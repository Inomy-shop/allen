/**
 * ContextTraceAnalysisAssignmentService — manages trace-analysis worker batches.
 *
 * Collection: context_trace_analysis_assignments
 *
 * Separate from context_review_worker_assignments (remediation workers).
 * Each document represents one worker batch that analyses up to 20
 * context_usage_trace candidates and persists a source evaluation per trace.
 *
 * The orchestrator:
 *   1. Calls listUnevaluatedContextTraces (scheduler) in batches of 20.
 *   2. Creates one assignment per batch via create().
 *   3. Spawns up to 4 concurrent worker agents, recording workerExecutionId.
 *   4. Waits for all assignments to reach a terminal state.
 *   5. Finalizes the session using DB-derived counts.
 *
 * Indexes (on the collection, applied at startup / migration):
 *   { assignmentId: 1 }  unique
 *   { sessionId: 1, status: 1 }
 *   { sourceIds: 1 }  — multikey, supports anti-join in listUnevaluatedContextTraces
 *   { createdAt: -1 }
 */

import { randomUUID } from 'node:crypto';
import type { Db, Collection } from 'mongodb';

export type TraceAssignmentStatus = 'queued' | 'running' | 'completed' | 'failed';
export type TraceAssignmentTerminalReason =
  | 'completed'
  | 'failed_unretried'
  | 'retried'
  | 'self_trace_ignored'
  | 'cancelled';

export interface ContextTraceAnalysisAssignment {
  assignmentId: string;
  sessionId: string;
  repoId?: string;
  /** Always 'context_usage_trace' — this collection is dedicated to trace analysis. */
  sourceType: 'context_usage_trace';
  /** Up to 20 contextAttemptIds in this batch. */
  sourceIds: string[];
  workerAgentName?: string;
  /** Allen execution_id of the spawned worker agent. */
  workerExecutionId?: string;
  status: TraceAssignmentStatus;
  retryOfAssignmentId?: string;
  retryAttempt?: number;
  supersededByAssignmentIds?: string[];
  terminalReason?: TraceAssignmentTerminalReason;
  /** Number of traces assigned (= sourceIds.length at creation time). */
  assignedCount: number;
  /** Number of traces for which a source evaluation was persisted. */
  evaluatedCount: number;
  /** Number of traces the worker skipped (no evidence / intentional skip). */
  skippedCount: number;
  /** Number of traces the worker could not evaluate due to an error. */
  failedCount: number;
  /** Number of findings created during this assignment. */
  findingCount: number;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

export class ContextTraceAnalysisAssignmentService {
  private collection: Collection<ContextTraceAnalysisAssignment>;

  constructor(private db: Db) {
    this.collection = db.collection<ContextTraceAnalysisAssignment>('context_trace_analysis_assignments');
  }

