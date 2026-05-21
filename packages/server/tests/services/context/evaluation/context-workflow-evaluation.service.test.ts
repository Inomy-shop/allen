import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextWorkflowEvaluationService } from '../../../../src/services/context/evaluation/context-workflow-evaluation.service.js';
import { ContextLifecycleStore } from '../../../../src/services/context/lifecycle/context-lifecycle-store.js';

vi.unmock('../../../../src/services/chat-llm.js');

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
      db.collection('context_attempts').deleteMany({}),
      db.collection('context_refs').deleteMany({}),
      db.collection('context_ref_events').deleteMany({}),
      db.collection('context_evaluations').deleteMany({}),
      db.collection('context_artifacts').deleteMany({}),
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
      evaluationId: expect.any(String),
      traceId: expect.any(String),
    }));
    expect(second?.jobId).toBe(job?.jobId);
    expect(await db.collection('context_evaluations').countDocuments({ executionId: 'exec-workflow', scope: 'workflow', active: true })).toBe(1);
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

    const stored = await db.collection('context_evaluations').findOne({ executionId: 'exec-workflow', scope: 'workflow', active: true });
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
      evidenceStats: expect.objectContaining({
        originalChars: expect.any(Number),
        packedChars: expect.any(Number),
      }),
      artifactHashes: expect.objectContaining({
        deepevalEvidence: expect.any(String),
        deepevalPackedEvidence: expect.any(String),
        deepevalPrompt: expect.any(String),
      }),
    }));
    const summary = await service.getSummaryForExecution('exec-workflow');
    expect(summary).toEqual(expect.objectContaining({
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

  it('marks workflow evaluation summaries stale when evidence packing is outdated', async () => {
    await insertWorkflowFixture(db, 'completed');
    await db.collection('context_evaluations').insertOne({
      jobId: 'job-old-packing',
      executionId: 'exec-workflow',
      rootExecutionId: 'exec-workflow',
      provider: 'deepeval',
      mode: 'workflow_summary',
      scope: 'workflow',
      active: true,
      status: 'completed',
      attempts: 1,
      maxAttempts: 3,
      queuedAt: new Date(),
      completedAt: new Date(Date.now() + 60_000),
      evidenceStats: { packingVersion: 1 },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const service = new ContextWorkflowEvaluationService(db);

    const summary = await service.getSummaryForExecution('exec-workflow');

    expect(summary).toEqual(expect.objectContaining({
      stale: true,
      staleReason: expect.stringContaining('older evidence packing format'),
    }));
  });

  it('does not queue workflow jobs when per-node mode is explicitly enabled', async () => {
    process.env.ALLEN_CONTEXT_SEMANTIC_MODE = 'per_node';
    await insertWorkflowFixture(db, 'completed');
    const service = new ContextWorkflowEvaluationService(db);

    await expect(service.enqueueForExecution('exec-workflow')).resolves.toBeNull();
  });

  it('allows manual workflow evaluation reruns for non-terminal execution states', async () => {
    await insertWorkflowFixture(db, 'cancelled');
    const service = new ContextWorkflowEvaluationService(db);

    await expect(service.enqueueForExecution('exec-workflow')).resolves.toBeNull();

    const job = await service.enqueueForExecution('exec-workflow', 'manual_rerun', {
      force: true,
      allowAnyExecutionStatus: true,
    });

    expect(job).toEqual(expect.objectContaining({
      executionId: 'exec-workflow',
      status: 'queued',
      provider: 'deepeval',
      mode: 'workflow_summary',
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'workflow_semantic_queued',
          message: expect.stringContaining('manual_rerun'),
        }),
      ]),
    }));
  });
});

async function insertWorkflowFixture(db: Db, status: string): Promise<void> {
  const lifecycle = new ContextLifecycleStore(db);
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
  const ref = { refId: 'ref-guidelines', kind: 'context_file' as const, path: 'docs/guidelines.md', title: 'Guidelines', mandatory: true, providerId: 'mandatory_graph' };
  await lifecycle.saveAttemptFromPacket({
    packet: {
      packetId: 'packet-implement',
      executionId: 'exec-workflow',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'implement',
      nodeRole: 'backend-developer',
      attempt: 1,
      repoId: 'repo-1',
      repoName: 'repo',
      repoPath: '/repo',
      indexId: 'index-1',
      indexFreshness: 'fresh',
      selectedRefs: [ref],
      injectableRefs: [ref],
      rejectedRefs: [],
      availableRefs: [],
      candidateRefs: [ref],
      providerTraces: [],
      providerDiagnostics: [],
      rerankerTraces: [],
      rerankerDiagnostics: [],
      rerankerProviders: [],
      retrievalProviders: ['mandatory_graph'],
      currentFiles: [],
      createdAt: new Date(),
    },
    injection: {
      injectionId: 'injection-implement',
      graphVersion: 'index-1',
      provider: 'unknown',
      targetLayer: 'system_prompt',
      maxFileChars: 0,
      maxTotalChars: 0,
      maxInjectedRefs: 1,
      totalChars: 100,
      consideredRefs: [ref],
      injectedRefs: [{ ...ref, content: 'Use repo guidelines.', contentSha256: 'hash-guidelines', charCount: 20, packingDecision: 'injected' as const }],
      skippedRefs: [],
      providerNativeRefs: [],
      packingDecisions: [],
      packingDiagnostics: [],
      createdAt: new Date(),
    },
    contextInjection: { injectedRefs: [{ refId: 'ref-guidelines', contentChars: 100 }] },
    promptBlock: '',
    systemPromptBlock: '',
  });
  await lifecycle.recordUsage({
    contextAttemptId: 'packet-implement',
    usageTraceId: 'usage-implement',
    executionId: 'exec-workflow',
    nodeName: 'implement',
    attempt: 1,
    parsed: {
      loaded: [{ refId: 'ref-guidelines' }],
      applied: [{ refId: 'ref-guidelines' }],
    },
  });
  await lifecycle.saveEvaluationVersion({
    evaluation: {
      traceId: 'eval-implement',
      contextAttemptId: 'packet-implement',
      usageTraceId: 'usage-implement',
      executionId: 'exec-workflow',
      nodeName: 'implement',
      attempt: 1,
      status: 'passed',
      scores: { precision: 1, completeness: 1, usefulness: 1, groundedness: 1, correctness: 1, bloat: 0, overall: 1 },
      diagnostics: [],
    },
  });
  await db.collection('execution_traces').insertOne({
    executionId: 'exec-workflow',
    node: 'implement',
    type: 'agent',
    attempt: 1,
    contextAttemptId: 'packet-implement',
    contextUsageTraceId: 'usage-implement',
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
