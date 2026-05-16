import yaml from 'js-yaml';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Collection, Db } from 'mongodb';
import { validateWorkflow, loadAgents, getBuiltIns, generateMermaid } from '@allen/engine';
import type { WorkflowDef, ValidationResult } from '@allen/engine';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
      projection: {
        name: 1,
        description: 1,
        version: 1,
        tags: 1,
        validation: 1,
        updatedAt: 1,
        archived: 1,
        'parsed.input': 1,
        'parsed.nodes': 1,
        'parsed.edges': 1,
      },
    }).sort({ updatedAt: -1 }).toArray();
  }

  async ensureDefaultWorkflows(names: string[]): Promise<Record<string, unknown>[]> {
    const wanted = new Set(names.filter(Boolean));
    if (wanted.size === 0) return [];

    const yamlAgents = loadAgents();
    const builtInNames = Object.keys(getBuiltIns());
    const dbAgents = await this.db.collection('agents').find({}, { projection: { name: 1, system: 1 } }).toArray();
    const agents: Record<string, { system: string }> = { ...yamlAgents };
    for (const a of dbAgents) {
      agents[a.name as string] = { system: (a.system as string) ?? '' };
    }

    const possiblePaths = [
      join(__dirname, '..', '..', '..', 'engine', 'workflows'),
      join(__dirname, '..', '..', '..', '..', 'engine', 'workflows'),
      join(process.cwd(), '..', 'engine', 'workflows'),
    ];
    const workflowDir = possiblePaths.find(path => existsSync(path));
    if (!workflowDir) throw new Error('Default workflows directory not found');

    const files = readdirSync(workflowDir).filter(file => file.endsWith('.yml') || file.endsWith('.yaml'));
    for (const file of files) {
      const content = readFileSync(join(workflowDir, file), 'utf-8');
      const parsed = yaml.load(content) as WorkflowDef;
      if (!wanted.has(parsed.name)) continue;

      const existing = await this.col.findOne({ name: parsed.name });
      if (existing) continue;

      const validation = validateWorkflow(parsed, agents, builtInNames);
      await this.col.insertOne({
        name: parsed.name,
        description: parsed.description ?? '',
        version: 1,
        yaml: content,
        parsed,
        reactFlowData: null,
        validation,
        tags: ['default'],
        createdBy: 'system',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    return this.col.find({ name: { $in: [...wanted] } }, {
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

  async create(body: { yaml?: string; parsed?: WorkflowDef; createdBy?: string; tags?: string[] }): Promise<Record<string, unknown>> {
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

    // Reject duplicate names so the agent gets a clear error instead of
    // silently creating a second workflow that shadows the first.
    const existing = await this.col.findOne({ name: parsed.name });
    if (existing) {
      throw new Error(`Workflow "${parsed.name}" already exists. Use update instead, or pick a different name.`);
    }

    const validation = await this.validate(parsed);

    const doc = {
      name: parsed.name,
      description: parsed.description ?? '',
      version: 1,
      yaml: rawYaml,
      parsed,
      reactFlowData: null,
      validation,
      tags: body.tags ?? [],
      createdBy: body.createdBy ?? 'system',
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
      updates.validation = await this.validate(parsed);
      updates.version = (existing.version as number ?? 0) + 1;
    } else if (body.parsed) {
      updates.parsed = body.parsed;
      updates.yaml = yaml.dump(body.parsed);
      updates.name = body.parsed.name;
      updates.description = body.parsed.description ?? '';
      updates.validation = await this.validate(body.parsed);
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

  /**
   * Validate a workflow against known agents (YAML file + database).
   * The YAML file has the old default agents; the database has the new org agents.
   * Both are merged so all agent references are resolved.
   */
  async validate(workflow: WorkflowDef): Promise<ValidationResult> {
    const yamlAgents = loadAgents();

    // Also load agents from the database (the new org agents live here)
    const dbAgents = await this.db.collection('agents').find({}, { projection: { name: 1, system: 1, model: 1, provider: 1, tools: 1 } }).toArray();
    const merged = { ...yamlAgents };
    for (const a of dbAgents) {
      merged[a.name as string] = { system: (a.system as string) ?? '' };
    }

    const builtIns = getBuiltIns();
    return validateWorkflow(workflow, merged, Object.keys(builtIns));
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
