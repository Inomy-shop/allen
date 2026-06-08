import { randomUUID } from 'node:crypto';
import type { Db, Collection } from 'mongodb';
import type {
  JudgeRun,
  JudgeScope,
  DeterministicScoreInput,
  Finding,
  FindingClassification,
  FixType,
  Risk,
  Severity,
  EvidenceRef,
  ReliabilityLabel,
  RunScope,
  ImpactScope,
} from './context-judge.types.js';
import {
  calibrateScores,
  aggregateReliabilityLabel,
  calibrateReliabilityFromConfidence,
} from './deterministic-reliability-calibrator.js';

export interface JudgeRunInput {
  scope?: JudgeScope;           // defaults to 'workflow'
  /** Scope of THIS run — which repos were evaluated. Inferred from repoId when not provided. */
  runScope?: RunScope;
  sourceId?: string;
  sourceKind?: string;
  repoId?: string;
  trigger?: 'auto' | 'manual' | 'rejudge';
  provider?: string;
  model?: string;
  deterministicScores?: DeterministicScoreInput[];
  rawFindings?: Array<{
    classification: FindingClassification;
    fixType: FixType;
    severity: Severity;
    risk: Risk;
    confidence: number;
    evidence?: EvidenceRef[];
    suggestedRemediation?: string;
    learningId?: string;
    // ── Fix 5: source traceability ──────────────────────────────────────
    primarySourceId?: string;
    sourceRefs?: string[];
    executionId?: string;
    contextAttemptId?: string;
    /** Impact scope for this specific finding (may differ from run scope). */
    impactScope?: ImpactScope;
  }>;
}

export interface JudgeRunResult {
  judgeRunId: string;
  scope: JudgeScope;
  findingIds: string[];
  reliabilityLabel: ReliabilityLabel;
  supersededRunId?: string;
  alreadyEvaluated?: boolean;
}

export class ContextJudgeService {
  private runsCollection: Collection<JudgeRun>;
  private findingsCollection: Collection<Finding>;

  constructor(private db: Db) {
    this.runsCollection = db.collection<JudgeRun>('context_judge_runs');
    this.findingsCollection = db.collection<Finding>('context_findings');
  }

