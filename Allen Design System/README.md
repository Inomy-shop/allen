# Allen Design System

> **Allen** is an agentic operating system for software development — an organisation of AI agents that plan, code, review, test, and ship against your repos, with humans approving at defined checkpoints.

This folder is the design system distilled from the Allen product UI. It's a manifest of brand voice, visual foundations, tokens, assets, and component recipes you can pull from to make Allen-shaped artefacts: pages, slides, prototypes, throwaway mocks, or production code.

## Sources

Everything here was derived directly from these Allen repositories. Browse them to go deeper:

- **Codebase (canonical):** https://github.com/Kalpai-poc/allen — the monorepo. The visual system lives in `packages/ui/`:
  - `packages/ui/src/index.css` — the full v2 token + component layer (light/dark, all class hooks)
  - `packages/ui/tailwind.config.js` — Tailwind theme mapping
  - `packages/ui/src/App.tsx` — shell, sidebar, topbar, command palette
  - `packages/ui/src/components/` — chat, agents, executions, workspace, settings
  - `packages/ui/src/pages/` — full page scaffolds
- **README (product overview):** https://github.com/Kalpai-poc/allen/blob/main/README.md
- **Org-mirror:** the same code is also hosted at `Inomy-shop/allen`.

If you have access, read the `*.tsx` files first — they're the source of truth for component shape and copy.

---

## Index

| File | What's in it |
|---|---|
| `README.md` | this file — brand context, content rules, visual foundations, iconography |
| `colors_and_type.css` | CSS variables for the entire token system + small helper classes |
| `assets/allen-mark.svg` | the `[a]` brand mark used as the favicon and in the sidebar |
| `preview/*.html` | small specimens (1 concept each) shown in the Design System tab |
| `ui_kits/allen-app/` | clickable React recreation of the core Allen UI — sidebar, topbar, chat, executions, workspaces |
| `SKILL.md` | downloadable Agent Skill descriptor for Claude Code |

---

## What Allen is

A multi-team agent org you point at your codebase. You talk to it in chat or hand it a Linear ticket; team-lead agents plan and delegate to specialist coding agents; work runs in isolated git worktrees with live terminals; every step is traced and humans approve at checkpoints. It integrates with GitHub, Linear, Slack, and MCP servers.

Two surfaces are in scope for this system:

1. **Allen App** (`packages/ui`) — the React + Vite control plane. Sidebar nav, command palette, chat with mentions, executions with traces, workspace pages with embedded terminals and previews, library (teams · agents · skills · repos · integrations), workflows, tickets, PRs, settings. This is where 99% of the visual system lives.
2. **Landing site** (`apps/landing`) — not yet built in the repo. **Caveat:** the landing folder is empty; this system assumes the landing site, when built, will extend the same tokens.

The product is **early alpha**. The visual system is itself labelled "v2" — a recent re-skin that swept out v1's neon glows, scan-lines, and clip-path corners in favour of a calm, Linear-flavoured aesthetic.

---

## Content fundamentals

Voice is **engineering-flavoured plain English**: clipped, lowercase, never marketing-y, and trusts the reader knows what a worktree is. Allen describes itself in functional terms (what it does, what you can do with it) and reserves emphatic language for safety warnings.

### Casing

- **Nav labels & section headers — all lowercase.** `new chat`, `executions`, `chats`, `tickets`, `pull requests`, `workspaces`, `library`, `workflows`, `settings`, `teams & agents`, `skills`, `repos`, `integrations`. Lowercase is non-negotiable for nav; titles in content (page headlines, dialog headers, button labels) are **sentence case** — `Create workflow`, `Open assistant chat`, `Review in Allen`.
- **Buttons are sentence case, not Title Case, not UPPERCASE.** A leading verb, no period: `Search or run command`, `Switch to dark mode`, `Sign out`, `Toggle sidebar`.
- **Group titles in the sidebar are Title Case** (`Sources`, `Org`, `Personal`) — these are the only Title-Case labels in the chrome.
- **Mono labels and counts are unstyled lowercase** (`12 live`, `v0.2`, `99+`).

### Voice & person

- **"You" addresses the user; "Allen" refers to the product in third person.** From the README: "You talk to it in chat or hand it a Linear ticket." The product never says "I" — agents inside Allen can speak in first person, but Allen as a product does not.
- **No marketing fluff.** The README opens with "An agentic operating system for software development — assign work to a coordinated org of AI agents, watch them execute against real repositories, intervene at checkpoints, and improve them over time." That's the register: nouns and verbs, no adjectives.
- **Status warnings are loud and italic.** "**Status: early alpha.** Run it against dedicated workspaces and disposable or non-critical repositories first." When something is dangerous, bold the label and follow with a single concrete instruction.

