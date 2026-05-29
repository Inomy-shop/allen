import { Router, type Response } from 'express';
import type { AuthedRequest } from '../middleware/requireAuth.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, unlinkSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve as resolvePath, extname } from 'node:path';
import multer from 'multer';
import { ObjectId, type Db } from 'mongodb';
import { forgetInstall, ensureInstalled, ensurePythonVenv, deletePythonVenv, resolvePythonInterpreter, ALLEN_MCP_TOOL_NAMES, type BuildMcpConfigOptions } from '@allen/engine';
import { param } from '../types.js';
import {
  McpService,
  MCP_PRESETS,
  type McpServerRecord,
  type McpServerSource,
} from '../services/mcp.service.js';
import { McpBundleService } from '../services/mcp-bundle.service.js';
import { healthCheckMcpServer } from '../services/mcp-health.service.js';
import { evictMcpConnection, getCachedMcpTools, loadMcpTools } from '../services/chat-mcp-client.js';
import { getRuntimeConfigProvider, getRuntimeSecretsProvider } from '../runtime/config.js';
import { buildMcpSourceEnvForServer, listMissingMcpCredentialEnv, mcpCredentialEnvKey } from '../runtime/mcp-credentials.js';

const BUNDLE_UPLOAD_TMP = '/tmp/mcp-bundle-uploads';
if (!existsSync(BUNDLE_UPLOAD_TMP)) mkdirSync(BUNDLE_UPLOAD_TMP, { recursive: true });

const bundleUpload = multer({
  dest: BUNDLE_UPLOAD_TMP,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter: (_req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith('.zip')) {
      cb(new Error('Only .zip files are accepted'));
      return;
    }
    cb(null, true);
  },
});

const execFileAsync = promisify(execFile);

/** Cached probe: is `codex` on PATH? Without this every MCP write spawns a
 * process and (on claude-only installs) logs an ENOENT for each call.
 * Lazy + cached so a freshly installed codex eventually flips true after
 * the first successful detection.  Re-probes once after a failed detection
 * up to a small jitter so a later install is picked up without a restart. */
let codexProbeAt = 0;
let codexAvailable: boolean | undefined;
async function hasCodex(): Promise<boolean> {
  const now = Date.now();
  if (codexAvailable === true) return true;
  if (codexAvailable === false && now - codexProbeAt < 60_000) return false;
  try {
    await execFileAsync('codex', ['--version'], { timeout: 2000 });
    codexAvailable = true;
  } catch {
    codexAvailable = false;
  }
  codexProbeAt = now;
  return codexAvailable;
}

/** Current user's ObjectId from the auth middleware. */
function ownerIdOf(req: AuthedRequest): ObjectId {
  const sub = req.user?.sub;
  if (!sub) throw new Error('authenticated user required');
  return new ObjectId(sub);
}

/** Build a Mongo filter scoped to the request's user. Used internally for
 * write operations and Codex sync. Note: GET /servers reads are now shared
 * across all authenticated users — all mcp_servers documents are returned
 * regardless of ownerId. */
function userScopedFilter(req: AuthedRequest, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ownerId: ownerIdOf(req), ...extra };
}

/** Sync a single user's enabled MCP servers to that user's Codex CLI config.
 * Still translates to `codex mcp add/remove` — the external interface is
 * unchanged. Pulls env from process.env via the shared resolver. */
