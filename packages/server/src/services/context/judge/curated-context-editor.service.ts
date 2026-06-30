import { randomUUID } from 'node:crypto';
import type { Db, Collection, ObjectId } from 'mongodb';

export type CuratedContextPatch = {
  [key: string]: unknown;
  chunks?: unknown[];
  curatedContext?: string;
  retrievalText?: string;
  path?: string;
  title?: string;
  category?: string;
  description?: string;
  summary?: string;
  inclusion?: string;
  injectionPolicy?: string;
  authority?: string;
  freshness?: string;
  memoryType?: string;
  appliesToAgents?: string[];
  appliesToGlobs?: string[];
  appliesToTaskKinds?: string[];
  positiveTaskHints?: string[];
  negativeTaskHints?: string[];
  demoteWhen?: string[];
  requirePositiveSignals?: string[];
  budgetPolicy?: string;
};

export interface CurationRevision {
  revisionId: string;
  repoId: string;
  entryId: string;
  beforeEntryVersionId?: string;
  afterEntryVersionId?: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  diff: Record<string, unknown> | null;
  source: string;
  actor: string;
  reviewTaskId?: string;
  remediationId?: string;
  learningId?: string;
  createdAt: Date;
}

export class CuratedContextEditorService {
  private entriesCollection: Collection<Record<string, unknown>>;
  private revisionsCollection: Collection<CurationRevision>;

  constructor(private db: Db) {
    this.entriesCollection = db.collection('repo_context_curation_entries');
    this.revisionsCollection = db.collection<CurationRevision>('repo_context_curation_entry_revisions');
  }

  async getEntry(repoId: string, entryId: string): Promise<Record<string, unknown> | null> {
    const doc = await this.findCurrentEntry(repoId, entryId);
    if (!doc) return null;
    // Remove MongoDB _id from returned object
    const { _id: _unused, ...rest } = doc as Record<string, unknown>;
    return rest;
  }

  async applyEdit(
    repoId: string,
    entryId: string,
    patch: CuratedContextPatch,
    meta: {
      actor: string;
      source: string;
      reviewTaskId?: string;
      remediationId?: string;
      learningId?: string;
      action?: 'create' | 'update' | 'archive';
      expectedEntryVersionId?: string;
    },
  ): Promise<{ revision: CurationRevision; entry: Record<string, unknown> }> {
    return this.writeEntry(repoId, entryId, patch, meta, { mergePriorFields: true });
  }

  async replaceFromCurator(
    repoId: string,
    entryId: string,
    entry: Record<string, unknown>,
    meta: {
      actor: string;
      source: string;
      reviewTaskId?: string;
      remediationId?: string;
      learningId?: string;
      expectedEntryVersionId?: string;
    },
  ): Promise<{ revision: CurationRevision; entry: Record<string, unknown> }> {
    return this.writeEntry(
      repoId,
      entryId,
      {
        ...entry,
        source: 'repo_context_curator',
        manualOverride: false,
      },
      { ...meta, action: 'update' },
      { mergePriorFields: false },
    );
  }