### Microcopy patterns

| Surface | Example |
|---|---|
| Empty state | "Start a conversation with Allen Assistant." |
| Chat placeholder | "Message Allen..." |
| Command palette placeholder | "Search navigation and actions..." |
| Topbar search | "Search or run command" with a `⌘K` kbd |
| Health chip | `healthy` / `checking` (lowercase, one word) |
| Live chip | `12 live` (numeral first, lowercase noun) |
| Status badge | `running`, `completed`, `failed`, `queued`, `waiting for input` (underscores replaced with spaces, all lowercase) |
| Section labels | `Sources`, `Org`, `Personal` |
| Workflow names | `feature-plan-and-implement`, `bug-fix-by-severity` (kebab-case, mono) |

### Tone rules

- **No emoji** anywhere in the product. The product communicates through icons (Lucide) and colored status dots. The README has none. Tweaks, slides, and prototypes built on this system should follow suit.
- **No exclamation marks** in product copy. The closest is `Status: early alpha.` and that uses a period.
- **Numerals over words** for counts (`12 live`, `20+ agents`, `6 teams`).
- **Verbs first** on CTAs (`Open executions`, `Go to new chat`, `View running executions`).
- **Identifiers in mono.** Routes, env vars, file paths, agent IDs, workflow names — all `JetBrains Mono`. The keyboard `kbd` element is also mono.

---

## Visual foundations

The Allen visual language is **calm, panel-based, type-led**. Think Linear's data density crossed with a developer-tool palette: lots of 1px borders, small mono labels, soft tinted status pills, blue as the single hero accent, and saturated colors held in reserve for run state.

### Color

| Role | Light | Dark | Notes |
|---|---|---|---|
| **Surface (page bg)** | `#FBFAF8` | `#06080C` | Off-white in light; near-black in dark |
| **Panel / card** | `#FFFFFF` | `#0D1116` | The only pure white in light mode |
| **Muted strip** | `#F6F5F2` | `#0B0F13` | Search bars, table headers, agent-row hover |
| **Border** | `#E3E1DE` | `#1F2329` | 1px, always |
| **Ink primary** | `#12171B` | `#DBDEE2` | Headings, primary text |
| **Ink secondary** | `#43484E` | `#A7ABB1` | Body text, nav |
| **Ink muted** | `#767B80` | `#70757C` | Captions, meta |
| **Ink subtle** | `#A1A5A9` | `#494E54` | Mono labels, placeholders |
| **Accent (blue)** | `#2A76E2` | `#5CA4FF` | The only brand color — buttons, links, active nav, focus |
| **Accent soft** | `#DEF0FF` | `#0C3164` | Tinted-active backgrounds (10–20% alpha of accent) |
| **OK (green)** | `#269F5F` | `#43C07A` | Completed runs, success toasts |
| **Err (red)** | `#DE3B3D` | `#FA6863` | Failed runs, destructive buttons |
| **Warn (yellow)** | `#DE9300` | `#F2A618` | Queued, retry, warnings |
| **Info (cyan)** | `#0098C0` | `#00B8E1` | Running runs |
| **Human (purple)** | `#9763CC` | `#BC88F4` | Human checkpoints, agent avatars |

**Rules.** Accent blue carries every primary action and active state. Status colors **only** appear on run state, toasts, and the dots/badges that summarise them — never as decorative fills. Both themes use the same hue set, with lightness adjusted; ratios stay AA on body text in both. Gradients are vanishingly rare — one place: the user avatar (`linear-gradient(135deg, accent, accent-purple)`).

### Type

- **Inter Tight** for everything that isn't code — headings, body, nav, buttons. 400/500/600/700.
- **JetBrains Mono** for labels, counts, badges, kbd, file paths, agent IDs, brand mark glyph, group titles, and the small uppercase overlines. 400/500/600.
- Body is `13px / 1.55` with `letter-spacing: 0` and `font-feature-settings: 'cv11', 'ss01'` enabled — so the alternate single-storey `a` and stylistic set 01 are active. Keep those features on if you re-platform.
- Headings keep `letter-spacing: 0` too — no tracking. Allen does not use uppercase tracked headlines; the only uppercase is in mono overlines (`SOURCES`, `ORG`) at `letter-spacing: 0.08em`.

