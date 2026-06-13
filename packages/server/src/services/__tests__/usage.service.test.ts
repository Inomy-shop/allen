import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { UsageService } from '../usage.service.js';
import { invalidateModelCostCache } from '../model-cost.service.js';

describe('UsageService.computeUsage', () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;

  const FROM = new Date('2026-06-01T00:00:00Z');
  const TO = new Date('2026-06-10T00:00:00Z');
  const AT = new Date('2026-06-05T12:00:00Z');

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    db = client.db('allen-usage-test');
  });

  beforeEach(async () => {
    await Promise.all([
      db.collection('executions').deleteMany({}),
      db.collection('execution_traces').deleteMany({}),
      db.collection('chat_messages').deleteMany({}),
      db.collection('chat_sessions').deleteMany({}),
      db.collection('model_registry').deleteMany({}),
    ]);
    // getModelCostMap keeps a 30s module-level cache — clear it so each
    // test sees its own registry fixtures.
    invalidateModelCostCache();
  });

  afterAll(async () => {
    await client.close();
    await mongo.stop();
  });

  it('attributes chat, workflow, and agent usage once each, grouped by provider/model', async () => {
    const sessionId = new ObjectId();
    await db.collection('chat_sessions').insertOne({ _id: sessionId, provider: 'claude', model: 'opus' });
    await db.collection('chat_messages').insertOne({
      sessionId: sessionId.toString(), role: 'assistant', costUsd: 0.1,
      tokenUsage: { inputCachedTokens: 10, inputNonCachedTokens: 5, outputTokens: 2 },
      createdAt: AT,
    });

    await db.collection('executions').insertMany([
      { id: 'wf-1', workflowName: 'deploy' },
      // spawned from chat — counted as agent source, NOT chat
      { id: 'agent-1', workflowName: 'chat:spawn_agent/lead', meta: { chatSessionId: sessionId.toString() } },
    ]);
    await db.collection('execution_traces').insertMany([
      {
        executionId: 'wf-1', node: 'build', attempt: 1, type: 'agent', provider: 'claude',
        cost: { actual: 0.2, estimated: 0, model: 'sonnet', method: 'token_computed' },
        tokenUsage: { inputCachedTokens: 100, inputNonCachedTokens: 50, outputTokens: 20 },
        startedAt: AT,
      },
      {
        // retry attempt — separate row, also counted (real spend)
        executionId: 'wf-1', node: 'build', attempt: 2, type: 'agent', provider: 'claude',
        cost: { actual: 0.05, estimated: 0, model: 'sonnet', method: 'token_computed' },
        tokenUsage: { inputCachedTokens: 10, inputNonCachedTokens: 5, outputTokens: 2 },
        startedAt: AT,
      },
      {
        // sub-workflow link trace — must be ignored even with a legacy value
        executionId: 'wf-1', node: 'run_sub', attempt: 1, type: 'workflow',
        cost: { actual: 99, estimated: 99, method: 'child_execution' },
        startedAt: AT,
      },
      {
        executionId: 'agent-1', node: 'lead', attempt: 1, type: 'agent', provider: 'claude',
        cost: { actual: 0.4, estimated: 0, model: 'opus', method: 'token_computed' },
        tokenUsage: { inputCachedTokens: 200, inputNonCachedTokens: 80, outputTokens: 40 },
        startedAt: AT,
      },
    ]);

    const report = await new UsageService(db).computeUsage({ from: FROM, to: TO });

    expect(report.totals.costUsd).toBeCloseTo(0.75); // 0.1 chat + 0.25 workflow + 0.4 agent
    expect(report.totals.llmCalls).toBe(4);
    expect(report.bySource.chat.costUsd).toBeCloseTo(0.1);
    expect(report.bySource.workflow.costUsd).toBeCloseTo(0.25);
    expect(report.bySource.agent.costUsd).toBeCloseTo(0.4);

    const sonnet = report.byProviderModel.find((b) => b.model === 'sonnet');
    expect(sonnet?.provider).toBe('claude');
    expect(sonnet?.costUsd).toBeCloseTo(0.25);
    expect(sonnet?.llmCalls).toBe(2);
    expect(sonnet?.inputCachedTokens).toBe(110);

    const opus = report.byProviderModel.find((b) => b.model === 'opus');
    expect(opus?.costUsd).toBeCloseTo(0.5); // 0.1 chat + 0.4 agent on opus
    expect(opus?.bySource.chat.costUsd).toBeCloseTo(0.1);
    expect(opus?.bySource.agent.costUsd).toBeCloseTo(0.4);

    expect(report.series.length).toBeGreaterThan(0);
    expect(report.seriesUnit).toBe('day');
  });

  it('derives cost from registry prices for unpriced rows and respects the date range', async () => {
    await db.collection('model_registry').insertOne({
      provider: 'claude', alias: 'sonnet', fullId: 'claude-sonnet-4-6', isActive: true,
      costInputPerMTok: 3, costOutputPerMTok: 15, costCacheReadPerMTok: 0.3,
    });
    await db.collection('executions').insertOne({ id: 'wf-2', workflowName: 'scan' });
    await db.collection('execution_traces').insertMany([
      {
        // tokens reported, no priced cost → derive: (1M×3 + 1M×15 + 1M×0.3)/1M... use simple numbers
        executionId: 'wf-2', node: 'n', attempt: 1, type: 'agent', provider: 'claude',
        cost: { actual: null, estimated: 0, model: 'sonnet', method: 'unavailable' },
        tokenUsage: { inputCachedTokens: 1_000_000, inputNonCachedTokens: 1_000_000, outputTokens: 1_000_000 },
        startedAt: AT,
      },
      {
        // outside the range — excluded
        executionId: 'wf-2', node: 'n', attempt: 2, type: 'agent', provider: 'claude',
        cost: { actual: 5, estimated: 0, model: 'sonnet', method: 'token_computed' },
        tokenUsage: { inputCachedTokens: 1, inputNonCachedTokens: 1, outputTokens: 1 },
        startedAt: new Date('2026-07-01T00:00:00Z'),
      },
    ]);

    const report = await new UsageService(db).computeUsage({ from: FROM, to: TO });
    // 0.3 (cache) + 3 (input) + 15 (output) = 18.3
    expect(report.totals.costUsd).toBeCloseTo(18.3);
    expect(report.totals.llmCalls).toBe(1);
  });

  it('falls back to registry/inference for provider attribution', async () => {
    await db.collection('model_registry').insertOne({
      provider: 'deepseek', alias: 'deepseek-chat', isActive: true,
    });
    await db.collection('executions').insertOne({ id: 'wf-3', workflowName: 'x' });
    await db.collection('execution_traces').insertMany([
      {
        // no provider on trace or execution → registry lookup by model
        executionId: 'wf-3', node: 'a', attempt: 1, type: 'agent',
        cost: { actual: 0.1, estimated: 0, model: 'deepseek-chat', method: 'token_computed' },
        tokenUsage: { inputCachedTokens: 0, inputNonCachedTokens: 1, outputTokens: 1 },
        startedAt: AT,
      },
      {
        // unknown everywhere → 'unknown' bucket, still counted
        executionId: 'wf-3', node: 'b', attempt: 1, type: 'agent',
        cost: { actual: 0.2, estimated: 0, method: 'sdk_reported' },
        tokenUsage: { inputCachedTokens: 0, inputNonCachedTokens: 1, outputTokens: 1 },
        startedAt: AT,
      },
    ]);

    const report = await new UsageService(db).computeUsage({ from: FROM, to: TO });
    expect(report.byProviderModel.find((b) => b.model === 'deepseek-chat')?.provider).toBe('deepseek');
    const unknown = report.byProviderModel.find((b) => b.model === 'unknown');
    expect(unknown?.provider).toBe('unknown');
    expect(unknown?.costUsd).toBeCloseTo(0.2);
    expect(report.totals.costUsd).toBeCloseTo(0.3);
  });
});
