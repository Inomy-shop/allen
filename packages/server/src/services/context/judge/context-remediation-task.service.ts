import { randomUUID } from 'node:crypto';
import type { Db, Collection } from 'mongodb';
import type { RemediationActionKind } from './context-judge.types.js';
import { normalizeContextWorkerRole, requiresHumanGate } from './context-judge-policy.js';

export type RemediationKind =
  | 'curation_metadata_update'
  | 'mandatory_mapping_update'
  | 'memory_merge'
  | 'memory_demote'
  | 'memory_add'
  | 'retrieval_policy_fix'
  | 'code_fix'
  | 'qa_rejudge'
  | 'no_op';

export interface Remediation {
  remediationId: string;
  rootExecutionId?: string;
  sessionId?: string;
  taskId: string;
  findingId: string;
  judgeRunId: string;
  actionKind: RemediationActionKind;
  remediationKind?: RemediationKind;
  workerRole?: string;
  targetEntryIds?: string[];
  targetRefIds?: string[];
  targetMappingIds?: string[];
  targetRepoId?: string;
  sourceEvaluationIds?: string[];
  affectedRefIds?: string[];
  proposedPatch?: Record<string, unknown>;
  retrievalReplayId?: string;
  validationPlan?: string;
  estimatedRisk?: string;
  confidence?: number;
  humanGateRequired?: boolean;
  status: 'pending' | 'dispatched' | 'running' | 'repairing' | 'completed' | 'partial' | 'needs_review' | 'failed';
  result?: Record<string, unknown>;
  error?: string;
  repairAttemptId?: string;
  repairAssignmentId?: string;
  repairAttempts?: Array<Record<string, unknown>>;
  appliedRevisionIds?: string[];
  lastAppliedRevisionId?: string;
  lastAppliedEntryVersionId?: string;
  dispatchedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export class ContextRemediationTaskService {
  private collection: Collection<Remediation>;

  constructor(private db: Db) {
    this.collection = db.collection<Remediation>('context_remediations');
  }

  async create(input: {
    taskId: string;
    rootExecutionId?: string;
    sessionId?: string;
    findingId: string;
    judgeRunId: string;
    actionKind: RemediationActionKind;
    remediationKind?: RemediationKind;
    workerRole?: string;
    targetEntryIds?: string[];
    targetRefIds?: string[];
    targetMappingIds?: string[];
    targetRepoId?: string;
    sourceEvaluationIds?: string[];
    affectedRefIds?: string[];
    proposedPatch?: Record<string, unknown>;
    retrievalReplayId?: string;
    validationPlan?: string;
    estimatedRisk?: string;
    confidence?: number;
    humanGateRequired?: boolean;
  }): Promise<Remediation> {
    const now = new Date();
    const workerRole = normalizeContextWorkerRole(input.workerRole) ?? input.workerRole;
    const humanGateRequired = input.humanGateRequired ?? requiresHumanGate({
      confidence: input.confidence,
      risk: input.estimatedRisk,
      workerRole,
      actionKind: input.actionKind,
      destructive: input.actionKind === 'curated_entry_archive',
    });
    const remediation: Remediation = {
      remediationId: randomUUID(),
      rootExecutionId: input.rootExecutionId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      findingId: input.findingId,
      judgeRunId: input.judgeRunId,
      actionKind: input.actionKind,
      remediationKind: input.remediationKind,
      workerRole,
      targetEntryIds: input.targetEntryIds,
      targetRefIds: input.targetRefIds,
      targetMappingIds: input.targetMappingIds,
      targetRepoId: input.targetRepoId,
      sourceEvaluationIds: input.sourceEvaluationIds,
      affectedRefIds: input.affectedRefIds,
      proposedPatch: input.proposedPatch,
      retrievalReplayId: input.retrievalReplayId,
      validationPlan: input.validationPlan,
      estimatedRisk: input.estimatedRisk,
      confidence: input.confidence,
      humanGateRequired,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    for (const key of Object.keys(remediation) as (keyof Remediation)[]) {
      if (remediation[key] === undefined) delete remediation[key];
    }
    await this.collection.insertOne(remediation as any);
    return remediation;
  }

  async get(remediationId: string): Promise<Remediation | null> {
    return this.collection.findOne({ remediationId }) as Promise<Remediation | null>;
  }

  async list(params: {
    taskId?: string;
    remediationId?: string;
    workerRole?: string;
    status?: string | string[];
    targetRepoId?: string;
    includeAssignments?: boolean;
    includeRevisions?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<Remediation[]> {
    if (!params.remediationId) await this.reconcileStaleDispatched();
    const filter = this.buildListFilter(params);
    const limit = Math.min(params.limit ?? 50, 200);
    const offset = params.offset ?? 0;
    const remediations = await this.collection
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limit)
      .toArray() as Remediation[];
    if (!params.includeAssignments && !params.includeRevisions) return remediations;
    return this.enrich(remediations, {
      includeAssignments: params.includeAssignments === true,
      includeRevisions: params.includeRevisions === true,
    });
  }

  async count(params: {
    taskId?: string;
    remediationId?: string;
    workerRole?: string;
    status?: string | string[];
    targetRepoId?: string;
  }): Promise<number> {
    if (!params.remediationId) await this.reconcileStaleDispatched();
    return this.collection.countDocuments(this.buildListFilter(params));
  }

  private buildListFilter(params: {
    taskId?: string;
    remediationId?: string;
    workerRole?: string;
    status?: string | string[];
    targetRepoId?: string;
  }): Record<string, unknown> {
    const filter: Record<string, unknown> = {};
    if (params.remediationId) filter.remediationId = params.remediationId;
    if (params.taskId) filter.taskId = params.taskId;
    if (params.workerRole) filter.workerRole = normalizeContextWorkerRole(params.workerRole) ?? params.workerRole;
    const statuses = parseStatusFilter(params.status);
    if (statuses.length === 1) filter.status = statuses[0];
    if (statuses.length > 1) filter.status = { $in: statuses };
    if (params.targetRepoId) filter.targetRepoId = params.targetRepoId;
    return filter;
  }

  /**
   * Dispatch a remediation. Sets status='dispatched' with dispatchedAt=now.
   * AC-19 gate: code_change_pr actionKind is NEVER dispatched directly — it sets status='failed'.
   */
  async dispatch(remediationId: string): Promise<boolean> {
    const remediation = await this.get(remediationId);
    if (!remediation) return false;

    // AC-19: code_change_pr must never create a PR directly
    if (remediation.actionKind === 'code_change_pr') {
      const result = await this.collection.updateOne(
        { remediationId },
        {
          $set: {
            status: 'failed',
            error: 'code_change_pr_requires_human_routing — direct PR creation is blocked',
            updatedAt: new Date(),
          },
        },
      );
      return result.modifiedCount > 0;
    }

    const now = new Date();
    const result = await this.collection.updateOne(
      { remediationId },
      { $set: { status: 'dispatched', dispatchedAt: now, updatedAt: now } },
    );
    return result.modifiedCount > 0;
  }

  async complete(remediationId: string, result: Record<string, unknown>): Promise<boolean> {
    const now = new Date();
    const updateResult = await this.collection.updateOne(
      { remediationId },
      {
        $set: { status: 'completed', result, completedAt: now, updatedAt: now },
        $unset: { error: '' },
      },
    );
    if (updateResult.modifiedCount > 0) {
      await this.markLinkedPromotionExecuted(remediationId, now);
    }
    return updateResult.modifiedCount > 0;
  }

  async fail(remediationId: string, error: string): Promise<boolean> {
    const result = await this.collection.updateOne(
      { remediationId },
      { $set: { status: 'failed', error, updatedAt: new Date() } },
    );
    return result.modifiedCount > 0;
  }

  async beginRepairAttempt(input: {
    remediationIds: string[];
    assignmentId: string;
    workerRole?: string;
    rootExecutionId?: string;
    sessionId?: string;
  }): Promise<{ attemptId: string; matched: number }> {
    const attemptId = randomUUID();
    const now = new Date();
    const remediations = await this.collection
      .find({ remediationId: { $in: input.remediationIds } })
      .toArray();
    for (const remediation of remediations) {
      await this.collection.updateOne(
        { remediationId: remediation.remediationId },
        {
          $set: {
            status: 'repairing',
            repairAttemptId: attemptId,
            repairAssignmentId: input.assignmentId,
            lastRepairStartedAt: now,
            updatedAt: now,
          },
          $unset: { error: '', result: '' },
          $push: {
            repairAttempts: {
              attemptId,
              assignmentId: input.assignmentId,
              workerRole: input.workerRole,
              rootExecutionId: input.rootExecutionId,
              sessionId: input.sessionId,
              startedAt: now,
              previousStatus: remediation.status,
              previousError: remediation.error,
              previousResult: remediation.result,
              previousUpdatedAt: remediation.updatedAt,
            },
          },
        } as never,
      );
    }
    return { attemptId, matched: remediations.length };
  }

  async recordAppliedRevision(input: {
    remediationId: string;
    revisionId: string;
    entryVersionId?: string;
  }): Promise<boolean> {
    const now = new Date();
    const result = await this.collection.updateOne(
      { remediationId: input.remediationId },
      {
        $addToSet: { appliedRevisionIds: input.revisionId },
        $set: {
          status: 'running',
          lastAppliedRevisionId: input.revisionId,
          lastAppliedEntryVersionId: input.entryVersionId,
          updatedAt: now,
        },
        $unset: { error: '' },
      } as never,
    );
    return result.modifiedCount > 0;
  }

  async countActiveDispatched(): Promise<number> {
    await this.reconcileStaleDispatched();
    const remediations = await this.collection
      .find({ status: { $in: ['dispatched', 'running', 'repairing'] } })
      .project({ _id: 0, remediationId: 1 })
      .toArray();
    if (!remediations.length) return 0;
    const ids = remediations.map((doc) => doc['remediationId'] as string).filter(Boolean);
    const activeAssignments = await this.db.collection('context_review_worker_assignments').aggregate([
      { $match: { remediationIds: { $in: ids }, status: { $in: ['queued', 'running'] } } },
      { $unwind: '$remediationIds' },
      { $match: { remediationIds: { $in: ids } } },
      { $group: { _id: '$remediationIds' } },
    ]).toArray();
    return activeAssignments.length;
  }

  async countCompletedWithAppliedRevisions(): Promise<number> {
    return this.collection.countDocuments({
      status: 'completed',
      $or: [
        { appliedRevisionIds: { $exists: true, $ne: [] } },
        { 'result.editsApplied.0': { $exists: true } },
        { 'result.appliedRevisions.0': { $exists: true } },
      ],
    } as never);
  }

  async reconcileStaleDispatched(): Promise<void> {
    const candidates = await this.collection
      .find({
        $or: [
          { status: { $in: ['dispatched', 'running', 'repairing'] } },
          { status: 'failed', appliedRevisionIds: { $exists: true, $ne: [] } },
        ],
      } as never)
      .project({ _id: 0, remediationId: 1, appliedRevisionIds: 1 })
      .limit(500)
      .toArray();
    if (!candidates.length) return;
    const now = new Date();
    for (const candidate of candidates) {
      const remediationId = candidate['remediationId'] as string | undefined;
      if (!remediationId) continue;
      const assignments = await this.db.collection('context_review_worker_assignments')
        .find({
          remediationIds: remediationId,
          workerRole: {
            $nin: ['context_qa_eval', 'qa_eval'],
          },
        })
        .sort({ updatedAt: -1 })
        .toArray();
      if (!assignments.length) {
        const appliedRevisionIds = Array.isArray(candidate['appliedRevisionIds'])
          ? candidate['appliedRevisionIds'].filter(Boolean)
          : [];
        if (appliedRevisionIds.length > 0) {
          await this.collection.updateOne(
            { remediationId },
            {
              $set: { status: 'completed', completedAt: now, updatedAt: now },
              $unset: { error: '' },
            } as never,
          );
        }
        continue;
      }
      const hasActive = assignments.some((assignment) => ['queued', 'running'].includes(String(assignment['status'] ?? '')));
      if (hasActive) continue;
      const latest = assignments[0] as Record<string, unknown>;
      const latestStatus = String(latest['status'] ?? '');
      const notes = firstString(latest['notes']) ?? `Worker assignment ${latestStatus || 'terminal'} without an active remediation worker.`;
      const result = isRecord(latest['result']) ? latest['result'] : undefined;
      const editsApplied = extractAppliedEdits(result);
      const appliedRevisionIds = Array.isArray(candidate['appliedRevisionIds'])
        ? candidate['appliedRevisionIds'].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        : [];
      const revisionIds = uniqueStrings([
        ...appliedRevisionIds,
        ...editsApplied.map((edit) => firstString(edit['revisionId'])).filter((value): value is string => Boolean(value)),
      ]);
      if (latestStatus === 'completed' && revisionIds.length > 0) {
        await this.collection.updateOne(
          { remediationId },
          {
            $set: {
              status: 'completed',
              result: {
                ...(result ?? {}),
                reconciledFromAssignmentId: latest['assignmentId'],
              },
              appliedRevisionIds: revisionIds,
              completedAt: latest['completedAt'] ?? now,
              updatedAt: now,
            },
            $unset: { error: '' },
          } as never,
        );
        await this.markLinkedPromotionExecuted(remediationId, now);
        continue;
      }
      if (revisionIds.length > 0 && latestStatus !== 'failed') {
        await this.collection.updateOne(
          { remediationId },
          {
            $set: {
              status: 'completed',
              result: result ? { ...result, reconciledFromAssignmentId: latest['assignmentId'] } : { reconciledFromAssignmentId: latest['assignmentId'] },
              appliedRevisionIds: revisionIds,
              completedAt: latest['completedAt'] ?? now,
              updatedAt: now,
            },
            $unset: { error: '' },
          } as never,
        );
        await this.markLinkedPromotionExecuted(remediationId, now);
        continue;
      }
      if (revisionIds.length > 0) {
        await this.collection.updateOne(
          { remediationId },
          {
            $set: {
              status: 'partial',
              error: notes,
              result: result ? { ...result, reconciledFromAssignmentId: latest['assignmentId'] } : { reconciledFromAssignmentId: latest['assignmentId'] },
              appliedRevisionIds: revisionIds,
              updatedAt: now,
            },
          } as never,
        );
        continue;
      }
      await this.collection.updateOne(
        { remediationId },
        {
          $set: {
            status: 'failed',
            error: notes,
            result: result ? { ...result, reconciledFromAssignmentId: latest['assignmentId'] } : { reconciledFromAssignmentId: latest['assignmentId'] },
            updatedAt: now,
          },
        } as never,
      );
    }
  }

  private async enrich(remediations: Remediation[], options: { includeAssignments: boolean; includeRevisions: boolean }): Promise<Remediation[]> {
    const ids = remediations.map((remediation) => remediation.remediationId).filter(Boolean);
    if (!ids.length) return remediations;
    const assignments = options.includeAssignments
      ? await this.db.collection('context_review_worker_assignments')
        .find({ remediationIds: { $in: ids } })
        .sort({ updatedAt: -1 })
        .toArray()
      : [];
    const revisions = options.includeRevisions
      ? await this.db.collection('repo_context_curation_entry_revisions')
        .find({ remediationId: { $in: ids } })
        .sort({ createdAt: -1 })
        .toArray()
      : [];
    return remediations.map((remediation) => ({
      ...remediation,
      ...(options.includeAssignments ? { assignments: assignments.filter((assignment) => Array.isArray(assignment['remediationIds']) && assignment['remediationIds'].includes(remediation.remediationId)) } : {}),
      ...(options.includeRevisions ? { revisions: revisions.filter((revision) => revision['remediationId'] === remediation.remediationId) } : {}),
    })) as Remediation[];
  }

  private async markLinkedPromotionExecuted(remediationId: string, now: Date): Promise<void> {
    await this.db.collection('context_learning_promotions').updateMany(
      { remediationId, status: { $nin: ['executed', 'rejected'] } },
      {
        $set: {
          status: 'executed',
          remediationStatus: 'completed',
          updatedAt: now,
        },
      },
    ).catch(() => {});
  }
}

function parseStatusFilter(status?: string | string[]): string[] {
  if (Array.isArray(status)) return status.flatMap((value) => parseStatusFilter(value));
  if (!status) return [];
  return status.split(',').map((value) => value.trim()).filter(Boolean);
}

function firstString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function extractAppliedEdits(result: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  if (!result) return [];
  const direct = result['editsApplied'];
  if (Array.isArray(direct)) return direct.filter(isRecord);
  const remediationResults = result['remediationResults'];
  if (!Array.isArray(remediationResults)) return [];
  return remediationResults
    .filter(isRecord)
    .flatMap((item) => Array.isArray(item['editsApplied']) ? item['editsApplied'].filter(isRecord) : []);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}
