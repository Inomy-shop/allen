// Tests for ContextEvaluationScheduler — repo filter, all-source deduplication, cursor lifecycle
// Uses MongoMemoryServer for in-memory MongoDB isolation.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ContextEvaluationScheduler } from '../../../services/context/judge/context-evaluation-scheduler.js';

let mongo: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let scheduler: ContextEvaluationScheduler;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = new MongoClient(mongo.getUri());
  await client.connect();
  db = client.db('test-scheduler');
  scheduler = new ContextEvaluationScheduler(db);
});

describe('chat_learning scoped discovery', () => {
  it('uses Mongo _id as learningId when learningId is missing', async () => {
    const learningObjectId = new ObjectId();
    await db.collection('learnings').insertOne({
      _id: learningObjectId,
      content: 'When editing context judge, verify curation mappings.',
      contextEligibility: null,
      repoId: 'repo-learning-a',
      createdAt: new Date(),
    });
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'chat_learning',
      scopeType: 'repo',
      scopeKey: 'repo-learning-a',
      status: 'idle',
      cursor: new Date(0).toISOString(),
      updatedAt: new Date(),
    });

    const results = await scheduler.discoverPending('chat_learning', 20, { repoId: 'repo-learning-a' });

    expect(results).toHaveLength(1);
    expect(results[0].sourceId).toBe(learningObjectId.toString());
    expect(results[0].repoId).toBe('repo-learning-a');
  });

  it('multi-repo learning assignment cursor updates one scoped row per repo', async () => {
    const now = new Date();
    await scheduler.markSourcesAssigned('chat_learning', [
      { sourceId: 'learning-r1', sourceKind: 'chat_learning', repoId: 'repo-1', createdAt: now },
      { sourceId: 'learning-r2', sourceKind: 'chat_learning', repoId: 'repo-2', createdAt: now },
    ]);

    const rows = await db.collection('context_judge_scheduler_state')
      .find({ sourceType: 'chat_learning', scopeType: 'repo' })
      .sort({ scopeKey: 1 })
      .toArray();

    expect(rows.map((row) => row['scopeKey'])).toEqual(['repo-1', 'repo-2']);
    expect(rows[0]['lastAssignedSourceIds']).toEqual(['learning-r1']);
    expect(rows[1]['lastAssignedSourceIds']).toEqual(['learning-r2']);
  });

  it('does not hide older unevaluated global learnings after a partial repo assignment', async () => {
    const repoId = 'repo-learning-batch';
    const base = new Date('2026-06-01T00:00:00.000Z').getTime();
    const ids: string[] = [];
    for (let i = 0; i < 29; i += 1) {
      const id = new ObjectId();
      ids.push(id.toString());
      await db.collection('learnings').insertOne({
        _id: id,
        content: `Learning ${i}`,
        contextEligibility: null,
        scope: { level: 'global' },
        createdAt: new Date(base + i * 1000),
      });
    }

    const firstBatch = await scheduler.discoverPending('chat_learning', 20, { repoId });
    expect(firstBatch).toHaveLength(20);
    await scheduler.markSourcesAssigned('chat_learning', firstBatch);
    for (const candidate of firstBatch) {
      await db.collection('context_source_evaluations').insertOne({
        evaluationId: `eval-${candidate.sourceId}`,
        sessionId: 'session-learning-batch',
        sourceType: 'chat_learning',
        sourceId: candidate.sourceId,
        sourceKey: `chat_learning:repo:${repoId}:${candidate.sourceId}`,
        repoId,
        decision: 'no_issue',
        status: 'completed',
        evaluationVersion: 1,
        evaluatedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    const secondBatch = await scheduler.discoverPending('chat_learning', 20, { repoId });

    expect(secondBatch).toHaveLength(9);
    expect(secondBatch.map((candidate) => candidate.sourceId).sort()).toEqual(ids.slice(0, 9).sort());
    const row = await db.collection('context_judge_scheduler_state').findOne({
      sourceType: 'chat_learning',
      scopeType: 'repo',
      scopeKey: repoId,
    });
    expect(row?.['cursor']).toBeUndefined();
  });
});

afterAll(async () => {
  await client.close();
  await mongo.stop();
});

beforeEach(async () => {
  // Clear all collections used by the scheduler
  await db.collection('executions').deleteMany({});
  await db.collection('agent_conversations').deleteMany({});
  await db.collection('chat_sessions').deleteMany({});
  await db.collection('context_ref_events').deleteMany({});
  await db.collection('context_evaluations').deleteMany({});
  await db.collection('learnings').deleteMany({});
  await db.collection('context_findings').deleteMany({});
  await db.collection('context_judge_runs').deleteMany({});
  await db.collection('context_judge_scheduler_state').deleteMany({});
  await db.collection('context_attempts').deleteMany({});
  await db.collection('workflow_interventions').deleteMany({});
});

// ─── Repo filter ──────────────────────────────────────────────────────────────

describe('context_usage_trace discovers from context_attempts', () => {
  it('discovers attempt with injectedCount > 0', async () => {
    const past = new Date(0);
    await db.collection('context_attempts').insertOne({
      contextAttemptId: 'ca-injected-1', executionId: 'exec-1', repoId: 'repo-a',
      executionKind: 'workflow_node', status: 'ready',
      contextInjection: { injectedCount: 3, consideredCount: 5 }, createdAt: new Date(),
    });
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'context_usage_trace', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });
    const results = await scheduler.discoverPending('context_usage_trace', 20);
    expect(results.length).toBe(1);
    expect(results[0].sourceId).toBe('ca-injected-1'); // contextAttemptId
    expect(results[0].sourceKind).toBe('context_usage_trace');
    expect(results[0].repoId).toBe('repo-a');
  });

  it('discovers attempt where only consideredCount > 0', async () => {
    const past = new Date(0);
    await db.collection('context_attempts').insertOne({
      contextAttemptId: 'ca-considered-1', executionId: 'exec-2', repoId: 'repo-b',
      executionKind: 'workflow_node', status: 'ready',
      contextInjection: { injectedCount: 0, consideredCount: 4 }, createdAt: new Date(),
    });
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'context_usage_trace', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });
    const results = await scheduler.discoverPending('context_usage_trace', 20);
    expect(results.length).toBe(1);
    expect(results[0].sourceId).toBe('ca-considered-1');
  });

  it('skips attempts where status != ready', async () => {
    const past = new Date(0);
    await db.collection('context_attempts').insertOne({
      contextAttemptId: 'ca-building-1', executionId: 'exec-3', repoId: 'repo-c',
      executionKind: 'workflow_node', status: 'building',
      contextInjection: { injectedCount: 2, consideredCount: 3 }, createdAt: new Date(),
    });
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'context_usage_trace', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });
    const results = await scheduler.discoverPending('context_usage_trace', 20);
    expect(results.length).toBe(0);
  });

  it('skips attempts with no injection evidence (both counts = 0)', async () => {
    const past = new Date(0);
    await db.collection('context_attempts').insertOne({
      contextAttemptId: 'ca-empty-1', executionId: 'exec-4', repoId: 'repo-d',
      executionKind: 'workflow_node', status: 'ready',
      contextInjection: { injectedCount: 0, consideredCount: 0 }, createdAt: new Date(),
    });
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'context_usage_trace', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });
    const results = await scheduler.discoverPending('context_usage_trace', 20);
    expect(results.length).toBe(0);
  });

  it('filters context_usage_trace candidates by repoId', async () => {
    const past = new Date(0);
    await db.collection('context_attempts').insertMany([
      { contextAttemptId: 'ca-repo-filter-1', executionId: 'exec-r1', repoId: 'repo-target', executionKind: 'workflow_node', status: 'ready', contextInjection: { injectedCount: 2, consideredCount: 3 }, createdAt: new Date() },
      { contextAttemptId: 'ca-repo-filter-2', executionId: 'exec-r2', repoId: 'repo-other', executionKind: 'workflow_node', status: 'ready', contextInjection: { injectedCount: 1, consideredCount: 2 }, createdAt: new Date() },
    ]);
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'context_usage_trace', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });
    const results = await scheduler.discoverPending('context_usage_trace', 20, { repoId: 'repo-target' });
    expect(results.length).toBe(1);
    expect(results[0].sourceId).toBe('ca-repo-filter-1');
  });
});

