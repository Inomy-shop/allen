# Workflow Execution — How It Actually Works

An end-to-end reference for how Allen runs a workflow: entry points, graph
traversal, node execution for each of the five node types, the retry system
(both in-engine edge retries and operator-initiated retry-from-node), log
streaming, checkpoints, and all the surrounding machinery.

This document describes what the code **does**, with direct references to the
files and line numbers so you can verify every claim.

---

## 1. The three packages and their responsibilities

- **`packages/engine`** — pure execution engine. Knows how to walk a workflow
  graph, call agents via the Claude Code SDK, evaluate edge conditions, manage
  state/checkpoints/retries, and emit SSE events. Has no HTTP layer.
- **`packages/server`** — Express app. Owns MongoDB, authentication, routes,
  intervention plumbing, workspace management, and the SSE transport. Wraps
  the engine and runs it inside the server process.
- **`packages/ui`** — React app. Subscribes to SSE, polls logs for agent runs,
  renders the execution detail page, and provides the Retry-from-node button.

The engine runs **in-process** with the server. There is no network hop
between them — built-ins can reach server infrastructure via the in-process
`services` hook (`packages/engine/src/types.ts:EngineServices`). There **is**
a network hop between agent subprocesses (claude-cli / codex-cli) and the
engine, which goes through the Allen MCP server over stdio JSON-RPC.

---

## 2. Data model — what lives where

Every execution touches five MongoDB collections:

| Collection | Purpose | Written by |
|---|---|---|
| `executions` | One row per run. Holds status, input, live state, sessions, retryCounts, currentNodes, completedNodes, cost, failedNode, errorMessage. | `StateManager.createExecution` / `updateExecution` |
| `checkpoints` | One row per node completion. Snapshot of state + sessions + retryCounts + completedNodes **after** that node ran. Used by retry-from-node to rewind. | `StateManager.saveCheckpoint` (`engine.ts:767`) |
| `execution_traces` | One row per node attempt. Inputs, rendered prompt, raw response, extracted outputs, cost, duration, sessionId. | `StateManager.saveTrace` (`engine.ts:764`) |
| `execution_logs` | Stream of log entries — one per event. Written as events are broadcast. | `stream.service.ts:59` (fire-and-forget on every `execution_log` event) |
| `execution_failure_reports` | Forensics doc written when an execution transitions to `failed`. Contains failure type, failed node, gate diagnostic fields, final state. | `StateManager.saveFailureReport` (`state-manager.ts:23`) |

Plus `workflow_interventions` for human-in-the-loop intervention records
(`packages/server/src/services/intervention.service.ts`), which the engine
never writes directly — the server's intervention hook writes them in
response to `input_required` events.

---

## 3. `ExecutionState` — what the engine carries

Defined in `packages/engine/src/types.ts`. The same object is updated in
memory during a run and persisted to `executions` at every transition:

```ts
{
  id: string;                                  // UUID — same as the document key
  workflowId: string;                          // Mongo _id of the workflow doc (empty for ephemeral/agent runs)
  workflowName: string;
  workflowVersion: number;
  status: 'running' | 'queued' | 'waiting_for_input' | 'completed' | 'failed';
  input: Record<string, unknown>;              // Immutable — the form data submitted
  state: Record<string, unknown>;              // Mutable — starts = {...input}, each node merges its outputs in
  sessions: Record<string, string>;            // nodeName → claude-cli session id from the last successful run
  retryCounts: Record<string, number>;         // edgeKey → count, for max_retries enforcement
  currentNodes: string[];                      // What the engine is currently about to run (or running)
  completedNodes: string[];                    // Append-only — every node that has finished, in order
  cost: { actual: number | null; estimated: number };
  failedNode?: string;                         // Set when a node throws; cleared on retry-from-node
  errorMessage?: string;                       // Final error string, same
  durationMs: number;
  startedAt: Date;
  completedAt?: Date;
}
```

Convention: any key in `state` starting with `__` is an engine-private field
(`__retry_target`, `__retry_attempt`, `__retry_source`, `__gate_action`,
`__contextTags`, `__waiting_for_input`, etc.). These are never exposed to edge
conditions or prompt templates without explicit access.

---

## 4. Entry points

There are three ways an execution gets launched, and they all end in the same
place: `ExecutionService.launchExecution()`.

### 4a. `POST /api/executions` → `ExecutionService.start()`
(`packages/server/src/services/execution.service.ts:93`)

- Loads the workflow doc by `_id`.
- Checks `workflow.context?.concurrency`: if the count of `running` +
  `waiting_for_input` executions for this workflow name is already at the
  limit, inserts the execution into Mongo with `status: 'queued'` and returns
  immediately. The queue is drained by `dequeueNext()` when a slot frees up.
- Otherwise calls `trackRepoUsage(input)` then `launchExecution()`.

### 4b. `POST /api/executions/:id/retry-from/:node` → `ExecutionService.retryFromNode()`
(`execution.service.ts:296` → `engine.ts:242`)

- Loads the workflow doc for the existing execution.
- Builds a fresh `EngineConfig` (with services, emitter, workflows, agents,
  builtIns, db).
- Calls `engine.retryFromNode(workflow, executionId, nodeName)`.
- Inside the engine (`engine.ts:242-320`):
  1. `stateManager.getCheckpointBefore(executionId, nodeName)` — queries the
     `checkpoints` collection for the latest checkpoint whose `completedNodes`
     does NOT include `nodeName`, sorted by `createdAt desc`. This is the
     snapshot taken BEFORE that node ran.
  2. Slices `completedNodes` to drop `nodeName` and everything after it.
  3. Builds a fresh `ExecutionState` from the checkpoint: restored `state`,
     `sessions`, `retryCounts`; truncated `completedNodes`; status=`running`.
  4. Persists the rewound state to Mongo (`updateExecution`).
  5. Emits `execution_started` on the SSE stream so the UI re-opens the live
     view.
  6. Calls `executeGraph(workflow, exec, 0)` — which picks up from the target
     node because `completedNodes.length > 0` and `getNextNodes` returns
     `[nodeName]`.

