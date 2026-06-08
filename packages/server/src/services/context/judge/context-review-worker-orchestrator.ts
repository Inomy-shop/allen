import { randomUUID } from 'node:crypto';
import type { Db, Collection } from 'mongodb';
import {
  normalizeContextWorkerRole,
  type ContextWorkerRole,
} from './context-judge-policy.js';
import { ContextEvaluationScheduler, type RepoFilter } from './context-evaluation-scheduler.js';
import { ContextRemediationTaskService } from './context-remediation-task.service.js';

export type { ContextWorkerRole } from './context-judge-policy.js';

export interface OrchestratorGates {
  bypassesHumanReview: false;
  enforcesCodeChangeBlock: true;
}

export interface AllenAgentInvocation {
  agentName: string;
  taskDescription: string;
  taskPayload: {
    assignmentId: string;
    taskIds: string[];
    learningIds?: string[];
    remediationIds?: string[];
    curationTargetKey?: string;
    curationTarget?: { repoId: string; entryId: string };
    workerRole: ContextWorkerRole;
  };
  dispatchStatus: 'pending_runtime' | 'dispatched' | 'failed';
  dispatchedAt?: Date;
  dispatchError?: string;
}

/**
 * Agent name for context_usage_trace and human_feedback evaluation.
 * This is NOT a ContextWorkerRole (trace analysis uses a separate collection:
 * context_trace_analysis_assignments, not context_review_worker_assignments).
 * The orchestrator spawns this agent via mcp__allen__spawn_agent DIRECTLY —
 * it is never routed through assignBacklog() or WORKER_ROLE_AGENT_MAP.
 *
 * IMPORTANT: context-qa-eval-agent validates applied remediations only.
 * It must NOT be used for trace analysis or human_feedback evaluation.
 */
export const TRACE_ANALYSIS_AGENT_NAME = 'context-trace-analysis-agent';

export const WORKER_ROLE_AGENT_MAP: Record<ContextWorkerRole, string> = {
  // Review/remediation pipeline agents (use context_review_worker_assignments collection)
  context_review_triage: 'context-review-triage-agent',          // ONLY creates context_review_tasks
  context_remediation_planner: 'context-remediation-planner-agent', // ONLY creates remediation plans
  context_learning_curator: 'context-learning-curator-agent',    // emits LearningPromotion candidates only
  context_curation_fix: 'context-curation-fix-agent',            // applies approved curated edits only
  context_ingestion_repair: 'context-ingestion-repair-agent',    // produces repair plans only
  context_code_fix: 'context-code-fix-agent',                    // produces code plans only, never PRs
  context_qa_eval: 'context-qa-eval-agent',                      // validates remediations, read-only
};

function legacyRolesFor(role: ContextWorkerRole): string[] {
  const aliases: Record<ContextWorkerRole, string[]> = {
    context_review_triage: ['context_review_triage', 'review_triage'],
    context_remediation_planner: ['context_remediation_planner', 'remediation_planner'],
    context_learning_curator: ['context_learning_curator', 'learning_curator'],
    context_curation_fix: ['context_curation_fix', 'curation_fix'],
    context_ingestion_repair: ['context_ingestion_repair', 'ingestion_repair'],
    context_code_fix: ['context_code_fix', 'code_fix'],
    context_qa_eval: ['context_qa_eval', 'qa_eval'],
  };
  return aliases[role];
}

function normalizeWorkerAgentName(agentName: string | undefined | null): string | undefined {
  if (!agentName) return undefined;
  const normalized = agentName
    .trim()
    .toLowerCase()
    .replace(/^codex[\s:_-]+/, '')
    .replace(/_/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!normalized) return undefined;
  return normalized.endsWith('-agent') ? normalized : `${normalized}-agent`;
}

export interface ExecutableTaskRecord {
  recordId: string;
  assignmentId: string;
  agentName: string;
  workerRole: ContextWorkerRole;
  taskPayload: Record<string, unknown>;
  status: 'queued' | 'dispatched' | 'failed';
  createdAt: Date;
  updatedAt: Date;
}

export interface DispatchResult {
  assignmentId: string;
  dispatched: boolean;
  queuedRecord?: ExecutableTaskRecord;
  spawnResponse?: Record<string, unknown>;
  error?: string;
}

