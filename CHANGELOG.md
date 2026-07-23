# Changelog

This file tracks notable Allen changes.

Allen is currently pre-release, so behavior can change between commits. Versioned release notes will start when public tags are created.

## [Unreleased]

## [0.1.22] - 2026-07-23

Large UI redesign release.

### Added

- **Redesigned interface across every major surface** (`packages/ui`): a new shared component foundation (`common/Button`, `Dialog`, `Field`, `Surface`, `Typography`, `ProviderIcon`, `V8SidebarIcons`) with the dashboard, sidebar navigation, sessions, repositories, Linear, workspaces, documents, pull requests (list + detail), teams (list + detail), workflows (list, detail, ensemble detail), executions (list + detail), repository context, conversation detail, workspace detail, Allen Design (page, workspace, session), and settings surfaces all rebuilt against the new design.
- **Universal document viewer and unified document/resource workspace** (`packages/ui`, `packages/server`): new `DocumentTabHost`, `DocumentReviewRail`, and `MediaViewerHost` components backed by `documentTabStore` and `mediaViewerStore`, so documents and chat resources open as tabs in one workspace. Chat resources open in sibling tabs, with supporting `artifact.service` / `document.service` changes.
- **Structured workflow execution logs** (`packages/ui`, `packages/server`): new `StructuredExecutionLogs` and `ExecutionSummaryStrip` components giving execution logs a structured, summarized view.
- **Team classification** (`packages/server`, `packages/ui`): new team-classification types and a `TeamClassificationSelect` control, plus Studio session routing.
- **Provider tool activity in chat** (`packages/server`, `packages/ui`): a new `chat-tool-normalization` service surfaces provider tool activity in the chat transcript.
- **Documentation site** (`packages/docs-site`): a new Docusaurus site with audited, code-verified content across getting started, concepts, feature guides, integrations, and the operator guide.
- **Playwright MCP preset** (`packages/server`): added a Playwright MCP server preset to the preset catalog.

### Changed

- **Model controls and document library state** (`packages/ui`): refined model selection controls and document library state handling, including a shared reasoning-effort helper.
- **Workspace chat tabs and composer** (`packages/ui`): unified the workspace chat tabs and composer, and refined composer focus and height behaviour.
- **Desktop spacing and diff backgrounds** (`packages/ui`): polished spacing and code-diff backgrounds.

### Fixed

- **Chat documents isolated by conversation** (`packages/ui`): documents no longer leak between chat conversations.
- **Execution log node labels** (`packages/ui`): long node labels are truncated instead of overflowing.
- **Chat execution and resource handling** (`packages/ui`): refined handling of chat executions and attached resources.

## [0.1.20] - 2026-07-16

### Added

- **Runtime model overrides** (`packages/server`, `packages/engine`): models can be overridden at runtime for an execution.
- **Cascading team deletion** (`packages/server`): deleting a team now cascades to its dependent records.
- **Binary artifact serving** (`packages/server`): binary artifacts are persisted and served as their original bytes, with MIME detection, HTTP range requests, byte-accurate size, and SHA-256 metadata.

### Changed

- **Default model switched to `codex/gpt-5.6-sol`** (`packages/server`, `packages/engine`): seeded agents (`org-seed.ts`), several workflow node model overrides (`multi-repo-change-orchestration`, `requirement-to-prd-ensemble`, `workflow-build-and-review`), and the context-engine default model (`DEFAULT_CONTEXT_LLM_MODEL`) were switched from their prior models (`sonnet` / `gpt-5.5` / `opus` / `deepseek-v4-pro`) to `codex/gpt-5.6-sol`.
- **Extended default auth token lifetimes** (`packages/server`).

### Fixed

- **In-chat model switching** (`packages/server`, `packages/ui`): switching models mid-chat is now allowed.
- **Execution state synchronization across clients** (`packages/server`, `packages/ui`): execution state stays in sync across multiple connected clients.
- **Stale chat streaming turns** (`packages/server`): stale streaming turns no longer linger.
- **Chat resume cwd handling** (`packages/server`): resuming a chat now resolves the working directory correctly.
- **Workflow node model overrides preserved** (`packages/server`): node-level model overrides are no longer lost.
- **Latest human approval decision projected** (`packages/engine`): the latest canonical approval decision is projected onto flattened decision aliases, so a stale `pending_human_review` no longer aborts downstream mutation nodes after an approval.
- **Workflow watcher wakeup** (`packages/server`): the workflow watcher is woken on terminal states.
- **Design Studio session model derives from the configured default** (`packages/server`, `packages/ui`): Design Studio duplicated a Studio-specific hardcoded model default in both the frontend and the server, each reaching past the already correctly-ordered enabled-provider list. A blank composer showed that hardcoded model even when Allen's configured default was different; both now derive from the configured default.
- **Execution status and log scrolling stabilized** (`packages/server`, `packages/ui`): chat state is reconciled from execution snapshots and chat cards recover from lifecycle snapshots, steadying execution status and timeline log scrolling.

