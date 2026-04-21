# Allen — Deep Dive (baseline doc for comparison)

**Last reviewed:** 2026-04-20
**Category:** Self-hosted multi-agent workflow orchestration platform
**One-line pitch:** A TypeScript monorepo that orchestrates Claude Code + Codex CLI subprocesses through a declarative workflow graph, with first-class teams, agent-to-agent delegation, 21 self-service MCP tools, a Mem0-style learning system, automatic CodeRabbit review resolution, and human-in-the-loop interventions — all self-hostable, production-deployed to AWS.

---

## 1. Snapshot

- **Package layout:** npm workspaces + Turbo — `packages/engine`, `packages/server`, `packages/ui`.
- **Runtime:** Node.js (Express), MongoDB persistence (DocumentDB on AWS), React + SSE front-end.
- **Model providers:** Claude Code SDK (TypeScript `query()` wrapper, not raw CLI) + OpenAI Codex CLI.
- **Deployment:** Docker Compose for local/on-prem. **Live production on AWS** — EC2 behind ALB + Route53 (`allen.inomy.ai`) + ACM, provisioned via Terraform (`infra/` + `apply.sh`).
- **Persistent state:** `~/.allen/` (repos/workspaces/worktree-cache) — survives reboots; centralized in `packages/engine/src/paths.ts` with per-subdir env overrides.
- **Source:** Private repo (`Kalpai-poc/allen`).

## 2. Engine (`packages/engine/src/`)

### 2a. Five node types (`types.ts:3`, `node-executor.ts`)
1. **`agent`** — spawns Claude Code SDK `query()` or Codex CLI subprocess. Per-node `agentOverrides` can cross-override provider / model / reasoning / plan-mode without mutating the agent document.
2. **`code`** — invokes a built-in function. Supports `retries`, `backoff` (exponential/linear/fixed), `retry_on` patterns, `on_failure` (fail/skip/fallback), `fallback_value`.
3. **`human`** — blocks execution and requests structured input (fields: string/text/boolean/number/select).
4. **`workflow`** — invokes a nested workflow via `runWorkflow()` DI, with `input_map` / `output_map` for schema translation. Nesting capped at depth 3.
5. **`condition`** — evaluates Filtrex expression, routes on named branches.

### 2b. Graph walker (`engine.ts`)
- **Topology-aware loop** over `currentNodes` + `completedNodes`.
- **Parallel forks** via edges with `parallel: true` — branches run concurrently with snapshot state copies + per-branch `AbortController`. Join policies: `wait-all | wait-any | fail-fast`. Merge strategies per-key: `last | concat | min | max | all | any`.
- **Retry edges** — backward edges with `max_retries` + `retry_context` template. Enforces `retryCounts`; synthesises feedback payload; rewinds downstream `completedNodes`.
- **Three retry layers:**
  1. **SDK-transient** — 3 attempts, 5s cooldown, only on matching transient patterns (`ECONNRESET`, `ETIMEDOUT`, subprocess exit 1, `~/.claude/` lock contention).
  2. **Edge retry** — `max_retries` on backward edges, with resumed agent sessions + minimal retry prompt.
  3. **Operator retry-from-node** — rewind to checkpoint from UI button or intervention `request_changes`.
- **Auto-gate**: agent nodes without conditional out-edges get STOP/SKIP/CLARIFY instructions auto-injected; `extractAutoGateFields` parses tokens from raw response.
- **Checkpoints** — one per completed node + one pre-human-wait. Queried by "most recent where `completedNodes ∌ target`".
- **Cancel / Pause / Resume** — three `Set<string>` flags on engine instance + per-node AbortController for subprocess kills. Cooperative.

### 2c. Key modules
- **`template.ts`** — Handlebars rendering with object/array pretty-printed (no `[object Object]`). Handlebars templates cached by string.
- **`condition-parser.ts`** — Filtrex with AND/OR/NOT normalization, single→double quote coercion, boolean↔0/1 coercion, safe state view (missing = 0).
- **`output-extractor.ts`** — **4-layer extraction**:
  1. Raw JSON (response starts with `{` or `[`).
  2. Fenced ```json ... ``` code block.
  3. Custom regex per field (`output_extraction: {field: "pattern"}`).
  4. **Haiku LLM fallback** with output schema as prompt.
  Plus **agent-resume retry** — re-asks the same session for properly-formatted JSON (max 2 attempts, 5s cooldown).
