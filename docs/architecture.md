# Architecture

Allen is a TypeScript monorepo that coordinates AI agents across software engineering workflows. The system combines a React UI, an Express API, a workflow engine, MongoDB persistence, local workspaces, and integrations such as GitHub, Linear, Slack, MCP servers, Claude Code, and Codex.

## System overview

```text
React UI / Desktop shell
  |
  | HTTP, SSE, WebSocket
  v
Express Server ---------------- MongoDB
  |                               |
  | starts workflows              | users, teams, agents, repos,
  | manages workspaces            | workflows, executions, chats,
  | exposes integrations          | artifacts, learnings, settings
  v
Workflow Engine
  |
  | runs workflow nodes and agents
  v
Agent providers + MCP tools ---- Local repos and workspaces
```

## Main packages

| Package | Role | More detail |
| --- | --- | --- |
| `packages/engine` | Workflow runtime, agent invocation, workflow validation, artifacts, traces, and execution state. | [Engine module](modules/engine.md) |
| `packages/server` | API, MongoDB persistence, auth, repo/workspace management, integrations, scheduled jobs, and workflow/agent dispatch. | [Server module](modules/server.md) |
| `packages/ui` | React interface for chat, executions, workflows, workspaces, repos, agents, teams, tickets, PRs, settings, and design flows. | [UI module](modules/ui.md) |
| `packages/desktop` | Electron host that runs the shared Allen UI and backend as a local desktop app. | [Desktop module](modules/desktop.md) |
| `e2e` | Playwright tests for full-product flows. | [E2E module](modules/e2e.md) |

## Core runtime flow

```text
1. A user starts from chat, a workflow run dialog, a ticket, or automation.
2. The server records the request and chooses an agent or workflow route.
3. The engine executes the workflow graph or agent run.
4. Agents inspect context, call approved tools, create artifacts, and ask for help when needed.
5. Human checkpoints pause risky or ambiguous work.
6. The UI streams logs, traces, state, artifacts, and final output.
```

## Workspaces

Workspaces give agent work a dedicated repo worktree, terminal, file watcher, and preview proxy. They make repository changes easier to observe and review before merge.

See [Workspaces](concepts/workspaces.md) and [Security and sandboxing](security.md).

## Agents, teams, skills, and workflows

Allen models work as an organization:

- [Teams](concepts/teams.md) group agents by responsibility.
- [Agents](concepts/agents.md) perform or coordinate work.
- [Skills](concepts/skills.md) guide routing and operating decisions.
- [Workflows](concepts/workflows.md) provide repeatable multi-step execution paths.

This separation keeps the product understandable: teams describe ownership, agents do work, skills help choose a route, and workflows make multi-step processes repeatable.

## Data and observability

Allen persists product and execution state in MongoDB. Important records include users, teams, agents, repositories, workspaces, chat sessions, workflows, executions, execution traces, interventions, artifacts, uploaded files, settings, and learnings.

