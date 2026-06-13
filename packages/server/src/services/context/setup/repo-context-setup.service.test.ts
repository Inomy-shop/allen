import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Db } from 'mongodb';

// ── Mocked modules ────────────────────────────────────────────────────────────

vi.mock('node:fs', () => ({ existsSync: vi.fn(() => true) }));
vi.mock('../config/context-provider-config.js', () => ({
  isContextEngineEnabled: vi.fn(() => true),
  isCogneeContextEnabled: vi.fn(() => true),
}));
vi.mock('../curation/repo-context-curation-git.js', () => ({
  resolveDefaultBranchName: vi.fn(() => 'main'),
  fetchBranch: vi.fn(async () => undefined),
  revParse: vi.fn(async () => 'abc123'),
}));
vi.mock('../curation/repo-context-curation-runner.js', () => ({
  getRepoContextCurationStageStatus: vi.fn(async () => ({
    promotable: true,
    validEntries: 5,
    expectedFiles: 5,
    retryFiles: [],
    entries: [],
    diagnostics: [],
    runId: 'run-1',
    status: 'validated',
    stagedEntries: 5,
    stagedStatuses: 5,
    completedFiles: 5,
    missingFiles: [],
    invalidFiles: [],
    duplicateStatusFiles: [],
  })),
  markRepoContextCurationRunPromoted: vi.fn(async () => {}),
}));
vi.mock('../../alert.service.js', () => ({
  AlertService: vi.fn().mockImplementation(() => ({
    create: vi.fn().mockResolvedValue({}),
  })),
}));
vi.mock('../../execution.service.js', () => ({
  ExecutionService: vi.fn().mockImplementation(() => ({
    cancel: vi.fn().mockResolvedValue(undefined),
  })),
}));
// Dev adaptation: soft-delete — the real module is used but we mock it to return the filter
vi.mock('../../soft-delete.js', () => ({
  notDeletedFilter: { isDeleted: { $ne: true } },
}));

import { RepoContextSetupService, resetFetchThrottleForTests } from './repo-context-setup.service.js';
import { isContextEngineEnabled, isCogneeContextEnabled } from '../config/context-provider-config.js';
import { getRepoContextCurationStageStatus } from '../curation/repo-context-curation-runner.js';
import { fetchBranch, revParse } from '../curation/repo-context-curation-git.js';
import { ExecutionService } from '../../execution.service.js';
import { makeCollection, makeDb } from '../../../test-helpers/mock-mongo.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCuration(overrides?: Partial<{ getLatest: unknown; prepareForCoordinator: unknown; promoteStageFromAgent: unknown; attachExecutionToProfile: unknown }>) {
  return {
    getLatest: vi.fn(async () => ({ headSha: 'abc123', profileId: 'p1', status: 'completed' })),
    prepareForCoordinator: vi.fn(async () => ({
      run_id: 'run-1',
      profile_id: 'p1',
      execution_id: 'exec-1',
      // G1: default to fresh snapshot so existing tests are unaffected
      snapshot: { fresh: true, ref: 'origin/main', head_sha: 'abc123', fetch_ok: true },
    })),
    promoteStageFromAgent: vi.fn(async () => ({ run_id: 'run-1', promoted_entries: 5, stats: {}, diagnostics: [] })),
    attachExecutionToProfile: vi.fn(async () => {}),
    ...overrides,
  } as unknown as import('./repo-context-setup.service.js').RepoContextSetupService['curation' extends keyof RepoContextSetupService ? 'curation' : never];
}

function makeMandatory(overrides?: Partial<{ list: unknown; replaceForRun: unknown }>) {
  return {
    list: vi.fn(async () => []),
    replaceForRun: vi.fn(async () => ({ saved: 2, deactivated: 1 })),
    ...overrides,
  } as unknown as import('./repo-context-setup.service.js').RepoContextSetupService['mandatory' extends keyof RepoContextSetupService ? 'mandatory' : never];
}

function makeCognee(overrides?: Partial<{ getStatus: unknown; scheduleRefreshRepo: unknown; stopRefreshRepo: unknown }>) {
  return {
    getStatus: vi.fn(async () => ({ status: 'completed', workerActive: false })),
    scheduleRefreshRepo: vi.fn(async () => ({ status: 'running' })),
    stopRefreshRepo: vi.fn(async () => {}),
    ...overrides,
  } as unknown as import('./repo-context-setup.service.js').RepoContextSetupService['cognee' extends keyof RepoContextSetupService ? 'cognee' : never];
}

function makeSpawn(execStatus = 'completed') {
  return vi.fn(async () => ({ execution_id: 'child-exec-1' }));
}

// Valid 24-char hex ObjectId for tests. new ObjectId(REPO_ID) must not throw.
const REPO_ID = '507f1f77bcf86cd799439011';

function makeRepo(overrides?: Partial<Record<string, unknown>>) {
  return {
    _id: { toString: () => REPO_ID, toHexString: () => REPO_ID },
    name: 'test-repo',
    path: '/tmp/test-repo',
    ...overrides,
  };
}

