# Allen UI v2 — Developer Handoff

This bundle contains everything needed to migrate `packages/ui` from the current dark sci-fi theme (v1) to the new **Linear-clean** light theme (v2).

## What's in here

```
handoff/
├── README.md                    ← you are here
├── index.html                   ← open this first (handoff overview)
├── COMPONENT_GUIDE.md           ← v1 → v2 class mapping
├── MIGRATION.md                 ← step-by-step rollout playbook
├── tokens/
│   ├── index.css.v2             ← drop-in for packages/ui/src/index.css
│   └── tailwind.config.js.v2    ← drop-in for packages/ui/tailwind.config.js
└── references/
    ├── 00-design-system.html    ← canonical design system page
    ├── 01-dashboard.html        ← Dashboard, 3 directions side-by-side
    ├── 02-chat.html             ← Chat, 3 directions
    ├── 03-workflows.html        ← Agent workflows, 3 directions
    ├── 04-agents.html           ← Agents & teams
    ├── 05-repos.html            ← Repositories
    ├── 06-linear.html           ← Linear / tickets
    ├── 07-workspaces.html       ← Workspaces
    ├── 08-pull-requests.html    ← Pull requests
    ├── 09-executions.html       ← Executions
    ├── 10-interventions.html    ← Interventions / human-in-loop
    ├── 11-analytics.html        ← Analytics / learnings
    ├── 12-scheduled.html        ← Scheduled jobs + MCP
    ├── themes.css               ← all 3 directions' tokens (D1, D2, D3)
    ├── design-canvas.jsx        ← canvas wrapper used by reference pages
    ├── chrome.jsx               ← shared sidebar/topbar component
    └── pages/                   ← reference page implementations
```

## Quick start (TL;DR)

1. Open `index.html` for the handoff overview & screenshots.
2. Read `MIGRATION.md` (15-min skim).
3. From your repo root:

   ```bash
   git checkout -b ui/v2-linear-clean

   cp /path/to/handoff/tokens/index.css.v2 \
      packages/ui/src/index.css

   cp /path/to/handoff/tokens/tailwind.config.js.v2 \
      packages/ui/tailwind.config.js
   ```

4. Add fonts to `packages/ui/index.html`:

   ```html
   <link rel="preconnect" href="https://fonts.googleapis.com">
   <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
   <link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap" rel="stylesheet">
   ```

5. `npm --workspace=@allen/ui run dev` and click through every page.

The drop-in is **non-breaking**: every legacy class name (`accent-blue`, `shadow-glow-*`, `.scan-lines`) still resolves. Your existing JSX keeps compiling. Visual changes happen because the tokens those classes resolve TO are now v2.

## Three directions, one implementation

The references show **three design directions** per page:
- **D1 — Mission Control** (dark, dense)
- **D2 — Linear-clean** ← **what the tokens implement**
- **D3 — Operator** (brutalist, mono)

If you want D1 or D3 instead, the tokens file is the only thing that needs to change — the JSX is theme-agnostic.

## Asking Claude Code to implement

Best opening prompt:

> Read `handoff/README.md`, `handoff/MIGRATION.md`, and `handoff/COMPONENT_GUIDE.md`. Then execute Phase 1 (drop-in tokens) on a new branch `ui/v2-linear-clean`. Stop and show me the diff before continuing to Phase 2.

After that lands, page-by-page polish prompts:

> Open `handoff/references/01-dashboard.html` (focus the artboard labelled "D2 / Linear-clean"). Update `packages/ui/src/pages/DashboardPage.tsx` to match. Use only token classes — no inline hex colors.

## Built for Allen (`Kalpai-poc/allen`)

Targets:
- React 18.3 + TypeScript 5.7
- Tailwind 3.4 (existing CSS-variable + RGB-channel pattern preserved)
- Vite 6
- Existing `packages/ui` structure — engine and server packages untouched
