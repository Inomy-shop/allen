import { randomUUID } from 'node:crypto';
import type { Db, Collection } from 'mongodb';
import type {
  Finding,
  JudgeScope,
  FindingClassification,
  FixType,
  Risk,
  Severity,
  EvidenceRef,
  ReliabilityLabel,
  ImpactScope,
} from './context-judge.types.js';
import { AUTO_CURATION_CONFIDENCE_THRESHOLD } from './context-judge-policy.js';

export interface CreateFindingInput {
  judgeRunId: string;
  scope: JudgeScope;
  impactScope?: ImpactScope;
  repoId?: string;
  sourceId?: string;
  // ── Fix 5: source traceability ──────────────────────────────────────────────
  primarySourceId?: string;
  sourceKind?: string;
  sourceRefs?: string[];
  executionId?: string;
  contextAttemptId?: string;
  classification: FindingClassification;
  fixType: FixType;
  severity: Severity;
  risk: Risk;
  confidence: number;
  reliabilityLabel: ReliabilityLabel;
  evidence?: EvidenceRef[];
  suggestedRemediation?: string;
  learningId?: string;   // AC-07
}

export interface FindingRoutingDecision {
  requiresHumanReview: boolean;
  reason?: string;
  autoRemediationAllowed: boolean;
}

export class ContextFindingService {
  private collection: Collection<Finding>;

  constructor(private db: Db) {
    this.collection = db.collection<Finding>('context_findings');
  }

  async create(input: CreateFindingInput): Promise<Finding> {
    const now = new Date();
    const finding: Finding = {
      findingId: randomUUID(),
      judgeRunId: input.judgeRunId,
      scope: input.scope,
      impactScope: input.impactScope,
      repoId: input.repoId,
      sourceId: input.sourceId,
      primarySourceId: input.primarySourceId ?? input.sourceId,
      sourceKind: input.sourceKind,
      sourceRefs: input.sourceRefs,
      executionId: input.executionId,
      contextAttemptId: input.contextAttemptId,
      classification: input.classification,
      fixType: input.fixType,
      severity: input.severity,
      risk: input.risk,
      confidence: input.confidence,
      reliabilityLabel: input.reliabilityLabel,
      evidence: input.evidence ?? [],
      suggestedRemediation: input.suggestedRemediation,
      status: 'open',
      learningId: input.learningId,
      active: true,
      version: 1,
      validFrom: now,
      createdAt: now,
      updatedAt: now,
    };
    await this.collection.insertOne(finding as any);
    return finding;
  }

  async getById(findingId: string): Promise<Finding | null> {
    return this.collection.findOne({ findingId }) as Promise<Finding | null>;
  }

  async list(params: {
    scope?: JudgeScope;
    judgeRunId?: string;
    status?: string;
    reliabilityLabel?: ReliabilityLabel;
    active?: boolean;
    learningId?: string;
    limit?: number;
    offset?: number;
  }): Promise<Finding[]> {
    const filter: Record<string, unknown> = {};
    if (params.scope) filter.scope = params.scope;
    if (params.judgeRunId) filter.judgeRunId = params.judgeRunId;
    if (params.status) filter.status = params.status;
    if (params.reliabilityLabel) filter.reliabilityLabel = params.reliabilityLabel;
    if (params.active !== undefined) filter.active = params.active;
    if (params.learningId) filter.learningId = params.learningId;  // AC-07
    const limit = Math.min(params.limit ?? 50, 200);
    const offset = params.offset ?? 0;
    return this.collection.find(filter).sort({ createdAt: -1 }).skip(offset).limit(limit).toArray() as Promise<Finding[]>;
  }

  async update(
    findingId: string,
    patch: Partial<Pick<Finding, 'status' | 'suggestedRemediation' | 'reliabilityLabel'>>,
  ): Promise<boolean> {
    const result = await this.collection.updateOne(
      { findingId, active: true },
      { $set: { ...patch, updatedAt: new Date() } },
    );
    return result.modifiedCount > 0;
  }

  /**
   * Supersede a finding when re-judging. Preserves history (AC-20).
   * Sets active=false, validTo, supersededAt, supersededBy on the old finding.
   */
  async supersede(
    oldFindingId: string,
    newFindingId: string,
  ): Promise<boolean> {
    const now = new Date();
    const result = await this.collection.updateOne(
      { findingId: oldFindingId, active: true },
      {
        $set: {
          active: false,
          status: 'superseded',
          validTo: now,
          supersededAt: now,
          supersededBy: newFindingId,
          updatedAt: now,
        },
      },
    );
    return result.modifiedCount > 0;
  }

  /**
   * Determine routing requirements for a finding.
   * AC-18 gate logic — used by review service in MS-002.
   *
   * Fix 3: Gate checks use impactScope (what is affected), NOT the run/session scope.
   * A repo-scoped run that discovers a cross-repo finding must trigger human review
   * based on the finding's impactScope, not the orchestrator's session scope.
   */
  routingDecision(finding: Pick<Finding, 'confidence' | 'risk' | 'scope' | 'fixType' | 'learningId' | 'impactScope'>): FindingRoutingDecision {
    if (finding.fixType === 'code_fix') {
      return { requiresHumanReview: true, reason: 'code_fix', autoRemediationAllowed: false };
    }
    // Low confidence → mandatory human review
    if (finding.confidence < AUTO_CURATION_CONFIDENCE_THRESHOLD) {
      return { requiresHumanReview: true, reason: 'low_confidence', autoRemediationAllowed: false };
    }
    if (finding.risk === 'high' || finding.risk === 'critical') {
      return { requiresHumanReview: true, reason: 'high_risk', autoRemediationAllowed: false };
    }
    if (finding.impactScope === 'cross_repo' || finding.impactScope === 'global') {
      return { requiresHumanReview: true, reason: 'cross_repo_or_global_impact', autoRemediationAllowed: false };
    }
    // Otherwise: auto-remediation allowed if high confidence + low risk
    return {
      requiresHumanReview: false,
      autoRemediationAllowed: true,
    };
  }
}
