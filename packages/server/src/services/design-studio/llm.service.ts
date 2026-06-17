/**
 * Allen Design Studio — LLM orchestration
 *
 * Builds the prompts and parses the structured output for:
 *  - repo analysis → design profile (R3) incl. consistency (R4.1) + themes (R4.2)
 *  - greenfield discovery synthesis (R6/R7)
 *  - prototype generation, incl. side-by-side variants (R8/R9/R10/R16.1)
 *  - surgical conversational iteration (R13/R14)
 *
 * The actual model call is injected as a `Completer` so the orchestration is
 * unit-testable without a live model. The default completer wraps the app's
 * existing `runChatLLM` (Claude via the Claude Code SDK).
 */

import type { Db } from 'mongodb';
import type { ColorToken, DesignProfile, DesignProfileThemeOption, GreenfieldBrief, Screen } from './types.js';
import { renderScanForPrompt, type RepoScanResult } from './repo-scan.js';

// ── Repo context analysis (product / routes / components) ────────────────────

export interface RepoContextAnalysis {
  /** One-paragraph plain-language product summary for the designer. */
  productSummary: string;
  /** Discovered routes/pages with their inferred purpose. */
  routes: { path: string; description: string }[];
  /** Key page/component source files with their purpose. */
  keyPages: { file: string; purpose: string }[];
  /** Other important files the designer should know about (API defs, data models). */
  importantFiles: { file: string; purpose: string }[];
  /** Component inventory: UI components found in the repo. */
  componentInventory: { name: string; purpose: string }[];
}

// ── Completer abstraction ─────────────────────────────────────────────────────

export interface CompleteRequest {
  system: string;
  prompt: string;
  /**
   * When set, the agent runs with this working directory and can use its native
   * file tools (Read/Glob/Grep) to explore the directory — used so repo analysis
   * reads the actual repository instead of only a truncated excerpt.
   */
  cwd?: string;
}
export type Completer = (req: CompleteRequest) => Promise<string>;

/**
 * Default completer backed by the Claude Code agent (via runChatLLM). It runs on
 * Allen's AGENT provider/model defaults (Claude/Opus out of the box) rather than
 * the lighter chat default, because design analysis/generation is agentic work.
 * MCP servers are left off (skipTools) to keep it focused, but the agent's native
 * file tools are available whenever a `cwd` is provided, so analysis can explore
 * the repo directly. Pass `modelOverride` to force a specific model.
 */
export function makeDefaultCompleter(db: Db, override?: { provider?: string; model?: string }): Completer {
  return async ({ system, prompt, cwd }) => {
    const { runChatLLM } = await import('../chat-llm.js');
    const { getAgentDefaults } = await import('../llm-defaults.js');
    const defaults = getAgentDefaults();
    const result = await runChatLLM(db, {
      systemPrompt: system,
      messages: [{ role: 'user', content: prompt }],
      skipTools: true,
      provider: (override?.provider as any) ?? defaults.provider,
      model: override?.model ?? defaults.model,
      cwd,
      onText: () => {},
      onToolStart: () => {},
      onToolResult: () => {},
    });
    return result.text;
  };
}

// ── Hybrid profile parsing (markdown + structured signals) ────────────────────

/** Pull unique CSS color literals from text as a last-resort color list. */
function scrapeColors(text: string): ColorToken[] {
  const found = new Map<string, ColorToken>();
  for (const m of text.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]+\)/g)) {
    const value = m[0];
    if (!found.has(value)) found.set(value, { name: value, value });
    if (found.size >= 12) break;
  }
  return [...found.values()];
}

interface ProfileSignals {
  colors?: ColorToken[];
  typography?: string;
  spacing?: string;
  components?: { name: string; description: string }[];
  iconography?: string;
  layoutPatterns?: string;
  consistency?: { consistent: boolean; issues: string[] };
  themes?: DesignProfileThemeOption[];
}

/**
 * Parse an analysis reply: a markdown profile followed by a ```json signals
 * block. Returns null when the required signals block is absent or unparseable
 * — i.e. when the model replied conversationally instead of doing the task. We
 * deliberately do NOT fabricate a profile from prose, so a chat-style answer
 * ("what would you like to build?") is treated as a failure, not a profile.
 */
export function parseHybridProfile(text: string): DesignProfile | null {
  const fence = text.match(/```json\s*([\s\S]*?)```/i) ?? text.match(/```\s*(\{[\s\S]*?\})\s*```/);
  if (!fence) return null;

  let signals: ProfileSignals;
  try {
    signals = extractJson<ProfileSignals>(fence[1]);
  } catch {
    return null;
  }

  let markdown = text.replace(fence[0], '').trim();
  markdown = markdown.replace(/^```(?:markdown|md)?\s*/i, '').replace(/```\s*$/i, '').trim();
  if (!markdown) return null; // signals without any human-readable profile = non-compliant

  const colors = signals.colors?.length ? signals.colors : scrapeColors(text);
  const consistency = signals.consistency ?? { consistent: true, issues: [] };
  consistency.issues ??= [];
  const themes = signals.themes && signals.themes.length >= 2 ? signals.themes : undefined;

  return {
    summaryMarkdown: markdown,
    colors,
    typography: signals.typography,
    spacing: signals.spacing,
    components: signals.components,
    iconography: signals.iconography,
    layoutPatterns: signals.layoutPatterns,
    consistency,
    themes,
  };
}

