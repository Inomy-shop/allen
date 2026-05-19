import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextWorkflowEvaluationService } from './context-workflow-evaluation.service.js';

vi.unmock('./chat-llm.js');

describe('ContextWorkflowEvaluationService', () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  const originalEvaluator = process.env.ALLEN_CONTEXT_SEMANTIC_EVALUATOR;
  const originalMode = process.env.ALLEN_CONTEXT_SEMANTIC_MODE;
  const originalScript = process.env.ALLEN_DEEPEVAL_WORKFLOW_SCRIPT;
  const originalSecret = process.env.JWT_ACCESS_SECRET;
  const originalContextProvider = process.env.ALLEN_CONTEXT_PROVIDER;
  let fakeScript: string;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    db = client.db('allen-context-workflow-evaluation-test');
    fakeScript = createFakeWorkflowDeepEvalScript();
  });

  beforeEach(async () => {
    process.env.ALLEN_CONTEXT_SEMANTIC_EVALUATOR = 'deepeval';
    process.env.ALLEN_DEEPEVAL_WORKFLOW_SCRIPT = fakeScript;
    process.env.JWT_ACCESS_SECRET = 'test-secret';
    process.env.ALLEN_CONTEXT_PROVIDER = 'allen';
    delete process.env.ALLEN_CONTEXT_SEMANTIC_MODE;
    await Promise.all([
      db.collection('executions').deleteMany({}),
      db.collection('execution_traces').deleteMany({}),
      db.collection('node_context_packets').deleteMany({}),
      db.collection('context_usage_traces').deleteMany({}),
      db.collection('context_evaluation_traces').deleteMany({}),
      db.collection('context_workflow_evaluation_jobs').deleteMany({}),
    ]);
  });

  afterAll(async () => {
    if (originalEvaluator === undefined) delete process.env.ALLEN_CONTEXT_SEMANTIC_EVALUATOR;
    else process.env.ALLEN_CONTEXT_SEMANTIC_EVALUATOR = originalEvaluator;
    if (originalMode === undefined) delete process.env.ALLEN_CONTEXT_SEMANTIC_MODE;
    else process.env.ALLEN_CONTEXT_SEMANTIC_MODE = originalMode;
    if (originalScript === undefined) delete process.env.ALLEN_DEEPEVAL_WORKFLOW_SCRIPT;
    else process.env.ALLEN_DEEPEVAL_WORKFLOW_SCRIPT = originalScript;
    if (originalSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
    else process.env.JWT_ACCESS_SECRET = originalSecret;
    if (originalContextProvider === undefined) delete process.env.ALLEN_CONTEXT_PROVIDER;
    else process.env.ALLEN_CONTEXT_PROVIDER = originalContextProvider;
    await client.close();
    await mongo.stop();
  });

  it('queues one workflow-level DeepEval job for a terminal execution', async () => {
    await insertWorkflowFixture(db, 'completed');
    const service = new ContextWorkflowEvaluationService(db);

    const job = await service.enqueueForExecution('exec-workflow');
    const second = await service.enqueueForExecution('exec-workflow');

    expect(job).toEqual(expect.objectContaining({
      executionId: 'exec-workflow',
      provider: 'deepeval',
      mode: 'workflow_summary',
      status: 'queued',
    }));
    expect(second?.jobId).toBe(job?.jobId);
    expect(await db.collection('context_workflow_evaluation_jobs').countDocuments({ executionId: 'exec-workflow' })).toBe(1);
  });

  it('runs the workflow-level evaluator through the DeepEval sidecar path', async () => {
    await insertWorkflowFixture(db, 'completed');
    await db.collection('execution_traces').insertOne({
      executionId: 'exec-workflow',
      node: 'qa',
      type: 'agent',
      attempt: 1,
      contextUsage: { traceId: 'usage-qa', loadedCount: 0, appliedCount: 0, skippedCount: 0 },
      startedAt: new Date(),
    });
    const service = new ContextWorkflowEvaluationService(db);
    await service.enqueueForExecution('exec-workflow');

    await expect(service.runPendingWorkflowEvaluations()).resolves.toBe(1);

    const stored = await db.collection('context_workflow_evaluation_jobs').findOne({ executionId: 'exec-workflow' });
    expect(stored).toEqual(expect.objectContaining({
      status: 'completed',
      result: expect.objectContaining({
        provider: 'deepeval',
        mode: 'workflow_summary',
        runner: 'python_deepeval',
        modelProvider: 'allen_codex',
        scores: expect.objectContaining({ precision: 0.75 }),
        nodeFindings: expect.arrayContaining([
          expect.objectContaining({ nodeName: 'implement', attempt: 1, status: 'warning', source: 'deepeval', identityNormalized: true }),
          expect.objectContaining({ nodeName: 'qa', attempt: 1, status: 'not_assessed', source: 'allen_fallback' }),
        ]),
        evaluationCoverage: expect.objectContaining({
          expectedNodeFindings: 2,
          returnedNodeFindings: 1,
          fallbackNodeFindings: 1,
        }),
      }),
      promptChars: expect.any(Number),
      promptSha256: expect.any(String),
      promptPreview: expect.stringContaining('Packed workflow evidence JSON:'),
      evidencePayload: expect.objectContaining({
        nodeContextPackets: expect.any(Array),
      }),
      packedEvidencePayload: expect.objectContaining({
        nodes: expect.any(Array),
      }),
      evidenceStats: expect.objectContaining({
        originalChars: expect.any(Number),
        packedChars: expect.any(Number),
      }),
    }));
    const exec = await db.collection('executions').findOne({ id: 'exec-workflow' });
    expect(exec?.contextWorkflowEvaluation).toEqual(expect.objectContaining({
      status: 'completed',
      result: expect.objectContaining({ summary: 'Workflow context was useful with minor bloat.' }),
    }));
  });

  it('marks workflow evaluation summaries stale after newer workflow changes', async () => {
    await insertWorkflowFixture(db, 'completed');
    const service = new ContextWorkflowEvaluationService(db);
    await service.enqueueForExecution('exec-workflow');
    await service.runPendingWorkflowEvaluations();
    await db.collection('execution_traces').insertOne({
      executionId: 'exec-workflow',
      node: 'qa',
      type: 'agent',
      attempt: 1,
      startedAt: new Date(Date.now() + 60_000),
      completedAt: new Date(Date.now() + 60_000),
    });

    const summary = await service.getSummaryForExecution('exec-workflow');

    expect(summary).toEqual(expect.objectContaining({
      stale: true,
      staleReason: expect.stringContaining('Workflow changed'),
    }));
  });

  it('does not queue workflow jobs when per-node mode is explicitly enabled', async () => {
    process.env.ALLEN_CONTEXT_SEMANTIC_MODE = 'per_node';
    await insertWorkflowFixture(db, 'completed');
    const service = new ContextWorkflowEvaluationService(db);

    await expect(service.enqueueForExecution('exec-workflow')).resolves.toBeNull();
  });
});

