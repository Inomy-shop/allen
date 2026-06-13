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
- Runtime config: `packages/desktop/src/runtime-config.ts`
- Managed MongoDB runtime: `packages/desktop/src/managed-mongo.ts`
- Packaging config: `packages/desktop/electron-builder.yml`
- Packaging operations: [Desktop packaging](../desktop-packaging.md)

## Related concepts

- [Workspaces](../concepts/workspaces.md)
- [Integrations](../concepts/integrations.md)
- [Security and sandboxing](../security.md)
