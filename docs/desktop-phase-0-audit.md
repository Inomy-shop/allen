# Desktop Phase 0 Audit

Status: complete for initial desktop planning.

Worktree: `/Users/shreemantkumar/allen-internal-desktop`

Branch: `desktop-app`

## Purpose

Phase 0 prepares Allen for a production macOS desktop app by identifying the current assumptions that block an embedded desktop runtime.

This phase does not implement Electron, config providers, Keychain, SQLite, or packaging. It defines the concrete refactor targets for Phase 1 and later phases.

## Summary

Allen can support a desktop app cleanly, but the current runtime is still shaped around a manually started local/server process.

The main blockers are:

- Server startup is not embeddable yet.
- `.env` and `process.env` are read directly from many runtime layers.
- MongoDB is the only persistence implementation.
- Ports are fixed or derived from env variables instead of being owned by a runtime host.
- Background services start without a single lifecycle handle.
- MCP credentials and provider tokens are modeled as `.env` values.
- Some UI copy tells users to edit `.env`, which is wrong for desktop mode.

The first real implementation step should be Phase 1: extract an embeddable server start/stop API while preserving existing web behavior.

## Current Runtime Shape

Current startup flow:

```text
packages/server/src/app.ts
  loads root .env
  connects MongoDB
  seeds org/workflows/cron jobs
  creates Express app
  starts HTTP server
  starts MCP monitors
  starts file watch
  starts terminal WebSocket server
  invokes main() at module load
```

For desktop, this needs to become:

```text
Electron main process
  calls startAllenServer(options)
  receives server URL and shutdown handle
  loads shared UI
  stops runtime on app quit
```

## Audit Findings

### 1. Server Startup Is Coupled To Module Load

Key files:

- `packages/server/src/app.ts`
- `packages/server/src/database/mongo.ts`
- `packages/server/src/services/workspace-terminal.ts`
- `packages/server/src/services/workspace-watcher.ts`
- `packages/server/src/services/mcp-health.service.ts`
- `packages/server/src/services/mcp-orphan-sweeper.service.ts`
- `packages/server/src/services/cron.service.ts`

Current behavior:

- `packages/server/src/app.ts` loads root `.env` at import time.
- `PORT` is read into a module-level constant.
- `main()` is called at the bottom of the module.
- Fatal error handlers call `process.exit(1)`.
- `app.listen(PORT)` is called directly.
- Terminal WebSocket server starts separately on `TERMINAL_WS_PORT`.
- Background services are started inside `main()`.
- Some services return no stop handle.

Desktop impact:

- Electron cannot safely import and start the server as a managed child runtime.
- Tests cannot easily start multiple isolated server instances.
- Dynamic port allocation is hard.
- Graceful shutdown is incomplete.

Required seam:

```ts
export interface StartAllenServerOptions {
  mode: "web" | "desktop";
  host?: string;
  port?: number;
  terminalWsPort?: number;
  dataDir?: string;
  configProvider?: ConfigProvider;
  secretsProvider?: SecretsProvider;
  persistenceProvider?: PersistenceProvider;
}

export interface AllenServerHandle {
  app: Express;
  httpServer: import("http").Server;
  baseUrl: string;
  port: number;
  terminalWsUrl?: string;
  stop(): Promise<void>;
}

export async function startAllenServer(
  options: StartAllenServerOptions,
): Promise<AllenServerHandle>;
```

Phase 1 should extract this without changing existing `npm start` behavior.

### 2. Direct Environment Access Is Widespread

Observed scope:

- 75 files under `packages/server/src`, `packages/engine/src`, `packages/ui/src`, and `packages/ui/vite.config.ts` reference `process.env`.

High-impact examples:

