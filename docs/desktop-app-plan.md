# Allen macOS Desktop App Plan

## Goal

Build a production-quality macOS desktop version of Allen while keeping the existing web/local app working.

The desktop app should feel like a complete product:

- The user opens `Allen.app`.
- The user does not run `npm`, `node`, MongoDB, backend servers, or MCP processes manually.
- The user does not edit `.env`.
- Provider credentials, MCP settings, local paths, logs, updates, and runtime state are managed from the app.
- Native desktop capabilities are used where they improve the product, especially terminal lifecycle, notifications, file/folder selection, keychain secrets, app menus, and process supervision.

The desktop app must not become a fork of the current app. Allen should remain one product with two launch modes.

## High-Level Recommendation

Use the same repository and reuse the existing code.

```text
packages/
  ui/          Shared React/Vite app
  server/      Shared API, runtime, integrations, streaming, workspaces
  engine/      Shared workflow and agent engine
  desktop/     Electron host for macOS
```

Add small infrastructure abstractions for configuration, secrets, persistence, and runtime hosting so web mode and desktop mode can use different implementations without duplicating product logic.

## Why Same Repo

Keep desktop in this monorepo because:

- The desktop app should reuse `packages/ui`, `packages/server`, and `packages/engine`.
- Shared types, API contracts, tests, and refactors are easier in one repo.
- Bug fixes land once instead of being copied between repos.
- Early desktop work will require changes across UI, server, engine, config, and packaging.
- The current repo already uses npm workspaces and Turbo, which fits a new `packages/desktop` package.

Move desktop to a separate repo only if one of these becomes true:

- Desktop has a separate release team and lifecycle.
- Desktop must be closed-source while the main repo remains public.
- Signing/notarization infrastructure needs hard isolation.
- The desktop app diverges so much that it is no longer the same product.

## Product Model

Current Allen is a web/local app:

```text
User runs dependencies and commands
  -> browser opens localhost UI
  -> server runs on localhost
  -> MongoDB stores data
  -> .env provides configuration
```

Desktop Allen should be a managed local runtime:

```text
User opens Allen.app
  -> Electron starts and supervises the local Allen runtime
  -> shared React UI loads in a native window
  -> shared server runs internally on a dynamic local port
  -> engine runs workflows and agents
  -> app-managed config, secrets, storage, MCP, and logs
```

The backend still exists, but it is internal to the app. The user never starts it separately.

## Technology Stack

### Desktop Host

Use Electron.

Reasons:

- Allen already depends on Node-oriented functionality: subprocesses, PTYs, local repos, WebSockets, file watchers, CLIs, and MCP processes.
- The existing React/Vite UI can be reused.
- The existing Node/Express server can be embedded or spawned by the desktop host.
- Electron supports mature packaging, auto-update, signing, native menus, tray, notifications, and secure preload bridges.

Avoid SwiftUI for the first production desktop version because it would require a major UI rewrite.

Avoid Tauri for the first production desktop version unless the team is ready to maintain a Node sidecar anyway. Allen's runtime requirements make a pure Tauri approach less clean.

### UI

Reuse `packages/ui`.

Desktop-specific UI should be feature flags or small adaptive components, not a copied UI package.

Examples:

- Use the same chat, execution, workflow, workspace, settings, and MCP screens.
- Add desktop-only affordances where needed, such as "Open in Finder", "Open in Terminal", app diagnostics, and native folder selection.

### Backend

Reuse `packages/server`.

The server should be refactored so it can start in two ways:

- Web/dev mode: normal HTTP server started by scripts.
- Desktop mode: programmatically started by Electron with injected runtime options.

Target API:

```ts
startAllenServer({
  mode: "desktop",
  host: "127.0.0.1",
  port: 0,
  dataDir,
  configProvider,
  secretsProvider,
  persistenceProvider,
  runtimeHost
});
```

`port: 0` lets the OS choose a free port. Electron then passes that port to the UI.

### Engine

Reuse `packages/engine`.

The engine should not know whether it is running in web mode or desktop mode except through injected paths, config, and runtime services.

### Storage

Use different persistence implementations by mode:

```text
Web/dev mode:
  MongoDB

Desktop mode:
  SQLite or another embedded local database
```

For production desktop, avoid requiring the user to install or start MongoDB.

The clean path is a persistence abstraction:

```ts
interface PersistenceProvider {
  connect(): Promise<void>;
  close(): Promise<void>;
}
```

Existing MongoDB code can remain the first implementation. Desktop should add an SQLite implementation once the persistence boundary is clean enough.

### Secrets