  private async writeEntry(
    repoId: string,
    entryId: string,
    patch: CuratedContextPatch,
    meta: {
      actor: string;
      source: string;
      reviewTaskId?: string;
      remediationId?: string;
      learningId?: string;
      action?: 'create' | 'update' | 'archive';
      expectedEntryVersionId?: string;
    },
    options: { mergePriorFields: boolean },
  ): Promise<{ revision: CurationRevision; entry: Record<string, unknown> }> {
    const now = new Date();
    const existing = await this.findCurrentEntry(repoId, entryId);

    let before: Record<string, unknown> | null = null;
    let existingObjectId: ObjectId | undefined;

    if (existing) {
      const { _id: _unused, ...existingRest } = existing as Record<string, unknown>;
      if (
        meta.expectedEntryVersionId &&
        existingRest['entryVersionId'] &&
        meta.expectedEntryVersionId !== existingRest['entryVersionId']
      ) {
        throw new Error(`Curated entry version conflict: expected ${meta.expectedEntryVersionId}, found ${String(existingRest['entryVersionId'])}`);
      }
      before = existingRest;
      existingObjectId = existing['_id'] as ObjectId | undefined;
    }

    const revisionId = randomUUID();
    const nextEntryVersionId = randomUUID();
    const updateFields: Record<string, unknown> = {
      ...(options.mergePriorFields ? before ?? {} : {}),
      repoId,
      entryId,
      entryVersionId: nextEntryVersionId,
      active: meta.action === 'archive' ? false : true,
      validFrom: now,
      validTo: meta.action === 'archive' ? now : null,
      supersededAt: null,
      supersededByVersionId: null,
      archivedAt: meta.action === 'archive' ? now : null,
      lastEditedBy: meta.actor,
      lastEditedAt: now,
      updatedAt: now,
      createdAt: before?.['createdAt'] ?? now,
      createdByRevisionId: revisionId,
    };
    delete updateFields['_id'];
    for (const [key, value] of Object.entries(sanitizeCuratedPatch(patch))) {
      if (value !== undefined) updateFields[key] = value;
    }

    let after: Record<string, unknown>;
    if (meta.action === 'archive') {
      if (!existingObjectId) throw new Error(`Cannot archive missing curated entry: ${entryId}`);
      const archivePatch = {
        active: false,
        validTo: now,
        supersededAt: now,
        supersededByVersionId: null,
        archivedAt: now,
        lastEditedBy: meta.actor,
        lastEditedAt: now,
        updatedAt: now,
      };
      await this.entriesCollection.updateOne({ _id: existingObjectId }, { $set: archivePatch });
      after = { ...(before ?? {}), ...archivePatch };
      await this.markContextDatasetStale(repoId, entryId, undefined, revisionId);
    } else {
      if (existingObjectId) {
        await this.entriesCollection.updateOne(
          { _id: existingObjectId },
          {
            $set: {
              active: false,
              validTo: now,
              supersededAt: now,
              supersededByVersionId: nextEntryVersionId,
              updatedAt: now,
            },
          },
        );
      }
      await this.entriesCollection.insertOne(updateFields);
      const afterDoc = await this.entriesCollection.findOne({ repoId, entryId, entryVersionId: nextEntryVersionId });
      const { _id: _unusedAfter, ...afterRest } = (afterDoc ?? updateFields) as Record<string, unknown>;
      after = afterRest;
      await this.markContextDatasetStale(repoId, entryId, nextEntryVersionId, revisionId);
    }

    // Compute simple diff (keys that changed)
    const diff: Record<string, unknown> = {};
    for (const key of Object.keys({ ...sanitizeCuratedPatch(patch), active: updateFields['active'] })) {
      diff[key] = { before: before?.[key], after: after[key] };
    }

    const revision: CurationRevision = {
      revisionId,
      repoId,
      entryId,
      beforeEntryVersionId: before?.['entryVersionId'] as string | undefined,
      afterEntryVersionId: after['entryVersionId'] as string | undefined,
      before,
      after,
      diff,
      source: meta.source,
      actor: meta.actor,
      reviewTaskId: meta.reviewTaskId,
      remediationId: meta.remediationId,
      learningId: meta.learningId,
      createdAt: now,
    };

    await this.revisionsCollection.insertOne(revision as any);
    return { revision, entry: after };
  }