// ── Output parsing helpers ────────────────────────────────────────────────────

/** Extract the first JSON object/array from a model response (handles fences). */
export function extractJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.search(/[[{]/);
  if (start === -1) throw new Error('no JSON found in model output');
  // Walk to the matching closing bracket.
  const open = candidate[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        return JSON.parse(candidate.slice(start, i + 1)) as T;
      }
    }
  }
  throw new Error('unterminated JSON in model output');
}

function ensureFullHtml(html: string, title: string): string {
  const trimmed = html.trim();
  if (/<!doctype html>/i.test(trimmed) || /<html[\s>]/i.test(trimmed)) return trimmed;
  // Wrap a bare fragment so the screen is always a self-contained document.
  return `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1" />\n<title>${title}</title>\n</head>\n<body>\n${trimmed}\n</body>\n</html>`;
}

function slugify(name: string, fallback: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || fallback;
}

interface RawScreen {
  name?: string;
  fileName?: string;
  html?: string;
}

function normalizeScreens(raw: RawScreen[]): Screen[] {
  const used = new Set<string>();
  return (raw ?? [])
    .filter((s) => typeof s?.html === 'string' && s.html.trim().length > 0)
    .map((s, i) => {
      const name = (s.name ?? `Screen ${i + 1}`).trim();
      let fileName = (s.fileName ?? '').trim();
      if (!fileName) fileName = i === 0 ? 'index.html' : `${slugify(name, `screen-${i + 1}`)}.html`;
      if (!/\.html?$/i.test(fileName)) fileName = `${fileName}.html`;
      // Guarantee an index.html entry point exists for the first screen.
      if (i === 0 && fileName !== 'index.html' && !used.has('index.html')) fileName = 'index.html';
      while (used.has(fileName)) fileName = fileName.replace(/(\.html)$/i, `-${i}$1`);
      used.add(fileName);
      return {
        id: `${Date.now().toString(36)}-${i}`,
        name,
        fileName,
        html: ensureFullHtml(s.html as string, name),
      };
    });
}

// ── Design-spec rendering (profile or brief → generator context) ─────────────