- `packages/server/src/app.ts` loads `.env` and reads `PORT`.
- `packages/server/src/auth/jwt.ts` reads JWT secrets and token TTLs.
- `packages/server/src/services/github-auth.ts` reads GitHub token env.
- `packages/server/src/services/linear.service.ts` reads `ALLEN_LINEAR_ACCESS_TOKEN`.
- `packages/server/src/routes/mcp.routes.ts` validates MCP env keys from `process.env`.
- `packages/server/src/services/chat-llm.ts` injects `ALLEN_API_URL`, `ALLEN_PUBLIC_URL`, and `JWT_ACCESS_SECRET` into MCP subprocesses.
- `packages/server/src/services/chat-providers.ts` injects the same values into Codex MCP config.
- `packages/server/src/services/chat-tools.ts` injects runtime env into spawned agents and tools.
- `packages/engine/src/mcp-loader.ts` resolves MCP env allowlists from `process.env`.
- `packages/engine/src/codex-executor.ts` constructs agent runtime env from `process.env`.
- `packages/engine/src/paths.ts` resolves `ALLEN_HOME`, `ALLEN_REPOS_DIR`, `WORKSPACE_BASE_DIR`, and `ALLEN_WORKTREE_CACHE`.

Desktop impact:

- Desktop users would still need `.env` unless this is abstracted.
- Secrets would be visible in process env instead of macOS Keychain.
- Electron cannot reliably control runtime config per app instance.
- Multiple Allen runtimes on one machine would conflict through global env.

Required seam:

```ts
export interface ConfigProvider {
  get(key: string): string | undefined;
  require(key: string): string;
}

export interface SecretsProvider {
  getSecret(key: string): Promise<string | undefined>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
}

export interface RuntimeEnvProvider {
  buildChildEnv(input: RuntimeEnvInput): Promise<NodeJS.ProcessEnv>;
}
```

Recommended sequence:

1. Add env-backed providers first.
2. Migrate server startup, auth, integrations, MCP, and agent spawning to provider access.
3. Add desktop providers later.

### 3. MongoDB Is Hardwired

Observed scope:

- 121 files under `packages/server/src` and `packages/engine/src` reference MongoDB types, imports, `ObjectId`, or `Db`.

Key files:

- `packages/server/src/database/mongo.ts`
- `packages/server/src/database/indexes.ts`
- `packages/server/src/app.ts`
- `packages/server/src/routes/*.ts`
- `packages/server/src/services/*.ts`
- `packages/engine/src/state-manager.ts`
- `packages/engine/src/learning-manager.ts`
- `packages/engine/src/embedding.ts`
- `packages/engine/src/types.ts`

Current behavior:

- `connectDB()` creates a MongoDB client using `MONGODB_URI` or `mongodb://localhost:27017/allen`.
- Routes and services receive a raw Mongo `Db`.
- Many records use Mongo `ObjectId`.
- Index creation is Mongo-specific.

Desktop impact:

- A production desktop app would require MongoDB unless this changes.
- SQLite cannot be introduced cleanly without a persistence boundary.
- Data migrations and backups would be difficult to define for desktop.

Required seam:

Do not try to replace MongoDB in Phase 1. First make startup embeddable.

For Phase 5, introduce repository/service boundaries around persistence-heavy areas:

- auth/users
- chat sessions/messages
- workflows/executions/traces
- repos/workspaces
- MCP servers
- artifacts/files
- cron jobs/runs
- learnings/embeddings
- pull requests/tickets

Recommended short-term approach:

- Keep MongoDB for web mode.
- Allow desktop MVP to use MongoDB only as a temporary internal alpha dependency.
- Plan SQLite only after startup/config seams are stable.

### 4. Ports Are Runtime Assumptions

Key files:

- `.env.example`
- `packages/server/src/app.ts`
- `packages/server/src/services/workspace-terminal.ts`
- `packages/ui/vite.config.ts`
- `README.md`
- `docs/architecture.md`
- `docs/troubleshooting.md`

Current behavior:

- `.env.example` sets `PORT=4023`.
- `packages/server/src/app.ts` defaults to `4023`.
- UI dev proxy defaults API port to `4000` if env is missing.
- Terminal WebSocket defaults to `4024`.
- UI dev proxy derives terminal WebSocket port as `PORT + 1` unless `TERMINAL_WS_PORT` is set.
- Docs mention both `4000` and `4023` in different places.

Desktop impact:

- Desktop should not rely on fixed ports.
- Electron should bind backend to `127.0.0.1` with `port: 0`.
- The terminal WebSocket should either share the HTTP server upgrade path or return its allocated port to Electron.
- Runtime URLs should be generated from the actual bound port, not `process.env.PORT`.

