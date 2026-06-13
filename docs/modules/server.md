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
- Coordinate workspaces, terminals, file watchers, and preview proxies.
- Integrate with GitHub, Linear, Slack, MCP servers, and scheduled jobs.
- Dispatch workflow and agent runs through the engine.
- Manage the model registry (`/api/system/models`, Settings → Models) that drives every model dropdown, display name resolution, and per-MTok cost calculation. Each entry carries `fullId` (canonical DB key), `displayName` (human label, required), and `providerDisplayName` (provider-level label, e.g. "Claude", "Codex"). The unique index is `{provider, fullId}`; the `alias` field has been removed. The seed catalog syncs on every boot without overwriting admin edits.
- Run an idempotent alias→fullId migration at boot (`runAliasToFullIdMigration`) that rewrites legacy aliases (e.g. `sonnet` → `claude-sonnet-4-6`) in `agents.model`, `chat_sessions.model`, `chat_sessions.agentOverrides.model`, and `workflows.nodes[].agentOverrides.model` using a frozen map of all 19 known seed models. Historical execution trace records are NOT rewritten — a read-time legacy alias lookup in `model-cost.service.ts` keeps pre-migration cost figures accurate (FR-3.3).

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

## Related concepts

- [Teams](../concepts/teams.md)
- [Agents](../concepts/agents.md)
- [Workspaces](../concepts/workspaces.md)
- [Integrations](../concepts/integrations.md)
- [Security and sandboxing](../security.md)