// ─── workflow_run discovers distinct executionIds from context_attempts ────────

describe('workflow_run discovers distinct executionIds from context_attempts', () => {
  it('discovers workflow_node executionId from context_attempts', async () => {
    const past = new Date(0);
    await db.collection('context_attempts').insertOne({
      contextAttemptId: 'ca-wf-1', executionId: 'exec-wf-distinct-1', repoId: 'repo-wf',
      executionKind: 'workflow_node', status: 'ready',
      contextInjection: { injectedCount: 2, consideredCount: 3 }, createdAt: new Date(),
    });
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'workflow_run', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });
    const results = await scheduler.discoverPending('workflow_run', 20);
    expect(results.length).toBe(1);
    expect(results[0].sourceId).toBe('exec-wf-distinct-1'); // executionId, not contextAttemptId
    expect(results[0].sourceKind).toBe('workflow_run');
  });

  it('deduplicates multiple attempts for the same executionId', async () => {
    const past = new Date(0);
    await db.collection('context_attempts').insertMany([
      { contextAttemptId: 'ca-wf-multi-1', executionId: 'exec-multi', repoId: 'repo-wf', executionKind: 'workflow_node', status: 'ready', contextInjection: { injectedCount: 2, consideredCount: 3 }, createdAt: new Date(Date.now() - 1000) },
      { contextAttemptId: 'ca-wf-multi-2', executionId: 'exec-multi', repoId: 'repo-wf', executionKind: 'workflow_node', status: 'ready', contextInjection: { injectedCount: 1, consideredCount: 2 }, createdAt: new Date() },
    ]);
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'workflow_run', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });
    const results = await scheduler.discoverPending('workflow_run', 20);
    expect(results.filter(r => r.sourceId === 'exec-multi').length).toBe(1); // deduped
  });

  it('does not discover spawned_agent attempts as workflow_run', async () => {
    const past = new Date(0);
    await db.collection('context_attempts').insertOne({
      contextAttemptId: 'ca-agent-1', executionId: 'exec-agent-1', repoId: 'repo-wf',
      executionKind: 'spawned_agent', status: 'ready',
      contextInjection: { injectedCount: 2, consideredCount: 3 }, createdAt: new Date(),
    });
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'workflow_run', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });
    const results = await scheduler.discoverPending('workflow_run', 20);
    expect(results.find(r => r.sourceId === 'exec-agent-1')).toBeUndefined();
  });
});