async function syncUserToCodex(service: McpService, req: AuthedRequest): Promise<void> {
  if (!(await hasCodex())) return; // claude-only install — nothing to sync to
  try {
    const ownerFilter = userScopedFilter(req);
    // Use the service list (no scope) but re-filter here so syncUserToCodex
    // works even if the service is shared for multiple users later.
    const servers = (await service.list()).filter(
      (s) => String(s.ownerId ?? '') === String(ownerFilter.ownerId ?? ''),
    );

    const { buildSingleServerConfig } = await import('@allen/engine');
    let existing = '';
    try { existing = (await execFileAsync('codex', ['mcp', 'list'], { timeout: 5000 })).stdout; } catch {}

    for (const s of servers) {
      if (s.type !== 'stdio') continue;
      const isRegistered = existing.includes(s.name);
      if (!s.enabled && !isRegistered) continue;
      if (!s.enabled && isRegistered) {
        await execFileAsync('codex', ['mcp', 'remove', s.name], { timeout: 5000 });
        continue;
      }

      // Resolve the spawn config using the same path the loader uses, so new
      // source-based records and legacy bundle records both translate correctly.
      const cfg = await buildSingleServerConfig(
        s as unknown as Record<string, unknown>,
        (service as unknown as { db: Db }).db ?? (req as unknown as { app: { locals: { db: Db } } }).app.locals.db,
        { sourceEnv: await buildMcpSourceEnvForServer(s) } satisfies BuildMcpConfigOptions,
      );
      if (!cfg) continue;

      const envMap = (cfg.env as Record<string, string>) ?? {};
      const cmd = (cfg.command as string) ?? 'node';
      const cmdArgs = (cfg.args as string[]) ?? [];

      if (isRegistered) {
        await execFileAsync('codex', ['mcp', 'remove', s.name], { timeout: 5000 });
      }
      const args = ['mcp', 'add', s.name];
      for (const [k, v] of Object.entries(envMap)) args.push('--env', `${k}=${v}`);
      args.push('--', cmd, ...cmdArgs);
      await execFileAsync('codex', args, { timeout: 10000 });
    }

  } catch (err) {
    console.error('[mcp] Codex sync failed:', (err as Error).message);
  }
}

async function persistProvidedMcpCredentials(
  credentials: Record<string, string> | undefined,
  allowedKeys: string[],
): Promise<void> {
  const entries = Object.entries(credentials ?? {})
    .map(([key, value]) => [mcpCredentialEnvKey(key.trim()), String(value ?? '')] as const)
    .filter(([, value]) => value.trim() !== '');
  if (entries.length === 0) return;

  const allowed = new Set(allowedKeys.map(mcpCredentialEnvKey));
  for (const [key] of entries) {
    if (!allowed.has(key)) {
      throw new Error(`unsupported MCP credential key: ${key}`);
    }
  }

  const secrets = getRuntimeSecretsProvider();
  if (!secrets.setSecret) throw new Error('runtime_secrets_are_read_only');
  for (const [key, value] of entries) {
    await secrets.setSecret(key, value);
    process.env[key] = value;
  }
}

function credentialKeysForMcpServer(server: Pick<McpServerRecord, 'envKeys' | 'argKeys'>): string[] {
  return Array.from(new Set([
    ...(server.envKeys ?? []),
    ...(server.argKeys ?? []),
  ].map(mcpCredentialEnvKey)));
}

async function deleteUnusedMcpCredentials(
  service: McpService,
  deletedServer: Pick<McpServerRecord, 'envKeys' | 'argKeys'>,
): Promise<void> {
  const runtimeConfig = getRuntimeConfigProvider();
  if (runtimeConfig.get('ALLEN_DESKTOP') !== '1') return;

  const keys = credentialKeysForMcpServer(deletedServer);
  if (keys.length === 0) return;

  const remainingReferencedKeys = new Set(
    (await service.list()).flatMap((server) => credentialKeysForMcpServer(server)),
  );
  const keysToDelete = keys.filter((key) => !remainingReferencedKeys.has(key));
  if (keysToDelete.length === 0) return;

  const secrets = getRuntimeSecretsProvider();
  const config = runtimeConfig as {
    delete?: (runtimeKey: string) => void;
  };
  await Promise.all(keysToDelete.map(async (key) => {
    await secrets.deleteSecret?.(key);
    config.delete?.(key);
    delete process.env[key];
  }));
}

