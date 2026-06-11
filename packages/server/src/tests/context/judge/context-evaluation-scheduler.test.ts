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

describe('discoverPending with repoId filter', () => {
  it('filters workflow_run sources by repoId', async () => {
    const past = new Date(0);
    await db.collection('context_attempts').insertMany([
      { contextAttemptId: 'ca-repo-a-1', executionId: 'exec-repo-a-1', repoId: 'repo-a', executionKind: 'workflow_node', status: 'ready', contextInjection: { injectedCount: 2, consideredCount: 3 }, createdAt: new Date() },
      { contextAttemptId: 'ca-repo-b-1', executionId: 'exec-repo-b-1', repoId: 'repo-b', executionKind: 'workflow_node', status: 'ready', contextInjection: { injectedCount: 1, consideredCount: 2 }, createdAt: new Date() },
    ]);
    // Seed cursor to past so all records are discovered
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'workflow_run', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });

    const results = await scheduler.discoverPending('workflow_run', 20, { repoId: 'repo-a' });
    expect(results.length).toBe(1);
    expect(results[0].sourceId).toBe('exec-repo-a-1');
    expect(results[0].repoId).toBe('repo-a');
  });

  it('returns sources from all repos when no filter provided (global)', async () => {
    const past = new Date(0);
    await db.collection('context_attempts').insertMany([
      { contextAttemptId: 'ca-global-1', executionId: 'exec-global-1', repoId: 'repo-x', executionKind: 'workflow_node', status: 'ready', contextInjection: { injectedCount: 1, consideredCount: 2 }, createdAt: new Date() },
      { contextAttemptId: 'ca-global-2', executionId: 'exec-global-2', repoId: 'repo-y', executionKind: 'workflow_node', status: 'ready', contextInjection: { injectedCount: 1, consideredCount: 2 }, createdAt: new Date() },
    ]);
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'workflow_run', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });

    const results = await scheduler.discoverPending('workflow_run', 20);
    expect(results.length).toBe(2);
  });

  it('filters by repoIds array', async () => {
    const past = new Date(0);
    await db.collection('context_attempts').insertMany([
      { contextAttemptId: 'ca-multi-a', executionId: 'exec-multi-a', repoId: 'repo-m1', executionKind: 'workflow_node', status: 'ready', contextInjection: { injectedCount: 1, consideredCount: 2 }, createdAt: new Date() },
      { contextAttemptId: 'ca-multi-b', executionId: 'exec-multi-b', repoId: 'repo-m2', executionKind: 'workflow_node', status: 'ready', contextInjection: { injectedCount: 1, consideredCount: 2 }, createdAt: new Date() },
      { contextAttemptId: 'ca-multi-c', executionId: 'exec-multi-c', repoId: 'repo-m3', executionKind: 'workflow_node', status: 'ready', contextInjection: { injectedCount: 1, consideredCount: 2 }, createdAt: new Date() },
    ]);
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'workflow_run', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });

    const results = await scheduler.discoverPending('workflow_run', 20, { repoIds: ['repo-m1', 'repo-m2'] });
    expect(results.length).toBe(2);
    const ids = results.map((r) => r.sourceId);
    expect(ids).toContain('exec-multi-a');
    expect(ids).toContain('exec-multi-b');
    expect(ids).not.toContain('exec-multi-c');
  });
});

// ─── All-source deduplication ─────────────────────────────────────────────────

