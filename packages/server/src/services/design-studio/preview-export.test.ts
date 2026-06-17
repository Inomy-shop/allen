/**
 * Preview + export — local-browser hosting and standalone bundle.
 *
 *  - R11/R15: buildPreview materializes screens; the token route serves them
 *    and blocks path traversal
 *  - R19/R20: exportVersion writes a self-contained folder with every screen,
 *    an index entry point, and a manifest
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Point Allen-managed storage at a throwaway dir.
const TMP = join(tmpdir(), `dstudio-test-${Date.now()}`);
vi.mock('@allen/engine', async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>).catch(() => ({}));
  return { ...actual, resolveAllenHome: () => TMP };
});

import { buildPreview, createPreviewHandler, materializeScreens, _resetPreviewRegistry } from './preview.service.js';
import { exportVersion } from './export.service.js';
import { createWorkspaceSiteHandler, ensureWorkspaceDir, exportWorkspace, listWorkspaceFiles } from './workspace-fs.js';
import type { DesignVersion, Screen } from './types.js';

const screens: Screen[] = [
  { id: '1', name: 'Home', fileName: 'index.html', html: '<!DOCTYPE html><html><body><a href="pricing.html">Pricing</a></body></html>' },
  { id: '2', name: 'Pricing', fileName: 'pricing.html', html: '<!DOCTYPE html><html><body>PRICING</body></html>' },
];

beforeAll(async () => {
  await fs.mkdir(TMP, { recursive: true });
});
afterAll(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

function mockRes() {
  return {
    statusCode: 200,
    body: '' as string,
    headers: {} as Record<string, string>,
    status(c: number) { this.statusCode = c; return this; },
    setHeader(k: string, v: string) { this.headers[k] = v; },
    send(b: string) { this.body = b; },
  };
}

describe('preview hosting', () => {
  it('R11/R15: serves the materialized screens by token; nav file resolves', async () => {
    _resetPreviewRegistry();
    const { token, url } = await buildPreview('ver1', screens);
    expect(url).toBe(`/dstudio-preview/${token}/index.html`);
    const handler = createPreviewHandler();

    const res1 = mockRes();
    await handler({ params: { token, file: 'index.html' } } as any, res1 as any);
    expect(res1.statusCode).toBe(200);
    expect(res1.body).toContain('href="pricing.html"');

    const res2 = mockRes();
    await handler({ params: { token, file: 'pricing.html' } } as any, res2 as any);
    expect(res2.body).toContain('PRICING');
  });

  it('blocks path traversal and unknown tokens', async () => {
    const handler = createPreviewHandler();
    const res = mockRes();
    await handler({ params: { token: 'nope', file: 'index.html' } } as any, res as any);
    expect(res.statusCode).toBe(404);

    _resetPreviewRegistry();
    const { token } = await buildPreview('ver2', screens);
    const trav = mockRes();
    await handler({ params: { token, file: '../../../etc/passwd' } } as any, trav as any);
    expect([403, 404]).toContain(trav.statusCode);
  });

  it('always writes an index.html entry point', async () => {
    const dir = join(TMP, 'mat');
    await materializeScreens(dir, [{ id: 'x', name: 'Only', fileName: 'home.html', html: '<html><body>x</body></html>' }]);
    expect(await fs.readFile(join(dir, 'index.html'), 'utf8')).toContain('x');
  });
});

describe('export bundle', () => {
  it('R19/R20: writes a self-contained folder with all screens + manifest', async () => {
    const version: DesignVersion = {
      sessionId: 's', workspaceId: 'w', seq: 3, kind: 'generation', label: 'final', screens,
      createdAt: new Date(),
    };
    const dest = join(TMP, 'dest');
    const result = await exportVersion(version, { sessionTitle: 'My Site', destinationDir: dest });
    expect(result.files).toContain('index.html');
    expect(result.files).toContain('pricing.html');
    expect(result.files).toContain('allen-design.json');
    expect(result.manifest.screens).toHaveLength(2);
    // The bundle renders offline: index links to pricing by relative path.
    const index = await fs.readFile(join(result.dir, 'index.html'), 'utf8');
    expect(index).toContain('href="pricing.html"');
  });
});

describe('workspace design gallery', () => {
  it('seeds a dashboard, manifest, shared CSS, and designs folder', async () => {
    const workspaceId = 'workspace-seed';
    const dir = await ensureWorkspaceDir(workspaceId, {
      summaryMarkdown: 'Profile',
      colors: [{ name: 'Primary', role: 'primary', value: '#123456' }],
      typography: 'Inter; h1 48/1.05 760, body 14/1.5 400.',
      spacing: '4px base grid, 8px radius, 40px control heights.',
      components: [{ name: 'Button', description: 'Rounded primary and ghost variants with 40px height.' }],
      iconography: 'lucide-react outline icons, 16px and 20px.',
      layoutPatterns: 'Centered auth cards and dense dashboard tables.',
      consistency: { consistent: true, issues: [] },
    });

    const index = await fs.readFile(join(dir, 'index.html'), 'utf8');
    const styles = await fs.readFile(join(dir, 'styles.css'), 'utf8');
    const tokens = await fs.readFile(join(dir, 'system', 'tokens.css'), 'utf8');
    const components = await fs.readFile(join(dir, 'system', 'components.css'), 'utf8');
    const componentSheet = await fs.readFile(join(dir, 'system', 'components.html'), 'utf8');
    const systemManifest = JSON.parse(await fs.readFile(join(dir, 'system', 'manifest.json'), 'utf8'));
    const manifest = JSON.parse(await fs.readFile(join(dir, 'designs', 'manifest.json'), 'utf8'));
    const files = await listWorkspaceFiles(workspaceId);

    expect(index).toContain('Design dashboard');
    expect(index).toContain('href="styles.css"');
    expect(index).toContain('data-design-grid');
    expect(index).toContain("fetch('designs/manifest.json'");
    expect(index).toContain('No design groups yet');
    expect(index).not.toContain('Ask Allen');
    expect(styles).toContain('@import url("./system/tokens.css");');
    expect(styles).toContain('@import url("./system/components.css");');
    expect(styles).toContain('--color-primary: #123456');
    expect(styles).toContain('repeat(auto-fill, minmax(280px, 340px))');
    expect(styles).toContain('justify-content: start');
    expect(styles).toContain('grid-template-rows: 156px 132px');
    expect(styles).toContain('grid-template-rows: auto auto');
    expect(styles).toContain('align-content: start');
    expect(styles).toContain('height: 288px');
    expect(styles).toContain('min-height: 39px');
    expect(styles).toContain('.studio-floating-nav');
    expect(styles).toContain('bottom: 18px');
    expect(styles).toContain('font-size: 0');
    expect(styles).toContain('radial-gradient');
    expect(styles).toContain('transition: opacity 170ms ease, transform 170ms ease');
    expect(styles).toContain('Repository design-system notes captured during analysis');
    expect(styles).toContain('Typography: Inter');
    expect(styles).toContain('Components: Button - Rounded primary');
    expect(styles).toContain('Iconography: lucide-react');
    expect(tokens).toContain('--ds-color-primary: #123456');
    expect(tokens).toContain('--ds-font-family: Inter');
    expect(tokens).toContain('--ds-radius-md: 8px');
    expect(tokens).toContain('--ds-control-height: 40px');
    expect(components).toContain('.ds-btn');
    expect(components).toContain('.ds-input');
    expect(components).toContain('.ds-card');
    expect(components).toContain('.ds-dropdown');
    expect(componentSheet).toContain('Design system kit');
    expect(componentSheet).toContain('Captured components: Button');
    expect(systemManifest.source).toBe('repository-analysis');
    expect(systemManifest.foundations.typography).toContain('Inter');
    expect(systemManifest.components[0].name).toBe('Button');
    expect(systemManifest.usage.join(' ')).toContain('system/components.html');
    expect(manifest).toEqual({ designs: [] });
    expect(files.map((f) => f.path)).toEqual(expect.arrayContaining([
      'index.html',
      'styles.css',
      'designs/manifest.json',
      'system/tokens.css',
      'system/components.css',
      'system/components.html',
      'system/manifest.json',
    ]));
  });

  it('writes a read-only source repo pointer when a repo workspace is seeded', async () => {
    const workspaceId = 'workspace-source-repo';
    const dir = await ensureWorkspaceDir(workspaceId, undefined, {
      workspaceName: 'Acme App',
      sourceRepoName: 'Acme App',
      sourceRepoId: 'repo-123',
      sourceRepoPath: '/tmp/acme-source',
    });

    const sourceRepo = JSON.parse(await fs.readFile(join(dir, 'system', 'source-repo.json'), 'utf8'));
    expect(sourceRepo).toMatchObject({
      mode: 'read-only',
      name: 'Acme App',
      repoId: 'repo-123',
      path: '/tmp/acme-source',
    });
    expect(sourceRepo.usage.join(' ')).toContain('redesign requests');
  });

  it('serves and exports nested design-group files', async () => {
    const workspaceId = 'workspace-nested';
    const dir = await ensureWorkspaceDir(workspaceId);
    await fs.mkdir(join(dir, 'designs', 'login'), { recursive: true });
    await fs.writeFile(join(dir, 'designs', 'login', 'index.html'), '<!DOCTYPE html><html><body>LOGIN GROUP</body></html>', 'utf8');
    await fs.writeFile(join(dir, 'designs', 'login', 'variation-1.html'), '<!DOCTYPE html><html><body>LOGIN VARIANT</body></html>', 'utf8');

    const handler = createWorkspaceSiteHandler();
    const res = mockRes();
    await handler({ params: { workspaceId, file: 'designs/login/variation-1.html' } } as any, res as any);
    expect(res.statusCode).toBe(200);
    expect(res.body.toString()).toContain('LOGIN VARIANT');

    const exported = await exportWorkspace(workspaceId, { name: 'Nested Site', destinationDir: join(TMP, 'workspace-export') });
    expect(exported.files).toEqual(expect.arrayContaining([
      'index.html',
      'styles.css',
      'designs/manifest.json',
      'designs/login/index.html',
      'designs/login/variation-1.html',
    ]));
    expect(await fs.readFile(join(exported.dir, 'designs', 'login', 'index.html'), 'utf8')).toContain('LOGIN GROUP');
  });
});
