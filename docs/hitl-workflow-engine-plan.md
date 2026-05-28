# HITL Workflow Engine Plan

## Goal

Make every workflow human intervention render as one of three predictable cases:

1. Clarify: a node needs missing or ambiguous human input.
2. Review: a node produced work and needs human approval, feedback, rejection, or routing.
3. Recover: a workflow is blocked because retry budget was exhausted, an agent escalated, validation failed, or a final action failed.

The engine should produce a normalized intervention payload for the UI. The UI should render that payload directly instead of inferring meaning from node names.

## Core Model

Add a first-class `human` presentation block to workflow nodes:

```yaml
some_human_node:
  type: human
  human:
    kind: clarify | review | recover
    title: "..."
    summary: "..."
    question: "..."
    highlights: []
    evidence: []
    actions: {}
    fields: []
```

Existing `prompt` and `fields` continue to work as fallback for backward compatibility.

## Content Ownership

Workflow-authored content:

- Expected clarify nodes.
- Review gates.
- Approval gates.
- Recovery/escalation gates.
- Action labels and routes.
- Required fields and feedback rules.
- Evidence that should be shown.

Agent-generated content:

- Unexpected `__action: clarify`.
- Runtime summaries.
- Failure reasons.
- Artifact URLs.
- Suggested fields for dynamic clarification.

Engine-generated content:

- Normalized intervention payload.
- Rendered templates from workflow state.
- Retry exhaustion metadata.
- Cumulative human input history.
- Fallback presentation when workflow metadata is missing.

UI-rendered content:

- Title, summary, question.
- Evidence links and review content.
- Fields and validation.
- Buttons/actions.
- Risk warnings.

## Normalized Intervention Payload

The engine should emit a normalized payload on `input_required`:

```ts
type HumanInterventionPayload = {
  kind: 'clarify' | 'review' | 'recover';
  node: string;
  title: string;
  summary?: string;
  question: string;
  severity: 'question' | 'approval' | 'escalation';
  highlights?: string[];
  evidence?: Array<{
    label: string;
    type: 'text' | 'artifact' | 'url' | 'diff' | 'log';
    value?: string;
    url?: string;
  }>;
  fields: HumanField[];
  actions: Array<{
    id: string;
    label: string;
    intent: 'submit' | 'approve' | 'request_changes' | 'reject' | 'retry' | 'override' | 'abandon';
    feedbackRequired?: boolean;
    feedbackOptional?: boolean;
    warning?: string;
    route?: {
      type: 'continue' | 'retry' | 'end';
      targetNode?: string;
    };
  }>;
  retryExhaustion?: RetryExhaustionContext;
};
```

## Retry Exhaustion Context

When a retry edge is exhausted, the engine already knows:

- The exhausted source node from `state.__retry_exhausted_from`.
- The retry edge key from `retryCounts`.
- The number of attempts already consumed.
- The retry target from the edge.
- The retry context template or synthesized retry context.
- The current state values produced by the failed node.

Add an engine-generated context object:

```ts
type RetryExhaustionContext = {
  exhaustedFrom: string;
  retryEdgeKey: string;
  attemptsUsed: number;
  maxRetries: number;
  lastFailureSummary?: string;
  retryTarget?: string;
  availableFailureFields: Record<string, unknown>;
};
```

The engine should attach this to state when retry budget is exhausted:

```ts
state.__retry_exhaustion = {
  exhaustedFrom,
  retryEdgeKey,
  attemptsUsed: count,
  maxRetries: edge.max_retries,
  retryTarget,
  lastFailureSummary,
  availableFailureFields,
};
```

For recovery HITL, the engine should generate understandable fallback content even if the workflow author did not provide a rich `human` block:

```text
The workflow could not recover automatically.

Failed stage: qa
Retry attempts used: 2 of 2
Last failure: Unit test failed: empty state renders wrong copy.

Choose how to recover:
- Retry with feedback
- Override and continue
- Abandon
```

The workflow can still override or enrich this copy through `human.summary`, `human.question`, `human.evidence`, and `human.actions`.

## Human Event History

Add an append-only event list to workflow state:

```ts
state.__human_events = [
  {
    kind: 'clarify' | 'review' | 'recover';
    node: string;
    actionId?: string;
    decision?: string;
    values?: Record<string, unknown>;
    feedback?: string;
    route?: {
      type: 'continue' | 'retry' | 'end';
      targetNode?: string;
    };
    evidence?: Array<{ label: string; url?: string; value?: string }>;
    retryExhaustion?: RetryExhaustionContext;
    createdAt: string;
  }
];
```

Use this for all three buckets:

- Clarify answers.
- Review decisions and feedback.
- Recovery decisions after retry exhaustion or escalation.

## Human History Injection

Every later agent node should receive a compact rendered block:

```text
HUMAN INPUT HISTORY

1. clarify at understand_request
User answered:
- target_page: Workspace settings

2. review at plan_approval_gate
Decision: approve
Feedback: Keep the change behind a feature flag.
Route: continue to implement

3. recover at qa_escalation
Failed stage: qa
Retry attempts used: 2 of 2
Decision: retry_with_feedback
Feedback: Fix the empty-state test and rerun the full suite.
Route: retry implement

Treat this human input as authoritative.
```

This solves dynamic fields from unexpected clarification and ensures downstream nodes receive every human decision even when prompts do not know the dynamic field names.

## Engine Changes

1. Extend workflow types in `packages/engine/src/types.ts`.
   - Add `HumanPresentation`.
   - Add `HumanAction`.
   - Add `HumanEvidence`.
   - Add `HumanInterventionPayload`.
   - Add `HumanEvent`.
   - Add `RetryExhaustionContext`.

2. Extend workflow validation in `packages/engine/src/validator.ts`.
   - Validate `human.kind`.
   - Validate action IDs and route target nodes.
   - Validate field names, field types, select options.
   - Allow old `prompt` and `fields` form.

3. Add a renderer in the engine.
   - `renderHumanIntervention(nodeName, nodeDef, state, workflow)`.
   - Resolve templates in title, summary, question, highlights, evidence, and actions.
   - Generate fallback content for legacy human nodes.
   - Generate fallback recovery content from `state.__retry_exhaustion`.

4. Update explicit human node execution.
   - Emit `input_required` with `intervention`.
   - Keep `prompt` and `fields` for backward compatibility.

5. Update agent clarify handling.
   - Convert `__action: clarify` to a normalized `kind: clarify` intervention.
   - Use `__reason` as question.
   - Use `__clarify_fields` as fields.
   - Fallback to one required `clarification` text field.
   - Default to `retry`.

6. Update retry exhaustion handling.
   - When retry budget is exhausted, set `state.__retry_exhausted_from`.
   - Also set `state.__retry_exhaustion`.
   - Include attempts used, max retries, failed node, target node, and failure summary candidates.

7. Append human events.
   - On every submitted human response, append a structured event to `state.__human_events`.
   - Include decision/action, field values, feedback, route, evidence, and retry exhaustion context.

8. Inject human history into later agent prompts.
   - Add a rendered human history block to node context.
   - Keep it concise and truncate older events if needed.

## Server Changes

1. Update intervention creation in `packages/server/src/services/execution.service.ts`.
   - Prefer `event.data.intervention`.
   - Fallback to current node-name/prompt/fields inference.
   - Store normalized fields, actions, evidence, summary, question, and retry exhaustion context.

2. Update intervention response route in `packages/server/src/routes/intervention.routes.ts`.
   - Accept `actionId`, `fieldValues`, and `feedback`.
   - Submit the response to the engine.
   - Avoid route inference from UI decision names where normalized action route is available.

3. Keep backward compatibility.
   - Existing `decision`, `field_values`, `feedback`, and `answer` request shapes should continue to work during migration.

## UI Changes

1. Render from normalized payload.
   - Use `kind`, `actions`, `fields`, `evidence`, and `retryExhaustion`.
   - Stop inferring approval/escalation from node names.

2. Clarify UI.
   - Title: `Clarification needed` or payload title.
   - Show question.
   - Show specific fields.
   - Actions: submit answer, cancel.

3. Review UI.
   - Title and summary.
   - Highlight work product.
   - Evidence/artifact links.
   - Actions: approve, request changes, reject.
   - Feedback optional for approve when configured.
   - Feedback required for request changes when configured.

4. Recover UI.
   - Title and summary.
   - Failed node.
   - Attempts used and max retries.
   - Last failure summary.
   - Evidence/artifact links.
   - Actions: retry with feedback, override/force continue, abandon.
   - Show explicit warning for override.

## Workflow Migration

Update human nodes in these workflows:

- `packages/engine/workflows/bug-fix-by-severity.yml`
- `packages/engine/workflows/feature-plan-and-implement.yml`
- `packages/engine/workflows/tdd-design-by-severity.yml`
- `packages/engine/workflows/multi-repo-change-orchestration.yml`
- `packages/engine/workflows/milestone-implementation-from-prd-tdd.yml`

Mapping:

- Severity fallback: `kind: review`, one required classification field.
- Root-cause / plan / repo-plan approval: `kind: review`.
- TDD questions / request clarification: `kind: clarify`.
- Retry exhausted / blocked / failed validation: `kind: recover`.

## Tests

Add tests for:

- Rendering a `human` block with templates.
- Legacy human node fallback.
- Agent `__action: clarify` normalized payload.
- Retry exhaustion generates `__retry_exhaustion`.
- Recovery intervention contains attempts used and max retries.
- Human responses append `__human_events`.
- Later agent node prompt includes human history.
- Normalized action route drives retry/continue/end.
- UI renders actions from payload, not node-name heuristics.

## Implementation Order

1. Types and validator.
2. Engine human intervention renderer.
3. Retry exhaustion context generation.
4. Human event history append and injection.
5. Server intervention payload support.
6. UI rendering from normalized payload.
7. Workflow migration.
8. Tests and backward compatibility pass.