describe('deduplication: workflow_run', () => {
  it('skips source when active judge run exists', async () => {
    const past = new Date(0);
    await db.collection('context_attempts').insertOne({
      contextAttemptId: 'ca-wf-dedup-1', executionId: 'wf-dedup-1', repoId: 'repo-d',
      executionKind: 'workflow_node', status: 'ready',
      contextInjection: { injectedCount: 2, consideredCount: 3 }, createdAt: new Date(),
    });
    await db.collection('context_judge_runs').insertOne({
      judgeRunId: 'run-wf-dedup-1', sourceId: 'wf-dedup-1', sourceKey: 'workflow_run:wf-dedup-1', active: true, status: 'completed',
    });
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'workflow_run', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });

    const results = await scheduler.discoverPending('workflow_run', 20);
    expect(results.find((r) => r.sourceId === 'wf-dedup-1')).toBeUndefined();
  });

  it('includes source when no active judge run exists', async () => {
    const past = new Date(0);
    await db.collection('context_attempts').insertOne({
      contextAttemptId: 'ca-wf-new-1', executionId: 'wf-new-1', repoId: 'repo-d',
      executionKind: 'workflow_node', status: 'ready',
      contextInjection: { injectedCount: 2, consideredCount: 3 }, createdAt: new Date(),
    });
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'workflow_run', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });

    const results = await scheduler.discoverPending('workflow_run', 20);
    expect(results.find((r) => r.sourceId === 'wf-new-1')).toBeDefined();
  });
});

describe('deduplication: spawned_agent_run', () => {
  it('skips source when active judge run exists', async () => {
    const past = new Date(0);
    await db.collection('context_attempts').insertOne({
      contextAttemptId: 'ca-conv-dedup-1', executionId: 'conv-dedup-1', repoId: 'repo-e',
      executionKind: 'spawned_agent', status: 'ready',
      contextInjection: { injectedCount: 1, consideredCount: 2 }, createdAt: new Date(),
    });
    await db.collection('context_judge_runs').insertOne({
      judgeRunId: 'run-conv-dedup-1', sourceId: 'conv-dedup-1', sourceKey: 'spawned_agent_run:conv-dedup-1', active: true, status: 'completed',
    });
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'spawned_agent_run', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });

    const results = await scheduler.discoverPending('spawned_agent_run', 20);
    expect(results.find((r) => r.sourceId === 'conv-dedup-1')).toBeUndefined();
  });
});

describe('deduplication: chat_turn', () => {
  it('skips source when active judge run exists', async () => {
    const past = new Date(0);
    await db.collection('chat_sessions').insertOne({
      sessionId: 'sess-dedup-1', updatedAt: new Date(),
    });
    await db.collection('context_judge_runs').insertOne({
      judgeRunId: 'run-sess-dedup-1', sourceId: 'sess-dedup-1', sourceKey: 'chat_turn:sess-dedup-1', active: true, status: 'completed',
    });
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'chat_turn', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });

    const results = await scheduler.discoverPending('chat_turn', 20);
    expect(results.find((r) => r.sourceId === 'sess-dedup-1')).toBeUndefined();
  });

  it('includes source when no active judge run exists', async () => {
    const past = new Date(0);
    await db.collection('chat_sessions').insertOne({
      sessionId: 'sess-new-1', updatedAt: new Date(),
    });
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'chat_turn', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });

    const results = await scheduler.discoverPending('chat_turn', 20);
    expect(results.find((r) => r.sourceId === 'sess-new-1')).toBeDefined();
  });
});

describe('deduplication: context_usage_trace', () => {
  it('skips source when active judge run exists', async () => {
    const past = new Date(0);
    await db.collection('context_attempts').insertOne({
      contextAttemptId: 'ca-dedup-1', executionId: 'exec-dedup-1', repoId: 'repo-f',
      executionKind: 'workflow_node', status: 'ready',
      contextInjection: { injectedCount: 2, consideredCount: 3 }, createdAt: new Date(),
    });
    await db.collection('context_judge_runs').insertOne({
      judgeRunId: 'run-evt-dedup-1', sourceId: 'ca-dedup-1', sourceKey: 'context_usage_trace:ca-dedup-1', active: true, status: 'completed',
    });
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'context_usage_trace', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });

    const results = await scheduler.discoverPending('context_usage_trace', 20);
    expect(results.find((r) => r.sourceId === 'ca-dedup-1')).toBeUndefined();
  });
});

