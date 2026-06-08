/**
 * ContextJudgeOrchestratorService — LLM Agent Orchestration Boundary
 *
 * DESIGN: This service is the tool-layer boundary for an LLM judge agent.
 * The LLM agent (not this service) makes all intelligence decisions:
 *   - Which sources need evaluation
 *   - How to classify each context problem
 *   - What evidence supports each finding
 *   - What fix to suggest
 *
 * This service provides:
 *   - Session persistence and audit trail for agent decisions
 *   - Coordination of downstream pipeline (judge runs, findings, review tasks)
 *   - Safety gate enforcement (enforced even if agent logic is wrong)
 *   - Complete AgentDecisionLog for replay and debugging
 *
 * Usage pattern:
 *   1. Agent calls beginOrchestration() to start a session
 *   2. Agent discovers sources, calls logAgentDecision() at each reasoning step
 *   3. Agent classifies findings, calls submitFindings() with its decisions
 *   4. Agent calls finalizeOrchestration() with a summary
 *
 * The scheduler (ContextEvaluationScheduler) discovers what sources exist.
 * The orchestrator agent decides what to DO with them.
 * The worker orchestrator (ContextReviewWorkerOrchestrator) routes auto-
 * remediatable tasks to worker agents after human gates are enforced.
 *
 * Collection: sessions stored in `context_orchestration_sessions` collection.
 * Indexes:
 *   - { sessionId: 1 } unique
 *   - { scope: 1, status: 1 }
 *   - { createdAt: -1 }
 */

import { randomUUID } from 'node:crypto';
import type { Db, Collection } from 'mongodb';
import type {
  JudgeScope,
  ContextJudgeConfig,
  OrchestratorRunRecord,
  RunScope,
} from './context-judge.types.js';
import type { AgentDecisionEntry, AgentFindingInput, OrchestrationSession } from './context-judge-orchestrator.types.js';
export type { AgentDecisionEntry, AgentFindingInput, OrchestrationSession } from './context-judge-orchestrator.types.js';
import { ContextJudgeService } from './context-judge.service.js';
import { ContextReviewService } from './context-review.service.js';
import { ContextSourceEvaluationService } from './context-source-evaluation.service.js';
import { ContextTraceAnalysisAssignmentService } from './context-trace-analysis-assignment.service.js';

/**
 * OrchestrationSession — represents one LLM agent orchestration run.
 * The agent begins a session, submits its classifications, then finalizes.
 * The service persists all agent decisions for audit.
 */

export class ContextJudgeOrchestratorService {
  private sessionsCollection: Collection<OrchestrationSession>;
  private runRecordsCollection: Collection<OrchestratorRunRecord>;
  private judgeService: ContextJudgeService;
  private reviewService: ContextReviewService;
  private sourceEvalService: ContextSourceEvaluationService;
  private traceAssignmentService: ContextTraceAnalysisAssignmentService;

  constructor(private db: Db) {
    this.sessionsCollection = db.collection<OrchestrationSession>('context_orchestration_sessions');
    this.runRecordsCollection = db.collection<OrchestratorRunRecord>('context_orchestrator_run_records');
    this.judgeService = new ContextJudgeService(db);
    this.reviewService = new ContextReviewService(db);
    this.sourceEvalService = new ContextSourceEvaluationService(db);
    this.traceAssignmentService = new ContextTraceAnalysisAssignmentService(db);
  }

