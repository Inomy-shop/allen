# Self-Healing Monitoring Agent Implementation Plan

> Status: draft · owner: allen · last updated: 2026-05-01  
> Parent PRD: `docs/plans/self-healing-monitoring-agent-prd.md`  
> Linear: ENG-1472

## 1. Implementation Objective

Build a built-in Allen self-healing loop:

1. Detect chat, agent, delegation, workflow, memory, MCP, tool, and Linear
   dispatch failures.
2. Hydrate the full diagnostic context from Allen-owned telemetry.
3. Decide whether the root cause is likely inside the Allen repo or Allen
   runtime configuration.
4. Create or update a deduplicated Linear issue in the Allen project.
5. Route the issue to a built-in Allen agent or built-in workflow.
6. Track the bug-fix execution back to the incident and Linear ticket.

All agents, workflows, cron jobs, and system actions required for this loop must
be seeded as Allen built-ins. Nothing critical should depend on manually-created
agents or one-off UI configuration.

## 2. Built-In Runtime Pieces

### 2.1 Built-In Cron Job

Add this job to `packages/server/src/services/cron-seed.service.ts`.

| Job | Schedule | Timezone | Target | Purpose |
|---|---:|---|---|---|
| `allen-self-healing-monitor-hourly` | `17 * * * *` | `UTC` | workflow `allen-self-healing-monitor-hourly` | Agent-led hourly monitor for all completed, failed, cancelled/canceled, stale chats, agent executions, delegations, workflows, memory audits, MCP/tool calls, logs, traces, messages, and Linear dispatch records. |

Rationale:

- The agent-led workflow must run every 1 hour and act as the canonical reliability loop.
- Every hourly run checks completed, failed, cancelled/canceled, and stale
  records; completed records are included because bad behavior can complete
  with low-quality output, wrong memory, wrong tool usage, missing artifacts, or
  bad prompt/instruction behavior.
- Hooks may still record lightweight events immediately, but the hourly scanner
  is the source of truth that hydrates full context and decides ticketing/routing.
- Existing cron locking prevents overlapping runs when a previous scan is still
  running.

Default scanner args:

```json
{
  "lookbackHours": 24,
  "scanMode": "all_new_or_updated_since_last_success_with_overlap",
  "maxCandidatesPerRun": 200,
  "maxTicketsPerRun": 20,
  "autoDispatch": true,
  "includeStatuses": ["completed", "failed", "cancelled", "canceled", "interrupted", "stale"],
  "scanSurfaces": [
    "chat_conversations",
    "chat_messages",
    "chat_logs",
    "agent_executions",
    "agent_conversations",
    "agent_activity",
    "workflow_executions",
    "execution_logs",
    "execution_traces",
    "execution_failure_reports",
    "tool_calls",
    "mcp",
    "memory",
    "linear_dispatch"
  ],
  "stuckThresholds": {
    "chatStreamingMinutes": 10,
    "agentRunningMinutes": 45,
    "delegationActiveMinutes": 45,
    "workflowRunningMinutes": 90,
    "workflowWaitingForInputMinutes": 1440
  }
}
```

Scanner cursor behavior:

- Every hourly run scans all eligible records created or updated since the last
  successful scanner run, plus a 24-hour overlap window to catch late-arriving
  logs/traces/tool results.
- On first boot, the scanner backfills the most recent 24 hours by default.
- Operators can run a manual full backfill later, but the built-in hourly job
  must remain bounded so it cannot overload MongoDB or Linear.
- "Eligible records" means all completed, failed, cancelled/canceled,
  interrupted, and stale chat conversations, messages, agent executions,
  delegation conversations, workflow executions, logs, traces, memory audits,
  and tool-call records, not only records already marked failed.

### 2.2 Built-In Agent-Led Workflow Trigger

The hourly cron target is the built-in workflow
`allen-self-healing-monitor-hourly`. Backend code does not analyze incidents,
create Linear tickets, or route bug-fix work. It only starts the workflow and exposes
safe Allen MCP tools for agents.

Add a compatibility service file:

- `packages/server/src/services/self-healing-monitor.service.ts`

Export:

- `createSelfHealingMonitorScanAction(db)`

Register it in `packages/server/src/app.ts` only as a compatibility action for
older seeded cron rows or manual calls.

The compatibility action launches the agent-led workflow and returns a short
cron-run note:

```text
launched workflow=allen-self-healing-monitor-hourly execution=<execution-id>
```

### 2.3 Built-In Agents

Add these agents to `OrgSeedService` in
`packages/server/src/services/org-seed.ts`. They must be marked built-in by the
normal seed path.

