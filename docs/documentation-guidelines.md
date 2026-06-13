# Documentation Guidelines

Allen's public documentation is for contributors, operators, and open-source evaluators. It should help readers understand the product and find the right source area without turning docs into a second copy of the code.

## Audience

Write for people who want to:

- Run Allen locally.
- Understand the architecture at a high level.
- Contribute safely.
- Operate agents and workflows.
- Review security-sensitive behavior.

## Style

Prefer:

- Plain language.
- Short sections.
- Diagrams that show flow and responsibility.
- Links to source areas when they help contributors navigate.
- Conceptual explanations of what, why, and how pieces connect.

Avoid:

- Internal roadmap, phase, or milestone language.
- Internal requirement/specification documents in public docs.
- Function-by-function implementation detail.
- Private local paths, secrets, customer data, or copied proprietary context.
- Stale plans that describe intended work as if it already exists.

## Module docs template

Use this structure for high-level module docs:

```markdown
# Module Name

One-paragraph purpose.

## Location

`path/to/module`

## Responsibilities

- Major responsibility.
- Major responsibility.

## How it fits with the rest of Allen

Short flow or diagram.

## Contributor entry points

- `path/to/file-or-folder`

## Related concepts

- Related concept link
```

## Maintenance checklist

Before merging documentation changes, check that:

- New docs are linked from `docs/README.md` when they are meant to be public.
- Deleted docs do not leave broken links.
- Public docs do not include private filesystem paths.
- Workflow, agent, team, and integration docs stay high-level.
- Security-sensitive claims link to `docs/security.md` or source areas.
