import { existsSync, mkdirSync, accessSync, constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Centralized resolution for Allen on-disk directories.
 *
 * Everything the server/engine persists on disk (cloned repos, workspace
 * worktrees, ad-hoc workflow worktrees) lives under one root so:
 *   - a single env var / one chown can move it all
 *   - nothing lands in /tmp by default (AL2023 mounts /tmp as tmpfs,
 *     so anything there is wiped on every reboot/stop-start)
 *
 * Resolution order for the root:
 *   1. ALLEN_HOME env var — explicit opt-in, wins over everything.
 *   2. $HOME/.allen — persistent, user-owned, survives reboots.
 *   3. /var/lib/allen — fallback for service users with no real home.
 *   4. /tmp/allen — last-resort fallback; logs a loud warning because
 *      this is volatile on tmpfs-mounted /tmp.
 *
 * Individual subdirs can be overridden with their own env vars (for ops
 * who want repos on a mounted EBS volume but keep workspaces in $HOME):
 *   - ALLEN_REPOS_DIR       → overrides <root>/repositories
 *   - WORKSPACE_BASE_DIR        → overrides <root>/workspaces
 *   - ALLEN_WORKTREE_CACHE  → overrides <root>/worktree-cache
 */

function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true, mode: 0o755 });
  }
}

function tryDir(path: string): boolean {
  try {
    ensureDir(path);
    accessSync(path, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function requireWritable(path: string, source: string): string {
  if (!tryDir(path)) {
    throw new Error(
      `[allen-paths] ${source}=${path} is not writable. ` +
      `Fix permissions (chown the directory to the service user) or unset ${source}.`,
    );
  }
  return path;
}

let cachedRoot: string | undefined;

export function resolveAllenHome(): string {
  if (cachedRoot) return cachedRoot;

  const envOverride = process.env.ALLEN_HOME;
  if (envOverride) {
    cachedRoot = requireWritable(envOverride, 'ALLEN_HOME');
    return cachedRoot;
  }

  const home = homedir();
  if (home && home !== '/') {
    const candidate = join(home, '.allen');
    if (tryDir(candidate)) {
      cachedRoot = candidate;
      return cachedRoot;
    }
  }

  const varLib = '/var/lib/allen';
  if (tryDir(varLib)) {
    cachedRoot = varLib;
    return cachedRoot;
  }

  const tmpRoot = '/tmp/allen';
  ensureDir(tmpRoot);
  console.warn(
    `[allen-paths] Falling back to ${tmpRoot}. On AL2023 / tmpfs-mounted systems ` +
    `this directory is wiped on every reboot. Set ALLEN_HOME to a persistent path.`,
  );
  cachedRoot = tmpRoot;
  return cachedRoot;
}

export function resolveRepositoriesDir(): string {
  const override = process.env.ALLEN_REPOS_DIR;
  if (override) return requireWritable(override, 'ALLEN_REPOS_DIR');
  const dir = join(resolveAllenHome(), 'repositories');
  ensureDir(dir);
  return dir;
}

export function resolveWorkspacesDir(): string {
  const override = process.env.WORKSPACE_BASE_DIR;
  if (override) return requireWritable(override, 'WORKSPACE_BASE_DIR');
  const dir = join(resolveAllenHome(), 'workspaces');
  ensureDir(dir);
  return dir;
}

export function resolveWorktreeCacheDir(): string {
  const override = process.env.ALLEN_WORKTREE_CACHE;
  if (override) return requireWritable(override, 'ALLEN_WORKTREE_CACHE');
  const dir = join(resolveAllenHome(), 'worktree-cache');
  ensureDir(dir);
  return dir;
}
