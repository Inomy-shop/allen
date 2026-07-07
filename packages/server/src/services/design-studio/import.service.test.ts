/**
 * Design import — cross-workspace and bundle imports.
 *
 *  - Additive, never-overwrite semantics: colliding design folders rename
 *  - Shared-style resolution: adopted (fresh target), shared (identical),
 *    snapshot (divergent → vendored `_imported/` styles + rewritten refs)
 *  - Bundle import: version-export folders become one design group
 *  - Provenance + designs/manifest.json merging for the dashboard
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Point Allen-managed storage at a throwaway dir.
const TMP = join(tmpdir(), `dstudio-import-test-${Date.now()}`);
vi.mock('@allen/engine', async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>).catch(() => ({}));
  return { ...actual, resolveAllenHome: () => TMP };
});

import { importDesigns, listAllImportSources, uniqueFolderName } from './import.service.js';
import { workspaceDir } from './workspace-fs.js';
import type { DesignStudioStore } from './store.service.js';

beforeAll(async () => {
  await fs.mkdir(TMP, { recursive: true });
});
afterAll(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

let uniq = 0;
function wsId(): string {
  return `ws-import-${++uniq}`;
}

async function seedWorkspace(id: string, opts: {
  styles?: string;
  designs?: Record<string, Record<string, string>>;
  manifest?: { designs: Record<string, unknown>[] };
  systemCss?: { tokens?: string; components?: string };
}): Promise<string> {
  const root = workspaceDir(id);
  await fs.mkdir(join(root, 'designs'), { recursive: true });
  if (opts.styles !== undefined) await fs.writeFile(join(root, 'styles.css'), opts.styles, 'utf8');
  if (opts.systemCss) {
    await fs.mkdir(join(root, 'system'), { recursive: true });
    if (opts.systemCss.tokens !== undefined) await fs.writeFile(join(root, 'system', 'tokens.css'), opts.systemCss.tokens, 'utf8');
    if (opts.systemCss.components !== undefined) await fs.writeFile(join(root, 'system', 'components.css'), opts.systemCss.components, 'utf8');
  }
  for (const [design, files] of Object.entries(opts.designs ?? {})) {
    const dir = join(root, 'designs', design);
    await fs.mkdir(dir, { recursive: true });
    for (const [file, content] of Object.entries(files)) {
      await fs.mkdir(join(dir, file, '..'), { recursive: true });
      await fs.writeFile(join(dir, file), content, 'utf8');
    }
  }
  if (opts.manifest) {
    await fs.writeFile(join(root, 'designs', 'manifest.json'), JSON.stringify(opts.manifest, null, 2), 'utf8');
  }
  return root;
}

async function readJson(path: string): Promise<any> {
  return JSON.parse(await fs.readFile(path, 'utf8'));
}

describe('helpers', () => {
  it('uniqueFolderName renames on collision with numeric suffixes', () => {
    expect(uniqueFolderName('checkout', new Set())).toBe('checkout');
    expect(uniqueFolderName('checkout', new Set(['checkout']))).toBe('checkout-2');
    expect(uniqueFolderName('checkout', new Set(['checkout', 'checkout-2']))).toBe('checkout-3');
  });

});

describe('workspace → workspace import', () => {
  it('adopts the source design system into a fresh target', async () => {
    const source = wsId();
    const target = wsId();
    await seedWorkspace(source, {
      styles: ':root { --color-primary: #ff0000; }',
      designs: { 'checkout-page': { 'index.html': '<html><link href="../../styles.css"></html>' } },
      manifest: { designs: [{ slug: 'checkout-page', title: 'Checkout', entry: 'designs/checkout-page/index.html' }] },
    });
    await seedWorkspace(target, { styles: ':root { --color-primary: #0000ff; }' });

    const report = await importDesigns({ targetWorkspaceId: target, sourceWorkspaceId: source });

    expect(report.stylesMode).toBe('adopted');
    expect(report.imported).toEqual([{ name: 'checkout-page', as: 'checkout-page', renamed: false, stylesMode: 'adopted' }]);
    // The fresh target adopted the source stylesheet wholesale.
    expect(await fs.readFile(join(workspaceDir(target), 'styles.css'), 'utf8')).toContain('#ff0000');
    // Design copied with references untouched (root stylesheet now matches).
    const html = await fs.readFile(join(workspaceDir(target), 'designs', 'checkout-page', 'index.html'), 'utf8');
    expect(html).toContain('../../styles.css');
    // Manifest merged for the dashboard.
    const manifest = await readJson(join(workspaceDir(target), 'designs', 'manifest.json'));
    expect(manifest.designs).toHaveLength(1);
    expect(manifest.designs[0].slug).toBe('checkout-page');
  });

  it('renames colliding design folders and rewrites manifest entries', async () => {
    const source = wsId();
    const target = wsId();
    const styles = ':root { --same: 1; }';
    await seedWorkspace(source, {
      styles,
      designs: { checkout: { 'index.html': '<html>SOURCE</html>' } },
      manifest: { designs: [{ slug: 'checkout', title: 'Checkout', entry: 'designs/checkout/index.html' }] },
    });
    await seedWorkspace(target, {
      styles,
      designs: { checkout: { 'index.html': '<html>TARGET</html>' } },
      manifest: { designs: [{ slug: 'checkout', title: 'Existing', entry: 'designs/checkout/index.html' }] },
    });

    const report = await importDesigns({ targetWorkspaceId: target, sourceWorkspaceId: source });

    expect(report.stylesMode).toBe('shared');
    expect(report.imported).toEqual([{ name: 'checkout', as: 'checkout-2', renamed: true, stylesMode: 'shared' }]);
    // The existing design is untouched; the import landed beside it.
    expect(await fs.readFile(join(workspaceDir(target), 'designs', 'checkout', 'index.html'), 'utf8')).toContain('TARGET');
    expect(await fs.readFile(join(workspaceDir(target), 'designs', 'checkout-2', 'index.html'), 'utf8')).toContain('SOURCE');
    // Provenance records the rename.
    const provenance = await readJson(join(workspaceDir(target), 'designs', 'checkout-2', '_imported', 'manifest.json'));
    expect(provenance.renamedFrom).toBe('checkout');
    expect(provenance.source).toEqual({ type: 'workspace', workspaceId: source });
    // Manifest gained the renamed entry with a rewritten path.
    const manifest = await readJson(join(workspaceDir(target), 'designs', 'manifest.json'));
    expect(manifest.designs.map((d: any) => d.slug)).toEqual(['checkout', 'checkout-2']);
    expect(manifest.designs[1].entry).toBe('designs/checkout-2/index.html');
  });

  it('snapshots divergent styles per design and rewrites references', async () => {
    const source = wsId();
    const target = wsId();
    await seedWorkspace(source, {
      styles: '@import url("./system/tokens.css");\n:root { --color-primary: #ff0000; }',
      systemCss: { tokens: ':root { --ds-a: 1; }' },
      designs: {
        landing: {
          'index.html': '<link rel="stylesheet" href="../../styles.css" /><a href="../../index.html">Home</a>',
          'sub/page.html': '<link rel="stylesheet" href="../../../styles.css" />',
        },
      },
    });
    await seedWorkspace(target, {
      styles: ':root { --color-primary: #0000ff; }',
      designs: { existing: { 'index.html': '<html>KEEP</html>' } },
    });

    const report = await importDesigns({ targetWorkspaceId: target, sourceWorkspaceId: source });

    expect(report.stylesMode).toBe('snapshot');
    const targetRoot = workspaceDir(target);
    // The target's shared stylesheet is untouched.
    expect(await fs.readFile(join(targetRoot, 'styles.css'), 'utf8')).toContain('#0000ff');
    // The imported design carries a private snapshot of the source system,
    // including the CSS the stylesheet itself imports.
    expect(await fs.readFile(join(targetRoot, 'designs', 'landing', '_imported', 'styles.css'), 'utf8')).toContain('#ff0000');
    expect(await fs.readFile(join(targetRoot, 'designs', 'landing', '_imported', 'system', 'tokens.css'), 'utf8')).toContain('--ds-a');
    // References rewritten at both depths; dashboard navigation untouched.
    const index = await fs.readFile(join(targetRoot, 'designs', 'landing', 'index.html'), 'utf8');
    expect(index).toContain('href="_imported/styles.css"');
    expect(index).toContain('href="../../index.html"');
    expect(await fs.readFile(join(targetRoot, 'designs', 'landing', 'sub', 'page.html'), 'utf8')).toContain('href="../_imported/styles.css"');
  });

  it('vendors non-canonical shared assets (e.g. v6.css) even when styles.css matches', async () => {
    const source = wsId();
    const target = wsId();
    const styles = ':root { --same: 1; }';
    const sourceRoot = await seedWorkspace(source, {
      styles,
      designs: { hero: { 'index.html': '<link rel="stylesheet" href="../../v6a.css" />' } },
    });
    await fs.writeFile(join(sourceRoot, 'v6a.css'), '.hero { color: #123456; }', 'utf8');
    await seedWorkspace(target, {
      styles,
      designs: { existing: { 'index.html': '<html>KEEP</html>' } },
    });

    const report = await importDesigns({ targetWorkspaceId: target, sourceWorkspaceId: source });

    // styles.css is identical → shared, but the extra stylesheet still travels.
    expect(report.stylesMode).toBe('shared');
    const dir = join(workspaceDir(target), 'designs', 'hero');
    expect(await fs.readFile(join(dir, '_imported', 'v6a.css'), 'utf8')).toContain('#123456');
    expect(await fs.readFile(join(dir, 'index.html'), 'utf8')).toContain('href="_imported/v6a.css"');
  });

  it('remaps cross-design links when a sibling design is renamed in the same batch', async () => {
    const source = wsId();
    const target = wsId();
    const styles = ':root { --same: 1; }';
    await seedWorkspace(source, {
      styles,
      designs: {
        checkout: { 'index.html': '<html>SOURCE CHECKOUT</html>' },
        landing: { 'index.html': '<a href="../checkout/index.html">Checkout</a>' },
      },
    });
    await seedWorkspace(target, {
      styles,
      designs: { checkout: { 'index.html': '<html>TARGET</html>' } },
    });

    const report = await importDesigns({ targetWorkspaceId: target, sourceWorkspaceId: source });

    expect(report.imported.find((d) => d.name === 'checkout')?.as).toBe('checkout-2');
    // landing's link follows the renamed sibling instead of the target's own checkout.
    const landing = await fs.readFile(join(workspaceDir(target), 'designs', 'landing', 'index.html'), 'utf8');
    expect(landing).toContain('href="../checkout-2/index.html"');
  });

  it('rejects importing a workspace into itself and empty sources', async () => {
    const id = wsId();
    await seedWorkspace(id, { styles: 'a', designs: { d: { 'index.html': 'x' } } });
    await expect(importDesigns({ targetWorkspaceId: id, sourceWorkspaceId: id })).rejects.toThrow(/into itself/);

    const empty = wsId();
    const target = wsId();
    await seedWorkspace(empty, { styles: 'a' });
    await seedWorkspace(target, { styles: 'a' });
    await expect(importDesigns({ targetWorkspaceId: target, sourceWorkspaceId: empty })).rejects.toThrow(/no designs/);

    await expect(importDesigns({ targetWorkspaceId: target, sourceDir: join(TMP, 'missing-dir') })).rejects.toThrow(/does not exist/);
    await expect(importDesigns({ targetWorkspaceId: target })).rejects.toThrow(/required/);
  });
});

describe('bundle import', () => {
  it('imports a version-export folder as a single self-contained design', async () => {
    const bundleDir = join(TMP, 'exports', 'Checkout Redesign-v3');
    await fs.mkdir(bundleDir, { recursive: true });
    await fs.writeFile(join(bundleDir, 'index.html'), '<html><style>.a{}</style>BUNDLE</html>', 'utf8');
    await fs.writeFile(join(bundleDir, 'pricing.html'), '<html>PRICING</html>', 'utf8');
    await fs.writeFile(join(bundleDir, 'allen-design.json'), JSON.stringify({ screens: [] }), 'utf8');
    await fs.writeFile(join(bundleDir, 'README.txt'), 'readme', 'utf8');

    const target = wsId();
    await seedWorkspace(target, { styles: 'a' });
    const report = await importDesigns({ targetWorkspaceId: target, sourceDir: bundleDir });

    expect(report.sourceType).toBe('bundle');
    expect(report.stylesMode).toBe('self_contained');
    expect(report.imported).toHaveLength(1);
    const as = report.imported[0].as;
    const dir = join(workspaceDir(target), 'designs', as);
    expect(await fs.readFile(join(dir, 'index.html'), 'utf8')).toContain('BUNDLE');
    // README from the export is not treated as design content.
    await expect(fs.access(join(dir, 'README.txt'))).rejects.toThrow();
    const manifest = await readJson(join(workspaceDir(target), 'designs', 'manifest.json'));
    expect(manifest.designs[0].entry).toBe(`designs/${as}/index.html`);
  });

  it('rejects folders without any HTML screens', async () => {
    const emptyDir = join(TMP, 'exports', 'not-a-design');
    await fs.mkdir(emptyDir, { recursive: true });
    await fs.writeFile(join(emptyDir, 'notes.txt'), 'hi', 'utf8');
    const target = wsId();
    await seedWorkspace(target, { styles: 'a' });
    await expect(importDesigns({ targetWorkspaceId: target, sourceDir: emptyDir })).rejects.toThrow(/no designs/);
  });
});

describe('listAllImportSources', () => {
  it('lists every workspace that has designs, across owners, repos, and kinds', async () => {
    const repoPeer = wsId();
    const greenfieldPeer = wsId();
    const empty = wsId();
    await seedWorkspace(repoPeer, { styles: 'a', designs: { one: { 'index.html': 'x' }, two: { 'index.html': 'y' } } });
    await seedWorkspace(greenfieldPeer, { styles: 'a', designs: { idea: { 'index.html': 'z' } } });

    const workspaces = [
      { _id: repoPeer, kind: 'repo', sourceRepoId: 'repo-1', name: 'Other user', ownerUserId: 'u2', updatedAt: new Date() },
      { _id: greenfieldPeer, kind: 'greenfield', name: 'Idea', ownerUserId: 'u3', updatedAt: new Date() },
      { _id: empty, kind: 'repo', sourceRepoId: 'repo-2', name: 'Empty', ownerUserId: 'u1', updatedAt: new Date() },
    ];
    const store = {
      listWorkspaces: async () => workspaces,
    } as unknown as DesignStudioStore;

    const sources = await listAllImportSources(store);
    expect(sources.map((s) => s._id).sort()).toEqual([repoPeer, greenfieldPeer].sort());
    expect(sources.find((s) => s._id === repoPeer)?.designCount).toBe(2);
    expect(sources.find((s) => s._id === greenfieldPeer)?.kind).toBe('greenfield');
  });
});