async function insertWorkflowFixture(db: Db, status: string): Promise<void> {
  await db.collection('executions').insertOne({
    id: 'exec-workflow',
    workflowName: 'bug-investigate-and-fix',
    status,
    input: { task: 'Fix refund idempotency' },
    state: { result: 'Implemented refund idempotency fix' },
    feedbackEntries: [],
    startedAt: new Date(),
    completedAt: new Date(),
  });
  await db.collection('node_context_packets').insertOne({
    packetId: 'packet-implement',
    executionId: 'exec-workflow',
    workflowName: 'bug-investigate-and-fix',
    nodeName: 'implement',
    nodeRole: 'backend-developer',
    attempt: 1,
    selectedRefs: [{ refId: 'ref-guidelines', path: 'docs/guidelines.md', mandatory: true }],
    contextInjection: { injectedRefs: [{ refId: 'ref-guidelines', contentChars: 100 }] },
    createdAt: new Date(),
  });
  await db.collection('context_usage_traces').insertOne({
    traceId: 'usage-implement',
    executionId: 'exec-workflow',
    nodeName: 'implement',
    attempt: 1,
    packetId: 'packet-implement',
    loaded: [{ refId: 'ref-guidelines' }],
    claimedUsed: [{ refId: 'ref-guidelines' }],
    createdAt: new Date(),
  });
  await db.collection('context_evaluation_traces').insertOne({
    traceId: 'eval-implement',
    executionId: 'exec-workflow',
    nodeName: 'implement',
    attempt: 1,
    packetId: 'packet-implement',
    status: 'passed',
    scores: { precision: 1, completeness: 1, usefulness: 1, groundedness: 1, correctness: 1, bloat: 0, overall: 1 },
    diagnostics: [],
    createdAt: new Date(),
  });
  await db.collection('execution_traces').insertOne({
    executionId: 'exec-workflow',
    node: 'implement',
    type: 'agent',
    attempt: 1,
    rawResponse: 'Implemented the fix using repo guidelines.',
    startedAt: new Date(),
  });
}

function createFakeWorkflowDeepEvalScript(): string {
  const dir = mkdtempSync(join(tmpdir(), 'allen-workflow-deepeval-'));
  const script = join(dir, 'fake-workflow-deepeval.py');
  writeFileSync(script, `#!/usr/bin/env python3
import json
import sys

payload = json.load(sys.stdin)
assert "DeepEval semantic evaluator" in payload["prompt"]
print(json.dumps({
  "status": "warning",
  "provider": "deepeval",
  "runner": "python_deepeval",
  "modelProvider": "allen_codex",
  "scores": {
    "precision": 0.75,
    "completeness": 1,
    "usefulness": 0.8,
    "groundedness": 0.9,
    "correctness": 1,
    "bloat": 0.2,
    "overall": 0.875
  },
  "diagnostics": [{"code": "context_ok", "severity": "info", "message": "Context was mostly relevant."}],
  "nodeFindings": [{"executionId": "exec-workflow", "nodeName": "implement attempt 1", "status": "warning", "summary": "One injected ref was not used."}],
  "summary": "Workflow context was useful with minor bloat."
}))
`);
  return script;
}