## [0.1.19] - 2026-07-07

### Added

- **Manual skill loading in assistant chat** (`packages/server`, `packages/ui`): `/skill <name>` loads an Allen Library skill in a single chat turn (the server expands it to a `get_skill` load instruction and persists a skill-load marker), plus a new Skills settings page and seeded playbook skills.
- **Import Design Studio designs into a new workspace** (`packages/server`, `packages/ui`): fork designs created in another user's Design Studio workspace (or an exported folder) into a fresh workspace of your own.
- **Direct chat artifacts in the sidebar** (`packages/ui`): direct-chat artifacts now appear in the sidebar, the artifact viewer is unified, and comments are enabled by default.

### Fixed

- **Bold artifact chat links** (`packages/ui`): nested inline markdown inside emphasis is now parsed, so artifact links wrapped in bold render as clickable chat controls.
- **Model recovery provider overrides** (`packages/server`, `packages/engine`): model-recovery override metadata is propagated into parallel-branch retries so selected fallback providers/models are visible to node execution, and the model-recovery intervention widget is persisted.
- **Artifact document comments and versions** (`packages/server`, `packages/ui`): assorted fixes to artifact document comments and versioning.
- **Skills settings cards** (`packages/ui`): updated the skills settings cards.

## [0.1.18] - 2026-07-05

### Added

- **Document comments, versioning, and agent-assisted revisions** (`packages/server`, `packages/ui`): full document/artifact commenting with a comment timeline, document versioning with restore and version comparison, agent-readable comments, and agent-assisted revision of documents.
- **Claude Sonnet 5 in the model registry** (`packages/server`): added Claude Sonnet 5 to the seeded model registry.

### Fixed

- **Guard agent capability search** (`packages/ui`): agent capability lists are normalized before rendering and searching, so malformed legacy/imported capability values can no longer crash the Agents and Teams pages.
- **Watcher polling interval** (`packages/server`): corrected the execution watcher polling interval.
- **Preserve agent model and provider during seed refresh** (`packages/server`): when `SEED_OVERRIDE=true` refreshes existing seeded agents, it no longer overwrites user-configured model and provider settings, so operators don't need to reconfigure them after a refresh.
- **Chat tab switching** (`packages/ui`): switching between workspace chat/terminal/servers tabs no longer fully remounts `ChatMessageList`, eliminating the smooth scroll-from-top animation on every tab switch.

## [0.1.17] - 2026-06-30

### Added

- **Chat export/import — portable replay bundles** (`packages/server`, `packages/ui`): export any chat session as a downloadable `allen-chat-*.json` file and import it on another Allen installation as a read-only replay. The feature covers the full PRD scope (R1–R16, AC1–AC20).
  - **New server services** (`packages/server/src/services/chat-export.service.ts`, `chat-import.service.ts`): `ChatExportService` assembles a portable bundle from chat messages, executions, logs, traces, artifacts, interventions, watchers, and code-diff snapshots with configurable toggles and server-side redaction; `ChatImportService` validates, previews, and persists imported bundles with full ID remapping and rollback on failure.
  - **New API** (`packages/server/src/routes/chat-export-import.routes.ts`): `GET /api/chat/sessions/:id/export-options` (counts/size preview), `POST /api/chat/sessions/:id/export` (assembly + download), `GET /api/chat/sessions/:id/export-bundle` (re-download), `POST /api/chat/import/preview` (validate + preview), `POST /api/chat/import/confirm` (persist with rollback).
  - **Read-only guards**: imported sessions block message send, cancel, steer, queue, code-diff creation, agent-answer, and automation-message endpoints (chat.routes.ts). Imported executions block resume/retry (execution.routes.ts). Interventions on imported sessions block respond (intervention.routes.ts). The watcher registration endpoint rejects imported sessions, and `pollOnce()` force-resolves any watcher linked to imported executions (watcher.service.ts).
  - **New UI components** (`packages/ui/src/components/chat/`): `ChatExportDialog` — 11 toggle groups (messages, tool calls, hidden messages, logs, traces, artifacts, artfact contents, code diffs, thinking, hidden messages) and 3 redaction checkboxes (paths, identity, secrets) with size-limit recovery. `ChatImportPreviewModal` — file picker → validation → preview with source environment, counts, warnings, and confirmation. `ImportedChatBanner` — persistent yellow read-only replay banner above the message list with source environment details.
  - **Modified UI** (`ConversationsSidebar.tsx`): Import chat button (Upload icon) next to New chat in the sidebar header; imported sessions show a yellow "Imported" badge in the history list. `ChatPage.tsx`: Export button in the active chat header; composer disabled with replay reason; answer/intervention callbacks suppressed when `session.isImported`. `useChat.ts`: added `isImported`, `importBundleId`, `sourceEnvironment`, `sourceSessionId`, `replayLabel` fields. `api.ts`: new `chat.exportOptions`, `chat.exportChat`, `chat.getExportBundle`, `chat.importPreview`, `chat.importConfirm` methods.
  - **New DB collection** (`chat_export_bundles`): indexes on `bundleId` (unique), `chatSessionId+operation`, `userId+createdAt`, `importSessionId` (sparse), `createdAt`. New partial index on `chat_sessions.isImported`.
  - **New server mount**: `chatExportImportRoutes` mounted at `/api/chat` in `server.ts`.
  - **Covers**: PRD R1–R16, AC1–AC20.

