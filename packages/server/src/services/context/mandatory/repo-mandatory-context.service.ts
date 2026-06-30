import type { Collection, Db } from 'mongodb';
import { ObjectId } from 'mongodb';
import { sha256, stringValue } from '../common/context-utils.js';
import { notDeletedFilter } from '../../soft-delete.js';

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
  // Audit fields for deactivation — optional, added by replaceForRun
  deactivatedAt?: Date;
  deactivatedByRunId?: string;
  deactivationReason?: string;
  // Fix C: tracks which standalone-path setup run staged this row (new rows only)
  stagedBySetupRunId?: string;
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

  async list(repoId: string, options: { agentName?: string; enabled?: boolean | 'all' } = {}): Promise<RepoMandatoryContextMapping[]> {
    const query: Record<string, unknown> = { repoId };
    if (options.agentName) query.agentName = options.agentName;
    if (options.enabled === true) {
      query.enabled = true;
    } else if (options.enabled === false) {
      query.enabled = false;
    }
    // options.enabled === 'all' or undefined → no filter
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

  async replaceForRun(repoId: string, body: {
    setupRunId: string;
    affectedAgentNames: string[];
    mappings: Array<{
      agentName: string;
      sourcePath?: string;
      sourceHash?: string;
      title: string;
      content: string;
      reasoning?: string;
    }>;
  }): Promise<{ saved: number; deactivated: number }> {
    const { setupRunId, affectedAgentNames, mappings } = body;
    const now = new Date();

    // Validate: all agentNames in mappings and affectedAgentNames must exist
    // Dev adaptation: exclude soft-deleted agents so a deleted agent doesn't pass validation
    // NOTE: the proposals route re-validates the same constraints — intentional defense-in-depth, not accidental duplication.
    const allAgentNames = new Set([
      ...affectedAgentNames,
      ...mappings.map((m) => m.agentName),
    ]);
    for (const name of allAgentNames) {
      const exists = await this.agents.findOne({ name, ...notDeletedFilter });
      if (!exists) {
        const err = new Error(`Agent '${name}' not found in agents collection`);
        (err as Error & { code?: string }).code = 'INVALID_AGENT_NAME';
        throw err;
      }
    }

    // Validate: affectedAgentNames ⊇ unique(mappings[].agentName)
    const mappingAgentNames = new Set(mappings.map((m) => m.agentName));
    for (const name of mappingAgentNames) {
      if (!affectedAgentNames.includes(name)) {
        const err = new Error(`Agent '${name}' appears in mappings but is not in affectedAgentNames`);
        (err as Error & { code?: string }).code = 'AGENT_NOT_AFFECTED';
        throw err;
      }
    }

    const repo = await this.repos.findOne({ _id: new ObjectId(repoId) });

    // Try transactional path
    let saved = 0;
    let deactivated = 0;

    let useTransaction = false;
    try {
      const adminDb = this.db.admin();
      const isMaster = await adminDb.command({ isMaster: 1 }).catch(() => ({ ismaster: false, setName: null }));
      useTransaction = Boolean((isMaster as Record<string, unknown>).setName);
    } catch {
      useTransaction = false;
    }

    if (useTransaction) {
      const session = this.db.client.startSession();
      try {
        await session.withTransaction(async () => {
          const newIds: string[] = [];
          for (const raw of mappings) {
            const result = await this.upsertInSession(repoId, { ...raw, enabled: true, setupRunId }, repo, session);
            newIds.push(result.mappingId);
            saved++;
          }
          // Deactivate old mappings for reviewed agents (no sourceType clause — AC-009)
          for (const agentName of affectedAgentNames) {
            const res = await this.mappings.updateMany(
              { repoId, agentName, enabled: true, ...(newIds.length ? { mappingId: { $nin: newIds } } : {}) },
              { $set: this.buildDeactivationUpdate(setupRunId, agentName, mappings, now) },
              { session },
            );
            deactivated += res.modifiedCount;
          }
        });
      } finally {
        await session.endSession();
      }
    } else {
      // Fix C: Standalone fallback — never downgrade an existing enabled:true row
      //
      // Step 1: upsert proposed rows — enabled:false only in $setOnInsert so existing
      // enabled:true rows are never touched. Track this run's newly staged rows via
      // stagedBySetupRunId so we can delete only them on cleanup.
      const insertedIds: string[] = [];
      for (const raw of mappings) {
        const contentHash = sha256(raw.content);
        const mappingId = stableMappingId(repoId, raw.agentName, raw.sourcePath, raw.sourceHash, contentHash);
        const agent = await this.agents.findOne({ name: raw.agentName });
        const now2 = new Date();
        // $setOnInsert: fields for brand-new rows only (enabled:false, createdAt, stagedBySetupRunId)
        // $set: non-enabled fields always updated so content stays fresh on re-propose
        await this.mappings.updateOne(
          { mappingId },
          {
            $set: {
              repoId,
              repoName: stringValue(repo?.name as unknown),
              agentId: agent?._id ? String(agent._id) : undefined,
              agentName: raw.agentName,
              agentDisplayName: stringValue(agent?.displayName as unknown),
              agentTeamName: stringValue(agent?.teamName as unknown),
              agentType: stringValue(agent?.type as unknown),
              sourcePath: raw.sourcePath,
              sourceHash: raw.sourceHash,
              title: raw.title,
              content: raw.content,
              contentHash,
              sourceType: 'agent_generated' as const,
              reasoning: raw.reasoning,
              lastValidatedAt: now2,
              updatedAt: now2,
            },
            $setOnInsert: {
              enabled: false,
              createdAt: now2,
              stagedBySetupRunId: setupRunId,
            },
          },
          { upsert: true },
        );
        insertedIds.push(mappingId);
      }

      // BulkWrite: flip new/existing rows to enabled (only when not already enabled),
      // then deactivate old rows for the affected agents.
      const ops: Array<Record<string, unknown>> = [];
      for (const mappingId of insertedIds) {
        ops.push({
          updateOne: {
            // Only flip rows that are not already enabled (no-op for identical re-proposed rows)
            filter: { mappingId, enabled: { $ne: true } },
            update: { $set: { enabled: true, updatedAt: now } },
          },
        });
      }

      // Count only the deactivation ops' modifiedCount for accurate 'deactivated' total
      let deactivationModifiedCount = 0;
      const deactivationOpsStart = ops.length;
      for (const agentName of affectedAgentNames) {
        const deactivateFilter: Record<string, unknown> = {
          repoId,
          agentName,
          enabled: true,
        };
        if (insertedIds.length > 0) {
          deactivateFilter.mappingId = { $nin: insertedIds };
        }
        ops.push({
          updateMany: {
            filter: deactivateFilter,
            update: { $set: this.buildDeactivationUpdate(setupRunId, agentName, mappings, now) },
          },
        });
      }

      if (ops.length > 0) {
        try {
          const bulkResult = await this.mappings.bulkWrite(ops as never[]);
          saved = insertedIds.length;
          // Fix C: compute deactivated from deactivation ops' modifiedCount only
          // (flip ops are no-ops for already-enabled rows and must not inflate the count)
          const deactivationOps = ops.slice(deactivationOpsStart);
          deactivationModifiedCount = deactivationOps.length > 0
            ? (bulkResult.modifiedCount - Math.min(insertedIds.length, bulkResult.modifiedCount))
            : 0;
          // Fallback: just use bulkResult.upsertedCount to not double-count
          // Use nModified from deactivation ops portion: total modified - flip ops modified
          // Since flip ops only touch rows where enabled!=true, count them separately
          deactivated = deactivationModifiedCount >= 0 ? deactivationModifiedCount : 0;
        } catch (bulkErr) {
          // Fix C: compensating cleanup — DELETE only this run's newly staged disabled rows.
          // Pre-existing enabled:true rows were never touched (enabled is $setOnInsert only),
          // so deleting stagedBySetupRunId rows restores the true pre-run state.
          if (insertedIds.length > 0) {
            await this.mappings.deleteMany(
              { mappingId: { $in: insertedIds }, enabled: false, stagedBySetupRunId: setupRunId },
            ).catch(() => {});
          }
          throw bulkErr;
        }
      } else {
        saved = 0;
        deactivated = 0;
      }
    }

    return { saved, deactivated };
  }

  /** C2: shared deactivation $set used by both the transactional path and the standalone fallback. */
  private buildDeactivationUpdate(
    setupRunId: string,
    agentName: string,
    mappings: Array<{ agentName: string }>,
    now: Date,
  ): Partial<RepoMandatoryContextMapping> {
    return {
      enabled: false,
      deactivatedAt: now,
      deactivatedByRunId: setupRunId,
      deactivationReason: mappings.some((m) => m.agentName === agentName) ? 'replaced' : 'reviewed_empty',
      updatedAt: now,
    };
  }

  private async upsertInSession(
    repoId: string,
    raw: Record<string, unknown>,
    repo: Record<string, unknown> | null,
    session: import('mongodb').ClientSession,
  ): Promise<RepoMandatoryContextMapping> {
    const agentName = stringValue(raw.agentName as unknown ?? raw.agent_name);
    if (!agentName) throw new Error('agentName is required');
    const content = stringValue(raw.content as unknown);
    if (!content) throw new Error('content is required');
    const agent = await this.agents.findOne({ name: agentName }, { session } as never);
    const now = new Date();
    const sourcePath = stringValue(raw.sourcePath as unknown ?? raw.source_path);
    const sourceHash = stringValue(raw.sourceHash as unknown ?? raw.source_hash);
    const contentHash = sha256(content);
    const mappingId = stringValue(raw.mappingId as unknown ?? raw.mapping_id)
      ?? stableMappingId(repoId, agentName, sourcePath, sourceHash, contentHash);
    const next: RepoMandatoryContextMapping = {
      mappingId,
      repoId,
      repoName: stringValue(repo?.name as unknown),
      agentId: agent?._id ? String(agent._id) : stringValue(raw.agentId as unknown ?? raw.agent_id),
      agentName,
      agentDisplayName: stringValue(agent?.displayName as unknown ?? raw.agentDisplayName ?? raw.agent_display_name),
      agentTeamName: stringValue(agent?.teamName as unknown ?? raw.agentTeamName ?? raw.agent_team_name),
      agentType: stringValue(agent?.type as unknown ?? raw.agentType ?? raw.agent_type),
      sourcePath,
      sourceHash,
      title: stringValue(raw.title as unknown) ?? sourcePath ?? agentName,
      content,
      contentHash,
      enabled: raw.enabled === false ? false : true,
      sourceType: 'agent_generated',
      reasoning: stringValue(raw.reasoning as unknown),
      createdAt: now,
      updatedAt: now,
      lastValidatedAt: now,
    };
    const { createdAt: _createdAt, ...setFields } = next;
    await this.mappings.updateOne(
      { mappingId },
      { $set: setFields, $setOnInsert: { createdAt: now } },
      { upsert: true, session } as never,
    );
    return (await this.mappings.findOne({ mappingId }, { session } as never))!;
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

  async deactivateMany(
    repoId: string,
    mappingIds: string[],
    options: { reason?: string } = {},
  ): Promise<{ requested: number; affected: number; skipped: number }> {
    if (!mappingIds.length) return { requested: 0, affected: 0, skipped: 0 };
    const now = new Date();
    const result = await this.mappings.updateMany(
      { repoId, mappingId: { $in: mappingIds }, enabled: true },
      {
        $set: {
          enabled: false,
          deactivatedAt: now,
          deactivationReason: options.reason ?? 'user_bulk_delete',
          updatedAt: now,
        },
      },
    );
    const affected = result.modifiedCount;
    const skipped = mappingIds.length - affected;
    return { requested: mappingIds.length, affected, skipped };
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

function normalizeSourceType(value: unknown): MandatoryContextSourceType {
  return value === 'user_added' || value === 'user_override' || value === 'agent_generated'
    ? value
    : 'user_added';
}
