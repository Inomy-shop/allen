/**
 * GitHub authentication helper.
 *
 * Centralizes how the `gh` CLI gets its token. The `gh` CLI honors `GH_TOKEN`
 * (and `GITHUB_TOKEN`) env vars and uses them in preference to its on-disk
 * auth state. We fetch the token from the encrypted `secrets` collection
 * (key: GITHUB_PERSONAL_ACCESS_TOKEN) and inject it into the child env.
 *
 * If no secret is configured, we fall back to whatever local auth `gh` already
 * has (e.g. `gh auth login` for dev), so existing setups keep working until
 * the user adds a token via Settings → Secrets.
 */

import type { Db } from 'mongodb';
import { SecretService } from './secret.service.js';

/** Secret key under which the GitHub token is stored. Matches the MCP preset. */
export const GITHUB_TOKEN_SECRET_KEY = 'FLOWFORGE_GITHUB_PERSONAL_ACCESS_TOKEN';
/** Legacy key kept for backward compatibility during migration. */
const LEGACY_GITHUB_TOKEN_KEY = 'GITHUB_PERSONAL_ACCESS_TOKEN';

/**
 * Build a child-process env object suitable for spawning `gh` CLI.
 *
 * If a token exists in the secrets store, sets `GH_TOKEN` (and `GITHUB_TOKEN`
 * for compatibility) so `gh` uses it. Otherwise returns the parent process env
 * unchanged so `gh` falls back to local auth.
 *
 * Always preserves PATH, HOME, and other parent env vars `gh` needs.
 */
export async function buildGhEnv(db: Db): Promise<NodeJS.ProcessEnv> {
  const secretSvc = new SecretService(db);
  const token = (await secretSvc.get(GITHUB_TOKEN_SECRET_KEY)) ?? (await secretSvc.get(LEGACY_GITHUB_TOKEN_KEY));
  if (!token) return { ...process.env };
  return {
    ...process.env,
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
  };
}

/**
 * Returns true if a GitHub token is configured in the secrets store.
 * Useful for surfacing setup hints in the UI.
 */
export async function hasGithubToken(db: Db): Promise<boolean> {
  const secretSvc = new SecretService(db);
  const token = (await secretSvc.get(GITHUB_TOKEN_SECRET_KEY)) ?? (await secretSvc.get(LEGACY_GITHUB_TOKEN_KEY));
  return Boolean(token);
}
