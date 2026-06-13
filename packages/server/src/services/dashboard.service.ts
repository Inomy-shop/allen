import type { Db } from 'mongodb';

export class DashboardService {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async getStats(): Promise<Record<string, unknown>> {
    const execCol = this.db.collection('executions');

    const total = await execCol.countDocuments();

    const byStatus = await execCol
      .aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }])
      .toArray();

    // Cost is summed from execution_traces — the per-LLM-run source of
    // truth — never from execution rows (which store no cost). Excluding
    // child_execution traces keeps sub-workflow links from double-counting.
    const costAgg = await this.db.collection('execution_traces')
      .aggregate([
        { $match: { 'cost.method': { $ne: 'child_execution' } } },
        {
          $group: {
            _id: null,
            totalEstimated: { $sum: { $ifNull: ['$cost.estimated', 0] } },
            totalActual: { $sum: { $ifNull: ['$cost.actual', 0] } },
          },
        },
      ])
      .toArray();

    const avgDuration = await execCol
      .aggregate([
        { $match: { status: 'completed' } },
        { $group: { _id: '$workflowName', avgDuration: { $avg: '$durationMs' }, count: { $sum: 1 } } },
      ])
      .toArray();

    return {
      total,
      byStatus: Object.fromEntries(byStatus.map(s => [s._id, s.count])),
      cost: costAgg[0] ?? { totalEstimated: 0, totalActual: 0 },
      avgDurationByWorkflow: Object.fromEntries(avgDuration.map(d => [d._id, { avgDuration: d.avgDuration, count: d.count }])),
    };
  }

  async getCostBreakdown(): Promise<Record<string, unknown>> {
    const tracesCol = this.db.collection('execution_traces');

    const byAgent = await tracesCol
      .aggregate([
        { $match: { agent: { $ne: null }, 'cost.method': { $ne: 'child_execution' } } },
        {
          $group: {
            _id: '$agent',
            totalEstimated: { $sum: { $ifNull: ['$cost.estimated', 0] } },
            totalActual: { $sum: { $ifNull: ['$cost.actual', 0] } },
            count: { $sum: 1 },
          },
        },
      ])
      .toArray();

    // Per-workflow cost = each execution's OWN traces grouped by the
    // execution's workflowName (join via $lookup). Execution rows no longer
    // store cost, and a workflow's number here intentionally excludes child
    // executions it triggered — those count under their own workflow/agent.
    const byWorkflow = await tracesCol
      .aggregate([
        { $match: { 'cost.method': { $ne: 'child_execution' } } },
        {
          $group: {
            _id: '$executionId',
            totalEstimated: { $sum: { $ifNull: ['$cost.estimated', 0] } },
            totalActual: { $sum: { $ifNull: ['$cost.actual', 0] } },
          },
        },
        {
          $lookup: {
            from: 'executions',
            localField: '_id',
            foreignField: 'id',
            as: 'execution',
            pipeline: [{ $project: { workflowName: 1 } }],
          },
        },
        { $unwind: '$execution' },
        {
          $group: {
            _id: '$execution.workflowName',
            totalEstimated: { $sum: '$totalEstimated' },
            totalActual: { $sum: '$totalActual' },
            count: { $sum: 1 },
          },
        },
      ])
      .toArray();

    return {
      byAgent: Object.fromEntries(byAgent.map(r => [r._id, r])),
      byWorkflow: Object.fromEntries(byWorkflow.map(w => [w._id, w])),
    };
  }
}