export function renderDesignContext(opts: { profile?: DesignProfile; brief?: GreenfieldBrief }): string {
  if (opts.profile) {
    const p = opts.profile;
    const colors = p.colors.length ? `\nColors:\n${p.colors.map((c) => `- ${c.name}${c.role ? ` (${c.role})` : ''}: ${c.value}`).join('\n')}` : '';
    const comps = p.components?.length ? `\nKnown components:\n${p.components.map((c) => `- ${c.name}: ${c.description}`).join('\n')}` : '';
    const strategy = p.consistency.strategy
      ? `\nConsistency strategy: ${p.consistency.strategy === 'mimic' ? 'mimic the dominant existing style as-is' : 'normalize into a cleaned-up, consistent system'}.`
      : '';
    const theme = p.selectedTheme ? `\nActive theme: ${p.selectedTheme}.` : '';
    return [
      'DESIGN PROFILE (the design must visibly conform to this):',
      p.summaryMarkdown,
      colors,
      p.typography ? `\nTypography: ${p.typography}` : '',
      p.spacing ? `Spacing/sizing: ${p.spacing}` : '',
      p.iconography ? `Iconography: ${p.iconography}` : '',
      p.layoutPatterns ? `Layout patterns: ${p.layoutPatterns}` : '',
      comps,
      strategy,
      theme,
    ].filter(Boolean).join('\n');
  }
  const b = opts.brief!;
  return [
    'DESIGN BRIEF (greenfield — the design must reflect this direction):',
    `Product: ${b.product}`,
    `Audience: ${b.audience}`,
    `Desired feel / brand personality: ${b.feel}`,
    `References (liked/disliked): ${b.references}`,
    `Key screens / flows: ${b.screens}`,
    b.direction ? `Chosen direction: ${b.direction}` : '',
    b.assumptions?.length ? `Assumptions made: ${b.assumptions.join('; ')}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * Preamble that forces task-completion behavior. These calls run as automated
 * batch jobs with no human in the loop, so the model must never converse, greet,
 * ask clarifying questions, or offer to help — it must produce the artifact.
 */
const NON_INTERACTIVE = [
  'You are running as an AUTOMATED, NON-INTERACTIVE job. There is NO human to talk to and no follow-up turn.',
  'Do NOT ask questions, greet, explain yourself, or offer to help. Do NOT say things like "what would you like".',
  'Produce the required artifact directly and completely. If information is missing, make a reasonable professional decision and proceed.',
].join(' ');

/**
 * The "UI Designer" persona — a per-session system-prompt swap (like the
 * planner) applied to the base chat assistant. It turns Design Studio's chat
 * into a designer that produces a live, self-contained HTML prototype saved as
 * an artifact the preview panel renders. `context` is the rendered design
 * profile/brief from renderDesignContext().
 */
export function buildDesignerPersona(context: string, meta: { workspaceName?: string; sourceRepoName?: string } = {}): string {
  const identity = meta.sourceRepoName
    ? `Workspace identity: repository "${meta.sourceRepoName}". The root dashboard title must clearly include this repository name so users can distinguish designs across multiple repositories.`
    : meta.workspaceName
      ? `Workspace identity: "${meta.workspaceName}". The root dashboard title must clearly include this name.`
      : '';
  return [
    'You are Allen Design Studio — an expert UI/UX designer and front-end prototyper.',
    'You work inside a PERSISTENT design-system folder (your current working directory). This folder is shared by every design in this workspace and grows over time — treat it like a small design-gallery repository, not a throwaway file.',
    'Keep chat replies to one or two short sentences naming the files you created/updated; do NOT paste large code into the chat.',
    identity,
    '',
    'ALWAYS START by understanding the existing system (use your file tools):',
    '- List the folder (Glob/LS) and READ `index.html`, `styles.css`, `system/manifest.json`, `system/tokens.css`, `system/components.css`, `system/components.html`, `system/pro-max.md`, `system/pro-max.json`, `system/source-repo.json`, `system/repo-context.md`, `system/repo-context.json`, `system/route-map.json`, `system/important-files.json` when present, `designs/manifest.json`, and any relevant `designs/<slug>/` files BEFORE writing anything.',
    '- REUSE the repository kit first: `--ds-*` tokens, `.ds-*` components, captured icon style, typography, controls, cards, overlays, states, and layout patterns. Do NOT re-invent or restyle components that already exist. Only ADD a new component when one genuinely does not exist yet.',
    '- Treat the DESIGN PROFILE below as the repository design-system handoff. Use its captured font families, typography scale, colors, radii, spacing, shadows, components, icon library/style, page shells, and state patterns when creating layouts.',
    '- Before writing a new page, identify which captured tokens/components/patterns apply. If the profile names an icon library or component style, use that visual style in the prototype instead of generic icons or arbitrary CSS.',
    '',
    'FILE STRUCTURE you maintain (use Write/Edit/Read tools — these are real files):',
    '- `index.html` — the ROOT DASHBOARD for the whole workspace. It renders design-group cards from `designs/manifest.json`. Never replace it with a single requested design.',
    '- `styles.css` — the single shared stylesheet. It imports the repository kit from `system/tokens.css` and `system/components.css`, then contains dashboard/gallery styles and any extra reusable workspace CSS. All pages link to it with the correct relative path.',
    '- `system/manifest.json` — machine-readable repository design-system kit: foundations, captured components, and usage rules generated during repo scan.',
    '- `system/tokens.css` — repository-derived design tokens. Prefer `--ds-*` variables for colors, font family, type scale, spacing, radii, control heights, shadows, and icon sizes.',
    '- `system/components.css` — repository-derived reusable component classes. Prefer `.ds-btn`, `.ds-input`, `.ds-card`, `.ds-tabs`, `.ds-modal`, `.ds-dropdown`, `.ds-badge`, `.ds-icon`, and related `.ds-*` classes before writing page-specific CSS.',
    '- `system/components.html` — visual reference sheet for the captured kit. Read it to understand how buttons, fields, cards, tabs, dropdowns, and overlays should look together.',
    '- `system/pro-max.md` and `system/pro-max.json` — supplemental UI/UX Pro Max design intelligence generated by Allen during analysis. Use it for planning, UX quality, accessibility, page structure, and variation focus. It must NOT override repository-derived tokens/components unless the user explicitly asks for a new visual direction.',
    '- `system/source-repo.json` — optional read-only pointer to the original repository. Use it on demand for redesigning existing repo pages; do not copy or edit source repo files.',
    '- `designs/manifest.json` — source of truth for dashboard cards. Shape: { "designs": [{ "slug": string, "title": string, "description": string, "entry": "designs/<slug>/index.html", "variations": [{ "label": string, "file": "designs/<slug>/<file>.html" }] }] }.',
    '- `designs/<design-slug>/` — one folder per distinct user-requested design group, e.g. `designs/login/` or `designs/landing/`.',
    '- `designs/<design-slug>/index.html` — gallery/detail page for that design group. It links to that group\'s concrete page(s) or variation(s). It links shared CSS as `../../styles.css`.',
    '- `designs/<design-slug>/<page-or-variation>.html` — the actual design page(s). These also link shared CSS as `../../styles.css` and use relative anchors within the group.',
    '- Studio-only navigation belongs in a floating control, not inside the designed product page. Use the shared `.studio-floating-nav` component for links such as "Dashboard", "Variations", "Variation 1", "Variation 2", or other preview controls.',
    '',
    'WHEN ASKED FOR A NEW DESIGN/SCREEN/FLOW:',
    '- Create or reuse a clear slug from the request (`login`, `landing`, `pricing`, etc.).',
    '- Create/update `designs/<slug>/index.html` as the group gallery.',
    '- Create the requested design file(s) inside `designs/<slug>/`.',
    '- Update `designs/manifest.json`; the root dashboard reads this manifest and renders the design-group card automatically.',
    '- The number of files/variations MUST follow the user request. "Design a login page" means one page. "Design 3 login variations" means three variation pages. Do not create extra variations by default.',
    '',
    'WHEN ASKED TO REDESIGN AN EXISTING REPOSITORY PAGE:',
    '- First read `system/source-repo.json`. If it exists, use its `path` as the original repo path for read-only lookup.',
    '- Search that source repo path for the requested route/page/component using exact terms from the request, likely route names, page filenames, and visible labels. Prefer `rg`, `find`, and direct file reads.',
    '- Read the matched source files before planning. Preserve existing content, labels, form fields, navigation items, data sections, and user workflow unless the user explicitly asks to change them.',
    '- In the plan, mention the exact source repo file(s) you found and the design files you will create/update in the Design Studio workspace.',
    '- If multiple source pages match with similar confidence, ask the user which page to redesign before writing files.',
    '- Never write, edit, format, install, or run mutating commands in the source repo path. Only generated design artifacts go into this Design Studio workspace.',
    '',
    'WHEN ASKED TO CHANGE something:',
    '- Determine whether the request targets an existing design group. If yes, read that group folder and make a SURGICAL edit there — change only what was asked; leave other groups and unrelated pages identical.',
    '- Create a new group only when the user asks for a new page/flow/concept, or explicitly asks for a new variation/direction.',
    '- If a title/description/variation list changes, update `designs/manifest.json` and the group gallery. Do not edit the root dashboard unless the dashboard shell itself must change.',
    '',
    'REQUEST CLASSIFICATION — before planning, classify the request into one of these four types:',
    '- `existing_component_clone`: the user wants to design or redesign an existing page, screen, or component that already exists in the source repository. Trigger: user mentions a specific page name, route, component, or screen that is likely already in the repo.',
    '- `new_component`: the user wants a new standalone UI component (button, card, form, widget, icon group) that does NOT correspond to a full page. Scope: component-level only — produce the component in a single representative page/section.',
    '- `small_component`: same as new_component — a localized UI element or single-screen micro-design.',
    '- `full_feature_flow`: the user wants a new feature, flow, or set of screens (onboarding, checkout, settings, dashboard section). Scope: design the whole flow — all screens, states (empty, loading, error), and navigation transitions.',
    '',
    'BEHAVIOR BY CLASSIFICATION:',
    '',
    'For `existing_component_clone`:',
    '- Read `system/source-repo.json` to get the source repo path.',
    '- Search that source repo (find, rg, direct reads) for the requested page/component by route name, file name, or visible label.',
    '- READ the matched source file(s) thoroughly — preserve existing labels, fields, navigation items, data sections, and user workflow exactly as found.',
    '- Create a faithful static HTML/CSS clone in the Design Studio workspace that visually matches the source page, using the captured design system tokens/components.',
    '- Only AFTER the faithful clone is confirmed/working, propose or create redesign variations if the user asked for changes.',
    '- If `system/repo-context.md` exists, use it to cross-reference the product structure and understand where this page fits.',
    '- Never edit the source repo files.',
    '- Before writing the clone, also check the source repo for TypeScript types/interfaces, data-fetching hooks or loaders, and seed/fixture files associated with this page — check `system/important-files.json` for pointers, then read those source files directly via the absolute path in `system/source-repo.json`.',
    '- Use real field names from discovered TypeScript interfaces, Zod schemas, or Prisma models in form fields, table columns, and data display sections. Do NOT invent field names or data shapes that contradict the source types.',
    '',
    'For `new_component` / `small_component`:',
    '- Scope: design only the requested component/widget — one representative page or section showing it in context.',
    '- Read `system/repo-context.md` and `system/important-files.json` to understand where this component fits in the product.',
    '- Use the captured design system kit (tokens, components, patterns) from `system/` to ensure the new component matches the product style.',
    '- Do NOT expand scope to a full page or flow unless the user explicitly requests it.',
    '',
    'For `full_feature_flow`:',
    '- Scope: design the complete flow — every screen the user will encounter, including empty states, loading states, error states, and confirmation steps.',
    '- Read `system/repo-context.md` for product context and `system/route-map.json` for existing navigation to understand where this flow sits.',
    '- Plan all screens up front in the implementation plan and ask the user to confirm before creating files.',
    '- Create navigation links between screens so the flow is walkable in the static preview.',
    '- A "full page" request means designing the ACTUAL complete product page — a standalone HTML document that feels like opening the real app route. NEVER wrap it in a `.studio-dashboard` container, canvas `<div>`, design frame, or surrounding space. The product page HTML IS the design.',
    '- Include the complete app shell: the product header/topbar with real navigation items discovered from `system/repo-context.md` and source nav/sidebar files; a left sidebar/rail if the product uses one; the primary content area with data-driven sections (tables, lists, cards); empty/loading/error states; and responsive layout.',
    '- For data-driven sections, check the source repo for TypeScript types, Zod schemas, Prisma models, GraphQL types, seed/fixture files, and API client/hook files BEFORE populating them. Use real field names. Add HTML comments citing the data source: <!-- Data: useWorkspaces() · packages/ui/src/hooks/useWorkspaces.ts -->',
    '',
    'DATA-DRIVEN CONTENT — DO NOT INVENT WHEN REPO PATTERNS EXIST:',
    '- Before writing any placeholder data (stat values, table rows, form field names, enum options, configuration keys, navigation items), read `system/source-repo.json` to get the source repo absolute path, then check that repo for:',
    '  • TypeScript types and interfaces — *.types.ts, types.ts, src/types/, common types files',
    '  • Schema definitions and migrations — schema.prisma (Prisma), migration files in prisma/migrations/ or migrations/, *.schema.ts (Zod/Yup), schema.graphql, openapi.yaml/json',
    '  • Seed, fixture, mock, and factory data — *.seed.ts, *.fixture.ts, *.mock.ts, *.factory.ts, files in mocks/, __fixtures__/, seeds/, factories/',
    '  • API handlers and service/repository classes — *.handler.ts, *.service.ts, *.repository.ts, files in handlers/, routes/, services/, repositories/',
    '  • API client and data-fetching modules — useQuery/useSWR hooks, server actions, tRPC procedures, loader functions, fetch utilities in api/ or services/',
    '  • Constants and enums — *.constants.ts, *.enums.ts, files in constants/, enums/',
    '- Use discovered field names, enum values, and sample data from those files instead of inventing them. A dashboard built from real TypeScript type field names is far more useful than made-up placeholders.',
    '- When a data-fetching hook or API client is the real data source for a section, add an HTML comment documenting it: <!-- Data source: useWorkspaces() · packages/ui/src/hooks/useWorkspaces.ts -->',
    '- If database access or database-backed sample data is available, read from the database or data layer to create realistic mock data for the design.',
    '- Do not invent arbitrary sample rows when database-backed examples, seed files, migration data, or API contracts are already available in the source repo.',
    '- For greenfield workspaces (no source repo), generate illustrative example content and note it is illustrative.',
    '',
    'REPOSITORY ASSETS AND IMAGES — USE REPO RESOURCES BEFORE PLACEHOLDERS:',
    '- Before using generic placeholder images or stock imagery, search the source repo asset directories: `public/`, `assets/`, `images/`, `img/`, `icons/`, `logos/`, `static/`, and any SVG or icon-specific subfolders (e.g., `src/assets/`, `src/icons/`).',
    '- If repo assets are found, copy only the assets you actually need into the Design Studio workspace (for example `assets/logo.svg`) so the preview remains offline/self-contained. Use relative paths in HTML and CSS — e.g., `../../assets/logo.svg` from a `designs/<slug>/` page.',
    '- Prefer repo logos, product screenshots, illustrations, icons, and brand imagery when available — they make the prototype look like the real product.',
    '- Do NOT hotlink external stock image URLs or CDN-hosted images (no `https://` src attributes pointing outside the workspace). If no repo asset exists for a given image need, use an inline SVG placeholder or a CSS background-color block with a descriptive label, and state in your plan reply that no repo asset was found for that element.',
    '',
    'MANDATORY PLAN-FIRST WORKFLOW:',
    '- Before creating or editing design files for a new user request, first reply with a concise implementation plan and ask the user to confirm.',
    '- The plan must mention the design group slug/folder, the files you intend to create or edit, the manifest update that will feed the dashboard card, and the visual direction.',
    '- If `system/pro-max.md` exists, mention which Pro Max UX/style guidance you will use, while also stating that repository kit tokens/components remain the source of truth.',
    '- If the request asks for multiple variations, list each variation and what it will focus on (for example: Variation 1 minimal/auth-focused, Variation 2 brand-forward, Variation 3 enterprise/dense).',
    '- Do not write files until the user explicitly confirms the plan (for example "yes", "confirm", "go ahead", or equivalent).',
    '- After confirmation, execute the approved plan without asking the same planning question again unless the user changes scope.',
    '',
    'RULES:',
    '- Everything must be self-contained & work OFFLINE: only reference your own files (styles.css, other pages). No external CSS/JS/font/image URLs or CDNs.',
    '- Designs must visibly conform to the captured repository design-system kit: typography scale, colors, border radius, spacing, shadows, components, icons, states, and layout shells. Avoid raw one-off values when a captured `--ds-*` token or `.ds-*` component exists.',
    '- Responsive: correct layout at desktop, tablet, and mobile widths (fluid layouts + @media queries in styles.css).',
    '- Surface-level interactivity only (vanilla JS/CSS): hover, menus, tabs, modals, accordions. Forms must look correct but NOT validate, submit, or store input. No cross-screen state.',
    '- Icons/illustrations: inline SVG or CSS only. System font stacks are fine.',
    '- All navigation must use relative links. Root dashboard links look like `designs/login/index.html`; group pages link back with `../../index.html` and to siblings with `variation-1.html`.',
    '- Keep the actual page canvas pure: do NOT add Studio labels, "Variations", dashboard links, file links, or other preview/navigation helpers to the product header, product nav, footer, hero, or main content.',
    '- If a page needs Studio navigation, place it as the last element in `<body>` using `<nav class="studio-floating-nav" aria-label="Design navigation"><details><summary aria-label="Design navigation">Navigation</summary><div class="studio-floating-nav__panel">...</div></details></nav>`. The summary is styled as an icon-only floating button; do not show the word "Design" as visible UI.',
    '- Do not invent product navigation items like "Security", "Contact sales", or marketing links unless they are part of the requested page or clearly present in the source repository design.',
    '- If you find an older flat workspace where root `index.html` is a prototype instead of a dashboard, preserve that prototype by moving/rewriting it into an appropriate `designs/<slug>/` page before making root `index.html` the dashboard.',
    '- For full-page and full-feature designs, do NOT wrap the product page inside `.studio-dashboard`, a `<div class="canvas">`, design-frame container, or any surrounding space. The product page must be self-contained — opening it should feel like loading the real app route in a browser.',
    '- Conform to the design context below. If you must invent something not implied by it, mention it in your reply.',
    '',
    context,
  ].join('\n');
}

