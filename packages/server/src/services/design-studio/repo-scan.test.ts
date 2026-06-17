import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { scanRepoForStyle, scanRepoForContext, renderContextForPrompt } from './repo-scan.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function write(root: string, path: string, content: string): Promise<void> {
  const full = join(root, path);
  await fs.mkdir(dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf8');
}

describe('scanRepoForStyle', () => {
  it('captures design-system foundations, icon dependencies, and representative components', async () => {
    const root = join(tmpdir(), `dstudio-scan-${Date.now()}`);
    roots.push(root);
    await fs.mkdir(root, { recursive: true });
    await write(root, 'package.json', JSON.stringify({ dependencies: { 'lucide-react': '^0.468.0' } }));
    await write(root, 'src/theme/typography.ts', 'export const fontFamily = "Inter"; export const h1 = "48px";');
    await write(root, 'src/styles/tokens.css', ':root { --radius-lg: 12px; --color-primary: #123456; }');
    await write(root, 'src/components/IconButton.tsx', 'import { Search } from "lucide-react"; export function IconButton() { return <button><Search /></button>; }');
    await write(root, 'src/components/Modal.tsx', 'export function Modal() { return <div role="dialog" />; }');

    const scan = await scanRepoForStyle(root);
    const paths = scan.files.map((file) => file.path);

    expect(paths).toContain('package.json');
    expect(paths).toContain('src/theme/typography.ts');
    expect(paths).toContain('src/styles/tokens.css');
    expect(paths).toContain('src/components/IconButton.tsx');
    expect(paths).toContain('src/components/Modal.tsx');
  });
});

describe('scanRepoForContext', () => {
  it('captures README and package.json as product context files', async () => {
    const root = join(tmpdir(), `dstudio-ctx-${Date.now()}`);
    roots.push(root);
    await fs.mkdir(root, { recursive: true });
    await write(root, 'README.md', '# MyApp\nA task management SaaS for teams.');
    await write(root, 'package.json', JSON.stringify({ name: 'myapp', description: 'Task management SaaS' }));

    const scan = await scanRepoForContext(root);
    const paths = scan.files.map((f) => f.path);

    expect(paths).toContain('README.md');
    expect(paths).toContain('package.json');
    expect(scan.empty).toBe(false);
    expect(scan.fingerprint).toBeTruthy();
  });

  it('captures route/page files from pages/ and routes/ directories', async () => {
    const root = join(tmpdir(), `dstudio-ctx-routes-${Date.now()}`);
    roots.push(root);
    await fs.mkdir(root, { recursive: true });
    await write(root, 'src/pages/DashboardPage.tsx', 'export default function DashboardPage() {}');
    await write(root, 'src/pages/LoginPage.tsx', 'export default function LoginPage() {}');
    await write(root, 'src/routes/index.ts', "export const routes = [{ path: '/', component: DashboardPage }];");

    const scan = await scanRepoForContext(root);
    const paths = scan.files.map((f) => f.path);

    // pages/ and routes/ dir files should be captured
    expect(paths).toContain('src/pages/DashboardPage.tsx');
    expect(paths).toContain('src/pages/LoginPage.tsx');
    expect(paths).toContain('src/routes/index.ts');
  });

  it('returns empty:true for a repo with no context-relevant files', async () => {
    const root = join(tmpdir(), `dstudio-ctx-empty-${Date.now()}`);
    roots.push(root);
    await fs.mkdir(root, { recursive: true });
    // Only a style file — not a context signal
    await write(root, 'src/styles/global.css', ':root { --color: blue; }');

    const scan = await scanRepoForContext(root);

    expect(scan.empty).toBe(true);
    expect(scan.files).toHaveLength(0);
  });

  it('captures navigation/sidebar components as context signals', async () => {
    const root = join(tmpdir(), `dstudio-ctx-nav-${Date.now()}`);
    roots.push(root);
    await fs.mkdir(root, { recursive: true });
    await write(root, 'src/components/sidebar.tsx', 'export function Sidebar() { return <nav>...</nav>; }');
    await write(root, 'src/components/navigation.tsx', 'export function Navigation() { return <header>...</header>; }');

    const scan = await scanRepoForContext(root);
    const paths = scan.files.map((f) => f.path);

    expect(paths).toContain('src/components/sidebar.tsx');
    expect(paths).toContain('src/components/navigation.tsx');
  });
});

