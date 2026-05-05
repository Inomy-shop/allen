# Allen UI, Task Routing, and Progress Revamp Plan

## Purpose

Revamp Allen so the chat assistant, workflow execution pages, direct agent runs, Linear dispatches, human-in-the-loop pauses, workspaces, PRs, artifacts, and logs all feel like one coherent system.

The visual direction should follow the prototype in:

```text
/Users/shreemantkumar/flowforge/allen-prototype
```

The prototype is a visual and interaction reference only. Real app behavior must come from existing backend records, not mock data.

## Product Requirements

1. Normal chat questions should be answered directly.
2. Work requests from chat should be routed intelligently.
3. If a matching workflow exists, use that workflow first.
4. If no workflow fits and the task needs multiple specialists, assign the relevant team lead.
5. If no workflow fits and one specialist clearly matches, run that single agent.
6. If the request is ambiguous or missing required context, ask a focused clarification.
7. Every routed task should create or link to a visible run status card.
8. Direct single-agent runs should show progress, not just final output.
9. Workflow runs should show node progress, spawned agents, logs, tools, human gates, artifacts, workspace, Linear ticket, and PR.
10. Linear-dispatched work should show the ticket, selected workflow or agent, workspace, execution, human input state, and PR.
11. Human-in-the-loop should be prominent wherever the user is likely to look: chat, execution detail, Linear ticket detail, and interventions.
12. The whole app UI should be visually refreshed toward the prototype direction.
13. Any task that may require code changes must create or select an isolated Allen workspace before assigning work to an agent, team lead, or workflow implementation path.

## Existing System Fit

The repo already has most of the required infrastructure.

| Capability | Existing Area |
| --- | --- |
| Workflows | `packages/engine/workflows/*` |
| Workflow execution | `packages/server/src/services/execution.service.ts`, `packages/engine/src/state-manager.ts` |
| Agents and teams | `agents`, `teams`, `packages/server/src/services/chat-tools.ts` |
| Chat | `packages/server/src/services/chat.service.ts`, `packages/ui/src/hooks/useChat.ts` |
| Agent spawning | `spawn_agent` in `packages/server/src/services/chat-tools.ts` |
| Linear dispatch | `packages/server/src/services/linear.service.ts`, `packages/ui/src/pages/TicketsPage.tsx` |
| Human-in-loop | `InterventionService`, `InterventionsPage`, `HumanInputDialog` |
| Workspace records | `WorkspaceManager`, workspace routes/pages |
| PR records | `PullRequestService`, PR routes/pages |
| Live logs and traces | `execution_logs`, `execution_traces`, SSE |
| Spawn tree | `parentExecutionId`, `rootExecutionId`, `/executions/:id/children` |

This is a medium-sized integration and UI revamp, not a rewrite.

## Core Concepts

### Run

A run is any meaningful unit of work:

- workflow execution
- direct agent execution
- chat-spawned agent execution
- Linear-dispatched workflow
- Linear-dispatched agent

All runs should normalize into a common UI model:

```ts
interface RunStatus {
  origin: 'chat' | 'linear' | 'workflow' | 'direct_agent';
  title: string;
  status: 'queued' | 'running' | 'waiting_for_input' | 'completed' | 'failed' | 'cancelled';
  currentStep: string | null;
  progress: {
    completed: number;
    total: number;
    label: string;
  };
  humanInput?: {
    required: boolean;
    interventionId?: string;
    title?: string;
    stage?: string;
  };
  workspace?: {
    id?: string;
    name?: string;
    repoName?: string;
    branch?: string;
    baseBranch?: string;
    status?: string;
    worktreePath?: string;
  };
  linear?: {
    issueId?: string;
    identifier?: string;
    title?: string;
    url?: string;
  };
  pullRequest?: {
    id?: string;
    number?: number;
    title?: string;
    url?: string;
    status?: string;
  };
  childAgents: Array<{
    executionId: string;
    agentName: string;
    status: string;
    currentStep?: string;
    durationMs?: number | null;
  }>;
  artifacts: Array<{
    artifactId: string;
    filename: string;
    url?: string;
  }>;
  recentActivity: Array<{
    type: string;
    label: string;
    at: string;
  }>;
}
```

### Task Router

Chat should not blindly spawn agents. It should route only when the user asks for work to be done.

Router output:

