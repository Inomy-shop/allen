import { ObjectId, type Collection, type Db } from 'mongodb';
import { notDeletedFilter, softDeleteSet, restoreSet } from './soft-delete.js';

export type SkillRoute =
  | 'direct_answer'
  | 'data_query'
  | 'spawn_agent'
  | 'run_workflow';

export interface SkillInput {
  name: string;
  displayName?: string;
  description?: string;
  category?: string;
  triggers?: string[];
  excludes?: string[];
  priority?: number;
  enabled?: boolean;
  allowedRoutes?: SkillRoute[];
  relatedWorkflows?: string[];
  relatedAgents?: string[];
  body: string;
  tags?: string[];
  createdBy?: string;
}

export interface SkillSearchInput {
  query?: string;
  context?: Record<string, unknown>;
  limit?: number;
  includeDisabled?: boolean;
}

const ROUTES: SkillRoute[] = [
  'direct_answer',
  'data_query',
  'spawn_agent',
  'run_workflow',
];

const REQUIRED_BODY_SECTIONS = [
  'when to use',
  'when not to use',
  'clarify and confirm',
  'capability discovery',
  'routing',
  'evidence',
];

function normalizeSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(v => String(v).trim()).filter(Boolean);
}

function normalizeRoutes(value: unknown): SkillRoute[] {
  const raw = asStringArray(value);
  const routes = raw.filter((route): route is SkillRoute => ROUTES.includes(route as SkillRoute));
  return routes.length > 0 ? routes : ['direct_answer'];
}

function normalizedSkill(input: SkillInput, existing?: Record<string, unknown>): Record<string, unknown> {
  const name = normalizeSlug(input.name);
  if (!name) throw new Error('Skill name is required');
  const body = String(input.body ?? '').trim();
  if (!body) throw new Error('Skill body is required');

  return {
    name,
    displayName: String(input.displayName ?? input.name).trim() || name,
    description: String(input.description ?? '').trim(),
    category: normalizeSlug(input.category ?? 'routing') || 'routing',
    triggers: asStringArray(input.triggers),
    excludes: asStringArray(input.excludes),
    priority: Number.isFinite(input.priority) ? Number(input.priority) : 50,
    enabled: input.enabled ?? true,
    allowedRoutes: normalizeRoutes(input.allowedRoutes),
    relatedWorkflows: asStringArray(input.relatedWorkflows),
    relatedAgents: asStringArray(input.relatedAgents),
    body,
    tags: asStringArray(input.tags),
    version: ((existing?.version as number | undefined) ?? 0) + 1,
    createdBy: existing?.createdBy ?? input.createdBy ?? 'user',
  };
}

function tokenize(value: string): string[] {
  const stopWords = new Set([
    'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'onto', 'have', 'what', 'will',
    'want', 'need', 'does', 'how', 'why', 'can', 'you', 'use', 'job', 'work', 'task',
  ]);
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 3 && !stopWords.has(token));
}

function includesAny(haystack: string, needles: string[]): boolean {
  return needles.some(needle => needle && haystack.includes(needle.toLowerCase()));
}

function scoreSkill(skill: Record<string, unknown>, query: string): { score: number; matched: string[] } {
  const q = query.trim().toLowerCase();
  if (!q) {
    return { score: (skill.priority as number | undefined) ?? 0, matched: ['priority'] };
  }

  const matched: string[] = [];
  let score = ((skill.priority as number | undefined) ?? 0) / 10;
  const triggers = asStringArray(skill.triggers);
  const excludes = asStringArray(skill.excludes);
  const name = String(skill.name ?? '').toLowerCase();
  const displayName = String(skill.displayName ?? '').toLowerCase();
  const description = String(skill.description ?? '').toLowerCase();
  const category = String(skill.category ?? '').toLowerCase();
  const body = String(skill.body ?? '').toLowerCase();

  if (includesAny(q, excludes) || includesAny([name, displayName, description, body].join(' '), excludes.filter(ex => q.includes(ex.toLowerCase())))) {
    score -= 100;
    matched.push('exclude');
  }

  for (const trigger of triggers) {
    const t = trigger.toLowerCase();
    if (q.includes(t)) {
      score += 40;
      matched.push(`trigger:${trigger}`);
    }
  }

  for (const token of tokenize(q)) {
    if (name.includes(token)) {
      score += 12;
      matched.push(`name:${token}`);
    }
    if (displayName.includes(token)) {
      score += 8;
      matched.push(`display:${token}`);
    }
    if (category.includes(token)) {
      score += 6;
      matched.push(`category:${token}`);
    }
    if (description.includes(token)) {
      score += 5;
      matched.push(`description:${token}`);
    }
    if (body.includes(token)) {
      score += 1;
      matched.push(`body:${token}`);
    }
  }

  return { score, matched: Array.from(new Set(matched)) };
}

