// Tests for CuratedContextEditorService — applyEdit, getHistory, revert
// Uses MongoMemoryServer for in-memory MongoDB isolation.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { CuratedContextEditorService } from '../../../services/context/judge/curated-context-editor.service.js';

let mongo: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let service: CuratedContextEditorService;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = new MongoClient(mongo.getUri());
  await client.connect();
  db = client.db('test-curated-editor');
  service = new CuratedContextEditorService(db);
});

afterAll(async () => {
  await client.close();
  await mongo.stop();
});

beforeEach(async () => {
  await db.collection('repo_context_curation_entries').deleteMany({});
  await db.collection('repo_context_curation_entry_revisions').deleteMany({});
});

const REPO_ID = 'repo-test-001';
const ENTRY_ID = 'entry-test-001';
const baseMeta = { actor: 'test-user', source: 'manual_edit' as const };

// ─── applyEdit ────────────────────────────────────────────────────────────────

describe('applyEdit', () => {
  it('creates a revision with before=null for a new entry', async () => {
    const { revision } = await service.applyEdit(REPO_ID, ENTRY_ID, { title: 'My Title' }, baseMeta);
    expect(revision.before).toBeNull();
    expect(revision.after).toBeDefined();
  });

  it('creates a revision with before=prior state for an existing entry', async () => {
    // First edit
    await service.applyEdit(REPO_ID, ENTRY_ID, { title: 'First Title' }, baseMeta);
    // Second edit — before should be the result of first
    const { revision } = await service.applyEdit(REPO_ID, ENTRY_ID, { title: 'Second Title' }, baseMeta);
    expect(revision.before).not.toBeNull();
    expect((revision.before as any)['title']).toBe('First Title');
  });

  it('after state reflects applied patch', async () => {
    const { entry } = await service.applyEdit(
      REPO_ID,
      ENTRY_ID,
      { title: 'Test Title', category: 'test-cat' },
      baseMeta,
    );
    expect(entry['title']).toBe('Test Title');
    expect(entry['category']).toBe('test-cat');
  });

  it('revision has actor and source from meta', async () => {
    const { revision } = await service.applyEdit(
      REPO_ID,
      ENTRY_ID,
      { title: 'Actor Test' },
      { actor: 'actor-xyz', source: 'remediation' },
    );
    expect(revision.actor).toBe('actor-xyz');
    expect(revision.source).toBe('remediation');
  });

  it('revision has revisionId (UUID)', async () => {
    const { revision } = await service.applyEdit(REPO_ID, ENTRY_ID, { title: 'UUID Test' }, baseMeta);
    expect(revision.revisionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('editVersion increments on each applyEdit', async () => {
    const { entry: e1 } = await service.applyEdit(REPO_ID, ENTRY_ID, { title: 'V1' }, baseMeta);
    const { entry: e2 } = await service.applyEdit(REPO_ID, ENTRY_ID, { title: 'V2' }, baseMeta);
    expect((e2['editVersion'] as number)).toBeGreaterThan((e1['editVersion'] as number));
  });

  it('diff contains changed fields', async () => {
    const { revision } = await service.applyEdit(REPO_ID, ENTRY_ID, { title: 'Diff Test' }, baseMeta);
    expect(revision.diff).toBeDefined();
    expect((revision.diff as any)['title']).toBeDefined();
  });

  it('applies structured metadata patches without converting them to chunk text', async () => {
    const { entry } = await service.applyEdit(
      REPO_ID,
      ENTRY_ID,
      {
        title: 'Policy entry',
        injectionPolicy: 'manifest_only',
        demoteWhen: ['exact files are present'],
        requirePositiveSignals: ['explicit docs intent'],
        budgetPolicy: 'Do not consume focused implementation budget.',
      },
      baseMeta,
    );

    expect(entry['injectionPolicy']).toBe('manifest_only');
    expect(entry['demoteWhen']).toEqual(['exact files are present']);
    expect(entry['requirePositiveSignals']).toEqual(['explicit docs intent']);
    expect(entry['budgetPolicy']).toContain('focused implementation');
    expect(entry['chunks']).toBeUndefined();
  });

  it('creates a new active version and marks the prior version inactive', async () => {
    const { entry: first } = await service.applyEdit(REPO_ID, ENTRY_ID, { title: 'V1' }, baseMeta);
    const { entry: second } = await service.applyEdit(REPO_ID, ENTRY_ID, { title: 'V2' }, baseMeta);

    expect(first['entryVersionId']).toBeDefined();
    expect(second['entryVersionId']).toBeDefined();
    expect(second['entryVersionId']).not.toBe(first['entryVersionId']);

    const rows = await db.collection('repo_context_curation_entries').find({ repoId: REPO_ID, entryId: ENTRY_ID }).toArray();
    expect(rows.filter((row) => row['active'] === true)).toHaveLength(1);
    expect(rows.filter((row) => row['active'] === false)).toHaveLength(1);

    const current = await service.getEntry(REPO_ID, ENTRY_ID);
    expect(current?.['title']).toBe('V2');
  });

  it('optional meta fields are stored in revision', async () => {
    const { revision } = await service.applyEdit(
      REPO_ID,
      ENTRY_ID,
      { title: 'Meta Test' },
      { actor: 'actor-1', source: 'remediation', reviewTaskId: 'task-123', remediationId: 'rem-456', learningId: 'learn-789' },
    );
    expect(revision.reviewTaskId).toBe('task-123');
    expect(revision.remediationId).toBe('rem-456');
    expect(revision.learningId).toBe('learn-789');
  });
});

// ─── getHistory ───────────────────────────────────────────────────────────────

describe('getHistory', () => {
  it('returns revisions newest first', async () => {
    await service.applyEdit(REPO_ID, ENTRY_ID, { title: 'V1' }, baseMeta);
    await new Promise((r) => setTimeout(r, 5));
    await service.applyEdit(REPO_ID, ENTRY_ID, { title: 'V2' }, baseMeta);
    await new Promise((r) => setTimeout(r, 5));
    await service.applyEdit(REPO_ID, ENTRY_ID, { title: 'V3' }, baseMeta);

    const history = await service.getHistory(REPO_ID, ENTRY_ID);
    expect(history.length).toBe(3);
    // Newest first
    expect((history[0].after as any)['title']).toBe('V3');
    expect((history[2].after as any)['title']).toBe('V1');
  });

  it('returns empty array for unknown entry', async () => {
    const history = await service.getHistory('unknown-repo', 'unknown-entry');
    expect(history).toEqual([]);
  });

  it('respects limit parameter', async () => {
    await service.applyEdit(REPO_ID, ENTRY_ID, { title: 'V1' }, baseMeta);
    await service.applyEdit(REPO_ID, ENTRY_ID, { title: 'V2' }, baseMeta);
    await service.applyEdit(REPO_ID, ENTRY_ID, { title: 'V3' }, baseMeta);

    const history = await service.getHistory(REPO_ID, ENTRY_ID, 2);
    expect(history.length).toBe(2);
  });
});

// ─── revert ───────────────────────────────────────────────────────────────────

describe('revert', () => {
  it('creates a new revision using the target revision\'s after state', async () => {
    const { revision: rev1 } = await service.applyEdit(REPO_ID, ENTRY_ID, { title: 'Original' }, baseMeta);
    await service.applyEdit(REPO_ID, ENTRY_ID, { title: 'Updated' }, baseMeta);

    // Revert to rev1 (original state)
    const { revision: revertRevision, entry } = await service.revert(REPO_ID, ENTRY_ID, rev1.revisionId, { actor: 'reverter' });

    // The entry should now have the original title
    expect(entry['title']).toBe('Original');
    // A new revision should have been created
    expect(revertRevision.revisionId).not.toBe(rev1.revisionId);
  });

  it('throws for unknown revisionId', async () => {
    await expect(
      service.revert(REPO_ID, ENTRY_ID, '00000000-0000-0000-0000-000000000000', { actor: 'test' }),
    ).rejects.toThrow();
  });

  it('revert adds to history', async () => {
    await service.applyEdit(REPO_ID, ENTRY_ID, { title: 'V1' }, baseMeta);
    const { revision: rev2 } = await service.applyEdit(REPO_ID, ENTRY_ID, { title: 'V2' }, baseMeta);

    await service.revert(REPO_ID, ENTRY_ID, rev2.revisionId, { actor: 'user' });

    const history = await service.getHistory(REPO_ID, ENTRY_ID);
    // 2 original + 1 revert = 3 revisions
    expect(history.length).toBe(3);
  });
});
