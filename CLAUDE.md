# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

Allen is an "agentic operating system for software development" — a TypeScript monorepo that runs YAML workflows and coding agents against real repositories, with isolated workspaces, execution traces, artifacts, human checkpoints, and integrations (GitHub, Linear, Slack, MCP, Claude Code CLI).

Three packages under npm workspaces, orchestrated by Turbo:

- `packages/engine` (`@allen/engine`) — workflow runtime: YAML loading/validation, template rendering, node execution, conditions, parallel branches, MCP loading, output extraction, agent execution via Claude Code CLI/SDK.
- `packages/server` (`@allen/server`) — Express API + MongoDB persistence, auth/JWT, repos/workspaces, executions, chat, artifacts, cron, and GitHub/Linear/Slack/MCP integrations. WebSockets for workspace terminal + file watch.
- `packages/ui` (`@allen/ui`) — React/Vite frontend (xterm, @xyflow, Monaco, Tailwind, Zustand).

`packages/server` depends on `packages/engine` (workspace `*` dep). Engine has no dependency on server.

## Common Commands

Run from the repo root (Turbo fans out to all workspaces):

```bash
npm run setup       # Verifies Node 22+/npm 10+, installs Mongo + Claude CLI, runs npm install, writes .env
npm start           # alias for `turbo run dev` — runs server (4000) + UI (5173) concurrently
npm run dev         # same as npm start
npm run build       # tsc + Vite production build across packages
npm run lint        # `tsc --noEmit` across packages (no ESLint configured)
npm test            # Vitest unit/integration suites across packages
npm run health      # runs server's health probe script
```

Per-package commands (useful when iterating on one surface):

```bash
npm run dev   --workspace=@allen/server   # tsx watch src/app.ts
npm run dev   --workspace=@allen/ui       # vite
npm run test  --workspace=@allen/engine   # vitest run (engine only)
npm run test:watch --workspace=@allen/server
```

Running a single test file or test:

```bash
# Single file
npx vitest run packages/engine/src/template.test.ts --root packages/engine

# Single test by name
npx vitest run -t "renders nested binding" --root packages/engine
```

E2E (Playwright — drives real server + UI, hits live MongoDB):

```bash
npm run test:e2e            # auto-starts server (4023) + UI (5173), installs Chromium
npm run test:e2e:dev        # reuses an already-running `npm run dev` (sets E2E_REUSE_DEV_SERVER=1)
npm run test:e2e:ui         # Playwright UI mode
npm run test:e2e:headed     # headed run; supports --debug, -- --project=chromium e2e/foo.spec.ts
npx playwright test e2e/workspace.spec.ts   # single spec
npm run test:e2e:report     # open the HTML report from the last run
```

E2E port defaults differ from `npm start`: server `4023`, UI `5173`. `scripts/e2e-preauth.ts` pre-creates auth tokens before Playwright starts. The Mongo connection used by e2e is the same one the server's `.env` points at — there is no in-memory DB for e2e.

## Architecture Notes

`docs/architecture.md` is the authoritative deep dive. Highlights that aren't obvious from reading a single file:

### Workflow Lifecycle

1. UI/trigger calls server → server writes an execution record in Mongo.
2. Engine loads the YAML from `packages/engine/workflows/` and the agent registry from `packages/engine/agents.yml`.
3. Nodes execute sequentially with support for condition and parallel branches (`src/parallel.ts`, `src/condition-parser.ts`).
4. Agent nodes spawn Claude Code via CLI (default) or SDK; output is parsed by `src/output-extractor.ts` and persisted as artifacts.
5. Human nodes create interventions/checkpoints; the UI resumes them via `/api/interventions`.
6. State and logs stream to the UI over SSE; workspace terminal + file watch share a WebSocket on port `4024`.

When changing engine behavior, the key entry points are `src/engine.ts` (top-level orchestration), `src/node-executor.ts` (per-node execution + agent invocation), `src/state-manager.ts` (persisted execution state), and `src/template.ts` (Handlebars rendering with binding capture).

### Workflows, Agents, Router

- Workflows: `packages/engine/workflows/*.yml`. Add a new one by dropping a YAML file and matching the schema in `src/validator.ts` / `src/types.ts`.
- Agents: `packages/engine/agents.yml` defines both **team agents** (orchestrators that delegate) and **specialist agents**. The `engineer` agent uses Codex by default; most others use Claude (`sonnet`/`opus`/`haiku` aliases). Agent loading is in `src/agents-loader.ts`.
- Router: `packages/engine/router.yml` drives chat/built-in agent routing via `src/router.ts`.

### Server Routes & Services

Routes are registered in `packages/server/src/app.ts`; each `/api/<area>` maps to a file in `src/routes/`. Notable service-layer files when working on:

