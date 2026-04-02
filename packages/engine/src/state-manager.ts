import type { Collection, Db } from 'mongodb';
import type { Checkpoint, ExecutionState } from './types.js';

export class StateManager {
  private executionsCol: Collection;
  private checkpointsCol: Collection;
  private tracesCol: Collection;

  constructor(private db: Db) {
    this.executionsCol = db.collection('executions');
    this.checkpointsCol = db.collection('checkpoints');
    this.tracesCol = db.collection('execution_traces');
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
