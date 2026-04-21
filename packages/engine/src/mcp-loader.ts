/**
 * MCP Server Loader (shared)
 * Loads enabled MCP server configs from MongoDB and returns them in the
 * format expected by Claude Code SDK's mcpServers option. Also builds the
 * Allen built-in MCP server config.
 *
 * Source-based records (added Apr 2026):
 *   source.kind === 'preset' → look up hardcoded preset, build env from envKeys
 *   source.kind === 'repo'   → resolve entry file under registered repo,
 *                              run `npm install` gate, spawn with narrow env
 *
 * Legacy records (bundleId / @secret:KEY refs) still spawn via the old
 * decryption path for backward compatibility.
 */

import type { Db, ObjectId } from 'mongodb';
import { resolve, join, dirname, extname, isAbsolute } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import crypto from 'node:crypto';

import { ensureInstalled } from './mcp-install.js';

// ── Legacy: inline AES-256-GCM decryption (matches server/encryption.ts) ──
// Only touched when we encounter a pre-refactor bundle/secret record.
const ENC_PREFIX = 'enc:v1:';
let cachedMasterKey: Buffer | null = null;

function loadMasterKey(): Buffer {
  if (cachedMasterKey) return cachedMasterKey;
  const envKey = process.env.ALLEN_MASTER_KEY;
  if (envKey) {
    const buf = Buffer.from(envKey, 'base64');
    if (buf.length === 32) { cachedMasterKey = buf; return buf; }
  }
  const file = join(homedir(), '.allen', 'master.key');
  if (existsSync(file)) {
    const buf = readFileSync(file);
    if (buf.length === 32) { cachedMasterKey = buf; return buf; }
  }
  throw new Error('Master key not found — set ALLEN_MASTER_KEY or create ~/.allen/master.key');
}