```ts
type TaskRouteDecision =
  | { intent: 'answer_directly'; reason: string }
  | { intent: 'run_workflow'; workflowId: string; workflowName: string; input: Record<string, unknown>; workspaceId?: string; workspacePath?: string; reason: string }
  | { intent: 'assign_team_lead'; agentName: string; prompt: string; workspaceId?: string; workspacePath?: string; reason: string }
  | { intent: 'run_single_agent'; agentName: string; prompt: string; workspaceId?: string; workspacePath?: string; reason: string }
  | { intent: 'ask_clarification'; questions: string[]; reason: string };
```

Routing order:

1. Answer normal questions directly.
2. For work requests, find a matching workflow.
3. If no workflow fits and the task needs coordination, assign a team lead.
4. If no workflow fits and the task is narrow, run one specialist agent.
5. Ask clarification only when required context is missing.

Workspace invariant:

- If the routed task can modify code, create or select an Allen workspace before the agent, lead, or workflow implementation starts.
- The agent or lead must receive the workspace `worktreePath` as its working directory.
- Agents should not be assigned directly against the registered source repo path for mutating work.
- Read-only questions, planning-only tasks, and explanation requests can use repo context without creating a workspace.
- If the user already has an active workspace for the task, reuse it when safe instead of creating a duplicate.
- If no repo/workspace can be resolved for a code-changing request, ask for the target repo before assigning work.

## Chat Behavior Requirements

### Normal Chat

User:

```text
What is human-in-the-loop in Allen?
```

Expected:

```text
Assistant answers directly.
No workflow.
No agent.
No execution card.
```

### Read-Only Chat

User:

```text
Explain what feature-plan-and-implement does.
```

Expected:

```text
Assistant may inspect workflow files and answer directly.
No task run unless the user asks to execute or assign work.
```

### Work Request

User:

```text
Work on improving the workflow execution status UI.
```

Expected route:

```ts
intent = 'run_workflow'
workflow = 'feature-plan-and-implement'
```

Chat should show:

```text
Started feature-plan-and-implement

[Run card]
Status: running
Current: intake-clarifier
Progress: 1 / 11 nodes
Workspace: pending
Human input: none
Open execution
```

### Direct Specialist Request

User:

```text
Ask frontend-developer to improve this UI.
```

Expected route:

```ts
intent = 'run_single_agent'
agentName = 'frontend-developer'
workspace = createOrReuseWorkspace(targetRepo)
```

Chat should show:

```text
[Agent run card]
frontend-developer - running
Current: inspecting repo
Workspace: flowforge
Tools: 4
Open execution
```

### Team Lead Request

User:

```text
Build a monitoring dashboard with backend APIs, frontend, tests, and PR.
```

If no workflow matches strongly:

```ts
intent = 'assign_team_lead'
agentName = 'Engineering Lead'
workspace = createOrReuseWorkspace(targetRepo)
```

Chat should show:

```text
Engineering Lead - running
Child agents:
- backend-developer running
- frontend-developer running
- qa-runner queued
```

## Workflow Matching Examples

| User Request | Expected Route |
| --- | --- |
| "Fix this bug in workspace setup" | `bug-investigate-and-fix` |
| "Investigate why direct agent progress is missing" | `bug-investigate-and-fix` |
| "Build a better execution status UI" | `feature-plan-and-implement` |
| "Implement this new dashboard" | `feature-plan-and-implement` |
| "Resolve CodeRabbit comments on this PR" | `resolve-pr-reviews` |
| "Review and fix PR feedback" | `resolve-pr-reviews` |
| "Understand this repo and make a plan" | `understand-and-plan` |

Workflow matching should be owned by the chat LLM. It should inspect workflow names, descriptions, declared inputs, tags, live agents, teams, repos, Linear tickets, and PR data with tools. If confidence is low, it should ask a clarification or choose a lead instead of forcing a workflow.

## Backend Plan

### 1. Move Routing Into the Chat LLM Prompt

Update chat handling in:

```text
packages/server/src/services/chat.service.ts
```

Behavior:

- ordinary messages continue through the normal assistant path
- the assistant prompt defines when to answer, inspect data, run a workflow, spawn a lead, or spawn a specialist
- work requests are decided by the LLM using live tool calls, not backend keyword matching
- code-changing work requests must call `create_workspace` before launch
- workflow decisions call `run_workflow`
- lead/single-agent decisions call `spawn_agent`
- chat response includes run metadata so the UI can render a status card

