import express from 'express';
import request from 'supertest';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { interventionRoutes } from '../intervention.routes.js';

describe('POST /api/interventions/:id/respond — model_recovery decisions', () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let app: express.Express;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    db = client.db('intervention-respond-model-recovery-test');

    // Seed model registry entries for validation
    await db.collection('model_registry').insertMany([
      {
        provider: 'claude',
        fullId: 'claude-sonnet-4-6',
        displayName: 'Sonnet 4.6',
        providerDisplayName: 'Claude',
        isActive: true,
        sortOrder: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        provider: 'claude',
        fullId: 'claude-haiku-4-5-20251001',
        displayName: 'Haiku 4.5',
        providerDisplayName: 'Claude',
        isActive: true,
        sortOrder: 2,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        provider: 'codex',
        fullId: 'gpt-5.5',
        displayName: 'GPT-5.5',
        providerDisplayName: 'Codex',
        isActive: true,
        sortOrder: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    app = express();
    app.use(express.json());
    app.use('/api/interventions', interventionRoutes(db));
  });

  beforeEach(async () => {
    await db.collection('workflow_interventions').deleteMany({});
    await db.collection('executions').deleteMany({});
  });

  afterAll(async () => {
    await client.close();
    await mongo.stop();
  });

  async function insertExecution(
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const doc = {
      id: 'exec-mr-1',
      workflowId: 'wf-1',
      workflowName: 'test-workflow',
      status: 'waiting_for_input',
      currentNodes: ['implement'],
      state: {
        __recovery_state: {
          nodeName: 'implement',
          attempt: 1,
          maxAttempts: 3,
        },
      },
      input: {},
      sessions: {},
      retryCounts: {},
      nodeAttempts: {},
      completedNodes: [],
      cost: { actual: null, estimated: 0 },
      durationMs: 1000,
      startedAt: new Date(),
      ...overrides,
    };
    await db.collection('executions').insertOne(doc);
    return doc.id;
  }

  async function insertIntervention(
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const doc = {
      intervention_id: 'INT-model-recovery-1',
      workflow_run_id: 'exec-mr-1',
      workflow_name: 'test-workflow',
      stage: 'implement',
      kind: 'model_recovery',
      widget: 'model_recovery',
      severity: 'escalation',
      title: 'Model Recovery — implement',
      summary: 'Model recovery needed',
      context_summary: 'Agent failed with rate limit error',
      question: 'Select a replacement provider and model',
      options: [
        { label: 'Retry with selected model', value: 'retry_with_model', primary: true },
        { label: 'Cancel workflow', value: 'cancel', destructive: true },
      ],
      fields: [],
      actions: [
        { id: 'retry_with_model', label: 'Retry with selected model', intent: 'retry' },
        { id: 'cancel', label: 'Cancel workflow', intent: 'reject' },
      ],
      recoveryContext: {
        failedProvider: 'claude',
        failedModel: 'claude-sonnet-4-6',
        failureCategory: 'rate_limit_exhausted',
        attempt: 1,
        maxAttempts: 3,
      },
      status: 'pending',
      created_at: new Date(),
      ...overrides,
    };
    await db.collection('workflow_interventions').insertOne(doc);
    return doc.intervention_id;
  }

  // ── retry_with_model happy path ──

  it('retry_with_model with valid body returns 200 and submits input', async () => {
    await insertExecution();
    const intId = await insertIntervention();

    const res = await request(app)
      .post(`/api/interventions/${intId}/respond`)
      .send({
        decision: 'retry_with_model',
        provider: 'claude',
        model: 'claude-haiku-4-5-20251001',
        reasoning_effort: 'low',
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('answered');
    expect(res.body.response?.decision).toBe('retry_with_model');

    // Verify the intervention was marked answered
    const updated = await db.collection('workflow_interventions').findOne({ intervention_id: intId });
    expect(updated?.status).toBe('answered');
    expect(updated?.retry_triggered?.retry_source).toBe('model_recovery');
  });

  it('retry_with_model returns 400 when provider is missing', async () => {
    await insertExecution();
    const intId = await insertIntervention();

    const res = await request(app)
      .post(`/api/interventions/${intId}/respond`)
      .send({
        decision: 'retry_with_model',
        model: 'claude-haiku-4-5-20251001',
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_body');
  });

  it('retry_with_model returns 400 when model is missing', async () => {
    await insertExecution();
    const intId = await insertIntervention();

    const res = await request(app)
      .post(`/api/interventions/${intId}/respond`)
      .send({
        decision: 'retry_with_model',
        provider: 'claude',
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_body');
  });

  it('retry_with_model returns 400 for unknown provider', async () => {
    await insertExecution();
    const intId = await insertIntervention();

    const res = await request(app)
      .post(`/api/interventions/${intId}/respond`)
      .send({
        decision: 'retry_with_model',
        provider: 'unknown-provider',
        model: 'some-model',
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_provider');
  });

  it('retry_with_model returns 400 for unknown model on known provider', async () => {
    await insertExecution();
    const intId = await insertIntervention();

    const res = await request(app)
      .post(`/api/interventions/${intId}/respond`)
      .send({
        decision: 'retry_with_model',
        provider: 'claude',
        model: 'nonexistent-model',
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_model');
  });

  // ── reject / cancel ──

  it('reject cancels the execution', async () => {
    await insertExecution();
    const intId = await insertIntervention();

    const res = await request(app)
      .post(`/api/interventions/${intId}/respond`)
      .send({
        decision: 'reject',
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('answered');
    expect(res.body.response?.decision).toBe('reject');

    // Execution should be cancelled
    const exec = await db.collection('executions').findOne({ id: 'exec-mr-1' });
    expect(exec?.status).toBe('cancelled');
  });
});
