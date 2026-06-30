import express from 'express';
import request from 'supertest';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSubmitInput = vi.hoisted(() => vi.fn());

vi.mock('../../services/execution.service.js', () => ({
  ExecutionService: vi.fn().mockImplementation(() => ({
    getById: vi.fn().mockImplementation(async (id: string) => {
      if (id === 'exec-not-found') return null;
      if (id === 'exec-trace-recovery') {
        return {
          id,
          workflowId: 'wf-1',
          workflowName: 'test-workflow',
          status: 'waiting_for_input',
          currentNodes: ['implement'],
          state: {},
          input: {},
          sessions: {},
          retryCounts: {},
          nodeAttempts: {},
          completedNodes: [],
          cost: { actual: null, estimated: 0 },
          durationMs: 1000,
          startedAt: new Date(),
        };
      }
      const recoveryAttempt =
        id === 'exec-attempt-max' ? 3 :
        id === 'exec-attempt-exceeded' ? 4 :
        1;
      return {
        id,
        workflowId: 'wf-1',
        workflowName: 'test-workflow',
        status: 'waiting_for_input',
        currentNodes: ['implement'],
        state: {
          __recovery_state: {
            nodeName: 'implement',
            failedProvider: 'claude',
            failedModel: 'claude-sonnet-4-6',
            failureCategory: 'rate_limit_exhausted',
            sanitizedError: 'Rate limit exceeded',
            attempt: recoveryAttempt,
            maxAttempts: 3,
            isParallelBranch: false,
            enteredAt: new Date().toISOString(),
            overrideHistory: [],
          },
          __model_overrides: {},
        },
        input: {},
        sessions: {},
        retryCounts: {},
        nodeAttempts: {},
        completedNodes: [],
        cost: { actual: null, estimated: 0 },
        durationMs: 1000,
        startedAt: new Date(),
      };
    }),
    submitInput: mockSubmitInput,
    listPaged: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    listFeedback: vi.fn().mockResolvedValue([]),
    appendFeedback: vi.fn().mockResolvedValue({}),
    getTraces: vi.fn().mockResolvedValue([]),
    getTracesByNode: vi.fn().mockResolvedValue([]),
    getTraceByAttempt: vi.fn().mockResolvedValue(null),
    cancel: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../services/intervention.service.js', () => ({
  InterventionService: vi.fn().mockImplementation(() => ({
    listForWorkflowRun: vi.fn().mockResolvedValue([]),
    recordResponse: vi.fn().mockResolvedValue({}),
    skipStalePending: vi.fn().mockResolvedValue(0),
    create: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('../../services/user.service.js', () => ({
  UserService: vi.fn().mockImplementation(() => ({
    findById: vi.fn().mockResolvedValue(null),
  })),
}));

import { executionRoutes } from '../execution.routes.js';

describe('POST /api/executions/:id/recover-model', () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let app: express.Express;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    db = client.db('execution-recover-model-test');

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
    app.use('/api/executions', executionRoutes(db));
  });

  beforeEach(async () => {
    mockSubmitInput.mockReset();
    mockSubmitInput.mockResolvedValue(true);
    await db.collection('execution_traces').deleteMany({});
  });

  afterAll(async () => {
    await client.close();
    await mongo.stop();
  });

  // ── Happy path ──

  it('returns 200 with correct response on valid model recovery', async () => {
    const res = await request(app)
      .post('/api/executions/exec-test-1/recover-model')
      .send({
        node: 'implement',
        provider: 'claude',
        model: 'claude-haiku-4-5-20251001',
        reasoningEffort: 'medium',
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      executionId: 'exec-test-1',
      node: 'implement',
      status: 'running',
      recoveryAttempt: 1,
      selectedProvider: 'claude',
      selectedModel: 'claude-haiku-4-5-20251001',
      action: 'retry_with_model',
    });
    expect(mockSubmitInput).toHaveBeenCalledWith(
      'exec-test-1',
      'implement',
      { provider: 'claude', model: 'claude-haiku-4-5-20251001', reasoning_effort: 'medium' },
    );
  });

  it('returns 200 with optional reasoningEffort omitted', async () => {
    const res = await request(app)
      .post('/api/executions/exec-test-1/recover-model')
      .send({
        node: 'implement',
        provider: 'codex',
        model: 'gpt-5.5',
      });

    expect(res.status).toBe(200);
    expect(res.body.selectedProvider).toBe('codex');
    expect(res.body.selectedModel).toBe('gpt-5.5');
    expect(res.body.action).toBe('retry_with_model');
  });


  it('falls back to the latest model recovery trace when paused state lacks recovery metadata', async () => {
    await db.collection('execution_traces').insertOne({
      executionId: 'exec-trace-recovery',
      node: 'implement',
      attempt: 1,
      startedAt: new Date('2026-06-20T00:00:00.000Z'),
      completedAt: new Date('2026-06-20T00:00:01.000Z'),
      modelRecoveryAttempt: {
        recoveryAttempt: 2,
        maxAttempts: 3,
        originalProvider: 'deepseek',
        originalModel: 'deepseek-v4-flash',
        failureCategory: 'provider_auth_failed',
      },
    });

    const res = await request(app)
      .post('/api/executions/exec-trace-recovery/recover-model')
      .send({
        node: 'implement',
        provider: 'claude',
        model: 'claude-haiku-4-5-20251001',
      });

    expect(res.status).toBe(200);
    expect(res.body.recoveryAttempt).toBe(2);
    expect(mockSubmitInput).toHaveBeenCalledWith(
      'exec-trace-recovery',
      'implement',
      { provider: 'claude', model: 'claude-haiku-4-5-20251001', reasoning_effort: undefined },
    );
  });

  // ── 409 / 500 — submitInput failure ──

  it('returns 500 when engine.submitInput returns false', async () => {
    mockSubmitInput.mockResolvedValue(false);

    const res = await request(app)
      .post('/api/executions/exec-test-1/recover-model')
      .send({
        node: 'implement',
        provider: 'claude',
        model: 'claude-haiku-4-5-20251001',
      });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('retry_failed');
  });

  // ── 400 invalid_node ──

  it('returns 400 when node is not in recovery state', async () => {
    const res = await request(app)
      .post('/api/executions/exec-test-1/recover-model')
      .send({
        node: 'nonexistent-node',
        provider: 'claude',
        model: 'claude-haiku-4-5-20251001',
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_node');
  });

  // ── 400 invalid_provider ──

  it('returns 400 for unknown provider', async () => {
    const res = await request(app)
      .post('/api/executions/exec-test-1/recover-model')
      .send({
        node: 'implement',
        provider: 'nonexistent-provider',
        model: 'some-model',
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_provider');
  });

  // ── 400 invalid_model ──

  it('returns 400 for unknown model on known provider', async () => {
    const res = await request(app)
      .post('/api/executions/exec-test-1/recover-model')
      .send({
        node: 'implement',
        provider: 'claude',
        model: 'nonexistent-model',
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_model');
  });

  // ── 400 max_recovery_attempts ──

  it('allows the final rendered recovery attempt when attempt equals maxAttempts', async () => {
    const res = await request(app)
      .post('/api/executions/exec-attempt-max/recover-model')
      .send({
        node: 'implement',
        provider: 'claude',
        model: 'claude-haiku-4-5-20251001',
      });

    expect(res.status).toBe(200);
    expect(res.body.recoveryAttempt).toBe(3);
  });

  it('returns 400 when recovery attempts are exceeded', async () => {
    const res = await request(app)
      .post('/api/executions/exec-attempt-exceeded/recover-model')
      .send({
        node: 'implement',
        provider: 'claude',
        model: 'claude-haiku-4-5-20251001',
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('max_recovery_attempts');
  });

  // ── 404 execution_not_found ──

  it('returns 404 for non-existent execution', async () => {
    const res = await request(app)
      .post('/api/executions/exec-not-found/recover-model')
      .send({
        node: 'implement',
        provider: 'claude',
        model: 'claude-haiku-4-5-20251001',
      });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('execution_not_found');
  });

  // ── Body validation ──

  it('returns 400 when node is missing', async () => {
    const res = await request(app)
      .post('/api/executions/exec-test-1/recover-model')
      .send({
        provider: 'claude',
        model: 'claude-haiku-4-5-20251001',
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_node');
  });

  it('returns 400 when provider is missing', async () => {
    const res = await request(app)
      .post('/api/executions/exec-test-1/recover-model')
      .send({
        node: 'implement',
        model: 'claude-haiku-4-5-20251001',
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_provider');
  });

  it('returns 400 when model is missing', async () => {
    const res = await request(app)
      .post('/api/executions/exec-test-1/recover-model')
      .send({
        node: 'implement',
        provider: 'claude',
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_model');
  });

  it('returns 400 for invalid reasoningEffort value', async () => {
    const res = await request(app)
      .post('/api/executions/exec-test-1/recover-model')
      .send({
        node: 'implement',
        provider: 'claude',
        model: 'claude-haiku-4-5-20251001',
        reasoningEffort: 'extreme',
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_reasoning_effort');
  });
});

describe('POST /api/executions/:id/input — imported execution guard', () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let app: express.Express;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    db = client.db('execution-input-guard-test');

    app = express();
    app.use(express.json());
    app.use('/api/executions', executionRoutes(db));
  });

  afterEach(async () => {
    await db.collection('executions').deleteMany({});
  });

  afterAll(async () => {
    await client.close();
    await mongo.stop();
  });

  it('returns 403 IMPORTED_SESSION_READONLY when execution has meta.imported === true', async () => {
    const execId = 'imported-exec-001';

    // Seed an execution with imported flag
    await db.collection('executions').insertOne({
      id: execId,
      meta: { imported: true },
      status: 'waiting_for_input',
      workflowId: 'wf-1',
      workflowName: 'test',
      state: {},
      currentNodes: ['ask_user'],
      input: {},
      sessions: {},
      retryCounts: {},
      nodeAttempts: {},
      completedNodes: [],
      cost: { actual: null, estimated: 0 },
      durationMs: 0,
      startedAt: new Date(),
    });

    const res = await request(app)
      .post(`/api/executions/${execId}/input`)
      .send({ node: 'ask_user', data: { response: 'yes' } });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: 'IMPORTED_SESSION_READONLY',
      message: 'Cannot resume or retry imported execution records',
    });
  });

  it('returns 200 for non-imported execution', async () => {
    const execId = 'normal-exec-001';

    // Seed a normal execution (no meta.imported)
    await db.collection('executions').insertOne({
      id: execId,
      meta: {},
      status: 'waiting_for_input',
      workflowId: 'wf-1',
      workflowName: 'test',
      state: {},
      currentNodes: ['ask_user'],
      input: {},
      sessions: {},
      retryCounts: {},
      nodeAttempts: {},
      completedNodes: [],
      cost: { actual: null, estimated: 0 },
      durationMs: 0,
      startedAt: new Date(),
    });

    const res = await request(app)
      .post(`/api/executions/${execId}/input`)
      .send({ node: 'ask_user', data: { response: 'yes' } });

    // Should pass the guard and proceed to submitInput
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'input_received' });
  });
});
