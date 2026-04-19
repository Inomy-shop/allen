# Auto-Gate — Intelligent Workflow Flow Control

Auto-gate is Allen's mechanism for agents to control workflow execution — stopping, pausing for human input, or skipping steps — without requiring manual configuration per node.

---

## How It Works

Every agent node's prompt is automatically appended with two things:
1. **Output format instruction** — tells the agent to return JSON with declared output fields
2. **Workflow context** — tells the agent its position in the graph and what actions it can take

The agent can optionally include `__action` in its JSON response to signal the engine. If omitted, execution continues normally.

```
Your prompt here...

When done, return results as JSON:                ← buildOutputInstruction()
{ "answer": ..., "sources": ... }

WORKFLOW CONTEXT:                                  ← buildNodeContext()
You are the FIRST step. After you:
  format (codex-researcher) — needs: formatted
ACTIONS YOU CAN TAKE:
  STOP: Only if impossible to proceed...
  CLARIFY with retry: If you CANNOT produce output...
  CLARIFY with continue: If you CAN produce output...
DEFAULT: Just produce your output normally.
```

---

## Actions

| Action | `__action` value | When to use | What happens |
|--------|-----------------|-------------|--------------|
| **Continue** | `"continue"` or omitted | Normal case — just do your job | Engine follows normal edges |
| **Stop** | `"stop"` | Entire workflow is pointless | Engine stops, status = completed |
| **Clarify + Retry** | `"clarify"` + `"retry"` | Cannot produce output without human info | Engine pauses → human input → same node re-runs |
| **Clarify + Continue** | `"clarify"` + `"continue"` | Output exists but uncertain | Engine pauses → human input → advances to next node |
| **Skip** | `"skip"` | Nothing meaningful to output (last node only) | Engine completes without this node's output |

### Agent Response Format

**Normal (no gate):**
```json
{ "answer": "TypeScript is...", "sources": ["..."] }
```

**Stop:**
```json
{ "__action": "stop", "__reason": "Task references a service that doesn't exist" }
```

**Clarify with form:**
```json
{
  "__action": "clarify",
  "__reason": "I need details to draft your email",
  "__clarify_action": "retry",
  "__clarify_fields": [
    { "name": "recipient", "type": "string", "label": "Who is the recipient?", "required": true },
    { "name": "purpose", "type": "select", "label": "Purpose", "options": ["request", "follow-up", "thank you"], "required": true },
    { "name": "key_points", "type": "text", "label": "Key points", "required": true }
  ]
}
```

**Clarify without form (simple text input):**
```json
{ "__action": "clarify", "__reason": "Which database should I query?", "__clarify_action": "retry" }
```

---

## When Auto-Gate Does NOT Apply

Auto-gate is **skipped entirely** for:
- **Code nodes** (`type: code`) — built-in functions, no LLM
- **Human nodes** (`type: human`) — already a human interaction
- **Workflow nodes** (`type: workflow`) — subgraph execution
- **Condition nodes** (`type: condition`) — pure logic
- **Agent nodes with conditional outgoing edges** — these are routing decision nodes (e.g., judge with APPROVED/REJECTED edges). Their output fields control routing, not `__action`.

Auto-gate only runs on **agent nodes without conditional outgoing edges**.

---

## Context-Aware Instructions

The engine generates different instructions based on the node's position in the workflow graph. This is computed at runtime from the edges — no configuration needed.

### What each position sees:

**First node (connected from START):**
```
You are the FIRST step. The next steps depend on your output:
  review (reviewer) — needs: verdict, feedback
  format (writer) — needs: formatted
```
- Can stop (if task is truly impossible)
- Can clarify (if input is vague)
- Cannot skip

**Middle node:**
```
You are a MIDDLE step. The next steps depend on your output:
  format (writer) — needs: formatted
```
- Can stop (if entire workflow is pointless)
- Can clarify retry (if upstream data is broken)
- Can clarify continue (if uncertain about output)
- Cannot skip

**Last node (connects to END):**
```
You are the FINAL step in this workflow.
```
- Can stop
- Can clarify continue (if quality uncertain)
- Can skip (if nothing to output)

**Only node (START → node → END):**
```
You are the ONLY step in this workflow.
```
- Full access to all actions

**Conditional edges node (e.g., judge):**
- No auto-gate instruction at all
- Node's output fields (verdict, score) control routing via edge conditions

### Downstream descriptions

The context includes descriptions of downstream nodes so the agent understands impact:
```
After you:
  polish (codex-developer) — needs: final_subject, final_body — "Polish this email for sending:"
```

This helps the agent write better clarify questions: "I need the recipient because the polish step will use it for the greeting."

---

## Output Extraction and Gate Fields

Gate fields (`__action`, `__reason`, `__clarify_action`, `__clarify_fields`) are extracted alongside declared outputs. They are **always preserved** even if not in the node's `outputs[]` list.

### Extraction Layers

| Layer | What it tries | Extra LLM call? |
|-------|--------------|-----------------|
| **0** | Parse entire response as raw JSON | No |
| **1** | Find ` ```json ``` ` code block | No |
| **1b** | Find `{...}` anywhere in text | No |
| **2** | Custom regex per field | No |
| **3** | Key-value patterns (`key: value`) | No |
| **4** | LLM fallback (Claude Haiku) | **Yes — 1 cheap call** |
| **5** | Auto-detect question pattern | No |