Use macOS Keychain for desktop secrets.

Examples:

- GitHub tokens
- Linear tokens
- Slack secrets
- OpenAI/Anthropic API keys
- MCP credentials
- OAuth refresh tokens

The user should configure these from Allen settings screens. The app stores them securely and injects them into backend, engine, provider, or MCP processes when needed.

Target interface:

```ts
interface SecretsProvider {
  getSecret(key: string): Promise<string | undefined>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
}
```

Web/dev mode can continue using `.env` while desktop mode uses Keychain.

### Configuration

Desktop users should not edit `.env`.

Use:

- App settings UI for configuration.
- Non-secret config under `~/Library/Application Support/Allen`.
- Keychain for secrets.
- Runtime-generated environment variables only for child processes that require env vars.

Target interface:

```ts
interface ConfigProvider {
  get(key: string): string | undefined;
  require(key: string): string;
}
```

Web/dev mode:

```text
.env -> EnvConfigProvider
```

Desktop mode:

```text
app settings DB/files -> DesktopConfigProvider
Keychain -> KeychainSecretsProvider
```

## Architecture

```text
macOS
  |
  v
Allen.app
  |
  +-- Electron main process
  |     - app lifecycle
  |     - backend supervision
  |     - native menus/tray
  |     - notifications
  |     - auto-update
  |     - native file/folder dialogs
  |     - Keychain access
  |
  +-- Electron preload bridge
  |     - narrow, secure desktop API exposed to React
  |
  +-- React UI from packages/ui
  |     - chat
  |     - workflows
  |     - executions
  |     - workspaces
  |     - terminal renderer
  |     - settings
  |
  +-- Internal Allen server from packages/server
  |     - API routes
  |     - WebSocket/SSE streaming
  |     - terminal sessions
  |     - MCP manager
  |     - workspace manager
  |     - integrations
  |
  +-- Engine from packages/engine
        - workflows
        - agents
        - tool execution
        - artifacts
```

## Shared Code vs Desktop-Only Code

### Shared

These should stay shared:

- React pages and components
- Chat UI and streaming rendering
- Workflow builder
- Execution details
- Workspace views
- Terminal UI renderer
- API client contracts
- Server routes
- WebSocket/SSE handlers
- Chat runtime
- Workspace runtime
- Agent/workflow engine
- MCP registry and process orchestration, where possible
- GitHub, Linear, Slack, and provider integration logic
- Tests for product behavior

### Desktop-Only

These should live in `packages/desktop` or behind desktop-specific adapters:

- Electron main process
- Electron preload script
- Native app menu
- Tray/menu bar integration
- Native notifications
- Auto-update
- Code signing and notarization config
- Keychain implementation
- Native folder/file picker
- App diagnostics bundle export
- Backend process supervision
- Desktop app lifecycle integration

## Native Features Plan

The desktop app should be hybrid: shared React for product UI, native/Electron for OS integration, and local Node runtime for process-heavy features.

### Terminal

Use a real native PTY process and render it with `xterm.js`.

```text
node-pty
  -> backend terminal session
  -> WebSocket
  -> xterm.js in shared UI
```

Desktop improvements:

- Native shell detection, usually `zsh` on macOS.
- App-managed PTY lifecycle.
- Terminal survives minor UI reloads when possible.
- Kill/restart terminal from UI.
- Open workspace in macOS Terminal, iTerm, Finder, or editor.
- Correct copy/paste shortcuts.
- Resize handling through WebSocket.
- Terminal logs included in diagnostics.

The terminal pixels can still be web-rendered. The native part is the PTY process and lifecycle.

### Chat Streaming

Use the shared streaming runtime.

```text
LLM/provider stream
  -> Allen chat runtime
  -> WebSocket or SSE
  -> shared React chat UI
```

Desktop improvements:

- Stream state survives window reload where possible.
- Long-running agents continue when the window is hidden.
- Native notifications for completions, failures, and interventions.
- App badge/progress status for running work.
- Cancel/retry controls wired to local runtime.
- Diagnostics include stream/session logs.

### MCP Servers

Desktop should fully control MCP setup and lifecycle:

- Add MCP server from UI.
- Use presets for common integrations.
- Support custom MCP commands.
- Store credentials in Keychain.
- Store non-secret config in local app data.
- Install dependencies if needed.
- Start/stop MCP subprocesses.
- Show health, logs, and restart controls.
- Inject only the env vars needed by that MCP server.

Users should never edit `.env` for MCP configuration in desktop mode.

### Provider and Integration Setup

The app should provide guided setup for:

