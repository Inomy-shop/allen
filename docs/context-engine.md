# Context Engine

This document explains Allen runtime context behavior. For setup, see [Context engine setup](context-engine-setup.md). For curated and mandatory field semantics, see [Curated and mandatory context](context-engine-curated-and-mandatory-context.md). For authoring guidance, see [Context engine best practices](context-engine-best-practices.md).

## Provider Gate

Allen context flows are disabled unless `ALLEN_CONTEXT_PROVIDER` is set.

Supported provider:

- `cognee` or `cognee_memory`: uses Cognee for semantic memory retrieval and cognification, with Allen-owned curation, mandatory mappings, selection, reranking, injection policy, diagnostics, and usage tracking.

When the provider is unset, Allen should not run context retrieval, reranking, Cognee ingestion, context builds, or context UI actions.

## Source Of Runtime Context

Allen no longer uses an internal `allen` repository graph provider for runtime context.

Runtime context comes from:

- `repo_context_curation_entries`: active curated entries that are ingested into Cognee and resolved back to curated content after recall;
- `repo_mandatory_context_mappings`: exact agent-to-context mappings that are injected directly as always-load guidance;
- `context_refs`, `context_attempts`, and related lifecycle collections: packet, diagnostic, selection, injection, and usage history.

Cognee is treated as a recall backend, not as the final prompt author. Allen decides which recalled candidates are selected, rejected, injectable, or injected.

## Mandatory Context

Mandatory context comes from explicit MongoDB mappings, not from curated entries and not from Cognee search.

Mappings are keyed by exact Allen agent name. At runtime Allen checks the current workflow node role, spawned-agent role, target role, and caller role, then loads enabled mappings for those agents.

Mandatory context should be narrow always-load material:

- coding or testing rules;
- security and production-safety constraints;
- workflow output contracts;
- repo practices that are easy to violate;
- role-specific process guidance.

Mandatory context is injected directly into the system context layer when it matches. Optional Cognee relevance thresholds do not filter mandatory mappings.

## Optional Retrieval

Optional context comes from Cognee recall over active curated entries.

The normal flow is:

1. Allen builds a role/task query intent.
2. Cognee returns semantic or graph-backed candidates.
3. Allen joins candidates to curation metadata and chunk-source mappings when available.
4. Allen filters and reranks candidates.
5. Allen marks refs as selected, rejected, injectable, or injected.
6. The injection packer uses resolved curated context when policy and score thresholds allow it.

Cognee chunk text is useful for recall diagnostics and mapping. Resolved `curatedContext` is the preferred agent-facing text for injection.

## Retrieval Modes

Allen separates full retrieval roles from support/output roles.

Full retrieval roles include investigation, planning, design, implementation, QA, validation, review, and documentation-writing roles. These roles can receive mandatory context plus selected task-specific Cognee refs.

Support/output nodes use `mandatory_only` retrieval. Examples include open/create PR, workspace resolution, notification, bookkeeping, and final summary aggregation.

For `mandatory_only` nodes, Allen:

- does not run semantic Cognee retrieval;
- injects only refs explicitly mapped to the node role, spawned-agent role, or spawner role;
- creates no repo context packet when no explicit mandatory refs match.

## Injection And Thresholds

Allen keeps separate stages for candidates, selected refs, injectable refs, and injected refs.

Optional Cognee refs can be filtered by:

- raw or normalized retrieval score;
- reranker score;
- final injection score;
- source authority and category metadata;
- `injectionPolicy` from the resolved curated entry.

Mandatory context bypasses these optional thresholds because it is an explicit always-load mapping.

## Usage Tracking

Agents must report repo context usage with structured fields such as preselected refs, loaded refs, applied refs, skipped refs, and validation performed. Allen also synthesizes usage from system-injected mandatory context and MCP body-loader calls when an agent omits a complete report.

The main body loaders are:

- `get_repo_context_body` for selected Cognee refs or explicit repo-relative context paths;
- `get_repo_skill_body` for explicit repo-relative skill paths.

## Evaluation Semantics

Context evaluation distinguishes injected guidance from source discovery.

Injected context is expected to provide mandatory rules, domain/spec context, API contracts, product requirements, and repo practices. Investigation and implementation agents are expected to read concrete source files, tests, logs, diffs, and workflow artifacts directly with tools.

Missing source-code bodies should not be treated as a context-injection failure when tool evidence shows the agent inspected the source. Missing mandatory guidelines or relevant specs should still be penalized.

## Context LLM Calls

Context-engine LLM calls use `ALLEN_CONTEXT_LLM_PROVIDER` and `ALLEN_CONTEXT_LLM_MODEL` by default. This applies to Cognee LLM callbacks, semantic context evaluation, and context curation or mapping tasks where the runtime supports the configured provider.

Cognee-specific `ALLEN_COGNEE_LLM_PROVIDER` and `ALLEN_COGNEE_LLM_MODEL` are legacy fallbacks.
