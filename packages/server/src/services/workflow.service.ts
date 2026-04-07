import yaml from 'js-yaml';
import type { Collection, Db } from 'mongodb';
import { validateWorkflow, loadAgents, getBuiltIns, generateMermaid } from '@flowforge/engine';
import type { WorkflowDef, ValidationResult } from '@flowforge/engine';

export class WorkflowService {
  private col: Collection;
  private db: Db;

  constructor(db: Db) {
    this.db = db;
    this.col = db.collection('workflows');
  }

  async list(includeArchived = false): Promise<Record<string, unknown>[]> {
    const filter = includeArchived ? {} : { archived: { $ne: true } };
    return this.col.find(filter, {
      projection: { name: 1, description: 1, version: 1, tags: 1, validation: 1, updatedAt: 1, archived: 1 },
    }).sort({ updatedAt: -1 }).toArray();
  }

  async getById(id: string): Promise<Record<string, unknown> | null> {
    const { ObjectId } = await import('mongodb');
    return this.col.findOne({ _id: new ObjectId(id) });
  }

  async getByName(name: string): Promise<Record<string, unknown> | null> {
    return this.col.findOne({ name });
  }

  async create(body: { yaml?: string; parsed?: WorkflowDef }): Promise<Record<string, unknown>> {
    let parsed: WorkflowDef;
    let rawYaml: string;

    if (body.yaml) {
      rawYaml = body.yaml;
      parsed = yaml.load(rawYaml) as WorkflowDef;
    } else if (body.parsed) {
      parsed = body.parsed;
      rawYaml = yaml.dump(parsed);
    } else {
      throw new Error('Either yaml or parsed must be provided');
    }

    const validation = this.validate(parsed);

    const doc = {
      name: parsed.name,
      description: parsed.description ?? '',
      version: 1,
      yaml: rawYaml,
      parsed,
      reactFlowData: null,
      validation,
      tags: [],
      createdBy: 'system',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await this.col.insertOne(doc);
    return { ...doc, _id: result.insertedId };
  }

  async update(id: string, body: { yaml?: string; parsed?: WorkflowDef; reactFlowData?: unknown }): Promise<Record<string, unknown>> {
    const { ObjectId } = await import('mongodb');
    const existing = await this.col.findOne({ _id: new ObjectId(id) });
    if (!existing) throw new Error('Workflow not found');

    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (body.yaml) {
      const parsed = yaml.load(body.yaml) as WorkflowDef;
      updates.yaml = body.yaml;
      updates.parsed = parsed;
      updates.name = parsed.name;
      updates.description = parsed.description ?? '';
      updates.validation = this.validate(parsed);
      updates.version = (existing.version as number ?? 0) + 1;
    } else if (body.parsed) {
      updates.parsed = body.parsed;
      updates.yaml = yaml.dump(body.parsed);
      updates.name = body.parsed.name;
      updates.description = body.parsed.description ?? '';
      updates.validation = this.validate(body.parsed);
      updates.version = (existing.version as number ?? 0) + 1;
    }

    if (body.reactFlowData !== undefined) {
      updates.reactFlowData = body.reactFlowData;
    }

    await this.col.updateOne({ _id: new ObjectId(id) }, { $set: updates });
    return { ...existing, ...updates };
  }

  async delete(id: string): Promise<void> {
    const { ObjectId } = await import('mongodb');
    await this.col.deleteOne({ _id: new ObjectId(id) });
  }

  validate(workflow: WorkflowDef): ValidationResult {
    const agents = loadAgents();
    const builtIns = getBuiltIns();
    return validateWorkflow(workflow, agents, Object.keys(builtIns));
  }

  async validateById(id: string): Promise<ValidationResult> {
    const { ObjectId } = await import('mongodb');
    const doc = await this.col.findOne({ _id: new ObjectId(id) });
    if (!doc) throw new Error('Workflow not found');
    return this.validate(doc.parsed as WorkflowDef);
  }

  async getMermaid(id: string): Promise<string> {
    const { ObjectId } = await import('mongodb');
    const doc = await this.col.findOne({ _id: new ObjectId(id) });
    if (!doc) throw new Error('Workflow not found');
    return generateMermaid(doc.parsed as WorkflowDef);
  }

  async importFromYaml(yamlContent: string): Promise<Record<string, unknown>> {
    return this.create({ yaml: yamlContent });
  }

  async exportAsYaml(id: string): Promise<string> {
    const { ObjectId } = await import('mongodb');
    const doc = await this.col.findOne({ _id: new ObjectId(id) });
    if (!doc) throw new Error('Workflow not found');
    return doc.yaml as string;
  }
}
