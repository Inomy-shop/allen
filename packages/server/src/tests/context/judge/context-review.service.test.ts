// Tests for ContextReviewService — AC-18 gate, queue management, decisions
// Uses MongoMemoryServer for in-memory MongoDB isolation.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ContextReviewService } from '../../../services/context/judge/context-review.service.js';
import type { Finding } from '../../../services/context/judge/context-judge.types.js';
import type { ContextJudgeConfig } from '../../../services/context/judge/context-judge.types.js';

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
    findingId: 'finding-test-001',
    judgeRunId: 'run-test-001',
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
    ...overrides,
  };
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = new MongoClient(mongo.getUri());
  await client.connect();
  db = client.db('test-review');
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

// ─── createFromFinding ───────────────────────────────────────────────────────

describe('createFromFinding', () => {
  it('creates a task with queue="open"', async () => {
    const finding = makeFinding();
    const task = await service.createFromFinding(finding, mockConfig);
    expect(task.queue).toBe('open');
  });

  it('creates a task with status="pending"', async () => {
    const finding = makeFinding();
    const task = await service.createFromFinding(finding, mockConfig);
    expect(task.status).toBe('pending');
  });

  it('high confidence + low risk + workflow scope → requiresHumanReview=false', async () => {
    const finding = makeFinding({ confidence: 0.9, risk: 'low', scope: 'workflow' });
    const task = await service.createFromFinding(finding, mockConfig);
    expect(task.requiresHumanReview).toBe(false);
  });

  it('low confidence → requiresHumanReview=true', async () => {
    const finding = makeFinding({ confidence: 0.3, risk: 'low', scope: 'workflow' });
    const task = await service.createFromFinding(finding, mockConfig);
    expect(task.requiresHumanReview).toBe(true);
    expect(task.humanReviewReason).toBe('low_confidence');
  });

  it('high risk → requiresHumanReview=true', async () => {
    const finding = makeFinding({ confidence: 0.9, risk: 'high', scope: 'workflow' });
    const task = await service.createFromFinding(finding, mockConfig);
    expect(task.requiresHumanReview).toBe(true);
    expect(task.humanReviewReason).toBe('high_risk');
  });

  it('code_fix → requiresHumanReview=true', async () => {
    const finding = makeFinding({ confidence: 0.9, risk: 'low', scope: 'workflow', fixType: 'code_fix' });
    const task = await service.createFromFinding(finding, mockConfig);
    expect(task.requiresHumanReview).toBe(true);
    expect(task.humanReviewReason).toBe('code_fix');
  });

  it('task has correct findingId and judgeRunId', async () => {
    const finding = makeFinding({ findingId: 'fid-abc', judgeRunId: 'run-abc' });
    const task = await service.createFromFinding(finding, mockConfig);
    expect(task.findingId).toBe('fid-abc');
    expect(task.judgeRunId).toBe('run-abc');
  });
});

// ─── cross_repo / global scope: parent + child tasks ─────────────────────────

describe('cross_repo scope with multiple repoIds creates parent + child tasks', () => {
  it('creates parent task with childTaskIds when repoId is comma-separated', async () => {
    const finding = makeFinding({
      scope: 'cross_repo',
      repoId: 'repo-a,repo-b',
      confidence: 0.9,
      risk: 'low',
    });
    const parent = await service.createFromFinding(finding, mockConfig);
    expect(parent.childTaskIds).toBeDefined();
    expect(parent.childTaskIds!.length).toBe(2);
  });

  it('child tasks have parentTaskId pointing to parent', async () => {
    const finding = makeFinding({
      scope: 'cross_repo',
      repoId: 'repo-x,repo-y',
      confidence: 0.9,
      risk: 'low',
    });
    const parent = await service.createFromFinding(finding, mockConfig);
    for (const childId of parent.childTaskIds ?? []) {
      const child = await service.get(childId);
      expect(child).not.toBeNull();
      expect(child!.parentTaskId).toBe(parent.taskId);
    }
  });

  it('single repoId cross_repo → no child tasks created', async () => {
    const finding = makeFinding({
      scope: 'cross_repo',
      repoId: 'repo-single',
      confidence: 0.9,
      risk: 'low',
    });
    const parent = await service.createFromFinding(finding, mockConfig);
    // No comma → no children
    expect(parent.childTaskIds).toBeUndefined();
  });

  it('global scope without repoId → single task only', async () => {
    const finding = makeFinding({
      scope: 'global',
      repoId: undefined,
      confidence: 0.9,
      risk: 'low',
    });
    const parent = await service.createFromFinding(finding, mockConfig);
    expect(parent.childTaskIds).toBeUndefined();
  });
});