- **`learning-manager.ts`** — Mem0-style ADD/UPDATE/DELETE/NOOP classification. See §3.
- **`org-context.ts`** — `buildOrgContextBlock(db, opts)` generates live markdown org-chart + delegation graph, stamped onto every agent's system prompt at runtime. Not persisted.
- **`mcp-loader.ts`** — loads enabled stdio MCP servers from Mongo, resolves `@secret:KEY` references via AES-256-GCM decryption (master key from `ALLEN_MASTER_KEY` env or `~/.allen/master.key`). Bundles the Allen MCP server (see §4b).
- **`state-manager.ts`** — writes to 4 Mongo collections: `executions`, `checkpoints`, `execution_traces`, `execution_failure_reports`.
- **`parallel.ts`** — merge-strategy resolver for parallel branch outputs.
- **`embedding.ts`** — `all-MiniLM-L6-v2` (384-dim) via `@xenova/transformers` — **local embeddings, no API key**. Auto-downloads ~23 MB on first use. LRU cache (1000).
- **`router.ts`** — `autoRoute(task, inputKeys)`: matches keyword + required-input rules against `router.yml`, picks a workflow. Used by chat to auto-pick workflow for a free-form task.
- **`validator.ts`** — validates workflow YAML against agent registry, built-ins, START/END reachability, condition syntax (filtrex compile), backward edges require `max_retries`, template variable warnings.

### 2d. Built-in functions (11 total, in `built-ins/`)
| Function | Purpose |
|---|---|
| `git-create-branch` | `git worktree add` on a new branch from base (default: main) |
| `git-commit` | Stage + commit in worktree |
| `git-push` | Push branch to origin |
| `git-create-pr` | `gh pr create` with title/body |
| `git-cleanup-worktree` | `git worktree remove --force` |
| `run-build` | Execute build script, capture output |
| `run-tests` | Execute test suite, parse results |
| `classify-task` | Claude Haiku tags incoming task (bug/feature/refactor) |
| `prompt-user` | Pause and ask user for text |
| `create-workspace` | In-process call into `WorkspaceManager` (no HTTP hop) — polls until setup complete |
| `persist-design-docs` | Commit generated design docs to an Allen branch |

### 2e. Learning system (`learning-manager.ts`)
- **5 extraction sources** (all fire-and-forget, non-blocking):
  1. **`retry_delta`** — after failed→succeeded retry, captures what the agent fixed.
  2. **`auto_gate`** — on STOP/SKIP/CLARIFY emission, captures workflow-design signal.
  3. **`human_correction`** — on ≥2nd clarify Q/A, captures missing input-schema signal.
  4. **`agent_explicit`** — agent emits `__learnings[]` field.
  5. **`post_execution_review`** — after execution, Haiku does forensic pass (~$0.005).
- **Classification**: Jaccard similarity (threshold 0.3) + optional embedding cosine boost. Regex-based `contradicts()`.
- **Scope levels** (`types.ts:428-434`): `global | workflow | context | agent | node_pattern`.
- **Growth limits** per scope (global: 200, workflow: 100, context: 500, agent: 50, node_pattern: 50). Weakest-learning eviction when full.
- **Feedback loop**: `confirm(lid, execId)` when injected + execution succeeds; `contradict(lid, execId)` when execution fails.
- **Token-budgeted injection** — 550 tokens per agent prompt.

## 3. Server (`packages/server/src/`)

### 3a. Routes (23 route files)
| Domain | Endpoints |
|---|---|
| **Executions** | POST `/api/executions`, GET list, GET detail, POST cancel/pause/resume/input, GET failure-report, POST retry-from/:node |
| **Interventions** | GET list, GET detail, POST respond (accept/reject/request_changes) |
| **Agents** | GET list, POST, PUT/:name, DELETE, POST import-from-repos |
| **Workflows** | GET list, POST, PUT/:id, DELETE, GET /:id/validate |
| **Teams** | GET list, POST, PUT/:name, DELETE, GET /:name/blueprint, POST/DELETE /members |
| **Learnings** | GET list (filter scope/type/status), GET, PUT (confirm/contradict), DELETE (archive) |
| **MCP servers** | GET list, POST register, PUT, DELETE, POST /:name/test |
| **Workspaces** | POST create, GET list, GET detail, POST snapshot, GET context, DELETE |
| **Repos** | GET list, POST register, PUT, DELETE, POST /:id/scan |
| **Pull Requests** | GET list, GET detail with diff |
| **Crons** | GET list, POST schedule, PUT, DELETE, POST run |
| **Chat** | POST spawn-agent, POST tools/:toolName, POST delegate, GET delegation/:id/status |
| **Auth** | POST login, POST logout, GET me, POST password-reset, POST password-reset/:token |
| **Users** (admin) | GET list, POST create, PUT, DELETE, POST must-reset |
| **Slack** | POST events (webhook), GET authorize |
| **Stream** | GET /:id/stream (SSE, mounted BEFORE requireAuth) |
| **Dashboard / Analytics / Design-Docs / Files / Alerts / Secrets** | Standard CRUD |

