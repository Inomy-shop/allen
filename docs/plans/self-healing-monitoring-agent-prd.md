# Self-Healing Monitoring Agent PRD

> Status: draft · owner: allen · last updated: 2026-05-01  
> Linear: ENG-1472 — Add monitoring agent to auto-create Linear issues for chat, agent, and workflow execution errors
> Implementation plan: `docs/plans/self-healing-monitoring-agent-implementation-plan.md`

## 1. Executive Summary

Allen should be able to improve Allen from its own runtime failures. When a
chat conversation, agent execution, lead-agent delegation, workflow execution,
memory injection, tool call, or MCP integration fails, Allen must analyze the
complete available runtime context, decide whether the failure is caused by an
actionable issue in the Allen repo, create a Linear ticket with diagnostic
evidence, and route the ticket to the correct bug-fix or triage path automatically.
The check runs every 1 hour and covers completed, failed, cancelled/canceled,
interrupted, and stale records because Allen issues can appear even when a run
technically completes.
Each run scans all eligible records created or updated since the last successful
scan, with overlap for late logs/traces, not only records already marked failed.

The product goal is not generic alerting. The goal is a closed feedback loop:

1. Observe Allen behavior across chat, agents, workflow runs, memory, tools,
   and delegations.
2. Diagnose whether something went wrong and whether the cause is likely in
   Allen code, configuration, prompts, workflow definitions, agent definitions,
   or repo-owned integration logic.
3. Create or update one deduplicated Linear issue in the Allen project with
   enough context for an agent or human to reproduce and fix it.
4. Automatically route the issue to the right agent, lead agent, or workflow
   run so Allen can repair itself.

## 2. Problem Statement

Allen currently stores rich operational data in multiple collections and logs,
but failures still require a human to notice, inspect traces, decide whether the
root cause belongs to Allen, create a Linear ticket, and dispatch an agent or
workflow. This breaks the promise that Allen can operate as an autonomous
software organization.

The failure modes are broader than explicit `status: failed` runs. Examples:

- Chat assistant cannot respond, times out, enters a broken resume state, or
  returns an internal tool error.
- A spawned agent or delegated agent fails, hangs, asks an unanswerable question,
  uses the wrong context, or loses its chat/workspace linkage.
- A workflow fails at a node, produces malformed outputs, retries until max
  retries are exceeded, or leaves an execution stuck.
- Memory is not extracted, not embedded, not retrieved, or the wrong memory is
  injected into prompts.
- Tool calls fail because Allen registered the wrong tool schema, hid MCP tools,
  used bad environment variables, dropped chat session context, or failed to
  route artifact/workspace IDs.
- Linear dispatch creates a ticket or assignment but the downstream agent or
  workflow does not actually start.
- Allen prompts, workflow node prompts, system instructions, delegation
  instructions, memory guidance, or tool-use instructions cause wrong behavior,
  skipped steps, bad routing, missing waits, wrong tool usage, or missing
  artifacts.

## 3. Goals

- Run a comprehensive monitoring check every 1 hour across chat conversations,
  chat logs, messages, tool calls, agent executions, lead-agent delegations,
  workflow executions, logs, traces, memory behavior, and workflow/tool
  behavior.
- Include completed, failed, cancelled/canceled, interrupted, and stale records
  in the scan.
- Analyze the full available evidence for each candidate incident, including
  user message, assistant message, tool call arguments and results, execution
  logs, traces, node metadata, agent conversation messages, timestamps,
  workspace/repo context, memory records, and related errors.
- Create Linear issues only for actionable problems likely caused by Allen-owned
  code, configuration, prompts, instructions, workflow definitions, agent
  definitions, or integration glue.
- Deduplicate recurring failures so Allen updates or groups an existing issue
  instead of spamming Linear.
- Route created or reopened issues to the appropriate bug-fix or triage target:
  bug-fix workflow, engineering lead, specialist agent, workflow-definition
  maintainer, or integration agent.
- Preserve enough evidence in the ticket for an agent to reproduce and act
  without requiring a human to manually inspect MongoDB or server logs.

## 4. Non-Goals

- Do not create Linear tickets for expected user cancellations, user mistakes,
  unsupported requests, insufficient user input, or external outages unless
  Allen mishandled them.
- Do not auto-edit production code directly from the monitor. The monitor opens
  and routes work; repair happens through the existing agent/workflow dispatch
  path.
- Do not send raw secrets, access tokens, private credentials, or unredacted
  large logs to Linear.
- Do not replace the current Alerts UI. Alerts remain useful for immediate
  operator visibility; this feature adds diagnosis, ticketing, and dispatch.