/** Scan a repo for candidate MCP entry files. Heuristics: files matching
 * `*.mcp.{ts,js,mjs}`, files inside a `.claude/mcp/*` subtree, or files that
 * reference `@modelcontextprotocol/sdk` as a header import (Node) or contain
 * known Python MCP fingerprints (.py). Skips node_modules, .git, .venv,
 * __pycache__. Returns absolute + repo-relative paths sorted by path. */
export function discoverMcpEntries(
  repoPath: string,
  maxDepth = 4,
): Array<{ entry: string; repoRelative: string; detectedLanguage: 'python' | 'node' }> {
  const out: Array<{ entry: string; repoRelative: string; detectedLanguage: 'python' | 'node' }> = [];
  const SDK_IMPORT = '@modelcontextprotocol/sdk';
  const PY_FINGERPRINTS = [
    'mcp.server.fastmcp',
    'FastMCP',
    'from mcp.server',
    'mcp.run(',
    '@mcp.tool',
  ];

  function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (name === 'node_modules' || name === '.git' || name.startsWith('.DS_')) continue;
      if (name === '.venv' || name === '__pycache__') continue; // skip Python env dirs
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!st.isFile()) continue;
      const ext = extname(name).toLowerCase();
      if (!['.ts', '.tsx', '.js', '.mjs', '.cjs', '.py'].includes(ext)) continue;

      const isPython = ext === '.py';

      // Convention-based pickup:
      //   Node: *.mcp.{ts,tsx,js,mjs,cjs} or .claude/mcp/**
      //   Python: any .py file inside .claude/mcp/** (REQ-002)
      const byConvention = isPython
        ? full.includes('/.claude/mcp/')
        : /\.mcp\.(ts|tsx|js|mjs|cjs)$/.test(name) || full.includes('/.claude/mcp/');

      // Content-based pickup: file imports the MCP SDK (Node) or contains
      // Python MCP fingerprints (Python) — only read if not already accepted (REQ-003)
      let byContent = false;
      if (!byConvention && st.size < 200 * 1024) {
        try {
          const sample = readFileSync(full, 'utf8').slice(0, 4096);
          if (isPython) {
            byContent = PY_FINGERPRINTS.some((fp) => sample.includes(fp));
          } else {
            byContent = sample.includes(SDK_IMPORT);
          }
        } catch { /* ignore */ }
      }

      if (byConvention || byContent) {
        out.push({
          entry: full,
          repoRelative: relative(repoPath, full),
          detectedLanguage: isPython ? 'python' : 'node',
        });
      }
    }
  }

  walk(repoPath, 0);
  out.sort((a, b) => a.repoRelative.localeCompare(b.repoRelative));
  return out;
}

