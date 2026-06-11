// Tests for ContextRemediationTaskService — create, dispatch, complete, fail
// Uses MongoMemoryServer for in-memory MongoDB isolation.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ContextRemediationTaskService } from '../../../services/context/judge/context-remediation-task.service.js';

let mongo: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let service: ContextRemediationTaskService;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = new MongoClient(mongo.getUri());
  await client.connect();
  db = client.db('test-remediation');
  service = new ContextRemediationTaskService(db);
});

afterAll(async () => {
  await client.close();
  await mongo.stop();
});

beforeEach(async () => {
  await db.collection('context_remediations').deleteMany({});
  await db.collection('context_review_worker_assignments').deleteMany({});
});

const baseInput = {
  taskId: 'task-001',
  findingId: 'finding-001',
  judgeRunId: 'run-001',
  actionKind: 'curated_entry_edit' as const,
};

// ─── create ──────────────────────────────────────────────────────────────────

describe('create', () => {
  it('returns a Remediation with a UUID remediationId', async () => {
    const rem = await service.create(baseInput);
    expect(rem.remediationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('initial status is "pending"', async () => {
    const rem = await service.create(baseInput);
    expect(rem.status).toBe('pending');
  });

  it('all input fields are reflected in the returned remediation', async () => {
    const rem = await service.create(baseInput);
    expect(rem.taskId).toBe('task-001');
    expect(rem.findingId).toBe('finding-001');
    expect(rem.judgeRunId).toBe('run-001');
    expect(rem.actionKind).toBe('curated_entry_edit');
  });

  it('stores structured memory remediation proposal fields', async () => {
    const rem = await service.create({
      ...baseInput,
      remediationKind: 'curation_metadata_update',
      workerRole: 'context_curation_fix',
      targetEntryIds: ['entry-1'],
      targetRefIds: ['cognee:bad-ref'],
      targetMappingIds: ['mandatory-1'],
      targetRepoId: 'repo-1',
      proposedPatch: {
        injectionPolicy: 'manifest_only',
        negativeTaskHints: ['backend context-quality'],
      },
      retrievalReplayId: 'captured:ca-1',
      validationPlan: 'Replay failing trace and rejudge nearby traces.',
      estimatedRisk: 'low',
      humanGateRequired: false,
    });

    expect(rem.remediationKind).toBe('curation_metadata_update');
    expect(rem.targetEntryIds).toEqual(['entry-1']);
    expect(rem.targetRefIds).toEqual(['cognee:bad-ref']);
    expect(rem.targetMappingIds).toEqual(['mandatory-1']);
    expect(rem.proposedPatch).toEqual({
      injectionPolicy: 'manifest_only',
      negativeTaskHints: ['backend context-quality'],
    });
    expect(rem.retrievalReplayId).toBe('captured:ca-1');
    expect(rem.validationPlan).toContain('Replay failing trace');
  });

  it('normalizes legacy worker roles and applies 0.65 confidence gate', async () => {
    const rem = await service.create({
      ...baseInput,
      workerRole: 'curation_fix',
      confidence: 0.6,
      estimatedRisk: 'low',
    });

    expect(rem.workerRole).toBe('context_curation_fix');
    expect(rem.confidence).toBe(0.6);
    expect(rem.humanGateRequired).toBe(true);
  });

  it('allows high-confidence non-code curation remediation without human gate', async () => {
    const rem = await service.create({
      ...baseInput,
      workerRole: 'context_curation_fix',
      confidence: 0.65,
      estimatedRisk: 'low',
    });

    expect(rem.humanGateRequired).toBe(false);
  });

  it('timestamps are set on creation', async () => {
    const rem = await service.create(baseInput);
    expect(rem.createdAt).toBeInstanceOf(Date);
    expect(rem.updatedAt).toBeInstanceOf(Date);
  });

  it('is retrievable by get()', async () => {
    const rem = await service.create(baseInput);
    const fetched = await service.get(rem.remediationId);
    expect(fetched).not.toBeNull();
    expect(fetched!.remediationId).toBe(rem.remediationId);
  });
});

// ─── dispatch ────────────────────────────────────────────────────────────────

describe('dispatch', () => {
  it('sets status to "dispatched"', async () => {
    const rem = await service.create(baseInput);
    const result = await service.dispatch(rem.remediationId);
    expect(result).toBe(true);

    const fetched = await service.get(rem.remediationId);
    expect(fetched!.status).toBe('dispatched');
  });

  it('sets dispatchedAt to a Date', async () => {
    const rem = await service.create(baseInput);
    await service.dispatch(rem.remediationId);

    const fetched = await service.get(rem.remediationId);
    expect(fetched!.dispatchedAt).toBeInstanceOf(Date);
  });

  it('returns false for unknown remediationId', async () => {
    const result = await service.dispatch('00000000-0000-0000-0000-000000000000');
    expect(result).toBe(false);
  });

  // AC-19 gate: code_change_pr must never be dispatched
  it('dispatch with actionKind="code_change_pr" → status="failed" (AC-19 gate)', async () => {
    const rem = await service.create({
      ...baseInput,
      actionKind: 'code_change_pr',
    });
    const result = await service.dispatch(rem.remediationId);
    // dispatch returns true (the update succeeded — it set status to failed)
    expect(result).toBe(true);

    const fetched = await service.get(rem.remediationId);
    expect(fetched!.status).toBe('failed');
    expect(fetched!.error).toContain('code_change_pr_requires_human_routing');
  });
});

// ─── complete ────────────────────────────────────────────────────────────────

describe('complete', () => {
  it('sets status to "completed" with result', async () => {
    const rem = await service.create(baseInput);
    const result = await service.complete(rem.remediationId, { applied: true, entryId: 'entry-123' });
    expect(result).toBe(true);

    const fetched = await service.get(rem.remediationId);
    expect(fetched!.status).toBe('completed');
    expect(fetched!.result).toEqual({ applied: true, entryId: 'entry-123' });
  });

  it('sets completedAt to a Date', async () => {
    const rem = await service.create(baseInput);
    await service.complete(rem.remediationId, {});

    const fetched = await service.get(rem.remediationId);
    expect(fetched!.completedAt).toBeInstanceOf(Date);
  });

  it('returns false for unknown remediationId', async () => {
    const result = await service.complete('00000000-0000-0000-0000-000000000000', {});
    expect(result).toBe(false);
  });
});

// ─── fail ─────────────────────────────────────────────────────────────────────

describe('fail', () => {
  it('sets status to "failed" with error message', async () => {
    const rem = await service.create(baseInput);
    const result = await service.fail(rem.remediationId, 'Something went wrong');
    expect(result).toBe(true);

    const fetched = await service.get(rem.remediationId);
    expect(fetched!.status).toBe('failed');
    expect(fetched!.error).toBe('Something went wrong');
  });

  it('returns false for unknown remediationId', async () => {
    const result = await service.fail('00000000-0000-0000-0000-000000000000', 'error');
    expect(result).toBe(false);
  });
});

// ─── list ────────────────────────────────────────────────────────────────────

describe('list', () => {
  it('list by taskId returns only matching remediations', async () => {
    await service.create({ ...baseInput, taskId: 'task-A' });
    await service.create({ ...baseInput, taskId: 'task-B' });

    const results = await service.list({ taskId: 'task-A' });
    expect(results.every((r) => r.taskId === 'task-A')).toBe(true);
  });

  it('list by status returns only matching remediations', async () => {
    const rem = await service.create(baseInput);
    await service.dispatch(rem.remediationId);

    const dispatched = await service.list({ status: 'dispatched' });
    expect(dispatched.some((r) => r.remediationId === rem.remediationId)).toBe(true);
  });

  it('reconciles stale dispatched remediations when linked assignments failed', async () => {
    const rem = await service.create({
      ...baseInput,
      workerRole: 'context_curation_fix',
      remediationKind: 'curation_metadata_update',
      proposedPatch: { metadataUpdates: { injectionPolicy: 'manifest_only' } },
    });
    await service.dispatch(rem.remediationId);
    await db.collection('context_review_worker_assignments').insertOne({
      assignmentId: 'assignment-failed',
      taskIds: [rem.remediationId],
      remediationIds: [rem.remediationId],
      workerRole: 'context_curation_fix',
      status: 'failed',
      notes: 'Editor API has no safe metadata-update write surface.',
      result: { editsApplied: [] },
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: new Date(),
    });

    const dispatched = await service.list({ status: 'dispatched', includeAssignments: true });
    expect(dispatched.some((item) => item.remediationId === rem.remediationId)).toBe(false);

    const fetched = await service.get(rem.remediationId);
    expect(fetched?.status).toBe('failed');
    expect(fetched?.error).toContain('metadata-update');
  });

  it('reconciles failed remediation with applied revisions out of failed status', async () => {
    const rem = await service.create({
      ...baseInput,
      workerRole: 'context_curation_fix',
      remediationKind: 'curation_metadata_update',
    });
    await db.collection('context_remediations').updateOne(
      { remediationId: rem.remediationId },
      {
        $set: {
          status: 'failed',
          error: 'old failure',
          appliedRevisionIds: ['revision-repaired-1'],
        },
      },
    );

    await service.reconcileStaleDispatched();

    const fetched = await service.get(rem.remediationId);
    expect(fetched?.status).toBe('completed');
    expect(fetched?.error).toBeUndefined();
    expect((fetched as any).appliedRevisionIds).toEqual(['revision-repaired-1']);
  });

  it('records applied revision and clears stale failure state while keeping remediation active', async () => {
    const rem = await service.create({
      ...baseInput,
      workerRole: 'context_curation_fix',
      remediationKind: 'curation_metadata_update',
    });
    await service.fail(rem.remediationId, 'old failure');

    const updated = await service.recordAppliedRevision({
      remediationId: rem.remediationId,
      revisionId: 'revision-1',
      entryVersionId: 'entry-version-1',
    });

    expect(updated).toBe(true);
    const fetched = await service.get(rem.remediationId);
    expect(fetched?.status).toBe('running');
    expect(fetched?.error).toBeUndefined();
    expect((fetched as any).appliedRevisionIds).toEqual(['revision-1']);
    expect((fetched as any).lastAppliedEntryVersionId).toBe('entry-version-1');
  });
});
