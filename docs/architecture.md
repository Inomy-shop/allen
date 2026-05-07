# Architecture

Allen is a TypeScript monorepo for coordinating AI agents across software engineering workflows.

## System Overview

```text
React UI
  |
  | HTTP, SSE, WebSocket
  v
Express Server -------------- MongoDB
  |                              |
  | starts workflows             | users, teams, repos, workflows,
  | manages workspaces           | executions, artifacts, chat,
  | serves artifacts/files       | integrations, learnings
  v
Workflow Engine
  |
  | loads YAML workflows and agents
  v
Agent Executors -------------- MCP Servers / Integrations
  |
  | Claude Code CLI or SDK
  v
Local Repositories and Workspaces
```

## Packages

### `packages/engine`

The workflow runtime.

Responsibilities:

- Load workflows from `packages/engine/workflows/`.
- Load agents from `packages/engine/agents.yml`.
- Validate YAML workflow structure.
- Render templates and track template bindings.
- Execute human, agent, built-in, condition, and parallel nodes.
- Maintain per-execution state.
- Extract structured outputs from agent responses.
- Attach artifacts to workflow, chat, and agent roots.
- Load MCP server definitions and inject allowed environment variables.
- Run agents through Claude Code CLI or SDK.

Important files:

- `src/engine.ts` - core workflow execution.
- `src/node-executor.ts` - node execution and agent invocation.
- `src/codex-executor.ts` and `src/cli-runner.ts` - Claude Code CLI execution paths.
- `src/parallel.ts` - parallel branch coordination.
- `src/condition-parser.ts` - condition node evaluation.
- `src/template.ts` - template rendering and binding capture for node inputs.
- `src/router.ts` - agent routing rules consumed by chat and built-in nodes.
- `src/agents-loader.ts` and `agents.yml` - agent definitions for teams and specialists.
- `src/mcp-loader.ts` and `src/mcp-install.ts` - MCP server loading, installation, and `ALLEN_`-prefix env mapping. Supports both Node.js (`.ts`/`.js`/`.mjs`) and Python (`.py`) entry files; Python MCPs default to `python3` and skip automatic `npm install`.
- `src/output-extractor.ts` - output parsing from model responses.
- `src/state-manager.ts` - persisted execution state.
- `src/learning-manager.ts` - learnings capture, retrieval, and prompt injection.
- `src/clarify-synthesizer.ts` - clarification gate handling for human checkpoints.
- `src/orphan-sweeper.ts` - background sweep of orphaned MCP child processes.
- `src/paths.ts` - resolves `ALLEN_HOME` and `WORKSPACE_BASE_DIR`.
- `src/model-alias.ts` - resolves `ALLEN_MODEL_HAIKU/SONNET/OPUS` overrides.
- `src/validator.ts` and `src/types.ts` - workflow YAML schema and types.
- `workflows/*.yml` - runnable workflows (`understand-and-plan`, `bug-investigate-and-fix`, `feature-plan-and-implement`, `resolve-pr-reviews`).

### `packages/server`

The API, persistence, orchestration, and integration layer.

Responsibilities:

- Connect to MongoDB and ensure indexes.
- Bootstrap the first admin user from `.env`.
- Seed default teams, agents, and workflows.
- Expose authenticated API routes.
- Manage users, auth, JWTs, password reset, and admin gating.
- Manage repos and workspaces.
- Start workspace terminals and file watchers.
- Serve execution streams, workspace logs, public artifact URLs, and public file URLs.
- Integrate with GitHub, Linear, Slack, MCP, and cron jobs.
- Proxy workspace app previews.

Routes (registered in `packages/server/src/app.ts`):

- `/api/health` - server health probe.
- `/api/auth` - login, refresh, password reset.
- `/api/users` - user management.
- `/api/teams` - teams.
- `/api/agents` - agent definitions.
- `/api/workflows` - workflow definitions.
- `/api/executions` - execution records and SSE streams.
- `/api/repos` - repo registration.
- `/api/workspaces` - workspaces, terminals, file watch, preview proxy.
- `/api/chat` - chat sessions and messages.
- `/api/mcp` - MCP server registry. Includes `GET /servers/discover/:repoId` (scan a repo for Python and Node MCP entry files) and `POST /servers/:id/reinstall` (bust the install cache and re-run `npm install`; Python MCPs return a skip response instead).
- `/api/linear` - Linear integration.
- `/api/slack` - Slack integration (raw body, signature-verified).
- `/api/pull-requests` - PR list and detail.
- `/api/artifacts` - artifact metadata and content.
- `/api/files` - uploaded file metadata and content.
- `/api/dashboard` - dashboard aggregations.
- `/api/learnings` - learnings store.
- `/api/alerts` - operator alerts.
- `/api/crons` - scheduled jobs.
- `/api/design-docs` - design documents.
- `/api/interventions` - human checkpoint queue.

Important server files:

- `src/app.ts` - HTTP app, route registration, middleware order, WebSocket server bootstrap.
- `src/auth/` - JWT issuance, password hashing, refresh tokens, admin bootstrap.
- `src/middleware/requireAuth.ts` and `requireAdmin.ts` - route gating.
- `src/services/workspace.service.ts` - workspace lifecycle, port allocation, preview wiring.
- `src/services/workspace-terminal.ts` - shared terminal + file-watch WebSocket on port `4024`.
- `src/services/workspace-watcher.ts` - file watcher attached to the terminal WebSocket.
- `src/services/workspace-proxy.ts` - workspace preview proxy.
- `src/services/github-auth.ts` - GitHub token resolution from `.env`.
- `src/services/linear.service.ts`, `services/slack.service.ts`, `services/slack-notifier.ts` - integrations.
- `src/routes/file.routes.ts` and `routes/artifact.routes.ts` - capability-URL public routes.

Public capability-style routes exist for generated file links, artifact links, execution SSE, workspace log SSE, and workspace previews. See `docs/security.md` before changing them.

### `packages/ui`

The React/Vite frontend.

Responsibilities:

- Login and password reset.
- Dashboard views.
- Chat and agent delegation UX.
- Workflow list and workflow builder.
- Workflow run dialogs.
- Execution timeline, node detail, logs, state, artifacts, checkpoints, and interventions.
- Workspace list/detail, terminal, file preview, service preview.
- Repo manager.
- Ticket and PR views.
- Settings for agents, MCP (including preset and repo-based registration with Python MCP support), integrations, and users.

## Data Model

MongoDB stores operational state for Allen. Collections are created and indexed by server startup code.

Key domains:

- Users and refresh tokens.
- Teams and agents.
- Workflow definitions and execution records.
- Execution logs and state.
- Repos and workspace metadata.
- Chat sessions and agent conversation state.
- Artifacts and uploaded files.
- Integration configuration.
- MCP server records and health state.
- Cron jobs and alerts.

## Workflow Lifecycle

1. User starts a workflow from the UI or another trigger.
2. Server creates an execution record in MongoDB.
3. Engine loads the workflow YAML and initial input.
4. Nodes run in order, with condition and parallel support.
5. Agent nodes spawn Claude Code CLI or SDK sessions.
6. Human nodes create interventions/checkpoints when input is required.
7. Node logs and state changes stream to the UI.
8. Outputs and artifacts are persisted.
9. Final status and summaries are visible in the execution detail page.

## Workspace Lifecycle

Allen workspaces are local worktrees under the workspace base directory.

Typical flow:

1. A repo is registered.
2. A workspace is created from a repo and branch.
3. Allen allocates a port block for workspace services.
4. Agents work inside the workspace path.
5. Terminal and file watch WebSockets attach to the workspace.
6. Preview proxy routes expose workspace services in the UI.
7. Stale PIDs are cleaned up on server boot.

Defaults:

- Workspace base: resolved by `WORKSPACE_BASE_DIR` or Allen's default home paths.
- Port blocks: start at `15000`, with 10 ports per workspace.
- Terminal WebSocket: `4024` (overridable via `TERMINAL_WS_PORT`).
- File watch: shares the terminal WebSocket on port `4024` at `/ws/workspaces/:id/watch`.

## Agent Execution

Allen supports Claude Code CLI and SDK execution.

Default behavior:

- Local repo/workspace context prefers CLI mode.
- Temporary or non-repo contexts can use SDK mode.
- `ALLEN_AGENT_EXECUTION_MODE=cli` or `sdk` forces a mode.
- `CLAUDE_BIN` can point to a specific Claude binary.
- `ALLEN_SYSTEM_PROMPT_MODE=append` preserves Claude Code scaffolding and appends Allen's role prompt.
- `ALLEN_SYSTEM_PROMPT_MODE=custom` fully replaces the system prompt where supported.

## Integrations

Allen has integration paths for:

- GitHub tokens and pull request workflows.
- Linear ticket dispatch.
- Slack thread/chat handling and human intervention notifications.
- MCP server presets and custom MCP servers.
- Cron-driven background tasks.

Integration credentials are read from `.env`. MCP servers use the `ALLEN_` prefix convention: an MCP-required key like `GITHUB_PERSONAL_ACCESS_TOKEN` is read from `ALLEN_GITHUB_PERSONAL_ACCESS_TOKEN` and forwarded to the MCP subprocess without the prefix. Both Node.js and Python MCP servers follow this model. Python MCPs require `python3` (or a custom interpreter) on `PATH`; their dependencies are not managed by Allen and must be installed separately by the user.

## Runtime Ports

Common local ports:

- `4000` - API server during normal `npm start`.
- `5173` - Vite UI.
- `4023` - e2e API default in Playwright helpers.
- `4024` - shared workspace terminal + file-watch WebSocket.
- `15000+` - workspace service ports.
- `27017` - local MongoDB.

## Test Layers

- `npm run build` - TypeScript and UI production build.
- `npm run lint` - TypeScript no-emit checks.
- `npm test` - Vitest suites across engine, server, and UI.
- `npm run test:e2e` - Playwright tests with real server/UI behavior.
