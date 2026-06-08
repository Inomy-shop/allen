import { randomUUID } from 'node:crypto';
import type { Db, Collection } from 'mongodb';
import type {
  Finding,
  JudgeScope,
  FixType,
  Risk,
  Severity,
  ReliabilityLabel,
  ReviewTaskStatus,
  ContextJudgeConfig,
} from './context-judge.types.js';
import { ContextFindingService } from './context-finding.service.js';
import { ContextRemediationTaskService } from './context-remediation-task.service.js';

export interface ReviewTask {
  taskId: string;
  findingId: string;
  judgeRunId: string;
  scope: JudgeScope;
  repoId?: string;
  affectedRepos?: string[];   // for cross-repo/global tasks that affect multiple repos
  parentTaskId?: string;
  childTaskIds?: string[];
  fixType: FixType;
  classification?: string;
  sourceType?: string;
  risk: Risk;
  severity: Severity;
  confidence: number;
  reliabilityLabel: ReliabilityLabel;
  suggestedRemediation?: string;
  assignedTo?: string;
  status: ReviewTaskStatus;
  queue:
    | 'open'
    | 'needs_review'
    | 'global_cross_repo'
    | 'learning_to_context'
    | 'auto_remediated'
    | 'dispatched'
    | 'needs_re_judge'
    | 'dismissed'
    | 'no_action'
    | 'history';
  requiresHumanReview: boolean;
  humanReviewReason?: string;
  learningId?: string;
  remediationId?: string;
  clusterKey?: string;          // "${fixType}:${scope}:${repoId ?? 'global'}"
  attachedFindingIds?: string[]; // findingIds grouped into this task (dedupe)
  createdAt: Date;
  updatedAt: Date;
}

export interface ReviewDecision {
  decisionId: string;
  taskId: string;
  actor: string;
  action: 'approve' | 'reject' | 'request_changes' | 'defer';
  notes?: string;
  remediationHint?: string;
  createdAt: Date;
}

const ACTION_TO_STATUS: Record<string, ReviewTaskStatus> = {
  approve: 'in_remediation',
  reject: 'rejected',
  request_changes: 'changes_requested',
  defer: 'pending',
};

export class ContextReviewService {
  private tasksCollection: Collection<ReviewTask>;
  private decisionsCollection: Collection<ReviewDecision>;
  private findingService: ContextFindingService;

  constructor(private db: Db) {
    this.tasksCollection = db.collection<ReviewTask>('context_review_tasks');
    this.decisionsCollection = db.collection<ReviewDecision>('context_review_decisions');
    this.findingService = new ContextFindingService(db);
  }

