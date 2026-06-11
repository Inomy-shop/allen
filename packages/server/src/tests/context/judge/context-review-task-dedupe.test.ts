// Tests for ContextReviewService clusterKey deduplication (CHANGE 4)
// Uses MongoMemoryServer for in-memory MongoDB isolation.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ContextReviewService } from '../../../services/context/judge/context-review.service.js';
import type { Finding, ContextJudgeConfig } from '../../../services/context/judge/context-judge.types.js';

let mongo: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let service: ContextReviewService;

const mockConfig: ContextJudgeConfig = {
  configId: 'singleton',
  autoRemediationEnabled: true,
  autoRemediationThresholds: {
    minConfidence: 0.85,
    maxRisk: 'low',
    allowedFixTypes: ['curated_context_edit', 'curated_context_create', 'no_action'],
  },
  mandatoryHumanReview: {
    lowConfidenceThreshold: 0.5,
    highRiskLevels: ['high', 'critical'],
    alwaysForScopes: ['cross_repo', 'global'],
    alwaysForLearningDerived: true,
    alwaysForCodeFix: true,
  },
  updatedAt: new Date(),
};

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  const now = new Date();
  return {
    findingId: `finding-${Math.random().toString(36).slice(2)}`,
    judgeRunId: 'run-test-dedupe',
    scope: 'workflow',
    classification: 'missing_context',
    fixType: 'curated_context_create',
    severity: 'warn',
    risk: 'low',
    confidence: 0.9,
    reliabilityLabel: 'confirmed',
    evidence: [],
    status: 'open',
    active: true,
    version: 1,
    validFrom: now,
    createdAt: now,
    updatedAt: now,
    repoId: 'repo-dedupe-1',
    ...overrides,
  };
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = new MongoClient(mongo.getUri());
  await client.connect();
  db = client.db('test-review-dedupe');
  service = new ContextReviewService(db);
});

afterAll(async () => {
  await client.close();
  await mongo.stop();
});

beforeEach(async () => {
  await db.collection('context_review_tasks').deleteMany({});
  await db.collection('context_review_decisions').deleteMany({});
});

// ─── clusterKey deduplication ─────────────────────────────────────────────────