Agent sessions are preserved. If the failed node had a `resume_on_retry: true`
config, the restored `sessions[nodeName]` will be used when it re-runs, so the
agent resumes mid-conversation with all prior turns intact.

### 4c. `InterventionService.respond()` with `request_changes`
(`packages/server/src/routes/intervention.routes.ts:186-205`)

Internal use — when a user clicks "request changes" on a pending intervention,
the respond handler patches fields into `exec.state` and calls
`executionService.retryFromNode(...)` targeting whichever node the
intervention's `retry_target` points to. Same code path as 4b.

---

## 5. `launchExecution()` — building the engine

`execution.service.ts:143-194`. This is the single gate every run passes
through before the engine starts.

```text
1. createSSEEmitter(executionId)       — the bare SSE emitter, broadcasts to
                                         all /api/executions/:id/stream subscribers
2. wrapEmitterWithInterventionHook(...)— middleware emitter: forwards every
                                         event to the SSE emitter AND on
                                         `input_required`, creates a
                                         workflow_interventions record + fires
                                         a Slack notification
3. Load all workflow defs from Mongo   — needed so nested `type: workflow`
                                         nodes can resolve by name
4. Build EngineConfig:
     { db, agents, builtIns, workflows, emitter, services }
5. new AllenEngine(config)
6. runningEngines.set(executionId, engine)  — so cancel/pause can find it
7. engine.run(workflow, input, 0, { executionId, workflowId })  — fire-and-forget
     .finally(() => {
       runningEngines.delete(executionId);
       dequeueNext(workflow.name);            — advance the concurrency queue
     })
```

`engine.run` is not awaited — it runs on the Node event loop while
`launchExecution` returns `{ id, status: 'running' }` to the HTTP caller
synchronously.

---

## 6. `engine.run()` — the outer loop

`engine.ts:61-180`.

1. Depth check — throws if `nestingDepth >= maxNestingDepth` (default 3) to
   prevent runaway `type: workflow` recursion.
2. Builds a fresh `ExecutionState` (same shape as §3) with `state = {...input}`
   and persists it via `stateManager.createExecution`.
3. Emits `execution_started`.
4. Calls `executeGraph(workflow, exec, nestingDepth)` inside a try/catch.
5. On success:
   - Marks `status = 'completed'`, sets `completedAt`, `durationMs`, `state`,
     `cost`.
   - Persists via `updateExecution`.
   - Emits `execution_completed`.
   - Fires `triggerPostExecutionReview(exec)` — the learning system's
     post-hoc analysis pass (`engine.ts:352`).
6. On failure:
   - Marks `status = 'failed'`, captures `failedNode` and `errorMessage`.
   - Writes to `execution_failure_reports` via `saveFailureReport`.
   - Emits `execution_failed` with `{ executionId, failedNode, error }`.
   - Fires the post-execution review for forensics.
   - Re-throws? No — `.catch(() => {})` in `launchExecution` swallows it.
     The failure is already persisted + streamed, so no surface needs the
     exception.

Two sibling methods, `resumeExistingExecution` (for `waiting_for_input` resume
after human input submit) and `retryFromNode`, share most of the same
try/catch structure (`engine.ts:180-320`).

---

## 7. `executeGraph()` — the inner loop

`engine.ts:385-595`. This is the graph walker. Runs per execution.

### 7a. Finding the start
- `getStartNodes(edges)` returns the `to` of the edge whose `from === 'START'`.
- If `exec.completedNodes` is non-empty (retry-from-node or waiting_for_input
  resume), it calls `getNextNodes` on the completed set to figure out where
  to pick back up.

### 7b. Per-iteration work
Inside `while (currentNodes.length > 0)`:

1. **Cancellation check.** `cancelledExecutions` is a `Set<string>` owned by
   the engine instance. If the execution is in it, throws
   `Execution cancelled`. The abort signal from `AbortController` is the
   mechanism that actually kills running subprocesses — see §11.
2. **Pause check.** If `pausedExecutions` has this id, marks status
   `waiting_for_input`, sleeps 1s, loops. Pausing is cooperative — it waits
   for the current node's subprocess to hit a pause point, it does not kill.
3. **Persist live state:** `updateExecution({ currentNodes, state, status: 'running' })`.
4. **Parallel edge detection.** If `currentNodes` exactly matches the `to` of
   a parallel edge (`edge.parallel === true`), it dispatches to
   `executeParallelNodes` (§10).
5. **Otherwise, run each node in sequence.** For each name in `currentNodes`:
   - Skip if it's `'END'`.
   - Call `executeSingleNode(nodeName, nodeDef, exec, nestingDepth, edges, workflow)`.
   - That returns a gate action: `'continue'`, `'stop'`, `'skip'`, or `'clarify'`.
   - `stop`/`skip` → exit the graph immediately and return `exec.state`.
   - `clarify` → pause at this node and wait for human input (§8e).
6. **Routing.** After the iteration, `justFinished = currentNodes.filter(n => n !== 'END')`.
   `currentNodes = getNextNodes(completedNodes, edges, state, retryCounts, execId, justFinished)`.
   This is where condition evaluation, retry edges, and join checks happen —
   see §9.
7. If the next `currentNodes` contains `'END'` or is empty, the loop breaks.

### 7c. What `getNextNodes` does
`engine.ts:1161-1305`. For each edge:

- Skip if source is `'START'`.
- Build `effectiveCompleted = completedNodes ∪ justFinished`. This is the set
  a forward edge checks against (`allFromCompleted`).
- **Retry edges** (edges with `max_retries != null`): only fire if at least
  one source node is in `justFinished`. This is the hack that prevents
  retry-loop explosion on stale completedNodes.
- **Forward edges**: skip if every target is already in `effectiveCompleted`
  (prevents re-firing an already-consumed edge).
- **Condition**: if `edge.condition` is set, `evaluateCondition(expression, state)`
  — filtrex, with uppercase `AND`/`OR`/`NOT` normalized to lowercase and
  `true`/`false` pre-populated as `1`/`0` in a safe state copy
  (`condition-parser.ts`). Emits a `condition` log line with `{ expression, result }`.