  /**
   * Create a new judge run. Default scope is 'workflow' (AC-01).
   * Per-node judging uses scope='node' (AC-02).
   * Learning judging uses scope='learning' (AC-03).
   * Re-judge supersedes prior active run for same source (AC-20).
   */
  async judge(input: JudgeRunInput): Promise<JudgeRunResult> {
    const scope: JudgeScope = input.scope ?? 'workflow';
    const now = new Date();
    const judgeRunId = randomUUID();

    // ── sourceKey idempotency ─────────────────────────────────────────────────
    // When sourceId and sourceKind are both set and this is NOT a rejudge,
    // return the existing completed run to avoid duplicate evaluation.
    if (input.sourceId && input.sourceKind && input.trigger !== 'rejudge') {
      const sourceKey = `${input.sourceKind}:${input.sourceId}`;
      const existing = await this.runsCollection.findOne({ sourceKey, status: 'completed', active: true });
      if (existing) {
        return {
          judgeRunId: existing.judgeRunId,
          scope: existing.scope,
          findingIds: [],
          reliabilityLabel: existing.deterministicReliability[0]?.reliabilityLabel ?? 'needs_judge',
          alreadyEvaluated: true,
        };
      }
    }

    // Check for existing active run on same source (for supersession, AC-20)
    let supersededRunId: string | undefined;
    if (input.sourceId) {
      const priorRun = await this.runsCollection.findOne({
        sourceId: input.sourceId,
        scope,
        active: true,
      });
      if (priorRun) {
        supersededRunId = priorRun.judgeRunId;
        // Supersede: preserve history, set validTo, active=false (AC-20)
        await this.runsCollection.updateOne(
          { judgeRunId: supersededRunId },
          {
            $set: {
              active: false,
              validTo: now,
              supersededAt: now,
              supersededBy: judgeRunId,
              updatedAt: now,
            },
          },
        );
        // Also supersede active findings from the old run
        await this.findingsCollection.updateMany(
          { judgeRunId: supersededRunId, active: true },
          {
            $set: {
              active: false,
              status: 'superseded',
              validTo: now,
              supersededAt: now,
              updatedAt: now,
            },
          },
        );
      }
    }

    // Calibrate deterministic scores
    const calibratedScores = calibrateScores(input.deterministicScores ?? []);
    // overallReliabilityLabel is used when no per-finding confidence is available
    // and no deterministic scores exist. When both are absent, it defaults to 'signal_only'
    // which is intentionally conservative. Per-finding labels are derived from confidence (fix 6).
    const overallReliabilityLabel = aggregateReliabilityLabel(calibratedScores);
    const hasDeterministicScores = calibratedScores.length > 0;

    // Derive runScope from input or from repoId presence
    const runScope: RunScope | undefined =
      input.runScope ?? (input.repoId ? 'repo' : 'global');

    // Create findings
    const findingIds: string[] = [];
    for (const rawFinding of input.rawFindings ?? []) {
      const findingId = randomUUID();

      // Fix 6: Reliability calibration — when no deterministic scores exist, derive
      // per-finding reliability from agent-reported confidence. High-confidence findings
      // should NOT default to signal_only just because deterministicScores is empty.
      const findingReliabilityLabel: ReliabilityLabel = hasDeterministicScores
        ? overallReliabilityLabel
        : calibrateReliabilityFromConfidence(rawFinding.confidence);

      const finding: Finding = {
        findingId,
        judgeRunId,
        scope,
        impactScope: rawFinding.impactScope,
        repoId: input.repoId,
        sourceId: input.sourceId,
        // Fix 5: top-level source traceability
        primarySourceId: rawFinding.primarySourceId ?? input.sourceId,
        sourceKind: rawFinding.contextAttemptId
          ? 'context_usage_trace'
          : (input.sourceKind ?? undefined),
        sourceRefs: rawFinding.sourceRefs,
        executionId: rawFinding.executionId,
        contextAttemptId: rawFinding.contextAttemptId,
        classification: rawFinding.classification,
        fixType: rawFinding.fixType,
        severity: rawFinding.severity,
        risk: rawFinding.risk,
        confidence: rawFinding.confidence,
        reliabilityLabel: findingReliabilityLabel,
        evidence: rawFinding.evidence ?? [],
        suggestedRemediation: rawFinding.suggestedRemediation,
        status: 'open',
        learningId: rawFinding.learningId,
        active: true,
        version: 1,
        validFrom: now,
        createdAt: now,
        updatedAt: now,
      };
      await this.findingsCollection.insertOne(finding as any);
      findingIds.push(findingId);
    }

    // Build findings summary
    const findingsSummary = {
      total: findingIds.length,
      bySeverity: {} as Record<string, number>,
      byClassification: {} as Record<string, number>,
    };
    for (const rawFinding of input.rawFindings ?? []) {
      findingsSummary.bySeverity[rawFinding.severity] =
        (findingsSummary.bySeverity[rawFinding.severity] ?? 0) + 1;
      findingsSummary.byClassification[rawFinding.classification] =
        (findingsSummary.byClassification[rawFinding.classification] ?? 0) + 1;
    }

    // Create judge run audit row (AC-21)
    const judgeRun: JudgeRun = {
      judgeRunId,
      scope,
      runScope,
      sourceId: input.sourceId,
      sourceKind: input.sourceKind,
      sourceKey: (input.sourceKind && input.sourceId)
        ? `${input.sourceKind}:${input.sourceId}`
        : undefined,
      repoId: input.repoId,
      status: 'completed',
      trigger: input.trigger ?? 'auto',
      provider: input.provider,
      model: input.model,
      deterministicReliability: calibratedScores,
      findingsSummary,
      active: true,
      version: 1,
      validFrom: now,
      createdAt: now,
      updatedAt: now,
    };
    await this.runsCollection.insertOne(judgeRun as any);

    return {
      judgeRunId,
      scope,
      findingIds,
      reliabilityLabel: overallReliabilityLabel,
      supersededRunId,
    };
  }

  async getJudgeRun(judgeRunId: string): Promise<JudgeRun | null> {
    return this.runsCollection.findOne({ judgeRunId }) as Promise<JudgeRun | null>;
  }

  async listJudgeRuns(params: {
    scope?: JudgeScope;
    status?: string;
    active?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<JudgeRun[]> {
    const filter: Record<string, unknown> = {};
    if (params.scope) filter.scope = params.scope;
    if (params.status) filter.status = params.status;
    if (params.active !== undefined) filter.active = params.active;
    const limit = Math.min(params.limit ?? 50, 200);
    const offset = params.offset ?? 0;
    return this.runsCollection.find(filter).sort({ createdAt: -1 }).skip(offset).limit(limit).toArray() as Promise<JudgeRun[]>;
  }
}