## 5. Primary Users

- Allen operators who need automatic triage and repair of production issues.
- Engineering agents that receive actionable Linear tickets with full context.
- Lead agents that coordinate repair work across specialist agents.
- Human engineers who review, prioritize, or merge resulting fixes.

## 6. Trigger Sources

### 6.1 Chat Conversations

Monitor:

- `chat_messages` with `status: completed`, `failed`, `cancelled`,
  `canceled`, `interrupted`, missing completion, or long-running streaming
  state.
- `chat_logs` with `status: failed`, error fields, timeout retries, malformed
  traces, or repeated tool failures.
- Tool call records where result contains `error`, empty output for required
  data, schema mismatch, authorization failure caused by Allen config, or
  unexpected internal exception.
- Chat sessions where assistant response is empty, truncated, duplicated,
  inconsistent with tool results, follows the wrong instruction, skips a
  required wait, or fails to use expected memory/tool context.

### 6.2 Agent Executions

Monitor:

- Spawned agent executions, identified by workflow names containing
  `:spawn_agent/`.
- Execution records with `status: completed`, `failed`, `cancelled`,
  `canceled`, suspiciously long `running`, or repeated timeout/retry patterns.
- Agent runs that completed but produced no useful output, failed to save
  expected artifacts, lost workspace context, or could not access expected MCP
  tools.
- Agent runs that completed but show prompt/instruction defects, including wrong
  delegation, skipped tool waits, wrong memory use, missing artifact guidance,
  or incorrect non-interactive behavior.
- Agent process failures from `chat-tools.ts`, including non-zero exits, idle
  timeouts, total timeouts, SIGKILL after ignored SIGTERM, and missing session
  IDs.

### 6.3 Lead-Agent Delegations

Monitor:

- `agent_conversations` with `status: completed`, `failed`, stale `active`,
  stale `waiting_for_answer`, missing response, or repeated question loops.
- `agent_activity` for delegation events, tool errors, stalled streams, and
  routing mismatches.
- Cases where a lead agent delegates to the wrong specialist, fails to wait for
  completion, responds before delegations finish, or follows bad delegation
  instructions.

### 6.4 Workflow Executions

Monitor:

- `executions` with completed, failed, cancelled/canceled, or stuck statuses.
- `execution_traces` for node-level failures, malformed structured outputs,
  retry loops, bad condition evaluation, and max retry exhaustion.
- `execution_logs` for node, tool, or engine errors.
- `execution_failure_reports` for already-normalized diagnostics.
- Human intervention records when a workflow pauses unexpectedly or never
  resumes after valid input.

### 6.5 Memory and Learning

Monitor:

- Learnings that should have been extracted but were not created.
- Learnings created with wrong scope, tags, source metadata, confidence, or
  status.
- Embedding failures, missing embeddings, and retrieval returning irrelevant or
  stale memories.
- Prompt injection failures where expected memory blocks are absent from agent
  or chat prompts.
- Prompt/instruction failures where the injected memory or instruction text is
  present but causes wrong behavior and therefore requires an Allen prompt or
  instruction change.
- `LearningService.forExecution()` limitations where injected memory cannot be
  audited; the PRD requires adding explicit memory-injection audit records.

### 6.6 MCP and Tool Infrastructure

Monitor:

- MCP tool discovery failures.
- Tool allowlist gaps where Linear, GitHub, Postgres, or Allen tools are
  configured but not visible to an agent.
- Tool schema mismatches, invalid arguments, missing env propagation, and
  missing chat/session/workspace/artifact root context.
- Workflow built-in failures and code-node exceptions.

## 7. Diagnosis Requirements

The monitor must classify every candidate incident before ticket creation.

### 7.1 Incident Classification

Each incident receives:

- `sourceType`: `chat`, `agent_execution`, `delegation`, `workflow_execution`,
  `memory`, `tool_call`, `mcp`, `linear_dispatch`, or `system`.
- `severity`: `critical`, `high`, `medium`, `low`.
- `actionability`: `create_ticket`, `update_existing_ticket`, `alert_only`,
  `ignore`.
- `rootCauseArea`: `allen_repo`, `agent_prompt`, `workflow_definition`,
  `instruction_bug`, `workflow_definition`, `memory_system`,
  `tool_integration`, `external_dependency`, `user_input`, `unknown`.
- `confidence`: numeric score from 0 to 1.
- `routingTarget`: lead agent, specialist agent, workflow, or human owner.

### 7.2 Allen-Owned Issue Rules

Create a ticket when evidence indicates:

- Allen code threw an exception, timed out incorrectly, or mishandled a retry.
- Allen failed to pass required context such as chat session ID, workspace path,
  artifact root, MCP environment, or execution ID.
- Allen prompts or agent definitions caused systematic misuse of tools,
  delegation, memory, or workflow routing.
- Allen instructions, non-interactive guidance, workflow node prompts, memory
  guidance, or tool-use guidance caused wrong behavior even if the run completed.
- Allen workflow YAML or node definitions produced invalid state transitions,
  missing inputs, bad conditions, or malformed expected outputs.
- Allen memory extraction, embedding, retrieval, or prompt injection failed.
- Linear dispatch, ticket assignment, or workflow dispatch logic failed after
  Allen accepted responsibility for the action.

Do not create a ticket when evidence indicates:

- The user cancelled the run intentionally.
- The user asked for something unsupported and Allen responded correctly.
- A third-party API outage occurred and Allen already surfaced the issue
  correctly.
- A repo under work was broken, but Allen orchestration behaved correctly.
- The same incident is already covered by an open issue and only needs a count
  or comment update.

## 8. Linear Ticket Requirements

Tickets must be created under the Linear team/project/assignee configured in
required env vars. There are no code defaults. If any destination env var is
missing, the monitor must not run.

Each ticket must include:

- Title: concise failure category plus affected surface.
- Source type and severity.
- First seen and last seen timestamps.
- Reproduction or trigger summary.
- User message excerpt when relevant.
- Chat session ID, chat message ID, execution ID, workflow name, node name,
  agent name, conversation ID, workspace ID, and repo path when available.
- Error summary and normalized stack/log excerpts.
- Relevant tool call names, arguments summary, result summary, and failure
  signature.
- Memory diagnostics when memory was involved: expected memory, injected memory,
  retrieval scores, learning IDs, embedding status, and prompt block presence.
- Links to Allen UI routes for chat, execution, workflow, agent conversation,
  workspace, and artifact records when available.
- Deduplication fingerprint.
- Proposed routing target and recommended workflow/agent to run.
- Redaction note confirming secrets and oversized logs were omitted.

## 9. Deduplication and Grouping

Create a deterministic fingerprint from:

- `sourceType`
- normalized error message
- root cause area
- workflow name and node name, if present
- agent name, if present
- tool name, if present
- stack top frame or internal module path, if present
- failure mode, such as timeout, schema mismatch, missing context, or bad
  memory injection

For an open matching issue:

- Add or update a comment with latest occurrence count, latest IDs, and new
  evidence.
- Update an internal `monitoring_incidents` record with count and last seen.
- Do not create a new Linear issue.

For a closed matching issue:

- Reopen or create a follow-up issue depending on Linear state and recurrence
  policy.

## 10. Routing Requirements

After a ticket is created or updated, the monitor should determine the repair
path.

### 10.1 Routing Examples

- Chat service failure → engineering lead or backend agent.
- Tool call schema/dispatch failure → bug-fix workflow or integration/tooling agent.
- Workflow YAML/node issue → bug-fix workflow or workflow maintainer.
- Memory extraction/injection failure → bug-fix workflow or memory-system agent.
- Agent prompt/delegation behavior → agent-builder or team lead.
- Prompt/instruction behavior → bug-fix workflow.
- Linear dispatch failure → Linear integration agent or backend agent.

### 10.2 Dispatch Behavior

The first version may assign only in Linear and create a local assignment record.
The full version must be able to:

- Dispatch an issue to an existing agent using the Linear dispatch flow.
- Dispatch an issue to a bug-fix workflow with the Allen repo selected.
- Start a lead-agent delegation when the issue spans multiple subsystems.
- Track the bug-fix execution ID back on the ticket and incident record.

## 11. Product Workflow

1. A chat, agent, workflow, memory, or tool event is written to MongoDB/logs.
2. Monitoring scanner receives or polls the event.
3. Scanner builds a candidate incident from full context.
4. Analyzer enriches the incident with related logs, traces, messages, memory
   records, tool calls, repo/workspace metadata, and prior similar incidents.
5. Analyzer classifies root cause, actionability, confidence, severity, and
   routing target.
6. Deduper checks `monitoring_incidents` and Linear issue metadata.
7. If actionable and unique, Linear ticket is created.
8. If duplicate, existing ticket receives a compact update.
9. Router dispatches or assigns the work to the correct Allen bug-fix or triage path.
10. Bug-fix execution status is tracked and linked back to the incident.

## 12. Data Model Requirements

Add `monitoring_incidents`:

- `fingerprint`
- `sourceType`
- `severity`
- `status`: `new`, `ticketed`, `dispatched`, `in_progress`, `resolved`,
  `ignored`, `suppressed`