For code-changing lead or single-agent routes, `spawn_agent` should receive the workspace path:

```ts
{
  repo_path: workspace.worktreePath,
  prompt: `${taskPrompt}\n\nWORKSPACE CONTEXT:\nWork only inside ${workspace.worktreePath}.`
}
```

For code-changing workflow routes, workflow input should include workspace context:

```ts
{
  workspace_id: workspaceId,
  repo_path: workspace.worktreePath,
  worktree_path: workspace.worktreePath,
  branch: workspace.branch
}
```

### 2. Link MCP Workspace and Execution Metadata

When the chat LLM calls Allen MCP tools:

- `create_workspace` links the created workspace back to the current chat session
- workflow executions started through MCP are stamped with `meta.origin = "chat"` and `meta.chatSessionId`
- workflow inputs should carry `workspace_id`, `repo_path`, `worktree_path`, and `branch` when code changes are involved
- spawned agents already carry chat/session metadata through the active chat context

### 3. Add Execution Metadata Stamping

Every task execution should include enough metadata for later context lookup.

Recommended execution metadata:

```ts
meta.origin = 'chat' | 'linear' | 'direct_agent' | 'manual_workflow';
meta.chatSessionId = string | undefined;
meta.parentMessageId = string | undefined;
meta.requestText = string;
meta.linearIssueId = string | undefined;
meta.linearIdentifier = string | undefined;
meta.linearTitle = string | undefined;
meta.linearUrl = string | undefined;
meta.workspaceId = string | undefined;
meta.workspacePath = string | undefined;
meta.repoId = string | undefined;
meta.branch = string | undefined;
meta.requiresCodeChanges = boolean;
```

Apply this in:

- Linear workflow dispatch
- Linear agent dispatch
- chat workflow launch
- chat direct agent launch
- manual workflow launch where possible
- direct agent run page / agent run API

### 4. Add Execution Context Aggregation Endpoint

Add:

```text
GET /api/executions/:id/context
```

It should aggregate:

- execution row
- workflow definition
- node states and traces
- execution logs
- recent activity
- child agent executions
- pending interventions
- workspace
- Linear assignment / issue metadata
- PR record
- artifacts

Response should be shaped for UI use, not raw DB documents.

### 5. Add Structured Progress Events

Do not depend only on natural language logs.

Progress should be derived from:

1. `executions.status`
2. `currentNodes`
3. `completedNodes`
4. `execution_traces`
5. structured activity events
6. tool calls
7. human intervention records
8. workspace/PR events

Normalize activity into phases:

```text
queued
starting
creating_workspace
inspecting
planning
editing
testing
waiting_for_human
opening_pr
completed
failed
cancelled
```

Tool phase mapping examples:

| Tool / Event | Phase |
| --- | --- |
| `Read`, `Grep`, `Glob`, `rg`, `sed` | inspecting |
| `apply_patch`, `Edit`, `Write` | editing |
| `npm test`, `vitest`, `pytest`, `pnpm test` | testing |
| `git push`, `gh pr create` | opening_pr |
| `input_required`, pending intervention | waiting_for_human |

### 6. Update Agent and Chat Instructions

Update chat/agent system instructions so agents emit concise milestones.

Instruction concept:

```text
When doing multi-step work, report short progress at major transitions:
investigating, planning, editing, testing, blocked, opening PR, completed.
Use structured tools/events where available. Do not ask the user unless blocked
or the decision materially changes scope.
For code-changing tasks, work only inside the assigned Allen workspace path.
Do not edit the registered source repo directly.
```

This supports progress UI, but the UI must still trust backend state first.

## UI Revamp Plan

### Design Direction

Use `allen-prototype` as reference for:

- denser shell
- cleaner status badges
- run trace rail
- right-side context panel
- interventions as first-class pending work
- live runs list
- execution logs as a central work surface
- compact tables and cards

Do not copy prototype mock data. Rebuild with current UI components and real API calls.

### 1. App Shell

Target:

```text
packages/ui/src/App.tsx
packages/ui/src/index.css
```

Goals:

- align navigation labels and spacing with prototype
- make "Activity", "Needs review", "Linear", "Workspaces", and "Pull requests" feel like one operational console
- keep existing auth/settings behavior

### 2. Execution List

Target:

```text
packages/ui/src/pages/ExecutionListPage.tsx
```

Prototype reference:

```text
allen-prototype/pages-runs.jsx - ExecutionsPage
```