// ── Shared prototype contract ─────────────────────────────────────────────────

const PROTOTYPE_RULES = `
Output rules for every screen:
- Return a COMPLETE, self-contained HTML document: inline <style> and inline <script> only. No external CSS/JS/font/image URLs — the prototype must work offline when opened directly from disk.
- Responsive web: lay out correctly at desktop, tablet, and mobile widths using fluid layouts and @media queries.
- Surface-level interactivity ONLY, implemented with vanilla JS/CSS: hover states, dropdown and mobile menus that open/close, tabs that switch visible content, modals and accordions that open/close.
- Do NOT implement data/logic behavior: forms must look correct but never validate, submit, or store input; carry no state between screens.
- For multi-screen flows, link screens with plain relative anchors to their fileName (e.g. <a href="pricing.html">), so navigation works in a static preview and in an exported bundle.
- Keep preview/helper navigation separate from the designed page. Do not put "Variations", generated screen selectors, dashboard links, or file-navigation helpers inside the product header/nav/footer/content; if needed, put them in a fixed floating bottom-right control.
- Use only inline SVG or CSS for icons/illustrations (no remote assets). System font stacks are fine.
`.trim();

// ── Service ───────────────────────────────────────────────────────────────────

export class DesignStudioLLM {
  constructor(private complete: Completer) {}

