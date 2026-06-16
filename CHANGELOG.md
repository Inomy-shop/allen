# Changelog

This file tracks notable Allen changes.

Allen is currently pre-release, so behavior can change between commits. Versioned release notes will start when public tags are created.

## [Unreleased]

## [0.1.12] - 2026-06-16

### Fixed

- **Execution page dark-mode borders** (`packages/ui`): the source-filter and run-status-card dividers used opacity modifiers on the hand-written `border-app` utility (`border-app/50`, `border-app/70`), which produced invalid classes and fell back to `currentColor` — rendering a bright white line in dark mode. Both now use the valid `border-app` utility.
- **Server boot recovery from an index spec conflict** (`packages/server`): the server now recovers on boot when `idx_setup_active_per_repo` already exists with a different `partialFilterExpression` from a prior version, instead of failing to start.

## [0.1.11] - 2026-06-16

Highlights since `v0.1.10`.

### Added

- **Deterministic Execution Watcher** (`packages/server`, `packages/ui`): automatically monitors chat-started workflow and agent executions, replaces polling chat messages with a single live status line per execution, and triggers the correct Assistant when the execution completes, fails, is cancelled, or waits for input.
  - **New service** (`packages/server/src/services/watcher.service.ts`): `WatcherService` with auto-registration on execution start/resume, log-driven status generation (factual templates + milestone vocabulary lookup against `execution_logs`), polling sweep driven by per-watcher `nextPollAt` (staggered intervals: 1 min ≤10 min, 5 min ≤60 min, 10 min >60 min), hidden trigger coordination, and boot-time reconciliation for server restart recovery.
  - **New API** (`packages/server/src/routes/watcher.routes.ts`): `GET /api/execution-watchers?chatSessionId=X` (list active watchers for a chat session), `GET /api/execution-watchers/:executionId` (single watcher). `POST /api/chat/sessions/:id/watcher-trigger` added in chat routes for hidden trigger injection.
  - **New UI component** (`packages/ui/src/components/chat/WatcherStatusLines.tsx`): non-clickable per-execution status lines with state icons, factual text, and "Last checked X ago" label. Lines are replaced in-place via SSE `watcher_update` events (updateSeq-based dedup).
  - **Chat message filtering**: hidden watcher-trigger messages (`hidden: true`) are filtered from the visible chat message list and from `ChatService.getSession()` / `getMessages()` responses.
  - **Registration hooks**: auto-registration on `run_workflow` and `spawn_agent` MCP tool calls (from `chat-tools.ts`), on execution start (from `ExecutionService.start()`), and on each resume path (agent resume, engine resume, checkpoint resume). Boot reconciliation in `server.ts` `runBootTasks()`. SSE `watcher_update` events via `stream.service.ts` `broadcastWatcherUpdate()`.
  - **New DB collection**: `execution_watchers` with indexes on `watcherId` (unique), `executionId` (unique), `chatSessionId+watcherStatus`, `watcherStatus+nextPollAt`, `watcherStatus+lastPolledAt`, and `updatedAt`.
  - **Covers**: PRD AC1–AC11, R1–R16.

- **Auto-update popup with release notes and download progress** (`packages/desktop`, `packages/ui`): replaced the previous `electron-updater` silent download with a custom production-update flow.
  - **Custom update checker** (`packages/desktop/src/main.ts`): fetches a JSON feed from `ALLEN_UPDATE_FEED_URL`, compares versions, and prompts the user via a new IPC channel instead of downloading silently in the background.
  - **Update prompts/flow** (`packages/desktop/src/main.ts`): the app sends an `allen:update-prompt` event to the renderer; the renderer responds with `update-now` or `update-later`. On "Update now", the app downloads the DMG, opens it, and quits Allen automatically for macOS drag-and-drop installation.
  - **Release notes** (`packages/desktop/src/main.ts`): fetches a release notes index from `ALLEN_RELEASE_NOTES_FEED_URL`, caches it locally, and serves individual release notes by version. Degrades gracefully to cached data when offline.
  - **UI modal** (`packages/ui/src/App.tsx`): new `UpdatePromptModal` component that shows current/latest version, release notes area, and buttons. Hooks into `allen:update-prompt` IPC events.
  - **IPC bridge** (`packages/desktop/src/preload.ts`, `preload.cjs`, `packages/ui/src/desktop.d.ts`): new contract for `getUpdateSettings`, `setAutoUpdateEnabled`, `checkForUpdates`, `getReleaseNotes`, `getReleaseNote`, `onUpdatePrompt`, `respondToUpdatePrompt`, and `openWorkspaceIde`.
  - **URL policy** (`packages/desktop/src/url-policy.ts`): extracted external URL validation into a standalone testable module with loopback hostname detection.
  - **Settings integration** (`packages/ui/src/pages/SettingsPage.tsx`): manual "Check for updates" now routes through the new IPC channels, with consistent auto-update toggle.
  - **Covers**: REQ-001–007, AC-001–008.