export function mcpRoutes(db: Db): Router {
  const router = Router();
  const service = new McpService(db);
  (service as unknown as { db: Db }).db = db;
  const bundleService = new McpBundleService(db);

  // ── Bundle upload routes (legacy, kept for backward compat) ──
  router.post('/servers/upload', bundleUpload.single('file'), async (req: AuthedRequest, res: Response) => {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });
    try {
      const meta = await bundleService.extractZip(file.path, file.originalname);
      try { unlinkSync(file.path); } catch {}
      res.status(201).json(meta);
    } catch (err: unknown) {
      try { unlinkSync(file.path); } catch {}
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.get('/servers/upload/:bundleId', (req: AuthedRequest, res: Response) => {
    const meta = bundleService.getMeta(param(req, 'bundleId'));
    if (!meta) return res.status(404).json({ error: 'Bundle not found' });
    res.json(meta);
  });

  router.patch('/servers/upload/:bundleId', (req: AuthedRequest, res: Response) => {
    try {
      const { entry } = req.body;
      if (!entry) return res.status(400).json({ error: 'entry is required' });
      bundleService.setEntry(param(req, 'bundleId'), entry);
      res.json(bundleService.getMeta(param(req, 'bundleId')));
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.delete('/servers/upload/:bundleId', (req: AuthedRequest, res: Response) => {
    bundleService.delete(param(req, 'bundleId'));
    res.status(204).send();
  });

  // ── MCP CRUD ──

  // GET /api/mcp/servers — List all MCP servers (shared read model) with owner display info
  router.get('/servers', async (req: AuthedRequest, res: Response) => {
    try {
      const servers = await db.collection('mcp_servers').find({}).sort({ name: 1 }).toArray();

      // Collect unique ownerIds for a single batch user lookup
      const ownerIds: ObjectId[] = [];
      const seen = new Set<string>();
      for (const s of servers) {
        if (s.ownerId == null) continue;
        const key = String(s.ownerId);
        if (!seen.has(key)) {
          seen.add(key);
          ownerIds.push(s.ownerId instanceof ObjectId ? s.ownerId : new ObjectId(key));
        }
      }

      // Batch-fetch only name + email — never expose password hashes or tokens
      const ownerMap = new Map<string, { name: string | null; email: string | null }>();
      if (ownerIds.length > 0) {
        const users = await db
          .collection('users')
          .find({ _id: { $in: ownerIds } }, { projection: { name: 1, email: 1 } })
          .toArray();
        for (const u of users) {
          ownerMap.set(String(u._id), {
            name: (u.name as string) ?? null,
            email: (u.email as string) ?? null,
          });
        }
      }

      // Attach ownerName / ownerEmail to every record
      const enriched = servers.map((s: Record<string, unknown>) => {
        const owner = s.ownerId != null ? ownerMap.get(String(s.ownerId)) : undefined;
        return {
          ...s,
          ownerName: owner?.name ?? null,
          ownerEmail: owner?.email ?? null,
        };
      });

      res.json(enriched);
    } catch (err: unknown) {
      const message = (err as Error).message;
      const status = message === 'runtime_secrets_are_read_only' || message.startsWith('unsupported MCP credential key:')
        ? 400
        : 500;
      res.status(status).json({ error: message });
    }
  });

  // GET /api/mcp/presets — list hardcoded presets (global, no scoping)
  router.get('/presets', (_req: AuthedRequest, res: Response) => {
    res.json(MCP_PRESETS);
  });

  // GET /api/mcp/tools — list available MCP tools grouped by server for access configuration.
  router.get('/tools', async (_req: AuthedRequest, res: Response) => {
    try {
      const service = new McpService(db);
      const enabledStdioServers = (await service.list())
        .filter((server) => server.enabled && server.type === 'stdio')
        .sort((a, b) => a.name.localeCompare(b.name));
      const externalTools = getCachedMcpTools();
      const grouped = new Map<string, Array<{ name: string; fullName: string; description: string }>>();
      for (const tool of externalTools) {
        const list = grouped.get(tool.serverName) ?? [];
        list.push({ name: tool.name, fullName: tool.fullName, description: tool.description });
        grouped.set(tool.serverName, list);
      }
      const warmDiscovery = _req.query.refresh !== '0';
      res.json([
        {
          serverName: 'allen',
          builtIn: true,
          enabled: true,
          tools: ALLEN_MCP_TOOL_NAMES.map((name) => ({
            name,
            fullName: `mcp__allen__${name}`,
            description: '',
          })),
        },
        ...enabledStdioServers.map((server) => ({
          serverName: server.name,
          builtIn: false,
          enabled: true,
          tools: (grouped.get(server.name) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
        })),
      ]);
      if (warmDiscovery) {
        setImmediate(() => {
          void loadMcpTools(db).catch((err) => {
            console.error('[mcp] Background tool discovery failed:', (err as Error).message);
          });
        });
      }
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/mcp/servers/discover/:repoId — scan the repo for MCP entry candidates
  router.get('/servers/discover/:repoId', async (req: AuthedRequest, res: Response) => {
    try {
      const repoId = param(req, 'repoId');
      let oid: ObjectId;
      try { oid = new ObjectId(repoId); } catch { return res.status(400).json({ error: 'invalid repoId' }); }
      const repo = await db.collection('repos').findOne({ _id: oid });
      if (!repo) return res.status(404).json({ error: 'repo not found' });
      const requestOwnerId = ownerIdOf(req);
      if (repo.ownerId && String(repo.ownerId) !== String(requestOwnerId)) {
        return res.status(403).json({ error: 'repo belongs to another user' });
      }
      if (typeof repo.path !== 'string' || !existsSync(repo.path)) {
        return res.status(400).json({ error: 'repo path does not exist on disk' });
      }
      const candidates = discoverMcpEntries(repo.path);
      res.json({ repoId, repoPath: repo.path, candidates });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/mcp/servers — Create (new: accepts `source`, `envKeys`, `argKeys`)
  router.post('/servers', async (req: AuthedRequest, res: Response) => {
    try {
      const {
        name, description, type, enabled,
        source, envKeys, argKeys,
        command, args, env, credentials, url, headers,
        bundleId, python,
      } = req.body as {
        name?: string; description?: string; type?: McpServerRecord['type']; enabled?: boolean;
        source?: McpServerSource;
        envKeys?: string[]; argKeys?: string[];
        command?: string; args?: string[]; env?: Record<string, string>; credentials?: Record<string, string>;
        url?: string; headers?: Record<string, string>;
        bundleId?: string;
        python?: { interpreter?: string; requirementsPath?: string };
      };
      if (!name || !type) return res.status(400).json({ error: 'name and type are required' });

      const ownerId = ownerIdOf(req);

      // Collision check within this user's namespace
      const duplicate = await db.collection('mcp_servers').findOne({ ownerId, name });
      if (duplicate) return res.status(409).json({ error: `MCP server "${name}" already exists in your servers` });

      // Preset resolution — if source.kind==='preset', copy command/args/envKeys/argKeys from the preset.
      let finalCommand = command;
      let finalArgs: string[] | undefined = args;
      let finalEnvKeys: string[] | undefined = envKeys;
      let finalArgKeys: string[] | undefined = argKeys;
      let finalUrl = url;
      let finalHeaders = headers;

      if (source?.kind === 'preset') {
        const preset = MCP_PRESETS.find((p) => p.name === source.presetName);
        if (!preset) return res.status(400).json({ error: `unknown preset: ${source.presetName}` });
        finalCommand = finalCommand ?? preset.command;
        finalArgs = finalArgs ?? preset.args;
        finalEnvKeys = finalEnvKeys ?? preset.envKeys;
        finalArgKeys = finalArgKeys ?? preset.argKeys;
        finalUrl = finalUrl ?? preset.url;
        finalHeaders = finalHeaders ?? preset.headers;
        await persistProvidedMcpCredentials(credentials, [
          ...(preset.envKeys ?? []),
          ...(preset.argKeys ?? []),
        ]);

        // Validate that every ALLEN_* credential the preset needs is available
        // from the runtime config/secrets providers. Web mode can still use
        // .env; desktop mode uses the app-managed secret store.
        const missing = await listMissingMcpCredentialEnv([
          ...(preset.envKeys ?? []),
          ...(preset.argKeys ?? []),
        ]);
        if (missing.length > 0) {
          return res.status(400).json({
            error: `Missing required credential${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. Add ${missing.length > 1 ? 'them' : 'it'} in Settings or configure the matching environment variable, then retry.`,
            missing,
          });
        }
      } else if (source?.kind === 'repo') {
        // Validate repo belongs to the same user (or is admin-owned/implicit)
        let repoOid: ObjectId;
        try { repoOid = new ObjectId(source.repoId); } catch { return res.status(400).json({ error: 'invalid source.repoId' }); }
        const repo = await db.collection('repos').findOne({ _id: repoOid });
        if (!repo) return res.status(404).json({ error: 'repo not found' });
        if (repo.ownerId && String(repo.ownerId) !== String(ownerId)) {
          return res.status(403).json({ error: 'repo belongs to another user' });
        }
        if (!source.entryPath || typeof source.entryPath !== 'string') {
          return res.status(400).json({ error: 'source.entryPath is required for repo-sourced MCP' });
        }
        await persistProvidedMcpCredentials(credentials, [
          ...(finalEnvKeys ?? []),
          ...(finalArgKeys ?? []),
        ]);
        // Validate the user-listed env var allowlist against Allen's runtime.
        // For repo MCPs, `envKeys`/`argKeys` come from the request body — the
        // user declared what their MCP needs. Fail fast if Allen can't provide.
        const missing = await listMissingMcpCredentialEnv([
          ...(finalEnvKeys ?? []),
          ...(finalArgKeys ?? []),
        ]);
        if (missing.length > 0) {
          return res.status(400).json({
            error: `Missing required credential${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. Add ${missing.length > 1 ? 'them' : 'it'} in Settings or configure the matching environment variable, then retry.`,
            missing,
          });
        }
      }

      // Legacy bundle path — unchanged; kept for backward compat.
      let bundlePath: string | undefined;
      let bundleEntry: string | undefined;
      if (bundleId) {
        const meta = bundleService.getMeta(bundleId);
        if (!meta) return res.status(404).json({ error: `Bundle ${bundleId} not found` });
        if (meta.status !== 'ready') return res.status(400).json({ error: `Bundle is not ready (status: ${meta.status})` });
        const entryPath = bundleService.getEntryPath(bundleId);
        if (!entryPath) return res.status(400).json({ error: 'Bundle has no entry point' });
        finalCommand = 'node';
        finalArgs = [entryPath];
        bundlePath = bundleService.getBundlePath(bundleId);
        bundleEntry = meta.entry;
      }

      // Persist python block ONLY for repo-sourced .py entries with no manual
      // command override. Other shapes ignore it — keeps the record clean.
      const isPythonRepoMcp =
        source?.kind === 'repo' &&
        extname(source.entryPath ?? '').toLowerCase() === '.py' &&
        !finalCommand;
      const finalPython = isPythonRepoMcp
        ? {
            interpreter: python?.interpreter || 'python3',
            ...(python?.requirementsPath ? { requirementsPath: python.requirementsPath } : {}),
          }
        : undefined;

      const server = await service.create({
        ownerId,
        name,
        description: description ?? '',
        type,
        enabled: enabled ?? true,
        source,
        envKeys: finalEnvKeys,
        argKeys: finalArgKeys,
        command: finalCommand,
        args: finalArgs,
        env,            // legacy literal env — passthrough for backwards-compat with existing records
        url: finalUrl,
        headers: finalHeaders,
        bundleId, bundlePath, bundleEntry,
        python: finalPython,
      } as Parameters<typeof service.create>[0]);

      if (bundleId && server._id) bundleService.markLinked(bundleId, server._id.toString());

      // NFR-009: log Python MCP registrations once per record creation
      if (source?.kind === 'repo' && extname(source.entryPath ?? '').toLowerCase() === '.py') {
        console.log(`[mcp] registered Python MCP "${name}" command="${finalCommand ?? 'python3 (auto)'}" entry=${source.entryPath}`);
      }

      syncUserToCodex(service, req).catch(() => {});
      res.status(201).json(server);
    } catch (err: unknown) {
      const message = (err as Error).message;
      const status = message === 'runtime_secrets_are_read_only' || message.startsWith('unsupported MCP credential key:')
        ? 400
        : 500;
      res.status(status).json({ error: message });
    }
  });

  // PUT /api/mcp/servers/:id — Update
  router.put('/servers/:id', async (req: AuthedRequest, res: Response) => {
    try {
      const id = param(req, 'id');
      const existing = await service.getById(id);
      if (!existing) return res.status(404).json({ error: 'MCP server not found' });

      const credentials = (req.body as { credentials?: Record<string, string> }).credentials;
      let update: Partial<McpServerRecord> = { ...req.body };
      // Strip fields that should never be mutated via PUT
      delete (update as Record<string, unknown>)._id;
      delete (update as Record<string, unknown>).ownerId;
      delete (update as Record<string, unknown>).createdAt;
      delete (update as Record<string, unknown>).credentials;
      for (const key of Object.keys(update) as Array<keyof McpServerRecord>) {
        if (update[key] === undefined) delete update[key];
      }

      // Presets are curated records: their name, command, args, URL, type,
      // source, and declared credential keys stay tied to MCP_PRESETS. Editing a
      // preset only updates the app-managed credential values supplied above.
      if (existing.source?.kind === 'preset') {
        update = {};
      }

      const nextEnvKeys = existing.source?.kind === 'preset'
        ? (existing.envKeys ?? [])
        : (update.envKeys ?? existing.envKeys ?? []);
      const nextArgKeys = existing.source?.kind === 'preset'
        ? (existing.argKeys ?? [])
        : (update.argKeys ?? existing.argKeys ?? []);
      const nextCredentialKeys = [
        ...(nextEnvKeys ?? []),
        ...(nextArgKeys ?? []),
      ];
      await persistProvidedMcpCredentials(credentials, nextCredentialKeys);

      const missing = await listMissingMcpCredentialEnv(nextCredentialKeys);
      if (missing.length > 0) {
        return res.status(400).json({
          error: `Missing required credential${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. Add ${missing.length > 1 ? 'them' : 'it'} in Settings or configure the matching environment variable, then retry.`,
          missing,
        });
      }

      const server = await service.update(id, update);
      if (!server) return res.status(404).json({ error: 'MCP server not found' });
      await deleteUnusedMcpCredentials(service, existing);

      // If installPath changed or source changed, bust the install cache.
      const oldInstall = (existing.source?.kind === 'repo')
        ? (existing.source.installPath ?? null)
        : null;
      const newInstall = (server.source?.kind === 'repo')
        ? (server.source.installPath ?? null)
        : null;
      if (oldInstall && oldInstall !== newInstall) forgetInstall(oldInstall);

      syncUserToCodex(service, req).catch(() => {});
      res.json(server);
    } catch (err: unknown) {
      const message = (err as Error).message;
      const status = message === 'runtime_secrets_are_read_only' || message.startsWith('unsupported MCP credential key:')
        ? 400
        : 500;
      res.status(status).json({ error: message });
    }
  });

  // PATCH /api/mcp/servers/:id/toggle — Toggle enabled/disabled
  router.patch('/servers/:id/toggle', async (req: AuthedRequest, res: Response) => {
    try {
      const id = param(req, 'id');
      const existing = await service.getById(id);
      if (!existing) return res.status(404).json({ error: 'MCP server not found' });
      const server = await service.toggle(id);
      syncUserToCodex(service, req).catch(() => {});
      res.json(server);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // DELETE /api/mcp/servers/:id
  router.delete('/servers/:id', async (req: AuthedRequest, res: Response) => {
    try {
      const id = param(req, 'id');
      const existing = await service.getById(id);
      if (!existing) return res.status(404).json({ error: 'MCP server not found' });
      await service.delete(id);
      await deleteUnusedMcpCredentials(service, existing);
      evictMcpConnection(existing.name);
      // Synchronously remove from Codex before the fire-and-forget sync so
      // there is no window where the deleted name re-appears in a later
      // syncUserToCodex run.  Skip entirely on claude-only installs.
      if (await hasCodex()) {
        try { await execFileAsync('codex', ['mcp', 'remove', existing.name], { timeout: 5000 }); } catch {}
      }
      if (existing.bundleId) bundleService.delete(existing.bundleId);
      // Wipe Allen-managed Python venv (no-op for non-Python MCPs).
      try { deletePythonVenv(id); } catch (err) {
        console.warn(`[mcp] failed to wipe venv for ${id}:`, (err as Error).message);
      }
      syncUserToCodex(service, req).catch(() => {});
      res.status(204).send();
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/mcp/servers/:id/test — MCP handshake (initialize + tools/list)
  router.post('/servers/:id/test', async (req: AuthedRequest, res: Response) => {
    const id = param(req, 'id');
    try {
      const server = await service.getById(id);
      if (!server) return res.status(404).json({ error: 'MCP server not found' });

      const result = await healthCheckMcpServer(server, db);

      if (result.ok) {
        await service.updateStatus(id, 'connected', {
          serverInfo: result.serverInfo,
          toolCount: result.toolCount ?? 0,
        });
        res.json({
          status: 'connected',
          serverInfo: result.serverInfo,
          toolCount: result.toolCount ?? 0,
          durationMs: result.durationMs,
        });
      } else {
        await service.updateStatus(id, 'failed', { error: result.error });
        res.json({ status: 'failed', error: result.error, durationMs: result.durationMs });
      }
    } catch (err: unknown) {
      const error = (err as Error).message;
      await service.updateStatus(id, 'failed', { error });
      res.json({ status: 'failed', error });
    }
  });

  // POST /api/mcp/servers/:id/reinstall — bust install cache + re-run npm install
  router.post('/servers/:id/reinstall', async (req: AuthedRequest, res: Response) => {
    try {
      const id = param(req, 'id');
      const server = await service.getById(id);
      if (!server) return res.status(404).json({ error: 'MCP server not found' });

      if (server.source?.kind !== 'repo') {
        return res.status(400).json({ error: 'reinstall only applies to repo-sourced MCP servers' });
      }
      const repo = await db.collection('repos').findOne({ _id: new ObjectId(server.source.repoId) });
      if (!repo || typeof repo.path !== 'string') {
        return res.status(404).json({ error: 'repo not found' });
      }
      const installDir = server.source.installPath
        ? resolvePath(repo.path, server.source.installPath)
        : resolvePath(repo.path, server.source.entryPath, '..');

      const entryExt = extname(server.source.entryPath ?? '').toLowerCase();
      const hasPkgJson = existsSync(join(installDir, 'package.json'));

      // Python MCPs (no manual command override): wipe the Allen-managed venv
      // and let the next spawn recreate it via ensurePythonVenv. Eager-trigger
      // ensurePythonVenv here so the user sees the install timing in the
      // response instead of waiting for the next chat turn.
      if (entryExt === '.py' && !server.command) {
        const interpreter = resolvePythonInterpreter(server.python?.interpreter);

        // Resolve requirements.txt: explicit on the record, else sibling auto-detect.
        let requirementsAbsPath: string | null = null;
        const explicit = server.python?.requirementsPath;
        if (explicit) {
          requirementsAbsPath = resolvePath(repo.path, explicit);
        } else {
          const sibling = resolvePath(repo.path, server.source.entryPath, '..', 'requirements.txt');
          if (existsSync(sibling)) requirementsAbsPath = sibling;
        }

        try {
          deletePythonVenv(id);
          const status = await ensurePythonVenv({
            mcpId: id,
            interpreter,
            requirementsAbsPath,
          });
          return res.json({
            installDir: status.venvPath,
            packageManager: 'pip',
            durationMs: status.durationMs,
            skipped: false,
            requirementsInstalled: status.installed,
            requirementsPath: requirementsAbsPath ? relative(repo.path, requirementsAbsPath) : null,
          });
        } catch (err) {
          return res.status(500).json({
            error: `pip install failed: ${(err as Error).message}`,
          });
        }
      }

      if (!hasPkgJson) {
        return res.status(400).json({
          error: `installDir has no package.json: ${installDir}`,
        });
      }

      forgetInstall(installDir);
      const result = await ensureInstalled(installDir);
      res.json({
        installDir: result.installDir,
        packageManager: result.packageManager,
        durationMs: result.durationMs,
        skipped: result.skipped,
      });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
