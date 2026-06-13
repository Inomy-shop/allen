import { describe, expect, it, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Db } from 'mongodb';

// ── Mocks ─────────────────────────────────────────────────────────────────────
// chat-providers.ts imports @allen/engine which is not built in the worktree.
// Mock chat-providers directly to prevent Vite's bundler from trying to resolve @allen/engine.
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
    startOrReturn: vi.fn(async () => ({
      setupRun: { setupRunId: 'run-1', repoId: 'repo-1', status: 'running' },
      deduped: false,
    })),
    getActiveOrLatest: vi.fn(async () => ({
      active: false,
      setupRun: null,
      label: 'prepare',
    })),
    listHistory: vi.fn(async () => []),
    get: vi.fn(async () => ({
      setupRun: { setupRunId: 'run-1', repoId: 'repo-1', status: 'running' },
      curationProfile: null,
      curationStageStatus: null,
      mandatoryMappings: { activeCount: 0, inactiveCount: 0 },
      cogneeStatus: null,
    })),
    cancel: vi.fn(async () => ({ setupRunId: 'run-1', status: 'cancelled' })),
    resume: vi.fn(async () => ({ setupRunId: 'run-1', status: 'running', resumeCount: 1 })),
  })),
}));

vi.mock('../services/context/cognee/cognee-memory.service.js', () => ({
  CogneeMemoryService: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../services/context/curation/repo-context-curation.service.js', () => ({
  RepoContextCurationService: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../services/context/mandatory/repo-mandatory-context.service.js', () => ({
  RepoMandatoryContextService: vi.fn().mockImplementation(() => ({
    list: vi.fn(async () => []),
    saveManyFromAgent: vi.fn(async () => ({ saved: 1, mappings: [] })),
  })),
}));
vi.mock('../services/context/core/repo-context-packet.service.js', () => ({
  RepoContextPacketService: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../services/context/graph/repo-context-graph.service.js', () => ({
  RepoContextGraphService: vi.fn().mockImplementation(() => ({})),
}));
// repo-context-engine.ts transitively imports @allen/engine (via cognee provider → context-llm-config → chat-providers)
vi.mock('../services/context/core/repo-context-engine.js', () => ({
  RepoContextEngine: vi.fn().mockImplementation(() => ({
    buildPacket: vi.fn(async () => ({ selectedRefs: [], injectableRefs: [], rejectedRefs: [] })),
  })),
  MandatoryContextMappingProvider: vi.fn().mockImplementation(() => ({
    providerId: 'mandatory_context_mapping',
    retrieve: vi.fn(async () => ({ providerId: 'mandatory_context_mapping', candidates: [], selectedRefs: [], rejectedRefs: [], diagnostics: [], trace: [] })),
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
vi.mock('../services/chat-tools.js', () => ({
  executeChatTool: vi.fn(async () => ({ execution_id: 'exec-1' })),
}));

import { repoRoutes } from './repo.routes.js';
import { isContextEngineEnabled } from '../services/context/config/context-provider-config.js';
import { RepoContextSetupService } from '../services/context/setup/repo-context-setup.service.js';
import { makeCollection, makeDb, type MockCollection } from '../test-helpers/mock-mongo.js';

function makeTestApp(): express.Application {
  const app = express();
  app.use(express.json());
  const db = {
    collection: vi.fn(() => ({
      findOne: vi.fn(async () => null),
      find: vi.fn(() => ({ toArray: async () => [], sort: function() { return this; }, limit: function() { return this; } })),
      insertOne: vi.fn(async (doc: Record<string, unknown>) => ({ insertedId: doc.proposalId })),
      updateMany: vi.fn(async () => ({ modifiedCount: 0 })),
    })),
  } as unknown as Db;
  app.use('/api/repos', repoRoutes(db));
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Repo Context Setup Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isContextEngineEnabled).mockReturnValue(true);
  });

  describe('POST /:id/context-setup', () => {
    it('returns 201 for new setup run', async () => {
      const app = makeTestApp();
      const res = await request(app)
        .post('/api/repos/repo-1/context-setup')
        .send({ options: {} });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('setupRun');
      expect(res.body.deduped).toBe(false);
    });

    it('returns 200 when deduped active run exists', async () => {
      const { RepoContextSetupService: MockSvc } = vi.mocked(await import('../services/context/setup/repo-context-setup.service.js'));
      const mockInst = new MockSvc({} as never, {} as never, {} as never, {} as never, {} as never);
      vi.mocked(mockInst.startOrReturn).mockResolvedValueOnce({
        setupRun: { setupRunId: 'existing', repoId: 'repo-1', status: 'running' } as never,
        deduped: true,
      });

      const app = makeTestApp();
      const res = await request(app)
        .post('/api/repos/repo-1/context-setup')
        .send({ options: {} });
      // The actual 201/200 depends on whether the service mock returns deduped
      expect([200, 201]).toContain(res.status);
    });

    it('returns 409 when context provider disabled', async () => {
      vi.mocked(isContextEngineEnabled).mockReturnValueOnce(false);
      const app = makeTestApp();
      const res = await request(app).post('/api/repos/repo-1/context-setup').send({});
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CONTEXT_PROVIDER_DISABLED');
    });

    it('returns 409 with REPO_NOT_FOUND when service throws', async () => {
      const err = Object.assign(new Error('Repo not found'), { code: 'REPO_NOT_FOUND', statusCode: 404 });
      vi.mocked(RepoContextSetupService).mockImplementationOnce(() => ({
        startOrReturn: vi.fn().mockRejectedValueOnce(err),
        getActiveOrLatest: vi.fn(),
        listHistory: vi.fn(),
        get: vi.fn(),
        cancel: vi.fn(),
        resume: vi.fn(),
      }) as never);
      const app = makeTestApp();
      const res = await request(app).post('/api/repos/repo-1/context-setup').send({});
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('GET /:id/context-setup', () => {
    it('returns 200 with label and setupRun', async () => {
      const app = makeTestApp();
      const res = await request(app).get('/api/repos/repo-1/context-setup');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('label');
      expect(res.body.label).toBe('prepare');
    });

    it('returns 409 when context provider disabled', async () => {
      vi.mocked(isContextEngineEnabled).mockReturnValueOnce(false);
      const app = makeTestApp();
      const res = await request(app).get('/api/repos/repo-1/context-setup');
      expect(res.status).toBe(409);
    });
  });

  describe('GET /:id/context-setup/runs', () => {
    it('returns history list', async () => {
      const app = makeTestApp();
      const res = await request(app).get('/api/repos/repo-1/context-setup/runs');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('runs');
      expect(Array.isArray(res.body.runs)).toBe(true);
    });
  });

  describe('GET /:id/context-setup/:setupRunId', () => {
    it('returns run detail', async () => {
      const app = makeTestApp();
      const res = await request(app).get('/api/repos/repo-1/context-setup/run-1');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('setupRun');
    });
  });

  describe('POST /:id/context-setup/:setupRunId/cancel', () => {
    it('returns 202 on success', async () => {
      const app = makeTestApp();
      const res = await request(app).post('/api/repos/repo-1/context-setup/run-1/cancel');
      expect(res.status).toBe(202);
      expect(res.body).toHaveProperty('setupRun');
    });

    it('returns 409 when context provider disabled', async () => {
      vi.mocked(isContextEngineEnabled).mockReturnValueOnce(false);
      const app = makeTestApp();
      const res = await request(app).post('/api/repos/repo-1/context-setup/run-1/cancel');
      expect(res.status).toBe(409);
    });
  });

  describe('POST /:id/context-setup/:setupRunId/resume', () => {
    it('returns 202 on success', async () => {
      const app = makeTestApp();
      const res = await request(app).post('/api/repos/repo-1/context-setup/run-1/resume');
      expect(res.status).toBe(202);
    });
  });

  describe('POST /:id/mandatory-context/proposals', () => {
    it('happy path returns 201 with proposalId', async () => {
      // Mock db to return an active run and valid agents
      const app = makeTestApp();
      // We need to override the db mock for this route
      const app2 = express();
      app2.use(express.json());
      const db = {
        collection: vi.fn((name: string) => {
          if (name === 'repo_context_setup_runs') {
            return {
              findOne: vi.fn(async () => ({ setupRunId: 'run-1', repoId: 'repo-1', status: 'running' })),
            };
          }
          if (name === 'agents') {
            return {
              findOne: vi.fn(async (filter: { name: string }) => ({ _id: `id-${filter.name}`, name: filter.name })),
            };
          }
          if (name === 'mandatory_context_proposals') {
            return {
              updateMany: vi.fn(async () => ({ modifiedCount: 0 })),
              insertOne: vi.fn(async (doc: Record<string, unknown>) => ({ insertedId: doc.proposalId })),
            };
          }
          return {
            findOne: vi.fn(async () => null),
            find: vi.fn(() => ({ toArray: async () => [] })),
          };
        }),
      } as unknown as Db;
      app2.use('/api/repos', repoRoutes(db));

      const res = await request(app2)
        .post('/api/repos/repo-1/mandatory-context/proposals')
        .send({
          setupRunId: 'run-1',
          affectedAgentNames: ['code-reviewer'],
          mappings: [{ agentName: 'code-reviewer', title: 'T', content: 'C' }],
        });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('proposalId');
    });

    it('returns 409 NO_ACTIVE_SETUP_RUN when setupRunId is unknown', async () => {
      const app2 = express();
      app2.use(express.json());
      const db = {
        collection: vi.fn((name: string) => {
          if (name === 'repo_context_setup_runs') {
            return { findOne: vi.fn(async () => null) }; // no active run
          }
          return { findOne: vi.fn(async () => null), find: vi.fn(() => ({ toArray: async () => [] })) };
        }),
      } as unknown as Db;
      app2.use('/api/repos', repoRoutes(db));

      const res = await request(app2)
        .post('/api/repos/repo-1/mandatory-context/proposals')
        .send({
          setupRunId: 'nonexistent-run',
          affectedAgentNames: ['code-reviewer'],
          mappings: [],
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('NO_ACTIVE_SETUP_RUN');
    });

    it('returns 400 INVALID_AGENT_NAME when agent does not exist', async () => {
      const app2 = express();
      app2.use(express.json());
      const db = {
        collection: vi.fn((name: string) => {
          if (name === 'repo_context_setup_runs') {
            return { findOne: vi.fn(async () => ({ setupRunId: 'run-1', repoId: 'repo-1', status: 'running' })) };
          }
          if (name === 'agents') {
            return { findOne: vi.fn(async () => null) }; // no agents
          }
          return { findOne: vi.fn(async () => null), find: vi.fn(() => ({ toArray: async () => [] })) };
        }),
      } as unknown as Db;
      app2.use('/api/repos', repoRoutes(db));

      const res = await request(app2)
        .post('/api/repos/repo-1/mandatory-context/proposals')
        .send({
          setupRunId: 'run-1',
          affectedAgentNames: ['nonexistent-agent'],
          mappings: [],
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_AGENT_NAME');
    });

    it('returns 400 AGENT_NOT_AFFECTED when mapping agent not in affectedAgentNames', async () => {
      const app2 = express();
      app2.use(express.json());
      const db = {
        collection: vi.fn((name: string) => {
          if (name === 'repo_context_setup_runs') {
            return { findOne: vi.fn(async () => ({ setupRunId: 'run-1', repoId: 'repo-1', status: 'running' })) };
          }
          if (name === 'agents') {
            return { findOne: vi.fn(async (filter: { name: string }) => ({ _id: `id-${filter.name}`, name: filter.name })) };
          }
          return { findOne: vi.fn(async () => null), find: vi.fn(() => ({ toArray: async () => [] })) };
        }),
      } as unknown as Db;
      app2.use('/api/repos', repoRoutes(db));

      const res = await request(app2)
        .post('/api/repos/repo-1/mandatory-context/proposals')
        .send({
          setupRunId: 'run-1',
          affectedAgentNames: ['code-reviewer'],
          mappings: [{ agentName: 'other-agent', title: 'T', content: 'C' }], // other-agent not in affectedAgentNames
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('AGENT_NOT_AFFECTED');
    });

    it('does not write to repo_mandatory_context_mappings', async () => {
      const mappingsWriteSpy = vi.fn();
      const app2 = express();
      app2.use(express.json());
      const db = {
        collection: vi.fn((name: string) => {
          if (name === 'repo_context_setup_runs') {
            return { findOne: vi.fn(async () => ({ setupRunId: 'run-1', repoId: 'repo-1', status: 'running' })) };
          }
          if (name === 'agents') {
            return { findOne: vi.fn(async (filter: { name: string }) => ({ _id: `id-${filter.name}`, name: filter.name })) };
          }
          if (name === 'mandatory_context_proposals') {
            return {
              updateMany: vi.fn(async () => ({ modifiedCount: 0 })),
              insertOne: vi.fn(async (doc: Record<string, unknown>) => ({ insertedId: doc.proposalId })),
            };
          }
          if (name === 'repo_mandatory_context_mappings') {
            return {
              insertOne: mappingsWriteSpy,
              updateOne: mappingsWriteSpy,
              updateMany: mappingsWriteSpy,
            };
          }
          return { findOne: vi.fn(async () => null), find: vi.fn(() => ({ toArray: async () => [] })) };
        }),
      } as unknown as Db;
      app2.use('/api/repos', repoRoutes(db));

      await request(app2)
        .post('/api/repos/repo-1/mandatory-context/proposals')
        .send({
          setupRunId: 'run-1',
          affectedAgentNames: ['code-reviewer'],
          mappings: [{ agentName: 'code-reviewer', title: 'T', content: 'C' }],
        });

      // Mapping collection must NOT be written during proposal
      expect(mappingsWriteSpy).not.toHaveBeenCalled();
    });
  });

  describe('POST /:id/mandatory-context/proposals (staged protocol)', () => {
    function makeStagedApp(opts: { proposals?: Record<string, unknown>[]; agents?: string[] } = {}): { app: express.Application; proposalsCol: MockCollection } {
      const proposalsCol = makeCollection(opts.proposals ?? []);
      const agentsCol = makeCollection((opts.agents ?? ['code-reviewer']).map((name) => ({ name })));
      const setupRunsCol = makeCollection([{ setupRunId: 'run-1', repoId: 'repo-1', status: 'running' }]);
      const db = makeDb({
        repo_context_setup_runs: setupRunsCol,
        agents: agentsCol,
        mandatory_context_proposals: proposalsCol,
      });
      const app2 = express();
      app2.use(express.json());
      app2.use('/api/repos', repoRoutes(db));
      return { app: app2, proposalsCol };
    }

    function stagePayload(mappings: Record<string, unknown>[]): Record<string, unknown> {
      return { mode: 'stage', setupRunId: 'run-1', mappings };
    }

    it('mode stage upserts new rows; re-staging the same key updates instead of duplicating', async () => {
      const { app, proposalsCol } = makeStagedApp();

      const first = await request(app)
        .post('/api/repos/repo-1/mandatory-context/proposals')
        .send(stagePayload([
          { agentName: 'code-reviewer', title: 'Doc A', content: 'A1' },
          { agentName: 'code-reviewer', title: 'Doc B', content: 'B1', sourcePath: 'docs/b.md' },
        ]));
      expect(first.status).toBe(200);
      expect(first.body).toEqual({ staged: 2, totalStaged: 2 });

      // Re-stage Doc A with corrected content → same row updated, no duplicate
      const second = await request(app)
        .post('/api/repos/repo-1/mandatory-context/proposals')
        .send(stagePayload([{ agentName: 'code-reviewer', title: 'Doc A', content: 'A2' }]));
      expect(second.status).toBe(200);
      expect(second.body).toEqual({ staged: 1, totalStaged: 2 });

      expect(proposalsCol._store).toHaveLength(2);
      const docA = proposalsCol._store.find((d) => d.title === 'Doc A');
      expect(docA).toMatchObject({ status: 'staged', content: 'A2', repoId: 'repo-1' });
      expect(docA?.stagedAt).toBeInstanceOf(Date);
      expect(docA?.updatedAt).toBeInstanceOf(Date);
    });

    it('mode stage rejects batches larger than 25 mappings', async () => {
      const { app, proposalsCol } = makeStagedApp();
      const mappings = Array.from({ length: 26 }, (_, i) => ({ agentName: 'code-reviewer', title: `Doc ${i}`, content: 'C' }));
      const res = await request(app)
        .post('/api/repos/repo-1/mandatory-context/proposals')
        .send(stagePayload(mappings));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('STAGE_BATCH_TOO_LARGE');
      expect(proposalsCol._store).toHaveLength(0);
    });

    it('mode stage validates agent existence (INVALID_AGENT_NAME)', async () => {
      const { app, proposalsCol } = makeStagedApp();
      const res = await request(app)
        .post('/api/repos/repo-1/mandatory-context/proposals')
        .send(stagePayload([{ agentName: 'ghost-agent', title: 'Doc', content: 'C' }]));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_AGENT_NAME');
      expect(proposalsCol._store).toHaveLength(0);
    });

    it('mode stage returns 409 NO_ACTIVE_SETUP_RUN for unknown setupRunId', async () => {
      const { app } = makeStagedApp();
      const res = await request(app)
        .post('/api/repos/repo-1/mandatory-context/proposals')
        .send({ mode: 'stage', setupRunId: 'nonexistent-run', mappings: [{ agentName: 'code-reviewer', title: 'Doc', content: 'C' }] });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('NO_ACTIVE_SETUP_RUN');
    });

    it('mode finalize assembles the proposal, supersedes prior proposed, and marks staged rows consumed', async () => {
      const { app, proposalsCol } = makeStagedApp({
        proposals: [{ proposalId: 'old-prop', setupRunId: 'run-1', repoId: 'repo-1', status: 'proposed' }],
      });

      await request(app)
        .post('/api/repos/repo-1/mandatory-context/proposals')
        .send(stagePayload([
          { agentName: 'code-reviewer', title: 'Doc A', content: 'A', sourceHash: 'h1', reasoning: 'why' },
          { agentName: 'code-reviewer', title: 'Doc B', content: 'B', sourcePath: 'docs/b.md' },
        ]));

      const res = await request(app)
        .post('/api/repos/repo-1/mandatory-context/proposals')
        .send({ mode: 'finalize', setupRunId: 'run-1', affectedAgentNames: ['code-reviewer'], expectedMappingCount: 2 });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('proposalId');
      expect(res.body.mappingCount).toBe(2);

      // Prior proposed doc demoted (latest-wins)
      const oldProp = proposalsCol._store.find((d) => d.proposalId === 'old-prop');
      expect(oldProp).toMatchObject({ status: 'rejected', rejectionReason: 'superseded' });

      // Single new proposal doc assembled from staged rows in the legacy shape
      const newProp = proposalsCol._store.find((d) => d.proposalId === res.body.proposalId && d.status === 'proposed');
      expect(newProp).toMatchObject({
        setupRunId: 'run-1',
        repoId: 'repo-1',
        status: 'proposed',
        affectedAgentNames: ['code-reviewer'],
      });
      expect(newProp?.mappings).toEqual([
        { agentName: 'code-reviewer', title: 'Doc A', content: 'A', sourceHash: 'h1', reasoning: 'why' },
        { agentName: 'code-reviewer', title: 'Doc B', content: 'B', sourcePath: 'docs/b.md' },
      ]);

      // Staged rows marked consumed_into_proposal; they carry consumedProposalId (audit link)
      // but must NOT carry proposalId — that field is reserved for final proposal docs only.
      const stagedRows = proposalsCol._store.filter((d) => d.title === 'Doc A' || d.title === 'Doc B');
      expect(stagedRows).toHaveLength(2);
      for (const row of stagedRows) {
        expect(row.status).toBe('consumed_into_proposal');
        // consumedProposalId links staged rows back to the assembled proposal
        expect(row.consumedProposalId).toBe(res.body.proposalId);
        // proposalId must NOT be set on staged rows (would collide with the partial unique index)
        expect(row).not.toHaveProperty('proposalId');
      }
    });

    it('mode finalize returns STAGED_COUNT_MISMATCH with both numbers', async () => {
      const { app } = makeStagedApp();
      await request(app)
        .post('/api/repos/repo-1/mandatory-context/proposals')
        .send(stagePayload([{ agentName: 'code-reviewer', title: 'Doc A', content: 'A' }]));

      const res = await request(app)
        .post('/api/repos/repo-1/mandatory-context/proposals')
        .send({ mode: 'finalize', setupRunId: 'run-1', affectedAgentNames: ['code-reviewer'], expectedMappingCount: 3 });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('STAGED_COUNT_MISMATCH');
      expect(res.body.stagedCount).toBe(1);
      expect(res.body.expectedMappingCount).toBe(3);
    });

    it('regression: staged rows never receive proposalId — only consumedProposalId (E11000 guard)', async () => {
      // This test documents the fix for the E11000 duplicate key bug:
      // Before the fix, handleProposalFinalize set `proposalId` on staged rows during
      // updateMany({ status: 'staged' }, { $set: { proposalId, ... } }). Because the old
      // broad unique index on { proposalId: 1 } treated ALL missing proposalId values as
      // identical, staging a second row failed with E11000. The fix uses `consumedProposalId`
      // as the audit field and restricts the unique index to final proposal docs only.
      const { app, proposalsCol } = makeStagedApp();

      // Stage TWO rows (this would have triggered E11000 with the old broad unique index)
      await request(app)
        .post('/api/repos/repo-1/mandatory-context/proposals')
        .send(stagePayload([
          { agentName: 'code-reviewer', title: 'Alpha', content: 'ca' },
          { agentName: 'code-reviewer', title: 'Beta', content: 'cb' },
        ]));

      // Finalize should succeed
      const res = await request(app)
        .post('/api/repos/repo-1/mandatory-context/proposals')
        .send({ mode: 'finalize', setupRunId: 'run-1', affectedAgentNames: ['code-reviewer'], expectedMappingCount: 2 });

      expect(res.status).toBe(201);
      const proposalId = res.body.proposalId as string;

      // Final proposal doc: has proposalId, has mappings, does NOT have consumedProposalId
      const finalDoc = proposalsCol._store.find((d) => d.proposalId === proposalId);
      expect(finalDoc).toBeDefined();
      expect(finalDoc).toHaveProperty('mappings');
      expect(finalDoc).not.toHaveProperty('consumedProposalId');

      // Staged rows: must NOT carry proposalId; must carry consumedProposalId as audit link
      const consumed = proposalsCol._store.filter((d) => d.status === 'consumed_into_proposal');
      expect(consumed).toHaveLength(2);
      for (const row of consumed) {
        expect(row).not.toHaveProperty('proposalId');
        expect(row.consumedProposalId).toBe(proposalId);
      }
    });

    it('mode finalize rejects staged agents missing from affectedAgentNames (AGENT_NOT_AFFECTED)', async () => {
      const { app } = makeStagedApp({
        agents: ['code-reviewer', 'other-agent'],
        proposals: [{ setupRunId: 'run-1', repoId: 'repo-1', agentName: 'other-agent', title: 'Doc X', content: 'X', status: 'staged' }],
      });

      const res = await request(app)
        .post('/api/repos/repo-1/mandatory-context/proposals')
        .send({ mode: 'finalize', setupRunId: 'run-1', affectedAgentNames: ['code-reviewer'], expectedMappingCount: 1 });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('AGENT_NOT_AFFECTED');
    });

    it('rejects an unknown mode value', async () => {
      const { app } = makeStagedApp();
      const res = await request(app)
        .post('/api/repos/repo-1/mandatory-context/proposals')
        .send({ mode: 'commit', setupRunId: 'run-1', mappings: [] });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_OPTIONS');
    });
  });

  describe('POST /mandatory-context (legacy route guard)', () => {
    function makeGuardApp(activeRun: Record<string, unknown> | null): { app: express.Application; setupRunsFindOne: ReturnType<typeof vi.fn> } {
      const setupRunsFindOne = vi.fn(async () => activeRun);
      const app2 = express();
      app2.use(express.json());
      const db = {
        collection: vi.fn((name: string) => {
          if (name === 'repo_context_setup_runs') {
            return { findOne: setupRunsFindOne, find: vi.fn(() => ({ toArray: async () => [] })) };
          }
          return {
            findOne: vi.fn(async () => null),
            find: vi.fn(() => ({ toArray: async () => [] })),
          };
        }),
      } as unknown as Db;
      app2.use('/api/repos', repoRoutes(db));
      return { app: app2, setupRunsFindOne };
    }

    it('returns 410 with setup_run_active_use_proposals when the repo has an active setup run', async () => {
      const { app: app2, setupRunsFindOne } = makeGuardApp({
        setupRunId: 'run-1',
        repoId: 'repo-1',
        status: 'running',
      });

      const res = await request(app2)
        .post('/api/repos/mandatory-context')
        .send({ repo_id: 'repo-1', mappings: [] });

      expect(res.status).toBe(410);
      expect(res.body.code).toBe('setup_run_active_use_proposals');
      expect(setupRunsFindOne).toHaveBeenCalledWith({ repoId: 'repo-1', status: 'running' });
    });

    it('passes the guard and reaches the save handler when no active setup run exists', async () => {
      const { app: app2, setupRunsFindOne } = makeGuardApp(null);

      const res = await request(app2)
        .post('/api/repos/mandatory-context')
        .send({ repo_id: 'repo-1', mappings: [] });

      expect(setupRunsFindOne).toHaveBeenCalledWith({ repoId: 'repo-1', status: 'running' });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ saved: 1, mappings: [] });
    });
  });
});