Required seam:

```ts
interface RuntimeUrls {
  apiBaseUrl: string;
  publicBaseUrl: string;
  terminalWsUrl: string;
}
```

All MCP, chat, Codex, and Claude spawning code should receive runtime URLs from the server runtime, not reconstruct them from `localhost:${process.env.PORT}`.

### 5. Background Services Need Lifecycle Ownership

Key files:

- `packages/server/src/app.ts`
- `packages/server/src/services/cron.service.ts`
- `packages/server/src/services/mcp-health.service.ts`
- `packages/server/src/services/mcp-orphan-sweeper.service.ts`
- `packages/server/src/services/workspace-terminal.ts`
- `packages/server/src/services/workspace-watcher.ts`
- `packages/server/src/services/chat-mcp-client.ts`

Current behavior:

- `CronService` has a `stop()` method.
- `startMcpHealthMonitor()` starts an interval, but `app.ts` does not keep a stop handle.
- `startMcpOrphanSweeper()` returns a timeout handle, but `app.ts` does not keep it.
- `startTerminalWebSocketServer()` does not return a close handle.
- `startFileWatchServer()` is effectively global.
- Workspace watchers and terminal sessions are global in memory.
- MCP chat clients manage child processes but are not wired into a single app shutdown handle.

Desktop impact:

- Quit/restart must stop all child processes, intervals, sockets, watchers, and PTYs.
- Otherwise Allen.app can leave orphaned processes after app quit or update.

Required seam:

```ts
interface RuntimeServiceHandle {
  stop(): Promise<void> | void;
}
```

`startAllenServer()` should collect all handles and stop them in reverse order.

### 6. MCP Is Still Env-Centric

Key files:

- `packages/server/src/services/mcp.service.ts`
- `packages/server/src/routes/mcp.routes.ts`
- `packages/engine/src/mcp-loader.ts`
- `packages/server/src/services/mcp-health.service.ts`
- `packages/server/src/services/chat-mcp-client.ts`
- `packages/ui/src/components/settings/McpServerManager.tsx`

Current behavior:

- MCP presets define required env keys.
- Users are told to place `ALLEN_<KEY>` values in Allen's root `.env`.
- Server validates presence by checking `process.env`.
- Engine strips `ALLEN_` and forwards narrow env to MCP subprocesses.
- The UI copy tells users to edit `.env`.

Desktop impact:

- Desktop must let users configure MCP credentials inside Allen.app.
- Secrets must be stored in Keychain.
- MCP subprocess env should be generated by the app runtime, not inherited from `.env`.

Required seam:

```ts
interface McpCredentialResolver {
  resolveEnv(envKeys: string[]): Promise<Record<string, string>>;
  resolveArgs(argKeys: string[]): Promise<string[]>;
  listMissing(keys: string[]): Promise<string[]>;
}
```

Web implementation:

- Reads `ALLEN_<KEY>` from env.

Desktop implementation:

- Reads secrets from Keychain and non-secret config from local app settings.

### 7. Native Terminal Path Is Good, But Startup Is Not

Key files:

- `packages/server/src/services/workspace-terminal.ts`
- `packages/server/src/services/workspace-watcher.ts`
- `packages/ui/vite.config.ts`

Current behavior:

- Terminal uses `node-pty` and WebSocket transport.
- The terminal service chooses shell from `ALLEN_TERMINAL_SHELL`, `SHELL`, and fallbacks.
- It cleans some host env before spawning workspace shells.
- It starts its own HTTP server on `TERMINAL_WS_PORT`.

Desktop impact:

- The terminal implementation is directionally correct for desktop.
- The missing piece is lifecycle and dynamic port ownership.
- Desktop should expose terminal WebSocket URL from `startAllenServer()`.
- Later native UX can add open-in-Terminal/iTerm/Finder/editor actions.

Required seam:

```ts
const terminalHandle = await startTerminalWebSocketServer({
  port: 0,
  host: "127.0.0.1",
  getWorkspacePath,
  getRepoPath,
});

await terminalHandle.stop();
```

### 8. UI Has Web-Mode Copy That Needs Desktop Variants

