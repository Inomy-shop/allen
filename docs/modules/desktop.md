# Desktop Module

The desktop module packages Allen as a macOS Electron app. It hosts the shared UI and starts the shared Allen backend locally so users can run Allen without manually starting the web stack. It supports multiple independent windows, each connected to the same shared backend.

## Location

`packages/desktop`

## Responsibilities

- Start and supervise the embedded Allen backend.
- Load the shared React UI in multiple independent Electron windows.
- Provide desktop-specific runtime configuration.
- Manage desktop app data paths and local runtime state.
- Bridge native capabilities such as directory picking, opening files, and external links.
- Package the app through Electron Builder.
- Manage multiple independent windows, each connected to the shared backend.
- **Check for production updates** by fetching a JSON feed, comparing versions, and prompting the user.
- **Download and open update installers** (DMG files) with progress visibility.
- **Fetch and cache release notes** from the release notes feed, with graceful fallback to cached data when offline.
- **Open workspace folders in external IDEs** (VS Code or Cursor).

## How it fits with the rest of Allen

```text
Allen.app
  -> Electron main process
  -> Embedded server from packages/server
  -> Shared UI from packages/ui
  -> Engine and workspaces through the server
```

Desktop is a host for the existing product, not a separate implementation of Allen.

## Contributor entry points

- Electron main process: `packages/desktop/src/main.ts`
- Main process unit tests: `packages/desktop/src/main.test.ts`
- Preload bridge: `packages/desktop/src/preload.ts`
- Preload bridge (CJS): `packages/desktop/preload.cjs`
- Runtime config: `packages/desktop/src/runtime-config.ts`
- Managed MongoDB runtime: `packages/desktop/src/managed-mongo.ts`
- URL external-navigation policy: `packages/desktop/src/url-policy.ts`
- Packaging config: `packages/desktop/electron-builder.yml`
- Packaging operations: [Desktop packaging](../desktop-packaging.md)

## Desktop auto-update

The desktop app uses a custom production-update checker instead of `electron-updater`. The flow works as follows:

1. **Update feed.** On startup (automatic) or when the user clicks "Check for updates" in Settings (manual), the app fetches a JSON feed from `ALLEN_UPDATE_FEED_URL` (default `https://askallen.build/download/latest.json`).
2. **Version comparison.** If the feed's version is greater than the running version, the app prompts the user via IPC (`allen:update-prompt` event → renderer `UpdatePromptModal`).
3. **User choice.** The user can postpone ("Update later") or proceed ("Update now"). The renderer sends the choice back via `allen:update-prompt-response`.
4. **Download.** On "Update now", the app downloads the DMG from the feed URL with a progress stream. The download is written to `{desktopDataDir}/updates/`.
5. **Open installer.** After download, the app opens the DMG with `shell.openPath()` and then calls `app.quit()` so the user can perform standard macOS drag-and-drop installation.

### Release notes

Alongside the update check, the app fetches a release notes index from `ALLEN_RELEASE_NOTES_FEED_URL` (default `https://askallen.build/download/releases.json`). The feed format is a JSON schema:

- `schemaVersion` — number
- `latestVersion` — the latest release version string
- `releases` — array of entries, each with `{ version, title, publishedAt, channel, clients, summary, notesUrl, sections }`

Release notes are cached to `{desktopDataDir}/updates/release-notes-cache.json` so they survive app restarts and degraded network conditions.

### IPC channels

The following IPC channels are registered in `main.ts` and bridged via the preload script:

| Channel | Direction | Purpose |
|---|---|---|
| `allen:update-settings-get` | Renderer → Main | Read auto-update preferences |
| `allen:update-settings-set-auto-enabled` | Renderer → Main | Write auto-update preference |
| `allen:update-check-now` | Renderer → Main | Trigger manual update check |
| `allen:release-notes-list` | Renderer → Main | Fetch release notes index |
| `allen:release-notes-get` | Renderer → Main | Fetch a single release note by version |
| `allen:update-prompt` | Main → Renderer | Notify renderer of available update |
| `allen:update-prompt-response` | Renderer → Main | User's response (update-now / update-later) |
| `allen:open-workspace-ide` | Renderer → Main | Open workspace folder in VS Code or Cursor |

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `ALLEN_UPDATE_FEED_URL` | `https://askallen.build/download/latest.json` | URL for the update metadata JSON |
| `ALLEN_RELEASE_NOTES_FEED_URL` | `https://askallen.build/download/releases.json` | URL for the release notes index JSON |
| `ALLEN_DISABLE_AUTO_UPDATE` | *(unset)* | Set to `1` to disable all automatic update checks |

### Auto-update preferences

User preferences are persisted as `{ autoUpdateEnabled: boolean }` in `{desktopDataDir}/allen-preferences/auto-update.json`. The default is enabled. When disabled, the app skips the scheduled check on startup but still respects manual "Check for updates" from Settings.

## Desktop multi-window support

The desktop app supports multiple independent windows, each connected to the same shared backend. Window management is handled entirely in the Electron main process (`main.ts`).

### How it works

- **Window collection.** A `Set<BrowserWindow>` (`windows`) replaces the previous `mainWindow` singleton. A `latestFocusedWindow` variable tracks the most recently focused window for focus-on-launch behavior.
- **Single shared backend.** All windows load their UI from the same `serverHandle.baseUrl`. The backend (server, engine, MongoDB) is started once and shared across all windows.
- **Independent navigation.** Each window has its own `webContents` and can navigate independently (e.g., one on Chat, another on Workspaces).

### Creating new windows

New windows can be created through desktop-native entry points only (no in-app buttons):

- **File → New Window** — menu item in the File menu.
- **Cmd+N / Ctrl+N** — keyboard shortcut for the same action.
- **Dock right-click → New Window** (macOS only) — right-click the Dock icon and select "New Window".

There is no hard limit on the number of open windows.

### Window lifecycle

- **Close one window.** Closing a window removes it from the `windows` set but does **not** stop the shared runtime or close other windows. The app stays alive.
- **Quit (Cmd+Q).** Quitting sets `isQuitting = true`, closes all windows, stops the shared runtime, and terminates the app.
- **App relaunch** (e.g., clicking Dock when already running). The app focuses the most recently focused window instead of creating a new one. If no windows exist and the runtime is up, one window is created.
- **macOS `activate` event.** If `windows` is empty and the runtime is ready, one default window is created (existing macOS convention preserved).
- **`window-all-closed` is a no-op** on all platforms (including non-macOS). The app requires an explicit Quit action to terminate.

### Window targeting for menu actions

Menu actions (File → Open Chat, Open Workspaces, Open Settings) target the focused window. If no window is focused, they fall back to the latest focused window, then to the newest alive window. This follows a `getTargetWindow()` helper:

1. `BrowserWindow.getFocusedWindow()` — if alive and tracked in the `windows` set.
2. `latestFocusedWindow` — if alive and tracked.
3. The newest member of the `windows` set (preserves focus-recency ordering).

### Dialogs

All desktop dialogs (Show Diagnostics, Export Support Bundle, directory picker) attach to the window returned by `getTargetWindow()`, so they appear over the correct window.

### Update prompts

When an update is available, the prompt is sent to the focused window only, using the same targeting chain as menu actions. If no window exists, the prompt is skipped and logged rather than shown as a blocking dialog.

### Crash recovery

If a renderer process crashes, the app shows a dialog with "Reload Window" and "Close Window" buttons (previously "Reload Window" and "Quit"). Clicking "Close Window" closes only the crashed window without affecting other windows or stopping the runtime.

## Related concepts

- [Workspaces](../concepts/workspaces.md)
- [Integrations](../concepts/integrations.md)
- [Security and sandboxing](../security.md)
