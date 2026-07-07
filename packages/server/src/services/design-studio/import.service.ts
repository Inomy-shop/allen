/**
 * Allen Design Studio — Import designs into a workspace.
 *
 * Sources:
 *  - another studio workspace's design-system folder (same Allen instance,
 *    typically another user's workspace on the same repo), or
 *  - a previously exported folder on disk (full workspace export, a version
 *    bundle with `allen-design.json`, or any folder of self-contained HTML).
 *
 * Rules (deliberately deterministic — no style merging):
 *  - Imports are ADDITIVE and SELF-CONTAINED. The source is never mutated and
 *    the target's shared files are never overwritten (except explicit adoption
 *    into a fresh gallery).
 *  - Design folders never merge: name collisions rename the incoming folder
 *    (`checkout-page` → `checkout-page-2`). Cross-design links between designs
 *    imported in the same batch are remapped through those renames.
 *  - Every asset a design references OUTSIDE its own folder (shared
 *    stylesheets like `styles.css` or persona-created `v6.css`, system kit
 *    files, images, fonts) is resolved per reference: byte-identical at the
 *    same path in the target → reuse the target's copy; otherwise the file is
 *    vendored into the design's `_imported/` folder and the reference is
 *    rewritten. Vendored CSS is scanned recursively so its own url()/@import
 *    chains come along. Navigation links to HTML pages are never vendored.
 *  - The reported `stylesMode` summarizes the shared-stylesheet outcome:
 *      adopted        — target gallery was fresh: source system taken wholesale
 *      shared         — byte-identical style files: target's copies reused
 *      snapshot       — divergent styles: vendored per design as above
 *      self_contained — bundle screens carry inline CSS; nothing to resolve
 *  - Every imported design records provenance in `_imported/manifest.json`.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, resolve, relative, sep } from 'node:path';
import { ensureWorkspaceDir, workspaceDir } from './workspace-fs.js';
import type { DesignStudioStore } from './store.service.js';
import type { DesignWorkspace, GreenfieldBrief, WorkspaceKind } from './types.js';

export type ImportStylesMode = 'adopted' | 'shared' | 'snapshot' | 'self_contained';

export interface ImportedDesign {
  /** Folder name in the source. */
  name: string;
  /** Folder name in the target (differs when renamed on collision). */
  as: string;
  renamed: boolean;
  stylesMode: ImportStylesMode;
}

export interface ImportReport {
  sourceType: 'workspace' | 'bundle';
  stylesMode: ImportStylesMode;
  imported: ImportedDesign[];
  skipped: { name: string; reason: string }[];
}

export interface ImportSourceSummary {
  _id: string;
  name: string;
  kind: WorkspaceKind;
  ownerUserId: string | null;
  designCount: number;
  updatedAt: Date;
}

const STYLE_FILES = ['styles.css', 'system/tokens.css', 'system/components.css'] as const;

// ── Small helpers ─────────────────────────────────────────────────────────────

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

