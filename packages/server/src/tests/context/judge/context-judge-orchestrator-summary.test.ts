// Tests for ContextJudgeOrchestratorService — LLM agent-owned orchestration boundary
// AC-11: orchestrator never performs linear sync side effects
// Uses MongoMemoryServer for in-memory MongoDB isolation.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ContextJudgeOrchestratorService } from '../../../services/context/judge/context-judge-orchestrator.service.js';
import type { AgentFindingInput } from '../../../services/context/judge/context-judge-orchestrator.service.js';
import type { ContextJudgeConfig } from '../../../services/context/judge/context-judge.types.js';

let mongo: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let service: ContextJudgeOrchestratorService;

const testConfig: ContextJudgeConfig = {
  configId: 'singleton',
  autoRemediationEnabled: false,
  autoRemediationThresholds: {
    minConfidence: 0.85,
    maxRisk: 'low',
    allowedFixTypes: [],
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

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = new MongoClient(mongo.getUri());
  await client.connect();
  db = client.db('test-orchestrator');
  service = new ContextJudgeOrchestratorService(db);
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
  await db.collection('context_remediations').deleteMany({});
  await db.collection('context_review_worker_assignments').deleteMany({});
  await db.collection('context_trace_analysis_assignments').deleteMany({});
});

// ─── beginOrchestration ──────────────────────────────────────────────────────

describe('D: runScope vs impactScope — gate behavior', () => {
  it('repo run + impactScope=repo finding does NOT trigger cross-repo/global gate', async () => {
    // Begin a repo-scoped run (scope inferred as 'repo' from repoId)
    const session = await service.beginOrchestration({ scope: 'workflow', repoId: 'repo-gate-test' });

    const findings: AgentFindingInput[] = [
      {
        classification: 'missing_context',
        fixType: 'curated_context_create',
        severity: 'warn',
        risk: 'low',
        confidence: 0.9,
        impactScope: 'repo',  // finding only affects this repo
      },
    ];

    await service.submitFindings(session.sessionId, findings, testConfig);

    const updated = await service.getSession(session.sessionId);
    const gateChecks = updated!.agentDecisionLog.filter((e) => e.kind === 'gate_check');
    // No impactScope-based gate should fire for repo-impact finding
    const crossRepoGates = gateChecks.filter(
      (e) => e.detail.includes('cross_repo') || e.detail.includes('global'),
    );
    expect(crossRepoGates.length).toBe(0);

    // Review task should NOT require human review (low risk, high confidence, repo scope, no code_fix)
    const tasks = await db
      .collection('context_review_tasks')
      .find({ taskId: { $in: updated!.reviewTaskIds } })
      .toArray();
    expect(tasks.every((t) => (t as any).requiresHumanReview === false)).toBe(true);
  });

  it('repo run + impactScope=global finding DOES trigger mandatory human-review gate', async () => {
    // Begin a repo-scoped run
    const session = await service.beginOrchestration({ scope: 'workflow', repoId: 'repo-gate-global' });

    const findings: AgentFindingInput[] = [
      {
        classification: 'missing_context',
        fixType: 'curated_context_create',
        severity: 'warn',
        risk: 'medium',
        confidence: 0.85,
        impactScope: 'global',  // finding affects all repos — gate must trigger
      },
    ];

    await service.submitFindings(session.sessionId, findings, testConfig);

    const updated = await service.getSession(session.sessionId);
    const gateChecks = updated!.agentDecisionLog.filter((e) => e.kind === 'gate_check');
    // A gate_check entry mentioning 'global' must be logged
    const globalGate = gateChecks.find((e) => e.detail.includes('global'));
    expect(globalGate).toBeDefined();

    // Review task MUST require human review because impactScope=global
    const tasks = await db
      .collection('context_review_tasks')
      .find({ taskId: { $in: updated!.reviewTaskIds } })
      .toArray();
    expect(tasks.every((t) => (t as any).requiresHumanReview === true)).toBe(true);
  });

  it('repo run + impactScope=cross_repo finding DOES trigger mandatory human-review gate', async () => {
    const session = await service.beginOrchestration({ scope: 'workflow', repoId: 'repo-gate-xrepo' });

    const findings: AgentFindingInput[] = [
      {
        classification: 'retrieval_gap',
        fixType: 'retrieval_fix',
        severity: 'warn',
        risk: 'medium',
        confidence: 0.85,
        impactScope: 'cross_repo',
      },
    ];

    await service.submitFindings(session.sessionId, findings, testConfig);

    const updated = await service.getSession(session.sessionId);
    const gateChecks = updated!.agentDecisionLog.filter((e) => e.kind === 'gate_check');
    const xRepoGate = gateChecks.find((e) => e.detail.includes('cross_repo'));
    expect(xRepoGate).toBeDefined();

    const tasks = await db
      .collection('context_review_tasks')
      .find({ taskId: { $in: updated!.reviewTaskIds } })
      .toArray();
    expect(tasks.every((t) => (t as any).requiresHumanReview === true)).toBe(true);
  });
});

