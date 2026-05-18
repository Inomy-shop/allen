/**
 * MCP Health Monitor
 *
 * Background service that pings every enabled MCP server on a fixed interval
 * (default: 5 minutes). On a healthy → failed *transition*, fires an alert via
 * AlertService.onMcpServerDisconnected so it shows up in the notification bell.
 * On a failed → healthy transition, fires an info-level recovery alert.
 *
 * The check is intentionally lightweight: spawn the MCP child process, do the
 * MCP `initialize` + `tools/list` JSON-RPC handshake, then kill the process.
 * No LLM call. No persistent connection cache (every check spawns a fresh
 * process so previously-cached connections can't mask broken servers).
 *
 * stdio servers are tested by spawning. SSE/HTTP servers are tested by HTTP
 * GET against their URL with a short timeout.
 */

import type { Db } from 'mongodb';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { McpService, type McpServerRecord } from './mcp.service.js';
import { buildSingleServerConfig } from '@allen/engine';
import { AlertService } from './alert.service.js';

// ── Config ──

const HEALTH_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const STARTUP_DELAY_MS = 30 * 1000; // wait 30s after boot before first check
const HANDSHAKE_TIMEOUT_MS = 15 * 1000; // each RPC waits at most 15s
const SPAWN_TIMEOUT_MS = 30 * 1000; // total per-server budget incl. process startup
const SSE_HTTP_TIMEOUT_MS = 10 * 1000;
const KILL_GRACE_MS = 3_000; // SIGTERM → SIGKILL grace period during teardown

// ── Result type ──

export interface HealthCheckResult {
  ok: boolean;
  toolCount?: number;
  serverInfo?: { name: string; version: string };
  error?: string;
  durationMs: number;
}

// ── Stdio handshake ──

/**
 * Spawn an MCP stdio server, do the JSON-RPC initialize + tools/list handshake,
 * then tear it down. Resolves with the result regardless of success/failure.
 */
// finish() adds durationMs from the closure, so its callers pass everything except that.
type PartialResult = Omit<HealthCheckResult, 'durationMs'>;