- `rootCauseArea`
- `confidence`
- `title`
- `summary`
- `firstSeenAt`
- `lastSeenAt`
- `occurrenceCount`
- `linearIssueId`
- `linearIdentifier`
- `linearUrl`
- `routingTarget`
- `dispatchExecutionId`
- `relatedIds`: chat session, message, execution, trace, workflow, node, agent,
  conversation, workspace, repo, tool call IDs
- `evidence`: compact redacted diagnostic payload
- `redactions`: list of redaction categories applied
- `createdAt`
- `updatedAt`

Add `memory_injection_audits`:

- `rootType`: `chat`, `workflow_execution`, `agent_execution`
- `rootId`
- `agentName`
- `promptContextHash`
- `query`
- `retrievedLearningIds`
- `retrievalScores`
- `injectedLearningIds`
- `injectedTokenCount`
- `createdAt`

Add indexes:

- `monitoring_incidents.fingerprint` unique
- `monitoring_incidents.status + lastSeenAt`
- `monitoring_incidents.sourceType + lastSeenAt`
- `monitoring_incidents.linearIssueId`
- `memory_injection_audits.rootType + rootId`
- `memory_injection_audits.agentName + createdAt`

## 13. System Design Requirements

### 13.1 Monitoring Service

Add a server-side `MonitoringService` responsible for:

- Polling recent failed/stale records and accepting event hooks.
- Hydrating complete context for each candidate incident.
- Calling the analyzer.
- Calling Linear creation/update.
- Calling routing/dispatch.
- Recording incident state.

### 13.2 Event Hooks

Wire best-effort hooks into:

- `ChatService.runLLM()` failure path and tool result handling.
- `runDelegationInBackground()` success/failure/timeout paths.
- Spawn-agent execution creation and failure paths in `chat-tools.ts`.
- `AllenEngine.run()` and resume/retry failure paths.
- `StateManager.saveFailureReport()`.
- MCP discovery and tool execution failure surfaces.
- Learning extraction, embedding, retrieval, and prompt-injection paths.

Hooks must never block user-facing execution. If monitoring fails, it should log
and continue.

### 13.3 Scanner

Add a periodic cron trigger using the existing cron infrastructure. The trigger
starts the `allen-self-healing-monitor-hourly` workflow. Agent duties:

- Catch incidents missed by hooks.
- Detect stuck states based on age thresholds.
- Reprocess incidents when new context arrives.
- Enforce dedupe and suppression windows.

### 13.4 Analyzer

The analyzer is `allen-monitoring-agent`:

- Use Allen MCP monitoring tools to fetch raw records, logs, traces, messages,
  tool calls, and memory audits.
- Decide Allen-owned versus external/user-owned causes from the full evidence.
- Summarize evidence, identify likely root cause, and propose routing.
- Store analyzer input/output for auditability, with redaction.

### 13.5 Linear Writer

Linear ticket creation and commenting are performed by `allen-incident-router`
through Linear MCP tools, not backend `LinearService`. The router must:

- Create issue in Engineering team and Allen project.
- Assign user by email or configured user ID.
- Add labels such as `monitoring`, `auto-created`, `self-healing`, and source
  type.
- Add comments to existing issues for duplicate occurrences.
- Optionally reopen closed issues.

### 13.6 Repair Router

The router should use existing agent/workflow dispatch capabilities rather than
inventing a separate execution system. It should:

- Select a target based on source type and root cause area.
- Prefer the Allen repo path automatically.
- Create or reuse a workspace branch named from the Linear issue.
- Dispatch a bug-fix workflow or spawn the selected agent.
- Store dispatch metadata in both `monitoring_incidents` and local Linear
  assignment records.

## 14. Configuration

Required:

- Linear API token configured via existing `ALLEN_LINEAR_ACCESS_TOKEN` secret.
- `ALLEN_SELF_HEALING_LINEAR_TEAM_KEY`.
- `ALLEN_SELF_HEALING_LINEAR_PROJECT_NAME`.
- `ALLEN_SELF_HEALING_ASSIGNEE_EMAIL`.
- Allen repo ID/path.

Optional:

- Severity thresholds.
- Stuck execution thresholds by source type.
- Dedupe suppression window.
- Auto-dispatch enabled/disabled.
- LLM analyzer enabled/disabled.
- Maximum Linear comments per incident per day.
- Redaction patterns.

## 15. UX Requirements

### 15.1 Operator Visibility

Add a monitoring view or extend Alerts/Executions with:

- Incident list with status, severity, source type, count, last seen, and Linear
  link.