- **Retry enforcement**: builds `edgeKey = "from→to"`. If
  `retryCounts[edgeKey] >= max_retries`, throws. Otherwise increments,
  synthesises `retry_context` from `edge.retry_context` (templated) OR from
  `synthesiseRetryContext(fromNodes, state)` which picks diagnostic keys
  (`answers`, `approved`, `failed_checks`, `review_feedback`, etc.).
- Sets `state.__retry_target = targets`, `state.__retry_attempt = count + 2`,
  `state.__retry_source = fromNodes.join(',')`.
- Logs `Retry attempt N/MAX` at warn level, emits `node_retrying`.
- **Rewinds downstream history**: `findDownstreamNodes(targets, edges)` BFS
  forward (ignoring retry edges), then splices those nodes out of
  `completedNodes`. This is what lets a retry cycle re-run everything that
  was downstream of the retry target.
- Appends edge targets to the next-nodes list.

Deduped, logged as `Routing to: X, Y` at category `routing`, returned.

---

## 8. `executeSingleNode()` — the node dispatcher

`engine.ts:602-900`. This is the shared wrapper that every node type flows
through, regardless of whether it's an agent, code, human, workflow, or
condition node.

### 8a. Attempt counting
`attempt = completedNodes.filter(n => n === nodeName).length + 1`. This means
the second execution of `qa` gets `attempt: 2` in its trace — used for trace
display and for the agent-call retry counter inside the executor.

### 8b. Auto-gate setup
`hasConditionalOutEdges = edges.some(e => e.from includes nodeName && (e.condition || e.max_retries))`.
If an agent node has **no** conditional or retry edges leaving it, the engine
builds an auto-gate instruction via `buildNodeContext(...)` and appends it to
`nodeContext`. This is what tells the agent to emit `STOP`/`SKIP`/`CLARIFY`
tokens that the engine parses out of raw response via
`extractAutoGateFields`.

### 8c. Learning injection
`engine.ts:637-660`. For agent nodes only:
`learningManager.query(contextTags, workflowName, agent, nodeName, 550)`
returns up to 550 tokens of relevant learnings. They're appended to
`nodeContext` and logged as
`[learning] Injected N learnings (tokens: X/550): "...", "...", ...`.

### 8d. Dispatching
`engine.ts:663-685`. Creates a per-node `AbortController` (stored in
`abortControllers.set(execId, ac)`), emits a `Node started` log, and calls:

```ts
const result = await executeNode(nodeName, nodeDef, exec.state, exec.sessions, deps);
```

`deps: NodeExecutorDeps` carries agents, builtIns, workflows, emitter,
runWorkflow (for nested workflows), executionId, nodeContext, db, services,
abortSignal.

Inside `executeNode` (`node-executor.ts:63`), the `switch (nodeDef.type)`
dispatches to one of five handlers. See §11.

### 8e. Handling the result
1. **Human-node wait.** If `result.outputs.__waiting_for_input` is set, marks
   status `waiting_for_input`, saves a checkpoint, and calls `waitForInput()`
   — which blocks on a `Promise` stored in `pendingInputResolvers`. The
   intervention respond handler or `submitInput` HTTP call resolves this
   promise with the human-provided data.
2. **Merge outputs into state.** `Object.assign(exec.state, result.outputs)`.
3. **Consume retry payload.** If the node just ran as a retry target,
   delete `retry_context`, `__retry_target`, `__retry_attempt`, `__retry_source`
   from state so downstream forward-path nodes don't see stale feedback
   (`engine.ts:724-730`).
4. **Track session.** If `result.sessionId` is set, write
   `exec.sessions[nodeName] = result.sessionId`.
5. **Cost accumulation.** `exec.cost.estimated += result.cost.estimated`; if
   `result.cost.actual != null`, add it to `exec.cost.actual`.
6. **Append to completedNodes** and **save trace + checkpoint** (two separate
   Mongo writes — traces are permanent history, checkpoints are rewind
   targets).
7. **Log completion:** `Node completed in Ns — cost: $X.XXXX`.
8. **Log extracted outputs:** `Extracted outputs: key1, key2, ...` (skips keys
   starting with `__`).
9. **Emit `node_completed`** with `{ node, attempt, output, durationMs, cost }`.
10. **Confirm learnings** via `learningManager.confirm(lid, execId)` for each
    injected learning id — marks them as "helped this run".
11. **Extract agent-emitted learnings** from `result.outputs.__learnings`.
12. **Auto-gate parsing** for agent nodes without conditional edges.
    `extractAutoGateFields(rawResponse, outputs)` returns `{ action, reason, clarifyAction, clarifyFields }`.
    If `action !== 'continue'`, stores it in `state.__gate_*` fields and
    returns the action to the caller (`continue`/`stop`/`skip`/`clarify`).

### 8f. On error
`catch (err)`:
- `exec.failedNode = nodeName`.
- Emits `node_failed` with `{ node, attempt, error: message }`.
- `learningManager.contradict(lid, execId)` for each injected learning —
  marks them as "didn't help / hurt".
- Re-throws so `executeGraph` exits the loop and `run()` catches it at the
  top level.

---

## 9. Retry — three distinct mechanisms

This is the most-confused part of the system. There are **three** orthogonal
retry mechanisms operating at different layers:

### 9a. In-node retry — transient SDK crashes
Inside `executeAgentNode()` (`node-executor.ts:~380`) the engine wraps the
Claude Code SDK's `query()` call in a 3-attempt loop with a 5-second cooldown
between attempts. It only retries on errors matching
`/exited with code 1|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up/i`.
This exists because back-to-back claude-cli subprocess spawns sometimes fail
to acquire `~/.claude/` session locks. Logged as
`[agent-call] Transient error on attempt N, retrying after 5s cooldown: <msg>`.
Not related to the workflow-level retry edges.

### 9b. Edge retry — workflow-level loops
Set on an edge as `max_retries: N` (+ optional `retry_context` template).
Managed entirely by `getNextNodes` (§7c). Fires on the FORWARD traversal when
the source node is in `justFinished` and the edge's condition (if any) is
true. Increments `retryCounts[edgeKey]`, builds `retry_context`, sets
`__retry_target`/`__retry_attempt`/`__retry_source` in state, rewinds
downstream `completedNodes`, and routes to the target.