async function checkStdioServer(server: McpServerRecord, db: Db): Promise<HealthCheckResult> {
  const startMs = Date.now();

  // Route through the shared spawn-config resolver so source-based records
  // (preset / repo) AND legacy bundle records both work — same logic the
  // loader uses at agent-execution time.
  let spawnCfg: Record<string, unknown> | null = null;
  try {
    spawnCfg = await buildSingleServerConfig(server as unknown as Record<string, unknown>, db);
  } catch (err) {
    return { ok: false, error: `failed to resolve spawn config: ${(err as Error).message}`, durationMs: Date.now() - startMs };
  }
  if (!spawnCfg) {
    return { ok: false, error: 'spawn config could not be resolved', durationMs: Date.now() - startMs };
  }

  const command = (spawnCfg.command as string | undefined) ?? '';
  if (!command) {
    return { ok: false, error: 'No command configured', durationMs: Date.now() - startMs };
  }
  const args = (spawnCfg.args as string[]) ?? [];
  const env = (spawnCfg.env as Record<string, string>) ?? {};
  const cwd = spawnCfg.cwd as string | undefined;

  // Log the spawn command for diagnostics — NEVER log env values (may contain secrets)
  console.log(`[mcp-health] stdio check: server="${server.name}" cmd="${command}" args=[${args.map(a => JSON.stringify(a)).join(', ')}]`);

  return new Promise<HealthCheckResult>((resolve) => {
    let proc: ReturnType<typeof spawn> | null = null;
    let buffer = '';
    let settled = false;
    // Capture stderr so we can surface it in the error message when the child
    // exits prematurely. Bounded to STDERR_TAIL_BYTES — Python tracebacks are
    // a few hundred bytes; 1KB covers ModuleNotFoundError + traceback comfortably.
    const STDERR_TAIL_BYTES = 1024;
    let stderrTail = '';
    const pending = new Map<string | number, (msg: any) => void>();

    const finish = (result: PartialResult) => {
      if (settled) return;
      settled = true;

      if (proc != null) {
        const pid = proc.pid;
        // Destroy stdin so the MCP server sees EOF (clean shutdown signal)
        try { proc.stdin?.destroy(); } catch { /* ignore */ }
        // Resume stdout/stderr to drain buffered data and unblock the pipe
        try { proc.stdout?.resume(); } catch { /* ignore */ }
        try { proc.stderr?.resume(); } catch { /* ignore */ }

        if (pid != null) {
          // Group-kill: negative PID sends signal to every process in the group.
          // With detached:true, PGID === child PID, so this catches the full
          // npx → sh → node mcp-mongo-server chain in one call.
          // On EPERM (rare setsid() race), fall back to per-process kill rather
          // than silently dropping — same pattern as chat-mcp-client.ts.
          const killGroup = (sig: NodeJS.Signals): void => {
            try {
              process.kill(-pid, sig);
            } catch (err) {
              const code = (err as NodeJS.ErrnoException).code;
              if (code !== 'ESRCH') {
                // EPERM or unexpected error — fall back to per-process kill
                try { proc!.kill(sig); } catch { /* ignore */ }
              }
              // ESRCH = process already gone, nothing to do
            }
          };
          killGroup('SIGTERM');
          // Escalate to SIGKILL after grace period
          setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS).unref();
        } else {
          // No PID (spawn failed early) — fallback to direct kill
          try { proc.kill('SIGKILL'); } catch { /* ignore */ }
        }
      }

      resolve({ ...result, durationMs: Date.now() - startMs });
    };

    const overallTimeout = setTimeout(() => {
      finish({ ok: false, error: `Health check timed out after ${SPAWN_TIMEOUT_MS}ms` });
    }, SPAWN_TIMEOUT_MS);

    try {
      proc = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,   // child gets its own process group → group-kill works
      });
    } catch (err) {
      clearTimeout(overallTimeout);
      finish({ ok: false, error: `spawn failed: ${(err as Error).message}` });
      return;
    }

    // Narrow `proc` to a non-null local for the rest of this scope
    const childProc = proc;

    childProc.on('error', (err) => {
      clearTimeout(overallTimeout);
      finish({ ok: false, error: `process error: ${err.message}` });
    });

    childProc.on('exit', (code, signal) => {
      if (settled) return;
      // Process died before handshake completed
      clearTimeout(overallTimeout);
      const baseMsg = `process exited prematurely (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
      const stderrTrimmed = stderrTail.trim();
      finish({
        ok: false,
        error: stderrTrimmed
          ? `${baseMsg}\nstderr: ${stderrTrimmed}`
          : baseMsg,
      });
    });

    childProc.stdout?.on('data', (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null && pending.has(msg.id)) {
            const cb = pending.get(msg.id)!;
            pending.delete(msg.id);
            cb(msg);
          }
        } catch { /* skip non-JSON noise */ }
      }
    });

    // Drain stderr to keep the pipe flowing AND retain the most recent
    // STDERR_TAIL_BYTES so the exit handler can surface it (e.g. Python
    // ModuleNotFoundError tracebacks would otherwise vanish).
    childProc.stderr?.on('data', (chunk: Buffer) => {
      stderrTail += chunk.toString();
      if (stderrTail.length > STDERR_TAIL_BYTES) {
        stderrTail = stderrTail.slice(-STDERR_TAIL_BYTES);
      }
    });

    // Swallow stream errors (EPIPE when the child dies mid-write, etc.) so
    // they don't surface as uncaughtException and crash the whole server.
    // The exit/timeout handlers above are responsible for settling the promise.
    childProc.stdin?.on('error', () => { /* handled via exit/timeout */ });
    childProc.stdout?.on('error', () => { /* handled via exit/timeout */ });
    childProc.stderr?.on('error', () => { /* handled via exit/timeout */ });

    const sendRpc = (method: string, params?: unknown): Promise<any> => {
      const id = randomUUID();
      return new Promise((rpcResolve, rpcReject) => {
        const t = setTimeout(() => {
          pending.delete(id);
          rpcReject(new Error(`RPC ${method} timed out after ${HANDSHAKE_TIMEOUT_MS}ms`));
        }, HANDSHAKE_TIMEOUT_MS);
        pending.set(id, (msg) => {
          clearTimeout(t);
          if (msg.error) rpcReject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
          else rpcResolve(msg.result);
        });
        const stdin = childProc.stdin;
        if (!stdin || stdin.destroyed || !stdin.writable) {
          clearTimeout(t);
          pending.delete(id);
          rpcReject(new Error('child stdin is not writable'));
          return;
        }
        const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }) + '\n';
        try {
          // Use the callback form so async write failures (EPIPE when the
          // child dies between calls) become RPC rejections instead of
          // uncaught 'error' events on the stream.
          stdin.write(payload, (err) => {
            if (err) {
              clearTimeout(t);
              pending.delete(id);
              rpcReject(err);
            }
          });
        } catch (err) {
          clearTimeout(t);
          pending.delete(id);
          rpcReject(err as Error);
        }
      });
    };

    // Run the handshake
    (async () => {
      try {
        // Give the process a brief moment to start before sending the first byte
        await new Promise(r => setTimeout(r, 500));

        const initResult = await sendRpc('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'allen-health-monitor', version: '1.0.0' },
        });

        const toolsResult = await sendRpc('tools/list') as {
          tools?: Array<{ name: string }>;
        };

        clearTimeout(overallTimeout);
        finish({
          ok: true,
          toolCount: toolsResult.tools?.length ?? 0,
          serverInfo: initResult?.serverInfo,
        });
      } catch (err) {
        clearTimeout(overallTimeout);
        finish({ ok: false, error: (err as Error).message });
      }
    })();
  });
}

// ── SSE / HTTP servers ──

async function checkRemoteServer(server: McpServerRecord): Promise<HealthCheckResult> {
  const startMs = Date.now();
  if (!server.url) {
    return { ok: false, error: 'No URL configured', durationMs: 0 };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SSE_HTTP_TIMEOUT_MS);
  try {
    const resp = await fetch(server.url, {
      method: 'GET',
      headers: server.headers ?? {},
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (resp.status >= 200 && resp.status < 500) {
      // 2xx/3xx/4xx all mean "the server responded" — only 5xx + network errors fail
      return { ok: true, durationMs: Date.now() - startMs };
    }
    return { ok: false, error: `HTTP ${resp.status}`, durationMs: Date.now() - startMs };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, error: (err as Error).message, durationMs: Date.now() - startMs };
  }
}

// ── Public API ──

/**
 * Check a single MCP server. Returns a result regardless of outcome — never throws.
 */
export async function healthCheckMcpServer(server: McpServerRecord, db: Db): Promise<HealthCheckResult> {
  if (!server.enabled) {
    return { ok: false, error: 'Server is disabled', durationMs: 0 };
  }
  try {
    if (server.type === 'stdio') return await checkStdioServer(server, db);
    return await checkRemoteServer(server);
  } catch (err) {
    return { ok: false, error: `health check threw: ${(err as Error).message}`, durationMs: 0 };
  }
}

// ── Background loop ──

let intervalHandle: NodeJS.Timeout | null = null;
let running = false;

/**
 * Run one pass: walk all enabled MCP servers, check each, update status, and
 * fire alerts on healthy↔failed transitions.
 */
async function runHealthCheckPass(db: Db): Promise<void> {
  if (running) {
    console.log('[mcp-health] Skipping pass — previous pass still running');
    return;
  }
  running = true;
  const startedAt = Date.now();

  try {
    const mcpService = new McpService(db);
    const alertService = new AlertService(db);
    const servers = (await mcpService.list()).filter(s => s.enabled);

    if (servers.length === 0) return;

    let healthy = 0;
    let failed = 0;
    let recovered = 0;
    let newlyFailed = 0;

    // Run checks sequentially to avoid spawning N child processes at once
    for (const server of servers) {
      const previousStatus = server.status;
      const result = await healthCheckMcpServer(server, db);
      const newStatus = result.ok ? 'connected' : 'failed';

      // Persist status
      await mcpService.updateStatus(server._id!.toString(), newStatus, {
        serverInfo: result.serverInfo,
        toolCount: result.toolCount,
        error: result.error,
      });

      // Detect transitions and fire alerts
      if (newStatus === 'failed' && previousStatus === 'connected') {
        // Healthy → failed: notify the user
        await alertService.onMcpServerDisconnected(
          server.name,
          result.error ?? 'unknown error',
        );
        newlyFailed++;
      } else if (newStatus === 'connected' && previousStatus === 'failed') {
        // Failed → healthy: post a recovery info alert
        await alertService.create({
          title: `MCP server recovered: ${server.name}`,
          message: `Reconnected successfully${result.toolCount != null ? ` (${result.toolCount} tools)` : ''}`,
          severity: 'info',
          category: 'mcp',
          meta: { serverName: server.name },
        });
        recovered++;
      }

      if (result.ok) healthy++;
      else failed++;
    }

    const durationMs = Date.now() - startedAt;
    const summary = `${healthy} healthy, ${failed} failed${newlyFailed > 0 ? ` (${newlyFailed} newly down)` : ''}${recovered > 0 ? ` (${recovered} recovered)` : ''}`;
    console.log(`[mcp-health] Check complete in ${durationMs}ms: ${summary}`);
  } catch (err) {
    console.error('[mcp-health] Pass failed:', (err as Error).message);
  } finally {
    running = false;
  }
}

/**
 * Start the background health-check loop. Runs once after a 30s startup delay,
 * then every 5 minutes. Safe to call multiple times — only one loop runs.
 */
export function startMcpHealthMonitor(db: Db): void {
  if (intervalHandle) {
    console.warn('[mcp-health] Monitor already running');
    return;
  }
  console.log(`[mcp-health] Monitor starting — first check in ${STARTUP_DELAY_MS / 1000}s, then every ${HEALTH_CHECK_INTERVAL_MS / 60000}min`);

  // First check after startup delay (don't slow down boot)
  setTimeout(() => { void runHealthCheckPass(db); }, STARTUP_DELAY_MS);

  // Recurring checks
  intervalHandle = setInterval(() => { void runHealthCheckPass(db); }, HEALTH_CHECK_INTERVAL_MS);
  // Allow process to exit cleanly during dev
  intervalHandle.unref?.();
}

/** Stop the background loop. Mainly for tests. */
export function stopMcpHealthMonitor(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