- **Context portability — import/export for curated and mandatory context** (`packages/server`, `packages/ui`): selectively export a repo's active curated entries and enabled mandatory mappings as a checksum-verified JSON package, and re-import them into another Allen instance with clash handling. New routes under `packages/server/src/routes/repo.routes.ts` and a portability module with deterministic SHA-256 package checksums.

- **Scoped "select all" for agents** (`packages/ui`): a scoped select-all control in the agent manager (`RoleManagerPage`) so bulk actions apply to the currently filtered/visible set.

### Changed

- **Direct file edits from the top-level Assistant when explicitly requested** (`packages/server`): the top-level Assistant may now make direct file edits when the user clearly and explicitly asks (e.g. "edit files directly"). Commits, pushes, and PR operations remain agent-routed unless separately and explicitly requested. Updates both the seed prompt and the live chat system prompt.
- **Terminal tabs**: clicking the terminal icon in workspace-linked chat now opens a new terminal tab with its own backend PTY session (unique terminal ID) instead of reusing a single shared tab.

### Fixed

- **Database index definitions** corrected for the repo context setup pipeline.

## [0.1.10] - 2026-06-13

Highlights since `v0.1.9`.

### Added

- **Change default branch in repository management** (`packages/server`, `packages/ui`): users can now change a registered repository's default branch from the repo edit dialog.
  - **New endpoint** (`PUT /api/repos/:id/default-branch`): fetches remote refs via `git fetch --prune origin`, validates the requested branch exists as `origin/<branch>`, switches the checkout via `git switch -C <branch> origin/<branch>`, and persists the new branch in `detected.defaultBranch` and `defaultBranch`. Local-only branches are rejected with a clear error. Compatible uncommitted changes are carried by Git without stashing; conflicting changes block the update and the error is surfaced.
  - **New service method** (`RepoService.updateDefaultBranch`): orchestrates the full sequence (fetch → verify → switch → persist) as a single atomic operation. Does not run `git reset`, `git clean`, `git stash`, or branch deletion.
  - **UI update** (repo edit dialog): new **Default branch** text field initialized from the four-step chain (`detected.defaultBranch → defaultBranch → branch → 'main'`). Saving a changed branch calls the new endpoint before updating other metadata.
  - **Workspace resolution**: the `workspaceCreateBaseBranch()` utility reads `detected.defaultBranch` first, so future workspaces automatically use the updated branch. Existing workspaces are not modified.
  - **Covers**: PRD AC1–AC11.

- **Model Registry — User-driven model configuration** (`packages/server`, `packages/engine`, `packages/ui`): replaces every hardcoded LLM model list with a MongoDB-backed `model_registry` collection managed through Settings → Models (admin-only tab). Key changes:
  - **New service** (`packages/server/src/services/model-registry.service.ts`): `ModelRegistryService` with full CRUD (`list`, `getById`, `create`, `update`, `softDelete`) plus `syncSeedModels()` that seeds/refreshes the catalog on every boot (inserts missing models, updates prices of rows admins never customized via `seededWith` snapshots, preserves admin edits). Provider validation uses the existing `CLAUDE_COMPATIBLE_PROVIDER_CONFIGS` set; `(provider, alias)` has a compound unique index. Soft-delete sets `isActive=false`; reactivation via PATCH.
  - **REST API** (`packages/server/src/routes/system.routes.ts`): `GET /api/system/models` (public, supports `?includeInactive` and `?provider` filters), `GET /api/system/models/:id` (public), `POST /api/system/models` (admin, validated, 409 on duplicate), `PATCH /api/system/models/:id` (admin, provider/alias immutable), `DELETE /api/system/models/:id` (admin, soft-delete). Desktop runtime settings endpoints updated to read model options from the registry.
  - **Engine integration** (`packages/engine/src/engine.ts`, `node-executor.ts`, `types.ts`): `aliasMap` and `costMap` added to `EngineConfig` and `NodeExecutorDeps`. `normalizeModelAlias()` accepts optional `aliasMap` (env override > registry > static defaults). Cost estimation uses `costMap` with `COST_PER_TURN` as fallback. `ModelCostInfo` type exported from `types.ts`.
  - **Execution wiring** (`packages/server/src/services/execution.service.ts`): `buildAliasAndCostMaps()` fetches active registry entries and wires `aliasMap`/`costMap` into all 4 `EngineConfig` construction sites.
  - **Provider model patching** (`packages/server/src/services/chat-providers.ts`): added `getEnabledProvidersFromRegistry(db)` which patches closed providers (`models`) and open providers (`modelSuggestions`) from the registry. `buildClaudeCompatibleEnvOverlay()` accepts optional `db` parameter for tier-based default resolution via `resolveModelForTier()`.
  - **New hook** (`packages/ui/src/hooks/useModelRegistry.ts`): shared `useModelRegistry()` hook with `{ models, fetch, createModel, updateModel, deleteModel, getModelsForProvider }`. All model dropdowns append an "Other…" free-text fallback (REQ-013).
  - **New UI component** (`packages/ui/src/components/settings/ModelRegistryPanel.tsx`): admin-only CRUD table with provider filtering, inline editing, soft-delete with confirmation, and duplicate/validation error toasts.
  - **Consumer updates**: `RoleDialog.tsx`, `NodeProperties.tsx`, `BulkAgentModelDialog.tsx`, `ImportAndTeamDialogs.tsx`, `OnboardingModelDefaultsPage.tsx`, `SettingsPage.tsx` — hardcoded model arrays replaced with `useModelRegistry()` hook consumption. `useEnabledProviders.ts` merges registry data via `mergeRegistryIntoProviders()`. `apiSecondary.ts` exports `system.models` API client wrappers.
  - **DB indexes** (`packages/server/src/database/indexes.ts`): `{ provider: 1, alias: 1 }` (unique), `{ provider: 1, isActive: 1, sortOrder: 1 }`, `{ isActive: 1 }`.
  - **Seed data**: Claude (fable/sonnet/opus/haiku — pricing from anthropic.com), Codex/GPT (from openai.com), DeepSeek (from api-docs.deepseek.com), Kimi (from platform.moonshot.cn), Xiaomi MiMo (no published pricing → null).
  - **Covers**: REQ-001–019, AC-001–008, NFR-001–004. Linear: ENG-1825.

