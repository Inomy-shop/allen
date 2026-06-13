import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { StateManager } from '@allen/engine';
import { CostRollupService } from '../cost-rollup.service.js';

/**
 * Cost singularity invariants:
 *  - DB stores cost only as per-LLM-run rows (execution_traces per node per
 *    attempt, chat_messages per assistant turn).
 *  - All totals are computed on demand by walking the execution tree.
 *  - Sub-workflow link traces (method 'child_execution') never contribute.
 */
describe('CostRollupService', () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    db = client.db('allen-cost-rollup-test');
  });

  beforeEach(async () => {
    await Promise.all([
      db.collection('executions').deleteMany({}),
      db.collection('execution_traces').deleteMany({}),
      db.collection('chat_messages').deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await client.close();
    await mongo.stop();
  });

  const trace = (executionId: string, node: string, attempt: number, costUsd: number, extra: Record<string, unknown> = {}) => ({
    executionId,
    node,
    attempt,
    status: 'completed',
    type: 'agent',
    cost: { actual: costUsd, estimated: 0, method: 'token_computed' },
    tokenUsage: { inputCachedTokens: 100, inputNonCachedTokens: 10, outputTokens: 5 },
    startedAt: new Date(),
    ...extra,
  });

  it('sums per-attempt traces and excludes child_execution link traces', async () => {
    await db.collection('execution_traces').insertMany([
      trace('e1', 'impl', 1, 0.1),
      trace('e1', 'impl', 2, 0.2), // retry — both attempts are real spend
      {
        // sub-workflow link trace: zero cost by contract, but even a legacy
        // value here must never be counted
        executionId: 'e1',
        node: 'run_child',
        attempt: 1,
        type: 'workflow',
        cost: { actual: 99, estimated: 99, method: 'child_execution' },
        startedAt: new Date(),
      },
    ]);

    const own = await new CostRollupService(db).getOwnCosts(['e1']);
    expect(own.get('e1')?.costUsd).toBeCloseTo(0.3);
    expect(own.get('e1')?.llmCalls).toBe(2);
    expect(own.get('e1')?.inputCachedTokens).toBe(200);
  });

  it('rolls up a 3-level spawn tree on demand: total == sum of every row\'s own traces', async () => {
    await db.collection('executions').insertMany([
      { id: 'lead', workflowName: 'chat:spawn_agent/lead' },
      { id: 'child-a', workflowName: 'lead:spawn_agent/a', parentExecutionId: 'lead' },
      { id: 'child-b', workflowName: 'lead:spawn_agent/b', parentExecutionId: 'lead' },
      { id: 'grandchild', workflowName: 'a:spawn_agent/g', parentExecutionId: 'child-a' },
    ]);
    await db.collection('execution_traces').insertMany([
      trace('lead', 'lead', 1, 1.0),
      trace('child-a', 'a', 1, 0.5),
      trace('child-b', 'b', 1, 0.25),
      trace('grandchild', 'g', 1, 0.125),
    ]);

    const tree = await new CostRollupService(db).getExecutionTreeCost('lead');
    expect(tree.own.costUsd).toBeCloseTo(1.0);       // lead's row stores ONLY its own spend
    expect(tree.total.costUsd).toBeCloseTo(1.875);   // tree computed on demand
    expect(tree.treeSize).toBe(4);

    const childA = tree.children.find(c => c.executionId === 'child-a');
    expect(childA?.total.costUsd).toBeCloseTo(0.625); // own + grandchild
  });

  it('counts a sub-workflow exactly once (link trace zero, child traces real)', async () => {
    await db.collection('executions').insertMany([
      { id: 'parent-wf', workflowName: 'main' },
      { id: 'child-wf', workflowName: 'sub', parentExecutionId: 'parent-wf' },
    ]);
    await db.collection('execution_traces').insertMany([
      trace('parent-wf', 'plan', 1, 0.4),
      {
        executionId: 'parent-wf', node: 'run_sub', attempt: 1, type: 'workflow',
        cost: { actual: null, estimated: 0, method: 'child_execution' },
        childExecutionId: 'child-wf', startedAt: new Date(),
      },
      trace('child-wf', 'step1', 1, 0.3),
      trace('child-wf', 'step2', 1, 0.2),
    ]);

    const svc = new CostRollupService(db);
    const tree = await svc.getExecutionTreeCost('parent-wf');
    expect(tree.own.costUsd).toBeCloseTo(0.4);
    expect(tree.total.costUsd).toBeCloseTo(0.9);

    // Dashboard-style global sum over traces equals true spend — no 2×/3×.
    const global = await db.collection('execution_traces').aggregate([
      { $match: { 'cost.method': { $ne: 'child_execution' } } },
      { $group: { _id: null, total: { $sum: { $ifNull: ['$cost.actual', 0] } } } },
    ]).toArray();
    expect(global[0].total).toBeCloseTo(0.9);
  });

  it('chat session total = own messages + linked execution trees, each counted once', async () => {
    await db.collection('chat_messages').insertMany([
      { sessionId: 's1', role: 'assistant', costUsd: 0.05, createdAt: new Date() },
      { sessionId: 's1', role: 'assistant', costUsd: 0.07, createdAt: new Date() },
      { sessionId: 'other', role: 'assistant', costUsd: 9, createdAt: new Date() },
    ]);
    await db.collection('executions').insertMany([
      { id: 'spawned', workflowName: 'chat:spawn_agent/lead', meta: { chatSessionId: 's1' } },
      // a child that ALSO carries the chat meta — must not be counted as a
      // second root (it's already inside the lead's tree)
      { id: 'spawned-child', workflowName: 'lead:spawn_agent/x', parentExecutionId: 'spawned', meta: { chatSessionId: 's1' } },
    ]);
    await db.collection('execution_traces').insertMany([
      trace('spawned', 'lead', 1, 0.5),
      trace('spawned-child', 'x', 1, 0.25),
    ]);

    const svc = new CostRollupService(db);
    const session = await svc.getChatSessionCost('s1');
    expect(session.messages.costUsd).toBeCloseTo(0.12);
    expect(session.executions).toHaveLength(1); // only the root
    expect(session.totalCostUsd).toBeCloseTo(0.87);

    const batch = await svc.getChatSessionsCostBatch(['s1']);
    expect(batch.get('s1')).toBeCloseTo(session.totalCostUsd);
  });

  it('recompute is idempotent — repeated reads never change stored rows', async () => {
    await db.collection('executions').insertOne({ id: 'e1', workflowName: 'wf' });
    await db.collection('execution_traces').insertOne(trace('e1', 'n', 1, 0.5));
    const svc = new CostRollupService(db);
    const a = await svc.getExecutionTreeCost('e1');
    const b = await svc.getExecutionTreeCost('e1');
    expect(b.total).toEqual(a.total);
    const rows = await db.collection('execution_traces').find({}).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].cost.actual).toBe(0.5);
  });
});

describe('StateManager cost stripping (store-single invariant)', () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    db = client.db('allen-state-manager-test');
  });

  afterAll(async () => {
    await client.close();
    await mongo.stop();
  });

  it('never persists cost/tokenUsage on execution rows', async () => {
    const sm = new StateManager(db);
    await sm.createExecution({
      id: 'exec-strip',
      workflowId: '',
      workflowName: 'wf',
      workflowVersion: 1,
      status: 'running',
      input: {},
      state: {},
      sessions: {},
      retryCounts: {},
      currentNodes: [],
      completedNodes: [],
      nodeAttempts: {},
      cost: { actual: 1.5, estimated: 2 },
      tokenUsage: { inputCachedTokens: 1, inputNonCachedTokens: 2, outputTokens: 3 },
      durationMs: 0,
      startedAt: new Date(),
    } as never);

    await sm.updateExecution('exec-strip', {
      status: 'completed',
      cost: { actual: 9, estimated: 9 },
    } as never);

    const row = await db.collection('executions').findOne({ id: 'exec-strip' });
    expect(row?.status).toBe('completed');
    expect(row?.cost).toBeUndefined();
    expect(row?.tokenUsage).toBeUndefined();
  });
});
