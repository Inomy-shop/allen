import { describe, expect, it, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Db } from 'mongodb';

// ── Mocks ─────────────────────────────────────────────────────────────────────
vi.mock('../services/chat-providers.js', () => ({
  PROVIDERS: [],
  ChatProvider: {},
}));

vi.mock('../services/context/config/context-provider-config.js', () => ({
  isContextEngineEnabled: vi.fn(() => true),
  isCogneeContextEnabled: vi.fn(() => true),
}));

vi.mock('../services/context/setup/repo-context-setup.service.js', () => ({
  SETUP_RUNS_COLLECTION: 'repo_context_setup_runs',
  RepoContextSetupService: vi.fn().mockImplementation(() => ({
    startOrReturn: vi.fn(async () => ({ setupRun: {}, deduped: false })),
    getActiveOrLatest: vi.fn(async () => ({ active: false, setupRun: null })),
    listHistory: vi.fn(async () => []),
    get: vi.fn(async () => ({})),
    cancel: vi.fn(async () => ({})),
    resume: vi.fn(async () => ({})),
  })),
}));

vi.mock('../services/context/cognee/cognee-memory.service.js', () => ({
  CogneeMemoryService: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../services/context/curation/repo-context-curation.service.js', () => ({
  RepoContextCurationService: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../services/context/core/repo-context-packet.service.js', () => ({
  RepoContextPacketService: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../services/context/graph/repo-context-graph.service.js', () => ({
  RepoContextGraphService: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../services/context/core/repo-context-engine.js', () => ({
  RepoContextEngine: vi.fn().mockImplementation(() => ({
    buildPacket: vi.fn(async () => ({ selectedRefs: [], injectableRefs: [], rejectedRefs: [] })),
  })),
}));
vi.mock('../services/context/core/workflow-context-injection-adapter.js', () => ({
  WorkflowContextInjectionAdapter: vi.fn().mockImplementation(() => ({})),
  summarizeInjection: vi.fn(() => ''),
}));
vi.mock('../services/repo.service.js', () => ({
  RepoService: vi.fn().mockImplementation(() => ({
    list: vi.fn(async () => []),
  })),
}));
vi.mock('../services/context/portability/repo-context-portability.service.js', () => ({
  RepoContextPortabilityService: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../services/chat-tools.js', () => ({
  executeChatTool: vi.fn(async () => ({ execution_id: 'test-exec' })),
}));

const archiveManyMock = vi.fn();
const deactivateManyMock = vi.fn();
const mandatoryUpdateMock = vi.fn();

vi.mock('../services/context/judge/curated-context-editor.service.js', () => ({
  CuratedContextEditorService: vi.fn().mockImplementation(() => ({
    getEntry: vi.fn(async () => null),
    applyEdit: vi.fn(async () => ({ revision: {}, entry: {} })),
    archiveMany: archiveManyMock,
  })),
}));

vi.mock('../services/context/mandatory/repo-mandatory-context.service.js', () => ({
  RepoMandatoryContextService: vi.fn().mockImplementation(() => ({
    list: vi.fn(async () => []),
    listAgents: vi.fn(async () => []),
    update: mandatoryUpdateMock,
    upsert: vi.fn(async () => ({})),
    saveManyFromAgent: vi.fn(async () => ({ saved: 0, mappings: [] })),
    deactivateMany: deactivateManyMock,
  })),
}));

// ── App setup ─────────────────────────────────────────────────────────────────
import { repoRoutes } from './repo.routes.js';

function makeApp() {
  const fakeDb = {
    collection: vi.fn().mockReturnValue({
      find: vi.fn().mockReturnValue({ toArray: vi.fn(async () => []) }),
      findOne: vi.fn(async () => null),
      updateOne: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ modifiedCount: 0 })),
      insertOne: vi.fn(async () => ({ insertedId: 'id1' })),
      countDocuments: vi.fn(async () => 0),
    }),
    admin: vi.fn().mockReturnValue({
      command: vi.fn(async () => ({ ismaster: false, setName: null })),
    }),
  } as unknown as Db;

  const app = express();
  app.use(express.json());
  app.use('/repos', repoRoutes(fakeDb));
  return app;
}

