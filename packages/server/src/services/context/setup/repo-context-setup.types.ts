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
