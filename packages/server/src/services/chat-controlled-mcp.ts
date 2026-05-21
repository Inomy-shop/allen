import type { Db } from 'mongodb';
import { dirname, resolve } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { MCP_SERVER_NAME } from '@allen/engine';
import { loadExternalMcpServers } from './chat-mcp.js';

export interface ControlledMcpOptions {
  db: Db;
  chatSessionId?: string;
  runtimeId: string;
  skipTools?: boolean;
}

export interface ControlledMcpConfig {
  servers: Record<string, Record<string, unknown>>;
  claudeConfigPath?: string;
  codexInlineConfig: string;
}

function getAllenMcpServerPath(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const tsPath = resolve(thisDir, 'allen-mcp-server.ts');
  if (existsSync(tsPath)) return tsPath;
  return resolve(thisDir, 'allen-mcp-server.js');
}

function getAllenMcpServerConfig(chatSessionId: string | undefined, runtimeId: string): Record<string, unknown> {
  const serverPath = getAllenMcpServerPath();
  const runner = serverPath.endsWith('.ts')
    ? { command: 'npx', args: ['tsx', serverPath] }
    : { command: 'node', args: [serverPath] };

  return {
    type: 'stdio',
    command: runner.command,
    args: runner.args,
    env: {
      ALLEN_API_URL: `http://localhost:${process.env.PORT ?? '4023'}`,
      ALLEN_PUBLIC_URL: process.env.ALLEN_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? '4023'}`,
      JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET ?? '',
      AI_RUNTIME_ID: runtimeId,
      ...(chatSessionId
        ? {
            ALLEN_ARTIFACT_ROOT_TYPE: 'chat',
            ALLEN_ARTIFACT_ROOT_ID: chatSessionId,
            ALLEN_CHAT_SESSION_ID: chatSessionId,
          }
        : {}),
    },
  };
}

export async function buildControlledMcpConfig(options: ControlledMcpOptions): Promise<ControlledMcpConfig> {
  const servers: Record<string, Record<string, unknown>> = {};
  if (!options.skipTools) {
    servers[MCP_SERVER_NAME] = getAllenMcpServerConfig(options.chatSessionId, options.runtimeId);
    const external = await loadExternalMcpServers(options.db);
    for (const [name, cfg] of Object.entries(external)) {
      if (cfg && typeof cfg === 'object') servers[name] = cfg as Record<string, unknown>;
    }
  }
  return {
    servers,
    codexInlineConfig: `mcp_servers=${toTomlInlineTable(toCodexMcpServers(servers))}`,
  };
}

export function writeClaudeMcpConfigFile(runtimeId: string, servers: Record<string, Record<string, unknown>>): string {
  const dir = resolve(tmpdir(), 'allen-chat-runtime-mcp');
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${runtimeId}.json`);
  writeFileSync(path, JSON.stringify({ mcpServers: servers }, null, 2) + '\n');
  return path;
}

function toTomlInlineTable(value: Record<string, unknown>): string {
  const entries = Object.entries(value).map(([key, item]) => `${tomlKey(key)}=${toTomlValue(item)}`);
  return `{${entries.join(',')}}`;
}

function toTomlValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(toTomlValue).join(',')}]`;
  if (value && typeof value === 'object') return toTomlInlineTable(value as Record<string, unknown>);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return '""';
  return JSON.stringify(String(value));
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function toCodexMcpServers(servers: Record<string, Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    const command = typeof cfg.command === 'string' ? cfg.command : '';
    if (!command) continue;
    out[name] = {
      command,
      args: Array.isArray(cfg.args) ? cfg.args : [],
      ...(cfg.cwd ? { cwd: cfg.cwd } : {}),
      env: cfg.env && typeof cfg.env === 'object' ? cfg.env : {},
    };
  }
  return out;
}
