/**
 * MCP Server Loader (shared)
 * Loads enabled MCP server configs from MongoDB and returns them in the
 * format expected by Claude Code SDK's mcpServers option. Also builds the
 * Allen built-in MCP server config.
 *
 * Source-based records:
 *   source.kind === 'preset' → look up hardcoded preset, build env from envKeys
 *   source.kind === 'repo'   → resolve entry file under registered repo,
 *                              run `npm install` gate, spawn with narrow env
 *
 * Bare bundle records (no `source`) spawn with the env/args verbatim. Source
 * records resolve credentials from a caller-supplied source env map, falling
 * back to process.env for local/server mode.
 */

import { type Db, ObjectId } from 'mongodb';
import { resolve, join, dirname, extname, isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ensureInstalled, ensurePythonVenv, resolvePythonInterpreter } from './mcp-install.js';

// ── env allowlist from source env (ALLEN_<key> → <key>) ────────────────────

const BASE_ENV_KEYS = ['PATH', 'HOME', 'USER', 'SHELL'] as const;

export type McpSourceEnv = NodeJS.ProcessEnv | Record<string, string | undefined>;

export interface BuildMcpConfigOptions {
  /** Extra env vars merged into each MCP's env after allowlist resolution. */
  extraEnv?: Record<string, string>;
  /** Source used to resolve ALLEN_<KEY> values. Defaults to process.env. */
  sourceEnv?: McpSourceEnv;
}

/**
 * Build the subprocess env from an allowlist. For each bare name `X` in
 * `envKeys`, reads `process.env.ALLEN_X` and sets `env[X]` to that value.
 * Missing keys are warned but not fatal (the MCP server decides how to
 * handle its own missing config). Only baseline OS vars + allowlisted keys
 * are forwarded — the subprocess never sees JWT secrets or other unrelated
 * `.env` contents.
 */
function buildEnvFromAllowlist(
  envKeys: string[] | undefined,
  options: BuildMcpConfigOptions = {},
): Record<string, string> {
  const sourceEnv = options.sourceEnv ?? process.env;
  const env: Record<string, string> = {
    // Silence dotenv's startup banner — corrupts strict MCP clients.
    DOTENV_CONFIG_QUIET: 'true',
  };
  for (const base of BASE_ENV_KEYS) {
    const v = sourceEnv[base] ?? process.env[base];
    if (v !== undefined) env[base] = v;
  }
  for (const key of envKeys ?? []) {
    const allenKey = `ALLEN_${key}`;
    const val = sourceEnv[allenKey];
    if (val === undefined) {
      console.warn(`[mcp-loader] envKey "${key}" referenced but ${allenKey} is not configured`);
      continue;
    }
    env[key] = val;
  }
  if (options.extraEnv) Object.assign(env, options.extraEnv);
  return env;
}

/**
 * Resolve argKeys (positional-arg-style config, used by a few presets like
 * postgres connection string). For each bare name `X`, returns
 * `process.env.ALLEN_X` — empty string when missing.
 */
function resolveArgKeys(argKeys: string[] | undefined, sourceEnv: McpSourceEnv = process.env): string[] {
  if (!argKeys || argKeys.length === 0) return [];
  return argKeys.map((key) => {
    const allenKey = `ALLEN_${key}`;
    const val = sourceEnv[allenKey];
    if (val === undefined) {
      console.warn(`[mcp-loader] argKey "${key}" referenced but ${allenKey} is not configured`);
      return '';
    }
    return val;
  });
}

// ── New path: resolve source → command/args/cwd ────────────────────────────

export function inferCommand(entryPath: string): { command: string; leadingArgs: string[] } {
  const ext = extname(entryPath).toLowerCase();
  if (ext === '.py') return { command: 'python3', leadingArgs: [] };
  if (ext === '.ts' || ext === '.tsx') return { command: 'npx', leadingArgs: ['tsx'] };
  return { command: 'node', leadingArgs: [] };
}

async function resolveRepoPath(db: Db, repoId: string): Promise<string | null> {
  const doc = await db.collection('repos').findOne({ _id: new ObjectId(repoId) });
  if (!doc || typeof doc.path !== 'string') return null;
  return doc.path;
}

/**
 * Given an mcp_servers record with a `source` field, build the stdio config
 * shape Claude Code expects. Returns null if the source can't be resolved
 * (missing repo, invalid entryPath, etc.) — caller skips the server.
 */
