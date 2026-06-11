/**
 * Unit tests for design-repo-preview-manager.ts
 *
 * Tests:
 *  readNextDevLock
 *    1. parses a valid lock file
 *    2. returns null for missing file
 *    3. returns null for malformed JSON
 *    4. returns null when required fields are absent/invalid
 *    5. returns null when pid is zero (invalid)
 *
 *  isProcessAlive
 *    6. returns true when process.kill(pid, 0) succeeds
 *    7. returns false when process.kill(pid, 0) throws
 *
 *  checkLockReachable
 *    8. returns true on 2xx HTTP response
 *    9. returns true on 4xx HTTP response (non-server-error)
 *   10. returns false on 5xx
 *   11. returns false on fetch error (ECONNREFUSED)
 *   12. appends trailing slash when missing
 *
 *  terminateNextDevLock
 *   13. no-op when lock file is absent
 *   14. no-op (log only) when PID is already dead
 *   15. sends SIGTERM to pid when PID is alive and process exits promptly
 *   16. sends SIGKILL after grace period if SIGTERM is insufficient
 *
 *  tryReuseNextDevLock (kept for backward-compat; no longer used by start())
 *   17. valid lock → registers entry as 'ready' and returns port/previewUrl
 *   18. valid lock without trailing slash → previewUrl gets slash appended
 *   19. stale lock (pid dead) → returns null
 *   20. pid alive but server unreachable → returns null
 *   21. missing lock file → returns null immediately
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readNextDevLock,
  isProcessAlive,
  checkLockReachable,
  terminateNextDevLock,
  tryReuseNextDevLock,
} from './design-repo-preview-manager.js';

// ── readNextDevLock ────────────────────────────────────────────────────────

describe('readNextDevLock', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'next-lock-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses a valid lock file', async () => {
    const lockDir = join(tmpDir, '.next', 'dev');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, 'lock'),
      JSON.stringify({
        pid: 12345,
        port: 3001,
        hostname: 'localhost',
        appUrl: 'http://localhost:3001',
        startedAt: 1700000000000,
      }),
    );
    const lock = await readNextDevLock(tmpDir);
    expect(lock).not.toBeNull();
    expect(lock!.pid).toBe(12345);
    expect(lock!.port).toBe(3001);
    expect(lock!.appUrl).toBe('http://localhost:3001');
  });

  it('returns null when lock file is absent', async () => {
    const lock = await readNextDevLock(tmpDir);
    expect(lock).toBeNull();
  });

  it('returns null when lock file contains invalid JSON', async () => {
    const lockDir = join(tmpDir, '.next', 'dev');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'lock'), 'not-json');
    const lock = await readNextDevLock(tmpDir);
    expect(lock).toBeNull();
  });

  it('returns null when required fields are missing', async () => {
    const lockDir = join(tmpDir, '.next', 'dev');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, 'lock'),
      JSON.stringify({ hostname: 'localhost' }), // no pid/port/appUrl
    );
    const lock = await readNextDevLock(tmpDir);
    expect(lock).toBeNull();
  });

  it('returns null when pid is zero (invalid)', async () => {
    const lockDir = join(tmpDir, '.next', 'dev');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, 'lock'),
      JSON.stringify({ pid: 0, port: 3001, appUrl: 'http://localhost:3001' }),
    );
    const lock = await readNextDevLock(tmpDir);
    expect(lock).toBeNull();
  });
});

// ── isProcessAlive ─────────────────────────────────────────────────────────

describe('isProcessAlive', () => {
  it('returns true when process.kill(pid, 0) succeeds', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementationOnce(() => true as any);
    const result = isProcessAlive(12345);
    expect(result).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(12345, 0);
    killSpy.mockRestore();
  });

  it('returns false when process.kill(pid, 0) throws (process not found)', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementationOnce(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });
    const result = isProcessAlive(99999);
    expect(result).toBe(false);
    killSpy.mockRestore();
  });
});

// ── checkLockReachable ─────────────────────────────────────────────────────

describe('checkLockReachable', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns true for a 200 OK response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200 } as Response);
    const result = await checkLockReachable('http://localhost:3001');
    expect(result).toBe(true);
  });

  it('returns true for a 404 Not Found (non-server-error) response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 404 } as Response);
    const result = await checkLockReachable('http://localhost:3001');
    expect(result).toBe(true);
  });

  it('returns false for a 500 Internal Server Error', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500 } as Response);
    const result = await checkLockReachable('http://localhost:3001');
    expect(result).toBe(false);
  });

  it('returns false when fetch throws (connection refused)', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await checkLockReachable('http://localhost:3001');
    expect(result).toBe(false);
  });

  it('appends trailing slash when missing', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200 } as Response);
    await checkLockReachable('http://localhost:3001');
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      'http://localhost:3001/',
      expect.any(Object),
    );
  });
});

// ── terminateNextDevLock ───────────────────────────────────────────────────
//
// Tests use real timers but pass short graceMs/pollMs via the options parameter
// so no test waits more than ~200ms real time.

describe('terminateNextDevLock', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'next-terminate-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function writeLock(pid: number, port = 3001, appUrl = `http://localhost:${port}`): void {
    const lockDir = join(tmpDir, '.next', 'dev');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, 'lock'),
      JSON.stringify({ pid, port, appUrl, startedAt: Date.now() }),
    );
  }

  /** Short options so tests complete in < 200ms real time. */
  const SHORT = { graceMs: 50, pollMs: 10 };

  it('is a no-op when no lock file exists', async () => {
    const killSpy = vi.spyOn(process, 'kill');
    // No lock written — must not call kill at all
    await terminateNextDevLock(tmpDir, 'repo-noop', SHORT);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('is a no-op (log only) when lock PID is already dead', async () => {
    writeLock(99999, 3001);
    // Simulate dead pid: process.kill(pid, 0) throws ESRCH
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, sig) => {
      if (sig === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      return true as any;
    });
    await terminateNextDevLock(tmpDir, 'repo-dead-pid', SHORT);
    // SIGTERM/SIGKILL must not be sent when PID is already dead
    expect(killSpy).not.toHaveBeenCalledWith(expect.any(Number), 'SIGTERM');
    expect(killSpy).not.toHaveBeenCalledWith(expect.any(Number), 'SIGKILL');
  });

  it('sends SIGTERM and process exits promptly (no SIGKILL needed)', async () => {
    writeLock(12345, 3001);

    let alive = true;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, sig) => {
      if (sig === 0) {
        if (!alive) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
        return true as any;
      }
      if (sig === 'SIGTERM') {
        // Process exits immediately on SIGTERM
        alive = false;
      }
      return true as any;
    });

    await terminateNextDevLock(tmpDir, 'repo-sigterm', SHORT);

    expect(killSpy).toHaveBeenCalledWith(expect.any(Number), 'SIGTERM');
    expect(killSpy).not.toHaveBeenCalledWith(expect.any(Number), 'SIGKILL');
  });

  it('sends SIGKILL after grace period if SIGTERM does not stop the process', async () => {
    writeLock(12345, 3001);

    // Process never dies from SIGTERM — always reports alive
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid, sig) => {
      if (sig === 0) return true as any; // always alive
      return true as any;
    });

    await terminateNextDevLock(tmpDir, 'repo-sigkill', SHORT);

    expect(killSpy).toHaveBeenCalledWith(expect.any(Number), 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(expect.any(Number), 'SIGKILL');
  });
});