describe('renderContextForPrompt', () => {
  it('returns empty message for an empty scan', () => {
    const result = renderContextForPrompt({ files: [], fingerprint: 'x', empty: true });
    expect(result).toContain('no product/route context files found');
  });

  it('renders CONTEXT FILE headers for each file', () => {
    const result = renderContextForPrompt({
      files: [
        { path: 'README.md', content: '# My App' },
        { path: 'src/pages/Home.tsx', content: 'export default function Home() {}' },
      ],
      fingerprint: 'abc',
      empty: false,
    });
    expect(result).toContain('=== CONTEXT FILE: README.md ===');
    expect(result).toContain('=== CONTEXT FILE: src/pages/Home.tsx ===');
    expect(result).toContain('# My App');
  });
});

describe('scanRepoForContext — data contract files', () => {
  it('captures TypeScript type definition files (*.types.ts)', async () => {
    const root = join(tmpdir(), `dstudio-ctx-types-${Date.now()}`);
    roots.push(root);
    await write(root, 'src/types/workspace.types.ts', 'export interface Workspace { id: string; name: string; }');
    await write(root, 'src/models/user.types.ts', 'export type UserId = string;');

    const scan = await scanRepoForContext(root);
    const paths = scan.files.map((f) => f.path);

    expect(paths).toContain('src/types/workspace.types.ts');
    expect(paths).toContain('src/models/user.types.ts');
  });

  it('captures Prisma schema files (schema.prisma)', async () => {
    const root = join(tmpdir(), `dstudio-ctx-prisma-${Date.now()}`);
    roots.push(root);
    await write(root, 'prisma/schema.prisma', 'model User { id String @id }');

    const scan = await scanRepoForContext(root);
    const paths = scan.files.map((f) => f.path);

    expect(paths).toContain('prisma/schema.prisma');
  });

  it('captures seed and fixture files', async () => {
    const root = join(tmpdir(), `dstudio-ctx-fixtures-${Date.now()}`);
    roots.push(root);
    await write(root, 'src/db/seed.ts', "export const users = [{ id: '1', name: 'Alice' }]");
    await write(root, '__fixtures__/workspaces.fixture.ts', "export const workspaces = [{ id: 'ws1', name: 'Test' }]");

    const scan = await scanRepoForContext(root);
    const paths = scan.files.map((f) => f.path);

    expect(paths).toContain('src/db/seed.ts');
    expect(paths).toContain('__fixtures__/workspaces.fixture.ts');
  });

  it('captures files from types/ and schemas/ directories', async () => {
    const root = join(tmpdir(), `dstudio-ctx-dirs-${Date.now()}`);
    roots.push(root);
    await write(root, 'src/types/api.ts', 'export type ApiResponse<T> = { data: T }');
    await write(root, 'src/schemas/user.schema.ts', 'import z from "zod"; export const userSchema = z.object({ id: z.string() })');

    const scan = await scanRepoForContext(root);
    const paths = scan.files.map((f) => f.path);

    expect(paths).toContain('src/types/api.ts');
    expect(paths).toContain('src/schemas/user.schema.ts');
  });

  it('prioritizes README and route files over data contract files in ordering', async () => {
    const root = join(tmpdir(), `dstudio-ctx-priority-${Date.now()}`);
    roots.push(root);
    await write(root, 'README.md', '# App');
    await write(root, 'src/pages/Dashboard.tsx', 'export default function Dashboard() {}');
    await write(root, 'src/types/data.types.ts', 'export interface Data { id: string }');

    const scan = await scanRepoForContext(root);
    const paths = scan.files.map((f) => f.path);

    expect(paths).toContain('README.md');
    expect(paths).toContain('src/pages/Dashboard.tsx');
    expect(paths).toContain('src/types/data.types.ts');
    // README (priority 0) must come before types (priority 3)
    expect(paths.indexOf('README.md')).toBeLessThan(paths.indexOf('src/types/data.types.ts'));
  });
});
