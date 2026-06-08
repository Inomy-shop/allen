import type {
  JudgeScope,
  FindingClassification,
  FixType,
  Risk,
  Severity,
  EvidenceRef,
  RunScope,
  ImpactScope,
} from './context-judge.types.js';

export interface OrchestrationSession {
  sessionId: string;
  agentModel?: string;
  agentProvider?: string;
  agentRationale?: string;        // LLM agent's free-text reasoning summary
  scope: JudgeScope;
  /** RunScope: which repos were evaluated in this session. Inferred from repoId. */
  runScope?: RunScope;
  sourceId?: string;
  sourceKind?: string;
  repoId?: string;
  dry_run?: boolean;
  rootExecutionId?: string;
  status: 'active' | 'finalized' | 'failed';
  lifecycleStatus?: 'running' | 'completed' | 'partial' | 'incomplete' | 'failed';
  judgeRunId?: string;            // set after agent submits findings
  judgeRunIds?: string[];
  findingIds: string[];
  reviewTaskIds: string[];
  sourceEvaluationIds?: string[];
  traceSnapshotStartedAt?: Date;
  traceSnapshotMaxContextAttemptId?: string;
  stageStatus?: Record<string, {
    status: 'not_started' | 'running' | 'completed' | 'skipped' | 'blocked' | 'failed';
    reason?: string;
    startedAt?: Date;
    completedAt?: Date;
    assignmentIds?: string[];
    executionIds?: string[];
  }>;
  agentDecisionLog: AgentDecisionEntry[];  // append-only log of agent decisions
  startedAt: Date;
  finalizedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentDecisionEntry {
  at: Date;
  kind: 'discovery' | 'classification' | 'routing' | 'gate_check' | 'summary';
  detail: string;   // agent's explanation for this decision
  metadata?: Record<string, unknown>;
}

export interface AgentFindingInput {
  classification: FindingClassification;
  fixType: FixType;
  severity: Severity;
  risk: Risk;
  confidence: number;
  evidence?: EvidenceRef[];
  suggestedRemediation?: string;
  learningId?: string;
  agentRationale?: string;      // agent's per-finding reasoning
  // ── Fix 3 + 5: impact scope and source traceability ──────────────────────
  /**
   * Impact scope for this specific finding.
   * A repo-scoped run can produce cross_repo or global findings.
   * Human gates use impactScope, not the session/run scope.
   */
  impactScope?: ImpactScope;
  primarySourceId?: string;
  sourceRefs?: string[];
  executionId?: string;
  contextAttemptId?: string;
}
