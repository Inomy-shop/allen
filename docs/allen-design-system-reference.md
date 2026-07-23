# Allen Design System Reference

This document is a working reference for Allen UI design patterns. When a local design-system source folder is available, treat it as read-only and prefer reusable tokens and component patterns over one-off styling.

Primary design-system sources:

- `Allen Design System/README.md`
- `Allen Design System/SKILL.md`
- `Allen Design System/colors_and_type.css`
- `Allen Design System/preview/*.html`
- `Allen Design System/ui_kits/allen-app/*`
- `Allen Design System/ui_kits/allen-app/screens/*`

## Product Model

Allen is an agentic operating system for software development. The UI represents a coordinated group of agents that plan, code, review, test, and ship against repositories, with humans approving at checkpoints.

The design system is focused on the Allen app control plane: chat, executions, workspaces, workflows, library, tickets, pull requests, settings, command palette, sidebar, topbar, tables, traces, terminals, and status surfaces.

## Design Character

Allen should feel like a dense engineering tool: calm, precise, type-led, and operational. The visual system uses compact typography, 1px borders, quiet panels, restrained color, and status badges. It is closer to a Linear-like developer control plane than a marketing site.

Use:

- Compact app chrome.
- Clear hierarchy from spacing, borders, and type weight.
- Plain operational language.
- Blue/indigo accent for action and selection.
- Status colors only for actual state.
- Lucide-style outline icons.

Avoid:

- Emoji.
- Marketing copy.
- Decorative illustrations, photography, noise, glassmorphism, neon glow, or ornamental gradients.
- Oversized radii.
- Heavy shadows on resting cards.
- Mixed icon systems.
- Uppercase tracked headlines outside small mono overlines.

## Implementation Priority

When sources disagree, use this order:

1. `colors_and_type.css` for implementation tokens.
2. `ui_kits/allen-app/kit.css` for app shell and component behavior.
3. `ui_kits/allen-app/*.jsx` for component structure and copy patterns.
4. `README.md` for brand, voice, and broader rules.
5. `preview/*.html` for individual specimens.

The V8 implementation uses a single restrained indigo accent: `#5E6AD2` in light mode and `#828BE0` in dark mode. Prefer the CSS token values when building UI.

## Core Tokens

Use CSS variables from `colors_and_type.css` rather than hard-coded colors where possible.

### Light Theme

- Sidebar surface: `rgb(var(--color-sidebar))`, currently `#F7FAFD`.
- Page surface: `rgb(var(--color-surface))`, currently `#FBFCFE`.
- Panel/card: `rgb(var(--color-surface-100))`, currently `#FFFFFF`.
- Muted strip: `rgb(var(--color-surface-200))`, currently `#EEF2F7`.
- Hairline: `var(--line)`, currently `rgba(13, 30, 47, 0.07)`.
- Card hairline: `var(--card-line)`, currently `rgba(13, 30, 47, 0.10)`.
- Primary text: `rgb(var(--color-text-primary))`, currently `#16181D`.
- Secondary text: `rgb(var(--color-text-secondary))`, currently `#3C4654`.
- Muted text: `rgb(var(--color-text-muted))`, currently `#64748B`.
- Subtle text: `rgb(var(--color-text-subtle))`, currently `#98A4B3`.
- Accent: `rgb(var(--color-accent))`, currently `#5E6AD2`.
- Accent soft: `rgb(var(--color-accent-soft))`, currently `#EDEFFB`.

### Dark Theme

The dark theme is activated by adding `.dark` to `<html>`.

- Sidebar surface: `#0C0D10`.
- Page surface: `#131418`.
- Panel/card: `#1A1C21`.
- Muted strip: `#1D2026`.
- Hairline: `rgba(235, 238, 245, 0.07)`.
- Card hairline: `rgba(235, 238, 245, 0.11)`.
- Accent: `#828BE0`.
- Accent soft: `#23264A`.

### Status Colors

Reserve these colors for status, not decoration:

- Success/completed: `--color-accent-green`.
- Error/failed/destructive: `--color-accent-red`.
- Warning/queued/retry: `--color-accent-yellow` or `--color-accent-orange`.
- Running/info: `--color-accent-cyan`.
- Human checkpoint/agent: `--color-accent-purple`.

Status badges use a small semantic dot plus lowercase mono text. Do not use tinted pill fills for status.

## Typography

Fonts:

- Sans: `Inter`, fallback `SF Pro Text`, then system sans.
- Mono: `SF Mono`, fallback `JetBrains Mono`, then system mono.

Use sans for normal UI text. Use mono for identifiers, workflow names, file paths, badges, counts, metadata, keyboard shortcuts, group labels, command hints, and terminal/code snippets.

Scale from `colors_and_type.css`:

- `2xs`: 9.5px.
- `meta`: 10.5px.
- `caption`: 11.5px.
- `body-sm`: 12.5px.
- `body`: 13.5px.
- `title-sm`: 14px.
- `title`: 15px.
- `section`: 15.5px.
- `h2`: 17px.
- `h1`: 19px.
- `display`: 24px.

Rules:

- Keep `letter-spacing: 0` for normal text and headings.
- Use `font-feature-settings: 'cv11', 'ss01'`.
- Only mono overlines use uppercase and tracking, usually 10px with `letter-spacing: 0.08em`.

## Spacing, Radius, Shadow

Spacing is based on a 4px grid:

- Inline gaps: 6, 8, 10, 12, 16, 20, 24px.
- Page shell: `20px 24px 32px`.
- Cards/panels: 16 to 20px padding.
- Rows: roughly `12px 14px` or `12px 16px`.
- Section gaps: 20, 24, 28px.

Radii:

- Small controls, chips, kbd: 4px.
- Buttons, inputs, nav items: 6 to 8px.
- Cards, dialogs, popovers, tables: 12px.
- Pills and avatars: 999px.
- Do not use 16px+ card radii unless an existing component already does. The kit has one composer at 16px; treat that as an exception, not the default.

Shadows:

- Resting cards use borders, not shadows.
- Hover cards may strengthen their border but do not lift or translate.
- Popovers, command palette, dialogs, and dropdowns use `--shadow-popover`.
- Do not use colored shadows or glows.

## Layout

App shell:

- `.app-shell`: full viewport flex shell.
- `.sidebar`: fixed 236px width, left side, `border-right`.
- `.topbar`: fixed 52px height, `border-bottom`.
- `.main-col`: flex column.
- `.main-body`: scroll area.
- `.page-shell`: `padding: 20px 24px 32px`.

Common page structure:

- `.page-head` with title/subtitle on the left and primary action on the right.
- `.page-title` at 24px/600.
- `.page-sub` at 13px muted.
- Tables and grids below the header.

Two-pane surfaces:

- Chat uses a 240px conversation rail and a flexible thread pane.
- Library/workspace/detail layouts should use a fixed left column around 260 to 360px and a flexible right column.
- Separate panes with 1px borders.

## Components

### Brand

Default product mark:

```html
<div class="brand-mark"><Sparkles /></div>
```

Use the compact four-point Sparkles mark in app chrome. Use `assets/allen-mark.svg` for favicon, tile, or dark-background logomark needs.

Wordmark:

- Text is `allen`.
- All lowercase.
- Inter 600.
- `letter-spacing: 0`.

### Sidebar

Source: `packages/ui/src/App.tsx`.

The expanded sidebar has a fixed vertical hierarchy:

| Area | Contents |
| --- | --- |
| Brand | Product mark, Allen wordmark, current workspace/repo context, notifications, and collapse control |
| Core | Home, Sessions, Executions, and Workspaces; always visible |
| Library | Persisted collapsible group for Linear, pull requests, repos, agents, and workflows |
| Pane selector | Two dots switch between app navigation and the structured Workspaces pane |
| Product block | Allen Design, Settings, then the current user |

The navigation and Workspaces panes form a two-panel carousel controlled by `sidebarPanel`. Changes animate via `translate3d` with a 300ms cubic-bezier transition. Users switch panes by:

- Clicking one of the two dots above the bottom product block.
- Horizontal scroll (trackpad or mouse wheel) inside the carousel area.
- Touch swipe (mobile/tablet).
- Opening `#workspaces` directly.

Inactive panes are `aria-hidden` and inert so off-canvas controls cannot receive focus. The Library state persists in `allen-nav-lib` and automatically opens on a Library route.

When the sidebar is **collapsed** (icon-only mode), the carousel is hidden and core, Library, Allen Design, and Settings icons remain available with `data-sidebar-tooltip` labels.

Only destinations with working routes belong in the sidebar. For example, Documents should not appear until Allen has a dedicated document-library route, even though document identity/version/comment APIs already exist.

Settings routes replace the standard sidebar with the dedicated settings navigation. The bottom product block stays fixed in normal app navigation.

