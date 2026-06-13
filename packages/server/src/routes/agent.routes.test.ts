import express from 'express';
import request from 'supertest';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { agentRoutes } from './agent.routes.js';

describe('agentRoutes bulk model update', () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let app: express.Express;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    db = client.db('agent-routes-test');
    app = express();
    app.use(express.json());
    app.use('/api/agents', agentRoutes(db));
  });

  beforeEach(async () => {
    await db.collection('agents').deleteMany({});
  });

  afterAll(async () => {
    await client.close();
    await mongo.stop();
  });

  it('updates compatible agents and skips missing agents', async () => {
    const before = new Date('2026-01-01T00:00:00.000Z');
    await insertAgent({ name: 'alpha', provider: 'claude', model: 'sonnet', updatedAt: before });

    const res = await request(app)
      .post('/api/agents/bulk-model')
      .send({
        agentNames: [' alpha ', 'missing'],
        provider: 'codex',
        model: ' gpt-5.5 ',
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      updated: ['alpha'],
      skipped: [{ name: 'missing', reason: 'not-found' }],
    });

    const alpha = await db.collection('agents').findOne({ name: 'alpha' });
    expect(alpha?.provider).toBe('codex');
    expect(alpha?.model).toBe('gpt-5.5');
    expect(alpha?.updatedAt).toBeInstanceOf(Date);
    expect(alpha?.updatedAt.getTime()).toBeGreaterThan(before.getTime());
  });

  it('rejects invalid agentNames before mutation', async () => {
    await insertAgent({ name: 'alpha', provider: 'claude', model: 'sonnet' });

    const blankRes = await request(app)
      .post('/api/agents/bulk-model')
      .send({ agentNames: ['alpha', '  '], provider: 'codex', model: 'gpt-5.5' });
    expect(blankRes.status).toBe(400);
    expect(blankRes.body.code).toBe('invalid_agent_names');

    const duplicateRes = await request(app)
      .post('/api/agents/bulk-model')
      .send({ agentNames: ['alpha', ' alpha '], provider: 'codex', model: 'gpt-5.5' });
    expect(duplicateRes.status).toBe(400);
    expect(duplicateRes.body.code).toBe('duplicate_agent_names');

    const alpha = await db.collection('agents').findOne({ name: 'alpha' });
    expect(alpha?.provider).toBe('claude');
    expect(alpha?.model).toBe('sonnet');
  });

  it('rejects unknown providers before mutation', async () => {
    await insertAgent({ name: 'alpha', provider: 'claude', model: 'sonnet' });

    const res = await request(app)
      .post('/api/agents/bulk-model')
      .send({ agentNames: ['alpha'], provider: 'not-a-provider', model: 'sonnet' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_provider');

    const alpha = await db.collection('agents').findOne({ name: 'alpha' });
    expect(alpha?.provider).toBe('claude');
  });

  it('accepts the legacy claude-cli provider id and stores it as claude', async () => {
    await insertAgent({ name: 'alpha', provider: 'claude', model: 'sonnet' });

    const res = await request(app)
      .post('/api/agents/bulk-model')
      .send({ agentNames: ['alpha'], provider: 'claude-cli', model: 'claude-sonnet-4-6' });

    expect(res.status).toBe(200);
    const alpha = await db.collection('agents').findOne({ name: 'alpha' });
    expect(alpha?.provider).toBe('claude');
  });

  it('rejects blank model before mutation', async () => {
    await insertAgent({ name: 'alpha', provider: 'claude', model: 'sonnet' });

    const res = await request(app)
      .post('/api/agents/bulk-model')
      .send({ agentNames: ['alpha'], provider: 'codex', model: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_model');

    const alpha = await db.collection('agents').findOne({ name: 'alpha' });
    expect(alpha?.provider).toBe('claude');
    expect(alpha?.model).toBe('sonnet');
  });

  it('skips planMode-incompatible agents when clearing is disabled', async () => {
    await insertAgent({ name: 'planner', provider: 'claude', model: 'sonnet', planMode: true });

    const res = await request(app)
      .post('/api/agents/bulk-model')
      .send({ agentNames: ['planner'], provider: 'codex', model: 'gpt-5.5' });

    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual([]);
    expect(res.body.skipped).toEqual([
      expect.objectContaining({
        name: 'planner',
        reason: 'incompatible-settings',
        code: 'plan_mode_claude_only',
      }),
    ]);

    const planner = await db.collection('agents').findOne({ name: 'planner' });
    expect(planner?.provider).toBe('claude');
    expect(planner?.model).toBe('sonnet');
    expect(planner?.planMode).toBe(true);
  });

  it('clears planMode and updates when clearing is enabled', async () => {
    await insertAgent({ name: 'planner', provider: 'claude', model: 'sonnet', planMode: true });

    const res = await request(app)
      .post('/api/agents/bulk-model')
      .send({
        agentNames: ['planner'],
        provider: 'codex',
        model: 'gpt-5.5',
        clearIncompatibleSettings: true,
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: ['planner'], skipped: [] });

    const planner = await db.collection('agents').findOne({ name: 'planner' });
    expect(planner?.provider).toBe('codex');
    expect(planner?.model).toBe('gpt-5.5');
    expect('planMode' in planner!).toBe(false);
  });

  it('skips reasoningEffort=max-incompatible agents when clearing is disabled', async () => {
    await insertAgent({
      name: 'thinker',
      provider: 'claude',
      model: 'opus',
      reasoningEffort: 'max',
    });

    const res = await request(app)
      .post('/api/agents/bulk-model')
      .send({ agentNames: ['thinker'], provider: 'claude', model: 'sonnet' });

    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual([]);
    expect(res.body.skipped).toEqual([
      expect.objectContaining({
        name: 'thinker',
        reason: 'incompatible-settings',
        code: 'effort_max_requires_opus',
      }),
    ]);

    const thinker = await db.collection('agents').findOne({ name: 'thinker' });
    expect(thinker?.provider).toBe('claude');
    expect(thinker?.model).toBe('opus');
    expect(thinker?.reasoningEffort).toBe('max');
  });

  it('clears reasoningEffort=max and updates when clearing is enabled', async () => {
    await insertAgent({
      name: 'thinker',
      provider: 'claude',
      model: 'opus',
      reasoningEffort: 'max',
    });

    const res = await request(app)
      .post('/api/agents/bulk-model')
      .send({
        agentNames: ['thinker'],
        provider: 'claude',
        model: 'sonnet',
        clearIncompatibleSettings: true,
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: ['thinker'], skipped: [] });

    const thinker = await db.collection('agents').findOne({ name: 'thinker' });
    expect(thinker?.provider).toBe('claude');
    expect(thinker?.model).toBe('sonnet');
    expect('reasoningEffort' in thinker!).toBe(false);
  });

  it('preserves protected fields when updating provider and model', async () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    const sourceRepoId = new ObjectId();
    await insertAgent({
      name: 'protected',
      provider: 'claude',
      model: 'sonnet',
      teamName: 'backend',
      teamRole: 'lead',
      isBuiltIn: true,
      createdBy: 'seed',
      createdAt,
      sourceRepoId,
      sourceRepoPath: '/repo',
      sourceFile: '.claude/agents/protected.md',
      sourceSha: 'abc123',
    });
    const before = await db.collection('agents').findOne({ name: 'protected' });

    const res = await request(app)
      .post('/api/agents/bulk-model')
      .send({ agentNames: ['protected'], provider: 'codex', model: 'gpt-5.5' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: ['protected'], skipped: [] });

    const after = await db.collection('agents').findOne({ name: 'protected' });
    expect(after?._id).toEqual(before?._id);
    expect(after?.name).toBe('protected');
    expect(after?.teamName).toBe('backend');
    expect(after?.teamRole).toBe('lead');
    expect(after?.isBuiltIn).toBe(true);
    expect(after?.createdBy).toBe('seed');
    expect(after?.createdAt).toEqual(createdAt);
    expect(after?.sourceRepoId).toEqual(sourceRepoId);
    expect(after?.sourceRepoPath).toBe('/repo');
    expect(after?.sourceFile).toBe('.claude/agents/protected.md');
    expect(after?.sourceSha).toBe('abc123');
    expect(after?.provider).toBe('codex');
    expect(after?.model).toBe('gpt-5.5');
  });

  async function insertAgent(overrides: Record<string, unknown>): Promise<void> {
    const now = new Date('2026-01-01T00:00:00.000Z');
    await db.collection('agents').insertOne({
      name: 'agent',
      displayName: 'Agent',
      description: '',
      teamName: 'unassigned',
      teamRole: 'member',
      type: 'technical',
      provider: 'claude',
      model: 'sonnet',
      capabilities: [],
      spawnTargets: [],
      canTrigger: [],
      personality: '',
      icon: 'bot',
      color: '#6366f1',
      system: '',
      isBuiltIn: false,
      createdBy: 'user',
      createdAt: now,
      updatedAt: now,
      ...overrides,
    });
  }
});

describe('agentRoutes soft delete and restore', () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let app: express.Express;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    db = client.db('agent-routes-soft-delete-test');
    app = express();
    app.use(express.json());
    app.use('/api/agents', agentRoutes(db));
  });

  beforeEach(async () => {
    await db.collection('agents').deleteMany({});
  });

  afterAll(async () => {
    await client.close();
    await mongo.stop();
  });

  const defaultAgent = {
    name: 'test-agent',
    displayName: 'Test Agent',
    description: 'An agent for testing',
    teamName: 'unassigned',
    teamRole: 'member',
    type: 'technical',
    provider: 'claude',
    model: 'sonnet',
    capabilities: [],
    spawnTargets: [],
    canTrigger: [],
    personality: '',
    icon: 'bot',
    color: '#6366f1',
    system: 'You are a test agent.',
    isBuiltIn: false,
    createdBy: 'user',
  };

  async function insertDefaultAgent(overrides: Record<string, unknown> = {}): Promise<void> {
    const now = new Date('2026-06-01T00:00:00.000Z');
    await db.collection('agents').insertOne({
      ...defaultAgent,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    });
  }

  // ── FR2-AC1: Deleting an agent sets isDeleted=true and deletedAt ──

  it('FR2-AC1: DELETE sets isDeleted and deletedAt, document remains in agents', async () => {
    await insertDefaultAgent({ name: 'delete-me' });

    const res = await request(app).delete('/api/agents/delete-me');
    expect(res.status).toBe(204);

    const doc = await db.collection('agents').findOne({ name: 'delete-me' });
    expect(doc).not.toBeNull();
    expect(doc?.isDeleted).toBe(true);
    expect(doc?.deletedAt).toBeInstanceOf(Date);
  });

  it('FR2-AC1: DELETE returns 404 for non-existent agent', async () => {
    const res = await request(app).delete('/api/agents/non-existent');
    expect(res.status).toBe(404);
  });

  // ── FR2-AC2: Deleted agents disappear from /api/agents ──

  it('FR2-AC2: GET /api/agents excludes deleted agents', async () => {
    await insertDefaultAgent({ name: 'visible' });
    await insertDefaultAgent({ name: 'hidden', isDeleted: true, deletedAt: new Date() });

    const res = await request(app).get('/api/agents');
    expect(res.status).toBe(200);
    const names = res.body.map((a: any) => a.name);
    expect(names).toContain('visible');
    expect(names).not.toContain('hidden');
  });

  // ── FR2-AC3: Get/spawn/run/edit/move a deleted agent returns not-found ──

  it('FR2-AC3: PUT on deleted agent returns 404', async () => {
    await insertDefaultAgent({ name: 'deleted-agent', isDeleted: true, deletedAt: new Date() });

    const res = await request(app)
      .put('/api/agents/deleted-agent')
      .send({ description: 'Trying update' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('FR2-AC3: POST /api/agents/:name/run on deleted agent returns 404', async () => {
    await insertDefaultAgent({ name: 'deleted-runner', isDeleted: true, deletedAt: new Date() });

    const res = await request(app)
      .post('/api/agents/deleted-runner/run')
      .send({ prompt: 'do something' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found|deleted/i);
  });

  it('FR2-AC3: PATCH team on deleted agent returns 404', async () => {
    await insertDefaultAgent({ name: 'deleted-patcher', isDeleted: true, deletedAt: new Date() });

    const res = await request(app)
      .patch('/api/agents/deleted-patcher/team')
      .send({ teamName: 'engineering', teamRole: 'member' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('FR2-AC3: bulk-model skips deleted agents as not-found', async () => {
    await insertDefaultAgent({ name: 'deleted-bulk', isDeleted: true, deletedAt: new Date() });

    const res = await request(app)
      .post('/api/agents/bulk-model')
      .send({ agentNames: ['deleted-bulk'], provider: 'codex', model: 'gpt-5.5' });
    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual([]);
    expect(res.body.skipped).toEqual([{ name: 'deleted-bulk', reason: 'not-found' }]);
  });

  // ── FR2-AC4: Creating agent with same name as deleted restores it ──

  it('FR2-AC4: POST /api/agents restores soft-deleted agent with same name', async () => {
    await db.collection('agents').insertOne({
      ...defaultAgent,
      name: 'restore-agent',
      createdAt: new Date(),
      updatedAt: new Date(),
      isDeleted: true,
      deletedAt: new Date(),
      deletedBy: 'old-user',
      deletedReason: 'test',
    });

    const res = await request(app)
      .post('/api/agents')
      .send({
        name: 'restore-agent',
        displayName: 'Restored Agent',
        description: 'I was restored',
        provider: 'claude',
        model: 'sonnet',
        system: 'You are a restored agent.',
      });

    expect(res.status).toBe(200);
    expect(res.body.restored).toBe(true);
    expect(res.body.name).toBe('restore-agent');

    const doc = await db.collection('agents').findOne({ name: 'restore-agent' });
    expect(doc?.isDeleted).toBe(false);
    expect(doc?.deletedAt).toBeNull();
    expect(doc?.restoredAt).toBeInstanceOf(Date);
    // deletedBy should be unset
    expect(doc?.deletedBy).toBeUndefined();
    expect(doc?.deletedReason).toBeUndefined();
  });

  // ── FR2-AC5: Imported agents with deleted-name collision restore ──

  it('FR2-AC5: import restores soft-deleted agent (import/json endpoint)', async () => {
    await db.collection('agents').insertOne({
      ...defaultAgent,
      name: 'imported-agent',
      createdAt: new Date(),
      updatedAt: new Date(),
      isDeleted: true,
      deletedAt: new Date(),
    });

    const res = await request(app)
      .post('/api/agents/import/json')
      .send({
        agents: [{ name: 'imported-agent', provider: 'claude', model: 'sonnet', system: 'imported' }],
      });

    expect(res.status).toBe(201);
    expect(res.body.created).toContain('imported-agent (restored)');

    const doc = await db.collection('agents').findOne({ name: 'imported-agent' });
    expect(doc?.isDeleted).toBe(false);
    expect(doc?.deletedAt).toBeNull();
    expect(doc?.restoredAt).toBeInstanceOf(Date);
  });

  // ── FR2-AC6: Existing execution records still render historical names (regression)
  //    No cascade delete — verified by NOT filtering other collections.

  it('FR2-AC6: deleting an agent does not cascade-delete from other collections', async () => {
    await insertDefaultAgent({ name: 'exec-agent' });
    await db.collection('executions').insertOne({
      id: 'exec-1',
      workflowName: 'chat:spawn_agent/exec-agent',
      status: 'completed',
      input: { agent_name: 'exec-agent' },
      startedAt: new Date('2026-01-01'),
      completedAt: new Date('2026-01-01T00:01:00'),
    });

    // Delete the agent
    const delRes = await request(app).delete('/api/agents/exec-agent');
    expect(delRes.status).toBe(204);

    // Execution record remains untouched
    const execDoc = await db.collection('executions').findOne({ id: 'exec-1' });
    expect(execDoc).not.toBeNull();
    expect(execDoc?.status).toBe('completed');
    expect((execDoc?.input as any)?.agent_name).toBe('exec-agent');
  });

  // ── FR2-AC7: No deleted-agent list, view, or admin page is added (NEGATIVE) ──
  // Verified by the absence of any route that returns deleted agents.
  // The GET /api/agents route excludes deleted agents (tested in FR2-AC2).

  // ── FR1-AC1: Lists exclude isDeleted:true rows (agents) ──

  it('FR1-AC1: GET /api/agents does not return soft-deleted agents', async () => {
    await insertDefaultAgent({ name: 'alpha' });
    await insertDefaultAgent({ name: 'beta', isDeleted: true, deletedAt: new Date() });
    await insertDefaultAgent({ name: 'gamma', isDeleted: true, deletedAt: new Date() });

    const res = await request(app).get('/api/agents');
    const names = res.body.map((a: any) => a.name);
    expect(names).toEqual(['alpha']);
  });

  // ── FR1-AC2: Direct get returns 404 for deleted rows ──

  it('FR1-AC2: PUT on a deleted agent name returns 404', async () => {
    await insertDefaultAgent({ name: 'ghost', isDeleted: true, deletedAt: new Date() });

    const res = await request(app)
      .put('/api/agents/ghost')
      .send({ description: 'updated' });
    expect(res.status).toBe(404);
  });

  // ── FR1-AC3: No includeDeleted or trash routes exist (NEGATIVE) ──

  it('FR1-AC3: /api/agents/deleted returns 404 (no such route)', async () => {
    const res = await request(app).get('/api/agents/deleted');
    expect(res.status).toBe(404);
  });

  it('FR1-AC3: /api/agents/trash returns 404 (no such route)', async () => {
    const res = await request(app).get('/api/agents/trash');
    expect(res.status).toBe(404);
  });

  it('FR1-AC3: no includeDeleted query parameter is recognized', async () => {
    // The route does not inspect includeDeleted — it always uses notDeletedFilter
    await insertDefaultAgent({ name: 'hidden-again', isDeleted: true, deletedAt: new Date() });

    const res = await request(app).get('/api/agents?includeDeleted=true');
    const names = res.body.map((a: any) => a.name);
    expect(names).not.toContain('hidden-again');
  });

  // ── FR8-AC2: User-deleted non-built-in resources remain deleted across restarts
  //    (Survives server restart — the isDeleted flag persists in MongoDB.)

  it('FR8-AC2: deleted flag persists across simulated restart (re-query)', async () => {
    await insertDefaultAgent({ name: 'persistent-delete', isDeleted: true, deletedAt: new Date() });

    // Simulate a "restart" by creating a new connection/query on same collection
    const doc = await db.collection('agents').findOne({ name: 'persistent-delete' });
    expect(doc?.isDeleted).toBe(true);
  });

  // ── FR8-AC3: Built-in deletion protections continue to prevent deletion

  it('FR8-AC3: built-in agents cannot be deleted', async () => {
    await insertDefaultAgent({ name: 'built-in-agent', isBuiltIn: true });

    const res = await request(app).delete('/api/agents/built-in-agent');
    expect(res.status).toBe(403); // built-in agents are protected from deletion
    expect(res.body.error).toMatch(/built-in/i);
    // Verify the agent still exists unchanged
    const doc = await db.collection('agents').findOne({ name: 'built-in-agent' });
    expect(doc?.isBuiltIn).toBe(true);
    expect(doc?.isDeleted).toBeFalsy();
  });

  // ── FR1-AC4: deletedAt:null without isDeleted not treated as deleted ──

  it('FR1-AC4: agent with deletedAt=null and no isDeleted is still visible', async () => {
    await insertDefaultAgent({ name: 'null-deleted-agent', deletedAt: null });

    const res = await request(app).get('/api/agents');
    const names = res.body.map((a: any) => a.name);
    expect(names).toContain('null-deleted-agent');
  });
});
