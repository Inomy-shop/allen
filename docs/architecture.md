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
- `src/mcp-loader.ts` and `src/mcp-install.ts` - MCP server loading, installation, and `ALLEN_`-prefix env mapping. Supports both Node.js (`.ts`/`.js`/`.mjs`) and Python (`.py`) entry files. Python MCPs get a per-MCP virtual environment at `<ALLEN_HOME>/venvs/<mcpId>/` with `requirements.txt` auto-installed on first spawn (`ensurePythonVenv`). Setting a manual **Command** override opts out of venv management; the user takes ownership of the interpreter.
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
- Expose first-run UI bootstrap for the first admin user.
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
- `/api/chat` - chat sessions and messages. Includes `POST /sessions/:id/automation-message` (JWT-guarded) for automation agents to append a message to a linked automation thread.
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
- `src/auth/jwt.ts` — JWT issuance and verification. `signAccessToken(payload, expiresIn?)` accepts an optional `expiresIn` override so callers can request short-lived tokens (e.g. `'5m'`) without bypassing the `ACCESS_TOKEN_TTL` default for normal user sessions.
- `src/middleware/requireAuth.ts` and `requireAdmin.ts` - route gating.
- `src/services/workspace.service.ts` - workspace lifecycle, port allocation, preview wiring.
- `src/services/workspace-terminal.ts` - shared terminal + file-watch WebSocket on port `4024`.
- `src/services/workspace-watcher.ts` - file watcher attached to the terminal WebSocket.
- `src/services/workspace-proxy.ts` - workspace preview proxy.
- `src/services/github-auth.ts` - GitHub token resolution from `.env`.
- `src/services/linear.service.ts` - Linear GraphQL client, TTL caches, agent/workflow dispatch, and issue fetching.
- `src/services/chat.service.ts` — `resolveMentions()` resolves `@ENG-123`-style tokens to Linear ticket context and `@name` tokens to workflow/repo/agent context before the LLM call. `ChatSession.source` accepts `'ui' | 'slack' | 'automation'`; automation sessions carry an `automationKey` field used as a deduplication key. `appendAutomationMessage(sessionId, role, content)` inserts a message into an automation thread without starting a live LLM session (content capped at 1 MB, `role:admin` rejected, throws `'Not an automation session'` if `session.source !== 'automation'`).
- `src/services/cron.service.ts` — Scheduler using `node-cron`. For agent-target jobs where `agentName === job.name`, `ensureLinkedSession()` upserts a persistent `chat_sessions` document keyed by `automationKey` (race-safe via `$setOnInsert` + E11000 fallback), then injects an `AUTOMATION_CONTEXT` block into the agent prompt (`LINKED_CHAT_SESSION_ID`, `AUTOMATION_API_TOKEN`, `AUTOMATION_MESSAGE_URL`) so the agent can POST its output back to the linked thread. The `AUTOMATION_API_TOKEN` is minted with a 5-minute TTL (via `signAccessToken(..., '5m')`) to avoid persisting a long-lived credential in the `chat_messages` collection. A stale-pointer recovery path re-links `cron_jobs.linkedChatSessionId` if the session was deleted and recreated.
- `src/services/cron-seed.service.ts` — Seeds built-in cron jobs. Includes the `daily-status-prep` job (schedule `30 9 * * 1-5`, `America/New_York`) that fires the `daily-status-prep` agent 30 minutes before the 10 AM ET daily call. `linkedChatSessionId` is intentionally excluded from `SEED_OVERRIDE` `$set` to preserve the persistent automation thread across restarts.
- `services/slack.service.ts`, `services/slack-notifier.ts` - Slack integrations.
- `src/routes/file.routes.ts` and `routes/artifact.routes.ts` - capability-URL public routes.

Public capability-style routes exist for generated file links, artifact links, execution SSE, workspace log SSE, and workspace previews. See `docs/security.md` before changing them.

### `packages/ui`

The React/Vite frontend.

Responsibilities:

