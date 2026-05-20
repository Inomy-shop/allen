# Context Engine

This document explains Allen runtime context behavior. For setup, provider configuration, Python sidecars, models, and Cognee databases, see [Context engine setup](context-engine-setup.md).

## Provider Gate

Allen context flows are disabled unless `ALLEN_CONTEXT_PROVIDER` is set.

Supported providers:

- `allen`: uses Allen's repository knowledge graph and metadata retrieval.
- `cognee` or `cognee_memory`: uses Cognee for semantic memory retrieval, with Allen-owned selection, reranking, injection policy, and usage tracking.

When the provider is unset, Allen should not run context generation, context retrieval, reranking, Cognee ingestion, or context UI actions.

## Mandatory Context

Mandatory context is graph/rule driven. It should come from narrow always-load instruction, guideline, policy, process, or safety files.

Mandatory mappings are explicit:

- `mandatoryForNodeRoles`: workflow node roles.
- `mandatoryForSpawnedAgentRoles`: spawned child agent roles.
- `mandatoryForSpawnerRoles`: workflow roles that need context to delegate correctly.
- `mandatoryForGlobs`: file-path scoped mandatory context for changed/current files.

Baseline repo instructions are provider-native when the provider already loads them. For example, Claude receives `.claude/CLAUDE.md` natively, and Codex receives `AGENTS.md` natively, so Allen records those refs for audit without duplicating the full body in the injected context block.

## Retrieval Modes

Allen separates full retrieval roles from support/output roles.

Full retrieval roles include investigation, planning, design, implementation, QA, validation, review, and documentation-writing roles. These roles use the configured context provider for retrieval and can receive mandatory context plus selected task-specific refs.

Support/output nodes use `mandatory_only` retrieval. Examples include open/create PR, workspace resolution, notification, bookkeeping, and final summary aggregation.

For `mandatory_only` nodes, Allen:

- does not run semantic retrieval;
- does not inject baseline repo context;
- does not inject file-glob mandatory context;
- injects only refs explicitly mapped to the node role, spawned-agent role, or spawner role;
- creates no repo context packet when no explicit mandatory refs match.

## Cognee Runtime Contract

Cognee is treated as a recall backend, not as the final prompt author.

Allen owns:

- deterministic role/task query construction;
- metadata joins and category policy;
- candidate filtering;
- reranking;
- selected versus injectable refs;
- injection decisions;
- provider diagnostics and context usage tracking.

Cognee recall results are candidates. Allen decides whether they become selected refs, injectable refs, snippets, manifest-only refs, or rejected refs.

## Usage Tracking

Agents must report repo context usage with structured fields such as preselected refs, loaded refs, applied refs, skipped refs, and validation performed. Allen also synthesizes usage from system-injected mandatory context and MCP body-load calls when an agent omits a complete report.