describe('deduplication: deterministic_warning', () => {
  it('skips source when active judge run exists', async () => {
    const past = new Date(0);
    await db.collection('context_evaluations').insertOne({
      evaluationId: 'eval-dedup-1', 'semantic.overallScore': 0.3, repoId: 'repo-g', updatedAt: new Date(),
    });
    await db.collection('context_judge_runs').insertOne({
      judgeRunId: 'run-eval-dedup-1', sourceId: 'eval-dedup-1', sourceKey: 'deterministic_warning:eval-dedup-1', active: true, status: 'completed',
    });
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'deterministic_warning', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });

    const results = await scheduler.discoverPending('deterministic_warning', 20);
    expect(results.find((r) => r.sourceId === 'eval-dedup-1')).toBeUndefined();
  });
});

describe('deduplication: human_feedback', () => {
  it('skips source when active judge run exists (sourceKey format: human_feedback:intervention:<id>)', async () => {
    const past = new Date(0);
    await db.collection('workflow_interventions').insertOne({
      intervention_id: 'INT-fb-dedup-1',
      workflow_run_id: 'run-wfr-dedup-1',
      workflow_name: 'test-workflow',
      stage: 'review',
      status: 'answered',
      response: { decision: 'approve', feedback: 'Looks good' },
      answered_at: new Date(),
      created_at: new Date(),
    });
    await db.collection('context_judge_runs').insertOne({
      judgeRunId: 'run-fb-dedup-1',
      sourceId: 'INT-fb-dedup-1',
      sourceKey: 'human_feedback:intervention:INT-fb-dedup-1',
      active: true,
      status: 'completed',
    });
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'human_feedback', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });

    const results = await scheduler.discoverPending('human_feedback', 20);
    expect(results.find((r) => r.sourceId === 'INT-fb-dedup-1')).toBeUndefined();
  });
});

// ─── human_feedback discovery from workflow_interventions ─────────────────────

