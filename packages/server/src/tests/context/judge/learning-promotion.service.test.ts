// Tests for LearningPromotionService — create, decide, execute
// Uses MongoMemoryServer for in-memory MongoDB isolation.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { LearningPromotionService } from '../../../services/context/judge/learning-promotion.service.js';
import { CuratedContextEditorService } from '../../../services/context/judge/curated-context-editor.service.js';

let mongo: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let service: LearningPromotionService;
let editor: CuratedContextEditorService;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = new MongoClient(mongo.getUri());
  await client.connect();
  db = client.db('test-learning-promotion');
  service = new LearningPromotionService(db);
  editor = new CuratedContextEditorService(db);
});

afterAll(async () => {
  await client.close();
  await mongo.stop();
});

beforeEach(async () => {
  await db.collection('context_learning_promotions').deleteMany({});
  await db.collection('repo_context_curation_entries').deleteMany({});
  await db.collection('repo_context_curation_entry_revisions').deleteMany({});
});

// ─── create ───────────────────────────────────────────────────────────────────

describe('create', () => {
  it('returns a promotion with status="pending"', async () => {
    const promotion = await service.create({
      learningId: 'learn-001',
      action: 'create_curated_context',
    });
    expect(promotion.status).toBe('pending');
  });

  it('returns a promotion with a UUID promotionId', async () => {
    const promotion = await service.create({
      learningId: 'learn-002',
      action: 'create_curated_context',
    });
    expect(promotion.promotionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('stores all input fields', async () => {
    const promotion = await service.create({
      learningId: 'learn-003',
      reviewTaskId: 'task-xyz',
      action: 'remediate_curated_context',
      targetRepoId: 'repo-abc',
      targetEntryId: 'entry-def',
      suggestedContent: 'Some content',
    });
    expect(promotion.learningId).toBe('learn-003');
    expect(promotion.reviewTaskId).toBe('task-xyz');
    expect(promotion.action).toBe('remediate_curated_context');
    expect(promotion.targetRepoId).toBe('repo-abc');
    expect(promotion.targetEntryId).toBe('entry-def');
    expect(promotion.suggestedContent).toBe('Some content');
  });

  it('auto-approves high-confidence validated promotions and creates curation-fix remediation', async () => {
    const promotion = await service.create({
      learningId: 'learn-auto-1',
      sessionId: 'session-auto',
      rootExecutionId: 'root-auto',
      action: 'create_curated_context',
      targetRepoId: 'repo-auto',
      confidence: 0.82,
      estimatedRisk: 'medium',
      humanGateRequired: true,
      sourceValidationStatus: 'validated',
      conflictStatus: 'no_conflict',
      suggestedContent: 'When fixing context judge learning flow, evaluate all learning batches before finalizing.',
      proposedPatch: {
        title: 'Context Judge Learning Exhaustiveness',
        path: 'manual/context-judge/learning-exhaustiveness.md',
        category: 'module_rule',
        injectionPolicy: 'snippet',
        retrievalText: 'context judge learning batch exhaustiveness cursor remediation',
      },
      scope: 'repo',
    });

    expect(promotion.status).toBe('approved');
    expect(promotion.decision).toBe('approved');
    expect(promotion.humanGateRequired).toBe(false);
    expect(promotion.remediationId).toBeTruthy();

    const remediation = await db.collection('context_remediations').findOne({ remediationId: promotion.remediationId });
    expect(remediation?.['workerRole']).toBe('context_curation_fix');
    expect(remediation?.['status']).toBe('pending');
    expect(remediation?.['humanGateRequired']).toBe(false);
    expect(remediation?.['sessionId']).toBe('session-auto');
    expect(remediation?.['rootExecutionId']).toBe('root-auto');
    expect(remediation?.['targetEntryIds']).toEqual(['manual/context-judge/learning-exhaustiveness.md']);
    expect(remediation?.['proposedPatch']).toMatchObject({
      curatedContext: 'When fixing context judge learning flow, evaluate all learning batches before finalizing.',
      retrievalText: 'context judge learning batch exhaustiveness cursor remediation',
    });
  });

  it('keeps low-confidence promotions human-gated without remediation', async () => {
    const promotion = await service.create({
      learningId: 'learn-review-1',
      action: 'create_curated_context',
      targetRepoId: 'repo-review',
      confidence: 0.64,
      estimatedRisk: 'low',
      sourceValidationStatus: 'validated',
      conflictStatus: 'no_conflict',
      suggestedContent: 'Low confidence draft',
    });

    expect(promotion.status).toBe('pending');
    expect(promotion.humanGateRequired).toBe(true);
    expect(promotion.remediationId).toBeUndefined();
    expect(await db.collection('context_remediations').countDocuments({ findingId: 'learn-review-1' })).toBe(0);
  });

  it('is retrievable by get()', async () => {
    const promotion = await service.create({ learningId: 'learn-004', action: 'create_curated_context' });
    const fetched = await service.get(promotion.promotionId);
    expect(fetched).not.toBeNull();
    expect(fetched!.promotionId).toBe(promotion.promotionId);
  });
});

// ─── decide ───────────────────────────────────────────────────────────────────

describe('decide', () => {
  it('decide("approved") sets decision and status="approved"', async () => {
    const promotion = await service.create({ learningId: 'learn-d1', action: 'create_curated_context' });
    const updated = await service.decide(promotion.promotionId, { actor: 'user-1', decision: 'approved' });
    expect(updated.decision).toBe('approved');
    expect(updated.status).toBe('approved');
    expect(updated.decidedBy).toBe('user-1');
    expect(updated.decidedAt).toBeInstanceOf(Date);
  });

  it('decide("rejected") sets decision and status="rejected"', async () => {
    const promotion = await service.create({ learningId: 'learn-d2', action: 'create_curated_context' });
    const updated = await service.decide(promotion.promotionId, { actor: 'user-1', decision: 'rejected' });
    expect(updated.decision).toBe('rejected');
    expect(updated.status).toBe('rejected');
  });

  it('decide("deferred") sets decision and status="deferred"', async () => {
    const promotion = await service.create({ learningId: 'learn-d3', action: 'create_curated_context' });
    const updated = await service.decide(promotion.promotionId, { actor: 'user-1', decision: 'deferred' });
    expect(updated.decision).toBe('deferred');
    expect(updated.status).toBe('deferred');
  });

  it('throws for unknown promotionId', async () => {
    await expect(
      service.decide('00000000-0000-0000-0000-000000000000', { actor: 'user', decision: 'approved' }),
    ).rejects.toThrow();
  });
});

// ─── execute ──────────────────────────────────────────────────────────────────

describe('execute', () => {
  it('create_curated_context after approval creates entry and sets status="executed"', async () => {
    const promotion = await service.create({
      learningId: 'learn-e1',
      action: 'create_curated_context',
      targetRepoId: 'repo-test',
      suggestedContent: 'New context content',
    });
    await service.decide(promotion.promotionId, { actor: 'admin', decision: 'approved' });
    const executed = await service.execute(promotion.promotionId, editor);
    expect(executed.status).toBe('executed');
    const entry = await editor.getEntry('repo-test', `learning:${promotion.promotionId}`);
    expect(entry?.['curatedContext']).toBe('New context content');
    expect(entry?.['retrievalText']).toBe('New context content');
  });

  it('remediate_curated_context after approval calls applyEdit and sets status="executed"', async () => {
    const targetRepoId = 'repo-remediate';
    const targetEntryId = 'entry-remediate';

    // Create the entry first
    await editor.applyEdit(targetRepoId, targetEntryId, { title: 'Original' }, { actor: 'system', source: 'manual_edit' });

    const promotion = await service.create({
      learningId: 'learn-e2',
      action: 'remediate_curated_context',
      targetRepoId,
      targetEntryId,
      suggestedContent: 'Remediated content',
    });
    await service.decide(promotion.promotionId, { actor: 'admin', decision: 'approved' });
    const executed = await service.execute(promotion.promotionId, editor);
    expect(executed.status).toBe('executed');

    // Verify the entry was updated
    const history = await editor.getHistory(targetRepoId, targetEntryId);
    expect(history.length).toBeGreaterThanOrEqual(2);
  });

  it('execute throws if not approved', async () => {
    const promotion = await service.create({ learningId: 'learn-e3', action: 'create_curated_context' });
    // Not approved yet
    await expect(service.execute(promotion.promotionId, editor)).rejects.toThrow();
  });

  it('execute throws if rejected', async () => {
    const promotion = await service.create({ learningId: 'learn-e4', action: 'create_curated_context' });
    await service.decide(promotion.promotionId, { actor: 'admin', decision: 'rejected' });
    await expect(service.execute(promotion.promotionId, editor)).rejects.toThrow();
  });
});

// ─── list ─────────────────────────────────────────────────────────────────────

describe('list', () => {
  it('list by learningId returns only matching promotions', async () => {
    await service.create({ learningId: 'learn-list-a', action: 'create_curated_context' });
    await service.create({ learningId: 'learn-list-b', action: 'create_curated_context' });

    const results = await service.list({ learningId: 'learn-list-a' });
    expect(results.every((p) => p.learningId === 'learn-list-a')).toBe(true);
  });

  it('list by status returns only matching promotions', async () => {
    const p1 = await service.create({ learningId: 'learn-s1', action: 'create_curated_context' });
    await service.decide(p1.promotionId, { actor: 'user', decision: 'approved' });
    await service.create({ learningId: 'learn-s2', action: 'create_curated_context' });

    const approved = await service.list({ status: 'approved' });
    expect(approved.every((p) => p.status === 'approved')).toBe(true);
    expect(approved.some((p) => p.promotionId === p1.promotionId)).toBe(true);
  });
});