// ─── spawned_agent_run discovers from context_attempts ───────────────────────

describe('spawned_agent_run discovers from context_attempts', () => {
  it('discovers spawned_agent executionId from context_attempts', async () => {
    const past = new Date(0);
    await db.collection('context_attempts').insertOne({
      contextAttemptId: 'ca-agent-disc-1', executionId: 'exec-agent-disc-1', repoId: 'repo-agent',
      executionKind: 'spawned_agent', status: 'ready',
      contextInjection: { injectedCount: 1, consideredCount: 2 }, createdAt: new Date(),
    });
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'spawned_agent_run', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });
    const results = await scheduler.discoverPending('spawned_agent_run', 20);
    expect(results.length).toBe(1);
    expect(results[0].sourceId).toBe('exec-agent-disc-1');
    expect(results[0].sourceKind).toBe('spawned_agent_run');
  });

  it('does not discover workflow_node attempts as spawned_agent_run', async () => {
    const past = new Date(0);
    await db.collection('context_attempts').insertOne({
      contextAttemptId: 'ca-wf-notag-1', executionId: 'exec-wf-notag-1', repoId: 'repo-agent',
      executionKind: 'workflow_node', status: 'ready',
      contextInjection: { injectedCount: 2, consideredCount: 3 }, createdAt: new Date(),
    });
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'spawned_agent_run', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });
    const results = await scheduler.discoverPending('spawned_agent_run', 20);
    expect(results.find(r => r.sourceId === 'exec-wf-notag-1')).toBeUndefined();
  });
});

