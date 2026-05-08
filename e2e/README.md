# Allen E2E Tests (Playwright)

Integration tests that drive the **real** server (`:4023`) and UI (`:5173`) — they create workspaces, spawn agents, hit the live MongoDB, and check the rendered React views. They are **not** unit tests; use `npm test` at the root for unit coverage.

## Quick start

```bash
# Run the full suite. Auto-downloads Chromium on first run, auto-starts
# server + UI dev processes. No extra setup needed.
npm run test:e2e

# If you already have `npm run dev` running in another terminal,
# reuse it (skips the auto-start + browser install):
npm run test:e2e:dev

# Interactive UI mode (pick individual specs, replay, time-travel)
npm run test:e2e:ui

# Run a single spec file
npx playwright test e2e/workspace.spec.ts

# Debug a failing spec with browser visible and traces
npm run test:e2e:headed -- --project=chromium --debug e2e/workspace-terminal.spec.ts

# Open the HTML report from the last run
npm run test:e2e:report
```

On an AWS EC2 deploy, the bootstrap script (`infra/templates/bootstrap.sh`)
installs the Chromium browser bundle and its system libs automatically, so
`npm run test:e2e` on the server works with no additional steps.

## What's covered — 88 tests in 16 spec files

| Area | Specs |
|---|---|
| **Workspace lifecycle** | `workspace.spec.ts`, `workspace-sandbox.spec.ts` |
| **Workspace features** | `workspace-terminal.spec.ts`, `workspace-chat.spec.ts`, `workspace-image-preview.spec.ts`, `workspace-security-hardening.spec.ts`, `workspace-panels.spec.ts` |
| **Executions & agents** | `agent-execution.spec.ts`, `agent-live-test.spec.ts`, `exec-logs-test.spec.ts`, `exec-desc-test.spec.ts` |
| **Repos** | `repo-list.spec.ts` |
| **MCP** | `mcp-python.spec.ts` |
| **Editor / UI widgets** | `markdown-preview.spec.ts`, `icon-theme.spec.ts`, `terminal-screenshot.spec.ts` |

## Configuration

- **`playwright.config.ts`** (repo root) — defines browsers, timeouts, and the auto-start `webServer` block that launches `npm run dev --workspace=@allen/server` + `npm run dev --workspace=@allen/ui` on demand.
- **`e2e/helpers.ts`** — exports `API` and `UI` base URL constants derived from `API_PORT` / `UI_PORT` env vars. Default 4023 + 5173; the workspace-sandbox specs override to 15000/15001.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `API_PORT` | 4023 | Allen server port |
| `UI_PORT` | 5173 | Vite dev server port |
| `E2E_REUSE_DEV_SERVER` | unset | When `=1`, skip the Playwright auto-start and assume server + UI are already running |
| `CI` | unset | Auto-set in CI — enables retries + GitHub reporter |

## Known gotchas

1. **Needs a running MongoDB** — tests hit the live DB. Use the same instance `npm run dev` points at (local or dev DocumentDB via the env). On EC2 this is automatic because the server is configured to talk to the real DB.
2. **MCP + Claude Code SDK** — specs that spawn agents use the real Claude CLI subprocess. Make sure `claude` is on your PATH and authenticated before running agent-related specs.
3. **Leftover workspace state** — specs that create workspaces commit real git operations. If a test crashes mid-run, stray files may remain in `~/allen-workspaces/`. `workspace-sandbox.spec.ts` is safe (cleans up after itself); manual cleanup is only needed if the process is killed with SIGKILL.
4. **No visual regression baselines** — the previous baseline PNGs were captured on one developer's machine and were removed. If you want visual regression again, use `await expect(page).toHaveScreenshot('name.png')` (Playwright's built-in API) which stores per-platform baselines and is machine-portable.

## NOT run by `npm test`

The root `npm test` command fans out via turbo to the three workspace `vitest` suites (unit tests only — ~2s total, 73 tests). E2E tests are deliberately excluded because they:

- Take 5–20 minutes
- Need an actual server + UI running
- Create real filesystem / DB state
- Depend on external processes (git, npm, Claude CLI)

Run them on-demand locally and in a dedicated CI job (not the unit test stage).
