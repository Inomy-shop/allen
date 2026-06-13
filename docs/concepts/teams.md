# Teams

A team is a group of related agents with a lead agent and a mission. Teams make Allen's agent organization easier to understand and route.

## Built-in team areas

Allen seeds teams for:

- Executive coordination.
- Product requirements and acceptance criteria.
- Engineering implementation and technical review.
- Quality validation and testing.
- Design exploration and prototype work.
- Meta/builders work for extending Allen itself.
- Unassigned agents that have not moved into a dedicated team.

## How teams are used

```text
Task arrives
  -> Allen identifies the relevant domain
  -> a team lead or specialist receives the work
  -> the agent may delegate, ask for input, or run tools
  -> progress remains visible through chat or executions
```

Teams are primarily an operating model. They help contributors reason about responsibility boundaries without needing to understand every prompt or implementation detail.

## Contributor guidance

- Add or change teams only when the responsibility boundary is meaningful.
- Prefer a specialist agent when the task is narrow.
- Prefer a lead agent when coordination across roles is needed.
- Keep team names and descriptions understandable to new contributors.

## Related docs

- [Agents](agents.md)
- [Workflows](workflows.md)