function decryptValue(value: string): string {
  if (!value.startsWith(ENC_PREFIX)) return value;
  const parts = value.slice(ENC_PREFIX.length).split(':');
  if (parts.length !== 3) return value;
  const [ivB64, tagB64, ctB64] = parts;
  const key = loadMasterKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

async function resolveSecretRef(value: string, db: Db): Promise<string> {
  if (typeof value !== 'string' || !value.startsWith('@secret:')) return value;
  const key = value.slice('@secret:'.length);
  const doc = await db.collection('secrets').findOne({ key });
  if (!doc || typeof doc.value !== 'string') {
    console.warn(`[mcp-loader] Secret "${key}" referenced but not found`);
    return '';
  }
  try {
    return decryptValue(doc.value);
  } catch (err) {
    console.error(`[mcp-loader] Failed to decrypt secret "${key}":`, (err as Error).message);
    return '';
  }
}

// ── New path: env allowlist from process.env (ALLEN_<key> → <key>) ─────────

const BASE_ENV_KEYS = ['PATH', 'HOME', 'USER', 'SHELL'] as const;

/**
 * Build the subprocess env from an allowlist. For each bare name `X` in
 * `envKeys`, reads `process.env.ALLEN_X` and sets `env[X]` to that value.
 * Missing keys are warned but not fatal (the MCP server decides how to
 * handle its own missing config). Only baseline OS vars + allowlisted keys
 * are forwarded — the subprocess never sees ALLEN_MASTER_KEY, JWT secrets,
 * or other unrelated .env contents.
 */
function buildEnvFromAllowlist(
  envKeys: string[] | undefined,
  extraEnv?: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {
    // Silence dotenv's startup banner — corrupts strict MCP clients.
    DOTENV_CONFIG_QUIET: 'true',
  };
  for (const base of BASE_ENV_KEYS) {
    const v = process.env[base];
    if (v !== undefined) env[base] = v;
  }
  for (const key of envKeys ?? []) {
    const allenKey = `ALLEN_${key}`;
    const val = process.env[allenKey];
    if (val === undefined) {
      console.warn(`[mcp-loader] envKey "${key}" referenced but ${allenKey} is not set in Allen's .env`);
      continue;
    }
    env[key] = val;
  }
  if (extraEnv) Object.assign(env, extraEnv);
  return env;
}

/**
 * Resolve argKeys (positional-arg-style config, used by a few presets like
 * postgres connection string). For each bare name `X`, returns
 * `process.env.ALLEN_X` — empty string when missing.
 */
function resolveArgKeys(argKeys: string[] | undefined): string[] {
  if (!argKeys || argKeys.length === 0) return [];
  return argKeys.map((key) => {
    const allenKey = `ALLEN_${key}`;
    const val = process.env[allenKey];
    if (val === undefined) {
      console.warn(`[mcp-loader] argKey "${key}" referenced but ${allenKey} is not set in Allen's .env`);
      return '';
    }
    return val;
  });
}

// ── New path: resolve source → command/args/cwd ────────────────────────────

function inferCommand(entryPath: string): { command: string; leadingArgs: string[] } {
  const ext = extname(entryPath).toLowerCase();
  if (ext === '.ts' || ext === '.tsx') return { command: 'npx', leadingArgs: ['tsx'] };
  return { command: 'node', leadingArgs: [] };
}

async function resolveRepoPath(db: Db, repoId: string): Promise<string | null> {
  const doc = await db.collection('repos').findOne({ _id: new (await import('mongodb')).ObjectId(repoId) });
  if (!doc || typeof doc.path !== 'string') return null;
  return doc.path;
}

/**
 * Given an mcp_servers record with a `source` field, build the stdio config
 * shape Claude Code expects. Returns null if the source can't be resolved
 * (missing repo, invalid entryPath, etc.) — caller skips the server.
 */
async function resolveSourcedStdio(
  s: Record<string, unknown>,
  db: Db,
  extraEnv?: Record<string, string>,
): Promise<Record<string, unknown> | null> {
  const source = s.source as Record<string, unknown> | undefined;
  if (!source) return null;
  const envKeys = (s.envKeys as string[] | undefined) ?? [];
  const argKeys = (s.argKeys as string[] | undefined) ?? [];
  const extraArgs = (s.args as string[] | undefined) ?? [];

  if (source.kind === 'preset') {
    // The record stored the command+args at create time (copied from the
    // hardcoded preset). Trust them verbatim; append argKeys expansion.
    const args = [...extraArgs, ...resolveArgKeys(argKeys)];
    return {
      type: 'stdio',
      command: (s.command as string) ?? 'npx',
      args,
      env: buildEnvFromAllowlist(envKeys, extraEnv),
    };
  }

  if (source.kind === 'repo') {
    const repoId = source.repoId as string;
    const entryPath = source.entryPath as string;
    const installPathOverride = source.installPath as string | undefined;
    if (!repoId || !entryPath) return null;

    const repoPath = await resolveRepoPath(db, repoId);
    if (!repoPath) {
      console.warn(`[mcp-loader] MCP "${s.name}" references missing repo ${repoId}`);
      return null;
    }

    const entryAbs = isAbsolute(entryPath) ? entryPath : resolve(repoPath, entryPath);
    const installDir = installPathOverride
      ? (isAbsolute(installPathOverride) ? installPathOverride : resolve(repoPath, installPathOverride))
      : dirname(entryAbs);

    // Path-traversal guard: the resolved entry must stay inside the repo.
    if (!entryAbs.startsWith(repoPath + '/') && entryAbs !== repoPath) {
      console.error(`[mcp-loader] entryPath "${entryPath}" escapes repo ${repoPath}`);
      return null;
    }

    // Install deps once per installDir per process lifetime. If package.json
    // is absent (some MCP servers are single-file with no deps), skip silently.
    if (existsSync(join(installDir, 'package.json'))) {
      try {
        await ensureInstalled(installDir);
      } catch (err) {
        console.error(`[mcp-loader] npm install failed for "${s.name}" at ${installDir}:`, (err as Error).message);
        return null;
      }
    }

    // Auto-infer command unless the record overrides it explicitly.
    const { command: autoCmd, leadingArgs } = inferCommand(entryAbs);
    const command = (s.command as string) ?? autoCmd;
    const args = [...leadingArgs, entryAbs, ...extraArgs, ...resolveArgKeys(argKeys)];

    return {
      type: 'stdio',
      command,
      args,
      env: buildEnvFromAllowlist(envKeys, extraEnv),
      cwd: installDir,
    };
  }

  return null;
}

// ── Load-all entrypoints ───────────────────────────────────────────────────

export type LoadMcpOptions = {
  /**
   * Scope the result to a specific owner. When omitted, returns servers with
   * any ownerId (current behavior pre-scoping). Pass an ObjectId or string.
   */
  ownerId?: ObjectId | string | null;
  /** Extra env vars merged into each MCP's env. */
  extraEnv?: Record<string, string>;
};

/**
 * Load enabled external MCP servers as Claude Code SDK mcpServers config.
 * Filters by `enabled: true, type: 'stdio'` and optionally by ownerId.
 * Returns only servers whose spawn config could be built — unresolved ones
 * are skipped with a console.warn.
 */
export async function loadMcpServers(
  db: Db,
  options?: LoadMcpOptions,
): Promise<Record<string, unknown>> {
  const filter: Record<string, unknown> = { enabled: true, type: 'stdio' };
  if (options?.ownerId !== undefined) {
    if (options.ownerId === null) {
      filter.ownerId = null;  // implicit admin — legacy records
    } else if (typeof options.ownerId === 'string') {
      const { ObjectId: OID } = await import('mongodb');
      filter.ownerId = new OID(options.ownerId);
    } else {
      filter.ownerId = options.ownerId;
    }
  }

  const servers = await db.collection('mcp_servers').find(filter).toArray();

  const config: Record<string, unknown> = {};
  for (const s of servers) {
    try {
      const cfg = await buildSingleServerConfig(s, db, options?.extraEnv);
      if (cfg) config[s.name as string] = cfg;
    } catch (err) {
      console.error(`[mcp-loader] Failed to resolve MCP "${s.name}":`, (err as Error).message);
    }
  }

  return config;
}

/**
 * Resolve a single MCP server record (new source-based or legacy bundle-based)
 * into the stdio config Claude Code and Codex both expect. Used by
 * loadMcpServers and by mcp-health.service's connection check so both paths
 * go through the same resolution logic. Returns null when the record can't
 * be resolved (missing repo, bad entryPath, etc).
 */
export async function buildSingleServerConfig(
  s: Record<string, unknown>,
  db: Db,
  extraEnv?: Record<string, string>,
): Promise<Record<string, unknown> | null> {
  // Preferred path: source-based record (preset or repo).
  if (s.source) {
    return resolveSourcedStdio(s, db, extraEnv);
  }

  // Legacy path: bundle / @secret:KEY refs. Decryption, cwd from bundlePath.
  const resolvedEnv: Record<string, string> = { DOTENV_CONFIG_QUIET: 'true' };
  for (const [k, v] of Object.entries((s.env ?? {}) as Record<string, string>)) {
    resolvedEnv[k] = await resolveSecretRef(v, db);
  }
  if (extraEnv) Object.assign(resolvedEnv, extraEnv);
  const resolvedArgs: string[] = [];
  for (const a of ((s.args ?? []) as string[])) {
    resolvedArgs.push(await resolveSecretRef(a, db));
  }
  const stdioConfig: Record<string, unknown> = {
    type: 'stdio',
    command: s.command,
    args: resolvedArgs,
    env: resolvedEnv,
  };
  if (s.bundlePath) stdioConfig.cwd = s.bundlePath;
  return stdioConfig;
}

// ── Allen built-in MCP server ──────────────────────────────────────────────

export function getAllenMcpConfig(
  extraEnv?: Record<string, string>,
): Record<string, unknown> | null {
  const apiUrl = process.env.ALLEN_API_URL ?? `http://localhost:${process.env.PORT ?? '4023'}`;

  const candidates = [
    resolve(process.cwd(), 'src/services/allen-mcp-server.ts'),
    resolve(process.cwd(), '../server/src/services/allen-mcp-server.ts'),
    resolve(process.cwd(), 'dist/services/allen-mcp-server.js'),
  ];
  const serverPath = candidates.find(p => existsSync(p));
  if (!serverPath) return null;

  const env: Record<string, string> = {
    ALLEN_API_URL: apiUrl,
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    ...(process.env.JWT_ACCESS_SECRET ? { JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET } : {}),
    ...(extraEnv ?? {}),
  };

  return {
    type: 'stdio',
    command: 'npx',
    args: ['tsx', serverPath],
    env,
  };
}

/**
 * Load ALL MCP servers: Allen built-in + user-configured external.
 * `ownerIdOrExtraEnv` accepts either legacy `extraEnv` (Record<string,string>)
 * for backward compat with existing callers, OR a LoadMcpOptions object.
 */
export async function loadAllMcpServers(
  db: Db,
  ownerIdOrExtraEnv?: Record<string, string> | LoadMcpOptions,
): Promise<Record<string, unknown>> {
  const options: LoadMcpOptions = isLoadOptions(ownerIdOrExtraEnv)
    ? ownerIdOrExtraEnv
    : { extraEnv: ownerIdOrExtraEnv };

  const config: Record<string, unknown> = {};

  const ffConfig = getAllenMcpConfig(options.extraEnv);
  if (ffConfig) config.allen = ffConfig;

  const external = await loadMcpServers(db, options);
  Object.assign(config, external);

  return config;
}

function isLoadOptions(v: unknown): v is LoadMcpOptions {
  if (!v || typeof v !== 'object') return false;
  return 'ownerId' in v || 'extraEnv' in v;
}
