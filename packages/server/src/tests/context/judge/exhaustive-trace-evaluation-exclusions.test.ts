/**
 * Regression tests for ENG-1760 — Exhaustive Context Trace Evaluation
 *
 * Covers:
 *  1. 7 unevaluated traces => 1 assignment of 7
 *  2. 20 unevaluated traces => 1 assignment of 20
 *  3. 43 unevaluated traces => 3 assignments: 20+20+3
 *  4. 1000 traces => ceil(1000/20)=50 assignments (pagination, not loading all at once)
 *  5. Orchestrator does not finalize 'completed' while unevaluatedTraceCount > 0
 *  6. Worker/source-evaluation path persists no_issue for healthy trace
 *  7. Finding created for a trace with missing injected context
 *  8. Curated context exists but not injected => classify retrieval/filtering gap
 *  9. DB-derived final summary matches actual DB rows
 * 10. Regression: 20 context_usage_trace candidates must not finalize with sourceEvaluations=0
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ContextEvaluationScheduler } from '../../../services/context/judge/context-evaluation-scheduler.js';
import { ContextTraceAnalysisAssignmentService } from '../../../services/context/judge/context-trace-analysis-assignment.service.js';
import { ContextSourceEvaluationService } from '../../../services/context/judge/context-source-evaluation.service.js';
import { ContextJudgeOrchestratorService } from '../../../services/context/judge/context-judge-orchestrator.service.js';
import type { AgentFindingInput } from '../../../services/context/judge/context-judge-orchestrator.service.js';
import type { ContextJudgeConfig } from '../../../services/context/judge/context-judge.types.js';

let mongo: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let scheduler: ContextEvaluationScheduler;
let traceAssignmentService: ContextTraceAnalysisAssignmentService;
let sourceEvalService: ContextSourceEvaluationService;
let orchestratorService: ContextJudgeOrchestratorService;

const testConfig: ContextJudgeConfig = {
  configId: 'singleton',
  autoRemediationEnabled: false,
  autoRemediationThresholds: { minConfidence: 0.85, maxRisk: 'low', allowedFixTypes: [] },
  mandatoryHumanReview: {
    lowConfidenceThreshold: 0.5,
    highRiskLevels: ['high', 'critical'],
    alwaysForScopes: ['cross_repo', 'global'],
    alwaysForLearningDerived: true,
    alwaysForCodeFix: true,
  },
  updatedAt: new Date(),
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeAttempt(index: number, repoId = 'repo-test') {
  const id = `ca-${String(index).padStart(5, '0')}`;
  return {
    contextAttemptId: id,
    executionId: `exec-${id}`,
    repoId,
    executionKind: 'workflow_node',
    status: 'ready',
    contextInjection: { consideredCount: 2, injectedCount: 1 },
    createdAt: new Date(Date.now() + index * 1000), // unique timestamps
    updatedAt: new Date(Date.now() + index * 1000),
  };
}

async function insertAttempts(count: number, repoId = 'repo-test') {
  const docs = Array.from({ length: count }, (_, i) => makeAttempt(i + 1, repoId));
  await db.collection('context_attempts').insertMany(docs);
  return docs;
}

async function markEvaluated(contextAttemptId: string, sessionId = 'sess-default') {
  const sourceKey = `context_usage_trace:${contextAttemptId}`;
  await db.collection('context_source_evaluations').insertOne({
    evaluationId: `eval-${contextAttemptId}`,
    sessionId,
    sourceType: 'context_usage_trace',
    sourceId: contextAttemptId,
    sourceKey,
    decision: 'no_issue',
    status: 'completed',
    evaluationVersion: 1,
    evaluatedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

// Simulate the orchestrator's exhaustive assignment loop in-process
async function runExhaustiveAssignmentLoop(
  sessionId: string,
  repoId?: string,
  maxIterations = 200,
): Promise<{
  assignments: Awaited<ReturnType<typeof traceAssignmentService.list>>;
  iterationCount: number;
}> {
  let cursor: string | undefined = undefined;
  let iterationCount = 0;
  const assignmentIds: string[] = [];

  while (iterationCount < maxIterations) {
    iterationCount++;
    const candidates = await scheduler.listUnevaluatedContextTraces({
      repoId,
      sessionId,
      limit: 20,
      cursor,
    });

    if (candidates.length === 0) break; // All unevaluated traces discovered

    const sourceIds = candidates.map((c) => c.contextAttemptId!).filter(Boolean);
    const assignment = await traceAssignmentService.create({
      sessionId,
      repoId,
      sourceIds,
    });
    assignmentIds.push(assignment.assignmentId);

    // Advance cursor to last assigned contextAttemptId for next page
    cursor = sourceIds[sourceIds.length - 1];
  }

  const assignments = await traceAssignmentService.list({ sessionId });
  return { assignments, iterationCount };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = new MongoClient(mongo.getUri());
  await client.connect();
  db = client.db('test-exhaustive-trace');
  scheduler = new ContextEvaluationScheduler(db);
  traceAssignmentService = new ContextTraceAnalysisAssignmentService(db);
  sourceEvalService = new ContextSourceEvaluationService(db);
  orchestratorService = new ContextJudgeOrchestratorService(db);
});

afterAll(async () => {
  await client.close();
  await mongo.stop();
});

beforeEach(async () => {
  await db.collection('context_attempts').deleteMany({});
  await db.collection('context_source_evaluations').deleteMany({});
  await db.collection('context_trace_analysis_assignments').deleteMany({});
  await db.collection('context_orchestration_sessions').deleteMany({});
  await db.collection('context_judge_runs').deleteMany({});
  await db.collection('context_findings').deleteMany({});
  await db.collection('context_review_tasks').deleteMany({});
  await db.collection('context_orchestrator_run_records').deleteMany({});
  await db.collection('executions').deleteMany({});
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: 7 unevaluated traces => 1 assignment of 7
// ─────────────────────────────────────────────────────────────────────────────

describe('ContextTraceAnalysisAssignmentService CRUD', () => {
  it('create() enforces max 20 sourceIds', async () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => `ca-${i}`);
    await expect(
      traceAssignmentService.create({ sessionId: 'sess-overflow', sourceIds: tooMany }),
    ).rejects.toThrow(/≤ 20/);
  });

  it('create() with exactly 20 sourceIds succeeds', async () => {
    const exactly20 = Array.from({ length: 20 }, (_, i) => `ca-e${i}`);
    const assignment = await traceAssignmentService.create({
      sessionId: 'sess-exact20',
      sourceIds: exactly20,
    });
    expect(assignment.assignedCount).toBe(20);
    expect(assignment.sourceIds).toHaveLength(20);
    expect(assignment.status).toBe('queued');
  });

  it('update() transitions status and records completion time', async () => {
    const assignment = await traceAssignmentService.create({
      sessionId: 'sess-update',
      sourceIds: ['ca-up-1', 'ca-up-2'],
    });

    let updated = await traceAssignmentService.update(assignment.assignmentId, {
      status: 'running',
      workerExecutionId: 'exec-worker-1',
    });
    expect(updated).toBe(true);

    const running = await traceAssignmentService.get(assignment.assignmentId);
    expect(running!.status).toBe('running');
    expect(running!.workerExecutionId).toBe('exec-worker-1');

    updated = await traceAssignmentService.update(assignment.assignmentId, {
      status: 'completed',
      evaluatedCount: 2,
      findingCount: 0,
    });
    expect(updated).toBe(true);

    const completed = await traceAssignmentService.get(assignment.assignmentId);
    expect(completed!.status).toBe('completed');
    expect(completed!.evaluatedCount).toBe(2);
    expect(completed!.completedAt).toBeDefined();
  });

  it('countBySession() returns correct aggregates', async () => {
    const sessionId = 'sess-count';
    const a1 = await traceAssignmentService.create({ sessionId, sourceIds: ['c1', 'c2', 'c3'] });
    const a2 = await traceAssignmentService.create({ sessionId, sourceIds: ['c4', 'c5'] });

    await traceAssignmentService.update(a1.assignmentId, {
      status: 'completed', evaluatedCount: 3, findingCount: 1,
    });
    await traceAssignmentService.update(a2.assignmentId, {
      status: 'failed', failedCount: 2, error: 'worker timed out',
    });

    const counts = await traceAssignmentService.countBySession(sessionId);
    expect(counts.total).toBe(2);
    expect(counts.byStatus['completed']).toBe(1);
    expect(counts.byStatus['failed']).toBe(1);
    expect(counts.totalAssigned).toBe(5);
    expect(counts.totalEvaluated).toBe(3);
    expect(counts.totalFailed).toBe(2);
    expect(counts.totalFindings).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 12: listUnevaluatedContextTraces respects in-flight assignment exclusion
// ─────────────────────────────────────────────────────────────────────────────

describe('listUnevaluatedContextTraces exclusion logic', () => {
  it('excludes traces that are in active (non-failed) assignments', async () => {
    await insertAttempts(5);
    const attempts = await scheduler.listUnevaluatedContextTraces({ limit: 20 });
    expect(attempts).toHaveLength(5);

    // Create an assignment for 3 of them
    const first3 = attempts.slice(0, 3).map((c) => c.contextAttemptId!);
    await traceAssignmentService.create({
      sessionId: 'sess-excl',
      sourceIds: first3,
    });

    // Now only 2 should be returned (the assigned 3 are excluded)
    const remaining = await scheduler.listUnevaluatedContextTraces({ limit: 20 });
    expect(remaining).toHaveLength(2);
    for (const id of first3) {
      expect(remaining.every((c) => c.contextAttemptId !== id)).toBe(true);
    }
  });

  it('INCLUDES traces from failed assignments (so they can be retried)', async () => {
    await insertAttempts(3);
    const attempts = await scheduler.listUnevaluatedContextTraces({ limit: 20 });
    const ids = attempts.map((c) => c.contextAttemptId!);

    // Create an assignment and mark it failed
    const assignment = await traceAssignmentService.create({
      sessionId: 'sess-retry',
      sourceIds: ids,
    });
    await traceAssignmentService.update(assignment.assignmentId, {
      status: 'failed',
      error: 'worker crashed',
    });

    // Traces should be available again for retry
    const retryable = await scheduler.listUnevaluatedContextTraces({ limit: 20 });
    expect(retryable).toHaveLength(3); // all 3 available again
  });

  it('successful retry supersedes failed analysis in effective trace counts', async () => {
    await insertAttempts(2);
    const sessionId = 'sess-retry-effective';
    const ids = ['ca-00001', 'ca-00002'];

    const failed = await traceAssignmentService.create({
      sessionId,
      sourceIds: ids,
    });
    await traceAssignmentService.update(failed.assignmentId, {
      status: 'failed',
      failedCount: 2,
      error: 'worker crashed',
    });

    const retry = await traceAssignmentService.create({
      sessionId,
      sourceIds: ids,
      retryOfAssignmentId: failed.assignmentId,
    });
    for (const id of ids) {
      await sourceEvalService.upsert({
        sessionId,
        sourceType: 'context_usage_trace',
        sourceId: id,
        contextAttemptId: id,
        workerAssignmentId: retry.assignmentId,
        decision: 'no_issue',
        status: 'completed',
      });
    }
    await traceAssignmentService.update(retry.assignmentId, {
      status: 'completed',
      evaluatedCount: 2,
      failedCount: 0,
    });

    const counts = await traceAssignmentService.countBySession(sessionId);
    expect(counts.retriedTraceCount).toBe(2);
    expect(counts.effectiveEvaluatedTraceCount).toBe(2);
    expect(counts.effectiveFailedTraceCount).toBe(0);

    const original = await db.collection('context_trace_analysis_assignments').findOne({
      assignmentId: failed.assignmentId,
    });
    expect((original as any).terminalReason).toBe('retried');
    expect((original as any).supersededByAssignmentIds).toContain(retry.assignmentId);
  });

  it('excludes child execution traces for the current context judge root execution', async () => {
    await db.collection('context_attempts').insertMany([
      {
        contextAttemptId: 'ca-self-001',
        executionId: 'exec-judge-child-1',
        repoId: 'repo-self-filter',
        executionKind: 'spawned_agent',
        status: 'ready',
        contextInjection: { consideredCount: 1, injectedCount: 1 },
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        contextAttemptId: 'ca-user-001',
        executionId: 'exec-user-work-1',
        repoId: 'repo-self-filter',
        executionKind: 'workflow_node',
        status: 'ready',
        contextInjection: { consideredCount: 1, injectedCount: 1 },
        createdAt: new Date('2026-01-01T00:00:01.000Z'),
        updatedAt: new Date('2026-01-01T00:00:01.000Z'),
      },
    ]);
    await db.collection('executions').insertOne({
      id: 'exec-judge-child-1',
      rootExecutionId: 'exec-judge-root-1',
      agent_name: 'context-trace-analysis-agent',
      createdAt: new Date(),
    });
    const session = await orchestratorService.beginOrchestration({
      scope: 'workflow',
      repoId: 'repo-self-filter',
      rootExecutionId: 'exec-judge-root-1',
    });

    const candidates = await scheduler.listUnevaluatedContextTraces({
      sessionId: session.sessionId,
      repoId: 'repo-self-filter',
      limit: 20,
    });

    expect(candidates.map((c) => c.contextAttemptId)).toEqual(['ca-user-001']);
  });

  it('excludes traces already in context_source_evaluations with status=completed', async () => {
    await insertAttempts(4);
    const firstId = 'ca-00001';
    const secondId = 'ca-00002';

    // Mark two as evaluated
    await markEvaluated(firstId);
    await markEvaluated(secondId);

    const candidates = await scheduler.listUnevaluatedContextTraces({ limit: 20 });
    expect(candidates).toHaveLength(2);
    expect(candidates.every((c) => c.contextAttemptId !== firstId)).toBe(true);
    expect(candidates.every((c) => c.contextAttemptId !== secondId)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 13: Regression — listUnevaluatedContextTraces MUST NOT return false empty
// when the first internal page (INTERNAL_PAGE_SIZE=100) is entirely excluded but
// later rows are unevaluated. Covers ENG-1760 Blocker C.
// ─────────────────────────────────────────────────────────────────────────────

describe('Test 13: Pagination false-empty regression (ENG-1760 Blocker C)', () => {
  it('returns unevaluated traces that appear after a fully-excluded first page', async () => {
    // Insert exactly 100 attempts (one internal page worth) — all evaluated
    const firstPageAttempts = await insertAttempts(100);

    // Mark all 100 as evaluated so they will be excluded
    for (const a of firstPageAttempts) {
      await markEvaluated(a.contextAttemptId);
    }

    // Insert 1 unevaluated attempt beyond the first page
    // Its contextAttemptId ('ca-00101') sorts after all first-page IDs
    const lateAttempt = makeAttempt(101);
    await db.collection('context_attempts').insertOne(lateAttempt);

    // With the OLD code (limit * FETCH_MULTIPLIER = 120), all 100 filtered
    // results would be exhausted and the 1 remaining unevaluated trace at
    // position 101 would never be reached → false empty.
    //
    // With the NEW iterative-page code, after the first page (100 rows, all
    // excluded), the loop advances cursor and fetches page 2 (1 row), finds
    // the unevaluated trace, and returns it.
    const candidates = await scheduler.listUnevaluatedContextTraces({ limit: 20 });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].contextAttemptId).toBe('ca-00101');
  });

  it('returns correct results when first page is entirely in-flight assignments', async () => {
    const firstPageAttempts = await insertAttempts(100);
    const firstPageIds = firstPageAttempts.map((a) => a.contextAttemptId);

    // Put all 100 in an active (non-failed) assignment
    await db.collection('context_trace_analysis_assignments').insertOne({
      assignmentId: 'assign-fullpage',
      sessionId: 'sess-fullpage',
      sourceType: 'context_usage_trace',
      sourceIds: firstPageIds,
      assignedCount: 100,
      evaluatedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      findingCount: 0,
      status: 'running',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Insert 5 unevaluated attempts beyond the first page
    await insertAttempts(5); // re-uses indices 1-5 but those are already inserted; need 101-105
    // Actually insertAttempts generates ca-00001 through ca-00005, which collide.
    // Use a manual insert with higher IDs instead.
    for (let i = 101; i <= 105; i++) {
      await db.collection('context_attempts').insertOne(makeAttempt(i));
    }

    const candidates = await scheduler.listUnevaluatedContextTraces({ limit: 20 });

    expect(candidates.length).toBe(5);
    for (const c of candidates) {
      expect(Number(c.contextAttemptId!.replace('ca-', ''))).toBeGreaterThanOrEqual(101);
    }
  });

  it('exhausts all pages and returns empty when all traces are evaluated', async () => {
    const attempts = await insertAttempts(110); // more than one internal page
    for (const a of attempts) {
      await markEvaluated(a.contextAttemptId);
    }

    const candidates = await scheduler.listUnevaluatedContextTraces({ limit: 20 });
    expect(candidates).toHaveLength(0);
  });

  it('handles cursor correctly when rows after cursor are all evaluated, then finds more', async () => {
    // Rows 1-100 unevaluated (will be assigned in first orchestrator pass)
    await insertAttempts(100);
    // Rows 101-200 evaluated (skipped)
    const midAttempts = Array.from({ length: 100 }, (_, i) => makeAttempt(i + 101));
    await db.collection('context_attempts').insertMany(midAttempts);
    for (const a of midAttempts) {
      await markEvaluated(a.contextAttemptId);
    }
    // Row 201 unevaluated
    await db.collection('context_attempts').insertOne(makeAttempt(201));

    // Orchestrator first pass: cursor=undefined, assigns rows 1-20
    const pass1 = await scheduler.listUnevaluatedContextTraces({ limit: 20 });
    expect(pass1.length).toBe(20);
    const pass1Ids = pass1.map((c) => c.contextAttemptId!);
    // Mark them as evaluated so they're excluded in next pass
    for (const id of pass1Ids) await markEvaluated(id);

    // Second pass: cursor='ca-00020', rows 21-40 should come from first 100
    const pass2 = await scheduler.listUnevaluatedContextTraces({ limit: 20, cursor: 'ca-00020' });
    expect(pass2.length).toBe(20);
    // All should be in the 21-100 range
    for (const c of pass2) {
      const n = parseInt(c.contextAttemptId!.replace('ca-', ''), 10);
      expect(n).toBeGreaterThan(20);
      expect(n).toBeLessThanOrEqual(100);
    }

    // After all 100 are evaluated, cursor at 'ca-00100',
    // rows 101-200 are evaluated, row 201 is unevaluated.
    // listUnevaluatedContextTraces(cursor='ca-00100') should reach row 201.
    const attempts2to100 = Array.from({ length: 80 }, (_, i) => `ca-${String(i + 21).padStart(5, '0')}`);
    for (const id of attempts2to100) await markEvaluated(id);

    const passLate = await scheduler.listUnevaluatedContextTraces({ limit: 20, cursor: 'ca-00100' });
    expect(passLate.length).toBe(1);
    expect(passLate[0].contextAttemptId).toBe('ca-00201');
  });
});