### 3b. Allen MCP server (`allen-mcp-server.ts`, 32 KB)
A standalone MCP server spawned via `npx tsx allen-mcp-server.ts`. Proxies **16 chat tools** over stdio JSON-RPC to the running Allen server. Key design choices:

- **JWT auth** — mints a token using `JWT_ACCESS_SECRET` (cached 1h, refreshed 30s before expiry). Wraps global fetch to inject Authorization header.
- **Spawn-tree context propagation** — passes parent executionId, caller node, root executionId via env vars so the next agent sees the spawn-tree.
- **Permission gating** — meta tools (create_agent, create_team, create/update workflow) check `currentAgent` against a builder-agent allow-list.

**16 tools exposed:**
- **Workflow**: `list_workflows`, `get_workflow`, `run_workflow`, `validate_workflow`, `create_workflow`, `update_workflow`.
- **Execution**: `wait_for_execution`, `list_executions`, `search_executions`, `cancel_execution`, `submit_execution_input`, `get_node_trace`, `get_execution_logs`.
- **Agent**: `list_agents`, `get_agent`, `create_agent`, `update_agent`, `delete_agent`, `move_agent_to_team`, `spawn_agent`.
- **Team**: `list_teams`, `get_team`, `get_team_blueprint`, `list_team_members`, `create_team`, `update_team`, `delete_team`.
- **Repo**: `list_repos`, `get_repo_context`.
- **Delegation**: `delegate_to_agent`, `wait_for_delegation`, `answer_delegator`.

This is Allen's defining feature: **agents can create agents, author workflows, recruit teammates, and delegate mid-task.**

### 3c. Services (50+ modules)
Highlights:
- **`execution.service.ts`** — start/retry-from-node/launch/cancel/queue. Builds `EngineServices` in-process hook so built-ins can reach workspace infra without HTTP.
- **`chat.service.ts`** — multi-turn session management; resumes, cancels, tracks turns + cost.
- **`chat-tools.ts`** (100 KB!) — implements the 16 MCP tools against Mongo + engine + workspace services.
- **`chat-providers.ts`** — spawns claude-cli / codex-cli subprocesses with correct `cwd`, env, MCP config. Manages session files in `~/.claude/sessions/`.
- **`stream.service.ts`** — `createSSEEmitter`; `broadcastToExecution`; persists every `execution_log` event to Mongo as fire-and-forget.
- **`intervention.service.ts`** — wraps emitter with `wrapEmitterWithInterventionHook`: on `input_required`, dedupes + creates a `workflow_interventions` row, fires Slack DM + channel post.
- **`workspace.service.ts`** — `git worktree add`, setup polling (npm install), base-port assignment, cleanup.
- **`repo-context-scanner.service.ts`** — analyses registered repos, generates markdown brief (tech stack, module map).
- **`claude-agents-importer.ts`** — scans `.claude/agents/*.md` in registered repos, parses frontmatter, imports as Allen agents.
- **`org-seed.ts`** (121 KB) — seeds default teams, agents, delegation edges from YAML.
- **`cron.service.ts`** — `node-cron` scheduling for workflows.
- **`encryption.ts`** — AES-256-GCM for secrets with master key.

### 3d. Mongo collections (inferred from services + types)
`executions`, `checkpoints`, `execution_traces`, `execution_failure_reports`, `execution_logs`, `agents`, `workflows`, `learnings`, `teams`, `agent_conversations`, `workspaces`, `repos`, `mcp_servers`, `secrets`, `users`, `cron_jobs`, `workflow_interventions`, `pull_requests`, `design_docs`, `alerts`.

## 4. UI (`packages/ui/src/`)

