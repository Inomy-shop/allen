/**
 * MCP Client for the Codex CLI provider.
 * Spawns MCP server processes, discovers tools, and executes tool calls.
 * (Claude CLI handles its own MCP wiring via the @anthropic-ai/claude-code SDK.)
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { McpService, type McpServerRecord, resolveEnvSecrets, resolveArgSecrets } from './mcp.service.js';

// ── Types ──

export interface McpTool {
  serverName: string;
  name: string;
  fullName: string; // serverName__toolName (matches Claude CLI naming)
  description: string;
  inputSchema: Record<string, unknown>;
}

interface McpConnection {
  serverName: string;
  process: ChildProcess;
  tools: McpTool[];
  pendingRequests: Map<string | number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  buffer: string;
}

// ── Active connections ──
const connections = new Map<string, McpConnection>();

// ── JSON-RPC helpers ──

function sendRpc(conn: McpConnection, method: string, params?: unknown): Promise<unknown> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    conn.pendingRequests.set(id, { resolve, reject });
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} });
    conn.process.stdin?.write(msg + '\n');

    // Timeout after 15s
    setTimeout(() => {
      if (conn.pendingRequests.has(id)) {
        conn.pendingRequests.delete(id);
        reject(new Error(`MCP RPC timeout: ${method}`));
      }
    }, 15000);
  });
}

function handleStdout(conn: McpConnection, data: string): void {
  conn.buffer += data;
  const lines = conn.buffer.split('\n');
  conn.buffer = lines.pop() ?? '';

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && conn.pendingRequests.has(msg.id)) {
        const pending = conn.pendingRequests.get(msg.id)!;
        conn.pendingRequests.delete(msg.id);
        if (msg.error) pending.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        else pending.resolve(msg.result);
      }
    } catch { /* skip non-JSON lines */ }
  }
}

// ── Connection Management ──

async function connectServer(server: McpServerRecord, db: Db): Promise<McpConnection> {
  // Check if already connected
  const existing = connections.get(server.name);
  if (existing && !existing.process.killed) return existing;

  if (server.type !== 'stdio') {
    throw new Error(`MCP client only supports stdio servers, got: ${server.type}`);
  }

  // Resolve any @secret: references in both env and args from the encrypted
  // secrets store before passing them to the spawned process.
  const [resolvedEnv, resolvedArgs] = await Promise.all([
    resolveEnvSecrets(server.env, db),
    resolveArgSecrets(server.args, db),
  ]);

  const proc = spawn(server.command!, resolvedArgs, {
    env: { ...process.env, ...resolvedEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const conn: McpConnection = {
    serverName: server.name,
    process: proc,
    tools: [],
    pendingRequests: new Map(),
    buffer: '',
  };

  proc.stdout?.on('data', (data: Buffer) => handleStdout(conn, data.toString()));
  proc.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) console.log(`\x1b[33m[mcp:${server.name}]\x1b[0m ${msg}`);
  });
  proc.on('close', () => { connections.delete(server.name); });

  connections.set(server.name, conn);

  // Wait for process to start
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Initialize MCP handshake
  await sendRpc(conn, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'flowforge-chat', version: '1.0.0' },
  });

  // Discover tools
  const toolsResult = await sendRpc(conn, 'tools/list') as { tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> };

  conn.tools = (toolsResult.tools ?? []).map(t => ({
    serverName: server.name,
    name: t.name,
    fullName: `mcp__${server.name}__${t.name}`,
    description: t.description ?? '',
    inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
  }));

  console.log(`\x1b[32m[mcp]\x1b[0m Connected to ${server.name}: ${conn.tools.length} tools`);
  return conn;
}

// ── Public API ──

/**
 * Load all enabled MCP servers, connect to them, and return their tools
 * as function definitions that can be registered with any LLM provider.
 */
export async function loadMcpTools(db: Db): Promise<McpTool[]> {
  const service = new McpService(db);
  const servers = (await service.list()).filter(s => s.enabled && s.type === 'stdio');

  const allTools: McpTool[] = [];
  for (const server of servers) {
    try {
      const conn = await connectServer(server, db);
      allTools.push(...conn.tools);
    } catch (err) {
      console.error(`\x1b[31m[mcp]\x1b[0m Failed to connect to ${server.name}:`, (err as Error).message);
    }
  }
  return allTools;
}

/**
 * Execute an MCP tool call. Finds the right server and sends the call.
 */
export async function executeMcpTool(
  fullName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // Parse server name and tool name from fullName: mcp__linear__linear_search_issues
  const parts = fullName.split('__');
  if (parts.length < 3 || parts[0] !== 'mcp') {
    return { error: `Invalid MCP tool name: ${fullName}` };
  }
  const serverName = parts[1];
  const toolName = parts.slice(2).join('__');

  const conn = connections.get(serverName);
  if (!conn || conn.process.killed) {
    return { error: `MCP server "${serverName}" is not connected` };
  }

  try {
    const result = await sendRpc(conn, 'tools/call', { name: toolName, arguments: args }) as {
      content: Array<{ type: string; text?: string }>;
    };

    // Parse the result content
    const textContent = (result.content ?? [])
      .filter(c => c.type === 'text')
      .map(c => c.text ?? '')
      .join('');

    try {
      return JSON.parse(textContent);
    } catch {
      return { result: textContent };
    }
  } catch (err) {
    return { error: `MCP tool ${fullName} failed: ${(err as Error).message}` };
  }
}

/**
 * Check if a tool name is an MCP tool.
 */
export function isMcpTool(name: string): boolean {
  return name.startsWith('mcp__');
}

/**
 * Disconnect all MCP servers.
 */
export function disconnectAll(): void {
  for (const conn of connections.values()) {
    try { conn.process.kill(); } catch {}
  }
  connections.clear();
}