async function pathExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function hashFile(p: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(p);
    return createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

/** Combined fingerprint of the shared style files (null when none exist). */
async function styleFingerprint(root: string): Promise<string | null> {
  const hashes: string[] = [];
  for (const file of STYLE_FILES) {
    hashes.push((await hashFile(join(root, file))) ?? 'absent');
  }
  return hashes.every((h) => h === 'absent') ? null : hashes.join('|');
}

async function listDesignFolders(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(join(root, 'designs'), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

export function uniqueFolderName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function safeFolderName(name: string): string {
  return name.replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'imported-design';
}

function humanize(slug: string): string {
  return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

// ── Escaping-reference vendoring ──────────────────────────────────────────────

/** `"../../v6.css"`, `'../x.png'`, or `url(../../styles.css)` — any relative ref that climbs out of the file's folder. */
const ESCAPING_REF = /(["'(])((?:\.\.\/)+)([^"'()?#\s]+)/g;

/** url(...) and @import "..." references inside a CSS file. */
const CSS_REF = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^"')]+))\s*\)|@import\s+(?:"([^"]+)"|'([^']+)')/g;

function isRemoteRef(ref: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//') || ref.startsWith('/') || ref.startsWith('#');
}

interface VendorContext {
  /** Directory the design's `../` hops climb toward (the source workspace root, or its equivalent for bundles). */
  escapeRoot: string;
  /** The design's original folder — references resolve from here. */
  sourceDesignDir: string;
  /** The copied design folder in the target workspace. */
  designDir: string;
  targetRoot: string;
  /** Batch renames (source design name → target folder name), workspace-shaped imports only. */
  renames?: Map<string, string>;
  /** This design's source/target names, workspace-shaped imports only. */
  origName?: string;
  newName?: string;
}

/** Copy one referenced file into `<design>/_imported/`, following CSS url()/@import chains. */
async function vendorFile(absSource: string, vendorRel: string, ctx: VendorContext, vendored: Set<string>): Promise<void> {
  if (vendored.has(vendorRel)) return;
  vendored.add(vendorRel);
  const dest = join(ctx.designDir, '_imported', vendorRel);
  await fs.mkdir(dirname(dest), { recursive: true });
  await fs.copyFile(absSource, dest);

  if (!/\.css$/i.test(vendorRel)) return;
  // Relative refs inside vendored CSS keep working because the `_imported/`
  // tree mirrors the escape root — vendor what they point at too.
  const content = await fs.readFile(absSource, 'utf8');
  for (const match of content.matchAll(CSS_REF)) {
    const ref = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? '').trim();
    if (!ref || isRemoteRef(ref)) continue;
    const resolved = resolve(dirname(absSource), ref.split('?')[0].split('#')[0]);
    const rel = toPosix(relative(ctx.escapeRoot, resolved));
    if (rel.startsWith('..')) continue;
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat?.isFile()) continue;
    await vendorFile(resolved, rel, ctx, vendored);
  }
}

/**
 * Resolve every reference that escapes the copied design folder:
 *  - own-folder refs and links to HTML pages → untouched
 *  - links into sibling designs renamed in this batch → remapped
 *  - assets byte-identical at the same target-root path → untouched (shared)
 *  - everything else that exists in the source → vendored + rewritten
 */
async function vendorEscapingAssets(ctx: VendorContext): Promise<void> {
  const vendored = new Set<string>();

  async function processFile(fileRel: string): Promise<void> {
    const targetAbs = join(ctx.designDir, fileRel);
    const sourceAbs = join(ctx.sourceDesignDir, fileRel);
    const depth = fileRel.split('/').length - 1;
    const content = await fs.readFile(targetAbs, 'utf8');

    const replacements = new Map<string, string>();
    for (const match of content.matchAll(ESCAPING_REF)) {
      const [full, quote, hops, refPath] = match;
      if (replacements.has(full) || isRemoteRef(refPath)) continue;

      const resolved = resolve(dirname(sourceAbs), `${hops}${refPath.split('?')[0].split('#')[0]}`);
      const escapeRel = toPosix(relative(ctx.escapeRoot, resolved));
      if (escapeRel.startsWith('..')) continue; // climbs past the workspace root
      if (!toPosix(relative(ctx.sourceDesignDir, resolved)).startsWith('..')) continue; // stays inside this design

      const designLink = /^designs\/([^/]+)\/(.+)$/.exec(escapeRel);
      if (designLink) {
        // Navigation into a sibling design: only the batch-rename needs fixing.
        const renamed = ctx.renames?.get(designLink[1]);
        if (renamed && ctx.newName && renamed !== designLink[1]) {
          const fromDir = posix.join('designs', ctx.newName, posix.dirname(fileRel) === '.' ? '' : posix.dirname(fileRel));
          replacements.set(full, `${quote}${posix.relative(fromDir, posix.join('designs', renamed, designLink[2]))}`);
        }
        continue;
      }
      if (/\.html?$/i.test(escapeRel)) continue; // dashboard/page navigation, never vendored

      const sourceHash = await hashFile(resolved);
      if (sourceHash === null) continue; // dangling in the source too
      if (sourceHash === await hashFile(join(ctx.targetRoot, escapeRel))) continue; // identical shared file at target

      await vendorFile(resolved, escapeRel, ctx, vendored);
      replacements.set(full, `${quote}${'../'.repeat(depth)}_imported/${escapeRel}`);
    }

    if (replacements.size === 0) return;
    await fs.writeFile(targetAbs, content.replace(ESCAPING_REF, (full) => replacements.get(full) ?? full), 'utf8');
  }

  async function walk(dir: string, rel: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === '_imported') continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(join(dir, e.name), childRel);
      else if (e.isFile() && /\.(html?|css)$/i.test(e.name)) await processFile(childRel);
    }
  }
  await walk(ctx.designDir, '');
}

interface Provenance {
  importedAt: string;
  source: { type: 'workspace' | 'bundle'; workspaceId?: string; dir?: string };
  renamedFrom?: string;
  stylesMode: ImportStylesMode;
}

async function writeProvenance(designDir: string, provenance: Provenance): Promise<void> {
  const importedDir = join(designDir, '_imported');
  await fs.mkdir(importedDir, { recursive: true });
  await fs.writeFile(join(importedDir, 'manifest.json'), `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
}

// ── designs/manifest.json merging (feeds the dashboard cards) ────────────────

interface ManifestDesign {
  slug?: string;
  title?: string;
  description?: string;
  entry?: string;
  variations?: unknown[];
  importedFrom?: string;
  [key: string]: unknown;
}

async function readDesignsManifest(root: string): Promise<{ designs: ManifestDesign[] }> {
  try {
    const raw = await fs.readFile(join(root, 'designs', 'manifest.json'), 'utf8');
    const parsed = JSON.parse(raw) as { designs?: ManifestDesign[] };
    return { designs: Array.isArray(parsed.designs) ? parsed.designs : [] };
  } catch {
    return { designs: [] };
  }
}

async function writeDesignsManifest(root: string, manifest: { designs: ManifestDesign[] }): Promise<void> {
  await fs.mkdir(join(root, 'designs'), { recursive: true });
  await fs.writeFile(join(root, 'designs', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function manifestEntryFor(
  sourceManifest: { designs: ManifestDesign[] },
  originalName: string,
  newName: string,
  sourceLabel: string,
): ManifestDesign {
  const src = sourceManifest.designs.find((d) => d.slug === originalName);
  const entry: ManifestDesign = src
    ? { ...src }
    : { slug: originalName, title: humanize(originalName), description: 'Imported design group.' };
  entry.slug = newName;
  entry.entry = typeof entry.entry === 'string' && entry.entry.includes(`designs/${originalName}/`)
    ? entry.entry.replace(`designs/${originalName}/`, `designs/${newName}/`)
    : `designs/${newName}/index.html`;
  entry.importedFrom = sourceLabel;
  return entry;
}

// ── Import sources listing ────────────────────────────────────────────────────

/**
 * Other studio workspaces on the same source repo (across owners — sharing
 * designs between users on one Allen instance is the point of import).
 */
async function summarizeSource(ws: DesignWorkspace): Promise<ImportSourceSummary> {
  return {
    _id: String(ws._id),
    name: ws.name,
    kind: ws.kind,
    ownerUserId: ws.ownerUserId ?? null,
    designCount: (await listDesignFolders(workspaceDir(String(ws._id)))).length,
    updatedAt: ws.updatedAt,
  };
}

/** Every workspace with at least one design — sources for "import as new workspace". */
export async function listAllImportSources(store: DesignStudioStore): Promise<ImportSourceSummary[]> {
  const out: ImportSourceSummary[] = [];
  for (const ws of await store.listWorkspaces()) {
    const summary = await summarizeSource(ws);
    if (summary.designCount > 0) out.push(summary);
  }
  return out;
}

// ── Import as a NEW workspace (fork instead of merge) ────────────────────────

export interface ImportAsNewWorkspaceOptions {
  name?: string;
  sourceWorkspaceId?: string;
  sourceDir?: string;
  ownerUserId?: string | null;
  /**
   * Registered repo to link the new workspace to. When importing from a
   * workspace this defaults to the source's repo link; for bundle imports the
   * caller resolves it from an explicit repoId.
   */
  repo?: { id: string; path?: string; name?: string };
}

export interface ImportAsNewWorkspaceResult {
  workspace: DesignWorkspace;
  report: ImportReport;
}

/**
 * Create a fresh greenfield workspace and import into it. The empty gallery
 * guarantees `adopted` mode — the source design system is taken wholesale.
 * The brief is synthesized and confirmed so the workspace is immediately
 * usable for design chats (no discovery interview for imported content).
 * Rolls the workspace back if the import fails.
 */
export async function importAsNewWorkspace(store: DesignStudioStore, opts: ImportAsNewWorkspaceOptions): Promise<ImportAsNewWorkspaceResult> {
  let sourceName: string;
  let sourceWorkspace: DesignWorkspace | null = null;
  if (opts.sourceWorkspaceId) {
    sourceWorkspace = await store.getWorkspace(opts.sourceWorkspaceId);
    if (!sourceWorkspace) throw new Error('source workspace not found');
    sourceName = sourceWorkspace.name;
  } else if (opts.sourceDir) {
    sourceName = basename(resolve(opts.sourceDir));
  } else {
    throw new Error('sourceWorkspaceId or sourceDir required');
  }

  // Repo link: explicit repo wins; otherwise inherit from the source workspace.
  // The workspace stays greenfield-kind so the one-repo-workspace-per-user rule
  // is untouched, but the repo fields give design chats the read-only
  // source-repo pointer and preserve where these designs came from.
  const repoId = opts.repo?.id ?? sourceWorkspace?.sourceRepoId;
  const repoPath = opts.repo?.path ?? sourceWorkspace?.sourceRepoPath;

  const name = opts.name?.trim() || `${sourceName} (imported)`;
  const workspace = await store.createWorkspace({
    kind: 'greenfield',
    name,
    sourceRepoId: repoId,
    sourceRepoPath: repoPath,
    ownerUserId: opts.ownerUserId ?? null,
  });
  const id = String(workspace._id);
  try {
    // Seed the gallery scaffolding (dashboard + manifest + repo pointer)
    // before importing; the empty gallery makes the import adopt the source
    // design system wholesale.
    await ensureWorkspaceDir(id, undefined, {
      workspaceName: name,
      sourceRepoId: repoId,
      sourceRepoPath: repoPath,
      sourceRepoName: opts.repo?.name,
    });
    const report = await importDesigns({ targetWorkspaceId: id, sourceWorkspaceId: opts.sourceWorkspaceId, sourceDir: opts.sourceDir });

    // Carry the source's analyzed design profile when there is one — it is the
    // richer description of the system the imported designs are built on.
    if (sourceWorkspace?.profile) {
      await store.setProfile(id, sourceWorkspace.profile, 'confirmed');
    }
    const brief: GreenfieldBrief = {
      product: `Imported design gallery: ${sourceName}`,
      audience: 'Same audience as the imported designs.',
      feel: 'Follows the imported design system.',
      references: opts.sourceWorkspaceId ? `workspace:${opts.sourceWorkspaceId}` : `bundle:${resolve(opts.sourceDir!)}`,
      screens: report.imported.map((d) => d.as).join(', '),
      assumptions: ['Brief synthesized automatically when existing designs were imported into this new workspace.'],
    };
    const confirmed = await store.setGreenfieldBrief(id, brief, 'confirmed');
    return { workspace: confirmed ?? workspace, report };
  } catch (e) {
    await store.deleteWorkspace(id).catch(() => {});
    await fs.rm(workspaceDir(id), { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

// ── Import execution ──────────────────────────────────────────────────────────

export interface ImportOptions {
  targetWorkspaceId: string;
  sourceWorkspaceId?: string;
  /** Absolute path of an exported folder (workspace export or version bundle). */
  sourceDir?: string;
}

export async function importDesigns(opts: ImportOptions): Promise<ImportReport> {
  const targetRoot = workspaceDir(opts.targetWorkspaceId);

  let sourceRoot: string;
  let sourceLabel: string;
  let provenanceSource: Provenance['source'];
  if (opts.sourceWorkspaceId) {
    if (opts.sourceWorkspaceId === opts.targetWorkspaceId) throw new Error('cannot import a workspace into itself');
    sourceRoot = workspaceDir(opts.sourceWorkspaceId);
    sourceLabel = `workspace:${opts.sourceWorkspaceId}`;
    provenanceSource = { type: 'workspace', workspaceId: opts.sourceWorkspaceId };
  } else if (opts.sourceDir) {
    if (!isAbsolute(opts.sourceDir)) throw new Error('sourceDir must be an absolute path');
    sourceRoot = resolve(opts.sourceDir);
    sourceLabel = `bundle:${sourceRoot}`;
    provenanceSource = { type: 'bundle', dir: sourceRoot };
  } else {
    throw new Error('sourceWorkspaceId or sourceDir required');
  }

  if (resolve(sourceRoot) === resolve(targetRoot)) throw new Error('cannot import a workspace into itself');
  const sourceStat = await fs.stat(sourceRoot).catch(() => null);
  if (!sourceStat?.isDirectory()) {
    throw new Error(opts.sourceWorkspaceId ? 'source workspace has no designs yet' : 'sourceDir does not exist');
  }

  await fs.mkdir(join(targetRoot, 'designs'), { recursive: true });

  const workspaceShaped = await pathExists(join(sourceRoot, 'designs'));
  if (workspaceShaped) {
    return importFromWorkspaceFolder(sourceRoot, targetRoot, provenanceSource, sourceLabel);
  }
  return importBundleAsSingleDesign(sourceRoot, targetRoot, provenanceSource, sourceLabel);
}

async function importFromWorkspaceFolder(
  sourceRoot: string,
  targetRoot: string,
  provenanceSource: Provenance['source'],
  sourceLabel: string,
): Promise<ImportReport> {
  const sourceDesigns = await listDesignFolders(sourceRoot);
  if (sourceDesigns.length === 0) throw new Error('source has no designs to import');

  const taken = new Set(await listDesignFolders(targetRoot));
  const targetFresh = taken.size === 0;

  // Resolve the whole batch's renames up front so cross-design links can be remapped.
  const renames = new Map<string, string>();
  for (const name of sourceDesigns) {
    const as = uniqueFolderName(name, taken);
    taken.add(as);
    renames.set(name, as);
  }

  // Shared-stylesheet strategy, reported once for the whole import.
  const sourceFingerprint = await styleFingerprint(sourceRoot);
  const targetFingerprint = await styleFingerprint(targetRoot);
  let stylesMode: ImportStylesMode;
  if (sourceFingerprint === null || sourceFingerprint === targetFingerprint) {
    stylesMode = 'shared';
  } else if (targetFresh || targetFingerprint === null) {
    stylesMode = 'adopted';
  } else {
    stylesMode = 'snapshot';
  }

  if (stylesMode === 'adopted') {
    for (const file of STYLE_FILES) {
      const src = join(sourceRoot, file);
      if (!(await pathExists(src))) continue;
      const dest = join(targetRoot, file);
      await fs.mkdir(dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
    }
  }

  const sourceManifest = await readDesignsManifest(sourceRoot);
  const targetManifest = await readDesignsManifest(targetRoot);
  const imported: ImportedDesign[] = [];
  const skipped: { name: string; reason: string }[] = [];

  for (const name of sourceDesigns) {
    const as = renames.get(name)!;
    const destDir = join(targetRoot, 'designs', as);
    try {
      await fs.cp(join(sourceRoot, 'designs', name), destDir, { recursive: true });
      await vendorEscapingAssets({
        escapeRoot: sourceRoot,
        sourceDesignDir: join(sourceRoot, 'designs', name),
        designDir: destDir,
        targetRoot,
        renames,
        origName: name,
        newName: as,
      });
      await writeProvenance(destDir, {
        importedAt: new Date().toISOString(),
        source: provenanceSource,
        ...(as !== name ? { renamedFrom: name } : {}),
        stylesMode,
      });
      imported.push({ name, as, renamed: as !== name, stylesMode });
      targetManifest.designs.push(manifestEntryFor(sourceManifest, name, as, sourceLabel));
    } catch (e) {
      await fs.rm(destDir, { recursive: true, force: true }).catch(() => {});
      skipped.push({ name, reason: (e as Error).message });
    }
  }

  if (imported.length > 0) await writeDesignsManifest(targetRoot, targetManifest);
  if (imported.length === 0 && skipped.length > 0) {
    throw new Error(`import failed: ${skipped.map((s) => `${s.name} (${s.reason})`).join('; ')}`);
  }
  return { sourceType: provenanceSource.type, stylesMode, imported, skipped };
}

/** A version bundle / plain folder of screens → one design folder. */
async function importBundleAsSingleDesign(
  sourceRoot: string,
  targetRoot: string,
  provenanceSource: Provenance['source'],
  sourceLabel: string,
): Promise<ImportReport> {
  const entries = await fs.readdir(sourceRoot, { withFileTypes: true });
  const hasHtml = entries.some((e) => e.isFile() && /\.html?$/i.test(e.name));
  if (!hasHtml) throw new Error('sourceDir has no designs (expected a designs/ folder or HTML screens)');

  const name = safeFolderName(basename(sourceRoot));
  const taken = new Set(await listDesignFolders(targetRoot));
  const as = uniqueFolderName(name, taken);
  const destDir = join(targetRoot, 'designs', as);
  await fs.mkdir(destDir, { recursive: true });
  for (const e of entries) {
    if (e.name === 'README.txt') continue;
    await fs.cp(join(sourceRoot, e.name), join(destDir, e.name), { recursive: true });
  }

  // Version-export screens are self-contained; but a design folder picked
  // straight out of a workspace still references shared files two levels up —
  // vendor whatever such references point at.
  await vendorEscapingAssets({
    escapeRoot: resolve(sourceRoot, '..', '..'),
    sourceDesignDir: sourceRoot,
    designDir: destDir,
    targetRoot,
  });

  const stylesMode: ImportStylesMode = 'self_contained';
  await writeProvenance(destDir, {
    importedAt: new Date().toISOString(),
    source: provenanceSource,
    ...(as !== name ? { renamedFrom: name } : {}),
    stylesMode,
  });

  // Entry point: index.html when present, otherwise the first screen.
  const htmlFiles = entries.filter((e) => e.isFile() && /\.html?$/i.test(e.name)).map((e) => e.name).sort();
  const entryFile = htmlFiles.find((f) => /^index\.html?$/i.test(f)) ?? htmlFiles[0];

  const targetManifest = await readDesignsManifest(targetRoot);
  targetManifest.designs.push({
    slug: as,
    title: humanize(as),
    description: 'Imported design bundle.',
    entry: `designs/${as}/${entryFile}`,
    importedFrom: sourceLabel,
  });
  await writeDesignsManifest(targetRoot, targetManifest);

  return {
    sourceType: provenanceSource.type,
    stylesMode,
    imported: [{ name, as, renamed: as !== name, stylesMode }],
    skipped: [],
  };
}
