# Changelog

This file tracks notable Allen changes.

Allen is currently pre-release, so behavior can change between commits. Versioned release notes will start when public tags are created.

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