async function resolveSourcedStdio(
  s: Record<string, unknown>,
  db: Db,
  options: BuildMcpConfigOptions = {},
): Promise<Record<string, unknown> | null> {
  const sourceEnv = options.sourceEnv ?? process.env;
  const source = s.source as Record<string, unknown> | undefined;
  if (!source) return null;
  const envKeys = (s.envKeys as string[] | undefined) ?? [];
  const argKeys = (s.argKeys as string[] | undefined) ?? [];
  const extraArgs = (s.args as string[] | undefined) ?? [];

  if (source.kind === 'preset') {
    // The record stored the command+args at create time (copied from the
    // hardcoded preset). Trust them verbatim; append argKeys expansion.
    const args = [...extraArgs, ...resolveArgKeys(argKeys, sourceEnv)];
    return {
      type: 'stdio',
      command: (s.command as string) ?? 'npx',
      args,
      env: buildEnvFromAllowlist(envKeys, options),
    };
  }

  if (source.kind === 'repo') {
    const repoId = source.repoId as string;
    const entryPath = source.entryPath as string;
    const installPathOverride = source.installPath as string | undefined;
    if (!repoId || !entryPath) return null;

    const repoPath = await resolveRepoPath(db, repoId);
    if (!repoPath) {
      console.warn(`[mcp-loader] MCP "${s.name}" references missing repo ${repoId}`);
      return null;
    }

    const entryAbs = isAbsolute(entryPath) ? entryPath : resolve(repoPath, entryPath);
    const installDir = installPathOverride
      ? (isAbsolute(installPathOverride) ? installPathOverride : resolve(repoPath, installPathOverride))
      : dirname(entryAbs);

    // Path-traversal guard: the resolved entry must stay inside the repo.
    const normRepoPath = repoPath.endsWith('/') ? repoPath.slice(0, -1) : repoPath;
    if (!entryAbs.startsWith(normRepoPath + '/') && entryAbs !== normRepoPath) {
      console.error(`[mcp-loader] entryPath "${entryPath}" escapes repo ${repoPath}`);
      return null;
    }

    const isPython = extname(entryAbs).toLowerCase() === '.py';
    const hasManualCommand = typeof s.command === 'string' && (s.command as string).length > 0;

    // Python venv path: when the user has NOT supplied a manual Command override,
    // Allen owns the interpreter — provisions a per-MCP venv at
    // <ALLEN_HOME>/venvs/<mcpId>/, runs `pip install -r requirements.txt` once,
    // and spawns with that venv's python. Manual Command opts out entirely
    // (escape hatch for users who manage their own interpreter).
    if (isPython && !hasManualCommand) {
      const mcpId = String(s._id ?? '');
      if (!mcpId) {
        console.error(`[mcp-loader] Python MCP "${s.name}" has no _id — cannot derive venv path`);
        return null;
      }

      const py = (s.python as Record<string, unknown> | undefined) ?? {};
      let interpreter: string;
      try {
        interpreter = resolvePythonInterpreter(py.interpreter as string | undefined);
      } catch (err) {
        console.error(`[mcp-loader] python interpreter resolution failed for "${s.name}":`, (err as Error).message);
        return null;
      }

      // Resolve requirements.txt: explicit path on the record wins, otherwise
      // auto-detect a sibling file next to the entry. Path-traversal-guard the
      // explicit case the same way we guard entryPath.
      let requirementsAbsPath: string | null = null;
      const explicitReq = py.requirementsPath as string | undefined;
      if (explicitReq) {
        const reqAbs = isAbsolute(explicitReq) ? explicitReq : resolve(repoPath, explicitReq);
        if (!reqAbs.startsWith(normRepoPath + '/') && reqAbs !== normRepoPath) {
          console.error(`[mcp-loader] requirementsPath "${explicitReq}" escapes repo ${repoPath}`);
          return null;
        }
        if (!existsSync(reqAbs)) {
          console.warn(`[mcp-loader] requirementsPath "${explicitReq}" does not exist — skipping pip install`);
        } else {
          requirementsAbsPath = reqAbs;
        }
      } else {
        const sibling = join(dirname(entryAbs), 'requirements.txt');
        if (existsSync(sibling)) requirementsAbsPath = sibling;
      }

      let pythonBin: string;
      try {
        const status = await ensurePythonVenv({
          mcpId,
          interpreter,
          requirementsAbsPath,
        });
        pythonBin = status.pythonBin;
        if (status.created || status.installed) {
          console.log(
            `[mcp-loader] provisioned venv for "${s.name}" at ${status.venvPath} ` +
            `(${Math.round(status.durationMs / 1000)}s${status.installed ? ', installed deps' : ''})`,
          );
        }
      } catch (err) {
        console.error(`[mcp-loader] venv setup failed for "${s.name}":`, (err as Error).message);
        return null;
      }

      const args = [entryAbs, ...extraArgs, ...resolveArgKeys(argKeys, sourceEnv)];
      return {
        type: 'stdio',
        command: pythonBin,
        args,
        env: buildEnvFromAllowlist(envKeys, options),
        cwd: installDir,
      };
    }

    // Node path (and Python with manual Command override) — fall through to
    // npm install + auto-inferred command.
    if (existsSync(join(installDir, 'package.json'))) {
      try {
        await ensureInstalled(installDir);
      } catch (err) {
        console.error(`[mcp-loader] npm install failed for "${s.name}" at ${installDir}:`, (err as Error).message);
        return null;
      }
    }

    // Auto-infer command unless the record overrides it explicitly.
    const { command: autoCmd, leadingArgs } = inferCommand(entryAbs);
    const command = (s.command as string) ?? autoCmd;
    const args = [...leadingArgs, entryAbs, ...extraArgs, ...resolveArgKeys(argKeys, sourceEnv)];

    return {
      type: 'stdio',
      command,
      args,
      env: buildEnvFromAllowlist(envKeys, options),
      cwd: installDir,
    };
  }

  return null;
}

