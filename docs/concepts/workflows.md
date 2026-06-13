# Workflows

A workflow is a repeatable multi-step process that Allen can run for a user or system event. Workflows are useful when a task needs more than one agent, a validation gate, a human checkpoint, or predictable routing.

## What a workflow contains

Workflows are defined as YAML files under `packages/engine/workflows/`. A workflow can contain:

- Agent steps for research, implementation, review, or validation.
- Human checkpoints for approval, clarification, or recovery.
- Conditions that route based on prior output.
- Parallel branches for independent work.
- Nested workflow calls for larger orchestration.
- Artifact outputs that preserve important results.

## How a workflow runs

```text
User or automation starts workflow
  -> server creates an execution record
  -> engine walks the workflow graph
  -> agents, tools, and human checkpoints produce state
  -> UI streams progress and artifacts
  -> workflow ends with a result, pause, failure, or PR/action
```

## Built-in workflow areas

Allen ships workflows for feature implementation, bug fixing, technical design, milestone implementation, PR review resolution, self-healing triage, cross-repo orchestration, and design exploration.

## Design principles

- Keep workflow steps understandable to operators.
- Prefer human checkpoints where risk or ambiguity is high.
- Save durable outputs as artifacts.
- Keep implementation detail in code and agent prompts, not in public docs.

## Related docs

- [Engine module](../modules/engine.md)
- [First workflow](../first-workflow.md)
