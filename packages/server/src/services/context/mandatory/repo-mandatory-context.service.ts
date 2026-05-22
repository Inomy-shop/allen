import { createHash, randomUUID } from 'node:crypto';
import type { Collection, Db } from 'mongodb';
import { ObjectId } from 'mongodb';

export type MandatoryContextSourceType = 'agent_generated' | 'user_added' | 'user_override';

export type RepoMandatoryContextMapping = {
  mappingId: string;
  repoId: string;
  repoName?: string;
  agentId?: string;
  agentName: string;
  agentDisplayName?: string;
  agentTeamName?: string;
  agentType?: string;
  sourcePath?: string;
  sourceHash?: string;
  title: string;
  content: string;
  contentHash: string;
  enabled: boolean;
  sourceType: MandatoryContextSourceType;
  reasoning?: string;
  createdAt: Date;
  updatedAt: Date;
  lastValidatedAt?: Date;
};

export class RepoMandatoryContextService {
  private mappings: Collection<RepoMandatoryContextMapping>;
  private repos: Collection;
  private agents: Collection;

  constructor(private readonly db: Db) {
    this.mappings = db.collection<RepoMandatoryContextMapping>('repo_mandatory_context_mappings');
    this.repos = db.collection('repos');
    this.agents = db.collection('agents');
  }

  async list(repoId: string, options: { agentName?: string } = {}): Promise<RepoMandatoryContextMapping[]> {
    const query: Record<string, unknown> = { repoId };
    if (options.agentName) query.agentName = options.agentName;
    return this.mappings.find(query, { sort: { agentName: 1, sourcePath: 1, title: 1, updatedAt: -1 } }).toArray();
  }

  async listAgents(): Promise<Array<Record<string, unknown>>> {
    return this.agents.find(
      {},
      {
        projection: {
          _id: 1,
          name: 1,
          displayName: 1,
          teamName: 1,
          type: 1,
          capabilities: 1,
        },
        sort: { teamName: 1, name: 1 },
      },
    ).toArray();
  }

  async upsert(repoId: string, raw: Record<string, unknown>): Promise<RepoMandatoryContextMapping> {
    const repo = await this.repos.findOne({ _id: new ObjectId(repoId) });
    if (!repo) throw new Error('Repo not found');
    const agentName = stringValue(raw.agentName ?? raw.agent_name);
    if (!agentName) throw new Error('agentName is required');
    const content = stringValue(raw.content);
    if (!content) throw new Error('content is required');
    const agent = await this.agents.findOne({ name: agentName });
    const now = new Date();
    const sourcePath = stringValue(raw.sourcePath ?? raw.source_path);
    const sourceHash = stringValue(raw.sourceHash ?? raw.source_hash);
    const contentHash = sha256(content);
    const sourceType = normalizeSourceType(raw.sourceType ?? raw.source_type);
    const mappingId = stringValue(raw.mappingId ?? raw.mapping_id)
      ?? stableMappingId(repoId, agentName, sourcePath, sourceHash, contentHash);
    const next: RepoMandatoryContextMapping = {
      mappingId,
      repoId,
      repoName: stringValue(repo.name),
      agentId: agent?._id ? String(agent._id) : stringValue(raw.agentId ?? raw.agent_id),
      agentName,
      agentDisplayName: stringValue(agent?.displayName ?? raw.agentDisplayName ?? raw.agent_display_name),
      agentTeamName: stringValue(agent?.teamName ?? raw.agentTeamName ?? raw.agent_team_name),
      agentType: stringValue(agent?.type ?? raw.agentType ?? raw.agent_type),
      sourcePath,
      sourceHash,
      title: stringValue(raw.title) ?? sourcePath ?? agentName,
      content,
      contentHash,
      enabled: raw.enabled === false ? false : true,
      sourceType,
      reasoning: stringValue(raw.reasoning),
      createdAt: now,
      updatedAt: now,
      lastValidatedAt: now,
    };
    const { createdAt: _createdAt, ...setFields } = next;
    await this.mappings.updateOne(
      { mappingId },
      { $set: setFields, $setOnInsert: { createdAt: now } },
      { upsert: true },
    );
    return (await this.mappings.findOne({ mappingId }))!;
  }

  async update(repoId: string, mappingId: string, raw: Record<string, unknown>): Promise<RepoMandatoryContextMapping> {
    const existing = await this.mappings.findOne({ repoId, mappingId });
    if (!existing) throw new Error('Mandatory context mapping not found');
    const updates: Partial<RepoMandatoryContextMapping> = { updatedAt: new Date() };
    if ('title' in raw) updates.title = stringValue(raw.title) ?? existing.title;
    if ('content' in raw) {
      const content = stringValue(raw.content);
      if (!content) throw new Error('content cannot be empty');
      updates.content = content;
      updates.contentHash = sha256(content);
      updates.sourceType = 'user_override';
    }
    if ('enabled' in raw) updates.enabled = raw.enabled === true;
    if ('reasoning' in raw) updates.reasoning = stringValue(raw.reasoning);
    if ('sourcePath' in raw || 'source_path' in raw) updates.sourcePath = stringValue(raw.sourcePath ?? raw.source_path);
    if ('sourceHash' in raw || 'source_hash' in raw) updates.sourceHash = stringValue(raw.sourceHash ?? raw.source_hash);
    await this.mappings.updateOne({ repoId, mappingId }, { $set: updates });
    return (await this.mappings.findOne({ repoId, mappingId }))!;
  }

  async saveManyFromAgent(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const repoId = stringValue(body.repo_id ?? body.repoId);
    if (!repoId) throw new Error('repo_id is required');
    const mappings = Array.isArray(body.mappings) ? body.mappings : [];
    const saved: RepoMandatoryContextMapping[] = [];
    for (const raw of mappings) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      saved.push(await this.upsert(repoId, { ...(raw as Record<string, unknown>), sourceType: (raw as Record<string, unknown>).sourceType ?? 'agent_generated' }));
    }
    return { repo_id: repoId, saved: saved.length, mappings: saved.map((item) => ({ mappingId: item.mappingId, agentName: item.agentName, sourcePath: item.sourcePath, contentHash: item.contentHash })) };
  }
}

function stableMappingId(repoId: string, agentName: string, sourcePath: string | undefined, sourceHash: string | undefined, contentHash: string): string {
  const key = `${repoId}:${agentName}:${sourcePath ?? ''}:${sourceHash ?? ''}:${contentHash}`;
  return `mandatory-${sha256(key).slice(0, 24)}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeSourceType(value: unknown): MandatoryContextSourceType {
  return value === 'user_added' || value === 'user_override' || value === 'agent_generated'
    ? value
    : 'user_added';
}

export function newManualMappingId(): string {
  return `mandatory-${randomUUID()}`;
}