  async getHistory(repoId: string, entryId: string, limit = 50): Promise<CurationRevision[]> {
    return this.revisionsCollection
      .find({ repoId, entryId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray() as Promise<CurationRevision[]>;
  }

  async archiveMany(
    repoId: string,
    entryIds: string[],
    meta: { actor: string; source: string },
  ): Promise<{ requested: number; affected: number; skipped: number; items: Array<{ entryId: string; status: 'archived' | 'skipped'; reason?: string }> }> {
    const results: Array<{ entryId: string; status: 'archived' | 'skipped'; reason?: string }> = [];
    for (const entryId of entryIds) {
      try {
        const existing = await this.getEntry(repoId, entryId);
        if (!existing) {
          results.push({ entryId, status: 'skipped', reason: 'not_found' });
          continue;
        }
        if (existing.active === false) {
          results.push({ entryId, status: 'skipped', reason: 'already_archived' });
          continue;
        }
        await this.applyEdit(
          repoId,
          entryId,
          {},
          { actor: meta.actor, source: meta.source, action: 'archive' },
        );
        results.push({ entryId, status: 'archived' });
      } catch (err: unknown) {
        results.push({ entryId, status: 'skipped', reason: (err as Error).message });
      }
    }
    const affected = results.filter((r) => r.status === 'archived').length;
    const skipped = results.filter((r) => r.status === 'skipped').length;
    return { requested: entryIds.length, affected, skipped, items: results };
  }

  async revert(
    repoId: string,
    entryId: string,
    revisionId: string,
    meta: { actor: string },
  ): Promise<{ revision: CurationRevision; entry: Record<string, unknown> }> {
    const targetRevision = await this.revisionsCollection.findOne({ revisionId });
    if (!targetRevision) {
      throw new Error(`Revision not found: ${revisionId}`);
    }

    // Revert to the 'after' state of the target revision
    const revertTarget = targetRevision.after;

    return this.applyEdit(
      repoId,
      entryId,
      {
        chunks: revertTarget['chunks'] as unknown[] | undefined,
        curatedContext: revertTarget['curatedContext'] as string | undefined,
        retrievalText: revertTarget['retrievalText'] as string | undefined,
        summary: revertTarget['summary'] as string | undefined,
        title: revertTarget['title'] as string | undefined,
        category: revertTarget['category'] as string | undefined,
        description: revertTarget['description'] as string | undefined,
        inclusion: revertTarget['inclusion'] as string | undefined,
        injectionPolicy: revertTarget['injectionPolicy'] as string | undefined,
        authority: revertTarget['authority'] as string | undefined,
        freshness: revertTarget['freshness'] as string | undefined,
        memoryType: revertTarget['memoryType'] as string | undefined,
        appliesToAgents: revertTarget['appliesToAgents'] as string[] | undefined,
        appliesToGlobs: revertTarget['appliesToGlobs'] as string[] | undefined,
        appliesToTaskKinds: revertTarget['appliesToTaskKinds'] as string[] | undefined,
        positiveTaskHints: revertTarget['positiveTaskHints'] as string[] | undefined,
        negativeTaskHints: revertTarget['negativeTaskHints'] as string[] | undefined,
        demoteWhen: revertTarget['demoteWhen'] as string[] | undefined,
        requirePositiveSignals: revertTarget['requirePositiveSignals'] as string[] | undefined,
        budgetPolicy: revertTarget['budgetPolicy'] as string | undefined,
      },
      {
        actor: meta.actor,
        source: 'manual_edit',
        reviewTaskId: undefined,
        remediationId: undefined,
        learningId: undefined,
      },
    );
  }

  private async findCurrentEntry(repoId: string, entryId: string): Promise<Record<string, unknown> | null> {
    const active = await this.entriesCollection.findOne({ repoId, entryId, active: true }, { sort: { updatedAt: -1, createdAt: -1, entryVersionId: -1 } });
    if (active) return active;
    return this.entriesCollection.findOne(
      {
        repoId,
        entryId,
        active: { $exists: false },
      },
      { sort: { updatedAt: -1, createdAt: -1, entryVersionId: -1 } },
    );
  }

  private async markContextDatasetStale(repoId: string, entryId: string, entryVersionId: string | undefined, revisionId: string): Promise<void> {
    const now = new Date();
    await this.db.collection('repo_cognee_datasets').updateOne(
      { repoId },
      {
        $set: {
          curatedContextStale: true,
          staleReason: 'curation_entry_changed',
          updatedAt: now,
        },
        $push: {
          diagnostics: {
            code: 'curated_context_stale',
            severity: 'info',
            entryId,
            entryVersionId,
            revisionId,
            message: 'Curated context changed and needs context rebuild/update.',
          },
        },
      } as never,
    ).catch(() => {});
  }
}

const EDITOR_OWNED_FIELDS = new Set([
  '_id',
  'repoId',
  'entryId',
  'entryVersionId',
  'active',
  'validFrom',
  'validTo',
  'supersededAt',
  'supersededByVersionId',
  'archivedAt',
  'createdAt',
  'updatedAt',
  'lastEditedAt',
  'lastEditedBy',
  'createdByRevisionId',
  'version',
  'editVersion',
]);

function sanitizeCuratedPatch(patch: CuratedContextPatch): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (EDITOR_OWNED_FIELDS.has(key)) continue;
    sanitized[key] = value;
  }
  return sanitized;
}
