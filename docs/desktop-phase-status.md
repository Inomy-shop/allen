# Allen Desktop Phase Status

Current worktree: `/Users/shreemantkumar/allen-internal-desktop`

Branch: `desktop-app`

## Phase 0 - Audit

Status: complete.

Output:

- Captured startup, configuration, persistence, lifecycle, MCP, and UI risks in `docs/desktop-phase-0-audit.md`.

## Phase 1 - Embeddable Server

Status: complete.

Output:

- Added `startAllenServer` and `createAllenExpressApp` in `packages/server/src/server.ts`.
- Kept web mode working through `packages/server/src/app.ts`.
- Added explicit stop handles for HTTP, terminal WebSocket, file watcher, MCP health monitor, MCP orphan sweeper, cron, and managed database connections.
- Added dynamic port support for desktop mode.

## Phase 2 - Runtime Providers

Status: complete.

Output:

- Added runtime config and secrets provider interfaces in `packages/server/src/runtime`.
- Migrated JWT, integrations, MCP config loading, child-process env construction, and internal API URL usage away from direct `process.env` coupling where desktop needs injection.
- Kept `.env` behavior for web/dev mode through env-backed providers.

## Phase 3 - Desktop Shell

Status: complete.

Output:

- Added `packages/desktop` Electron workspace.
- Desktop starts the shared Allen backend internally on `127.0.0.1` with an OS-selected HTTP port.
- Desktop loads the shared `packages/ui` build from the embedded backend.
- Desktop generates stable local JWT secrets under the app data directory, so bootstrap no longer needs `.env`.
- Desktop health checks use the external workflow Node runtime instead of Electron's embedded Node version.
- Added tests for desktop runtime config, embedded static UI serving, dynamic backend ports, and inherited API URL isolation.

Run:

```bash
cd /Users/shreemantkumar/allen-internal-desktop
npm --workspace @allen/desktop run dev
```

## Phase 4 - Runtime Ownership

Status: complete.

Output:

- Desktop runtime now owns its app data paths under Electron `userData`.
- Desktop starts and stops a managed local MongoDB runtime when no explicit `MONGODB_URI` is configured.
- Desktop stores managed MongoDB data under Electron `userData`, so users do not need to start MongoDB separately.
- Desktop stores managed MongoDB binaries under Electron `userData`, so the runtime is app-owned.
- Desktop defaults the terminal WebSocket port to the main Allen HTTP server in desktop mode, so packaged UI terminal and file-watch sockets use the same origin.
- Desktop mode overrides inherited `ALLEN_API_URL` and `ALLEN_INTERNAL_API_URL` after the backend binds its dynamic port.
- Desktop now wires explicit config and secrets providers into the embedded server.
- Desktop runtime JWT secrets are stored in macOS Keychain through a native `security` CLI adapter, with migration from older `desktop-runtime.json` secret values.
- Desktop settings now expose runtime status and allow saving/deleting Keychain-backed GitHub, Linear, Slack, and MCP credential keys without returning secret values to the UI.
- MCP credential validation now uses the runtime config/secrets providers instead of hardcoding `.env` guidance.
- Electron now uses a context-isolated preload bridge for desktop-only APIs: runtime info, native directory picker, Finder reveal, and external URL opening.

## Phase 5 - Distribution And Native Polish

Status: complete for local packaging and packaged runtime validation.

Scope:

- Package `Allen.app` with a bundled or pre-seeded MongoDB binary strategy for offline first launch.
- Add signing, notarization, auto-update, crash reporting, and log diagnostics.
- Expand native menus, notifications, and desktop-specific workflow affordances.

Output:

- Added `electron-builder` configuration for macOS `.app`, DMG, and zip outputs.
- Added local unsigned package command: `npm --workspace @allen/desktop run dist:mac:unsigned`.
- Added signing-capable package command: `npm --workspace @allen/desktop run dist:mac`.
- Added hardened runtime entitlements scaffold.
- Added the Allen app icon from `askallen.build` and a branded DMG background.
- Added MongoDB binary pre-seed script and packaged-resource runtime lookup.
- Added packaged smoke test command: `npm --workspace @allen/desktop run smoke:packaged`.
- Added packaged-app startup logging under Electron `userData/logs` and a Settings action to open the logs directory.
- Added a native desktop menu for Chat, Workspaces, Settings, data/log folder access, diagnostics copy, reload/devtools, and help links.
- Added auto-update wiring through `electron-updater`; downloads stay manual until release UX is finalized.
- Fixed packaged ESM metadata, startup import order, upload path ownership, Keychain timeouts, and managed Mongo launch args.
- Validated a local `--dir` package at `packages/desktop/release/mac-arm64/Allen.app`.
- Validated packaged smoke startup: embedded backend, bundled MongoDB binary, static UI server, cron, MCP sync, file watcher, and shared terminal WebSocket all start and shut down cleanly.

