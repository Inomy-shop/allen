// E2E test: Complete context quality flow (AC-22)
// Step 1: Enqueue judge run
// Step 2: Normalized findings created
// Step 3: Review task created from finding
// Step 4: Approve decision added
// Step 5: Remediation created and dispatched
// Step 6: Audit/history visible (decisions, remediation status)
// AC-19: code_change_pr dispatch is blocked

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ContextJudgeService } from '../../../services/context/judge/context-judge.service.js';
import { ContextFindingService } from '../../../services/context/judge/context-finding.service.js';
import { ContextReviewService } from '../../../services/context/judge/context-review.service.js';
import { ContextRemediationTaskService } from '../../../services/context/judge/context-remediation-task.service.js';
import { ContextReviewWorkerOrchestrator } from '../../../services/context/judge/context-review-worker-orchestrator.js';
import { ContextJudgeOrchestratorService } from '../../../services/context/judge/context-judge-orchestrator.service.js';

let mongo: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let judgeService: ContextJudgeService;
let findingService: ContextFindingService;
let reviewService: ContextReviewService;
let remediationService: ContextRemediationTaskService;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = new MongoClient(mongo.getUri());
  await client.connect();
  db = client.db('test-e2e-quality');
  judgeService = new ContextJudgeService(db);
  findingService = new ContextFindingService(db);
  reviewService = new ContextReviewService(db);
  remediationService = new ContextRemediationTaskService(db);
});

afterAll(async () => {
  await client.close();
  await mongo.stop();
});

beforeEach(async () => {
  await db.collection('context_judge_runs').deleteMany({});
  await db.collection('context_findings').deleteMany({});
  await db.collection('context_review_tasks').deleteMany({});
  await db.collection('context_review_decisions').deleteMany({});
  await db.collection('context_remediations').deleteMany({});
  await db.collection('context_orchestration_sessions').deleteMany({});
  await db.collection('context_review_worker_assignments').deleteMany({});
});

// ─── Minimal config for createFromFinding ────────────────────────────────────

const testConfig = {
  configId: 'singleton' as const,
  autoRemediationEnabled: false,
  autoRemediationThresholds: {
    minConfidence: 0.9,
    maxRisk: 'low' as const,
    allowedFixTypes: [] as any[],
  },
  mandatoryHumanReview: {
    lowConfidenceThreshold: 0.5,
    highRiskLevels: ['critical' as const, 'high' as const],
    alwaysForScopes: ['cross_repo' as const, 'global' as const],
    alwaysForLearningDerived: true,
    alwaysForCodeFix: true,
  },
  updatedAt: new Date(),
};

// ─── Step 1 + 2: Judge run with rawFindings ────────────────────────────────────

