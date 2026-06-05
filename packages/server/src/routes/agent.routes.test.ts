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
    await insertAgent({ name: 'alpha', provider: 'claude-cli', model: 'sonnet', updatedAt: before });

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
    await insertAgent({ name: 'alpha', provider: 'claude-cli', model: 'sonnet' });

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
    expect(alpha?.provider).toBe('claude-cli');
    expect(alpha?.model).toBe('sonnet');
  });

  it('rejects unknown providers before mutation', async () => {
    await insertAgent({ name: 'alpha', provider: 'claude-cli', model: 'sonnet' });

    const res = await request(app)
      .post('/api/agents/bulk-model')
      .send({ agentNames: ['alpha'], provider: 'claude', model: 'sonnet' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_provider');

    const alpha = await db.collection('agents').findOne({ name: 'alpha' });
    expect(alpha?.provider).toBe('claude-cli');
  });

  it('rejects blank model before mutation', async () => {
    await insertAgent({ name: 'alpha', provider: 'claude-cli', model: 'sonnet' });

    const res = await request(app)
      .post('/api/agents/bulk-model')
      .send({ agentNames: ['alpha'], provider: 'codex', model: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_model');

    const alpha = await db.collection('agents').findOne({ name: 'alpha' });
    expect(alpha?.provider).toBe('claude-cli');
    expect(alpha?.model).toBe('sonnet');
  });

  it('skips planMode-incompatible agents when clearing is disabled', async () => {
    await insertAgent({ name: 'planner', provider: 'claude-cli', model: 'sonnet', planMode: true });

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
    expect(planner?.provider).toBe('claude-cli');
    expect(planner?.model).toBe('sonnet');
    expect(planner?.planMode).toBe(true);
  });

  it('clears planMode and updates when clearing is enabled', async () => {
    await insertAgent({ name: 'planner', provider: 'claude-cli', model: 'sonnet', planMode: true });

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
      provider: 'claude-cli',
      model: 'opus',
      reasoningEffort: 'max',
    });

    const res = await request(app)
      .post('/api/agents/bulk-model')
      .send({ agentNames: ['thinker'], provider: 'claude-cli', model: 'sonnet' });

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
    expect(thinker?.provider).toBe('claude-cli');
    expect(thinker?.model).toBe('opus');
    expect(thinker?.reasoningEffort).toBe('max');
  });

  it('clears reasoningEffort=max and updates when clearing is enabled', async () => {
    await insertAgent({
      name: 'thinker',
      provider: 'claude-cli',
      model: 'opus',
      reasoningEffort: 'max',
    });

    const res = await request(app)
      .post('/api/agents/bulk-model')
      .send({
        agentNames: ['thinker'],
        provider: 'claude-cli',
        model: 'sonnet',
        clearIncompatibleSettings: true,
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: ['thinker'], skipped: [] });

    const thinker = await db.collection('agents').findOne({ name: 'thinker' });
    expect(thinker?.provider).toBe('claude-cli');
    expect(thinker?.model).toBe('sonnet');
    expect('reasoningEffort' in thinker!).toBe(false);
  });

  it('preserves protected fields when updating provider and model', async () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    const sourceRepoId = new ObjectId();
    await insertAgent({
      name: 'protected',
      provider: 'claude-cli',
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
      provider: 'claude-cli',
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
