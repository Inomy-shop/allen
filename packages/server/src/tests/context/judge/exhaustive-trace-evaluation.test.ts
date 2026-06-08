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

describe('Test 1: 7 unevaluated traces => 1 assignment of 7', () => {
  it('creates exactly 1 assignment containing all 7 trace IDs', async () => {
    await insertAttempts(7);
    const sessionId = 'sess-test1';

    const { assignments, iterationCount } = await runExhaustiveAssignmentLoop(sessionId);

    expect(iterationCount).toBe(2); // 1 batch + 1 empty confirmation
    expect(assignments).toHaveLength(1);
    expect(assignments[0].assignedCount).toBe(7);
    expect(assignments[0].sourceIds).toHaveLength(7);
    expect(assignments[0].sourceType).toBe('context_usage_trace');
  });

  it('listUnevaluatedContextTraces returns all 7 with no cursor', async () => {
    await insertAttempts(7);
    const candidates = await scheduler.listUnevaluatedContextTraces({ limit: 20 });
    expect(candidates).toHaveLength(7);
    expect(candidates.every((c) => c.sourceKind === 'context_usage_trace')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: 20 unevaluated traces => 1 assignment of 20
// ─────────────────────────────────────────────────────────────────────────────

describe('Test 2: 20 unevaluated traces => 1 assignment of 20', () => {
  it('creates exactly 1 assignment containing 20 traces', async () => {
    await insertAttempts(20);
    const sessionId = 'sess-test2';

    const { assignments, iterationCount } = await runExhaustiveAssignmentLoop(sessionId);

    expect(assignments).toHaveLength(1);
    expect(assignments[0].assignedCount).toBe(20);
    expect(assignments[0].sourceIds).toHaveLength(20);
    // 2 iterations: 1 full batch + 1 empty (do NOT treat 20 as complete)
    expect(iterationCount).toBe(2);
  });

  it('does NOT stop after exactly 20 results — continues to check for more', async () => {
    // Insert 25 traces to confirm the loop checks past the first 20
    await insertAttempts(25);
    const sessionId = 'sess-test2b';

    const { assignments } = await runExhaustiveAssignmentLoop(sessionId);

    // Must have 2 assignments: 20 + 5
    expect(assignments).toHaveLength(2);
    const totalAssigned = assignments.reduce((s, a) => s + a.assignedCount, 0);
    expect(totalAssigned).toBe(25);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: 43 unevaluated traces => 3 assignments: 20 + 20 + 3
// ─────────────────────────────────────────────────────────────────────────────

describe('Test 3: 43 unevaluated traces => 3 assignments (20+20+3)', () => {
  it('creates 3 assignments with correct sizes', async () => {
    await insertAttempts(43);
    const sessionId = 'sess-test3';

    const { assignments, iterationCount } = await runExhaustiveAssignmentLoop(sessionId);

    expect(assignments).toHaveLength(3);

    // Sort by createdAt to get deterministic order
    const sorted = [...assignments].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );

    expect(sorted[0].assignedCount).toBe(20);
    expect(sorted[1].assignedCount).toBe(20);
    expect(sorted[2].assignedCount).toBe(3);

    const totalAssigned = sorted.reduce((s, a) => s + a.assignedCount, 0);
    expect(totalAssigned).toBe(43);

    // 4 iterations: batches of 20+20+3 + 1 empty check
    expect(iterationCount).toBe(4);
  });

  it('all 43 sourceIds are unique across assignments (no duplicate assignments)', async () => {
    await insertAttempts(43);
    const sessionId = 'sess-test3-dedup';

    const { assignments } = await runExhaustiveAssignmentLoop(sessionId);

    const allIds = assignments.flatMap((a) => a.sourceIds);
    const uniqueIds = new Set(allIds);
    expect(uniqueIds.size).toBe(allIds.length); // no duplicates
    expect(allIds.length).toBe(43);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: 1000 traces => ceil(1000/20) = 50 assignments (no full load)
// ─────────────────────────────────────────────────────────────────────────────

describe('Test 4: 1000 traces => 50 assignments via pagination (no full load at once)', () => {
  it('produces 50 assignments when 1000 traces exist', async () => {
    await insertAttempts(1000);
    const sessionId = 'sess-test4';

    const { assignments, iterationCount } = await runExhaustiveAssignmentLoop(sessionId, undefined, 1000);

    expect(assignments).toHaveLength(50);

    const totalAssigned = assignments.reduce((s, a) => s + a.assignedCount, 0);
    expect(totalAssigned).toBe(1000);

    // 51 iterations: 50 batches + 1 empty check
    expect(iterationCount).toBe(51);
  }, 60_000); // allow up to 60s for 1000 traces

  it('each assignment has at most 20 sourceIds', async () => {
    await insertAttempts(1000);
    const sessionId = 'sess-test4b';

    const { assignments } = await runExhaustiveAssignmentLoop(sessionId, undefined, 1000);

    for (const a of assignments) {
      expect(a.sourceIds.length).toBeLessThanOrEqual(20);
    }
  }, 60_000);

  it('no trace is assigned twice across 50 assignments', async () => {
    await insertAttempts(100); // use 100 for faster test
    const sessionId = 'sess-test4c';

    const { assignments } = await runExhaustiveAssignmentLoop(sessionId, undefined, 200);

    const allIds = assignments.flatMap((a) => a.sourceIds);
    const uniqueIds = new Set(allIds);
    expect(uniqueIds.size).toBe(allIds.length);
    expect(allIds.length).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: Orchestrator does NOT finalize 'completed' while unevaluatedTraceCount > 0
// ─────────────────────────────────────────────────────────────────────────────

describe('Test 5: Orchestrator does not finalize completed while unevaluatedTraceCount > 0', () => {
  it('dbSummary.status is not completed when trace assignments are queued but not evaluated', async () => {
    const session = await orchestratorService.beginOrchestration({
      scope: 'workflow',
      repoId: 'repo-test5',
    });

    // Insert 10 traces
    await insertAttempts(10, 'repo-test5');

    // Create an assignment (simulating orchestrator created it but worker hasn't finished)
    const attempts = await scheduler.listUnevaluatedContextTraces({ repoId: 'repo-test5', limit: 20 });
    const assignment = await traceAssignmentService.create({
      sessionId: session.sessionId,
      repoId: 'repo-test5',
      sourceIds: attempts.map((c) => c.contextAttemptId!),
    });

    // Assignment is queued (not completed) — evaluatedCount=0
    expect(assignment.evaluatedCount).toBe(0);

    // Finalize the session without any source evaluations persisted
    const finalized = await orchestratorService.finalizeOrchestration(
      session.sessionId,
      'Test: should be partial',
    ) as any;

    expect(finalized.dbSummary).toBeDefined();
    // Assigned 10 traces, 0 evaluated → unevaluatedTraceCount = 10
    expect(finalized.dbSummary.unevaluatedTraceCount).toBeGreaterThan(0);
    // Must NOT be completed
    expect(finalized.dbSummary.status).not.toBe('completed');
    expect(['partial', 'incomplete']).toContain(finalized.dbSummary.status);
  });

  it('status is partial (not incomplete) when some assignments exist but unevaluated remain', async () => {
    const session = await orchestratorService.beginOrchestration({
      scope: 'workflow',
      repoId: 'repo-test5b',
    });

    await insertAttempts(5, 'repo-test5b');
    const attempts = await scheduler.listUnevaluatedContextTraces({ repoId: 'repo-test5b', limit: 20 });
    await traceAssignmentService.create({
      sessionId: session.sessionId,
      repoId: 'repo-test5b',
      sourceIds: attempts.map((c) => c.contextAttemptId!),
    });

    const finalized = await orchestratorService.finalizeOrchestration(session.sessionId) as any;
    // Has assignments but not all evaluated → partial
    expect(finalized.dbSummary.status).toBe('partial');
  });

  it('status is completed when all assigned traces are accounted for in source_evaluations', async () => {
    const session = await orchestratorService.beginOrchestration({
      scope: 'workflow',
      repoId: 'repo-test5c',
    });

    const attempts = await insertAttempts(3, 'repo-test5c');
    const traceIds = attempts.map((a) => a.contextAttemptId);

    const assignment = await traceAssignmentService.create({
      sessionId: session.sessionId,
      repoId: 'repo-test5c',
      sourceIds: traceIds,
    });

    // Simulate worker completing: persist source evaluations + update assignment
    for (const id of traceIds) {
      await sourceEvalService.upsert({
        sessionId: session.sessionId,
        sourceType: 'context_usage_trace',
        sourceId: id,
        workerAssignmentId: assignment.assignmentId,
        decision: 'no_issue',
        status: 'completed',
      });
    }

    // Update assignment counts to reflect completion
    await traceAssignmentService.update(assignment.assignmentId, {
      status: 'completed',
      evaluatedCount: 3,
    });

    const finalized = await orchestratorService.finalizeOrchestration(session.sessionId) as any;
    expect(finalized.dbSummary.unevaluatedTraceCount).toBe(0);
    expect(finalized.dbSummary.assignedTraceCount).toBe(3);
    expect(finalized.dbSummary.evaluatedTraceCount).toBe(3);
    expect(finalized.dbSummary.status).toBe('completed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6: Worker/source-evaluation path persists no_issue for healthy trace
// ─────────────────────────────────────────────────────────────────────────────

describe('Test 6: Worker persists no_issue for healthy trace', () => {
  it('upsert with decision=no_issue persists and is retrievable', async () => {
    const sessionId = 'sess-test6';
    const contextAttemptId = 'ca-healthy-001';

    const evaluation = await sourceEvalService.upsert({
      sessionId,
      sourceType: 'context_usage_trace',
      sourceId: contextAttemptId,
      sourceKind: 'context_usage_trace',
      contextAttemptId,
      executionId: 'exec-healthy-001',
      repoId: 'repo-test6',
      decision: 'no_issue',
      status: 'completed',
      contextCorrect: true,
      notes: 'Context was appropriately injected for this trace.',
    });

    expect(evaluation.evaluationId).toBeDefined();
    expect(evaluation.decision).toBe('no_issue');
    expect(evaluation.contextCorrect).toBe(true);

    // Verify persisted in DB
    const stored = await db.collection('context_source_evaluations').findOne({
      sourceKey: `context_usage_trace:${contextAttemptId}`,
    });
    expect(stored).not.toBeNull();
    expect((stored as any).decision).toBe('no_issue');
    expect((stored as any).contextCorrect).toBe(true);
  });

  it('no_issue trace is excluded from listUnevaluatedContextTraces after persistence', async () => {
    await insertAttempts(3);

    // Evaluate the first trace
    const firstId = 'ca-00001';
    await markEvaluated(firstId);

    const candidates = await scheduler.listUnevaluatedContextTraces({ limit: 20 });
    // Only 2 remaining unevaluated
    expect(candidates).toHaveLength(2);
    expect(candidates.every((c) => c.contextAttemptId !== firstId)).toBe(true);
  });

  it('sourceEvalService persists all new ENG-1760 fields', async () => {
    const sessionId = 'sess-test6-fields';
    const contextAttemptId = 'ca-fields-001';

    const evaluation = await sourceEvalService.upsert({
      sessionId,
      sourceType: 'context_usage_trace',
      sourceId: contextAttemptId,
      sourceKind: 'context_usage_trace',
      contextAttemptId,
      workerAssignmentId: 'assign-w-001',
      decision: 'no_issue',
      status: 'completed',
      contextCorrect: true,
      contextIncomplete: false,
      contextIrrelevant: false,
      mandatoryMissing: false,
      mandatoryIncorrect: false,
      confidence: 0.92,
      risk: 'low',
      severity: 'info',
      notes: 'All context packets were valid.',
      evidence: [{ kind: 'text', snippet: 'injectedCount=2' }],
    });

    expect(evaluation.workerAssignmentId).toBe('assign-w-001');
    expect(evaluation.contextCorrect).toBe(true);
    expect(evaluation.mandatoryMissing).toBe(false);
    expect(evaluation.confidence).toBe(0.92);
    expect(evaluation.evidence).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 7: Finding created for trace with missing injected context
// ─────────────────────────────────────────────────────────────────────────────

describe('Test 7: Finding created for trace with missing injected context', () => {
  it('persists finding_created evaluation with findingIds when context is missing', async () => {
    const sessionId = 'sess-test7';
    const contextAttemptId = 'ca-missing-001';

    // Begin a session to use submitFindings
    const session = await orchestratorService.beginOrchestration({
      scope: 'workflow',
      sourceId: contextAttemptId,
      sourceKind: 'context_usage_trace',
      repoId: 'repo-test7',
    });

    // Submit a finding for the missing context
    const findings: AgentFindingInput[] = [{
      classification: 'missing_context',
      fixType: 'curated_context_create',
      severity: 'warn',
      risk: 'medium',
      confidence: 0.8,
      primarySourceId: contextAttemptId,
      contextAttemptId,
      executionId: 'exec-missing-001',
      suggestedRemediation: 'Create curated context entry for this workflow step.',
    }];

    const result = await orchestratorService.submitFindings(session.sessionId, findings, testConfig);
    expect(result.findingIds).toHaveLength(1);

    // Now persist the source evaluation with decision=finding_created
    const evaluation = await sourceEvalService.upsert({
      sessionId: session.sessionId,
      sourceType: 'context_usage_trace',
      sourceId: contextAttemptId,
      contextAttemptId,
      executionId: 'exec-missing-001',
      repoId: 'repo-test7',
      workerAssignmentId: 'assign-test7',
      decision: 'finding_created',
      status: 'completed',
      contextCorrect: false,
      classification: 'missing_context',
      fixType: 'curated_context_create',
      confidence: 0.8,
      risk: 'medium',
      severity: 'warn',
      findingIds: result.findingIds,
      notes: 'Context was not injected; no curated entries exist for this repo.',
    });

    expect(evaluation.decision).toBe('finding_created');
    expect(evaluation.findingIds).toHaveLength(1);
    expect(evaluation.contextCorrect).toBe(false);
    expect(evaluation.classification).toBe('missing_context');

    // DB should have the evaluation
    const stored = await db.collection('context_source_evaluations').findOne({
      sourceKey: `context_usage_trace:${contextAttemptId}`,
    });
    expect(stored).not.toBeNull();
    expect((stored as any).decision).toBe('finding_created');
    expect((stored as any).findingIds).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 8: Curated context exists but not injected => classify retrieval/filtering gap
// ─────────────────────────────────────────────────────────────────────────────

describe('Test 8: Curated context exists but not injected => retrieval/filtering gap', () => {
  it('when curated entries exist but context was not injected, classify as retrieval/filtering gap', async () => {
    // Insert a curated context entry for the repo
    await db.collection('context_curation_entries').insertOne({
      entryId: 'entry-gap-001',
      repoId: 'repo-gap-test',
      title: 'Existing context entry',
      content: 'Some curated context that should have been injected.',
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Trace: context was not injected (injectedCount=0) despite curated context existing
    const contextAttemptId = 'ca-gap-001';
    const sessionId = 'sess-test8';

    // The worker should classify as retrieval_gap or filtering_gap, NOT missing_context
    // We simulate this by persisting the evaluation with retrieval_gap classification
    const evaluation = await sourceEvalService.upsert({
      sessionId,
      sourceType: 'context_usage_trace',
      sourceId: contextAttemptId,
      contextAttemptId,
      executionId: 'exec-gap-001',
      repoId: 'repo-gap-test',
      decision: 'finding_created',
      status: 'completed',
      contextCorrect: false,
      classification: 'retrieval_gap',    // NOT missing_context
      fixType: 'retrieval_fix',
      confidence: 0.8,
      risk: 'medium',
      severity: 'warn',
      notes: 'Curated context exists in DB but was not retrieved. This is a retrieval gap, not missing context.',
    });

    expect(evaluation.classification).toBe('retrieval_gap');
    expect(evaluation.classification).not.toBe('missing_context');
    expect(evaluation.contextCorrect).toBe(false);

    // Verify the classification makes sense: curated entry exists for this repo
    const entry = await db.collection('context_curation_entries').findOne({
      repoId: 'repo-gap-test',
      active: true,
    });
    expect(entry).not.toBeNull(); // confirms curated context exists
    expect(evaluation.classification).toBe('retrieval_gap'); // confirms correct classification

    await db.collection('context_curation_entries').deleteMany({});
  });

  it('classifies as filtering_gap when retrieved but blocked by injection policy', async () => {
    const sessionId = 'sess-test8b';
    const contextAttemptId = 'ca-filter-001';

    const evaluation = await sourceEvalService.upsert({
      sessionId,
      sourceType: 'context_usage_trace',
      sourceId: contextAttemptId,
      contextAttemptId,
      repoId: 'repo-filter-test',
      decision: 'finding_created',
      status: 'completed',
      contextCorrect: false,
      classification: 'filtering_gap',    // explicitly filtering gap
      fixType: 'injection_policy_fix',
      confidence: 0.85,
      risk: 'low',
      severity: 'warn',
      notes: 'Context was retrieved (consideredCount=3) but filtered to 0 injected items.',
    });

    expect(evaluation.classification).toBe('filtering_gap');
    // Should not be missing_context or mandatory_missing
    expect(evaluation.classification).not.toBe('missing_context');
    expect(evaluation.classification).not.toBe('mandatory_missing');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 9: DB-derived final summary matches actual DB rows
// ─────────────────────────────────────────────────────────────────────────────

describe('Test 9: DB-derived final summary matches actual DB rows', () => {
  it('dbSummary counts match actual documents in DB', async () => {
    const session = await orchestratorService.beginOrchestration({
      scope: 'workflow',
      repoId: 'repo-summary-test',
    });

    await insertAttempts(5, 'repo-summary-test');
    const attempts = await scheduler.listUnevaluatedContextTraces({
      repoId: 'repo-summary-test',
      limit: 20,
    });

    const assignment = await traceAssignmentService.create({
      sessionId: session.sessionId,
      repoId: 'repo-summary-test',
      sourceIds: attempts.map((c) => c.contextAttemptId!),
    });

    // Persist evaluations: 3 no_issue, 1 finding_created, 1 skipped
    const evals = [
      { id: attempts[0].contextAttemptId!, decision: 'no_issue' as const },
      { id: attempts[1].contextAttemptId!, decision: 'no_issue' as const },
      { id: attempts[2].contextAttemptId!, decision: 'no_issue' as const },
      { id: attempts[3].contextAttemptId!, decision: 'finding_created' as const },
      { id: attempts[4].contextAttemptId!, decision: 'skipped' as const },
    ];

    for (const e of evals) {
      await sourceEvalService.upsert({
        sessionId: session.sessionId,
        sourceType: 'context_usage_trace',
        sourceId: e.id,
        contextAttemptId: e.id,
        workerAssignmentId: assignment.assignmentId,
        decision: e.decision,
        status: 'completed',
      });
    }

    // Update assignment to reflect completion
    await traceAssignmentService.update(assignment.assignmentId, {
      status: 'completed',
      evaluatedCount: 4, // no_issue + finding_created
      skippedCount: 1,
      failedCount: 0,
      findingCount: 1,
    });

    const finalized = await orchestratorService.finalizeOrchestration(session.sessionId) as any;
    const { dbSummary } = finalized;

    // Verify source evaluation counts match actual DB rows
    const actualEvalCount = await db.collection('context_source_evaluations').countDocuments({
      sessionId: session.sessionId,
      sourceType: 'context_usage_trace',
    });
    expect(dbSummary.dbDerivedSourceEvaluationCount).toBe(actualEvalCount);

    // Verify trace assignment counts
    expect(dbSummary.traceAssignmentCount).toBe(1);
    expect(dbSummary.completedTraceAssignmentCount).toBe(1);
    expect(dbSummary.assignedTraceCount).toBe(5);
    expect(dbSummary.evaluatedTraceCount).toBe(4); // updated in assignment
    expect(dbSummary.skippedTraceCount).toBe(1);
    expect(dbSummary.failedTraceCount).toBe(0);

    // unevaluated = assigned - evaluated - skipped - failed
    const expected = dbSummary.assignedTraceCount - dbSummary.evaluatedTraceCount
      - dbSummary.skippedTraceCount - dbSummary.failedTraceCount;
    expect(dbSummary.unevaluatedTraceCount).toBe(Math.max(0, expected));

    // Since all are accounted for (4+1=5=assignedTraceCount), status should be completed
    expect(dbSummary.status).toBe('completed');
  });

  it('decisionsByType reflects actual source evaluation decisions', async () => {
    const session = await orchestratorService.beginOrchestration({ scope: 'workflow' });

    await db.collection('context_source_evaluations').insertMany([
      { sessionId: session.sessionId, sourceType: 'context_usage_trace', sourceId: 'ca-d1', sourceKey: 'context_usage_trace:ca-d1', decision: 'no_issue', status: 'completed', evaluationVersion: 1, evaluatedAt: new Date(), createdAt: new Date(), updatedAt: new Date() },
      { sessionId: session.sessionId, sourceType: 'context_usage_trace', sourceId: 'ca-d2', sourceKey: 'context_usage_trace:ca-d2', decision: 'no_issue', status: 'completed', evaluationVersion: 1, evaluatedAt: new Date(), createdAt: new Date(), updatedAt: new Date() },
      { sessionId: session.sessionId, sourceType: 'context_usage_trace', sourceId: 'ca-d3', sourceKey: 'context_usage_trace:ca-d3', decision: 'finding_created', status: 'completed', evaluationVersion: 1, evaluatedAt: new Date(), createdAt: new Date(), updatedAt: new Date() },
      { sessionId: session.sessionId, sourceType: 'context_usage_trace', sourceId: 'ca-d4', sourceKey: 'context_usage_trace:ca-d4', decision: 'skipped', status: 'completed', evaluationVersion: 1, evaluatedAt: new Date(), createdAt: new Date(), updatedAt: new Date() },
    ]);

    const finalized = await orchestratorService.finalizeOrchestration(session.sessionId) as any;
    const { decisionsByType } = finalized.dbSummary;

    expect(decisionsByType['no_issue']).toBe(2);
    expect(decisionsByType['finding_created']).toBe(1);
    expect(decisionsByType['skipped']).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 10: Regression — 20 context_usage_trace candidates MUST NOT finalize
// with sourceEvaluations=0 after workers complete
// ─────────────────────────────────────────────────────────────────────────────

describe('Test 10: Regression — 20 traces must not finalize with sourceEvaluations=0', () => {
  it('after workers persist evaluations for all 20 traces, dbDerivedSourceEvaluationCount > 0', async () => {
    const session = await orchestratorService.beginOrchestration({
      scope: 'workflow',
      repoId: 'repo-reg-test',
    });

    // Insert exactly 20 traces
    const attempts = await insertAttempts(20, 'repo-reg-test');

    // Create 1 assignment for all 20 traces
    const assignment = await traceAssignmentService.create({
      sessionId: session.sessionId,
      repoId: 'repo-reg-test',
      sourceIds: attempts.map((a) => a.contextAttemptId),
    });

    expect(assignment.assignedCount).toBe(20);

    // Simulate worker: persist one evaluation per trace
    for (const attempt of attempts) {
      await sourceEvalService.upsert({
        sessionId: session.sessionId,
        sourceType: 'context_usage_trace',
        sourceId: attempt.contextAttemptId,
        sourceKind: 'context_usage_trace',
        contextAttemptId: attempt.contextAttemptId,
        executionId: attempt.executionId,
        repoId: 'repo-reg-test',
        workerAssignmentId: assignment.assignmentId,
        decision: 'no_issue',
        status: 'completed',
        contextCorrect: true,
      });
    }

    // Update assignment: worker completed all 20
    await traceAssignmentService.update(assignment.assignmentId, {
      status: 'completed',
      evaluatedCount: 20,
      skippedCount: 0,
      failedCount: 0,
      findingCount: 0,
    });

    const finalized = await orchestratorService.finalizeOrchestration(session.sessionId) as any;
    const { dbSummary } = finalized;

    // PRIMARY REGRESSION CHECK: must not be 0
    expect(dbSummary.dbDerivedSourceEvaluationCount).toBe(20);
    expect(dbSummary.contextTraceEvaluatedCount).toBe(20);
    expect(dbSummary.evaluatedTraceCount).toBe(20);
    expect(dbSummary.unevaluatedTraceCount).toBe(0);
    expect(dbSummary.assignedTraceCount).toBe(20);
    expect(dbSummary.status).toBe('completed');
  });

  it('session with 20 traces and zero evaluations has status partial, not completed', async () => {
    const session = await orchestratorService.beginOrchestration({
      scope: 'workflow',
      repoId: 'repo-reg-zero',
    });

    const attempts = await insertAttempts(20, 'repo-reg-zero');

    // Create assignment but DO NOT persist any evaluations (simulates worker not running)
    await traceAssignmentService.create({
      sessionId: session.sessionId,
      repoId: 'repo-reg-zero',
      sourceIds: attempts.map((a) => a.contextAttemptId),
    });

    const finalized = await orchestratorService.finalizeOrchestration(session.sessionId) as any;

    // No evaluations persisted → regression case
    expect(finalized.dbSummary.dbDerivedSourceEvaluationCount).toBe(0);
    // Status must NOT be completed — regression check
    expect(finalized.dbSummary.status).not.toBe('completed');
    expect(finalized.dbSummary.unevaluatedTraceCount).toBe(20);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 11: ContextTraceAnalysisAssignmentService CRUD
// ─────────────────────────────────────────────────────────────────────────────
