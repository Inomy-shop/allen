/**
 * MCP Server Loader (shared)
 * Loads enabled MCP server configs from MongoDB and returns them
 * in the format expected by Claude Code SDK's mcpServers option.
 * Also builds the FlowForge MCP server config.
 */

import type { Db } from 'mongodb';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Load all enabled external MCP servers from the database
 * and return as Claude Code SDK mcpServers config.
 */
export async function loadMcpServers(db: Db): Promise<Record<string, unknown>> {
  const servers = await db.collection('mcp_servers')
    .find({ enabled: true, type: 'stdio' })
    .toArray();

  const config: Record<string, unknown> = {};

  for (const s of servers) {
    config[s.name as string] = {
      type: 'stdio',
      command: s.command,
      args: s.args ?? [],
      env: s.env ?? {},
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
