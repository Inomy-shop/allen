# Allen Self-Healing Monitoring

Allen has a built-in, agent-led self-healing loop that watches Allen's own
runtime behavior and turns actionable Allen-owned issues into Linear repair
work.

## What It Does

Every hour, Allen starts the `allen-self-healing-monitor-hourly` workflow. The
workflow agents inspect recent and updated runtime records across:

- chat conversations and messages
- chat logs
- spawned agent executions
- lead-agent delegation conversations
- workflow executions
- execution logs
- execution traces
- execution failure reports
- tool calls and MCP records
- memory/learning records and memory injection audits
- Linear dispatch and local ticket-assignment records

The agent-led scan includes `completed`, `failed`, `cancelled`/`canceled`,
`interrupted`, and stale running/waiting records. Completed records are included
because a run can technically finish while still doing the wrong thing, such as
using the wrong tool, skipping a required wait, losing workspace context,
injecting the wrong memory, failing to save artifacts, or following bad
instructions.

## Hourly Cron Job

The built-in cron job is seeded at server startup:

```text
name: allen-self-healing-monitor-hourly
schedule: 17 * * * *
timezone: UTC
target: workflow allen-self-healing-monitor-hourly
```

It runs once per hour. The cron only starts the monitoring workflow. Agents use
Allen MCP tools to read the previous scan cursor, choose the scan window, fetch
evidence, and update the cursor after the scan closes.

On first boot, it backfills the most recent 24 hours.

## End-To-End Flow

1. A chat, agent, delegation, workflow, memory operation, tool call, MCP call, or
   Linear dispatch completes, fails, is cancelled, or becomes stale.
2. Allen stores runtime evidence in MongoDB collections such as
   `chat_messages`, `chat_logs`, `executions`, `execution_traces`,
   `execution_logs`, `execution_failure_reports`, `agent_conversations`,
   `agent_activity`, `learnings`, `memory_injection_audits`, and
   `ticket_assignments`.
3. The hourly cron starts the `allen-self-healing-monitor-hourly` workflow.
4. `allen-monitoring-agent` plans the scan and collects raw evidence through
   Allen MCP monitoring tools.
5. `allen-monitoring-agent` analyzes the evidence and persists evidence bundles
   and incident decisions.
6. `allen-incident-router` deduplicates against existing monitoring incidents
   and Linear issues.
7. `allen-incident-router` creates or updates Linear issues through Linear MCP
   tools. Backend code does not directly create the Linear ticket.
8. `allen-incident-router` chooses the repair route and starts the selected
   built-in repair workflow through Allen MCP `run_workflow`.
9. The repair workflow creates an isolated worktree, diagnoses the issue,
   implements the fix, validates it, and opens a PR.
10. Agents write Linear metadata, routing, dispatch execution ID, evidence, and
    status back to `monitoring_incidents`.

## What Counts As Allen-Owned

The monitoring agents create tickets for problems likely caused by:

- Allen repo code
- Allen runtime configuration
- built-in agent prompts
- workflow node prompts
- system instructions
- delegation instructions
- non-interactive execution guidance
- memory guidance or prompt injection
- tool-use instructions
- workflow definitions
- MCP/tool integration glue
- Linear dispatch code

It avoids ticketing expected user cancellations, unsupported user requests,
plain user input mistakes, and external outages that Allen handled correctly.

## Dedupe

Every candidate gets a deterministic fingerprint based on:

- source type
- root cause area
- failure mode
- workflow name and node
- agent name
- tool/server
- normalized error summary

If an open incident already exists, `allen-incident-router` decides whether the
new evidence is truly new. It updates the existing Linear issue only when the
agent finds useful new evidence, avoiding automatic hourly comment spam.

## Linear Ticket Contents

Linear tickets are created or updated by agents through Linear MCP tools, not by
backend service code.

Auto-created tickets include:

- source type
- severity
- root cause area
- confidence
- failure mode
- fingerprint
- first and latest seen timestamps
- summary
- related IDs
- Allen links where available
- redacted evidence
- routing recommendation

The Linear destination has no code defaults. The monitor will not start unless
all required destination variables are present:

```text
ALLEN_SELF_HEALING_LINEAR_TEAM_KEY
ALLEN_SELF_HEALING_LINEAR_PROJECT_NAME
ALLEN_SELF_HEALING_ASSIGNEE_EMAIL
```

Optional:

```text
ALLEN_SELF_HEALING_REPO_PATH
```

## Built-In Agents

The following agents are seeded as built-ins:

- `allen-monitoring-agent`
- `allen-incident-router`
- `allen-memory-diagnostician`
- `allen-tooling-diagnostician`
- `allen-workflow-diagnostician`
- `allen-prompt-instruction-diagnostician`

They exist so the self-healing loop does not depend on manually-created agents.

## Built-In Repair Workflows

The following workflows are seeded from `packages/engine/workflows/`:

- `self-healing-incident-triage`
- `allen-self-healing-monitor-hourly`
- `self-healing-repair-allen`
- `self-healing-memory-repair`
- `self-healing-tooling-repair`
- `self-healing-workflow-repair`
- `self-healing-prompt-instruction-repair`

Routing defaults:

| Root Cause Area | Repair Target |
|---|---|
| `memory_system` | `self-healing-memory-repair` |
| `tool_integration` | `self-healing-tooling-repair` |
| `workflow_definition` | `self-healing-workflow-repair` |
| `agent_prompt` | `self-healing-prompt-instruction-repair` |
| `instruction_bug` | `self-healing-prompt-instruction-repair` |
| `allen_repo` | `self-healing-repair-allen` |
| `unknown` | `allen-incident-router` |

## API

Authenticated routes:

```text
GET  /api/monitoring/incidents
GET  /api/monitoring/incidents/:id
POST /api/monitoring/scan
POST /api/monitoring/incidents/:id/ticket
POST /api/monitoring/incidents/:id/dispatch
POST /api/monitoring/incidents/:id/ignored
POST /api/monitoring/incidents/:id/suppressed
POST /api/monitoring/incidents/:id/resolved
```

Use `POST /api/monitoring/scan` to manually launch the agent-led monitoring
workflow.

## Key Collections

- `monitoring_incidents`: deduped incidents, Linear links, routing state, and
  evidence.
- `monitoring_scan_state`: last successful scanner cursor.
- `monitoring_events`: lightweight event-hook records.
- `monitoring_evidence_bundles`: agent-curated evidence reviewed during a scan.
- `memory_injection_audits`: explicit memory retrieval/injection audit records.

## Safety

- Monitoring is best effort. It must not break the original chat, agent, or
  workflow.
- Evidence is redacted before storage in incidents or Linear tickets.
- The hourly workflow has bounded record and ticket limits.
- Agents decide whether to dispatch; repair workflows work in isolated
  worktrees and open PRs rather than editing the base repo directly.