describe('human_feedback discovery from workflow_interventions', () => {
  it('discovers answered intervention with response.feedback', async () => {
    const past = new Date(0);
    await db.collection('workflow_interventions').insertOne({
      intervention_id: 'INT-hf-1',
      workflow_run_id: 'wfr-hf-1',
      workflow_name: 'deploy-workflow',
      stage: 'review',
      status: 'answered',
      response: { decision: 'approve', feedback: 'Looks great, ship it' },
      answered_at: new Date(),
      created_at: new Date(),
    });
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'human_feedback', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });

    const results = await scheduler.discoverPending('human_feedback', 20);
    expect(results.length).toBe(1);
    expect(results[0].sourceId).toBe('INT-hf-1');
    expect(results[0].sourceKind).toBe('human_feedback');
  });

  it('discovers answered intervention with response.answer when feedback is absent', async () => {
    const past = new Date(0);
    await db.collection('workflow_interventions').insertOne({
      intervention_id: 'INT-hf-answer-1',
      workflow_run_id: 'wfr-hf-answer-1',
      workflow_name: 'clarify-workflow',
      stage: 'clarify',
      status: 'answered',
      response: { decision: 'answer', answer: 'Yes, proceed with the current approach' },
      answered_at: new Date(),
      created_at: new Date(),
    });
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'human_feedback', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });

    const results = await scheduler.discoverPending('human_feedback', 20);
    expect(results.length).toBe(1);
    expect(results[0].sourceId).toBe('INT-hf-answer-1');
    expect(results[0].sourceKind).toBe('human_feedback');
  });

  it('skips pending interventions', async () => {
    const past = new Date(0);
    await db.collection('workflow_interventions').insertOne({
      intervention_id: 'INT-hf-pending-1',
      workflow_run_id: 'wfr-hf-pending-1',
      workflow_name: 'workflow-pending',
      stage: 'review',
      status: 'pending',
      // No response yet
      created_at: new Date(),
    });
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'human_feedback', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });

    const results = await scheduler.discoverPending('human_feedback', 20);
    expect(results.find((r) => r.sourceId === 'INT-hf-pending-1')).toBeUndefined();
  });

  it('skips answered interventions with empty feedback and empty answer', async () => {
    const past = new Date(0);
    await db.collection('workflow_interventions').insertMany([
      {
        intervention_id: 'INT-hf-empty-fb',
        workflow_run_id: 'wfr-hf-empty-fb',
        workflow_name: 'workflow-empty',
        stage: 'review',
        status: 'answered',
        response: { decision: 'approve', feedback: '', answer: '' },
        answered_at: new Date(),
        created_at: new Date(),
      },
      {
        intervention_id: 'INT-hf-no-response',
        workflow_run_id: 'wfr-hf-no-response',
        workflow_name: 'workflow-no-resp',
        stage: 'review',
        status: 'answered',
        response: { decision: 'approve' },  // no feedback or answer field
        answered_at: new Date(),
        created_at: new Date(),
      },
    ]);
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'human_feedback', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });

    const results = await scheduler.discoverPending('human_feedback', 20);
    expect(results.find((r) => r.sourceId === 'INT-hf-empty-fb')).toBeUndefined();
    expect(results.find((r) => r.sourceId === 'INT-hf-no-response')).toBeUndefined();
  });

  it('dedupes when active context_judge_runs.sourceKey exists', async () => {
    const past = new Date(0);
    await db.collection('workflow_interventions').insertOne({
      intervention_id: 'INT-hf-sk-1',
      workflow_run_id: 'wfr-hf-sk-1',
      workflow_name: 'workflow-sk',
      stage: 'review',
      status: 'answered',
      response: { decision: 'approve', feedback: 'Approved' },
      answered_at: new Date(),
      created_at: new Date(),
    });
    // Active judge run with the new sourceKey format
    await db.collection('context_judge_runs').insertOne({
      judgeRunId: 'run-hf-sk-1',
      sourceKey: 'human_feedback:intervention:INT-hf-sk-1',
      active: true,
      status: 'completed',
    });
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'human_feedback', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });

    const results = await scheduler.discoverPending('human_feedback', 20);
    expect(results.find((r) => r.sourceId === 'INT-hf-sk-1')).toBeUndefined();
  });

  it('includes intervention when inactive judge run exists (active:false)', async () => {
    const past = new Date(0);
    await db.collection('workflow_interventions').insertOne({
      intervention_id: 'INT-hf-inactive-1',
      workflow_run_id: 'wfr-hf-inactive-1',
      workflow_name: 'workflow-inactive',
      stage: 'review',
      status: 'answered',
      response: { decision: 'approve', feedback: 'OK' },
      answered_at: new Date(),
      created_at: new Date(),
    });
    await db.collection('context_judge_runs').insertOne({
      judgeRunId: 'run-hf-inactive-1',
      sourceKey: 'human_feedback:intervention:INT-hf-inactive-1',
      active: false,  // inactive — should NOT block discovery
      status: 'completed',
    });
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'human_feedback', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });

    const results = await scheduler.discoverPending('human_feedback', 20);
    expect(results.find((r) => r.sourceId === 'INT-hf-inactive-1')).toBeDefined();
  });

  it('respects limit parameter', async () => {
    const past = new Date(0);
    const interventions = Array.from({ length: 5 }, (_, i) => ({
      intervention_id: `INT-hf-limit-${i}`,
      workflow_run_id: `wfr-hf-limit-${i}`,
      workflow_name: 'workflow-limit',
      stage: 'review',
      status: 'answered',
      response: { decision: 'approve', feedback: `feedback ${i}` },
      answered_at: new Date(Date.now() + i * 1000),
      created_at: new Date(),
    }));
    await db.collection('workflow_interventions').insertMany(interventions);
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'human_feedback', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });

    const results = await scheduler.discoverPending('human_feedback', 3);
    expect(results.length).toBe(3);
    // All returned items should be human_feedback kind
    expect(results.every((r) => r.sourceKind === 'human_feedback')).toBe(true);
  });

  it('respects cursor: skips interventions answered before cursor date', async () => {
    const cutoff = new Date(Date.now() - 5000);
    const beforeCutoff = new Date(Date.now() - 10000);
    const afterCutoff = new Date();

    await db.collection('workflow_interventions').insertMany([
      {
        intervention_id: 'INT-hf-old-1',
        workflow_run_id: 'wfr-hf-old-1',
        workflow_name: 'workflow-old',
        stage: 'review',
        status: 'answered',
        response: { decision: 'approve', feedback: 'Old feedback' },
        answered_at: beforeCutoff,
        created_at: beforeCutoff,
      },
      {
        intervention_id: 'INT-hf-new-1',
        workflow_run_id: 'wfr-hf-new-1',
        workflow_name: 'workflow-new',
        stage: 'review',
        status: 'answered',
        response: { decision: 'approve', feedback: 'New feedback' },
        answered_at: afterCutoff,
        created_at: afterCutoff,
      },
    ]);
    // Set cursor to cutoff — only interventions answered AFTER cutoff should appear
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'human_feedback', status: 'idle', cursor: cutoff.toISOString(), updatedAt: new Date(),
    });

    const results = await scheduler.discoverPending('human_feedback', 20);
    expect(results.find((r) => r.sourceId === 'INT-hf-old-1')).toBeUndefined();
    expect(results.find((r) => r.sourceId === 'INT-hf-new-1')).toBeDefined();
  });

  it('repo filter includes only safely resolved matching repo feedback', async () => {
    const past = new Date(0);
    await db.collection('workflow_interventions').insertMany([
      {
        intervention_id: 'INT-hf-repo-a',
        workflow_run_id: 'wfr-hf-repo-a',
        workflow_name: 'workflow-a',
        stage: 'review',
        status: 'answered',
        response: { decision: 'approve', feedback: 'Approved for repo-a' },
        answered_at: new Date(),
        created_at: new Date(),
      },
      {
        intervention_id: 'INT-hf-repo-b',
        workflow_run_id: 'wfr-hf-repo-b',
        workflow_name: 'workflow-b',
        stage: 'review',
        status: 'answered',
        response: { decision: 'approve', feedback: 'Approved for repo-b' },
        answered_at: new Date(),
        created_at: new Date(),
      },
    ]);
    // Link only wfr-hf-repo-a to repo-alpha via context_attempts
    await db.collection('context_attempts').insertOne({
      contextAttemptId: 'ca-repo-a-hf', executionId: 'wfr-hf-repo-a', repoId: 'repo-alpha',
      executionKind: 'workflow_node', status: 'ready',
      contextInjection: { injectedCount: 1, consideredCount: 2 }, createdAt: new Date(),
    });
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'human_feedback', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });

    const results = await scheduler.discoverPending('human_feedback', 20, { repoId: 'repo-alpha' });
    expect(results.length).toBe(1);
    expect(results[0].sourceId).toBe('INT-hf-repo-a');
    expect(results[0].repoId).toBe('repo-alpha');
  });

  it('repo filter excludes unresolved candidates when repo filter is present', async () => {
    const past = new Date(0);
    await db.collection('workflow_interventions').insertOne({
      intervention_id: 'INT-hf-unresolved',
      workflow_run_id: 'wfr-hf-unresolved',
      workflow_name: 'workflow-unresolved',
      stage: 'review',
      status: 'answered',
      response: { decision: 'approve', feedback: 'Feedback present' },
      answered_at: new Date(),
      created_at: new Date(),
    });
    // No context_attempts entry for wfr-hf-unresolved — repoId cannot be resolved
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'human_feedback', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });

    // With a repo filter: unresolvable candidates must be excluded
    const results = await scheduler.discoverPending('human_feedback', 20, { repoId: 'repo-any' });
    expect(results.find((r) => r.sourceId === 'INT-hf-unresolved')).toBeUndefined();
  });

  it('includes unresolved repoId candidates when no repo filter is present', async () => {
    const past = new Date(0);
    await db.collection('workflow_interventions').insertOne({
      intervention_id: 'INT-hf-no-repo',
      workflow_run_id: 'wfr-hf-no-repo',
      workflow_name: 'workflow-no-repo',
      stage: 'review',
      status: 'answered',
      response: { decision: 'approve', feedback: 'Feedback for no-repo' },
      answered_at: new Date(),
      created_at: new Date(),
    });
    // No context_attempts entry — repoId unresolvable
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'human_feedback', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });

    // Without a repo filter: should still be included (repoId will be undefined)
    const results = await scheduler.discoverPending('human_feedback', 20);
    const found = results.find((r) => r.sourceId === 'INT-hf-no-repo');
    expect(found).toBeDefined();
    expect(found?.repoId).toBeUndefined();
  });

  it('does not use executions.feedbackEntries[] for human_feedback discovery', async () => {
    const past = new Date(0);
    // Seed executions with feedbackEntries — these must NOT appear in results
    await db.collection('executions').insertOne({
      id: 'exec-with-feedback',
      workflowName: 'workflow-fe',
      status: 'completed',
      feedbackEntries: [
        { id: 'fe-1', feedback: 'Great run', answeredAt: new Date() },
      ],
    });
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'human_feedback', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });

    const results = await scheduler.discoverPending('human_feedback', 20);
    // No workflow_interventions seeded — results must be empty
    expect(results.length).toBe(0);
    // Execution feedbackEntries are never used
    expect(results.find((r) => r.sourceId === 'fe-1')).toBeUndefined();
    expect(results.find((r) => r.sourceId === 'exec-with-feedback')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('deduplication: chat_learning', () => {
  it('skips source when active judge run exists', async () => {
    const past = new Date(0);
    await db.collection('learnings').insertOne({
      learningId: 'learn-dedup-1', repoId: 'repo-i', contextEligibility: 'eligible', createdAt: new Date(),
    });
    await db.collection('context_judge_runs').insertOne({
      judgeRunId: 'run-learn-dedup-1', sourceId: 'learn-dedup-1', sourceKey: 'chat_learning:learn-dedup-1', active: true, status: 'completed',
    });
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'chat_learning', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });

    const results = await scheduler.discoverPending('chat_learning', 20);
    expect(results.find((r) => r.sourceId === 'learn-dedup-1')).toBeUndefined();
  });
});

