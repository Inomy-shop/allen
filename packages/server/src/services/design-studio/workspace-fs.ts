/**
 * Allen Design Studio — workspace design-system folder.
 *
 * Each workspace owns ONE persistent folder on disk that accumulates a shared
 * design gallery: root `index.html` (dashboard), `styles.css` (tokens +
 * reusable components), and one folder per requested design under `designs/`.
 * Every chat thread for the workspace runs the UI Designer persona with this
 * folder as its working directory, so new designs reuse and extend the same
 * system instead of rebuilding it. The folder is also what we serve for
 * "Open in browser" and copy for "Export".
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, normalize, extname, resolve, relative } from 'node:path';
import type { Request, Response } from 'express';
import { resolveAllenHome } from '@allen/engine';
import type { DesignProfile } from './types.js';
import { renderProMaxMarkdown, type ProMaxDesignIntelligence } from './ui-ux-pro-max.js';

export const DSTUDIO_SITE_PREFIX = '/dstudio-site';

const IGNORE = new Set(['.git', 'node_modules', '.DS_Store']);

export function workspaceDir(workspaceId: string): string {
  // workspaceId is a Mongo ObjectId hex — safe as a path segment.
  const safe = workspaceId.replace(/[^a-zA-Z0-9_-]/g, '');
  return join(resolveAllenHome(), 'design-studio', 'workspaces', safe);
}

export interface WorkspaceSeedMeta {
  workspaceName?: string;
  sourceRepoName?: string;
  sourceRepoPath?: string;
  sourceRepoId?: string;
}

/** Ensure the folder exists and, on first use, seed the dashboard structure. */
export async function ensureWorkspaceDir(workspaceId: string, profile?: DesignProfile, meta: WorkspaceSeedMeta = {}): Promise<string> {
  const dir = workspaceDir(workspaceId);
  await fs.mkdir(dir, { recursive: true });

  const stylesPath = join(dir, 'styles.css');
  try {
    await fs.access(stylesPath);
  } catch {
    await fs.writeFile(stylesPath, seedStyles(profile), 'utf8');
  }

  const designsDir = join(dir, 'designs');
  await fs.mkdir(designsDir, { recursive: true });

  const manifestPath = join(designsDir, 'manifest.json');
  try {
    await fs.access(manifestPath);
  } catch {
    await fs.writeFile(manifestPath, seedManifest(), 'utf8');
  }

  const indexPath = join(dir, 'index.html');
  try {
    await fs.access(indexPath);
  } catch {
    await fs.writeFile(indexPath, seedDashboardHtml(meta), 'utf8');
  }

  if (profile) {
    await ensureDesignSystemKit(dir, profile, { overwrite: false });
  }
  await ensureSourceRepoPointer(dir, meta);

  return dir;
}

export async function materializeDesignSystemKit(workspaceId: string, profile: DesignProfile): Promise<string> {
  const dir = workspaceDir(workspaceId);
  await fs.mkdir(dir, { recursive: true });
  await ensureDesignSystemKit(dir, profile, { overwrite: true });
  return join(dir, 'system');
}

export async function materializeProMaxDesignIntelligence(workspaceId: string, insight: ProMaxDesignIntelligence): Promise<string> {
  const systemDir = join(workspaceDir(workspaceId), 'system');
  await fs.mkdir(systemDir, { recursive: true });
  await fs.writeFile(join(systemDir, 'pro-max.json'), `${JSON.stringify(insight, null, 2)}\n`, 'utf8');
  await fs.writeFile(join(systemDir, 'pro-max.md'), renderProMaxMarkdown(insight), 'utf8');
  return systemDir;
}

