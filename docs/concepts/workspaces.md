# Workspaces

A workspace is an isolated working copy where Allen agents can inspect or modify a repository. Workspaces make agent work visible, reviewable, and safer than running everything in the original checkout.

## Default base branch

When creating a new workspace, the default base branch is resolved from the repository metadata in a four-step chain:

1. `repo.detected.defaultBranch` — set by the initial scan or updated by the change-default-branch flow.
2. `repo.defaultBranch` — explicitly saved fallback.
3. `repo.branch` — the local checkout branch at registration time.
4. `main` — final fallback.

Changing a repository's default branch via the edit dialog updates `detected.defaultBranch` and `defaultBranch` so future workspaces are created against the new branch. Existing workspaces are not modified.

## What a workspace provides

- A dedicated git worktree for a repo task.
- Workspace-aware chat sessions.
- A terminal surface and file watcher.
- Preview proxy ports for local dev servers.
- Links between executions, chats, artifacts, and repository changes.

## How workspaces are used

```text
Repo task starts
  -> Allen creates or selects a workspace
  -> agents run with the workspace as their current context
  -> user can inspect terminal, files, previews, and artifacts
  -> changes can be reviewed before merge
```

## Safety expectations

Workspaces improve isolation and traceability, but they are not a hardened security sandbox. Treat agents and tools as powerful developer automation. Review changes before merging and avoid running untrusted workflows against sensitive repositories.

## Related docs

- [Security and sandboxing](../security.md)
- [Server module](../modules/server.md)