### 4a. Pages (21)
Chat, Execution List, Execution Detail, Interventions, Learnings, Workflow List, **Workflow Builder (ReactFlow)**, Workspace Detail (with terminal + file browser), Workspace List, Role Manager, Team Manager, Repo Manager, Pull Request List, Pull Request Detail, Cron Manager, Analytics, Settings, Users Admin, Dashboard, Login, Reset Password.

### 4b. Components
- **Workflow canvas** — drag nodes, connect edges, node/edge property panels, real-time validation warnings.
- **Execution timeline** — per-node trace, attempt counts, duration, cost, agent output, failure report detail.
- **Workspace terminal** — live output via polling / WebSocket.
- **Learning browser** — scope/type/status filters, confirm/contradict controls, semantic search.

### 4c. Hooks
- `useSSE()` — thin `EventSource` wrapper.
- `useExecution()` — subscribes to SSE + polls `/logs` every 2s for historical or sub-agent-spawn logs.
- `useChat()` — session management.

## 5. Authentication

- **JWT-based** — access token short-lived, stored in localStorage + sent as Bearer.
- **Password reset** flow with email tokens (full E2E tests).
- **`mustReset` flag** to force password change.
- **Admin bootstrap** — first run creates initial admin.
- **Admin-only routes** for user management.
- Playwright E2E tests cover login + password reset.

## 6. Key architectural decisions (worth calling out)

