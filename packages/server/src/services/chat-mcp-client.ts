/**
 * MCP Client for the Codex CLI provider.
 * Spawns MCP server processes, discovers tools, and executes tool calls.
 * (Claude CLI handles its own MCP wiring via the @anthropic-ai/claude-code SDK.)
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { buildSingleServerConfig } from '@allen/engine';
import { McpService, type McpServerRecord } from './mcp.service.js';

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
// In-flight spawn promises so two concurrent loadMcpTools() calls don't
// double-spawn the same server. Without this, the 2026-04-29 audit found
// 481 leaked mcp-mongo-server processes accumulated over 11h — the gap
// between spawn() and connections.set() (after a 1s sleep + handshake) is
// long enough for many parallel callers to all decide "no existing
// connection, spawn a fresh one." Keyed by server name; resolves to the
// connection once handshake completes.
const inFlightSpawns = new Map<string, Promise<McpConnection>>();

// Force-kill the entire process group of an MCP child. Without this,
// mcp-mongo-server keeps its node event loop alive via the MongoDB
// driver's heartbeat timers and never exits on stdin EOF, leaking 11
// threads and ~30 MB of swap per orphan. Pairs with detached:true on
// spawn so the MCP becomes its own group leader and a negative-pid kill
// reaches every descendant (npx → npm → sh → node).
function killMcpProcessGroup(proc: ChildProcess, sig: NodeJS.Signals = 'SIGTERM'): void {
  if (proc.pid == null) return;
  try { process.kill(-proc.pid, sig); }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ESRCH = group already gone, fine. EPERM = group leader gap (we
    // missed the detached path); fall back to per-PID kill so we at
    // least terminate the immediate child.
    if (code !== 'ESRCH') {
      try { proc.kill(sig); } catch { /* ignore */ }
    }
  }
}

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
  // Already connected?
  const existing = connections.get(server.name);
  if (existing && !existing.process.killed && existing.process.exitCode === null) {
    return existing;
  }

  // Already being spawned by a concurrent caller? Wait for it instead of
  // racing. This was the 2026-04-29 leak's primary cause: the gap between
  // spawn() and connections.set() (post-handshake) let parallel agent
  // starts double-spawn the same MCP server.
  const inFlight = inFlightSpawns.get(server.name);
  if (inFlight) return inFlight;

  if (server.type !== 'stdio') {
    throw new Error(`MCP client only supports stdio servers, got: ${server.type}`);
  }

  const promise = (async (): Promise<McpConnection> => {
    // Resolve via the shared spawn-config resolver so source-based
    // (preset/repo) and legacy bundle records both spawn through a single
    // code path.
    const cfg = await buildSingleServerConfig(server as unknown as Record<string, unknown>, db);
    if (!cfg) throw new Error(`Could not resolve spawn config for MCP server "${server.name}"`);
    const resolvedArgs = (cfg.args as string[]) ?? [];
    const resolvedEnv = (cfg.env as Record<string, string>) ?? {};
    const resolvedCwd = cfg.cwd as string | undefined;
    const resolvedCmd = (cfg.command as string) ?? server.command ?? '';

    const proc = spawn(resolvedCmd, resolvedArgs, {
      cwd: resolvedCwd,
      env: { ...process.env, ...resolvedEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
      // Make this MCP its own process-group leader so killMcpProcessGroup()
      // can take down its npx → npm → sh → node descendant chain in one
      // negative-pid signal. Without this, killing the immediate proc
      // leaves zombies that pin allen.service's cgroup pids ceiling.
      detached: true,
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

    try {
      // Wait for process to start
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Initialize MCP handshake
      await sendRpc(conn, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'allen-chat', version: '1.0.0' },
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

      // Only register AFTER the handshake succeeds, so a partially-spawned
      // server isn't mistaken for a healthy one by later callers.
      connections.set(server.name, conn);

      console.log(`\x1b[32m[mcp]\x1b[0m Connected to ${server.name}: ${conn.tools.length} tools`);
      return conn;
    } catch (err) {
      // Handshake failed — kill the spawned process tree so it doesn't
      // leak. Without this, every failed handshake left a 65 MB
      // mcp-mongo-server orphan running in ep_poll forever.
      console.warn(`\x1b[31m[mcp]\x1b[0m ${server.name} handshake failed, killing process group:`, (err as Error).message);
      killMcpProcessGroup(proc, 'SIGTERM');
      setTimeout(() => killMcpProcessGroup(proc, 'SIGKILL'), 2_000).unref();
      throw err;
    }
  })();

  inFlightSpawns.set(server.name, promise);
  try {
    return await promise;
  } finally {
    inFlightSpawns.delete(server.name);
  }
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
 * Disconnect all MCP servers. Sends SIGTERM to each MCP's whole process
 * group (because each was spawned with detached:true) so the npx → npm
 * → sh → node descendant chain dies together. SIGKILL escalation 2s
 * later catches anything that ignores SIGTERM.
 */
export function disconnectAll(): void {
  for (const conn of connections.values()) {
    killMcpProcessGroup(conn.process, 'SIGTERM');
    setTimeout(() => killMcpProcessGroup(conn.process, 'SIGKILL'), 2_000).unref();
  }
  connections.clear();
}
