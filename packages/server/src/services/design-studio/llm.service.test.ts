/**
 * DesignStudioLLM — prompt orchestration + output parsing, with a fake completer.
 *
 * Validates the LLM-shaped requirements at the orchestration level (no live model):
 *  - R3/R4.1/R4.2: analyzeRepo parses profile, consistency, themes
 *  - R8/R9: generate produces self-contained screens; first is index.html
 *  - R10: generateVariants produces N visibly-distinct directions
 *  - R14/R16: iterate is surgical — unmentioned screens carried over verbatim
 */
import { describe, expect, it, vi } from 'vitest';
import { DesignStudioLLM, extractJson, buildDesignerPersona, renderDesignContext, type Completer } from './llm.service.js';
import type { Screen } from './types.js';

function completerReturning(text: string): Completer {
  return vi.fn(async () => text);
}

describe('buildDesignerPersona', () => {
  it('embeds the context and instructs a shared, reused, file-based design system', () => {
    const context = renderDesignContext({ brief: { product: 'Acme', audience: 'devs', feel: 'clean', references: 'Linear', screens: 'login' } });
    const persona = buildDesignerPersona(context, { sourceRepoName: 'Acme Repo' });
    expect(persona).toContain('styles.css');     // shared stylesheet
    expect(persona).toContain('index.html');      // entry point
    expect(persona).toContain('system/manifest.json');
    expect(persona).toContain('system/tokens.css');
    expect(persona).toContain('system/components.css');
    expect(persona).toContain('system/components.html');
    expect(persona).toContain('system/source-repo.json');
    expect(persona).toContain('--ds-*');
    expect(persona).toContain('.ds-*');
    expect(persona).toContain('.ds-btn');
    expect(persona).toContain('.ds-input');
    expect(persona).toContain('designs/manifest.json');
    expect(persona).toContain('designs/<design-slug>/');
    expect(persona).toMatch(/ROOT DASHBOARD/);
    expect(persona).toMatch(/Do not create extra variations by default/i);
    expect(persona).toContain('repository "Acme Repo"');
    expect(persona).toContain('MANDATORY PLAN-FIRST WORKFLOW');
    expect(persona).toMatch(/ask the user to confirm/i);
    expect(persona).toMatch(/list each variation and what it will focus on/i);
    expect(persona).toContain('.studio-floating-nav');
    expect(persona).toContain('aria-label="Design navigation"');
    expect(persona).toMatch(/icon-only floating button/i);
    expect(persona).toMatch(/Keep the actual page canvas pure/i);
    expect(persona).toMatch(/Do not invent product navigation items/i);
    expect(persona).toMatch(/captured font families, typography scale, colors, radii, spacing, shadows, components, icon library/i);
    expect(persona).toMatch(/REDESIGN AN EXISTING REPOSITORY PAGE/i);
    expect(persona).toMatch(/exact source repo file\(s\) you found/i);
    expect(persona).toMatch(/Never write, edit, format, install, or run mutating commands in the source repo path/i);
    expect(persona).toMatch(/reuse/i);            // reuse existing components
    expect(persona).toMatch(/persistent design-system folder/i);
    expect(persona).toContain('Acme');            // workspace context included
    expect(persona).toMatch(/surgical/i);         // iteration discipline
  });
});

describe('extractJson', () => {
  it('parses JSON inside a ```json fence', () => {
    expect(extractJson<{ a: number }>('blah\n```json\n{"a":1}\n```\nend').a).toBe(1);
  });
  it('parses a bare JSON object with nested braces and strings', () => {
    const out = extractJson<{ s: string; n: object }>('{"s":"a } b","n":{"x":1}}');
    expect(out.s).toBe('a } b');
  });
});