The target node, when it executes, checks `state.__retry_target` to decide
whether to send a **minimal retry prompt** (`node-executor.ts:147-175`) vs.
the full templated prompt. The minimal retry prompt says "you're being re-run,
here's the feedback, address it and re-emit your JSON" — it's designed to be
sent over a RESUMED agent session so the agent already has the original task
context and doesn't need it re-sent.

After the retry target completes, `executeSingleNode` consumes (deletes) the
retry payload from state so the next forward-path node doesn't see stale
feedback (`engine.ts:724-730`).

**Max retries exceeded** throws inside `getNextNodes`. The throw bubbles up
to `executeGraph`'s loop and then to `run()`'s top-level catch, where it
becomes a failed execution.

### 9c. Operator retry — retry-from-node
`engine.retryFromNode(workflow, executionId, nodeName)` (`engine.ts:242-320`).
Rewinds the execution to the checkpoint taken BEFORE the specified node, then
re-enters `executeGraph` from that point. Detailed in §4b.

Differences from 9b:
- Initiated externally (API, UI button, intervention respond handler). Not
  driven by edges.
- Can rewind to ANY previously completed node, not just the one the workflow
  author declared as a retry target.
- Restores `sessions`, `retryCounts`, AND `state` from the checkpoint — so
  it's a true rewind, not a partial reset.
- Uses the FORWARD path after the target. It does not trigger 9b's
  `__retry_target` machinery — from the node's perspective, it just gets
  re-entered from a past state.

---

## 10. Parallel execution

`executeParallelNodes` (`engine.ts:904-~1080`). Triggered when `currentNodes`
exactly matches the `to` of an edge with `parallel: true`.

- Emits `parallel_started` with `{ nodes, joinPolicy }`.
- Each target node gets a snapshot copy of `exec.state` (deep merge at the
  end, not shared live — each branch reads from the snapshot).
- `joinPolicy` defaults to `wait-all`:
  - `wait-all` — `Promise.all` all branches, merge outputs via
    `mergeParallelOutputs` (the parallel utility handles conflicts).
  - `wait-any` — first success wins, aborts the rest via abort controllers.
  - `race` — like `wait-any` but aborts on first completion regardless of
    success.
- Each branch runs through its own copy of `executeNode` with its own
  `AbortController`, so cancellation of the parent execution aborts all
  branches.
- When all branches join (`parallel_joined` emitted), merged outputs are
  written to `exec.state` and the merged `completedNodes` is the union of
  `currentNodes` ∪ `branch completedNodes` for each branch.

---

## 11. Node types — what actually runs

Five handlers, all in `packages/engine/src/node-executor.ts`.

### 11a. `type: 'agent'` → `executeAgentNode()`
The big one. Walkthrough:

1. Resolve the agent role via `deps.agents[nodeDef.agent]`. Throw if not
   found. Determine provider: per-node override > agent's `provider` field,
   default `claude`. If provider is `codex`, dispatch to `executeCodexNode`
   (`codex-executor.ts`) and return. Otherwise continue with the Claude path.
2. Resolve `cwd`: `state.worktree_path ?? state.repo_path ?? role.sourceRepoPath`,
   with existence validation via `statSync(...).isDirectory()` at each step.
   Candidates that don't exist are logged as `[cwd] <label>="<path>" does not
   exist — falling through to next candidate` and skipped. If nothing
   resolves, leaves `cwd = undefined` so claude-cli inherits the engine's
   cwd, and logs `[cwd] no candidate directory exists (...); inheriting
   engine's cwd`. (This exists because Node's `spawn()` reports a missing
   cwd as `spawn node ENOENT`, blaming the executable — maximally confusing.)
3. Determine session resume:
   - `existingSession = sessions[nodeName]` (from prior runs in this execution).
   - `resumeFlag = nodeDef.resume_on_retry !== false`.
   - `resume = resumeFlag && existingSession ? existingSession : undefined`.
4. Determine prompt shape:
   - `isRetryTarget = state.__retry_target includes nodeName`.
   - `useMinimalRetryPrompt = isRetryTarget && resume !== undefined`.
   - **Minimal prompt**: a short block containing only the retry feedback,
     under the assumption the resumed session has all prior context.
   - **Full prompt**: `renderTemplate(nodeDef.prompt, state)` + output
     instructions from `buildOutputInstruction` + any `nodeContext` (auto-gate,
     learnings). If `isRetryTarget` but no resume, the feedback block is
     appended to the full prompt.
5. Build `effectiveSystem = role.system + orgBlock` where the orgBlock is
   live-injected via `buildOrgContextBlock(db, { forAgent, includeFullChart,
   includeMeta })` — this is the runtime-injected org chart + delegation
   targets.
6. Load MCP servers via `loadAllMcpServers(db)`. This includes the Allen
   MCP server (stdio-launched via `npx tsx allen-mcp-server.ts`) plus any
   external MCP servers from the `mcp_servers` collection.
7. Call the Claude Code SDK via `query()`:
   ```ts
   query({
     prompt,
     options: {
       customSystemPrompt: effectiveSystem,
       model, allowedTools, cwd, resume, maxTurns, permissionMode,
       stderr: (chunk) => { stderrChunks.push(chunk); emitLog('[claude-stderr] ' + chunk); },
       mcpServers,
       abortController: { signal: deps.abortSignal },
     },
   });
   ```
   The `stderr` callback is critical — without it the SDK pipes subprocess
   stderr to `"ignore"` and every failure becomes the opaque
   `"Claude Code process exited with code 1"` with no cause.
8. Iterate the async message stream from `query()`. Messages are either
   `assistant` (blocks: text, tool_use) or `result` (session_id, cost, turns).
   - Text blocks get emitted as `agent_text` SSE events and appended to the
     `[agent]` log category in batches.
   - Tool blocks get emitted as `agent_tool_start` and logged as
     `Tool: <name> (arg1, arg2)` under the `tool` category.