- Login and password reset.
- Dashboard views.
- Chat and agent delegation UX, including `@mention` autocomplete for workflows, repos, agents, and Linear tickets.
- Workflow list and workflow builder.
- Workflow run dialogs.
- Paginated activity feed: server-side execution list (50 per page) with status filter, type filter (agent / workflow), and debounced text search. Page position is encoded in `?page=N` URL state and resets to 0 on filter or search changes. The page auto-refreshes every 5 s while running or queued executions are present.
- Execution timeline, node detail, logs, state, artifacts, checkpoints, and interventions.
- Workspace list/detail, terminal, file preview, service preview.
- Repo manager.
- Ticket and PR views.
- Settings for agents, MCP (including preset and repo-based registration with Python MCP support), integrations, and users.

Key activity page components:

- `src/pages/ExecutionListPage.tsx` - Activity page. Renders the paginated execution list. Exports the `paginationViewModel({ page, total, pageSize })` pure function that computes UI-state (`visible`, `pageCount`, `currentPageLabel`, `prevDisabled`, `nextDisabled`) with no DOM dependency so it can be tested in isolation.
The Dashboard shows an **Automations** panel (above in-flight work) that lists configured automation cron jobs. Each card renders the job's last-run status, next-run time, and a `View Report →` link to the linked automation chat thread (only shown once `linkedChatSessionId` is set). The `DailyStatusPrepCard` component (`DashboardPage.tsx`) displays a `glow-running` badge with an animated `Loader2` spinner while `runStatus === 'running'`.

Key chat UI components:

- `src/components/chat/ChatInput.tsx` - message composer with model/effort/plan/repo selectors, file attachments, and @mention detection.
- `src/components/chat/MentionAutocomplete.tsx` - autocomplete dropdown with two modes: **default** (workflows, repos, agents filtered by query) and **linear** (activated by `@linear`, shows the user's assigned active tickets with priority dots and state badges).
- `src/services/api.ts` `linear` object - typed wrappers for all `/api/linear/*` endpoints including the `assignee: 'me'` filter shorthand.

## Data Model

MongoDB stores operational state for Allen. Collections are created and indexed by server startup code.

Key domains:

- Users and refresh tokens.
- Teams and agents.
- Workflow definitions and execution records.
- Execution logs and state.
- Repos and workspace metadata.
- Chat sessions and agent conversation state. Automation sessions (`source: 'automation'`) carry a sparse-unique `automationKey` index on `chat_sessions` (one persistent thread per cron job). The linked session's `_id` is stored as `cron_jobs.linkedChatSessionId` and is never overwritten by seed updates.
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
- Linear ticket dispatch and chat @mention resolution.
- Slack thread/chat handling and human intervention notifications.
- MCP server presets and custom MCP servers.
- Cron-driven background tasks.

Integration credentials are read from `.env`. MCP servers use the `ALLEN_` prefix convention: an MCP-required key like `GITHUB_PERSONAL_ACCESS_TOKEN` is read from `ALLEN_GITHUB_PERSONAL_ACCESS_TOKEN` and forwarded to the MCP subprocess without the prefix. Both Node.js and Python MCP servers follow this model. Python MCPs require `python3` (or a custom bootstrap interpreter) on `PATH`; Allen creates an isolated venv per MCP at `<ALLEN_HOME>/venvs/<mcpId>/` and installs `requirements.txt` into it on first spawn. To update deps, click **Reinstall** in Settings → MCP Servers (wipes the venv) or delete and re-add the MCP. A manual **Command** override (e.g. pointing at an existing project venv) opts out of Allen-managed venv creation.

### Linear Integration

Requires `ALLEN_LINEAR_ACCESS_TOKEN` in `.env`. The `LinearService` (`packages/server/src/services/linear.service.ts`) wraps Linear's GraphQL API in read/write mode with short-lived TTL caches (status: 5 min, projects: 1 min, issues: 30 s) to stay within Linear's 4500 req/hr rate limit.

**API routes (`/api/linear`):**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/status` | Check whether Linear is configured and return workspace info. |
| `GET` | `/projects` | List all Linear projects. |
| `GET` | `/issues` | List issues with optional filters: `projectId`, `state` (comma-separated state types), `q` (full-text search), `limit`, `assignee=me`. |
| `GET` | `/issues/:id` | Fetch a single issue by Linear ID. |
| `PATCH` | `/issues/:id/assign-agent` | Store a local agent assignment for a ticket. Body: `{ agentName: string \| null }`. |
| `POST` | `/issues/:id/dispatch` | Create an isolated git worktree from a chosen repo, wait for it to become active, then spawn an agent with the ticket body as the prompt. Body: `{ agentName, repoId, extraInstructions?, promptTemplate? }`. Returns HTTP 202 with the initial `pending` assignment; the UI polls `/issues/:id` for progress. |
| `POST` | `/issues/:id/dispatch-workflow` | Start a registered workflow with the ticket's metadata injected into the input. Body: `{ workflowId, input }`. Returns HTTP 202 with the assignment. |

**`assignee=me` filter:** when `assignee=me` is passed, the route resolves it to the authenticated user's email from the JWT and forwards it as a Linear `assignee.email.eq` filter.

**Chat @mention resolution:** when a chat message contains a token matching `@[A-Z]+-\d+` (e.g. `@ENG-123`), `resolveMentions()` in `chat.service.ts` fetches the issue from Linear (up to 3 tickets per message, description capped at 800 chars) and injects a context block into the LLM conversation before any workflow/repo/agent mentions are resolved. If Linear is not configured or the identifier is not found, the token is silently skipped.

**Chat @mention autocomplete:** the `ChatInput` component detects when the user types `@linear` and switches `MentionAutocomplete` into linear mode. In linear mode the component fetches the authenticated user's assigned active tickets (`started,unstarted,backlog`, limit 25) via the `/api/linear/issues?assignee=me&state=…&limit=25` endpoint. Selecting a ticket inserts `@ENG-123` into the message text. Each row shows a priority dot, the identifier, the issue title, and a colour-coded state badge.

### Automation Agents

Cron jobs with `target.type === 'agent'` and `target.agentName === job.name` follow the **automation convention**. On every dispatch:

1. `CronService.ensureLinkedSession()` upserts a `chat_sessions` document with `source: 'automation'` and `automationKey: job.name`. The upsert is idempotent (MongoDB `$setOnInsert` + E11000 race fallback). The resulting session `_id` is written to `cron_jobs.linkedChatSessionId` (only on first creation or after stale-pointer recovery).
2. The cron service mints a **5-minute** admin JWT (`signAccessToken({ role: 'admin', ... }, '5m')`) for the `cron-system` principal and appends an `AUTOMATION_CONTEXT` block to the agent prompt. The short TTL ensures the token stored in `chat_messages` cannot be exploited after the agent finishes:

   ```text
   LINKED_CHAT_SESSION_ID: <sessionId>
   AUTOMATION_API_TOKEN: <token>
   AUTOMATION_MESSAGE_URL: http://localhost:<PORT>/api/chat/sessions/<sessionId>/automation-message
   ```

3. The agent uses `AUTOMATION_MESSAGE_URL` to `POST` its results back with `{ role: 'assistant', content: '...' }`. The endpoint validates the JWT via the global `requireAuth` middleware, applies an in-memory rate limit of 60 req/min per caller sub (→ 429), restricts `role` to `user` or `assistant` (→ 400), rejects requests targeting non-automation sessions (→ 403), enforces a 1 MB content cap (→ 400), and sanitises unexpected errors to `'Internal server error'` so internal details are not leaked.

The persistent linked chat thread accumulates every run's output in one scrollable session, visible from the Dashboard Automations card or directly at `/chat/<sessionId>`.

**Built-in automation jobs** (seeded by `cron-seed.service.ts`):

| Name | Schedule | Description |
|------|----------|-------------|
| `daily-status-prep` | `30 9 * * 1-5` ET | Weekday morning briefing 30 min before the 10 AM ET daily call. |

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