| Agent | Team | Type | Purpose |
|---|---|---|---|
| `allen-monitoring-agent` | engineering | technical | Plans scans, collects evidence through Allen MCP tools, analyzes logs/messages/traces/tool calls, persists evidence bundles, and decides whether an issue is Allen-owned. |
| `allen-incident-router` | engineering | team | Deduplicates incidents, creates/updates Linear tickets through Linear MCP tools, chooses bug-fix or triage target, and dispatches `bug-investigate-and-fix` through Allen MCP. |
| `allen-memory-diagnostician` | engineering | technical | Specializes in learning extraction, embedding, retrieval, and prompt-injection failures. |
| `allen-tooling-diagnostician` | engineering | technical | Specializes in MCP, tool schema, tool allowlist, env propagation, and artifact/workspace context failures. |
| `allen-workflow-diagnostician` | engineering | technical | Specializes in workflow YAML, engine node execution, traces, retries, conditions, and stuck workflow states. |
| `allen-prompt-instruction-diagnostician` | engineering | technical | Specializes in agent prompts, system instructions, non-interactive guidance, workflow node prompts, and memory/tool instructions that cause wrong behavior despite successful completion. |

Seeded delegation updates:

- Add these agents to `engineering-lead.canDelegateTo`.
- Add `allen-incident-router` to `ceo.canDelegateTo` if executive escalation is
  needed.
- Keep all diagnosis agents as built-in members of the Engineering team.

### 2.4 Built-In Workflows

Add these workflow YAML files under `packages/engine/workflows/` so they are
seeded by `seedDefaultWorkflows()`:

| Workflow | Purpose |
|---|---|
| `self-healing-incident-triage` | Given an incident ID, hydrate evidence, classify root cause, decide actionability, update incident state, and create/update Linear. Mostly analysis and routing; no code changes. |
| `bug-investigate-and-fix` | Given a synthesized incident bug report, create an isolated worktree for the Allen repo, run investigation, fix, tests, review, and PR creation. |

Update `cleanupOrphanedSeedEntities()` keep list in `packages/server/src/app.ts`
so these built-in workflows are not deleted on boot.

## 3. Backend Implementation

### 3.1 Monitoring Service

Create `MonitoringService` in
`packages/server/src/services/self-healing-monitor.service.ts`.

Responsibilities:

- Scan candidate records.
- Hydrate full context.
- Classify incidents.
- Redact evidence.
- Deduplicate by fingerprint.
- Create or update Linear issues.
- Route repair work.
- Persist incident status.

Public methods:

```ts
scan(args: MonitoringScanArgs): Promise<MonitoringScanResult>
handleEvent(event: MonitoringEvent): Promise<void>
classify(candidate: MonitoringCandidate): Promise<MonitoringClassification>
ticket(incident: MonitoringIncident): Promise<MonitoringTicketResult>
route(incident: MonitoringIncident): Promise<MonitoringRouteResult>
```

### 3.2 Candidate Scanners

Add scanner modules or private methods for:

- Chat failures from `chat_messages` and `chat_logs`.
- Chat conversations and messages across completed, failed, interrupted,
  cancelled/canceled, streaming/stale, and empty/truncated assistant outputs.
- Spawned agent executions from `executions` where `workflowName` contains
  `:spawn_agent/`, across completed, failed, cancelled/canceled, and stale
  running statuses.
- Delegations from `agent_conversations` and `agent_activity`, across completed,
  failed, waiting, active/stale, and cancelled/canceled behavior.
- Workflow executions from `executions`, `execution_traces`, `execution_logs`,
  and `execution_failure_reports`.
- Memory failures from `learnings`, embedding gaps, and new
  `memory_injection_audits`.
- MCP/tool failures from chat tool calls, execution logs, and MCP discovery
  warning/error paths.
- Linear dispatch failures from local ticket assignments and failed dispatch
  execution IDs.
- Prompt/instruction failures from completed and failed chats/agents/workflows
  where evidence shows wrong tool usage, skipped required waits, bad delegation,
  missing artifact guidance, bad non-interactive guidance, wrong memory
  instruction, or workflow node prompt mismatch.

### 3.3 Context Hydration

For every candidate, hydrate:

- source IDs and timestamps
- user/assistant excerpts
- execution record
- failure report
- traces and execution logs
- tool calls and tool results
- agent conversation messages and activity
- workspace and repo metadata
- learning IDs, retrieved/injected memories, embedding status
- related Linear assignment and dispatch status

Cap raw excerpts and store links/IDs for full inspection.

### 3.4 Deterministic Classification

Start with rule-based classifications:

- `status: failed` + internal module path in error → `allen_repo`.
- missing `ALLEN_CHAT_SESSION_ID`, artifact root, workspace path, or MCP env →
  `tool_integration`.
