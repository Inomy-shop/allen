import type { Db, Collection, ObjectId } from 'mongodb';
import { embedAndSave } from './embedding.service.js';

export class LearningService {
  private collection: Collection;

  constructor(private db: Db) {
    this.collection = db.collection('learnings');
  }

  async list(params: {
    scope?: string;
    type?: string;
    status?: string;
    tags?: string[];
    workflowName?: string;
    confidence_min?: number;
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<any[]> {
    const filter: Record<string, unknown> = {};

    if (params.scope) filter['scope.level'] = params.scope;
    if (params.type) filter.type = params.type;
    if (params.status) {
      filter.status = params.status;
    } else {
      filter.status = 'active'; // default to active
    }
    if (params.tags && params.tags.length > 0) {
      filter.tags = { $all: params.tags };
    }
    if (params.workflowName) {
      filter['scope.workflowName'] = params.workflowName;
    }
    if (params.confidence_min != null) {
      filter.confidence = { $gte: params.confidence_min };
    }
    if (params.search) {
      filter.content = { $regex: params.search, $options: 'i' };
    }

    const limit = Math.min(params.limit ?? 50, 200);
    const offset = params.offset ?? 0;

    return this.collection
      .find(filter)
      .sort({ confidence: -1, createdAt: -1 })
      .skip(offset)
      .limit(limit)
      .toArray();
  }

  async stats(): Promise<Record<string, unknown>> {
    const [total, active, archived, superseded] = await Promise.all([
      this.collection.countDocuments(),
      this.collection.countDocuments({ status: 'active' }),
      this.collection.countDocuments({ status: 'archived' }),
      this.collection.countDocuments({ status: 'superseded' }),
    ]);

    // Aggregate by type
    const byTypePipeline = [
      { $match: { status: 'active' } },
      { $group: { _id: '$type', count: { $sum: 1 } } },
    ];
    const byTypeResult = await this.collection.aggregate(byTypePipeline).toArray();
    const byType: Record<string, number> = {};
    for (const row of byTypeResult) {
      byType[row._id as string] = row.count;
    }

    // Aggregate by scope
    const byScopePipeline = [
      { $match: { status: 'active' } },
      { $group: { _id: '$scope.level', count: { $sum: 1 } } },
    ];
    const byScopeResult = await this.collection.aggregate(byScopePipeline).toArray();
    const byScope: Record<string, number> = {};
    for (const row of byScopeResult) {
      byScope[row._id as string] = row.count;
    }

    // Aggregate by source type
    const bySourcePipeline = [
      { $match: { status: 'active' } },
      { $group: { _id: '$source.sourceType', count: { $sum: 1 } } },
    ];
    const bySourceResult = await this.collection.aggregate(bySourcePipeline).toArray();
    const bySource: Record<string, number> = {};
    for (const row of bySourceResult) {
      bySource[row._id as string] = row.count;
    }

    return { total, active, archived, superseded, byType, byScope, bySource };
  }

  async getById(id: string): Promise<any> {
    const { ObjectId } = await import('mongodb');
    return this.collection.findOne({ _id: new ObjectId(id) });
  }

  async create(body: {
    content: string;
    type: string;
    scope: { level: string; workflowName?: string; contextTags?: string[]; agentName?: string };
    tags?: string[];
  }): Promise<any> {
    const now = new Date();
    const doc = {
      content: body.content,
      type: body.type,
      tags: body.tags ?? [],
      scope: body.scope,
      source: {
        executionId: '',
        nodeName: 'manual',
        workflowName: body.scope.workflowName ?? '',
        sourceType: 'manual',
        timestamp: now,
      },
      confidence: 0.7,
      confirmations: 0,
      contradictions: 0,
      usageCount: 0,
      validFrom: now,
      tokenCount: Math.ceil(body.content.split(/\s+/).length * 1.3),
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };

    const result = await this.collection.insertOne(doc);
    // Generate embedding (non-blocking)
    embedAndSave(this.db, result.insertedId.toString(), body.content).catch(() => {});
    return { ...doc, _id: result.insertedId };
  }

  async update(id: string, body: {
    content?: string;
    type?: string;
    tags?: string[];
    confidence?: number;
  }): Promise<any> {
    const { ObjectId } = await import('mongodb');
    const update: Record<string, unknown> = { updatedAt: new Date() };

    if (body.content != null) {
      update.content = body.content;
      update.tokenCount = Math.ceil(body.content.split(/\s+/).length * 1.3);
    }
    if (body.type != null) update.type = body.type;
    if (body.tags != null) update.tags = body.tags;
    if (body.confidence != null) update.confidence = body.confidence;

    await this.collection.updateOne(
      { _id: new ObjectId(id) },
      { $set: update },
    );

    return this.collection.findOne({ _id: new ObjectId(id) });
  }

  async approve(id: string): Promise<any> {
    const { ObjectId } = await import('mongodb');
    await this.collection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { confidence: 0.95, updatedAt: new Date() } },
    );
    return this.collection.findOne({ _id: new ObjectId(id) });
  }

  async reject(id: string): Promise<any> {
    const { ObjectId } = await import('mongodb');
    await this.collection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: 'archived', updatedAt: new Date() } },
    );
    return this.collection.findOne({ _id: new ObjectId(id) });
  }

  async archive(id: string): Promise<void> {
    const { ObjectId } = await import('mongodb');
    await this.collection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: 'archived', updatedAt: new Date() } },
    );
  }

  async forExecution(executionId: string): Promise<{ injected: any[]; extracted: any[] }> {
    // Extracted: learnings where source.executionId matches
    const extracted = await this.collection
      .find({ 'source.executionId': executionId })
      .sort({ createdAt: -1 })
      .toArray();

    // Injected: We cannot perfectly track which learnings were injected into a specific execution
    // without a separate tracking collection. Return empty for now — the UI will parse logs instead.
    return { injected: [], extracted };
  }
}
