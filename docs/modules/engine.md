# Engine Module

The engine is Allen's workflow runtime. It loads workflow definitions, starts agent or human steps, tracks state, and turns each run into observable execution records.

## Location

`packages/engine`

## Responsibilities

- Load and validate workflow YAML from `packages/engine/workflows/`.
- Execute workflow nodes such as agent steps, code steps, human checkpoints, conditions, parallel branches, and nested workflows.
- Render workflow templates and pass state between nodes.
- Run configured agents through supported providers.
- Classify and manage model-recovery retries when an agent node fails with a recoverable provider error (rate limits, server errors, model unavailability, transient connectivity, or session exhaustion).
- Capture artifacts, traces, logs, token usage, and structured outputs.
- Load MCP server definitions and expose approved tools to agents.
- Store and retrieve learnings that can be injected into later runs.

## How it fits with the rest of Allen

```text
Server asks engine to run a workflow
  -> engine loads workflow + agent definitions
  -> engine executes nodes and invokes agents/tools
  -> engine records traces, artifacts, and state
  -> server streams progress to the UI
```

The engine is not a web server and does not own the product UI. It is the orchestration layer used by the API server and by tests.

## Contributor entry points

- Workflow behavior: `packages/engine/src/engine.ts`
- Node execution: `packages/engine/src/node-executor.ts`
- Workflow schema and validation: `packages/engine/src/validator.ts`
- Workflow definitions: `packages/engine/workflows/`
- Agent defaults and routing: `packages/engine/agents.yml`, `packages/engine/router.yml`
- Model alias resolution: `packages/engine/src/model-alias.ts` (normalizes legacy aliases and unknown strings to canonical fullIds at the CLI/SDK boundary using a frozen `LEGACY_ALIAS_LOOKUP_MAP`; resolution order: env override → registry alias map → legacy lookup → known fullId passthrough → unknown passthrough unchanged)
- Cost calculation: `packages/engine/src/cost-calculator.ts` (registry-backed `aliasMap`/`costMap` supplied by the server; costs are token-computed from per-MTok prices)
- MCP loading: `packages/engine/src/mcp-loader.ts`
- Model recovery: `packages/engine/src/model-recovery.ts` (failure classification via `classifyFailure`, recovery state tracking, execution-scoped model overrides)
- Recovery behavior in `packages/engine/src/engine.ts` `executeSingleNode` and `executeParallelNodes` (catch-recoverable paths, branch-preserving parallel fork recovery)
- Node executor override application: `packages/engine/src/node-executor.ts` (reads `state.__model_overrides` and discards prior session on model change)
- Human intervention for recovery: `packages/engine/src/human-intervention.ts` (`renderModelRecoveryIntervention`, `'model_recovery'` kind support)

## Related concepts

- [Workflows](../concepts/workflows.md)
- [Agents](../concepts/agents.md)
- [Artifacts](../concepts/artifacts.md)
- [Integrations](../concepts/integrations.md)