function seedStyles(profile?: DesignProfile): string {
  const vars = (profile?.colors ?? [])
    .map((c, i) => `  --color-${(c.role || c.name || `c${i}`).toLowerCase().replace(/[^a-z0-9]+/g, '-')}: ${c.value};`)
    .join('\n');
  const profileNotes = renderProfileCssNotes(profile);
  return [
    '@import url("./system/tokens.css");',
    '@import url("./system/components.css");',
    '',
    '/* Design system - shared tokens & components for this workspace.',
    ' * The designer reuses and extends this file across all designs. */',
    ':root {',
    '  --color-primary: #4763cf;',
    '  --color-bg: #fcfdff;',
    '  --color-text: #0b1730;',
    '  --color-muted: #6e778a;',
    '  --color-subtle: #9ca5b8;',
    '  --color-panel: #ffffff;',
    '  --color-panel-soft: #f7f9fd;',
    '  --color-border: #e2e5ed;',
    '  --color-border-strong: #cdd3e0;',
    vars,
    '  --radius: 8px;',
    '  --space: 8px;',
    '}',
    '',
    '* { box-sizing: border-box; }',
    profileNotes,
    '',
    'body {',
    '  margin: 0;',
    '  min-height: 100vh;',
    '  display: flex;',
    '  flex-direction: column;',
    '  font-family: Inter, "Inter Tight", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;',
    '  color: var(--color-text);',
    '  background: linear-gradient(180deg, color-mix(in srgb, var(--color-primary) 6%, transparent), transparent 340px), var(--color-bg);',
    '  letter-spacing: 0;',
    '}',
    '',
    '.studio-dashboard {',
    '  width: min(1120px, calc(100% - 32px));',
    '  min-height: 100vh;',
    '  margin: 0 auto;',
    '  padding: 56px 0 64px;',
    '  display: flex;',
    '  flex: 1;',
    '  flex-direction: column;',
    '}',
    '.studio-dashboard__header { margin-bottom: 30px; }',
    '.studio-dashboard__eyebrow {',
    '  display: inline-flex;',
    '  align-items: center;',
    '  width: fit-content;',
    '  min-height: 26px;',
    '  margin: 0 0 14px;',
    '  padding: 5px 9px;',
    '  border: 1px solid var(--color-border);',
    '  border-radius: 999px;',
    '  background: var(--color-panel);',
    '  color: var(--color-primary);',
    '  font-size: 12px;',
    '  font-weight: 700;',
    '  line-height: 1;',
    '}',
    '.studio-dashboard h1 {',
    '  margin: 0;',
    '  max-width: 760px;',
    '  font-size: clamp(26px, 3.75vw, 44px);',
    '  line-height: 1;',
    '  font-weight: 760;',
    '}',
    '.studio-dashboard__intro {',
    '  max-width: 680px;',
    '  margin: 16px 0 0;',
    '  color: var(--color-muted);',
    '  font-size: 16px;',
    '  line-height: 1.6;',
    '}',
    '.studio-design-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 340px)); justify-content: start; gap: 18px; }',
    '.studio-design-card {',
    '  display: grid;',
    '  grid-template-rows: 156px 132px;',
    '  overflow: hidden;',
    '  height: 288px;',
    '  border: 1px solid var(--color-border);',
    '  border-radius: var(--radius);',
    '  background: var(--color-panel);',
    '  color: inherit;',
    '  text-decoration: none;',
    '  box-shadow: 0 1px 2px rgba(24, 24, 26, 0.04);',
    '  transition: border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease;',
    '}',
    '.studio-design-card:hover {',
    '  border-color: var(--color-primary);',
    '  box-shadow: 0 12px 30px rgba(24, 24, 26, 0.08), 0 1px 2px rgba(24, 24, 26, 0.04);',
    '  transform: translateY(-2px);',
    '}',
    '.studio-design-card__preview {',
    '  min-height: 0;',
    '  height: 156px;',
    '  overflow: hidden;',
    '  padding: 16px;',
    '  border-bottom: 1px solid var(--color-border);',
    '  background: var(--color-panel-soft);',
    '}',
    '.studio-preview-login { display: grid; place-items: center; }',
    '.studio-preview-form {',
    '  width: min(190px, 100%);',
    '  display: grid;',
    '  gap: 8px;',
    '  padding: 14px;',
    '  border: 1px solid var(--color-border);',
    '  border-radius: 8px;',
    '  background: #ffffff;',
    '}',
    '.studio-preview-input, .studio-preview-line, .studio-preview-block, .studio-preview-pill { border-radius: 5px; background: #dfe4f1; }',
    '.studio-preview-input { height: 26px; }',
    '.studio-preview-line { height: 10px; }',
    '.studio-preview-line.is-dark { background: #aab4c9; }',
    '.studio-preview-pill { height: 24px; background: var(--color-primary); }',
    '.studio-preview-block { min-height: 60px; }',
    '.studio-preview-landing { display: grid; grid-template-columns: minmax(0, 1fr) 0.72fr; gap: 12px; align-items: center; }',
    '.studio-preview-stack { display: grid; gap: 10px; }',
    '.studio-preview-billing { display: grid; gap: 10px; }',
    '.studio-preview-mini-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }',
    '.studio-design-card__body { display: grid; grid-template-rows: auto auto; align-content: start; gap: 12px; height: 132px; min-height: 0; padding: 16px; }',
    '.studio-design-card__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }',
    '.studio-design-card h2 { margin: 0; font-size: 16px; line-height: 1.2; font-weight: 720; }',
    '.studio-design-card p {',
    '  display: -webkit-box;',
    '  overflow: hidden;',
    '  -webkit-box-orient: vertical;',
    '  -webkit-line-clamp: 2;',
    '  margin: 6px 0 0;',
    '  color: var(--color-muted);',
    '  font-size: 13px;',
    '  line-height: 1.5;',
    '  min-height: 39px;',
    '}',
    '.studio-card-summary { display: flex; align-items: center; gap: 8px; color: var(--color-muted); font-size: 12px; }',
    '.studio-card-dot { width: 4px; height: 4px; border-radius: 999px; background: var(--color-border-strong); }',
    '.studio-empty-state {',
    '  grid-column: 1 / -1;',
    '  display: grid;',
    '  place-items: center;',
    '  min-height: 340px;',
    '  border: 1px dashed var(--color-border-strong);',
    '  border-radius: var(--radius);',
    '  background: rgba(255, 255, 255, 0.58);',
    '  padding: 56px 24px;',
    '}',
    '.studio-empty-state__content { max-width: 460px; text-align: center; }',
    '.studio-empty-state h2 { margin: 0; font-size: 22px; line-height: 1.2; font-weight: 730; }',
    '.studio-empty-state p { margin: 10px 0 0; color: var(--color-muted); font-size: 14px; line-height: 1.65; }',
    '.studio-dashboard__footer {',
    '  display: flex;',
    '  align-items: center;',
    '  justify-content: space-between;',
    '  gap: 16px;',
    '  margin-top: auto;',
    '  padding-top: 18px;',
    '  border-top: 1px solid var(--color-border);',
    '  color: var(--color-subtle);',
    '  font-size: 12px;',
    '}',
    '.studio-dashboard__footer strong { color: var(--color-muted); font-weight: 650; }',
    '.studio-variation-list { display: grid; gap: 12px; margin-top: 24px; }',
    '.studio-floating-nav {',
    '  position: fixed;',
    '  right: 18px;',
    '  bottom: 18px;',
    '  z-index: 9999;',
    '  color: var(--color-text);',
    '  font-family: Inter, "Inter Tight", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;',
    '}',
    '.studio-floating-nav details { position: relative; }',
    '.studio-floating-nav details > .studio-floating-nav__panel { display: grid; }',
    '.studio-floating-nav summary {',
    '  display: inline-flex;',
    '  align-items: center;',
    '  justify-content: center;',
    '  width: 40px;',
    '  height: 40px;',
    '  padding: 0;',
    '  border: 1px solid var(--color-border);',
    '  border-radius: 999px;',
    '  background: rgba(255, 255, 255, 0.92);',
    '  box-shadow: 0 12px 30px rgba(24, 24, 26, 0.12), 0 1px 2px rgba(24, 24, 26, 0.06);',
    '  cursor: pointer;',
    '  font-size: 0;',
    '  font-weight: 700;',
    '  list-style: none;',
    '  outline: none;',
    '  transition: border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease;',
    '  user-select: none;',
    '}',
    '.studio-floating-nav summary:hover, .studio-floating-nav summary:focus-visible {',
    '  border-color: var(--color-primary);',
    '  box-shadow: 0 16px 36px rgba(24, 24, 26, 0.16), 0 0 0 3px color-mix(in srgb, var(--color-primary) 16%, transparent);',
    '  transform: translateY(-1px);',
    '}',
    '.studio-floating-nav summary::-webkit-details-marker { display: none; }',
    '.studio-floating-nav summary::before {',
    '  content: "";',
    '  width: 16px;',
    '  height: 16px;',
    '  border-radius: 4px;',
    '  background:',
    '    radial-gradient(circle at 3px 3px, var(--color-primary) 0 2px, transparent 2.5px),',
    '    radial-gradient(circle at 13px 3px, var(--color-primary) 0 2px, transparent 2.5px),',
    '    radial-gradient(circle at 3px 13px, var(--color-primary) 0 2px, transparent 2.5px),',
    '    radial-gradient(circle at 13px 13px, var(--color-primary) 0 2px, transparent 2.5px);',
    '}',
    '.studio-floating-nav__panel {',
    '  position: absolute;',
    '  right: 0;',
    '  bottom: calc(100% + 8px);',
    '  min-width: 190px;',
    '  gap: 4px;',
    '  padding: 8px;',
    '  border: 1px solid var(--color-border);',
    '  border-radius: var(--radius);',
    '  background: rgba(255, 255, 255, 0.96);',
    '  box-shadow: 0 18px 44px rgba(24, 24, 26, 0.14), 0 1px 2px rgba(24, 24, 26, 0.06);',
    '  opacity: 0;',
    '  pointer-events: none;',
    '  transform: translateY(8px) scale(0.98);',
    '  transform-origin: bottom right;',
    '  transition: opacity 170ms ease, transform 170ms ease;',
    '}',
    '.studio-floating-nav:hover .studio-floating-nav__panel,',
    '.studio-floating-nav:focus-within .studio-floating-nav__panel,',
    '.studio-floating-nav details[open] .studio-floating-nav__panel {',
    '  opacity: 1;',
    '  pointer-events: auto;',
    '  transform: translateY(0) scale(1);',
    '}',
    '.studio-floating-nav a {',
    '  display: flex;',
    '  align-items: center;',
    '  min-height: 32px;',
    '  padding: 0 10px;',
    '  border-radius: 6px;',
    '  color: var(--color-text);',
    '  font-size: 13px;',
    '  text-decoration: none;',
    '}',
    '.studio-floating-nav a:hover { background: var(--color-panel-soft); }',
    '@media (max-width: 760px) {',
    '  .studio-dashboard { padding: 32px 0 44px; }',
    '  .studio-dashboard__footer { align-items: flex-start; flex-direction: column; }',
    '  .studio-floating-nav { right: 12px; bottom: 12px; }',
    '}',
    '',
    '/* Add reusable product components below (.btn, .card, .nav, .input, etc.). */',
    '',
  ].join('\n');
}

