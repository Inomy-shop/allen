# Changelog

This file tracks notable Allen changes.

Allen is currently pre-release, so behavior can change between commits. Versioned release notes will start when public tags are created.

## [Unreleased]

### Added

- **Workspace-linked chat** (`packages/ui`, `packages/server`): clicking a workspace in the sidebar now opens `ChatPage` in workspace mode (`/chat?workspaceId=…`) instead of the workspace IDE page.
  - `ChatPage` bootstraps a browser-style tab strip of the workspace's linked chat sessions (recent-first). Selecting a tab navigates to `/chat/<sessionId>`; the workspace context bar and tabs are preserved.
  - New `WorkspaceChatContextBar` component — shows workspace name, repo, branch, and worktree path with a quick-action button (Open workspace); renders an archived-workspace banner when the workspace is no longer active.
  - New `WorkspaceChatTabs` component — horizontal tab strip with `+ New Chat`, close (`x`), and a **Previous chats ▾** restore dropdown (recent-first, capped at 50 items). Close is confirmed when the target tab is streaming. Tab labels truncate with a full-title tooltip.
  - `POST /api/chat/sessions` now accepts an optional `workspaceId` body field. When supplied, the server atomically calls `WorkspaceManager.linkChat` and returns the session with workspace metadata already populated — replacing the previous two-call round-trip.
  - `WorkspaceManager.linkChat` snapshots workspace fields (`workspaceName`, `workspaceRepoId`, `workspaceRepoName`, `workspaceBranch`, `workspaceBaseBranch`, `workspacePrNumber`, `workspacePrUrl`) onto the `chat_sessions` document when linking a chat session.
  - New MongoDB indexes: `workspaces.{ chatSessionId: 1 }` (agent cwd resolution), `chat_sessions.{ workspaceId: 1, lastMessageAt: -1 }` (tab ordering and previous-chat dropdown).
  - Navigating directly to `/chat/<sessionId>` where the session has a `workspaceId` also bootstraps workspace mode, enabling Dashboard-driven resumption with the correct tab active.
  - Sidebar `activeWorkspaceId` now matches `/chat?workspaceId=…` and `/chat/:sessionId` (when the session is workspace-linked) in addition to the existing `/workspaces/:id` path.
  - Tab titles update live when the server generates or renames the chat title (`titleSource` transitions from `default` → `auto`/`user`). Tab state is persisted best-effort in `localStorage` keyed by workspace ID.

## [0.1.6] - 2026-06-08

Highlights since `v0.1.3`.

### Added

- **Context quality judge, review & remediation pipeline**: a full context-engine subsystem behind the `context-engine` flag — a context judge with reliability calibration, a finding/review service with human-review gates, and a remediation service that can dispatch `code_change_pr` work. Ships 12 REST routes under `/api/context/quality` and a new Context Review UI.
- **New providers — DeepSeek, Xiaomi MiMo, and Kimi**: three new first-class chat/agent providers alongside `codex` and `claude-cli`. They reuse the Claude Code binary via a per-spawn env overlay that never mutates `process.env`, with free-text model input and provider status cards in onboarding/settings.
- **Visual workflow builder — full authoring**: the visual editor can now author edge control-flow (conditions, parallel fan-out + join/merge, retry loops) and condition-node branches entirely in-app instead of requiring YAML, with a new in-app guide.
- **Bulk agent model migration**: migrate many agents to a new model in one action.
- **Workspace server runner**: a server-runner tab in the workspace view.

### Changed

- **In-place integration connect**: Linear/GitHub MCP connect modals now open directly from the Tickets, Pull Requests, and Dashboard pages and refresh on success, instead of routing to `/settings/mcp`.
- **PR Creator git identity**: the PR Creator now derives its git identity dynamically from `gh api user` instead of the hardcoded `allen@local` / `Allen Agent`.
- **Settings & workspace UI refinements**: refined repository/model settings, workspace sidebar states, and chat metrics layout.

## [0.1.0] - 2026-05-21

First public alpha release.

### Fixed

- **`resume_execution` — agent session continuity** (`packages/server/src/services/chat-tools.ts`): `resumeAgentExecution` now walks a three-layer fallback chain when resolving the LLM session ID: (1) `executions.sessions[agentName]` (primary, no extra query), (2) `output.session_id` from the latest `execution_traces` row (sorted `{ completedAt: -1, createdAt: -1 }`), (3) `exec.input.session_id`. When the ID is found via layers 2 or 3, it is written back to the sessions map (`$set`) before spawning the resumed process so future resumes use the fast primary path. Agents that were killed before their SDK session marker was written now resume into the same conversation instead of starting cold.
- **`resume_execution` — workflow routing guard** (`packages/server/src/services/chat-tools.ts`): the `isAgentExecution` check now correctly excludes chat-started workflow executions (`source === 'chat'` with a truthy `workflowId`). Previously any execution with `source === 'chat'` was routed into the agent-resume path; it now reaches the checkpoint-based workflow-resume path as intended. Pure agent spawns from chat (`source === 'chat'`, no `workflowId`) continue to use the agent-resume path unchanged.

