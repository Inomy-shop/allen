// Context Quality (Judge / Review / Remediation) response types.

export interface JudgeRunDoc {
  judgeRunId: string;
  scope: string;
  sourceId?: string;
  sourceKind?: string;
  repoId?: string;
  status: string;
  trigger: string;
  deterministicReliability: Array<{ dimension: string; rawScore: number; reliabilityLabel: string }>;
  findingsSummary: { total: number; bySeverity: Record<string, number>; byClassification: Record<string, number> };
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FindingDoc {
  findingId: string;
  judgeRunId: string;
  scope: string;
  repoId?: string;
  sourceId?: string;
  classification: string;
  fixType: string;
  severity: string;
  risk: string;
  confidence: number;
  reliabilityLabel: string;
  evidence: Array<{ kind: string; refId?: string; snippet?: string; score?: number; label?: string }>;
  suggestedRemediation?: string;
  status: string;
  learningId?: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewTaskDoc {
  taskId: string;
  findingId: string;
  judgeRunId: string;
  scope: string;
  repoId?: string;
  parentTaskId?: string;
  childTaskIds?: string[];
  fixType: string;
  risk: string;
  severity: string;
  confidence: number;
  reliabilityLabel: string;
  suggestedRemediation?: string;
  assignedTo?: string;
  status: string;
  queue: string;
  requiresHumanReview: boolean;
  humanReviewReason?: string;
  learningId?: string;
  remediationId?: string;
  createdAt: string;
  updatedAt: string;
  affectedRepos?: string[];
  classification?: string;
  sourceType?: string;
  judgeRationale?: string;
  learningContent?: string;
  learningScope?: string;
}

export interface WorkerAssignmentDoc {
  assignmentId: string;
  taskIds: string[];
  remediationIds?: string[];
  learningIds?: string[];
  workerAgentName?: string;
  workerRole?: string;
  status: string;
  notes?: string;
  result?: Record<string, unknown>;
  agentExecutionId?: string;
  allenAgentInvocation?: {
    agentName: string;
    taskDescription: string;
    dispatchStatus: string;
    dispatchedAt?: string;
  };
  assignedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewDecisionDoc {
  decisionId: string;
  taskId: string;
  actor: string;
  action: string;
  notes?: string;
  createdAt: string;
}

export interface RemediationDoc {
  remediationId: string;
  taskId: string;
  findingId: string;
  judgeRunId: string;
  actionKind: string;
  remediationKind?: string;
  workerRole?: string;
  targetEntryIds?: string[];
  targetRefIds?: string[];
  targetMappingIds?: string[];
  targetRepoId?: string;
  targetRepoIds?: string[];
  sourceEvaluationIds?: string[];
  affectedRefIds?: string[];
  proposedPatch?: Record<string, unknown>;
  retrievalReplayId?: string;
  validationPlan?: string;
  confidence?: number;
  estimatedRisk?: string;
  humanGateRequired?: boolean;
  status: string;
  result?: Record<string, unknown>;
  error?: string;
  assignments?: WorkerAssignmentDoc[];
  revisions?: CurationRevisionDoc[];
  appliedRevisionIds?: string[];
  lastAppliedRevisionId?: string;
  lastAppliedEntryVersionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CurationRevisionDoc {
  revisionId: string;
  repoId: string;
  entryId: string;
  beforeEntryVersionId?: string;
  afterEntryVersionId?: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  diff?: Record<string, unknown> | null;
  source: string;
  actor: string;
  reviewTaskId?: string;
  remediationId?: string;
  learningId?: string;
  createdAt: string;
}

export interface LearningPromotionDoc {
  promotionId: string;
  rootExecutionId?: string;
  sessionId?: string;
  learningId: string;
  reviewTaskId?: string;
  action: string;
  targetRepoId?: string;
  targetEntryId?: string;
  targetEntryIds?: string[];
  targetRefIds?: string[];
  affectedRefIds?: string[];
  sourceEvaluationIds?: string[];
  proposedPatch?: Record<string, unknown>;
  confidence?: number;
  estimatedRisk?: string;
  humanGateRequired?: boolean;
  remediationId?: string;
  remediationStatus?: string;
  sourceValidationStatus?: string;
  conflictStatus?: string;
  curationQualityWarnings?: string[];
  scope?: string;
  suggestedContent?: string;
  proposedCuratedText?: string;
  decision?: string;
  decidedBy?: string;
  decidedAt?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface PagedContextQualityResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface OrchestrationSessionDoc {
  sessionId: string;
  agentModel?: string;
  agentProvider?: string;
  agentRationale?: string;
  scope: string;
  sourceId?: string;
  sourceKind?: string;
  repoId?: string;
  status: 'active' | 'finalized' | 'failed';
  judgeRunId?: string;
  findingIds: string[];
  reviewTaskIds: string[];
  agentDecisionLog: Array<{ at: string; kind: string; detail: string; metadata?: Record<string, unknown> }>;
  startedAt: string;
  finalizedAt?: string;
  createdAt: string;
  updatedAt: string;
}
