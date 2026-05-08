import { Router, type Response } from 'express';
import type { AuthedRequest } from '../middleware/requireAuth.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, unlinkSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve as resolvePath, extname } from 'node:path';
import multer from 'multer';
import { ObjectId, type Db } from 'mongodb';
import { forgetInstall, ensureInstalled, ensurePythonVenv, deletePythonVenv } from '@allen/engine';
import { param } from '../types.js';
import {
  McpService,
  MCP_PRESETS,
  type McpServerRecord,
  type McpServerSource,
} from '../services/mcp.service.js';
import { McpBundleService } from '../services/mcp-bundle.service.js';
import { healthCheckMcpServer } from '../services/mcp-health.service.js';
import { evictMcpConnection } from '../services/chat-mcp-client.js';

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

/** Current user's ObjectId from the auth middleware. */
function ownerIdOf(req: AuthedRequest): ObjectId {
  const sub = req.user?.sub;
  if (!sub) throw new Error('authenticated user required');
  return new ObjectId(sub);
}

/** True if the authenticated user is admin. Used only to gate the "all records
 * in Codex sync" admin path — MCP CRUD is strict user-scoped regardless. */
function isAdmin(req: AuthedRequest): boolean {
  return req.user?.role === 'admin';
}

/** Build a Mongo filter scoped to the request's user. MCP has ZERO admin
 * override — even admins see and manage only their own MCP servers. */
function userScopedFilter(req: AuthedRequest, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ownerId: ownerIdOf(req), ...extra };
}

/** Sync a single user's enabled MCP servers to that user's Codex CLI config.
 * Still translates to `codex mcp add/remove` — the external interface is
 * unchanged. Pulls env from process.env via the shared resolver. */
async function syncUserToCodex(service: McpService, req: AuthedRequest): Promise<void> {
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

  // ── MCP CRUD (user-scoped, strict) ──

  // GET /api/mcp/servers — List caller's own MCP servers
  router.get('/servers', async (req: AuthedRequest, res: Response) => {
    try {
      const filter = userScopedFilter(req);
      const servers = await db.collection('mcp_servers').find(filter).sort({ name: 1 }).toArray();
      res.json(servers);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/mcp/presets — list hardcoded presets (global, no scoping)
  router.get('/presets', (_req: AuthedRequest, res: Response) => {
    res.json(MCP_PRESETS);
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
        command, args, env, url, headers,
        bundleId, python,
      } = req.body as {
        name?: string; description?: string; type?: McpServerRecord['type']; enabled?: boolean;
        source?: McpServerSource;
        envKeys?: string[]; argKeys?: string[];
        command?: string; args?: string[]; env?: Record<string, string>;
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

      if (source?.kind === 'preset') {
        const preset = MCP_PRESETS.find((p) => p.name === source.presetName);
        if (!preset) return res.status(400).json({ error: `unknown preset: ${source.presetName}` });
        finalCommand = finalCommand ?? preset.command;
        finalArgs = finalArgs ?? preset.args;
        finalEnvKeys = finalEnvKeys ?? preset.envKeys;
        finalArgKeys = finalArgKeys ?? preset.argKeys;

        // Validate that every ALLEN_* env var the preset needs is present in
        // Allen's root .env. If missing, refuse to create the record and list
        // exactly what the user needs to add — no secret prompt, no
        // database-stored credentials, just .env + restart.
        const missing = [
          ...(preset.envKeys ?? []).map((k) => `ALLEN_${k}`),
          ...(preset.argKeys ?? []).map((k) => `ALLEN_${k}`),
        ].filter((k) => process.env[k] === undefined || process.env[k] === '');
        if (missing.length > 0) {
          return res.status(400).json({
            error: `Missing required env var${missing.length > 1 ? 's' : ''} in Allen's .env: ${missing.join(', ')}. Add ${missing.length > 1 ? 'them' : 'it'} to Allen's .env and restart the server.`,
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
        // Validate the user-listed env var allowlist against Allen's .env.
        // For repo MCPs, `envKeys`/`argKeys` come from the request body — the
        // user declared what their MCP needs. Fail fast if Allen can't provide.
        const needed = [
          ...(finalEnvKeys ?? []).map((k) => `ALLEN_${k}`),
          ...(finalArgKeys ?? []).map((k) => `ALLEN_${k}`),
        ];
        const missing = needed.filter((k) => process.env[k] === undefined || process.env[k] === '');
        if (missing.length > 0) {
          return res.status(400).json({
            error: `Missing required env var${missing.length > 1 ? 's' : ''} in Allen's .env: ${missing.join(', ')}. Add ${missing.length > 1 ? 'them' : 'it'} to Allen's .env and restart the server.`,
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
        env,            // legacy literal env — passthrough, may contain @secret:KEY refs
        url, headers,
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
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // PUT /api/mcp/servers/:id — Update (owner-only)
  router.put('/servers/:id', async (req: AuthedRequest, res: Response) => {
    try {
      const id = param(req, 'id');
      const existing = await service.getById(id);
      if (!existing) return res.status(404).json({ error: 'MCP server not found' });
      if (String(existing.ownerId ?? '') !== String(ownerIdOf(req)) && !(isAdmin(req) && !existing.ownerId)) {
        return res.status(403).json({ error: 'you can only edit your own MCP servers' });
      }

      const update: Partial<McpServerRecord> = { ...req.body };
      // Strip fields that should never be mutated via PUT
      delete (update as Record<string, unknown>)._id;
      delete (update as Record<string, unknown>).ownerId;
      delete (update as Record<string, unknown>).createdAt;

      const server = await service.update(id, update);
      if (!server) return res.status(404).json({ error: 'MCP server not found' });

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
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // PATCH /api/mcp/servers/:id/toggle — Toggle enabled/disabled
  router.patch('/servers/:id/toggle', async (req: AuthedRequest, res: Response) => {
    try {
      const id = param(req, 'id');
      const existing = await service.getById(id);
      if (!existing) return res.status(404).json({ error: 'MCP server not found' });
      if (String(existing.ownerId ?? '') !== String(ownerIdOf(req)) && !(isAdmin(req) && !existing.ownerId)) {
        return res.status(403).json({ error: 'you can only toggle your own MCP servers' });
      }
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
      if (String(existing.ownerId ?? '') !== String(ownerIdOf(req)) && !(isAdmin(req) && !existing.ownerId)) {
        return res.status(403).json({ error: 'you can only delete your own MCP servers' });
      }
      await service.delete(id);
      evictMcpConnection(existing.name);
      // Synchronously remove from Codex before the fire-and-forget sync so
      // there is no window where the deleted name re-appears in a later
      // syncUserToCodex run.  Ignore errors (e.g. Codex not installed or
      // server was never registered).
      try { await execFileAsync('codex', ['mcp', 'remove', existing.name], { timeout: 5000 }); } catch {}
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
      if (String(server.ownerId ?? '') !== String(ownerIdOf(req)) && !(isAdmin(req) && !server.ownerId)) {
        return res.status(403).json({ error: 'you can only test your own MCP servers' });
      }

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
      if (String(server.ownerId ?? '') !== String(ownerIdOf(req)) && !(isAdmin(req) && !server.ownerId)) {
        return res.status(403).json({ error: 'you can only reinstall your own MCP servers' });
      }

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
        const interpreter = server.python?.interpreter || 'python3';

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