function cssComment(value: string): string {
  return value.replace(/\*\//g, '* /').trim();
}

function renderProfileCssNotes(profile?: DesignProfile): string {
  if (!profile) return '';
  const notes = [
    profile.typography ? `Typography: ${profile.typography}` : '',
    profile.spacing ? `Spacing/sizing: ${profile.spacing}` : '',
    profile.iconography ? `Iconography: ${profile.iconography}` : '',
    profile.layoutPatterns ? `Layout patterns: ${profile.layoutPatterns}` : '',
    profile.components?.length
      ? `Components: ${profile.components.map((component) => `${component.name} - ${component.description}`).join('; ')}`
      : '',
  ].filter(Boolean);
  if (!notes.length) return '';
  return [
    '/* Repository design-system notes captured during analysis:',
    ...notes.map((note) => ` * ${cssComment(note)}`),
    ' */',
  ].join('\n');
}

async function ensureDesignSystemKit(dir: string, profile: DesignProfile, opts: { overwrite: boolean }): Promise<void> {
  const systemDir = join(dir, 'system');
  await fs.mkdir(systemDir, { recursive: true });
  await ensureStylesImports(join(dir, 'styles.css'));

  const files = [
    ['tokens.css', renderTokensCss(profile)],
    ['components.css', renderComponentsCss(profile)],
    ['components.html', renderComponentsHtml(profile)],
    ['manifest.json', renderSystemManifest(profile)],
  ] as const;

  for (const [file, content] of files) {
    const target = join(systemDir, file);
    if (!opts.overwrite) {
      try {
        await fs.access(target);
        continue;
      } catch {
        // create below
      }
    }
    await fs.writeFile(target, content, 'utf8');
  }
}

async function ensureSourceRepoPointer(dir: string, meta: WorkspaceSeedMeta): Promise<void> {
  const sourceRepoPath = meta.sourceRepoPath?.trim();
  if (!sourceRepoPath) return;
  const systemDir = join(dir, 'system');
  await fs.mkdir(systemDir, { recursive: true });
  const pointer = {
    source: 'design-studio-workspace',
    mode: 'read-only',
    name: meta.sourceRepoName?.trim() || null,
    repoId: meta.sourceRepoId?.trim() || null,
    path: sourceRepoPath,
    usage: [
      'For redesign requests targeting existing repository pages, inspect this path on demand before planning.',
      'Use read-only operations only. Generated design files must stay in the Design Studio workspace.',
      'Preserve existing page content, labels, fields, navigation, and workflow unless the user asks to change them.',
    ],
  };
  await fs.writeFile(join(systemDir, 'source-repo.json'), `${JSON.stringify(pointer, null, 2)}\n`, 'utf8');
}

async function ensureStylesImports(stylesPath: string): Promise<void> {
  const imports = [
    '@import url("./system/tokens.css");',
    '@import url("./system/components.css");',
  ];
  let current = '';
  try {
    current = await fs.readFile(stylesPath, 'utf8');
  } catch {
    await fs.writeFile(stylesPath, `${imports.join('\n')}\n\n`, 'utf8');
    return;
  }

  const missing = imports.filter((line) => !current.includes(line));
  if (!missing.length) return;
  await fs.writeFile(stylesPath, `${missing.join('\n')}\n${current.startsWith('\n') ? '' : '\n'}${current}`, 'utf8');
}

function designVarName(value: string, fallback: string): string {
  return (value || fallback).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || fallback;
}

function colorByRole(profile: DesignProfile, role: string, fallback: string): string {
  const lower = role.toLowerCase();
  const token = profile.colors.find((color) => color.role?.toLowerCase() === lower)
    ?? profile.colors.find((color) => color.name.toLowerCase().includes(lower));
  return token?.value || fallback;
}

function fontFamilyFromProfile(profile: DesignProfile): string {
  const text = [profile.typography, profile.summaryMarkdown].filter(Boolean).join(' ');
  const quoted = text.match(/["'`]([^"'`]+)["'`]/);
  if (quoted?.[1]) return `${quoted[1]}, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  const common = ['Inter Tight', 'Inter', 'Roboto', 'Poppins', 'Montserrat', 'Lato', 'Open Sans', 'Nunito', 'Manrope', 'Geist', 'Arial', 'Helvetica'];
  const found = common.find((font) => new RegExp(`\\b${font.replace(/\s+/g, '\\s+')}\\b`, 'i').test(text));
  return found
    ? `${found.includes(' ') ? `"${found}"` : found}, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
    : 'Inter, "Inter Tight", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
}

function pxFromText(text: string | undefined, patterns: RegExp[], fallback: string): string {
  if (!text) return fallback;
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return `${match[1]}px`;
  }
  return fallback;
}

function renderTokensCss(profile: DesignProfile): string {
  const colorLines = profile.colors.map((color, index) => {
    const name = designVarName(color.role || color.name, `color-${index + 1}`);
    return `  --ds-color-${name}: ${color.value};`;
  });
  const systemText = [profile.spacing, profile.summaryMarkdown].filter(Boolean).join(' ');
  const radius = pxFromText(systemText, [/(\d+(?:\.\d+)?)px\s+(?:border-)?radius/i, /radius[^.\n]*?(\d+(?:\.\d+)?)px/i, /rounded[^.\n]*?(\d+(?:\.\d+)?)px/i], '8px');
  const controlHeight = pxFromText(systemText, [/(\d+(?:\.\d+)?)px\s+control/i, /control[^.\n]*?(\d+(?:\.\d+)?)px/i, /button[^.\n]*?height[^.\n]*?(\d+(?:\.\d+)?)px/i], '40px');

  return [
    '/* Repository design-system tokens.',
    ' * Generated from Design Studio repository analysis. */',
    ':root {',
    `  --ds-color-primary: ${colorByRole(profile, 'primary', '#4763cf')};`,
    `  --ds-color-background: ${colorByRole(profile, 'background', '#fcfdff')};`,
    `  --ds-color-surface: ${colorByRole(profile, 'surface', '#ffffff')};`,
    `  --ds-color-text: ${colorByRole(profile, 'text', '#0b1730')};`,
    `  --ds-color-muted: ${colorByRole(profile, 'muted', '#6e778a')};`,
    `  --ds-color-border: ${colorByRole(profile, 'border', '#e2e5ed')};`,
    ...colorLines,
    `  --ds-font-family: ${fontFamilyFromProfile(profile)};`,
    '  --ds-font-size-display: 44px;',
    '  --ds-font-size-title: 24px;',
    '  --ds-font-size-body: 14px;',
    '  --ds-font-size-caption: 12px;',
    '  --ds-line-height-tight: 1.15;',
    '  --ds-line-height-body: 1.5;',
    '  --ds-font-weight-regular: 400;',
    '  --ds-font-weight-medium: 600;',
    '  --ds-font-weight-bold: 720;',
    '  --ds-space-1: 4px;',
    '  --ds-space-2: 8px;',
    '  --ds-space-3: 12px;',
    '  --ds-space-4: 16px;',
    '  --ds-space-5: 24px;',
    '  --ds-space-6: 32px;',
    `  --ds-radius-sm: ${radius};`,
    `  --ds-radius-md: ${radius};`,
    '  --ds-radius-lg: calc(var(--ds-radius-md) + 4px);',
    `  --ds-control-height: ${controlHeight};`,
    '  --ds-icon-size-sm: 16px;',
    '  --ds-icon-size-md: 20px;',
    '  --ds-shadow-sm: 0 1px 2px rgba(24, 24, 26, 0.06);',
    '  --ds-shadow-md: 0 12px 30px rgba(24, 24, 26, 0.10);',
    '}',
    '',
    profile.typography ? `/* Typography evidence: ${cssComment(profile.typography)} */` : '',
    profile.spacing ? `/* Spacing evidence: ${cssComment(profile.spacing)} */` : '',
    profile.iconography ? `/* Iconography evidence: ${cssComment(profile.iconography)} */` : '',
    '',
  ].filter((line) => line !== '').join('\n');
}

function renderComponentsCss(profile: DesignProfile): string {
  return [
    '/* Repository component kit.',
    ' * Generated from Design Studio repository analysis. Use these classes before inventing page-specific CSS. */',
    '.ds-page { min-height: 100vh; background: var(--ds-color-background); color: var(--ds-color-text); font-family: var(--ds-font-family); }',
    '.ds-container { width: min(1120px, calc(100% - 32px)); margin: 0 auto; }',
    '.ds-stack { display: grid; gap: var(--ds-space-4); }',
    '.ds-row { display: flex; align-items: center; gap: var(--ds-space-3); }',
    '.ds-card { border: 1px solid var(--ds-color-border); border-radius: var(--ds-radius-md); background: var(--ds-color-surface); box-shadow: var(--ds-shadow-sm); padding: var(--ds-space-4); }',
    '.ds-title { margin: 0; color: var(--ds-color-text); font-size: var(--ds-font-size-title); line-height: var(--ds-line-height-tight); font-weight: var(--ds-font-weight-bold); }',
    '.ds-body { margin: 0; color: var(--ds-color-muted); font-size: var(--ds-font-size-body); line-height: var(--ds-line-height-body); }',
    '.ds-caption { margin: 0; color: var(--ds-color-muted); font-size: var(--ds-font-size-caption); line-height: var(--ds-line-height-body); }',
    '.ds-btn { display: inline-flex; min-height: var(--ds-control-height); align-items: center; justify-content: center; gap: var(--ds-space-2); border: 1px solid transparent; border-radius: var(--ds-radius-sm); padding: 0 var(--ds-space-4); font: inherit; font-size: var(--ds-font-size-body); font-weight: var(--ds-font-weight-medium); cursor: pointer; text-decoration: none; transition: background 160ms ease, border-color 160ms ease, color 160ms ease, box-shadow 160ms ease, transform 160ms ease; }',
    '.ds-btn:hover { transform: translateY(-1px); }',
    '.ds-btn-primary { background: var(--ds-color-primary); color: #fff; box-shadow: var(--ds-shadow-sm); }',
    '.ds-btn-secondary { border-color: var(--ds-color-border); background: var(--ds-color-surface); color: var(--ds-color-text); }',
    '.ds-btn-ghost { background: transparent; color: var(--ds-color-muted); }',
    '.ds-field { display: grid; gap: var(--ds-space-2); }',
    '.ds-label { color: var(--ds-color-text); font-size: var(--ds-font-size-caption); font-weight: var(--ds-font-weight-medium); }',
    '.ds-input, .ds-select, .ds-textarea { width: 100%; border: 1px solid var(--ds-color-border); border-radius: var(--ds-radius-sm); background: var(--ds-color-surface); color: var(--ds-color-text); font: inherit; font-size: var(--ds-font-size-body); outline: none; transition: border-color 160ms ease, box-shadow 160ms ease; }',
    '.ds-input, .ds-select { height: var(--ds-control-height); padding: 0 var(--ds-space-3); }',
    '.ds-textarea { min-height: 104px; padding: var(--ds-space-3); resize: vertical; }',
    '.ds-input:focus, .ds-select:focus, .ds-textarea:focus { border-color: var(--ds-color-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ds-color-primary) 16%, transparent); }',
    '.ds-badge { display: inline-flex; min-height: 24px; align-items: center; border: 1px solid var(--ds-color-border); border-radius: 999px; background: color-mix(in srgb, var(--ds-color-primary) 8%, var(--ds-color-surface)); color: var(--ds-color-primary); padding: 0 var(--ds-space-2); font-size: var(--ds-font-size-caption); font-weight: var(--ds-font-weight-medium); }',
    '.ds-tabs { display: inline-flex; border: 1px solid var(--ds-color-border); border-radius: var(--ds-radius-md); background: var(--ds-color-surface); padding: 3px; }',
    '.ds-tab { min-height: 32px; border: 0; border-radius: var(--ds-radius-sm); background: transparent; color: var(--ds-color-muted); padding: 0 var(--ds-space-3); font: inherit; font-size: var(--ds-font-size-caption); font-weight: var(--ds-font-weight-medium); }',
    '.ds-tab[aria-selected="true"] { background: var(--ds-color-primary); color: #fff; }',
    '.ds-modal { width: min(440px, calc(100% - 32px)); border: 1px solid var(--ds-color-border); border-radius: var(--ds-radius-lg); background: var(--ds-color-surface); box-shadow: var(--ds-shadow-md); padding: var(--ds-space-5); }',
    '.ds-dropdown { min-width: 220px; border: 1px solid var(--ds-color-border); border-radius: var(--ds-radius-md); background: var(--ds-color-surface); box-shadow: var(--ds-shadow-md); padding: var(--ds-space-2); }',
    '.ds-dropdown-item { display: flex; min-height: 34px; align-items: center; border-radius: var(--ds-radius-sm); color: var(--ds-color-text); padding: 0 var(--ds-space-3); text-decoration: none; }',
    '.ds-dropdown-item:hover { background: color-mix(in srgb, var(--ds-color-primary) 8%, transparent); }',
    '.ds-icon { width: var(--ds-icon-size-md); height: var(--ds-icon-size-md); display: inline-block; color: currentColor; }',
    '',
    profile.components?.length
      ? `/* Component evidence: ${cssComment(profile.components.map((component) => `${component.name}: ${component.description}`).join('; '))} */`
      : '',
    profile.layoutPatterns ? `/* Layout evidence: ${cssComment(profile.layoutPatterns)} */` : '',
    '',
  ].filter((line) => line !== '').join('\n');
}

function renderComponentsHtml(profile: DesignProfile): string {
  const componentNames = profile.components?.map((component) => component.name).join(', ') || 'Buttons, forms, cards, badges, tabs, modals, dropdowns';
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    '  <title>Design system kit</title>',
    '  <link rel="stylesheet" href="../styles.css" />',
    '</head>',
    '<body class="ds-page">',
    '  <main class="ds-container ds-stack" style="padding: 48px 0;">',
    '    <header class="ds-stack">',
    '      <span class="ds-badge">Repository kit</span>',
    '      <h1 class="ds-title">Design system kit</h1>',
    `      <p class="ds-body">Captured components: ${escapeHtml(componentNames)}.</p>`,
    '    </header>',
    '    <section class="ds-card ds-stack" aria-label="Buttons">',
    '      <h2 class="ds-title">Buttons</h2>',
    '      <div class="ds-row">',
    '        <button class="ds-btn ds-btn-primary">Primary action</button>',
    '        <button class="ds-btn ds-btn-secondary">Secondary</button>',
    '        <button class="ds-btn ds-btn-ghost">Ghost</button>',
    '      </div>',
    '    </section>',
    '    <section class="ds-card ds-stack" aria-label="Form controls">',
    '      <h2 class="ds-title">Form controls</h2>',
    '      <label class="ds-field"><span class="ds-label">Email</span><input class="ds-input" placeholder="name@example.com" /></label>',
    '      <label class="ds-field"><span class="ds-label">Role</span><select class="ds-select"><option>Admin</option><option>Member</option></select></label>',
    '    </section>',
    '    <section class="ds-card ds-stack" aria-label="Navigation and overlays">',
    '      <h2 class="ds-title">Navigation and overlays</h2>',
    '      <div class="ds-tabs"><button class="ds-tab" aria-selected="true">Overview</button><button class="ds-tab">Details</button></div>',
    '      <div class="ds-dropdown"><a class="ds-dropdown-item" href="#">Dropdown item</a><a class="ds-dropdown-item" href="#">Another item</a></div>',
    '    </section>',
    '  </main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

function renderSystemManifest(profile: DesignProfile): string {
  return `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: 'repository-analysis',
    files: ['system/tokens.css', 'system/components.css', 'system/components.html'],
    foundations: {
      colors: profile.colors,
      typography: profile.typography ?? null,
      spacing: profile.spacing ?? null,
      iconography: profile.iconography ?? null,
      layoutPatterns: profile.layoutPatterns ?? null,
    },
    components: profile.components ?? [],
    usage: [
      'Read this manifest, system/tokens.css, system/components.css, and system/components.html before creating design pages.',
      'Use ds-* component classes and token variables before inventing new CSS.',
      'Only add new component classes when the requested design needs a pattern not represented in this kit.',
    ],
  }, null, 2)}\n`;
}

function seedManifest(): string {
  return `${JSON.stringify({ designs: [] }, null, 2)}\n`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function seedDashboardHtml(meta: WorkspaceSeedMeta = {}): string {
  const repoName = meta.sourceRepoName?.trim();
  const workspaceName = meta.workspaceName?.trim();
  const title = repoName
    ? `${repoName} design dashboard`
    : workspaceName
      ? `${workspaceName} design dashboard`
      : 'Design dashboard';
  const eyebrow = repoName ? `Repository: ${repoName}` : workspaceName ? `Workspace: ${workspaceName}` : 'Design workspace';
  const intro = repoName
    ? 'A focused preview of the design groups created for this repository.'
    : 'A focused preview of the design groups created for this workspace.';
  const emptyDescription = repoName
    ? 'Generated designs for this repository will appear here.'
    : 'Generated designs for this workspace will appear here.';
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    `  <title>${escapeHtml(title)}</title>`,
    '  <link rel="stylesheet" href="styles.css" />',
    '</head>',
    '<body>',
    '  <main class="studio-dashboard">',
    '    <header class="studio-dashboard__header">',
    `      <p class="studio-dashboard__eyebrow">${escapeHtml(eyebrow)}</p>`,
    `      <h1>${escapeHtml(title)}</h1>`,
    `      <p class="studio-dashboard__intro">${escapeHtml(intro)}</p>`,
    '    </header>',
    '    <section class="studio-design-grid" aria-label="Design groups" data-design-grid>',
    '      <div class="studio-empty-state" data-dashboard-empty>',
    '        <div class="studio-empty-state__content">',
    '          <h2>No design groups yet</h2>',
    `          <p>${escapeHtml(emptyDescription)}</p>`,
    '        </div>',
    '      </div>',
    '    </section>',
    '    <footer class="studio-dashboard__footer">',
    '      <span><strong>Allen Design Studio</strong></span>',
    '      <span>© askallen.build</span>',
    '    </footer>',
    '  </main>',
    '  <script>',
    '    (() => {',
    "      const grid = document.querySelector('[data-design-grid]');",
    "      const emptyState = document.querySelector('[data-dashboard-empty]');",
    '',
    '      function previewMarkup(index) {',
    '        const variant = index % 3;',
    '        if (variant === 0) {',
    '          return `',
    '            <div class="studio-design-card__preview studio-preview-login">',
    '              <div class="studio-preview-form">',
    '                <div class="studio-preview-line is-dark" style="width: 58%;"></div>',
    '                <div class="studio-preview-input"></div>',
    '                <div class="studio-preview-input"></div>',
    '                <div class="studio-preview-pill"></div>',
    '              </div>',
    '            </div>`;',
    '        }',
    '        if (variant === 1) {',
    '          return `',
    '            <div class="studio-design-card__preview studio-preview-landing">',
    '              <div class="studio-preview-stack">',
    '                <div class="studio-preview-line is-dark" style="width: 78%;"></div>',
    '                <div class="studio-preview-line" style="width: 92%;"></div>',
    '                <div class="studio-preview-line" style="width: 64%;"></div>',
    '                <div class="studio-preview-pill" style="width: 76px;"></div>',
    '              </div>',
    '              <div class="studio-preview-block"></div>',
    '            </div>`;',
    '        }',
    '        return `',
    '          <div class="studio-design-card__preview studio-preview-billing">',
    '            <div class="studio-preview-line is-dark" style="width: 46%;"></div>',
    '            <div class="studio-preview-mini-grid">',
    '              <div class="studio-preview-block"></div>',
    '              <div class="studio-preview-block"></div>',
    '            </div>',
    '            <div class="studio-preview-line" style="width: 96%;"></div>',
    '            <div class="studio-preview-line" style="width: 82%;"></div>',
    '          </div>`;',
    '      }',
    '',
    '      function humanizeSlug(slug) {',
    "        return String(slug || 'Design group').replace(/[-_]+/g, ' ').replace(/\\b\\w/g, (letter) => letter.toUpperCase());",
    '      }',
    '',
    '      function pageCountLabel(design) {',
    '        const count = Array.isArray(design.variations) && design.variations.length > 0 ? design.variations.length : 1;',
    "        return `${count} ${count === 1 ? 'page' : 'pages'}`;",
    '      }',
    '',
    '      function createCard(design, index) {',
    "        const card = document.createElement('a');",
    "        card.className = 'studio-design-card';",
    "        card.href = design.entry || `designs/${design.slug || 'design'}/index.html`;",
    '        card.innerHTML = `${previewMarkup(index)}',
    '          <div class="studio-design-card__body">',
    '            <div class="studio-design-card__head">',
    '              <div>',
    '                <h2></h2>',
    '                <p></p>',
    '              </div>',
    '            </div>',
    '            <div class="studio-card-summary">',
    '              <span data-page-count></span>',
    '              <span class="studio-card-dot"></span>',
    '              <span data-design-type></span>',
    '            </div>',
    '          </div>`;',
    "        card.querySelector('h2').textContent = design.title || humanizeSlug(design.slug);",
    "        card.querySelector('p').textContent = design.description || 'Design group for this repository.';",
    "        card.querySelector('[data-page-count]').textContent = pageCountLabel(design);",
    "        card.querySelector('[data-design-type]').textContent = humanizeSlug(design.slug);",
    '        return card;',
    '      }',
    '',
    '      function renderDashboard(manifest) {',
    '        const designs = Array.isArray(manifest?.designs) ? manifest.designs : [];',
    '        if (!designs.length) return;',
    '        emptyState?.remove();',
    '        designs.forEach((design, index) => grid.appendChild(createCard(design, index)));',
    '      }',
    '',
    "      fetch('designs/manifest.json', { cache: 'no-store' })",
    '        .then((response) => (response.ok ? response.json() : { designs: [] }))',
    '        .then(renderDashboard)',
    '        .catch(() => {});',
    '    })();',
    '  </script>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

export interface WorkspaceFile {
  path: string; // relative
  size: number;
  isHtml: boolean;
}

export interface WorkspaceFileContent {
  path: string;
  size: number;
  content: string;
  truncated: boolean;
}

/** Flat, recursive listing of the workspace's files (bounded). */
export async function listWorkspaceFiles(workspaceId: string): Promise<WorkspaceFile[]> {
  const root = workspaceDir(workspaceId);
  const out: WorkspaceFile[] = [];
  async function walk(dir: string, rel: string, depth: number): Promise<void> {
    if (depth > 6 || out.length > 500) return;
    let entries: import('node:fs').Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (IGNORE.has(e.name)) continue;
      const abs = join(dir, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { await walk(abs, relPath, depth + 1); }
      else if (e.isFile()) {
        const st = await fs.stat(abs).catch(() => null);
        out.push({ path: relPath, size: st?.size ?? 0, isHtml: /\.html?$/i.test(e.name) });
      }
    }
  }
  await walk(root, '', 0);
  return out.sort((a, b) => (a.path === 'index.html' ? -1 : b.path === 'index.html' ? 1 : a.path.localeCompare(b.path)));
}

export async function readWorkspaceFile(workspaceId: string, requestedPath: string, maxBytes = 512 * 1024): Promise<WorkspaceFileContent> {
  const root = resolve(workspaceDir(workspaceId));
  const safe = normalize(requestedPath || '').replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  if (!safe || safe === '.') throw new Error('file path required');
  const full = resolve(root, safe);
  const rel = relative(root, full);
  if (rel.startsWith('..') || rel === '' || rel.includes('..\\')) throw new Error('invalid file path');
  const stat = await fs.stat(full);
  if (!stat.isFile()) throw new Error('not a file');
  const handle = await fs.open(full, 'r');
  try {
    const limit = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(limit);
    await handle.read(buffer, 0, limit, 0);
    return {
      path: rel.replace(/\\/g, '/'),
      size: stat.size,
      content: buffer.toString('utf8'),
      truncated: stat.size > maxBytes,
    };
  } finally {
    await handle.close();
  }
}

function mimeForFile(filename: string): string {
  const ext = extname(filename).toLowerCase();
  const map: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  };
  return map[ext] ?? 'text/plain; charset=utf-8';
}

