# FlowForge — Product Plan

## 1. Overview

FlowForge is a visual, web-based workflow engine for orchestrating AI agents. Build workflows by drag-and-drop or YAML, execute them using Claude Code SDK (no API key needed), and monitor execution in real-time with full node-level input/output visibility.

**Core principle:** The engine is generic. Workflows are YAML config. Agents are Claude Code SDK subprocesses. No code changes needed to add workflows, roles, or support new repos.

**Not a LangGraph clone.** LangGraph orchestrates API calls. FlowForge orchestrates autonomous agents — each node is a full Claude Code session that can read files, edit code, run commands, search the web.

---

## 2. Architecture

```
┌────────────────────────────────────────────────────────┐
│                     FlowForge UI                        │
│  React 18 + React Flow + Monaco Editor                  │
│  ┌───────────┐ ┌──────────┐ ┌─────────┐ ┌───────────┐ │
│  │ Workflow   │ │  YAML    │ │  Live   │ │ Execution │ │
│  │ Builder    │ │  Editor  │ │ Monitor │ │  History  │ │
│  │(React Flow)│ │(Monaco)  │ │  (SSE)  │ │ (Replay)  │ │
│  └─────┬─────┘ └────┬─────┘ └────┬────┘ └─────┬─────┘ │
│        └─────────────┴────────────┴─────────────┘       │
│                        REST + SSE                        │
├──────────────────────────────────────────────────────────┤
│                    FlowForge Server                       │
│  Express.js + TypeScript                                  │
│  ┌───────────┐ ┌──────────────┐ ┌──────────────────────┐│
│  │ Workflow   │ │ Graph Engine │ │   Node Executor      ││
│  │ CRUD API   │ │  (core)      │ │  (Claude Agent SDK)  ││
│  └───────────┘ └──────────────┘ └──────────────────────┘│
│  ┌───────────┐ ┌──────────────┐ ┌──────────────────────┐│
│  │   SSE      │ │ State Mgr    │ │  Built-in Functions  ││
│  │ Streamer   │ │ (checkpoint) │ │  (git, build, etc.)  ││
│  └───────────┘ └──────────────┘ └──────────────────────┘│
├──────────────────────────────────────────────────────────┤
│                      MongoDB                              │
│  workflows │ roles │ executions │ traces │ checkpoints    │
└──────────────────────────────────────────────────────────┘
```

---

## 3. Tech Stack

| Layer | Tech | Why |
|-------|------|-----|
| UI | React 18, TypeScript, Vite, Tailwind, Shadcn/ui | Standard modern SPA |
| Graph Builder | React Flow | Best drag-and-drop node graph library for React |
| Code Editor | Monaco Editor | VS Code editor component, YAML highlighting + autocomplete |
| Real-time | Server-Sent Events (SSE) | Simpler than WebSocket, unidirectional streaming |
| Server | Express.js, TypeScript | Lightweight, well-known |
| Agent Execution | `@anthropic-ai/claude-agent-sdk` | No API key — uses Claude Code subscription |
| Database | MongoDB | Flexible schema for workflows, executions, traces |
| Template Engine | Handlebars | `{{var}}`, `{{#if}}`, `{{#each}}` — well-known, battle-tested |
| Monorepo | Turborepo | Manages engine/server/ui packages |

---

## 4. Core Concepts

### 4.1 Workflows

A workflow is a directed graph of nodes and edges, defined in YAML:

```yaml
name: sdlc
description: Full software development lifecycle
version: 1

context:
  requires: [repo]                     # environment needed
  tools: [filesystem, git, terminal]   # what agents can access
  secrets: [GITHUB_TOKEN]             # secrets needed (from secrets.yml)
  concurrency: 1                       # max simultaneous executions

input:
  task: { type: string, required: true }
  repo_path: { type: string, required: true }

nodes: { ... }
edges: [ ... ]
```

### 4.2 Node Types

| Type | What It Does | Retry Behavior |
|------|-------------|----------------|
| `agent` (default) | Spawns Claude Code SDK with role's system prompt + node's prompt | Resume same session via `resume_on_retry: true` |
| `code` | Runs a built-in JavaScript function (git, build, classify) | Configurable: `retries`, `backoff`, `on_failure` |
| `human` | Pauses execution, shows form in UI, waits for user input | No auto-retry — human decides |
| `workflow` | Runs another workflow as a subgraph | Inherits child workflow's behavior |
| `condition` | Pure logic — evaluates expression, routes to different edges | N/A — no execution |

#### Agent Node (LLM)

```yaml
implement:
  role: developer                      # links to roles.yml for system prompt
  prompt: |                            # task-specific prompt
    Implement in {{worktree_path}}:
    Plan: {{plan}}
    {{#if retry_context}}FIX: {{retry_context}}{{/if}}
  outputs: [changed_files, summary]
  output_format: json                  # instructs engine to extract JSON
  resume_on_retry: true                # reuse Claude session on retry
  timeout: 300                         # seconds, default 600
```

#### Code Node (Built-in Function)

```yaml
create-branch:
  type: code
  function: git-create-branch
  config:
    base_branch: main
  retries: 2                           # retry up to 2 times
  backoff: exponential                 # exponential | linear | fixed
  backoff_base_ms: 1000               # 1s, 2s, 4s
  retry_on: [NETWORK_ERROR, TIMEOUT]  # only retry specific errors
  on_failure: fail                     # fail | skip | fallback
  fallback_value:                      # used when on_failure: skip
    worktree_path: null
  outputs: [worktree_path, branch_name]
```

#### Human Node (Pause for Input)

```yaml
approve-pr:
  type: human
  prompt: "Review the changes and decide whether to proceed"
  fields:
    - { name: approved, type: boolean, label: "Approve?" }
    - { name: comments, type: text, label: "Comments", required: false }
    - { name: priority, type: select, label: "Priority", options: [low, medium, high] }
  timeout: 24h                         # auto-cancel if no response
  timeout_action: cancel               # cancel | default (use field defaults)
  outputs: [approved, comments, priority]
```

