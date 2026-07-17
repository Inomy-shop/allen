/**
 * design-studio routes — end-to-end flow over a real in-memory Mongo with a
 * deterministic injected completer (no live model).
 *
 * Covers the full greenfield journey and the generation gating:
 *  - R2/R22: create greenfield workspace
 *  - R6/R7/R22.3: discovery synthesis → confirmed brief reused
 *  - generation is GATED until the brief/profile is confirmed
 *  - R8/R10: generate single + variants
 *  - R10/R18.1: select a variant
 *  - R13/R14: surgical iterate
 *  - R17/R18: list + restore versions
 *  - R19: export bundle
 *  - R22 (repo): repo workspace dedupe
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const TMP = join(tmpdir(), `dstudio-routes-${Date.now()}`);
vi.mock('@allen/engine', async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>).catch(() => ({}));
  return { ...actual, resolveAllenHome: () => TMP };
});

import { designStudioRoutes, type DesignStudioRoutesOptions } from './design-studio.routes.js';
import { workspaceDir } from '../services/design-studio/workspace-fs.js';
import type { Completer } from '../services/design-studio/llm.service.js';

// Deterministic completer that branches on the system prompt's intent.
const completer: Completer = async ({ system, prompt }) => {
  if (system.includes('design-systems analyst')) {
    return [
      '# Design profile',
      'Repository uses a compact Inter-based product system.',
      '',
      '```json',
      JSON.stringify({
        colors: [{ name: 'Primary', value: '#123456', role: 'primary' }],
        typography: 'Inter; h1 48/1.05 760, body 14/1.5 400.',
        spacing: '4px base grid, 8px radius, 40px control heights.',
        components: [{ name: 'Button', description: 'Rounded primary and ghost variants.' }],
        iconography: 'lucide-react outline icons.',
        layoutPatterns: 'Dense dashboard shell with cards and tables.',
        consistency: { consistent: true, issues: [] },
      }),
      '```',
    ].join('\n');
  }
  if (system.includes('senior software architect')) {
    return JSON.stringify({
      productSummary: 'A compact SaaS dashboard product.',
      routes: [{ path: '/', description: 'Dashboard' }],
      keyPages: [{ file: 'src/pages/Dashboard.tsx', purpose: 'Main dashboard page' }],
      importantFiles: [],
      componentInventory: [{ name: 'Button', purpose: 'Primary action' }],
    });
  }
  if (system.includes('discovery answers')) {
    return JSON.stringify({ product: 'P', audience: 'A', feel: 'F', references: 'R', screens: 'landing', direction: 'clean', assumptions: ['picked blue'] });
  }
  if (system.includes('SURGICAL')) {
    return JSON.stringify({ changed: [{ fileName: 'index.html', name: 'Home', html: '<!DOCTYPE html><html><body>UPDATED</body></html>' }], invented: [] });
  }
  // generation — vary slightly by direction hint so variants differ
  const tag = prompt.includes('bold') ? 'BOLD' : prompt.includes('classic') ? 'CLASSIC' : 'CLEAN';
  return JSON.stringify({ screens: [{ name: 'Home', fileName: 'index.html', html: `<!DOCTYPE html><html><body>${tag}</body></html>` }], invented: [] });
};

function buildApp(db: Db, opts: DesignStudioRoutesOptions) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).user = { sub: 'u1', email: 'u@test' }; next(); });
  app.use('/api/design-studio', designStudioRoutes(db, opts));
  return app;
}

describe('design-studio routes', () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let app: express.Express;

  beforeAll(async () => {
    await fs.mkdir(TMP, { recursive: true });
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    db = client.db('dstudio-routes-test');
    app = buildApp(db, { completerFactory: () => completer });
  });

  afterAll(async () => {
    await client?.close();
    await mongo?.stop();
    await fs.rm(TMP, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(async () => {
    for (const c of ['dstudio_workspaces', 'dstudio_sessions', 'dstudio_versions', 'dstudio_messages', 'chat_sessions', 'repos', 'model_registry']) {
      await db.collection(c).deleteMany({});
    }
  });

  it('runs the full greenfield journey end-to-end', async () => {
    // R2/R22 — create greenfield workspace
    const ws = (await request(app).post('/api/design-studio/workspaces').send({ kind: 'greenfield', name: 'My idea' }).expect(201)).body;
    const session = (await request(app).post(`/api/design-studio/workspaces/${ws._id}/sessions`).send({ title: 'Landing' }).expect(201)).body;

    // Generation is GATED before the brief is confirmed
    await request(app).post(`/api/design-studio/sessions/${session._id}/generate`).send({ instruction: 'a landing page' }).expect(409);

    // R6/R7/R22.3 — discovery synthesis confirms the brief
    const confirmed = (await request(app).post(`/api/design-studio/workspaces/${ws._id}/greenfield`).send({ idea: 'My idea', answers: { feel: 'modern' } }).expect(200)).body;
    expect(confirmed.profileStatus).toBe('confirmed');
    expect(confirmed.greenfieldBrief.assumptions).toContain('picked blue');

    // R8 — single generation
    const gen = (await request(app).post(`/api/design-studio/sessions/${session._id}/generate`).send({ instruction: 'a landing page' }).expect(201)).body;
    expect(gen.version.screens[0].fileName).toBe('index.html');

    // R13/R14 — surgical iterate
    const iter = (await request(app).post(`/api/design-studio/sessions/${session._id}/iterate`).send({ instruction: 'update the header' }).expect(201)).body;
    expect(iter.changedFiles).toContain('index.html');
    expect(iter.version.screens[0].html).toContain('UPDATED');

    // R17 — version history accrues
    const versions = (await request(app).get(`/api/design-studio/sessions/${session._id}/versions`).expect(200)).body;
    expect(versions.length).toBe(2);

    // R18 — restore first version, later versions preserved
    const restored = (await request(app).post(`/api/design-studio/versions/${versions[0]._id}/restore`).expect(201)).body;
    const after = (await request(app).get(`/api/design-studio/sessions/${session._id}/versions`).expect(200)).body;
    expect(after.length).toBe(3);
    expect(restored.kind).toBe('restore');

    // R19 — export bundle
    const exported = (await request(app).post(`/api/design-studio/versions/${restored._id}/export`).send({}).expect(200)).body;
    expect(exported.files).toContain('index.html');
  });

  it('R10/R18.1: generates variants and selects one', async () => {
    const ws = (await request(app).post('/api/design-studio/workspaces').send({ kind: 'greenfield', name: 'Idea' }).expect(201)).body;
    await request(app).post(`/api/design-studio/workspaces/${ws._id}/greenfield`).send({ answers: {} }).expect(200);
    const session = (await request(app).post(`/api/design-studio/workspaces/${ws._id}/sessions`).send({}).expect(201)).body;

    const res = (await request(app).post(`/api/design-studio/sessions/${session._id}/generate`).send({ instruction: 'landing', variants: 3 }).expect(201)).body;
    expect(res.variants).toHaveLength(3);
    expect(res.variants.filter((v: any) => v.selected)).toHaveLength(1);

    const pick = res.variants[2];
    const picked = (await request(app).post(`/api/design-studio/versions/${pick._id}/select-variant`).expect(200)).body;
    expect(picked.selected).toBe(true);
  });

  it('R22: repo workspace dedupes by repoId', async () => {
    const repoId = '64b2f0000000000000000abc';
    await db.collection('repos').insertOne({ _id: new (await import('mongodb')).ObjectId(repoId), name: 'Acme', path: '/tmp/none' } as any);
    const first = (await request(app).post('/api/design-studio/workspaces').send({ kind: 'repo', repoId }).expect(201)).body;
    const second = (await request(app).post('/api/design-studio/workspaces').send({ kind: 'repo', repoId }).expect(200)).body;
    expect(second._id).toBe(first._id);
  });

  it('analyzes repo workspaces with normalized Claude Opus 4.8 defaults and rich profile fields', async () => {
    const repoRoot = join(TMP, 'repo-analysis');
    await fs.mkdir(join(repoRoot, 'src/components'), { recursive: true });
    await fs.writeFile(join(repoRoot, 'package.json'), JSON.stringify({ dependencies: { 'lucide-react': '^0.468.0' } }), 'utf8');
    await fs.writeFile(join(repoRoot, 'src/components/Button.tsx'), 'export function Button() { return <button className="rounded-lg" />; }', 'utf8');

    const repoId = '64b2f0000000000000000aaa';
    await db.collection('repos').insertOne({ _id: new ObjectId(repoId), name: 'Analyzed App', path: repoRoot } as any);
    const ws = (await request(app).post('/api/design-studio/workspaces').send({ kind: 'repo', repoId }).expect(201)).body;

    const analyzed = (await request(app)
      .post(`/api/design-studio/workspaces/${ws._id}/analyze`)
      .send({ provider: 'claude-cli', model: 'opus' })
      .expect(200)).body;

    expect(analyzed.analysisProvider).toBe('claude');
    expect(analyzed.analysisModel).toBe('claude-opus-4-8');
    expect(analyzed.profileStatus).toBe('needs_review');
    expect(analyzed.profile.typography).toContain('Inter');
    expect(analyzed.profile.components[0].name).toBe('Button');
    expect(analyzed.profile.iconography).toContain('lucide-react');

    const workspaceRoot = join(TMP, 'design-studio', 'workspaces', ws._id);
    const tokens = await fs.readFile(join(workspaceRoot, 'system', 'tokens.css'), 'utf8');
    const components = await fs.readFile(join(workspaceRoot, 'system', 'components.css'), 'utf8');
    const kitManifest = JSON.parse(await fs.readFile(join(workspaceRoot, 'system', 'manifest.json'), 'utf8'));
    const sourceRepo = JSON.parse(await fs.readFile(join(workspaceRoot, 'system', 'source-repo.json'), 'utf8'));
    const sharedStyles = await fs.readFile(join(workspaceRoot, 'styles.css'), 'utf8');
    expect(tokens).toContain('--ds-color-primary: #123456');
    expect(tokens).toContain('--ds-font-family: Inter');
    expect(components).toContain('.ds-btn');
    expect(components).toContain('.ds-input');
    expect(components).toContain('.ds-card');
    expect(kitManifest.components[0].name).toBe('Button');
    expect(kitManifest.foundations.iconography).toContain('lucide-react');
    expect(sourceRepo.mode).toBe('read-only');
    expect(sourceRepo.name).toBe('Analyzed App');
    expect(sourceRepo.path).toBe(repoRoot);
    expect(sharedStyles).toContain('@import url("./system/tokens.css");');
    expect(sharedStyles).toContain('@import url("./system/components.css");');
  });

  it('keeps the active Opus model fallback for repo analysis when selection is omitted', async () => {
    vi.stubEnv('ALLEN_DEFAULT_CHAT_PROVIDER', 'codex');
    vi.stubEnv('ALLEN_DEFAULT_CHAT_MODEL', 'gpt-5.6-sol');
    await db.collection('model_registry').insertOne({
      _id: new ObjectId(),
      provider: 'claude',
      fullId: 'claude-opus-4-7',
      displayName: 'Opus 4.7',
      providerDisplayName: 'Claude',
      tier: 'opus',
      isActive: true,
      sortOrder: 10,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const repoRoot = join(TMP, 'repo-analysis-fallback');
    await fs.mkdir(repoRoot, { recursive: true });
    await fs.writeFile(join(repoRoot, 'package.json'), JSON.stringify({ dependencies: {} }), 'utf8');

    const repoId = '64b2f0000000000000000aab';
    await db.collection('repos').insertOne({ _id: new ObjectId(repoId), name: 'Fallback App', path: repoRoot } as any);
    const ws = (await request(app).post('/api/design-studio/workspaces').send({ kind: 'repo', repoId }).expect(201)).body;

    const analyzed = (await request(app)
      .post(`/api/design-studio/workspaces/${ws._id}/analyze`)
      .send({})
      .expect(200)).body;

    expect(analyzed.analysisProvider).toBe('claude');
    expect(analyzed.analysisModel).toBe('claude-opus-4-7');
  });

  it('serves workspace file content and blocks path traversal', async () => {
    const ws = (await request(app).post('/api/design-studio/workspaces').send({ kind: 'greenfield', name: 'Files' }).expect(201)).body;
    await request(app).get(`/api/design-studio/workspaces/${ws._id}/files`).expect(200);

    const content = (await request(app)
      .get(`/api/design-studio/workspaces/${ws._id}/files/content`)
      .query({ path: 'index.html' })
      .expect(200)).body;

    expect(content.path).toBe('index.html');
    expect(content.content).toContain('design dashboard');
    expect(content.truncated).toBe(false);

    await request(app)
      .get(`/api/design-studio/workspaces/${ws._id}/files/content`)
      .query({ path: '../../package.json' })
      .expect(400);
  });

  it('starts repo-backed design chat on the selected model and seeds a repo-named dashboard', async () => {
    const repoId = '64b2f0000000000000000def';
    await db.collection('repos').insertOne({ _id: new ObjectId(repoId), name: 'Acme App', path: '/tmp/acme-app' } as any);
    const ws = (await request(app).post('/api/design-studio/workspaces').send({ kind: 'repo', repoId }).expect(201)).body;

    await db.collection('dstudio_workspaces').updateOne(
      { _id: new ObjectId(ws._id) },
      {
        $set: {
          profileStatus: 'confirmed',
          profile: {
            summaryMarkdown: 'Acme profile',
            colors: [],
            consistency: { consistent: true, issues: [] },
          },
        },
      },
    );

    const started = (await request(app)
      .post(`/api/design-studio/workspaces/${ws._id}/start`)
      .send({ provider: 'claude', model: 'claude-opus-4-8' })
      .expect(201)).body;
    const session = await db.collection('chat_sessions').findOne({ _id: new ObjectId(started.chatSessionId) });

    expect(session?.provider).toBe('claude');
    expect(session?.model).toBe('claude-opus-4-8');
    expect(session?.studioWorkspaceId).toBe(ws._id);
    expect(String(session?.repoId)).toBe(repoId);
    expect(session?.repoName).toBe('Acme App');
    expect(session?.repoPath).toContain('design-studio/workspaces');

    const dashboard = await fs.readFile(join(TMP, 'design-studio', 'workspaces', ws._id, 'index.html'), 'utf8');
    expect(dashboard).toContain('Acme App design dashboard');
    expect(session?.systemPromptOverride).toContain('repository "Acme App"');
    expect(session?.systemPromptOverride).toContain('MANDATORY PLAN-FIRST WORKFLOW');
  });

  it.each([
    { provider: 'codex', model: 'gpt-5.6-sol', alsoActive: [] as string[] },
    // The Claude case registers Opus 4.8 as an ACTIVE model on purpose. Without it, the old
    // hardcoded Opus default would coincidentally resolve back to the configured model via
    // chooseAvailableStudioModel's unavailable-model fallback, so the test would pass against
    // the bug it is meant to catch. With Opus genuinely available, only the fixed
    // configured-default resolution can return the configured Sonnet model.
    { provider: 'claude', model: 'claude-sonnet-4-6', alsoActive: ['claude-opus-4-8'] },
  ])('defaults design chat sessions to the configured $provider model when selection is omitted', async ({ provider, model, alsoActive }) => {
    vi.stubEnv('ALLEN_DEFAULT_CHAT_PROVIDER', provider);
    vi.stubEnv('ALLEN_DEFAULT_CHAT_MODEL', model);
    await db.collection('model_registry').insertMany([
      { fullId: model, tier: 'default' },
      ...alsoActive.map((fullId) => ({ fullId, tier: 'opus' })),
    ].map((entry, index) => ({
      _id: new ObjectId(),
      provider,
      fullId: entry.fullId,
      displayName: entry.fullId,
      providerDisplayName: provider === 'claude' ? 'Claude' : 'Codex',
      tier: entry.tier,
      isActive: true,
      sortOrder: 10 + index,
      createdAt: new Date(),
      updatedAt: new Date(),
    })));

    const ws = (await request(app).post('/api/design-studio/workspaces').send({ kind: 'greenfield', name: 'Idea' }).expect(201)).body;
    await request(app).post(`/api/design-studio/workspaces/${ws._id}/greenfield`).send({ answers: {} }).expect(200);

    const started = (await request(app).post(`/api/design-studio/workspaces/${ws._id}/start`).send({}).expect(201)).body;
    const session = await db.collection('chat_sessions').findOne({ _id: new ObjectId(started.chatSessionId) });

    expect(session?.provider).toBe(provider);
    expect(session?.model).toBe(model);
  });

  it.each([
    { provider: 'claude', model: 'claude-sonnet-4-6', requiredKey: undefined },
    { provider: 'zai', model: 'glm-5.2[1m]', requiredKey: 'ALLEN_ZAI_API_KEY' },
  ])('defaults an explicit $provider selection to that provider\'s own model', async ({ provider, model, requiredKey }) => {
    vi.stubEnv('ALLEN_DEFAULT_CHAT_PROVIDER', 'codex');
    vi.stubEnv('ALLEN_DEFAULT_CHAT_MODEL', 'gpt-5.6-sol');
    if (requiredKey) vi.stubEnv(requiredKey, 'test-key');

    const ws = (await request(app).post('/api/design-studio/workspaces').send({ kind: 'greenfield', name: 'Idea' }).expect(201)).body;
    await request(app).post(`/api/design-studio/workspaces/${ws._id}/greenfield`).send({ answers: {} }).expect(200);

    const started = (await request(app)
      .post(`/api/design-studio/workspaces/${ws._id}/start`)
      .send({ provider })
      .expect(201)).body;
    const session = await db.collection('chat_sessions').findOne({ _id: new ObjectId(started.chatSessionId) });

    expect(session?.provider).toBe(provider);
    expect(session?.model).toBe(model);
  });

  it('keeps Claude Opus 4.8 as the repo analysis default when selection is omitted', async () => {
    vi.stubEnv('ALLEN_DEFAULT_CHAT_PROVIDER', 'codex');
    vi.stubEnv('ALLEN_DEFAULT_CHAT_MODEL', 'gpt-5.6-sol');
    const repoRoot = join(TMP, 'repo-analysis-default');
    await fs.mkdir(repoRoot, { recursive: true });
    await fs.writeFile(join(repoRoot, 'package.json'), JSON.stringify({ dependencies: {} }), 'utf8');

    const repoId = '64b2f0000000000000000aac';
    await db.collection('repos').insertOne({ _id: new ObjectId(repoId), name: 'Default Analysis App', path: repoRoot } as any);
    const ws = (await request(app).post('/api/design-studio/workspaces').send({ kind: 'repo', repoId }).expect(201)).body;

    const analyzed = (await request(app)
      .post(`/api/design-studio/workspaces/${ws._id}/analyze`)
      .send({})
      .expect(200)).body;

    expect(analyzed.analysisProvider).toBe('claude');
    expect(analyzed.analysisModel).toBe('claude-opus-4-8');
  });

  describe('POST /workspaces/:id/refresh (REQ-005)', () => {
    let repoWorkspaceId: string;

    beforeEach(async () => {
      // Create a real repo directory with some context files.
      const repoDir = join(TMP, `repo-refresh-${Date.now()}`);
      await fs.mkdir(repoDir, { recursive: true });
      await fs.writeFile(join(repoDir, 'README.md'), '# Test Repo', 'utf8');
      await fs.writeFile(join(repoDir, 'package.json'), JSON.stringify({ name: 'test-repo' }), 'utf8');

      // Manually inject a confirmed workspace with sourceRepoPath pointing to repoDir.
      const ws = await db.collection('dstudio_workspaces').insertOne({
        kind: 'repo',
        name: 'Test Refresh Repo',
        sourceRepoId: new ObjectId().toString(),
        sourceRepoPath: repoDir,
        ownerUserId: 'u1',
        profileStatus: 'confirmed',
        profile: {
          summaryMarkdown: 'Clean modern product.',
          colors: [{ name: 'Primary', value: '#123456', role: 'primary' }],
          typography: 'Inter',
          spacing: '4px',
          components: [],
          iconography: 'lucide',
          layoutPatterns: 'Dashboard shell',
          consistency: { consistent: true, issues: [] },
        },
        repoFingerprint: 'abc123',
        analysisProvider: 'claude',
        analysisModel: 'claude-opus-4-8',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      repoWorkspaceId = ws.insertedId.toString();
    });

    it('returns 200 with an updated workspace for a confirmed repo workspace', async () => {
      const res = await request(app)
        .post(`/api/design-studio/workspaces/${repoWorkspaceId}/refresh`);
      expect(res.status).toBe(200);
      expect(res.body.profileStatus).toBe('confirmed'); // stays confirmed
      expect(res.body._id).toBe(repoWorkspaceId);
    });

    it('returns 409 for a non-confirmed (pending) workspace', async () => {
      // Patch workspace to pending status
      await db.collection('dstudio_workspaces').updateOne(
        { _id: new ObjectId(repoWorkspaceId) },
        { $set: { profileStatus: 'pending' } },
      );
      const res = await request(app)
        .post(`/api/design-studio/workspaces/${repoWorkspaceId}/refresh`);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('NOT_CONFIRMED');
    });

    it('returns 400 for a greenfield workspace', async () => {
      const greenfieldWs = await db.collection('dstudio_workspaces').insertOne({
        kind: 'greenfield',
        name: 'Greenfield',
        ownerUserId: 'u1',
        profileStatus: 'confirmed',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const res = await request(app)
        .post(`/api/design-studio/workspaces/${greenfieldWs.insertedId.toString()}/refresh`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('BAD_WORKSPACE');
    });

    it('returns 404 for a non-existent workspace', async () => {
      const res = await request(app)
        .post(`/api/design-studio/workspaces/${new ObjectId().toString()}/refresh`);
      expect(res.status).toBe(404);
    });
  });

  describe('POST /workspaces/import-new (fork designs into a new workspace)', () => {
    /** A repo-linked, profiled source workspace with one design on disk. */
    async function seedSourceWorkspace(): Promise<string> {
      const inserted = await db.collection('dstudio_workspaces').insertOne({
        kind: 'repo',
        name: 'Design source',
        sourceRepoId: 'repo-1',
        sourceRepoPath: '/tmp/source-repo',
        ownerUserId: 'u2',
        profileStatus: 'confirmed',
        profile: {
          summaryMarkdown: 'Compact Inter-based system.',
          colors: [{ name: 'Primary', value: '#123456', role: 'primary' }],
          consistency: { consistent: true, issues: [] },
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const id = inserted.insertedId.toString();
      const designDir = join(workspaceDir(id), 'designs', 'checkout');
      await fs.mkdir(designDir, { recursive: true });
      await fs.writeFile(join(workspaceDir(id), 'styles.css'), ':root { --brand: #ff0000; }', 'utf8');
      await fs.writeFile(join(designDir, 'index.html'), '<link rel="stylesheet" href="../../styles.css" /><body>CHECKOUT</body>', 'utf8');
      return id;
    }

    it('creates a confirmed workspace with adopted designs, inherited repo link, and profile', async () => {
      const sourceId = await seedSourceWorkspace();

      // The source is offered as a global import source.
      const sources = (await request(app).get('/api/design-studio/import-sources').expect(200)).body;
      expect(sources.map((s: { _id: string }) => s._id)).toContain(sourceId);
      expect(sources.find((s: { _id: string }) => s._id === sourceId)?.designCount).toBe(1);

      const { workspace, report } = (await request(app)
        .post('/api/design-studio/workspaces/import-new')
        .send({ sourceWorkspaceId: sourceId })
        .expect(201)).body;

      // Immediately usable: confirmed, named after the source, brief records provenance.
      expect(workspace.kind).toBe('greenfield');
      expect(workspace.name).toBe('Design source (imported)');
      expect(workspace.profileStatus).toBe('confirmed');
      expect(workspace.greenfieldBrief.references).toBe(`workspace:${sourceId}`);
      // Repo link and analyzed profile carried over from the source.
      expect(workspace.sourceRepoId).toBe('repo-1');
      expect(workspace.sourceRepoPath).toBe('/tmp/source-repo');
      expect(workspace.profile.colors[0].value).toBe('#123456');

      // Fresh gallery → the source design system is adopted wholesale.
      expect(report.stylesMode).toBe('adopted');
      expect(report.imported).toEqual([{ name: 'checkout', as: 'checkout', renamed: false, stylesMode: 'adopted' }]);
      expect(await fs.readFile(join(workspaceDir(workspace._id), 'styles.css'), 'utf8')).toContain('#ff0000');
      expect(await fs.readFile(join(workspaceDir(workspace._id), 'designs', 'checkout', 'index.html'), 'utf8')).toContain('CHECKOUT');
      // Repo pointer materialized for design chats.
      const pointer = JSON.parse(await fs.readFile(join(workspaceDir(workspace._id), 'system', 'source-repo.json'), 'utf8'));
      expect(pointer.path).toBe('/tmp/source-repo');
    });

    it('links a bundle import to an explicitly chosen repo', async () => {
      const repo = await db.collection('repos').insertOne({ name: 'my-app', path: '/tmp/my-app' });
      const bundleDir = join(TMP, 'exports', 'shared-designs');
      await fs.mkdir(bundleDir, { recursive: true });
      await fs.writeFile(join(bundleDir, 'index.html'), '<html>BUNDLE</html>', 'utf8');

      const { workspace } = (await request(app)
        .post('/api/design-studio/workspaces/import-new')
        .send({ sourceDir: bundleDir, repoId: repo.insertedId.toString(), name: 'Shared designs' })
        .expect(201)).body;

      expect(workspace.name).toBe('Shared designs');
      expect(workspace.sourceRepoId).toBe(repo.insertedId.toString());
      expect(workspace.sourceRepoPath).toBe('/tmp/my-app');
    });

    it('validates sources and rolls the workspace back when the import fails', async () => {
      await request(app).post('/api/design-studio/workspaces/import-new').send({}).expect(400);
      await request(app).post('/api/design-studio/workspaces/import-new')
        .send({ sourceWorkspaceId: new ObjectId().toString() }).expect(404);
      await request(app).post('/api/design-studio/workspaces/import-new')
        .send({ sourceDir: join(TMP, 'exports', 'nope'), repoId: new ObjectId().toString() }).expect(404);

      // A source with no designs fails the import → the created workspace is rolled back.
      const empty = (await request(app).post('/api/design-studio/workspaces').send({ kind: 'greenfield', name: 'Empty' }).expect(201)).body;
      await request(app).post('/api/design-studio/workspaces/import-new').send({ sourceWorkspaceId: empty._id }).expect(400);
      const list = (await request(app).get('/api/design-studio/workspaces').expect(200)).body;
      expect(list.map((w: { name: string }) => w.name)).toEqual(['Empty']);
    });
  });
});