9. On exception in the `for await`, rethrow with the captured stderr tail
   appended: `<original msg>\n--- claude stderr (tail) ---\n<last 2KB>`.
10. Transient-retry loop: up to 3 attempts, 5-second cooldown, only on
    transient patterns (see §9a).
11. **Output extraction.** `extractOutputs` runs in layers:
    - Layer 0: raw JSON (response starts with `{` or `[`).
    - Layer 1: fenced code block with JSON.
    - Layer 2: regex key-value parse.
    - Layer 3: LLM fallback (skipped initially).
    - If still missing, the engine can ask the agent to resend in the
      expected JSON format via an **agent-resume retry** — resumes the same
      session with the same options (same system, same tools, same MCP), sends
      a minimal "please re-emit" prompt. Max 2 attempts. 5s cooldown to let
      `~/.claude/` locks clear.
    - If THAT still fails, it can fall back to Haiku for pure text-to-JSON
      extraction as a last resort.
12. Return `{ outputs, rawResponse, sessionId, cost, durationMs }`.

### 11b. `type: 'code'` → `executeCodeNode()`
Runs a built-in function by name. `nodeDef.function` must match a key in
`deps.builtIns`. The function signature is:
```ts
(config: Record<string, unknown>, state: Record<string, unknown>, ctx: BuiltInContext) => Promise<Record<string, unknown>>
```
`config` is `nodeDef.config` with `{{template}}` placeholders rendered against
`state`. `ctx` carries `{ emitter, db, executionId, services }`. Built-ins
include `create-workspace`, `git-create-branch`, `git-commit`, `git-push`,
`git-create-pr`, `run-build`, `run-tests`, `classify-task`, `prompt-user`,
`persist-design-docs`. Cost is 0. The function's return value becomes
`result.outputs`.

### 11c. `type: 'human'` → `executeHumanNode()`
Returns `{ outputs: { __waiting_for_input: true, __node: nodeName, ...fields }, cost: 0 }`.
The outer `executeSingleNode` wrapper (§8e) sees the flag and emits
`input_required`, saves a checkpoint, and blocks on `waitForInput`. The
intervention hook on the server (§13) sees the same event and creates a
`workflow_interventions` row + Slack notification. When the user responds via
`POST /api/interventions/:id/respond`, the respond handler calls
`engine.submitInput(execId, nodeName, fieldValues)` which resolves the waiting
promise and merges the data into state.

### 11d. `type: 'workflow'` → `executeWorkflowNode()`
Resolves `nodeDef.workflow` against `deps.workflows` (loaded from Mongo at
launch time). Calls `deps.runWorkflow(subWorkflow, nodeInput)` — which
internally calls `engine.run(subWorkflow, input, nestingDepth + 1)`. Depth is
capped at `maxNestingDepth` (default 3). The sub-workflow's final state is
returned as the parent node's outputs.

### 11e. `type: 'condition'` → `executeConditionNode()`
Evaluates `nodeDef.condition` against state, returns
`{ outputs: { result: boolean }, cost: 0 }`. In practice conditions are
almost always on edges, not on nodes — this node type exists for the rare
case where you need an explicit branch hop that logs a condition decision
as a node rather than an edge.

---

## 12. SSE event stream — how logs get to the browser

### 12a. Event types
From `packages/engine/src/types.ts:320-336`:

```
execution_started, execution_completed, execution_failed,
node_started, node_completed, node_failed, node_retrying,
agent_text, agent_tool_start, agent_tool_complete,
input_required, input_received,
parallel_started, parallel_branch_done, parallel_joined,
execution_log
```

Every event is `{ event: SSEEventType, data: Record<string, unknown> }`. The
engine calls `this.emit(event)` which delegates to `config.emitter.emit(event)`.

### 12b. Transport
`packages/server/src/services/stream.service.ts`.

- `createSSEEmitter(executionId)` returns an `EngineEventEmitter` whose
  `emit` writes to an internal `clients` array of SSE subscribers by
  executionId. Every emit also logs a terse line to the server's stdout
  (`[HH:MM:SS] ● nodeName`, `✓ nodeName (Nms)`, `✗ nodeName: error`).
- `broadcastToExecution(executionId, event)` writes
  `event: <name>\ndata: <json>\n\n` to every matching client's response
  stream. If the write throws (client disconnected), removes them from the
  array.
- `addSSEClient(executionId, res)` is the handler for
  `GET /api/executions/:id/stream`. Writes SSE headers
  (`Content-Type: text/event-stream`, `Cache-Control: no-cache`,
  `Connection: keep-alive`, `X-Accel-Buffering: no`), an initial newline to
  flush, adds the client to the array, and hooks `close`/`error` to remove.
- **Log persistence.** Every `execution_log` event is ALSO inserted into
  `execution_logs` as a fire-and-forget side effect of
  `broadcastToExecution` (`stream.service.ts:57-63`). This is why the
  execution detail page can poll logs for historical runs after the SSE
  connection has closed.

### 12c. Auth
The stream route is mounted BEFORE `requireAuth` in `app.ts`:
```ts
app.use('/api/executions', streamRoutes());   // public — EventSource can't send headers
app.use('/api', requireAuth, blockIfMustReset);
app.use('/api/executions', executionRoutes(db));
```
`EventSource` can't send custom headers, so the stream endpoint uses the
capability-URL model: the execution id is an unguessable UUID, same pattern as
`/api/files` for uploads. Write paths (start, cancel, retry-from-node) are
all mounted AFTER requireAuth.

### 12d. UI consumption
`packages/ui/src/hooks/useExecution.ts:250,472`:
```ts
const sseUrl = id && isLive ? api.streamUrl(id) : null;
const { connected } = useSSE(sseUrl, handleEvent);
```
`useSSE` is a thin `new EventSource(url)` wrapper. `handleEvent` updates
React state per event type: `node_started` → mark node running;
`node_completed` → update output + cost; `node_failed` → mark failed +
capture `errorMessage`; `execution_log` → append to logs array; etc.