Release operations still required before public distribution:

- Add Apple Developer signing identity and notarization credentials in CI. On hold for now.
- Publish release artifacts to the configured update feed. On hold for now.
- Run manual GUI checks for bootstrap, chat streaming, terminal, settings secrets, and MCP against a signed/notarized build.

## Phase 6 - Packaged Desktop QA Automation

Status: complete for local packaged-app QA automation.

Scope:

- Turn the remaining local packaged-app QA into repeatable checks.
- Verify the packaged browser window, preload bridge, first-run bootstrap, and onboarding entry path.
- Catch desktop-only packaging/runtime regressions before manual QA.

Output:

- Added `npm --workspace @allen/desktop run smoke:packaged:ui`.
- Added a Playwright Electron packaged UI smoke at `packages/desktop/scripts/smoke-packaged-ui.mjs`.
- The UI smoke launches `Allen.app` with an isolated temporary `userData` directory.
- The UI smoke verifies the desktop preload bridge, runtime info, local backend URL, managed MongoDB, logs path, first-run onboarding, admin bootstrap, `/onboarding/health`, and `/api/system/health`.
- Expanded the UI smoke to cover signed-in chat SSE stream subscription, chat session readback, terminal WebSocket interaction from the packaged renderer, desktop Settings secret save/delete, MCP server list/create/test/delete, and a successful stdio MCP handshake.
- Fixed packaged preload loading by using `packages/desktop/preload.cjs`; Electron preload scripts are now CommonJS while the main process remains ESM.
- Updated packaging config to include `packages/desktop/preload.cjs`.
- Added a file-backed desktop secret store for isolated packaged QA via `ALLEN_DESKTOP_SECRET_STORE=file`, so smoke tests do not touch the user's macOS Keychain secrets.

Validated:

- `npm --workspace @allen/desktop run lint`
- `npm --workspace @allen/desktop run test`
- `npm --workspace @allen/desktop run build`
- `npx electron-builder --projectDir . --config packages/desktop/electron-builder.yml --dir --mac --arm64 --publish never`
- `npm --workspace @allen/desktop run smoke:packaged`
- `npm --workspace @allen/desktop run smoke:packaged:ui`

## Phase 7 - Production Hardening

Status: started.

Scope:

- Harden Electron security boundaries before broader manual QA.
- Add defense-in-depth around navigation, renderer permissions, content security policy, and external URL opening.
- Continue improving diagnostics, data lifecycle, and failure recovery without starting public release work.

Output:

- Added a default deny policy for renderer permission requests.
- Added CSP headers for the embedded local app responses.
- Kept renderer navigation constrained to the embedded Allen backend origin.
- Restricted native external URL opening to public HTTPS URLs.
- Explicitly enabled Electron web security and disabled insecure mixed-content execution.
- Removed desktop runtime dependency on remote font stylesheets by using local system font stacks in the desktop renderer.
- Added a native support bundle export with sanitized runtime config, health snapshots, security posture, paths, and log tails.
- Exposed support bundle export in the desktop Settings runtime panel and native File menu.
- Extended packaged UI smoke to verify support bundle creation and secret redaction.
- Added a single-instance lock so two desktop processes do not concurrently use the same app-owned data directory.
- Added renderer crash/unresponsive logging with a native reload-or-quit recovery prompt.
- Reworked desktop MCP credential entry so preset and repo-sourced MCP servers can receive required API keys/secrets from the UI-backed secret store instead of `.env`.
- Extended packaged UI smoke to prove a custom MCP credential is saved through the app, passed to the child MCP process as an allowlisted bare env var, and redacted from support bundles.

Release operations:

- Apple Developer signing, notarization, and public update publishing remain on hold.