export interface WorkerAssignment {
  assignmentId: string;
  taskIds: string[];
  learningIds?: string[];
  remediationIds?: string[];
  curationTargetKey?: string;
  curationTarget?: { repoId: string; entryId: string };
  rootExecutionId?: string;
  sessionId?: string;
  repairMode?: boolean;
  repairAttemptId?: string;
  workerAgentName?: string;
  workerRole?: ContextWorkerRole;
  allenAgentInvocation?: AllenAgentInvocation;
  status: 'queued' | 'running' | 'completed' | 'failed';
  gates: OrchestratorGates;
  notes?: string;
  assignedAt: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

type RemediationAssignmentDoc = Record<string, unknown> & {
  remediationId?: string;
  targetRepoId?: string;
  repoId?: string;
  targetEntryId?: string;
  targetEntryIds?: string[];
  proposedPatch?: Record<string, unknown>;
};

export interface WorkerAssignmentConflict {
  remediationId: string;
  targetKey: string;
  activeAssignmentId: string;
}

export interface AssignBacklogResult {
  assigned: number;
  assignments: WorkerAssignment[];
  skippedConflicts?: WorkerAssignmentConflict[];
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function firstStringFromArray(value: unknown): string | undefined {
  return Array.isArray(value) ? firstString(...value) : undefined;
}

function remediationTarget(doc: RemediationAssignmentDoc): { repoId: string; entryId: string; key: string } {
  const proposedPatch = doc.proposedPatch ?? {};
  const repoId = firstString(
    doc.targetRepoId,
    doc.repoId,
    proposedPatch['targetRepoId'],
    proposedPatch['repoId'],
  ) ?? 'global';
  const entryId = firstString(
    firstStringFromArray(doc.targetEntryIds),
    doc.targetEntryId,
    proposedPatch['entryId'],
    proposedPatch['path'],
    doc.remediationId,
  ) ?? 'unknown';
  return { repoId, entryId, key: `${repoId}:${entryId}` };
}

function isGroupedCurationWorker(role: ContextWorkerRole): boolean {
  return role === 'context_curation_fix' || role === 'context_ingestion_repair';
}

export class ContextReviewWorkerOrchestrator {
  // MUST be false — non-negotiable (AC-17, AC-18)
  // MUST be true — non-negotiable (AC-19)
  readonly gates: OrchestratorGates = {
    bypassesHumanReview: false,
    enforcesCodeChangeBlock: true,
  };

  private assignmentsCollection: Collection<WorkerAssignment>;
  private scheduler: ContextEvaluationScheduler;

  constructor(private db: Db) {
    this.assignmentsCollection = db.collection<WorkerAssignment>('context_review_worker_assignments');
    this.scheduler = new ContextEvaluationScheduler(db);
  }

  private async activeCurationTargetAssignments(role: ContextWorkerRole): Promise<Map<string, string>> {
    const groupedRoles = Array.from(new Set([
      ...legacyRolesFor(role),
      ...legacyRolesFor('context_curation_fix'),
      ...legacyRolesFor('context_ingestion_repair'),
    ]));
    const activeAssignments = await this.assignmentsCollection
      .find({
        workerRole: { $in: groupedRoles },
        status: { $in: ['queued', 'running'] },
        remediationIds: { $exists: true, $ne: [] },
      } as never)
      .project({ _id: 0, assignmentId: 1, remediationIds: 1, curationTargetKey: 1 })
      .toArray();
    const byTarget = new Map<string, string>();
    const remediationIds = Array.from(new Set(
      activeAssignments.flatMap((assignment) => ((assignment as any).remediationIds ?? []) as string[]).filter(Boolean),
    ));
    if (remediationIds.length === 0) {
      for (const assignment of activeAssignments) {
        const targetKey = (assignment as any).curationTargetKey as string | undefined;
        const assignmentId = (assignment as any).assignmentId as string | undefined;
        if (targetKey && assignmentId) byTarget.set(targetKey, assignmentId);
      }
      return byTarget;
    }
    const remediations = await this.db.collection('context_remediations')
      .find({ remediationId: { $in: remediationIds } })
      .project({
        _id: 0,
        remediationId: 1,
        targetRepoId: 1,
        repoId: 1,
        targetEntryId: 1,
        targetEntryIds: 1,
        proposedPatch: 1,
      })
      .toArray() as RemediationAssignmentDoc[];
    const targetByRemediationId = new Map<string, string>();
    for (const remediation of remediations) {
      if (!remediation.remediationId) continue;
      targetByRemediationId.set(remediation.remediationId, remediationTarget(remediation).key);
    }
    for (const assignment of activeAssignments) {
      const assignmentId = (assignment as any).assignmentId as string | undefined;
      if (!assignmentId) continue;
      const storedTargetKey = (assignment as any).curationTargetKey as string | undefined;
      if (storedTargetKey) byTarget.set(storedTargetKey, assignmentId);
      for (const remediationId of (((assignment as any).remediationIds ?? []) as string[])) {
        const targetKey = targetByRemediationId.get(remediationId);
        if (targetKey) byTarget.set(targetKey, assignmentId);
      }
    }
    return byTarget;
  }