- **X API MCP preset** (`packages/server`): added an X (Twitter) API MCP server preset to the MCP preset catalog.
- **Context setup-card progress detail panel** (`packages/ui`): the context-setup card replaces the always-visible minimal progress pane with a user-toggled (Show/Hide) detail panel grouped into Curation, Mandatory Mapping, and Graph sections.
- **Bulk context deletion controls** (`packages/server`, `packages/ui`): bulk soft-archive of curated context entries (`archiveMany()`) and bulk-deactivation of mandatory mappings (`deactivateMany()`), each preserving revision history and Cognee stale-marking per entry.

### Fixed

- **Prevent Claude `AskUserQuestion` tool use in chat** (`packages/server`): the chat runtime no longer permits Claude's `AskUserQuestion` tool, which is unsupported in this context.
- **Provider-aware workflow model overrides** (`packages/server`): workflow model overrides now respect the node's provider instead of assuming a single provider.
- **Core-job-specific agent builder prompts** (`packages/server`): the agent builder enforces core-job-specific prompts rather than a shared generic prompt.

## [0.1.16] - 2026-06-24

### Added

- **OpenRouter provider and model registry** (`packages/server`, `packages/ui`): OpenRouter added as a first-class Claude-compatible provider (identifier `openrouter`) with API key secret `ALLEN_OPENROUTER_API_KEY`. OpenRouter models are not seeded; users register their own OpenRouter model slugs in Settings → Models and can configure `ALLEN_OPENROUTER_BASE_URL` (default `https://openrouter.ai/api`). Non-Claude OpenRouter models show explicit warnings in agent config forms, model selectors, and workflow node configs (AC6). The `runClaudeCompatibleChatCLI` helper now suppresses host `ANTHROPIC_API_KEY` during all Claude-compatible provider runs to prevent credential override.
- **Reviewed agent builder workflow** (`packages/engine`, `packages/server`): added the `agent-build-with-review` workflow seed, a blueprint validator agent, and meta-builder skill routing so new agent creation goes through research, human review, validation, and then the internal Agent Builder executor instead of direct Agent Builder calls.
- **Review-gated workflow builder** (`packages/engine`, `packages/server`): added the `workflow-build-and-review` workflow seed so new workflow creation runs through research and a human review gate before the workflow is built.

### Changed

- **ANTHROPIC_API_KEY credential isolation** (`packages/server`): `runClaudeCompatibleChatCLI` now saves and suppresses the host `ANTHROPIC_API_KEY` env var during Claude-compatible provider runs (DeepSeek, Kimi, Xiaomi MiMo, GLM/Z.AI, OpenRouter) to prevent it from overriding the provider's `ANTHROPIC_AUTH_TOKEN` (AC5).

## [0.1.15] - 2026-06-22

### Added

- **Desktop-only local password reset** (`packages/server`, `packages/ui`): a "Forgot password?" recovery flow for local accounts, hard-gated by the `ALLEN_DESKTOP` runtime flag so it is never exposed on browser/web deployments. New public `POST /api/auth/desktop-reset-password` validates password strength, rejects unknown emails, updates the password, and revokes all existing sessions (issues no session — the user logs in again). New `ForgotPasswordModal` on the login page.

### Changed

- **Design Studio sidebar actions** (`packages/ui`): added a repository delete action on the Design Studio workspace detail page, and workspace update events are now published so sidebar status and deletion state refresh immediately.

### Removed

- **Legacy Design flow** (`packages/server`, `packages/engine`, `docs`): removed the legacy design pipeline — the `source-prd-to-ui-designs-variations` workflow and the `design-repos` routes/preview — now superseded by Design Studio.