- GitHub
- Linear
- Slack
- OpenAI
- Anthropic
- Claude Code or Codex CLI if still required
- MCP servers

For provider APIs, prefer direct token/API-key based integration where possible.

If external CLIs are required, the desktop app should detect them, guide authentication, and show health status. The user should still not be required to edit shell files manually.

## Security Model

### Electron Security

Use Electron best practices:

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true` where practical
- Strict preload bridge
- No arbitrary IPC exposure
- Validate IPC inputs with schemas
- Avoid exposing raw filesystem or shell execution APIs to the renderer
- Use CSP for renderer assets
- Use `shell.openExternal` only after URL validation

### Preload Bridge

Expose a narrow desktop API:

```ts
window.allen.desktop.getAppVersion()
window.allen.desktop.selectRepositoryFolder()
window.allen.desktop.openPath(path)
window.allen.desktop.openExternal(url)
window.allen.desktop.showNotification(input)
window.allen.desktop.getRuntimeStatus()
```

Do not put business logic in the preload bridge.

### Secrets

- Store desktop secrets in Keychain.
- Never persist secrets in logs.
- Never expose all secrets to the renderer.
- Pass secrets only to the backend or child process that needs them.
- Redact secrets in diagnostics.

### Local Runtime

- Bind internal backend to `127.0.0.1`, not `0.0.0.0`.
- Use random available ports.
- Use an app-issued local auth token between UI and backend if needed.
- Avoid exposing desktop-only privileged APIs through normal HTTP routes.
- Keep workspace execution security documented in `docs/security.md`.

## Data and Paths

Desktop app data should live under:

```text
~/Library/Application Support/Allen/
```

Suggested layout:

```text
Allen/
  config/
  data/
  logs/
  diagnostics/
  worktrees/
  mcp/
  cache/
  updates/
```

Secrets should live in macOS Keychain, not in this directory.

## Development Workflow

Keep existing web workflow:

```bash
npm run dev
```

Add desktop workflow:

```bash
npm --workspace @allen/desktop run dev
```

Expected behavior:

- Build or serve the shared UI.
- Start Electron.
- Start the shared server in desktop mode.
- Use desktop config paths.
- Show runtime status in the app.

## Packaging and Release

Use `electron-builder`.

Production release requirements:

- macOS app bundle
- DMG or ZIP distribution
- Apple Developer ID signing
- macOS notarization
- Hardened runtime
- Entitlements reviewed carefully
- Auto-update support if product distribution needs it
- Release notes
- Crash/error log capture
- Diagnostics export

## Testing Strategy

### Shared Tests

Keep existing unit/integration tests for:

- engine
- server services
- UI utility logic
- API behavior
- workflow execution

### Desktop Tests

Add tests for:

- backend startup/shutdown from Electron
- dynamic port allocation
- desktop config provider
- Keychain secrets provider
- preload IPC validation
- app lifecycle behavior
- MCP process supervision
- terminal session lifecycle
- streaming reconnect behavior

### End-to-End Tests

Use Playwright for:

- web app flows
- Electron app flows if feasible

Desktop E2E coverage should include:

- first launch
- onboarding/settings
- login/bootstrap
- chat streaming
- workflow run
- terminal open/resize/input
- MCP server add/start/stop
- app quit and restart

## Migration Plan

### Phase 0: Architecture Preparation

Goal: prepare the existing app for multiple hosts.

Tasks:

- Identify direct `.env` reads across server and engine.
- Identify MongoDB-specific assumptions.
- Identify fixed port assumptions.
- Identify startup code that assumes CLI/server-only execution.
- Document current runtime dependencies.

Deliverable:

- Clear list of required seams before Electron packaging.

### Phase 1: Embeddable Server

Goal: make the backend startable by Electron without shelling out to app scripts.

Tasks:

- Extract server startup into `startAllenServer()`.
- Support graceful shutdown.
- Support `host`, `port`, `mode`, `dataDir`, and injected providers.
- Support dynamic port allocation.
- Keep existing CLI/server startup behavior unchanged.
- Add tests for startup and shutdown.

Deliverable:

- Existing web mode still works.
- Desktop host can start the same server code programmatically.

### Phase 2: Config and Secrets Abstractions

Goal: remove desktop blockers caused by direct `.env` usage.

Tasks:

- Add `ConfigProvider`.
- Add `SecretsProvider`.
- Implement env-backed providers for existing web/dev behavior.
- Add desktop-backed provider shape.
- Migrate provider, integration, MCP, and auth code away from direct env access.
- Redact secrets consistently in logs.

Deliverable:

- Web mode still uses `.env`.
- Desktop mode can be wired to app settings and Keychain.

### Phase 3: Desktop Shell MVP

Goal: open Allen as a macOS app using the shared UI and shared server.

Tasks:

- Add `packages/desktop`.
- Add Electron main and preload scripts.
- Load shared UI.
- Start shared server in desktop mode.
- Pass backend URL to the renderer safely.
- Add app menu and quit lifecycle.
- Add runtime status screen or diagnostics panel.

Deliverable:

- `Allen.app` development build opens the existing Allen UI.
- Backend starts and stops with the app.
- No copied UI or server logic.

### Phase 4: Desktop Runtime Ownership

Goal: remove user-facing terminal/setup requirements for normal desktop use.

Tasks:

- Add app settings storage.
- Add macOS Keychain storage.
- Add desktop onboarding for provider credentials.
- Add app-managed MCP setup and process lifecycle.
- Add in-app logs and health checks.
- Add dependency detection for Git and any required CLIs.
- Route desktop MCP env through runtime-generated env maps.

Deliverable:

- Users configure integrations and MCP servers through the app.
- No user-edited `.env` is required for desktop mode.

### Phase 5: Desktop Storage

Goal: remove MongoDB as a desktop prerequisite.

Tasks:

- Define persistence boundaries around current MongoDB usage.
- Add a desktop persistence adapter, preferably SQLite.
- Add migrations for desktop local DB.
- Add tests for persistence behavior.
- Keep MongoDB adapter for web/dev/server mode.

Deliverable:

- Desktop app stores local state without requiring MongoDB.
- Web/server mode remains unchanged.

### Phase 6: Native UX

Goal: make desktop features feel like desktop features.

Tasks:

- Improve terminal lifecycle and shortcuts.
- Add native notifications.
- Add open-in-Finder/editor/terminal actions.
- Add app menu commands.
- Add tray/menu bar status if useful.
- Add deep link support such as `allen://`.
- Add background execution behavior.
- Add diagnostics export.