The semantic scale (mirrors `tailwind.config.js`):

```
2xs       11 / 1.5    badge text, counters
meta      11 / 1.5    timestamps, env hints
caption   12 / 1.5    empty states, sub-labels
body      13 / 1.55   default
title     14 / 1.4    card titles, row titles
h2        18 / 1.3    section headers
h1        24 / 1.25   page headers
display   44 / 1.05   hero (mw-hero only)
```

### Spacing

A 4-pt baseline grid. Page shells run `px-6 pt-5 pb-8`. Cards have `padding: 16px–20px`. Row paddings are `12px 16px`. Inline gaps are `6 / 8 / 10 / 12 / 16 / 20 / 24` px. Verticals between sections are `20 / 24 / 28` px.

### Radii

| Token | Value | Use |
|---|---|---|
| `--radius-sm` | 4px | Chips, kbd, small badges, mono pills |
| `--radius`    | 8px | Buttons, inputs, nav items, popovers |
| `--radius-lg` | 12px | Cards, dialogs, panels |
| `--radius-xl` | 12px | Same — `xl` is an alias, not larger |
| (pill)        | 999px | Status badges, pulse chips, avatars |

Allen does **not** use 16/20/24px card radii. The biggest container radius is 12px.

### Shadows

Only two, and both are soft:

```
--shadow-sm:      0 1px 2px rgb(0 0 0 / 0.04), 0 1px 1px rgb(0 0 0 / 0.04);
--shadow-popover: 0 8px 24px rgb(24 24 26 / 0.08), 0 2px 6px rgb(24 24 26 / 0.06);
```

`shadow-sm` only appears on `.card-hover:hover`. `shadow-popover` is for the command palette, dialogs, dropdowns. Resting cards get a 1px border, **not** a shadow. There is no glow, no neon, no colored shadow — explicitly removed from v1.

### Borders

A 1-pixel `rgb(var(--color-border))` line is the primary separator in Allen. Borders do almost everything: they separate cards, table rows, sidebar groups, topbar from body, terminal panels from code panels. There is no use of dividers (`<hr>`) outside of borders; rule lines come from `border-bottom` on a row.

### Active states

- **Hover:** background shifts up one surface level (`surface-100` → `surface-200`), text moves from secondary to primary. Borders deepen from `border` to `border-strong`. **Never** opacity-fade.
- **Active nav:** soft accent background (`--color-accent-soft`), accent text, accent-tinted 18% border. The nav sub-item gets a 2px accent rail on the left instead.
- **Press:** no explicit press state — the hover state holds during click. Buttons don't shrink.
- **Focus:** 3px `accent / 0.18` outer ring. Applied via `box-shadow`, never `outline`.
- **Disabled:** `opacity: 0.5`, `cursor: not-allowed`. Color is not adjusted independently.

### Backgrounds & decoration

- **No background images.** No photography, no full-bleed hero imagery, no patterns. The closest is the My Work home, which has a 3-stop vertical fade between `surface` and `surface-100`.
- **No textures, no grain, no noise.**
- **No illustrations.** Empty states are plain text — `task-empty` is `border-dashed` + muted text. The brand has no mascot or character.
- **No protective gradients** behind text on imagery — because there is no imagery.
- **Transparency** is reserved for:
  - Status badge fills at `0.10–0.15` alpha of the status color
  - Hover backgrounds at `0.55` alpha of `surface-200`
  - The 35% black `bg-black/35 backdrop-blur-sm` scrim behind the command palette
- **Blur** appears only on that command-palette scrim. No frosted-glass cards.

### Animation

Restrained and short. Three patterns:

| Class | Effect | Use |
|---|---|---|
| `animate-pulse-running` | gentle outer-ring pulse on `accent-cyan` | running execution dot |
| `animate-msg-enter` (`al-msg-enter`) | 0.3s `fade + slide-up 0.5rem` | new chat message rows |
| `animate-agent-pulse` (`al-agent-pulse`) | opacity 0.55 ↔ 1 over 1.6s | agent "thinking" indicators |

Easing is `ease-in-out` or `ease-out`. Durations are **120ms** for state transitions (color, border, background), **200–300ms** for entries. There are no spring-style bounces, no rotates, no scales — explicitly stripped out of v1.

### Layout rules

