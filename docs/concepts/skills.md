# Skills

A skill is guidance that helps Allen route or perform a class of work consistently. Skills can describe when to use a workflow, when to use a specialist, how to gather evidence, or what guardrails apply.

## What skills are for

Skills help Allen choose the right path for non-trivial requests. They are especially useful when a user asks for work that could be handled by chat, a workflow, an agent, or an external tool.

## How skills relate to agents and workflows

```text
User request
  -> skill guidance helps classify intent
  -> Allen chooses direct answer, data query, agent, or workflow
  -> selected route performs the work
```

Skills are not the same as workflows. A workflow is an executable process; a skill is routing or operating guidance that helps choose and run the right process.

## Public documentation boundary

Open-source docs should explain what skills are and how they fit into Allen. They should not publish private prompt text, hidden routing rules, or exhaustive internal decision trees.

## Related docs

- [Agents](agents.md)
- [Workflows](workflows.md)
- [Teams](teams.md)
