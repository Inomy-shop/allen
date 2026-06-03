# Allen Desktop Packaging

Phase 5 packaging commands run from the desktop worktree:

```bash
cd /Users/shreemantkumar/allen-internal-desktop
npm --workspace @allen/desktop run dist:mac:unsigned
```

This builds the shared engine, server, UI, and Electron host, pre-seeds a MongoDB binary into `packages/desktop/assets/mongo-binaries`, then produces local macOS artifacts under `packages/desktop/release`.

For signing-capable machines, use:

```bash
npm --workspace @allen/desktop run dist:mac
```

The builder config lives in `packages/desktop/electron-builder.yml`.

## Local Signed Release

For a public macOS release built from a local Mac, copy the signing template and
fill it with the Apple Developer credentials:

```bash
cp .env.signing.example .env.signing.local
```

By default, each release run asks whether to use `patch`, `minor`, `major`,
`none`, or an exact version before building. Set `RELEASE_VERSION_BUMP` in
`.env.signing.local` to a fixed value like `patch`, `minor`, `major`, `1.2.3`,
or `none` if you do not want the prompt.

Use either a Keychain-installed `Developer ID Application` identity or a `.p12`
via `CSC_LINK`. The same env file also supports notarization through an Apple ID
app-specific password, a stored `notarytool` keychain profile, or an App Store
Connect API key.

Then run:

```bash
npm run release:mac:local
```

The script validates the signing identity, checks notarization credentials,
bumps and synchronizes the root and desktop package versions, runs the macOS
release build, verifies the code signature, checks Gatekeeper assessment, and
validates the stapled notarization ticket.

## Local Package Smoke

After producing the local `--dir` package, validate the packaged runtime with:

```bash
npm --workspace @allen/desktop run smoke:packaged
```

The smoke command launches `packages/desktop/release/mac-arm64/Allen.app` in a temporary user-data directory, starts the embedded backend with the bundled MongoDB binary, checks `/api/health`, then shuts the runtime down.

To validate the packaged renderer and first-run flow, run:

```bash
npm --workspace @allen/desktop run smoke:packaged:ui
```

The UI smoke launches the real packaged window with a temporary user-data directory, verifies the desktop preload bridge, creates the first admin account, reaches `/onboarding/health`, checks `/api/system/health`, validates chat SSE subscription, exercises terminal WebSocket I/O, saves/deletes a desktop Settings secret, and creates/tests/deletes a fixture MCP server.

For safety, the UI smoke runs with `ALLEN_DESKTOP_SECRET_STORE=file`, so Settings secret checks use a temporary app-data file instead of the user's macOS Keychain.

The packaged app icon is sourced from `https://askallen.build/` and stored under `packages/desktop/build`.

## MongoDB Binary

`npm --workspace @allen/desktop run preseed:mongo` resolves a `mongod` binary with `mongodb-memory-server-core`, copies it into `packages/desktop/assets/mongo-binaries`, and marks it executable.

At runtime, the packaged app checks `process.resourcesPath/mongo-binaries` first and uses the bundled `mongod` as `systemBinary`. If no bundled binary is present, it falls back to the app-owned cache under Electron `userData`.

Set `ALLEN_DESKTOP_MONGODB_VERSION` during pre-seed to pin a specific MongoDB version:

```bash
ALLEN_DESKTOP_MONGODB_VERSION=8.2.1 npm --workspace @allen/desktop run preseed:mongo
```

## Signing

The current config supports hardened runtime entitlements and lets `electron-builder` use the available macOS signing identity. The unsigned script disables certificate auto-discovery for local validation.

Notarization remains a release-operations step: wire Apple credentials into CI before producing public builds.

## Logs

The desktop host writes startup/runtime diagnostics to Electron `userData/logs/desktop.log`. In desktop mode, Settings exposes the logs path and an Open Logs action through the context-isolated preload bridge.
