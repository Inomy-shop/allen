/**
 * `npm install` gate for repo-sourced MCP servers.
 *
 * MCP servers that live inside a registered repo (e.g.
 * `<repo>/.claude/mcp/postgres/`) need their deps installed before the first
 * spawn. This module runs `npm/pnpm/yarn install` exactly once per installDir
 * per process lifetime, keyed by absolute path. Subsequent spawns skip the
 * check. Call `forgetInstall(installDir)` to bust the cache (e.g. after a
 * `git pull` or on the /reinstall admin route).
 *
 * Package manager is auto-detected from the lockfile in installDir:
 *   pnpm-lock.yaml → pnpm
 *   yarn.lock      → yarn
 *   package-lock.json / none → npm
 */
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';

/**
 * Already-installed installDirs for the current process. Keyed by absolute
 * path. Reset whenever the Allen process restarts — intentional, because
 * missing `node_modules` is cheap to re-check via existsSync.
 */
const installedDirs = new Set<string>();
/** In-flight installs, so concurrent spawns await the same install. */
const inflight = new Map<string, Promise<void>>();

export type InstallStatus = {
  installDir: string;
  packageManager: 'pnpm' | 'yarn' | 'npm';
  durationMs: number;
  skipped: boolean;          // true when node_modules already existed
  stdout: string;
  stderr: string;
};

/**
 * Ensure `node_modules` exists inside `installDir`. Idempotent across
 * concurrent callers — a single install runs at most once per path per
 * process lifetime (until `forgetInstall()` is called).
 *
 * Throws if the install subprocess exits non-zero. Never throws on cache hits.
 */
export async function ensureInstalled(installDir: string): Promise<InstallStatus> {
  const dir = resolvePath(installDir);
  if (installedDirs.has(dir)) {
    return { installDir: dir, packageManager: 'npm', durationMs: 0, skipped: true, stdout: '', stderr: '' };
  }
  const existing = inflight.get(dir);
  if (existing) {
    await existing;
    return { installDir: dir, packageManager: 'npm', durationMs: 0, skipped: true, stdout: '', stderr: '' };
  }

  const pkgJson = resolvePath(dir, 'package.json');
  if (!existsSync(pkgJson)) {
    throw new Error(`MCP installDir has no package.json: ${dir}`);
  }
  const nodeModules = resolvePath(dir, 'node_modules');
  if (existsSync(nodeModules)) {
    installedDirs.add(dir);
    return { installDir: dir, packageManager: detectPm(dir), durationMs: 0, skipped: true, stdout: '', stderr: '' };
  }

  const pm = detectPm(dir);
  const startedAt = Date.now();
  const task = runInstall(dir, pm);
  inflight.set(dir, task.then(() => undefined, () => undefined));
  try {
    const { stdout, stderr } = await task;
    installedDirs.add(dir);
    return { installDir: dir, packageManager: pm, durationMs: Date.now() - startedAt, skipped: false, stdout, stderr };
  } finally {
    inflight.delete(dir);
  }
}

/** Drop the installed-marker for `installDir` so the next call re-runs install. */
export function forgetInstall(installDir: string): void {
  installedDirs.delete(resolvePath(installDir));
}

function detectPm(dir: string): 'pnpm' | 'yarn' | 'npm' {
  if (existsSync(resolvePath(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(resolvePath(dir, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function runInstall(
  dir: string,
  pm: 'pnpm' | 'yarn' | 'npm',
): Promise<{ stdout: string; stderr: string }> {
  // pnpm: `pnpm install --prefer-frozen-lockfile` (fast path when lockfile is committed)
  // yarn: `yarn install --frozen-lockfile`
  // npm:  `npm install` (don't use `npm ci` — many MCP repos don't commit lockfiles)
  const [cmd, args] =
    pm === 'pnpm' ? ['pnpm', ['install', '--prefer-frozen-lockfile']]
    : pm === 'yarn' ? ['yarn', ['install', '--frozen-lockfile']]
    : ['npm', ['install']];

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cmd as string, args as string[], {
      cwd: dir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });
    child.once('error', (err) => rejectPromise(err));
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else rejectPromise(new Error(
        `${pm} install failed in ${dir} (code ${code}${signal ? `, signal ${signal}` : ''}).\n` +
        `stderr tail: ${stderr.slice(-500)}`,
      ));
    });
  });
}