// ─── Fix 7: Learning discovery policy ────────────────────────────────────────
// Repo-specific runs include:
//   (a) repo-specific learnings (repoId matches)
//   (b) global/unscoped learnings (repoId null or missing)
// Global runs include all eligible learnings.
// Learnings belonging to a DIFFERENT repo are excluded from repo-specific runs.

describe('chat_learning discovery policy (Fix 7)', () => {
  it('global run (no repoIds filter) returns all eligible learnings', async () => {
    const past = new Date(0);
    await db.collection('learnings').insertMany([
      { learningId: 'lrn-global-1', repoId: 'repo-a', contextEligibility: null, createdAt: new Date() },
      { learningId: 'lrn-global-2', repoId: 'repo-b', contextEligibility: null, createdAt: new Date() },
      { learningId: 'lrn-global-3', repoId: null, contextEligibility: null, createdAt: new Date() },
      { learningId: 'lrn-global-4', contextEligibility: null, createdAt: new Date() },
    ]);
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'chat_learning', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });

    const results = await scheduler.discoverPending('chat_learning', 20);
    const ids = results.map((r) => r.sourceId);
    expect(ids).toContain('lrn-global-1');
    expect(ids).toContain('lrn-global-2');
    expect(ids).toContain('lrn-global-3');
    expect(ids).toContain('lrn-global-4');
  });

  it('repo-specific run includes learnings for the repo', async () => {
    const past = new Date(0);
    await db.collection('learnings').insertMany([
      { learningId: 'lrn-repo-a-1', repoId: 'repo-a', contextEligibility: null, createdAt: new Date() },
      { learningId: 'lrn-repo-b-1', repoId: 'repo-b', contextEligibility: null, createdAt: new Date() },
    ]);
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'chat_learning', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });

    const results = await scheduler.discoverPending('chat_learning', 20, { repoId: 'repo-a' });
    const ids = results.map((r) => r.sourceId);
    expect(ids).toContain('lrn-repo-a-1');
    expect(ids).not.toContain('lrn-repo-b-1');
  });

  it('repo-specific run includes global/unscoped learnings (repoId null)', async () => {
    const past = new Date(0);
    await db.collection('learnings').insertMany([
      { learningId: 'lrn-scoped-1', repoId: 'repo-a', contextEligibility: null, createdAt: new Date() },
      { learningId: 'lrn-unscoped-null', repoId: null, contextEligibility: null, createdAt: new Date() },
      { learningId: 'lrn-unscoped-missing', contextEligibility: null, createdAt: new Date() },
    ]);
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'chat_learning', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });

    const results = await scheduler.discoverPending('chat_learning', 20, { repoId: 'repo-a' });
    const ids = results.map((r) => r.sourceId);
    expect(ids).toContain('lrn-scoped-1');
    expect(ids).toContain('lrn-unscoped-null');
    expect(ids).toContain('lrn-unscoped-missing');
  });

  it('repo-specific run excludes learnings that belong to a different repo', async () => {
    const past = new Date(0);
    await db.collection('learnings').insertMany([
      { learningId: 'lrn-other-repo', repoId: 'repo-other', contextEligibility: null, createdAt: new Date() },
      { learningId: 'lrn-my-repo', repoId: 'repo-a', contextEligibility: null, createdAt: new Date() },
    ]);
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'chat_learning', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });

    const results = await scheduler.discoverPending('chat_learning', 20, { repoId: 'repo-a' });
    const ids = results.map((r) => r.sourceId);
    // Should include own-repo learning
    expect(ids).toContain('lrn-my-repo');
    // Should NOT include other-repo learning
    expect(ids).not.toContain('lrn-other-repo');
  });

  it('excludes ineligible learnings regardless of repo scope', async () => {
    const past = new Date(0);
    await db.collection('learnings').insertMany([
      { learningId: 'lrn-ineligible-1', repoId: 'repo-a', contextEligibility: 'ineligible', createdAt: new Date() },
      { learningId: 'lrn-eligible-1', repoId: 'repo-a', contextEligibility: null, createdAt: new Date() },
    ]);
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'chat_learning', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });

    const results = await scheduler.discoverPending('chat_learning', 20, { repoId: 'repo-a' });
    const ids = results.map((r) => r.sourceId);
    expect(ids).not.toContain('lrn-ineligible-1');
    expect(ids).toContain('lrn-eligible-1');
  });

  it('multi-repo repoIds filter includes global/unscoped learnings', async () => {
    const past = new Date(0);
    await db.collection('learnings').insertMany([
      { learningId: 'lrn-m1', repoId: 'repo-m1', contextEligibility: null, createdAt: new Date() },
      { learningId: 'lrn-m2', repoId: 'repo-m2', contextEligibility: null, createdAt: new Date() },
      { learningId: 'lrn-m3-other', repoId: 'repo-m3-other', contextEligibility: null, createdAt: new Date() },
      { learningId: 'lrn-unscoped-m', repoId: null, contextEligibility: null, createdAt: new Date() },
    ]);
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'chat_learning', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });

    const results = await scheduler.discoverPending('chat_learning', 20, { repoIds: ['repo-m1', 'repo-m2'] });
    const ids = results.map((r) => r.sourceId);
    expect(ids).toContain('lrn-m1');
    expect(ids).toContain('lrn-m2');
    expect(ids).toContain('lrn-unscoped-m');
    expect(ids).not.toContain('lrn-m3-other');
  });
});

