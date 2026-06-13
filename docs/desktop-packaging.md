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

## Related docs

- [Desktop module](modules/desktop.md)
- [Security and sandboxing](security.md)