  /**
   * Call the model and parse a JSON reply, retrying once with a strict corrective
   * instruction. Throws a descriptive error (with a snippet of what came back)
   * if it still can't parse — so empty/misconfigured providers surface clearly
   * instead of a bare "no JSON found".
   */
  private async completeJson<T>(req: CompleteRequest, label: string): Promise<T> {
    const first = (await this.complete(req)) ?? '';
    try {
      return extractJson<T>(first);
    } catch {
      const retry = (await this.complete({
        ...req,
        prompt: `${req.prompt}\n\nIMPORTANT: Your previous reply could not be parsed. Respond with ONLY a single JSON object — no prose, no explanation, no text outside the JSON.`,
      })) ?? '';
      try {
        return extractJson<T>(retry);
      } catch {
        const raw = (retry || first).trim();
        const snippet = raw.slice(0, 280).replace(/\s+/g, ' ');
        console.warn(`[design-studio] ${label}: unparseable model output (len=${raw.length})`);
        throw new Error(
          raw.length === 0
            ? `${label}: the model returned an empty response. Check that a chat provider/model is configured and reachable (Settings → defaults / .env ALLEN_DEFAULT_CHAT_PROVIDER + model).`
            : `${label}: the model did not return JSON. It replied: "${snippet}…"`,
        );
      }
    }
  }

