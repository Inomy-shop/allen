# UI Module

The UI is Allen's React application. It gives operators a browser-based way to chat with agents, inspect workflow runs, manage repos, review artifacts, and configure the system.

## Location

`packages/ui`

## Responsibilities

- Render the dashboard, chat, workflow, execution, workspace, repo, agent, team, ticket, PR, design, and settings screens.
- Stream execution progress and show logs, traces, artifacts, checkpoints, token usage, and **execution watcher status lines** (one live non-clickable line per running execution, updated in-place via SSE `watcher_update` events).
- Provide workspace-aware chat and terminal/preview surfaces.
- Manage forms for integrations, MCP servers, design repos, and admin settings. The repository edit dialog includes a **Default branch** field — the initial value is resolved from `detected.defaultBranch → defaultBranch → branch → 'main'`, and saving a changed branch calls `PUT /api/repos/:id/default-branch`.
- Keep user-facing flows understandable while the server and engine handle execution.

## How it fits with the rest of Allen

```text
User action in UI
  -> API request or stream subscription
  -> Server updates state or starts execution
  -> UI renders progress and decisions
```

The UI should not contain orchestration rules that belong in workflows, agents, or server services. It should make state visible and actions safe.

## Contributor entry points

- App routes: `packages/ui/src/App.tsx`
- Pages: `packages/ui/src/pages/`
- Shared components: `packages/ui/src/components/`
- API wrappers: `packages/ui/src/services/`
- State stores: `packages/ui/src/stores/`
- Hooks and utilities: `packages/ui/src/hooks/`, `packages/ui/src/utils/`

## Related concepts

- [Workflows](../concepts/workflows.md)
- [Workspaces](../concepts/workspaces.md)
- [Artifacts](../concepts/artifacts.md)