// ─── E: Traceability persistence through orchestrator flow ────────────────────
// primarySourceId, sourceRefs, and contextAttemptId must survive the
// submitFindings → judge service → stored finding pipeline.

describe('E: traceability fields persist through orchestrator submitFindings', () => {
  it('primarySourceId, sourceRefs, contextAttemptId are stored on findings via orchestrator', async () => {
    const session = await service.beginOrchestration({
      scope: 'workflow',
      sourceId: 'exec-trace-orch',
      sourceKind: 'context_usage_trace',
    });

    const findings: AgentFindingInput[] = [
      {
        classification: 'retrieval_gap',
        fixType: 'retrieval_fix',
        severity: 'warn',
        risk: 'low',
        confidence: 0.8,
        primarySourceId: 'ca-orch-trace-1',
        sourceRefs: ['ca-orch-trace-1', 'ref-secondary'],
        contextAttemptId: 'ca-orch-trace-1',
        executionId: 'exec-trace-orch',
      },
    ];

    const result = await service.submitFindings(session.sessionId, findings, testConfig);
    expect(result.findingIds).toHaveLength(1);

    const stored = await db.collection('context_findings').findOne({ findingId: result.findingIds[0] });
    expect(stored).not.toBeNull();
    expect((stored as any).primarySourceId).toBe('ca-orch-trace-1');
    expect((stored as any).sourceRefs).toEqual(['ca-orch-trace-1', 'ref-secondary']);
    expect((stored as any).contextAttemptId).toBe('ca-orch-trace-1');
    expect((stored as any).executionId).toBe('exec-trace-orch');
  });
});

// ─── F: GAP 4 — Assignment count uses taskIds array shape ─────────────────────
// Worker assignments store taskIds: string[] (array), not taskId: string.
// dbSummary.dbDerivedAssignmentCount must use $in against the array field.