`ExecutionDetailPage` also has a **separate HTTP polling loop** that fetches
`/api/executions/:id/logs?limit=500` every 2 seconds. This runs IN ADDITION
to the SSE connection because:
- Agent execution views (spawn_agent chat tool runs) don't go through the
  workflow engine and don't emit workflow SSE — they log to `execution_logs`
  directly from `chat-tools.ts:runSpawnInBackground`. The poll is the only
  way to see them.
- For historical (non-live) executions, the SSE connection is closed and
  the poll is the only source. `useExecution` sets `isLive = false` once
  the status transitions to `completed`/`failed`, which gates the poll loop.

### 12e. Log categories
```
agent     — streamed text chunks from the model
tool      — tool calls from the model (Read, Grep, spawn_agent, etc.)
condition — edge condition evaluation
routing   — which nodes the engine is routing to next
system    — engine-level events (node started/completed, extraction, learning)
gate      — auto-gate decisions (continue / stop / skip / clarify)
```

Levels: `info`, `debug`, `warn`, `error`.

---

## 13. Human intervention — the wrapped emitter

`execution.service.ts:365-~500`. The emitter returned from
`createSSEEmitter` is wrapped in `wrapEmitterWithInterventionHook` before
being handed to the engine. The wrapper's `emit`:

1. Always forwards to the base emitter first (inside a try/catch so a bad
   intervention record can never break the SSE stream).