Add:

- live count summary
- better filtering by running / queued / waiting / failed / completed
- origin indicator: chat, Linear, workflow, agent
- current step when available
- workspace / PR quick indicators

### 3. Execution Detail

Target:

```text
packages/ui/src/pages/ExecutionDetailPage.tsx
```

Prototype reference:

```text
allen-prototype/pages-runs.jsx - RunTracePage
```

New layout:

```text
Top bar:
Back | execution id | workflow/agent name | status | duration | cost | workspace | PR | cancel

Main:
Left: status trace / node rail
Center: logs, tools, artifacts, diff/cost tabs
Right: context panel
```

Right context panel should show:

- repo
- Linear ticket
- workspace
- PR
- models/providers
- human gates
- child agents
- artifacts
- actions

### 4. Direct Agent Execution Detail

Target:

```text
AgentExecutionView inside ExecutionDetailPage.tsx
```

Should use the same execution status language as workflows:

```text
frontend-developer - running
Task: Fix workspace status UI
Current: editing files
Workspace: flowforge
Linear: none
PR: pending
Artifacts: 1
Logs: live
```

### 5. Chat Progress Cards

Targets:

```text
packages/ui/src/pages/ChatPage.tsx
packages/ui/src/hooks/useChat.ts
packages/ui/src/components/chat/*
```

When chat routes work, render compact cards:

```text
feature-plan-and-implement - running
Current: intake-clarifier
Progress: 1 / 11
Open execution
```

For spawned agents:

```text
frontend-developer - running
Current: inspecting repo
Tools: 4
Open execution
```

If human input is needed:

```text
Waiting for human input
Plan approval required
Respond
```

### 6. Interventions

Target:

```text
packages/ui/src/pages/InterventionsPage.tsx
```

Prototype reference:

```text
allen-prototype/pages-runs.jsx - InterventionsPage
```

Goals:

- make pending interventions more prominent
- show linked execution/workflow/ticket/workspace
- keep response flow through `ClarificationPanel`
- reflect answered history clearly

### 7. Linear Ticket Page

Target:

```text
packages/ui/src/pages/TicketsPage.tsx
```

Add a run status card to ticket detail:

```text
ENG-1453
Assigned to: feature-plan-and-implement
Status: waiting for human input
Current: plan_approval_gate
Workspace: Open
Execution: Open
PR: pending
```

### 8. Workspace and PR Pages

Targets:

```text
packages/ui/src/pages/WorkspaceListPage.tsx
packages/ui/src/pages/WorkspaceDetailPage.tsx
packages/ui/src/pages/PullRequestListPage.tsx
packages/ui/src/pages/PullRequestDetailPage.tsx
```

Add reciprocal visibility:

- workspace shows linked execution and Linear ticket
- PR shows originating execution/workspace/ticket
- execution links back to workspace and PR

## End-to-End Example Flows

### Example A: Normal Question

User:

```text
What does the resolve-pr-reviews workflow do?
```

Router:

```ts
intent = 'answer_directly'
```

UI:

```text
Assistant answers in chat.
No execution card.
```

### Example B: Direct Single-Agent Run

User:

```text
Ask frontend-developer to improve the workflow execution status UI.
```

Router:

```ts
intent = 'run_single_agent'
agentName = 'frontend-developer'
workspace = createOrReuseWorkspace('flowforge')
```

Execution:

```text
workflowName = 'chat:spawn_agent/frontend-developer'
source = 'chat'
status = 'running'
currentNodes = ['frontend-developer']
meta.origin = 'chat'
meta.requestText = user message
meta.workspaceId = created workspace id
meta.workspacePath = created workspace worktree path
```

Chat card:

```text
frontend-developer - running
Current: inspecting repo
Workspace: flowforge
Open execution
```

Execution page:

```text
frontend-developer - running
Task: improve workflow execution status UI
Activity: inspecting -> editing -> testing
Workspace: flowforge
PR: pending
Artifacts: available if saved
```

### Example C: Feature Work Request

User:

```text
Work on a better workflow execution status UI with chat progress cards.
```

Router:

```ts
intent = 'run_workflow'
workflow = 'feature-plan-and-implement'
workspace = createOrReuseWorkspace(targetRepo)
```

Execution page:

```text
feature-plan-and-implement - running
Progress: 3 / 11
Current: hla-writer
Human gate: Plan approval upcoming
Workspace: pending
PR: pending
```