// ─── pending discovery payload is lightweight ────────────────────────────────

describe('pending discovery payload is lightweight', () => {
  it('discoverPending for context_usage_trace returns only lightweight fields', async () => {
    const past = new Date(0);
    await db.collection('context_attempts').insertOne({
      contextAttemptId: 'ca-light-1', executionId: 'exec-light-1', repoId: 'repo-light',
      executionKind: 'workflow_node', status: 'ready',
      contextInjection: { injectedCount: 3, consideredCount: 5 }, createdAt: new Date(),
      // These should NOT appear in the returned candidate:
      taskPrompt: 'very long task prompt here',
      renderedContextQuery: 'rendered query content',
      diagnosticsArtifactHash: 'sha256abc',
      contextQuerySummary: { role: 'engineer', workflowName: 'test' },
    });
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'context_usage_trace', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });
    const results = await scheduler.discoverPending('context_usage_trace', 20);
    expect(results.length).toBe(1);
    // Verify shape — lightweight fields only (sourceId, sourceKind, repoId, plus
    // contextAttemptId, executionId, flowKind for context_usage_trace candidates)
    const candidate = results[0];
    expect(candidate.sourceId).toBe('ca-light-1');
    expect(candidate.sourceKind).toBe('context_usage_trace');
    expect(candidate.repoId).toBe('repo-light');
    // Ensure no large payload fields leaked
    expect((candidate as any).taskPrompt).toBeUndefined();
    expect((candidate as any).renderedContextQuery).toBeUndefined();
    expect((candidate as any).diagnosticsArtifactHash).toBeUndefined();
  });
});

// ─── context_usage_trace explicit payload fields ──────────────────────────────
// ENG-1760 hardening: candidates must include contextAttemptId, executionId,
// flowKind explicitly so judge agents do not confuse sourceId with executionId.

