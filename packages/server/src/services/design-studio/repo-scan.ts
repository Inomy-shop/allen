/**
 * Allen Design Studio — Repo scanner (Mode A)
 *
 * Read-only over the user's repo (non-goal: never writes to it). Collects the
 * styling-relevant signals (CSS/SCSS, Tailwind/theme config, a sample of UI
 * component files) into a bounded text bundle for the LLM to infer a design
 * profile from, and computes a lightweight fingerprint used to detect repo
 * changes since profiling (R22.2).
 */

import { promises as fs } from 'node:fs';
import { join, relative, extname, basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const STYLE_EXTENSIONS = new Set(['.css', '.scss', '.sass', '.less']);
const COMPONENT_EXTENSIONS = new Set(['.tsx', '.jsx', '.vue', '.svelte']);
const CONFIG_NAMES = new Set([
  'package.json',
  'tailwind.config.js',
  'tailwind.config.ts',
  'tailwind.config.cjs',
  'postcss.config.js',
  'postcss.config.cjs',
  'theme.ts',
  'theme.js',
  'theme.json',
  'tokens.json',
  'design-tokens.json',
  'style-dictionary.config.js',
  'components.json',
]);
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage', 'vendor', '.turbo']);

const MAX_FILES = 40;
const MAX_BYTES_PER_FILE = 16 * 1024;
const MAX_TOTAL_BYTES = 240 * 1024;

export interface ScannedFile {
  path: string; // relative
  content: string;
}

export interface RepoScanResult {
  files: ScannedFile[];
  fingerprint: string;
  /** True when nothing style-relevant was found — analysis should say so. */
  empty: boolean;
}

async function walk(dir: string, root: string, acc: string[], depth = 0): Promise<void> {
  if (depth > 8 || acc.length > 4000) return;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      await walk(full, root, acc, depth + 1);
    } else if (entry.isFile()) {
      acc.push(full);
    }
  }
}

function rank(path: string): number {
  const ext = extname(path).toLowerCase();
  const name = basename(path).toLowerCase();
  if (CONFIG_NAMES.has(name)) return 0;
  if (
    name.includes('theme') ||
    name.includes('token') ||
    name.includes('global') ||
    name.includes('variables') ||
    name.includes('font') ||
    name.includes('typography') ||
    name.includes('radius') ||
    name.includes('shadow') ||
    name.includes('icon')
  ) return 1;
  if (STYLE_EXTENSIONS.has(ext)) return 2;
  if (
    name.includes('button') ||
    name.includes('card') ||
    name.includes('nav') ||
    name.includes('sidebar') ||
    name.includes('header') ||
    name.includes('input') ||
    name.includes('form') ||
    name.includes('select') ||
    name.includes('checkbox') ||
    name.includes('radio') ||
    name.includes('switch') ||
    name.includes('tabs') ||
    name.includes('table') ||
    name.includes('list') ||
    name.includes('modal') ||
    name.includes('dialog') ||
    name.includes('drawer') ||
    name.includes('sheet') ||
    name.includes('badge') ||
    name.includes('alert') ||
    name.includes('toast') ||
    name.includes('avatar') ||
    name.includes('empty') ||
    name.includes('skeleton') ||
    name.includes('loader') ||
    name.includes('tooltip') ||
    name.includes('popover')
  ) return 3;
  if (COMPONENT_EXTENSIONS.has(ext)) return 4;
  return 9;
}

function isNamedDesignSignal(name: string): boolean {
  return (
    name.includes('theme') ||
    name.includes('token') ||
    name.includes('global') ||
    name.includes('variables') ||
    name.includes('font') ||
    name.includes('typography') ||
    name.includes('radius') ||
    name.includes('shadow') ||
    name.includes('icon')
  );
}

/**
 * Scan a repo on disk for styling signals. Bounded in file count and bytes so
 * very large repos stay responsive (risk noted in PRD §8).
 */
export async function scanRepoForStyle(repoPath: string): Promise<RepoScanResult> {
  const all: string[] = [];
  await walk(repoPath, repoPath, all);

  const candidates = all
    .filter((p) => {
      const ext = extname(p).toLowerCase();
      const name = basename(p).toLowerCase();
      return STYLE_EXTENSIONS.has(ext) || COMPONENT_EXTENSIONS.has(ext) || CONFIG_NAMES.has(name) || isNamedDesignSignal(name);
    })
    .sort((a, b) => rank(a) - rank(b) || a.length - b.length);

  const files: ScannedFile[] = [];
  const hash = createHash('sha256');
  let total = 0;

  for (const p of candidates) {
    if (files.length >= MAX_FILES || total >= MAX_TOTAL_BYTES) break;
    let raw: string;
    try {
      raw = await fs.readFile(p, 'utf8');
    } catch {
      continue;
    }
    const sliced = raw.slice(0, MAX_BYTES_PER_FILE);
    const rel = relative(repoPath, p);
    files.push({ path: rel, content: sliced });
    hash.update(rel);
    hash.update(sliced);
    total += sliced.length;
  }

  return {
    files,
    fingerprint: hash.digest('hex'),
    empty: files.length === 0,
  };
}

/** Render the scan as a bounded prompt context block. */
export function renderScanForPrompt(scan: RepoScanResult): string {
  if (scan.empty) return '(no styling-relevant files were found in this repository)';
  return scan.files
    .map((f) => `=== FILE: ${f.path} ===\n${f.content}`)
    .join('\n\n');
}

