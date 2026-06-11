// Complete type definitions for the context judge/review/remediation system

export type JudgeScope =
  | 'workflow' | 'node' | 'chat_turn' | 'spawned_agent'
  | 'learning' | 'cross_repo' | 'global' | 'user_preference';

export type ReliabilityLabel = 'signal_only' | 'needs_judge' | 'confirmed' | 'rejected';

export type Risk = 'low' | 'medium' | 'high' | 'critical';

export type Severity = 'info' | 'warn' | 'error' | 'critical';

export type FindingClassification =
  | 'missing_context' | 'wrong_context' | 'stale_context' | 'bloated_context'
  | 'mandatory_missing' | 'ingestion_gap' | 'retrieval_miss' | 'reranker_demoted'
  | 'injection_policy' | 'prompt_contract' | 'instrumentation_gap'
  | 'code_defect' | 'learning_candidate' | 'learning_remediation'
  | 'learning_conflict'        // learning conflicts with existing curated context
  | 'learning_no_action'       // learning evaluated, no curation action needed
  | 'retrieval_precision_gap'  // retrieval returning documents with low precision
  // v4 expanded taxonomy
  | 'missing_mandatory_context' | 'incomplete_context' | 'source_inspection_gap'
  | 'overbroad_context' | 'context_bloat' | 'duplicate_context' | 'conflicting_context'
  | 'stale_index' | 'source_mapping_gap' | 'chunking_gap'
  | 'retrieval_gap' | 'reranker_gap' | 'filtering_gap' | 'injection_policy_gap'
  | 'manifest_policy_violation' | 'provider_native_gap' | 'unverified_context_claim'
  | 'context_ignored' | 'ungrounded_output' | 'incorrect_context_application'
  | 'context_scope_violation' | 'sensitive_context_risk' | 'trace_gap'
  | 'judge_uncertain' | 'schema_violation'
  | 'learning_to_curated_context_candidate' | 'learning_updates_existing_context'
  | 'learning_conflicts_with_context' | 'learning_requires_source_validation'
  | 'learning_not_context_worthy' | 'false_positive' | 'no_action_needed';

export type FixType =
  | 'curated_context_edit' | 'curated_context_create' | 'curated_context_archive'
  | 'mandatory_context_edit' | 'mandatory_context_create'
  | 'learning_promotion' | 'learning_archive'
  | 'ingestion_repair' | 'retrieval_tune' | 'injection_policy_change'
  | 'prompt_contract_change' | 'instrumentation_fix' | 'code_fix' | 'no_action'
  | 'learning_validation'           // learning needs validation before promotion
  | 'learning_conflict_resolution'  // learning conflicts with existing curated context, needs manual resolution
  | 'mandatory_context_archive'     // archive an obsolete mandatory mapping
  // v4 expanded fix types
  | 'curated_context_fix' | 'mandatory_context_fix' | 'global_context_fix' | 'cross_repo_context_fix'
  | 'learning_to_curated_context_fix' | 'learning_context_remediation_fix'
  | 'learning_context_conflict_review' | 'learning_source_validation_task'
  | 'ingestion_fix' | 'retrieval_fix' | 'reranking_fix'
  | 'injection_policy_fix' | 'prompt_contract_fix'
  | 'task_split_required' | 'no_fix';

export type ReviewTaskStatus =
  | 'pending' | 'in_review' | 'changes_requested' | 'approved'
  | 'in_remediation' | 'remediation_failed' | 'done' | 'rejected'
  | 'superseded' | 'duplicate';

export type RemediationActionKind =
  | 'curated_entry_edit' | 'curated_entry_create' | 'curated_entry_archive'
  | 'mandatory_mapping_edit' | 'mandatory_mapping_create'
  | 'learning_promotion_to_curated' | 'learning_remediation_of_curated'
  | 'ingestion_rerun' | 'retrieval_config_change' | 'reranker_config_change'
  | 'injection_policy_change' | 'prompt_contract_change'
  | 'instrumentation_change' | 'code_change_pr' | 'no_op';

/**
 * RunScope describes the scope of THIS judge run — which repos were evaluated.
 *   'repo'       — single-repo run, evaluates sources from one repo
 *   'multi_repo' — explicit multi-repo run
 *   'global'     — no repo filter, evaluates all sources
 *
 * ImpactScope describes the scope of IMPACT for findings discovered in this run.
 *   'repo'       — finding affects only the repo this run was scoped to
 *   'cross_repo' — finding affects multiple repos (discovered during a repo run)
 *   'global'     — finding affects all repos / is system-wide
 *
 * These MUST be kept separate. A repo run can produce cross-repo or global findings.
 * Human gates use impactScope, not runScope.
 */
