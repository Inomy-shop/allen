import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { hydrateTraceContextEvaluations } from '../../../../src/services/context/evaluation/context-evaluation-trace-hydrator.js';

describe('hydrateTraceContextEvaluations', () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    db = client.db('allen-context-evaluation-hydrator-test');
  });

  beforeEach(async () => {
    await db.collection('context_evaluation_traces').deleteMany({});
  });

  afterAll(async () => {
    await client.close();
    await mongo.stop();
  });

  it('hydrates missing trace summaries from matching evaluation rows', async () => {
    await db.collection('context_evaluation_traces').insertOne({
      executionId: 'exec-hydrate',
      executionTraceId: 'trace-hydrate',
      traceId: 'eval-hydrate',
      nodeName: 'qa',
      attempt: 1,
      status: 'warning',
      scores: { overall: 0.5 },
      diagnostics: [{ code: 'low_context_precision', severity: 'warn', message: 'Noisy context.' }],
      feedbackEvidence: [],
      createdAt: new Date(),
    });

    const [trace] = await hydrateTraceContextEvaluations(db, 'exec-hydrate', [{
      executionId: 'exec-hydrate',
      executionTraceId: 'trace-hydrate',
      node: 'qa',
      type: 'agent',
      attempt: 1,
    }]);

    expect(trace.contextEvaluation).toEqual(expect.objectContaining({
      traceId: 'eval-hydrate',
      status: 'warning',
      scores: { overall: 0.5 },
    }));
  });
});