describe('analyzeRepo (hybrid: markdown + signals)', () => {
  it('R3/R4.1: keeps markdown as the profile and parses consistency signals from the json fence', async () => {
    const reply = [
      '# Design profile',
      'A modern SaaS look with a blue accent.',
      '',
      '```json',
      JSON.stringify({
        colors: [{ name: 'Primary', value: '#3b82f6', role: 'primary' }],
        typography: 'Inter; h1 48/1.05 760, body 14/1.5 400.',
        spacing: '4px base grid, 8px radius, 40px control heights.',
        components: [{ name: 'Button', description: 'Rounded primary and ghost variants with 40px height.' }],
        iconography: 'lucide-react outline icons, 16px and 20px.',
        layoutPatterns: 'Centered auth cards and dense dashboard tables.',
        consistency: { consistent: false, issues: ['3 button styles', '2 palettes'] },
      }),
      '```',
    ].join('\n');
    const p = await new DesignStudioLLM(completerReturning(reply)).analyzeRepo({ files: [], fingerprint: 'x', empty: false });
    expect(p.summaryMarkdown).toContain('modern SaaS look');
    expect(p.summaryMarkdown).not.toContain('```'); // fence stripped from the prose
    expect(p.consistency.consistent).toBe(false);
    expect(p.consistency.issues).toHaveLength(2);
    expect(p.colors[0].value).toBe('#3b82f6');
    expect(p.typography).toContain('Inter');
    expect(p.spacing).toContain('4px');
    expect(p.components?.[0].name).toBe('Button');
    expect(p.iconography).toContain('lucide-react');
    expect(p.layoutPatterns).toContain('auth cards');
  });

  it('R4.2: keeps a themes array only when 2+ themes present', async () => {
    const withThemes = (themes: unknown[]) => [
      'Profile prose.', '```json', JSON.stringify({ colors: [], consistency: { consistent: true, issues: [] }, themes }), '```',
    ].join('\n');
    const multi = await new DesignStudioLLM(completerReturning(withThemes([
      { name: 'Admin', description: 'dense gray', location: 'apps/admin' },
      { name: 'Marketing', description: 'airy blue', location: 'apps/site' },
    ]))).analyzeRepo({ files: [], fingerprint: 'x', empty: false });
    expect(multi.themes).toHaveLength(2);

    const single = await new DesignStudioLLM(completerReturning(withThemes([
      { name: 'Only', description: 'd', location: 'src' },
    ]))).analyzeRepo({ files: [], fingerprint: 'x', empty: false });
    expect(single.themes).toBeUndefined();
  });
});

describe('analyzeRepo strictness (rejects conversational replies)', () => {
  it('throws (after retry) when the model converses instead of emitting the signals block', async () => {
    const complete = vi.fn(async () => "I'm in the repo and it's clean. What would you like changed or built?");
    const llm = new DesignStudioLLM(complete);
    await expect(llm.analyzeRepo({ files: [], fingerprint: 'x', empty: false }))
      .rejects.toThrow(/conversationally|more capable model/i);
    expect(complete).toHaveBeenCalledTimes(2); // one strict retry before giving up
  });

  it('throws on an empty response', async () => {
    const llm = new DesignStudioLLM(vi.fn(async () => ''));
    await expect(llm.analyzeRepo({ files: [], fingerprint: 'x', empty: false }))
      .rejects.toThrow(/empty response/i);
  });

  it('recovers when the strict retry returns a proper profile', async () => {
    const good = ['# Profile', 'Clean modern look.', '```json', JSON.stringify({ colors: [], consistency: { consistent: true, issues: [] } }), '```'].join('\n');
    const complete = vi.fn()
      .mockResolvedValueOnce('Sure, what would you like to build?')
      .mockResolvedValueOnce(good);
    const p = await new DesignStudioLLM(complete).analyzeRepo({ files: [], fingerprint: 'x', empty: false });
    expect(p.summaryMarkdown).toContain('Clean modern look');
  });
});