describe('POST /repos/:id/context-management/entries/bulk-delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 when entryIds is empty array', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/repos/repo-123/context-management/entries/bulk-delete')
      .send({ entryIds: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/non-empty/);
  });

  it('returns 400 when entryIds exceeds max batch size', async () => {
    const app = makeApp();
    const entryIds = Array.from({ length: 201 }, (_, i) => `entry-${i}`);
    const res = await request(app)
      .post('/repos/repo-123/context-management/entries/bulk-delete')
      .send({ entryIds });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/200/);
  });

  it('returns 400 when entryIds is missing', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/repos/repo-123/context-management/entries/bulk-delete')
      .send({});
    expect(res.status).toBe(400);
  });

  it('calls archiveMany and returns summary on success', async () => {
    archiveManyMock.mockResolvedValueOnce({ requested: 2, affected: 2, skipped: 0, items: [] });
    const app = makeApp();
    const res = await request(app)
      .post('/repos/repo-123/context-management/entries/bulk-delete')
      .send({ entryIds: ['entry-1', 'entry-2'] });
    expect(res.status).toBe(200);
    expect(res.body.requested).toBe(2);
    expect(res.body.affected).toBe(2);
    expect(archiveManyMock).toHaveBeenCalledWith(
      'repo-123',
      ['entry-1', 'entry-2'],
      { actor: 'user', source: 'manual_context_management' },
    );
  });

  it('returns partial result when some entries are skipped', async () => {
    archiveManyMock.mockResolvedValueOnce({
      requested: 3, affected: 2, skipped: 1,
      items: [
        { entryId: 'entry-1', status: 'archived' },
        { entryId: 'entry-2', status: 'archived' },
        { entryId: 'entry-3', status: 'skipped', reason: 'not_found' },
      ],
    });
    const app = makeApp();
    const res = await request(app)
      .post('/repos/repo-123/context-management/entries/bulk-delete')
      .send({ entryIds: ['entry-1', 'entry-2', 'entry-3'] });
    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe(1);
  });
});

describe('POST /repos/:id/context-management/mandatory/bulk-delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 when mappingIds is empty array', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/repos/repo-123/context-management/mandatory/bulk-delete')
      .send({ mappingIds: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/non-empty/);
  });

  it('returns 400 when mappingIds exceeds max batch size', async () => {
    const app = makeApp();
    const mappingIds = Array.from({ length: 201 }, (_, i) => `mapping-${i}`);
    const res = await request(app)
      .post('/repos/repo-123/context-management/mandatory/bulk-delete')
      .send({ mappingIds });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/200/);
  });

  it('calls deactivateMany and returns summary on success', async () => {
    deactivateManyMock.mockResolvedValueOnce({ requested: 2, affected: 2, skipped: 0 });
    const app = makeApp();
    const res = await request(app)
      .post('/repos/repo-123/context-management/mandatory/bulk-delete')
      .send({ mappingIds: ['mapping-1', 'mapping-2'] });
    expect(res.status).toBe(200);
    expect(res.body.requested).toBe(2);
    expect(res.body.affected).toBe(2);
    expect(deactivateManyMock).toHaveBeenCalledWith(
      'repo-123',
      ['mapping-1', 'mapping-2'],
      { reason: undefined },
    );
  });

  it('passes reason when provided', async () => {
    deactivateManyMock.mockResolvedValueOnce({ requested: 1, affected: 1, skipped: 0 });
    const app = makeApp();
    const res = await request(app)
      .post('/repos/repo-123/context-management/mandatory/bulk-delete')
      .send({ mappingIds: ['mapping-1'], reason: 'user_removed' });
    expect(res.status).toBe(200);
    expect(deactivateManyMock).toHaveBeenCalledWith(
      'repo-123',
      ['mapping-1'],
      { reason: 'user_removed' },
    );
  });
});
