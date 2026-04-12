/**
 * MCP Server Loader (shared)
 * Loads enabled MCP server configs from MongoDB and returns them
 * in the format expected by Claude Code SDK's mcpServers option.
 * Also builds the FlowForge MCP server config.
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
  const envKey = process.env.FLOWFORGE_MASTER_KEY;
  if (envKey) {
    const buf = Buffer.from(envKey, 'base64');
    if (buf.length === 32) { cachedMasterKey = buf; return buf; }
  }
  const file = join(homedir(), '.flowforge', 'master.key');
  if (existsSync(file)) {
    const buf = readFileSync(file);
    if (buf.length === 32) { cachedMasterKey = buf; return buf; }
  }
  throw new Error('Master key not found — set FLOWFORGE_MASTER_KEY or create ~/.flowforge/master.key');
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
 * Get the FlowForge MCP server config.
 * This provides our built-in tools (list_workflows, get_execution, etc.)
 * via a local MCP server that calls the FlowForge API.
 */
export function getFlowForgeMcpConfig(): Record<string, unknown> | null {
  const apiUrl = process.env.FLOWFORGE_API_URL ?? `http://localhost:${process.env.PORT ?? '4023'}`;

  // Find the FlowForge MCP server script
  const candidates = [
    resolve(process.cwd(), 'src/services/flowforge-mcp-server.ts'),
    resolve(process.cwd(), '../server/src/services/flowforge-mcp-server.ts'),
    resolve(process.cwd(), 'dist/services/flowforge-mcp-server.js'),
  ];

  const serverPath = candidates.find(p => existsSync(p));
  if (!serverPath) return null;

  return {
    type: 'stdio',
    command: 'npx',
    args: ['tsx', serverPath],
    env: { FLOWFORGE_API_URL: apiUrl },
  };
}

/**
 * Load ALL MCP servers: FlowForge built-in + user-configured external.
 */
export async function loadAllMcpServers(db: Db): Promise<Record<string, unknown>> {
  const config: Record<string, unknown> = {};

  // FlowForge built-in tools
  const ffConfig = getFlowForgeMcpConfig();
  if (ffConfig) config.flowforge = ffConfig;

  // External servers (Linear, Postgres, MongoDB, etc.)
  const external = await loadMcpServers(db);
  Object.assign(config, external);

  return config;
}
