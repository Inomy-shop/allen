# Artifacts

An artifact is a durable output created by an agent, workflow, or tool. Artifacts preserve important work so users and later steps can inspect it without relying on chat history alone.

## Common artifact types

- Research summaries.
- Design or technical notes.
- Validation reports.
- Generated files.
- Workflow handoff material.
- Review or QA findings.

## How artifacts are used

```text
Agent produces important output
  -> Allen saves it as an artifact
  -> execution and chat link to it
  -> later agents or users can read it
```

Artifacts are useful for transparency. They also make long-running or multi-agent work easier to audit.

## Security note

Artifact links can be capability-style URLs. Do not put secrets, private credentials, or sensitive customer data in artifacts.

## Related docs

- [Workflows](workflows.md)
- [Security and sandboxing](../security.md)