- memory expected but audit record missing → `memory_system`.
- max retries exceeded or malformed workflow node output →
  `workflow_definition` or `allen_repo` depending on trace evidence.
- user cancellation → `ignore`.
- external API outage surfaced cleanly → `alert_only`.

The final classification is made by `allen-monitoring-agent`. Backend tools may
filter and fetch records, but they must not make root-cause or ticketing
decisions.

### 3.5 Deduplication

Add `monitoring_incidents` collection.

Unique fingerprint fields:

- `sourceType`
- normalized error message
- root cause area
- workflow and node
- agent
- tool/server
- top internal module path
- failure mode

Use `findOneAndUpdate(..., upsert: true)` with `$setOnInsert` and `$inc` to make
dedupe safe when many failures happen at once.

### 3.6 Linear Ticketing Through MCP

Linear tickets are created and updated by `allen-incident-router` through Linear
MCP tools:

```text
mcp__linear__linear_search_issues
mcp__linear__linear_create_issue
mcp__linear__linear_create_comment
mcp__linear__linear_edit_issue
```

Backend `LinearService` must not be the self-healing ticket creator. The backend
only exposes Allen state tools and workflow execution; agents decide and perform
Linear actions.

Required Linear ticket destination env vars. There are no code defaults, and
the monitor must not run unless all are set:

- `ALLEN_SELF_HEALING_LINEAR_TEAM_KEY`
- `ALLEN_SELF_HEALING_LINEAR_PROJECT_NAME`
- `ALLEN_SELF_HEALING_ASSIGNEE_EMAIL`
- labels: `monitoring`, `auto-created`, `self-healing`, source type

### 3.7 Repair Router

Routing table:

| Root Cause | Source Type | Target |
|---|---|---|
| `memory_system` | memory/chat/agent | workflow `bug-investigate-and-fix` |
| `tool_integration` | tool_call/mcp/chat/agent | workflow `bug-investigate-and-fix` |
| `workflow_definition` | workflow_execution | workflow `bug-investigate-and-fix` |
| `agent_prompt` | chat/agent/delegation/workflow_execution | workflow `bug-investigate-and-fix` |
| `instruction_bug` | chat/agent/delegation/workflow_execution/tool_call | workflow `bug-investigate-and-fix` |
| `allen_repo` | any | workflow `bug-investigate-and-fix` |
| `unknown` with high severity | any | agent `allen-incident-router` |

Auto-dispatch rules:

- Dispatch only when confidence >= `0.70`.
- Dispatch only once per incident unless manually redispatched.
- Use the registered Allen repo path automatically.
- Create or reuse a workspace branch from the Linear issue identifier.
- Store `dispatchExecutionId`, workflow/agent target, and status on
  `monitoring_incidents`.

## 4. Data Model and Indexes

Add indexes in `packages/server/src/database/indexes.ts`:

```ts
await db.collection('monitoring_incidents').createIndex({ fingerprint: 1 }, { unique: true });
await db.collection('monitoring_incidents').createIndex({ status: 1, lastSeenAt: -1 });
await db.collection('monitoring_incidents').createIndex({ sourceType: 1, lastSeenAt: -1 });
await db.collection('monitoring_incidents').createIndex({ linearIssueId: 1 });
await db.collection('monitoring_incidents').createIndex({ dispatchExecutionId: 1 });

await db.collection('memory_injection_audits').createIndex({ rootType: 1, rootId: 1 });
await db.collection('memory_injection_audits').createIndex({ agentName: 1, createdAt: -1 });
await db.collection('memory_injection_audits').createIndex({ createdAt: -1 });
```

Incident statuses:

- `new`
- `analyzed`
- `ticketed`
- `updated_existing`
- `dispatched`
- `in_progress`
- `resolved`
- `ignored`
- `suppressed`
- `failed_to_ticket`
- `failed_to_dispatch`

## 5. Event Hooks

Add non-blocking hooks that call `MonitoringService.handleEvent(...).catch(...)`.

Hook locations:

- `ChatService.runLLM()` catch path.
- `ChatService.runLLM()` tool result handling when result contains errors.
- `runDelegationInBackground()` failure, timeout, and non-zero exit paths.
- Spawn-agent failure paths in `chat-tools.ts`.
- `AllenEngine.run()`, `resumeFromCheckpoint()`, and `retryFromNode()` failure
  paths.
- `StateManager.saveFailureReport()`.
- MCP discovery failure path in `ExecutionService.launchExecution()`.
- Learning extraction/retrieval/prompt-injection paths.
- Linear dispatch `finishDispatch()` failure path.

