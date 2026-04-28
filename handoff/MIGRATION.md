# Allen UI v2 — Migration Playbook

**Goal:** ship the v2 (Linear-clean) design system to `packages/ui` with minimal disruption to the rest of the monorepo (`engine`, `server`).

**Estimated effort:** 1 day for the drop-in, 2–3 days for the tightening pass, 1–2 weeks page-by-page polish.

---

## Phase 0 · Branch & font setup (15 min)

```bash
git checkout -b ui/v2-linear-clean
```

Add fonts to `packages/ui/index.html`:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap" rel="stylesheet">
```

---

## Phase 1 · Drop-in tokens (30 min)

```bash
# from this handoff folder
cp tokens/index.css.v2          ../packages/ui/src/index.css
cp tokens/tailwind.config.js.v2 ../packages/ui/tailwind.config.js
```

Run `npm --workspace=@allen/ui run dev` and click through every page. Expected outcome: the **whole app turns light** with the violet accent, badges and buttons restyle automatically. Glow shadows disappear. **Nothing should crash** — every legacy class name still resolves (with `shadow-glow-*` mapped to `none` and `accent-blue/cyan` mapped to violet).

**Commit checkpoint** — this is your safe rollback point.

```bash
git commit -am "ui: v2 tokens drop-in (Linear-clean)"
```

---

## Phase 2 · Visual QA pass (2–4 hours)

Open each page, compare to its `references/*.html`. Look for:

- [ ] **Contrast issues** — any near-white text on near-white backgrounds (was white-on-navy before)
- [ ] **Hardcoded hex colors** in components (search: `rg "#[0-9a-fA-F]{6}" packages/ui/src/components`)
- [ ] **Inline `style={{ background: '...' }}`** with v1 navy values
- [ ] **Monaco / xterm theming** — both have their own theme APIs; see Phase 4
- [ ] **Mermaid diagrams** — token vars are already updated; refresh the page to verify
- [ ] **React Flow edges** — same; check the Workflow Builder

File issues per page; don't fix them yet — batch in Phase 3.

---

## Phase 3 · Page-by-page polish (1–2 weeks, async)

Order by user-facing impact:

1. `DashboardPage` (landing — sets the tone)
2. `ChatPage` (highest engagement)
3. `WorkflowListPage` + `WorkflowBuilderPage`
4. `ExecutionListPage` + `ExecutionDetailPage`
5. `RoleManagerPage`, `RepoManagerPage`, `TicketsPage`
6. The rest

For each page:

1. Open `references/<page>.html` in one window, the dev server in another
2. Pick **direction 02 (Linear-clean)** — that's what the tokens implement
3. Replace inline hex with token classes (`bg-app`, `bg-app-card`, `text-theme-muted`, etc.)
4. Drop `tracking-wider uppercase` from buttons; add to `.overline` labels instead
5. Replace `shadow-glow-*` with nothing (or `shadow-sm` for hover affordance)
6. Replace clip-path corners with `rounded-lg`

---

## Phase 4 · Third-party theming

### Monaco editor

In the file that initialises Monaco (likely `components/editor/`):

```ts
monaco.editor.defineTheme('allen-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#FFFFFF',
    'editor.foreground': '#18181A',
    'editor.lineHighlightBackground': '#F8F9FC',
    'editorGutter.background': '#FBFBFA',
    'editorLineNumber.foreground': '#B8B8BC',
    'editorLineNumber.activeForeground': '#5E6AD2',
    'editor.selectionBackground': '#EEF0FB',
    'editorCursor.foreground': '#5E6AD2',
  },
});
monaco.editor.setTheme('allen-light');
```

### xterm.js

```ts
new Terminal({
  theme: {
    background: '#18181A',   // terminals stay dark — readable, expected
    foreground: '#F4F4F2',
    cursor:     '#5E6AD2',
    selectionBackground: 'rgba(94,106,210,0.35)',
  },
  fontFamily: 'Geist Mono, JetBrains Mono, monospace',
  fontSize: 13,
});
```

### React Flow (`@xyflow/react`)

Edge colors come from the `--color-flow-edge-*` CSS vars — already updated in `tokens/index.css.v2`. Node styles in custom node components may have inline hex; sweep those.

### Mermaid

Already wired through `--color-mermaid-*` vars. Re-render any open diagrams.

---

## Phase 5 · Optional dark mode

The tokens file ships a `.dark` block (Phase 0 was light-by-default). To enable a dark toggle:

```tsx
// somewhere in App.tsx
<button onClick={() => document.documentElement.classList.toggle('dark')}>
  Toggle theme
</button>
```

The dark palette is intentionally less saturated than v1 — same restraint, just inverted surface stack.

---

## Phase 6 · Cleanup (after 1 week of stable v2)

Once you're confident no JSX still references the v1-specific names:

1. Remove the legacy `accent-blue` / `accent-cyan` / `shadow-glow-*` aliases from `tailwind.config.js`
2. Delete the `.scan-lines::after { content: none; }` no-op line
3. Drop the `.glow-completed`/`.glow-failed` no-op rules

Search before removing:

```bash
rg "accent-blue|accent-cyan|shadow-glow|scan-lines|glow-completed|glow-failed" packages/ui/src
```

Should return 0 hits.

---

## Rollback

`git revert <phase-1-commit>` and you're back on v1. The migration is fully self-contained in two files: `index.css` + `tailwind.config.js`. No JSX is required to change for the rollback to be clean.

---

## Risks & gotchas

- **Editor pages may look low-contrast** if Monaco still uses a dark theme on a light page. Phase 4 fixes this.
- **xterm terminals** intentionally stay dark — flipping them light fights the user's expectation of what a terminal looks like.
- **Glow-as-affordance** — anywhere a glow was *the only* indicator of a state, that state is now invisible. Hunt for `shadow-glow-*` and verify a badge or icon also signals the state.
- **Type sizing** — v2 body is 13px (was unset / inherited). Some dense tables may now feel slightly looser; if too loose, scope a `text-[12px]` override on that page.