- **Fixed shell:** a left sidebar (220px expanded / 56px collapsed) and a top bar (52px) wrap the app. Both are `overflow: hidden`; content scrolls inside.
- **Pages** breathe at `px-6 pt-5 pb-8`. Above-the-fold content is typically `max-width: 980px` and centered (e.g. `.mw-hero-inner`).
- **Tables** are full-width with `border-collapse: separate` and 14px row padding. Headers are `surface-200` background with mono 10px uppercase labels.
- **Two-pane layouts** (library, workspace, executions detail) use a fixed left column (260–360px) and a flex-1 right column with its own scroll. Sidebar border is always `border-right: 1px solid --color-border`.

---

## Iconography

Allen uses **[Lucide React](https://lucide.dev/)** exclusively in product code. Every icon you see in `App.tsx` is imported from `lucide-react`. No custom SVG icons, no emoji, no Unicode characters used as icons.

- **Stroke style.** Lucide's default — 24×24 viewBox, 2px stroke, round caps and joins.
- **Sizing.** Almost always `w-4 h-4` (16px) for inline; `w-3.5 h-3.5` (14px) in tight chrome; `w-3 h-3` (12px) inside badges.
- **Color.** Icons inherit from text (`currentColor`) — they pick up the surrounding `theme-muted` / `theme-secondary` / `accent` color automatically.
- **No filled icons.** Allen uses outline-only Lucide icons. The exception is the brand mark.

### Brand mark

A monospace `[a]` glyph rendered inside a soft-accent capsule.

```html
<div class="brand-mark">[a]</div>
```

```css
.brand-mark {
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid rgb(var(--color-accent) / 0.25);
  border-radius: 6px;
  background: rgb(var(--color-accent-soft));
  color: rgb(var(--color-accent));
  padding: 3px 6px;
  font-family: var(--font-mono);
  font-size: 13px; font-weight: 600;
}
```

The favicon (`assets/allen-mark.svg`) is a richer marketing variant: a 32×32 rounded-rect with a blue→purple gradient and abstract glyphs (lines + dots) suggesting "list of work + status indicators." Use the favicon when you need a logomark on dark backgrounds or a tile; use the `[a]` capsule everywhere else.

### Common icons & their meaning

These are the Lucide names actually used by the product. If you mock a feature, reach for the matching icon:

| Concept | Lucide name |
|---|---|
| Chat / message | `MessageSquare` |
| Execution / run | `Play` |
| Workflow | `GitBranch` |
| Pull request | `GitPullRequest` |
| Repo / workspace | `FolderGit2` |
| Team / agent | `Users` |
| Ticket (Linear) | `Ticket` |
| Settings | `Settings` |
| Search | `Search` |
| Command palette | `Command` |
| Sign out | `LogOut` |
| Toggle sidebar | `PanelLeft` |
| New chat | `Sparkles` |
| Chevron | `ChevronRight` / `ChevronLeft` |
| Light / dark mode | `Sun` / `Moon` |
| Success | `CheckCircle` |
| Failure | `XCircle` |
| Waiting / paused | `Pause` |
| Queued | `Clock` |
| Running | `Loader2` (with `animate-spin`) |
| Info toast | `Info` |
| Warning toast | `AlertCircle` |
| Close | `X` |

For artefacts outside the codebase, load Lucide from the CDN:

```html
<script src="https://unpkg.com/lucide@latest"></script>
```

— or use Lucide React in JSX prototypes. This is the **only** icon set Allen uses; do not mix in Heroicons, Feather, Phosphor, or emoji.

---

## Font substitutions

Both Allen typefaces (Inter Tight + JetBrains Mono) are **Google Fonts**, loaded via the CSS `@import` in `colors_and_type.css`. No local font files are required.

There's one additional optional face — **JetBrainsMono Nerd Font** — pulled from a `cdn.jsdelivr.net` mirror for terminal contexts that need patched glyphs. If you need it, copy the `@font-face` block from `packages/ui/index.html`. The non-Nerd JetBrains Mono is fine for everything outside a real terminal.

---

## Caveats

- **`apps/landing` is empty in the repo.** This system documents the product UI only. If you build a landing page, extend these tokens rather than inventing a parallel system.
- **No printed/exported brand guidelines** were attached — voice and tone rules above are inferred from product copy and the `README.md`. Refine with whoever owns the brand.
- **Allen does not have a logotype** — only the `[a]` mark and the favicon. If you need a wordmark, set "allen" in Inter Tight 600, all lowercase, `letter-spacing: 0`.