// ─── addDecision ─────────────────────────────────────────────────────────────

describe('addDecision', () => {
  it('approve → task status changes to "in_remediation"', async () => {
    const finding = makeFinding();
    const task = await service.createFromFinding(finding, mockConfig);
    await service.addDecision(task.taskId, { actor: 'user-1', action: 'approve' });
    const updated = await service.get(task.taskId);
    expect(updated!.status).toBe('in_remediation');
  });

  it('reject → task status changes to "rejected"', async () => {
    const finding = makeFinding();
    const task = await service.createFromFinding(finding, mockConfig);
    await service.addDecision(task.taskId, { actor: 'user-1', action: 'reject' });
    const updated = await service.get(task.taskId);
    expect(updated!.status).toBe('rejected');
  });

  it('request_changes → task status changes to "changes_requested"', async () => {
    const finding = makeFinding();
    const task = await service.createFromFinding(finding, mockConfig);
    await service.addDecision(task.taskId, { actor: 'user-1', action: 'request_changes' });
    const updated = await service.get(task.taskId);
    expect(updated!.status).toBe('changes_requested');
  });

  it('defer → task status changes to "pending"', async () => {
    const finding = makeFinding();
    const task = await service.createFromFinding(finding, mockConfig);
    // Change status first to verify it goes back to pending
    await service.updateStatus(task.taskId, 'in_review');
    await service.addDecision(task.taskId, { actor: 'user-1', action: 'defer' });
    const updated = await service.get(task.taskId);
    expect(updated!.status).toBe('pending');
  });

  it('decision is stored in context_review_decisions', async () => {
    const finding = makeFinding();
    const task = await service.createFromFinding(finding, mockConfig);
    await service.addDecision(task.taskId, { actor: 'user-2', action: 'approve', notes: 'Looks good' });
    const decisions = await service.listDecisions(task.taskId);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].actor).toBe('user-2');
    expect(decisions[0].action).toBe('approve');
    expect(decisions[0].notes).toBe('Looks good');
  });
});

// ─── list ─────────────────────────────────────────────────────────────────────

describe('list', () => {
  it('list by queue returns only tasks in that queue', async () => {
    // Use distinct fixTypes so each finding gets its own clusterKey and task
    const f1 = makeFinding({ findingId: 'fid-q1', fixType: 'curated_context_create', repoId: 'repo-queue-1' });
    const f2 = makeFinding({ findingId: 'fid-q2', fixType: 'ingestion_fix', repoId: 'repo-queue-2' });
    const task1 = await service.createFromFinding(f1, mockConfig);
    const task2 = await service.createFromFinding(f2, mockConfig);

    // Move task2 to a different queue
    await service.updateStatus(task2.taskId, 'done', { queue: 'history' as any });

    const openTasks = await service.list({ queue: 'open' });
    const ids = openTasks.map((t) => t.taskId);
    expect(ids).toContain(task1.taskId);
    expect(ids).not.toContain(task2.taskId);
  });

  it('list by risk returns only tasks with that risk', async () => {
    const fHigh = makeFinding({ findingId: 'fid-risk-h', risk: 'high', confidence: 0.9 });
    const fLow = makeFinding({ findingId: 'fid-risk-l', risk: 'low', confidence: 0.9 });
    await service.createFromFinding(fHigh, mockConfig);
    await service.createFromFinding(fLow, mockConfig);

    const highRiskTasks = await service.list({ risk: 'high' });
    expect(highRiskTasks.every((t) => t.risk === 'high')).toBe(true);
  });
});

// ─── getQueues ────────────────────────────────────────────────────────────────

describe('getQueues', () => {
  it('returns counts for all queues', async () => {
    const finding = makeFinding({ findingId: 'fid-queue-test' });
    await service.createFromFinding(finding, mockConfig);
    const queues = await service.getQueues();
    expect(typeof queues['open']).toBe('number');
    expect(typeof queues['auto_remediated']).toBe('number');
    expect(typeof queues['dispatched']).toBe('number');
    expect(typeof queues['history']).toBe('number');
    expect(queues['open']).toBeGreaterThanOrEqual(1);
  });
});
