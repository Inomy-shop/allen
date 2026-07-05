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

## Document commenting and versioning

Text-based artifacts (markdown, text, code, JSON, CSV) can opt into a **document identity** with commenting and versioning. Once enabled, the artifact becomes a *commentable document* with the following capabilities:

- **Inline comments** anchored to specific text ranges or lines. Comments can be open, resolved, or stale. Each comment tracks its thread, author (human or agent), anchor position, and resolution.
- **Versions** — every edit produces a new numbered version preserving the full content history. Versions track who created them (human, agent, or system) and which comments they address.
- **Version diff** — any two versions can be compared side by side with line-level additions, removals, and modifications.
- **Version restore** — a prior version can be restored, which creates a new version containing the restored content and marks comments anchored to no-longer-current text as stale.
- **Timeline** — a chronological view of version creates, comment additions, resolutions, and reopen events.

### Agent comment workflow

When an agent fetches a commentable artifact via `allen_get_artifact`, the response includes `isCommentable: true`, a `documentId`, and a `commentContext` block listing unresolved comments, resolved summary, and stale count. Agents that encounter documents with comments follow this workflow (injected into the base chat persona prompt):

1. Read the artifact with `allen_get_artifact` first to see latest content and unresolved comments.
2. Treat unresolved comments as default revision instructions.
3. After revising, call `allen_create_document_version` to publish the update.
4. For each addressed comment, call `allen_resolve_document_comment` with a clear resolution note.
5. For comments that cannot be addressed, reply via `allen_reply_document_comment` and leave them unresolved.
6. Stale comments are noted but not actionable until re-anchored.

### UI viewer controls

The artifact viewer (sidebar panel) shows version badges and three toggle controls when a document identity exists:
- **Comments panel** — browse threads, resolve, reopen, and navigate to anchor positions.
- **Version history panel** — browse versions, view content at a specific version, compare to latest, and restore.
- **Timeline panel** — chronological event view of all version and comment activity.

Text selection on commentable documents activates an inline comment input anchored to the selected range.

### Lazy activation

A document identity is created lazily the first time a user clicks **Enable Commenting** in the artifact viewer. Existing text-based artifacts become commentable on demand — no background migration is needed.

## Security note

Artifact links can be capability-style URLs. Do not put secrets, private credentials, or sensitive customer data in artifacts.

## Related docs

- [Workflows](workflows.md)
- [Security and sandboxing](../security.md)