describe('Step 1-2: Judge run enqueues and creates findings', () => {
  it('judge() with rawFindings creates a judgeRunId and findingIds', async () => {
    const result = await judgeService.judge({
      scope: 'workflow',
      rawFindings: [
        {
          classification: 'missing_context',
          fixType: 'curated_context_create',
          severity: 'warn',
          risk: 'medium',
          confidence: 0.75,
          suggestedRemediation: 'Create a new context entry for this workflow step',
        },
      ],
    });

    expect(result.judgeRunId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(result.findingIds).toHaveLength(1);
    expect(result.findingIds[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('finding is stored in DB and retrievable', async () => {
    const result = await judgeService.judge({
      scope: 'node',
      rawFindings: [
        {
          classification: 'wrong_context',
          fixType: 'curated_context_edit',
          severity: 'error',
          risk: 'high',
          confidence: 0.88,
        },
      ],
    });

    const finding = await findingService.getById(result.findingIds[0]);
    expect(finding).not.toBeNull();
    expect(finding!.judgeRunId).toBe(result.judgeRunId);
    expect(finding!.classification).toBe('wrong_context');
    expect(finding!.status).toBe('open');
    expect(finding!.active).toBe(true);
  });

  it('judge() with no rawFindings creates no findings', async () => {
    const result = await judgeService.judge({ scope: 'workflow' });
    expect(result.findingIds).toHaveLength(0);
  });
});

// ─── Step 3: Review task created from finding ─────────────────────────────────

describe('Step 3: Review task created from finding', () => {
  it('createFromFinding returns a task with the finding data', async () => {
    const finding = await findingService.create({
      judgeRunId: 'run-e2e-001',
      scope: 'workflow',
      classification: 'missing_context',
      fixType: 'curated_context_create',
      severity: 'warn',
      risk: 'medium',
      confidence: 0.75,
      reliabilityLabel: 'needs_judge',
      suggestedRemediation: 'Add a curated entry',
    });

    const task = await reviewService.createFromFinding(finding, testConfig);

    expect(task.taskId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(task.findingId).toBe(finding.findingId);
    expect(task.judgeRunId).toBe(finding.judgeRunId);
    expect(task.status).toBe('pending');
    expect(task.queue).toBe('open');
  });

  it('task is retrievable from DB', async () => {
    const finding = await findingService.create({
      judgeRunId: 'run-e2e-002',
      scope: 'workflow',
      classification: 'stale_context',
      fixType: 'curated_context_archive',
      severity: 'info',
      risk: 'low',
      confidence: 0.91,
      reliabilityLabel: 'confirmed',
    });

    const task = await reviewService.createFromFinding(finding, testConfig);
    const fetched = await reviewService.get(task.taskId);

    expect(fetched).not.toBeNull();
    expect(fetched!.taskId).toBe(task.taskId);
  });
});

// ─── Step 4: Approve decision → task status changes ───────────────────────────

describe('Step 4: Approve decision transitions task to in_remediation', () => {
  it('addDecision approve → task.status becomes in_remediation', async () => {
    const finding = await findingService.create({
      judgeRunId: 'run-e2e-003',
      scope: 'workflow',
      classification: 'missing_context',
      fixType: 'curated_context_create',
      severity: 'warn',
      risk: 'low',
      confidence: 0.8,
      reliabilityLabel: 'confirmed',
    });

    const task = await reviewService.createFromFinding(finding, testConfig);
    await reviewService.addDecision(task.taskId, { actor: 'user', action: 'approve' });

    const updated = await reviewService.get(task.taskId);
    expect(updated!.status).toBe('in_remediation');
  });

  it('addDecision reject → task.status becomes rejected', async () => {
    const finding = await findingService.create({
      judgeRunId: 'run-e2e-004',
      scope: 'node',
      classification: 'wrong_context',
      fixType: 'curated_context_edit',
      severity: 'error',
      risk: 'medium',
      confidence: 0.55,
      reliabilityLabel: 'needs_judge',
    });

    const task = await reviewService.createFromFinding(finding, testConfig);
    await reviewService.addDecision(task.taskId, {
      actor: 'reviewer',
      action: 'reject',
      notes: 'Not a valid finding',
    });

    const updated = await reviewService.get(task.taskId);
    expect(updated!.status).toBe('rejected');
  });

  it('addDecision request_changes → task.status becomes changes_requested', async () => {
    const finding = await findingService.create({
      judgeRunId: 'run-e2e-005',
      scope: 'workflow',
      classification: 'bloated_context',
      fixType: 'curated_context_archive',
      severity: 'info',
      risk: 'low',
      confidence: 0.7,
      reliabilityLabel: 'signal_only',
    });

    const task = await reviewService.createFromFinding(finding, testConfig);
    await reviewService.addDecision(task.taskId, {
      actor: 'reviewer',
      action: 'request_changes',
    });

    const updated = await reviewService.get(task.taskId);
    expect(updated!.status).toBe('changes_requested');
  });
});

// ─── Step 5: Remediation created and dispatched ───────────────────────────────

describe('Step 5: Remediation lifecycle', () => {
  it('create remediation → status pending', async () => {
    const remediation = await remediationService.create({
      taskId: 'task-rem-001',
      findingId: 'finding-rem-001',
      judgeRunId: 'run-rem-001',
      actionKind: 'curated_entry_edit',
    });

    expect(remediation.remediationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(remediation.status).toBe('pending');
  });

  it('dispatch curated_entry_edit → status dispatched', async () => {
    const remediation = await remediationService.create({
      taskId: 'task-rem-002',
      findingId: 'finding-rem-002',
      judgeRunId: 'run-rem-002',
      actionKind: 'curated_entry_edit',
    });

    const ok = await remediationService.dispatch(remediation.remediationId);
    expect(ok).toBe(true);

    const updated = await remediationService.get(remediation.remediationId);
    expect(updated!.status).toBe('dispatched');
  });

  it('dispatch no_op → status dispatched', async () => {
    const remediation = await remediationService.create({
      taskId: 'task-rem-003',
      findingId: 'finding-rem-003',
      judgeRunId: 'run-rem-003',
      actionKind: 'no_op',
    });

    const ok = await remediationService.dispatch(remediation.remediationId);
    expect(ok).toBe(true);

    const updated = await remediationService.get(remediation.remediationId);
    expect(updated!.status).toBe('dispatched');
  });
});

// ─── Step 6: Audit/history visible ────────────────────────────────────────────

describe('Step 6: Decision history is visible', () => {
  it('listDecisions returns approve decision after it is added', async () => {
    const finding = await findingService.create({
      judgeRunId: 'run-hist-001',
      scope: 'workflow',
      classification: 'missing_context',
      fixType: 'curated_context_create',
      severity: 'warn',
      risk: 'low',
      confidence: 0.85,
      reliabilityLabel: 'confirmed',
    });

    const task = await reviewService.createFromFinding(finding, testConfig);
    await reviewService.addDecision(task.taskId, {
      actor: 'admin',
      action: 'approve',
      notes: 'Looks correct',
    });

    const decisions = await reviewService.listDecisions(task.taskId);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe('approve');
    expect(decisions[0].actor).toBe('admin');
    expect(decisions[0].notes).toBe('Looks correct');
  });

  it('multiple decisions are all recorded', async () => {
    const finding = await findingService.create({
      judgeRunId: 'run-hist-002',
      scope: 'node',
      classification: 'wrong_context',
      fixType: 'curated_context_edit',
      severity: 'error',
      risk: 'medium',
      confidence: 0.6,
      reliabilityLabel: 'needs_judge',
    });

    const task = await reviewService.createFromFinding(finding, testConfig);
    await reviewService.addDecision(task.taskId, { actor: 'reviewer-a', action: 'request_changes' });
    await reviewService.addDecision(task.taskId, { actor: 'reviewer-b', action: 'approve' });

    const decisions = await reviewService.listDecisions(task.taskId);
    expect(decisions).toHaveLength(2);
    expect(decisions.map((d) => d.action)).toContain('approve');
    expect(decisions.map((d) => d.action)).toContain('request_changes');
  });
});

// ─── AC-19: code_change_pr dispatch is blocked ────────────────────────────────

describe('AC-19: code_change_pr dispatch is blocked', () => {
  it('dispatch with actionKind=code_change_pr sets status to failed', async () => {
    const remediation = await remediationService.create({
      taskId: 'task-ac19-001',
      findingId: 'finding-ac19-001',
      judgeRunId: 'run-ac19-001',
      actionKind: 'code_change_pr',
    });

    const ok = await remediationService.dispatch(remediation.remediationId);
    expect(ok).toBe(true);

    const updated = await remediationService.get(remediation.remediationId);
    expect(updated!.status).toBe('failed');
    expect(updated!.error).toContain('code_change_pr_requires_human_routing');
  });

  it('dispatch with actionKind=code_change_pr does NOT set status to dispatched', async () => {
    const remediation = await remediationService.create({
      taskId: 'task-ac19-002',
      findingId: 'finding-ac19-002',
      judgeRunId: 'run-ac19-002',
      actionKind: 'code_change_pr',
    });

    await remediationService.dispatch(remediation.remediationId);

    const updated = await remediationService.get(remediation.remediationId);
    expect(updated!.status).not.toBe('dispatched');
  });
});

// ─── AC-11: Linear is never called from judge pipeline ────────────────────────

describe('AC-11: Linear is never called from judge pipeline', () => {
  it('complete judge->finding->review->remediation flow has no linear fields', async () => {
    // Run judge
    const judgeResult = await judgeService.judge({
      scope: 'workflow',
      rawFindings: [
        {
          classification: 'missing_context',
          fixType: 'curated_context_create',
          severity: 'warn',
          risk: 'low',
          confidence: 0.82,
        },
      ],
    });

    // Create review task
    const finding = await findingService.getById(judgeResult.findingIds[0]);
    const task = await reviewService.createFromFinding(finding!, testConfig);

    // Add decision
    await reviewService.addDecision(task.taskId, { actor: 'user', action: 'approve' });

    // Create and dispatch remediation
    const remediation = await remediationService.create({
      taskId: task.taskId,
      findingId: finding!.findingId,
      judgeRunId: judgeResult.judgeRunId,
      actionKind: 'curated_entry_create',
    });
    await remediationService.dispatch(remediation.remediationId);

    // Assert no linear fields in judge runs
    const judgeRuns = await db.collection('context_judge_runs').find({}).toArray();
    for (const run of judgeRuns) {
      expect((run as any).linearIssueId).toBeUndefined();
      expect((run as any).linearUrl).toBeUndefined();
      expect((run as any).linearSynced).toBeUndefined();
    }

    // Assert no linear fields in findings
    const findings = await db.collection('context_findings').find({}).toArray();
    for (const f of findings) {
      expect((f as any).linearIssueId).toBeUndefined();
      expect((f as any).linearUrl).toBeUndefined();
      expect((f as any).linearSynced).toBeUndefined();
    }

    // Assert no linear fields in review tasks
    const tasks = await db.collection('context_review_tasks').find({}).toArray();
    for (const t of tasks) {
      expect((t as any).linearIssueId).toBeUndefined();
      expect((t as any).linearUrl).toBeUndefined();
      expect((t as any).linearSynced).toBeUndefined();
    }

    // Assert no linear fields in remediations
    const remediations = await db.collection('context_remediations').find({}).toArray();
    for (const r of remediations) {
      expect((r as any).linearIssueId).toBeUndefined();
      expect((r as any).linearUrl).toBeUndefined();
      expect((r as any).linearSynced).toBeUndefined();
    }
  });
});

// ─── AC-17: Worker orchestrator enforces gates on large backlogs ──────────────

describe('AC-17: Worker orchestrator enforces gates on large backlogs', () => {
  let workerOrchestrator: ContextReviewWorkerOrchestrator;

  beforeAll(() => {
    workerOrchestrator = new ContextReviewWorkerOrchestrator(db);
  });

  it('assignBacklog does not assign tasks with requiresHumanReview=true', async () => {
    // Insert 5 tasks requiring human review and 3 that don't (non-code_fix)
    const humanReviewTasks = Array.from({ length: 5 }, (_, i) => ({
      taskId: `task-human-${i}`,
      findingId: `finding-human-${i}`,
      judgeRunId: 'run-ac17-001',
      scope: 'workflow',
      fixType: 'curated_context_edit',
      risk: 'high',
      severity: 'error',
      confidence: 0.9,
      reliabilityLabel: 'confirmed',
      status: 'pending',
      queue: 'open',
      requiresHumanReview: true,
      humanReviewReason: 'high_risk',
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const autoTasks = Array.from({ length: 3 }, (_, i) => ({
      taskId: `task-auto-${i}`,
      findingId: `finding-auto-${i}`,
      judgeRunId: 'run-ac17-001',
      scope: 'workflow',
      fixType: 'curated_context_create',
      risk: 'low',
      severity: 'info',
      confidence: 0.9,
      reliabilityLabel: 'confirmed',
      status: 'pending',
      queue: 'open',
      requiresHumanReview: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    await db.collection('context_review_tasks').insertMany([...humanReviewTasks, ...autoTasks] as any[]);

    const result = await workerOrchestrator.assignBacklog({ maxBatch: 20 });

    // Only 3 auto tasks should be assigned
    expect(result.assigned).toBe(3);
    expect(result.assignments).toHaveLength(1);
    const assignedTaskIds = result.assignments[0].taskIds;
    // None of the human review tasks should appear in assignments
    for (const humanTask of humanReviewTasks) {
      expect(assignedTaskIds).not.toContain(humanTask.taskId);
    }
    // All 3 auto tasks should appear
    for (const autoTask of autoTasks) {
      expect(assignedTaskIds).toContain(autoTask.taskId);
    }
  });

  it('assignBacklog never assigns code_fix tasks even if requiresHumanReview=false', async () => {
    // Insert a code_fix task with requiresHumanReview=false (inconsistent state)
    await db.collection('context_review_tasks').insertOne({
      taskId: 'task-codefix-ac17',
      findingId: 'finding-codefix-ac17',
      judgeRunId: 'run-ac17-002',
      scope: 'workflow',
      fixType: 'code_fix',
      risk: 'medium',
      severity: 'error',
      confidence: 0.9,
      reliabilityLabel: 'confirmed',
      status: 'pending',
      queue: 'open',
      requiresHumanReview: false,  // intentionally wrong — should still be blocked
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    const result = await workerOrchestrator.assignBacklog({ maxBatch: 20 });

    // The code_fix task must NOT be assigned
    const allAssignedTaskIds = result.assignments.flatMap((a) => a.taskIds);
    expect(allAssignedTaskIds).not.toContain('task-codefix-ac17');
  });
});

// ─── AC-19: code_change_pr is always blocked ──────────────────────────────────

describe('AC-19: code_change_pr is always blocked', () => {
  it('dispatch of code_change_pr remediation fails with gate error', async () => {
    const remediation = await remediationService.create({
      taskId: 'task-ac19-e2e-001',
      findingId: 'finding-ac19-e2e-001',
      judgeRunId: 'run-ac19-e2e-001',
      actionKind: 'code_change_pr',
    });

    const ok = await remediationService.dispatch(remediation.remediationId);
    expect(ok).toBe(true);

    const updated = await remediationService.get(remediation.remediationId);
    expect(updated!.status).toBe('failed');
    expect(updated!.error).toMatch(/blocked|code_change_pr/i);
  });
});

// ─── Orchestrator session flow ─────────────────────────────────────────────────

describe('Orchestrator session flow', () => {
  let orchestratorService: ContextJudgeOrchestratorService;

  beforeAll(() => {
    orchestratorService = new ContextJudgeOrchestratorService(db);
  });

  it('full orchestrator session: begin -> logDecision -> submitFindings -> finalize', async () => {
    // Step 1: Begin session
    const session = await orchestratorService.beginOrchestration({
      scope: 'workflow',
      agentModel: 'claude-3-5-sonnet',
      agentProvider: 'anthropic',
      agentRationale: 'E2E test orchestration',
    });
    expect(session.status).toBe('active');

    // Step 2: Log a discovery decision
    await orchestratorService.logAgentDecision(session.sessionId, {
      at: new Date(),
      kind: 'discovery',
      detail: 'Discovered 5 workflow runs with potential context gaps',
      metadata: { sourceCount: 5 },
    });

    // Step 3: Submit 2 findings
    const result = await orchestratorService.submitFindings(
      session.sessionId,
      [
        {
          classification: 'missing_context',
          fixType: 'curated_context_create',
          severity: 'warn',
          risk: 'low',
          confidence: 0.85,
          suggestedRemediation: 'Create curated entry for this workflow step',
          agentRationale: 'Context absent in majority of sampled runs',
        },
        {
          classification: 'stale_context',
          fixType: 'curated_context_edit',
          severity: 'info',
          risk: 'low',
          confidence: 0.78,
          agentRationale: 'Context is outdated by 30+ days',
        },
      ],
      testConfig,
    );

    expect(result.findingIds).toHaveLength(2);
    expect(result.reviewTaskIds).toHaveLength(2);

    // Step 4: Finalize with summary
    const finalized = await orchestratorService.finalizeOrchestration(
      session.sessionId,
      'Evaluated 5 workflow runs, produced 2 findings for review',
    );

    expect(finalized.status).toBe('finalized');
    expect(finalized.findingIds).toHaveLength(2);
    expect(finalized.reviewTaskIds).toHaveLength(2);

    // Verify agentDecisionLog has at least 3 entries:
    //   discovery + gate_checks (0 here since no code_fix/cross_repo) + summary
    // With no gate checks, should have: discovery (1) + summary (1) = 2 minimum
    // The spec says "at least 3 entries (discovery + 2 gate_checks + summary)"
    // for code_fix/cross_repo scenarios; for this test (low risk, no gate triggers):
    expect(finalized.agentDecisionLog.length).toBeGreaterThanOrEqual(2);

    const discoveryEntries = finalized.agentDecisionLog.filter((e) => e.kind === 'discovery');
    const summaryEntries = finalized.agentDecisionLog.filter((e) => e.kind === 'summary');
    expect(discoveryEntries).toHaveLength(1);
    expect(summaryEntries).toHaveLength(1);
    expect(summaryEntries[0].detail).toContain('2 findings');
  });
});

// ─── AC-23: Agent-owned orchestration path ───────────────────────────────────

describe('AC-23: Agent-owned orchestration path', () => {
  it('full orchestration loop: agent begins → logs decisions → submits findings → worker assignment has invocation metadata → dispatch creates queue record', async () => {
    const orchestratorService = new ContextJudgeOrchestratorService(db);
    const workerOrchestrator = new ContextReviewWorkerOrchestrator(db);

    // Step 1: Agent begins orchestration session
    const session = await orchestratorService.beginOrchestration({
      scope: 'workflow',
      agentModel: 'claude-sonnet',
      agentProvider: 'claude-cli',
      agentRationale: 'Scanning workflow runs for context quality issues — AC-23 test',
    });
    expect(session.status).toBe('active');
    expect(session.agentModel).toBe('claude-sonnet');

    // Step 2: Agent logs discovery decision
    await orchestratorService.logAgentDecision(session.sessionId, {
      at: new Date(),
      kind: 'discovery',
      detail: 'Discovered 2 workflow runs with low precision scores',
      metadata: { sourceCount: 2, sourceType: 'workflow_run' },
    });

    // Step 3: Agent logs classification decision
    await orchestratorService.logAgentDecision(session.sessionId, {
      at: new Date(),
      kind: 'classification',
      detail: 'Classified as missing_context (retrieval_gap) with medium risk',
      metadata: { classification: 'missing_context', fixType: 'curated_context_fix', confidence: 0.77 },
    });

    // Step 4: Agent submits findings
    const findResult = await orchestratorService.submitFindings(
      session.sessionId,
      [{
        classification: 'missing_context',
        fixType: 'curated_context_fix',
        severity: 'warn',
        risk: 'medium',
        confidence: 0.77,
        suggestedRemediation: 'Create curated context for workflow step X',
        agentRationale: 'Deterministic precision 0.42 and retrieval recalled only 1/3 expected refs',
      }],
      testConfig,
    );
    expect(findResult.findingIds).toHaveLength(1);
    expect(findResult.reviewTaskIds).toHaveLength(1);

    // Step 5: Agent logs routing decision
    await orchestratorService.logAgentDecision(session.sessionId, {
      at: new Date(),
      kind: 'routing',
      detail: 'Routing to curation worker agent — confidence 0.77, risk medium, auto-remediatable',
      metadata: { workerRole: 'context_curation_fix', taskId: findResult.reviewTaskIds[0] },
    });

    // Step 6: Agent finalizes session
    const finalized = await orchestratorService.finalizeOrchestration(
      session.sessionId,
      'AC-23 orchestration complete: 1 finding, 1 review task, routed to context_curation_fix worker',
    );
    expect(finalized.status).toBe('finalized');
    expect(finalized.agentDecisionLog.length).toBeGreaterThanOrEqual(4);
    expect(finalized.findingIds).toHaveLength(1);

    // Step 7: Worker assignment boundary — assign eligible task (AC-23 key assertion)
    await db.collection('context_review_tasks').insertOne({
      taskId: 'ac23-eligible-task',
      status: 'pending',
      requiresHumanReview: false,
      fixType: 'curated_context_fix',
      createdAt: new Date(),
    });
    await db.collection('context_remediations').insertOne({
      remediationId: 'ac23-remediation',
      taskId: 'ac23-eligible-task',
      findingId: 'finding-ac23',
      judgeRunId: 'run-ac23',
      actionKind: 'curated_entry_edit',
      workerRole: 'context_curation_fix',
      status: 'pending',
      humanGateRequired: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const workResult = await workerOrchestrator.assignBacklog({
      maxBatch: 5,
      workerRole: 'context_curation_fix',
    });

    const theAssignment = workResult.assignments.find(a => a.remediationIds?.includes('ac23-remediation'));
    expect(theAssignment).toBeDefined();
    // AC-23: worker assignment MUST have allenAgentInvocation metadata
    expect(theAssignment!.allenAgentInvocation).toBeDefined();
    expect(theAssignment!.allenAgentInvocation!.agentName).toBe('context-curation-fix-agent');
    expect(theAssignment!.allenAgentInvocation!.dispatchStatus).toBe('pending_runtime');
    expect(theAssignment!.workerRole).toBe('context_curation_fix');
    expect(theAssignment!.taskIds).toContain('ac23-remediation');
    expect(theAssignment!.allenAgentInvocation!.taskPayload.workerRole).toBe('context_curation_fix');
    expect('instructionDocPath' in theAssignment!.allenAgentInvocation!.taskPayload).toBe(false);

    // Step 8: Dispatch creates executable task record (AC-23 key assertion)
    const dispatchResult = await workerOrchestrator.dispatchAssignmentToAgent(theAssignment!.assignmentId);
    expect(dispatchResult.queuedRecord).toBeDefined();
    expect(dispatchResult.queuedRecord!.agentName).toBe('context-curation-fix-agent');
    // Verify DB record exists
    const queueRecord = await db.collection('context_agent_dispatch_queue').findOne({
      assignmentId: theAssignment!.assignmentId,
    });
    expect(queueRecord).not.toBeNull();
    expect((queueRecord as any).status).toBe('queued');
    expect((queueRecord as any).taskPayload.instructionDocPath).toBeUndefined();
  });
});

// ─── Full 6-step loop ─────────────────────────────────────────────────────────

describe('AC-22: Complete 6-step loop integration', () => {
  it('runs the full loop end to end', async () => {
    // Step 1: Enqueue judge run with rawFindings
    const judgeResult = await judgeService.judge({
      scope: 'workflow',
      sourceId: 'exec-e2e-full',
      rawFindings: [
        {
          classification: 'missing_context',
          fixType: 'curated_context_create',
          severity: 'warn',
          risk: 'low',
          confidence: 0.80,
          suggestedRemediation: 'Create a new curated entry',
        },
      ],
    });

    // Step 2: Verify finding exists
    expect(judgeResult.findingIds).toHaveLength(1);
    const finding = await findingService.getById(judgeResult.findingIds[0]);
    expect(finding).not.toBeNull();
    expect(finding!.status).toBe('open');

    // Step 3: Create review task from finding
    const task = await reviewService.createFromFinding(finding!, testConfig);
    expect(task.status).toBe('pending');
    expect(task.queue).toBe('open');

    // Step 4: Add approve decision
    await reviewService.addDecision(task.taskId, {
      actor: 'user',
      action: 'approve',
      notes: 'Context is indeed missing',
    });

    // Verify task status changed to in_remediation
    const taskAfterApprove = await reviewService.get(task.taskId);
    expect(taskAfterApprove!.status).toBe('in_remediation');

    // Step 5: Create and dispatch remediation
    const remediation = await remediationService.create({
      taskId: task.taskId,
      findingId: finding!.findingId,
      judgeRunId: judgeResult.judgeRunId,
      actionKind: 'curated_entry_create',
    });

    await remediationService.dispatch(remediation.remediationId);

    const remediationAfterDispatch = await remediationService.get(remediation.remediationId);
    expect(remediationAfterDispatch!.status).toBe('dispatched');

    // Step 6: Audit — list decisions and confirm history
    const decisions = await reviewService.listDecisions(task.taskId);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe('approve');

    // List remediations and verify visible
    const remediations = await remediationService.list({ taskId: task.taskId });
    expect(remediations).toHaveLength(1);
    expect(remediations[0].status).toBe('dispatched');
  });
});
