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
    await Promise.all([
      db.collection('context_attempts').deleteMany({}),
      db.collection('context_refs').deleteMany({}),
      db.collection('context_ref_events').deleteMany({}),
      db.collection('context_evaluations').deleteMany({}),
      db.collection('context_artifacts').deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await client.close();
    await mongo.stop();
  });

  it('hydrates missing trace summaries from matching evaluation rows', async () => {
    await db.collection('context_evaluations').insertOne({
      executionId: 'exec-hydrate',
      executionTraceId: 'trace-hydrate',
      traceId: 'eval-hydrate',
      evaluationId: 'evaluation-hydrate',
      scope: 'node',
      active: true,
      nodeName: 'qa',
      attempt: 1,
      status: 'warning',
      scores: { overall: 0.5 },
      diagnostics: [{ code: 'low_context_precision', severity: 'warn', message: 'Noisy context.' }],
      feedbackEvidence: [],
      validFrom: new Date(),
      validTo: null,
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

  it('attaches migrated normalized lifecycle data to traces without pointer fields', async () => {
    await db.collection('context_attempts').insertOne({
      contextAttemptId: 'packet-hydrate',
      executionId: 'exec-hydrate',
      workflowName: 'workflow',
      nodeName: 'qa',
      nodeRole: 'qa',
      attempt: 1,
      createdAt: new Date(),
    });
    await db.collection('context_refs').insertOne({
      contextAttemptId: 'packet-hydrate',
      executionId: 'exec-hydrate',
      nodeName: 'qa',
      attempt: 1,
      refId: 'ref-guidelines',
      path: 'docs/guidelines.md',
      mandatory: true,
      createdAt: new Date(),
    });
    await db.collection('context_ref_events').insertMany([
      {
        eventId: 'event-selected',
        contextAttemptId: 'packet-hydrate',
        packetId: 'packet-hydrate',
        refId: 'ref-guidelines',
        type: 'selected',
        executionId: 'exec-hydrate',
        nodeName: 'qa',
        attempt: 1,
        createdAt: new Date(),
      },
      {
        eventId: 'event-loaded',
        contextAttemptId: 'packet-hydrate',
        packetId: 'packet-hydrate',
        refId: 'ref-guidelines',
        type: 'loaded',
        usageTraceId: 'usage-hydrate',
        executionId: 'exec-hydrate',
        nodeName: 'qa',
        attempt: 1,
        createdAt: new Date(),
      },
    ]);

    const [trace] = await hydrateTraceContextEvaluations(db, 'exec-hydrate', [{
      executionId: 'exec-hydrate',
      node: 'qa',
      type: 'agent',
      attempt: 1,
    }]);

    expect(trace.contextAttemptId).toBe('packet-hydrate');
    expect(trace.contextUsage).toEqual(expect.objectContaining({
      loadedCount: 1,
      preselectedCount: 1,
    }));
    expect(trace.contextLifecycleAttempt).toEqual(expect.objectContaining({
      contextAttemptId: 'packet-hydrate',
      refs: expect.arrayContaining([
        expect.objectContaining({ refId: 'ref-guidelines', lifecycleStatus: 'loaded' }),
      ]),
    }));
  });
});
