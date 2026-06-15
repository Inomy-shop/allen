# Allen Desktop Packaging

This page summarizes how contributors can build and smoke-test the macOS desktop app locally. It is an operations guide, not a release roadmap.

## Local package

Build an unsigned macOS package:

```bash
npm --workspace @allen/desktop run dist:mac:unsigned
```

Build with signing enabled on a machine configured with Apple Developer credentials:

```bash
npm --workspace @allen/desktop run dist:mac
```

The Electron Builder config lives at `packages/desktop/electron-builder.yml`. Build output is written under `packages/desktop/release`.

## Local signed release helper

For a local signed release, copy the signing template and fill it with the required Apple Developer values:

```bash
cp .env.signing.example .env.signing.local
npm run release:mac:local
```

The release helper validates signing configuration, synchronizes package versions, builds the app, checks code signature, runs Gatekeeper assessment, and verifies notarization when configured.

## Smoke validation

After producing a local package, validate the packaged backend runtime:

```bash
npm --workspace @allen/desktop run smoke:packaged
```

Validate the packaged renderer and first-run desktop flow:

```bash
npm --workspace @allen/desktop run smoke:packaged:ui
```

The UI smoke uses a temporary user-data directory. It avoids touching the user's macOS Keychain by using the file-backed secret store mode for test secrets.

## MongoDB binary pre-seeding

The desktop app can pre-seed a MongoDB binary so the packaged app can start offline:

```bash
npm --workspace @allen/desktop run preseed:mongo
```

To pin a MongoDB version for pre-seeding:

```bash
ALLEN_DESKTOP_MONGODB_VERSION=8.2.1 npm --workspace @allen/desktop run preseed:mongo
```

At runtime, the desktop app checks bundled resources first and falls back to its app-owned cache when a bundled binary is unavailable.

## Logs

The desktop host writes runtime diagnostics to the app data logs directory. In desktop mode, Settings exposes the logs path and an action to open it.

## Update feed

The desktop app checks for updates by fetching a JSON feed at `ALLEN_UPDATE_FEED_URL`. The feed must return a JSON object with the following shape:

```json
{
  "version": "0.2.0",
  "url": "https://askallen.build/download/Allen-0.2.0-arm64.dmg",
  "releaseNotesUrl": "https://askallen.build/download/releases/0.2.0.json",
  "releasesUrl": "https://askallen.build/download/releases.json"
}
```

- `version` — the new version (semver, compared against `app.getVersion()`).
- `url` — HTTPS download URL for the DMG. Must be same origin as the feed URL; validated by `url-policy.ts`.
- `releaseNotesUrl` — optional URL for the detailed release note for this version.
- `releasesUrl` — optional URL for the release notes index (list of all releases).

To publish an update, host the DMG and feed JSON at the configured origin, then update the feed metadata. The app respects `ALLEN_UPDATE_FEED_URL` for custom hosting.

## Release notes feed

The release notes index at `ALLEN_RELEASE_NOTES_FEED_URL` returns a JSON object:

```json
{
  "schemaVersion": 1,
  "latestVersion": "0.2.0",
  "releases": [
    {
      "version": "0.2.0",
      "title": "Allen 0.2.0",
      "publishedAt": "2026-06-14T00:00:00Z",
      "channel": "stable",
      "clients": ["desktop"],
      "summary": "Auto-update popup with release notes and download progress.",
      "notesUrl": "https://askallen.build/download/releases/0.2.0.json",
      "sections": [
        { "title": "New", "items": ["Auto-update popup with version-specific release notes"] },
        { "title": "Fixed", "items": ["Download progress now visible in the popup"] }
      ]
    }
  ]
}
```

Entry fields:
- `schemaVersion` — feed format version (default 1).
- `latestVersion` — the latest release version.
- `releases` — array of release entries, sorted newest-first by the app.
- Each entry: `version` (required), `title`, `publishedAt`, `channel`, `clients` (if specified and does not include `"desktop"`, the entry is skipped), `summary`, `notesUrl` (same-origin HTTPS URL for the detailed release note), `sections` (array of `{ title, items }` for structured notes).

When the feed is unreachable, the app falls back to a local on-disk cache stored at `{desktopDataDir}/updates/release-notes-cache.json`.

## Related docs

- [Desktop module](modules/desktop.md)
- [Security and sandboxing](security.md)