describe('clusterKey deduplication', () => {
  it('first finding creates a task with clusterKey set', async () => {
    const finding = makeFinding({ findingId: 'f-dedupe-1' });
    const task = await service.createFromFinding(finding, mockConfig);

    expect(task.clusterKey).toBe(`${finding.classification}:${finding.fixType}:${finding.scope}:${finding.repoId}`);
    expect(task.attachedFindingIds).toEqual([]);
  });

  it('second finding with same fixType+scope+repoId attaches to existing task, not create new', async () => {
    const f1 = makeFinding({ findingId: 'f-cluster-1', repoId: 'repo-cluster-a' });
    const f2 = makeFinding({ findingId: 'f-cluster-2', repoId: 'repo-cluster-a' });

    const task1 = await service.createFromFinding(f1, mockConfig);
    const task2 = await service.createFromFinding(f2, mockConfig);

    // Should return the existing task (same taskId)
    expect(task2.taskId).toBe(task1.taskId);

    // Only one task should exist in DB
    const count = await db.collection('context_review_tasks').countDocuments({});
    expect(count).toBe(1);

    // The existing task should have f2's findingId in attachedFindingIds
    const stored = await db.collection('context_review_tasks').findOne({ taskId: task1.taskId });
    expect((stored as any).attachedFindingIds).toContain('f-cluster-2');
  });

  it('third finding with DIFFERENT fixType creates a new task', async () => {
    const f1 = makeFinding({ findingId: 'f-diff-1', fixType: 'curated_context_create', repoId: 'repo-diff' });
    const f2 = makeFinding({ findingId: 'f-diff-2', fixType: 'ingestion_fix', repoId: 'repo-diff' });

    const task1 = await service.createFromFinding(f1, mockConfig);
    const task2 = await service.createFromFinding(f2, mockConfig);

    expect(task2.taskId).not.toBe(task1.taskId);

    const count = await db.collection('context_review_tasks').countDocuments({});
    expect(count).toBe(2);
  });

  it('task with parentTaskId set is NOT matched (only top-level tasks cluster)', async () => {
    // Insert a task with parentTaskId that otherwise has a matching clusterKey
    const clusterKey = 'missing_context:curated_context_create:workflow:repo-parent-test';
    await db.collection('context_review_tasks').insertOne({
      taskId: 'task-with-parent',
      findingId: 'f-parent-existing',
      judgeRunId: 'run-x',
      scope: 'workflow',
      repoId: 'repo-parent-test',
      fixType: 'curated_context_create',
      risk: 'low',
      severity: 'warn',
      confidence: 0.9,
      reliabilityLabel: 'confirmed',
      status: 'pending',
      queue: 'open',
      requiresHumanReview: false,
      clusterKey,
      parentTaskId: 'parent-task-id-123',  // has parentTaskId → should NOT be matched
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const finding = makeFinding({ findingId: 'f-parent-new', repoId: 'repo-parent-test', fixType: 'curated_context_create' });
    const newTask = await service.createFromFinding(finding, mockConfig);

    // Should NOT match the child task — should create a new top-level task
    expect(newTask.taskId).not.toBe('task-with-parent');
    expect(newTask.parentTaskId).toBeUndefined();
  });

  it('completed task (status="done") is NOT matched — new task created', async () => {
    const f1 = makeFinding({ findingId: 'f-done-1', repoId: 'repo-done' });
    const task1 = await service.createFromFinding(f1, mockConfig);

    // Mark task as done
    await db.collection('context_review_tasks').updateOne(
      { taskId: task1.taskId },
      { $set: { status: 'done' } },
    );

    // Second finding with same cluster
    const f2 = makeFinding({ findingId: 'f-done-2', repoId: 'repo-done' });
    const task2 = await service.createFromFinding(f2, mockConfig);

    // Should create a NEW task since existing one is 'done'
    expect(task2.taskId).not.toBe(task1.taskId);
    const count = await db.collection('context_review_tasks').countDocuments({});
    expect(count).toBe(2);
  });

  it('two findings with SAME fixType+scope+repoId but DIFFERENT classification create SEPARATE tasks', async () => {
    const f1 = makeFinding({
      findingId: 'f-class-1',
      repoId: 'repo-class-test',
      fixType: 'curated_context_create',
      classification: 'missing_context',
    });
    const f2 = makeFinding({
      findingId: 'f-class-2',
      repoId: 'repo-class-test',
      fixType: 'curated_context_create',
      classification: 'stale_context',
    });

    const task1 = await service.createFromFinding(f1, mockConfig);
    const task2 = await service.createFromFinding(f2, mockConfig);

    // Different classification → different clusterKey → two separate tasks
    expect(task2.taskId).not.toBe(task1.taskId);
    expect(task1.clusterKey).toBe(`missing_context:curated_context_create:workflow:repo-class-test`);
    expect(task2.clusterKey).toBe(`stale_context:curated_context_create:workflow:repo-class-test`);

    const count = await db.collection('context_review_tasks').countDocuments({});
    expect(count).toBe(2);
  });

  it('attachedFindingIds uses $addToSet — no duplicates on repeated call', async () => {
    const f1 = makeFinding({ findingId: 'f-addToSet-1', repoId: 'repo-addToSet' });
    const f2 = makeFinding({ findingId: 'f-addToSet-2', repoId: 'repo-addToSet' });

    const task1 = await service.createFromFinding(f1, mockConfig);
    await service.createFromFinding(f2, mockConfig);
    // Call again with f2 — should not duplicate
    await service.createFromFinding(f2, mockConfig);

    const stored = await db.collection('context_review_tasks').findOne({ taskId: task1.taskId });
    const attached = (stored as any).attachedFindingIds as string[];
    const uniqueCount = new Set(attached).size;
    expect(uniqueCount).toBe(attached.length); // no duplicates
  });
});