describe('context_usage_trace explicit payload fields', () => {
  it('candidate includes explicit contextAttemptId, executionId, flowKind', async () => {
    const past = new Date(0);
    await db.collection('context_attempts').insertOne({
      contextAttemptId: 'ca-explicit-1', executionId: 'exec-explicit-1', repoId: 'repo-exp',
      executionKind: 'workflow_node', status: 'ready',
      contextInjection: { injectedCount: 2, consideredCount: 3 }, createdAt: new Date(),
    });
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'context_usage_trace', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });
    const results = await scheduler.discoverPending('context_usage_trace', 20);
    expect(results.length).toBe(1);
    const c = results[0];
    expect(c.contextAttemptId).toBe('ca-explicit-1');
    expect(c.executionId).toBe('exec-explicit-1');
    expect(c.flowKind).toBe('workflow_node');
  });

  it('sourceId === contextAttemptId (backwards compatibility guaranteed)', async () => {
    const past = new Date(0);
    await db.collection('context_attempts').insertOne({
      contextAttemptId: 'ca-compat-bwd', executionId: 'exec-compat-bwd', repoId: 'repo-compat',
      executionKind: 'spawned_agent', status: 'ready',
      contextInjection: { injectedCount: 1, consideredCount: 2 }, createdAt: new Date(),
    });
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'context_usage_trace', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });
    const results = await scheduler.discoverPending('context_usage_trace', 20);
    expect(results.length).toBe(1);
    // sourceId must equal contextAttemptId — invariant for backwards compatibility
    expect(results[0].sourceId).toBe(results[0].contextAttemptId);
    expect(results[0].flowKind).toBe('spawned_agent');
  });

  it('workflow_run candidates do NOT include contextAttemptId or flowKind (other types unaffected)', async () => {
    const past = new Date(0);
    await db.collection('context_attempts').insertOne({
      contextAttemptId: 'ca-wf-unaffected', executionId: 'exec-wf-unaffected', repoId: 'repo-unaffected',
      executionKind: 'workflow_node', status: 'ready',
      contextInjection: { injectedCount: 2, consideredCount: 3 }, createdAt: new Date(),
    });
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'workflow_run', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });
    const results = await scheduler.discoverPending('workflow_run', 20);
    expect(results.length).toBe(1);
    // workflow_run sourceId is the executionId, NOT the contextAttemptId
    expect(results[0].sourceId).toBe('exec-wf-unaffected');
    // workflow_run candidates do not carry context_usage_trace-specific fields
    expect((results[0] as any).contextAttemptId).toBeUndefined();
    expect((results[0] as any).flowKind).toBeUndefined();
  });

  it('flowKind reflects executionKind from the context_attempt', async () => {
    const past = new Date(0);
    await db.collection('context_attempts').insertMany([
      {
        contextAttemptId: 'ca-fk-wf', executionId: 'exec-fk-wf', repoId: 'repo-fk',
        executionKind: 'workflow_node', status: 'ready',
        contextInjection: { injectedCount: 1, consideredCount: 2 }, createdAt: new Date(Date.now() - 2000),
      },
      {
        contextAttemptId: 'ca-fk-agent', executionId: 'exec-fk-agent', repoId: 'repo-fk',
        executionKind: 'spawned_agent', status: 'ready',
        contextInjection: { injectedCount: 1, consideredCount: 2 }, createdAt: new Date(Date.now() - 1000),
      },
    ]);
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'context_usage_trace', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });
    const results = await scheduler.discoverPending('context_usage_trace', 20);
    expect(results.length).toBe(2);
    const wfCandidate = results.find((r) => r.contextAttemptId === 'ca-fk-wf');
    const agentCandidate = results.find((r) => r.contextAttemptId === 'ca-fk-agent');
    expect(wfCandidate?.flowKind).toBe('workflow_node');
    expect(agentCandidate?.flowKind).toBe('spawned_agent');
  });
});

// ─── Primary requirement: sort newest-first before limit ─────────────────────
// Candidates must be sorted by date descending BEFORE the limit is applied.
// The newest sources should be evaluated first.