If human gate triggers:

```text
Status: waiting for input
Human in loop: Plan approval required
Respond
```

### Example D: Bug Fix

User:

```text
Fix why direct agent runs do not show progress in chat.
```

Router:

```ts
intent = 'run_workflow'
workflow = 'bug-investigate-and-fix'
workspace = createOrReuseWorkspace(targetRepo)
```

Progress:

```text
bug-investigate-and-fix - running
Current: root-cause investigation
Workspace: created
Child agents: none or specialist spawned by workflow
PR: pending
```

### Example E: Multi-Specialist Work Without Workflow

User:

```text
Build a monitoring dashboard, add backend APIs, write tests, and open a PR.
```

If no matching workflow is available:

```ts
intent = 'assign_team_lead'
agentName = 'Engineering Lead'
workspace = createOrReuseWorkspace(targetRepo)
```

Progress:

```text
Engineering Lead - running
Child agents:
- backend-developer running
- frontend-developer running
- qa-runner queued
- security-reviewer pending
Workspace: created
PR: pending
```

### Example F: Linear Ticket

User:

```text
Work on ENG-1453.
```

Router:

1. resolve `ENG-1453` from Linear
2. classify issue type from title/description/labels
3. resolve the target repo from ticket metadata, selected repo, or user context
4. create or reuse an isolated workspace for the ticket
5. choose workflow if matched
6. stamp execution metadata

Progress:

```text
ENG-1453 - running
Workflow: bug-investigate-and-fix
Current: investigation
Progress: 2 / 9
Workspace: linear/eng-1453
PR: not opened
Human input: none
```

When PR opens:

```text
PR #598 open
```

## Implementation Phases

### Phase 1: Foundation

Goal: add backend primitives without changing chat behavior yet.

- [x] Add routing policy to the assistant prompt instead of a backend heuristic router.
- [x] Keep greetings, normal questions, explanations, and brainstorming on the direct assistant path.
- [x] Define workflow/lead/specialist selection rules in prompt.
- [x] Define workspace-first requirements for code-changing tasks in prompt.
- [x] Add MCP workspace creation/linking surface for chat integration.
- [x] Add metadata shape for LLM-routed executions.
- [x] Add `/executions/:id/context` aggregation endpoint.
- [x] Include Linear/workspace/PR/intervention/child-agent context in the endpoint.
- [x] Keep existing UI and chat behavior functional.
- [x] Verify server typecheck.

### Phase 2: Chat Routing

- [x] Integrate router into `ChatService`.
- [x] Preserve direct answer behavior for normal questions.
- [x] Add workflow launch from chat.
- [x] Add lead/single-agent launch from chat.
- [x] Ensure code-changing chat routes create/reuse workspace first.
- [x] Stamp execution metadata on chat-started runs.
- [x] Return run metadata to chat stream.
- [x] Add backend tests for normal answer vs routed work.
- [x] Verify server and UI typechecks.

### Phase 3: Progress Aggregation

- [x] Normalize execution progress into `RunStatus`.
- [x] Include child agents.
- [x] Include interventions.
- [x] Include workspace/Linear/PR/artifacts.
- [x] Add phase mapping from structured events and tools.
- [x] Add tests around direct-agent, workflow, and Linear-dispatched context.
- [x] Verify server and UI typechecks.

### Phase 4: Chat UI Progress Cards

- [x] Add run cards to chat.
- [x] Show direct agent progress.
- [x] Show workflow progress.
- [x] Show human-input state.
- [x] Link execution/workspace/PR/artifacts.
- [x] Poll or subscribe to run context updates.
- [x] Rehydrate chat run cards from persisted execution links after refresh.
- [x] Verify server and UI typechecks.

### Phase 5: Execution UI Revamp

- [x] Rework execution detail toward prototype layout.
- [x] Add trace rail.
- [x] Add right context panel.
- [x] Update direct agent execution view.
- [x] Improve logs/tools/activity display.
- [x] Keep graph/logs available for power users.
- [x] Verify server and UI typechecks/build.

### Phase 6: Linear and Interventions UI

- [x] Add shared run card to Linear ticket detail.
- [x] Make pending interventions prominent.
- [x] Add reciprocal links across ticket/execution/workspace/PR.
- [x] Show workspace-first status for Linear code tasks.

### Phase 7: Full UI Pass