// ── Load-all entrypoints ───────────────────────────────────────────────────

export type LoadMcpOptions = {
  /**
   * Scope the result to a specific owner. When omitted, returns servers with
   * any ownerId (current behavior pre-scoping). Pass an ObjectId or string.
   */
  ownerId?: ObjectId | string | null;
  /** Extra env vars merged into each MCP's env. */
  extraEnv?: Record<string, string>;
  /** Source used to resolve ALLEN_<KEY> values. Defaults to process.env. */
  sourceEnv?: McpSourceEnv;
  /**
   * External MCP server allowlist. Allen's built-in MCP is handled by
   * loadAllMcpServers and is never filtered here. undefined = all external
   * MCPs, [] = no external MCPs, [name] = only those external MCP servers.
   */
  externalServerNames?: string[];
};

/**
 * Load enabled external MCP servers as Claude Code SDK mcpServers config.
 * Filters by `enabled: true, type: 'stdio'` and optionally by ownerId.
 * Returns only servers whose spawn config could be built — unresolved ones
 * are skipped with a console.warn.
 */
export async function loadMcpServers(
  db: Db,
  options?: LoadMcpOptions,
): Promise<Record<string, unknown>> {
  const filter: Record<string, unknown> = { enabled: true, type: 'stdio' };
  if (options?.ownerId !== undefined) {
    if (options.ownerId === null) {
      filter.ownerId = null;  // implicit admin — legacy records
    } else if (typeof options.ownerId === 'string') {
      filter.ownerId = new ObjectId(options.ownerId);
    } else {
      filter.ownerId = options.ownerId;
    }
  }

  const servers = await db.collection('mcp_servers').find(filter).toArray();
  const allowedExternal = options?.externalServerNames
    ? new Set(options.externalServerNames.filter((name) => typeof name === 'string' && name.length > 0))
    : null;

  const config: Record<string, unknown> = {};
  for (const s of servers) {
    if (allowedExternal && !allowedExternal.has(String(s.name))) continue;
    try {
      const cfg = await buildSingleServerConfig(s, db, {
        extraEnv: options?.extraEnv,
        sourceEnv: options?.sourceEnv,
      });
      if (cfg) config[s.name as string] = cfg;
    } catch (err) {
      console.error(`[mcp-loader] Failed to resolve MCP "${s.name}":`, (err as Error).message);
    }
  }

  return config;
}

/**
 * Resolve a single MCP server record (source-based or bare bundle) into the
 * stdio config Claude Code and Codex both expect. Used by loadMcpServers and
 * by mcp-health.service's connection check so both paths go through the same
 * resolution logic. Returns null when the record can't be resolved (missing
 * repo, bad entryPath, etc).
 */