describe('deduplication: stale_finding', () => {
  it('skips source when active judge run exists for findingId', async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await db.collection('context_findings').insertOne({
      findingId: 'stale-dedup-1', repoId: 'repo-j', status: 'open', active: true, updatedAt: eightDaysAgo,
    });
    await db.collection('context_judge_runs').insertOne({
      judgeRunId: 'run-stale-dedup-1', sourceId: 'stale-dedup-1', sourceKey: 'stale_finding:stale-dedup-1', active: true, status: 'completed',
    });
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'stale_finding', status: 'idle', updatedAt: new Date(),
    });

    const results = await scheduler.discoverPending('stale_finding', 20);
    expect(results.find((r) => r.sourceId === 'stale-dedup-1')).toBeUndefined();
  });

  it('includes stale finding when no active judge run exists', async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await db.collection('context_findings').insertOne({
      findingId: 'stale-new-1', repoId: 'repo-j', status: 'open', active: true, updatedAt: eightDaysAgo,
    });
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'stale_finding', status: 'idle', updatedAt: new Date(),
    });

    const results = await scheduler.discoverPending('stale_finding', 20);
    expect(results.find((r) => r.sourceId === 'stale-new-1')).toBeDefined();
  });
});

// ─── Cursor lifecycle ─────────────────────────────────────────────────────────