describe('F: GAP 4 — dbSummary assignment count uses taskIds array shape', () => {
  beforeEach(async () => {
    await db.collection('context_review_worker_assignments').deleteMany({});
  });

  it('assignment count is 0 when no assignments exist', async () => {
    const session = await service.beginOrchestration({ scope: 'workflow' });
    const findings = [{ classification: 'missing_context' as any, fixType: 'curated_context_create' as any, severity: 'warn' as any, risk: 'low' as any, confidence: 0.8 }];
    await service.submitFindings(session.sessionId, findings, testConfig);
    const finalized = await service.finalizeOrchestration(session.sessionId) as any;
    expect(finalized.dbSummary.dbDerivedAssignmentCount).toBe(0);
  });

  it('assignment count includes worker assignment that covers session review task IDs (taskIds array)', async () => {
    const session = await service.beginOrchestration({ scope: 'workflow' });
    const findings = [{ classification: 'missing_context' as any, fixType: 'curated_context_create' as any, severity: 'warn' as any, risk: 'low' as any, confidence: 0.8 }];
    await service.submitFindings(session.sessionId, findings, testConfig);

    const updatedSession = await service.getSession(session.sessionId);
    const taskIds = updatedSession!.reviewTaskIds;
    expect(taskIds.length).toBeGreaterThan(0);

    // Insert an assignment using taskIds: string[] (correct shape — GAP 4)
    await db.collection('context_review_worker_assignments').insertOne({
      assignmentId: 'assign-gap4-1',
      taskIds,           // array field, not taskId
      workerRole: 'context_review_triage',
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const finalized = await service.finalizeOrchestration(session.sessionId) as any;
    // Should count the assignment that covers this session's task IDs
    expect(finalized.dbSummary.dbDerivedAssignmentCount).toBe(1);
  });

  it('assignment count is 0 when assignment uses taskId (singular) not taskIds (wrong shape)', async () => {
    const session = await service.beginOrchestration({ scope: 'workflow' });
    const findings = [{ classification: 'missing_context' as any, fixType: 'curated_context_create' as any, severity: 'warn' as any, risk: 'low' as any, confidence: 0.8 }];
    await service.submitFindings(session.sessionId, findings, testConfig);

    const updatedSession = await service.getSession(session.sessionId);
    const taskIds = updatedSession!.reviewTaskIds;

    // Insert a WRONG-shaped assignment (singular taskId field) — should NOT be counted
    await db.collection('context_review_worker_assignments').insertOne({
      assignmentId: 'assign-wrong-shape',
      taskId: taskIds[0],  // wrong shape — singular
      workerRole: 'context_review_triage',
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const finalized = await service.finalizeOrchestration(session.sessionId) as any;
    // The wrong-shape assignment should NOT be counted
    expect(finalized.dbSummary.dbDerivedAssignmentCount).toBe(0);
  });
});

// ─── G: GAP 3+5 — dbSummary source evaluation and remediation counts ──────────

describe('G: GAP 3+5 — dbSummary includes source evaluation and remediation counts', () => {
  beforeEach(async () => {
    await db.collection('context_source_evaluations').deleteMany({});
    await db.collection('context_remediations').deleteMany({});
  });

  it('dbSummary includes source evaluation coverage fields (initially 0)', async () => {
    const session = await service.beginOrchestration({ scope: 'workflow' });
    const finalized = await service.finalizeOrchestration(session.sessionId) as any;

    expect(finalized.dbSummary.dbDerivedSourceEvaluationCount).toBe(0);
    expect(finalized.dbSummary.sourceEvaluationsByType).toBeDefined();
    expect(finalized.dbSummary.sourceEvaluationsByDecision).toBeDefined();
    expect(typeof finalized.dbSummary.contextTraceEvaluatedCount).toBe('number');
    expect(typeof finalized.dbSummary.contextTraceFindingCount).toBe('number');
    expect(typeof finalized.dbSummary.contextTraceNoIssueCount).toBe('number');
  });

  it('dbSummary source evaluation counts reflect entries in context_source_evaluations', async () => {
    const session = await service.beginOrchestration({ scope: 'workflow' });

    // Manually insert source evaluation records for this session
    await db.collection('context_source_evaluations').insertMany([
      {
        evaluationId: 'eval-g-1', sessionId: session.sessionId,
        sourceType: 'context_usage_trace', sourceId: 'ca-g-1', sourceKey: 'context_usage_trace:ca-g-1',
        decision: 'finding_created', status: 'completed', evaluationVersion: 1,
        evaluatedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
      },
      {
        evaluationId: 'eval-g-2', sessionId: session.sessionId,
        sourceType: 'context_usage_trace', sourceId: 'ca-g-2', sourceKey: 'context_usage_trace:ca-g-2',
        decision: 'no_issue', status: 'completed', evaluationVersion: 1,
        evaluatedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
      },
      {
        evaluationId: 'eval-g-3', sessionId: session.sessionId,
        sourceType: 'workflow_run', sourceId: 'exec-g-1', sourceKey: 'workflow_run:exec-g-1',
        decision: 'no_issue', status: 'completed', evaluationVersion: 1,
        evaluatedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
      },
    ]);

    const finalized = await service.finalizeOrchestration(session.sessionId) as any;
    const { dbSummary } = finalized;

    expect(dbSummary.dbDerivedSourceEvaluationCount).toBe(3);
    expect(dbSummary.sourceEvaluationsByType['context_usage_trace']).toBe(2);
    expect(dbSummary.sourceEvaluationsByType['workflow_run']).toBe(1);
    expect(dbSummary.sourceEvaluationsByDecision['finding_created']).toBe(1);
    expect(dbSummary.sourceEvaluationsByDecision['no_issue']).toBe(2);
    expect(dbSummary.contextTraceEvaluatedCount).toBe(2);
    expect(dbSummary.contextTraceFindingCount).toBe(1);
    expect(dbSummary.contextTraceNoIssueCount).toBe(1);
  });

  it('dbSummary includes remediation counts from context_remediations', async () => {
    const session = await service.beginOrchestration({ scope: 'workflow' });
    const findings = [
      { classification: 'missing_context' as any, fixType: 'curated_context_create' as any, severity: 'warn' as any, risk: 'low' as any, confidence: 0.8 },
    ];
    const submitResult = await service.submitFindings(session.sessionId, findings, testConfig);

    // Manually insert a remediation for this judgeRunId
    await db.collection('context_remediations').insertOne({
      remediationId: 'remed-g-1',
      taskId: submitResult.reviewTaskIds[0] ?? 'task-g-1',
      findingId: submitResult.findingIds[0] ?? 'finding-g-1',
      judgeRunId: submitResult.judgeRunId,
      actionKind: 'curated_entry_edit',
      status: 'completed',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const finalized = await service.finalizeOrchestration(session.sessionId) as any;
    expect(finalized.dbSummary.dbDerivedRemediationCount).toBe(1);
    expect(finalized.dbSummary.remediationsByStatus['completed']).toBe(1);
  });

  it('final status is partial when auto-remediation tasks exist but no remediation planner/remediation exists', async () => {
    const session = await service.beginOrchestration({ scope: 'workflow', runScope: 'repo', repoId: 'repo-gate' });
    await service.submitFindings(session.sessionId, [
      {
        classification: 'irrelevant_context' as any,
        fixType: 'filtering_fix' as any,
        severity: 'warn' as any,
        risk: 'low' as any,
        confidence: 0.9,
        impactScope: 'repo',
      },
    ], testConfig);

    await db.collection('context_trace_analysis_assignments').insertOne({
      assignmentId: 'trace-gate-1',
      sessionId: session.sessionId,
      sourceIds: ['ca-gate-1'],
      status: 'completed',
      evaluatedCount: 1,
      skippedCount: 0,
      failedCount: 0,
      findingCount: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: new Date(),
    });
    await db.collection('context_source_evaluations').insertOne({
      evaluationId: 'eval-gate-1',
      sessionId: session.sessionId,
      sourceType: 'context_usage_trace',
      sourceId: 'ca-gate-1',
      sourceKey: 'context_usage_trace:ca-gate-1',
      decision: 'finding_created',
      status: 'completed',
      evaluationVersion: 1,
      evaluatedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const finalized = await service.finalizeOrchestration(session.sessionId) as any;
    expect(finalized.dbSummary.dbDerivedAutoRemediationCount).toBe(1);
    expect(finalized.dbSummary.dbDerivedRemediationPlannerAssignmentCount).toBe(0);
    expect(finalized.dbSummary.dbDerivedRemediationCount).toBe(0);
    expect(finalized.dbSummary.status).toBe('partial');
  });

  it('final status is partial and Stage 7 required when pending curation fixes have no fix assignment', async () => {
    const session = await service.beginOrchestration({ scope: 'workflow', runScope: 'repo', repoId: 'repo-fix-gate' });
    const submitResult = await service.submitFindings(session.sessionId, [
      {
        classification: 'missing_context' as any,
        fixType: 'curated_context_create' as any,
        severity: 'warn' as any,
        risk: 'low' as any,
        confidence: 0.9,
        impactScope: 'repo',
      },
    ], testConfig);

    await db.collection('context_trace_analysis_assignments').insertOne({
      assignmentId: 'trace-fix-gate-1',
      sessionId: session.sessionId,
      sourceIds: ['ca-fix-gate-1'],
      status: 'completed',
      evaluatedCount: 1,
      skippedCount: 0,
      failedCount: 0,
      findingCount: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: new Date(),
    });
    await db.collection('context_source_evaluations').insertOne({
      evaluationId: 'eval-fix-gate-1',
      sessionId: session.sessionId,
      sourceType: 'context_usage_trace',
      sourceId: 'ca-fix-gate-1',
      sourceKey: 'context_usage_trace:ca-fix-gate-1',
      decision: 'finding_created',
      status: 'completed',
      evaluationVersion: 1,
      findingIds: submitResult.findingIds,
      judgeRunId: submitResult.judgeRunId,
      evaluatedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.collection('context_review_worker_assignments').insertOne({
      assignmentId: 'planner-fix-gate-1',
      taskIds: submitResult.reviewTaskIds,
      workerRole: 'context_remediation_planner',
      status: 'completed',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.collection('context_remediations').insertOne({
      remediationId: 'remediation-fix-gate-1',
      sessionId: session.sessionId,
      rootExecutionId: session.rootExecutionId,
      taskId: submitResult.reviewTaskIds[0],
      findingId: submitResult.findingIds[0],
      judgeRunId: submitResult.judgeRunId,
      workerRole: 'context_curation_fix',
      actionKind: 'curated_entry_create',
      status: 'pending',
      humanGateRequired: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const finalized = await service.finalizeOrchestration(session.sessionId) as any;
    expect(finalized.dbSummary.dbDerivedRemediationCount).toBe(1);
    expect(finalized.dbSummary.pendingFixRemediationCount).toBe(1);
    expect(finalized.dbSummary.unassignedPendingFixRemediationCount).toBe(1);
    expect(finalized.dbSummary.fixAssignmentCount).toBe(0);
    expect(finalized.dbSummary.status).toBe('partial');
    const stageState = await service.computeStageState(session.sessionId, finalized.dbSummary) as any;
    expect(stageState.stages.stage_7_fix_qa.status).toBe('required');
  });

  it('dbSummary remediation counts are 0 when no judgeRunId or no remediations exist', async () => {
    const session = await service.beginOrchestration({ scope: 'workflow' });
    // No findings submitted → no judgeRunId
    const finalized = await service.finalizeOrchestration(session.sessionId) as any;
    expect(finalized.dbSummary.dbDerivedRemediationCount).toBe(0);
  });

  it('submitFindings auto-logs finding_created to context_source_evaluations when session has sourceId', async () => {
    const session = await service.beginOrchestration({
      scope: 'workflow',
      sourceId: 'exec-autolog-1',
      sourceKind: 'workflow_run',
      repoId: 'repo-autolog',
    });
    const findings = [
      { classification: 'missing_context' as any, fixType: 'curated_context_create' as any, severity: 'warn' as any, risk: 'low' as any, confidence: 0.8 },
    ];
    const result = await service.submitFindings(session.sessionId, findings, testConfig);
    expect(result.findingIds.length).toBeGreaterThan(0);

    // context_source_evaluations should have a finding_created record
    const evalRecord = await db.collection('context_source_evaluations').findOne({
      sessionId: session.sessionId, sourceType: 'workflow_run', sourceId: 'exec-autolog-1',
    });
    expect(evalRecord).not.toBeNull();
    expect((evalRecord as any).decision).toBe('finding_created');
    expect((evalRecord as any).status).toBe('completed');
    expect((evalRecord as any).judgeRunId).toBe(result.judgeRunId);
  });

  it('submitFindings accumulates session finding and review task IDs across judge runs', async () => {
    const session = await service.beginOrchestration({ scope: 'workflow' });

    const first = await service.submitFindings(session.sessionId, [
      { classification: 'missing_context' as any, fixType: 'curated_context_create' as any, severity: 'warn' as any, risk: 'low' as any, confidence: 0.8 },
    ], testConfig);
    const second = await service.submitFindings(session.sessionId, [
      { classification: 'stale_context' as any, fixType: 'curated_context_edit' as any, severity: 'info' as any, risk: 'low' as any, confidence: 0.9 },
    ], testConfig);

    const withSummary = await service.getSessionWithSummary(session.sessionId) as any;

    expect(withSummary.findingIds).toEqual(expect.arrayContaining([
      first.findingIds[0],
      second.findingIds[0],
    ]));
    expect(withSummary.reviewTaskIds).toEqual(expect.arrayContaining([
      first.reviewTaskIds[0],
      second.reviewTaskIds[0],
    ]));
    expect(withSummary.judgeRunIds).toEqual(expect.arrayContaining([
      first.judgeRunId,
      second.judgeRunId,
    ]));
    expect(withSummary.dbSummary.dbDerivedFindingCount).toBe(2);
    expect(withSummary.dbSummary.dbDerivedReviewTaskCount).toBe(2);
    expect(withSummary.dbSummary.judgeRunIds).toEqual(expect.arrayContaining([
      first.judgeRunId,
      second.judgeRunId,
    ]));
  });

  it('repair state reports unresolved failed traces and finding evaluations without remediation mappings', async () => {
    const session = await service.beginOrchestration({
      scope: 'workflow',
      rootExecutionId: 'exec-repair-root-1',
    });
    const result = await service.submitFindings(session.sessionId, [
      { classification: 'retrieval_gap' as any, fixType: 'retrieval_fix' as any, severity: 'warn' as any, risk: 'low' as any, confidence: 0.9 },
    ], testConfig);

    await db.collection('context_trace_analysis_assignments').insertOne({
      assignmentId: 'trace-repair-failed-1',
      sessionId: session.sessionId,
      sourceIds: ['ca-repair-1'],
      status: 'failed',
      failedCount: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.collection('context_source_evaluations').insertOne({
      evaluationId: 'eval-repair-1',
      sessionId: session.sessionId,
      sourceType: 'context_usage_trace',
      sourceId: 'ca-repair-1',
      sourceKey: 'context_usage_trace:ca-repair-1',
      decision: 'finding_created',
      status: 'completed',
      findingIds: result.findingIds,
      affectedRefIds: ['ctx-ref-1'],
      evaluationVersion: 1,
      evaluatedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const state = await service.getRepairResumeState({
      rootExecutionId: 'exec-repair-root-1',
    }) as any;

    expect(state.found).toBe(true);
    expect(state.sessionId).toBe(session.sessionId);
    expect(state.unresolvedTraceSources).toHaveLength(1);
    expect(state.unresolvedTraceSources[0].assignmentId).toBe('trace-repair-failed-1');
    expect(state.findingEvaluationsWithoutRemediation).toHaveLength(1);
    expect(state.findingEvaluationsWithoutRemediation[0].findingId).toBe(result.findingIds[0]);
    expect(state.findingEvaluationsWithoutRemediation[0].affectedRefIds).toEqual(['ctx-ref-1']);
  });

  it('dbSummary fix and QA assignment counts are scoped to this session remediations', async () => {
    const sessionA = await service.beginOrchestration({
      scope: 'workflow',
      sourceId: 'exec-summary-scope-a',
      sourceKind: 'workflow_run',
    });
    const sessionB = await service.beginOrchestration({
      scope: 'workflow',
      sourceId: 'exec-summary-scope-b',
      sourceKind: 'workflow_run',
    });
    const resultA = await service.submitFindings(sessionA.sessionId, [
      { classification: 'missing_context' as any, fixType: 'curated_context_create' as any, severity: 'warn' as any, risk: 'low' as any, confidence: 0.9 },
    ], testConfig);
    const resultB = await service.submitFindings(sessionB.sessionId, [
      { classification: 'missing_context' as any, fixType: 'curated_context_create' as any, severity: 'warn' as any, risk: 'low' as any, confidence: 0.9 },
    ], testConfig);

    await db.collection('context_remediations').insertMany([
      {
        remediationId: 'remed-session-a-1',
        taskId: resultA.reviewTaskIds[0],
        findingId: resultA.findingIds[0],
        judgeRunId: resultA.judgeRunId,
        workerRole: 'context_curation_fix',
        status: 'pending',
        actionKind: 'curated_entry_create',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        remediationId: 'remed-session-b-1',
        taskId: resultB.reviewTaskIds[0],
        findingId: resultB.findingIds[0],
        judgeRunId: resultB.judgeRunId,
        workerRole: 'context_curation_fix',
        status: 'pending',
        actionKind: 'curated_entry_create',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    await db.collection('context_review_worker_assignments').insertOne({
      assignmentId: 'assign-fix-session-b-1',
      taskIds: ['remed-session-b-1'],
      remediationIds: ['remed-session-b-1'],
      workerRole: 'context_curation_fix',
      status: 'queued',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const summaryA = await service.computeDbSummary(sessionA.sessionId) as any;
    const summaryB = await service.computeDbSummary(sessionB.sessionId) as any;

    expect(summaryA.dbDerivedRemediationCount).toBe(1);
    expect(summaryA.fixAssignmentCount).toBe(0);
    expect(summaryB.dbDerivedRemediationCount).toBe(1);
    expect(summaryB.fixAssignmentCount).toBe(1);
  });
});
