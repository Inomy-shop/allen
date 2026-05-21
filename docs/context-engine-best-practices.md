# Context Engine Best Practices

This guide explains what context means in Allen and how to use it to improve workflow, chat, and spawned-agent results. For setup, see [Context engine setup](context-engine-setup.md). For runtime behavior, see [Context engine](context-engine.md).

## What Context Means

Context is the information Allen gives an agent so it can make better decisions before it starts working. It is not a replacement for reading the repository, running commands, checking artifacts, or validating output.

Good context helps an agent answer:

- What domain or product area is this task about?
- What rules, contracts, and specifications must be followed?
- Which repo practices matter for this role?
- Which files, modules, or workflows are likely relevant?
- What should be loaded or verified directly before making changes?

Context should orient the agent and constrain its behavior. Source files, tests, logs, diffs, and workflow artifacts should usually be inspected directly with tools.

## Context Types

Allen uses different context classes for different jobs:

| Context type | Purpose | Examples | Injection behavior |
|---|---|---|---|
| Mandatory guidance | Always-follow rules for a role or repo | coding guidelines, security policy, workflow output contract | Inject full body when mapped and not provider-native |
| Domain/spec context | Product and business requirements | PRDs, API contracts, workflow specs, schema docs | Retrieve and inject when task intent needs it |
| Orientation context | Pointers to likely relevant areas | module summaries, file refs, graph neighbors | Prefer snippet or manifest-only |
| Source evidence | Concrete implementation truth | source files, tests, diffs, logs, artifacts | Agent should read directly with tools |
| Historical/operational context | Past learnings and production notes | incident notes, rollout constraints, known failure modes | Inject only when clearly task-relevant |

The most common mistake is treating all context as prompt body. Allen should inject only what needs to shape the agent's reasoning immediately. Everything else should be a precise reference the agent can load or verify.

## What To Inject

Inject context when the agent must know it before choosing an approach:

- Role-specific coding and testing rules.
- Security, privacy, auth, credentials, and production-safety constraints.
- Product requirements and acceptance criteria.
- API, schema, event, workflow, or output contracts.
- Repository conventions that are easy to violate.
- User or workflow feedback that changes how the next attempt should behave.

Prefer mandatory context only for true always-load material. A document is not mandatory just because it is useful. Module docs, runbooks, package scripts, and implementation files are usually task-specific retrieval context.

## What Not To Inject

Avoid injecting large bodies when the agent can read or discover them:

- Full source files.
- Full test files.
- Full logs or command output.
- Large PRDs when only one section is relevant.
- Broad docs that mention the same keywords but do not constrain the task.
- Persona or agent instruction files unrelated to the current role.
- Build, deploy, CI, or package files unless the task is about those systems.

For investigation and implementation, it is correct for the agent to use injected context as a map and then read source files directly. Evaluation should not penalize missing source bodies when tool evidence shows the agent inspected them.

## Retrieval And Injection Rules

Use these rules when designing or debugging context behavior:

- Start with role and task intent. The same query should not be used for every node.
- Separate candidates, selected refs, injectable refs, and injected refs.
- Treat semantic recall as a candidate generator, not as final truth.
- Rerank and filter broad Cognee results before injection.
- Prefer `manifest_only` for source files and broad docs unless the body is explicitly needed.
- Prefer snippets for task-relevant sections of specs, contracts, or guidelines.
- Use full-body injection for mandatory policies and short exact contracts.
- Record skipped refs with reasons so evaluation can distinguish policy decisions from failures.

If a result is useful only as a pointer, do not inject the body. Give the agent the ref and let it load or read the exact file when needed.

## Role Guidance

Different roles need different context:

| Role type | Good context | Expected direct tool use |
|---|---|---|
| Investigation | domain specs, bug area hints, relevant contracts, prior failures | grep/read source, inspect logs, inspect artifacts |
| Planning/design | product requirements, architecture constraints, API contracts, known risks | inspect existing patterns and touched modules |
| Implementation | coding guidelines, exact contracts, target module hints, acceptance criteria | read/edit source, run tests, inspect build output |
| QA/validation | acceptance criteria, test strategy, risk areas, changed refs | run tests, inspect failures, verify artifacts |
| Review | coding standards, security rules, changed files, expected behavior | inspect diffs and implementation files |
| Summary/PR/open-ticket | only explicit mandatory guidance if mapped | usually no semantic retrieval |

Support nodes should usually use `mandatory_only` retrieval. They should not receive semantic context unless their job requires repo reasoning.

## Writing Better Context Documents

Good context documents are easy for retrieval and agents to use:

- Put the main topic in the title and first heading.
- Use stable repo-relative paths.
- Keep one document focused on one purpose.
- Include exact contracts, allowed values, commands, or examples when they matter.
- Prefer clear headings over long narrative.
- Avoid mixing evergreen policy with temporary implementation notes.
- Mark generated or stale documents clearly.
- Keep broad background docs out of mandatory mappings.

When using Cognee, remember that semantic search works best when documents contain the words users and agents naturally use in task prompts. Add aliases or headings for important domain terms.

## Evaluation Expectations

Context evaluation should answer two separate questions:

- Did Allen inject the right guidance, specs, contracts, and constraints?
- Did the agent use tools to discover concrete source evidence when needed?

Good results may still show that agents read files directly. That is expected. A context failure happens when:

- mandatory guidance was missing;
- relevant specs or contracts were not selected;
- noisy semantic docs crowded out useful context;
- manifest-only refs were claimed as used without body-load or source-read evidence;
- the agent made decisions from summaries when it needed exact file contents.

Evaluation should reward precise orientation plus verified source discovery, not prompt stuffing.

## Practical Workflow

Use this loop when improving context quality:

1. Identify the role and task type.
2. Confirm mandatory context is narrow and correct.
3. Check selected refs before injected refs.
4. Remove broad or unrelated semantic matches.
5. Ensure source files are manifest-only unless exact bodies are required.
6. Verify the agent actually read the source/test/artifact evidence it used.
7. Use feedback to add missing specs or narrow noisy categories.

The target state is not "inject everything." The target state is "give the agent the right map, rules, and contracts, then make it verify the real code."