describe('cursor lifecycle', () => {
  it('markRunning sets status to "running"', async () => {
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'workflow_run', status: 'idle', updatedAt: new Date(),
    });

    await scheduler.markRunning('workflow_run');

    const state = await db
      .collection('context_judge_scheduler_state')
      .findOne({ sourceType: 'workflow_run' });
    expect(state?.['status']).toBe('running');
    expect(state?.['lastRunAt']).toBeInstanceOf(Date);
  });

  it('markIdle sets status to "idle" and updates cursor', async () => {
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'workflow_run', status: 'running', updatedAt: new Date(),
    });

    const cursorVal = new Date().toISOString();
    await scheduler.markIdle('workflow_run', cursorVal);

    const state = await db
      .collection('context_judge_scheduler_state')
      .findOne({ sourceType: 'workflow_run' });
    expect(state?.['status']).toBe('idle');
    expect(state?.['cursor']).toBe(cursorVal);
  });

  it('markError sets status to "error" and stores errorMessage', async () => {
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'workflow_run', status: 'running', updatedAt: new Date(),
    });

    await scheduler.markError('workflow_run', 'boom');

    const state = await db
      .collection('context_judge_scheduler_state')
      .findOne({ sourceType: 'workflow_run' });
    expect(state?.['status']).toBe('error');
    expect(state?.['errorMessage']).toBe('boom');
  });

  it('advanceCursor sets status to "idle" and updates cursor to a non-empty ISO timestamp', async () => {
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'workflow_run', status: 'running', updatedAt: new Date(),
    });

    await scheduler.advanceCursor('workflow_run');

    const state = await db
      .collection('context_judge_scheduler_state')
      .findOne({ sourceType: 'workflow_run' });
    expect(state?.['status']).toBe('idle');
    expect(typeof state?.['cursor']).toBe('string');
    expect(state?.['cursor']).not.toBe('');
    // Verify it's a valid ISO timestamp
    expect(new Date(state?.['cursor'] as string).getTime()).toBeGreaterThan(0);
  });
});

