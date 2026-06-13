# E2E Module

The e2e suite verifies Allen through real browser and backend flows. It is separate from package-level unit tests because it exercises the running product.

## Location

`e2e`

## Responsibilities

- Drive the React UI with Playwright.
- Exercise workspace, terminal, chat, execution, repo, MCP, and UI flows.
- Validate behavior across the UI, server, database, filesystem, and external processes.
- Catch integration regressions that unit tests cannot see.

## How it fits with the rest of Allen

```text
Playwright browser
  -> UI dev server
  -> Allen API server
  -> MongoDB, workspace services, and agent/runtime dependencies
```

Use e2e tests for user journeys and cross-package behavior. Use package tests for isolated logic.

## Contributor entry points

- E2E guide: `e2e/README.md`
- Spec files: `e2e/*.spec.ts`
- Shared test helpers: `e2e/helpers.ts`
- Playwright config: `playwright.config.ts`

## Related concepts

- [Workspaces](../concepts/workspaces.md)
- [Workflows](../concepts/workflows.md)
