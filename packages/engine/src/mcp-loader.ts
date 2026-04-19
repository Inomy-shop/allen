/**
 * MCP Server Loader (shared)
 * Loads enabled MCP server configs from MongoDB and returns them
 * in the format expected by Claude Code SDK's mcpServers option.
 * Also builds the Allen MCP server config.
 */

import type { Db } from 'mongodb';
import { resolve, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import crypto from 'node:crypto';

// ── Inline AES-256-GCM decryption (duplicated from server/encryption.ts) ──
// Must match the server's encryption format exactly.
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
  if (!value.startsWith(ENC_PREFIX)) return value; // legacy plaintext
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

/** Resolve a single @secret:KEY reference to the decrypted plaintext. */
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

/**
 * Load all enabled external MCP servers from the database
 * and return as Claude Code SDK mcpServers config. Resolves @secret:
 * references in env and args so the spawned process gets plaintext values.
 */
export async function loadMcpServers(db: Db): Promise<Record<string, unknown>> {
  const servers = await db.collection('mcp_servers')
    .find({ enabled: true, type: 'stdio' })
    .toArray();

  const config: Record<string, unknown> = {};

  for (const s of servers) {
    // Resolve @secret: references in env
    const resolvedEnv: Record<string, string> = {
      // Silence dotenv's startup banner — it writes to stdout and corrupts
      // strict MCP clients (e.g. Codex CLI's rmcp) that expect pure JSON-RPC.
      DOTENV_CONFIG_QUIET: 'true',
    };
    for (const [k, v] of Object.entries((s.env ?? {}) as Record<string, string>)) {
      resolvedEnv[k] = await resolveSecretRef(v, db);
    }
    // Resolve @secret: references in args
    const resolvedArgs: string[] = [];
    for (const a of ((s.args ?? []) as string[])) {
      resolvedArgs.push(await resolveSecretRef(a, db));
    }

    config[s.name as string] = {
      type: 'stdio',
      command: s.command,
      args: resolvedArgs,
      env: resolvedEnv,
    };
  }

  return config;
}

/**
 * Get the Allen MCP server config.
 * This provides our built-in tools (list_workflows, wait_for_execution, etc.)
 * via a local MCP server that calls the Allen API.
 *
 * `extraEnv` lets callers stamp additional environment variables onto the
 * MCP server's subprocess env — used for spawn-tree propagation so the
 * MCP server can read ALLEN_PARENT_EXECUTION_ID / _CALLER /
 * _ROOT_EXECUTION_ID at startup and forward them into every `spawn_agent`
 * HTTP call. Passing them explicitly here (rather than relying on
 * claude-cli's parent-env inheritance for MCP children) keeps the chain
 * working regardless of whether the SDK merges or replaces env.
 */
export function getAllenMcpConfig(
  extraEnv?: Record<string, string>,
): Record<string, unknown> | null {
  const apiUrl = process.env.ALLEN_API_URL ?? `http://localhost:${process.env.PORT ?? '4023'}`;

  // Find the Allen MCP server script
  const candidates = [
    resolve(process.cwd(), 'src/services/allen-mcp-server.ts'),
    resolve(process.cwd(), '../server/src/services/allen-mcp-server.ts'),
    resolve(process.cwd(), 'dist/services/allen-mcp-server.js'),
  ];

  const serverPath = candidates.find(p => existsSync(p));
  if (!serverPath) return null;

  // The MCP server needs JWT_ACCESS_SECRET to mint authenticated HTTP calls
  // back into the Allen API. Previous versions relied on claude-cli
  // merging parent env with our `env` field, which is an undocumented
  // assumption — we now pass JWT_ACCESS_SECRET explicitly so the MCP
  // server works even under an SDK/CLI version that replaces env instead
  // of merging.
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
 * `extraEnv` is forwarded to the Allen MCP server's env so callers
 * (node-executor, chat-tools.runSpawnInBackground) can stamp the
 * spawn-tree propagation vars without reaching inside the config dict.
 */
export async function loadAllMcpServers(
  db: Db,
  extraEnv?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const config: Record<string, unknown> = {};

  // Allen built-in tools
  const ffConfig = getAllenMcpConfig(extraEnv);
  if (ffConfig) config.allen = ffConfig;

  // External servers (Linear, Postgres, MongoDB, etc.)
  const external = await loadMcpServers(db);
  Object.assign(config, external);

  return config;
}