  async createFromFinding(finding: Finding, _config: ContextJudgeConfig): Promise<ReviewTask> {
    const routing = this.findingService.routingDecision(finding);
    const now = new Date();

    const affectedRepos: string[] =
      finding.affectedRepos && finding.affectedRepos.length > 0
        ? finding.affectedRepos
        : (finding.repoId?.includes(',')
            ? finding.repoId.split(',').map((r: string) => r.trim()).filter(Boolean)
            : []);

    const shouldSplitChildren =
      (finding.scope === 'cross_repo' || finding.scope === 'global') &&
      affectedRepos.length > 1;

    const repoIds = shouldSplitChildren ? affectedRepos : [];

    // ── clusterKey deduplication ──────────────────────────────────────────────
    // For non-split tasks, check if an existing compatible pending/in_review
    // top-level task already exists for this fixType+scope+repoId combination.
    // If so, attach the finding to it rather than creating a duplicate task.
    if (!shouldSplitChildren) {
      const clusterKey = `${finding.classification}:${finding.fixType}:${finding.scope}:${finding.repoId ?? 'global'}`;
      const existingTask = await this.tasksCollection.findOne({
        clusterKey,
        status: { $in: ['pending', 'in_review'] },
        parentTaskId: { $exists: false },
      });
      if (existingTask) {
        // Attach finding to existing task — use $addToSet to avoid duplicates
        await this.tasksCollection.updateOne(
          { taskId: (existingTask as unknown as ReviewTask).taskId },
          {
            $addToSet: { attachedFindingIds: finding.findingId } as any,
            $set: { updatedAt: now },
          },
        );
        return existingTask as unknown as ReviewTask;
      }
    }

    const clusterKey = `${finding.classification}:${finding.fixType}:${finding.scope}:${finding.repoId ?? 'global'}`;

    const initialQueue = routing.requiresHumanReview
      ? 'needs_review'
      : finding.learningId
        ? 'learning_to_context'
        : (finding.scope === 'cross_repo' || finding.scope === 'global' || finding.impactScope === 'cross_repo' || finding.impactScope === 'global')
          ? 'global_cross_repo'
          : finding.fixType === 'no_action' || finding.fixType === 'no_fix'
            ? 'no_action'
            : 'open';

    const parentTask: ReviewTask = {
      taskId: randomUUID(),
      findingId: finding.findingId,
      judgeRunId: finding.judgeRunId,
      scope: finding.scope,
      repoId: finding.repoId,
      affectedRepos: affectedRepos.length > 0 ? affectedRepos : undefined,
      fixType: finding.fixType,
      classification: finding.classification,
      sourceType: finding.sourceKind,
      risk: finding.risk,
      severity: finding.severity,
      confidence: finding.confidence,
      reliabilityLabel: finding.reliabilityLabel,
      suggestedRemediation: finding.suggestedRemediation,
      status: 'pending',
      queue: initialQueue,
      requiresHumanReview: routing.requiresHumanReview,
      humanReviewReason: routing.reason,
      learningId: finding.learningId,
      childTaskIds: repoIds.length > 0 ? [] : undefined,
      clusterKey: shouldSplitChildren ? undefined : clusterKey,
      attachedFindingIds: shouldSplitChildren ? undefined : [],
      createdAt: now,
      updatedAt: now,
    };

    if (repoIds.length > 1) {
      const childIds: string[] = [];
      for (const repoId of repoIds) {
        const childTask: ReviewTask = {
          taskId: randomUUID(),
          findingId: finding.findingId,
          judgeRunId: finding.judgeRunId,
          scope: finding.scope,
          repoId,
          affectedRepos: [repoId],
          parentTaskId: parentTask.taskId,
          fixType: finding.fixType,
          classification: finding.classification,
          sourceType: finding.sourceKind,
          risk: finding.risk,
          severity: finding.severity,
          confidence: finding.confidence,
          reliabilityLabel: finding.reliabilityLabel,
          suggestedRemediation: finding.suggestedRemediation,
          status: 'pending',
          queue: initialQueue,
          requiresHumanReview: routing.requiresHumanReview,
          humanReviewReason: routing.reason,
          learningId: finding.learningId,
          createdAt: now,
          updatedAt: now,
        };
        await this.tasksCollection.insertOne(childTask as any);
        childIds.push(childTask.taskId);
      }
      parentTask.childTaskIds = childIds;
    }

    await this.tasksCollection.insertOne(parentTask as any);
    return parentTask;
  }

  async get(taskId: string): Promise<ReviewTask | null> {
    return this.tasksCollection.findOne({ taskId }) as Promise<ReviewTask | null>;
  }

