# UI Module

The UI is Allen's React application. It gives operators a browser-based way to chat with agents, inspect workflow runs, manage repos, review artifacts, and configure the system.

## Location

`packages/ui`

## Responsibilities

- Render the dashboard, chat, workflow, execution, workspace, repo, agent, team, ticket, PR, design, and settings screens. Chat includes a **Steer** button that injects a typed message into the running agent turn mid-stream — visible only when the agent is streaming and the input is non-empty, distinct from the Stop button.
- Stream execution progress and show logs, traces, artifacts, checkpoints, token usage, and **execution watcher status lines** (one live non-clickable line per running execution, updated in-place via SSE `watcher_update` events).
- Render model-recovery prompts (`ModelRecoveryPrompt`) when a workflow node encounters a recoverable provider error — shows the failed node, provider/model, error summary, topology context (sequential vs. parallel branch), and lets the operator select a replacement provider/model to retry.
- Provide workspace-aware chat and terminal/preview surfaces.
- Manage forms for integrations, MCP servers, design repos, and admin settings. The repository edit dialog includes a **Default branch** field — the initial value is resolved from `detected.defaultBranch → defaultBranch → branch → 'main'`, and saving a changed branch calls `PUT /api/repos/:id/default-branch`.
- Render a **sidebar carousel** with three panels accessible via dot selector: **Design Studio** (left dot), **main navigation** (center dot, default), and **workspaces** (right dot). The active panel is controlled by `sidebarPanel` state in `App.tsx`; users switch via the dot row at the bottom of the expanded sidebar or via horizontal scroll/touch gestures on the carousel area.
- The Design Studio panel lists the user's Design Studio workspaces with compact status badges, a search input to filter, and a + button to create a new workspace. The navigation panel retains the original app nav groups. The workspace panel shows workspaces grouped by repo with search, collapse, and create actions.
- Provide a collapsed sidebar mode (icon-only) that hides the carousel and shows nav icons with tooltips.
- When the user is on a `/design` route and the sidebar is expanded, switch to a dedicated design-history sidebar (via `DesignNavPanel`) that shows design sessions instead of the carousel panels.
- Show non-Claude OpenRouter model warnings in agent configuration forms and role/model selectors (AC6). When the selected provider is OpenRouter and the model slug does not start with `anthropic/`, a persistent warning banner reads "This model is experimental for the Claude Code execution path. Non-Claude models may not work correctly with this runtime." The heuristic is shared via `packages/ui/src/lib/openrouter-warning.ts` and the `(experimental)` suffix is appended to model labels in model pickers via `packages/ui/src/lib/model-catalog.ts`.
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
