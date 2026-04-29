# Component Conversion Guide — Allen UI v1 → v2

This is a one-page mapping from every existing component class in `packages/ui/src/index.css` to its v2 equivalent. **No JSX needs to change** for the basic conversion — drop in the new `index.css` and `tailwind.config.js`, and the existing class names keep resolving. This guide covers the visual deltas to expect plus tightening passes for after the first deploy.

---

## 1. Drop-in mapping (zero JSX change)

| v1 class | Resolves in v2 to | Visual delta |
|---|---|---|
| `bg-surface`, `bg-surface-100/80` | Light off-white surfaces (#FBFBFA, #FFFFFF/80%) | Now light, not deep navy |
| `border-border/60` | Hairline #E8E7E4 at 60% | Softer, less contrast |
| `text-accent-blue`, `text-accent-cyan` | Both alias to violet `#5E6AD2` | Cyan → violet |
| `bg-accent-blue/15` | Violet at 15% over white | Was glowing cyan, now soft violet tint |
| `shadow-glow-blue/green/red/...` | `none` (kept as no-ops) | Glow rings removed |
| `text-accent-red` | `#DC2626` | Slightly less hot |
| `text-accent-green` | `#059669` | More muted, more "shipped"-feeling |
| `.card` | White surface, 1px hairline, 10px radius | Clip-path corners removed; no top accent line |
| `.btn-primary` | Violet fill, white text, sentence-case | No clip-path, no glow, no uppercase |
| `.btn-ghost` | Transparent, hover #F4F4F2 | Same shape, lighter |
| `.btn-danger` | Red fill, white text | Was tinted/glowing; now solid |
| `.input` | Boxed input with focus ring | Was bottom-bordered terminal style |
| `.badge` | Geist Mono, soft tint | Was uppercase tracking-wider |
| `.glow-running` | Subtle pulse | Was bright cyan ring |
| `.glow-completed` / `.glow-failed` | No-ops | State now shown via badge color only |
| `.scan-lines::after` | No-op | Global scan-line overlay removed |

---

## 2. Tightening pass (recommended after deploy)

Once the v2 tokens are live, search-and-replace these to match the new design language exactly:

```bash
# 1. Cyan/blue accent references — rename for clarity
rg "accent-blue|accent-cyan" packages/ui/src --files-with-matches
# Replace with: accent  (or accent-violet for new code)

# 2. Glow shadows — delete entirely once verified clean
rg "shadow-glow-" packages/ui/src
# Remove the className segment

# 3. Uppercase button copy in JSX
rg "tracking-wider|uppercase" packages/ui/src/components --files-with-matches
# Buttons: drop both. Overlines: keep, but use .overline class.

# 4. Clip-path utilities (if any inline)
rg "clip-path" packages/ui/src
```

---

## 3. New v2-only classes worth adopting

These are introduced in v2 and used throughout the design references:

```jsx
<span className="overline">Recently active · 12</span>

<button className="btn btn-secondary btn-sm">Filter</button>

<span className="badge badge-ok">● completed</span>
<span className="badge badge-info">PR #612</span>
<span className="badge badge-human">human in loop</span>

<div className="card-hover">…</div>   {/* card with hover lift */}

<span className="dot dot-run"></span> running
```

---

## 4. Pages → reference designs

| Allen page (`packages/ui/src/pages/`) | Reference HTML (in this handoff) |
|---|---|
| `DashboardPage.tsx` | `references/01-dashboard.html` |
| `ChatPage.tsx` | `references/02-chat.html` |
| `WorkflowListPage.tsx`, `WorkflowBuilderPage.tsx` | `references/03-workflows.html` |
| `RoleManagerPage.tsx` (agents) | `references/04-agents.html` |
| `RepoManagerPage.tsx` | `references/05-repos.html` |
| `TicketsPage.tsx` (Linear) | `references/06-linear.html` |
| `WorkspaceListPage.tsx`, `WorkspaceDetailPage.tsx` | `references/07-workspaces.html` |
| `PullRequestListPage.tsx`, `PullRequestDetailPage.tsx` | `references/08-pull-requests.html` |
| `ExecutionListPage.tsx`, `ExecutionDetailPage.tsx` | `references/09-executions.html` |
| `InterventionsPage.tsx` | `references/10-interventions.html` |
| `AnalyticsPage.tsx`, `LearningsPage.tsx` | `references/11-analytics.html` |
| `CronManagerPage.tsx` | `references/12-scheduled.html` |

Each reference shows three directions side-by-side; **direction 02 (Linear-clean)** is the one the tokens here implement.

---

## 5. Font setup

Add to `packages/ui/index.html` `<head>`:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link
  href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap"
  rel="stylesheet"
>
```

Or self-host into `packages/ui/public/fonts/` and add `@font-face` rules.
