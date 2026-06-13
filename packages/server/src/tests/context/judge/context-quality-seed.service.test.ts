/**
 * Unit tests for seedContextQuality — the idempotent startup bootstrap.
 * Uses MongoMemoryServer for in-memory MongoDB isolation.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { seedContextQuality } from '../../../services/context/judge/context-quality-seed.service.js';

let mongo: MongoMemoryServer;
let client: MongoClient;
let db: Db;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = new MongoClient(mongo.getUri());
  await client.connect();
  db = client.db('test-context-quality-seed');
});

afterAll(async () => {
  await client.close();
  await mongo.stop();
});

beforeEach(async () => {
  // Clean all relevant collections before each test for isolation
  await db.collection('context_judge_config').deleteMany({});
  await db.collection('context_judge_scheduler_state').deleteMany({});
  await db.collection('learnings').deleteMany({});
  await db.collection('context_evaluations').deleteMany({});
  await db.collection('repo_context_curation_entries').deleteMany({});
  await db.collection('repo_context_curation_entry_revisions').deleteMany({});
  await db.collection('context_review_tasks').deleteMany({});
});

// ─── Singleton Config ────────────────────────────────────────────────────────

describe('seedContextQuality — singleton config', () => {
  it('inserts singleton config on fresh DB', async () => {
    await seedContextQuality(db);

    const config = await db.collection('context_judge_config').findOne({ configId: 'singleton' });
    expect(config).not.toBeNull();
    expect(config!['configId']).toBe('singleton');
    expect(typeof config!['autoRemediationEnabled']).toBe('boolean');
    expect(config!['mandatoryHumanReview']).toBeDefined();
  });

  it('does NOT overwrite existing config values (idempotent)', async () => {
    // Pre-seed a custom config
    await db.collection('context_judge_config').insertOne({
      configId: 'singleton',
      autoRemediationEnabled: true,   // custom value
      updatedAt: new Date(),
    });

    await seedContextQuality(db);

    const config = await db.collection('context_judge_config').findOne({ configId: 'singleton' });
    // $setOnInsert must NOT overwrite the existing custom value
    expect(config!['autoRemediationEnabled']).toBe(true);
  });

  it('only one singleton config exists after running twice', async () => {
    await seedContextQuality(db);
    await seedContextQuality(db);

    const count = await db.collection('context_judge_config').countDocuments({ configId: 'singleton' });
    expect(count).toBe(1);
  });
});

// ─── Scheduler Cursor Rows ───────────────────────────────────────────────────

const EXPECTED_SOURCE_TYPES = [
  'workflow_run',
  'spawned_agent_run',
  'chat_turn',
  'context_usage_trace',
  'deterministic_warning',
  'human_feedback',
  'chat_learning',
  'stale_finding',
] as const;

describe('seedContextQuality — scheduler cursor rows', () => {
  it('creates all 8 scheduler cursor rows on fresh DB', async () => {
    await seedContextQuality(db);

    const rows = await db.collection('context_judge_scheduler_state').find({}).toArray();
    expect(rows).toHaveLength(9);

    const seededTypes = new Set(rows.map((r) => r['sourceType']));
    for (const st of EXPECTED_SOURCE_TYPES) {
      expect(seededTypes.has(st), `sourceType '${st}' must be seeded`).toBe(true);
    }
  });

  it('all seeded cursor rows have status idle', async () => {
    await seedContextQuality(db);

    const rows = await db.collection('context_judge_scheduler_state').find({}).toArray();
    for (const row of rows) {
      expect(row['status']).toBe('idle');
    }
  });

  it('does NOT duplicate scheduler rows when run twice (idempotent)', async () => {
    await seedContextQuality(db);
    await seedContextQuality(db);

    const count = await db.collection('context_judge_scheduler_state').countDocuments();
    expect(count).toBe(9);
  });

  it('does NOT overwrite existing scheduler row custom cursor value', async () => {
    const customCursor = '2025-01-01T00:00:00.000Z';
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'workflow_run',
      status: 'idle',
      cursor: customCursor,
      updatedAt: new Date(),
    });

    await seedContextQuality(db);

    const row = await db.collection('context_judge_scheduler_state').findOne({ sourceType: 'workflow_run' });
    expect(row!['cursor']).toBe(customCursor);
  });
});

// ─── Review Queue Reconciliation ────────────────────────────────────────────

describe('seedContextQuality — review queue reconciliation', () => {
  it('moves stale planning-dispatched auto tasks back to open', async () => {
    await db.collection('context_review_tasks').insertOne({
      taskId: 'task-stale-auto',
      queue: 'dispatched',
      status: 'in_review',
      remediationStatus: 'planning_dispatched',
      requiresHumanReview: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await seedContextQuality(db);

    const task = await db.collection('context_review_tasks').findOne({ taskId: 'task-stale-auto' });
    expect(task!['queue']).toBe('open');
    expect(task!['remediationStatus']).toBe('planning_dispatched');
  });

  it('moves stale planning-dispatched human-gated tasks to needs_review', async () => {
    await db.collection('context_review_tasks').insertOne({
      taskId: 'task-stale-human',
      queue: 'dispatched',
      status: 'in_review',
      remediationStatus: 'planning_dispatched',
      requiresHumanReview: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await seedContextQuality(db);

    const task = await db.collection('context_review_tasks').findOne({ taskId: 'task-stale-human' });
    expect(task!['queue']).toBe('needs_review');
  });
});

// ─── Learnings Backfill ──────────────────────────────────────────────────────

describe('seedContextQuality — learnings backfill', () => {
  it('adds contextEligibility: null to learnings that lack the field', async () => {
    await db.collection('learnings').insertMany([
      { learningId: 'l1', content: 'test' },
      { learningId: 'l2', content: 'test2' },
    ]);

    await seedContextQuality(db);

    const docs = await db.collection('learnings').find({}).toArray();
    for (const doc of docs) {
      expect('contextEligibility' in doc, `${doc['learningId']} must have contextEligibility`).toBe(true);
      expect(doc['contextEligibility']).toBeNull();
    }
  });

  it('does NOT overwrite existing contextEligibility values', async () => {
    await db.collection('learnings').insertOne({
      learningId: 'l-existing',
      content: 'test',
      contextEligibility: 'eligible',
    });

    await seedContextQuality(db);

    const doc = await db.collection('learnings').findOne({ learningId: 'l-existing' });
    expect(doc!['contextEligibility']).toBe('eligible');
  });
});

// ─── Context Evaluations Backfill ────────────────────────────────────────────

describe('seedContextQuality — context_evaluations backfill', () => {
  it('adds semantic.judgeRunId: null to evaluations that lack the field', async () => {
    await db.collection('context_evaluations').insertOne({
      evaluationId: 'eval-1',
      semantic: { status: 'pending' },
    });

    await seedContextQuality(db);

    const doc = await db.collection('context_evaluations').findOne({ evaluationId: 'eval-1' });
    expect(doc!['semantic']['judgeRunId']).toBeNull();
  });

  it('does NOT overwrite existing semantic.judgeRunId', async () => {
    await db.collection('context_evaluations').insertOne({
      evaluationId: 'eval-2',
      semantic: { status: 'done', judgeRunId: 'existing-run-id' },
    });

    await seedContextQuality(db);

    const doc = await db.collection('context_evaluations').findOne({ evaluationId: 'eval-2' });
    expect(doc!['semantic']['judgeRunId']).toBe('existing-run-id');
  });
});

// ─── Curation Entries Backfill ───────────────────────────────────────────────

describe('seedContextQuality — repo_context_curation_entries backfill', () => {
  it('adds entryVersionId/lastEditedBy/lastEditedAt to entries missing these fields', async () => {
    await db.collection('repo_context_curation_entries').insertOne({
      entryId: 'entry-1',
      repoId: 'repo-1',
      chunks: [],
      createdAt: new Date(),
    });

    await seedContextQuality(db);

    const doc = await db.collection('repo_context_curation_entries').findOne({ entryId: 'entry-1' });
    expect(doc!['entryVersionId']).toEqual(expect.any(String));
    expect(doc!['lastEditedBy']).toBeNull();
    expect(doc!['lastEditedAt']).toBeNull();
  });

  it('does NOT overwrite existing edit tracking fields', async () => {
    await db.collection('repo_context_curation_entries').insertOne({
      entryId: 'entry-2',
      repoId: 'repo-1',
      entryVersionId: 'entry-version-existing',
      lastEditedBy: 'user-x',
      lastEditedAt: new Date('2025-01-01'),
    });

    await seedContextQuality(db);

    const doc = await db.collection('repo_context_curation_entries').findOne({ entryId: 'entry-2' });
    expect(doc!['entryVersionId']).toBe('entry-version-existing');
    expect(doc!['lastEditedBy']).toBe('user-x');
  });
});

// ─── Curation Entry Revision Seed ────────────────────────────────────────────

describe('seedContextQuality — initial curation entry revisions', () => {
  it('creates one initial revision per curated entry without any revision', async () => {
    await db.collection('repo_context_curation_entries').insertMany([
      { entryId: 'rev-entry-1', repoId: 'repo-r', chunks: [{ text: 'a' }], createdAt: new Date() },
      { entryId: 'rev-entry-2', repoId: 'repo-r', chunks: [{ text: 'b' }], createdAt: new Date() },
    ]);

    await seedContextQuality(db);

    const revisions = await db.collection('repo_context_curation_entry_revisions').find({}).toArray();
    expect(revisions).toHaveLength(2);

    const entryIds = new Set(revisions.map((r) => r['entryId']));
    expect(entryIds.has('rev-entry-1')).toBe(true);
    expect(entryIds.has('rev-entry-2')).toBe(true);

    for (const rev of revisions) {
      expect(rev['source']).toBe('boot_seed');
      expect(rev['actor']).toBe('system');
      expect(rev['before']).toBeNull();
      expect(rev['revisionId']).toBeDefined();
    }
  });

  it('does NOT create a second revision if one already exists (idempotent)', async () => {
    await db.collection('repo_context_curation_entries').insertOne({
      entryId: 'dup-entry-1', repoId: 'repo-r2', chunks: [], createdAt: new Date(),
    });
    // Pre-seed an existing revision
    await db.collection('repo_context_curation_entry_revisions').insertOne({
      revisionId: 'existing-rev',
      entryId: 'dup-entry-1',
      repoId: 'repo-r2',
      source: 'manual_edit',
      actor: 'user-a',
      before: null,
      after: { chunks: [] },
      diff: null,
      createdAt: new Date(),
    });

    await seedContextQuality(db);

    // Should still be exactly 1 revision for this entry
    const count = await db.collection('repo_context_curation_entry_revisions').countDocuments({ entryId: 'dup-entry-1' });
    expect(count).toBe(1);
  });

  it('running twice does NOT duplicate revision rows', async () => {
    await db.collection('repo_context_curation_entries').insertOne({
      entryId: 'twice-entry-1', repoId: 'repo-r3', chunks: [], createdAt: new Date(),
    });

    await seedContextQuality(db);
    await seedContextQuality(db);

    const count = await db.collection('repo_context_curation_entry_revisions').countDocuments({ entryId: 'twice-entry-1' });
    expect(count).toBe(1);
  });

  it('skips entries without an entryId field', async () => {
    await db.collection('repo_context_curation_entries').insertOne({
      // no entryId field
      repoId: 'repo-no-id',
      chunks: [],
      createdAt: new Date(),
    });

    await seedContextQuality(db);

    const count = await db.collection('repo_context_curation_entry_revisions').countDocuments({ repoId: 'repo-no-id' });
    expect(count).toBe(0);
  });
});

// ─── Full idempotency: run from empty DB twice ────────────────────────────────

describe('seedContextQuality — full idempotency', () => {
  it('running on an empty DB twice leaves exactly the seeded rows and nothing more', async () => {
    await seedContextQuality(db);
    await seedContextQuality(db);

    expect(await db.collection('context_judge_config').countDocuments()).toBe(1);
    expect(await db.collection('context_judge_scheduler_state').countDocuments()).toBe(9);
    // No sample findings must be inserted in production boot
    expect(await db.collection('context_findings').countDocuments()).toBe(0);
    expect(await db.collection('context_judge_runs').countDocuments()).toBe(0);
  });
});