describe('resilient JSON parsing (strict steps: generate/iterate)', () => {
  const validGen = JSON.stringify({ screens: [{ name: 'S', fileName: 'index.html', html: '<main>x</main>' }], invented: [] });

  it('generate retries once when the first reply has no JSON, then succeeds', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce('Here is a description with no JSON at all.')
      .mockResolvedValueOnce(validGen);
    const out = await new DesignStudioLLM(complete).generate({ context: 'ctx', instruction: 'landing' });
    expect(out.screens[0].fileName).toBe('index.html');
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('generate throws a descriptive error on an empty response', async () => {
    await expect(new DesignStudioLLM(vi.fn(async () => '')).generate({ context: 'c', instruction: 'x' }))
      .rejects.toThrow(/empty response/i);
  });
});

describe('generate', () => {
  it('R8/R9: wraps fragments into full documents and forces index.html first', async () => {
    const llm = new DesignStudioLLM(completerReturning(JSON.stringify({
      screens: [
        { name: 'Landing', fileName: 'landing', html: '<section>hi</section>' },
        { name: 'Pricing', fileName: 'pricing.html', html: '<!DOCTYPE html><html><body>p</body></html>' },
      ],
      invented: ['accent color'],
    })));
    const out = await llm.generate({ context: 'ctx', instruction: 'make a landing page' });
    expect(out.screens[0].fileName).toBe('index.html');
    expect(out.screens[0].html.toLowerCase()).toContain('<!doctype html>');
    expect(out.invented).toContain('accent color');
  });
});

describe('generateVariants', () => {
  it('R10: produces the requested number of variants via distinct direction hints', async () => {
    const completer = vi.fn(async () => JSON.stringify({ screens: [{ name: 'S', fileName: 'index.html', html: '<main>v</main>' }], invented: [] }));
    const llm = new DesignStudioLLM(completer);
    const variants = await llm.generateVariants({ context: 'ctx', instruction: 'landing', count: 3 });
    expect(variants).toHaveLength(3);
    // Each call carried a different direction hint → meaningfully distinct briefs.
    const prompts = completer.mock.calls.map((c) => (c[0] as { prompt: string }).prompt);
    expect(new Set(prompts).size).toBe(3);
  });
});

describe('iterate (surgical)', () => {
  const current: Screen[] = [
    { id: '1', name: 'Home', fileName: 'index.html', html: '<!DOCTYPE html><html><body>HOME-ORIGINAL</body></html>' },
    { id: '2', name: 'Pricing', fileName: 'pricing.html', html: '<!DOCTYPE html><html><body>PRICING-ORIGINAL</body></html>' },
  ];

  it('R14: only the changed screen is replaced; others kept verbatim', async () => {
    const llm = new DesignStudioLLM(completerReturning(JSON.stringify({
      changed: [{ fileName: 'index.html', name: 'Home', html: '<!DOCTYPE html><html><body>HOME-UPDATED</body></html>' }],
      invented: [],
    })));
    const r = await llm.iterate({ context: 'ctx', instruction: 'change the header', current });
    expect(r.changedFiles).toEqual(['index.html']);
    const home = r.screens.find((s) => s.fileName === 'index.html')!;
    const pricing = r.screens.find((s) => s.fileName === 'pricing.html')!;
    expect(home.html).toContain('HOME-UPDATED');
    expect(pricing.html).toContain('PRICING-ORIGINAL'); // untouched
  });

  it('R16: a brand-new screen introduced by an edit is appended', async () => {
    const llm = new DesignStudioLLM(completerReturning(JSON.stringify({
      changed: [{ fileName: 'about.html', name: 'About', html: '<!DOCTYPE html><html><body>ABOUT</body></html>' }],
      invented: [],
    })));
    const r = await llm.iterate({ context: 'ctx', instruction: 'add an about page', current });
    expect(r.screens).toHaveLength(3);
    expect(r.screens.some((s) => s.fileName === 'about.html')).toBe(true);
  });
});

describe('analyzeRepoContext', () => {
  const validAnalysis = {
    productSummary: 'MyApp is a task management SaaS for teams.',
    routes: [
      { path: '/', description: 'Dashboard page' },
      { path: '/login', description: 'Authentication' },
    ],
    keyPages: [
      { file: 'src/pages/DashboardPage.tsx', purpose: 'Main dashboard' },
    ],
    importantFiles: [
      { file: 'openapi.yaml', purpose: 'API definitions' },
    ],
    componentInventory: [
      { name: 'Button', purpose: 'Primary action trigger' },
    ],
  };

  it('parses a valid RepoContextAnalysis JSON response', async () => {
    const reply = `\`\`\`json\n${JSON.stringify(validAnalysis)}\n\`\`\``;
    const llm = new DesignStudioLLM(completerReturning(reply));
    const scan = { files: [], fingerprint: 'x', empty: true };
    const analysis = await llm.analyzeRepoContext(scan);
    expect(analysis.productSummary).toBe('MyApp is a task management SaaS for teams.');
    expect(analysis.routes).toHaveLength(2);
    expect(analysis.routes[0].path).toBe('/');
    expect(analysis.keyPages[0].file).toBe('src/pages/DashboardPage.tsx');
    expect(analysis.importantFiles[0].purpose).toBe('API definitions');
    expect(analysis.componentInventory[0].name).toBe('Button');
  });

  it('retries once when the model gives no JSON, then succeeds', async () => {
    const reply = `\`\`\`json\n${JSON.stringify(validAnalysis)}\n\`\`\``;
    const complete = vi.fn()
      .mockResolvedValueOnce('I see this is a task management product. What would you like to know?')
      .mockResolvedValueOnce(reply);
    const llm = new DesignStudioLLM(complete);
    const scan = { files: [], fingerprint: 'x', empty: true };
    const analysis = await llm.analyzeRepoContext(scan);
    expect(analysis.productSummary).toContain('MyApp');
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('throws after two failed attempts', async () => {
    const llm = new DesignStudioLLM(vi.fn(async () => 'No JSON here at all, sorry.'));
    const scan = { files: [], fingerprint: 'x', empty: true };
    await expect(llm.analyzeRepoContext(scan)).rejects.toThrow(/analyzeRepoContext/i);
  });
});

describe('buildDesignerPersona — new repo context & classification instructions', () => {
  it('includes system/repo-context.md, route-map.json, and important-files.json in the required read list', () => {
    const context = renderDesignContext({ brief: { product: 'Acme', audience: 'devs', feel: 'clean', references: 'Linear', screens: 'login' } });
    const persona = buildDesignerPersona(context, { sourceRepoName: 'Acme Repo' });
    expect(persona).toContain('system/repo-context.md');
    expect(persona).toContain('system/repo-context.json');
    expect(persona).toContain('system/route-map.json');
    expect(persona).toContain('system/important-files.json');
  });

  it('includes REQUEST CLASSIFICATION with the four request types', () => {
    const context = renderDesignContext({ brief: { product: 'Acme', audience: 'devs', feel: 'clean', references: 'Linear', screens: 'login' } });
    const persona = buildDesignerPersona(context);
    expect(persona).toContain('REQUEST CLASSIFICATION');
    expect(persona).toContain('existing_component_clone');
    expect(persona).toContain('new_component');
    expect(persona).toContain('small_component');
    expect(persona).toContain('full_feature_flow');
  });

  it('specifies faithful clone behavior for existing_component_clone', () => {
    const context = renderDesignContext({ brief: { product: 'Acme', audience: 'devs', feel: 'clean', references: 'Linear', screens: 'login' } });
    const persona = buildDesignerPersona(context);
    expect(persona).toMatch(/faithful static HTML\/CSS clone/i);
    expect(persona).toMatch(/Never edit the source repo files/i);
  });

  it('specifies full flow design for full_feature_flow', () => {
    const context = renderDesignContext({ brief: { product: 'Acme', audience: 'devs', feel: 'clean', references: 'Linear', screens: 'login' } });
    const persona = buildDesignerPersona(context);
    expect(persona).toMatch(/every screen the user will encounter/i);
    expect(persona).toMatch(/empty states.*loading states.*error states/i);
  });
});

describe('buildDesignerPersona — data-driven content and full-page design behavior', () => {
  const ctx = renderDesignContext({ brief: { product: 'Acme', audience: 'devs', feel: 'clean', references: 'Linear', screens: 'dashboard' } });
  const persona = buildDesignerPersona(ctx, { sourceRepoName: 'Acme Repo' });

  it('includes DATA-DRIVEN CONTENT section prohibiting data invention when repo patterns exist', () => {
    expect(persona).toMatch(/DO NOT INVENT WHEN REPO PATTERNS EXIST/i);
    expect(persona).toMatch(/TypeScript types and interfaces/i);
    expect(persona).toMatch(/seed.*fixture.*mock|fixture.*seed.*mock/i);
  });

  it('instructs to look for data-fetching hooks and API clients in the source repo', () => {
    expect(persona).toMatch(/useQuery|useSWR|server action|tRPC|loader function/i);
    expect(persona).toMatch(/API client and data.fetching/i);
  });

  it('instructs to add HTML comments citing the data source file', () => {
    expect(persona).toMatch(/HTML comment.*data source|Data source.*HTML comment|<!-- Data source/i);
  });

  it('for full_feature_flow, prohibits wrapping product page in studio-dashboard or canvas container', () => {
    expect(persona).toMatch(/NEVER wrap.*studio-dashboard|do NOT wrap.*studio-dashboard/i);
  });

  it('for full_feature_flow, requires the complete app shell for full-page requests', () => {
    expect(persona).toMatch(/complete app shell/i);
  });

  it('for full_feature_flow, specifies the page must feel like the real app route', () => {
    expect(persona).toMatch(/feel like.*real app route/i);
  });

  it('adds data contract reading guidance to existing_component_clone behavior', () => {
    expect(persona).toMatch(/TypeScript types.*interfaces.*data.fetching hooks.*loaders/i);
  });

  it('adds rule prohibiting canvas/dashboard wrapper in RULES section', () => {
    expect(persona).toMatch(/do NOT wrap.*product page.*studio-dashboard|do NOT wrap.*studio-dashboard/i);
  });
});

describe('buildDesignerPersona — database/data-layer instructions', () => {
  const ctx = renderDesignContext({ brief: { product: 'Acme', audience: 'devs', feel: 'clean', references: 'Linear', screens: 'dashboard' } });
  const persona = buildDesignerPersona(ctx, { sourceRepoName: 'Acme Repo' });

  it('includes migrations in the schema/data bullet', () => {
    expect(persona).toMatch(/migrations/i);
    expect(persona).toMatch(/prisma\/migrations|migrations\//i);
  });

  it('includes factory files in the seed/fixture bullet', () => {
    expect(persona).toMatch(/factory/i);
    expect(persona).toMatch(/\.factory\.ts|factories\//i);
  });

  it('includes service and repository class files as data sources', () => {
    expect(persona).toMatch(/\.service\.ts|\.repository\.ts/i);
    expect(persona).toMatch(/services\/|repositories\//i);
  });

  it('includes API handlers as data sources', () => {
    expect(persona).toMatch(/\.handler\.ts|handlers\//i);
  });

  it('instructs to read from the database or data layer to create realistic mock data', () => {
    expect(persona).toMatch(/read from the database or data layer/i);
    expect(persona).toMatch(/realistic mock data/i);
  });

  it('prohibits inventing arbitrary sample rows when DB-backed data exists', () => {
    expect(persona).toMatch(/Do not invent arbitrary sample rows/i);
    expect(persona).toMatch(/seed files.*migration data.*API contracts|database-backed examples/i);
  });
});

describe('buildDesignerPersona — repository assets/images instructions', () => {
  const ctx = renderDesignContext({ brief: { product: 'Acme', audience: 'devs', feel: 'clean', references: 'Linear', screens: 'dashboard' } });
  const persona = buildDesignerPersona(ctx, { sourceRepoName: 'Acme Repo' });

  it('includes the REPOSITORY ASSETS AND IMAGES section heading', () => {
    expect(persona).toMatch(/REPOSITORY ASSETS AND IMAGES/i);
  });

  it('instructs to search standard asset directories before using placeholders', () => {
    expect(persona).toMatch(/public\/.*assets\/|assets\/.*images\/|icons\/.*logos\//i);
  });

  it('requires relative paths and offline-safe asset copies in the workspace', () => {
    expect(persona).toMatch(/relative paths/i);
    expect(persona).toMatch(/offline/i);
  });

  it('encourages using repo logos, brand imagery, and product screenshots', () => {
    expect(persona).toMatch(/repo logos|product screenshots|brand imagery/i);
  });

  it('prohibits hotlinking external CDN or stock image URLs', () => {
    expect(persona).toMatch(/Do NOT hotlink|no.*https:\/\/.*src/i);
  });

  it('requires CSS or inline SVG fallback with a note when no repo asset exists', () => {
    expect(persona).toMatch(/inline SVG placeholder|CSS.*background-color/i);
    expect(persona).toMatch(/no repo asset was found/i);
  });
});
