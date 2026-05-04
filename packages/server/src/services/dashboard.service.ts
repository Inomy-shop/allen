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

    const costAgg = await execCol
      .aggregate([
        {
          $group: {
            _id: null,
            totalEstimated: { $sum: '$cost.estimated' },
            totalActual: { $sum: '$cost.actual' },
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
        { $match: { agent: { $ne: null } } },
        {
          $group: {
            _id: '$agent',
            totalEstimated: { $sum: '$cost.estimated' },
            totalActual: { $sum: '$cost.actual' },
            count: { $sum: 1 },
          },
        },
      ])
      .toArray();

    const byWorkflow = await this.db
      .collection('executions')
      .aggregate([
        {
          $group: {
            _id: '$workflowName',
            totalEstimated: { $sum: '$cost.estimated' },
            totalActual: { $sum: '$cost.actual' },
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