export async function buildSingleServerConfig(
  s: Record<string, unknown>,
  db: Db,
  optionsOrExtraEnv?: Record<string, string> | BuildMcpConfigOptions,
): Promise<Record<string, unknown> | null> {
  const options: BuildMcpConfigOptions = isBuildOptions(optionsOrExtraEnv)
    ? optionsOrExtraEnv
    : { extraEnv: optionsOrExtraEnv };
  // Preferred path: source-based record (preset or repo).
  if (s.source) {
    return resolveSourcedStdio(s, db, options);
  }

  // Bare bundle path: env/args used verbatim. Credentials are expected to
  // be present on `process.env` already (Allen never resolves @secret refs).
  const resolvedEnv: Record<string, string> = {
    DOTENV_CONFIG_QUIET: 'true',
    ...(s.env ?? {}) as Record<string, string>,
  };
  if (options.extraEnv) Object.assign(resolvedEnv, options.extraEnv);
  const stdioConfig: Record<string, unknown> = {
    type: 'stdio',
    command: s.command,
    args: ((s.args ?? []) as string[]).slice(),
    env: resolvedEnv,
  };
  if (s.bundlePath) stdioConfig.cwd = s.bundlePath;
  return stdioConfig;
}

// ── Allen built-in MCP server ──────────────────────────────────────────────

// Anchor server-file resolution to this module's location, not process.cwd().
// cwd is whatever shell launched the engine — in deployed envs it's almost
// never the monorepo root, which is why the previous cwd-based candidate
// list silently returned null and dropped Allen MCP from every agent spawn.
// See the 2026-05-24 ENG-1737 incident: the `bug-investigator` ran for 7
// minutes, then logged "The artifact MCP tool isn't available in this
  // environment" — every workflow / spawned agent that day was missing
// `mcp__allen__*` for the same reason.
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * True when the process is running compiled JS from a `dist/` directory
 * (systemd `node dist/app.js`, `npm start`), false for source-running
 * tools (`tsx watch`, vitest, ts-node, scripts). Used as a deployment
 * discriminator that does NOT require NODE_ENV to be set — the current
 * Allen production deploy (infra/templates/allen.service) doesn't set
 * NODE_ENV, so NODE_ENV-gated behavior never kicks in.
 *
 * Heuristic: process.argv[1] is the entry file path. systemd invokes
 * `/usr/bin/node /home/ubuntu/allen/packages/server/dist/app.js`, so
 * argv[1] ends in `/dist/<name>.js`. `tsx watch src/app.ts` sets argv[1]
 * to the tsx binary (under node_modules/.bin or node_modules/tsx/dist),
 * never matching the regex.
 */
export function isRunningBuiltCode(): boolean {
  const argv1 = process.argv[1] ?? '';
  if (!argv1.endsWith('.js')) return false;
  // Exclude node_modules so test runners and CLIs (vitest, jest, eslint,
  // tsx itself) — all of which live under node_modules/*/dist/cli.js —
  // don't get misclassified as production runs.
  if (/[/\\]node_modules[/\\]/.test(argv1)) return false;
  // Require the path to traverse a `dist` segment so ad-hoc `node foo.js`
  // in random places doesn't get misclassified either.
  return /[/\\]dist[/\\]/.test(argv1);
}

function resolveAllenMcpServerPath(): { path: string; tried: string[] } | { path: null; tried: string[] } {
  const tried: string[] = [];
  const tryPath = (p: string | undefined): string | null => {
    if (!p) return null;
    tried.push(p);
    return existsSync(p) ? p : null;
  };
  // 1. Explicit override — set in deploy configs that ship the MCP server
  //    outside the standard monorepo layout (e.g. flattened bundles).
  const override = tryPath(process.env.ALLEN_MCP_SERVER_PATH);
  if (override) return { path: override, tried };
  // 2. Module-anchored. From packages/engine/{src,dist}, the server lives at
  //    ../../server/{src,dist}/services/allen-mcp-server.{ts,js}.
  //    Order depends on whether we're running built code or live source.
  //    Prod-like (systemd `node dist/app.js`, `npm start`): prefer the
  //    .js build artifact — faster startup, no per-spawn tsx overhead.
  //    Dev (`tsx watch src/app.ts`, vitest, ad-hoc scripts): prefer .ts so
  //    edits to the MCP server take effect without a rebuild.
  //    Discriminator is process.argv[1] — works without NODE_ENV (which
  //    the current deployment doesn't set).
  const runningBuiltCode = isRunningBuiltCode();
  const moduleAnchored = runningBuiltCode
    ? [
        resolve(MODULE_DIR, '../../server/dist/services/allen-mcp-server.js'),
        resolve(MODULE_DIR, '../../server/src/services/allen-mcp-server.ts'),
        resolve(MODULE_DIR, 'allen-mcp-server.js'),
        resolve(MODULE_DIR, 'allen-mcp-server.ts'),
      ]
    : [
        resolve(MODULE_DIR, '../../server/src/services/allen-mcp-server.ts'),
        resolve(MODULE_DIR, '../../server/dist/services/allen-mcp-server.js'),
        resolve(MODULE_DIR, 'allen-mcp-server.ts'),
        resolve(MODULE_DIR, 'allen-mcp-server.js'),
      ];
  for (const p of moduleAnchored) {
    const hit = tryPath(p);
    if (hit) return { path: hit, tried };
  }
  // 3. Legacy cwd-anchored fallbacks for dev shells that cd into the server
  //    package directly.
  const cwdAnchored = [
    resolve(process.cwd(), 'src/services/allen-mcp-server.ts'),
    resolve(process.cwd(), 'dist/services/allen-mcp-server.js'),
    resolve(process.cwd(), 'packages/server/src/services/allen-mcp-server.ts'),
    resolve(process.cwd(), 'packages/server/dist/services/allen-mcp-server.js'),
  ];
  for (const p of cwdAnchored) {
    const hit = tryPath(p);
    if (hit) return { path: hit, tried };
  }
  return { path: null, tried };
}

