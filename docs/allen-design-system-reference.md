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

Notable token difference: the README describes an earlier blue accent `#2A76E2`, while `colors_and_type.css` currently defines the import-ready accent as `#4763CF` in light mode and `#8A9CEC` in dark mode. Prefer the CSS token values when building UI.

## Core Tokens

Use CSS variables from `colors_and_type.css` rather than hard-coded colors where possible.

### Light Theme

- Page surface: `rgb(var(--color-surface))`, currently `#FCFDFF`.
- Panel/card: `rgb(var(--color-surface-100))`, currently `#FFFFFF`.
- Muted strip: `rgb(var(--color-surface-200))`, currently `#F4F6FB`.
- Alternate panel: `rgb(var(--color-surface-300))`, currently `#F8FAFE`.
- Border: `rgb(var(--color-border))`, currently `#E2E5ED`.
- Strong border: `rgb(var(--color-border-strong))`, currently `#CDD3E0`.
- Primary text: `rgb(var(--color-text-primary))`, currently `#0B1730`.
- Secondary text: `rgb(var(--color-text-secondary))`, currently `#354158`.
- Muted text: `rgb(var(--color-text-muted))`, currently `#6E778A`.
- Subtle text: `rgb(var(--color-text-subtle))`, currently `#9CA5B8`.
- Accent: `rgb(var(--color-accent))`, currently `#4763CF`.
- Accent soft: `rgb(var(--color-accent-soft))`, currently `#DFE2F7`.

### Dark Theme

The dark theme is activated by adding `.dark` to `<html>`.

- Page surface: `#070910`.
- Panel/card: `#0E121C`.
- Muted strip: `#0B0F18`.
- Alternate panel: `#141925`.
- Border: `#202534`.
- Strong border: `#2E354A`.
- Accent: `#8A9CEC`.
- Accent soft: `#202652`.

### Status Colors

Reserve these colors for status, not decoration:

- Success/completed: `--color-accent-green`.
- Error/failed/destructive: `--color-accent-red`.
- Warning/queued/retry: `--color-accent-yellow` or `--color-accent-orange`.
- Running/info: `--color-accent-cyan`.
- Human checkpoint/agent: `--color-accent-purple`.

Badge fills use low alpha, typically `0.12` to `0.15`.

## Typography

Fonts:

- Sans: `Inter Tight`, fallback `Inter`, then system sans.
- Mono: `JetBrains Mono`, fallback `Geist Mono`, then system mono.

Use sans for normal UI text. Use mono for identifiers, workflow names, file paths, badges, counts, metadata, keyboard shortcuts, group labels, command hints, and terminal/code snippets.

Scale from `colors_and_type.css`:

- `2xs`: 11px / 1.5.
- `meta`: 11px / 1.5.
- `caption`: 12px / 1.5.
- `body`: 13px / 1.55.
- `title`: 14px / 1.4.
- `h2`: 18px / 1.3.
- `h1`: 24px / 1.25.
- `display`: 44px / 1.05, for true hero moments only.

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
- Hover cards may use `--shadow-sm`.
- Popovers, command palette, dialogs, and dropdowns use `--shadow-popover`.
- Do not use colored shadows or glows.

## Layout

App shell:

- `.app-shell`: full viewport flex shell.
- `.sidebar`: fixed 220px width, left side, `border-right`.
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
<div class="brand-mark">[a]</div>
```

Use the `[a]` capsule in chrome and most product surfaces. Use `assets/allen-mark.svg` for favicon, tile, or dark-background logomark needs.

Wordmark:

- Text is `allen`.
- All lowercase.
- Inter Tight 600.
- `letter-spacing: 0`.

### Sidebar

Source: `ui_kits/allen-app/Sidebar.jsx`.

Structure:

- Brand row with `[a]`, `allen`, and mono version like `v0.2`.
- Navigation groups:
  - Primary: `new chat`, `executions`, `chats`.
  - `Sources`: `tickets`, `pull requests`, `workspaces`.
  - `Org`: `library`, `workflows`.
  - `Personal`: `settings`.
- Footer with avatar, user name, email, sign-out icon.

Rules:

- Nav labels are lowercase.
- Group titles are Title Case text rendered as uppercase mono overlines.
- Active nav uses accent-soft background, accent text, and subtle accent border.
- Count badges are mono, small, and border-backed.

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
- Use the app shell dimensions: 220px sidebar, 52px topbar.
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