### When extra LLM call happens (Layer 4)

Layer 4 fires **only when all previous layers fail** — meaning the agent returned completely unstructured text with no JSON anywhere. This happens when:
- Codex returns a conversational response instead of JSON
- The agent ignores the output format instruction
- Response is free-form text with no parseable structure

The LLM call uses Claude Haiku (cheapest model) with a simple extraction prompt. It also detects if the text is asking a question and returns `__action: "clarify"` accordingly.

**Cost:** ~$0.001 per call. Only happens on extraction failures, not on every node.

### When Layer 5 auto-detect fires

If even the LLM fallback fails AND the response contains question patterns (`?`, `could you`, `please provide`, etc.), Layer 5 automatically treats it as a clarify request. This is the last resort safety net.

---

## Clarify Form Fields

When an agent uses `__action: "clarify"`, it can optionally return `__clarify_fields` — a structured form definition. The UI renders these as proper form inputs instead of a single text box.

### Field types:

| Type | UI Element |
|------|-----------|
| `string` | Text input (single line) |
| `text` | Textarea (multi-line) |
| `select` | Dropdown with options |
| `boolean` | Checkbox |
| `number` | Number input |

### Fallback:

If `__clarify_fields` is not provided, the UI shows a single textarea with `__reason` as the label.

### How human input flows back:

1. Human fills form → submits
2. All field values merged into execution state: `state.recipient = "John"`, `state.purpose = "request"`
3. For retry: `retry_context` built from all fields: `"Human provided:\nrecipient: John\npurpose: request\nkey_points: Need budget approval"`
4. Node re-runs with `retry_context` in its prompt template (`{{retry_context}}`)
5. For continue: fields merged into state, next node sees them as template variables

---

## Clarify: Retry vs Continue

| | Retry | Continue |
|---|---|---|
| **Agent returns** | `__clarify_action: "retry"` | `__clarify_action: "continue"` |
| **Node output** | Empty/broken — unusable | Exists but uncertain |
| **After human input** | Same node re-runs | Advances to next node |
| **Node's `completedNodes`** | Removed (so it can re-run) | Stays (already completed) |
| **State** | Human input → `retry_context` | Human input merged directly |
| **Use case** | "I can't work without this info" | "I did my job but pick a direction" |
| **Default** | Yes (if not specified) | — |

---

## Common Scenarios

### Agent returns valid JSON but content is a question

**Problem:** Agent returns `{ "subject": "Need more details", "body": "Could you tell me..." }` — valid JSON with all fields, but the content is a clarification question disguised as output.

**Current behavior:** Layers 0/1 extract it successfully. No `__action` field → gate says continue. Downstream gets a "question email" instead of a real email.

**Mitigation:** Use explicit prompt instructions telling the agent to use `__action: "clarify"` instead of embedding questions in output. Stronger models (gpt-5.3-codex, sonnet) follow this better than mini models.

### Agent completely ignores gate instructions

**Problem:** Some models don't follow the workflow context instructions at all.

**Current behavior:** No `__action` in response → gate defaults to continue. Workflow proceeds normally. Auto-gate is additive — worst case is no gate, not a broken workflow.

### Agent returns `__action: "stop"` on a middle node

**Current behavior:** Engine respects it — stops the workflow. The bar is set high ("only if entire workflow is pointless") but the engine doesn't override the agent's decision.

---

## File Locations

| File | What |
|------|------|
| `packages/engine/src/output-extractor.ts` | `buildNodeContext()` — generates per-node instructions. `buildOutputInstruction()` — JSON format instruction. `extractAutoGateFields()` — extracts gate fields from response. `extractOutputs()` — 6-layer extraction with logging. |
| `packages/engine/src/engine.ts` | `executeSingleNode()` — calls `buildNodeContext`, passes to node executor, checks gate after execution, handles clarify retry/continue flow. |
| `packages/engine/src/node-executor.ts` | Appends `nodeContext` to agent prompt. Passes extraction logger. |
| `packages/engine/src/codex-executor.ts` | Same for Codex nodes. |
| `packages/engine/src/types.ts` | `AutoGateAction`, `ClarifyAction` types. |
| `packages/ui/src/components/execution/NodeDetail.tsx` | Shows gate banner (⛔ STOPPED / ⏭ SKIPPED / ❓ CLARIFY). Renders clarify form fields inline. |
| `packages/ui/src/hooks/useExecution.ts` | Synthesizes `input_required` event from `__clarify_fields` for waiting executions. |

---

## No Configuration Required

Auto-gate is fully automatic:
- **No YAML config** — no `auto_gate: true` flags on nodes
- **No per-workflow setup** — works on any workflow topology
- **No per-node instructions** — context generated from graph position
- **No explicit form definitions** — agents generate forms dynamically based on what they need

The only thing workflow authors can do is write better node prompts that guide the agent toward using `__action: "clarify"` when appropriate (like the email-drafter's "check first before writing" instruction). But even without that, auto-gate provides a safety net via extraction Layer 4/5.
