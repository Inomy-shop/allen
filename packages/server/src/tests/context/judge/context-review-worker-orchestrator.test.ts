// Tests for ContextReviewWorkerOrchestrator — gates, assignment rules
// Uses MongoMemoryServer for in-memory MongoDB isolation.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  ContextReviewWorkerOrchestrator,
  WORKER_ROLE_AGENT_MAP,
} from '../../../services/context/judge/context-review-worker-orchestrator.js';
import { CuratedContextEditorService } from '../../../services/context/judge/curated-context-editor.service.js';

let mongo: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let orchestrator: ContextReviewWorkerOrchestrator;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = new MongoClient(mongo.getUri());
  await client.connect();
  db = client.db('test-orchestrator');
  orchestrator = new ContextReviewWorkerOrchestrator(db);
});

afterAll(async () => {
  await client.close();
  await mongo.stop();
});

beforeEach(async () => {
  await db.collection('context_review_tasks').deleteMany({});
  await db.collection('context_review_worker_assignments').deleteMany({});
  await db.collection('context_remediations').deleteMany({});
  await db.collection('learnings').deleteMany({});
  await db.collection('context_learning_promotions').deleteMany({});
  await db.collection('repo_context_curation_entries').deleteMany({});
  await db.collection('repo_context_curation_entry_revisions').deleteMany({});
});