**Flow:**
```
Engine reaches human node
  → Saves checkpoint
  → Sets execution status to "waiting_for_input"
  → Emits SSE event: { type: "input_required", node, fields, prompt }
  → UI shows form dialog
  → User fills in fields, clicks Submit
  → POST /api/executions/:id/input { node: "approve-pr", data: { approved: true } }
  → Engine resumes from checkpoint with human input merged into state
```

#### Workflow Node (Subgraph)

```yaml
ship-feature:
  type: workflow
  workflow: sdlc                       # references another workflow by name
  input_map:                           # parent state → child input
    task: "{{task}}"
    repo_path: "{{repo_path}}"
  output_map:                          # child output → parent state
    pr_url: pr_url
    changed_files: changed_files
  timeout: 30m                         # max time for child workflow
```

Engine creates a child execution linked to parent. Parent waits for child to complete, then maps outputs back.

**Nesting limit:** Max 3 levels deep to prevent runaway recursion.

#### Condition Node (Pure Logic)

```yaml
check-quality:
  type: condition
  conditions:
    - name: high_quality
      expression: "test_passed AND review_verdict == 'APPROVED'"
    - name: needs_fix
      expression: "NOT test_passed"
    - name: needs_review
      expression: "test_passed AND review_verdict != 'APPROVED'"
```

### 4.3 Edges

```yaml
edges:
  # Simple forward
  - from: plan
    to: implement

  # Parallel fork
  - from: implement
    to: [test, build]
    parallel: true
    join: wait-all                     # wait-all | wait-any | fail-fast

  # Conditional forward
  - from: [test, build]               # join — waits for both
    to: review
    condition: "test_passed AND build_passed"

  # Retry loop (backward edge)
  - from: [test, build]
    to: implement
    condition: "NOT test_passed OR NOT build_passed"
    max_retries: 3
    retry_context: "Test: {{test_output}}\nBuild: {{build_errors}}"

  # From condition node
  - from: check-quality
    to: create-pr
    condition: "high_quality"
```

**Parallel join policies:**

| Policy | Behavior | Use When |
|--------|----------|----------|
| `wait-all` | Wait for ALL branches to complete, merge all outputs | Default — need all results |
| `wait-any` | Proceed when FIRST branch completes, cancel others | Race — take fastest |
| `fail-fast` | If ANY branch fails, cancel others immediately | All-or-nothing |

**Retry loops:** Any backward edge with `max_retries` creates a loop. The engine tracks retry counts per edge. When `max_retries` is exceeded, execution fails. The `retry_context` template is rendered and injected into state so the target node knows what went wrong.

### 4.5 Condition Expression Language

