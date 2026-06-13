import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolveExecutable = vi.fn();
const runCommand = vi.fn();

vi.mock('../system-health.service.js', () => ({
  resolveExecutable: (...args: unknown[]) => resolveExecutable(...args),
  runCommand: (...args: unknown[]) => runCommand(...args),
}));

import {
  assertCliProviderUsable,
  clearCliAuthCache,
  CliNotLoggedInError,
  getCliAuthStatus,
  isCliProvider,
} from '../cli-auth.service.js';

beforeEach(() => {
  clearCliAuthCache();
  resolveExecutable.mockReset();
  runCommand.mockReset();
});

describe('isCliProvider', () => {
  it('matches only the CLI providers', () => {
    expect(isCliProvider('claude')).toBe(true);
    expect(isCliProvider('codex')).toBe(true);
    expect(isCliProvider('deepseek')).toBe(false);
    expect(isCliProvider('claude-cli')).toBe(false);
  });
});

describe('getCliAuthStatus', () => {
  it('returns cli_missing when the executable is not found', async () => {
    resolveExecutable.mockResolvedValue(null);
    expect(await getCliAuthStatus('claude')).toBe('cli_missing');
  });

  it('returns logged_in when the auth command succeeds', async () => {
    resolveExecutable.mockResolvedValue('/usr/local/bin/claude');
    runCommand.mockResolvedValue({ ok: true, stdout: 'Logged in', stderr: '' });
    expect(await getCliAuthStatus('claude')).toBe('logged_in');
    expect(runCommand).toHaveBeenCalledWith('/usr/local/bin/claude', ['auth', 'status'], 8000);
  });

  it('returns not_logged_in when the auth command fails', async () => {
    resolveExecutable.mockResolvedValue('/usr/local/bin/codex');
    runCommand.mockResolvedValue({ ok: false, stdout: '', stderr: 'not logged in' });
    expect(await getCliAuthStatus('codex')).toBe('not_logged_in');
    expect(runCommand).toHaveBeenCalledWith('/usr/local/bin/codex', ['login', 'status'], 8000);
  });

  it('caches a passing check and skips the subprocess on repeat calls', async () => {
    resolveExecutable.mockResolvedValue('/usr/local/bin/claude');
    runCommand.mockResolvedValue({ ok: true, stdout: '', stderr: '' });
    await getCliAuthStatus('claude');
    await getCliAuthStatus('claude');
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it('fresh: true bypasses the cache', async () => {
    resolveExecutable.mockResolvedValue('/usr/local/bin/claude');
    runCommand.mockResolvedValue({ ok: true, stdout: '', stderr: '' });
    await getCliAuthStatus('claude');
    await getCliAuthStatus('claude', { fresh: true });
    expect(runCommand).toHaveBeenCalledTimes(2);
  });
});

describe('assertCliProviderUsable', () => {
  it('is a no-op for non-CLI providers', async () => {
    await expect(assertCliProviderUsable('deepseek')).resolves.toBeUndefined();
    expect(resolveExecutable).not.toHaveBeenCalled();
  });

  it('passes when the CLI is logged in', async () => {
    resolveExecutable.mockResolvedValue('/usr/local/bin/claude');
    runCommand.mockResolvedValue({ ok: true, stdout: '', stderr: '' });
    await expect(assertCliProviderUsable('claude')).resolves.toBeUndefined();
  });

  it('re-verifies fresh before throwing, then throws a structured error', async () => {
    resolveExecutable.mockResolvedValue('/usr/local/bin/codex');
    runCommand.mockResolvedValue({ ok: false, stdout: '', stderr: '' });
    const err = await assertCliProviderUsable('codex').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliNotLoggedInError);
    expect((err as CliNotLoggedInError).code).toBe('cli_not_logged_in');
    expect((err as CliNotLoggedInError).message).toContain('codex login');
    // first check + fresh re-check
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it('picks up a login that happened after a failed cached check', async () => {
    resolveExecutable.mockResolvedValue('/usr/local/bin/claude');
    runCommand.mockResolvedValueOnce({ ok: false, stdout: '', stderr: '' });
    await getCliAuthStatus('claude'); // caches not_logged_in
    runCommand.mockResolvedValue({ ok: true, stdout: '', stderr: '' });
    await expect(assertCliProviderUsable('claude')).resolves.toBeUndefined();
  });
});
