# Server Module

The server is Allen's API, persistence, integration, and runtime coordination layer. It exposes the product backend that the UI and desktop shell use.

## Location

`packages/server`

## Responsibilities

- Start the Express API and real-time streams.
- Connect to MongoDB and manage persisted data.
- Seed the built-in teams, agents, workflows, and scheduled jobs.
- Manage users, auth, repos, chats, executions, interventions, artifacts, files, and workspaces.
  - Repo management includes a `PUT /api/repos/:id/default-branch` endpoint that fetches remote refs, validates `origin/<branch>` exists, switches the checkout via `git switch -C <branch> origin/<branch>`, and persists the branch as the new `detected.defaultBranch`. Local-only branches are rejected.
  - Chat management includes send, queue, and steer endpoints. `POST /api/chat/sessions/:id/steer` injects a user message into the running agent turn mid-stream — it bypasses the turn queue and delivers the message directly into the active persistent runtime (Claude or Codex). If no active turn exists, the message falls back transparently to the existing queue behavior.
- Run the **Execution Watcher** — a background poller (`WatcherService`) that automatically monitors chat-started workflow and agent executions, generates deterministic status text from execution logs and known milestones, publishes `watcher_update` SSE events in real time, and sends hidden Assistant triggers when executions complete, fail, are cancelled, or wait for input. Boot-time reconciliation recovers watchers after server restart.
- Coordinate workspaces, terminals, file watchers, and preview proxies.
- Integrate with GitHub, Linear, Slack, MCP servers, and scheduled jobs.
- Dispatch workflow and agent runs through the engine, including model-recovery retries via `POST /api/executions/:executionId/recover-model`.
- Manage the model registry (`/api/system/models`, Settings → Models) that drives every model dropdown, display name resolution, and per-MTok cost calculation. The same data populates the recovery model selector via `GET /api/system/models/recovery`, which returns provider-grouped active models for model-recovery prompts. Each entry carries `fullId` (canonical DB key), `displayName` (human label, required), and `providerDisplayName` (provider-level label, e.g. "Claude", "Codex", "GLM/Z.AI"). The unique index is `{provider, fullId}`; the `alias` field has been removed. The seed catalog syncs on every boot without overwriting admin edits.
- Run an idempotent alias→fullId migration at boot (`runAliasToFullIdMigration`) that rewrites legacy aliases (e.g. `sonnet` → `claude-sonnet-4-6`) in `agents.model`, `chat_sessions.model`, `chat_sessions.agentOverrides.model`, and `workflows.nodes[].agentOverrides.model` using a frozen `LEGACY_ALIAS_LOOKUP_MAP` covering all supported providers. Historical execution trace records are NOT rewritten — a read-time legacy alias lookup in `model-cost.service.ts` keeps pre-migration cost figures accurate (FR-3.3).

## How it fits with the rest of Allen

```text
UI / Desktop
  -> Server API
  -> MongoDB + workspace services + integrations
  -> Engine for agent and workflow execution
```

The server is the boundary between product actions and runtime execution. It should preserve clear authentication, authorization, and auditability around anything that can affect repositories or credentials.

## Contributor entry points

- App and route wiring: `packages/server/src/app.ts`
- Embeddable server startup: `packages/server/src/server.ts`
- API routes: `packages/server/src/routes/`
- Runtime services: `packages/server/src/services/`
- Auth: `packages/server/src/auth/`, `packages/server/src/middleware/`
- Runtime config: `packages/server/src/runtime/`
- Execution Watcher service: `packages/server/src/services/watcher.service.ts`
- Execution Watcher routes: `packages/server/src/routes/watcher.routes.ts`

## Related concepts

- [Teams](../concepts/teams.md)
- [Agents](../concepts/agents.md)
- [Workspaces](../concepts/workspaces.md)
- [Integrations](../concepts/integrations.md)
- [Security and sandboxing](../security.md)