  async list(params: {
    queue?: string;
    scope?: JudgeScope;
    fixType?: FixType;
    risk?: Risk;
    severity?: Severity;
    classification?: string;
    confidenceBand?: string;
    sourceType?: string;
    repoId?: string;
    status?: ReviewTaskStatus;
    limit?: number;
    offset?: number;
  }): Promise<ReviewTask[]> {
    const filter = this.buildListFilter(params);
    const limit = Math.min(params.limit ?? 50, 200);
    const offset = params.offset ?? 0;
    return this.tasksCollection
      .find(filter as any)
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limit)
      .toArray() as Promise<ReviewTask[]>;
  }

  async count(params: {
    queue?: string;
    scope?: JudgeScope;
    fixType?: FixType;
    risk?: Risk;
    severity?: Severity;
    classification?: string;
    confidenceBand?: string;
    sourceType?: string;
    repoId?: string;
    status?: ReviewTaskStatus;
  }): Promise<number> {
    return this.tasksCollection.countDocuments(this.buildListFilter(params) as any);
  }

  private buildListFilter(params: {
    queue?: string;
    scope?: JudgeScope;
    fixType?: FixType;
    risk?: Risk;
    severity?: Severity;
    classification?: string;
    confidenceBand?: string;
    sourceType?: string;
    repoId?: string;
    status?: ReviewTaskStatus;
  }): Record<string, unknown> {
    const filter: Record<string, unknown> = {};
    if (params.queue) filter.queue = params.queue;
    if (params.scope) filter.scope = params.scope;
    if (params.fixType) filter.fixType = params.fixType;
    if (params.risk) filter.risk = params.risk;
    if (params.severity) filter.severity = params.severity;
    if (params.classification) filter.classification = params.classification;
    if (params.sourceType) filter.sourceType = params.sourceType;
    if (params.repoId) filter.repoId = params.repoId;
    if (params.status) filter.status = params.status;
    if (params.confidenceBand) {
      if (params.confidenceBand === 'high') {
        filter.confidence = { $gte: 0.8 };
      } else if (params.confidenceBand === 'medium') {
        filter.confidence = { $gte: 0.5, $lte: 0.79 };
      } else if (params.confidenceBand === 'low') {
        filter.confidence = { $lt: 0.5 };
      }
    }
    return filter;
  }

  async addDecision(
    taskId: string,
    decision: {
      actor: string;
      action: 'approve' | 'reject' | 'request_changes' | 'defer';
      notes?: string;
      remediationHint?: string;
    },
  ): Promise<void> {
    const now = new Date();
    const reviewDecision: ReviewDecision = {
      decisionId: randomUUID(),
      taskId,
      actor: decision.actor,
      action: decision.action,
      notes: decision.notes,
      remediationHint: decision.remediationHint,
      createdAt: now,
    };
    await this.decisionsCollection.insertOne(reviewDecision as any);

    const newStatus = ACTION_TO_STATUS[decision.action];
    if (newStatus) {
      await this.tasksCollection.updateOne(
        { taskId },
        { $set: { status: newStatus, updatedAt: now } },
      );
    }
  }

  async listDecisions(taskId: string): Promise<ReviewDecision[]> {
    return this.decisionsCollection
      .find({ taskId })
      .sort({ createdAt: 1 })
      .toArray() as Promise<ReviewDecision[]>;
  }

  async updateStatus(
    taskId: string,
    status: ReviewTaskStatus,
    patch?: Partial<ReviewTask>,
  ): Promise<boolean> {
    const update: Record<string, unknown> = { status, updatedAt: new Date() };
    if (patch) {
      for (const [k, v] of Object.entries(patch)) {
        if (k !== 'taskId' && k !== 'createdAt') update[k] = v;
      }
    }
    const result = await this.tasksCollection.updateOne(
      { taskId },
      { $set: update },
    );
    return result.modifiedCount > 0;
  }

  async getQueues(): Promise<Record<string, number>> {
    const queues = [
      'open',
      'needs_review',
      'global_cross_repo',
      'learning_to_context',
      'auto_remediated',
      'dispatched',
      'needs_re_judge',
      'dismissed',
      'no_action',
      'history',
    ] as const;
    const counts: Record<string, number> = {};
    for (const queue of queues) {
      counts[queue] = await this.tasksCollection.countDocuments({ queue });
    }
    counts['learning_to_context'] = Math.max(
      counts['learning_to_context'] ?? 0,
      await this.db.collection('context_learning_promotions').countDocuments({ status: { $nin: ['executed', 'rejected'] } }),
    );
    const remediationService = new ContextRemediationTaskService(this.db);
    counts['dispatched'] = await remediationService.countActiveDispatched();
    counts['auto_remediated'] = await remediationService.countCompletedWithAppliedRevisions();
    counts['history'] = Math.max(
      counts['history'] ?? 0,
      await this.db.collection('context_remediations').countDocuments({ status: 'failed' }),
    );
    return counts;
  }

  async splitCrossRepoTask(parentTaskId: string, repoIds: string[]): Promise<ReviewTask[]> {
    const parent = await this.tasksCollection.findOne({ taskId: parentTaskId });
    if (!parent) throw new Error(`Parent task not found: ${parentTaskId}`);
    if (parent.scope !== 'cross_repo' && parent.scope !== 'global') {
      throw new Error(`Task ${parentTaskId} is not cross_repo or global scope`);
    }
    if (!repoIds.length) throw new Error('At least one repoId is required for split');

    const now = new Date();
    const childTasks: ReviewTask[] = [];

    for (const repoId of repoIds) {
      const child: ReviewTask = {
        ...parent,
        taskId: randomUUID(),
        scope: 'workflow' as any,
        repoId,
        affectedRepos: [repoId],
        parentTaskId: parentTaskId,
        childTaskIds: undefined,
        status: 'pending',
        queue: 'open',
        createdAt: now,
        updatedAt: now,
      };
      await this.tasksCollection.insertOne(child as any);
      childTasks.push(child);
    }

    // Update parent
    const childIds = childTasks.map(c => c.taskId);
    await this.tasksCollection.updateOne(
      { taskId: parentTaskId },
      { $set: { childTaskIds: childIds, updatedAt: now } },
    );

    return childTasks;
  }
}