// ─── chat_turn repo filter ─────────────────────────────────────────────────────

describe('discoverPending chat_turn with repoFilter', () => {
  it('returns empty when no context_attempts match the repoId', async () => {
    const past = new Date(0);
    await db.collection('chat_sessions').insertOne({
      sessionId: 'sess-repo-none', updatedAt: new Date(),
    });
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'chat_turn', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });

    // No context_attempts entries → should return empty
    const results = await scheduler.discoverPending('chat_turn', 20, { repoId: 'repo-no-match' });
    expect(results.length).toBe(0);
  });

  it('returns only sessions associated with the repoId via context_attempts', async () => {
    const past = new Date(0);
    await db.collection('chat_sessions').insertMany([
      { sessionId: 'sess-with-repo', updatedAt: new Date() },
      { sessionId: 'sess-without-repo', updatedAt: new Date() },
    ]);
    // Link sess-with-repo to repo-ca-1 via context_attempts
    await db.collection('context_attempts').insertOne({
      executionId: 'sess-with-repo',
      repoId: 'repo-ca-1',
    });
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'chat_turn', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });

    const results = await scheduler.discoverPending('chat_turn', 20, { repoId: 'repo-ca-1' });
    expect(results.length).toBe(1);
    expect(results[0].sourceId).toBe('sess-with-repo');
  });

  it('returns sessions for all matching repos when repoIds filter provided', async () => {
    const past = new Date(0);
    await db.collection('chat_sessions').insertMany([
      { sessionId: 'sess-repo-x', updatedAt: new Date() },
      { sessionId: 'sess-repo-y', updatedAt: new Date() },
      { sessionId: 'sess-repo-z', updatedAt: new Date() },
    ]);
    await db.collection('context_attempts').insertMany([
      { executionId: 'sess-repo-x', repoId: 'repo-x' },
      { executionId: 'sess-repo-y', repoId: 'repo-y' },
      { executionId: 'sess-repo-z', repoId: 'repo-z' },
    ]);
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'chat_turn', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });

    const results = await scheduler.discoverPending('chat_turn', 20, { repoIds: ['repo-x', 'repo-y'] });
    const ids = results.map((r) => r.sourceId);
    expect(ids).toContain('sess-repo-x');
    expect(ids).toContain('sess-repo-y');
    expect(ids).not.toContain('sess-repo-z');
  });
});