- Workspaces: `services/workspace.service.ts`, `workspace-terminal.ts`, `workspace-watcher.ts`, `workspace-proxy.ts`.
- Chat: `services/chat.service.ts` — handles `@ENG-123` Linear mention resolution and `@name` workflow/repo/agent mentions; `ChatSession.source` is `'ui' | 'slack' | 'automation'`.
- Cron / automation: `services/cron.service.ts` upserts a persistent `chat_sessions` doc (keyed by `automationKey`) for agent-target jobs and injects an `AUTOMATION_CONTEXT` block with a **5-minute** admin JWT into the agent prompt. The agent POSTs back via `/api/chat/sessions/:id/automation-message`. Don't extend the TTL or persist long-lived tokens.
- Linear: `services/linear.service.ts` — GraphQL client with TTL caches (status 5m, projects 1m, issues 30s) to stay under Linear's 4500 req/hr limit.
- MCP: `services/mcp.service.ts` plus engine's `src/mcp-loader.ts` / `src/mcp-install.ts`. Python MCPs get a per-MCP venv at `<ALLEN_HOME>/venvs/<mcpId>/`; a manual **Command** override opts out of Allen-managed venv creation.

Public capability-style routes exist for artifacts, files, execution SSE, workspace logs, and workspace previews. Treat changes to these as security-sensitive; consult `docs/security.md`.

### UI

React Router pages live in `packages/ui/src/pages/`; reusable components in `src/components/<area>/`. State is mostly local + Zustand stores in `src/stores/`. Activity page (`ExecutionListPage.tsx`) auto-refreshes every 5s while running/queued executions are present and exports a pure `paginationViewModel` for testability. Chat composer (`components/chat/ChatInput.tsx`) drives `@mention` autocomplete (`MentionAutocomplete.tsx`) with default and Linear modes.

## Conventions

- **TypeScript everywhere**, `strict: true`. Modules use `NodeNext` resolution; engine and server are ESM (`"type": "module"`).
- **Prefer explicit types at module and persistence boundaries.** Match local patterns in the package you're editing; don't drive-by refactor unrelated code.
- **Workflow YAML** must keep human-facing labels, descriptions, and outputs — the UI surfaces them in the workflow builder and execution trace.
- **Agent execution defaults to CLI mode.** `ALLEN_AGENT_EXECUTION_MODE=cli` is the explicit default; `=sdk` only when intentionally forcing the in-process SDK path. `CLAUDE_BIN` overrides which `claude` binary is used.
- **System-prompt mode:** `ALLEN_SYSTEM_PROMPT_MODE=append` (default) layers Allen's role prompt on top of Claude Code's scaffolding; `custom` fully replaces it where supported.
- **MCP env convention:** MCP-required keys are read from `.env` with an `ALLEN_` prefix and forwarded to the subprocess without it. Example: an MCP that wants `GITHUB_PERSONAL_ACCESS_TOKEN` reads `ALLEN_GITHUB_PERSONAL_ACCESS_TOKEN` from `.env`. Both Node and Python MCPs follow this.
- **Model aliases:** Agents reference `haiku`/`sonnet`/`opus`; `ALLEN_MODEL_HAIKU` / `_SONNET` / `_OPUS` override the resolved model (`src/model-alias.ts`).
- **Security-sensitive areas:** workflow YAML, agent definitions, workspace lifecycle, auth/JWT, MCP loading, capability URLs. Read the surrounding code before adding abstractions in these areas.
- **Never commit** `.env`, API keys, OAuth tokens, SSH keys, private repo contents, customer data, or proprietary prompts (including in test fixtures, logs, or screenshots).

## Runtime Ports

| Port | Purpose |
|------|---------|
| `4000` | API server during `npm start` |
| `5173` | Vite UI |
| `4023` | API server for Playwright e2e |
| `4024` | Shared workspace terminal + file-watch WebSocket (`TERMINAL_WS_PORT` overrides) |
| `15000+` | Workspace service port blocks (10 ports per workspace) |
| `27017` | Local MongoDB |

## Pull Request Expectations

The PR template (`.github/PULL_REQUEST_TEMPLATE.md`) requires `npm run build`, `npm run lint`, `npm test`, and — when the change touches UI, workspaces, execution traces, chat, integrations, auth, or agent execution — `npm run test:e2e` or a focused manual test. Keep PRs to a single Allen surface area and update `.env.example` / docs when setup or behavior changes.

## Reference Docs

- `docs/architecture.md` — full system, package, data model, and integration overview.
- `docs/first-workflow.md` — first local run end-to-end.
- `docs/security.md` — sandboxing, secrets, MCP, and capability URLs.
- `docs/troubleshooting.md` — common setup and runtime failures.
- `docs/known-limitations.md` — alpha limitations.
- `e2e/README.md` — Playwright suite details, gotchas, and env vars.