### Topbar

Source: `ui_kits/allen-app/Topbar.jsx`.

Structure:

- Toggle sidebar icon button.
- Breadcrumb: `allen / Current page`.
- Live chip: `12 live`.
- Health chip: `healthy`.
- Search command button with `Search or run command` and `⌘K`.
- Theme toggle icon.

Rules:

- Topbar height is 52px.
- Search width is `min(340px, 24vw)`.
- Chips are compact, border-backed, and mono.

### Home

Source: `packages/ui/src/pages/DashboardPage.tsx`.

- Lead with date plus running-session metadata and the prompt `What should Allen take on?`.
- Keep the working composer as the primary surface, including assistant, model/effort, plan mode, repo/workspace, attachment, and send controls.
- First-run state shows four working starter prompts and six setup cards backed by live GitHub, Linear, provider, MCP, agent-org, and workflow data.
- Active state groups approvals under `Needs you` and puts running sessions first in the bounded `Recent` list.
- Completed setup cards remain visible with a check; every setup action must navigate to or open a working configuration flow.
- End with the onboarding setup receipt and the quiet Allen product footer.

### Command Palette

Source: `ui_kits/allen-app/CommandPalette.jsx`.

Behavior:

- Opens with `Cmd/Ctrl+K`.
- Scrim uses `rgb(0 0 0 / 0.35)` and a small blur.
- Panel max width is 560px.
- Input placeholder: `Search navigation and actions...`.
- Actions use verb-first labels, for example `Open executions`, `Go to new chat`, `View running executions`.
- Result group appears as a small mono badge.

### Buttons

Classes from `colors_and_type.css`:

- `.btn`
- `.btn-primary`
- `.btn-secondary`
- `.btn-ghost`
- `.btn-danger`

Rules:

- Height is usually 30px.
- Border radius is 8px.
- Text is 13px, weight 500.
- Buttons should include a Lucide icon when the action benefits from one.
- Button labels use sentence case, usually verb-first.
- No uppercase labels.

### Inputs And Composer

Inputs:

- Use `.input`.
- 13px body text.
- 8px radius.
- Focus uses accent border and `--focus-ring`.

Composer:

- Chat placeholder: `Message Allen...`.
- Main hero composer can use larger 16px text.
- Footer includes context chips, a keyboard shortcut, and Send button.
- Send action uses primary button with Send icon.

### Tables

Source: `kit.css`, `screens/MyWork.jsx`, `screens/Executions.jsx`.

Rules:

- Wrapper: `.tbl-wrap`, 1px border, 12px radius, clipped overflow.
- Table: `.tbl`, full width, separate border model.
- Headers: muted strip, mono 10px uppercase, compact padding.
- Rows: 12 to 14px vertical padding, bottom borders.
- Hover rows shift to muted strip at low alpha.
- Numeric/metadata columns are usually right-aligned and mono.

### Badges, Chips, Dots

Use:

- `.badge` for statuses.
- `.chip` for compact metadata filters and context pills.
- `.dot` with status modifiers for status lights.

Status mapping:

- `running`: cyan/info, `Loader2` or loader icon.
- `completed`: green/ok, check icon.
- `failed`: red/error, x-circle icon.
- `queued`: yellow/warn, clock icon.
- `waiting for input`: purple/human, pause icon.
- `idle`: subtle dot.

Status text is lowercase. Replace underscores with spaces.

### Cards

Use cards for repeated items, not full-page section wrappers.

Default:

- Background: panel.
- Border: 1px border.
- Radius: 12px.
- Padding: 16 to 20px.
- Hover: stronger border and optional `--shadow-sm`.

Workflow cards:

- Workflow name is mono 13px/600.
- Description is muted 13px.
- Footer is chip row.

Workspace cards:

- Header with repo name and status chip.
- Metadata row with branch, workspace ID, age.
- Terminal preview uses dark terminal colors and mono.
- Agent chip in footer.

### Chat

Source: `screens/Chat.jsx`.

Structure:

- Left conversation list, 240px wide.
- Main thread with centered message rows max width around 760px.
- Avatar, author, mono metadata, message body.
- Mentions use accent.
- Inline code uses mono, muted background, border, 4px radius.
- Tool output appears as a bordered panel with mono header/body.
- Composer is fixed at bottom of chat pane with border-top.

## Iconography

Use Lucide React in production code. Use inline Lucide-style SVG only for static prototypes if the project does not have Lucide available.