  /**
   * Assign a batch of auto-remediatable tasks to a worker agent.
   * Gates enforced:
   * - Never assigns tasks with requiresHumanReview=true (AC-18)
   * - Never assigns code_fix tasks (AC-18, AC-19)
   */
  async assignBacklog(params: {
    maxBatch?: number;
    workerAgentName?: string;
    workerRole?: ContextWorkerRole | string;
    repoId?: string;
    repoIds?: string[];
    allowBackfill?: boolean;
    remediationIds?: string[];
    repairMode?: boolean;
    rootExecutionId?: string;
    sessionId?: string;
  }): Promise<AssignBacklogResult> {
    const maxBatch = params.maxBatch ?? 10;
    const normalizedRole = normalizeContextWorkerRole(params.workerRole) ?? 'context_review_triage';
    const resolvedAgentName = params.workerAgentName
      ?? WORKER_ROLE_AGENT_MAP[normalizedRole]
      ?? 'context-review-triage-agent';
    const resolvedRole: ContextWorkerRole = normalizedRole;

    let taskIds: string[] = [];
    let learningIds: string[] | undefined;
    let remediationIds: string[] | undefined;
    let curationTarget: { repoId: string; entryId: string; key: string } | undefined;

    if (resolvedRole === 'context_learning_curator') {
      const repoFilter: RepoFilter | undefined = params.repoId || params.repoIds?.length
        ? { repoId: params.repoId, repoIds: params.repoIds }
        : undefined;
      const pendingLearnings = await this.scheduler.discoverPending(
        'chat_learning',
        maxBatch,
        repoFilter,
        params.allowBackfill === true,
      );
      const existingPromotions = await this.db.collection('context_learning_promotions')
        .find({ learningId: { $in: pendingLearnings.map((doc) => doc.sourceId).filter(Boolean) } })
        .project({ _id: 0, learningId: 1 })
        .toArray();
      const promoted = new Set(existingPromotions.map((doc) => doc['learningId'] as string).filter(Boolean));
      const selectedLearnings = pendingLearnings.filter((candidate) => !promoted.has(candidate.sourceId)).slice(0, maxBatch);
      learningIds = selectedLearnings.map((candidate) => candidate.sourceId);
      taskIds = learningIds;
      await this.scheduler.markSourcesAssigned('chat_learning', selectedLearnings);
    } else if (
      resolvedRole === 'context_curation_fix' ||
      resolvedRole === 'context_ingestion_repair' ||
      resolvedRole === 'context_code_fix' ||
      resolvedRole === 'context_qa_eval'
    ) {
      const explicitRemediationIds = Array.isArray(params.remediationIds)
        ? params.remediationIds.map((value) => String(value)).filter(Boolean)
        : [];
      const roleFilter: Record<string, unknown> = params.repairMode === true && explicitRemediationIds.length
        ? {
            remediationId: { $in: explicitRemediationIds },
            status: { $in: ['failed', 'pending', 'dispatched', 'running', 'repairing', 'partial', 'needs_review'] },
          }
        : resolvedRole === 'context_qa_eval'
          ? { status: 'completed' }
          : { status: { $in: ['pending', 'dispatched'] } };
      if (resolvedRole !== 'context_qa_eval') {
        roleFilter['humanGateRequired'] = { $ne: true };
      }
      if (resolvedRole === 'context_code_fix') {
        roleFilter['humanGateRequired'] = true;
      }
      const remediationDocs = await this.db.collection('context_remediations')
        .find({
          ...roleFilter,
          workerRole: { $in: legacyRolesFor(resolvedRole) },
        })
        .sort({ createdAt: 1 })
        .limit(explicitRemediationIds.length ? Math.max(explicitRemediationIds.length, maxBatch) : maxBatch)
        .project({
          _id: 0,
          remediationId: 1,
          targetRepoId: 1,
          repoId: 1,
          targetEntryId: 1,
          targetEntryIds: 1,
          proposedPatch: 1,
        })
        .toArray() as RemediationAssignmentDoc[];
      if (explicitRemediationIds.length) {
        const byId = new Map(remediationDocs.map((doc) => [doc.remediationId, doc]).filter(([id]) => Boolean(id)) as Array<[string, RemediationAssignmentDoc]>);
        remediationDocs.splice(0, remediationDocs.length, ...explicitRemediationIds.map((id) => byId.get(id)).filter((doc): doc is RemediationAssignmentDoc => Boolean(doc)));
      }
      if (isGroupedCurationWorker(resolvedRole)) {
        const activeByTarget = await this.activeCurationTargetAssignments(resolvedRole);
        const skippedConflicts: WorkerAssignmentConflict[] = [];
        const grouped = new Map<string, { target: { repoId: string; entryId: string; key: string }; docs: RemediationAssignmentDoc[] }>();
        for (const doc of remediationDocs) {
          const remediationId = doc.remediationId;
          if (!remediationId) continue;
          const target = remediationTarget(doc);
          const activeAssignmentId = activeByTarget.get(target.key);
          if (activeAssignmentId) {
            skippedConflicts.push({ remediationId, targetKey: target.key, activeAssignmentId });
            continue;
          }
          const existing = grouped.get(target.key) ?? { target, docs: [] };
          existing.docs.push(doc);
          grouped.set(target.key, existing);
        }
        if (grouped.size === 0) {
          return { assigned: 0, assignments: [], ...(skippedConflicts.length ? { skippedConflicts } : {}) };
        }

        const now = new Date();
        const assignments: WorkerAssignment[] = [];
        for (const group of grouped.values()) {
          const groupRemediationIds = group.docs.map((doc) => doc.remediationId).filter((id): id is string => Boolean(id));
          if (groupRemediationIds.length === 0) continue;
          const assignmentId = randomUUID();
          const allenAgentInvocation: AllenAgentInvocation = {
            agentName: resolvedAgentName,
            taskDescription: `Process ${groupRemediationIds.length} context remediation(s) for ${group.target.entryId} as ${resolvedRole} worker agent`,
            taskPayload: {
              assignmentId,
              taskIds: groupRemediationIds,
              remediationIds: groupRemediationIds,
              curationTargetKey: group.target.key,
              curationTarget: { repoId: group.target.repoId, entryId: group.target.entryId },
              workerRole: resolvedRole,
            },
            dispatchStatus: 'pending_runtime',
          };
          const assignment: WorkerAssignment = {
            assignmentId,
            taskIds: groupRemediationIds,
            remediationIds: groupRemediationIds,
            curationTargetKey: group.target.key,
            curationTarget: { repoId: group.target.repoId, entryId: group.target.entryId },
            rootExecutionId: params.rootExecutionId,
            sessionId: params.sessionId,
            repairMode: params.repairMode === true ? true : undefined,
            workerAgentName: resolvedAgentName,
            workerRole: resolvedRole,
            allenAgentInvocation,
            status: 'queued',
            gates: this.gates,
            assignedAt: now,
            createdAt: now,
            updatedAt: now,
          };
          await this.assignmentsCollection.insertOne(assignment as any);
          if (params.repairMode === true) {
            const repair = await new ContextRemediationTaskService(this.db).beginRepairAttempt({
              remediationIds: groupRemediationIds,
              assignmentId,
              workerRole: resolvedRole,
              rootExecutionId: params.rootExecutionId,
              sessionId: params.sessionId,
            });
            assignment.repairAttemptId = repair.attemptId;
            await this.assignmentsCollection.updateOne(
              { assignmentId },
              { $set: { repairAttemptId: repair.attemptId, updatedAt: now } },
            );
          } else {
            await this.db.collection('context_remediations').updateMany(
              { remediationId: { $in: groupRemediationIds } },
              { $set: { status: 'dispatched', updatedAt: now } },
            );
          }
          assignments.push(assignment);
        }
        return {
          assigned: assignments.reduce((sum, assignment) => sum + (assignment.remediationIds?.length ?? 0), 0),
          assignments,
          ...(skippedConflicts.length ? { skippedConflicts } : {}),
        };
      }
      remediationIds = remediationDocs.map((doc) => doc.remediationId).filter((id): id is string => Boolean(id));
      taskIds = remediationIds;
    } else {
      const baseFilter: Record<string, unknown> = {
        requiresHumanReview: false,
        fixType: { $ne: 'code_fix' },
      };
      if (resolvedRole === 'context_remediation_planner') {
      baseFilter.status = { $in: ['in_review', 'approved'] };
      baseFilter.$or = [
        { remediationStatus: { $exists: false } },
        { remediationStatus: { $in: ['ready', 'triaged', 'planning_failed'] } },
      ];
      } else {
        baseFilter.status = 'pending';
      }

      const candidateTasks = await this.db
        .collection('context_review_tasks')
        .find(baseFilter)
        .sort({ createdAt: 1 })
        .project({ _id: 0, taskId: 1 })
        .toArray();

      let eligibleTasks = candidateTasks;
      if (resolvedRole === 'context_remediation_planner' && candidateTasks.length > 0) {
        const candidateIds = candidateTasks.map((t) => t['taskId'] as string).filter(Boolean);
        const existingPlannerAssignments = await this.assignmentsCollection
          .find({
            workerRole: 'context_remediation_planner',
            status: { $in: ['queued', 'running', 'completed'] },
            taskIds: { $in: candidateIds },
          })
          .project({ _id: 0, taskIds: 1 })
          .toArray();
        const alreadyAssigned = new Set<string>();
        for (const assignment of existingPlannerAssignments) {
          for (const taskId of assignment.taskIds ?? []) alreadyAssigned.add(taskId);
        }
        eligibleTasks = candidateTasks.filter((task) => !alreadyAssigned.has(task['taskId'] as string));
      }
      eligibleTasks = eligibleTasks.slice(0, maxBatch);
      taskIds = eligibleTasks.map((t) => t['taskId'] as string).filter(Boolean);
    }

    if (taskIds.length === 0) {
      return { assigned: 0, assignments: [] };
    }

    const now = new Date();

    const assignmentId = randomUUID();

    const allenAgentInvocation: AllenAgentInvocation = {
      agentName: resolvedAgentName,
      taskDescription: `Process ${taskIds.length} context review task(s) as ${resolvedRole} worker agent`,
      taskPayload: {
        assignmentId,
        taskIds,
        learningIds,
        remediationIds,
        curationTargetKey: curationTarget?.key,
        curationTarget: curationTarget ? { repoId: curationTarget.repoId, entryId: curationTarget.entryId } : undefined,
        workerRole: resolvedRole,
      },
      dispatchStatus: 'pending_runtime',
    };

    const assignment: WorkerAssignment = {
      assignmentId,
      taskIds,
      learningIds,
      remediationIds,
      curationTargetKey: curationTarget?.key,
      curationTarget: curationTarget ? { repoId: curationTarget.repoId, entryId: curationTarget.entryId } : undefined,
      rootExecutionId: params.rootExecutionId,
      sessionId: params.sessionId,
      repairMode: params.repairMode === true ? true : undefined,
      workerAgentName: resolvedAgentName,
      workerRole: resolvedRole,
      allenAgentInvocation,
      status: 'queued',
      gates: this.gates,
      assignedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    await this.assignmentsCollection.insertOne(assignment as any);

    if (learningIds?.length) {
      // Learning workers emit promotion proposals; no source rows are mutated here.
    } else if (remediationIds?.length) {
      if (params.repairMode === true && resolvedRole !== 'context_qa_eval') {
        const repair = await new ContextRemediationTaskService(this.db).beginRepairAttempt({
          remediationIds,
          assignmentId,
          workerRole: resolvedRole,
          rootExecutionId: params.rootExecutionId,
          sessionId: params.sessionId,
        });
        assignment.repairAttemptId = repair.attemptId;
        await this.assignmentsCollection.updateOne(
          { assignmentId },
          { $set: { repairAttemptId: repair.attemptId, updatedAt: now } },
        );
      } else {
        await this.db.collection('context_remediations').updateMany(
          { remediationId: { $in: remediationIds } },
          { $set: { status: resolvedRole === 'context_qa_eval' ? 'running' : 'dispatched', updatedAt: now } },
        );
      }
    } else {
      const taskPatch = resolvedRole === 'context_remediation_planner'
      ? { remediationStatus: 'planning_dispatched', remediationQueue: 'dispatched', updatedAt: now }
      : { status: 'in_review', remediationStatus: 'ready', updatedAt: now };

      await this.db.collection('context_review_tasks').updateMany(
        { taskId: { $in: taskIds } },
        { $set: taskPatch },
      );
    }

    return { assigned: taskIds.length, assignments: [assignment] };
  }

  /**
   * Update assignment lifecycle state. Used by worker agents to report status
   * transitions (queued → running → completed/failed) and attach notes, result,
   * or agent-run metadata.
   *
   * The dispatch queue (context_agent_dispatch_queue) is an AUDIT/FALLBACK
   * mechanism. The primary worker-start mechanism is spawn_agent via the
   * orchestrator agent. This method only updates assignment records; it does
   * not trigger any new dispatches.
   */
  async updateAssignment(
    assignmentId: string,
    update: {
      status?: 'queued' | 'running' | 'completed' | 'failed';
      notes?: string;
      result?: Record<string, unknown>;
      agentRunId?: string;
      agentExecutionId?: string;
      workerRole?: string;
      agentName?: string;
    },
  ): Promise<boolean> {
    const now = new Date();
    const existing = await this.assignmentsCollection.findOne({ assignmentId });
    if (!existing) return false;
    const requestedRole = normalizeContextWorkerRole(update.workerRole) ?? update.workerRole;
    if (requestedRole && existing.workerRole && requestedRole !== existing.workerRole) {
      await this.assignmentsCollection.updateOne(
        { assignmentId },
        {
          $push: {
            ownershipWarnings: {
              code: 'worker_role_mismatch',
              requestedRole,
              assignmentWorkerRole: existing.workerRole,
              agentExecutionId: update.agentExecutionId,
              at: now,
            },
          },
          $set: { updatedAt: now },
        } as never,
      );
      return false;
    }
    const normalizedRequestedAgent = normalizeWorkerAgentName(update.agentName);
    const normalizedAssignmentAgent = normalizeWorkerAgentName(existing.workerAgentName);
    const roleVerified = Boolean(requestedRole && existing.workerRole && requestedRole === existing.workerRole);
    if (
      normalizedRequestedAgent &&
      normalizedAssignmentAgent &&
      normalizedRequestedAgent !== normalizedAssignmentAgent &&
      !roleVerified
    ) {
      await this.assignmentsCollection.updateOne(
        { assignmentId },
        {
          $push: {
            ownershipWarnings: {
              code: 'worker_agent_mismatch',
              requestedAgentName: update.agentName,
              assignmentWorkerAgentName: existing.workerAgentName,
              agentExecutionId: update.agentExecutionId,
              at: now,
            },
          },
          $set: { updatedAt: now },
        } as never,
      );
      return false;
    }
    const patch: Record<string, unknown> = { updatedAt: now };
    if (update.status !== undefined) patch.status = update.status;
    if (update.notes !== undefined) patch.notes = update.notes;
    if (update.result !== undefined) patch.result = update.result;
    if (update.agentRunId !== undefined) patch.agentRunId = update.agentRunId;
    if (update.agentExecutionId !== undefined) patch.agentExecutionId = update.agentExecutionId;
    if (update.status === 'completed' || update.status === 'failed') {
      patch.completedAt = now;
    }
    const result = await this.assignmentsCollection.updateOne(
      { assignmentId },
      { $set: patch },
    );
    if (
      result.modifiedCount > 0 &&
      update.agentName &&
      existing.workerAgentName &&
      normalizedRequestedAgent !== normalizedAssignmentAgent &&
      roleVerified
    ) {
      await this.assignmentsCollection.updateOne(
        { assignmentId },
        {
          $push: {
            ownershipWarnings: {
              code: 'worker_agent_alias_mismatch',
              requestedAgentName: update.agentName,
              assignmentWorkerAgentName: existing.workerAgentName,
              agentExecutionId: update.agentExecutionId,
              at: now,
            },
          },
        } as never,
      );
    }
    if (result.modifiedCount > 0 && (update.status === 'completed' || update.status === 'failed')) {
      await new ContextRemediationTaskService(this.db).reconcileStaleDispatched();
    }
    return result.modifiedCount > 0;
  }

  async completeAssignment(
    assignmentId: string,
    result: { status: 'completed' | 'failed'; notes?: string },
  ): Promise<boolean> {
    const now = new Date();
    const updateResult = await this.assignmentsCollection.updateOne(
      { assignmentId },
      {
        $set: {
          status: result.status,
          notes: result.notes,
          completedAt: now,
          updatedAt: now,
        },
      },
    );
    if (updateResult.modifiedCount > 0) {
      await new ContextRemediationTaskService(this.db).reconcileStaleDispatched();
    }
    return updateResult.modifiedCount > 0;
  }

  async listAssignments(params: {
    status?: string;
    limit?: number;
  }): Promise<WorkerAssignment[]> {
    const filter: Record<string, unknown> = {};
    if (params.status) filter.status = params.status;
    const limit = Math.min(params.limit ?? 50, 200);
    return this.assignmentsCollection
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray() as Promise<WorkerAssignment[]>;
  }

  async dispatchAssignmentToAgent(assignmentId: string): Promise<DispatchResult> {
    const assignment = await this.assignmentsCollection.findOne({ assignmentId });
    if (!assignment) {
      return { assignmentId, dispatched: false, error: 'Assignment not found' };
    }

    const agentName = assignment.allenAgentInvocation?.agentName ?? 'context-review-triage-agent';
    const workerRole: ContextWorkerRole = assignment.workerRole ?? 'context_review_triage';
    const now = new Date();

    // Create an executable task record in the dispatch queue
    const record: ExecutableTaskRecord = {
      recordId: randomUUID(),
      assignmentId,
      agentName,
      workerRole,
      taskPayload: {
        assignmentId,
        taskIds: assignment.taskIds,
        learningIds: assignment.learningIds,
        remediationIds: assignment.remediationIds,
        workerRole,
        rootExecutionId: assignment.rootExecutionId,
        sessionId: assignment.sessionId,
        repairMode: assignment.repairMode,
      },
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    };
    await this.db.collection('context_agent_dispatch_queue').insertOne(record as any);

    // Attempt Allen runtime spawn if configured
    const spawnUrl = process.env['ALLEN_AGENT_SPAWN_URL'];
    if (spawnUrl) {
      try {
        const response = await fetch(spawnUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentName,
            prompt: record.taskPayload,
            input: record.taskPayload,
          }),
        });
        const spawnBody = await response.json() as Record<string, unknown>;

        // Update record and assignment to 'dispatched'
        await this.db.collection('context_agent_dispatch_queue').updateOne(
          { recordId: record.recordId },
          { $set: { status: 'dispatched', updatedAt: new Date() } },
        );
        if (assignment.allenAgentInvocation) {
          await this.assignmentsCollection.updateOne(
            { assignmentId },
            {
              $set: {
                'allenAgentInvocation.dispatchStatus': 'dispatched',
                'allenAgentInvocation.dispatchedAt': new Date(),
                updatedAt: new Date(),
              },
            },
          );
        }
        return {
          assignmentId,
          dispatched: true,
          queuedRecord: { ...record, status: 'dispatched' },
          spawnResponse: spawnBody,
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await this.db.collection('context_agent_dispatch_queue').updateOne(
          { recordId: record.recordId },
          { $set: { status: 'failed', updatedAt: new Date() } },
        );
        if (assignment.allenAgentInvocation) {
          await this.assignmentsCollection.updateOne(
            { assignmentId },
            {
              $set: {
                'allenAgentInvocation.dispatchStatus': 'failed',
                'allenAgentInvocation.dispatchError': errMsg,
                updatedAt: new Date(),
              },
            },
          );
        }
        return { assignmentId, dispatched: false, queuedRecord: record, error: errMsg };
      }
    }

    // No spawn URL configured — record is queued for Allen runtime adapter
    return { assignmentId, dispatched: false, queuedRecord: record };
  }

  async listDispatchQueue(params: { status?: string; limit?: number }): Promise<ExecutableTaskRecord[]> {
    const filter: Record<string, unknown> = {};
    if (params.status) filter['status'] = params.status;
    const limit = Math.min(params.limit ?? 50, 200);
    const docs = await this.db.collection('context_agent_dispatch_queue')
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    return docs as unknown as ExecutableTaskRecord[];
  }
}
