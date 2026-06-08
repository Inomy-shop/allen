/**
 * Chat-scoped isolation tests for DesignRepoPreviewManager.
 *
 * Verifies that two chat sessions targeting the same repo have fully
 * independent registry entries — starting, stopping, or querying one
 * session's preview never affects the other session.
 *
 * Kept in a separate file so the file-level vi.mock('node:child_process')
 * does not interfere with the existing unit tests in
 * design-repo-preview-manager.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DesignRepoPreviewManager } from './design-repo-preview-manager.js';
import type { DesignPreviewConfig } from './design-preview.service.js';

// ── Module-level mocks ─────────────────────────────────────────────────────

/**
 * Prevent real child processes from being spawned during tests.
 * The mock returns a minimal ChildProcess-like object that satisfies
 * the event-listener plumbing inside DesignRepoPreviewManager.start().
 */
vi.mock('node:child_process', () => ({
  spawn: vi.fn().mockReturnValue({
    pid: 99001,
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
  }),
}));

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a minimal DesignPreviewConfig using fixed-port mode so that
 * findFreePort() is bypassed entirely.  The provided port must not be
 * in use on the test machine; high numbers like 19991-19996 are safe.
 */
function makeConfig(fixedPort: number): DesignPreviewConfig {
  return {
    enabled: true,
    startCommand: 'echo start',
    workingDirectory: '',
    portMode: 'fixed',
    fixedPort,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('chat-scoped registry isolation', () => {
  let tmpDir: string;

  beforeEach(() => {
    // Fresh temp dir per test — no .next/dev/lock file, so terminateNextDevLock
    // is a no-op and we never accidentally kill a real process.
    tmpDir = mkdtempSync(join(tmpdir(), 'scope-isolation-test-'));
  });

  afterEach(() => {
    // Best-effort cleanup so registry entries don't leak across tests.
    // Using unique repoIds per test already provides isolation, but this
    // keeps the in-memory Maps tidy.
    DesignRepoPreviewManager.stop('iso-repo-1', 'session-A');
    DesignRepoPreviewManager.stop('iso-repo-1', 'session-B');
    DesignRepoPreviewManager.stop('iso-repo-2', 'sess-A');
    DesignRepoPreviewManager.stop('iso-repo-2', 'sess-B');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('getStatus returns null for two sessions on the same repo before any start', () => {
    const a = DesignRepoPreviewManager.getStatus('iso-repo-1', 'session-A');
    const b = DesignRepoPreviewManager.getStatus('iso-repo-1', 'session-B');

    expect(a).toBeNull();
    expect(b).toBeNull();
  });

  it('stop for session-A does not affect session-B on the same repo', async () => {
    // Start both sessions with different fixed ports so they don't collide.
    await DesignRepoPreviewManager.start('iso-repo-2', makeConfig(19993), tmpDir, 'sess-A');
    // NOTE: global stop-before-start means starting sess-B stops sess-A first.
    await DesignRepoPreviewManager.start('iso-repo-2', makeConfig(19992), tmpDir, 'sess-B');

    // sess-A was stopped by global-stop-before-start when sess-B started.
    // sess-B is in 'starting' state.
    expect(DesignRepoPreviewManager.getStatus('iso-repo-2', 'sess-A')?.status).toBe('stopped');
    expect(DesignRepoPreviewManager.getStatus('iso-repo-2', 'sess-B')?.status).toBe('starting');

    // Explicitly stopping session A (already stopped) must not affect session B
    DesignRepoPreviewManager.stop('iso-repo-2', 'sess-A');

    // sess-A remains 'stopped'; sess-B must remain 'starting' (unaffected)
    expect(DesignRepoPreviewManager.getStatus('iso-repo-2', 'sess-A')?.status).toBe('stopped');
    expect(DesignRepoPreviewManager.getStatus('iso-repo-2', 'sess-B')?.status).toBe('starting');
  });
});

describe('global stop-before-start', () => {
  let tmpA: string;
  let tmpB: string;

  beforeEach(() => {
    tmpA = mkdtempSync(join(tmpdir(), 'global-stop-a-'));
    tmpB = mkdtempSync(join(tmpdir(), 'global-stop-b-'));
    vi.mocked(spawn).mockReturnValue({
      pid: 55001,
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      kill: vi.fn(),
    } as any);
  });

  afterEach(() => {
    DesignRepoPreviewManager.stop('global-repo', 'sess-old');
    DesignRepoPreviewManager.stop('global-repo', 'sess-new');
    rmSync(tmpA, { recursive: true, force: true });
    rmSync(tmpB, { recursive: true, force: true });
    vi.mocked(spawn).mockReset().mockReturnValue({
      pid: 99001,
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      kill: vi.fn(),
    } as any);
  });

  it('starting a new preview stops any existing preview in a different session', async () => {
    // Start session-A preview
    await DesignRepoPreviewManager.start('global-repo', makeConfig(19960), tmpA, 'sess-old');
    expect(DesignRepoPreviewManager.getStatus('global-repo', 'sess-old')?.status).toBe('starting');

    // Start session-B preview — should stop session-A first
    await DesignRepoPreviewManager.start('global-repo', makeConfig(19959), tmpB, 'sess-new');

    // session-A must now be stopped
    expect(DesignRepoPreviewManager.getStatus('global-repo', 'sess-old')?.status).toBe('stopped');
    // session-B must be starting
    expect(DesignRepoPreviewManager.getStatus('global-repo', 'sess-new')?.status).toBe('starting');
  });

  it('starting a preview for the same session only restarts that session (no double-stop)', async () => {
    await DesignRepoPreviewManager.start('global-repo', makeConfig(19958), tmpA, 'sess-old');
    expect(DesignRepoPreviewManager.getStatus('global-repo', 'sess-old')?.status).toBe('starting');

    // Re-start the same session
    await DesignRepoPreviewManager.start('global-repo', makeConfig(19957), tmpA, 'sess-old');

    // Must still be starting (restarted), not stopped
    expect(DesignRepoPreviewManager.getStatus('global-repo', 'sess-old')?.status).toBe('starting');
  });
});

// ── Install/build command tests ──────────────────────────────────────────────

describe('install/build command composition', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cmd-compose-test-'));
    vi.mocked(spawn).mockReturnValue({
      pid: 88001,
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      kill: vi.fn(),
    } as any);
  });

  afterEach(() => {
    DesignRepoPreviewManager.stop('cmd-repo', 'sess-cmd');
    rmSync(tmpDir, { recursive: true, force: true });
    vi.mocked(spawn).mockReset().mockReturnValue({
      pid: 99001,
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      kill: vi.fn(),
    } as any);
  });

  it('includes installCommand in the spawned shell command when set', async () => {
    const config = makeConfig(19980);
    (config as any).installCommand = 'npm install';
    await DesignRepoPreviewManager.start('cmd-repo', config as any, tmpDir, 'sess-cmd');
    const [, [, shellCmd]] = vi.mocked(spawn).mock.calls.at(-1) as any;
    expect(shellCmd).toContain('npm install');
  });

  it('includes buildCommand in the spawned shell command when set', async () => {
    const config = makeConfig(19979);
    (config as any).buildCommand = 'npm run build';
    await DesignRepoPreviewManager.start('cmd-repo', config as any, tmpDir, 'sess-cmd-build');
    const [, [, shellCmd]] = vi.mocked(spawn).mock.calls.at(-1) as any;
    expect(shellCmd).toContain('npm run build');
  });

  it('chains install && build && start in order when all are set', async () => {
    const config = makeConfig(19978);
    (config as any).installCommand = 'npm ci';
    (config as any).buildCommand = 'npm run build';
    await DesignRepoPreviewManager.start('cmd-repo', config as any, tmpDir, 'sess-chain');
    const [, [, shellCmd]] = vi.mocked(spawn).mock.calls.at(-1) as any;
    const ciIdx = shellCmd.indexOf('npm ci');
    const buildIdx = shellCmd.indexOf('npm run build');
    const startIdx = shellCmd.indexOf('echo start');
    expect(ciIdx).toBeGreaterThanOrEqual(0);
    expect(buildIdx).toBeGreaterThan(ciIdx);
    expect(startIdx).toBeGreaterThan(buildIdx);
  });

  it('status becomes failed when process exits with non-zero code while starting', async () => {
    let closeHandler: ((code: number) => void) | null = null;
    vi.mocked(spawn).mockReturnValueOnce({
      pid: 88002,
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn().mockImplementation((event: string, handler: any) => {
        if (event === 'close') closeHandler = handler;
      }),
      kill: vi.fn(),
    } as any);

    await DesignRepoPreviewManager.start('cmd-repo', makeConfig(19977), tmpDir, 'sess-fail');

    expect(DesignRepoPreviewManager.getStatus('cmd-repo', 'sess-fail')?.status).toBe('starting');

    // Simulate non-zero exit (e.g., npm install failed)
    closeHandler?.(1);

    expect(DesignRepoPreviewManager.getStatus('cmd-repo', 'sess-fail')?.status).toBe('failed');
  });
});

// ── stopAll tests ─────────────────────────────────────────────────────────────

describe('DesignRepoPreviewManager.stopAll', () => {
  let tmpA: string;
  let tmpB: string;

  beforeEach(() => {
    tmpA = mkdtempSync(join(tmpdir(), 'stopall-a-'));
    tmpB = mkdtempSync(join(tmpdir(), 'stopall-b-'));
  });

  afterEach(() => {
    rmSync(tmpA, { recursive: true, force: true });
    rmSync(tmpB, { recursive: true, force: true });
    vi.mocked(spawn).mockReset().mockReturnValue({
      pid: 99001,
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      kill: vi.fn(),
    } as any);
  });

  it('stopAll sends SIGTERM to all tracked processes and sets status to stopped', async () => {
    const killMock = vi.fn();
    vi.mocked(spawn).mockReturnValue({
      pid: 77001,
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      kill: killMock,
    } as any);

    await DesignRepoPreviewManager.start('stopall-repo', makeConfig(19970), tmpA, 'sess-stopall-1');
    // NOTE: global stop-before-start means starting sess-stopall-2 stops sess-stopall-1 first.
    await DesignRepoPreviewManager.start('stopall-repo', makeConfig(19969), tmpB, 'sess-stopall-2');

    // sess-stopall-1 was stopped by global-stop-before-start; sess-stopall-2 is starting.
    expect(DesignRepoPreviewManager.getStatus('stopall-repo', 'sess-stopall-1')?.status).toBe('stopped');
    expect(DesignRepoPreviewManager.getStatus('stopall-repo', 'sess-stopall-2')?.status).toBe('starting');

    await DesignRepoPreviewManager.stopAll();

    expect(DesignRepoPreviewManager.getStatus('stopall-repo', 'sess-stopall-1')?.status).toBe('stopped');
    expect(DesignRepoPreviewManager.getStatus('stopall-repo', 'sess-stopall-2')?.status).toBe('stopped');
    // killMock must have been called with SIGTERM (by global-stop and/or stopAll)
    expect(killMock).toHaveBeenCalledWith('SIGTERM');
  });
});