## [0.1.14] - 2026-06-20

### Added

- **Steer — inject messages into a running agent** (`packages/server`): a per-message "Steer" action injects a typed message into the currently running agent turn mid-stream instead of queuing it behind the in-flight turn. Works for Claude (a `control_request` interrupt followed by the new user message on the persistent `claude -p` runtime) and Codex (`turn/steer` JSON-RPC).
- **Z.AI (GLM) provider** (`packages/server`): Z.AI added as a first-class Claude-compatible provider (identifier `zai`, displayed as GLM/Z.AI), seeding 15 GLM text models with current pricing into the model registry.
- **Node-level model recovery for workflow agent failures** (`packages/server`, `packages/engine`): when an agent/model-backed workflow node fails with a recoverable model/provider error (rate limit, server error, model unavailable, insufficient balance), Allen pauses execution for human recovery instead of failing the run.
- **Design Studio sidebar panel** (`packages/ui`): a third sidebar carousel panel for Design Studio workspaces (left dot), alongside main navigation (center) and workspaces (right).

### Changed

- **Reduced `wait_for_execution` response payload** (`packages/server`): the `wait_for_execution` MCP tool now returns a slimmer payload.

### Fixed

- **Live chat watcher updates** (`packages/server`, `packages/ui`): chat watcher status lines now stream live.
- **Honor agent override model in engine metadata** (`packages/engine`).
- **deepeval script paths** (`packages/desktop`): resolved outside `app.asar` for the packaged desktop app, and a blocking import guard was dropped.
- **Workspace sidebar groups** (`packages/ui`): capped to avoid unbounded growth.
- **Full-page file-drop overlay** (`packages/ui`): cleared after a composer drop.

## [0.1.13] - 2026-06-17

Highlights since `v0.1.12`.

### Added

- **Multi-window desktop support** (`packages/desktop/src/main.ts`): replaces the single-window `mainWindow` singleton with a `Set<BrowserWindow>` window collection supporting multiple independent windows, each connected to the same shared backend.
  - **Window creation**: File → New Window (Cmd+N) menu item, macOS Dock right-click → New Window. No in-app new-window buttons (desktop-native entry points only, per PRD D9).
  - **Shared runtime**: all windows load from the same `serverHandle.baseUrl` — one backend, multiple clients.
  - **Independent navigation**: each window has its own `webContents`; navigating one does not affect others.
  - **Lifecycle**: closing one window does not stop the shared runtime or close other windows. Explicit Quit (Cmd+Q) stops everything. `window-all-closed` is a no-op on all platforms.
  - **Focused-window targeting**: menu actions (Open Chat, Open Workspaces, Open Settings) and dialogs (Show Diagnostics, Export Support Bundle, directory picker) target the focused window via `getTargetWindow()` fallback chain.
  - **Update prompts**: routed to the focused window only; skipped and logged when no window exists.
  - **Crash recovery**: renderer-crash dialog changed from "Reload Window / Quit" to "Reload Window / Close Window" — closing one crashed window does not affect others.
  - **New test file** (`packages/desktop/src/main.test.ts`): 27 unit tests covering `getTargetWindow` fallback ordering, `handleWindowClosed` state updates, `getSecondInstanceTarget`, `shouldKeepAppAliveOnWindowClosed`, and `shouldCreateWindowOnActivate` predicates.
  - **Covers**: AC1–AC19, R1–R15, D1–D9.

- **Design Studio** (`packages/server`, `packages/ui`): a new Allen Design surface with design workspaces, sessions, profile review, discovery, generation, preview, variants, version history, and export. Adds repo-context and request modes so designs can be grounded in a repository. New backend routes/services and a full Design Studio UI; docs under `docs/design-studio.md`.

- **Drag-and-drop file uploads everywhere** (`packages/ui`): the entire chat page, dashboard, and workspace embedded chat now act as file drop zones that upload and attach dropped files to that surface's composer, instead of only the small composer field. New `useFileDropZone` hook.

- **PRD ensemble workflow seed** (`packages/engine`): seeded `requirement-to-prd-ensemble` workflow that takes a repo path and a requirement, fans out to three parallel `requirements-analyst` drafts (claude-opus-4-8, gpt-5.5, deepseek-v4-pro), and synthesizes a PRD.

- **Workspace setup cancellation** (`packages/server`, `packages/ui`): in-progress workspace setup can now be cancelled from the setup progress dialog.

### Fixed

- **Workspace sidebar ordering** (`packages/server`, `packages/ui`): workspaces are now ordered by the most recent chat message linked to each workspace, kept live without polling.

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
