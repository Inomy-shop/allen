import type { Collection, Db, Filter } from 'mongodb';
import { ObjectId } from 'mongodb';
import type { Checkpoint, ExecutionState } from './types.js';

export class StateManager {
  private executionsCol: Collection;
  private checkpointsCol: Collection;
  private tracesCol: Collection;

  private failureReportsCol: Collection;

  constructor(private db: Db) {
    this.executionsCol = db.collection('executions');
    this.checkpointsCol = db.collection('checkpoints');
    this.tracesCol = db.collection('execution_traces');
    this.failureReportsCol = db.collection('execution_failure_reports');
  }

  /**
   * Persist a detailed "why did this fail" report for forensics when an
   * execution transitions to `failed`. Pulls gate-specific diagnostic fields
   * out of the final state so we can show actionable diffs in the UI later.
   */
  async saveFailureReport(exec: ExecutionState, error: Error | string): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const state = exec.state ?? {};

    const failureType: 'max_retries_exceeded' | 'node_threw' | 'unknown' =
      /Max retries.*exceeded/i.test(message) ? 'max_retries_exceeded'
      : exec.failedNode ? 'node_threw'
      : 'unknown';

    const pick = <T,>(keys: string[]): T | undefined => {
      const out: Record<string, unknown> = {};
      let hasAny = false;
      for (const k of keys) {
        if (k in state) {
          out[k] = (state as Record<string, unknown>)[k];
          hasAny = true;
        }
      }
      return hasAny ? (out as T) : undefined;
    };

    const doc = {
      executionId: exec.id,
      workflowName: exec.workflowName,
      failedAt: new Date(),
      failureType,
      failedNode: exec.failedNode ?? null,
      errorMessage: message,

      lastValidatorResult: pick<unknown>(['validation_passed', 'validation_results', 'failed_checks']),
      lastRequirementResult: pick<unknown>(['completeness', 'requirement_results', 'missing_items']),
      lastSecurityResult: pick<unknown>(['security_verdict', 'security_feedback']),
      lastCodeReviewResult: pick<unknown>(['review_verdict', 'review_feedback']),
      lastFinalValidation: pick<unknown>(['final_passed', 'final_failed_items']),

      finalState: state,
      completedNodes: exec.completedNodes ?? [],
      retryCounts: exec.retryCounts ?? {},

      createdAt: new Date(),
    };