- **Soft delete + restore-by-create for agents, workflows, teams, and skills** (`packages/server`, `packages/ui`): deleting an org resource now sets `isDeleted=true` and `deletedAt` instead of removing the document from MongoDB. Deleted resources are hidden everywhere (lists, detail endpoints, MCP tools, pickers, org context) and behave as if they do not exist to all external callers — no "show deleted" option exists in v1.
  - New shared helpers in `packages/server/src/services/soft-delete.ts`: `notDeletedFilter`, `softDeleteSet()`, `restoreSet()`.
  - All delete endpoints (agents, workflows, teams, skills) now use `softDeleteSet()` instead of `deleteOne()`.
  - All list and get/detail endpoints add `notDeletedFilter` (`{ isDeleted: { $ne: true } }`) to query predicates.
  - Agents: built-in protection, team-lead protection, and spawn/run/edit/move guards all remain and use `notDeletedFilter`.
  - Workflows: `archived` and `isDeleted` are independent; both filters are applied.
  - Teams: deletion refused if members exist. Move-to-deleted-team is rejected.
  - Skills: `enabled` and `isDeleted` are independent; `includeDisabled=true` still excludes deleted skills.
  - **Restore-by-create**: creating/importing a resource with the same `name` as a soft-deleted record restores it (updates `isDeleted=false`, clears timestamps) instead of inserting a new document. REST responses include `restored: true`; the UI shows "Restored" toasts.
  - MCP tools (`create_agent`, `delete_agent`, `create_team`, `delete_team`, `list_workflows`, `get_workflow`, `run_workflow`, `list_skills`, `search_skills`, etc.) all apply the same soft-delete filtering.
  - Org context generation excludes deleted agents and teams.
  - Seed logic (`seed.ts`) checks `isDeleted` before recreating built-in resources; soft-deleted built-ins are only restored under `SEED_OVERRIDE`.
  - UI: delete confirmation dialogs note that agents, workflows, and teams can be recovered by recreating with the same name. Create/import forms handle `restored: true` with "Restored" toasts. All pickers (agent selectors, team selectors, workflow selectors) exclude deleted resources.

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

- **Usage & cost dashboard** (`packages/server`, `packages/ui`): new Settings → Usage dashboard backed by per-LLM-run cost records that are stored individually and rolled up on demand, fixing prior cost aggregation ("cost-singularity").

- **Plan Mode Planner persona** (`packages/engine`, `packages/server`): Plan Mode now drives a read-only Planner that brainstorms and authors PRDs without making code changes.

- **One-click repo context bootstrap** (`packages/server`, `packages/ui`): guided orchestration that sets up repository context in a single flow.

- **In-app release notes viewer** (`packages/desktop`, `packages/ui`): a desktop changelog viewer that reads the release notes feed.

### Changed

- **Registry-driven model display names**: model display names are now consistent and sourced from the Model Registry across all surfaces, and the registry is managed within providers.
- **Workflow context evaluation** moved into the inspector.
- **Reorganized public documentation** under `docs/`.

### Fixed

- **Slack markdown attachments** are now handled correctly.
- **Duplicate toast messages** are de-duplicated.
- **`SEED_OVERRIDE`** is respected, and agent providers are no longer flattened on desktop restart.
- **Curated context refresh consistency**.

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