/**
 * Express handler for `${DSTUDIO_SITE_PREFIX}/:workspaceId/:file(*)?` — serves the
 * workspace design-system folder as a static site (relative links + shared CSS
 * resolve). Unauthenticated, scoped + path-traversal guarded.
 */
export function createWorkspaceSiteHandler() {
  return async (req: Request, res: Response): Promise<void> => {
    const { workspaceId } = req.params as { workspaceId: string };
    const requested = (req.params as Record<string, string>).file?.trim() || 'index.html';
    const root = workspaceDir(workspaceId);
    const safe = normalize(requested).replace(/^(\.\.[/\\])+/, '').replace(/^\/+/, '');
    const full = join(root, safe);
    if (!full.startsWith(root)) { res.status(403).send('Forbidden'); return; }
    try {
      const content = await fs.readFile(full);
      res.setHeader('Content-Type', mimeForFile(full));
      res.setHeader('Cache-Control', 'no-store');
      res.send(content);
    } catch {
      res.status(404).send('Not found');
    }
  };
}

function safeName(name: string): string {
  return name.replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'design-system';
}

export interface ExportResult { dir: string; files: string[] }

// ── Repo context materialization ─────────────────────────────────────────────

export interface RepoContextData {
  productSummary: string;
  routes: { path: string; description: string }[];
  keyPages: { file: string; purpose: string }[];
  importantFiles: { file: string; purpose: string }[];
  componentInventory: { name: string; purpose: string }[];
  generatedAt: string;
}