Rules:

- Outline icons only.
- 24x24 viewBox, 2px stroke, round caps and joins.
- Default size is 16px.
- Tight chrome can use 14px.
- Badges can use 12px.
- Icons inherit `currentColor`.

Common mappings:

- Chat: `MessageSquare`.
- Execution/run: `Play`.
- Workflow: `GitBranch`.
- Pull request: `GitPullRequest`.
- Repo/workspace: `FolderGit2`.
- Team/agent: `Users`.
- Ticket: `Ticket`.
- Settings: `Settings`.
- Search: `Search`.
- Command palette: `Command`.
- Sign out: `LogOut`.
- Toggle sidebar: `PanelLeft`.
- New chat: `Sparkles`.
- Success: `CheckCircle`.
- Failure: `XCircle`.
- Waiting/paused: `Pause`.
- Queued: `Clock`.
- Running: `Loader2`.
- Warning: `AlertCircle`.
- Close: `X`.

## Copy Rules

Voice:

- Engineering-flavored plain English.
- Functional, clipped, and specific.
- Trust the reader understands development concepts.
- Allen as product is third person. Agents can speak in first person.

Casing:

- Sidebar nav labels: lowercase.
- Sidebar group labels: Title Case source text, rendered as uppercase mono overlines.
- Page titles and dialog titles: sentence case or natural title casing based on existing route title.
- Buttons: sentence case, verb-first.
- Status badges: lowercase.
- Workflow IDs: kebab-case, mono.
- Identifiers, routes, env vars, paths, agents, repo names: mono.

Avoid:

- Emoji.
- Exclamation marks.
- Marketing adjectives.
- Mascots or character copy.

Common copy:

- Chat placeholder: `Message Allen...`.
- Command palette placeholder: `Search navigation and actions...`.
- Topbar search: `Search or run command`.
- Empty state: `Start a conversation with Allen Assistant.`
- Health: `healthy`, `checking`.
- Live: `12 live`.
- Statuses: `running`, `completed`, `failed`, `queued`, `waiting for input`.

## Interaction Rules

- Hover changes background one surface level and strengthens text/border.
- Active nav uses accent-soft, accent text, and accent-tinted border.
- Focus uses `box-shadow: var(--focus-ring)`, not outline.
- Disabled uses `opacity: 0.5` and `cursor: not-allowed`.
- Press states do not shrink controls.
- Use 120ms transitions for color, border, and background.
- Use 200 to 300ms for entry animations.
- Avoid bounces, rotations, scale animations, and decorative motion.

## Practical Build Checklist

Before building an Allen UI:

- Import or mirror `colors_and_type.css`.
- Use Inter Tight and JetBrains Mono.
- Use the app shell dimensions: 236px expanded sidebar, 62px collapsed sidebar, 52px topbar.
- Keep the page background quiet and panel-based.
- Use 1px borders as the primary separator.
- Keep cards at 12px radius or less.
- Use Lucide outline icons.
- Use accent only for active state, links, focus, and primary actions.
- Use status colors only for statuses.
- Keep labels compact and operational.
- Use mono for IDs, workflow names, repo names, file paths, badges, kbd, and metadata.
- Verify no design-system source files under `Allen Design System/` were edited.

## Local Reference Paths

- Tokens: `Allen Design System/colors_and_type.css`
- App kit CSS: `Allen Design System/ui_kits/allen-app/kit.css`
- App shell: `Allen Design System/ui_kits/allen-app/App.jsx`
- Sidebar: `Allen Design System/ui_kits/allen-app/Sidebar.jsx`
- Topbar: `Allen Design System/ui_kits/allen-app/Topbar.jsx`
- Command palette: `Allen Design System/ui_kits/allen-app/CommandPalette.jsx`
- Icons: `Allen Design System/ui_kits/allen-app/icons.jsx`
- Screens:
  - `Allen Design System/ui_kits/allen-app/screens/MyWork.jsx`
  - `Allen Design System/ui_kits/allen-app/screens/Executions.jsx`
  - `Allen Design System/ui_kits/allen-app/screens/Chat.jsx`
  - `Allen Design System/ui_kits/allen-app/screens/Workspaces.jsx`
  - `Allen Design System/ui_kits/allen-app/screens/Workflows.jsx`
- Brand asset: `Allen Design System/assets/allen-mark.svg`
- Component specimens: `Allen Design System/preview/*.html`
