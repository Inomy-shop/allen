/**
 * Chat MCP Config Builder
 * Loads user-configured external MCP servers from MongoDB
 * and builds the config object for Claude Code SDK.
 */

import type { Db } from 'mongodb';
import { McpService } from './mcp.service.js';

/**
 * Load all enabled external MCP servers from the database
 * and return them as a Claude Code SDK mcpServers config.
 */
export async function loadExternalMcpServers(db: Db): Promise<Record<string, unknown>> {
  const service = new McpService(db);
  return service.getEnabledAsConfig();
}