export function getAllenMcpConfig(
  extraEnv?: Record<string, string>,
): Record<string, unknown> | null {
  const resolution = resolveAllenMcpServerPath();
  if (!resolution.path) {
    const msg = `[mcp-loader] Allen MCP server file not found — agents will lack mcp__allen__* tools. ` +
                `Tried: ${resolution.tried.join(', ')}. Set ALLEN_MCP_SERVER_PATH to the absolute path, ` +
                `or ensure the server package is built (packages/server/dist).`;
    if (process.env.ALLEN_REQUIRE_BUILTIN_MCP === '1') throw new Error(msg);
    console.warn(msg);
    return null;
  }

  const serverPath = resolution.path;
  const apiUrl = process.env.ALLEN_API_URL ?? `http://localhost:${process.env.PORT ?? '4023'}`;
  // .ts source runs via `npx tsx`; unpacked .js runs via `node`; packaged
  // ASAR paths must run through Electron's Node runtime because plain Node
  // cannot read files inside app.asar.
  const runner = serverPath.endsWith('.ts')
    ? { command: 'npx', args: ['tsx', serverPath], env: {} as Record<string, string> }
    : serverPath.includes('.asar/')
      ? { command: process.execPath, args: [serverPath], env: { ELECTRON_RUN_AS_NODE: '1' } }
      : { command: 'node', args: [serverPath], env: {} as Record<string, string> };

  const env: Record<string, string> = {
    ALLEN_API_URL: apiUrl,
    ...(process.env.ALLEN_PUBLIC_URL ? { ALLEN_PUBLIC_URL: process.env.ALLEN_PUBLIC_URL } : {}),
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    ...(process.env.JWT_ACCESS_SECRET ? { JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET } : {}),
    ...runner.env,
    ...(extraEnv ?? {}),
  };

  return {
    type: 'stdio',
    command: runner.command,
    args: runner.args,
    env,
    // Claude Code may defer large MCP tool sets behind tool discovery. Allen
    // tools are runtime-critical for spawned agents (artifacts, waits,
    // nested spawns), so keep this built-in server eagerly loaded.
    alwaysLoad: true,
  };
}

/**
 * Load ALL MCP servers: Allen built-in + user-configured external.
 * `ownerIdOrExtraEnv` accepts either legacy `extraEnv` (Record<string,string>)
 * for backward compat with existing callers, OR a LoadMcpOptions object.
 */
export async function loadAllMcpServers(
  db: Db,
  ownerIdOrExtraEnv?: Record<string, string> | LoadMcpOptions,
): Promise<Record<string, unknown>> {
  const options: LoadMcpOptions = isLoadOptions(ownerIdOrExtraEnv)
    ? ownerIdOrExtraEnv
    : { extraEnv: ownerIdOrExtraEnv };

  const config: Record<string, unknown> = {};

  const ffConfig = getAllenMcpConfig(options.extraEnv);
  if (ffConfig) config.allen = ffConfig;

  const external = await loadMcpServers(db, options);
  Object.assign(config, external);

  return config;
}

function isLoadOptions(v: unknown): v is LoadMcpOptions {
  if (!v || typeof v !== 'object') return false;
  return 'ownerId' in v || 'extraEnv' in v || 'sourceEnv' in v || 'externalServerNames' in v;
}

function isBuildOptions(v: unknown): v is BuildMcpConfigOptions {
  if (!v || typeof v !== 'object') return false;
  return 'extraEnv' in v || 'sourceEnv' in v;
}