- [x] Apply prototype design language across:
  - [x] shell
  - [x] shared tokens/chips/radii/topbar primitives
  - [x] activity
  - [x] interventions
  - [x] tickets
  - [x] workspaces
  - [x] PRs
  - [x] agents
  - [x] workflows
- [x] Verify responsive behavior at the implementation level with wrapped shared headers/lists.
- [x] Run frontend typecheck and production build.
- [x] Manual browser QA after dev server is allowed to run again.

### Phase 8: Prototype Page Content Parity

Goal: correct the page-to-content mapping so the app shows the same type of content on each route as the prototype, backed by live data instead of fixtures.

- [x] Keep `/chat` as the real assistant conversation surface for normal answers and routed task requests.
- [x] Add `/threads` as the prototype thread-list route.
- [x] Update navigation and command palette so the `threads` item opens `/threads`, not `/chat`.
- [x] Convert `/` to the prototype `my work` surface:
  - greeting
  - task composer
  - `needs you`
  - `in flight`
  - `recent`
- [x] Convert `/interventions` to the prototype `inbox` surface:
  - `all/gate/review/question/blocked/mention` chips
  - `urgent/today/fyi` groups
  - compact rows that open the intervention detail page
- [x] Convert `/executions` to the prototype `activity` surface:
  - `running now`
  - `recent executions`
  - `tasks in motion`
  - all-executions table retained below for power users
- [x] Replace remaining old violet accent defaults with prototype blue defaults.
- [x] Run frontend typecheck and production build after the content parity changes.
- [x] Run browser QA for `/`, `/interventions`, `/threads`, `/chat`, `/executions`, `/tickets`, `/workspaces`, `/pull-requests`, `/agents`, and `/workflows`.
- [x] Stop local dev servers after browser QA.

## Risks and Decisions

### Risk: Over-triggering workflows

Mitigation:

- the chat LLM is the routing brain, guided by explicit prompt policy
- normal greetings, questions, explanations, and brainstorming answer directly
- the assistant only starts workflows/agents when user intent to execute work is explicit
- code still enforces metadata linking and workspace visibility after tools are called

### Risk: Progress from logs is noisy

Mitigation:

- derive core status from execution state, traces, interventions, and structured events
- use free-text logs only as display/fallback

### Risk: Workflow matching confidence

Mitigation:

- have the LLM inspect live workflow, agent, team, repo, and ticket data with tools
- ask clarification if fit or repo context is ambiguous
- prefer a matching workflow when available, a team lead for broad multi-specialist tasks, and one specialist for narrow tasks

### Risk: UI revamp becomes too large

Mitigation:

- ship in phases
- start with execution/chat/Linear progress surfaces
- then apply visual language across secondary pages

### Risk: Agents Modify the Registered Repo Directly

Mitigation:

- assistant prompt requires create_workspace before mutating work
- pass only the workspace path to agents/leads for code-changing tasks
- link workspace and chat metadata when MCP tools create workspaces or workflow executions
- surface workspace in the run card so the user can verify where work is happening

## Architecture Update: LLM-Owned Routing

- [x] Remove the backend heuristic chat pre-router from the assistant message path.
- [x] Move workflow/lead/specialist routing policy into the assistant and team-agent system prompts.
- [x] Keep simple chat, greetings, questions, and brainstorming on the normal assistant path.
- [x] Require the LLM to inspect live workflows/agents/repos/tickets with tools when routing is needed.
- [x] Require `create_workspace` before code-changing workflow/agent execution.
- [x] Link MCP-created workspaces back to the chat session.
- [x] Stamp chat metadata on workflow executions started through the Allen MCP path.
- [x] Keep backend code responsible for safety, linking, and status visibility, not semantic routing decisions.

## Definition of Done

1. Normal chat questions do not spawn work.
2. Explicit work requests are routed by the chat LLM to workflow, lead, or single agent.
3. Code-changing work always creates or reuses an isolated workspace before assigning an agent, lead, or workflow implementation path.
4. Every routed task produces a visible progress card.
5. Direct single-agent runs show live progress and context.
6. Workflow runs show progress, child agents, human gates, workspace, Linear, PR, artifacts, and logs.
7. Linear tickets show linked run progress.
8. Human-in-loop is visible in chat, execution detail, and interventions.
9. UI follows the prototype direction while using real backend data.
10. Existing workflow/agent/Linear functionality continues to work.
11. Tests and manual browser verification cover the main flows.