- Incident detail with evidence, classification, dedupe fingerprint, related
  records, and dispatch status.
- Manual controls: ignore, suppress, create ticket, reroute, redispatch,
  mark resolved.

### 15.2 Ticket Readability

Tickets must be compact enough to scan but complete enough to act. Long logs
should be summarized in Linear and linked to Allen records rather than pasted in
full.

## 16. Security and Privacy

- Redact secrets, tokens, Authorization headers, cookies, env vars, private keys,
  and credential-like strings before storing evidence or writing Linear tickets.
- Cap log excerpts by size.
- Store full raw evidence only in Allen-controlled storage if needed; Linear gets
  summarized and redacted evidence.
- Avoid including entire user conversations when a short excerpt is sufficient.
- Ensure the monitor cannot recursively create unlimited tickets for its own
  ticket-creation failures.

## 17. Reliability Requirements

- Monitoring must be best effort and must not degrade chat, agent, or workflow
  latency.
- Linear failures must retry with backoff and preserve pending incidents.
- Deduplication must be transaction-safe enough to prevent ticket storms during
  repeated failures.
- Scanner must be idempotent.
- Auto-dispatch must have a feature flag and concurrency limits.
- The monitor must suppress known noisy failures after an operator marks them
  ignored or non-actionable.

## 18. Metrics

Track:

- Candidate incidents detected by source type.
- Tickets created, updated, suppressed, ignored.
- Duplicate suppression rate.
- False positive and false negative rate from manual review labels.
- Time from failure to ticket.
- Time from ticket to dispatch.
- Time from dispatch to fix PR.
- Repair execution success/failure rate.
- Recurrence after issue closed.
- Memory injection audit coverage.

## 19. Acceptance Criteria

- Failed chat responses can create a deduplicated Linear ticket with chat IDs,
  user message summary, tool failures, error text, and Allen route links.
- Failed spawned agents can create a deduplicated Linear ticket with execution
  ID, agent name, workflow name, prompt summary, logs, tool calls, and workspace
  context.
- Failed or stuck delegations can create a ticket with conversation ID,
  from-agent, to-agent, task summary, messages, activity, and failure mode.
- Failed workflows can create a ticket with execution ID, workflow name, failed
  node, failure report, trace/log summary, retry counts, and state summary.
- Completed chats, agent runs, delegations, or workflows can create a ticket
  when logs, traces, messages, tool calls, or outputs show wrong Allen behavior.
- Prompt/instruction issues can create a ticket and route to bug-investigate-and-fix
  to change Allen prompts, workflow node prompts, system guidance,
  memory guidance, or tool-use instructions.
- Memory retrieval/injection failures can create a ticket with expected versus
  actual memory evidence and learning IDs.
- Tool/MCP failures can create a ticket with tool name, server name, schema/env
  context, arguments summary, result summary, and suspected Allen module.
- Duplicate failures update the existing issue or incident record instead of
  creating repeated Linear issues.
- Created issues use the required Linear team, project, and assignee env vars.
- Auto-routing can dispatch at least one created issue to bug-investigate-and-fix
  and persist the dispatch execution ID.
- Monitoring failures do not break the original chat, agent, or workflow run.

## 20. Rollout Plan

### Phase 1: Passive Detection and Ticket Creation

- Add `MonitoringService`, incident store, indexes, redaction, and rule-based
  detection for failed chats, failed executions, failed delegations, and failed
  workflows.
- Add Linear create/comment support.
- Add dedupe fingerprints.
- Keep auto-dispatch disabled.

### Phase 2: Context-Rich Analysis

- Hydrate full logs, traces, tool calls, messages, failure reports, and memory
  records.
- Add LLM-assisted summaries and root-cause classification.
- Add monitoring UI for incidents.
- Add memory injection audit records.

### Phase 3: Auto-Routing

- Add routing table from source/root cause to agent or workflow.
- Dispatch to existing Linear agent/workflow flow.
- Track bug-fix execution and update incidents.

### Phase 4: Self-Improving Loop

- Learn from resolved/ignored incidents to reduce false positives.
- Detect recurrence after fix.
- Comment on Linear when an incident recurs after closure.
- Add dashboards for self-healing performance.

## 21. Open Questions

- Should the monitor create tickets directly through server-side Linear SDK, MCP
  tools, or both? Server-side SDK is preferred for reliability and permissions.
- Which existing agent should own initial repair routing for ambiguous Allen
  platform issues?
- Should auto-dispatch be enabled only in development/staging first?
- What labels should be created in Linear for source type and self-healing
  status?
- Should resolved incidents auto-close when the linked repair PR merges, or only
  after recurrence checks pass?