Deliverable:

- Terminal, chat streaming, interventions, and workspace actions feel integrated with macOS.

### Phase 7: Production Packaging

Goal: ship a signed and notarized macOS build.

Tasks:

- Add app icon and bundle metadata.
- Configure signing and notarization.
- Configure hardened runtime and entitlements.
- Build DMG/ZIP artifacts.
- Add release workflow.
- Add auto-update if needed.
- Add crash/error reporting plan.

Deliverable:

- Production-ready macOS desktop release candidate.

## Risks and Decisions

### MongoDB to SQLite

This is likely the largest technical migration.

Decision needed:

- Short-term internal alpha can require MongoDB.
- Production desktop should use embedded local storage.

Recommended path:

- Do not block Electron MVP on SQLite.
- Do not ship polished desktop to normal users with a manual MongoDB requirement.

### External CLIs

Allen currently relies on external agent runtimes such as Claude Code and optionally Codex.

Decision needed:

- Continue using CLIs and manage detection/auth from the app.
- Or move more provider behavior to direct APIs over time.

Recommended path:

- Support current CLI behavior first.
- Hide setup behind desktop onboarding and health checks.
- Prefer direct provider APIs where they reduce setup burden and improve reliability.

### Native vs Shared UI

Decision:

- Do not rewrite core product UI natively.
- Use native APIs for OS capabilities and process lifecycle.

Recommended path:

- Shared React for screens.
- Electron/native APIs for OS integration.

## Definition of Done

Desktop foundation is done when:

- Existing web app still works.
- Desktop app builds from the same repo.
- Desktop app reuses shared UI/server/engine code.
- No product screens are copied into desktop-specific files.
- Backend starts and stops with `Allen.app`.
- Desktop config does not require user-edited `.env`.
- Secrets are stored outside plain config files.
- Terminal and chat streaming work in desktop mode.
- MCP servers can be configured and managed from the app.
- The app can produce diagnostics.
- There is a clear path to signed, notarized macOS releases.

## Initial Implementation Order

Recommended first implementation order:

1. Refactor server startup into an embeddable `startAllenServer()`.
2. Add `ConfigProvider` and `SecretsProvider` with env-backed implementations.
3. Add `packages/desktop` with Electron dev shell.
4. Start shared server from Electron using dynamic localhost port.
5. Load shared UI in Electron.
6. Add desktop app settings and Keychain storage.
7. Move MCP and provider setup into app-managed settings.
8. Add SQLite persistence for desktop.
9. Add native terminal/chat improvements.
10. Add signing, notarization, and release automation.
