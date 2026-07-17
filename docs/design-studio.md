# Allen Design (Design Studio)

A dedicated, first-class **Design Studio** surface that acts like an AI UI/UX
designer: it understands an existing repository's design system (or interviews
you for a new idea), generates live, responsive HTML/CSS prototypes, lets you
preview them in your local browser, iterate conversationally, organize requested
designs into dashboard-linked folders, compare variants when requested, browse
version history, and export a standalone HTML bundle.

This is a **fresh build**, intentionally independent of the legacy `design_*`
collections/services. It lives under its own namespace:

- UI routes: `/studio`, `/studio/workspaces/:id`, `/studio/sessions/:id`
- Sidebar panel: accessible from the left dot in the expanded app sidebar carousel — lists Design Studio workspaces with compact status badges, search/filter, and a + button to create new workspaces. On `/design` routes, the sidebar switches to a `DesignNavPanel` that shows design-session history instead.
- API: `/api/design-studio/*`
- Unauthenticated preview/static site: `/dstudio-preview/:token/:file`, `/dstudio-site/:workspaceId/:file`
- Mongo collections: `dstudio_workspaces`, `dstudio_sessions`, `dstudio_versions`, `dstudio_messages`
- Managed local storage: `<allen-home>/design-studio/{workspaces,previews,exports}`

## Architecture

Three persistence tiers (all local, Allen-managed Mongo):

```
Workspace (one per repo / per idea — holds the confirmed profile or brief)
 └─ Session (a design conversation)
     └─ Version (every generation/iteration; variant siblings grouped, branchable)
```

- **`services/design-studio/store.service.ts`** — all CRUD + the version-graph
  rules (variants as grouped siblings, branch, restore-without-destroying-history).
- **`services/design-studio/repo-scan.ts`** — read-only repo scan for styling
  signals + a fingerprint used for change detection.
- **`services/design-studio/llm.service.ts`** — prompt building + output parsing
  for analysis, greenfield synthesis, generation/variants, and surgical iteration.
  The model call is an injectable `Completer` (default wraps `runChatLLM`), which
  keeps the orchestration unit-testable without a live model.
- **`services/design-studio/preview.service.ts`** — materializes a version's
  screens to disk and serves them over a token-scoped, unauthenticated route so
  they open in the real browser with working navigation.
- **`services/design-studio/export.service.ts`** — writes a self-contained bundle.
- **`services/design-studio/workspace-fs.ts`** — manages the persona-driven
  workspace folder: root dashboard, shared `styles.css`, `designs/manifest.json`,
  and per-design folders.
- **`routes/design-studio.routes.ts`** — the HTTP surface.

## Session model: reuse the chat UI + a "UI Designer" persona

The design session **reuses the existing chat UI** (`ChatPage`) rather than a
bespoke conversation. When you start a design, the backend creates a normal chat
session carrying a **per-session system-prompt override** — the "UI Designer"
persona (the same mechanism as the planner persona, not a seeded agent). The
persona works in a persistent design-system folder. The folder has one root
`index.html` dashboard, shared `styles.css`, `designs/manifest.json`, and one
folder per requested design group, for example:

```
index.html
styles.css
designs/
  manifest.json
  login/
    index.html
    login.html
  landing/
    index.html
    variation-1.html
    variation-2.html
```

The number of pages or variations is driven by the user's request. Asking for
"a login page" creates one login page; asking for "three login variations"
creates three variation pages. The root dashboard links to each design group's
gallery page.

- Persona prompt: `buildDesignerPersona()` in `design-studio/llm.service.ts`
- Wiring: `POST /api/design-studio/workspaces/:id/start` creates the chat session
  with `systemPromptOverride` (chat.service `createSession` extras) bound to the
  workspace design-system folder. `chat.service.sendMessage` uses the override
  when no team agent is selected.
- Model selection: the Studio composer opens before a chat session exists, so the
  user can change model just like normal chat. If unchanged, a new Studio session
  starts on the configured default chat provider/model. Repo analysis and refresh
  deliberately continue to use Claude/Opus for design-analysis quality.