Hooks should enqueue/record lightweight events only. The hourly scanner/action
hydrates full context and is authoritative for whether to ticket or dispatch.

## 6. Memory Audit Implementation

Add explicit memory-injection audit writes where memory is loaded into prompts:

- `ChatService.getSystemPrompt()`
- `ChatService.buildAgentSystemPrompt()`
- engine learning injection points in `AllenEngine`/`LearningManager`

Audit row fields:

- root type and root ID
- agent name
- user query or prompt context hash
- retrieved learning IDs and scores
- injected learning IDs
- token count
- timestamp

This closes the current audit gap where `LearningService.forExecution()` cannot
report injected memory.

## 7. API and UI

Backend routes:

- `GET /api/monitoring/incidents`
- `GET /api/monitoring/incidents/:id`
- `POST /api/monitoring/incidents/:id/ignore`
- `POST /api/monitoring/incidents/:id/suppress`
- `POST /api/monitoring/incidents/:id/ticket`
- `POST /api/monitoring/incidents/:id/dispatch`
- `POST /api/monitoring/scan`

UI:

- Add Monitoring page or extend Alerts.
- Show source type, severity, count, status, last seen, Linear link, dispatch
  execution, and confidence.
- Incident detail shows redacted evidence and related Allen links.

## 8. Testing Plan

Unit tests:

- fingerprint normalization
- redaction
- deterministic classifiers
- dedupe upsert behavior
- Linear ticket payload generation
- routing target selection
- cron action result summaries

Integration tests:

- failed chat creates one incident and one ticket
- repeated same failure updates existing incident/ticket
- failed workflow hydrates failure report and traces
- memory audit missing/injection mismatch creates memory incident
- tool result error creates tooling incident
- auto-dispatch starts the correct built-in workflow

E2E/manual:

- Force a chat tool failure.
- Force a workflow node failure.
- Force a delegated agent timeout/failure.
- Verify ticket content, dedupe, route, dispatch execution, and UI links.

## 9. Rollout Order

1. Add data model, indexes, redaction, and `MonitoringService` skeleton.
2. Add Linear write methods.
3. Add passive scanners and hourly built-in cron job with `autoDispatch=false`
   in development.
4. Add event hooks.
5. Add memory injection audit records.
6. Add built-in diagnosis agents.
7. Add triage and bug-fix workflow routing.
8. Enable auto-dispatch for confidence >= 0.70.
9. Add UI controls.
10. Add recurrence checks to the hourly scanner.

## 10. File-Level Work Breakdown

Backend:

- `packages/server/src/services/self-healing-monitor.service.ts`
- `packages/server/src/services/linear.service.ts`
- `packages/server/src/services/cron-seed.service.ts`
- `packages/server/src/app.ts`
- `packages/server/src/database/indexes.ts`
- `packages/server/src/routes/monitoring.routes.ts`
- `packages/server/src/services/chat.service.ts`
- `packages/server/src/services/chat-tools.ts`
- `packages/server/src/services/execution.service.ts`
- `packages/server/src/services/learning.service.ts`

Engine:

- `packages/engine/src/engine.ts`
- `packages/engine/src/state-manager.ts`
- `packages/engine/src/learning-manager.ts`
- `packages/engine/workflows/self-healing-incident-triage.yml`
- `packages/engine/workflows/bug-investigate-and-fix.yml`

Seeds:

- `packages/server/src/services/org-seed.ts`
- `packages/server/src/app.ts` workflow cleanup keep list

UI:

- `packages/ui/src` monitoring routes/page/components, following existing
  Alerts/Executions patterns.

Docs:

- `docs/plans/self-healing-monitoring-agent-prd.md`
- `docs/plans/self-healing-monitoring-agent-implementation-plan.md`

## 11. Definition of Done

- Built-in hourly cron job exists after boot and runs without manual setup.
- Built-in monitor/router/diagnosis agents exist after boot.
- Built-in self-healing workflows exist after boot and are protected from seed
  cleanup.
- Completed, failed, cancelled/canceled, and stale chats, agents, delegations,
  workflows, memory issues, logs, traces, messages, and tool/MCP calls can
  produce deduplicated incidents when evidence shows actionable Allen-owned
  behavior.
- Prompt and instruction defects in Allen built-in agents, workflow node prompts,
  system guidance, memory guidance, and tool-use guidance can be detected,
  ticketed, routed, fixed, tested, and shipped through the same loop.
- Actionable Allen-owned incidents create or update Linear issues using the
  Linear team, project, and assignee configured in required env vars.
- Auto-dispatch can start the built-in bug-fix workflow or built-in
  routing agent.
- Monitoring failures never break the original user-facing chat/agent/workflow.
