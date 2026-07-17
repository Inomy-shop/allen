import yaml from 'js-yaml';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ObjectId, type Collection, type Db } from 'mongodb';
import { validateWorkflow, loadAgents, getBuiltIns, generateMermaid, normalizeModelAlias } from '@allen/engine';
import type { WorkflowDef, ValidationResult } from '@allen/engine';
import { notDeletedFilter, softDeleteSet, restoreSet } from './soft-delete.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MODEL_OVERRIDE_FIELDS = ['provider', 'model', 'reasoningEffort', 'planMode'] as const;
const INSTRUCTION_LIKE_NODE_FIELDS = ['prompt', 'instructions', 'system', 'outputs'] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isPlainRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function stableEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

export class WorkflowService {
  private col: Collection;
  private db: Db;

  constructor(db: Db) {
    this.db = db;
    this.col = db.collection('workflows');
  }

  async list(includeArchived = false): Promise<Record<string, unknown>[]> {
    const filter = includeArchived
      ? notDeletedFilter
      : { archived: { $ne: true }, ...notDeletedFilter };
    const rows = await this.col.find(filter, {
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
    if (rows.length === 0) return [];

    const workflowIds = rows.map((row) => String(row._id));
    const workflowNames = rows.map((row) => String(row.name)).filter(Boolean);
    const executionGroups = await this.db.collection('executions').aggregate([
      {
        $match: {
          $or: [
            { workflowId: { $in: workflowIds } },
            { workflowName: { $in: workflowNames } },
          ],
        },
      },
      {
        $group: {
          _id: {
            workflowId: '$workflowId',
            workflowName: '$workflowName',
          },
          count: { $sum: 1 },
        },
      },
    ]).toArray();

    const countsById = new Map<string, number>();
    const countsByName = new Map<string, number>();
    for (const group of executionGroups) {
      const id = typeof group._id?.workflowId === 'string' ? group._id.workflowId : null;
      const name = typeof group._id?.workflowName === 'string' ? group._id.workflowName : null;
      if (id) countsById.set(id, (countsById.get(id) ?? 0) + Number(group.count ?? 0));
      else if (name) countsByName.set(name, (countsByName.get(name) ?? 0) + Number(group.count ?? 0));
    }

    return rows.map((row) => ({
      ...row,
      runCount: countsById.get(String(row._id)) ?? countsByName.get(String(row.name)) ?? 0,
    }));
  }

  /**
   * Slim list for agent/MCP consumers — omits the heavy `parsed.nodes` and
   * `parsed.edges` graphs that the chat-side `list_workflows` MCP tool
   * doesn't need (callers use `get_workflow` to fetch the full graph for a
   * chosen workflow). Returned shape mirrors the chat-tools.ts listWorkflows
   * tool so agents get a consistent summary across in-process and MCP paths.
   */
  async listSummary(includeArchived = false): Promise<Record<string, unknown>[]> {
    const filter = includeArchived
      ? notDeletedFilter
      : { archived: { $ne: true }, ...notDeletedFilter };
    const rows = await this.col.find(filter, {
      projection: {
        name: 1,
        description: 1,
        version: 1,
        validation: 1,
        updatedAt: 1,
        'parsed.nodes': 1, // counted then discarded
      },
    }).sort({ updatedAt: -1 }).toArray();
    return rows.map((w) => {
      const wAny = w as Record<string, unknown>;
      const parsed = wAny.parsed as { nodes?: Record<string, unknown> } | undefined;
      const validation = wAny.validation as { valid?: boolean } | undefined;
      return {
        id: String(w._id),
        name: w.name,
        description: (w.description as string) ?? '',
        version: (w.version as number) ?? 1,
        isValid: validation?.valid ?? false,
        nodeCount: parsed?.nodes ? Object.keys(parsed.nodes).length : 0,
        updatedAt: w.updatedAt,
      };
    });
  }

  async ensureDefaultWorkflows(names: string[]): Promise<Record<string, unknown>[]> {
    const wanted = new Set(names.filter(Boolean));
    if (wanted.size === 0) return [];

    const yamlAgents = loadAgents();
    const builtInNames = Object.keys(getBuiltIns());
    const dbAgents = await this.db.collection('agents').find(notDeletedFilter, { projection: { name: 1, system: 1 } }).toArray();
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
      if (existing) {
        // If soft-deleted, restore it with current YAML content
        if (existing.isDeleted) {
          const validation = validateWorkflow(parsed, agents, builtInNames);
          await this.col.updateOne(
            { name: parsed.name },
            restoreSet({
              name: parsed.name,
              description: parsed.description ?? '',
              version: (existing.version as number ?? 0) + 1,
              yaml: content,
              parsed,
              reactFlowData: null,
              validation,
              tags: ['default'],
              createdBy: 'system',
            }),
          );
        }
        continue;
      }

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
    return this.col.findOne({ _id: new ObjectId(id), ...notDeletedFilter });
  }

  async getByName(name: string): Promise<Record<string, unknown> | null> {
    return this.col.findOne({ name, ...notDeletedFilter });
  }

  private inferProviderForModel(model: string, aliasMap: Record<string, string>, modelProviderMap: Record<string, string>): string | undefined {
    const resolvedModel = normalizeModelAlias(model, aliasMap) ?? model;
    const fromRegistry = modelProviderMap[resolvedModel] ?? modelProviderMap[model];
    if (fromRegistry) return fromRegistry;

    const lower = model.toLowerCase().trim();
    if (!lower) return undefined;
    if (lower === 'sonnet' || lower === 'opus' || lower === 'haiku' || lower === 'fable' || lower.startsWith('claude-')) return 'claude';
    if (lower.startsWith('gpt-') || lower === 'o3' || lower.startsWith('o4-') || lower.startsWith('codex-')) return 'codex';
    if (lower.startsWith('deepseek-')) return 'deepseek';
    if (lower.startsWith('kimi-')) return 'kimi';
    if (lower.startsWith('mimo-')) return 'xiaomi-mimo';
    if (lower.startsWith('glm-')) return 'zai';
    return undefined;
  }

  private async addMissingNodeOverrideProviders(parsed: WorkflowDef): Promise<boolean> {
    const nodes = parsed.nodes as Record<string, Record<string, unknown>> | undefined;
    if (!nodes) return false;

    const aliasMap: Record<string, string> = {};
    const modelProviderMap: Record<string, string> = {};
    try {
      const entries = await this.db.collection('model_registry')
        .find({ isActive: true }, { projection: { alias: 1, fullId: 1, provider: 1 } })
        .toArray();
      for (const entry of entries) {
        const provider = typeof entry.provider === 'string' ? entry.provider : undefined;
        const fullId = typeof entry.fullId === 'string' ? entry.fullId : undefined;
        const alias = typeof entry.alias === 'string' ? entry.alias : undefined;
        if (alias && fullId) aliasMap[alias.toLowerCase()] = fullId;
        if (provider && fullId) modelProviderMap[fullId] = provider;
        if (provider && alias) modelProviderMap[alias] = provider;
      }
    } catch {
      // Best-effort only; static fallback below still covers Allen's seed catalog.
    }

    let changed = false;
    for (const node of Object.values(nodes)) {
      const overrides = node?.agentOverrides;
      if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) continue;
      const typedOverrides = overrides as Record<string, unknown>;
      if (typedOverrides.provider != null || typeof typedOverrides.model !== 'string') continue;
      const provider = this.inferProviderForModel(typedOverrides.model, aliasMap, modelProviderMap);
      if (!provider) continue;
      typedOverrides.provider = provider;
      changed = true;
    }
    return changed;
  }

  private preserveExistingNodeModelOverrides(existing: unknown, next: WorkflowDef): boolean {
    const existingNodes = isPlainRecord(existing)
      && isPlainRecord(existing.nodes)
      ? existing.nodes as Record<string, unknown>
      : undefined;
    const nextNodes = next.nodes as Record<string, Record<string, unknown>> | undefined;
    if (!existingNodes || !nextNodes) return false;

    let changed = false;
    for (const [nodeName, nextNode] of Object.entries(nextNodes)) {
      const existingNode = existingNodes[nodeName];
      if (!isPlainRecord(existingNode) || !isPlainRecord(nextNode)) continue;

      if (
        typeof existingNode.type === 'string'
        && typeof nextNode.type === 'string'
        && existingNode.type !== nextNode.type
      ) {
        continue;
      }

      const existingAgent = typeof existingNode.agent === 'string'
        ? existingNode.agent
        : typeof existingNode.role === 'string'
          ? existingNode.role
          : undefined;
      const nextAgent = typeof nextNode.agent === 'string'
        ? nextNode.agent
        : typeof nextNode.role === 'string'
          ? nextNode.role
          : undefined;
      if (existingAgent && nextAgent && existingAgent !== nextAgent) continue;

      if (!isPlainRecord(existingNode.agentOverrides)) continue;
      const existingOverrides = existingNode.agentOverrides;
      const nextOverrides = isPlainRecord(nextNode.agentOverrides)
        ? { ...nextNode.agentOverrides }
        : {};
      const instructionsChanged = INSTRUCTION_LIKE_NODE_FIELDS.some((field) => (
        !stableEqual(existingNode[field], nextNode[field])
      ));

      let nodeChanged = false;
      for (const field of MODEL_OVERRIDE_FIELDS) {
        if (!hasOwn(existingOverrides, field)) continue;
        const nextHasExplicitValue = hasOwn(nextOverrides, field);
        if (nextHasExplicitValue && !instructionsChanged) continue;
        if (stableEqual(nextOverrides[field], existingOverrides[field])) continue;
        nextOverrides[field] = existingOverrides[field];
        nodeChanged = true;
      }

      if (nodeChanged) {
        nextNode.agentOverrides = nextOverrides;
        changed = true;
      }
    }
    return changed;
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

    if (await this.addMissingNodeOverrideProviders(parsed)) {
      rawYaml = yaml.dump(parsed, { lineWidth: 120, noRefs: true, sortKeys: false });
    }

    // Check for soft-deleted record with the same name — restore instead of insert.
    // Also reject active duplicates so the agent gets a clear error.
    const deleted = await this.col.findOne({ name: parsed.name, isDeleted: true });
    if (deleted) {
      const validation = await this.validate(parsed);
      await this.col.updateOne(
        { name: parsed.name },
        restoreSet({
          name: parsed.name,
          description: parsed.description ?? '',
          version: (deleted.version as number ?? 0) + 1,
          yaml: rawYaml,
          parsed,
          reactFlowData: null,
          validation,
          tags: body.tags ?? [],
          createdBy: body.createdBy ?? 'system',
        }),
      );
      return { ...deleted, name: parsed.name, description: parsed.description, version: (deleted.version as number ?? 0) + 1, yaml: rawYaml, parsed, validation, tags: body.tags, restored: true };
    }

    const existing = await this.col.findOne({ name: parsed.name, ...notDeletedFilter });
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
    const existing = await this.col.findOne({ _id: new ObjectId(id), ...notDeletedFilter });
    if (!existing) throw new Error('Workflow not found');

    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (body.yaml) {
      const parsed = yaml.load(body.yaml) as WorkflowDef;
      const preserved = this.preserveExistingNodeModelOverrides(existing.parsed, parsed);
      const changed = await this.addMissingNodeOverrideProviders(parsed);
      updates.yaml = preserved || changed ? yaml.dump(parsed, { lineWidth: 120, noRefs: true, sortKeys: false }) : body.yaml;
      updates.parsed = parsed;
      updates.name = parsed.name;
      updates.description = parsed.description ?? '';
      updates.validation = await this.validate(parsed);
      updates.version = (existing.version as number ?? 0) + 1;
    } else if (body.parsed) {
      this.preserveExistingNodeModelOverrides(existing.parsed, body.parsed);
      await this.addMissingNodeOverrideProviders(body.parsed);
      updates.parsed = body.parsed;
      updates.yaml = yaml.dump(body.parsed, { lineWidth: 120, noRefs: true, sortKeys: false });
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
    await this.col.updateOne({ _id: new ObjectId(id) }, softDeleteSet());
  }

  /**
   * Validate a workflow against known agents (YAML file + database).
   * The YAML file has the old default agents; the database has the new org agents.
   * Both are merged so all agent references are resolved.
   */
  async validate(workflow: WorkflowDef): Promise<ValidationResult> {
    const yamlAgents = loadAgents();

    // Also load agents from the database (the new org agents live here)
    const dbAgents = await this.db.collection('agents').find(notDeletedFilter, { projection: { name: 1, system: 1, model: 1, provider: 1, tools: 1 } }).toArray();
    const merged = { ...yamlAgents };
    for (const a of dbAgents) {
      merged[a.name as string] = { system: (a.system as string) ?? '' };
    }

    const builtIns = getBuiltIns();
    return validateWorkflow(workflow, merged, Object.keys(builtIns));
  }

  async validateById(id: string): Promise<ValidationResult> {
    const { ObjectId } = await import('mongodb');
    const _id = new ObjectId(id);
    const doc = await this.col.findOne({ _id, ...notDeletedFilter });
    if (!doc) throw new Error('Workflow not found');
    const validation = await this.validate(doc.parsed as WorkflowDef);
    await this.col.updateOne({ _id }, { $set: { validation, updatedAt: new Date() } });
    return validation;
  }

  async getMermaid(id: string): Promise<string> {
    const { ObjectId } = await import('mongodb');
    const doc = await this.col.findOne({ _id: new ObjectId(id), ...notDeletedFilter });
    if (!doc) throw new Error('Workflow not found');
    return generateMermaid(doc.parsed as WorkflowDef);
  }

  async importFromYaml(yamlContent: string): Promise<Record<string, unknown>> {
    return this.create({ yaml: yamlContent });
  }

  async exportAsYaml(id: string): Promise<string> {
    const { ObjectId } = await import('mongodb');
    const doc = await this.col.findOne({ _id: new ObjectId(id), ...notDeletedFilter });
    if (!doc) throw new Error('Workflow not found');
    return doc.yaml as string;
  }

  async exportAsJson(ids: string[]): Promise<Record<string, unknown>> {
    const filter = ids.length > 0
      ? { _id: { $in: ids.map((id) => new ObjectId(id)) }, ...notDeletedFilter }
      : { archived: { $ne: true }, ...notDeletedFilter };
    const docs = await this.col.find(filter).sort({ name: 1 }).toArray();
    return {
      kind: 'allen-workflows-bundle',
      version: 1,
      exportedAt: new Date().toISOString(),
      workflows: docs.map((doc) => {
        const copy = { ...doc } as Record<string, unknown>;
        delete copy._id;
        delete copy.createdAt;
        delete copy.updatedAt;
        copy.createdBy = 'import';
        return copy;
      }),
    };
  }

  async importFromJsonBundle(bundle: unknown): Promise<Record<string, unknown>> {
    const input = (bundle ?? {}) as { workflows?: Record<string, unknown>[] };
    const workflows = Array.isArray(input.workflows) ? input.workflows : [];
    if (workflows.length === 0) throw new Error('workflows must be a non-empty array');

    const created: string[] = [];
    const skipped: { name: string; reason: string }[] = [];
    for (const item of workflows) {
      const yamlContent = typeof item.yaml === 'string' ? item.yaml : '';
      const parsed = item.parsed as WorkflowDef | undefined;
      const name = typeof item.name === 'string' ? item.name : parsed?.name;
      if (!name || (!yamlContent && !parsed)) {
        skipped.push({ name: name ?? '(missing)', reason: 'invalid-workflow' });
        continue;
      }
      const existing = await this.col.findOne({ name });
      if (existing) {
        if (existing.isDeleted) {
          // Restore soft-deleted workflow with the imported data
          try {
            const createdDoc = await this.create({
              yaml: yamlContent || undefined,
              parsed: yamlContent ? undefined : parsed,
              createdBy: 'import',
              tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === 'string') : [],
            });
            created.push(String(createdDoc.name));
          } catch (err) {
            skipped.push({ name, reason: (err as Error).message });
          }
          continue;
        }
        skipped.push({ name, reason: 'already-exists' });
        continue;
      }
      try {
        const createdDoc = await this.create({
          yaml: yamlContent || undefined,
          parsed: yamlContent ? undefined : parsed,
          createdBy: 'import',
          tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === 'string') : [],
        });
        created.push(String(createdDoc.name));
      } catch (err) {
        skipped.push({ name, reason: (err as Error).message });
      }
    }
    return { created, skipped };
  }

}
