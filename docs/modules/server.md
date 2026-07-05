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
  - Chat management includes send, queue, steer, export, and import endpoints. `POST /api/chat/sessions/:id/steer` injects a user message into the running agent turn mid-stream — it bypasses the turn queue and delivers the message directly into the active persistent runtime (Claude or Codex). If no active turn exists, the message falls back transparently to the existing queue behavior.
  - **Chat export/import**: `GET /api/chat/sessions/:id/export-options` returns counts and estimated size for a download preview. `POST /api/chat/sessions/:id/export` assembles and streams a portable JSON bundle with configurable toggles (messages, tool calls, logs, traces, artifacts, code-diffs, thinking text) and server-side redaction (paths, identity, secrets). `GET /api/chat/sessions/:id/export-bundle` returns the last completed export. `POST /api/chat/import/preview` validates bundle JSON, version, required fields, XSS patterns, and size. `POST /api/chat/import/confirm` persists the bundle with full ID remapping and reverse-order rollback on failure.
  - **Imported replay guards**: imported sessions block message send, cancel, steer, queue, code-diff creation, agent answer, and automation messages. Imported executions block resume and retry. Interventions on imported sessions block respond. Watcher registration rejects imported sessions; `pollOnce()` force-resolves any watcher linked to an imported session or imported execution.
- Run the **Execution Watcher** — a background poller (`WatcherService`) that automatically monitors chat-started workflow and agent executions, generates deterministic status text from execution logs and known milestones, publishes `watcher_update` SSE events in real time, and sends hidden Assistant triggers when executions complete, fail, are cancelled, or wait for input. Boot-time reconciliation recovers watchers after server restart. Imported replay watchers are stored with `watcherStatus: 'resolved'` so the poller never picks them up; `pollOnce()` also force-resolves any watcher for an imported session or imported execution.
- Coordinate workspaces, terminals, file watchers, and preview proxies.
- Integrate with GitHub, Linear, Slack, MCP servers, and scheduled jobs.
- Dispatch workflow and agent runs through the engine, including model-recovery retries via `POST /api/executions/:executionId/recover-model`.
- Validate provider+model selection through `CLAUDE_COMPATIBLE_PROVIDER_CONFIGS` in `chat-providers.ts` — OpenRouter
  models that are not in the `anthropic/` family return a non-Claude warning (`getOpenRouterNonClaudeWarning`) in
  agent and workflow config routes. The `runClaudeCompatibleChatCLI` function suppresses the host `ANTHROPIC_API_KEY`
  during all Claude-compatible provider runs so the provider's `ANTHROPIC_AUTH_TOKEN` is never silently overridden.
- Manage the model registry (`/api/system/models`, Settings → Models) that drives every model dropdown, display name resolution, and per-MTok cost calculation. The same data populates the recovery model selector via `GET /api/system/models/recovery`, which returns provider-grouped active models for model-recovery prompts. Each entry carries `fullId` (canonical DB key), `displayName` (human label, required), and `providerDisplayName` (provider-level label, e.g. "Claude", "Codex", "OpenRouter", "GLM/Z.AI"). The unique index is `{provider, fullId}`; the `alias` field has been removed. The seed catalog syncs on every boot without overwriting admin edits. OpenRouter has no seeded models; users register OpenRouter provider slugs manually as `fullId` values in Settings → Models.
- Run an idempotent alias→fullId migration at boot (`runAliasToFullIdMigration`) that rewrites legacy aliases (e.g. `sonnet` → `claude-sonnet-4-6`) in `agents.model`, `chat_sessions.model`, `chat_sessions.agentOverrides.model`, and `workflows.nodes[].agentOverrides.model` using a frozen `LEGACY_ALIAS_LOOKUP_MAP` covering all supported providers. Historical execution trace records are NOT rewritten — a read-time legacy alias lookup in `model-cost.service.ts` keeps pre-migration cost figures accurate (FR-3.3).
- Manage **document commenting and versioning** through the `/api/documents` route group (mounted at `server.ts`). Endpoints:
  - `GET /api/documents/by-artifact/:artifactId` — look up document identity by source artifact. Returns identity summary or a 404 with `eligibleForCommenting` flag.
  - `POST /api/documents` — lazily create a document identity from an artifact (bridge).
  - `GET /api/documents/:documentId` — get document summary with latest version + comment counts.
  - `GET /api/documents/:documentId/versions` — list version metadata.
  - `GET /api/documents/:documentId/versions/:versionNumber` — get full version content.
  - `POST /api/documents/:documentId/versions` — create a new version (agent or human).
  - `POST /api/documents/:documentId/versions/:versionNumber/restore` — restore a prior version (creates a new version with restored content, marks affected comments stale).
  - `GET /api/documents/:documentId/versions/compare?v1=N&v2=M` — diff two versions (line-level added/removed/modified).
  - `GET /api/documents/:documentId/comments?status=open|resolved|stale|all` — list comments.
  - `POST /api/documents/:documentId/comments` — add a comment (with text anchor).
  - `POST /api/documents/:documentId/comments/:commentId/reply` — reply to a comment thread.
  - `POST /api/documents/:documentId/comments/:commentId/resolve` — resolve a comment.
  - `POST /api/documents/:documentId/comments/:commentId/reopen` — reopen a resolved comment.
  - `GET /api/documents/:documentId/timeline` — chronological event feed.

  Database collections: `document_identities` (unique: `documentId`, indexed: `sourceArtifactId`), `document_comments` (indexed: `commentId`, `{documentId, status, createdAt}`, `{documentId, threadId, createdAt}`), plus version data embedded in the identity document.
- Inject a **document comment workflow contract** (`DOCUMENT_COMMENT_WORKFLOW`) into the base chat persona system prompt. This instructs chat agents to read comments when they fetch a commentable artifact, treat unresolved comments as revision instructions, publish new versions via `allen_create_document_version`, and resolve/reply to comments via the corresponding MCP tools. Stale comments are noted but not actionable until re-anchored.
- Register three agent-accessible MCP tools for document interactions:
  - `allen_create_document_version` — publish a new version of a commentable document.
  - `allen_resolve_document_comment` — mark a comment as resolved with a note.
  - `allen_reply_document_comment` — reply to a comment thread (used when a comment cannot be addressed).

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
  - Document routes: `packages/server/src/routes/document.routes.ts`
- Runtime services: `packages/server/src/services/`
  - Document service: `packages/server/src/services/document.service.ts`
- Auth: `packages/server/src/auth/`, `packages/server/src/middleware/`
- Runtime config: `packages/server/src/runtime/`
- Execution Watcher service: `packages/server/src/services/watcher.service.ts`
- Execution Watcher routes: `packages/server/src/routes/watcher.routes.ts`
- MCP tool definitions: `packages/server/src/services/allen-mcp-server.ts`
- Chat Export/Import services: `packages/server/src/services/chat-export.service.ts`, `packages/server/src/services/chat-import.service.ts`
- Chat Export/Import routes: `packages/server/src/routes/chat-export-import.routes.ts`

## Related concepts

- [Teams](../concepts/teams.md)
- [Agents](../concepts/agents.md)
- [Workspaces](../concepts/workspaces.md)
- [Integrations](../concepts/integrations.md)
- [Security and sandboxing](../security.md)
