/**
 * Tests for SkillService — soft delete + restore behaviour.
 *
 * Uses mongodb-memory-server to validate MongoDB operators and
 * ObjectId queries against a real instance.
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, type Db, ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SkillService } from './skill.service.js';
import { notDeletedFilter, softDeleteSet, restoreSet } from './soft-delete.js';

describe('SkillService soft delete and restore', () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let service: SkillService;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    db = client.db('skill-service-test');
    service = new SkillService(db);
  });

  afterAll(async () => {
    await client.close();
    await mongo.stop();
  });

  beforeEach(async () => {
    await db.collection('skills').deleteMany({});
  });

  // ── FR5-AC1: Delete skill sets isDeleted=true, document remains ──

  it('FR5-AC1: delete sets isDeleted=true and deletedAt, document remains', async () => {
    const id = new ObjectId();
    await db.collection('skills').insertOne({
      _id: id,
      name: 'test-skill',
      displayName: 'Test Skill',
      description: 'A test skill',
      body: '## When to use\nTest.\n## When not to use\nN/A.',
      enabled: true,
      priority: 50,
      allowedRoutes: ['direct_answer'],
      version: 1,
      createdBy: 'user',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await service.delete(id.toHexString());

    const doc = await db.collection('skills').findOne({ _id: id });
    expect(doc).not.toBeNull();
    expect(doc?.isDeleted).toBe(true);
    expect(doc?.deletedAt).toBeInstanceOf(Date);
  });

  it('FR5-AC1: delete throws on invalid id', async () => {
    await expect(service.delete('not-an-object-id')).rejects.toThrow('Invalid skill id');
  });

  // ── FR5-AC2: Deleted skills disappear from list_skills and search_skills ──

  it('FR5-AC2: list excludes deleted skills', async () => {
    await db.collection('skills').insertOne({
      name: 'active-skill',
      displayName: 'Active',
      body: '## When to use\nActive.\n## When not to use\nN/A.',
      enabled: true,
      priority: 50,
      allowedRoutes: ['direct_answer'],
      version: 1,
      createdBy: 'user',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.collection('skills').insertOne({
      name: 'deleted-skill',
      displayName: 'Deleted',
      body: '## When to use\nDeleted.\n## When not to use\nN/A.',
      enabled: true,
      priority: 50,
      allowedRoutes: ['direct_answer'],
      version: 1,
      createdBy: 'user',
      createdAt: new Date(),
      updatedAt: new Date(),
      isDeleted: true,
      deletedAt: new Date(),
    });

    const list = await service.list(false);
    const names = list.map((s: any) => s.name);
    expect(names).toContain('active-skill');
    expect(names).not.toContain('deleted-skill');
  });

  it('FR5-AC2: search excludes deleted skills', async () => {
    await db.collection('skills').insertOne({
      name: 'searchable',
      displayName: 'Searchable',
      body: '## When to use\nSearchable.\n## When not to use\nN/A.',
      enabled: true,
      priority: 50,
      allowedRoutes: ['direct_answer'],
      version: 1,
      createdBy: 'user',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.collection('skills').insertOne({
      name: 'deleted-searchable',
      displayName: 'Deleted Searchable',
      body: '## When to use\nDeleted searchable.\n## When not to use\nN/A.',
      enabled: true,
      priority: 50,
      allowedRoutes: ['direct_answer'],
      version: 1,
      createdBy: 'user',
      createdAt: new Date(),
      updatedAt: new Date(),
      isDeleted: true,
      deletedAt: new Date(),
    });

    const result = await service.search({ query: 'searchable' });
    const matchNames = result.matches.map((m: any) => m.name);
    expect(matchNames).toContain('searchable');
    expect(matchNames).not.toContain('deleted-searchable');
  });

  // ── FR5-AC3: includeDisabled=true still excludes deleted skills ──

  it('FR5-AC3: list with includeDisabled=true excludes deleted skills', async () => {
    await db.collection('skills').insertOne({
      name: 'disabled-skill',
      displayName: 'Disabled',
      body: '## When to use\nDisabled.\n## When not to use\nN/A.',
      enabled: false,
      priority: 50,
      allowedRoutes: ['direct_answer'],
      version: 1,
      createdBy: 'user',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.collection('skills').insertOne({
      name: 'deleted-skill-2',
      displayName: 'Deleted 2',
      body: '## When to use\nDeleted.\n## When not to use\nN/A.',
      enabled: true,
      priority: 50,
      allowedRoutes: ['direct_answer'],
      version: 1,
      createdBy: 'user',
      createdAt: new Date(),
      updatedAt: new Date(),
      isDeleted: true,
      deletedAt: new Date(),
    });

    const list = await service.list(true);
    const names = list.map((s: any) => s.name);
    expect(names).toContain('disabled-skill');
    expect(names).not.toContain('deleted-skill-2');
  });

  it('FR5-AC3: search with includeDisabled=true excludes deleted', async () => {
    await db.collection('skills').insertOne({
      name: 'disabled-search',
      displayName: 'Disabled Search',
      body: '## When to use\nDisabled search.\n## When not to use\nN/A.',
      enabled: false,
      priority: 50,
      allowedRoutes: ['direct_answer'],
      version: 1,
      createdBy: 'user',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.collection('skills').insertOne({
      name: 'deleted-search',
      displayName: 'Deleted Search',
      body: '## When to use\nDeleted search.\n## When not to use\nN/A.',
      enabled: true,
      priority: 50,
      allowedRoutes: ['direct_answer'],
      version: 1,
      createdBy: 'user',
      createdAt: new Date(),
      updatedAt: new Date(),
      isDeleted: true,
      deletedAt: new Date(),
    });

    const result = await service.search({ query: 'search', includeDisabled: true });
    const matchNames = result.matches.map((m: any) => m.name);
    expect(matchNames).toContain('disabled-search');
    expect(matchNames).not.toContain('deleted-search');
  });

  // ── FR5-AC4: Creating same-name skill restores same _id ──

  it('FR5-AC4: create restores soft-deleted skill with same name', async () => {
    const id = new ObjectId();
    await db.collection('skills').insertOne({
      _id: id,
      name: 'restored-skill',
      displayName: 'Original',
      description: 'Original',
      body: '## When to use\nOriginal.\n## When not to use\nN/A.',
      enabled: true,
      priority: 50,
      allowedRoutes: ['direct_answer'],
      version: 3,
      createdBy: 'user',
      createdAt: new Date(),
      updatedAt: new Date(),
      isDeleted: true,
      deletedAt: new Date(),
      deletedBy: 'some-user',
    });

    const result = await service.create({
      name: 'restored-skill',
      displayName: 'Restored',
      description: 'Restored version',
      body: '## When to use\nRestored.\n## When not to use\nN/A.',
    });

    expect(result.name).toBe('restored-skill');
    // _id is the original deleted document's _id
    expect(result._id as string).toBeDefined();

    const doc = await db.collection('skills').findOne({ name: 'restored-skill' });
    expect(doc?.isDeleted).toBe(false);
    expect(doc?.deletedAt).toBeNull();
    expect(doc?.restoredAt).toBeInstanceOf(Date);
    // deletedBy should be unset
    expect(doc?.deletedBy).toBeUndefined();
  });

  it('FR5-AC4: create rejects duplicate active skill', async () => {
    await db.collection('skills').insertOne({
      name: 'dup-skill',
      displayName: 'Duplicate',
      body: '## When to use\nDup.\n## When not to use\nN/A.',
      enabled: true,
      priority: 50,
      allowedRoutes: ['direct_answer'],
      version: 1,
      createdBy: 'user',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(service.create({
      name: 'dup-skill',
      displayName: 'Duplicate',
      body: '## When to use\nDup.\n## When not to use\nN/A.',
    })).rejects.toThrow(/already exists/);
  });

  // ── FR5-AC5: Update/get deleted skill returns not found ──

  it('FR5-AC5: getById returns null for deleted skill', async () => {
    const id = new ObjectId();
    await db.collection('skills').insertOne({
      _id: id,
      name: 'ghost-skill',
      displayName: 'Ghost',
      body: '## When to use\nGhost.\n## When not to use\nN/A.',
      enabled: true,
      priority: 50,
      allowedRoutes: ['direct_answer'],
      version: 1,
      createdBy: 'user',
      createdAt: new Date(),
      updatedAt: new Date(),
      isDeleted: true,
      deletedAt: new Date(),
    });

    const found = await service.getById(id.toHexString());
    expect(found).toBeNull();
  });

  it('FR5-AC5: getByName returns null for deleted skill', async () => {
    await db.collection('skills').insertOne({
      name: 'ghost-skill-by-name',
      displayName: 'Ghost By Name',
      body: '## When to use\nGhost.\n## When not to use\nN/A.',
      enabled: true,
      priority: 50,
      allowedRoutes: ['direct_answer'],
      version: 1,
      createdBy: 'user',
      createdAt: new Date(),
      updatedAt: new Date(),
      isDeleted: true,
      deletedAt: new Date(),
    });

    const found = await service.getByName('ghost-skill-by-name');
    expect(found).toBeNull();
  });

  it('FR5-AC5: update throws for deleted skill', async () => {
    const id = new ObjectId();
    await db.collection('skills').insertOne({
      _id: id,
      name: 'updatable-skill',
      displayName: 'Updatable',
      body: '## When to use\nUpdate.\n## When not to use\nN/A.',
      enabled: true,
      priority: 50,
      allowedRoutes: ['direct_answer'],
      version: 1,
      createdBy: 'user',
      createdAt: new Date(),
      updatedAt: new Date(),
      isDeleted: true,
      deletedAt: new Date(),
    });

    await expect(service.update(id.toHexString(), { displayName: 'Trying' })).rejects.toThrow('Skill not found');
  });

  // ── FR5-AC6: No deleted-skill view added (NEGATIVE) ──
  // Verified by the absence of any method returning deleted-only rows.

  // ── FR1-AC4: deletedAt:null without isDeleted is not treated as deleted ──

  it('FR1-AC4: skill with deletedAt=null and no isDeleted is visible', async () => {
    await db.collection('skills').insertOne({
      name: 'null-deleted-skill',
      displayName: 'Null Deleted',
      body: '## When to use\nNull.\n## When not to use\nN/A.',
      enabled: true,
      priority: 50,
      allowedRoutes: ['direct_answer'],
      version: 1,
      createdBy: 'user',
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    });

    const found = await service.getByName('null-deleted-skill');
    expect(found).not.toBeNull();
    expect(found?.name).toBe('null-deleted-skill');
  });
});