// ── Product/route/component context scan ────────────────────────────────────

/**
 * Files and extensions that signal routes, pages, navigation, or product
 * structure — distinct from style signals.
 */
const ROUTE_FILE_PATTERNS = [
  /routes?\.(ts|tsx|js|jsx)$/i,
  /router\.(ts|tsx|js|jsx)$/i,
  /app\.(ts|tsx|js|jsx)$/i,
  /index\.(ts|tsx|js|jsx)$/i,
  /navigation\.(ts|tsx|js|jsx)$/i,
  /sidebar\.(ts|tsx|js|jsx)$/i,
  /menu\.(ts|tsx|js|jsx)$/i,
  /nav\.(ts|tsx|js|jsx)$/i,
];
const ROUTE_DIR_NAMES = new Set(['pages', 'routes', 'views', 'screens', 'app']);
const PRODUCT_FILE_NAMES = new Set([
  'README.md', 'README.mdx', 'README.rst', 'README.txt',
  'package.json', '.env.example', 'env.example',
  'openapi.yaml', 'openapi.json', 'swagger.yaml', 'swagger.json',
]);

const MAX_CONTEXT_FILES = 30;
const MAX_CONTEXT_BYTES_PER_FILE = 12 * 1024;
const MAX_CONTEXT_TOTAL_BYTES = 200 * 1024;

/** Patterns that signal data contracts — TypeScript types, schemas, fixtures, constants, enums. */
const DATA_CONTRACT_FILE_PATTERNS: RegExp[] = [
  /\.types\.(ts|tsx)$/i,
  /types\.(ts|tsx|js)$/i,
  /\.schema\.(ts|js)$/i,
  /schema\.prisma$/i,
  /schema\.graphql$/i,
  /\.seed\.(ts|js)$/i,
  /^seeds?\.(ts|js)$/i,
  /\.fixture\.(ts|js)$/i,
  /\.mock\.(ts|js)$/i,
  /\.constants?\.(ts|js)$/i,
  /\.enums?\.(ts|js)$/i,
];

/** Directory names that signal data contracts. */
const DATA_CONTRACT_DIR_NAMES = new Set([
  'types', 'schemas', 'models', 'fixtures', 'mocks',
  '__fixtures__', '__mocks__', 'seeds', 'seed', 'constants', 'enums',
]);

export interface RepoContextScan {
  files: ScannedFile[];
  fingerprint: string;
  empty: boolean;
}

function isRouteSignal(path: string, name: string, parentDir: string): boolean {
  if (PRODUCT_FILE_NAMES.has(name)) return true;
  if (ROUTE_DIR_NAMES.has(parentDir.toLowerCase())) return true;
  if (ROUTE_FILE_PATTERNS.some((re) => re.test(name))) return true;
  // Data contract signals — TypeScript types, schemas, fixtures, constants
  if (DATA_CONTRACT_DIR_NAMES.has(parentDir.toLowerCase())) return true;
  return DATA_CONTRACT_FILE_PATTERNS.some((re) => re.test(name));
}

function rankContext(path: string): number {
  const name = basename(path);
  const parentDir = basename(dirname(path));
  if (PRODUCT_FILE_NAMES.has(name)) return 0;
  if (ROUTE_DIR_NAMES.has(parentDir.toLowerCase())) return 1;
  if (ROUTE_FILE_PATTERNS.some((re) => re.test(name))) return 2;
  // Data contract files (types, schemas, fixtures, seeds, constants) — lower priority than routes
  if (DATA_CONTRACT_DIR_NAMES.has(parentDir.toLowerCase())) return 3;
  if (DATA_CONTRACT_FILE_PATTERNS.some((re) => re.test(name))) return 3;
  return 9;
}

/**
 * Scan a repo for product/route/component context (distinct from style scan).
 * Collects README, package.json, route/page files, navigation components.
 */
export async function scanRepoForContext(repoPath: string): Promise<RepoContextScan> {
  const all: string[] = [];
  await walk(repoPath, repoPath, all);

  const candidates = all
    .filter((p) => {
      const name = basename(p);
      const parentDir = basename(dirname(p));
      return isRouteSignal(p, name, parentDir);
    })
    .sort((a, b) => rankContext(a) - rankContext(b) || a.length - b.length);

  const files: ScannedFile[] = [];
  const hash = createHash('sha256');
  let total = 0;

  for (const p of candidates) {
    if (files.length >= MAX_CONTEXT_FILES || total >= MAX_CONTEXT_TOTAL_BYTES) break;
    let raw: string;
    try {
      raw = await fs.readFile(p, 'utf8');
    } catch {
      continue;
    }
    const sliced = raw.slice(0, MAX_CONTEXT_BYTES_PER_FILE);
    const rel = relative(repoPath, p);
    files.push({ path: rel, content: sliced });
    hash.update(rel);
    hash.update(sliced);
    total += sliced.length;
  }

  return {
    files,
    fingerprint: hash.digest('hex'),
    empty: files.length === 0,
  };
}

/** Render the context scan as a bounded prompt block. */
export function renderContextForPrompt(scan: RepoContextScan): string {
  if (scan.empty) return '(no product/route context files found in this repository)';
  return scan.files
    .map((f) => `=== CONTEXT FILE: ${f.path} ===\n${f.content}`)
    .join('\n\n');
}
