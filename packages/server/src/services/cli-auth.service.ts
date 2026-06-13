/**
 * CLI provider auth status — login-gated availability for `claude` and `codex`.
 *
 * The two CLI-backed providers are always enabled (they cannot be disabled),
 * but they are only USABLE when their CLI is installed and logged in. This
 * module owns that check:
 *
 *   - `getCliAuthStatus(provider)` — cached subprocess check (`claude auth
 *     status` / `codex login status`). Cached so the providers endpoint never
 *     spawns a subprocess per request.
 *   - `assertCliProviderUsable(provider)` — fail-fast gate used by the chat
 *     LLM router. Re-verifies fresh before failing so a user who just logged
 *     in isn't blocked by a stale cache.
 *
 * The recheck endpoint (POST /api/system/providers/:provider/recheck-auth)
 * calls with `fresh: true` to back the "Check again" button in Settings.
 */

import { resolveExecutable, runCommand } from './system-health.service.js';

export type CliAuthStatus = 'logged_in' | 'not_logged_in' | 'cli_missing';
export type CliProvider = 'claude' | 'codex';

interface CliProviderCheck {
  command: string;
  args: string[];
  /** What the user should run in a terminal to authenticate. */
  loginCommand: string;
  envVar?: string;
  skipNodeModulesBin?: boolean;
}

const CLI_PROVIDER_CHECKS: Record<CliProvider, CliProviderCheck> = {
  claude: {
    command: 'claude',
    args: ['auth', 'status'],
    loginCommand: 'claude (then /login)',
    envVar: 'CLAUDE_BIN',
    skipNodeModulesBin: true,
  },
  codex: {
    command: 'codex',
    args: ['login', 'status'],
    loginCommand: 'codex login',
  },
};

export function isCliProvider(provider: unknown): provider is CliProvider {
  return provider === 'claude' || provider === 'codex';
}

export function cliLoginCommand(provider: CliProvider): string {
  return CLI_PROVIDER_CHECKS[provider].loginCommand;
}

// A passing check stays valid for a while; a failing one expires quickly so
// the UI converges fast after the user logs in.
const LOGGED_IN_TTL_MS = 5 * 60_000;
const FAILED_TTL_MS = 30_000;

interface CacheEntry {
  status: CliAuthStatus;
  checkedAt: number;
}

const authCache = new Map<CliProvider, CacheEntry>();

/** Test hook — resets the cache between cases. */
export function clearCliAuthCache(): void {
  authCache.clear();
}

async function checkCliAuth(provider: CliProvider): Promise<CliAuthStatus> {
  const check = CLI_PROVIDER_CHECKS[provider];
  const executable = await resolveExecutable(check.command, {
    envVar: check.envVar,
    skipNodeModulesBin: check.skipNodeModulesBin,
  });
  if (!executable) return 'cli_missing';
  const result = await runCommand(executable, check.args, 8000);
  return result.ok ? 'logged_in' : 'not_logged_in';
}

export async function getCliAuthStatus(
  provider: CliProvider,
  options?: { fresh?: boolean },
): Promise<CliAuthStatus> {
  const cached = authCache.get(provider);
  if (!options?.fresh && cached) {
    const ttl = cached.status === 'logged_in' ? LOGGED_IN_TTL_MS : FAILED_TTL_MS;
    if (Date.now() - cached.checkedAt < ttl) return cached.status;
  }
  const status = await checkCliAuth(provider);
  authCache.set(provider, { status, checkedAt: Date.now() });
  return status;
}

export class CliNotLoggedInError extends Error {
  code = 'cli_not_logged_in' as const;
  constructor(public provider: CliProvider, public status: CliAuthStatus) {
    super(status === 'cli_missing'
      ? `The ${provider} CLI is not installed. Install it, log in, and try again.`
      : `The ${provider} CLI is not logged in. Run \`${cliLoginCommand(provider)}\` in a terminal, then try again.`);
    this.name = 'CliNotLoggedInError';
  }
}

/**
 * Fail-fast gate for chat/agent/workflow runs. No-op for non-CLI providers.
 * A cached `logged_in` passes immediately; anything else triggers one fresh
 * check before throwing, so a just-completed login is picked up.
 */
export async function assertCliProviderUsable(provider: string): Promise<void> {
  if (!isCliProvider(provider)) return;
  let status = await getCliAuthStatus(provider);
  if (status !== 'logged_in') {
    status = await getCliAuthStatus(provider, { fresh: true });
  }
  if (status !== 'logged_in') {
    throw new CliNotLoggedInError(provider, status);
  }
}