  /**
   * Create a new trace-analysis assignment for a batch of ≤ 20 traces.
   * Validates that sourceIds.length ≤ 20 (enforced here, not just in the prompt).
   */
  async create(input: {
    sessionId: string;
    repoId?: string;
    sourceIds: string[];
    workerAgentName?: string;
    retryOfAssignmentId?: string;
  }): Promise<ContextTraceAnalysisAssignment> {
    if (input.sourceIds.length > 20) {
      throw new Error(
        `Trace analysis assignment batch size must be ≤ 20 traces; received ${input.sourceIds.length}`,
      );
    }
    const now = new Date();
    let retryAttempt: number | undefined;
    if (input.retryOfAssignmentId) {
      const original = await this.collection.findOne(
        { assignmentId: input.retryOfAssignmentId },
        { projection: { retryAttempt: 1 } },
      ) as ContextTraceAnalysisAssignment | null;
      retryAttempt = ((original as any)?.retryAttempt ?? 0) + 1;
    }

    const assignment: ContextTraceAnalysisAssignment = {
      assignmentId: randomUUID(),
      sessionId: input.sessionId,
      repoId: input.repoId,
      sourceType: 'context_usage_trace',
      sourceIds: input.sourceIds,
      workerAgentName: input.workerAgentName,
      retryOfAssignmentId: input.retryOfAssignmentId,
      retryAttempt,
      status: 'queued',
      assignedCount: input.sourceIds.length,
      evaluatedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      findingCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.collection.insertOne(assignment as any);

    const retryFilter: Record<string, unknown> = input.retryOfAssignmentId
      ? { assignmentId: input.retryOfAssignmentId }
      : {
          sessionId: input.sessionId,
          status: 'failed',
          sourceIds: { $in: input.sourceIds },
        };
    await this.collection.updateMany(
      retryFilter,
      {
        $addToSet: { supersededByAssignmentIds: assignment.assignmentId } as any,
        $set: { terminalReason: 'retried', updatedAt: now },
      },
    );

    return assignment;
  }

  /**
   * Retrieve a single assignment by assignmentId.
   */
  async get(assignmentId: string): Promise<ContextTraceAnalysisAssignment | null> {
    return this.collection.findOne({ assignmentId }) as Promise<ContextTraceAnalysisAssignment | null>;
  }

  /**
   * List assignments, optionally filtered by sessionId and/or status.
   */
  async list(params: {
    sessionId?: string;
    status?: TraceAssignmentStatus;
    limit?: number;
    offset?: number;
  }): Promise<ContextTraceAnalysisAssignment[]> {
    const filter: Record<string, unknown> = {};
    if (params.sessionId) filter['sessionId'] = params.sessionId;
    if (params.status) filter['status'] = params.status;
    const limit = Math.min(params.limit ?? 100, 500);
    const offset = params.offset ?? 0;
    return this.collection
      .find(filter as any)
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limit)
      .toArray() as Promise<ContextTraceAnalysisAssignment[]>;
  }

  /**
   * Update assignment lifecycle fields.
   * Workers call this to report status transitions (queued → running → completed/failed)
   * and to persist their evaluation counts.
   */
  async update(
    assignmentId: string,
    patch: {
      status?: TraceAssignmentStatus;
      workerExecutionId?: string;
      workerAgentName?: string;
      evaluatedCount?: number;
      skippedCount?: number;
      failedCount?: number;
      findingCount?: number;
      error?: string;
      terminalReason?: TraceAssignmentTerminalReason;
    },
  ): Promise<boolean> {
    const now = new Date();
    const update: Record<string, unknown> = { updatedAt: now };

    if (patch.status !== undefined) update['status'] = patch.status;
    if (patch.workerExecutionId !== undefined) update['workerExecutionId'] = patch.workerExecutionId;
    if (patch.workerAgentName !== undefined) update['workerAgentName'] = patch.workerAgentName;
    if (patch.evaluatedCount !== undefined) update['evaluatedCount'] = patch.evaluatedCount;
    if (patch.skippedCount !== undefined) update['skippedCount'] = patch.skippedCount;
    if (patch.failedCount !== undefined) update['failedCount'] = patch.failedCount;
    if (patch.findingCount !== undefined) update['findingCount'] = patch.findingCount;
    if (patch.error !== undefined) update['error'] = patch.error;
    if (patch.terminalReason !== undefined) update['terminalReason'] = patch.terminalReason;
    if (patch.status === 'completed' || patch.status === 'failed') {
      update['completedAt'] = now;
      if (patch.terminalReason === undefined) {
        update['terminalReason'] = patch.status === 'completed' ? 'completed' : 'failed_unretried';
      }
    }

    const result = await this.collection.updateOne(
      { assignmentId },
      { $set: update },
    );
    return result.modifiedCount > 0;
  }