async function insertTask(overrides: Record<string, unknown> = {}): Promise<string> {
  const taskId = `task-${Math.random().toString(36).slice(2)}`;
  await db.collection('context_review_tasks').insertOne({
    taskId,
    status: 'pending',
    requiresHumanReview: false,
    fixType: 'curated_context_edit',
    queue: 'open',
    ...overrides,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return taskId;
}

async function insertRemediation(overrides: Record<string, unknown> = {}): Promise<string> {
  const remediationId = typeof overrides.remediationId === 'string'
    ? overrides.remediationId
    : `remediation-${Math.random().toString(36).slice(2)}`;
  await db.collection('context_remediations').insertOne({
    remediationId,
    taskId: `task-${remediationId}`,
    findingId: `finding-${remediationId}`,
    workerRole: 'context_curation_fix',
    actionKind: 'curated_entry_edit',
    status: 'pending',
    humanGateRequired: false,
    targetRepoId: 'repo-1',
    targetEntryIds: ['knowledge-docs/docs/one.md'],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
  return remediationId;
}

// ─── Gate invariants (AC-17, AC-18, AC-19) ───────────────────────────────────

describe('Gate invariants', () => {
  it('gates.bypassesHumanReview === false (AC-17, AC-18)', () => {
    expect(orchestrator.gates.bypassesHumanReview).toBe(false);
  });

  it('gates.enforcesCodeChangeBlock === true (AC-19)', () => {
    expect(orchestrator.gates.enforcesCodeChangeBlock).toBe(true);
  });
});

// ─── assignBacklog ────────────────────────────────────────────────────────────

describe('assignBacklog', () => {
  it('does NOT assign tasks with requiresHumanReview=true (AC-18)', async () => {
    // Insert a human-review task
    await insertTask({ requiresHumanReview: true });

    const { assigned } = await orchestrator.assignBacklog({});
    expect(assigned).toBe(0);
  });

  it('does NOT assign code_fix tasks (AC-18, AC-19)', async () => {
    await insertTask({ fixType: 'code_fix', requiresHumanReview: false });

    const { assigned } = await orchestrator.assignBacklog({});
    expect(assigned).toBe(0);
  });

  it('creates an assignment for eligible tasks', async () => {
    const taskId = await insertTask({ requiresHumanReview: false, fixType: 'curated_context_edit' });

    const { assigned, assignments } = await orchestrator.assignBacklog({});
    expect(assigned).toBeGreaterThanOrEqual(1);
    expect(assignments.length).toBeGreaterThanOrEqual(1);
    expect(assignments[0].taskIds).toContain(taskId);
  });

  it('assignment includes gates with correct values', async () => {
    await insertTask({ requiresHumanReview: false, fixType: 'curated_context_edit' });
    const { assignments } = await orchestrator.assignBacklog({});
    expect(assignments[0].gates.bypassesHumanReview).toBe(false);
    expect(assignments[0].gates.enforcesCodeChangeBlock).toBe(true);
  });

  it('assignment has status="queued"', async () => {
    await insertTask({ requiresHumanReview: false, fixType: 'curated_context_edit' });
    const { assignments } = await orchestrator.assignBacklog({});
    expect(assignments[0].status).toBe('queued');
  });

  it('does not assign when no eligible tasks exist', async () => {
    const { assigned } = await orchestrator.assignBacklog({});
    expect(assigned).toBe(0);
  });

  it('respects maxBatch parameter', async () => {
    await insertTask({ requiresHumanReview: false });
    await insertTask({ requiresHumanReview: false });
    await insertTask({ requiresHumanReview: false });

    const { assigned } = await orchestrator.assignBacklog({ maxBatch: 2 });
    expect(assigned).toBeLessThanOrEqual(2);
  });

  it('triage assignment marks auto-remediatable tasks ready for remediation planning', async () => {
    const taskId = await insertTask({ requiresHumanReview: false, fixType: 'filtering_fix' });

    await orchestrator.assignBacklog({ workerRole: 'context_review_triage' });

    const task = await db.collection('context_review_tasks').findOne({ taskId });
    expect((task as any).status).toBe('in_review');
    expect((task as any).queue).toBe('open');
    expect((task as any).remediationStatus).toBe('ready');
  });

  it('remediation planner selects triaged ready tasks instead of requiring pending status', async () => {
    const taskId = await insertTask({
      status: 'in_review',
      queue: 'dispatched',
      remediationStatus: 'ready',
      requiresHumanReview: false,
      fixType: 'filtering_fix',
    });

    const { assigned, assignments } = await orchestrator.assignBacklog({
      workerRole: 'context_remediation_planner',
    });

    expect(assigned).toBe(1);
    expect(assignments[0].workerAgentName).toBe('context-remediation-planner-agent');
    expect(assignments[0].taskIds).toContain(taskId);
    const task = await db.collection('context_review_tasks').findOne({ taskId });
    expect((task as any).status).toBe('in_review');
    expect((task as any).remediationStatus).toBe('planning_dispatched');
    expect((task as any).remediationQueue).toBe('dispatched');
  });

  it('does not create duplicate remediation planner assignments for the same task', async () => {
    await insertTask({
      taskId: 'task-planner-dedupe',
      status: 'in_review',
      remediationStatus: 'ready',
      requiresHumanReview: false,
      fixType: 'filtering_fix',
    });

    const first = await orchestrator.assignBacklog({ workerRole: 'context_remediation_planner' });
    const second = await orchestrator.assignBacklog({ workerRole: 'context_remediation_planner' });

    expect(first.assigned).toBe(1);
    expect(second.assigned).toBe(0);
  });

  it('learning curator assigns eligible learnings that have no promotion yet', async () => {
    const now = new Date();
    await db.collection('learnings').insertMany([
      {
        learningId: 'learning-ready-1',
        contextEligibility: 'eligible',
        createdAt: new Date(now.getTime() + 3),
        updatedAt: now,
      },
      {
        learningId: 'learning-promoted-1',
        contextEligibility: 'eligible',
        createdAt: new Date(now.getTime() + 2),
        updatedAt: now,
      },
      {
        learningId: 'learning-ineligible-1',
        contextEligibility: 'ineligible',
        createdAt: new Date(now.getTime() + 1),
        updatedAt: now,
      },
    ]);
    await db.collection('context_learning_promotions').insertOne({
      promotionId: 'promotion-existing-1',
      learningId: 'learning-promoted-1',
      status: 'pending',
      action: 'create_curated_context',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const { assigned, assignments } = await orchestrator.assignBacklog({
      workerRole: 'context_learning_curator',
    });

    expect(assigned).toBe(1);
    expect(assignments[0].learningIds).toEqual(['learning-ready-1']);
    expect(assignments[0].taskIds).toEqual(['learning-ready-1']);
    expect(assignments[0].allenAgentInvocation!.taskPayload.learningIds).toEqual(['learning-ready-1']);
  });

  it('fix workers consume remediation records and mark them dispatched', async () => {
    await db.collection('context_remediations').insertOne({
      remediationId: 'remediation-ready-1',
      taskId: 'task-remediation-1',
      findingId: 'finding-remediation-1',
      workerRole: 'context_curation_fix',
      actionKind: 'curated_entry_edit',
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const { assigned, assignments } = await orchestrator.assignBacklog({
      workerRole: 'context_curation_fix',
    });

    expect(assigned).toBe(1);
    expect(assignments[0].remediationIds).toEqual(['remediation-ready-1']);
    expect(assignments[0].taskIds).toEqual(['remediation-ready-1']);
    expect(assignments[0].allenAgentInvocation!.taskPayload.remediationIds).toEqual(['remediation-ready-1']);

    const remediation = await db.collection('context_remediations').findOne({
      remediationId: 'remediation-ready-1',
    });
    expect((remediation as any).status).toBe('dispatched');
  });

  it('groups curation-fix remediations for the same target entry into one assignment', async () => {
    await insertRemediation({
      remediationId: 'remediation-same-target-1',
      targetRepoId: 'repo-group',
      targetEntryIds: ['knowledge-docs/docs/same.md'],
      createdAt: new Date(Date.now() + 1),
    });
    await insertRemediation({
      remediationId: 'remediation-same-target-2',
      targetRepoId: 'repo-group',
      targetEntryIds: ['knowledge-docs/docs/same.md'],
      createdAt: new Date(Date.now() + 2),
    });

    const { assigned, assignments } = await orchestrator.assignBacklog({
      workerRole: 'context_curation_fix',
      maxBatch: 10,
    });

    expect(assigned).toBe(2);
    expect(assignments).toHaveLength(1);
    expect(assignments[0].remediationIds).toEqual([
      'remediation-same-target-1',
      'remediation-same-target-2',
    ]);
    expect(assignments[0].curationTargetKey).toBe('repo-group:knowledge-docs/docs/same.md');
    expect(assignments[0].allenAgentInvocation!.taskPayload.curationTarget).toEqual({
      repoId: 'repo-group',
      entryId: 'knowledge-docs/docs/same.md',
    });
  });

  it('splits curation-fix remediations for different target entries into separate assignments', async () => {
    await insertRemediation({
      remediationId: 'remediation-target-a',
      targetRepoId: 'repo-group',
      targetEntryIds: ['knowledge-docs/docs/a.md'],
      createdAt: new Date(Date.now() + 1),
    });
    await insertRemediation({
      remediationId: 'remediation-target-b',
      targetRepoId: 'repo-group',
      targetEntryIds: ['knowledge-docs/docs/b.md'],
      createdAt: new Date(Date.now() + 2),
    });

    const { assigned, assignments } = await orchestrator.assignBacklog({
      workerRole: 'context_curation_fix',
      maxBatch: 10,
    });

    expect(assigned).toBe(2);
    expect(assignments).toHaveLength(2);
    expect(assignments.map((assignment) => assignment.curationTargetKey).sort()).toEqual([
      'repo-group:knowledge-docs/docs/a.md',
      'repo-group:knowledge-docs/docs/b.md',
    ]);
  });

  it('repair mode creates visible assignment for explicit failed remediation IDs and marks them repairing', async () => {
    await db.collection('context_remediations').insertOne({
      remediationId: 'remediation-repair-1',
      taskId: 'task-repair-1',
      findingId: 'finding-repair-1',
      workerRole: 'context_curation_fix',
      actionKind: 'curated_entry_edit',
      status: 'failed',
      error: 'previous failed attempt',
      result: { status: 'failed' },
      humanGateRequired: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const { assigned, assignments } = await orchestrator.assignBacklog({
      workerRole: 'context_curation_fix',
      remediationIds: ['remediation-repair-1'],
      repairMode: true,
      rootExecutionId: 'root-repair-1',
      sessionId: 'session-repair-1',
    });

    expect(assigned).toBe(1);
    expect(assignments[0].repairMode).toBe(true);
    expect(assignments[0].rootExecutionId).toBe('root-repair-1');
    expect(assignments[0].remediationIds).toEqual(['remediation-repair-1']);

    const remediation = await db.collection('context_remediations').findOne({
      remediationId: 'remediation-repair-1',
    });
    expect((remediation as any).status).toBe('repairing');
    expect((remediation as any).error).toBeUndefined();
    expect((remediation as any).repairAssignmentId).toBe(assignments[0].assignmentId);
    expect((remediation as any).repairAttempts[0].previousStatus).toBe('failed');
    expect((remediation as any).repairAttempts[0].previousError).toBe('previous failed attempt');
  });

  it('repair mode splits explicit curation remediations by target entry', async () => {
    await insertRemediation({
      remediationId: 'remediation-repair-split-a',
      status: 'failed',
      targetRepoId: 'repo-repair',
      targetEntryIds: ['knowledge-docs/docs/a.md'],
      createdAt: new Date(Date.now() + 1),
    });
    await insertRemediation({
      remediationId: 'remediation-repair-split-b',
      status: 'failed',
      targetRepoId: 'repo-repair',
      targetEntryIds: ['knowledge-docs/docs/b.md'],
      createdAt: new Date(Date.now() + 2),
    });

    const { assigned, assignments } = await orchestrator.assignBacklog({
      workerRole: 'context_curation_fix',
      remediationIds: ['remediation-repair-split-a', 'remediation-repair-split-b'],
      repairMode: true,
      rootExecutionId: 'root-repair-split',
      sessionId: 'session-repair-split',
    });

    expect(assigned).toBe(2);
    expect(assignments).toHaveLength(2);
    expect(assignments.every((assignment) => assignment.repairMode === true)).toBe(true);
    expect(assignments.map((assignment) => assignment.curationTargetKey).sort()).toEqual([
      'repo-repair:knowledge-docs/docs/a.md',
      'repo-repair:knowledge-docs/docs/b.md',
    ]);
  });

  it('skips explicit repair remediations whose target entry already has an active assignment', async () => {
    await insertRemediation({
      remediationId: 'remediation-active-target',
      targetRepoId: 'repo-conflict',
      targetEntryIds: ['knowledge-docs/docs/conflict.md'],
      status: 'repairing',
    });
    await db.collection('context_review_worker_assignments').insertOne({
      assignmentId: 'assignment-active-target',
      taskIds: ['remediation-active-target'],
      remediationIds: ['remediation-active-target'],
      curationTargetKey: 'repo-conflict:knowledge-docs/docs/conflict.md',
      curationTarget: { repoId: 'repo-conflict', entryId: 'knowledge-docs/docs/conflict.md' },
      workerAgentName: 'context-curation-fix-agent',
      workerRole: 'context_curation_fix',
      status: 'running',
      gates: { bypassesHumanReview: false, enforcesCodeChangeBlock: true },
      assignedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await insertRemediation({
      remediationId: 'remediation-conflicting-repair',
      status: 'failed',
      targetRepoId: 'repo-conflict',
      targetEntryIds: ['knowledge-docs/docs/conflict.md'],
    });

    const result = await orchestrator.assignBacklog({
      workerRole: 'context_curation_fix',
      remediationIds: ['remediation-conflicting-repair'],
      repairMode: true,
    });

    expect(result.assigned).toBe(0);
    expect(result.assignments).toHaveLength(0);
    expect(result.skippedConflicts).toEqual([
      {
        remediationId: 'remediation-conflicting-repair',
        targetKey: 'repo-conflict:knowledge-docs/docs/conflict.md',
        activeAssignmentId: 'assignment-active-target',
      },
    ]);
  });

  it('stores workerAgentName on assignment', async () => {
    await insertTask({ requiresHumanReview: false });
    const { assignments } = await orchestrator.assignBacklog({ workerAgentName: 'worker-agent-1' });
    expect(assignments[0].workerAgentName).toBe('worker-agent-1');
  });
});

// ─── completeAssignment ───────────────────────────────────────────────────────

describe('completeAssignment', () => {
  it('sets status to "completed"', async () => {
    await insertTask({ requiresHumanReview: false });
    const { assignments } = await orchestrator.assignBacklog({});
    const assignmentId = assignments[0].assignmentId;

    const result = await orchestrator.completeAssignment(assignmentId, { status: 'completed' });
    expect(result).toBe(true);

    const listed = await orchestrator.listAssignments({});
    const found = listed.find((a) => a.assignmentId === assignmentId);
    expect(found!.status).toBe('completed');
  });

  it('sets status to "failed"', async () => {
    await insertTask({ requiresHumanReview: false });
    const { assignments } = await orchestrator.assignBacklog({});
    const assignmentId = assignments[0].assignmentId;

    await orchestrator.completeAssignment(assignmentId, { status: 'failed', notes: 'Error occurred' });

    const listed = await orchestrator.listAssignments({});
    const found = listed.find((a) => a.assignmentId === assignmentId);
    expect(found!.status).toBe('failed');
  });

  it('returns false for unknown assignmentId', async () => {
    const result = await orchestrator.completeAssignment('00000000-0000-0000-0000-000000000000', { status: 'completed' });
    expect(result).toBe(false);
  });
});

// ─── listAssignments ──────────────────────────────────────────────────────────

describe('listAssignments', () => {
  it('returns all assignments when no filter applied', async () => {
    await insertTask({ requiresHumanReview: false, fixType: 'curated_context_create' });
    await orchestrator.assignBacklog({});

    const all = await orchestrator.listAssignments({});
    expect(all.length).toBeGreaterThanOrEqual(1);
  });

  it('filter by status returns only matching assignments', async () => {
    await insertTask({ requiresHumanReview: false });
    const { assignments } = await orchestrator.assignBacklog({});
    await orchestrator.completeAssignment(assignments[0].assignmentId, { status: 'completed' });

    const completed = await orchestrator.listAssignments({ status: 'completed' });
    expect(completed.every((a) => a.status === 'completed')).toBe(true);
  });
});

// ─── Worker assignment boundary — agent invocation metadata ──────────────────

describe('Worker assignment boundary — agent invocation metadata', () => {
  beforeEach(async () => {
    await db.collection('context_agent_dispatch_queue').deleteMany({});
  });

  it('assignBacklog includes allenAgentInvocation with pending_runtime status', async () => {
    await db.collection('context_remediations').insertOne({
      remediationId: 'remediation-agent-boundary-1',
      taskId: 'task-agent-boundary-1',
      findingId: 'finding-agent-boundary-1',
      workerRole: 'context_curation_fix',
      actionKind: 'curated_entry_edit',
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await orchestrator.assignBacklog({
      maxBatch: 5,
      workerAgentName: 'context-curation-fix-agent',
      workerRole: 'context_curation_fix',
    });

    expect(result.assigned).toBeGreaterThanOrEqual(1);
    const assignment = result.assignments.find(a => a.remediationIds?.includes('remediation-agent-boundary-1'));
    expect(assignment).toBeDefined();
    expect(assignment!.allenAgentInvocation).toBeDefined();
    expect(assignment!.allenAgentInvocation!.agentName).toBe('context-curation-fix-agent');
    expect(assignment!.allenAgentInvocation!.dispatchStatus).toBe('pending_runtime');
    expect(assignment!.workerRole).toBe('context_curation_fix');
    expect(assignment!.allenAgentInvocation!.taskPayload.remediationIds).toEqual(['remediation-agent-boundary-1']);
    expect(assignment!.allenAgentInvocation!.taskPayload.workerRole).toBe('context_curation_fix');
    expect('instructionDocPath' in assignment!.allenAgentInvocation!.taskPayload).toBe(false);
  });

  it('normalizes requested worker role and picks up legacy remediation workerRole rows', async () => {
    await db.collection('context_remediations').insertOne({
      remediationId: 'remediation-legacy-role-1',
      taskId: 'task-legacy-role-1',
      findingId: 'finding-legacy-role-1',
      workerRole: 'curation_fix',
      actionKind: 'curated_entry_edit',
      status: 'pending',
      humanGateRequired: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await orchestrator.assignBacklog({
      maxBatch: 5,
      workerRole: 'curation_fix',
    });

    expect(result.assigned).toBe(1);
    expect(result.assignments[0].workerRole).toBe('context_curation_fix');
    expect(result.assignments[0].remediationIds).toEqual(['remediation-legacy-role-1']);
  });

  it('dispatchAssignmentToAgent creates an executable task record in dispatch queue', async () => {
    // Create assignment directly
    const now = new Date();
    const assignmentId = 'test-dispatch-boundary-1';
    await db.collection('context_review_worker_assignments').insertOne({
      assignmentId,
      taskIds: ['task-x'],
      workerAgentName: 'context-qa-eval-agent',
      workerRole: 'context_qa_eval',
      status: 'queued',
      gates: { bypassesHumanReview: false, enforcesCodeChangeBlock: true },
      allenAgentInvocation: {
        agentName: 'context-qa-eval-agent',
        taskDescription: 'Process QA eval tasks',
        taskPayload: { assignmentId, taskIds: ['task-x'], workerRole: 'context_qa_eval' },
        dispatchStatus: 'pending_runtime',
      },
      assignedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const result = await orchestrator.dispatchAssignmentToAgent(assignmentId);

    expect(result.assignmentId).toBe(assignmentId);
    expect(result.queuedRecord).toBeDefined();
    expect(result.queuedRecord!.status).toBe('queued'); // no ALLEN_AGENT_SPAWN_URL in test
    expect(result.queuedRecord!.agentName).toBe('context-qa-eval-agent');

    // Verify record in DB
    const record = await db.collection('context_agent_dispatch_queue').findOne({ assignmentId });
    expect(record).not.toBeNull();
    expect((record as any).agentName).toBe('context-qa-eval-agent');
    expect((record as any).taskPayload.instructionDocPath).toBeUndefined();
  });

  it('does not let a QA worker overwrite a curation-fix assignment execution owner', async () => {
    const now = new Date();
    const assignmentId = 'assignment-owner-guard-1';
    await db.collection('context_review_worker_assignments').insertOne({
      assignmentId,
      taskIds: ['remediation-owner-1'],
      remediationIds: ['remediation-owner-1'],
      workerAgentName: 'context-curation-fix-agent',
      workerRole: 'context_curation_fix',
      status: 'queued',
      gates: { bypassesHumanReview: false, enforcesCodeChangeBlock: true },
      assignedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const updated = await orchestrator.updateAssignment(assignmentId, {
      status: 'completed',
      workerRole: 'context_qa_eval',
      agentName: 'context-qa-eval-agent',
      agentExecutionId: 'qa-exec-1',
    });

    expect(updated).toBe(false);
    const assignment = await db.collection('context_review_worker_assignments').findOne({ assignmentId });
    expect((assignment as any).status).toBe('queued');
    expect((assignment as any).agentExecutionId).toBeUndefined();
    expect((assignment as any).ownershipWarnings[0].code).toBe('worker_role_mismatch');
  });

  it('allows cosmetic agentName variants when workerRole matches the assignment', async () => {
    const now = new Date();
    const assignmentId = 'assignment-agent-alias-1';
    await db.collection('context_review_worker_assignments').insertOne({
      assignmentId,
      taskIds: ['learning-agent-alias-1'],
      learningIds: ['learning-agent-alias-1'],
      workerAgentName: 'context-learning-curator-agent',
      workerRole: 'context_learning_curator',
      status: 'queued',
      gates: { bypassesHumanReview: false, enforcesCodeChangeBlock: true },
      assignedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const updated = await orchestrator.updateAssignment(assignmentId, {
      status: 'running',
      workerRole: 'context_learning_curator',
      agentName: 'Codex context_learning_curator',
      agentExecutionId: 'learning-exec-1',
    });

    expect(updated).toBe(true);
    const assignment = await db.collection('context_review_worker_assignments').findOne({ assignmentId });
    expect((assignment as any).status).toBe('running');
    expect((assignment as any).agentExecutionId).toBe('learning-exec-1');
    expect((assignment as any).ownershipWarnings).toBeUndefined();
  });

  it('allows prefixed exact worker names when workerRole matches the assignment', async () => {
    const now = new Date();
    const assignmentId = 'assignment-agent-alias-2';
    await db.collection('context_review_worker_assignments').insertOne({
      assignmentId,
      taskIds: ['remediation-code-alias-1'],
      remediationIds: ['remediation-code-alias-1'],
      workerAgentName: 'context-code-fix-agent',
      workerRole: 'context_code_fix',
      status: 'queued',
      gates: { bypassesHumanReview: false, enforcesCodeChangeBlock: true },
      assignedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const updated = await orchestrator.updateAssignment(assignmentId, {
      status: 'failed',
      workerRole: 'context_code_fix',
      agentName: 'Codex context-code-fix-agent',
      agentExecutionId: 'code-exec-1',
      notes: 'gate blocked',
    });

    expect(updated).toBe(true);
    const assignment = await db.collection('context_review_worker_assignments').findOne({ assignmentId });
    expect((assignment as any).status).toBe('failed');
    expect((assignment as any).agentExecutionId).toBe('code-exec-1');
    expect((assignment as any).notes).toBe('gate blocked');
  });

  it('WORKER_ROLE_AGENT_MAP has all 7 required worker roles', () => {
    expect(Object.keys(WORKER_ROLE_AGENT_MAP)).toHaveLength(7);
    expect(WORKER_ROLE_AGENT_MAP['context_review_triage']).toBe('context-review-triage-agent');
    expect(WORKER_ROLE_AGENT_MAP['context_curation_fix']).toBe('context-curation-fix-agent');
    expect(WORKER_ROLE_AGENT_MAP['context_qa_eval']).toBe('context-qa-eval-agent');
  });
});

describe('CuratedContextEditorService concurrency guard', () => {
  it('rejects stale expected entry versions', async () => {
    const editor = new CuratedContextEditorService(db);
    const created = await editor.applyEdit(
      'repo-editor',
      'knowledge-docs/docs/test.md',
      {
        title: 'Initial',
        curatedContext: 'Initial context',
      },
      { actor: 'test', source: 'test', action: 'create' },
    );
    await editor.applyEdit(
      'repo-editor',
      'knowledge-docs/docs/test.md',
      {
        curatedContext: 'Updated context',
      },
      {
        actor: 'test',
        source: 'test',
        action: 'update',
        expectedEntryVersionId: created.revision.afterEntryVersionId,
      },
    );

    await expect(editor.applyEdit(
      'repo-editor',
      'knowledge-docs/docs/test.md',
      {
        curatedContext: 'Stale update',
      },
      {
        actor: 'test',
        source: 'test',
        action: 'update',
        expectedEntryVersionId: created.revision.afterEntryVersionId,
      },
    )).rejects.toThrow(/Curated entry version conflict/);

    const activeEntries = await db.collection('repo_context_curation_entries')
      .find({ repoId: 'repo-editor', entryId: 'knowledge-docs/docs/test.md', active: true })
      .toArray();
    expect(activeEntries).toHaveLength(1);
    expect((activeEntries[0] as any).curatedContext).toBe('Updated context');
  });
});
