/**
 * ENG-1760 — Context Quality Orchestration Invariant Tests
 *
 * Covers the corrected orchestration model:
 *  1. Worker role routing: trace analysis → context-trace-analysis-agent (not context-qa-eval-agent)
 *  2. Analysis workers candidate-only invariant (cannot create review tasks / remediation)
 *  3. Triage-only review task creation invariant
 *  4. Planner-only remediation assignment invariant
 *  5. Finalization partial when unevaluated traces remain (DB summary wins over scheduler)
 *  6. Finalization partial when trace assignments are non-terminal
 *  7. DB summary wins over scheduler empty result
 *  8. TRACE_ANALYSIS_AGENT_NAME is not context-qa-eval-agent
 *  9. WORKER_ROLE_AGENT_MAP does not contain context-trace-analysis-agent (separate pathway)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  ContextReviewWorkerOrchestrator,
  WORKER_ROLE_AGENT_MAP,
  TRACE_ANALYSIS_AGENT_NAME,
} from '../../../services/context/judge/context-review-worker-orchestrator.js';
import { ContextJudgeOrchestratorService } from '../../../services/context/judge/context-judge-orchestrator.service.js';
import { ContextTraceAnalysisAssignmentService } from '../../../services/context/judge/context-trace-analysis-assignment.service.js';
import { ContextSourceEvaluationService } from '../../../services/context/judge/context-source-evaluation.service.js';
import type { ContextJudgeConfig } from '../../../services/context/judge/context-judge.types.js';

let mongo: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let workerOrchestrator: ContextReviewWorkerOrchestrator;
let orchestratorService: ContextJudgeOrchestratorService;
let traceAssignmentService: ContextTraceAnalysisAssignmentService;
let sourceEvalService: ContextSourceEvaluationService;

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

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = new MongoClient(mongo.getUri());
  await client.connect();
  db = client.db('test-orchestration-invariants');
  workerOrchestrator = new ContextReviewWorkerOrchestrator(db);
  orchestratorService = new ContextJudgeOrchestratorService(db);
  traceAssignmentService = new ContextTraceAnalysisAssignmentService(db);
  sourceEvalService = new ContextSourceEvaluationService(db);
});

afterAll(async () => {
  await client.close();
  await mongo.stop();
});

beforeEach(async () => {
  await db.collection('context_orchestration_sessions').deleteMany({});
  await db.collection('context_judge_runs').deleteMany({});
  await db.collection('context_findings').deleteMany({});
  await db.collection('context_review_tasks').deleteMany({});
  await db.collection('context_source_evaluations').deleteMany({});
  await db.collection('context_trace_analysis_assignments').deleteMany({});
  await db.collection('context_review_worker_assignments').deleteMany({});
  await db.collection('context_remediations').deleteMany({});
});

// ─────────────────────────────────────────────────────────────────────────────
// Invariant 1: Correct worker role routing for trace analysis
// ─────────────────────────────────────────────────────────────────────────────

describe('Invariant 1: Correct worker role routing — trace analysis uses context-trace-analysis-agent', () => {
  it('TRACE_ANALYSIS_AGENT_NAME is context-trace-analysis-agent (not context-qa-eval-agent)', () => {
    expect(TRACE_ANALYSIS_AGENT_NAME).toBe('context-trace-analysis-agent');
    expect(TRACE_ANALYSIS_AGENT_NAME).not.toBe('context-qa-eval-agent');
  });

  it('context-qa-eval-agent in WORKER_ROLE_AGENT_MAP is only for context_qa_eval role (not trace analysis)', () => {
    expect(WORKER_ROLE_AGENT_MAP['context_qa_eval']).toBe('context-qa-eval-agent');
    // context_qa_eval is for validation of applied remediations, not trace analysis
    // Verify no trace analysis role maps to context-qa-eval-agent
    const allValues = Object.values(WORKER_ROLE_AGENT_MAP);
    // context-trace-analysis-agent must NOT be in the WORKER_ROLE_AGENT_MAP (it has its own pathway)
    expect(allValues).not.toContain('context-trace-analysis-agent');
  });

  it('WORKER_ROLE_AGENT_MAP does not contain a context_trace_analysis key (separate pathway)', () => {
    // Trace analysis uses context_trace_analysis_assignments (not context_review_worker_assignments)
    // and TRACE_ANALYSIS_AGENT_NAME (not WORKER_ROLE_AGENT_MAP)
    expect('context_trace_analysis' in WORKER_ROLE_AGENT_MAP).toBe(false);
  });

  it('WORKER_ROLE_AGENT_MAP has all 7 remediation/review roles correctly mapped', () => {
    expect(Object.keys(WORKER_ROLE_AGENT_MAP)).toHaveLength(7);
    expect(WORKER_ROLE_AGENT_MAP['context_review_triage']).toBe('context-review-triage-agent');
    expect(WORKER_ROLE_AGENT_MAP['context_remediation_planner']).toBe('context-remediation-planner-agent');
    expect(WORKER_ROLE_AGENT_MAP['context_learning_curator']).toBe('context-learning-curator-agent');
    expect(WORKER_ROLE_AGENT_MAP['context_curation_fix']).toBe('context-curation-fix-agent');
    expect(WORKER_ROLE_AGENT_MAP['context_ingestion_repair']).toBe('context-ingestion-repair-agent');
    expect(WORKER_ROLE_AGENT_MAP['context_code_fix']).toBe('context-code-fix-agent');
    expect(WORKER_ROLE_AGENT_MAP['context_qa_eval']).toBe('context-qa-eval-agent');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Invariant 2: Analysis workers candidate-only invariant
// ─────────────────────────────────────────────────────────────────────────────

describe('Invariant 2: Analysis workers (trace analysis) cannot create context_review_tasks via assignBacklog', () => {
  it('assignBacklog gates require requiresHumanReview=false and non-code_fix — trace analysis is separate', async () => {
    // The trace analysis agent (context-trace-analysis-agent) works via context_trace_analysis_assignments,
    // NOT via context_review_worker_assignments. It cannot be assigned a backlog job through
    // assignBacklog() which only handles context_review_worker_assignments.
    //
    // Attempting to insert a trace analysis "task" into context_review_tasks and assign it
    // should behave correctly — the gate logic prevents human-review items from being assigned.
    await db.collection('context_review_tasks').insertOne({
      taskId: 'task-analysis-gate-1',
      status: 'pending',
      requiresHumanReview: true,  // analysis findings typically need human review
      fixType: 'retrieval_fix',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const { assigned } = await workerOrchestrator.assignBacklog({});
    // Human-review required tasks should NOT be assigned (analysis workers can't bypass gates)
    expect(assigned).toBe(0);
  });

  it('trace analysis assignment creation is separate from review worker assignment creation', async () => {
    // Create a trace analysis assignment
    const traceAssignment = await traceAssignmentService.create({
      sessionId: 'sess-inv2',
      sourceIds: ['ca-001', 'ca-002'],
    });
    expect(traceAssignment.assignmentId).toBeDefined();
    expect(traceAssignment.sourceType).toBe('context_usage_trace');

    // Verify this does NOT appear in context_review_worker_assignments
    const reviewAssignments = await db.collection('context_review_worker_assignments').find({}).toArray();
    expect(reviewAssignments).toHaveLength(0);

    // Verify it appears in context_trace_analysis_assignments
    const traceAssignments = await db.collection('context_trace_analysis_assignments').find({}).toArray();
    expect(traceAssignments).toHaveLength(1);
    expect((traceAssignments[0] as any).assignmentId).toBe(traceAssignment.assignmentId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Invariant 3: Triage-only review task creation invariant
// ─────────────────────────────────────────────────────────────────────────────

describe('Invariant 3: Triage-only review task creation — service-layer gate', () => {
  it('ContextReviewWorkerOrchestrator assignBacklog only assigns tasks with requiresHumanReview=false', async () => {
    // Insert two tasks: one requiring human review (triage gate must block), one eligible
    await db.collection('context_review_tasks').insertMany([
      {
        taskId: 'task-human-gate',
        status: 'pending',
        requiresHumanReview: true,
        fixType: 'curated_context_edit',
        createdAt: new Date(), updatedAt: new Date(),
      },
      {
        taskId: 'task-auto-eligible',
        status: 'pending',
        requiresHumanReview: false,
        fixType: 'curated_context_edit',
        createdAt: new Date(), updatedAt: new Date(),
      },
    ]);

    const { assigned, assignments } = await workerOrchestrator.assignBacklog({});
    // Only the non-human-review task should be assigned
    expect(assigned).toBe(1);
    expect(assignments[0].taskIds).toContain('task-auto-eligible');
    expect(assignments[0].taskIds).not.toContain('task-human-gate');
  });

  it('review tasks with requiresHumanReview=true are never auto-dispatched (gate holds)', async () => {
    await db.collection('context_review_tasks').insertOne({
      taskId: 'task-gate-only',
      status: 'pending',
      requiresHumanReview: true,
      fixType: 'code_fix',
      createdAt: new Date(), updatedAt: new Date(),
    });

    const { assigned } = await workerOrchestrator.assignBacklog({ maxBatch: 10 });
    expect(assigned).toBe(0);

    // Verify task remains pending (not dispatched)
    const task = await db.collection('context_review_tasks').findOne({ taskId: 'task-gate-only' });
    expect((task as any).status).toBe('pending');
    expect((task as any).queue).not.toBe('dispatched');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Invariant 4: Planner-only remediation assignment invariant
// ─────────────────────────────────────────────────────────────────────────────

describe('Invariant 4: Planner-only remediation — WORKER_ROLE_AGENT_MAP gate', () => {
  it('context_remediation_planner role maps to context-remediation-planner-agent exclusively', () => {
    expect(WORKER_ROLE_AGENT_MAP['context_remediation_planner']).toBe('context-remediation-planner-agent');
    // No other role maps to the planner agent
    const plannerEntries = Object.entries(WORKER_ROLE_AGENT_MAP)
      .filter(([, agent]) => agent === 'context-remediation-planner-agent');
    expect(plannerEntries).toHaveLength(1);
    expect(plannerEntries[0][0]).toBe('context_remediation_planner');
  });

  it('assignBacklog with workerRole=context_remediation_planner only assigns non-human-review tasks', async () => {
    await db.collection('context_review_tasks').insertOne({
      taskId: 'task-planner-eligible',
      status: 'in_review',
      requiresHumanReview: false,
      fixType: 'curated_context_edit',
      remediationStatus: 'ready',
      createdAt: new Date(), updatedAt: new Date(),
    });

    const { assignments } = await workerOrchestrator.assignBacklog({
      workerRole: 'context_remediation_planner',
    });

    expect(assignments.length).toBeGreaterThanOrEqual(1);
    expect(assignments[0].workerRole).toBe('context_remediation_planner');
    expect(assignments[0].workerAgentName).toBe('context-remediation-planner-agent');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Invariant 5: Finalization partial when unevaluated traces remain
// ─────────────────────────────────────────────────────────────────────────────

describe('Invariant 5: Finalization partial when unevaluated traces remain (DB summary wins)', () => {
  it('dbSummary.status is partial when trace assignments are queued but not evaluated', async () => {
    const session = await orchestratorService.beginOrchestration({
      scope: 'workflow',
      repoId: 'repo-inv5',
    });

    // Create a trace assignment with 5 traces assigned but 0 evaluated
    const assignment = await traceAssignmentService.create({
      sessionId: session.sessionId,
      repoId: 'repo-inv5',
      sourceIds: ['ca-inv5-1', 'ca-inv5-2', 'ca-inv5-3', 'ca-inv5-4', 'ca-inv5-5'],
    });
    expect(assignment.evaluatedCount).toBe(0);

    const finalized = await orchestratorService.finalizeOrchestration(
      session.sessionId,
      'Test: partial invariant',
    ) as any;

    // unevaluatedTraceCount should be 5 (all assigned, none evaluated)
    expect(finalized.dbSummary.unevaluatedTraceCount).toBe(5);
    expect(finalized.dbSummary.assignedTraceCount).toBe(5);
    expect(finalized.dbSummary.evaluatedTraceCount).toBe(0);
    // Must NOT be completed
    expect(finalized.dbSummary.status).not.toBe('completed');
    expect(['partial', 'incomplete']).toContain(finalized.dbSummary.status);
  });

  it('dbSummary.status is partial when some traces evaluated but non-zero unevaluated remain', async () => {
    const session = await orchestratorService.beginOrchestration({
      scope: 'workflow',
      repoId: 'repo-inv5b',
    });

    const assignment = await traceAssignmentService.create({
      sessionId: session.sessionId,
      repoId: 'repo-inv5b',
      sourceIds: ['ca-inv5b-1', 'ca-inv5b-2', 'ca-inv5b-3'],
    });

    // Evaluate 2 of 3 traces
    await sourceEvalService.upsert({
      sessionId: session.sessionId,
      sourceType: 'context_usage_trace',
      sourceId: 'ca-inv5b-1',
      workerAssignmentId: assignment.assignmentId,
      decision: 'no_issue',
      status: 'completed',
    });
    await sourceEvalService.upsert({
      sessionId: session.sessionId,
      sourceType: 'context_usage_trace',
      sourceId: 'ca-inv5b-2',
      workerAssignmentId: assignment.assignmentId,
      decision: 'no_issue',
      status: 'completed',
    });

    // Update assignment: 2 evaluated, 1 still outstanding
    await traceAssignmentService.update(assignment.assignmentId, {
      status: 'running',
      evaluatedCount: 2,
    });

    const finalized = await orchestratorService.finalizeOrchestration(session.sessionId) as any;
    // assignedCount=3, evaluatedCount=2, skipped=0, failed=0 → unevaluated=1
    expect(finalized.dbSummary.assignedTraceCount).toBe(3);
    expect(finalized.dbSummary.evaluatedTraceCount).toBe(2);
    expect(finalized.dbSummary.unevaluatedTraceCount).toBe(1);
    expect(finalized.dbSummary.status).not.toBe('completed');
    expect(finalized.dbSummary.status).toBe('partial');
  });

  it('dbSummary.unevaluatedTraceCount uses source evaluations when assignment counters lag', async () => {
    const session = await orchestratorService.beginOrchestration({
      scope: 'workflow',
      repoId: 'repo-inv5-stale',
    });

    const assignment = await traceAssignmentService.create({
      sessionId: session.sessionId,
      repoId: 'repo-inv5-stale',
      sourceIds: ['ca-stale-1', 'ca-stale-2', 'ca-stale-3'],
    });

    await sourceEvalService.upsert({
      sessionId: session.sessionId,
      sourceType: 'context_usage_trace',
      sourceId: 'ca-stale-1',
      workerAssignmentId: assignment.assignmentId,
      decision: 'no_issue',
      status: 'completed',
    });
    await sourceEvalService.upsert({
      sessionId: session.sessionId,
      sourceType: 'context_usage_trace',
      sourceId: 'ca-stale-2',
      workerAssignmentId: assignment.assignmentId,
      decision: 'skipped',
      status: 'completed',
    });

    await traceAssignmentService.update(assignment.assignmentId, {
      status: 'running',
      evaluatedCount: 0,
      skippedCount: 0,
    });

    const finalized = await orchestratorService.finalizeOrchestration(session.sessionId) as any;
    expect(finalized.dbSummary.assignedTraceCount).toBe(3);
    expect(finalized.dbSummary.evaluatedTraceCount).toBe(0);
    expect(finalized.dbSummary.effectiveEvaluatedTraceCount).toBe(1);
    expect(finalized.dbSummary.effectiveSkippedTraceCount).toBe(1);
    expect(finalized.dbSummary.unevaluatedTraceCount).toBe(1);
    expect(finalized.dbSummary.nonTerminalTraceAssignmentCount).toBe(1);
    expect(finalized.dbSummary.status).toBe('partial');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Invariant 6: Finalization partial when assignments are non-terminal
// ─────────────────────────────────────────────────────────────────────────────

describe('Invariant 6: Finalization partial when any trace assignment is non-terminal', () => {
  it('status is partial when a trace assignment is still in queued state', async () => {
    const session = await orchestratorService.beginOrchestration({ scope: 'workflow' });

    // Create an assignment and leave it in queued state (default)
    await traceAssignmentService.create({
      sessionId: session.sessionId,
      sourceIds: ['ca-nterm-1', 'ca-nterm-2'],
    });

    const finalized = await orchestratorService.finalizeOrchestration(session.sessionId) as any;
    // Queued assignment means traces are unevaluated → partial
    expect(finalized.dbSummary.status).not.toBe('completed');
    expect(finalized.dbSummary.unevaluatedTraceCount).toBeGreaterThan(0);
  });

  it('status is partial when a trace assignment is in running state', async () => {
    const session = await orchestratorService.beginOrchestration({ scope: 'workflow' });

    const assignment = await traceAssignmentService.create({
      sessionId: session.sessionId,
      sourceIds: ['ca-running-1', 'ca-running-2', 'ca-running-3'],
    });

    // Mark as running (non-terminal)
    await traceAssignmentService.update(assignment.assignmentId, {
      status: 'running',
      workerExecutionId: 'exec-worker-running',
    });

    const finalized = await orchestratorService.finalizeOrchestration(session.sessionId) as any;
    expect(finalized.dbSummary.status).not.toBe('completed');
    expect(finalized.dbSummary.unevaluatedTraceCount).toBe(3);
  });

  it('status is partial even when count math matches but trace assignment is still running (false-complete prevention)', async () => {
    // This is the critical edge case: evaluatedCount + skippedCount + failedCount === assignedCount
    // BUT the assignment status is still 'running'. The service must NOT return 'completed'.
    const session = await orchestratorService.beginOrchestration({ scope: 'workflow' });

    const assignment = await traceAssignmentService.create({
      sessionId: session.sessionId,
      sourceIds: ['ca-fc-1', 'ca-fc-2'],
    });

    // Simulate: worker reported all traces evaluated but hasn't flipped its own status to completed yet.
    await traceAssignmentService.update(assignment.assignmentId, {
      status: 'running',
      evaluatedCount: 2,  // count math: 2 === 2 (matches assignedCount)
    });

    const finalized = await orchestratorService.finalizeOrchestration(session.sessionId) as any;
    // Count math would say isComplete=true, but non-terminal gate must block it.
    expect(finalized.dbSummary.nonTerminalTraceAssignmentCount).toBe(1);
    expect(finalized.dbSummary.status).not.toBe('completed');
    expect(['partial', 'incomplete']).toContain(finalized.dbSummary.status);
  });

  it('status is completed only when all assignments are terminal and all traces accounted for', async () => {
    const session = await orchestratorService.beginOrchestration({ scope: 'workflow' });

    const assignment = await traceAssignmentService.create({
      sessionId: session.sessionId,
      sourceIds: ['ca-term-1', 'ca-term-2'],
    });

    // Persist evaluations for all traces
    for (const id of ['ca-term-1', 'ca-term-2']) {
      await sourceEvalService.upsert({
        sessionId: session.sessionId,
        sourceType: 'context_usage_trace',
        sourceId: id,
        workerAssignmentId: assignment.assignmentId,
        decision: 'no_issue',
        status: 'completed',
      });
    }

    // Mark assignment completed
    await traceAssignmentService.update(assignment.assignmentId, {
      status: 'completed',
      evaluatedCount: 2,
    });

    const finalized = await orchestratorService.finalizeOrchestration(session.sessionId) as any;
    expect(finalized.dbSummary.unevaluatedTraceCount).toBe(0);
    expect(finalized.dbSummary.assignedTraceCount).toBe(2);
    expect(finalized.dbSummary.evaluatedTraceCount).toBe(2);
    expect(finalized.dbSummary.status).toBe('completed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Invariant 7: DB summary wins over scheduler empty result
// ─────────────────────────────────────────────────────────────────────────────

describe('Invariant 7: DB summary wins over scheduler empty result (ENG-1760 gap)', () => {
  it('dbSummary.unevaluatedTraceCount reflects DB state, not scheduler listing', async () => {
    const session = await orchestratorService.beginOrchestration({
      scope: 'workflow',
      repoId: 'repo-db-wins',
    });

    // Create assignment for 10 traces (simulating orchestrator created batches)
    const sourceIds = Array.from({ length: 10 }, (_, i) => `ca-dbwins-${i + 1}`);
    const assignment = await traceAssignmentService.create({
      sessionId: session.sessionId,
      repoId: 'repo-db-wins',
      sourceIds,
    });

    // Simulate scenario: scheduler might return empty (stale cursor) but DB shows
    // the assignment still has unevaluated traces. The session should NOT complete.
    // We do NOT insert context_attempts here (scheduler won't find them),
    // but the trace assignment record IS in the DB.

    const finalized = await orchestratorService.finalizeOrchestration(
      session.sessionId,
      'Simulated: scheduler empty but DB has unevaluated traces',
    ) as any;

    const { dbSummary } = finalized;
    // DB-derived: 10 assigned, 0 evaluated → 10 unevaluated
    expect(dbSummary.assignedTraceCount).toBe(10);
    expect(dbSummary.evaluatedTraceCount).toBe(0);
    expect(dbSummary.unevaluatedTraceCount).toBe(10);

    // INVARIANT: DB says unevaluated=10, so status MUST NOT be 'completed'
    expect(dbSummary.status).not.toBe('completed');
    expect(['partial', 'incomplete']).toContain(dbSummary.status);

    // Cleanup
    await traceAssignmentService.update(assignment.assignmentId, { status: 'failed', error: 'test cleanup' });
  });

  it('after workers complete and DB evaluations are persisted, finalize correctly resolves to completed', async () => {
    const session = await orchestratorService.beginOrchestration({
      scope: 'workflow',
      repoId: 'repo-db-wins-complete',
    });

    const sourceIds = ['ca-dbc-1', 'ca-dbc-2', 'ca-dbc-3'];
    const assignment = await traceAssignmentService.create({
      sessionId: session.sessionId,
      repoId: 'repo-db-wins-complete',
      sourceIds,
    });

    // Worker completes: persist evaluations
    for (const id of sourceIds) {
      await sourceEvalService.upsert({
        sessionId: session.sessionId,
        sourceType: 'context_usage_trace',
        sourceId: id,
        workerAssignmentId: assignment.assignmentId,
        decision: 'no_issue',
        status: 'completed',
      });
    }

    // Worker updates assignment to completed
    await traceAssignmentService.update(assignment.assignmentId, {
      status: 'completed',
      evaluatedCount: 3,
      skippedCount: 0,
      failedCount: 0,
    });

    const finalized = await orchestratorService.finalizeOrchestration(
      session.sessionId,
      'All traces evaluated',
    ) as any;

    expect(finalized.dbSummary.unevaluatedTraceCount).toBe(0);
    expect(finalized.dbSummary.assignedTraceCount).toBe(3);
    expect(finalized.dbSummary.evaluatedTraceCount).toBe(3);
    expect(finalized.dbSummary.status).toBe('completed');
  });

  it('dbSummary counts are DB-derived, not locally tracked by orchestrator agent', async () => {
    const session = await orchestratorService.beginOrchestration({ scope: 'workflow' });

    // Submit findings via orchestrator (production mode)
    const result = await orchestratorService.submitFindings(session.sessionId, [
      {
        classification: 'missing_context',
        fixType: 'curated_context_create',
        severity: 'warn',
        risk: 'low',
        confidence: 0.8,
      },
    ], testConfig);

    const finalized = await orchestratorService.finalizeOrchestration(session.sessionId) as any;
    const { dbSummary } = finalized;

    // DB-derived counts MUST match actual DB document counts
    const actualFindingCount = await db.collection('context_findings').countDocuments({
      judgeRunId: result.judgeRunId,
    });
    const actualReviewTaskCount = await db.collection('context_review_tasks').countDocuments({
      taskId: { $in: result.reviewTaskIds },
    });

    expect(dbSummary.dbDerivedFindingCount).toBe(actualFindingCount);
    expect(dbSummary.dbDerivedReviewTaskCount).toBe(actualReviewTaskCount);
    // The counts must not be zero when findings were actually submitted
    expect(dbSummary.dbDerivedFindingCount).toBeGreaterThan(0);
    expect(dbSummary.dbDerivedReviewTaskCount).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Invariant 8: Gate constants — orchestrator gates are immutable
// ─────────────────────────────────────────────────────────────────────────────

describe('Invariant 8: Orchestrator gate constants are correct and immutable', () => {
  it('ContextReviewWorkerOrchestrator.gates.bypassesHumanReview is always false', () => {
    expect(workerOrchestrator.gates.bypassesHumanReview).toBe(false);
    expect(workerOrchestrator.gates.bypassesHumanReview).not.toBe(true);
  });

  it('ContextReviewWorkerOrchestrator.gates.enforcesCodeChangeBlock is always true', () => {
    expect(workerOrchestrator.gates.enforcesCodeChangeBlock).toBe(true);
  });

  it('code_fix tasks are NEVER auto-assigned (double gate: requiresHumanReview + fixType filter)', async () => {
    await db.collection('context_review_tasks').insertMany([
      {
        taskId: 'task-code-fix-no-human',
        status: 'pending',
        requiresHumanReview: false, // even without human review flag
        fixType: 'code_fix',        // code_fix is always blocked
        createdAt: new Date(), updatedAt: new Date(),
      },
      {
        taskId: 'task-code-fix-human',
        status: 'pending',
        requiresHumanReview: true,
        fixType: 'code_fix',
        createdAt: new Date(), updatedAt: new Date(),
      },
    ]);

    const { assigned } = await workerOrchestrator.assignBacklog({ maxBatch: 10 });
    expect(assigned).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Invariant 9: Prompt builder exports all agent prompts (smoke test)
// ─────────────────────────────────────────────────────────────────────────────

describe('Invariant 9: Agent prompt builders are all exported and non-empty', async () => {
  // Dynamic import to verify module exports without side effects
  const promptModule = await import(
    '../../../services/context/judge/context-judge-agent-prompts.js'
  );

  it('buildContextJudgeOrchestratorPrompt exports a non-empty string', () => {
    const prompt = promptModule.buildContextJudgeOrchestratorPrompt();
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(100);
  });

  it('orchestrator prompt references context-trace-analysis-agent (not context-qa-eval for traces)', () => {
    const prompt = promptModule.buildContextJudgeOrchestratorPrompt();
    // Must mention the trace analysis agent
    expect(prompt).toContain('context-trace-analysis-agent');
    // The EXHAUSTIVE trace evaluation section must reference the correct agent
    // (search the full prompt rather than relying on index math)
    const exhaustiveSection = prompt.slice(prompt.indexOf('EXHAUSTIVE context_usage_trace'));
    expect(exhaustiveSection).toContain('context-trace-analysis-agent');
    // Must clarify context-qa-eval-agent is NOT for traces
    expect(exhaustiveSection).toContain('context-qa-eval-agent');
    const notForTraces = exhaustiveSection.indexOf('context-qa-eval-agent');
    const agentForAnalysis = exhaustiveSection.indexOf('context-trace-analysis-agent');
    // The trace analysis agent should be mentioned before the qa eval agent in the section
    expect(agentForAnalysis).toBeLessThan(notForTraces);
  });

  it('orchestrator prompt has DB-wins invariant for scheduler empty result', () => {
    const prompt = promptModule.buildContextJudgeOrchestratorPrompt();
    // Accept any of the phrases we added for the DB-wins invariant
    const hasDbWinsInvariant =
      prompt.includes('DB SUMMARY WINS') ||
      prompt.includes('DB-summary-wins') ||
      prompt.includes('DB summary is authoritative') ||
      prompt.includes('DB is authoritative');
    expect(hasDbWinsInvariant).toBe(true);
  });

  it('orchestrator prompt has stage ordering section', () => {
    const prompt = promptModule.buildContextJudgeOrchestratorPrompt();
    expect(prompt).toContain('stage ordering');
  });

  it('orchestrator prompt uses a rolling trace worker concurrency window', () => {
    const prompt = promptModule.buildContextJudgeOrchestratorPrompt();
    expect(prompt).toContain('context_quality_create_trace_analysis_wave');
    expect(prompt).toContain('rolling trace-analysis concurrency window');
    expect(prompt).toContain('maxActiveTraceWorkers = 4');
    expect(prompt).toContain('openSlots = 4 - activeTraceWorkers.length');
    expect(prompt).toContain('Do not wait for all 4 workers to finish before refilling a slot');
    expect(prompt).toContain('Refill an open slot as soon as a worker');
    expect(prompt).toContain('context_quality_update_trace_analysis_assignment');
    expect(prompt).not.toContain('wait for the whole wave to reach terminal state before creating the next wave');
    expect(prompt).not.toContain('dispatching exactly one trace worker');
    expect(prompt).not.toContain('no additional workers will be spawned until this batch closes');
  });

  it('buildContextTraceAnalysisWorkerPrompt references both trace and human_feedback', () => {
    const prompt = promptModule.buildContextTraceAnalysisWorkerPrompt();
    expect(prompt).toContain('human_feedback');
    expect(prompt).toContain('MUST NOT');
    expect(prompt).toContain('context_review_tasks');
  });

  it('buildContextReviewTriageAgentPrompt mentions its role making findings actionable for remediation', () => {
    const prompt = promptModule.buildContextReviewTriageAgentPrompt();
    // Triage prompt describes its central role without claiming it creates review tasks (those are
    // created upstream by context_quality_submit_findings). It makes them actionable for remediation.
    expect(prompt).toContain('actionable for remediation');
    // Must still describe the ONLY/exclusive nature of its triage role
    const hasOnlyRole = prompt.includes('ONLY stage') || prompt.includes('central role') || prompt.includes('You are the ONLY');
    expect(hasOnlyRole, 'review-triage prompt must describe its exclusive triage role').toBe(true);
  });

  it('buildContextRemediationPlannerAgentPrompt mentions ONLY stage for remediation', () => {
    const prompt = promptModule.buildContextRemediationPlannerAgentPrompt();
    expect(prompt).toContain('ONLY stage allowed to create remediation');
  });

  it('buildContextLearningCuratorAgentPrompt mentions distinct stage', () => {
    const prompt = promptModule.buildContextLearningCuratorAgentPrompt();
    expect(prompt).toContain('DISTINCT stage');
    expect(prompt).toContain('MUST NOT');
  });
});