/** Helper: make an executions collection where the child exec returns a specific terminal status. */
function makeExecutionsCol(status = 'completed') {
  return makeCollection([{ id: 'child-exec-1', status }]);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RepoContextSetupService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('startOrReturn', () => {
    it('starts a run when none active and returns 201-style result', async () => {
      const reposCol = makeCollection([makeRepo()]);
      const setupRunsCol = makeCollection();
      const agentsCol = makeCollection([{ name: 'repo-context-curator' }, { name: 'repo-mandatory-context-mapper' }]);
      const mcpCol = makeCollection();

      const db = makeDb({ repos: reposCol, repo_context_setup_runs: setupRunsCol, agents: agentsCol, mcp_servers: mcpCol });
      const curation = makeCuration();
      const mandatory = makeMandatory();
      const cognee = makeCognee();
      const spawn = makeSpawn();

      const svc = new RepoContextSetupService(db, curation as never, mandatory as never, cognee as never, spawn);
      const result = await svc.startOrReturn(REPO_ID, {}, 'user-1', 'api');

      expect(result.deduped).toBe(false);
      expect(result.setupRun.status).toBe('running');
      expect(result.setupRun.repoId).toBe(REPO_ID);
      expect(setupRunsCol.insertOne).toHaveBeenCalled();
    });

    it('dedupes second concurrent start — returns active run with deduped:true', async () => {
      const activeRun = {
        setupRunId: 'existing-run',
        repoId: REPO_ID,
        status: 'running',
        phases: { preflight: { status: 'completed' }, curation: { status: 'running' }, mandatoryMapping: { status: 'pending' }, contextRefresh: { status: 'pending' } },
      };
      const reposCol = makeCollection([makeRepo()]);
      const setupRunsCol = makeCollection([activeRun]);
      const db = makeDb({ repos: reposCol, repo_context_setup_runs: setupRunsCol, agents: makeCollection(), mcp_servers: makeCollection() });

      const svc = new RepoContextSetupService(db, makeCuration() as never, makeMandatory() as never, makeCognee() as never, makeSpawn());
      const result = await svc.startOrReturn(REPO_ID, {}, 'user-1');

      expect(result.deduped).toBe(true);
      expect(result.setupRun.setupRunId).toBe('existing-run');
    });

    it('dedupes when status is partial (REQ-005, AC-002)', async () => {
      const partialRun = { setupRunId: 'partial-run', repoId: REPO_ID, status: 'partial', phases: { preflight: { status: 'completed' }, curation: { status: 'completed' }, mandatoryMapping: { status: 'completed' }, contextRefresh: { status: 'failed' } } };
      const reposCol = makeCollection([makeRepo()]);
      const setupRunsCol = makeCollection([partialRun]);
      const db = makeDb({ repos: reposCol, repo_context_setup_runs: setupRunsCol, agents: makeCollection(), mcp_servers: makeCollection() });

      const svc = new RepoContextSetupService(db, makeCuration() as never, makeMandatory() as never, makeCognee() as never, makeSpawn());
      const result = await svc.startOrReturn(REPO_ID, {}, 'user-1');
      expect(result.deduped).toBe(true);
      expect(result.setupRun.status).toBe('partial');
    });

    it('preflight fails when context provider disabled — throws CONTEXT_PROVIDER_DISABLED', async () => {
      vi.mocked(isContextEngineEnabled).mockReturnValueOnce(false);
      const reposCol = makeCollection([makeRepo()]);
      const db = makeDb({ repos: reposCol, repo_context_setup_runs: makeCollection(), agents: makeCollection(), mcp_servers: makeCollection() });
      const svc = new RepoContextSetupService(db, makeCuration() as never, makeMandatory() as never, makeCognee() as never, makeSpawn());

      await expect(svc.startOrReturn(REPO_ID, {}, undefined)).rejects.toMatchObject({ code: 'CONTEXT_PROVIDER_DISABLED' });
    });

    it('preflight fails on missing agent — no child spawned', async () => {
      const reposCol = makeCollection([makeRepo()]);
      const setupRunsCol = makeCollection();
      // No agents registered
      const db = makeDb({ repos: reposCol, repo_context_setup_runs: setupRunsCol, agents: makeCollection(), mcp_servers: makeCollection() });
      const spawn = makeSpawn();
      const svc = new RepoContextSetupService(db, makeCuration() as never, makeMandatory() as never, makeCognee() as never, spawn);

      await expect(svc.startOrReturn(REPO_ID, {}, undefined)).rejects.toMatchObject({ code: 'AGENT_MISSING' });
      expect(spawn).not.toHaveBeenCalled();
    });

    it('preflight Cognee disabled (default options): refresh phase skipped, final status completed (EC)', async () => {
      vi.mocked(isCogneeContextEnabled).mockReturnValueOnce(false);
      const reposCol = makeCollection([makeRepo()]);
      const setupRunsCol = makeCollection();
      const agentsCol = makeCollection([{ name: 'repo-context-curator' }, { name: 'repo-mandatory-context-mapper' }]);
      const db = makeDb({ repos: reposCol, repo_context_setup_runs: setupRunsCol, agents: agentsCol, mcp_servers: makeCollection() });
      const svc = new RepoContextSetupService(db, makeCuration() as never, makeMandatory() as never, makeCognee() as never, makeSpawn());

      const result = await svc.startOrReturn(REPO_ID, {}, undefined);
      expect(result.deduped).toBe(false);
      expect(result.setupRun.phases.contextRefresh.status).toBe('skipped');
    });

    it('preflight Cognee disabled + cleanRebuildCognee=true: hard fail COGNEE_DISABLED_BUT_REQUIRED', async () => {
      vi.mocked(isCogneeContextEnabled).mockReturnValueOnce(false);
      const reposCol = makeCollection([makeRepo()]);
      const db = makeDb({ repos: reposCol, repo_context_setup_runs: makeCollection(), agents: makeCollection([{ name: 'repo-context-curator' }, { name: 'repo-mandatory-context-mapper' }]), mcp_servers: makeCollection() });
      const svc = new RepoContextSetupService(db, makeCuration() as never, makeMandatory() as never, makeCognee() as never, makeSpawn());

      await expect(svc.startOrReturn(REPO_ID, { cleanRebuildCognee: true }, undefined)).rejects.toMatchObject({ code: 'COGNEE_DISABLED_BUT_REQUIRED' });
    });

    it('throws INVALID_OPTIONS for conflicting cleanRebuildCognee + skipCognee', async () => {
      const db = makeDb({ repos: makeCollection([makeRepo()]), repo_context_setup_runs: makeCollection(), agents: makeCollection(), mcp_servers: makeCollection() });
      const svc = new RepoContextSetupService(db, makeCuration() as never, makeMandatory() as never, makeCognee() as never, makeSpawn());

      await expect(svc.startOrReturn(REPO_ID, { cleanRebuildCognee: true, skipCognee: true }, undefined)).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    });

    it('no version field is written anywhere (AC-010)', async () => {
      const reposCol = makeCollection([makeRepo()]);
      const setupRunsCol = makeCollection();
      const agentsCol = makeCollection([{ name: 'repo-context-curator' }, { name: 'repo-mandatory-context-mapper' }]);
      const db = makeDb({ repos: reposCol, repo_context_setup_runs: setupRunsCol, agents: agentsCol, mcp_servers: makeCollection() });

      const svc = new RepoContextSetupService(db, makeCuration() as never, makeMandatory() as never, makeCognee() as never, makeSpawn());
      const result = await svc.startOrReturn(REPO_ID, {}, undefined);

      expect(result.setupRun).not.toHaveProperty('version');
      const insertedDoc = setupRunsCol._store[0];
      expect(insertedDoc).not.toHaveProperty('version');
    });

    // ── Dev adaptation: soft-delete ──────────────────────────────────────────

    it('preflight fails AGENT_MISSING when curator is soft-deleted (isDeleted:true)', async () => {
      const reposCol = makeCollection([makeRepo()]);
      const setupRunsCol = makeCollection();
      // curator is soft-deleted; mapper is not
      const agentsCol = makeCollection([
        { name: 'repo-context-curator', isDeleted: true },
        { name: 'repo-mandatory-context-mapper' },
      ]);
      const db = makeDb({ repos: reposCol, repo_context_setup_runs: setupRunsCol, agents: agentsCol, mcp_servers: makeCollection() });
      const spawn = makeSpawn();
      const svc = new RepoContextSetupService(db, makeCuration() as never, makeMandatory() as never, makeCognee() as never, spawn);

      await expect(svc.startOrReturn(REPO_ID, {}, undefined)).rejects.toMatchObject({ code: 'AGENT_MISSING' });
      expect(spawn).not.toHaveBeenCalled();
    });
  });

  describe('cancel', () => {
    it('cancels child executions and stops cognee', async () => {
      const run = {
        setupRunId: 'run-1',
        repoId: REPO_ID,
        status: 'running',
        childExecutionIds: ['exec-1', 'exec-2'],
        phases: { preflight: { status: 'completed' }, curation: { status: 'completed' }, mandatoryMapping: { status: 'completed' }, contextRefresh: { status: 'running' } },
        diagnostics: [],
        resumeCount: 0,
      };
      const setupRunsCol = makeCollection([run]);
      const db = makeDb({ repo_context_setup_runs: setupRunsCol, repos: makeCollection(), agents: makeCollection(), mcp_servers: makeCollection() });
      const cognee = makeCognee();
      const svc = new RepoContextSetupService(db, makeCuration() as never, makeMandatory() as never, cognee as never, makeSpawn());

      const result = await svc.cancel('run-1');
      expect(result.status).toBe('cancelled');
      expect(cognee.stopRefreshRepo).toHaveBeenCalledWith(REPO_ID);
    });

    it('throws RUN_NOT_CANCELLABLE for terminal status', async () => {
      const run = { setupRunId: 'run-1', repoId: REPO_ID, status: 'completed', childExecutionIds: [], phases: { preflight: { status: 'completed' }, curation: { status: 'completed' }, mandatoryMapping: { status: 'completed' }, contextRefresh: { status: 'completed' } }, diagnostics: [], resumeCount: 0 };
      const db = makeDb({ repo_context_setup_runs: makeCollection([run]) });
      const svc = new RepoContextSetupService(db, makeCuration() as never, makeMandatory() as never, makeCognee() as never, makeSpawn());

      await expect(svc.cancel('run-1')).rejects.toMatchObject({ code: 'RUN_NOT_CANCELLABLE' });
    });
  });

  describe('resume', () => {
    it('only allowed in non-running terminal states', async () => {
      const runningRun = { setupRunId: 'run-1', repoId: REPO_ID, status: 'running', childExecutionIds: [], phases: { preflight: { status: 'completed' }, curation: { status: 'running' }, mandatoryMapping: { status: 'pending' }, contextRefresh: { status: 'pending' } }, diagnostics: [], resumeCount: 0 };
      const db = makeDb({ repo_context_setup_runs: makeCollection([runningRun]) });
      const svc = new RepoContextSetupService(db, makeCuration() as never, makeMandatory() as never, makeCognee() as never, makeSpawn());

      await expect(svc.resume('run-1')).rejects.toMatchObject({ code: 'RUN_NOT_RESUMABLE' });
    });

    it('resumes a failed run and increments resumeCount', async () => {
      const failedRun = { setupRunId: 'run-1', repoId: REPO_ID, status: 'failed', currentPhase: 'mandatory_mapping', childExecutionIds: [], phases: { preflight: { status: 'completed' }, curation: { status: 'completed' }, mandatoryMapping: { status: 'failed' }, contextRefresh: { status: 'pending' } }, diagnostics: [], resumeCount: 0 };
      const setupRunsCol = makeCollection([failedRun]);
      const proposalsCol = makeCollection();
      const db = makeDb({ repo_context_setup_runs: setupRunsCol, repos: makeCollection([makeRepo()]), mandatory_context_proposals: proposalsCol, executions: makeCollection() });
      const svc = new RepoContextSetupService(db, makeCuration() as never, makeMandatory() as never, makeCognee() as never, makeSpawn());

      const result = await svc.resume('run-1');
      expect(result.resumeCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('reconcileSetupRuns', () => {
    it('marks orphaned running rows as stopped (rule 6)', async () => {
      const run = {
        setupRunId: 'orphan-run',
        repoId: 'repo-1',
        status: 'running',
        currentPhase: 'curation',
        childExecutionIds: [],
        phases: { preflight: { status: 'completed' }, curation: { status: 'running' }, mandatoryMapping: { status: 'pending' }, contextRefresh: { status: 'pending' } },
        updatedAt: new Date(Date.now() - 1000), // very recent — not timed out
        diagnostics: [],
        resumeCount: 0,
      };
      const setupRunsCol = makeCollection([run]);
      setupRunsCol.find = vi.fn(() => ({
        toArray: async () => [run],
        sort: function () { return this; },
        limit: function () { return this; },
      }));
      const db = makeDb({ repo_context_setup_runs: setupRunsCol, repos: makeCollection(), executions: makeCollection(), agents: makeCollection(), mcp_servers: makeCollection() });
      const cognee = makeCognee({ getStatus: vi.fn(async () => null) });
      const svc = new RepoContextSetupService(db, makeCuration() as never, makeMandatory() as never, cognee as never, makeSpawn());

      await svc.reconcileSetupRuns();
      // The orphan with no child exec and no cognee signal should be marked stopped
      expect(setupRunsCol.findOneAndUpdate).toHaveBeenCalled();
    });
  });

  describe('computeLabel', () => {
    async function makeLabel(setupRuns: Record<string, unknown>[], cogneeStatus?: Record<string, unknown> | null, latestProfile?: Record<string, unknown> | null, gitSha?: string) {
      const runsCol = makeCollection(setupRuns);
      runsCol.find = vi.fn(() => ({
        toArray: async () => setupRuns,
        sort: function () { return this; },
        limit: function () { return this; },
      }));
      const db = makeDb({ repo_context_setup_runs: runsCol, repos: makeCollection([makeRepo()]) });
      const cognee = makeCognee({ getStatus: vi.fn(async () => cogneeStatus ?? { status: 'completed', workerActive: false }) });
      const curation = makeCuration({ getLatest: vi.fn(async () => latestProfile ?? { headSha: gitSha ?? 'abc123', profileId: 'p1' }) });
      const svc = new RepoContextSetupService(db, curation as never, makeMandatory() as never, cognee as never, makeSpawn());
      return svc.computeLabel('repo-1');
    }

    it('returns "prepare" when no prior run', async () => {
      const label = await makeLabel([]);
      expect(label).toBe('prepare');
    });

    it('returns "view_progress" while running', async () => {
      const label = await makeLabel([{ setupRunId: 'r1', repoId: 'repo-1', status: 'running', createdAt: new Date() }]);
      expect(label).toBe('view_progress');
    });

    it('returns "resume_setup" for partial run', async () => {
      const label = await makeLabel([{ setupRunId: 'r1', repoId: 'repo-1', status: 'partial', createdAt: new Date() }]);
      expect(label).toBe('resume_setup');
    });

    it('returns "resume_setup" for failed lastRun', async () => {
      const label = await makeLabel([{ setupRunId: 'r1', repoId: 'repo-1', status: 'failed', createdAt: new Date() }]);
      expect(label).toBe('resume_setup');
    });

    it('returns "resume_setup" for stopped run (boot-reconciler orphan)', async () => {
      const label = await makeLabel([{ setupRunId: 'r1', repoId: 'repo-1', status: 'stopped', createdAt: new Date() }]);
      expect(label).toBe('resume_setup');
    });

    it('returns "resume_setup" for cancelled run', async () => {
      const label = await makeLabel([{ setupRunId: 'r1', repoId: 'repo-1', status: 'cancelled', createdAt: new Date() }]);
      expect(label).toBe('resume_setup');
    });

    it('returns "refresh_stale_graph" when curatedContextStale is true', async () => {
      const label = await makeLabel(
        [{ setupRunId: 'r1', repoId: 'repo-1', status: 'completed', createdAt: new Date() }],
        { status: 'completed', curatedContextStale: true, workerActive: false },
      );
      expect(label).toBe('refresh_stale_graph');
    });

    it('returns "check_for_updates" when default-branch HEAD SHA advances past last profile headSha', async () => {
      // git revParse is mocked above to return 'abc123'
      // latestProfile has headSha 'old-sha' which differs from the revParse mock output
      const label = await makeLabel(
        [{ setupRunId: 'r1', repoId: 'repo-1', status: 'completed', createdAt: new Date() }],
        { status: 'completed', curatedContextStale: false, workerActive: false },
        { headSha: 'old-sha', profileId: 'p1' },
      );
      expect(label).toBe('check_for_updates');
    });

    it('returns "check_for_updates" as default when completed and up to date', async () => {
      // When profile headSha matches current SHA (both 'abc123' from the revParse mock)
      const label = await makeLabel(
        [{ setupRunId: 'r1', repoId: 'repo-1', status: 'completed', createdAt: new Date() }],
        { status: 'completed', workerActive: false, curatedContextStale: false },
        { headSha: 'abc123', profileId: 'p1' },
      );
      expect(label).toBe('check_for_updates');
    });
  });

  // ── G2: fetch throttle — at most one git fetch per repo per 5 min ─────────────

  describe('G2: hasCommittedChangesSinceLastRun fetch throttle', () => {
    const THROTTLE_REPO_ID = '507f1f77bcf86cd799439044';

    function makeThrottleLabel(gitSha = 'abc123') {
      const runsCol = makeCollection([{ setupRunId: 'r1', repoId: THROTTLE_REPO_ID, status: 'completed', createdAt: new Date() }]);
      runsCol.find = vi.fn(() => ({
        toArray: async () => [{ setupRunId: 'r1', repoId: THROTTLE_REPO_ID, status: 'completed', createdAt: new Date() }],
        sort: function () { return this; },
        limit: function () { return this; },
      }));
      const db = makeDb({
        repo_context_setup_runs: runsCol,
        repos: makeCollection([{ ...makeRepo(), _id: { toString: () => THROTTLE_REPO_ID, toHexString: () => THROTTLE_REPO_ID } }]),
      });
      const cognee = makeCognee({ getStatus: vi.fn(async () => ({ status: 'completed', workerActive: false, curatedContextStale: false })) });
      const curation = makeCuration({ getLatest: vi.fn(async () => ({ headSha: 'old-sha', profileId: 'p1' })) });
      const svc = new RepoContextSetupService(db, curation as never, makeMandatory() as never, cognee as never, makeSpawn());
      return svc;
    }

    beforeEach(() => {
      // Reset the per-repo throttle cache between tests
      resetFetchThrottleForTests();
      vi.mocked(fetchBranch).mockClear();
      vi.mocked(revParse).mockClear();
    });

    it('G2: first computeLabel call fetches once; second call within window skips the fetch', async () => {
      const svc = makeThrottleLabel();

      // First call — throttle map is empty for THROTTLE_REPO_ID → fetch IS called
      await svc.computeLabel(THROTTLE_REPO_ID);
      expect(vi.mocked(fetchBranch)).toHaveBeenCalledTimes(1);

      // Record current rev-parse call count
      const revParseCallsAfterFirst = vi.mocked(revParse).mock.calls.length;

      // Second call immediately after — throttle guard fires, fetch is skipped
      await svc.computeLabel(THROTTLE_REPO_ID);
      // Still only 1 fetch across both calls
      expect(vi.mocked(fetchBranch)).toHaveBeenCalledTimes(1);
      // But rev-parse was called for both computeLabel invocations
      expect(vi.mocked(revParse).mock.calls.length).toBeGreaterThan(revParseCallsAfterFirst);
    });
  });

  // ── G1: stale snapshot signal propagated to curation phase diagnostics ────────

  describe('G1: stale snapshot propagated to curation phase diagnostics', () => {
    it('runCurationPhase propagates snapshot.fresh=false to phases.curation.diagnostics (non-fatal)', async () => {
      const setupRun = {
        setupRunId: 'g1-setup-run',
        repoId: REPO_ID,
        status: 'running',
        currentPhase: 'curation',
        childExecutionIds: [],
        branch: 'main',
        repoPath: '/tmp/test-repo',
        phases: {
          preflight: { status: 'completed' },
          curation: { status: 'pending' },
          mandatoryMapping: { status: 'pending' },
          contextRefresh: { status: 'pending' },
        },
        diagnostics: [],
        resumeCount: 0,
        options: {},
      };
      const setupRunsCol = makeCollection([setupRun]);
      const agentsCol = makeCollection([{ name: 'repo-context-curator' }]);
      const db = makeDb({
        repos: makeCollection([makeRepo()]),
        repo_context_setup_runs: setupRunsCol,
        agents: agentsCol,
        mcp_servers: makeCollection(),
        mandatory_context_proposals: makeCollection(),
        executions: makeExecutionsCol('completed'),
        repo_context_curation_runs: makeCollection([{ runId: 'run-1', status: 'validated' }]),
      });

      // Curation mock returns stale snapshot
      const staleCuration = makeCuration({
        prepareForCoordinator: vi.fn(async () => ({
          run_id: 'run-1',
          profile_id: 'p1',
          execution_id: 'exec-1',
          snapshot: { fresh: false, ref: 'HEAD', head_sha: 'old-sha', fetch_ok: false },
        })),
      });

      const svc = new RepoContextSetupService(db, staleCuration as never, makeMandatory() as never, makeCognee() as never, makeSpawn());
      await svc['runCurationPhase'](setupRun as never);

      // phases.curation.diagnostics should contain the stale inventory_snapshot_stale entry
      const updateCalls = setupRunsCol.updateOne.mock.calls as Array<[unknown, unknown]>;
      const staleSignalUpdate = updateCalls.find(([, update]) => {
        const u = update as Record<string, unknown>;
        const $push = u.$push as Record<string, unknown> | undefined;
        return $push && 'phases.curation.diagnostics' in $push;
      });
      expect(staleSignalUpdate).toBeDefined();
      const pushed = ((staleSignalUpdate![1] as Record<string, unknown>).$push as Record<string, unknown>)['phases.curation.diagnostics'] as Record<string, unknown>;
      expect(pushed.code).toBe('inventory_snapshot_stale');
      expect(pushed.severity).toBe('warning');
    });
  });

  // ── Fix A: Partial Cognee refresh → run status 'partial', not 'failed' ──────

  describe('Fix A: context_refresh phase failure → run status partial', () => {
    async function makeRunWithPhases(phases: Record<string, unknown>, cogneeStatus: string) {
      const setupRun = {
        setupRunId: 'run-partial',
        repoId: REPO_ID,
        status: 'running',
        currentPhase: 'context_refresh',
        childExecutionIds: [],
        phases: {
          preflight: { status: 'completed' },
          curation: { status: 'completed' },
          mandatoryMapping: { status: 'completed' },
          contextRefresh: { status: 'running' },
          ...phases,
        },
        diagnostics: [],
        resumeCount: 0,
        repoPath: '/tmp/test-repo',
        options: {},
      };
      const setupRunsCol = makeCollection([setupRun]);
      const agentsCol = makeCollection([{ name: 'repo-context-curator' }, { name: 'repo-mandatory-context-mapper' }]);
      const db = makeDb({ repos: makeCollection([makeRepo()]), repo_context_setup_runs: setupRunsCol, agents: agentsCol, mcp_servers: makeCollection(), mandatory_context_proposals: makeCollection(), executions: makeExecutionsCol() });

      // Cognee returns a terminal non-completed status
      const cognee = makeCognee({
        getStatus: vi.fn()
          .mockResolvedValueOnce({ status: 'running', workerActive: true })
          .mockResolvedValueOnce({ status: cogneeStatus, workerActive: false, message: 'Cognee refresh stopped' }),
        scheduleRefreshRepo: vi.fn(async () => {}),
      });

      const svc = new RepoContextSetupService(db, makeCuration() as never, makeMandatory() as never, cognee as never, makeSpawn());
      // Run the refresh phase directly via runPhases in a way that reaches context_refresh
      await svc['runRefreshPhase'](setupRun as never).catch(() => {}); // expect throw
      return { setupRunsCol, svc, setupRun };
    }

    it('cognee terminal partial → runPhases sets run status partial (not failed)', async () => {
      vi.useFakeTimers();
      try {
        // Build a run where curation+mandatory are done, context_refresh is pending
        const setupRun = {
          setupRunId: 'run-partial',
          repoId: REPO_ID,
          status: 'running',
          currentPhase: 'context_refresh',
          childExecutionIds: [],
          phases: {
            preflight: { status: 'completed' },
            curation: { status: 'completed' },
            mandatoryMapping: { status: 'completed' },
            contextRefresh: { status: 'pending' },
          },
          diagnostics: [],
          resumeCount: 0,
          repoPath: '/tmp/test-repo',
          options: {},
        };
        const setupRunsCol = makeCollection([setupRun]);
        const db = makeDb({ repos: makeCollection([makeRepo()]), repo_context_setup_runs: setupRunsCol, agents: makeCollection([{ name: 'repo-context-curator' }, { name: 'repo-mandatory-context-mapper' }]), mcp_servers: makeCollection(), mandatory_context_proposals: makeCollection(), executions: makeExecutionsCol() });

        const cognee = makeCognee({
          getStatus: vi.fn().mockResolvedValue({ status: 'partial', workerActive: false, message: 'graph build partial' }),
          scheduleRefreshRepo: vi.fn(async () => {}),
        });

        const svc = new RepoContextSetupService(db, makeCuration() as never, makeMandatory() as never, cognee as never, makeSpawn());

        // Run phases in background with timers advanced
        const phasesPromise = svc['runPhases'](setupRun as never);
        // Advance past all poll sleeps
        await vi.runAllTimersAsync();
        await phasesPromise;

        // The run status should be 'partial' (context_refresh failed but is resumable)
        const updatedRun = setupRunsCol._store.find((d: Record<string, unknown>) => d.setupRunId === 'run-partial');
        expect(updatedRun?.status).toBe('partial');
      } finally {
        vi.useRealTimers();
      }
    });

    it('startOrReturn dedupes against a partial run (AC-002)', async () => {
      const partialRun = { setupRunId: 'partial-run', repoId: REPO_ID, status: 'partial', phases: { preflight: { status: 'completed' }, curation: { status: 'completed' }, mandatoryMapping: { status: 'completed' }, contextRefresh: { status: 'failed' } } };
      const setupRunsCol = makeCollection([partialRun]);
      const db = makeDb({ repos: makeCollection([makeRepo()]), repo_context_setup_runs: setupRunsCol, agents: makeCollection(), mcp_servers: makeCollection() });

      const svc = new RepoContextSetupService(db, makeCuration() as never, makeMandatory() as never, makeCognee() as never, makeSpawn());
      const result = await svc.startOrReturn(REPO_ID, {}, 'user-1');

      expect(result.deduped).toBe(true);
      expect(result.setupRun.status).toBe('partial');
    });

    it('resume re-enters only context_refresh for a partial run', async () => {
      vi.useFakeTimers();
      try {
        const partialRun = {
          setupRunId: 'partial-run-2',
          repoId: REPO_ID,
          status: 'partial',
          currentPhase: 'context_refresh',
          childExecutionIds: [],
          phases: {
            preflight: { status: 'completed' },
            curation: { status: 'completed' },
            mandatoryMapping: { status: 'completed' },
            contextRefresh: { status: 'failed' },
          },
          diagnostics: [],
          resumeCount: 0,
          repoPath: '/tmp/test-repo',
          options: {},
        };
        const setupRunsCol = makeCollection([partialRun]);
        const db = makeDb({ repos: makeCollection([makeRepo()]), repo_context_setup_runs: setupRunsCol, agents: makeCollection([{ name: 'repo-context-curator' }, { name: 'repo-mandatory-context-mapper' }]), mcp_servers: makeCollection(), mandatory_context_proposals: makeCollection(), executions: makeExecutionsCol() });
        const cognee = makeCognee({
          getStatus: vi.fn().mockResolvedValue({ status: 'completed', workerActive: false }),
          scheduleRefreshRepo: vi.fn(async () => {}),
        });
        const svc = new RepoContextSetupService(db, makeCuration() as never, makeMandatory() as never, cognee as never, makeSpawn());

        // resume() fires runPhases in background — collect the background promise
        let backgroundDone = false;
        const resumeResult = await svc.resume('partial-run-2');
        expect(resumeResult.resumeCount).toBeGreaterThanOrEqual(1);

        // Advance timers so the background runPhases can proceed through the cognee poll
        await vi.runAllTimersAsync();
        backgroundDone = true;

        // scheduleRefreshRepo should be called (context_refresh re-entered)
        expect(cognee.scheduleRefreshRepo).toHaveBeenCalled();
        expect(backgroundDone).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── Fix B: Curator/mapper child-execution failure detection ────────────────

  describe('Fix B: child execution failure detection', () => {
    it('curation phase throws PHASE_FAILED_CURATION when curator exec fails', async () => {
      const setupRun = {
        setupRunId: 'run-curate',
        repoId: REPO_ID,
        status: 'running',
        currentPhase: 'curation',
        childExecutionIds: [],
        phases: { preflight: { status: 'completed' }, curation: { status: 'running' }, mandatoryMapping: { status: 'pending' }, contextRefresh: { status: 'pending' } },
        diagnostics: [],
        resumeCount: 0,
        repoPath: '/tmp/test-repo',
        options: {},
        branch: 'main',
      };
      const setupRunsCol = makeCollection([setupRun]);
      // child exec is 'failed'
      const execCol = makeCollection([{ id: 'child-exec-1', status: 'failed' }]);
      const db = makeDb({ repos: makeCollection([makeRepo()]), repo_context_setup_runs: setupRunsCol, agents: makeCollection([{ name: 'repo-context-curator' }]), mcp_servers: makeCollection(), executions: execCol });

      const spawn = vi.fn(async () => ({ execution_id: 'child-exec-1' }));
      const svc = new RepoContextSetupService(db, makeCuration() as never, makeMandatory() as never, makeCognee() as never, spawn);

      await expect(svc['runCurationPhase'](setupRun as never, {})).rejects.toThrow('PHASE_FAILED_CURATION');
    });

    it('curation phase throws PHASE_FAILED_CURATION when curator exec is cancelled', async () => {
      const setupRun = {
        setupRunId: 'run-cancel',
        repoId: REPO_ID,
        status: 'running',
        currentPhase: 'curation',
        childExecutionIds: [],
        phases: { preflight: { status: 'completed' }, curation: { status: 'running' }, mandatoryMapping: { status: 'pending' }, contextRefresh: { status: 'pending' } },
        diagnostics: [],
        resumeCount: 0,
        repoPath: '/tmp/test-repo',
        options: {},
        branch: 'main',
      };
      const setupRunsCol = makeCollection([setupRun]);
      const execCol = makeCollection([{ id: 'child-exec-1', status: 'cancelled' }]);
      const db = makeDb({ repos: makeCollection([makeRepo()]), repo_context_setup_runs: setupRunsCol, agents: makeCollection(), mcp_servers: makeCollection(), executions: execCol });

      const spawn = vi.fn(async () => ({ execution_id: 'child-exec-1' }));
      const svc = new RepoContextSetupService(db, makeCuration() as never, makeMandatory() as never, makeCognee() as never, spawn);

      await expect(svc['runCurationPhase'](setupRun as never, {})).rejects.toThrow('PHASE_FAILED_CURATION');
    });

    it('curation phase completes with warning when inventory is empty (REQ-018)', async () => {
      // getRepoContextCurationStageStatus returns expectedFiles:0, promotable:false
      vi.mocked(getRepoContextCurationStageStatus).mockResolvedValueOnce({
        promotable: false,
        validEntries: 0,
        expectedFiles: 0,
        retryFiles: [],
        entries: [],
        diagnostics: [],
        runId: 'run-1',
        status: 'validated',
        stagedEntries: 0,
        stagedStatuses: 0,
        completedFiles: 0,
        missingFiles: [],
        invalidFiles: [],
        duplicateStatusFiles: [],
      });

      // Pre-existing phase diagnostic (e.g. from a stale prepare snapshot) — must
      // survive the empty-inventory write because the service uses $push, not $set.
      const earlierDiagnostic = { code: 'inventory_snapshot_stale', severity: 'warning', message: 'Inventory snapshot may be stale' };
      const setupRun = {
        setupRunId: 'run-empty',
        repoId: REPO_ID,
        status: 'running',
        currentPhase: 'curation',
        childExecutionIds: [],
        phases: { preflight: { status: 'completed' }, curation: { status: 'running', diagnostics: [earlierDiagnostic] }, mandatoryMapping: { status: 'pending' }, contextRefresh: { status: 'pending' } },
        diagnostics: [],
        resumeCount: 0,
        repoPath: '/tmp/test-repo',
        options: {},
        branch: 'main',
      };
      const setupRunsCol = makeCollection([setupRun]);
      const execCol = makeCollection([{ id: 'child-exec-1', status: 'completed' }]);
      // stage-run not promoted
      const curationRunsCol = makeCollection([{ runId: 'run-1', status: 'running' }]);
      const db = makeDb({ repos: makeCollection([makeRepo()]), repo_context_setup_runs: setupRunsCol, agents: makeCollection(), mcp_servers: makeCollection(), executions: execCol, repo_context_curation_runs: curationRunsCol });

      const spawn = vi.fn(async () => ({ execution_id: 'child-exec-1' }));
      const svc = new RepoContextSetupService(db, makeCuration() as never, makeMandatory() as never, makeCognee() as never, spawn);

      // Should NOT throw — empty inventory is a valid terminal state
      await svc['runCurationPhase'](setupRun as never, {});
      const updatedRun = setupRunsCol._store.find((d: Record<string, unknown>) => d.setupRunId === 'run-empty') as Record<string, unknown>;
      const curationPhase = (updatedRun.phases as Record<string, Record<string, unknown>>).curation;
      expect(curationPhase.promotedCount).toBe(0);
      expect(curationPhase.promotable).toBe(false);

      // Q1: the no_context_files diagnostic must be $push-ed (not $set), preserving earlier diagnostics
      const noFilesWrite = (setupRunsCol.updateOne.mock.calls as Array<[unknown, Record<string, unknown>]>).find(
        ([, update]) => update.$push && 'phases.curation.diagnostics' in (update.$push as Record<string, unknown>),
      );
      expect(noFilesWrite).toBeDefined();
      const pushed = (noFilesWrite![1].$push as Record<string, Record<string, unknown>>)['phases.curation.diagnostics'];
      expect(pushed.code).toBe('no_context_files');
      expect(pushed.severity).toBe('warning');
      // No updateOne call may overwrite the diagnostics array via $set
      for (const [, update] of setupRunsCol.updateOne.mock.calls as Array<[unknown, Record<string, unknown>]>) {
        expect(Object.keys((update.$set ?? {}) as Record<string, unknown>)).not.toContain('phases.curation.diagnostics');
      }
      // Earlier diagnostics preserved, new one appended
      const diagnostics = curationPhase.diagnostics as Array<Record<string, unknown>>;
      expect(diagnostics.map((d) => d.code)).toEqual(['inventory_snapshot_stale', 'no_context_files']);
    });

    it('mandatory phase throws PHASE_FAILED_MANDATORY when mapper exec fails', async () => {
      const setupRun = {
        setupRunId: 'run-mandatory',
        repoId: REPO_ID,
        status: 'running',
        currentPhase: 'mandatory_mapping',
        childExecutionIds: [],
        phases: { preflight: { status: 'completed' }, curation: { status: 'completed' }, mandatoryMapping: { status: 'running' }, contextRefresh: { status: 'pending' } },
        diagnostics: [],
        resumeCount: 0,
        repoPath: '/tmp/test-repo',
        options: {},
        branch: 'main',
      };
      const setupRunsCol = makeCollection([setupRun]);
      const execCol = makeCollection([{ id: 'child-exec-1', status: 'failed' }]);
      const db = makeDb({ repos: makeCollection([makeRepo()]), repo_context_setup_runs: setupRunsCol, agents: makeCollection(), mcp_servers: makeCollection(), executions: execCol, mandatory_context_proposals: makeCollection() });

      const spawn = vi.fn(async () => ({ execution_id: 'child-exec-1' }));
      const svc = new RepoContextSetupService(db, makeCuration() as never, makeMandatory() as never, makeCognee() as never, spawn);

      await expect(svc['runMandatoryPhase'](setupRun as never)).rejects.toThrow('PHASE_FAILED_MANDATORY');
    });
  });

  // ── Fix F: consumeCurationOutput handles already-promoted stage-run ─────────

  describe('Fix F: orchestrator promotion correctness', () => {
    it('agent-already-promoted → phase completes without throwing', async () => {
      const setupRun = {
        setupRunId: 'run-prom',
        repoId: REPO_ID,
        status: 'running',
        currentPhase: 'curation',
        childExecutionIds: [],
        phases: { preflight: { status: 'completed' }, curation: { status: 'running', curationRunId: 'run-1' }, mandatoryMapping: { status: 'pending' }, contextRefresh: { status: 'pending' } },
        diagnostics: [],
        resumeCount: 0,
        repoPath: '/tmp/test-repo',
        options: {},
      };
      const setupRunsCol = makeCollection([setupRun]);
      // stage-run is already promoted (agent already called promote_repo_context_curation_stage)
      const curationRunsCol = makeCollection([{ runId: 'run-1', status: 'promoted', promotedAt: new Date() }]);
      const db = makeDb({ repos: makeCollection([makeRepo()]), repo_context_setup_runs: setupRunsCol, agents: makeCollection(), mcp_servers: makeCollection(), executions: makeExecutionsCol(), repo_context_curation_runs: curationRunsCol });

      const promoteStageFromAgent = vi.fn(async () => ({ promoted_entries: 5 }));
      const curation = makeCuration({ promoteStageFromAgent });
      const svc = new RepoContextSetupService(db, curation as never, makeMandatory() as never, makeCognee() as never, makeSpawn());

      // Should NOT throw — agent already promoted
      await expect(svc['consumeCurationOutput']('run-prom', 'run-1', Date.now())).resolves.toBeUndefined();
      // promoteStageFromAgent should NOT be called (already promoted)
      expect(promoteStageFromAgent).not.toHaveBeenCalled();
    });

    it('agent-staged-only → promoteStageFromAgent called and counts recorded', async () => {
      const setupRun = {
        setupRunId: 'run-stage',
        repoId: REPO_ID,
        status: 'running',
        currentPhase: 'curation',
        childExecutionIds: [],
        phases: { preflight: { status: 'completed' }, curation: { status: 'running', curationRunId: 'run-1' }, mandatoryMapping: { status: 'pending' }, contextRefresh: { status: 'pending' } },
        diagnostics: [],
        resumeCount: 0,
        repoPath: '/tmp/test-repo',
        options: {},
      };
      const setupRunsCol = makeCollection([setupRun]);
      // stage-run is running (not yet promoted)
      const curationRunsCol = makeCollection([{ runId: 'run-1', status: 'running' }]);
      const db = makeDb({ repos: makeCollection([makeRepo()]), repo_context_setup_runs: setupRunsCol, agents: makeCollection(), mcp_servers: makeCollection(), executions: makeExecutionsCol(), repo_context_curation_runs: curationRunsCol });

      const promoteStageFromAgent = vi.fn(async () => ({ promoted_entries: 7, stats: {}, diagnostics: [] }));
      const curation = makeCuration({ promoteStageFromAgent });
      const svc = new RepoContextSetupService(db, curation as never, makeMandatory() as never, makeCognee() as never, makeSpawn());

      await svc['consumeCurationOutput']('run-stage', 'run-1', Date.now());
      // promoteStageFromAgent MUST be called
      expect(promoteStageFromAgent).toHaveBeenCalledWith({ run_id: 'run-1' });
    });
  });

  // ── Fix H: no phantom executions row from prepareForCoordinator ─────────────

  describe('Fix H: single execution record per Prepare / Resume', () => {
    function makeRunForCuration(overrides?: Partial<Record<string, unknown>>) {
      return {
        setupRunId: 'run-fixh',
        repoId: REPO_ID,
        status: 'running',
        currentPhase: 'curation',
        childExecutionIds: [],
        phases: { preflight: { status: 'completed' }, curation: { status: 'running' }, mandatoryMapping: { status: 'pending' }, contextRefresh: { status: 'pending' } },
        diagnostics: [],
        resumeCount: 0,
        repoPath: '/tmp/test-repo',
        options: {},
        branch: 'main',
        ...overrides,
      };
    }

    it('runCurationPhase calls prepareForCoordinator with skip_execution_record:true', async () => {
      const setupRun = makeRunForCuration();
      const setupRunsCol = makeCollection([setupRun]);
      const execCol = makeExecutionsCol('completed');
      const db = makeDb({ repos: makeCollection([makeRepo()]), repo_context_setup_runs: setupRunsCol, agents: makeCollection(), mcp_servers: makeCollection(), executions: execCol, repo_context_curation_runs: makeCollection([{ runId: 'run-1', status: 'running' }]) });

      const prepareForCoordinator = vi.fn(async () => ({ run_id: 'run-1', profile_id: 'p1', execution_id: undefined }));
      const attachExecutionToProfile = vi.fn(async () => {});
      const curation = makeCuration({ prepareForCoordinator, attachExecutionToProfile });
      const spawn = vi.fn(async () => ({ execution_id: 'child-exec-1' }));
      const svc = new RepoContextSetupService(db, curation as never, makeMandatory() as never, makeCognee() as never, spawn);

      await svc['runCurationPhase'](setupRun as never, {});

      // prepareForCoordinator MUST be called with skip_execution_record: true
      const prepareCall = prepareForCoordinator.mock.calls[0][0] as Record<string, unknown>;
      expect(prepareCall).toHaveProperty('skip_execution_record', true);
    });

    it('runCurationPhase calls attachExecutionToProfile with the spawned exec id', async () => {
      const setupRun = makeRunForCuration();
      const setupRunsCol = makeCollection([setupRun]);
      const execCol = makeExecutionsCol('completed');
      const db = makeDb({ repos: makeCollection([makeRepo()]), repo_context_setup_runs: setupRunsCol, agents: makeCollection(), mcp_servers: makeCollection(), executions: execCol, repo_context_curation_runs: makeCollection([{ runId: 'run-1', status: 'running' }]) });

      const prepareForCoordinator = vi.fn(async () => ({ run_id: 'run-1', profile_id: 'p1', execution_id: undefined }));
      const attachExecutionToProfile = vi.fn(async () => {});
      const curation = makeCuration({ prepareForCoordinator, attachExecutionToProfile });
      const spawn = vi.fn(async () => ({ execution_id: 'child-exec-1' }));
      const svc = new RepoContextSetupService(db, curation as never, makeMandatory() as never, makeCognee() as never, spawn);

      await svc['runCurationPhase'](setupRun as never, {});

      // attachExecutionToProfile MUST be called with (profileId, runId, execId)
      expect(attachExecutionToProfile).toHaveBeenCalledWith('p1', 'run-1', 'child-exec-1');
    });

    it('exactly one spawnAgentFn call — no extra phantom spawn', async () => {
      const setupRun = makeRunForCuration();
      const setupRunsCol = makeCollection([setupRun]);
      const execCol = makeExecutionsCol('completed');
      const db = makeDb({ repos: makeCollection([makeRepo()]), repo_context_setup_runs: setupRunsCol, agents: makeCollection(), mcp_servers: makeCollection(), executions: execCol, repo_context_curation_runs: makeCollection([{ runId: 'run-1', status: 'running' }]) });

      const curation = makeCuration();
      const spawn = vi.fn(async () => ({ execution_id: 'child-exec-1' }));
      const svc = new RepoContextSetupService(db, curation as never, makeMandatory() as never, makeCognee() as never, spawn);

      await svc['runCurationPhase'](setupRun as never, {});

      // Only ONE spawn call for the real curator agent
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({ agent_name: 'repo-context-curator' }),
        expect.anything(),
      );
    });

    it('resume: runCurationPhase (re-entered) also passes skip_execution_record:true', async () => {
      // Simulate a resume where curation phase re-enters the normal path (no expectChildExecution)
      const setupRun = makeRunForCuration({ status: 'running', resumeCount: 1 });
      const setupRunsCol = makeCollection([setupRun]);
      // spawn will return 'child-exec-resume' — make sure executions col has that id at 'completed'
      const execCol = makeCollection([{ id: 'child-exec-resume', status: 'completed' }]);
      const db = makeDb({ repos: makeCollection([makeRepo()]), repo_context_setup_runs: setupRunsCol, agents: makeCollection(), mcp_servers: makeCollection(), executions: execCol, repo_context_curation_runs: makeCollection([{ runId: 'run-1', status: 'running' }]) });

      const prepareForCoordinator = vi.fn(async () => ({ run_id: 'run-1', profile_id: 'p1', execution_id: undefined }));
      const attachExecutionToProfile = vi.fn(async () => {});
      const curation = makeCuration({ prepareForCoordinator, attachExecutionToProfile });
      const spawn = vi.fn(async () => ({ execution_id: 'child-exec-resume' }));
      const svc = new RepoContextSetupService(db, curation as never, makeMandatory() as never, makeCognee() as never, spawn);

      // No expectChildExecution → normal path runs
      await svc['runCurationPhase'](setupRun as never, {});

      const prepareCall = prepareForCoordinator.mock.calls[0][0] as Record<string, unknown>;
      expect(prepareCall).toHaveProperty('skip_execution_record', true);
      expect(attachExecutionToProfile).toHaveBeenCalledWith('p1', 'run-1', 'child-exec-resume');
      // Still exactly one spawn
      expect(spawn).toHaveBeenCalledTimes(1);
    });
  });

  // ── Fix J: resume reattaches to live child executions ──────────────────────

  describe('Fix J: resume reattaches to live child executions', () => {
    function makeResumeRun(overrides?: Partial<Record<string, unknown>>) {
      return {
        setupRunId: 'run-fixj',
        repoId: REPO_ID,
        status: 'failed',
        currentPhase: 'curation',
        childExecutionIds: ['curator-exec-1'],
        phases: {
          preflight: { status: 'completed' },
          curation: { status: 'failed', curationRunId: 'run-1', curationExecutionId: 'curator-exec-1' },
          mandatoryMapping: { status: 'pending' },
          contextRefresh: { status: 'pending' },
        },
        diagnostics: [],
        resumeCount: 0,
        repoPath: '/tmp/test-repo',
        options: {},
        branch: 'main',
        updatedAt: new Date(),
        ...overrides,
      };
    }

    it('resume() with live child curation exec → resets phase status to running', async () => {
      const setupRun = makeResumeRun();
      const setupRunsCol = makeCollection([setupRun]);
      // Child exec is still running
      const execCol = makeCollection([{ id: 'curator-exec-1', status: 'running' }]);
      const db = makeDb({
        repos: makeCollection([makeRepo()]),
        repo_context_setup_runs: setupRunsCol,
        agents: makeCollection(),
        mcp_servers: makeCollection(),
        executions: execCol,
        repo_context_curation_runs: makeCollection([{ runId: 'run-1', status: 'running' }]),
        mandatory_context_proposals: makeCollection(),
      });

      const spawn = vi.fn(async () => ({ execution_id: 'new-exec' }));
      const svc = new RepoContextSetupService(db, makeCuration() as never, makeMandatory() as never, makeCognee() as never, spawn);

      // resume() returns immediately (background task fires asynchronously)
      const updated = await svc.resume('run-fixj');

      // Run status should be 'running'
      expect(updated.status).toBe('running');
      expect(updated.resumeCount).toBe(1);

      // The phase status must have been reset to 'running' in the store
      const stored = setupRunsCol._store.find((d: Record<string, unknown>) => d.setupRunId === 'run-fixj') as Record<string, unknown>;
      const phases = (stored?.phases ?? {}) as Record<string, Record<string, unknown>>;
      expect(phases.curation?.status).toBe('running');
    });

    it('resume() with terminal child curation exec → phase status not reset', async () => {
      const setupRun = makeResumeRun();
      const setupRunsCol = makeCollection([setupRun]);
      // Child exec is already completed (no live exec to reattach to)
      const execCol = makeCollection([{ id: 'curator-exec-1', status: 'completed' }]);
      const db = makeDb({
        repos: makeCollection([makeRepo()]),
        repo_context_setup_runs: setupRunsCol,
        agents: makeCollection(),
        mcp_servers: makeCollection(),
        executions: execCol,
        repo_context_curation_runs: makeCollection([{ runId: 'run-1', status: 'running' }]),
        mandatory_context_proposals: makeCollection(),
      });

      const spawn = vi.fn(async () => ({ execution_id: 'new-exec' }));
      const svc = new RepoContextSetupService(db, makeCuration() as never, makeMandatory() as never, makeCognee() as never, spawn);

      await svc.resume('run-fixj');

      // Phase status was 'failed', should still be 'failed' (no reset since no live exec)
      const stored = setupRunsCol._store.find((d: Record<string, unknown>) => d.setupRunId === 'run-fixj') as Record<string, unknown>;
      const phases = (stored?.phases ?? {}) as Record<string, Record<string, unknown>>;
      expect(phases.curation?.status).toBe('failed');
    });

    it('runCurationPhase with expectChildExecution and completed exec → no new spawn', async () => {
      const setupRun = makeResumeRun({ status: 'running', phases: { preflight: { status: 'completed' }, curation: { status: 'running', curationRunId: 'run-1', curationExecutionId: 'curator-exec-1' }, mandatoryMapping: { status: 'pending' }, contextRefresh: { status: 'pending' } } });
      const setupRunsCol = makeCollection([setupRun]);
      const execCol = makeCollection([{ id: 'curator-exec-1', status: 'completed' }]);
      const db = makeDb({
        repos: makeCollection([makeRepo()]),
        repo_context_setup_runs: setupRunsCol,
        agents: makeCollection(),
        mcp_servers: makeCollection(),
        executions: execCol,
        repo_context_curation_runs: makeCollection([{ runId: 'run-1', status: 'running' }]),
      });

      const spawn = vi.fn(async () => ({ execution_id: 'never-called' }));
      const svc = new RepoContextSetupService(db, makeCuration() as never, makeMandatory() as never, makeCognee() as never, spawn);

      // Reattach path: pass expectChildExecution
      await svc['runCurationPhase'](setupRun as never, { expectChildExecution: 'curator-exec-1' });

      // spawnAgentFn must NOT have been called — we reused the existing exec
      expect(spawn).not.toHaveBeenCalled();
    });

    it('runCurationPhase with expectChildExecution and failed exec → throws PHASE_FAILED_CURATION', async () => {
      const setupRun = makeResumeRun({ status: 'running', phases: { preflight: { status: 'completed' }, curation: { status: 'running', curationRunId: 'run-1', curationExecutionId: 'curator-exec-1' }, mandatoryMapping: { status: 'pending' }, contextRefresh: { status: 'pending' } } });
      const setupRunsCol = makeCollection([setupRun]);
      const execCol = makeCollection([{ id: 'curator-exec-1', status: 'failed' }]);
      const db = makeDb({
        repos: makeCollection([makeRepo()]),
        repo_context_setup_runs: setupRunsCol,
        agents: makeCollection(),
        mcp_servers: makeCollection(),
        executions: execCol,
        repo_context_curation_runs: makeCollection([{ runId: 'run-1', status: 'running' }]),
      });

      const spawn = vi.fn(async () => ({ execution_id: 'never-called' }));
      const svc = new RepoContextSetupService(db, makeCuration() as never, makeMandatory() as never, makeCognee() as never, spawn);

      await expect(svc['runCurationPhase'](setupRun as never, { expectChildExecution: 'curator-exec-1' }))
        .rejects.toThrow('PHASE_FAILED_CURATION');
      expect(spawn).not.toHaveBeenCalled();
    });

    it('runMandatoryPhase with expectChildExecution and completed exec → no new spawn, consumes proposal', async () => {
      const proposal = {
        proposalId: 'prop-1',
        setupRunId: 'run-fixj',
        repoId: REPO_ID,
        status: 'proposed',
        affectedAgentNames: ['agent-1'],
        mappings: [{ agentName: 'agent-1', title: 'Test', content: 'test content' }],
      };
      const setupRun = {
        setupRunId: 'run-fixj',
        repoId: REPO_ID,
        status: 'running',
        currentPhase: 'mandatory_mapping',
        childExecutionIds: ['mapper-exec-1'],
        phases: {
          preflight: { status: 'completed' },
          curation: { status: 'completed' },
          mandatoryMapping: { status: 'running', mandatoryExecutionId: 'mapper-exec-1' },
          contextRefresh: { status: 'pending' },
        },
        diagnostics: [],
        resumeCount: 1,
        repoPath: '/tmp/test-repo',
        options: {},
        branch: 'main',
      };
      const setupRunsCol = makeCollection([setupRun]);
      const execCol = makeCollection([{ id: 'mapper-exec-1', status: 'completed' }]);
      const proposalsCol = makeCollection([proposal]);
      const db = makeDb({
        repos: makeCollection([makeRepo()]),
        repo_context_setup_runs: setupRunsCol,
        agents: makeCollection(),
        mcp_servers: makeCollection(),
        executions: execCol,
        mandatory_context_proposals: proposalsCol,
      });

      const spawn = vi.fn(async () => ({ execution_id: 'never-called' }));
      const svc = new RepoContextSetupService(db, makeCuration() as never, makeMandatory() as never, makeCognee() as never, spawn);

      // Reattach path: pass expectChildExecution
      await svc['runMandatoryPhase'](setupRun as never, { expectChildExecution: 'mapper-exec-1' });

      // spawnAgentFn must NOT have been called
      expect(spawn).not.toHaveBeenCalled();
    });

    it('runMandatoryPhase without opts → spawns new mapper agent (existing behavior preserved)', async () => {
      const proposal = {
        proposalId: 'prop-2',
        setupRunId: 'run-fixj-normal',
        repoId: REPO_ID,
        status: 'proposed',
        affectedAgentNames: [],
        mappings: [],
      };
      const setupRun = {
        setupRunId: 'run-fixj-normal',
        repoId: REPO_ID,
        status: 'running',
        currentPhase: 'mandatory_mapping',
        childExecutionIds: [],
        phases: {
          preflight: { status: 'completed' },
          curation: { status: 'completed' },
          mandatoryMapping: { status: 'running' },
          contextRefresh: { status: 'pending' },
        },
        diagnostics: [],
        resumeCount: 0,
        repoPath: '/tmp/test-repo',
        options: {},
        branch: 'main',
      };
      const setupRunsCol = makeCollection([setupRun]);
      const execCol = makeCollection([{ id: 'mapper-new-exec', status: 'completed' }]);
      const proposalsCol = makeCollection([proposal]);
      const db = makeDb({
        repos: makeCollection([makeRepo()]),
        repo_context_setup_runs: setupRunsCol,
        agents: makeCollection(),
        mcp_servers: makeCollection(),
        executions: execCol,
        mandatory_context_proposals: proposalsCol,
      });

      const spawn = vi.fn(async () => ({ execution_id: 'mapper-new-exec' }));
      const svc = new RepoContextSetupService(db, makeCuration() as never, makeMandatory() as never, makeCognee() as never, spawn);

      await svc['runMandatoryPhase'](setupRun as never);

      // Normal path: spawn was called with the mapper agent
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({ agent_name: 'repo-mandatory-context-mapper' }),
        expect.anything(),
      );
    });
  });

  // ── Fix K: progress-aware timeout and cancel on giveup ──────────────────────

  describe('Fix K: progress-aware timeout and cancel on giveup', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('pollExecution returns terminal status immediately (basic regression)', async () => {
      const execCol = makeCollection([{ id: 'quick-exec', status: 'completed' }]);
      const db = makeDb({
        repos: makeCollection(),
        repo_context_setup_runs: makeCollection(),
        executions: execCol,
        agents: makeCollection(),
        mcp_servers: makeCollection(),
        mandatory_context_proposals: makeCollection(),
      });
      const svc = new RepoContextSetupService(db, makeCuration() as never, makeMandatory() as never, makeCognee() as never, makeSpawn());
      const status = await svc['pollExecution']('quick-exec');
      expect(status).toBe('completed');
    });

    it('pollExecution detects stall when probe fingerprint is frozen', async () => {
      vi.useFakeTimers();
      const execCol = makeCollection([{ id: 'stall-exec', status: 'running' }]);
      const db = makeDb({
        repos: makeCollection(),
        repo_context_setup_runs: makeCollection(),
        executions: execCol,
        agents: makeCollection(),
        mcp_servers: makeCollection(),
        mandatory_context_proposals: makeCollection(),
      });
      const svc = new RepoContextSetupService(db, makeCuration() as never, makeMandatory() as never, makeCognee() as never, makeSpawn());

      // Probe always returns 0 — fingerprint never changes
      const probe = vi.fn(async () => 0);

      // Capture rejection before advancing timers to avoid "unhandled rejection" warning
      let capturedError: unknown;
      const pollDone = svc['pollExecution']('stall-exec', { progressProbe: probe }).catch((e: unknown) => {
        capturedError = e;
      });

      // Advance past stall threshold (20 min) + max poll interval (5 s) to let the check fire
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000 + 6_000);
      await pollDone; // wait for the caught rejection to settle

      expect(capturedError).toBeInstanceOf(Error);
      expect((capturedError as Error).message).toContain('stalled');

      // ExecutionService.cancel must have been called (mocked at top of file)
      expect(vi.mocked(ExecutionService)).toHaveBeenCalled();
    });

    it('pollExecution does NOT stall when probe fingerprint advances', async () => {
      vi.useFakeTimers();
      // Exec turns 'completed' after two poll iterations
      let pollCount = 0;
      const execWithTransition = {
        ...makeCollection([{ id: 'progress-exec', status: 'running' }]),
        findOne: vi.fn(async () => {
          pollCount++;
          return { id: 'progress-exec', status: pollCount >= 3 ? 'completed' : 'running' };
        }),
      };
      const db = makeDb({
        repos: makeCollection(),
        repo_context_setup_runs: makeCollection(),
        executions: execWithTransition as unknown as ReturnType<typeof makeCollection>,
        agents: makeCollection(),
        mcp_servers: makeCollection(),
        mandatory_context_proposals: makeCollection(),
      });
      const svc = new RepoContextSetupService(db, makeCuration() as never, makeMandatory() as never, makeCognee() as never, makeSpawn());

      // Probe returns incrementing values → lastProgressAt keeps resetting
      let fp = 0;
      const probe = vi.fn(async () => fp++);
      const pollPromise = svc['pollExecution']('progress-exec', { progressProbe: probe });

      // Advance past two sleep intervals to allow the exec to reach 'completed'
      await vi.advanceTimersByTimeAsync(15_000);

      const result = await pollPromise;
      expect(result).toBe('completed');
    });

    it('pollExecution cancels child exec on hard timeout when no probe provided', async () => {
      vi.useFakeTimers();
      const execCol = makeCollection([{ id: 'timeout-exec', status: 'running' }]);
      const db = makeDb({
        repos: makeCollection(),
        repo_context_setup_runs: makeCollection(),
        executions: execCol,
        agents: makeCollection(),
        mcp_servers: makeCollection(),
        mandatory_context_proposals: makeCollection(),
      });
      const svc = new RepoContextSetupService(db, makeCuration() as never, makeMandatory() as never, makeCognee() as never, makeSpawn());

      // No probe → stall detection disabled; only hard cap applies (4 hours default)
      let capturedError: unknown;
      const pollDone = svc['pollExecution']('timeout-exec').catch((e: unknown) => {
        capturedError = e;
      });

      // Advance past 4-hour hard cap + buffer
      await vi.advanceTimersByTimeAsync(4 * 3_600_000 + 6_000);
      await pollDone;

      expect(capturedError).toBeInstanceOf(Error);
      expect((capturedError as Error).message).toContain('hard timeout');
      expect(vi.mocked(ExecutionService)).toHaveBeenCalled();
    });
  });

  // ── Fix M4: persist unchangedCount/changedCount from prepare; resume clears message ─

  describe('Fix M4: curation counts + resume message reset', () => {
    function makeM4Run(overrides?: Partial<Record<string, unknown>>) {
      return {
        setupRunId: 'run-m4',
        repoId: REPO_ID,
        status: 'running',
        currentPhase: 'curation',
        childExecutionIds: [],
        phases: {
          preflight: { status: 'completed' },
          curation: { status: 'running' },
          mandatoryMapping: { status: 'pending' },
          contextRefresh: { status: 'pending' },
        },
        diagnostics: [],
        resumeCount: 0,
        repoPath: '/tmp/test-repo',
        options: {},
        ...overrides,
      };
    }

    it('runCurationPhase persists unchangedCount and changedCount from prepareForCoordinator', async () => {
      const setupRun = makeM4Run();
      const setupRunsCol = makeCollection([setupRun]);
      const execCol = makeCollection([{ id: 'child-exec-1', status: 'completed' }]);
      const curationRunsCol = makeCollection([{ runId: 'run-1', status: 'running' }]);
      const db = makeDb({
        repos: makeCollection([makeRepo()]),
        repo_context_setup_runs: setupRunsCol,
        agents: makeCollection(),
        mcp_servers: makeCollection(),
        executions: execCol,
        repo_context_curation_runs: curationRunsCol,
      });

      const prepareForCoordinator = vi.fn(async () => ({
        run_id: 'run-1',
        profile_id: 'p1',
        execution_id: undefined,
        unchanged_reused_entries: [{ path: 'a.md' }, { path: 'b.md' }], // 2 reused
        files_to_curate_count: 3, // 3 need curation
        snapshot: { fresh: true, ref: 'origin/main', head_sha: 'abc', fetch_ok: true },
      }));
      const curation = makeCuration({ prepareForCoordinator, attachExecutionToProfile: vi.fn(async () => {}) });
      const spawn = vi.fn(async () => ({ execution_id: 'child-exec-1' }));
      const svc = new RepoContextSetupService(db, curation as never, makeMandatory() as never, makeCognee() as never, spawn);

      await svc['runCurationPhase'](setupRun as never, {});

      // The store should have unchangedCount=2 and changedCount=3
      const updatedRun = setupRunsCol._store.find((d) => d.setupRunId === 'run-m4');
      const curationPhase = (updatedRun?.phases as Record<string, unknown>)?.curation as Record<string, unknown>;
      expect(curationPhase?.unchangedCount).toBe(2);
      expect(curationPhase?.changedCount).toBe(3);
    });

    it('runCurationPhase treats missing unchanged_reused_entries as 0', async () => {
      const setupRun = makeM4Run();
      const setupRunsCol = makeCollection([setupRun]);
      const execCol = makeCollection([{ id: 'child-exec-1', status: 'completed' }]);
      const curationRunsCol = makeCollection([{ runId: 'run-1', status: 'running' }]);
      const db = makeDb({
        repos: makeCollection([makeRepo()]),
        repo_context_setup_runs: setupRunsCol,
        agents: makeCollection(),
        mcp_servers: makeCollection(),
        executions: execCol,
        repo_context_curation_runs: curationRunsCol,
      });

      // prepareForCoordinator returns no unchanged_reused_entries
      const prepareForCoordinator = vi.fn(async () => ({
        run_id: 'run-1',
        profile_id: 'p1',
        files_to_curate_count: 7,
        snapshot: { fresh: true },
      }));
      const curation = makeCuration({ prepareForCoordinator, attachExecutionToProfile: vi.fn(async () => {}) });
      const svc = new RepoContextSetupService(db, curation as never, makeMandatory() as never, makeCognee() as never, vi.fn(async () => ({ execution_id: 'child-exec-1' })));

      await svc['runCurationPhase'](setupRun as never, {});

      const updatedRun = setupRunsCol._store.find((d) => d.setupRunId === 'run-m4');
      const curationPhase = (updatedRun?.phases as Record<string, unknown>)?.curation as Record<string, unknown>;
      expect(curationPhase?.unchangedCount).toBe(0);
      expect(curationPhase?.changedCount).toBe(7);
    });

    it('resume() patches message to "Resuming setup…" to clear stale failure text', async () => {
      const failedRun = {
        setupRunId: 'run-m4-resume',
        repoId: REPO_ID,
        status: 'failed',
        currentPhase: 'curation',
        message: 'Phase curation failed: some error',
        childExecutionIds: [],
        phases: {
          preflight: { status: 'completed' },
          curation: { status: 'failed', curationRunId: 'run-1' },
          mandatoryMapping: { status: 'pending' },
          contextRefresh: { status: 'pending' },
        },
        diagnostics: [],
        resumeCount: 0,
        repoPath: '/tmp/test-repo',
        options: {},
      };
      const setupRunsCol = makeCollection([failedRun]);
      const execCol = makeCollection([{ id: 'child-exec-1', status: 'completed' }]);
      const db = makeDb({
        repos: makeCollection([makeRepo()]),
        repo_context_setup_runs: setupRunsCol,
        executions: execCol,
        agents: makeCollection(),
        mcp_servers: makeCollection(),
        repo_context_curation_runs: makeCollection([{ runId: 'run-1', status: 'running' }]),
      });

      const curation = makeCuration();
      const spawn = vi.fn(async () => ({ execution_id: 'child-exec-1' }));
      const svc = new RepoContextSetupService(db, curation as never, makeMandatory() as never, makeCognee() as never, spawn);

      const result = await svc.resume('run-m4-resume');

      // resume() should have patched message to 'Resuming setup…'
      expect(result.message).toBe('Resuming setup…');
      // And cleared the old stale failure text
      expect(result.message).not.toContain('Phase curation failed');
    });
  });

  // ── Fix G: correct collection name in get() ────────────────────────────────

  describe('Fix G: get() uses correct collection name', () => {
    it('queries repo_context_curation_runs (not stage_runs) for curationStageStatus', async () => {
      const setupRun = {
        setupRunId: 'run-get',
        repoId: REPO_ID,
        status: 'completed',
        currentPhase: 'completed',
        childExecutionIds: [],
        phases: { preflight: { status: 'completed' }, curation: { status: 'completed', curationRunId: 'cr-1' }, mandatoryMapping: { status: 'completed' }, contextRefresh: { status: 'completed' } },
        diagnostics: [],
        resumeCount: 0,
        repoPath: '/tmp/test-repo',
        options: {},
      };
      const setupRunsCol = makeCollection([setupRun]);
      const curationRunsCol = makeCollection([{ runId: 'cr-1', status: 'promoted', promotedEntries: 3 }]);
      // Wrong collection (old name) — should NOT be queried
      const stageRunsCol = makeCollection([{ runId: 'cr-1', status: 'promoted', wrongCollection: true }]);

      const collectionsQueried: string[] = [];
      const db = {
        collection: (name: string) => {
          collectionsQueried.push(name);
          if (name === 'repo_context_setup_runs') return setupRunsCol;
          if (name === 'repo_context_curation_runs') return curationRunsCol;
          if (name === 'repo_context_curation_stage_runs') return stageRunsCol;
          return makeCollection();
        },
        admin: () => ({ command: async () => ({ setName: null }) }),
      } as unknown as Db;

      const svc = new RepoContextSetupService(db, makeCuration() as never, makeMandatory() as never, makeCognee() as never, makeSpawn());
      const result = await svc.get('run-get');

      expect(collectionsQueried).toContain('repo_context_curation_runs');
      expect(collectionsQueried).not.toContain('repo_context_curation_stage_runs');
      expect(result.curationStageStatus).toBeDefined();
      expect((result.curationStageStatus as Record<string, unknown>)?.wrongCollection).toBeUndefined();
    });
  });

  // ── Staged proposal resume: continue-from-last-run for the mapper ───────────

  describe('Staged proposal resume (continue-from-last-run)', () => {
    function makeStagedRun(setupRunId: string) {
      return {
        setupRunId,
        repoId: REPO_ID,
        status: 'running',
        currentPhase: 'mandatory_mapping',
        childExecutionIds: [],
        phases: {
          preflight: { status: 'completed' },
          curation: { status: 'completed' },
          mandatoryMapping: { status: 'running' },
          contextRefresh: { status: 'pending' },
        },
        diagnostics: [],
        resumeCount: 1,
        repoPath: '/tmp/test-repo',
        options: {},
        branch: 'main',
      };
    }

    function makeStagedDb(setupRun: Record<string, unknown>, proposalsCol: ReturnType<typeof makeCollection>) {
      return makeDb({
        repos: makeCollection([makeRepo()]),
        repo_context_setup_runs: makeCollection([setupRun]),
        agents: makeCollection(),
        mcp_servers: makeCollection(),
        executions: makeCollection([{ id: 'mapper-new-exec', status: 'completed' }]),
        mandatory_context_proposals: proposalsCol,
      });
    }

    it('injects the staged-summary into the mapper prompt and does NOT delete staged rows', async () => {
      const setupRun = makeStagedRun('run-resume-staged');
      const stagedRows = [
        { setupRunId: 'run-resume-staged', repoId: 'repo-1', agentName: 'agent-1', title: 'Doc A', content: 'a', status: 'staged' },
        { setupRunId: 'run-resume-staged', repoId: 'repo-1', agentName: 'agent-1', title: 'Doc B', content: 'b', status: 'staged' },
        { setupRunId: 'run-resume-staged', repoId: 'repo-1', agentName: 'agent-2', title: 'Doc C', content: 'c', status: 'staged' },
      ];
      const proposal = {
        proposalId: 'prop-resume',
        setupRunId: 'run-resume-staged',
        repoId: REPO_ID,
        status: 'proposed',
        affectedAgentNames: ['agent-1', 'agent-2'],
        mappings: [{ agentName: 'agent-1', title: 'Doc A', content: 'a' }],
      };
      const proposalsCol = makeCollection([...stagedRows, proposal]);
      const db = makeStagedDb(setupRun, proposalsCol);

      const spawn = vi.fn(async () => ({ execution_id: 'mapper-new-exec' }));
      const svc = new RepoContextSetupService(db, makeCuration() as never, makeMandatory() as never, makeCognee() as never, spawn);

      await svc['runMandatoryPhase'](setupRun as never);

      expect(spawn).toHaveBeenCalledTimes(1);
      const prompt = String((spawn.mock.calls[0] as unknown[])[0] && (spawn.mock.calls[0][0] as { prompt: string }).prompt);
      expect(prompt).toContain('RESUME NOTE');
      expect(prompt).toContain('already staged 3 mapping(s)');
      expect(prompt).toContain('agent-1=2');
      expect(prompt).toContain('agent-2=1');
      expect(prompt).toContain('- (agent-1, Doc A)');
      expect(prompt).toContain('- (agent-2, Doc C)');
      // No silent caps — 3 entries are all listed, no truncation note
      expect(prompt).not.toContain('more staged entries not listed');

      // Staged rows must survive the resume path untouched
      const survivingStaged = proposalsCol._store.filter((d) => d.status === 'staged');
      expect(survivingStaged).toHaveLength(3);
    });

    it('caps the staged (agentName,title) list at 50 entries with an explicit "and N more" note', async () => {
      const setupRun = makeStagedRun('run-resume-many');
      const stagedRows = Array.from({ length: 55 }, (_, i) => ({
        setupRunId: 'run-resume-many',
        repoId: 'repo-1',
        agentName: 'agent-1',
        title: `Doc ${i}`,
        content: 'c',
        status: 'staged',
      }));
      const proposal = { proposalId: 'prop-many', setupRunId: 'run-resume-many', repoId: REPO_ID, status: 'proposed', affectedAgentNames: ['agent-1'], mappings: [] };
      const proposalsCol = makeCollection([...stagedRows, proposal]);
      const db = makeStagedDb(setupRun, proposalsCol);

      const spawn = vi.fn(async () => ({ execution_id: 'mapper-new-exec' }));
      const svc = new RepoContextSetupService(db, makeCuration() as never, makeMandatory() as never, makeCognee() as never, spawn);

      await svc['runMandatoryPhase'](setupRun as never);

      const prompt = String((spawn.mock.calls[0][0] as { prompt: string }).prompt);
      expect(prompt).toContain('already staged 55 mapping(s)');
      expect(prompt).toContain('- (agent-1, Doc 49)');
      expect(prompt).not.toContain('- (agent-1, Doc 50)');
      expect(prompt).toContain('…and 5 more staged entries not listed here.');
    });

    it('fresh attempt (no staged rows) keeps the protocol instructions but omits the resume note', async () => {
      const setupRun = makeStagedRun('run-fresh');
      const proposal = { proposalId: 'prop-fresh', setupRunId: 'run-fresh', repoId: REPO_ID, status: 'proposed', affectedAgentNames: [], mappings: [] };
      const proposalsCol = makeCollection([proposal]);
      const db = makeStagedDb(setupRun, proposalsCol);

      const spawn = vi.fn(async () => ({ execution_id: 'mapper-new-exec' }));
      const svc = new RepoContextSetupService(db, makeCuration() as never, makeMandatory() as never, makeCognee() as never, spawn);

      await svc['runMandatoryPhase'](setupRun as never);

      const prompt = String((spawn.mock.calls[0][0] as { prompt: string }).prompt);
      expect(prompt).toContain('mode: "stage"');
      expect(prompt).toContain('mode: "finalize"');
      expect(prompt).toContain('AT MOST 10 mappings');
      expect(prompt).not.toContain('RESUME NOTE');
    });
  });
});