export class SkillService {
  private col: Collection;
  private db: Db;

  constructor(db: Db) {
    this.db = db;
    this.col = db.collection('skills');
  }

  async list(includeDisabled = false): Promise<Record<string, unknown>[]> {
    const filter = includeDisabled
      ? notDeletedFilter
      : { enabled: { $ne: false }, ...notDeletedFilter };
    return this.col.find(filter, {
      projection: {
        body: 0,
      },
    }).sort({ priority: -1, name: 1 }).toArray();
  }

  async getById(id: string): Promise<Record<string, unknown> | null> {
    if (!ObjectId.isValid(id)) throw new Error(`Invalid skill id "${id}"`);
    return this.col.findOne({ _id: new ObjectId(id), ...notDeletedFilter });
  }

  async getByName(name: string): Promise<Record<string, unknown> | null> {
    return this.col.findOne({ name: normalizeSlug(name), ...notDeletedFilter });
  }

  async create(input: SkillInput): Promise<Record<string, unknown>> {
    const doc = normalizedSkill(input);

    // Check for soft-deleted record with the same name — restore instead of insert
    const deleted = await this.col.findOne({ name: doc.name, isDeleted: true });
    if (deleted) {
      await this.validateDoc(doc);
      const now = new Date();
      await this.col.updateOne(
        { name: doc.name },
        restoreSet({ ...doc, createdAt: now, updatedAt: now }),
      );
      const restored = await this.col.findOne({ name: doc.name });
      return { ...restored, restored: true };
    }

    const existing = await this.col.findOne({ name: doc.name, ...notDeletedFilter });
    if (existing) throw new Error(`Skill "${doc.name}" already exists`);
    await this.validateDoc(doc);
    const now = new Date();
    const result = await this.col.insertOne({ ...doc, createdAt: now, updatedAt: now });
    return { ...doc, _id: result.insertedId, createdAt: now, updatedAt: now };
  }

  async update(id: string, input: Partial<SkillInput>): Promise<Record<string, unknown>> {
    if (!ObjectId.isValid(id)) throw new Error(`Invalid skill id "${id}"`);
    const existing = await this.col.findOne({ _id: new ObjectId(id), ...notDeletedFilter });
    if (!existing) throw new Error('Skill not found');

    const merged = normalizedSkill({
      name: (input.name ?? existing.name) as string,
      displayName: (input.displayName ?? existing.displayName) as string,
      description: (input.description ?? existing.description) as string,
      category: (input.category ?? existing.category) as string,
      triggers: (input.triggers ?? existing.triggers) as string[],
      excludes: (input.excludes ?? existing.excludes) as string[],
      priority: (input.priority ?? existing.priority) as number,
      enabled: (input.enabled ?? existing.enabled) as boolean,
      allowedRoutes: (input.allowedRoutes ?? existing.allowedRoutes) as SkillRoute[],
      relatedWorkflows: (input.relatedWorkflows ?? existing.relatedWorkflows) as string[],
      relatedAgents: (input.relatedAgents ?? existing.relatedAgents) as string[],
      body: (input.body ?? existing.body) as string,
      tags: (input.tags ?? existing.tags) as string[],
      createdBy: existing.createdBy as string,
    }, existing);

    const duplicate = await this.col.findOne({ name: merged.name, _id: { $ne: existing._id } });
    if (duplicate) throw new Error(`Skill "${merged.name}" already exists`);
    await this.validateDoc(merged);

    const updatedAt = new Date();
    await this.col.updateOne({ _id: existing._id }, { $set: { ...merged, updatedAt } });
    return { ...existing, ...merged, updatedAt };
  }

