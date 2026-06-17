/**
 * UI/UX Pro Max integration for Allen Design Studio.
 *
 * This is a TypeScript, no-Python port of the small BM25/design-system
 * selection logic from https://github.com/nextlevelbuilder/ui-ux-pro-max-skill.
 * Allen vendors the MIT-licensed CSV data under ./vendor so users do not need
 * to install anything outside the app.
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DesignProfile, GreenfieldBrief } from './types.js';
import type { RepoScanResult } from './repo-scan.js';

type CsvRow = Record<string, string>;

interface DomainConfig {
  file: string;
  searchCols: string[];
  outputCols: string[];
}

interface SearchResult {
  domain: string;
  query: string;
  file: string;
  count: number;
  results: CsvRow[];
}

export interface ProMaxDesignIntelligence {
  source: 'ui-ux-pro-max';
  version: string;
  generatedAt: string;
  projectName: string;
  query: string;
  category: string;
  pattern: {
    name: string;
    sections: string;
    ctaPlacement: string;
    colorStrategy: string;
    conversion: string;
  };
  style: {
    name: string;
    type: string;
    effects: string;
    keywords: string;
    bestFor: string;
    performance: string;
    accessibility: string;
  };
  colors: {
    primary: string;
    secondary: string;
    accent: string;
    background: string;
    foreground: string;
    muted: string;
    border: string;
    notes: string;
  };
  typography: {
    heading: string;
    body: string;
    mood: string;
    bestFor: string;
  };
  keyEffects: string;
  antiPatterns: string;
  stack?: string;
  stackGuidelines: CsvRow[];
  uxGuidelines: CsvRow[];
  rawMatches: Record<string, SearchResult>;
}

const VERSION = '2.5.0';

const CSV_CONFIG: Record<string, DomainConfig> = {
  style: {
    file: 'styles.csv',
    searchCols: ['Style Category', 'Keywords', 'Best For', 'Type', 'AI Prompt Keywords'],
    outputCols: ['Style Category', 'Type', 'Keywords', 'Primary Colors', 'Effects & Animation', 'Best For', 'Light Mode ✓', 'Dark Mode ✓', 'Performance', 'Accessibility', 'Framework Compatibility', 'Complexity', 'AI Prompt Keywords', 'CSS/Technical Keywords', 'Implementation Checklist', 'Design System Variables'],
  },
  color: {
    file: 'colors.csv',
    searchCols: ['Product Type', 'Notes'],
    outputCols: ['Product Type', 'Primary', 'On Primary', 'Secondary', 'On Secondary', 'Accent', 'On Accent', 'Background', 'Foreground', 'Card', 'Card Foreground', 'Muted', 'Muted Foreground', 'Border', 'Destructive', 'On Destructive', 'Ring', 'Notes'],
  },
  landing: {
    file: 'landing.csv',
    searchCols: ['Pattern Name', 'Keywords', 'Conversion Optimization', 'Section Order'],
    outputCols: ['Pattern Name', 'Keywords', 'Section Order', 'Primary CTA Placement', 'Color Strategy', 'Conversion Optimization'],
  },
  product: {
    file: 'products.csv',
    searchCols: ['Product Type', 'Keywords', 'Primary Style Recommendation', 'Key Considerations'],
    outputCols: ['Product Type', 'Keywords', 'Primary Style Recommendation', 'Secondary Styles', 'Landing Page Pattern', 'Dashboard Style (if applicable)', 'Color Palette Focus'],
  },
  typography: {
    file: 'typography.csv',
    searchCols: ['Font Pairing Name', 'Category', 'Mood/Style Keywords', 'Best For', 'Heading Font', 'Body Font'],
    outputCols: ['Font Pairing Name', 'Category', 'Heading Font', 'Body Font', 'Mood/Style Keywords', 'Best For', 'Google Fonts URL', 'CSS Import', 'Tailwind Config', 'Notes'],
  },
  ux: {
    file: 'ux-guidelines.csv',
    searchCols: ['Category', 'Issue', 'Description', 'Platform'],
    outputCols: ['Category', 'Issue', 'Platform', 'Description', 'Do', "Don't", 'Severity'],
  },
};

const STACK_FILES: Record<string, string> = {
  angular: 'stacks/angular.csv',
  astro: 'stacks/astro.csv',
  flutter: 'stacks/flutter.csv',
  'html-tailwind': 'stacks/html-tailwind.csv',
  'jetpack-compose': 'stacks/jetpack-compose.csv',
  laravel: 'stacks/laravel.csv',
  nextjs: 'stacks/nextjs.csv',
  'nuxt-ui': 'stacks/nuxt-ui.csv',
  nuxtjs: 'stacks/nuxtjs.csv',
  react: 'stacks/react.csv',
  'react-native': 'stacks/react-native.csv',
  shadcn: 'stacks/shadcn.csv',
  svelte: 'stacks/svelte.csv',
  threejs: 'stacks/threejs.csv',
  vue: 'stacks/vue.csv',
};

const STACK_COLS: DomainConfig = {
  file: '',
  searchCols: ['Category', 'Guideline', 'Description', 'Do', "Don't"],
  outputCols: ['Category', 'Guideline', 'Description', 'Do', "Don't", 'Severity', 'Docs URL'],
};

const REASONING_FILE = 'ui-reasoning.csv';

function normalizeToken(text: string): string[] {
  return String(text)
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2);
}

class BM25 {
  private corpus: string[][] = [];
  private docLengths: number[] = [];
  private avgdl = 0;
  private idf = new Map<string, number>();

  constructor(private readonly k1 = 1.5, private readonly b = 0.75) {}

  fit(documents: string[]): void {
    this.corpus = documents.map(normalizeToken);
    this.docLengths = this.corpus.map((doc) => doc.length);
    this.avgdl = this.docLengths.length ? this.docLengths.reduce((sum, len) => sum + len, 0) / this.docLengths.length : 0;
    const freqs = new Map<string, number>();
    for (const doc of this.corpus) {
      for (const word of new Set(doc)) freqs.set(word, (freqs.get(word) ?? 0) + 1);
    }
    const n = this.corpus.length;
    this.idf = new Map([...freqs.entries()].map(([word, freq]) => [word, Math.log((n - freq + 0.5) / (freq + 0.5) + 1)]));
  }

  score(query: string): Array<{ index: number; score: number }> {
    const queryTokens = normalizeToken(query);
    return this.corpus
      .map((doc, index) => {
        const termFreqs = new Map<string, number>();
        for (const word of doc) termFreqs.set(word, (termFreqs.get(word) ?? 0) + 1);
        const docLen = this.docLengths[index] || 1;
        let score = 0;
        for (const token of queryTokens) {
          const idf = this.idf.get(token);
          if (!idf) continue;
          const tf = termFreqs.get(token) ?? 0;
          const denominator = tf + this.k1 * (1 - this.b + this.b * docLen / Math.max(this.avgdl, 1));
          score += idf * ((tf * (this.k1 + 1)) / denominator);
        }
        return { index, score };
      })
      .sort((a, b) => b.score - a.score);
  }
}

function parseCsv(text: string): CsvRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }

  const [headers = [], ...body] = rows;
  return body
    .filter((cells) => cells.some((cell) => cell.trim()))
    .map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ''])));
}

async function existingPath(candidates: string[]): Promise<string> {
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  throw new Error('UI/UX Pro Max vendor data was not found');
}

async function dataDir(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  return existingPath([
    join(here, 'vendor', 'ui-ux-pro-max', 'data'),
    join(here.replace(`${join('dist', 'services', 'design-studio')}`, join('src', 'services', 'design-studio')), 'vendor', 'ui-ux-pro-max', 'data'),
    join(process.cwd(), 'packages/server/src/services/design-studio/vendor/ui-ux-pro-max/data'),
  ]);
}

async function loadCsv(relativePath: string): Promise<CsvRow[]> {
  const root = await dataDir();
  const text = await fs.readFile(join(root, relativePath), 'utf8');
  return parseCsv(text);
}

function pick(row: CsvRow, cols: string[]): CsvRow {
  return Object.fromEntries(cols.filter((col) => col in row).map((col) => [col, row[col] ?? '']));
}

async function searchDomain(query: string, domain: keyof typeof CSV_CONFIG, maxResults: number): Promise<SearchResult> {
  const config = CSV_CONFIG[domain];
  const rows = await loadCsv(config.file);
  const documents = rows.map((row) => config.searchCols.map((col) => row[col] ?? '').join(' '));
  const bm25 = new BM25();
  bm25.fit(documents);
  const results = bm25.score(query)
    .filter((item) => item.score > 0)
    .slice(0, maxResults)
    .map((item) => pick(rows[item.index], config.outputCols));
  return { domain, query, file: config.file, count: results.length, results };
}

async function searchStackGuidelines(query: string, stack: string, maxResults: number): Promise<CsvRow[]> {
  const file = STACK_FILES[stack];
  if (!file) return [];
  const rows = await loadCsv(file);
  const documents = rows.map((row) => STACK_COLS.searchCols.map((col) => row[col] ?? '').join(' '));
  const bm25 = new BM25();
  bm25.fit(documents);
  return bm25.score(query)
    .filter((item) => item.score > 0)
    .slice(0, maxResults)
    .map((item) => pick(rows[item.index], STACK_COLS.outputCols));
}

async function reasoningFor(category: string): Promise<CsvRow> {
  const rows = await loadCsv(REASONING_FILE);
  const normalized = category.toLowerCase();
  return rows.find((row) => row.UI_Category?.toLowerCase() === normalized)
    ?? rows.find((row) => {
      const candidate = row.UI_Category?.toLowerCase() ?? '';
      return candidate && (candidate.includes(normalized) || normalized.includes(candidate));
    })
    ?? {};
}

function stylePriority(reasoning: CsvRow): string[] {
  return (reasoning.Style_Priority ?? '').split('+').map((item) => item.trim()).filter(Boolean);
}

function selectBest(results: CsvRow[], priorities: string[]): CsvRow {
  if (!results.length) return {};
  if (!priorities.length) return results[0];
  for (const priority of priorities) {
    const lower = priority.toLowerCase();
    const exact = results.find((row) => {
      const styleName = (row['Style Category'] ?? '').toLowerCase();
      return styleName.includes(lower) || lower.includes(styleName);
    });
    if (exact) return exact;
  }
  return results
    .map((row) => ({
      row,
      score: priorities.reduce((score, priority) => {
        const lower = priority.toLowerCase();
        const rowText = JSON.stringify(row).toLowerCase();
        if ((row['Style Category'] ?? '').toLowerCase().includes(lower)) return score + 10;
        if ((row.Keywords ?? '').toLowerCase().includes(lower)) return score + 3;
        return rowText.includes(lower) ? score + 1 : score;
      }, 0),
    }))
    .sort((a, b) => b.score - a.score)[0]?.row ?? results[0];
}

function detectStack(scan?: RepoScanResult): string | undefined {
  const text = (scan?.files ?? []).map((file) => `${file.path}\n${file.content}`).join('\n').toLowerCase();
  if (!text) return undefined;
  if (text.includes('"next"') || text.includes("'next'") || text.includes('next.config')) return 'nextjs';
  if (text.includes('@angular/') || text.includes('angular.json')) return 'angular';
  if (text.includes('"vue"') || text.includes('@vue/')) return 'vue';
  if (text.includes('"svelte"') || text.includes('svelte.config')) return 'svelte';
  if (text.includes('"astro"') || text.includes('astro.config')) return 'astro';
  if (text.includes('"react-native"')) return 'react-native';
  if (text.includes('"react"') || text.includes('from react')) return 'react';
  if (text.includes('tailwind') || text.includes('className=')) return 'html-tailwind';
  return undefined;
}

function compact(value: string | undefined, max = 280): string {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function buildQuery(input: {
  workspaceName: string;
  profile?: DesignProfile;
  brief?: GreenfieldBrief;
  scan?: RepoScanResult;
}): string {
  const parts = [
    input.workspaceName,
    input.brief?.product,
    input.brief?.audience,
    input.brief?.feel,
    input.brief?.screens,
    input.profile?.summaryMarkdown,
    input.profile?.typography,
    input.profile?.layoutPatterns,
    input.profile?.components?.map((component) => `${component.name} ${component.description}`).join(' '),
    input.scan?.files.find((file) => file.path.endsWith('package.json'))?.content,
  ];
  return compact(parts.filter(Boolean).join(' '), 1200) || input.workspaceName || 'modern web app';
}

export async function generateProMaxDesignIntelligence(input: {
  workspaceName: string;
  profile?: DesignProfile;
  brief?: GreenfieldBrief;
  scan?: RepoScanResult;
}): Promise<ProMaxDesignIntelligence> {
  const query = buildQuery(input);
  const product = await searchDomain(query, 'product', 1);
  const category = product.results[0]?.['Product Type'] || input.brief?.product || 'General';
  const reasoning = await reasoningFor(category);
  const priorities = stylePriority(reasoning);

  const styleQuery = priorities.length ? `${query} ${priorities.slice(0, 2).join(' ')}` : query;
  const [style, color, landing, typography, ux] = await Promise.all([
    searchDomain(styleQuery, 'style', 3),
    searchDomain(query, 'color', 2),
    searchDomain(query, 'landing', 2),
    searchDomain(query, 'typography', 2),
    searchDomain(query, 'ux', 4),
  ]);

  const bestStyle = selectBest(style.results, priorities);
  const bestColor = color.results[0] ?? {};
  const bestLanding = landing.results[0] ?? {};
  const bestTypography = typography.results[0] ?? {};
  const stack = detectStack(input.scan);
  const stackGuidelines = stack ? await searchStackGuidelines(query, stack, 4) : [];

  return {
    source: 'ui-ux-pro-max',
    version: VERSION,
    generatedAt: new Date().toISOString(),
    projectName: input.workspaceName || input.brief?.product || 'Design Studio workspace',
    query,
    category,
    pattern: {
      name: bestLanding['Pattern Name'] || reasoning.Recommended_Pattern || 'Hero + Features + CTA',
      sections: bestLanding['Section Order'] || 'Hero > Features > CTA',
      ctaPlacement: bestLanding['Primary CTA Placement'] || 'Above fold',
      colorStrategy: bestLanding['Color Strategy'] || '',
      conversion: bestLanding['Conversion Optimization'] || '',
    },
    style: {
      name: bestStyle['Style Category'] || 'Minimalism',
      type: bestStyle.Type || 'General',
      effects: bestStyle['Effects & Animation'] || reasoning.Key_Effects || '',
      keywords: bestStyle.Keywords || '',
      bestFor: bestStyle['Best For'] || '',
      performance: bestStyle.Performance || '',
      accessibility: bestStyle.Accessibility || '',
    },
    colors: {
      primary: bestColor.Primary || '#2563EB',
      secondary: bestColor.Secondary || '#3B82F6',
      accent: bestColor.Accent || '#F97316',
      background: bestColor.Background || '#F8FAFC',
      foreground: bestColor.Foreground || '#1E293B',
      muted: bestColor.Muted || '',
      border: bestColor.Border || '',
      notes: bestColor.Notes || '',
    },
    typography: {
      heading: bestTypography['Heading Font'] || 'Inter',
      body: bestTypography['Body Font'] || 'Inter',
      mood: bestTypography['Mood/Style Keywords'] || reasoning.Typography_Mood || '',
      bestFor: bestTypography['Best For'] || '',
    },
    keyEffects: bestStyle['Effects & Animation'] || reasoning.Key_Effects || '',
    antiPatterns: reasoning.Anti_Patterns || '',
    stack,
    stackGuidelines,
    uxGuidelines: ux.results,
    rawMatches: { product, style, color, landing, typography, ux },
  };
}

function bullet(label: string, value?: string): string {
  return value?.trim() ? `- **${label}:** ${value.trim()}` : '';
}

function rows(title: string, items: CsvRow[], columns: string[]): string[] {
  if (!items.length) return [];
  const out = [`## ${title}`];
  items.forEach((item, index) => {
    out.push(`### ${index + 1}. ${item.Guideline || item.Issue || item.Category || 'Guideline'}`);
    columns.forEach((col) => {
      if (item[col]?.trim()) out.push(`- **${col}:** ${compact(item[col], 360)}`);
    });
  });
  return out;
}

export function renderProMaxMarkdown(insight: ProMaxDesignIntelligence): string {
  return [
    '# UI/UX Pro Max Design Intelligence',
    '',
    `Generated: ${insight.generatedAt}`,
    `Source: UI/UX Pro Max ${insight.version}`,
    '',
    'This is supplemental design intelligence. Repository-derived Allen Design Studio tokens, components, typography, colors, and radii remain the source of truth.',
    '',
    '## Recommendation',
    bullet('Project', insight.projectName),
    bullet('Category', insight.category),
    bullet('Pattern', `${insight.pattern.name}; sections: ${insight.pattern.sections}`),
    bullet('CTA placement', insight.pattern.ctaPlacement),
    bullet('Conversion guidance', insight.pattern.conversion),
    bullet('Style', `${insight.style.name}${insight.style.type ? ` (${insight.style.type})` : ''}`),
    bullet('Style keywords', insight.style.keywords),
    bullet('Effects', insight.keyEffects),
    bullet('Accessibility', insight.style.accessibility),
    bullet('Typography', `${insight.typography.heading} / ${insight.typography.body}${insight.typography.mood ? ` — ${insight.typography.mood}` : ''}`),
    bullet('Color guidance', `${insight.colors.primary} primary, ${insight.colors.secondary} secondary, ${insight.colors.accent} accent, ${insight.colors.background} background, ${insight.colors.foreground} text`),
    bullet('Color notes', insight.colors.notes),
    bullet('Avoid', insight.antiPatterns),
    bullet('Detected stack', insight.stack),
    '',
    ...rows('Stack Guidance', insight.stackGuidelines, ['Category', 'Description', 'Do', "Don't", 'Severity']),
    '',
    ...rows('UX Guidance', insight.uxGuidelines, ['Category', 'Description', 'Do', "Don't", 'Severity']),
    '',
    '## Usage Rules For Allen Design Studio',
    '- Use this file to improve planning, UX quality, page composition, accessibility, and variation focus.',
    '- Do not override `system/tokens.css`, `system/components.css`, or the repository profile with these suggested colors/fonts unless the user explicitly asks for a new visual direction.',
    '- For multiple variations, use these recommendations to differentiate structure and UX emphasis while keeping the repo design system intact.',
    '',
  ].filter((line) => line !== '').join('\n');
}