1. **Engine runs in-process with the server** — no network hop. Built-ins reach server infra via `EngineServices` DI. Agent subprocesses are the only network hop (over MCP stdio).
2. **Claude Code SDK's `query()`, not the raw CLI** — allows passing a `stderr` callback (critical; the SDK otherwise pipes stderr to `"ignore"` and masks all errors).
3. **Agent sessions live in `~/.claude/`** — so migrating executions across machines invalidates resumed sessions. Documented sharp edge.
4. **`cwd` resolution is a fallback chain** — `worktree_path → repo_path → agent.sourceRepoPath → /tmp/allen`. **Never `process.cwd()`** (that's the server source tree).
5. **Workflow YAML is diffable** — the declarative artifact is the source of truth; the visual builder is a view on top.
6. **Every SSE event is persisted** — `execution_log` rows in Mongo let historical and sub-agent-spawn views rebuild full log streams.
7. **Secrets encrypted at rest** — AES-256-GCM with master key from env or file.

## 7. Shipped vs. planned (from `docs/plans/`)

### Shipped (code + tests, live on production)
- 5 node types, parallel execution with merge strategies, 3-layer retry, checkpoints, auto-gate
- Chat system (multi-turn, streaming, delegation)
- **21 MCP tools on Allen MCP server** (PR + workspace + execution + repo + agent + team + learning + secret + cron tools)
- Learning system (5 sources, ADD/UPDATE/DELETE/NOOP, embedding search)
- Org context live injection
- Workspace management (git worktrees on persistent `~/.allen/`, port assignment, setup polling)
- Intervention system with Slack notifications
- Cron scheduling (3 built-in jobs + user-defined)
- Repo context scanner + Claude agents importer
- Workflow visual builder
- Design-doc persistence
- 11 built-in functions
- AES-256-GCM secret encryption
- Full auth (JWT, password reset, admin, mustReset)
- PR tracking, alerts, analytics dashboards
- Codex provider support + per-node overrides
- **AWS production deployment** — EC2 + ALB + Route53 + ACM via Terraform; live at `allen.inomy.ai` with SSM-driven deploy pipeline
- **Full provider tool access** — agents can use every Claude/Codex built-in + every registered MCP server (removed legacy `allowedTools` restriction that silently blocked MCP calls in workflow nodes)
- **Per-execution tool-call log with expandable I/O** — every tool invocation is persisted in `execution_traces.toolCalls[]`, with full args + result (10KB cap + truncated flag). Rendered inline in the Activity Log viewer, ExecutionDetailPage, NodeDetail, and ChatPage. Live-streams during execution via `agent_tool_complete` SSE events.
- **Agent execution attempt tabs** — resuming a `spawn_agent` execution appends attempt N+1 on the same execution row (not a new execution). Attempt tabs in the UI let you switch between turns; the trace / cost / tool log / response per attempt is independently viewable.
- **Centralized brand + path constants** — `packages/engine/src/brand.ts` + `packages/ui/src/lib/brand.ts` + `packages/engine/src/paths.ts` make rebrands and relocations a 2-line change. Writable-check + fallback chain for `$HOME/.allen` → `/var/lib/allen` → `/tmp/allen` (with loud warning).
- **CodeRabbit auto-resolution workflow** — new `resolve-pr-reviews.yml` + 2 agents (`pr-workspace-resolver`, `pr-review-bot`) + `coderabbit-sweep-15min` cron. Fetches unresolved CodeRabbit comments from any open PR, applies fixes in the originating workspace (Flow A) or a freshly-created one (Flow B), runs tests, commits + pushes to the same branch, posts a summary, resolves threads via GraphQL. Manual UI trigger on the Pull Requests page for external PRs. Rate-limited: 3-attempt cap per PR, 30-min cooldown, advisory lock with TTL.
- **MCP-first agent instructions** — all new agents are told to prefer `mcp__github__*` / `mcp__linear__*` / `mcp__aws__*` / `mcp__pipeline*__*` / `mcp__allen__*` over shell CLI calls. Resolver orchestrators propagate this policy to delegated specialists.

### Planned (design docs only, no code)
- Memory blocks (Letta-inspired) — `docs/plans/memory-system-gap-analysis-2026.md`
- Skill library (markdown recipes on orphan branch) — `docs/plans/skill-library-design.md`
- Bidirectional agent conversations (ask mid-task) — `docs/plans/bidirectional-agent-conversations.md`
- Slack bot integration — commands + approvals beyond notifications; notifier path is live, full bot integration partially shipped (`docs/plans/slack-bot-integration.md`)
- Full per-node reasoning assignments — `docs/plans/agent-reasoning-assignments.md` (partial)
- GitHub webhook receiver — for sub-second CodeRabbit trigger latency (today the sweep is cron-driven at 15 min)

## 8. Strengths (distinct from competitors)

1. **Declarative graph + diffable YAML + 3-layer retry + checkpoints** — no other product has all four in the same engine.
2. **Agent self-service via 21 MCP tools** — agents that can create agents, author workflows, build teams, spawn peers, resolve PRs, mark sync state. Rare capability; no direct competitor matches it.
3. **Live org-chart injection at prompt time** — every agent sees the current team structure without restart.
4. **First-class teams with blueprints** — members + system prompts + delegation edges + live org chart in one primitive.
5. **Agent-to-agent delegation shipped** (`delegate_to_agent`, `wait_for_delegation`, `answer_delegator`) — Letta-class behavior.
6. **Claude Code ecosystem interop** — imports `.claude/agents/*.md` from user repos; exposes an MCP server Claude Code clients can call.
7. **Self-host on commodity infra** — Docker Compose + Mongo; no AWS lock-in; no per-token markup. Also ships a full Terraform-driven AWS deploy for shops that want managed infra.
8. **Local embeddings** — `all-MiniLM-L6-v2` via transformers.js, no API key, no network.
9. **Cron + chat + visual builder + CLI + Codex + Slack** on a single engine — widest surface in this cohort.
10. **Production-grade auth + secrets + E2E tests** — not a hobby project.
11. **Automatic review-bot resolution loop** — `resolve-pr-reviews` workflow fetches unresolved CodeRabbit / Sonar / arbitrary-bot comments, delegates fixes to the right specialist, commits + pushes to the same branch, and resolves the threads. Runs every 15 min via cron for workflow-owned PRs; manual trigger supports external PRs. No competitor in this cohort ships this.
12. **Full per-execution tool-call log with expandable I/O** — every tool call persists name + description + args + result + duration + error state. Matched by `toolUseId` for exact replay, or tool+timestamp as a fallback. Streams live via SSE during execution and survives page reloads after. Factory and Conductor show agent actions; neither exposes the full I/O per tool with this fidelity.
13. **Two-brand-constant rebrand path** — the project itself demonstrated this by renaming `flowforge` → `allen` across 129 files + infra + DocumentDB + live EC2 in a single day. The `brand.ts` + `paths.ts` abstractions are now documented as the "change these two lines" primitive for future rebrands or forks.

## 9. Weaknesses (honest self-assessment)

1. **No structured memory blocks** — learnings are Mem0-style delta facts, not Letta-class core/recall/archival tiers. Biggest confirmed gap.
2. **No autonomous trajectory planning (pass@k)** — Factory's published-benchmark approach beats Allen's single-path design.
3. **No spec-driven planning artifact** — Kiro's EARS requirements + design + tasks pipeline is cleaner than Allen's design-doc built-in for greenfield work.
4. **No event hooks** — only edges and cron; no file-save / PR-opened / tool-use triggers like Kiro.
5. **Parallel-agent UX less polished than Conductor** — data model supports it, UI doesn't showcase it.
6. **No published benchmark number** — Factory publishes SWE-bench; Allen doesn't.
7. **MongoDB + Node dependency** — lighter than many, but not as OS-friendly as pure-Node or pure-Go.
8. **Skill library design-stage** — markdown recipe system planned but not shipped.

## 10. Who it's for (realistic positioning)

- **Engineering teams that want to own the stack** — self-host, Claude-Code-native, declarative workflows, agents that can build agents.
- **Teams building multi-agent systems with hierarchies** — teams, leads, delegation, mid-workflow hand-offs.
- **Teams already using Claude Code** — direct ecosystem interop via `.claude/agents/*.md` import + MCP server.
- **Startups to mid-market** — Docker Compose + Mongo + BYO keys; no enterprise procurement required.
- **Not the right fit for:** pure PM workflows (use ProductNow), small solo-dev parallel Claude Code sessions (use Conductor), autonomous agent research with heavy memory experiments (use Letta), AWS-mandated shops (use Kiro), Fortune 500 audit-driven SDLC (use 8090 + Factory).

## 11. Top priorities derived from gaps

1. **Ship memory blocks** — `docs/plans/memory-system-gap-analysis-2026.md` is ready. Biggest remaining gap vs. Letta.
2. **Ship skill library** — `docs/plans/skill-library-design.md` is ready.
3. **Spec node type** (EARS-style) — new node emits `requirements.md` + `design.md` + `tasks.md` into state. Closes the Kiro gap.
4. **GitHub webhook receiver** — for sub-second CodeRabbit trigger latency. Today's 15-min sweep handles it with acceptable lag but a webhook path would be strictly better.
5. **Event hooks** (file save / PR-opened / tool use) — extend the emitter. Kiro ships this; Allen doesn't.
6. **Multi-trajectory option on agent nodes** — `trajectories: { samples: 3, selector: tests-pass }` reuses checkpoint infra. Closes the Factory pass@k gap.
7. **Conductor-style parallel-workspace UI** — the data model supports parallel forks; the UI needs a split-pane view.
8. **Publish a SWE-bench or Terminal-Bench number** for the coding-agent workflow — Factory and Conductor publish; Allen doesn't yet.

### Recently closed (2026-04-20)
- ✅ Persistent workspace/repo paths (`~/.allen/` instead of tmpfs-volatile `/tmp/`)
- ✅ Full MCP tool access across all workflow nodes (fixed the `allowedTools` bug that silently blocked MCP in workflow contexts)
- ✅ Structured per-execution tool log with expandable input/output
- ✅ Agent execution attempt tracking (resume creates attempt N+1 on same execution)
- ✅ Auto-resolve review-bot comments (CodeRabbit workflow)
- ✅ AWS production deploy (Terraform + Route53 + ACM + ALB)

## 12. References (internal)

- `packages/engine/src/engine.ts` — graph walker, retry edges, checkpoints, pause/resume, cancel.
- `packages/engine/src/node-executor.ts` — 5 node type dispatch, agent/claude/codex execution, prompt shaping (retry/forward/full), cwd resolution.
- `packages/engine/src/types.ts` — `NodeDef`, `AgentDef`, `AgentOverrides`, `Learning`, `ExecutionState`, `Checkpoint`, `SSEEvent`.
- `packages/engine/src/learning-manager.ts` — 5 extraction sources, classification, feedback loop.
- `packages/engine/src/mcp-loader.ts` — MCP servers + secrets.
- `packages/engine/src/org-context.ts` — live org-chart injection.
- `packages/engine/src/output-extractor.ts` — 4-layer extraction + LLM fallback.
- `packages/server/src/services/allen-mcp-server.ts` — 16 MCP tools + JWT + spawn-tree propagation.
- `packages/server/src/services/chat-tools.ts` — tool implementations.
- `packages/server/src/services/execution.service.ts` — launch / wrap / queue.
- `packages/server/src/services/workspace.service.ts` — git worktree lifecycle.
- `docs/workflow-execution.md` — reference guide to the execution model.
- `docs/plans/memory-system-gap-analysis-2026.md` — roadmap for closing Letta gap.
- `docs/plans/skill-library-design.md` — markdown recipe system.
- `docs/plans/multi-agent-team-system.md` — team-agents roadmap.