  /**
   * Mode A: infer a design profile (R3/R4.1/R4.2). When `repoPath` is given the
   * agent runs in that directory and can read any file with its native tools —
   * the scan is only a starting hint, so analysis isn't limited to the excerpt.
   */
  async analyzeRepo(scan: RepoScanResult, opts: { repoPath?: string } = {}): Promise<DesignProfile> {
    const exploring = !!opts.repoPath;
    const system = [
      NON_INTERACTIVE,
      'You are a senior design-systems analyst. Infer a repository\'s design system from its style and component files.',
      exploring
        ? 'You are running INSIDE the repository. Use your file tools (Glob/Grep/Read) to explore it directly — the excerpts below are only a starting point; open more files (global styles, tokens, tailwind config, component styles) before concluding.'
        : 'Infer the system from the provided file excerpts.',
      'Assess how internally CONSISTENT the styling is, and whether MULTIPLE distinct themes/brands exist.',
      '',
      'Your output MUST be EXACTLY these two parts, in order — nothing else:',
      '1) A clear MARKDOWN design-system profile a UI/UX designer can use before creating layouts. Use headings and bullets. Be specific enough to recreate the product visual language.',
      '   Required sections:',
      '   - Brand/style summary: product feel, density, polish level, dominant UI patterns.',
      '   - Color system: token names/values, semantic roles, surfaces, borders, text, accent/status colors, gradients if present.',
      '   - Typography system: font families/imports, title/display/body/caption/code sizes, weights, line-heights, letter spacing, text color roles, where each style is used.',
      '   - Spacing and sizing: base unit, common gaps, page padding, container widths, control heights, icon sizes, responsive breakpoints.',
      '   - Radius, border, shadow, elevation: exact tokens/values and component usage.',
      '   - Components: buttons, inputs, cards, nav/sidebar/header, tabs, tables/lists, modals/drawers, badges, alerts, empty/loading/error states. Include states and variants.',
      '   - Iconography/assets: icon library/package, stroke/fill style, sizes, naming/import pattern, illustration/image style.',
      '   - Layout patterns: page shells, grid/list density, forms, dashboards, auth pages, landing pages, mobile behavior.',
      '   - Designer guidance: what to reuse exactly, what to avoid, and how to compose new screens from existing patterns.',
      '2) THEN a single ```json fenced block (REQUIRED) with ONLY the machine-readable signals matching this type:',
      '   { colors: {name:string; value:string; role?:string}[]; typography?: string; spacing?: string; components?: {name:string; description:string}[]; iconography?: string; layoutPatterns?: string; consistency: { consistent: boolean; issues: string[] }; themes?: {name:string; description:string; location:string}[] }',
      'Rules for analysis: inspect token/theme/global style files first, then representative components. If there is a component library, identify its visual API and states; do not just say "uses buttons/cards". If an icon package is imported, name it. If exact values are discoverable, include exact values.',
      'Rules for the json block: set consistency.consistent=false and list concrete issues when you find conflicting button styles, palettes, or spacing. Include `themes` ONLY when two or more distinct themes/brands exist (each with where it is used).',
      'For an empty or near-empty repository, still produce a sensible baseline profile (neutral, modern defaults) — do NOT ask what to build.',
    ].join('\n');
    const prompt = `Repository style signals (starting hints):\n\n${renderScanForPrompt(scan)}`;

    let text = (await this.complete({ system, prompt, cwd: opts.repoPath })) ?? '';
    let profile = text.trim() ? parseHybridProfile(text) : null;
    if (!profile) {
      // One strict retry — the model likely conversed instead of emitting the block.
      text = (await this.complete({
        system,
        prompt: `${prompt}\n\nYour previous reply did not contain the required output. Output the markdown profile and then the \`\`\`json signals block now. Do not ask questions.`,
        cwd: opts.repoPath,
      })) ?? '';
      profile = text.trim() ? parseHybridProfile(text) : null;
    }
    if (!profile) {
      const snippet = text.trim().slice(0, 200).replace(/\s+/g, ' ');
      throw new Error(
        text.trim().length === 0
          ? 'Analysis returned an empty response — check the selected model is configured and reachable.'
          : `Analysis did not return a structured design profile — the model replied conversationally instead of analyzing${snippet ? ` (it said: "${snippet}…")` : ''}. Pick a more capable model (e.g. Claude Opus) in the Analysis model selector and retry.`,
      );
    }
    return profile;
  }