/**
 * Write repo product/route/component context into the workspace `system/` folder.
 * Always overwrites — these files are refreshed on every analyze/refresh call.
 */
export async function materializeRepoContext(workspaceId: string, data: RepoContextData): Promise<string> {
  const systemDir = join(workspaceDir(workspaceId), 'system');
  await fs.mkdir(systemDir, { recursive: true });

  // repo-context.json — full structured data
  await fs.writeFile(
    join(systemDir, 'repo-context.json'),
    `${JSON.stringify({ ...data, generatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );

  // repo-context.md — human-readable summary for the designer persona
  const md = [
    '# Repository Context',
    '',
    `_Generated: ${new Date().toISOString()}_`,
    '',
    '## Product Summary',
    '',
    data.productSummary || '_Not determined._',
    '',
    '## Route Map',
    '',
    data.routes.length
      ? data.routes.map((r) => `- **${r.path}** — ${r.description}`).join('\n')
      : '_No routes discovered._',
    '',
    '## Key Pages / Screens',
    '',
    data.keyPages.length
      ? data.keyPages.map((p) => `- \`${p.file}\` — ${p.purpose}`).join('\n')
      : '_None discovered._',
    '',
    '## Important Files',
    '',
    data.importantFiles.length
      ? data.importantFiles.map((f) => `- \`${f.file}\` — ${f.purpose}`).join('\n')
      : '_None discovered._',
    '',
    '## Component Inventory',
    '',
    data.componentInventory.length
      ? data.componentInventory.map((c) => `- **${c.name}** — ${c.purpose}`).join('\n')
      : '_None discovered._',
    '',
  ].join('\n');
  await fs.writeFile(join(systemDir, 'repo-context.md'), md, 'utf8');

  // route-map.json — standalone route list for quick lookup
  await fs.writeFile(
    join(systemDir, 'route-map.json'),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), routes: data.routes }, null, 2)}\n`,
    'utf8',
  );

  // important-files.json — combined key pages + important files
  await fs.writeFile(
    join(systemDir, 'important-files.json'),
    `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      keyPages: data.keyPages,
      importantFiles: data.importantFiles,
      componentInventory: data.componentInventory,
    }, null, 2)}\n`,
    'utf8',
  );

  return systemDir;
}

async function listExportedFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = join(dir, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(abs, relPath);
      else if (e.isFile()) out.push(relPath);
    }
  }
  await walk(root, '');
  return out.sort((a, b) => a.localeCompare(b));
}

/** Copy the workspace design system into a standalone, offline-openable folder. */
export async function exportWorkspace(workspaceId: string, opts: { name?: string; destinationDir?: string }): Promise<ExportResult> {
  const src = workspaceDir(workspaceId);
  const folder = `${safeName(opts.name ?? 'design-system')}`;
  const base = opts.destinationDir || join(homedir(), 'Downloads', 'Allen Design Studio');
  const dest = join(base, folder);
  await fs.mkdir(dest, { recursive: true });
  await fs.cp(src, dest, { recursive: true });
  await fs.writeFile(
    join(dest, 'README.txt'),
    'Allen Design Studio export\n\nOpen index.html in any browser. No internet or install required.\n',
    'utf8',
  );
  const files = await listExportedFiles(dest);
  return { dir: dest, files };
}