describe('newest-first ordering before limit', () => {
  it('context_usage_trace: returns newest candidates first when limited', async () => {
    const past = new Date(0);
    const old = new Date(Date.now() - 60000); // 60s ago
    const medium = new Date(Date.now() - 30000); // 30s ago
    const recent = new Date(); // now

    await db.collection('context_attempts').insertMany([
      { contextAttemptId: 'ca-old', executionId: 'exec-old', repoId: 'repo-order',
        executionKind: 'workflow_node', status: 'ready',
        contextInjection: { injectedCount: 1, consideredCount: 2 }, createdAt: old },
      { contextAttemptId: 'ca-medium', executionId: 'exec-medium', repoId: 'repo-order',
        executionKind: 'workflow_node', status: 'ready',
        contextInjection: { injectedCount: 1, consideredCount: 2 }, createdAt: medium },
      { contextAttemptId: 'ca-recent', executionId: 'exec-recent', repoId: 'repo-order',
        executionKind: 'workflow_node', status: 'ready',
        contextInjection: { injectedCount: 1, consideredCount: 2 }, createdAt: recent },
    ]);
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'context_usage_trace', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });

    // limit=2 — should return the 2 newest, not the 2 oldest
    const results = await scheduler.discoverPending('context_usage_trace', 2);
    expect(results).toHaveLength(2);
    // Most recent first
    expect(results[0].sourceId).toBe('ca-recent');
    expect(results[1].sourceId).toBe('ca-medium');
    // Oldest excluded because limit=2
    expect(results.find((r) => r.sourceId === 'ca-old')).toBeUndefined();
  });

  it('workflow_run: returns newest candidates first when limited', async () => {
    const past = new Date(0);
    const old = new Date(Date.now() - 60000);
    const recent = new Date();

    await db.collection('context_attempts').insertMany([
      { contextAttemptId: 'ca-wf-old', executionId: 'exec-wf-old', repoId: 'repo-wf-order',
        executionKind: 'workflow_node', status: 'ready',
        contextInjection: { injectedCount: 1, consideredCount: 2 }, createdAt: old },
      { contextAttemptId: 'ca-wf-recent', executionId: 'exec-wf-recent', repoId: 'repo-wf-order',
        executionKind: 'workflow_node', status: 'ready',
        contextInjection: { injectedCount: 1, consideredCount: 2 }, createdAt: recent },
    ]);
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'workflow_run', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });

    const results = await scheduler.discoverPending('workflow_run', 1);
    expect(results).toHaveLength(1);
    // Most recent should come first
    expect(results[0].sourceId).toBe('exec-wf-recent');
  });

  it('chat_learning: returns newest candidates first when limited', async () => {
    const past = new Date(0);
    const old = new Date(Date.now() - 60000);
    const recent = new Date();

    await db.collection('learnings').insertMany([
      { learningId: 'lrn-order-old', repoId: null, contextEligibility: null, createdAt: old },
      { learningId: 'lrn-order-recent', repoId: null, contextEligibility: null, createdAt: recent },
    ]);
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'chat_learning', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });

    const results = await scheduler.discoverPending('chat_learning', 1);
    expect(results).toHaveLength(1);
    expect(results[0].sourceId).toBe('lrn-order-recent');
  });

  it('human_feedback: returns newest candidates first when limited', async () => {
    const past = new Date(0);
    const old = new Date(Date.now() - 60000);
    const recent = new Date();

    await db.collection('workflow_interventions').insertMany([
      {
        intervention_id: 'INT-order-old', workflow_run_id: 'wfr-order-old',
        workflow_name: 'wf-old', stage: 'review', status: 'answered',
        response: { feedback: 'Old feedback' }, answered_at: old, created_at: old,
      },
      {
        intervention_id: 'INT-order-recent', workflow_run_id: 'wfr-order-recent',
        workflow_name: 'wf-recent', stage: 'review', status: 'answered',
        response: { feedback: 'Recent feedback' }, answered_at: recent, created_at: recent,
      },
    ]);
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'human_feedback', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });

    const results = await scheduler.discoverPending('human_feedback', 1);
    expect(results).toHaveLength(1);
    expect(results[0].sourceId).toBe('INT-order-recent');
  });
});

// ─── GAP 1+2: context_source_evaluations anti-join ───────────────────────────
// Sources already in context_source_evaluations (status='completed') must be
// excluded from pending discovery even if they have no context_judge_runs entry.
// Unevaluated older sources (before cursor) must be discoverable with allowBackfill.

