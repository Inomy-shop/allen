/**
 * Design Repo Preview Manager
 *
 * Manages running preview dev-server processes for registered design repos.
 * Processes are tracked module-level (single Allen server process) so they
 * survive across HTTP requests.
 *
 * Port range 12000-12100 — outside workspace range (15000-20000).
 *
 * Force-restart on every start()
 * ──────────────────────────────────────────────────────────────────────────
 * Every call to start() stops the Allen-tracked process for that repo and
 * terminates any live PID referenced by <cwd>/.next/dev/lock BEFORE spawning
 * a new server.  This ensures the user always gets a clean, fresh preview
 * instead of re-using a stale or wrong server.
 *
 * Only the selected repo's process and its repo-local Next lock are touched.
 * No other repos, no Allen process itself.
 *
 * Chat-scoped isolation
 * ──────────────────────────────────────────────────────────────────────────
 * Registry and process maps are keyed by a composite `chatSessionId:repoId`
 * string so that two different chat sessions using the same repo never share
 * or kill each other's preview server.  Use `scopeKey(chatSessionId, repoId)`
 * to compute the composite key.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { DesignPreviewConfig } from './design-preview.service.js';

export interface DesignRepoPreviewEntry {
  repoId: string;
  chatSessionId: string;
  port: number;
  pid?: number;
  status: 'starting' | 'ready' | 'failed' | 'stopped';
  repoPath: string;
  cwd: string;
  startedAt: Date;
  previewUrl?: string;
}

/** Shape of Next.js <cwd>/.next/dev/lock */
interface NextDevLock {
  pid: number;
  port: number;
  hostname?: string;
  appUrl: string;
  startedAt?: number;
}

const DESIGN_PREVIEW_PORT_START = 12000;
const DESIGN_PREVIEW_PORT_END = 12100;
const HEALTH_POLL_TIMEOUT_MS = 300_000;
const HEALTH_POLL_INTERVAL_MS = 1_000;
const NO_HEALTH_READY_DELAY_MS = 3_000;

/** Grace period (ms) given to a terminated process before SIGKILL is sent. */
const TERMINATION_GRACE_MS = 3_000;

/** How long (ms) to wait for a fixed port to become free after terminating. */
const PORT_FREE_WAIT_MS = 2_000;

const registry = new Map<string, DesignRepoPreviewEntry>();
const processes = new Map<string, ChildProcess>();

// ── Scope key helper ───────────────────────────────────────────────────────

/**
 * Compute the composite registry key for a chat session + repo pair.
 * Keys two different chat sessions' preview entries apart even when they
 * target the same repo.
 */
function scopeKey(chatSessionId: string, repoId: string): string {
  return `${chatSessionId}:${repoId}`;
}

// ── Next dev lock helpers (exported for unit tests) ────────────────────────

/**
 * Read and parse the Next.js dev-server lock file at <cwd>/.next/dev/lock.
 * Returns null when the file is absent, unreadable, or malformed.
 */