  async delete(id: string): Promise<void> {
    if (!ObjectId.isValid(id)) throw new Error(`Invalid skill id "${id}"`);
    await this.col.updateOne({ _id: new ObjectId(id) }, softDeleteSet());
  }

  async validate(input: SkillInput | Record<string, unknown>): Promise<{ valid: boolean; errors: string[]; warnings: string[] }> {
    const errors: string[] = [];
    const warnings: string[] = [];
    try {
      const doc = normalizedSkill(input as SkillInput);
      await this.validateDoc(doc, errors, warnings);
    } catch (err) {
      errors.push((err as Error).message);
    }
    return { valid: errors.length === 0, errors, warnings };
  }

  async search(input: SkillSearchInput): Promise<Record<string, unknown>> {
    const limit = Math.min(Math.max(Number(input.limit ?? 5), 1), 20);
    const filter = input.includeDisabled
      ? notDeletedFilter
      : { enabled: { $ne: false }, ...notDeletedFilter };
    const docs = await this.col.find(filter).toArray();
    const queryParts = [
      input.query ?? '',
      typeof input.context?.intent === 'string' ? input.context.intent : '',
      typeof input.context?.repo === 'string' ? input.context.repo : '',
      typeof input.context?.currentPage === 'string' ? input.context.currentPage : '',
    ].filter(Boolean);
    const query = queryParts.join(' ');

    const matches = docs
      .map(skill => {
        const { score, matched } = scoreSkill(skill, query);
        const isFallback = String(skill.name ?? '') === 'capability-routing';
        const fallbackScore = isFallback && query.trim() ? Math.max(score, Number(skill.priority ?? 50) / 20) : score;
        return {
          id: (skill._id as ObjectId).toString(),
          name: skill.name,
          displayName: skill.displayName,
          description: skill.description,
          category: skill.category,
          triggers: skill.triggers ?? [],
          excludes: skill.excludes ?? [],
          priority: skill.priority ?? 0,
          enabled: skill.enabled !== false,
          allowedRoutes: skill.allowedRoutes ?? [],
          relatedWorkflows: skill.relatedWorkflows ?? [],
          relatedAgents: skill.relatedAgents ?? [],
          score: fallbackScore,
          confidence: Math.max(0, Math.min(1, fallbackScore / 100)),
          matched,
        };
      })
      .filter(match => match.score > 0 && (!query.trim() || match.matched.length > 0 || match.name === 'capability-routing'))
      .sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)))
      .slice(0, limit);

    return { query, matches };
  }

  private async validateDoc(doc: Record<string, unknown>, errors: string[] = [], warnings: string[] = []): Promise<void> {
    const name = String(doc.name ?? '');
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      errors.push('Skill name must be a lowercase slug');
    }
    const routes = normalizeRoutes(doc.allowedRoutes);
    if (routes.length === 0) errors.push('At least one allowed route is required');

    const body = String(doc.body ?? '').toLowerCase();
    for (const section of REQUIRED_BODY_SECTIONS) {
      if (!body.includes(section)) warnings.push(`Body should include a "${section}" section`);
    }

    const workflows = asStringArray(doc.relatedWorkflows);
    if (workflows.length > 0) {
      const count = await this.db.collection('workflows').countDocuments({ name: { $in: workflows }, ...notDeletedFilter });
      if (count < workflows.length) warnings.push('Some related workflows do not exist yet');
    }

    const agents = asStringArray(doc.relatedAgents);
    if (agents.length > 0) {
      const count = await this.db.collection('agents').countDocuments({ name: { $in: agents }, ...notDeletedFilter });
      if (count < agents.length) warnings.push('Some related agents do not exist yet');
    }

    if (errors.length > 0) throw new Error(errors.join('; '));
  }
}
