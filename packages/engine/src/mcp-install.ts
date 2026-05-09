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
 *
 * Python MCP servers go through ensurePythonVenv instead — Allen creates
 * one venv per MCP record at <ALLEN_HOME>/venvs/<mcpId>/, runs `pip install
 * -r requirements.txt` into it, and spawns the entry with that venv's python.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { resolve as resolvePath, join } from 'node:path';
import { resolveAllenHome } from './paths.js';

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

// ── Python venv install gate ──────────────────────────────────────────────

/**
 * Venvs that have already been provisioned in this process. Once a venv is
 * here, subsequent ensurePythonVenv calls return immediately without even
 * touching disk. Reset on Allen restart — the on-disk venv check then runs
 * once and re-populates the set.
 *
 * To pick up new deps in requirements.txt, delete the MCP record (which wipes
 * its venv) and re-add it. By design, Allen does NOT auto-reinstall when
 * requirements.txt changes — it would silently mask broken pin updates.
 */
const provisionedVenvs = new Set<string>();
/** In-flight venv installs, so concurrent spawns await the same install. */
const venvInflight = new Map<string, Promise<PythonVenvStatus>>();

export type PythonVenvStatus = {
  venvPath: string;
  pythonBin: string;
  durationMs: number;
  /** true when nothing was done (venv was already provisioned). */
  skipped: boolean;
  /** true when we ran `python -m venv` this call (i.e. fresh venv). */
  created: boolean;
  /** true when we ran `pip install` this call. */
  installed: boolean;
  stdout: string;
  stderr: string;
};

export type EnsurePythonVenvOptions = {
  /** Stable per-MCP id used to derive the venv path. */
  mcpId: string;
  /** Interpreter used to bootstrap the venv (e.g. 'python3' or absolute path). */
  interpreter: string;
  /** Absolute path to requirements.txt, or null if the MCP has no deps file. */
  requirementsAbsPath: string | null;
  /**
   * Override the venv directory. Defaults to <ALLEN_HOME>/venvs/<mcpId>/.
   * Mainly here for tests; production callers leave this unset.
   */
  venvPath?: string;
};

/**
 * Pick a Python interpreter usable for MCP venvs. The `mcp` package requires
 * Python ≥3.10, but on macOS `python3` often resolves to the system 3.9, so
 * a naïve default silently breaks `pip install`. We probe candidates in
 * descending-version order and return the first one that reports ≥3.10.
 *
 * If `preferred` is set we honour it verbatim (user opt-in escape hatch).
 * Throws if nothing usable is on PATH.
 */
export function resolvePythonInterpreter(preferred?: string): string {
  if (preferred && preferred !== 'python3') return preferred;
  const candidates = [
    'python3.14', 'python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3',
  ];
  for (const bin of candidates) {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    if (r.status !== 0) continue;
    const out = `${r.stdout}${r.stderr}`;
    const m = out.match(/Python\s+(\d+)\.(\d+)/);
    if (!m) continue;
    const major = Number(m[1]);
    const minor = Number(m[2]);
    if (major > 3 || (major === 3 && minor >= 10)) return bin;
  }
  throw new Error(
    'No Python ≥3.10 found on PATH. Install one (e.g. `brew install python@3.12`) ' +
    'or set python.interpreter on the MCP record.',
  );
}

/** Build the canonical venv path for an MCP record. */
export function venvPathFor(mcpId: string, override?: string): string {
  if (override) return resolvePath(override);
  return join(resolveAllenHome(), 'venvs', mcpId);
}

/**
 * Idempotently provision a per-MCP Python venv and install its requirements.
 *
 * Behaviour:
 *   1. If `<venvPath>/bin/python` exists → return immediately, no work.
 *   2. Otherwise → `<interpreter> -m venv <venvPath>` then, if
 *      `requirementsAbsPath` is set, `<venv>/bin/python -m pip install -r ...`.
 *   3. Concurrent callers share one in-flight install via `venvInflight`.
 *
 * Throws if `python -m venv` or `pip install` fails. Caller is responsible
 * for persisting `venvPath` back to the MCP record so subsequent processes
 * can pick the same path. Updating deps is intentionally a manual step:
 * delete the MCP (which wipes the venv) and re-add it.
 */
export async function ensurePythonVenv(
  opts: EnsurePythonVenvOptions,
): Promise<PythonVenvStatus> {
  const venvPath = venvPathFor(opts.mcpId, opts.venvPath);
  const pythonBin = join(venvPath, 'bin', 'python');

  // In-process fast path — venv was provisioned earlier this process.
  if (provisionedVenvs.has(venvPath) && existsSync(pythonBin)) {
    return {
      venvPath, pythonBin, durationMs: 0,
      skipped: true, created: false, installed: false, stdout: '', stderr: '',
    };
  }

  // Coalesce concurrent callers
  const existing = venvInflight.get(venvPath);
  if (existing) return existing;

  const task = (async (): Promise<PythonVenvStatus> => {
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let created = false;
    let installed = false;

    if (!existsSync(pythonBin)) {
      // Wipe partial dir if any so `python -m venv` can succeed cleanly
      if (existsSync(venvPath)) {
        rmSync(venvPath, { recursive: true, force: true });
      }
      mkdirSync(venvPath, { recursive: true, mode: 0o755 });
      const r = await runProc(opts.interpreter, ['-m', 'venv', venvPath]);
      stdout += r.stdout;
      stderr += r.stderr;
      created = true;

      // First-time install of requirements (only when we just created the venv)
      if (opts.requirementsAbsPath) {
        if (!existsSync(opts.requirementsAbsPath)) {
          throw new Error(`requirements.txt not found at ${opts.requirementsAbsPath}`);
        }
        const r2 = await runProc(pythonBin, [
          '-m', 'pip', 'install',
          '--disable-pip-version-check',
          '-r', opts.requirementsAbsPath,
        ]);
        stdout += r2.stdout;
        stderr += r2.stderr;
        installed = true;
      }
    }

    provisionedVenvs.add(venvPath);
    return {
      venvPath, pythonBin,
      durationMs: Date.now() - startedAt,
      skipped: !created && !installed,
      created, installed, stdout, stderr,
    };
  })();

  venvInflight.set(venvPath, task);
  try {
    return await task;
  } finally {
    venvInflight.delete(venvPath);
  }
}

/**
 * Wipe a venv directory and its in-process cache entry. Called by the
 * DELETE /mcp/servers/:id handler so removed MCPs don't leave orphan venvs.
 * The user's update-deps flow is "delete MCP, re-add it" — this powers
 * the wipe half of that.
 */
export function deletePythonVenv(mcpId: string, venvPathOverride?: string): void {
  const venvPath = venvPathFor(mcpId, venvPathOverride);
  provisionedVenvs.delete(venvPath);
  if (existsSync(venvPath)) {
    rmSync(venvPath, { recursive: true, force: true });
  }
}

function runProc(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
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
        `${command} ${args.join(' ')} failed (code ${code}${signal ? `, signal ${signal}` : ''}).\n` +
        `stderr tail: ${stderr.slice(-500)}`,
      ));
    });
  });
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