Execution observability is a first-class product surface. Users should be able to see what ran, which agent or workflow produced output, what artifacts were saved, what checkpoints were reached, and what changed in the workspace.

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
- `src/services/soft-delete.ts` — Shared interface (`SoftDeleteFields`), helpers (`softDeleteSet`, `restoreSet`), and the `notDeletedFilter` constant used by route handlers and services to exclude soft-deleted records from queries. Applied across agents, workflows, teams, and skills.
- `src/services/chat-tools.ts` — Implements all 16+ MCP tool handlers (`spawn_agent`, `wait_for_execution`, `resume_execution`, `allen_save_artifact`, etc.). `resume_execution` resolves the resumed agent's LLM session ID through a three-layer fallback: (1) `executions.sessions[agentName]`, (2) `output.session_id` from the latest `execution_traces` document (sorted `{ completedAt: -1, createdAt: -1 }`), (3) `exec.input.session_id`. When a session ID is found via layer 2 or 3, it is written back to the sessions map before the spawn so future resumes use the fast primary path. Chat-started workflow executions (`source === 'chat'` with a truthy `workflowId`) are routed to the checkpoint-based workflow-resume path rather than the agent-resume path. `spawn_agent` captures provider token usage from Codex `turn.completed` events and Claude SDK `result` messages, aggregates across turns using `aggregateTokenUsage`, and persists the normalized `TokenUsageInfo` onto the execution row.
- `src/services/chat.service.ts` — `resolveMentions()` resolves `@ENG-123`-style tokens to Linear ticket context and `@name` tokens to workflow/repo/agent context before the LLM call. `ChatSession.source` accepts `'ui' | 'slack' | 'automation'`; automation sessions carry an `automationKey` field used as a deduplication key. `appendAutomationMessage(sessionId, role, content)` inserts a message into an automation thread without starting a live LLM session (content capped at 1 MB, `role:admin` rejected, throws `'Not an automation session'` if `session.source !== 'automation'`).
- `src/services/cron.service.ts` — Scheduler using `node-cron`. For agent-target jobs where `agentName === job.name`, `ensureLinkedSession()` upserts a persistent `chat_sessions` document keyed by `automationKey` (race-safe via `$setOnInsert` + E11000 fallback), then injects an `AUTOMATION_CONTEXT` block into the agent prompt (`LINKED_CHAT_SESSION_ID`, `AUTOMATION_API_TOKEN`, `AUTOMATION_MESSAGE_URL`) so the agent can POST its output back to the linked thread. The `AUTOMATION_API_TOKEN` is minted with a 5-minute TTL (via `signAccessToken(..., '5m')`) to avoid persisting a long-lived credential in the `chat_messages` collection. A stale-pointer recovery path re-links `cron_jobs.linkedChatSessionId` if the session was deleted and recreated.
- `src/services/cron-seed.service.ts` — Seeds built-in cron jobs covering repo scans/pulls, PR sync, MCP bundle cleanup, CodeRabbit PR-comment sweeps, and the hourly self-healing monitor. When `SEED_OVERRIDE` is set, display fields and schedules are refreshed on existing rows, but `linkedChatSessionId` is intentionally excluded from the `$set` so any persistent automation chat thread survives restarts.
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
- Execution timeline, node detail, logs, state, artifacts, checkpoints, interventions, and token usage breakdown (cached input, non-cached input, output tokens — omitted when data is unavailable).
- Workspace list/detail, terminal, file preview, service preview. Clicking a workspace in the sidebar opens `ChatPage` in workspace mode (`/chat?workspaceId=…`) rather than the workspace IDE page, giving a browser-style chat tab strip scoped to that workspace.
- Repo manager.
- Ticket and PR views.
- **Design tab** (`/design`, `/design/:designSessionId`): design-session list, active conversation, composer, routing selector, design/source repo selectors, run-progress panel, artifact list, and optional preview panel. When no design repo is configured, shows a setup panel with options to onboard an existing repo or bootstrap a `ui-designs` template.
- Settings for agents, MCP (including preset and repo-based registration with Python MCP support), integrations, and users.

Key activity page components:

- `src/pages/ExecutionListPage.tsx` - Activity page. Renders the paginated execution list. Exports the `paginationViewModel({ page, total, pageSize })` pure function that computes UI-state (`visible`, `pageCount`, `currentPageLabel`, `prevDisabled`, `nextDisabled`) with no DOM dependency so it can be tested in isolation. A **Source** filter chip group (`All | Chat | Workflow | Design`) filters on `executions.meta.sourceSurface`; design-tab runs carry `sourceSurface='design_tab'`.
- `src/pages/DesignPage.tsx` - Design tab entry point routed at `/design` and `/design/:designSessionId`. Hosts the session list, active conversation, composer, run panel, and routing selector. Renders `DesignSetupPanel` when no design repo is configured.

Key design UI components:

- `src/components/design/DesignSetupPanel.tsx` - empty-state panel with "Onboard existing design/prototyping repo" and "Create from ui-designs template" actions.
- `src/components/design/DesignConversationList.tsx` - left rail listing the user's design sessions.
- `src/components/design/DesignComposer.tsx` - input box and Run button; sends to `POST /api/design/sessions/:id/run`.
- `src/components/design/DesignRoutingSelector.tsx` - shows resolved mode, runner, and reason with a `Change ▾` override menu (`auto | full_workflow | fast_frontend | design_refinement | design_review`). Displays the workflow as `Full design workflow` in the UI without changing the internal name.
- `src/components/design/DesignRepoSelector.tsx` - design repo (required, defaults to `isDefaultDesignRepo`) and source repo (optional) selectors.
- `src/components/design/DesignPreviewConfigForm.tsx` - preview config form; validates working directory, startCommand, portMode, and fixedPort; calls `PUT /preview-config` then optionally `POST /preview-config/test`.
- `src/components/design/DesignRunPanel.tsx` - streams the active run via the existing execution SSE, shows artifacts, and surfaces retry/error options.
- `src/services/designService.ts` - thin `request<T>` wrappers around `/api/design/*`.

Key chat UI components:

- `src/components/chat/ChatInput.tsx` - message composer with model/effort/plan/repo selectors, file attachments, and @mention detection.
- `src/components/chat/MentionAutocomplete.tsx` - autocomplete dropdown with two modes: **default** (workflows, repos, agents filtered by query) and **linear** (activated by `@linear`, shows the user's assigned active tickets with priority dots and state badges).
- `src/components/chat/WorkspaceChatContextBar.tsx` - context bar rendered in workspace-mode chat. Shows workspace name, repo, branch, baseBranch, and worktree path; quick-action button (Open workspace); archived-workspace banner when `status === 'archived'`; hidden in non-workspace chat.
- `src/components/chat/WorkspaceChatTabs.tsx` - horizontal browser-style tab strip for workspace-linked chats. Supports open/close/restore tabs, `+ New Chat` button, and a **Previous chats ▾** dropdown (recent-first, capped at 50 items). Tab labels truncate with a tooltip showing the full title; a streaming indicator appears on live tabs. Close confirmation is shown when the target tab is streaming.
- `src/services/api.ts` `linear` object - typed wrappers for all `/api/linear/*` endpoints including the `assignee: 'me'` filter shorthand.

## The Seeded Org

On startup `packages/server/src/services/org-seed.ts` idempotently seeds the agent organization into the `teams` and `agents` MongoDB collections — this is the agent set Allen runs in production. `packages/engine/agents.yml` holds the engine's built-in default agents, used for development and when the database has not been seeded.

Six teams (lead → parent):

| Team | Lead | Parent | Notable members |
|---|---|---|---|
| `executive` | `ceo` | — | the CEO orchestrator |
| `product` | `product-manager` | executive | `requirements-analyst`, `acceptance-tester`, `brainstormer` |
| `engineering` | `engineering-lead` | executive | `backend-developer`, `frontend-developer`, `devops-engineer`, `pr-creator`, `code-reviewer`, `security-specialist`, `documentation-writer`, `codebase-navigator` |
| `quality` | `qa-lead` | executive | `test-planner`, `test-writer` |
| `meta` | `team-builder-agent` | — | `agent-builder-agent`, `workflow-builder-agent`, `research-agent`, `planner-agent`, `repo-scanner` |
| `unassigned` | `unassigned-coordinator` | executive | holding area for imported/created agents |

Agent categories:

- **Team leads / orchestrators** — no filesystem access; plan and delegate (`ceo`, `product-manager`, `engineering-lead`, `qa-lead`, `team-builder-agent`, `unassigned-coordinator`).
- **Specialist / technical agents** — filesystem + terminal; do the hands-on work (developers, reviewer, security, docs, navigator, testers, analysts, plus supporting agents like `bug-investigator`, `solution-architect`, `technical-designer`, `implementation-validator`, `pr-review-bot`, `pr-workspace-resolver`).
- **Automation / monitoring agents** — Allen-internal self-healing: `allen-monitoring-agent`, `allen-incident-router`, `allen-memory-diagnostician`, `allen-tooling-diagnostician`, `allen-workflow-diagnostician`, `allen-prompt-instruction-diagnostician`.

Re-seeding is idempotent. Set `SEED_OVERRIDE=true` to refresh existing seeded rows from code on next boot. Seed logic respects soft deletion: if a built-in agent or workflow has been soft-deleted by a user, it is skipped on normal startup (no duplicate re-insertion). Under `SEED_OVERRIDE`, a soft-deleted built-in is restored with current seed data.

## Data Model

MongoDB stores all operational state. Collections are created and indexed by server startup code (`packages/server/src/database/indexes.ts`). The main collections:

- **Auth** — `users`, `refresh_tokens` (TTL auto-purge), `bootstrap_locks` (first-admin race guard).
- **Org** — `teams`, `agents`, `skills`. All four org-collection types (including `workflows`) support **soft delete**: deleted records have `isDeleted=true` and are hidden from all lists, detail endpoints, MCP tools, pickers, and org context. Deleting sets `isDeleted=true`, `deletedAt`, and optionally `deletedBy`. Recovery in v1 is restore-by-create: creating a resource with the same `name` as a soft-deleted record restores it (clears deletion fields, sets `restoredAt`). The shared helpers live in `packages/server/src/services/soft-delete.ts`. Built-in delete protections still apply; team deletion is refused if the team has active members.
- **Workflows & executions** — `workflows`, `executions`, `execution_traces`, `execution_logs`, `execution_failure_reports`, `checkpoints`. Both `executions` and `execution_traces` rows carry an optional `tokenUsage: { inputCachedTokens, inputNonCachedTokens, outputTokens }` field (each sub-field is `number | null`) that is populated when the provider reports usage data. Old rows without this field render and behave normally.
- **Chat** — `chat_sessions` (automation sessions carry a sparse-unique `automationKey`; the linked `_id` is stored as `cron_jobs.linkedChatSessionId` and never overwritten by seed updates; workspace-linked sessions carry `workspaceId` plus snapshot fields `workspaceName`, `workspaceRepoId`, `workspaceRepoName`, `workspaceBranch`, `workspaceBaseBranch`, `workspacePrNumber`, `workspacePrUrl` written by `WorkspaceManager.linkChat`), `chat_messages`, `agent_conversations` (delegation threads), `agent_activity` (7-day TTL).
- **Docs & checkpoints** — `design_docs` (PRD/HLD/TDD), `workflow_interventions`.
- **Design tab** — `design_sessions` (`kind='design'`, `sourceSurface='design_tab'`; carries `designRepoId`, optional `sourceRepoId`/`workspaceId`, `status`, `routingDecision`, `lastExecutionId`, `hasExistingOutputs`, and `outputMode`), `design_messages` (per-session messages with optional `routingDecision`, `executionId`, `agentRunId`, and `artifacts`). Design sessions are separate from `chat_sessions` so normal chat history excludes design conversations by default.
- **Repos & workspaces** — `repos` (carries `detected.defaultBranch`, `defaultBranch`, and `branch` — the four-step resolution chain is `detected.defaultBranch → defaultBranch → branch → 'main'`; extended with optional `roles: RepoRole[]`, `isDefaultDesignRepo?: boolean`, and `designPreviewConfig?: DesignPreviewConfig` for design-tab support), `repo_contexts`, `pull_requests`, `workspaces`, `workspace_configs`.
- **MCP & secrets** — `mcp_servers`, `secrets`.
- **Scheduling & alerts** — `cron_jobs`, `cron_runs` (90-day TTL), `alerts`.
- **Learning** — `learnings`, `memory_injection_audits`.
- **Self-healing** — `monitoring_incidents` (unique `fingerprint`), `monitoring_scan_state`, `monitoring_events`, `monitoring_evidence_bundles`.
- **Slack** — `slack_thread_mappings`, `slack_processed_events` (24h TTL idempotency).

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

**Workspace-linked chat.** Clicking a workspace in the sidebar navigates to `/chat?workspaceId=<id>`. `ChatPage` bootstraps in workspace mode: it fetches the workspace document and its linked chat sessions, opens them as a browser-style tab strip (recent-first), and selects the most recently active tab. If no chats exist, a `New chat` temp tab is created. Sending the first message from a temp tab calls `POST /api/chat/sessions` with `workspaceId`, which links the new session and snapshots workspace metadata in one round-trip. The session's `workspaceId` is used by the agent cwd resolver so all agents in that chat run with `cwd = workspace.worktreePath`. Navigating to a `/chat/:sessionId` URL whose session has a `workspaceId` also bootstraps workspace mode and forces that session active, enabling Dashboard-driven resumption.

Defaults:

- Workspace base: resolved by `WORKSPACE_BASE_DIR` or Allen's default home paths.
- Port blocks: start at `15000`, with 10 ports per workspace.
- Terminal WebSocket: `4024` (overridable via `TERMINAL_WS_PORT`).
- File watch: shares the terminal WebSocket on port `4024` at `/ws/workspaces/:id/watch`.

## Agent Execution

Allen supports Claude Code CLI and SDK execution.

Default behavior:

- Claude-provider execution uses CLI mode by default.
- `ALLEN_AGENT_EXECUTION_MODE=cli` keeps the default explicit.
- `ALLEN_AGENT_EXECUTION_MODE=sdk` forces the in-process SDK path.
- `CLAUDE_BIN` can point to a specific Claude binary.
- `ALLEN_SYSTEM_PROMPT_MODE=append` preserves Claude Code scaffolding and appends Allen's role prompt.
- `ALLEN_SYSTEM_PROMPT_MODE=custom` fully replaces the system prompt where supported.

## Integrations

Allen integrates with external systems through server-managed configuration and tool access. Common integrations include:

- GitHub for pull requests and repo-related workflows.
- Linear for ticket browsing and dispatch.
- Slack for thread-based interaction.
- MCP servers for custom tools and data sources.
- Claude Code and Codex for agent execution.

See [Integrations](concepts/integrations.md).

## Security posture

Allen is developer infrastructure with repository and tool access. Treat workflow YAML, agent definitions, credentials, artifacts, MCP servers, and workspace execution as security-sensitive.

Start with [Security and sandboxing](security.md) before changing auth, workspaces, public links, MCP handling, agent execution, or integration credentials.

## Where to contribute

- Setup and operations docs: `README.md`, `docs/`, `scripts/`.
- Workflow changes: `packages/engine/workflows/` and related engine tests.
- Agent organization changes: server org seeding and engine defaults.
- API or persistence changes: `packages/server/src/`.
- Product UI changes: `packages/ui/src/`.
- Desktop runtime changes: `packages/desktop/src/`.
- End-to-end behavior: `e2e/`.

For public docs, follow the [Documentation guidelines](documentation-guidelines.md).