    try {
      await this.failureReportsCol.insertOne(doc as any);
    } catch (err) {
      console.error('[state-manager] Failed to save failure report:', (err as Error).message);
    }
  }

  async getFailureReport(executionId: string): Promise<unknown | null> {
    return this.failureReportsCol.findOne({ executionId });
  }

  async createExecution(exec: ExecutionState): Promise<string> {
    const result = await this.executionsCol.insertOne(exec);
    return result.insertedId.toString();
  }

  async getExecution(id: string): Promise<ExecutionState | null> {
    return this.executionsCol.findOne({ id }) as Promise<ExecutionState | null>;
  }

  async updateExecution(id: string, update: Partial<ExecutionState>): Promise<void> {
    await this.executionsCol.updateOne({ id }, { $set: update });
  }

  /**
   * Like updateExecution, but also supports clearing fields via `$unset`.
   * Used when re-running / resuming an execution to clear prior error fields
   * (errorMessage, failedNode) so the UI doesn't show stale failure info.
   */
  async updateExecutionWithUnset(
    id: string,
    setUpdate: Partial<ExecutionState>,
    unsetFields: string[],
  ): Promise<void> {
    const op: Record<string, unknown> = {};
    if (Object.keys(setUpdate).length > 0) op.$set = setUpdate;
    if (unsetFields.length > 0) {
      op.$unset = Object.fromEntries(unsetFields.map((f) => [f, '']));
    }
    if (Object.keys(op).length === 0) return;
    await this.executionsCol.updateOne({ id }, op);
  }

  async saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
    await this.checkpointsCol.insertOne(checkpoint);
  }

  async getLatestCheckpoint(executionId: string): Promise<Checkpoint | null> {
    return this.checkpointsCol.findOne(
      { executionId },
      { sort: { createdAt: -1 } },
    ) as Promise<Checkpoint | null>;
  }

  /**
   * Get the last checkpoint taken before a specific node was executed.
   */
  async getCheckpointBefore(executionId: string, nodeName: string): Promise<Checkpoint | null> {
    // Find checkpoints where completedNodes does NOT include the target node
    const checkpoints = await this.checkpointsCol
      .find({ executionId, completedNodes: { $nin: [nodeName] } })
      .sort({ createdAt: -1 })
      .limit(1)
      .toArray();
    return (checkpoints[0] as unknown as Checkpoint) ?? null;
  }

  /**
   * List every checkpoint for an execution, newest first. Returns full docs
   * (state can be large — callers wanting a list view should project fields
   * client-side).
   */
  async listCheckpoints(executionId: string): Promise<Array<Checkpoint & { _id: ObjectId }>> {
    const docs = await this.checkpointsCol
      .find({ executionId })
      .sort({ createdAt: -1 })
      .toArray();
    return docs as unknown as Array<Checkpoint & { _id: ObjectId }>;
  }

  /**
   * Look up a single checkpoint by its Mongo _id, scoped to the given
   * executionId (defense-in-depth: prevents fetching checkpoints across
   * executions via id guessing).
   */
  async getCheckpointById(
    executionId: string,
    checkpointId: string,
  ): Promise<(Checkpoint & { _id: ObjectId }) | null> {
    let oid: ObjectId;
    try { oid = new ObjectId(checkpointId); } catch { return null; }
    const doc = await this.checkpointsCol.findOne({ _id: oid, executionId });
    return (doc as unknown as (Checkpoint & { _id: ObjectId })) ?? null;
  }

  /**
   * Update a checkpoint. Only whitelisted fields are writable:
   *   - `state`: the node-state blob, edited by the user
   *   - `editedAt`, `editedBy`: audit trail
   * Other fields (executionId, afterNode, createdAt, completedNodes, sessions,
   * retryCounts) are immutable in v1 to prevent corruption. Returns the
   * updated document or null if the checkpoint doesn't exist / doesn't
   * belong to the given execution.
   */
  async updateCheckpoint(
    executionId: string,
    checkpointId: string,
    updates: { state?: Record<string, unknown>; editedBy?: ObjectId | string },
  ): Promise<(Checkpoint & { _id: ObjectId }) | null> {
    let oid: ObjectId;
    try { oid = new ObjectId(checkpointId); } catch { return null; }
    const $set: Record<string, unknown> = { editedAt: new Date() };
    if (updates.state !== undefined) $set.state = updates.state;
    if (updates.editedBy !== undefined) {
      $set.editedBy = typeof updates.editedBy === 'string'
        ? new ObjectId(updates.editedBy)
        : updates.editedBy;
    }
    const filter: Filter<Record<string, unknown>> = { _id: oid, executionId };
    const result = await this.checkpointsCol.findOneAndUpdate(
      filter as Filter<any>,
      { $set },
      { returnDocument: 'after' },
    );
    if (!result) return null;
    return result as unknown as (Checkpoint & { _id: ObjectId });
  }

  /**
   * Count running executions for a given workflow name.
   */
  async countRunningExecutions(workflowName: string): Promise<number> {
    return this.executionsCol.countDocuments({
      workflowName,
      status: { $in: ['running', 'waiting_for_input'] },
    });
  }

  async saveTrace(trace: Record<string, unknown>): Promise<void> {
    await this.tracesCol.insertOne(trace);
  }

  async getTraces(executionId: string): Promise<Record<string, unknown>[]> {
    return this.tracesCol.find({ executionId }).sort({ startedAt: 1 }).toArray();
  }

  async getTracesByNode(executionId: string, node: string): Promise<Record<string, unknown>[]> {
    return this.tracesCol.find({ executionId, node }).sort({ attempt: 1 }).toArray();
  }

  async getTraceByAttempt(executionId: string, node: string, attempt: number): Promise<Record<string, unknown> | null> {
    return this.tracesCol.findOne({ executionId, node, attempt });
  }

  async listExecutions(filter: Record<string, unknown> = {}): Promise<ExecutionState[]> {
    const docs = await this.executionsCol
      .find(filter)
      .sort({ startedAt: -1 })
      .limit(100)
      .toArray();
    return docs as unknown as ExecutionState[];
  }

  /**
   * Paginated variant of listExecutions. Returns the page slice plus the
   * total matching count so callers can render pagination controls.
   * `skip` defaults to 0; `limit` is clamped to [1, 200].
   */
  async listExecutionsPaged(
    filter: Record<string, unknown> = {},
    opts: { skip?: number; limit?: number } = {},
  ): Promise<{ items: ExecutionState[]; total: number }> {
    const skip = Math.max(0, opts.skip ?? 0);
    const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
    const [items, total] = await Promise.all([
      this.executionsCol
        .find(filter)
        .sort({ startedAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      this.executionsCol.countDocuments(filter),
    ]);
    return { items: items as unknown as ExecutionState[], total };
  }

  async getExecutionStats(): Promise<Record<string, unknown>> {
    const total = await this.executionsCol.countDocuments();
    const byStatus = await this.executionsCol
      .aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }])
      .toArray();
    const costAgg = await this.executionsCol
      .aggregate([
        { $group: { _id: null, totalEstimated: { $sum: '$cost.estimated' }, totalActual: { $sum: '$cost.actual' } } },
      ])
      .toArray();

    return {
      total,
      byStatus: Object.fromEntries(byStatus.map(s => [s._id, s.count])),
      cost: costAgg[0] ?? { totalEstimated: 0, totalActual: 0 },
    };
  }
}