describe('context_source_evaluations anti-join (GAP 1+2)', () => {
  it('excludes sources already in context_source_evaluations with status=completed', async () => {
    const past = new Date(0);
    await db.collection('context_attempts').insertOne({
      contextAttemptId: 'ca-evaluated', executionId: 'exec-evaluated', repoId: 'repo-antijoin',
      executionKind: 'workflow_node', status: 'ready',
      contextInjection: { injectedCount: 2, consideredCount: 3 }, createdAt: new Date(),
    });
    // Mark as already evaluated in the durable ledger
    await db.collection('context_source_evaluations').insertOne({
      evaluationId: 'eval-antijoin-1', sessionId: 'sess-antijoin', sourceType: 'workflow_run',
      sourceId: 'exec-evaluated', sourceKey: 'workflow_run:exec-evaluated',
      decision: 'no_issue', status: 'completed', evaluationVersion: 1,
      evaluatedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
    });
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'workflow_run', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });

    const results = await scheduler.discoverPending('workflow_run', 20);
    // Must be excluded because it's in context_source_evaluations as completed
    expect(results.find((r) => r.sourceId === 'exec-evaluated')).toBeUndefined();
  });

  it('includes sources with context_source_evaluations status=retryable (not completed)', async () => {
    const past = new Date(0);
    await db.collection('context_attempts').insertOne({
      contextAttemptId: 'ca-retryable', executionId: 'exec-retryable', repoId: 'repo-antijoin2',
      executionKind: 'workflow_node', status: 'ready',
      contextInjection: { injectedCount: 1, consideredCount: 2 }, createdAt: new Date(),
    });
    // status=retryable — NOT completed, should still be discoverable
    await db.collection('context_source_evaluations').insertOne({
      evaluationId: 'eval-retryable-1', sessionId: 'sess-antijoin2', sourceType: 'workflow_run',
      sourceId: 'exec-retryable', sourceKey: 'workflow_run:exec-retryable',
      decision: 'error', status: 'retryable', evaluationVersion: 1,
      evaluatedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
    });
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'workflow_run', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });

    const results = await scheduler.discoverPending('workflow_run', 20);
    // retryable status means the evaluation was not definitively completed — include it
    expect(results.find((r) => r.sourceId === 'exec-retryable')).toBeDefined();
  });

  it('allowBackfill=true ignores cursor and discovers older unevaluated sources', async () => {
    const recentCursor = new Date(Date.now() - 5000); // cursor set 5s ago
    const olderThanCursor = new Date(Date.now() - 60000); // created 60s ago (before cursor)

    await db.collection('context_attempts').insertOne({
      contextAttemptId: 'ca-old-backfill', executionId: 'exec-old-backfill', repoId: 'repo-backfill',
      executionKind: 'workflow_node', status: 'ready',
      contextInjection: { injectedCount: 1, consideredCount: 2 }, createdAt: olderThanCursor,
    });
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'workflow_run', status: 'idle', cursor: recentCursor.toISOString(), updatedAt: new Date(),
    });

    // Without backfill: source is older than cursor → not discovered
    const withoutBackfill = await scheduler.discoverPending('workflow_run', 20, undefined, false);
    expect(withoutBackfill.find((r) => r.sourceId === 'exec-old-backfill')).toBeUndefined();

    // With allowBackfill=true: cursor ignored → older source is discoverable
    const withBackfill = await scheduler.discoverPending('workflow_run', 20, undefined, true);
    expect(withBackfill.find((r) => r.sourceId === 'exec-old-backfill')).toBeDefined();
  });

  it('anti-join does not interfere with context_usage_trace discovery', async () => {
    const past = new Date(0);
    await db.collection('context_attempts').insertMany([
      { contextAttemptId: 'ca-done', executionId: 'exec-done', repoId: 'repo-trace-aj',
        executionKind: 'workflow_node', status: 'ready',
        contextInjection: { injectedCount: 1, consideredCount: 2 }, createdAt: new Date(Date.now() - 1000) },
      { contextAttemptId: 'ca-pending', executionId: 'exec-pending', repoId: 'repo-trace-aj',
        executionKind: 'workflow_node', status: 'ready',
        contextInjection: { injectedCount: 1, consideredCount: 2 }, createdAt: new Date() },
    ]);
    // Mark ca-done as completed
    await db.collection('context_source_evaluations').insertOne({
      evaluationId: 'eval-done-trace', sessionId: 'sess-done', sourceType: 'context_usage_trace',
      sourceId: 'ca-done', sourceKey: 'context_usage_trace:ca-done',
      decision: 'no_issue', status: 'completed', evaluationVersion: 1,
      evaluatedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
    });
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'context_usage_trace', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });

    const results = await scheduler.discoverPending('context_usage_trace', 20);
    // ca-done is excluded (completed evaluation), ca-pending is included
    expect(results.find((r) => r.sourceId === 'ca-done')).toBeUndefined();
    expect(results.find((r) => r.sourceId === 'ca-pending')).toBeDefined();
  });
});