  /**
   * Get aggregate counts for a session's trace analysis assignments.
   * Used by the orchestrator's DB-derived summary to compute coverage.
   */
  async countBySession(sessionId: string): Promise<{
    total: number;
    byStatus: Partial<Record<TraceAssignmentStatus, number>>;
    totalAssigned: number;
    totalEvaluated: number;
    totalSkipped: number;
    totalFailed: number;
    totalFindings: number;
    retriedTraceCount: number;
    effectiveEvaluatedTraceCount: number;
    effectiveSkippedTraceCount: number;
    effectiveFailedTraceCount: number;
    effectiveAssignedTraceCount: number;
    ignoredSelfTraceCount: number;
  }> {
    const docs = await this.collection
      .find({ sessionId }, {
        projection: {
          status: 1,
          assignedCount: 1,
          evaluatedCount: 1,
          skippedCount: 1,
          failedCount: 1,
          findingCount: 1,
          sourceIds: 1,
          terminalReason: 1,
          supersededByAssignmentIds: 1,
        },
      })
      .toArray();

    const byStatus: Partial<Record<TraceAssignmentStatus, number>> = {};
    let totalAssigned = 0;
    let totalEvaluated = 0;
    let totalSkipped = 0;
    let totalFailed = 0;
    let totalFindings = 0;
    const allAssigned = new Set<string>();
    const retriedSources = new Set<string>();
    const ignoredSelfTraceSources = new Set<string>();

    for (const doc of docs) {
      const s = (doc as any).status as TraceAssignmentStatus;
      if (s) byStatus[s] = (byStatus[s] ?? 0) + 1;
      const sourceIds = ((doc as any).sourceIds as string[] | undefined) ?? [];
      for (const id of sourceIds) allAssigned.add(id);
      if (((doc as any).supersededByAssignmentIds as string[] | undefined)?.length) {
        for (const id of sourceIds) retriedSources.add(id);
      }
      if ((doc as any).terminalReason === 'self_trace_ignored') {
        for (const id of sourceIds) ignoredSelfTraceSources.add(id);
      }
      totalAssigned += ((doc as any).assignedCount as number) ?? 0;
      totalEvaluated += ((doc as any).evaluatedCount as number) ?? 0;
      totalSkipped += ((doc as any).skippedCount as number) ?? 0;
      totalFailed += ((doc as any).failedCount as number) ?? 0;
      totalFindings += ((doc as any).findingCount as number) ?? 0;
    }

    const completedEvaluations = await this.db
      .collection('context_source_evaluations')
      .find(
        {
          sessionId,
          sourceType: 'context_usage_trace',
          status: 'completed',
          sourceId: { $in: Array.from(allAssigned) },
        },
        { projection: { sourceId: 1, decision: 1 } },
      )
      .toArray();

    const evaluatedSources = new Set<string>();
    const skippedSources = new Set<string>();
    for (const evaluation of completedEvaluations) {
      const sourceId = (evaluation as any).sourceId as string | undefined;
      if (!sourceId) continue;
      if ((evaluation as any).decision === 'skipped') {
        skippedSources.add(sourceId);
      } else {
        evaluatedSources.add(sourceId);
      }
    }

    const effectivelyProcessed = new Set<string>([...evaluatedSources, ...skippedSources, ...ignoredSelfTraceSources]);
    const failedSources = new Set<string>();
    for (const doc of docs) {
      if ((doc as any).status !== 'failed') continue;
      const superseded = (((doc as any).supersededByAssignmentIds as string[] | undefined) ?? []).length > 0;
      if (superseded) continue;
      for (const sourceId of (((doc as any).sourceIds as string[] | undefined) ?? [])) {
        if (!effectivelyProcessed.has(sourceId)) failedSources.add(sourceId);
      }
    }

    return {
      total: docs.length,
      byStatus,
      totalAssigned,
      totalEvaluated,
      totalSkipped,
      totalFailed,
      totalFindings,
      retriedTraceCount: retriedSources.size,
      effectiveEvaluatedTraceCount: evaluatedSources.size,
      effectiveSkippedTraceCount: skippedSources.size,
      effectiveFailedTraceCount: failedSources.size,
      effectiveAssignedTraceCount: allAssigned.size,
      ignoredSelfTraceCount: ignoredSelfTraceSources.size,
    };
  }

  /**
   * Return all contextAttemptIds that are currently in a non-failed assignment.
   * Used by listUnevaluatedContextTraces to exclude in-flight traces from discovery.
   */
  async getActivelyAssignedSourceIds(): Promise<Set<string>> {
    const docs = await this.collection
      .find(
        { status: { $ne: 'failed' } },
        { projection: { sourceIds: 1 } },
      )
      .toArray();

    const ids = new Set<string>();
    for (const doc of docs) {
      const sourceIds = (doc as any).sourceIds as string[] | undefined;
      if (Array.isArray(sourceIds)) {
        for (const id of sourceIds) {
          ids.add(id);
        }
      }
    }
    return ids;
  }
}