Key files:

- `packages/ui/src/components/settings/McpServerManager.tsx`
- `packages/ui/src/pages/TicketsPage.tsx`
- `packages/ui/src/components/workspace/WorkspaceConfigEditor.tsx`

Current behavior:

- MCP settings instruct users to add `ALLEN_*` values to `.env` and restart.
- Tickets page instructs users to add `ALLEN_LINEAR_ACCESS_TOKEN` to `.env`.
- Workspace config editor intentionally supports per-workspace `.env` files.

Desktop impact:

- Product-level Allen config should not mention editing `.env` in desktop mode.
- Workspace-level `.env` files can still exist because they belong to the user's project workspace, not Allen's own app config.

Required seam:

```ts
interface RuntimeCapabilities {
  mode: "web" | "desktop";
  supportsKeychainSecrets: boolean;
  supportsNativeFolderPicker: boolean;
  supportsManagedMcpCredentials: boolean;
}
```

The UI can use this to show correct setup flows per mode.

## Phase 1 Scope Recommendation

Phase 1 should be narrow.

Do:

- Extract `startAllenServer()`.
- Keep root `.env` loading for web mode.
- Keep MongoDB.
- Keep existing routes and services.
- Support `host`, `port`, and `terminalWsPort` options.
- Return actual bound API and terminal WebSocket URLs.
- Return a `stop()` handle.
- Keep `packages/server/src/app.ts` executable as before.

Do not:

- Add Electron yet.
- Add SQLite yet.
- Replace all `process.env` reads yet.
- Replace MCP credential handling yet.
- Rewrite UI settings yet.

This gives the desktop project its first required technical seam while keeping blast radius controlled.

## Proposed Phase 1 File Targets

Likely files to change:

- `packages/server/src/app.ts`
- `packages/server/src/database/mongo.ts`
- `packages/server/src/services/workspace-terminal.ts`
- `packages/server/src/services/mcp-health.service.ts`
- `packages/server/src/services/mcp-orphan-sweeper.service.ts`
- `packages/server/src/services/workspace-watcher.ts`
- `packages/server/src/services/cron.service.ts`

Likely new files:

- `packages/server/src/server.ts`
- `packages/server/src/runtime/types.ts`
- `packages/server/src/runtime/env.ts`

Suggested split:

```text
packages/server/src/app.ts
  CLI entrypoint only
  loads .env
  calls startAllenServer()

packages/server/src/server.ts
  exports createExpressApp()
  exports startAllenServer()
  owns startup/shutdown orchestration

packages/server/src/runtime/types.ts
  shared runtime option and handle types
```

## Acceptance Criteria For Phase 1

- `npm --workspace @allen/server run dev` still works.
- `npm --workspace @allen/server run start` still works after build.
- Existing API routes are unchanged.
- Server can also be started programmatically from a test.
- Programmatic startup can use `port: 0`.
- The returned handle exposes actual API base URL.
- Terminal WebSocket startup can be disabled or assigned an explicit port.
- `handle.stop()` closes HTTP server, terminal server, cron jobs, intervals, and DB connection as far as current services allow.
- Tests cover start and stop behavior.

## Open Decisions

### Should terminal WebSocket stay separate?

Current terminal/file-watch uses a separate WebSocket server.

Options:

- Keep separate for Phase 1 and make it dynamically allocated.
- Later move terminal/file-watch under the main HTTP server upgrade path.

Recommendation:

- Keep separate for Phase 1 to reduce risk.
- Expose the actual terminal WebSocket URL from the runtime handle.

### Should desktop MVP require MongoDB?

Options:

- Yes for internal alpha.
- No for production desktop.

Recommendation:

- Allow MongoDB for the first Electron shell only if needed.
- Do not consider desktop production-ready until SQLite or another embedded store is available.

### Should `.env` be removed before Electron?

Recommendation:

- No. Keep `.env` for web mode.
- Add provider abstractions before changing behavior.
- Desktop can initially run with env-backed providers during MVP, then switch to app settings and Keychain.

## Phase 0 Completion

Phase 0 is complete when this audit is accepted as the baseline for Phase 1.

The next implementation step is Phase 1: make the server embeddable.