// ─── sourceKey-based deduplication ───────────────────────────────────────────

describe('sourceKey cross-source collision prevention', () => {
  it('same sourceId in two different sourceKinds are treated as different entries', async () => {
    const sharedSourceId = 'shared-id-001';
    const past = new Date(0);

    // Insert both a workflow_node and a spawned_agent attempt with the SAME executionId (sharedSourceId)
    await db.collection('context_attempts').insertOne({
      contextAttemptId: 'ca-wf-shared', executionId: sharedSourceId, repoId: 'repo-shared',
      executionKind: 'workflow_node', status: 'ready',
      contextInjection: { injectedCount: 1, consideredCount: 2 }, createdAt: new Date(Date.now() - 1000),
    });
    await db.collection('context_attempts').insertOne({
      contextAttemptId: 'ca-agent-shared', executionId: sharedSourceId, repoId: 'repo-shared',
      executionKind: 'spawned_agent', status: 'ready',
      contextInjection: { injectedCount: 1, consideredCount: 2 }, createdAt: new Date(),
    });

    // Mark the workflow_run sourceKey as having an active judge run
    await db.collection('context_judge_runs').insertOne({
      judgeRunId: 'run-wf-shared', sourceKey: `workflow_run:${sharedSourceId}`, active: true, status: 'completed',
    });

    await db.collection('context_judge_scheduler_state').insertMany([
      { sourceType: 'workflow_run', status: 'idle', cursor: past.toISOString(), updatedAt: new Date() },
      { sourceType: 'spawned_agent_run', status: 'idle', cursor: past.toISOString(), updatedAt: new Date() },
    ]);

    // workflow_run should be DEDUPED (has active judge run with matching sourceKey)
    const wfResults = await scheduler.discoverPending('workflow_run', 20);
    expect(wfResults.find((r) => r.sourceId === sharedSourceId)).toBeUndefined();

    // spawned_agent_run should NOT be deduped (different sourceKey: spawned_agent_run:shared-id-001)
    const agentResults = await scheduler.discoverPending('spawned_agent_run', 20);
    expect(agentResults.find((r) => r.sourceId === sharedSourceId)).toBeDefined();
  });

  it('deduplication uses sourceKey not sourceId alone', async () => {
    const past = new Date(0);
    await db.collection('context_attempts').insertOne({
      contextAttemptId: 'ca-wf-sk-001', executionId: 'wf-sk-001', repoId: 'repo-sk',
      executionKind: 'workflow_node', status: 'ready',
      contextInjection: { injectedCount: 1, consideredCount: 2 }, createdAt: new Date(),
    });

    // Insert a judge run with only sourceId (old format) — should NOT block the new sourceKey-based check
    await db.collection('context_judge_runs').insertOne({
      judgeRunId: 'run-old-format', sourceId: 'wf-sk-001', active: true, status: 'completed',
      // Note: sourceKey is NOT set on this old record
    });

    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'workflow_run', status: 'idle', cursor: past.toISOString(), updatedAt: new Date(),
    });

    // Should be included because the sourceKey `workflow_run:wf-sk-001` is not in the db
    const results = await scheduler.discoverPending('workflow_run', 20);
    expect(results.find((r) => r.sourceId === 'wf-sk-001')).toBeDefined();
  });
});

// ─── context_usage_trace discovers from context_attempts ─────────────────────