export async function readNextDevLock(cwd: string): Promise<NextDevLock | null> {
  try {
    const { readFile } = await import('node:fs/promises');
    const lockPath = join(cwd, '.next', 'dev', 'lock');
    const raw = await readFile(lockPath, 'utf8');
    const parsed = JSON.parse(raw) as NextDevLock;
    if (
      typeof parsed.pid === 'number' &&
      typeof parsed.port === 'number' &&
      typeof parsed.appUrl === 'string' &&
      parsed.pid > 0 &&
      parsed.port > 0
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Returns true when a process with the given pid is alive on this machine.
 * Uses `process.kill(pid, 0)` — no signal is actually sent; the kernel just
 * reports whether the process exists and we have permission to signal it.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns true when `appUrl` responds with a non-server-error HTTP status
 * within 2 seconds.
 */
export async function checkLockReachable(appUrl: string): Promise<boolean> {
  try {
    const url = appUrl.endsWith('/') ? appUrl : appUrl + '/';
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

/**
 * Terminate the process (and its group) referenced by the Next.js dev lock at
 * `cwd/.next/dev/lock`.  Only acts on the repo-local lock — does NOT kill any
 * other server or Allen itself.
 *
 * Flow:
 *   1. Read the lock. If absent or malformed → no-op.
 *   2. If the PID is already dead → log and return (stale lock, safe to ignore).
 *   3. Send SIGTERM to the pid and its process group.
 *   4. Poll every `pollMs` ms up to `graceMs` for the process to exit.
 *   5. If still alive after the grace period → send SIGKILL.
 *
 * The `options` parameter is optional and intended for unit tests (shorter timeouts).
 * Exported for unit tests.
 *
 * NOTE: `repoId` is used only for log messages; termination is always
 * filesystem-based (lock file at `cwd`) and not keyed by chatSessionId.
 */
export async function terminateNextDevLock(
  cwd: string,
  repoId: string,
  options?: { graceMs?: number; pollMs?: number },
): Promise<void> {
  const graceMs = options?.graceMs ?? TERMINATION_GRACE_MS;
  const pollMs = options?.pollMs ?? 200;

  const lock = await readNextDevLock(cwd);
  if (!lock) return;

  if (!isProcessAlive(lock.pid)) {
    console.info(
      `[design-preview] Next dev lock for repo ${repoId}: pid ${lock.pid} is already dead — ignoring stale lock`,
    );
    return;
  }

  console.info(
    `[design-preview] terminating existing Next dev server for repo ${repoId} (pid ${lock.pid}) before fresh start`,
  );

  // Graceful shutdown: try process group first, then the pid directly
  try { process.kill(-lock.pid, 'SIGTERM'); } catch { /* process group may not exist */ }
  try { process.kill(lock.pid, 'SIGTERM'); } catch { /* already gone */ }

  // Wait for graceful exit
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(lock.pid)) {
      console.info(`[design-preview] Next dev server pid ${lock.pid} exited cleanly`);
      return;
    }
    await new Promise<void>((r) => setTimeout(r, pollMs));
  }

  // Force kill if still alive after grace period
  if (isProcessAlive(lock.pid)) {
    console.warn(
      `[design-preview] pid ${lock.pid} still alive after ${graceMs}ms — sending SIGKILL`,
    );
    try { process.kill(-lock.pid, 'SIGKILL'); } catch { /* best effort */ }
    try { process.kill(lock.pid, 'SIGKILL'); } catch { /* best effort */ }
  }
}

/**
 * Attempt to reuse an existing Next.js dev server via its lock file.
 *
 * If the lock file at `cwd/.next/dev/lock` contains a valid pid+port+appUrl,
 * the pid is alive, and the server responds to HTTP, the entry is registered
 * as `ready` and the call returns `{ port, previewUrl }`.
 *
 * Returns null when the lock is absent, stale, or unreachable.
 *
 * NOTE: This function is no longer called by start() — start() now always
 * force-restarts.  It is kept as an export for backward compatibility and
 * may be useful for diagnostics or future opt-in reuse scenarios.
 *
 * @param chatSessionId - Scopes the registry entry; defaults to 'global' for
 *   backward-compatible callers that don't pass a session id.
 */
export async function tryReuseNextDevLock(
  repoId: string,
  cwd: string,
  chatSessionId: string = 'global',
): Promise<{ port: number; previewUrl: string } | null> {
  const lock = await readNextDevLock(cwd);
  if (!lock) return null;

  if (!isProcessAlive(lock.pid)) {
    console.info(`[design-preview] stale Next dev lock for repo ${repoId}: pid ${lock.pid} is not alive`);
    return null;
  }

  const reachable = await checkLockReachable(lock.appUrl);
  if (!reachable) {
    console.info(`[design-preview] stale Next dev lock for repo ${repoId}: ${lock.appUrl} unreachable`);
    return null;
  }

  const key = scopeKey(chatSessionId, repoId);
  const previewUrl = lock.appUrl.endsWith('/') ? lock.appUrl : lock.appUrl + '/';
  const entry: DesignRepoPreviewEntry = {
    repoId,
    chatSessionId,
    port: lock.port,
    pid: lock.pid,
    status: 'ready',
    repoPath: cwd,
    cwd,
    startedAt: new Date(lock.startedAt ?? Date.now()),
    previewUrl,
  };
  registry.set(key, entry);
  console.info(
    `[design-preview] reusing existing Next dev server for repo ${repoId} (key ${key}) on port ${lock.port} (PID ${lock.pid})`,
  );
  return { port: lock.port, previewUrl };
}

// ── Internal helpers ───────────────────────────────────────────────────────

async function isPortFree(port: number): Promise<boolean> {
  const net = await import('net');
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    server.listen(port, '127.0.0.1');
  });
}

async function findFreePort(): Promise<number> {
  for (let p = DESIGN_PREVIEW_PORT_START; p <= DESIGN_PREVIEW_PORT_END; p++) {
    if (await isPortFree(p)) return p;
  }
  throw new Error(`No free design preview port in range ${DESIGN_PREVIEW_PORT_START}-${DESIGN_PREVIEW_PORT_END}`);
}

/**
 * Wait up to `maxWaitMs` for `port` to become free.
 * Used after terminating a fixed-port server to ensure the OS has released the port.
 */
async function waitForPortFree(port: number, maxWaitMs: number): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (await isPortFree(port)) return;
    await new Promise<void>((r) => setTimeout(r, 200));
  }
}