Conditions use a **safe expression evaluator** — NOT `eval()`. The engine uses [filtrex](https://github.com/joewalnes/filtrex), a sandboxed expression compiler that only allows comparison, logical operators, and property access. No function calls, no arbitrary JS execution.

**Supported syntax:**
```
# Comparison
test_passed == true
review_verdict == 'APPROVED'
confidence >= 0.7
retry_count < 3

# Logical operators
test_passed AND build_passed
NOT test_passed OR NOT build_passed
test_passed AND (review_verdict == 'APPROVED' OR review_verdict == 'LGTM')

# Truthiness (shorthand for == true)
test_passed                          # same as test_passed == true
NOT test_passed                      # same as test_passed == false

# String matching
review_verdict == 'REQUEST_CHANGES'
action == 'fix-now'

# Nested property access
plan.parallel == true
cost.estimated > 1.0

# Null checks
root_cause != null
pr_url != null
```

**NOT supported (by design — security):**
```
# No function calls
Math.random() > 0.5                  # REJECTED
state.toString()                     # REJECTED

# No assignment
test_passed = true                   # REJECTED

# No arbitrary JS
require('fs')                        # REJECTED
process.exit()                       # REJECTED
```

**Implementation:**
```typescript
import { compileExpression } from 'filtrex';

function evaluateCondition(expression: string, state: Record<string, any>): boolean {
  // filtrex compiles to a safe function — no eval, no prototype access
  const fn = compileExpression(expression);
  return !!fn(state);
}
```

**Validation:** During graph validation (Section 10), condition expressions are pre-compiled. Invalid syntax is caught before execution — shown as errors in the YAML editor and canvas.

### 4.6 Parallel State Merge Strategy

When parallel branches complete and join, their outputs may write to the same state keys. The engine resolves conflicts using **namespaced outputs + explicit merge rules:**

**Default behavior — no conflicts (recommended):** Each parallel node declares unique output keys:
```yaml
nodes:
  test:  { outputs: [test_passed, test_output] }     # unique keys
  build: { outputs: [build_passed, build_errors] }   # unique keys
  lint:  { outputs: [lint_passed, lint_errors] }      # unique keys
```
No conflict — each node writes to different keys. This is the recommended pattern.

**When conflicts exist — last-write-wins with warnings:**
If two parallel nodes write to the same key (e.g., both output `status`), the engine uses **deterministic ordering** (alphabetical by node name) so results are reproducible:
```yaml
# Both output "status" — node "build" wins over "test" (alphabetical)
nodes:
  test:  { outputs: [status, test_output] }
  build: { outputs: [status, build_errors] }
# state.status = build's output (alphabetical: "build" < "test")
```
A **warning** is emitted during validation: "Parallel nodes [test, build] both output 'status' — last-write-wins (alphabetical order)."

**Explicit merge strategy (advanced):** For cases where you need custom merge behavior, use `merge` on the parallel edge:
```yaml
edges:
  - from: implement
    to: [test, build, lint]
    parallel: true
    join: wait-all
    merge:
      # Merge strategy per conflicting key
      status: last         # last-write-wins (default)
      errors: concat       # concatenate arrays/strings
      score: min           # take minimum value
      passed: all          # boolean AND — true only if ALL branches set true
```

| Merge Strategy | Behavior | Use For |
|----------------|----------|---------|
| `last` | Alphabetical last node's value wins (default) | Single-value fields |
| `concat` | Concatenate arrays or join strings with newline | Error messages, file lists |
| `min` / `max` | Take minimum or maximum numeric value | Scores, confidence |
| `all` | Boolean AND — true only if all branches output true | Pass/fail gates |
| `any` | Boolean OR — true if any branch outputs true | Optional checks |

**Implementation:**
```typescript
function mergeParallelOutputs(
  results: Array<{ node: string, outputs: Record<string, any> }>,
  mergeConfig?: Record<string, string>
): Record<string, any> {
  const merged: Record<string, any> = {};
  const conflicts: string[] = [];

  // Sort results by node name for deterministic ordering
  results.sort((a, b) => a.node.localeCompare(b.node));

  for (const { node, outputs } of results) {
    for (const [key, value] of Object.entries(outputs)) {
      if (key in merged && mergeConfig?.[key]) {
        // Apply explicit merge strategy
        switch (mergeConfig[key]) {
          case 'concat':
            merged[key] = Array.isArray(merged[key])
              ? [...merged[key], ...asArray(value)]
              : `${merged[key]}\n${value}`;
            break;
          case 'min': merged[key] = Math.min(merged[key], value); break;
          case 'max': merged[key] = Math.max(merged[key], value); break;
          case 'all': merged[key] = merged[key] && !!value; break;
          case 'any': merged[key] = merged[key] || !!value; break;
          default:    merged[key] = value; // last-write-wins
        }
      } else {
        if (key in merged) conflicts.push(key);
        merged[key] = value;  // last-write-wins (alphabetical order)
      }
    }
  }

  if (conflicts.length > 0) {
    console.warn(`Parallel merge: conflicting keys [${conflicts}] resolved by alphabetical last-write-wins`);
  }

  return merged;
}
```

### 4.4 Roles

Generic agent personas defined in `roles.yml`. Not tied to any repo or workflow:

```yaml
roles:
  planner:
    system: |
      You are a technical planner. Analyze the codebase at your CWD,
      understand the architecture, and break down the given task.
    model: sonnet
    tools: [filesystem, terminal]
    icon: clipboard
    color: "#9b59b6"

  developer:
    system: |
      You are a software developer. Read the codebase, understand patterns
      and conventions, then implement the requested changes.
      Follow existing code style. Write clean code.
    model: sonnet
    tools: [filesystem, terminal, git]
    icon: code
    color: "#3498db"

  tester:
    system: |
      You are a test engineer. Discover the test framework used in this repo.
      Write tests that cover the changed code. Run them. Report results.
    model: sonnet
    tools: [filesystem, terminal]
    icon: flask
    color: "#2ecc71"

  reviewer:
    system: |
      You review code for correctness, security (OWASP top 10), performance.
      Output: APPROVED or REQUEST_CHANGES with line-level feedback.
    model: sonnet
    tools: [filesystem]
    icon: eye
    color: "#e67e22"

  researcher:
    system: |
      You research topics using web search. Find primary sources,
      recent data, expert opinions. Always cite sources with URLs.
    model: sonnet
    tools: [web-search, web-fetch]
    icon: search
    color: "#1abc9c"

  writer:
    system: |
      You write engaging content. Adapt tone and format to the platform.
      LinkedIn: professional, story-driven. Twitter: punchy, concise.
    model: sonnet
    tools: []
    icon: pen
    color: "#e74c3c"

  editor:
    system: |
      You review written content for clarity, accuracy, engagement, tone.
      Fact-check claims when possible.
    model: sonnet
    tools: [web-search]
    icon: check-circle
    color: "#f39c12"

  analyst:
    system: |
      You analyze data by querying databases, reading schemas, computing metrics.
      Write SQL/MongoDB queries. Interpret results. Find patterns.
    model: sonnet
    tools: [filesystem, terminal, database]
    icon: bar-chart
    color: "#8e44ad"

  investigator:
    system: |
      You investigate problems by gathering evidence from code, logs,
      databases, git history. Form and test hypotheses systematically.
    model: opus
    tools: [filesystem, terminal, database, web-search]
    icon: magnifying-glass
    color: "#c0392b"

  git-ops:
    system: |
      You manage git operations. Create branches, commit changes,
      push to remote, create pull requests.
    model: haiku
    tools: [filesystem, terminal, git]
    icon: git-branch
    color: "#7f8c8d"

  formatter:
    system: |
      You format content for specific platforms — hashtags, emoji,
      line breaks, character limits.
    model: haiku
    tools: []
    icon: layout
    color: "#16a085"
```

**At runtime, the engine combines role + node:**
```
System prompt  →  from roles.yml (role.system)
User prompt    →  from workflow YAML (node.prompt with {{variables}} rendered)
CWD            →  from input.repo_path (or none for non-repo tasks)
Tools          →  from role.tools
Model          →  from role.model
```

---

## 5. Template Engine

Using Handlebars syntax:

```yaml
prompt: |
  # Simple variable
  Task: {{task}}

  # Conditional
  {{#if retry_context}}
  FIX THESE ERRORS:
  {{retry_context}}
  {{/if}}

  # Negation
  {{#unless test_passed}}
  WARNING: Tests are failing.
  {{/unless}}

  # Iteration
  Changed files:
  {{#each changed_files}}
  - {{this}}
  {{/each}}

  # Nested access
  First module: {{plan.modules.[0]}}

  # Default values
  Platform: {{platform | default "linkedin"}}
```

Implementation uses the `handlebars` npm package directly — zero custom parser code.

---

## 6. Output Extraction

Claude Code returns free-form text. The engine extracts structured outputs using a 3-layer strategy:

**Layer 1 — Prompt injection:** Engine appends to every agent prompt:
```
When done, return results as JSON: ```json { "changed_files": [...], "summary": "..." } ```
```

**Layer 2 — Regex extraction:** Parse ` ```json ... ``` ` blocks from response. Also looks for `key: value` patterns for simple outputs.

**Layer 3 — LLM fallback:** If no structured output found, send a cheap haiku call:
```
Extract these fields from the text: changed_files, summary
Text: <agent response>
Return JSON only.
```

**Per-node configuration:**
```yaml
implement:
  outputs: [changed_files, summary]
  output_format: json             # adds JSON instruction to prompt
  # or
  output_format: freeform         # uses regex + LLM fallback
  # or
  output_extraction:              # custom regex per field
    changed_files: "Changed files?:?\s*\n((?:- .+\n)+)"
    summary: "Summary:?\s*(.+)"
```

---

## 7. Context and State Management

### Three Layers of Context

```
Layer 1: Graph State (small, structured — flows between ALL nodes)
  ├── task, repo_path, worktree_path, branch_name
  ├── executionIds (for session resume)
  ├── gate results (test_passed, review_verdict)
  └── retry_context, retry counts

Layer 2: Node Output (medium — passed to NEXT node via state)
  ├── plan, design decisions
  ├── changed_files, summary
  ├── error messages, review feedback
  └── pr_url, report content

Layer 3: Agent Internal Context (large, ephemeral — NOT persisted)
  ├── files the agent read internally
  ├── internal reasoning and failed attempts
  └── tool call history (streamed via SSE but not in state)
```

**Layer 3 dies when the node completes.** The next node doesn't need to know the developer tried 3 approaches before finding the right one.

### The Filesystem as Shared Context

For code tasks, the git worktree IS the shared context:

```
Node A (developer):  edits files in /tmp/flowforge/wt/exec-42/
Node B (tester):     reads those same files, writes tests
Node C (reviewer):   reads git diff of the same worktree
```

You don't serialize "what code was written" into state. The tester reads the worktree directly. This is why FlowForge works better than LangGraph for code tasks — files are natural shared memory.

### Session Resume for Retry Loops

When tests fail and the developer node runs again:

```
First run:  Engine spawns new Claude Code process → gets sessionId "sess_abc"
Retry:      Engine calls SDK with resume: "sess_abc"
            → Claude Code resumes in the SAME session
            → Agent remembers all files it read, all decisions it made
            → Only needs the error context to know what to fix
            → 10-50x cheaper than spawning a new session
```

---

## 8. Secret Management

Three layers, checked in order (highest priority first):

```
1. Environment variables
   FLOWFORGE_SECRET_GITHUB_TOKEN=ghp_xxx

2. secrets.yml (local file, gitignored)
   secrets:
     GITHUB_TOKEN: ghp_xxx
     DB_PASSWORD: xxx

3. MongoDB (encrypted, managed via UI)
```

Workflows declare what secrets they need:
```yaml
context:
  secrets: [GITHUB_TOKEN]    # engine validates these exist before starting
```

Secrets are injected as env vars into agent subprocesses. Never logged, never stored in execution traces. UI shows a secrets management page.

---

## 9. Concurrent Executions

**Default:** Multiple executions can run simultaneously.

**Per-workflow limit:**
```yaml
context:
  concurrency: 1    # only 1 execution of this workflow at a time
```

**Same repo isolation:** Each execution that requires `repo` creates a git worktree:
```
Execution A: repo=/Users/shree/project → worktree /tmp/flowforge/wt/exec-A/
Execution B: repo=/Users/shree/project → worktree /tmp/flowforge/wt/exec-B/
```

Worktrees are cleaned up after execution completes. If concurrency limit is reached, new executions are queued with status `queued` and auto-dequeued when a slot opens.

---

## 10. Graph Validation

Before saving or running, the engine validates the graph:

| Check | Type | Description |
|-------|------|-------------|
| No orphan nodes | Error | Every node reachable from START |
| All edge refs exist | Error | No edges pointing to non-existent nodes |
| Path to END exists | Error | At least one path from START to END |
| Cycles have max_retries | Error | Every backward edge must have `max_retries` — otherwise infinite loop |
| Template vars have sources | Warning | `{{plan}}` used but no upstream node outputs `plan` |
| Condition vars exist | Warning | `test_passed` in condition but not in any output |
| All roles exist | Error | Referenced roles exist in `roles.yml` |
| Code functions exist | Error | Referenced built-in functions exist |
| Workflow refs exist | Error | `type: workflow` references valid workflow |
| Parallel forks have joins | Warning | Fork to `[test, build]` should have a corresponding join |
| max_retries is reasonable | Warning | `max_retries > 10` is suspicious |

**In UI:**
- Red badges on invalid nodes/edges in canvas
- Red squiggly underlines in Monaco YAML editor
- Cannot click "Run" if errors exist
- Yellow badges for warnings (can still run)

---

## 11. Cost Tracking

Claude Agent SDK exposes `costUsd` in response metadata when using API key auth. For subscription-based users (no API key), costs are estimated:

```typescript
// Estimation for subscription users
const COST_PER_TURN = {
  opus: 0.15,
  sonnet: 0.05,
  haiku: 0.01,
};
estimatedCost = COST_PER_TURN[model] * numTurns;
```

**Stored per node execution:**
```typescript
cost: {
  actual: 0.12,       // from SDK (null if subscription)
  estimated: 0.15,    // always calculated
  model: 'sonnet',
  turns: 3,
  method: 'sdk_reported' | 'estimated',
}
```

**Dashboard shows:** per-node cost, per-execution total, per-workflow average, daily/weekly trends, "Estimated" badge when using subscription.

---

## 12. Workflow Auto-Routing

Instead of manually choosing a workflow, the engine can auto-detect:

```yaml
# router.yml
rules:
  - match: [code, fix, build, implement, refactor, add, feature, bug]
    has_input: [repo_path]
    workflow: sdlc

  - match: [write, post, linkedin, twitter, blog, content, article]
    workflow: research-and-write

  - match: [analyze, report, how many, what percentage, distribution]
    workflow: data-analysis

  - match: [investigate, debug, why, root cause, failing, broken]
    has_input: [repo_path]
    workflow: investigate

  - match: [review, audit, check]
    has_input: [repo_path]
    workflow: review-only

  fallback: ask-user
```

```bash
# User just gives a task — engine picks the workflow
flowforge run --task "Add rate limiting to pricing API" --repo /path/to/repo
# → auto-selects sdlc

flowforge run --task "Write a LinkedIn post about pipeline improvements"
# → auto-selects research-and-write

flowforge run --task "Why are monitors failing at Stage 3?" --repo /path/to/repo
# → auto-selects investigate
```

---

## 13. Database Schema

### Collection: workflows
```typescript
{
  _id: ObjectId,
  name: string,                          // unique
  description: string,
  version: number,                       // auto-incremented on save
  yaml: string,                          // raw YAML — source of truth
  parsed: {                              // pre-parsed for engine
    context: object,
    inputSchema: object,
    nodes: Record<string, NodeDef>,
    edges: EdgeDef[],
  },
  reactFlowData: {                       // UI canvas positions
    nodes: ReactFlowNode[],
    edges: ReactFlowEdge[],
    viewport: { x: number, y: number, zoom: number },
  },
  validation: {
    valid: boolean,
    errors: string[],
    warnings: string[],
    lastValidated: Date,
  },
  tags: string[],
  createdBy: string,
  createdAt: Date,
  updatedAt: Date,
}
```

### Collection: roles
```typescript
{
  _id: ObjectId,
  name: string,                          // unique
  system: string,                        // system prompt
  model: string,                         // sonnet | opus | haiku
  tools: string[],
  icon: string,
  color: string,
  isBuiltIn: boolean,                    // true for default roles
  createdAt: Date,
  updatedAt: Date,
}
```

### Collection: executions
```typescript
{
  _id: ObjectId,
  workflowId: ObjectId,
  workflowName: string,
  workflowVersion: number,
  status: 'queued' | 'running' | 'waiting_for_input' | 'completed' | 'failed' | 'cancelled',
  input: Record<string, any>,
  state: Record<string, any>,            // current state bag
  sessions: Record<string, string>,      // node → Claude sessionId
  retryCounts: Record<string, number>,   // edgeKey → count
  currentNodes: string[],
  completedNodes: string[],
  failedNode: string | null,
  errorMessage: string | null,
  cost: { actual: number | null, estimated: number },
  durationMs: number,
  worktreePath: string | null,
  startedAt: Date,
  completedAt: Date | null,
  createdBy: string,
}
```

### Collection: execution_traces
```typescript
{
  _id: ObjectId,
  executionId: ObjectId,
  node: string,
  attempt: number,                       // 1 = first try, 2+ = retry
  status: 'running' | 'completed' | 'failed' | 'cancelled',
  type: 'agent' | 'code' | 'human' | 'workflow' | 'condition',
  role: string | null,

  // What went in
  inputState: Record<string, any>,       // state snapshot before node
  renderedPrompt: string | null,         // prompt after template rendering

  // What came out
  output: Record<string, any>,           // extracted structured outputs
  rawResponse: string | null,            // full agent text (truncated to 10KB)

  // Agent activity (streamed live via SSE)
  activity: Array<{
    timestamp: Date,
    type: 'text' | 'tool_start' | 'tool_complete' | 'tool_error',
    tool?: string,
    content: string,
  }>,

  // Telemetry
  sessionId: string | null,
  cost: { actual: number | null, estimated: number },
  durationMs: number,
  startedAt: Date,
  completedAt: Date | null,
}
```

### Collection: checkpoints
```typescript
{
  _id: ObjectId,
  executionId: ObjectId,
  afterNode: string,                     // checkpoint taken after this node
  state: Record<string, any>,
  sessions: Record<string, string>,
  retryCounts: Record<string, number>,
  completedNodes: string[],
  createdAt: Date,
}
```

---

## 14. API Endpoints

### Workflows
```
GET    /api/workflows                         → List all workflows
POST   /api/workflows                         → Create (YAML string or parsed JSON)
GET    /api/workflows/:id                     → Get workflow (YAML + React Flow data)
PUT    /api/workflows/:id                     → Update (auto-increments version)
DELETE /api/workflows/:id                     → Delete workflow
POST   /api/workflows/:id/validate            → Validate (returns errors/warnings)
GET    /api/workflows/:id/mermaid             → Mermaid diagram string
POST   /api/workflows/import                  → Import from YAML file upload
GET    /api/workflows/:id/export              → Export as YAML file download
```

### Roles
```
GET    /api/roles                             → List all roles
POST   /api/roles                             → Create custom role
PUT    /api/roles/:name                       → Update role
DELETE /api/roles/:name                       → Delete (custom roles only)
```

### Executions
```
POST   /api/executions                        → Start { workflowId, input }
GET    /api/executions                        → List (filter: status, workflowId, date)
GET    /api/executions/:id                    → Get execution detail
GET    /api/executions/:id/stream             → SSE live stream
POST   /api/executions/:id/cancel             → Cancel running execution
POST   /api/executions/:id/pause              → Pause at next node boundary
POST   /api/executions/:id/resume             → Resume paused execution
POST   /api/executions/:id/input              → Submit human-in-the-loop input
POST   /api/executions/:id/retry-from/:node   → Retry from specific node
```

### Execution Traces
```
GET    /api/executions/:id/traces             → All node traces
GET    /api/executions/:id/traces/:node       → Specific node (all attempts)
GET    /api/executions/:id/traces/:node/:attempt → Specific attempt detail
```

### Dashboard
```
GET    /api/dashboard/stats                   → Execution stats, cost summary
GET    /api/dashboard/cost                    → Cost breakdown by workflow/role/day
```

### Secrets
```
GET    /api/secrets                            → List secret keys (not values)
POST   /api/secrets                            → Add secret
PUT    /api/secrets/:key                       → Update secret
DELETE /api/secrets/:key                       → Delete secret
```

---

## 15. SSE Event Types

Streamed to `GET /api/executions/:id/stream`:

```typescript
// Graph-level
{ event: "execution_started",      data: { executionId, workflowName } }
{ event: "execution_completed",    data: { executionId, durationMs, cost } }
{ event: "execution_failed",       data: { executionId, failedNode, error } }

// Node-level
{ event: "node_started",           data: { node, role, attempt } }
{ event: "node_completed",         data: { node, attempt, output, durationMs, cost } }
{ event: "node_failed",            data: { node, attempt, error } }
{ event: "node_retrying",          data: { node, fromNode, attempt, retryContext } }

// Agent activity (inside a node)
{ event: "agent_text",             data: { node, text } }
{ event: "agent_tool_start",       data: { node, tool, args } }
{ event: "agent_tool_complete",    data: { node, tool, summary } }

// Human-in-the-loop
{ event: "input_required",         data: { node, prompt, fields } }
{ event: "input_received",         data: { node, data } }

// Parallel execution
{ event: "parallel_started",       data: { nodes, joinPolicy } }
{ event: "parallel_branch_done",   data: { node, status, remaining } }
{ event: "parallel_joined",        data: { nodes, allPassed } }
```

---

## 16. UI Screens

### Screen 1: Workflow List
- Grid/list of all workflows with name, description, tags, last run status
- "New Workflow" button → opens builder
- Click workflow → opens builder

### Screen 2: Workflow Builder (Drag & Drop)
- **Left panel:** Node palette — drag roles, built-ins, human nodes, workflow nodes onto canvas
- **Center:** React Flow canvas — nodes, edges, click + drag to connect
- **Bottom panel:** Node properties — prompt editor (Monaco), role selector, outputs, retry config
- **Toggle:** Visual ↔ YAML mode (bidirectional sync)
- **Right panel (YAML mode):** Live Mermaid preview that updates as you type
- **Top bar:** Save, Validate, Run, Version history

### Screen 3: Live Execution Monitor
- **Top:** Animated graph with status-colored nodes (green=done, blue=running, red=failed, gray=pending) and retry count badges
- **Left:** Timeline of all events in chronological order
- **Right:** Node detail panel — click any node to see input state, rendered prompt, live streaming output, extracted outputs, activity log
- **Bottom:** Execution log table — all nodes with status, duration, cost
- **Actions:** Cancel, Pause, Submit human input (dialog)

### Screen 4: Execution History
- Filterable/sortable table of all executions
- Click row → opens full execution detail (same layout as monitor, but with completed data)
- Actions: Re-run, Retry from node, Export trace as JSON

### Screen 5: Role Manager
- List of all roles with icon, name, model, tools
- Click to edit: system prompt (Monaco editor), model selector, tool checkboxes, icon/color picker
- "Test Role" button — quick test with a sample prompt

### Screen 6: Dashboard
- Execution count over time
- Cost breakdown by workflow and role
- Success/failure rate per workflow
- Average duration per workflow
- Active/queued executions

---

## 17. Project Structure

```
flowforge/
├── packages/
│   ├── engine/                          # Core graph engine (standalone)
│   │   ├── src/
│   │   │   ├── engine.ts                # Graph executor (~300 lines)
│   │   │   ├── node-executor.ts         # SDK + code + human + subgraph (~200)
│   │   │   ├── state-manager.ts         # State flow + MongoDB checkpoints (~120)
│   │   │   ├── condition-parser.ts      # Edge condition evaluator using filtrex (~60)
│   │   │   ├── template.ts              # Handlebars rendering (~30)
│   │   │   ├── validator.ts             # Graph validation (~150)
│   │   │   ├── visualizer.ts            # YAML → Mermaid (~80)
│   │   │   ├── output-extractor.ts      # JSON + regex + LLM fallback (~100)
│   │   │   ├── parallel.ts              # Parallel execution, join policies, state merge (~100)
│   │   │   ├── router.ts                # Auto-select workflow from task (~80)
│   │   │   ├── types.ts                 # TypeScript types (~100)
│   │   │   ├── built-ins/
│   │   │   │   ├── git.ts               # branch, commit, push, PR (~150)
│   │   │   │   ├── build.ts             # auto-detect npm/cargo/make (~80)
│   │   │   │   ├── classify.ts          # task classification (~50)
│   │   │   │   └── prompt-user.ts       # human-in-the-loop bridge (~30)
│   │   │   └── cli.ts                   # CLI entry point (~50)
│   │   ├── workflows/                   # Default workflow templates
│   │   │   ├── sdlc.yml
│   │   │   ├── bugfix.yml
│   │   │   ├── research-and-write.yml
│   │   │   ├── data-analysis.yml
│   │   │   ├── investigate.yml
│   │   │   └── review-only.yml
│   │   ├── roles.yml                    # Default roles
│   │   ├── router.yml                   # Auto-routing rules
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── server/                          # Express API
│   │   ├── src/
│   │   │   ├── app.ts                   # Express setup + middleware
│   │   │   ├── routes/
│   │   │   │   ├── workflow.routes.ts
│   │   │   │   ├── execution.routes.ts
│   │   │   │   ├── role.routes.ts
│   │   │   │   ├── stream.routes.ts     # SSE endpoints
│   │   │   │   ├── secret.routes.ts
│   │   │   │   └── dashboard.routes.ts
│   │   │   ├── services/
│   │   │   │   ├── workflow.service.ts
│   │   │   │   ├── execution.service.ts
│   │   │   │   ├── stream.service.ts    # SSE broadcasting
│   │   │   │   ├── secret.service.ts
│   │   │   │   └── dashboard.service.ts
│   │   │   ├── database/
│   │   │   │   ├── mongo.ts
│   │   │   │   └── indexes.ts
│   │   │   └── types.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── ui/                              # React SPA
│       ├── src/
│       │   ├── App.tsx
│       │   ├── pages/
│       │   │   ├── WorkflowListPage.tsx
│       │   │   ├── WorkflowBuilderPage.tsx
│       │   │   ├── ExecutionListPage.tsx
│       │   │   ├── ExecutionDetailPage.tsx
│       │   │   ├── RoleManagerPage.tsx
│       │   │   └── DashboardPage.tsx
│       │   ├── components/
│       │   │   ├── canvas/              # React Flow graph builder
│       │   │   │   ├── Canvas.tsx
│       │   │   │   ├── AgentNode.tsx
│       │   │   │   ├── CodeNode.tsx
│       │   │   │   ├── HumanNode.tsx
│       │   │   │   ├── WorkflowNode.tsx
│       │   │   │   ├── ConditionalEdge.tsx
│       │   │   │   ├── RetryEdge.tsx
│       │   │   │   ├── NodePalette.tsx
│       │   │   │   └── NodeProperties.tsx
│       │   │   ├── editor/              # Monaco YAML editor
│       │   │   │   ├── YamlEditor.tsx
│       │   │   │   ├── yaml-schema.ts
│       │   │   │   └── MermaidPreview.tsx
│       │   │   ├── execution/           # Live monitor
│       │   │   │   ├── LiveGraph.tsx
│       │   │   │   ├── Timeline.tsx
│       │   │   │   ├── NodeDetail.tsx
│       │   │   │   ├── StreamOutput.tsx
│       │   │   │   └── HumanInputDialog.tsx
│       │   │   └── common/
│       │   │       ├── StatusBadge.tsx
│       │   │       ├── CostDisplay.tsx
│       │   │       └── RoleIcon.tsx
│       │   ├── hooks/
│       │   │   ├── useWorkflows.ts
│       │   │   ├── useExecution.ts
│       │   │   ├── useSSE.ts
│       │   │   └── useRoles.ts
│       │   ├── services/
│       │   │   └── api.ts
│       │   └── lib/
│       │       ├── yaml-to-reactflow.ts
│       │       ├── reactflow-to-yaml.ts
│       │       └── mermaid-generator.ts
│       ├── package.json
│       └── tsconfig.json
│
├── docker-compose.yml                   # MongoDB + server + UI
├── turbo.json                           # Turborepo config
├── package.json                         # Root
└── README.md
```

---

## 18. Deployment

### Local Development
```bash
git clone github.com/your-org/flowforge
cd flowforge
npm install
docker compose up -d mongodb
npm run dev                    # server (4000) + UI (5173)
```

### Docker Compose (Full Stack)
```yaml
version: '3.8'
services:
  mongodb:
    image: mongo:7
    ports: ["27017:27017"]
    volumes: [flowforge-data:/data/db]

  server:
    build: ./packages/server
    ports: ["4000:4000"]
    environment:
      MONGODB_URI: mongodb://mongodb:27017/flowforge
    volumes:
      - ~/.claude:/root/.claude:ro       # Claude Code auth
    depends_on: [mongodb]

  ui:
    build: ./packages/ui
    ports: ["5173:5173"]
    depends_on: [server]

volumes:
  flowforge-data:
```

### Quick Start
```bash
npx flowforge                  # downloads, starts everything
npx flowforge --port 8080     # custom port
```

---

## 19. Example Workflows

### SDLC (Code Changes)
```yaml
name: sdlc
description: Full software development lifecycle
context: { requires: [repo], tools: [filesystem, git, terminal] }
input:
  task: { type: string, required: true }
  repo_path: { type: string, required: true }

nodes:
  plan: { role: planner, prompt: "Break down: {{task}}", outputs: [plan] }
  create-branch: { type: code, function: git-create-branch, outputs: [worktree_path, branch_name] }
  implement:
    role: developer
    prompt: |
      Implement in {{worktree_path}}:
      {{plan}}
      {{#if retry_context}}FIX: {{retry_context}}{{/if}}
    outputs: [changed_files, summary]
    resume_on_retry: true
  test: { role: tester, prompt: "Test changes in {{worktree_path}}: {{changed_files}}", outputs: [test_passed, test_output] }
  build: { type: code, function: run-build, retries: 1, outputs: [build_passed, build_errors] }
  review:
    role: reviewer
    prompt: "Review {{worktree_path}} on {{branch_name}}. Verdict: APPROVED or REQUEST_CHANGES."
    outputs: [review_verdict, review_feedback]
  create-pr: { role: git-ops, prompt: "Create PR from {{branch_name}}: {{summary}}", outputs: [pr_url] }

edges:
  - { from: START, to: plan }
  - { from: plan, to: create-branch }
  - { from: create-branch, to: implement }
  - { from: implement, to: [test, build], parallel: true, join: wait-all }
  - { from: [test, build], to: review, condition: "test_passed AND build_passed" }
  - { from: [test, build], to: implement, condition: "NOT test_passed OR NOT build_passed", max_retries: 3, retry_context: "{{test_output}}\n{{build_errors}}" }
  - { from: review, to: create-pr, condition: "review_verdict == 'APPROVED'" }
  - { from: review, to: implement, condition: "review_verdict == 'REQUEST_CHANGES'", max_retries: 3, retry_context: "{{review_feedback}}" }
  - { from: create-pr, to: END }
```

### Quick Bugfix
```yaml
name: bugfix
context: { requires: [repo], tools: [filesystem, git, terminal] }
input:
  task: { type: string, required: true }
  repo_path: { type: string, required: true }

nodes:
  analyze: { role: investigator, prompt: "Find root cause: {{task}}", outputs: [root_cause, affected_files] }
  branch: { type: code, function: git-create-branch, outputs: [worktree_path, branch_name] }
  fix: { role: developer, prompt: "Fix {{root_cause}} in {{worktree_path}}. {{#if retry_context}}Errors: {{retry_context}}{{/if}}", outputs: [changed_files], resume_on_retry: true }
  test: { role: tester, prompt: "Test the fix in {{worktree_path}}", outputs: [test_passed, test_output] }
  pr: { role: git-ops, prompt: "Create bugfix PR from {{branch_name}}", outputs: [pr_url] }

edges:
  - { from: START, to: analyze }
  - { from: analyze, to: branch }
  - { from: branch, to: fix }
  - { from: fix, to: test }
  - { from: test, to: pr, condition: "test_passed" }
  - { from: test, to: fix, condition: "NOT test_passed", max_retries: 3, retry_context: "{{test_output}}" }
  - { from: pr, to: END }
```

### LinkedIn Post
```yaml
name: linkedin-post
description: Research and write a LinkedIn post
context: { requires: [], tools: [web-search, web-fetch] }
input:
  topic: { type: string, required: true }
  tone: { type: string, default: professional }

nodes:
  research: { role: researcher, prompt: "Research deeply: {{topic}}", outputs: [findings, key_stats, angles] }
  draft:
    role: writer
    prompt: |
      Write a LinkedIn post about: {{topic}}
      Tone: {{tone}}
      Findings: {{findings}}
      Stats: {{key_stats}}
      500-800 words. Hook in first line. End with question.
      {{#if retry_context}}REVISION NOTES: {{retry_context}}{{/if}}
    outputs: [draft]
  review: { role: editor, prompt: "Review LinkedIn post:\n{{draft}}\nVerdict: PUBLISH or REVISE.", outputs: [verdict, feedback] }
  format: { role: formatter, prompt: "Format for LinkedIn with hashtags and line breaks:\n{{draft}}", outputs: [final_post] }

edges:
  - { from: START, to: research }
  - { from: research, to: draft }
  - { from: draft, to: review }
  - { from: review, to: format, condition: "verdict == 'PUBLISH'" }
  - { from: review, to: draft, condition: "verdict == 'REVISE'", max_retries: 2, retry_context: "{{feedback}}" }
  - { from: format, to: END }
```

### Data Analysis
```yaml
name: data-analysis
description: Analyze data and generate a report
context: { requires: [], tools: [filesystem, terminal, database] }
input:
  question: { type: string, required: true }
  repo_path: { type: string, required: false }

nodes:
  plan: { role: analyst, prompt: "Plan analysis for: {{question}}", outputs: [analysis_plan, data_sources] }
  query: { role: analyst, prompt: "Execute queries:\n{{analysis_plan}}", outputs: [raw_results, anomalies] }
  synthesize: { role: analyst, prompt: "Synthesize:\nResults: {{raw_results}}\nAnomalies: {{anomalies}}", outputs: [summary, insights, recommendations] }
  report: { role: writer, prompt: "Write report:\n{{summary}}\n{{insights}}\n{{recommendations}}", outputs: [report] }

edges:
  - { from: START, to: plan }
  - { from: plan, to: query }
  - { from: query, to: synthesize }
  - { from: synthesize, to: report }
  - { from: report, to: END }
```

### Investigation with Human Decision
```yaml
name: investigate
description: Investigate a problem and decide whether to fix
context: { requires: [repo], tools: [filesystem, terminal, database, web-search] }
input:
  problem: { type: string, required: true }
  repo_path: { type: string, required: true }

nodes:
  gather: { role: investigator, prompt: "Investigate: {{problem}}", outputs: [evidence, hypotheses] }
  verify: { role: investigator, prompt: "Test hypotheses:\n{{hypotheses}}\nEvidence: {{evidence}}", outputs: [root_cause, confidence] }
  decide:
    type: human
    prompt: "Root cause: {{root_cause}} (confidence: {{confidence}}). What should we do?"
    fields:
      - { name: action, type: select, options: [fix-now, report-only, investigate-more] }
      - { name: notes, type: text, required: false }
    outputs: [action, notes]
  fix:
    type: workflow
    workflow: bugfix
    input_map: { task: "Fix: {{root_cause}}", repo_path: "{{repo_path}}" }
    output_map: { pr_url: fix_pr_url }
  report: { role: writer, prompt: "Write incident report:\nProblem: {{problem}}\nRoot cause: {{root_cause}}\nEvidence: {{evidence}}", outputs: [incident_report] }

edges:
  - { from: START, to: gather }
  - { from: gather, to: verify }
  - { from: verify, to: gather, condition: "confidence < 0.7", max_retries: 2 }
  - { from: verify, to: decide, condition: "confidence >= 0.7" }
  - { from: decide, to: fix, condition: "action == 'fix-now'" }
  - { from: decide, to: report, condition: "action == 'report-only'" }
  - { from: decide, to: gather, condition: "action == 'investigate-more'", max_retries: 1 }
  - { from: fix, to: report }
  - { from: report, to: END }
```

### Hybrid: Ship Feature + Announce
```yaml
name: ship-and-announce
description: Ship a feature and write a LinkedIn post about it
input:
  task: { type: string, required: true }
  repo_path: { type: string, required: true }

nodes:
  ship:
    type: workflow
    workflow: sdlc
    input_map: { task: "{{task}}", repo_path: "{{repo_path}}" }
    output_map: { pr_url: pr_url, changed_files: changed_files }

  announce:
    type: workflow
    workflow: linkedin-post
    input_map: { topic: "We just shipped: {{task}}. PR: {{pr_url}}" }
    output_map: { final_post: announcement }

edges:
  - { from: START, to: ship }
  - { from: ship, to: announce }
  - { from: announce, to: END }
```

---

## 20. Visualization

### Static (before execution)
Engine reads any workflow YAML and generates a Mermaid diagram:
```bash
flowforge visualize workflows/sdlc.yml           # outputs Mermaid to stdout
flowforge visualize workflows/sdlc.yml --png      # renders PNG
```

**UI:** Live Mermaid preview panel next to YAML editor, auto-updates on edit.

### Live (during execution)
SSE events update the graph in real-time:
- Nodes change color: gray → blue (running) → green (done) / red (failed)
- Retry edges pulse with attempt count badges
- Parallel branches show progress independently
- Timeline scrolls with events as they happen

### Post-execution (replay)
Full execution trace shows the exact path taken:
- Which edges were followed
- Which retry loops occurred (with attempt numbers)
- Duration and cost per node
- Click any node to inspect input/output/activity

---

## 21. Adding Capabilities — Zero Code Changes

| Want to add... | Do this |
|----------------|---------|
| New kind of work | Create a workflow YAML file |
| New kind of agent | Add a role in `roles.yml` or via UI |
| New built-in action | Add a function in `built-ins/` (only code change needed) |
| New repo | Just pass `repo_path` at runtime |
| Auto-routing for new workflow | Add a rule in `router.yml` |

**Engine code is never touched after v1** unless adding new built-in functions.

---

## 22. Build Phases

| Phase | What | Deliverables | Effort |
|-------|------|--------------|--------|
| **1** | Engine core | Graph executor, node executor (SDK), state manager, condition parser, template renderer, output extractor, CLI | 3-4 days |
| **2** | Built-ins + workflows | Git ops, build detection, default YAML workflows, roles, validator, visualizer | 2 days |
| **3** | Server + API | Express server, workflow CRUD, execution CRUD, SSE streaming, MongoDB | 2-3 days |
| **4** | UI — Execution monitor | Live graph, timeline, node detail, stream output, SSE hook | 3-4 days |
| **5** | UI — YAML editor | Monaco editor, YAML schema, live Mermaid preview, validation display | 2-3 days |
| **6** | UI — Drag & drop builder | React Flow canvas, custom nodes/edges, palette, properties panel, bidirectional YAML sync | 4-5 days |
| **7** | Advanced features | Human-in-the-loop, subgraphs, parallel join policies, cost dashboard, role manager, secrets | 3-4 days |
| **8** | Polish + deployment | Docker compose, README, default workflow tuning, error handling, edge cases | 2 days |

**Total: ~4 weeks for full v1**

Phase 1-3 give you a working CLI + API. Phase 4 adds visibility. Phase 5-6 give you the visual builder. Phase 7-8 complete the product.
