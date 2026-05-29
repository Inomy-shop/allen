# Allen App · UI kit

A click-through React recreation of the Allen control plane (`packages/ui` in the [Inomy-shop/allen](https://github.com/Inomy-shop/allen) monorepo).

Open `index.html` to see the shell assembled, or pull individual components into a new mock.

## Files

```
allen-app/
├── README.md
├── index.html              — entry; loads colors_and_type.css + components
├── App.jsx                 — top-level shell, simple in-memory router
├── Sidebar.jsx             — 220px nav with brand mark, groups, badges, sub-items
├── Topbar.jsx              — 52px breadcrumb · live chip · search · theme toggle
├── CommandPalette.jsx      — ⌘K overlay with scrim and filterable command list
└── screens/
    ├── MyWork.jsx          — landing hero + hero composer + recent runs
    ├── Executions.jsx      — table of runs with status badges and trace links
    ├── Chat.jsx            — agent thread with mentions and composer
    ├── Workspaces.jsx      — workspaces list with terminal/preview previews
    └── Workflows.jsx       — built-in workflows in a card grid
```

## Interactions

Click any sidebar item → routes to that screen. Click `⌘K` (or press the keyboard shortcut) → opens command palette. Click "new chat" or any composer "Send" → routes to the chat screen and seeds a fake message. Theme toggle in the topbar flips `.dark` on `<html>`.

These are **cosmetic recreations** — agent execution, terminals, repos, and the LLM round-trip are all fake.

## What's intentionally missing

- The execution detail view (a 100-KB monster in the real codebase) — only the list lives here.
- The visual workflow builder.
- The Library (teams / agents / skills / repos / integrations) — only the navigation entry exists.
- Authentication, onboarding, settings.

These are deliberate omissions to keep the kit small and editable. Add them as needed by reading the real `packages/ui/src/pages/<Page>.tsx`.