export type RunScope = 'repo' | 'multi_repo' | 'global';
export type ImpactScope = 'repo' | 'cross_repo' | 'global';

// Judge Run document shape
export interface JudgeRun {
  judgeRunId: string;
  scope: JudgeScope;
  /** Scope of THIS run — which repos were evaluated. Defaults to 'global' when no repoId filter. */
  runScope?: RunScope;
  sourceId?: string;       // executionId, chatSessionId, learningId etc.
  sourceKind?: string;     // 'workflow_run' | 'chat_turn' | 'spawned_agent' | 'learning' etc.
  sourceKey?: string;      // "${sourceKind}:${sourceId}" for idempotency checks
  repoId?: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  trigger: 'auto' | 'manual' | 'rejudge';
  provider?: string;
  model?: string;
  deterministicReliability: DeterministicReliabilityScore[];
  findingsSummary: FindingsSummary;
  active: boolean;
  version: number;
  validFrom: Date;
  validTo?: Date;
  supersededAt?: Date;
  supersededBy?: string;   // judgeRunId of the newer run
  createdAt: Date;
  updatedAt: Date;
}

export interface DeterministicReliabilityScore {
  dimension: string;       // e.g. 'precision', 'completeness', 'usefulness'
  rawScore: number;        // 0-1
  reliabilityLabel: ReliabilityLabel;
}

export interface FindingsSummary {
  total: number;
  bySeverity: Partial<Record<Severity, number>>;
  byClassification: Partial<Record<FindingClassification, number>>;
}

// Finding document shape
export interface Finding {
  findingId: string;
  judgeRunId: string;
  scope: JudgeScope;
  /**
   * Impact scope: who is affected by this finding.
   * Separate from run scope — a repo run can produce cross_repo or global findings.
   * Human gates MUST use impactScope, not the session/run scope.
   */
  impactScope?: ImpactScope;
  repoId?: string;
  affectedRepos?: string[];   // for cross-repo/global findings that affect multiple repos
  sourceId?: string;
  // ── Source traceability (fix 5) ──────────────────────────────────────────
  // Top-level fields for filtering, dedupe, rejudge, and remediation.
  // These are populated from orchestrator-classified findings.
  primarySourceId?: string;     // primary source ID (same as sourceId but explicit)
  sourceKind?: string;          // kind of the source ('workflow_run', 'chat_turn', etc.)
  sourceRefs?: string[];        // additional source ref IDs (e.g. contextAttemptIds)
  executionId?: string;         // if source is a workflow/agent execution
  contextAttemptId?: string;    // if source is a context attempt
  classification: FindingClassification;
  fixType: FixType;
  severity: Severity;
  risk: Risk;
  confidence: number;        // 0-1
  reliabilityLabel: ReliabilityLabel;
  evidence: EvidenceRef[];
  suggestedRemediation?: string;
  status: 'open' | 'in_review' | 'resolved' | 'rejected' | 'superseded';
  learningId?: string;       // AC-07: link to chat learning
  active: boolean;
  version: number;
  validFrom: Date;
  validTo?: Date;
  supersededAt?: Date;
  supersededBy?: string;     // findingId of newer finding
  createdAt: Date;
  updatedAt: Date;
}

export interface EvidenceRef {
  kind: 'context_ref' | 'evaluation_score' | 'text' | 'learning';
  refId?: string;
  snippet?: string;
  score?: number;
  label?: string;
}

// DeterministicCalibrator input
export interface DeterministicScoreInput {
  dimension: string;
  rawScore: number;         // 0-1 float
}

// Config shape for the singleton context_judge_config collection
export interface ContextJudgeConfig {
  configId: 'singleton';   // enforced singleton key
  autoRemediationEnabled: boolean;
  autoRemediationThresholds: {
    minConfidence: number;
    maxRisk: Risk;
    allowedFixTypes: FixType[];
  };
  mandatoryHumanReview: {
    lowConfidenceThreshold: number;  // confidence below this → human review
    highRiskLevels: Risk[];          // these risk levels → human review
    alwaysForScopes: JudgeScope[];   // cross_repo, global → human review
    alwaysForLearningDerived: boolean;
    alwaysForCodeFix: boolean;
  };
  updatedAt: Date;
  updatedBy?: string;
}

// Scheduler state shape for context_judge_scheduler_state collection
export type SchedulerSourceType =
  | 'workflow_run'
  | 'spawned_agent_run'
  | 'chat_turn'
  | 'context_usage_trace'
  | 'deterministic_warning'
  | 'human_feedback'
  | 'chat_learning'
  | 'stale_finding';