  /**
   * Begin a new orchestration session. The LLM agent calls this to start a run.
   * Returns the session for the agent to use in subsequent calls.
   */
  async beginOrchestration(input: {
    agentModel?: string;
    agentProvider?: string;
    agentRationale?: string;
    scope: JudgeScope;
    /** RunScope: which repos are being evaluated. Inferred from repoId when not provided. */
    runScope?: RunScope;
    sourceId?: string;
    sourceKind?: string;
    repoId?: string;
    dry_run?: boolean;
    rootExecutionId?: string;
  }): Promise<OrchestrationSession> {
    const now = new Date();
    // Infer runScope from repoId when not explicitly provided
    const runScope: RunScope = input.runScope ?? (input.repoId ? 'repo' : 'global');
    const latestTrace = input.repoId
      ? await this.db.collection('context_attempts').findOne(
          { repoId: input.repoId },
          { sort: { contextAttemptId: -1 }, projection: { contextAttemptId: 1 } },
        ) as any
      : await this.db.collection('context_attempts').findOne(
          {},
          { sort: { contextAttemptId: -1 }, projection: { contextAttemptId: 1 } },
        ) as any;
    const session: OrchestrationSession = {
      sessionId: randomUUID(),
      agentModel: input.agentModel,
      agentProvider: input.agentProvider,
      agentRationale: input.agentRationale,
      scope: input.scope,
      runScope,
      sourceId: input.sourceId,
      sourceKind: input.sourceKind,
      repoId: input.repoId,
      dry_run: input.dry_run ?? false,
      rootExecutionId: input.rootExecutionId,
      status: 'active',
      lifecycleStatus: 'running',
      judgeRunIds: [],
      findingIds: [],
      reviewTaskIds: [],
      sourceEvaluationIds: [],
      traceSnapshotStartedAt: now,
      traceSnapshotMaxContextAttemptId: latestTrace?.contextAttemptId,
      stageStatus: {
        stage_1_begin_session: { status: 'completed', startedAt: now, completedAt: now },
      },
      agentDecisionLog: [],
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await this.sessionsCollection.insertOne(session as any);
    return session;
  }

  /**
   * Append a decision entry to the session's agentDecisionLog.
   * The agent calls this to record its reasoning at each step.
   */
  async logAgentDecision(sessionId: string, entry: AgentDecisionEntry): Promise<void> {
    const now = new Date();
    await this.sessionsCollection.updateOne(
      { sessionId },
      {
        $push: { agentDecisionLog: entry } as any,
        $set: { updatedAt: now },
      },
    );
  }

  /**
   * Submit the agent's classified findings.
   * This is where the agent's intelligence decisions (the AgentFindingInput array)
   * become persisted findings. The agent has already decided what to classify —
   * this method just persists it.
   *
   * Gate checks (enforced even if agent logic is wrong):
   * - code_fix fixType always requires human review (logs gate_check decision entry)
   * - cross_repo/global scope always requires human review (logs gate_check decision entry)
   */
  async submitFindings(
    sessionId: string,
    findings: AgentFindingInput[],
    config: ContextJudgeConfig,
  ): Promise<{ judgeRunId: string; findingIds: string[]; reviewTaskIds: string[] }> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Orchestration session not found: ${sessionId}`);
    }
    if (session.status !== 'active') {
      throw new Error(`Orchestration session is not active: ${sessionId} (status: ${session.status})`);
    }

    // ── Dry-run mode: do not persist to DB ───────────────────────────────────
    if ((session as any).dry_run) {
      const now = new Date();
      const dryGateEntries: AgentDecisionEntry[] = [];
      for (const finding of findings) {
        if (finding.fixType === 'code_fix') {
          dryGateEntries.push({ at: now, kind: 'gate_check', detail: 'code_fix requires human review (dry-run: not persisted)', metadata: { classification: finding.classification } });
        }
      }
      if (dryGateEntries.length > 0) {
        await this.sessionsCollection.updateOne(
          { sessionId },
          { $push: { agentDecisionLog: { $each: dryGateEntries } } as any, $set: { updatedAt: now } },
        );
      }
      return { judgeRunId: `dry-run-${sessionId}`, findingIds: [], reviewTaskIds: [], dryRun: true, submittedCount: findings.length } as any;
    }

    // Retrieve the session from db (note: getSession already fetched it)
    const now = new Date();

    // Fix 3+4: Run gate checks per-finding using impactScope, NOT session/run scope.
    // A repo-scoped run CAN produce cross_repo or global findings. The gate decision
    // must be based on the finding's own impactScope, not the orchestrator's scope.
    // Gate entries are informational for auditability — review tasks enforce the gates.
    const gateEntries: AgentDecisionEntry[] = [];
    for (const finding of findings) {
      if (finding.fixType === 'code_fix') {
        gateEntries.push({
          at: now,
          kind: 'gate_check',
          detail: 'code_fix fixType always requires human review — this finding will be routed to manual review queue',
          metadata: { classification: finding.classification, fixType: finding.fixType },
        });
      }
      // Fix 3: use finding's impactScope for gate check, NOT session scope
      const effectiveImpactScope = finding.impactScope ?? session.scope;
      if (effectiveImpactScope === 'cross_repo' || effectiveImpactScope === 'global') {
        gateEntries.push({
          at: now,
          kind: 'gate_check',
          detail: `impactScope=${effectiveImpactScope} always requires human review — this finding will be routed to manual review queue`,
          metadata: { impactScope: effectiveImpactScope, runScope: (session as any).runScope ?? 'global', classification: finding.classification },
        });
      }
    }

    // Build raw findings for judge service, passing traceability fields through
    const rawFindings = findings.map((f) => ({
      classification: f.classification,
      fixType: f.fixType,
      severity: f.severity,
      risk: f.risk,
      confidence: f.confidence,
      evidence: f.evidence,
      suggestedRemediation: f.suggestedRemediation,
      learningId: f.learningId,
      // Fix 3+5: pass impactScope and traceability fields
      impactScope: f.impactScope,
      primarySourceId: f.primarySourceId,
      sourceRefs: f.sourceRefs,
      executionId: f.executionId,
      contextAttemptId: f.contextAttemptId,
    }));

    // Persist findings via judge service
    const judgeResult = await this.judgeService.judge({
      scope: session.scope,
      runScope: (session as any).runScope as RunScope | undefined,
      sourceId: session.sourceId,
      sourceKind: session.sourceKind,
      repoId: session.repoId,
      trigger: 'auto',
      rawFindings,
    });

    // AC-3: Verify persisted IDs are real. If findings were submitted but no
    // IDs came back (and this is not an alreadyEvaluated short-circuit), the
    // DB write must have failed silently — surface the gap immediately.
    if (rawFindings.length > 0 && !judgeResult.alreadyEvaluated) {
      if (!judgeResult.judgeRunId) {
        throw new Error(`DB write failed: judgeService.judge() returned no judgeRunId`);
      }
      if (judgeResult.findingIds.length === 0) {
        throw new Error(
          `DB write failed: ${rawFindings.length} findings submitted but judgeService.judge() returned 0 findingIds`,
        );
      }
      if (judgeResult.findingIds.length !== rawFindings.length) {
        throw new Error(
          `DB write partial: submitted ${rawFindings.length} findings but only ${judgeResult.findingIds.length} were persisted`,
        );
      }
    }

    // Create review tasks for each finding
    const reviewTaskIds: string[] = [];
    for (const findingId of judgeResult.findingIds) {
      const findingDoc = await this.db
        .collection('context_findings')
        .findOne({ findingId }) as any;
      if (findingDoc) {
        const task = await this.reviewService.createFromFinding(findingDoc, config);
        reviewTaskIds.push(task.taskId);
      }
    }

    // GAP 1: Auto-log a durable source evaluation record when the session has a
    // known primary source and findings were created. This populates the
    // context_source_evaluations ledger so the scheduler can anti-join against it.
    if (session.sourceId && session.sourceKind && judgeResult.findingIds.length > 0) {
      try {
        await this.sourceEvalService.upsert({
          sessionId,
          judgeRunId: judgeResult.judgeRunId,
          repoId: session.repoId,
          sourceType: session.sourceKind,
          sourceId: session.sourceId,
          decision: 'finding_created',
          status: 'completed',
          findingIds: judgeResult.findingIds,
        });
      } catch {
        // Non-fatal: ledger write failure should not block the main flow
      }
    }

    // Append gate check entries to decision log and update session
    const updateNow = new Date();
    const pushOps = gateEntries.length > 0
      ? { $push: { agentDecisionLog: { $each: gateEntries } } as any }
      : {};

    await this.sessionsCollection.updateOne(
      { sessionId },
      {
        ...pushOps,
        $set: {
          judgeRunId: judgeResult.judgeRunId,
          updatedAt: updateNow,
        },
        $addToSet: {
          judgeRunIds: judgeResult.judgeRunId,
          findingIds: { $each: judgeResult.findingIds },
          reviewTaskIds: { $each: reviewTaskIds },
        } as any,
      },
    );

    return {
      judgeRunId: judgeResult.judgeRunId,
      findingIds: judgeResult.findingIds,
      reviewTaskIds,
    };
  }

  /**
   * Finalize the orchestration session.
   * Sets status='finalized', logs a summary entry.
   */
  async finalizeOrchestration(sessionId: string, summary?: string): Promise<OrchestrationSession> {
    const now = new Date();
    const dbSummary = await this.computeDbSummary(sessionId);
    const lifecycleStatus = ((dbSummary as any).status ?? 'partial') as OrchestrationSession['lifecycleStatus'];
    const summaryEntry: AgentDecisionEntry = {
      at: now,
      kind: 'summary',
      detail: summary ?? 'Orchestration session finalized.',
      metadata: { dbDerivedSummary: dbSummary },
    };

    await this.sessionsCollection.updateOne(
      { sessionId },
      {
        $push: { agentDecisionLog: summaryEntry } as any,
        $set: {
          status: 'finalized',
          lifecycleStatus,
          finalizedAt: now,
          updatedAt: now,
        },
      },
    );

    const updated = await this.getSession(sessionId);
    if (!updated) {
      throw new Error(`Session not found after finalize: ${sessionId}`);
    }
    return { ...updated, dbSummary } as any;
  }

  async computeDbSummary(sessionId: string): Promise<Record<string, unknown>> {
    const session = await this.sessionsCollection.findOne({ sessionId }) as OrchestrationSession | null;
    const sourceEvalDocs = await this.db
      .collection('context_source_evaluations')
      .find({ sessionId }, { projection: { sourceId: 1, sourceType: 1, decision: 1, status: 1, findingIds: 1, judgeRunId: 1 } })
      .toArray();

    const sourceEvalFindingIds = new Set<string>();
    const sourceEvalJudgeRunIds = new Set<string>();
    for (const evaluation of sourceEvalDocs) {
      const judgeRunId = (evaluation as any).judgeRunId as string | undefined;
      if (judgeRunId) sourceEvalJudgeRunIds.add(judgeRunId);
      for (const findingId of (((evaluation as any).findingIds as string[] | undefined) ?? [])) {
        sourceEvalFindingIds.add(findingId);
      }
    }

    const sessionFindingIds = Array.from(new Set([
      ...((session?.findingIds ?? []) as string[]),
      ...sourceEvalFindingIds,
    ]));
    const judgeRunIds = Array.from(new Set([
      ...(((session as any)?.judgeRunIds ?? []) as string[]),
      ...sourceEvalJudgeRunIds,
      ...(((session as any)?.judgeRunId ? [(session as any).judgeRunId] : []) as string[]),
    ]));

    const reviewTaskDocs = sessionFindingIds.length > 0
      ? await this.db.collection('context_review_tasks').find({
          $or: [
            { findingId: { $in: sessionFindingIds } },
            { attachedFindingIds: { $in: sessionFindingIds } },
            ...(session?.reviewTaskIds?.length ? [{ taskId: { $in: session.reviewTaskIds } }] : []),
          ],
        }).toArray()
      : ((session?.reviewTaskIds?.length ?? 0) > 0
          ? await this.db.collection('context_review_tasks').find({ taskId: { $in: session!.reviewTaskIds } }).toArray()
          : []);

    const reviewTaskIds = Array.from(new Set([
      ...((session?.reviewTaskIds ?? []) as string[]),
      ...reviewTaskDocs.map((task) => (task as any).taskId as string).filter(Boolean),
    ]));
    const findingCount = sessionFindingIds.length;
    const reviewTaskCount = reviewTaskIds.length;

    // GAP 4: assignments store taskIds: string[] (array), not taskId: string.
    // Use $in against the array field so any assignment covering one of the
    // session's review task IDs is counted correctly.
    const assignmentCount = reviewTaskIds.length > 0
      ? await this.db.collection('context_review_worker_assignments').countDocuments({
          taskIds: { $in: reviewTaskIds },
        })
      : 0;
    const remediationPlannerAssignmentCount = reviewTaskIds.length > 0
      ? await this.db.collection('context_review_worker_assignments').countDocuments({
          taskIds: { $in: reviewTaskIds },
          workerRole: 'context_remediation_planner',
        })
      : 0;
    const triageAssignmentCount = reviewTaskIds.length > 0
      ? await this.db.collection('context_review_worker_assignments').countDocuments({
          taskIds: { $in: reviewTaskIds },
          workerRole: 'context_review_triage',
        })
      : 0;
    const learningAssignmentCount = await this.db.collection('context_review_worker_assignments').countDocuments({
      workerRole: 'context_learning_curator',
      status: { $in: ['queued', 'running', 'completed', 'failed'] },
    });
    let fixAssignmentCount = 0;
    let qaAssignmentCount = 0;

    // DB-derived human review gate counts.
    // Verify persisted review tasks AFTER submit to surface gate reasoning correctly.
    // The agent's pre-submit gate log may say "no gates" but the DB may require human
    // review due to impactScope or other finding-level properties. Always derive from DB.
    const humanReviewCount = reviewTaskIds.length > 0
      ? await this.db.collection('context_review_tasks').countDocuments({
          taskId: { $in: reviewTaskIds },
          requiresHumanReview: true,
        })
      : 0;
    const autoRemediationCount = reviewTaskCount - humanReviewCount;
    const readyAutoRemediationCount = reviewTaskIds.length > 0
      ? await this.db.collection('context_review_tasks').countDocuments({
          taskId: { $in: reviewTaskIds },
          requiresHumanReview: false,
          remediationStatus: { $in: ['ready', 'triaged', 'planning_failed'] },
        })
      : 0;

    // GAP 3: Source evaluation coverage counts from context_source_evaluations.
    // These are DB-derived from the durable ledger, not agent tallies.
    const sourceEvalCounts = await this.sourceEvalService.countBySession(sessionId);

    // Trace-specific counts from context_source_evaluations
    const hasTraceEvals = sourceEvalCounts.byType['context_usage_trace'] !== undefined
      && sourceEvalCounts.byType['context_usage_trace'] > 0;

    const [
      contextTraceFindingCount,
      contextTraceNoIssueCount,
      contextTraceSkippedCount,
      contextTraceErrorCount,
    ] = hasTraceEvals
      ? await Promise.all([
          this.db.collection('context_source_evaluations').countDocuments({
            sessionId, sourceType: 'context_usage_trace', decision: 'finding_created',
          }),
          this.db.collection('context_source_evaluations').countDocuments({
            sessionId, sourceType: 'context_usage_trace', decision: 'no_issue',
          }),
          this.db.collection('context_source_evaluations').countDocuments({
            sessionId, sourceType: 'context_usage_trace', decision: 'skipped',
          }),
          this.db.collection('context_source_evaluations').countDocuments({
            sessionId, sourceType: 'context_usage_trace', decision: 'error',
          }),
        ])
      : [0, 0, 0, 0];

    // Total evaluated traces = finding_created + no_issue (actionably evaluated)
    // Total processed traces = evaluated + skipped + error
    const contextTraceEvaluatedCount = sourceEvalCounts.byType['context_usage_trace'] ?? 0;

    // Remediation counts from findings / judge runs / review tasks linked to this session.
    // Review tasks can be clustered and shared across sessions, so taskId-only matching
    // must not pull another session's finding-specific remediation into this summary.
    const remediationClauses: Record<string, unknown>[] = [];
    remediationClauses.push({ sessionId });
    if (session?.rootExecutionId) {
      remediationClauses.push({ rootExecutionId: session.rootExecutionId });
    }
    if (sessionFindingIds.length > 0) {
      remediationClauses.push({ findingId: { $in: sessionFindingIds } });
    }
    if (judgeRunIds.length > 0) {
      remediationClauses.push({ judgeRunId: { $in: judgeRunIds } });
    }
    if (reviewTaskIds.length > 0) {
      const taskClause: Record<string, unknown> = { taskId: { $in: reviewTaskIds } };
      if (sessionFindingIds.length > 0) {
        taskClause['$or'] = [
          { findingId: { $exists: false } },
          { findingId: null },
          { findingId: { $in: sessionFindingIds } },
        ];
      }
      remediationClauses.push(taskClause);
    }
    const remediationFilter = remediationClauses.length > 0 ? { $or: remediationClauses } : null;
    const remediationCount = remediationFilter
      ? await this.db.collection('context_remediations').countDocuments(remediationFilter)
      : 0;
    const remediationsByStatus: Record<string, number> = {};
    const remediationsByKind: Record<string, number> = {};
    const fixRemediationsByStatus: Record<string, number> = {};
    let remediationIds: string[] = [];
    let pendingFixRemediationIds: string[] = [];
    if (remediationFilter && remediationCount > 0) {
      const remediationDocs = await this.db
        .collection('context_remediations')
        .find(remediationFilter, { projection: { remediationId: 1, status: 1, remediationKind: 1, workerRole: 1, humanGateRequired: 1 } })
        .toArray();
      remediationIds = remediationDocs.map((r) => (r as any).remediationId as string).filter(Boolean);
      for (const r of remediationDocs) {
        const s = (r as any).status as string;
        if (s) remediationsByStatus[s] = (remediationsByStatus[s] ?? 0) + 1;
        const k = (r as any).remediationKind as string;
        if (k) remediationsByKind[k] = (remediationsByKind[k] ?? 0) + 1;
        const workerRole = (r as any).workerRole as string | undefined;
        const isFixRemediation = [
          'context_curation_fix',
          'curation_fix',
          'context_ingestion_repair',
          'ingestion_repair',
          'context_code_fix',
          'code_fix',
        ].includes(workerRole ?? '');
        if (isFixRemediation && s) {
          fixRemediationsByStatus[s] = (fixRemediationsByStatus[s] ?? 0) + 1;
        }
        const isNonHumanGatedCurationFix = [
          'context_curation_fix',
          'curation_fix',
          'context_ingestion_repair',
          'ingestion_repair',
        ].includes(workerRole ?? '') && (r as any).humanGateRequired !== true;
        if (isNonHumanGatedCurationFix && s === 'pending') {
          const remediationId = (r as any).remediationId as string | undefined;
          if (remediationId) pendingFixRemediationIds.push(remediationId);
        }
      }
    }
    let unassignedPendingFixRemediationCount = 0;
    let nonTerminalFixAssignmentCount = 0;
    if (remediationIds.length > 0) {
      fixAssignmentCount = await this.db.collection('context_review_worker_assignments').countDocuments({
        workerRole: { $in: ['context_curation_fix', 'curation_fix', 'context_ingestion_repair', 'ingestion_repair', 'context_code_fix', 'code_fix'] },
        $or: [
          { remediationIds: { $in: remediationIds } },
          { taskIds: { $in: remediationIds } },
        ],
      });
      nonTerminalFixAssignmentCount = await this.db.collection('context_review_worker_assignments').countDocuments({
        workerRole: { $in: ['context_curation_fix', 'curation_fix', 'context_ingestion_repair', 'ingestion_repair', 'context_code_fix', 'code_fix'] },
        status: { $in: ['queued', 'running'] },
        $or: [
          { remediationIds: { $in: remediationIds } },
          { taskIds: { $in: remediationIds } },
        ],
      });
      qaAssignmentCount = await this.db.collection('context_review_worker_assignments').countDocuments({
        workerRole: { $in: ['context_qa_eval', 'qa_eval'] },
        $or: [
          { remediationIds: { $in: remediationIds } },
          { taskIds: { $in: remediationIds } },
        ],
      });
    }
    if (pendingFixRemediationIds.length > 0) {
      const assignedPendingFixDocs = await this.db.collection('context_review_worker_assignments')
        .find({
          workerRole: { $in: ['context_curation_fix', 'curation_fix', 'context_ingestion_repair', 'ingestion_repair'] },
          status: { $in: ['queued', 'running', 'completed', 'failed'] },
          $or: [
            { remediationIds: { $in: pendingFixRemediationIds } },
            { taskIds: { $in: pendingFixRemediationIds } },
          ],
        }, { projection: { remediationIds: 1, taskIds: 1 } })
        .toArray();
      const assignedPendingFixIds = new Set<string>();
      for (const assignment of assignedPendingFixDocs) {
        for (const remediationId of (((assignment as any).remediationIds ?? []) as string[])) assignedPendingFixIds.add(remediationId);
        for (const taskId of (((assignment as any).taskIds ?? []) as string[])) assignedPendingFixIds.add(taskId);
      }
      unassignedPendingFixRemediationCount = pendingFixRemediationIds.filter((id) => !assignedPendingFixIds.has(id)).length;
    }

    // ── Trace analysis assignment coverage ────────────────────────────────────
    // DB-derived counts from context_trace_analysis_assignments for this session.
    const traceAssignmentCounts = await this.traceAssignmentService.countBySession(sessionId);

    const assignedTraceCount = traceAssignmentCounts.totalAssigned;
    const evaluatedTraceCount = traceAssignmentCounts.totalEvaluated;
    const skippedTraceCount = traceAssignmentCounts.totalSkipped;
    const failedTraceCount = traceAssignmentCounts.totalFailed;
    const effectiveAssignedTraceCount = traceAssignmentCounts.effectiveAssignedTraceCount;
    const effectiveEvaluatedTraceCount = traceAssignmentCounts.effectiveEvaluatedTraceCount;
    const effectiveSkippedTraceCount = traceAssignmentCounts.effectiveSkippedTraceCount;
    const effectiveFailedTraceCount = traceAssignmentCounts.effectiveFailedTraceCount;
    const retriedTraceCount = traceAssignmentCounts.retriedTraceCount;
    const ignoredSelfTraceCount = traceAssignmentCounts.ignoredSelfTraceCount;
    // Unevaluated = assigned traces not yet accounted for by the durable evaluation ledger.
    // Assignment counters can lag while workers are still running, so use effective
    // source-evaluation counts for coverage and keep non-terminal assignment status
    // as the separate completion gate below.
    const unevaluatedTraceCount = Math.max(
      0,
      effectiveAssignedTraceCount - effectiveEvaluatedTraceCount - effectiveSkippedTraceCount - ignoredSelfTraceCount,
    );

    const traceAssignmentCount = traceAssignmentCounts.total;
    const completedTraceAssignmentCount = traceAssignmentCounts.byStatus['completed'] ?? 0;
    const failedTraceAssignmentCount = traceAssignmentCounts.byStatus['failed'] ?? 0;

    // ── Decision distribution ─────────────────────────────────────────────────
    const decisionsByType: Record<string, number> = {};
    for (const [decision, count] of Object.entries(sourceEvalCounts.byDecision)) {
      if (count !== undefined) decisionsByType[decision] = count;
    }

    // ── Findings by classification ─────────────────────────────────────────────
    const findingsByClassification: Record<string, number> = {};
    if (findingCount > 0 && sessionFindingIds.length > 0) {
      const findingDocs = await this.db
        .collection('context_findings')
        .find({ findingId: { $in: sessionFindingIds } }, { projection: { classification: 1 } })
        .toArray();
      for (const f of findingDocs) {
        const cls = (f as any).classification as string;
        if (cls) findingsByClassification[cls] = (findingsByClassification[cls] ?? 0) + 1;
      }
    }

    // ── Final status determination ─────────────────────────────────────────────
    // Non-terminal assignments: queued or running assignments mean work is still in flight.
    // Even if count math happens to balance (e.g. evaluatedCount === assignedCount but
    // the assignment itself is still running), we must NOT declare completed prematurely.
    const nonTerminalTraceAssignmentCount =
      (traceAssignmentCounts.byStatus['queued'] ?? 0) +
      (traceAssignmentCounts.byStatus['running'] ?? 0);

    // Completed: all assigned traces are accounted for (evaluated + skipped + failed),
    // no unevaluated traces remain, AND every assignment has reached a terminal state.
    const isComplete =
      unevaluatedTraceCount === 0 &&
      nonTerminalTraceAssignmentCount === 0 &&
      assignedTraceCount > 0 &&
      effectiveFailedTraceCount === 0 &&
      effectiveAssignedTraceCount <= effectiveEvaluatedTraceCount + effectiveSkippedTraceCount + ignoredSelfTraceCount &&
      !(autoRemediationCount > 0 && remediationPlannerAssignmentCount === 0 && remediationCount === 0) &&
      pendingFixRemediationIds.length === 0 &&
      unassignedPendingFixRemediationCount === 0 &&
      nonTerminalFixAssignmentCount === 0;

    // Partial: some assignments completed but unevaluated traces or non-terminal assignments remain.
    // Incomplete: no assignments were created yet / all failed.
    const finalStatus: 'completed' | 'partial' | 'incomplete' = isComplete
      ? 'completed'
      : (traceAssignmentCount > 0 ? 'partial' : 'incomplete');

    return {
      // ── Backward-compatible existing fields ───────────────────────────────
      dbDerivedFindingCount: findingCount,
      dbDerivedReviewTaskCount: reviewTaskCount,
      dbDerivedHumanReviewCount: humanReviewCount,
      dbDerivedAutoRemediationCount: autoRemediationCount,
      dbDerivedReadyAutoRemediationCount: readyAutoRemediationCount,
      dbDerivedAssignmentCount: assignmentCount,
      dbDerivedTriageAssignmentCount: triageAssignmentCount,
      dbDerivedLearningAssignmentCount: learningAssignmentCount,
      dbDerivedRemediationPlannerAssignmentCount: remediationPlannerAssignmentCount,
      // GAP 5
      dbDerivedRemediationCount: remediationCount,
      remediationsByStatus,
      remediationsByKind,
      fixRemediationsByStatus,
      pendingFixRemediationCount: pendingFixRemediationIds.length,
      unassignedPendingFixRemediationCount,
      nonTerminalFixAssignmentCount,
      // GAP 3
      dbDerivedSourceEvaluationCount: sourceEvalCounts.total,
      sourceEvaluationsByType: sourceEvalCounts.byType,
      sourceEvaluationsByDecision: sourceEvalCounts.byDecision,
      // contextTraceDiscoveredCount: use evaluatedCount as proxy (spec-approved)
      contextTraceDiscoveredCount: contextTraceEvaluatedCount,
      contextTraceEvaluatedCount,
      contextTraceFindingCount,
      contextTraceNoIssueCount,
      contextTraceSkippedCount,
      contextTraceErrorCount,
      judgeRunId: ((session as any)?.judgeRunId as string | undefined) ?? null,
      judgeRunIds,
      sessionFindingIds,
      sessionReviewTaskIds: reviewTaskIds,
      runScope: (session as any)?.runScope ?? null,
      dry_run: (session as any)?.dry_run ?? false,
      // ── New ENG-1760 trace coverage fields ────────────────────────────────
      discoveredTraceCount: assignedTraceCount, // all assigned = all discovered so far
      assignedTraceCount,
      evaluatedTraceCount,
      skippedTraceCount,
      failedTraceCount,
      effectiveAssignedTraceCount,
      effectiveEvaluatedTraceCount,
      effectiveSkippedTraceCount,
      effectiveFailedTraceCount,
      retriedTraceCount,
      ignoredSelfTraceCount,
      unevaluatedTraceCount,
      traceAssignmentCount,
      completedTraceAssignmentCount,
      failedTraceAssignmentCount,
      nonTerminalTraceAssignmentCount,
      decisionsByType,
      findingsByClassification,
      autoClusteredReviewTaskCount: reviewTaskDocs.filter((task) => ((task as any).attachedFindingIds ?? []).length > 0).length,
      fixAssignmentCount,
      qaAssignmentCount,
      status: finalStatus,
    };
  }

  async getSessionWithSummary(sessionId: string): Promise<(OrchestrationSession & { dbSummary: Record<string, unknown>; stageState: Record<string, unknown> }) | null> {
    const session = await this.getSession(sessionId);
    if (!session) return null;
    const dbSummary = await this.computeDbSummary(sessionId);
    const stageState = await this.computeStageState(sessionId, dbSummary);
    return { ...session, dbSummary, stageState } as any;
  }

  async computeStageState(sessionId: string, existingSummary?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const summary = existingSummary ?? await this.computeDbSummary(sessionId);
    const traceAssignments = await this.traceAssignmentService.countBySession(sessionId);
    const hasFindings = Number(summary['dbDerivedFindingCount'] ?? 0) > 0;
    const hasReviewTasks = Number(summary['dbDerivedReviewTaskCount'] ?? 0) > 0;
    const readyAutoRemediationCount = Number(summary['dbDerivedReadyAutoRemediationCount'] ?? 0);
    const remediationCount = Number(summary['dbDerivedRemediationCount'] ?? 0);
    const pendingFixRemediationCount = Number(summary['pendingFixRemediationCount'] ?? 0);
    const unassignedPendingFixRemediationCount = Number(summary['unassignedPendingFixRemediationCount'] ?? 0);
    const nonTerminalFixAssignmentCount = Number(summary['nonTerminalFixAssignmentCount'] ?? 0);
    const fixAssignmentCount = Number(summary['fixAssignmentCount'] ?? 0);
    const qaAssignmentCount = Number(summary['qaAssignmentCount'] ?? 0);
    const completedRemediationCount = Number((summary['remediationsByStatus'] as Record<string, number> | undefined)?.['completed'] ?? 0);
    const fixStageRequired = remediationCount > 0 && (
      pendingFixRemediationCount > 0 ||
      unassignedPendingFixRemediationCount > 0 ||
      nonTerminalFixAssignmentCount > 0 ||
      fixAssignmentCount === 0 ||
      (completedRemediationCount > 0 && qaAssignmentCount === 0)
    );
    const stages = {
      stage_3_trace_analysis: {
        status: traceAssignments.total === 0
          ? 'not_started'
          : (traceAssignments.effectiveFailedTraceCount > 0 ? 'partial' : 'completed'),
        effectiveFailedTraceCount: traceAssignments.effectiveFailedTraceCount,
        retriedTraceCount: traceAssignments.retriedTraceCount,
        ignoredSelfTraceCount: traceAssignments.ignoredSelfTraceCount,
      },
      stage_4_learning_curation: {
        status: Number(summary['dbDerivedLearningAssignmentCount'] ?? 0) > 0 ? 'completed' : 'not_started',
      },
      stage_5_triage: {
        status: Number(summary['dbDerivedTriageAssignmentCount'] ?? 0) > 0
          ? 'completed'
          : (hasFindings || hasReviewTasks ? 'required' : 'skipped'),
        reason: hasFindings || hasReviewTasks ? undefined : 'No findings or review tasks.',
      },
      stage_6_remediation_planning: {
        status: Number(summary['dbDerivedRemediationPlannerAssignmentCount'] ?? 0) > 0
          ? 'completed'
          : (readyAutoRemediationCount > 0 || (hasFindings && remediationCount === 0) ? 'required' : 'skipped'),
      },
      stage_7_fix_qa: {
        status: remediationCount === 0
          ? 'not_started'
          : (fixStageRequired ? 'required' : 'completed'),
        pendingFixRemediationCount,
        unassignedPendingFixRemediationCount,
        nonTerminalFixAssignmentCount,
        fixAssignmentCount,
        qaAssignmentCount,
      },
    };
    const nextRequiredStage = Object.entries(stages).find(([, value]) => (value as any).status === 'required')?.[0] ?? null;
    return { stages, nextRequiredStage, dbSummary: summary };
  }

  async getRepairResumeState(input: { sessionId?: string; rootExecutionId?: string }): Promise<Record<string, unknown>> {
    let session: OrchestrationSession | null = null;
    if (input.sessionId) {
      session = await this.getSession(input.sessionId);
    } else if (input.rootExecutionId) {
      session = await this.sessionsCollection.findOne({ rootExecutionId: input.rootExecutionId }) as OrchestrationSession | null;
    }
    if (!session) {
      return {
        found: false,
        reason: 'No context orchestration session found for the provided identifier.',
      };
    }
    const dbSummary = await this.computeDbSummary(session.sessionId);
    const stageState = await this.computeStageState(session.sessionId, dbSummary);
    const unresolvedTraceSources = await this.db.collection('context_trace_analysis_assignments')
      .find({
        sessionId: session.sessionId,
        status: 'failed',
        $or: [
          { supersededByAssignmentIds: { $exists: false } },
          { supersededByAssignmentIds: { $size: 0 } },
        ],
      }, { projection: { _id: 0, assignmentId: 1, sourceIds: 1 } })
      .toArray();
    const findingEvaluationsWithoutRemediation = await this.db.collection('context_source_evaluations')
      .aggregate([
        { $match: { sessionId: session.sessionId, decision: 'finding_created', findingIds: { $exists: true, $ne: [] } } },
        { $unwind: '$findingIds' },
        {
          $lookup: {
            from: 'context_remediations',
            localField: 'findingIds',
            foreignField: 'findingId',
            as: 'remediations',
          },
        },
        { $match: { remediations: { $size: 0 } } },
        { $project: { _id: 0, sourceId: 1, findingId: '$findingIds', affectedRefIds: 1, remediationHints: 1 } },
      ])
      .toArray();
    return {
      found: true,
      sessionId: session.sessionId,
      rootExecutionId: session.rootExecutionId ?? input.rootExecutionId,
      lifecycleStatus: session.lifecycleStatus,
      nextRequiredStage: (stageState as any).nextRequiredStage,
      dbSummary,
      stageState,
      unresolvedTraceSources,
      findingEvaluationsWithoutRemediation,
    };
  }

  /**
   * Retrieve a single session by sessionId.
   */
  async getSession(sessionId: string): Promise<OrchestrationSession | null> {
    return this.sessionsCollection.findOne({ sessionId }) as Promise<OrchestrationSession | null>;
  }

  /**
   * List sessions with optional filters.
   */
  async listSessions(params: {
    scope?: JudgeScope;
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<OrchestrationSession[]> {
    const filter: Record<string, unknown> = {};
    if (params.scope) filter.scope = params.scope;
    if (params.status) filter.status = params.status;
    const limit = Math.min(params.limit ?? 50, 200);
    const offset = params.offset ?? 0;
    return this.sessionsCollection
      .find(filter as any)
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limit)
      .toArray() as Promise<OrchestrationSession[]>;
  }

  /**
   * Mark a session as failed, logging the reason.
   */
  async failSession(sessionId: string, reason: string): Promise<void> {
    const now = new Date();
    const errorEntry: AgentDecisionEntry = {
      at: now,
      kind: 'summary',
      detail: `Session failed: ${reason}`,
      metadata: { error: reason },
    };
    await this.sessionsCollection.updateOne(
      { sessionId },
      {
        $push: { agentDecisionLog: errorEntry } as any,
        $set: {
          status: 'failed',
          updatedAt: now,
        },
      },
    );
  }

  // ── OrchestratorRunRecord methods ────────────────────────────────────────────

  /**
   * Create a new orchestrator run record with status='triggered'.
   */
  async createRunRecord(input: {
    triggeredBy: OrchestratorRunRecord['triggeredBy'];
    repoId?: string;
    repoIds?: string[];
    global: boolean;
    sessionId?: string;
  }): Promise<OrchestratorRunRecord> {
    const now = new Date();
    // Fix 3: derive runScope from input — never persist a repo-filtered run as global
    const runScope: RunScope =
      input.repoId
        ? 'repo'
        : (input.repoIds && input.repoIds.length > 0 ? 'multi_repo' : 'global');
    const record: OrchestratorRunRecord = {
      runId: randomUUID(),
      sessionId: input.sessionId,
      triggeredBy: input.triggeredBy,
      repoId: input.repoId,
      repoIds: input.repoIds,
      global: input.global,
      runScope,
      countDiscovered: 0,
      countSkipped: 0,
      countEvaluated: 0,
      countGrouped: 0,
      countTasksCreated: 0,
      assignmentLaunches: 0,
      errors: [],
      status: 'triggered',
      triggeredAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await this.runRecordsCollection.insertOne(record as any);
    return record;
  }

  /**
   * Update an existing run record by runId.
   */
  async updateRunRecord(runId: string, patch: Partial<OrchestratorRunRecord>): Promise<boolean> {
    const now = new Date();
    const update: Record<string, unknown> = { ...patch, updatedAt: now };
    // Remove runId from patch to avoid overwriting the key
    delete update['runId'];
    delete update['createdAt'];
    const result = await this.runRecordsCollection.updateOne(
      { runId },
      { $set: update },
    );
    return result.modifiedCount > 0;
  }

  /**
   * Retrieve a single run record by runId.
   */
  async getRunRecord(runId: string): Promise<OrchestratorRunRecord | null> {
    return this.runRecordsCollection.findOne({ runId }) as Promise<OrchestratorRunRecord | null>;
  }

  /**
   * List run records with optional filters.
   */
  async listRunRecords(params: {
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<OrchestratorRunRecord[]> {
    const filter: Record<string, unknown> = {};
    if (params.status) filter['status'] = params.status;
    const limit = Math.min(params.limit ?? 50, 200);
    const offset = params.offset ?? 0;
    return this.runRecordsCollection
      .find(filter as any)
      .sort({ triggeredAt: -1 })
      .skip(offset)
      .limit(limit)
      .toArray() as Promise<OrchestratorRunRecord[]>;
  }
}