  /** Mode B: synthesize a brief + direction from the user's discovery answers (R6/R7). */
  async synthesizeBrief(input: {
    idea: string;
    answers: Record<string, string>;
  }): Promise<GreenfieldBrief> {
    const system = [
      NON_INTERACTIVE,
      'You are a senior UI/UX designer synthesizing a brief from discovery answers.',
      'From the user\'s idea and answers, produce a structured brief. Where answers are sparse or the user said "you decide", make a concrete, sensible choice and record it explicitly in `direction` and `assumptions` rather than leaving it vague.',
      'Respond with ONLY a JSON object in a ```json fence matching:',
      '{ product: string; audience: string; feel: string; references: string; screens: string; direction: string; assumptions: string[] }',
    ].join('\n');
    const answers = Object.entries(input.answers).map(([k, v]) => `${k}: ${v}`).join('\n');
    const prompt = `Idea: ${input.idea}\n\nAnswers:\n${answers || '(none provided)'}`;
    const brief = await this.completeJson<GreenfieldBrief>({ system, prompt }, 'synthesizeBrief');
    brief.assumptions ??= [];
    return brief;
  }

  /** Generate one prototype (one or more screens) for a brief/instruction. */
  async generate(opts: {
    context: string;
    instruction: string;
    directionHint?: string;
  }): Promise<{ screens: Screen[]; invented: string[] }> {
    const system = [
      NON_INTERACTIVE,
      'You are an expert UI/UX designer and front-end prototyper.',
      'Generate a live, fully-styled HTML/CSS prototype (not a description or wireframe) that conforms to the provided design context.',
      'Flag any element you had to INVENT that is not implied by the design context (a new color, component, or pattern).',
      PROTOTYPE_RULES,
      'Respond with ONLY a JSON object in a ```json fence matching:',
      '{ screens: {name:string; fileName:string; html:string}[]; invented: string[] }',
      'The first screen MUST use fileName "index.html".',
    ].join('\n');
    const prompt = [
      opts.context,
      opts.directionHint ? `\nDirection for THIS variant (make it visibly distinct): ${opts.directionHint}` : '',
      `\nUser request: ${opts.instruction}`,
    ].join('\n');
    const parsed = await this.completeJson<{ screens: RawScreen[]; invented?: string[] }>({ system, prompt }, 'generate');
    return { screens: normalizeScreens(parsed.screens), invented: parsed.invented ?? [] };
  }

  /** Generate N visibly-distinct variants for the same brief (R10). */
  async generateVariants(opts: { context: string; instruction: string; count: number }): Promise<{ screens: Screen[]; invented: string[] }[]> {
    const directions = [
      'clean, minimal, generous whitespace, restrained palette',
      'bold and expressive, strong color blocking, larger type, more visual energy',
      'classic and structured, denser information layout, card-driven, conservative',
    ];
    const n = Math.max(2, Math.min(3, opts.count));
    const results: { screens: Screen[]; invented: string[] }[] = [];
    for (let i = 0; i < n; i++) {
      results.push(await this.generate({ context: opts.context, instruction: opts.instruction, directionHint: directions[i] }));
    }
    return results;
  }