export interface SchedulerCursorRow {
  sourceType: SchedulerSourceType;
  scopeType?: 'repo' | 'global' | 'legacy';
  scopeKey?: string;
  cursor?: string;        // ISO timestamp or opaque cursor value
  lastRunAt?: Date;
  lastEvaluatedAt?: Date;
  lastCandidateCreatedAt?: Date;
  lastAssignedSourceIds?: string[];
  lastEvaluatedSourceIds?: string[];
  cursorReason?: string;
  status: 'idle' | 'running' | 'error';
  errorMessage?: string;
  updatedAt: Date;
}

/**
 * Compatibility mapping: legacy taxonomy names → canonical v4 names.
 * Both old and new names remain valid union members.
 */
export const TAXONOMY_LEGACY_TO_CANONICAL: Record<string, FindingClassification> = {
  mandatory_missing: 'missing_mandatory_context',
  retrieval_miss: 'retrieval_gap',
  reranker_demoted: 'reranker_gap',
  injection_policy: 'injection_policy_gap',
  bloated_context: 'context_bloat',
  learning_candidate: 'learning_to_curated_context_candidate',
  learning_remediation: 'learning_updates_existing_context',
  learning_conflict: 'learning_conflicts_with_context',
  learning_no_action: 'learning_not_context_worthy',
  retrieval_precision_gap: 'retrieval_gap',
};

export const FIX_TYPE_LEGACY_TO_CANONICAL: Record<string, FixType> = {
  curated_context_edit: 'curated_context_fix',
  curated_context_create: 'curated_context_fix',
  mandatory_context_edit: 'mandatory_context_fix',
  mandatory_context_create: 'mandatory_context_fix',
  learning_promotion: 'learning_to_curated_context_fix',
  learning_conflict_resolution: 'learning_context_conflict_review',
  ingestion_repair: 'ingestion_fix',
  retrieval_tune: 'retrieval_fix',
  injection_policy_change: 'injection_policy_fix',
  prompt_contract_change: 'prompt_contract_fix',
  no_action: 'no_fix',
};

// ContextSourceEvaluation — durable ledger of per-source evaluation outcomes.
// Populated by the orchestrator when a source is evaluated (finding_created or no_issue).
// The scheduler anti-joins against this collection to avoid re-evaluating sources.
export type SourceEvaluationDecision = 'finding_created' | 'no_issue' | 'skipped' | 'error';
export type SourceEvaluationStatus = 'completed' | 'failed' | 'retryable';
export type ContextVerdict = 'correct' | 'wrong' | 'incomplete' | 'missing' | 'not_needed' | 'unjudgeable';

export interface ContextSourceEvaluation {
  evaluationId: string;
  sessionId: string;
  judgeRunId?: string;
  repoId?: string;
  sourceType: string;
  sourceId: string;
  /** "{sourceType}:{sourceId}" — primary lookup / anti-join key. */
  sourceKey: string;
  contextAttemptId?: string;
  executionId?: string;
  flowKind?: string;
  decision: SourceEvaluationDecision;
  status: SourceEvaluationStatus;
  reason?: string;
  classification?: string;
  fixType?: string;
  confidence?: number;
  risk?: string;
  severity?: string;
  findingIds?: string[];
  workerAssignmentId?: string;
  sourceKind?: string;
  contextCorrect?: boolean | 'unknown';
  contextVerdict?: ContextVerdict;
  contextIncomplete?: boolean;
  contextIrrelevant?: boolean;
  mandatoryMissing?: boolean;
  mandatoryIncorrect?: boolean;
  overFiltered?: boolean;
  overInjected?: boolean;
  wrongScope?: boolean;
  staleContext?: boolean;
  affectedRefIds?: string[];
  expectedContextKinds?: string[];
  remediationHints?: string[];
  evidence?: Array<{ kind: string; refId?: string; snippet?: string; score?: number; label?: string }>;
  notes?: string;
  evidenceSummary?: Record<string, unknown>;
  evaluationVersion: number;
  evaluatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

// OrchestratorRunRecord — top-level audit record for each orchestrator invocation.
// Stored in context_orchestrator_run_records collection.
export interface OrchestratorRunRecord {
  runId: string;
  sessionId?: string;
  triggeredBy: 'ui' | 'api' | 'scheduler' | 'cron' | 'manual';
  repoId?: string;
  repoIds?: string[];
  global: boolean;
  /** RunScope reflects which repos were evaluated in this run. */
  runScope?: RunScope;
  dry_run?: boolean;
  countDiscovered: number;
  countSkipped: number;       // already-evaluated sources skipped
  countEvaluated: number;
  countGrouped: number;       // findings attached to existing tasks (not new ones)
  countTasksCreated: number;
  assignmentLaunches: number;
  errors: string[];
  status: 'triggered' | 'running' | 'completed' | 'failed';
  triggeredAt: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}