### Added

- Activity page (`ExecutionListPage`) now paginates the execution list server-side: 50 executions per page, `?page=N` URL state, Previous / Next controls with a "Page X of Y" label. Controls are hidden when the total count fits on one page.
- `paginationViewModel()` pure function (exported from `ExecutionListPage.tsx`) computes `{ visible, pageCount, currentPageLabel, prevDisabled, nextDisabled }` from `{ page, total, pageSize }` with no DOM dependency, enabling isolated unit tests.
- **Automation agent infrastructure** — cron jobs with `target.agentName === job.name` now get a persistent linked chat session (one `chat_sessions` document per job, keyed by a sparse-unique `automationKey` index). On each dispatch, `CronService.ensureLinkedSession()` upserts the session race-safely and injects `AUTOMATION_CONTEXT` (session ID, 5-min JWT token, message URL) into the agent prompt so it can POST results back via the new `POST /api/chat/sessions/:id/automation-message` endpoint. `cron_jobs.linkedChatSessionId` is persisted on first creation and excluded from `SEED_OVERRIDE` updates. `signAccessToken` extended with an optional `expiresIn` override so automation tokens (`'5m'`) do not leak a long-lived credential into the `chat_messages` collection.

- `scripts/setup.sh` (run directly as `./scripts/setup.sh`) that installs Node 22 via nvm when Node is missing or older than 22; verifies npm 10+ and git; installs MongoDB 7 (Homebrew on macOS) and ensures it is reachable; installs the standalone Claude Code CLI via the official installer (verifying `--agent` support) and the Codex CLI via npm when missing; runs `npm install`; creates `.env` with freshly generated JWT secrets and an auto-pinned `CLAUDE_BIN`; and finishes with `npm run health`.
- `npm start` as the canonical command to run the full Allen stack locally.
- Documentation for the two repo registration flows (local path and clone-via-SSH), the Linear ticket dispatch flow, and the workflow creation paths (visual builder vs. seed YAML).
- Troubleshooting entry for "Codex CLI Not Found".
- `ALLEN_DEFAULT_CHAT_PROVIDER` env var (`codex` | `claude-cli`) controls the default chat provider for new sessions and reorders the UI provider picker so the configured default is selected on first load. Falls back to `codex` when unset or unrecognized.
- GitHub Actions CI for Allen's current build, lint, and Vitest checks.
- Dependabot configuration for npm and GitHub Actions.
- Allen-specific issue templates for workflow, workspace, agent, integration, UI, and test failures.
- Allen-specific PR template with validation and safety checks for agentic code execution.
- CODEOWNERS coverage for workflow engine, agent execution, auth, integrations, workspace execution, and repository policy files.
- Security policy focused on auth, workspaces, terminal execution, artifacts, MCP, and integrations.
- Support guide, roadmap, and code of conduct tailored to Allen's product surface.

### Changed

- Replaced the prior Docker-Compose-based MongoDB workflow with a locally-installed MongoDB 7 (auto-installed on macOS by the setup script).
- Documentation updated to use `./scripts/setup.sh` then `npm run build` + `npm start` instead of manual `npm install` + `docker compose up` + `npm run dev`.
- `.env.example` reorganized into a required block (server, MongoDB URI, JWT signing keys) and clearly labelled optional blocks for agent execution knobs and GitHub / Linear / Slack / MCP integration credentials. The first admin is created from the UI onboarding screen on first launch.
- Documentation simplified to source all integration credentials from `.env`; references to the encrypted Allen Secrets store and `ALLEN_MASTER_KEY` removed.

### Removed

- `docker-compose.yml`. Allen now runs against a local MongoDB; container images for the server and UI are not yet supported.
- Encrypted Allen Secrets store: `packages/server/src/services/secret.service.ts`, `services/encryption.ts`, `routes/secret.routes.ts`, the `/api/secrets` HTTP route, the legacy `@secret:KEY` MCP env resolution path, and `ALLEN_MASTER_KEY`. All integration credentials are now read directly from `.env` via `process.env`. (A vestigial `secrets` collection index in `database/indexes.ts` is no longer read or written by any code path.)
- `daily-status-prep` built-in agent, its seeded cron job (`30 9 * * 1-5` ET), and the Dashboard "Automations" panel that rendered its run status. The agent's prompt was specific to one organization (referenced an internal Slack channel by ID); the underlying automation-agent infrastructure (linked chat sessions, `AUTOMATION_CONTEXT` injection, `appendAutomationMessage` endpoint) remains so users can author their own automation agents and cron jobs.