2. Filters for `event === 'input_required'` and spawns a fire-and-forget
   async task:
   - Deduplication: checks `workflow_interventions` for an existing `pending`
     row on `(workflow_run_id, stage)`. If found, skips (a loop-back to the
     same human node after a prior answer legitimately needs a new row, so
     `answered` rows don't block).
   - Loads the full execution state from Mongo.
   - Derives severity from the stage name:
     - `*_gate` or `*approval*` → `approval` (🟢)
     - `*escalation*` → `escalation` (🔴)
     - else → `question` (🟡)
   - Derives title (`nodeDef.displayName ?? humaniseNodeName(nodeName)`),
     context summary (first 400 chars of rendered prompt), and question
     (verbatim prompt).
   - Captures the declared `fields: InterventionField[]` from
     `event.data.fields` so the Interventions detail page can render the
     right input controls.
   - Inserts a `workflow_interventions` row via `InterventionService.create()`,
     which also fires a Slack DM (to the run starter) + channel post via
     `SlackNotifier` if `ALLEN_SLACK_BOT_TOKEN` and
     `ALLEN_SLACK_INTERVENTIONS_CHANNEL` are configured.

The engine itself knows nothing about interventions. It just emits
`input_required` and waits on `waitForInput`. The wrapper is what bridges
into the intervention system.

When the user responds via `POST /api/interventions/:id/respond`, the route
handler (`intervention.routes.ts`) decides based on the response:
- `accept` → call `engine.submitInput(execId, nodeName, fieldValues)` →
  resolves the waiting promise → engine merges fields into state → advances.
- `reject` → call `engine.cancelExecution(execId)` → throws in the loop →
  run() catches, marks failed.
- `request_changes` → patch state with feedback fields + call
  `retryFromNode` targeting whichever node the intervention specifies as
  `retry_target` (default: the node that emitted the intervention).

---

## 14. Checkpoints — the rewind primitive

One checkpoint per completed node. Written by `executeSingleNode`
immediately after trace save (`engine.ts:767`):

```ts
await stateManager.saveCheckpoint({
  executionId: exec.id,
  afterNode: nodeName,
  state: { ...exec.state },
  sessions: { ...exec.sessions },
  retryCounts: { ...exec.retryCounts },
  completedNodes: [...exec.completedNodes],
  createdAt: new Date(),
});
```

Plus one written right before a human wait, so that retry-from-node on a
human node rewinds to exactly the right state.

Queried by `getCheckpointBefore(executionId, nodeName)` which does:
```js
checkpointsCol
  .find({ executionId, completedNodes: { $nin: [nodeName] } })
  .sort({ createdAt: -1 })
  .limit(1)
```
i.e. "the most recent snapshot where the target node had not yet completed."

The collection is append-only. Cleanup is the operator's responsibility if
storage becomes a concern — there's no TTL or auto-purge right now.

---

## 15. Cancellation and pause

Three cooperative signals on the engine instance:

```ts
private pendingInputResolvers = new Map<string, (data) => void>();  // human-node waits
private cancelledExecutions = new Set<string>();                    // cancel flag
private pausedExecutions = new Set<string>();                       // pause flag
private abortControllers = new Map<string, AbortController>();      // per-node abort for subprocess kill
```

- **Cancel.** `engine.cancelExecution(execId)`:
  1. Adds to `cancelledExecutions`.
  2. Aborts the current node's `AbortController`, which is passed into the
     Claude Code SDK's `query()` as `abortController.signal` — the SDK
     kills the claude-cli subprocess with SIGTERM.
  3. Resolves any pending human-input resolver with an empty object so
     `waitForInput` unblocks.
  4. The graph loop checks `cancelledExecutions.has(id)` on every iteration
     and throws `Execution cancelled`. `run()` catches it and transitions
     to `failed`.
- **Pause.** `engine.pauseExecution(execId)`:
  1. Adds to `pausedExecutions`.
  2. The graph loop has a `while (pausedExecutions.has(id))` check between
     nodes. It sleeps 1s and re-checks. Does NOT kill the current node — if
     you pause while a node is running, it finishes first. Pause takes
     effect at the next edge traversal.
- **Resume.** `engine.resumeExecution(execId)` removes from
  `pausedExecutions`. The loop's next tick continues.

All three are wired to `POST /api/executions/:id/cancel` and `/pause` and
`/resume` via `execution.routes.ts`.

---

## 16. Concurrency and queueing

`workflow.context.concurrency` is an optional integer. If set, `start()`
counts running + waiting-for-input executions for the same workflow name; if
at limit, inserts the execution as `status: 'queued'` and returns without
launching.

When any execution for that workflow finishes (completes OR fails),
`.finally()` on the engine promise calls `dequeueNext(workflow.name)`.
`dequeueNext` re-checks concurrency and pops the oldest queued execution by
`startedAt` ascending, then launches it via `launchExecution`.

No retry logic, no starvation prevention, no prioritization. FIFO only.

---

## 17. Full timeline of a successful run

Tying it all together. Imagine the bug workflow with the failing-then-passing
`qa` retry loop:

```
HTTP POST /api/executions
  → ExecutionService.start
  → (concurrency ok)
  → launchExecution(execId, workflowId, workflow, input)
    → createSSEEmitter(execId)
    → wrapEmitterWithInterventionHook(...)
    → new AllenEngine(config)
    → engine.run(workflow, input, 0, { executionId, workflowId })
      [FIRE AND FORGET — HTTP returns { id, status: 'running' }]

engine.run:
  → stateManager.createExecution(exec)   [executions row inserted]
  → emit('execution_started')            [SSE + server stdout]
  → executeGraph(workflow, exec, 0)
    → getStartNodes(edges) → ['investigate']
    → iteration 1: currentNodes = ['investigate']
      → executeSingleNode('investigate', ...)
        → attempt=1
        → learnings injected → log 'Injected 8 learnings'
        → executeNode → executeAgentNode
          → cwd = state.repo_path (validated, exists)
          → resume = undefined (sessions empty)
          → full prompt built from template
          → loadAllMcpServers(db) → allen
          → query({ prompt, options: { stderr: callback, ... } })
          → for await message: agent_text events, tool_use events
          → result: { sessionId, cost: 5.99, turns: 12 }
          → extractOutputs(rawResponse) → { root_cause, files_to_touch, ... }
        → save trace (execution_traces row)
        → save checkpoint (checkpoints row)
        → log 'Node completed in 157s — cost: $5.9938'
        → log 'Extracted outputs: root_cause, files_to_touch, ...'
        → emit('node_completed')
        → learningManager.confirm(lid, execId) for each
        → auto-gate skipped (conditional edges)
      → getNextNodes:
          edge 'investigate → create_branch' if looks_like_a_feature == false
          → evaluateCondition → true
          → log 'Condition "looks_like_a_feature == false" → true'
          → log 'Routing to: create_branch'
    → iteration 2: currentNodes = ['create_branch']
      → executeSingleNode('create_branch', ...)
        → executeCodeNode → builtIns['create-workspace'](config, state, ctx)
        → ctx.services.workspaces.create(payload)  [in-process, no HTTP]
        → polls workspaces.get(id) until status=active
        → returns { workspace_id, worktree_path, branch_name, ... }
    → iteration 3: currentNodes = ['develop']
      → executeSingleNode → executeAgentNode
        → cwd = state.worktree_path (now set)
        → full prompt, fresh session
        → query(...) → returns with files_changed, developer_output
    → iteration 4: currentNodes = ['qa']
      → executeSingleNode → executeAgentNode
        → attempt=1, no prior session
        → full prompt
        → query(...) → returns with qa_verdict='fail', failure_details
      → getNextNodes:
          edge 'qa → develop' if qa_verdict == 'fail' with max_retries=2
          → retryCounts['qa→develop'] = 0 < 2 — ALLOWED
          → retryCounts['qa→develop'] = 1
          → state.retry_context = edge.retry_context rendered
          → state.__retry_target = ['develop']
          → state.__retry_attempt = 2
          → log 'Retry attempt 2/2'
          → emit('node_retrying')
          → findDownstreamNodes(['develop']) → {'qa', 'update_docs', ...}
          → splice those out of completedNodes
          → log 'Routing to: develop'
    → iteration 5: currentNodes = ['develop']
      → executeSingleNode → executeAgentNode
        → attempt=2
        → existingSession = sessions['develop'], resume_on_retry=true (default)
        → resume = sessions['develop']
        → isRetryTarget = true, useMinimalRetryPrompt = true
        → minimal retry prompt built from retry_context
        → query({ resume, prompt: minimal, ... })
        → agent resumes mid-conversation, addresses feedback
        → returns with corrected developer_output
      → executeSingleNode consumes retry payload:
          delete state.retry_context, __retry_target, __retry_attempt, __retry_source
    → iteration 6: currentNodes = ['qa']
      → qa runs AGAIN (second time)
      → existingSession = sessions['qa'] (from iteration 4)
      → resume_on_retry=true, resume = prior session
      → BUT isRetryTarget = false (retry payload was consumed after develop)
      → useMinimalRetryPrompt = false → full prompt sent with resumed session
      → (this is the "forward-path re-entry" corner case we debugged)
    → iteration 7: currentNodes = ['update_docs']
      → ... continues to END
  → exec.status = 'completed'
  → emit('execution_completed')
  → triggerPostExecutionReview (fire-and-forget learning extraction)

engine.run returns, .finally() fires:
  runningEngines.delete(execId)
  dequeueNext(workflowName)
```

Every emit above is:
1. Sent to every SSE client subscribed to `/api/executions/:id/stream`.
2. Logged to the server's stdout for `node_started`/`node_completed`/`node_failed`.
3. Persisted to `execution_logs` if the event is `execution_log`.

---

## 18. Known sharp edges (read this before debugging)

1. **"Claude Code process exited with code 1" is opaque by default.** The SDK
   pipes subprocess stderr to `"ignore"` unless you pass `options.stderr`.
   The engine now passes a callback that streams each chunk into
   `execution_logs` as `[claude-stderr] ...` and appends the stderr tail to
   the thrown error message. If you see the opaque version, you're running
   a stale engine dist.
2. **"spawn node ENOENT" is ambiguous.** It means EITHER `node` not on PATH
   OR `cwd` doesn't exist. Node blames the executable in both cases. The
   cwd validation added to `node-executor.ts` pre-empts the cwd variant with
   a clear `[cwd] <label>="<path>" does not exist` log line.
3. **Forward-path re-entry with `resume_on_retry: true`.** When a node
   re-enters the executor because an UPSTREAM retry loop re-ran and forward
   routing arrived back at it, the engine currently still resumes the node's
   prior session AND sends a fresh full prompt (because `__retry_target` was
   already consumed and `isRetryTarget = false`). This combination can
   overflow the model's context window on the next API request. If you see a
   reliable `qa` (or similar downstream-of-retry node) failure with a short
   subprocess lifetime, this is the suspect — resume from the upstream node
   instead.
4. **Retry-from-node does not edit input.** If the failure was caused by
   stale `state.repo_path` (or any other input field), rewinding doesn't fix
   it — the checkpoint restores the same bad state. Patch Mongo directly or
   add an endpoint.
5. **Log poll races SSE.** The execution detail page polls `/logs` every 2s
   AND subscribes via SSE. On a very fast run, a log line written after the
   poll's cutoff but before SSE connects can be missed. It'll show up on the
   next poll tick.
6. **Session state lives in `~/.claude/`, not in Mongo.** A claude-cli
   subprocess writes session files to the filesystem. If you migrate
   executions across machines, resumed sessions will be invalid — the id
   exists in Mongo but the filesystem state doesn't.
7. **Parallel branches share a single `AbortController` via the parent
   engine.** Cancelling one branch cancels them all. There is no per-branch
   cancel today.
8. **Concurrency is per-workflow, not per-repo.** Two executions touching
   the same git repo can race via the workspace/worktree layer. The
   `workspace.service` does some protection but it's not a hard lock.

---

## 19. File map — where everything lives

```
packages/engine/src/
├── engine.ts              # AllenEngine class, executeGraph, executeSingleNode,
│                          # getNextNodes, retryFromNode, synthesiseRetryContext
├── node-executor.ts       # executeNode dispatch; executeAgentNode (the big one),
│                          # executeCodeNode, executeHumanNode, executeWorkflowNode,
│                          # executeConditionNode; callAgent helper; stderr capture
├── codex-executor.ts      # executeCodexNode — same role as executeAgentNode but for
│                          # Codex CLI provider
├── state-manager.ts       # StateManager — all Mongo reads/writes for executions,
│                          # checkpoints, traces, failure reports
├── condition-parser.ts    # evaluateCondition — filtrex wrapper with AND/OR/NOT
│                          # normalization and true/false literal handling
├── output-extractor.ts    # extractOutputs (layered), buildOutputInstruction,
│                          # extractAutoGateFields, buildNodeContext
├── template.ts            # renderTemplate — {{var}} interpolation, #if blocks
├── parallel.ts            # mergeParallelOutputs — merges branch outputs with
│                          # conflict handling
├── mcp-loader.ts          # loadAllMcpServers — builds the mcpServers config for
│                          # query(), including the Allen MCP server
├── org-context.ts         # buildOrgContextBlock — live-injected org chart for
│                          # system prompts
├── learning-manager.ts    # LearningManager — query, confirm, contradict,
│                          # extract, postExecutionReview
├── types.ts               # WorkflowDef, NodeDef, EdgeDef, ExecutionState,
│                          # Checkpoint, SSEEvent, BuiltInContext, EngineServices
└── built-ins/             # create-workspace, git-*, run-build, run-tests,
                           # classify-task, persist-design-docs, prompt-user

packages/server/src/
├── services/
│   ├── execution.service.ts     # ExecutionService — start, retryFromNode,
│   │                            # launchExecution, wrapEmitterWithInterventionHook,
│   │                            # dequeueNext, buildEngineServices
│   ├── stream.service.ts        # createSSEEmitter, broadcastToExecution,
│   │                            # addSSEClient, setStreamDb
│   ├── intervention.service.ts  # InterventionService — create, recordResponse,
│   │                            # list, listForWorkflowRun
│   ├── allen-mcp-server.ts  # The MCP server claude-cli connects to —
│   │                            # proxies 16 chat tools over stdio JSON-RPC
│   ├── chat-tools.ts            # spawn_agent, run_workflow, cancel_execution,
│   │                            # get_execution, etc. — the tool registry
│   └── workspace.service.ts     # WorkspaceManager — git worktree creation,
│                                # resolveWorkspaceBaseDir, ensureSpawnHelperExecutable
├── routes/
│   ├── execution.routes.ts      # POST /start, /retry-from/:node, /cancel,
│   │                            # /pause, /resume, /submit-input; GET /:id, /traces
│   ├── stream.routes.ts         # GET /:id/stream — SSE (mounted BEFORE requireAuth)
│   ├── intervention.routes.ts   # POST /:id/respond
│   └── agent.routes.ts          # POST /:name/run — single-agent spawn via chat tool
└── app.ts                       # Express mount order — stream BEFORE requireAuth,
                                 # executions AFTER

packages/ui/src/
├── pages/
│   └── ExecutionDetailPage.tsx  # Live graph + node detail + failure banner +
│                                # retry-from-node button; polls /logs every 2s
├── hooks/
│   ├── useExecution.ts          # Subscribes to SSE, manages React state,
│   │                            # calls api.streamUrl(id)
│   └── useSSE.ts                # Thin EventSource wrapper
└── services/api.ts              # api.retryFrom, api.streamUrl, etc.
```

---

## 20. How to add a new node type (checklist)

1. Add the string to `NodeType` in `types.ts`.
2. Add a `case` to the switch in `executeNode` in `node-executor.ts`.
3. Write an `executeXxxNode` function that returns a `NodeResult`.
4. If the node needs to pause execution, return
   `{ outputs: { __waiting_for_input: true, __node: nodeName, ...fieldDefs } }`
   — the outer `executeSingleNode` wrapper handles the pause, checkpoint,
   and wait.
5. If the node needs server-side infrastructure, expose it via
   `EngineServices` in `types.ts`, wire it through in
   `execution.service.ts:buildEngineServices`, and consume it from
   `ctx.services.xxx` in the node handler.
6. If the node emits events, call `deps.emitter.emit(...)` — the SSE and
   persistence layers handle the rest.

---

## 21. How to add a new SSE event type (checklist)

1. Add the string to `SSEEventType` in `types.ts`.
2. Emit it from the engine or a node executor.
3. Update `useExecution.ts:handleEvent` to react to it on the UI side.
4. (Optional) Update `stream.service.ts:createSSEEmitter` if it needs a
   special console log line.

That's it. Persistence and transport are automatic — every event flows
through the same `broadcastToExecution` path.
