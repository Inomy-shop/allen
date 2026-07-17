/**
 * Tests for TeamService — soft delete + restore behaviour.
 *
 * Uses mongodb-memory-server so all MongoDB operators are validated
 * against a real instance.
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, type Db, ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TeamService } from './team.service.js';
import { notDeletedFilter, softDeleteSet, restoreSet } from './soft-delete.js';

describe('TeamService soft delete and restore', () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let service: TeamService;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    db = client.db('team-service-test');
    service = new TeamService(db);
  });

  afterAll(async () => {
    await client.close();
    await mongo.stop();
  });

  beforeEach(async () => {
    await db.collection('teams').deleteMany({});
    await db.collection('agents').deleteMany({});
  });

  // ── FR4-AC1: Deleting empty non-built-in team sets isDeleted=true ──

  it('FR4-AC1: delete sets isDeleted=true on empty non-built-in team', async () => {
    await db.collection('teams').insertOne({
      name: 'empty-team',
      displayName: 'Empty Team',
      description: 'No members',
      leadAgentName: 'someone',
      isBuiltIn: false,
      createdBy: 'user',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await service.delete('empty-team');

    const doc = await db.collection('teams').findOne({ name: 'empty-team' });
    expect(doc).not.toBeNull();
    expect(doc?.isDeleted).toBe(true);
    expect(doc?.deletedAt).toBeInstanceOf(Date);
  });

  it('FR4-AC1: delete refuses built-in team', async () => {
    await db.collection('teams').insertOne({
      name: 'built-in-team',
      displayName: 'Built In',
      description: 'Seeded',
      leadAgentName: 'built-in-lead',
      isBuiltIn: true,
      createdBy: 'seed',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(service.delete('built-in-team')).rejects.toThrow(/built-in/);
  });

  // ── FR4-AC2: Deleted teams do not appear in lists ──

  it('FR4-AC2: list excludes deleted teams', async () => {
    await db.collection('teams').insertOne({
      name: 'visible-team',
      displayName: 'Visible',
      description: 'Active',
      leadAgentName: 'lead1',
      isBuiltIn: false,
      createdBy: 'user',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.collection('teams').insertOne({
      name: 'ghost-team',
      displayName: 'Ghost',
      description: 'Deleted',
      leadAgentName: 'lead2',
      isBuiltIn: false,
      createdBy: 'user',
      createdAt: new Date(),
      updatedAt: new Date(),
      isDeleted: true,
      deletedAt: new Date(),
    });

    const list = await service.list();
    const names = list.map((t) => t.name);
    expect(names).toContain('visible-team');
    expect(names).not.toContain('ghost-team');
  });

  // ── FR4-AC3: Team delete with active members still refused ──

  it('FR4-AC3: delete refuses team with active members', async () => {
    await db.collection('teams').insertOne({
      name: 'populated-team',
      displayName: 'Populated',
      description: 'Has members',
      leadAgentName: 'lead1',
      isBuiltIn: false,
      createdBy: 'user',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.collection('agents').insertOne({
      name: 'member1',
      teamName: 'populated-team',
      createdBy: 'user',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(service.delete('populated-team')).rejects.toThrow(/still has/);
  });

  it('deletes a non-built-in team and its agents when deleteAgents=true', async () => {
    await db.collection('teams').insertOne({
      name: 'obsolete-team',
      displayName: 'Obsolete',
      description: 'Can be removed as a unit',
      leadAgentName: 'obsolete-lead',
      isBuiltIn: false,
      createdBy: 'user',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.collection('agents').insertMany([
      {
        name: 'obsolete-lead',
        teamName: 'obsolete-team',
        teamRole: 'lead',
        isBuiltIn: false,
        createdBy: 'user',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        name: 'obsolete-member',
        teamName: 'obsolete-team',
        teamRole: 'member',
        isBuiltIn: false,
        createdBy: 'user',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        name: 'external-agent',
        teamName: 'other-team',
        spawnTargets: ['obsolete-lead', 'obsolete-member', 'kept-target'],
        canTrigger: ['obsolete-member', 'kept-workflow'],
        isBuiltIn: false,
        createdBy: 'user',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const result = await service.delete('obsolete-team', { deleteAgents: true });

    expect(result.deletedAgents.sort()).toEqual(['obsolete-lead', 'obsolete-member']);

    const team = await db.collection('teams').findOne({ name: 'obsolete-team' });
    expect(team?.isDeleted).toBe(true);

    const deletedAgents = await db.collection('agents')
      .find({ name: { $in: ['obsolete-lead', 'obsolete-member'] } })
      .toArray();
    expect(deletedAgents).toHaveLength(2);
    expect(deletedAgents.every((agent) => agent.isDeleted === true)).toBe(true);

    const external = await db.collection('agents').findOne({ name: 'external-agent' });
    expect(external?.spawnTargets).toEqual(['kept-target']);
    expect(external?.canTrigger).toEqual(['kept-workflow']);
  });

  it('deleteAgents=true refuses to delete built-in member agents', async () => {
    await db.collection('teams').insertOne({
      name: 'mixed-team',
      displayName: 'Mixed',
      description: 'Contains built-in member',
      leadAgentName: 'custom-lead',
      isBuiltIn: false,
      createdBy: 'user',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.collection('agents').insertOne({
      name: 'seeded-member',
      teamName: 'mixed-team',
      teamRole: 'member',
      isBuiltIn: true,
      createdBy: 'seed',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(service.delete('mixed-team', { deleteAgents: true })).rejects.toThrow(/built-in agent/);

    const team = await db.collection('teams').findOne({ name: 'mixed-team' });
    const agent = await db.collection('agents').findOne({ name: 'seeded-member' });
    expect(team?.isDeleted).not.toBe(true);
    expect(agent?.isDeleted).not.toBe(true);
  });

  // ── FR4-AC4: /api/teams/:name, members, blueprint routes return 404 ──

  it('FR4-AC4: getByName returns null for deleted team', async () => {
    await db.collection('teams').insertOne({
      name: 'ghost',
      displayName: 'Ghost',
      description: 'Deleted',
      leadAgentName: 'lead',
      isBuiltIn: false,
      createdBy: 'user',
      createdAt: new Date(),
      updatedAt: new Date(),
      isDeleted: true,
      deletedAt: new Date(),
    });

    const found = await service.getByName('ghost');
    expect(found).toBeNull();
  });

  it('FR4-AC4: getById returns null for deleted team', async () => {
    const id = new ObjectId();
    await db.collection('teams').insertOne({
      _id: id,
      name: 'ghost-by-id',
      displayName: 'Ghost By Id',
      description: 'Deleted',
      leadAgentName: 'lead',
      isBuiltIn: false,
      createdBy: 'user',
      createdAt: new Date(),
      updatedAt: new Date(),
      isDeleted: true,
      deletedAt: new Date(),
    });

    const found = await service.getById(id.toHexString());
    expect(found).toBeNull();
  });

  it('FR4-AC4: getBlueprint returns null for deleted team', async () => {
    await db.collection('teams').insertOne({
      name: 'ghost-blueprint',
      displayName: 'Ghost Blueprint',
      description: 'Deleted',
      leadAgentName: 'lead',
      isBuiltIn: false,
      createdBy: 'user',
      createdAt: new Date(),
      updatedAt: new Date(),
      isDeleted: true,
      deletedAt: new Date(),
    });

    const blueprint = await service.getBlueprint('ghost-blueprint');
    expect(blueprint).toBeNull();
  });

  it('FR4-AC4: listMembers filters by team and notDeletedFilter', async () => {
    await db.collection('agents').insertOne({
      name: 'alice',
      teamName: 'executive',
      teamRole: 'lead',
      spawnTargets: [],
      createdBy: 'user',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.collection('agents').insertOne({
      name: 'bob',
      teamName: 'executive',
      teamRole: 'member',
      spawnTargets: [],
      isDeleted: true,
      deletedAt: new Date(),
      createdBy: 'user',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const members = await service.listMembers('executive');
    const names = members.map((m: any) => m.name);
    expect(names).toContain('alice');
    expect(names).not.toContain('bob');
  });

  // ── FR4-AC5: Moving an agent into a deleted team fails ──

  it('FR4-AC5: promoteToLead rejects deleted lead agent', async () => {
    await db.collection('agents').insertOne({
      name: 'ghost-lead',
      teamName: 'unassigned',
      teamRole: 'member',
      isDeleted: true,
      deletedAt: new Date(),
      createdBy: 'user',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(service.promoteToLead('ghost-lead', 'engineering')).rejects.toThrow(/not found/);
  });

  // ── FR4-AC6: Creating team with same name restores original team row ──

  it('FR4-AC6: create restores soft-deleted team with same name', async () => {
    await db.collection('teams').insertOne({
      name: 'restored-team',
      displayName: 'Original Display',
      description: 'Original desc',
      leadAgentName: 'old-lead',
      isBuiltIn: false,
      createdBy: 'user',
      createdAt: new Date(),
      updatedAt: new Date(),
      isDeleted: true,
      deletedAt: new Date(),
      deletedBy: 'some-user',
    });

    const result = await service.create({
      name: 'restored-team',
      displayName: 'New Display',
      description: 'New desc',
      leadAgentName: 'new-lead',
    });

    expect(result.name).toBe('restored-team');
    expect(result.displayName).toBe('New Display');

    const doc = await db.collection('teams').findOne({ name: 'restored-team' });
    expect(doc?.isDeleted).toBe(false);
    // deletedAt set to null by restoreSet
    expect(doc?.deletedAt).toBeNull();
    expect(doc?.restoredAt).toBeInstanceOf(Date);
    // deletedBy should be unset
    expect(doc?.deletedBy).toBeUndefined();
  });

  // ── FR4-AC7: No deleted-team view added (NEGATIVE) ──
  // Verified by absence of any method that lists deleted teams.

  // ── FR1-AC4: deletedAt:null without isDeleted is not treated as deleted ──

  it('FR1-AC4: team with deletedAt=null and no isDeleted is visible', async () => {
    await db.collection('teams').insertOne({
      name: 'null-deleted-team',
      displayName: 'Null Deleted',
      description: 'Has deletedAt null only',
      leadAgentName: 'lead',
      isBuiltIn: false,
      createdBy: 'user',
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    });

    const found = await service.getByName('null-deleted-team');
    expect(found).not.toBeNull();
    expect(found?.name).toBe('null-deleted-team');
  });

  // ── update returns null when team is deleted ──

  it('update returns null for deleted team', async () => {
    await db.collection('teams').insertOne({
      name: 'deletable',
      displayName: 'Deletable',
      description: 'To be deleted',
      leadAgentName: 'lead',
      isBuiltIn: false,
      createdBy: 'user',
      createdAt: new Date(),
      updatedAt: new Date(),
      isDeleted: true,
      deletedAt: new Date(),
    });

    const result = await service.update('deletable', { displayName: 'Updated' });
    expect(result).toBeNull();
  });
});