// ── tryReuseNextDevLock ────────────────────────────────────────────────────
// Kept for backward-compatibility; tryReuseNextDevLock is exported but no
// longer used by start() (force-restart replaced the reuse path).

describe('tryReuseNextDevLock', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'next-reuse-test-'));
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function writeLock(pid: number, port: number, appUrl: string): void {
    const lockDir = join(tmpDir, '.next', 'dev');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, 'lock'),
      JSON.stringify({ pid, port, appUrl, startedAt: Date.now() }),
    );
  }

  it('valid lock → registers entry as ready and returns port/previewUrl', async () => {
    writeLock(12345, 48110, 'http://localhost:48110');
    vi.spyOn(process, 'kill').mockReturnValueOnce(true as any); // pid alive
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200 } as Response);

    const result = await tryReuseNextDevLock('repo-1', tmpDir);

    expect(result).not.toBeNull();
    expect(result!.port).toBe(48110);
    expect(result!.previewUrl).toBe('http://localhost:48110/');
  });

  it('valid lock without trailing slash → previewUrl gets slash appended', async () => {
    writeLock(12345, 3001, 'http://localhost:3001');
    vi.spyOn(process, 'kill').mockReturnValueOnce(true as any);
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200 } as Response);

    const result = await tryReuseNextDevLock('repo-2', tmpDir);
    expect(result!.previewUrl).toBe('http://localhost:3001/');
  });

  it('stale lock (pid dead) → returns null, falls back to spawn', async () => {
    writeLock(99999, 3001, 'http://localhost:3001');
    vi.spyOn(process, 'kill').mockImplementationOnce(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });

    const result = await tryReuseNextDevLock('repo-3', tmpDir);
    expect(result).toBeNull();
    // fetch must not be called — no point pinging a server whose process is dead
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('pid alive but server unreachable → returns null, falls back to spawn', async () => {
    writeLock(12345, 3001, 'http://localhost:3001');
    vi.spyOn(process, 'kill').mockReturnValueOnce(true as any); // pid alive
    vi.mocked(fetch).mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await tryReuseNextDevLock('repo-4', tmpDir);
    expect(result).toBeNull();
  });

  it('missing lock file → returns null immediately, falls back to spawn', async () => {
    // No lock file written — tmpDir has no .next directory
    const result = await tryReuseNextDevLock('repo-5', tmpDir);
    expect(result).toBeNull();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