- Repo identity: repo-backed workspaces keep the source repo id/name on the chat
  session while file tools run inside the Studio folder. The seeded root
  dashboard includes the repository name so multiple repo dashboards are easy to
  distinguish.
- Planning gate: for each new design request, the persona must present a concise
  plan and wait for confirmation before writing files. When variations are
  requested, the plan names what each variation will focus on.
- Studio navigation chrome stays outside the designed page canvas. Links such as
  dashboard, variations, and variation switchers use the shared floating
  bottom-right `.studio-floating-nav` control instead of appearing in the
  product header, nav, footer, hero, or content.
- Preview/export: `WorkspaceFilesPanel` lists the folder, opens files through
  `/dstudio-site/:workspaceId/:file`, and exports the folder recursively.
  HTML artifacts still render because `mimeForArtifact` serves `.html` as
  `text/html`.

The structured analysis/generation/version/export services below remain for the
profile setup (analysis) and are available for the alternate non-goal flow.

## Requirement traceability

| Req | Where | Tested |
| --- | --- | --- |
| R1 surface | `/studio` route + nav item; `DesignStudioPage` | `DesignStudioPage.test` |
| R2 entry modes | `NewWorkspaceModal` (repo / new idea) | `DesignStudioPage.test` |
| R3 design profile | `repo-scan` + `llm.analyzeRepo`; `ProfileReview` | `llm.service.test` |
| R4 review/correct | `ProfileReview` + `POST /workspaces/:id/profile` | UI + routes test |
| R4.1 mimic vs normalize | `needs_choice` gate; required `strategy` | `DesignStudioWorkspacePage.test`, routes |
| R4.2 multi-theme pick | themes listed; required `selectedTheme` | `llm.service.test`, UI test |
| R5 conformance + invented | `renderDesignContext`; `inventedElements` surfaced | `llm.service.test` |
| R6/R7 discovery | `GreenfieldSetup` + `llm.synthesizeBrief` (direction/assumptions) | UI + routes test |
| R8/R9 responsive prototype | `llm.generate` (full HTML, media queries); viewport toggle | `llm.service.test` |
| R10 variants | `generateVariants` + `addVariantGroup`; `VariantPicker` | store + llm + routes test |
| R11/R12 preview | `buildPreview` + iframe + open-in-browser; viewport widths | `preview-export.test` |
| R13/R14 surgical iterate | `llm.iterate` (changed-only merge) | `llm.service.test`, routes |
| R15/R16 multi-screen | relative-link nav; per-screen edits append/replace | `preview-export`, `llm.service.test` |
| R16.1 surface interactivity | `PROTOTYPE_RULES` (vanilla JS, no data/logic) | (prompt contract) |
| R17/R18 versions | append-only history; restore preserves later | `store.service.test`, routes |
| R18.1 variants in history / branch | grouped siblings; `selectVariant`; `branch` | `store.service.test`, routes |
| R18.2 unlimited | no cap (120-version test) | `store.service.test` |
| R19/R20 export bundle | `exportVersion` self-contained folder + nav | `preview-export.test`, routes |
| R21 storage | Mongo + `<allen-home>/design-studio`; export destination | (by construction) |
| R22 workspaces | per-repo dedupe; per-idea workspace | `store.service.test`, routes |
| R22.1 reuse profile | profile on workspace; no re-analysis | `store.service.test` |
| R22.2 repo changed | fingerprint compare + refresh/keep | UI test + `GET /repo-change` |
| R22.3 greenfield reuse | brief on workspace; no repeated interview | by construction |

## Notes / limitations

- **Live-model quality** (surgical edits, variant distinctness, interactivity) is
  enforced via prompt contracts and validated at the orchestration level with a
  fake completer; end-to-end fidelity depends on the model and is not asserted in
  CI.
- The Mongo-backed test suites use `mongodb-memory-server`; they run in CI where
  the binary is reachable.
