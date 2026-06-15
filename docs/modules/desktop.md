# Desktop Module

The desktop module packages Allen as a macOS Electron app. It hosts the shared UI and starts the shared Allen backend locally so users can run Allen without manually starting the web stack.

## Location

`packages/desktop`

## Responsibilities

- Start and supervise the embedded Allen backend.
- Load the shared React UI in an Electron window.
- Provide desktop-specific runtime configuration.
- Manage desktop app data paths and local runtime state.
- Bridge native capabilities such as directory picking, opening files, and external links.
- Package the app through Electron Builder.
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

## Related concepts

- [Workspaces](../concepts/workspaces.md)
- [Integrations](../concepts/integrations.md)
- [Security and sandboxing](../security.md)
