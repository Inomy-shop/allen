# Agents

An agent is a configured AI worker with a role, model, instructions, tools, and permissions. Allen uses agents to break software work into understandable responsibilities.

## Agent types

- **Team leads** coordinate work across a domain, such as product, engineering, quality, or design.
- **Specialists** perform focused tasks, such as backend work, frontend work, QA, code review, documentation, or investigation.
- **Utility agents** support system maintenance, context curation, workflow diagnostics, or routing.

## What agents do

Agents can participate in chat, be spawned directly, or run as workflow steps. Depending on configuration and context, an agent may inspect repos, call tools, create artifacts, delegate to another agent, or ask for human input.

## Where agents are defined

Allen has two related agent sources:

- The production org is seeded by the server into MongoDB.
- Engine defaults live in `packages/engine/agents.yml` for built-in and development use.

## Design principles

- Agents should have clear ownership and limited scope.
- Tool access should match the agent's job.
- High-risk work should be visible through executions, artifacts, reviews, or human checkpoints.
- Public docs should explain roles and flow, not private prompt internals.

## Related docs

- [Teams](teams.md)
- [Skills](skills.md)
- [Server module](../modules/server.md)
