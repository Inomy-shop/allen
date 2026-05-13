# Changelog

This file tracks notable Allen changes.

Allen is currently pre-release, so behavior can change between commits. Versioned release notes will start when public tags are created.

## Unreleased

### Added

- **Automation agent infrastructure** — cron jobs with `target.agentName === job.name` now get a persistent linked chat session (one `chat_sessions` document per job, keyed by a sparse-unique `automationKey` index). On each dispatch, `CronService.ensureLinkedSession()` upserts the session race-safely and injects `AUTOMATION_CONTEXT` (session ID, 5-min JWT token, message URL) into the agent prompt so it can POST results back via the new `POST /api/chat/sessions/:id/automation-message` endpoint. `cron_jobs.linkedChatSessionId` is persisted on first creation and excluded from `SEED_OVERRIDE` updates. `signAccessToken` extended with an optional `expiresIn` override so automation tokens (`'5m'`) do not leak a long-lived credential into the `chat_messages` collection.
- **`daily-status-prep` cron job** — weekday morning automation (schedule `30 9 * * 1-5` ET) that fires the `daily-status-prep` agent 30 minutes before the 10 AM ET daily call and posts a 6-section briefing to its linked chat thread and the configured Slack status channel.
- **Dashboard Automations panel** — displays configured automation jobs above in-flight work. Each card shows last-run status (with animated `Loader2` spinner + `glow-running` badge while running), next-run time, and a `View Report →` link to the linked chat thread.

- `npm run setup` script that verifies Node 22+, installs MongoDB 7 (Homebrew on macOS), the Claude Code CLI, and the Codex CLI when missing, runs `npm install`, and creates `.env` with freshly generated JWT secrets.
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
- Documentation updated to use `npm run setup` and `npm start` instead of manual `npm install` + `docker compose up` + `npm run dev`.
- `.env.example` reorganized into a required block (server, MongoDB URI, admin bootstrap, JWT signing keys) and clearly labelled optional blocks for agent execution knobs and GitHub / Linear / Slack / MCP integration credentials.
- Documentation simplified to source all integration credentials from `.env`; references to the encrypted Allen Secrets store and `ALLEN_MASTER_KEY` removed.

### Removed

- `docker-compose.yml`. Allen now runs against a local MongoDB; container images for the server and UI are not yet supported.
- Encrypted Allen Secrets store: `packages/server/src/services/secret.service.ts`, `services/encryption.ts`, `routes/secret.routes.ts`, the `/api/secrets` HTTP route, the `secrets` MongoDB collection wiring, the legacy `@secret:KEY` MCP env resolution path, and `ALLEN_MASTER_KEY`. All integration credentials are now read directly from `.env` via `process.env`.
