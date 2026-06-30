import type { CurationStageStatus } from '../curation/repo-context-curation-runner.js';

export type SetupPhase =
  | 'preflight'
  | 'curation'
  | 'mandatory_mapping'
  | 'context_refresh'
  | 'completed';

export type SetupStatus =
  | 'running'     // any phase actively executing
  | 'completed'   // all required phases succeeded
  | 'partial'     // setup phases ok, graph refresh partial/failed
  | 'failed'      // hard fail in curation or mandatory mapping
  | 'cancelled'   // user cancel
  | 'stopped';    // server crash/restart, reconciler marks as resumable

export type SetupPhaseStatus =
  | 'pending' | 'running' | 'skipped' | 'completed' | 'failed' | 'cancelled';

/** Statuses in which a run still occupies its repo's single active setup slot. */
export const ACTIVE_SETUP_STATUSES = ['running', 'partial'] as const satisfies readonly SetupStatus[];

/**
 * True when a run is active ('running' | 'partial'). Drives the persisted
 * `isActive` flag on each run, which backs the partial unique index that
 * enforces one active setup run per repo. DocumentDB rejects `$in` inside a
 * partialFilterExpression, so the active set is collapsed to this boolean in
 * application code rather than expressed in the index filter.
 */
export function isActiveSetupStatus(status: SetupStatus): boolean {
  return status === 'running' || status === 'partial';
}

export type SetupPhaseSnapshot = {
  status: SetupPhaseStatus;
  startedAt?: Date;
  completedAt?: Date;
  message?: string;
  diagnostics?: Array<Record<string, unknown>>;
  // Curation phase:
  curationRunId?: string;
  curationProfileId?: string;
  curationExecutionId?: string;
  unchangedCount?: number;
  changedCount?: number;
  retryCount?: number;
  stagedCount?: number;
  promotedCount?: number;
  promotable?: boolean;
  // Mandatory phase:
  mandatoryExecutionId?: string;
  affectedAgentNames?: string[];
  savedMappingCount?: number;
  deactivatedMappingCount?: number;
  // Cognee phase:
  cogneeStatus?: 'pending' | 'running' | 'completed' | 'partial' | 'failed' | 'stopped';
  cogneeStage?: string;
  cogneeBuildMode?: 'resume' | 'clean_rebuild';
  cogneeMessage?: string;
};

export type RepoContextSetupRun = {
  setupRunId: string;
  repoId: string;
  repoName: string;
  repoPath: string;
  branch?: string;
  status: SetupStatus;
  /**
   * Derived mirror of `status ∈ {running, partial}`. Persisted so the partial
   * unique index (one active run per repo) can filter on a single boolean —
   * DocumentDB does not support `$in` in partialFilterExpression. Always kept
   * in sync with `status`; see {@link isActiveSetupStatus}. Optional only for
   * legacy docs written before this field existed.
   */
  isActive?: boolean;
  currentPhase: SetupPhase;
  requestedBy?: string;
  requestedAt: Date;
  source: 'ui' | 'api' | 'reconcile';
  options: {
    cleanRebuildCognee?: boolean;
    skipCognee?: boolean;
    forceCuration?: boolean;
    scope?: { mode?: string; pattern?: string; force?: boolean };
  };
  phases: {
    preflight: SetupPhaseSnapshot;
    curation: SetupPhaseSnapshot;
    mandatoryMapping: SetupPhaseSnapshot;
    contextRefresh: SetupPhaseSnapshot;
  };
  message?: string;
  diagnostics: Array<Record<string, unknown>>;
  resumeCount: number;
  childExecutionIds: string[];
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
};

export type MandatoryContextProposal = {
  proposalId: string;
  setupRunId: string;
  repoId: string;
  affectedAgentNames: string[];
  mappings: Array<{
    agentName: string;
    sourcePath?: string;
    sourceHash?: string;
    title: string;
    content: string;
    reasoning?: string;
  }>;
  status: 'proposed' | 'consumed' | 'rejected';
  createdAt: Date;
  consumedAt?: Date;
  rejectedAt?: Date;
  rejectionReason?: string;
};

/** A single failed file entry from `repo_context_curation_stage_file_statuses`. */
export type CurationFileFailure = {
  path: string;
  sourceHash?: string;
  status: string;
  reason?: string;
  updatedAt?: Date;
};

export type MandatoryMappingRowStatus =
  | 'saved'                  // persisted to repo_mandatory_context_mappings, enabled=true
  | 'deactivated'            // exists in mappings, enabled=false, deactivatedByRunId matches
  | 'consumed_into_proposal' // proposal row status='consumed_into_proposal'
  | 'staged'                 // proposal row status='staged'
  | 'missing';               // agent in affectedAgentNames but no row found in either collection

/** One row in the MandatoryProposalDetail panel — one row per (agentName, title, sourcePath?) key. */
export type MandatoryMappingRow = {
  agentName: string;
  title: string;
  sourcePath?: string;
  status: MandatoryMappingRowStatus;
  reason?: string;
  updatedAt?: Date;
};

/** Aggregated detail for the Mandatory Mapping section of the setup progress panel. */
export type MandatoryProposalDetail = {
  stagedCount: number;
  consumedIntoProposalCount: number;
  activeProposalCount: number;
  rows: MandatoryMappingRow[];
};

/**
 * Extended response shape for `RepoContextSetupService.get()`.
 * Adds curation file failure list, mandatory proposal detail, and uses the
 * correctly computed `CurationStageStatus` from `getRepoContextCurationStageStatus()`.
 */
export type SetupDetailResponse = {
  setupRun: RepoContextSetupRun;
  curationProfile: Record<string, unknown> | null;
  /** Now correctly computed via getRepoContextCurationStageStatus() — bug fix */
  curationStageStatus: CurationStageStatus | null;
  /** Failed files from repo_context_curation_stage_file_statuses, capped at 20. */
  curationFileFailures: CurationFileFailure[];
  mandatoryMappings: { activeCount: number; inactiveCount: number };
  /** null when no proposals and no mappings exist for this setup run. */
  mandatoryProposalDetail: MandatoryProposalDetail | null;
  cogneeStatus: Record<string, unknown> | null;
};