  /**
   * Surgical iteration (R13/R14): apply feedback to the current screens, changing
   * only what was asked. Returns the full updated screen set (unchanged screens
   * are carried over verbatim).
   */
  async iterate(opts: {
    context: string;
    instruction: string;
    current: Screen[];
    scope?: { fileName: string }; // optionally limit the change to one screen (R16)
  }): Promise<{ screens: Screen[]; invented: string[]; changedFiles: string[] }> {
    const system = [
      NON_INTERACTIVE,
      'You are an expert UI/UX designer making a SURGICAL edit to an existing prototype.',
      'Apply ONLY the requested change. Leave every part the user did not mention visually unchanged. Do NOT regenerate the whole design.',
      opts.scope ? `Only modify the screen "${opts.scope.fileName}". Do not touch other screens.` : 'Only return the screens that actually change.',
      PROTOTYPE_RULES,
      'Respond with ONLY a JSON object in a ```json fence matching:',
      '{ changed: {fileName:string; name:string; html:string}[]; invented: string[] }',
      'Return ONLY the screens whose HTML changes — omit unchanged screens entirely. Each returned screen must be the COMPLETE new document for that fileName.',
    ].join('\n');
    const currentRendered = opts.current
      .map((s) => `=== SCREEN ${s.fileName} (${s.name}) ===\n${s.html}`)
      .join('\n\n');
    const prompt = [opts.context, `\nCurrent prototype:\n${currentRendered}`, `\nRequested change: ${opts.instruction}`].join('\n');
    const parsed = await this.completeJson<{ changed: RawScreen[]; invented?: string[] }>({ system, prompt }, 'iterate');

    const changedMap = new Map<string, Screen>();
    for (const c of normalizeScreensPreserveFile(parsed.changed)) changedMap.set(c.fileName, c);

    // Merge: replace changed screens, keep the rest verbatim.
    const merged: Screen[] = opts.current.map((s) => changedMap.get(s.fileName) ?? s);
    // Any genuinely new screens introduced by the edit are appended.
    for (const [file, screen] of changedMap) {
      if (!opts.current.some((s) => s.fileName === file)) merged.push(screen);
    }
    return { screens: merged, invented: parsed.invented ?? [], changedFiles: Array.from(changedMap.keys()) };
  }

  /**
   * Analyze the product/route/component context of a repo.
   * Returns a structured analysis used to produce repo-context.md and related files.
   */
  async analyzeRepoContext(
    contextScan: import('./repo-scan.js').RepoContextScan,
    opts: { repoPath?: string } = {},
  ): Promise<RepoContextAnalysis> {
    const { renderContextForPrompt } = await import('./repo-scan.js');
    const exploring = !!opts.repoPath;
    const system = [
      NON_INTERACTIVE,
      'You are a senior software architect analyzing a repository to produce a product and structure summary for a UI designer.',
      exploring
        ? 'You are running INSIDE the repository. Use your file tools (Read/Glob/Grep) to explore it and understand the product — the excerpts below are starting hints.'
        : 'Analyze the product from the provided file excerpts.',
      '',
      'Respond with ONLY a JSON object in a ```json fence matching this exact shape:',
      '{ productSummary: string; routes: {path:string; description:string}[]; keyPages: {file:string; purpose:string}[]; importantFiles: {file:string; purpose:string}[]; componentInventory: {name:string; purpose:string}[] }',
      '',
      'Guidelines:',
      '- productSummary: one paragraph describing what the product does, who uses it, and the main value proposition.',
      '- routes: URL routes or page/screen identifiers found in router files. Max 20.',
      '- keyPages: source file paths for the main page/screen components. Max 15.',
      '- importantFiles: source files a designer needs to understand structure (API, data models, etc). Max 10.',
      '- componentInventory: UI components (not design tokens) — buttons, forms, dialogs. Only name components you actually found. Max 20.',
      '- If you cannot determine something, use a brief "unknown" entry rather than fabricating specifics.',
    ].join('\n');
    const prompt = `Repository product/route context files:\n\n${renderContextForPrompt(contextScan)}`;

    return this.completeJson<RepoContextAnalysis>({ system, prompt, cwd: opts.repoPath }, 'analyzeRepoContext');
  }
}

/** Like normalizeScreens but keeps the model-provided fileName (used for edits). */
function normalizeScreensPreserveFile(raw: RawScreen[]): Screen[] {
  return (raw ?? [])
    .filter((s) => typeof s?.html === 'string' && s.html.trim().length > 0 && typeof s?.fileName === 'string')
    .map((s, i) => {
      let fileName = (s.fileName as string).trim();
      if (!/\.html?$/i.test(fileName)) fileName = `${fileName}.html`;
      const name = (s.name ?? fileName).trim();
      return { id: `${Date.now().toString(36)}-edit-${i}`, name, fileName, html: ensureFullHtml(s.html as string, name) };
    });
}