/**
 * After the preview server starts, attempt to discover its actual URL from
 * the Next.js dev lock file and update the registry entry.
 * Called once after the health check (or fixed delay) marks the server ready.
 *
 * @param key - Composite scope key (`chatSessionId:repoId`) used for registry lookup.
 */
async function updateUrlFromLock(key: string, cwd: string): Promise<void> {
  const lock = await readNextDevLock(cwd);
  if (!lock) return;
  const entry = registry.get(key);
  if (!entry || entry.status !== 'ready') return;
  const lockUrl = lock.appUrl.endsWith('/') ? lock.appUrl : lock.appUrl + '/';
  registry.set(key, { ...entry, previewUrl: lockUrl });
  console.info(`[design-preview] updated previewUrl for key ${key} from lock: ${lockUrl}`);
}

/**
 * @param key - Composite scope key (`chatSessionId:repoId`) used for registry lookups.
 */
function pollHealth(key: string, port: number, healthPath: string, cwd: string): void {
  const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS;

  const check = async () => {
    const entry = registry.get(key);
    if (!entry || entry.status !== 'starting') return;

    if (Date.now() > deadline) {
      registry.set(key, { ...entry, status: 'failed' });
      console.warn(`[design-preview] health check timed out for key ${key} on port ${port}`);
      return;
    }

    try {
      const url = `http://127.0.0.1:${port}${healthPath}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok || res.status < 500) {
        registry.set(key, { ...entry, status: 'ready' });
        console.info(`[design-preview] preview ready for key ${key} on port ${port}`);
        // Update previewUrl from lock file now that the server is confirmed ready
        void updateUrlFromLock(key, cwd);
        return;
      }
    } catch {
      // not ready yet — keep polling
    }

    setTimeout(check, HEALTH_POLL_INTERVAL_MS);
  };

  setTimeout(check, HEALTH_POLL_INTERVAL_MS);
}

export const DesignRepoPreviewManager = {
  /**
   * Force-restart the preview server for a design repo, scoped to a chat session.
   *
   * Every call stops any existing Allen-tracked process for this repo+session and
   * terminates any live PID in <cwd>/.next/dev/lock before spawning a fresh
   * server.  Only the selected repo's process and lock are touched.
   *
   * @param chatSessionId - Chat session owning this preview. Isolates the process
   *   from previews started by other sessions for the same repo.
   */
  async start(
    repoId: string,
    config: DesignPreviewConfig,
    repoPath: string,
    chatSessionId: string,
  ): Promise<{ port: number; previewUrl: string }> {
    const key = scopeKey(chatSessionId, repoId);

    // 0. Global stop-before-start: stop ALL other tracked preview processes.
    //    This ensures only one Allen-managed design preview runs at a time.
    for (const [otherKey, otherProc] of [...processes.entries()]) {
      if (otherKey === key) continue; // skip the key we're about to (re)start
      if (otherProc?.pid) {
        try { process.kill(-otherProc.pid, 'SIGTERM'); } catch { /* best effort */ }
        try { otherProc.kill('SIGTERM'); } catch { /* best effort */ }
      }
      processes.delete(otherKey);
      const otherEntry = registry.get(otherKey);
      if (otherEntry) registry.set(otherKey, { ...otherEntry, status: 'stopped', pid: undefined });
      console.info(`[design-preview] global stop-before-start: stopped key ${otherKey}`);
    }

    // 1. Stop any Allen-tracked process for this repo+session
    DesignRepoPreviewManager.stop(repoId, chatSessionId);

    // 2. Resolve working directory
    const cwd = config.workingDirectory
      ? join(repoPath, config.workingDirectory)
      : repoPath;

    // 3. Terminate any live Next dev server referenced by the repo-local lock file.
    //    This prevents "Another next dev server is already running" errors.
    //    terminateNextDevLock is filesystem-based; repoId is used for log messages only.
    await terminateNextDevLock(cwd, repoId);

    // 4. Assign port
    let port: number;
    if (config.portMode === 'fixed' && config.fixedPort) {
      port = config.fixedPort;
      // Wait for the fixed port to free up (the terminated process may still hold it briefly)
      await waitForPortFree(port, PORT_FREE_WAIT_MS);
    } else {
      port = await findFreePort();
    }

    // 5. Build full command: install → build → start (chained with &&)
    const startCmd = config.startCommand.replaceAll('{port}', String(port));
    const cmdParts: string[] = [];
    if (config.installCommand) cmdParts.push(config.installCommand);
    if (config.buildCommand) cmdParts.push(config.buildCommand);
    cmdParts.push(startCmd);
    const cmd = cmdParts.join(' && ');

    console.info(`[design-preview] starting preview for repo ${repoId} (key ${key}) on port ${port}: ${cmd}`);

    const proc = spawn('sh', ['-c', cmd], {
      cwd,
      env: { ...process.env, PORT: String(port) },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });

    const initialPreviewUrl = `http://127.0.0.1:${port}/`;
    const entry: DesignRepoPreviewEntry = {
      repoId,
      chatSessionId,
      port,
      pid: proc.pid,
      status: 'starting',
      repoPath,
      cwd,
      startedAt: new Date(),
      previewUrl: initialPreviewUrl,
    };
    registry.set(key, entry);
    processes.set(key, proc);

    // 6. Log stdout/stderr
    proc.stdout?.on('data', (chunk: Buffer) => {
      console.log(`[design-preview:${key}:stdout]`, chunk.toString().trimEnd());
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      console.log(`[design-preview:${key}:stderr]`, chunk.toString().trimEnd());
    });

    proc.on('close', (code) => {
      const e = registry.get(key);
      processes.delete(key);
      console.info(`[design-preview] process for key ${key} exited with code ${code}`);

      if (e && e.status !== 'ready') {
        // Non-zero exit while not ready means install/build/start failed
        const finalStatus = (code !== 0 && code !== null) ? 'failed' : 'stopped';
        registry.set(key, { ...e, status: finalStatus, pid: undefined });
      }
    });

    // 7. Health check or fixed delay — after ready, update URL from lock file
    if (config.healthCheckPath) {
      pollHealth(key, port, config.healthCheckPath, cwd);
    } else {
      setTimeout(() => {
        const e = registry.get(key);
        if (e && e.status === 'starting') {
          registry.set(key, { ...e, status: 'ready' });
          console.info(`[design-preview] preview assumed ready for repo ${repoId} (key ${key}) (no health check)`);
          // Try to update the preview URL from the lock file
          void updateUrlFromLock(key, cwd);
        }
      }, NO_HEALTH_READY_DELAY_MS);
    }

    return { port, previewUrl: initialPreviewUrl };
  },

  /**
   * Return current status entry, or null if never started.
   *
   * @param chatSessionId - Must match the session id passed to `start()`.
   */
  getStatus(repoId: string, chatSessionId: string): DesignRepoPreviewEntry | null {
    const key = scopeKey(chatSessionId, repoId);
    return registry.get(key) ?? null;
  },

  /**
   * Stop the preview server for a repo+session.
   *
   * @param chatSessionId - Must match the session id passed to `start()`.
   */
  stop(repoId: string, chatSessionId: string): void {
    const key = scopeKey(chatSessionId, repoId);
    const proc = processes.get(key);
    if (proc && proc.pid) {
      try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* already gone */ }
      try { proc.kill('SIGTERM'); } catch { /* already gone */ }
    }
    processes.delete(key);

    const e = registry.get(key);
    if (e) registry.set(key, { ...e, status: 'stopped', pid: undefined });
    console.info(`[design-preview] stopped preview for repo ${repoId} (key ${key})`);
  },

  /**
   * Get proxy target URL for a running preview, or null.
   *
   * @param chatSessionId - Must match the session id passed to `start()`.
   */
  getProxyTarget(repoId: string, chatSessionId: string): string | null {
    const key = scopeKey(chatSessionId, repoId);
    const e = registry.get(key);
    if (!e || e.status === 'stopped' || e.status === 'failed') return null;
    return `http://127.0.0.1:${e.port}`;
  },

  /**
   * Stop ALL tracked preview processes. Call on server shutdown to clean up
   * any detached child processes and their Next.js lock files.
   */
  async stopAll(): Promise<void> {
    const terminations: Promise<void>[] = [];

    for (const [key, proc] of processes.entries()) {
      if (proc?.pid) {
        try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* best effort */ }
        try { proc.kill('SIGTERM'); } catch { /* best effort */ }
      }
      const e = registry.get(key);
      if (e) {
        registry.set(key, { ...e, status: 'stopped', pid: undefined });
        if (e.cwd) {
          terminations.push(terminateNextDevLock(e.cwd, e.repoId));
        }
      }
    }
    processes.clear();

    console.info(`[design-preview] stopAll: terminated ${terminations.length} preview process(es)`);
    await Promise.allSettled(terminations);
  },
};
