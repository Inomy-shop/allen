/**
 * GitHub authentication helper.
 *
 * Centralizes how the `gh` CLI gets its token. The `gh` CLI honors `GH_TOKEN`
 * (and `GITHUB_TOKEN`) env vars and uses them in preference to its on-disk
 * auth state. We read the token from `.env` (key:
 * ALLEN_GITHUB_PERSONAL_ACCESS_TOKEN) and inject it into the child env.
 *
 * If no token is configured, we fall back to whatever local auth `gh` already
 * has (e.g. `gh auth login` for dev), so existing setups keep working until
 * the user adds a token to `.env`.
 */

import { getRuntimeSecretsProvider } from '../runtime/config.js';

/** Env var under which the GitHub token is stored. Matches the MCP preset. */
export const GITHUB_TOKEN_ENV_KEY = 'ALLEN_GITHUB_PERSONAL_ACCESS_TOKEN';
/** Legacy env var, supported for backward compatibility. */
const LEGACY_GITHUB_TOKEN_ENV_KEY = 'GITHUB_PERSONAL_ACCESS_TOKEN';

async function readToken(): Promise<string | null> {
  const secrets = getRuntimeSecretsProvider();
  return await secrets.getSecret(GITHUB_TOKEN_ENV_KEY)
    ?? await secrets.getSecret(LEGACY_GITHUB_TOKEN_ENV_KEY)
    ?? null;
}

/**
 * Build a child-process env object suitable for spawning `gh` CLI.
 *
 * If a token is set in `.env`, sets `GH_TOKEN` (and `GITHUB_TOKEN` for
 * compatibility) so `gh` uses it. Otherwise returns the parent process env
 * unchanged so `gh` falls back to local auth.
 *
 * Always preserves PATH, HOME, and other parent env vars `gh` needs.
 */
export async function buildGhEnv(): Promise<NodeJS.ProcessEnv> {
  const token = await readToken();
  if (!token) return { ...process.env };
  return {
    ...process.env,
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
  };
}

/**
 * Returns true if a GitHub token is configured in `.env`.
 * Useful for surfacing setup hints in the UI.
 */
export async function hasGithubToken(): Promise<boolean> {
  return Boolean(await readToken());
}
