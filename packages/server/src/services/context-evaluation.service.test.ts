import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ContextEvaluationService } from './context-evaluation.service.js';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpPath: string | undefined;

describe('ContextEvaluationService', () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  const originalSemanticEvaluator = process.env.ALLEN_CONTEXT_SEMANTIC_EVALUATOR;
  const originalSemanticMode = process.env.ALLEN_CONTEXT_SEMANTIC_MODE;
  const originalDeepEvalScript = process.env.ALLEN_DEEPEVAL_SCRIPT;
  const originalContextProvider = process.env.ALLEN_CONTEXT_PROVIDER;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    db = client.db('allen-context-evaluation-test');
  });

  beforeEach(async () => {
    process.env.ALLEN_CONTEXT_PROVIDER = 'graph';
    process.env.ALLEN_CONTEXT_SEMANTIC_EVALUATOR = originalSemanticEvaluator ?? '';
    if (originalSemanticMode === undefined) delete process.env.ALLEN_CONTEXT_SEMANTIC_MODE;
    else process.env.ALLEN_CONTEXT_SEMANTIC_MODE = originalSemanticMode;
    if (originalDeepEvalScript === undefined) delete process.env.ALLEN_DEEPEVAL_SCRIPT;
    else process.env.ALLEN_DEEPEVAL_SCRIPT = originalDeepEvalScript;
    if (tmpPath) rmSync(tmpPath, { recursive: true, force: true });
    tmpPath = undefined;
    await Promise.all([
      db.collection('node_context_packets').deleteMany({}),
      db.collection('context_usage_traces').deleteMany({}),
      db.collection('context_evaluation_traces').deleteMany({}),
      db.collection('execution_traces').deleteMany({}),
      db.collection('executions').deleteMany({}),
      db.collection('workflow_interventions').deleteMany({}),
    ]);
  });

  afterAll(async () => {
    if (tmpPath) rmSync(tmpPath, { recursive: true, force: true });
    if (originalSemanticEvaluator === undefined) delete process.env.ALLEN_CONTEXT_SEMANTIC_EVALUATOR;
    else process.env.ALLEN_CONTEXT_SEMANTIC_EVALUATOR = originalSemanticEvaluator;
    if (originalSemanticMode === undefined) delete process.env.ALLEN_CONTEXT_SEMANTIC_MODE;
    else process.env.ALLEN_CONTEXT_SEMANTIC_MODE = originalSemanticMode;
    if (originalDeepEvalScript === undefined) delete process.env.ALLEN_DEEPEVAL_SCRIPT;
    else process.env.ALLEN_DEEPEVAL_SCRIPT = originalDeepEvalScript;
    if (originalContextProvider === undefined) delete process.env.ALLEN_CONTEXT_PROVIDER;
    else process.env.ALLEN_CONTEXT_PROVIDER = originalContextProvider;
    await client.close();
    await mongo.stop();
  });

  it('persists deterministic quality scores and annotates the execution trace', async () => {
    await db.collection('node_context_packets').insertOne({
      packetId: 'packet-quality',
      executionId: 'exec-quality',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'implement',
      nodeRole: 'backend-developer',
      attempt: 1,
      repoId: 'repo-1',
      repoName: 'fixture-repo',
      indexId: 'index-1',
      selectedRefs: [
        { refId: 'ref-guidelines', kind: 'context_file', mandatory: true, path: 'docs/guidelines.md' },
        { refId: 'ref-prod', kind: 'production_note', mandatory: true, path: 'docs/prod.md' },
        { refId: 'ref-skill', kind: 'skill', path: '.claude/skills/backend/SKILL.md' },
      ],
      contextInjection: {
        injectedRefs: [
          { refId: 'ref-guidelines', kind: 'context_file', path: 'docs/guidelines.md', contentChars: 100 },
          { refId: 'ref-prod', kind: 'production_note', path: 'docs/prod.md', contentChars: 120 },
        ],
        totalChars: 220,
      },
      createdAt: new Date(),
    });
    await db.collection('context_usage_traces').insertOne({
      traceId: 'usage-quality',
      executionId: 'exec-quality',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'implement',
      nodeRole: 'backend-developer',
      attempt: 1,
      packetId: 'packet-quality',
      loaded: [{ refId: 'ref-guidelines', source: 'allen_system_injection' }],
      claimedUsed: [{ refId: 'ref-guidelines', summary: 'Followed backend guideline' }],
      reportedLoaded: [],
      reportedApplied: [],
      skipped: [],
      validationPerformed: ['npm test -- payments'],
      createdAt: new Date(),
    });
    await db.collection('execution_traces').insertOne({
      executionId: 'exec-quality',
      node: 'implement',
      agent: 'backend-developer',
      type: 'agent',
      attempt: 1,
      rawResponse: 'Implemented the change using the backend guideline.',
    });

    const service = new ContextEvaluationService(db);
    const result = await service.evaluateUsageTrace({
      executionId: 'exec-quality',
      nodeName: 'implement',
      attempt: 1,
      packetId: 'packet-quality',
      usageTraceId: 'usage-quality',
    });

    expect(result).toEqual(expect.objectContaining({
      executionId: 'exec-quality',
      nodeName: 'implement',
      status: 'warning',
      scores: expect.objectContaining({
        completeness: 1,
        groundedness: 1,
        correctness: 1,
        bloat: 0.5,
      }),
    }));
    expect((result?.diagnostics as Array<{ code: string }>).map((diag) => diag.code)).toContain('injected_context_unused');

    const stored = await db.collection('context_evaluation_traces').findOne({ packetId: 'packet-quality' });
    expect(stored?.usageTraceId).toBe('usage-quality');
    expect(stored?.semantic).toEqual(expect.objectContaining({ provider: 'none', status: 'disabled' }));

    const trace = await db.collection('execution_traces').findOne({ executionId: 'exec-quality', node: 'implement' });
    expect(trace?.contextEvaluation).toEqual(expect.objectContaining({
      status: 'warning',
      feedbackEvidenceCount: 0,
    }));
  });

  it('flags manifest-only claims without load evidence and reports retrieval lifecycle metrics', async () => {
    await db.collection('node_context_packets').insertOne({
      packetId: 'packet-manifest-only',
      executionId: 'exec-manifest-only',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'implement',
      nodeRole: 'backend-developer',
      attempt: 1,
      repoId: 'repo-1',
      repoName: 'fixture-repo',
      indexId: 'index-1',
      candidateRefs: [
        { refId: 'manifest-ref', providerId: 'cognee_memory' },
        { refId: 'graph-shadow-ref', providerId: 'cognee_memory', providerMetadata: { graphExpansion: true } },
      ],
      selectedRefs: [{
        refId: 'manifest-ref',
        kind: 'doc',
        providerId: 'cognee_memory',
        providerMetadata: { injectionPolicy: 'manifest_only' },
      }],
      rejectedRefs: [{
        refId: 'graph-shadow-ref',
        kind: 'doc',
        providerId: 'cognee_memory',
        providerMetadata: { graphExpansion: true, injectionPolicy: 'manifest_only' },
      }],
      contextInjection: { injectedRefs: [], totalChars: 0 },
      createdAt: new Date(),
    });
    await db.collection('context_usage_traces').insertOne({
      traceId: 'usage-manifest-only',
      executionId: 'exec-manifest-only',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'implement',
      nodeRole: 'backend-developer',
      attempt: 1,
      packetId: 'packet-manifest-only',
      loaded: [],
      claimedUsed: [{ refId: 'manifest-ref', summary: 'Used manifest-only summary' }],
      reportedLoaded: [],
      reportedApplied: [],
      skipped: [],
      validationPerformed: [],
      createdAt: new Date(),
    });

    const service = new ContextEvaluationService(db);
    const result = await service.evaluateUsageTrace({
      executionId: 'exec-manifest-only',
      nodeName: 'implement',
      attempt: 1,
      packetId: 'packet-manifest-only',
      usageTraceId: 'usage-manifest-only',
    });

    expect(result?.scores).toEqual(expect.objectContaining({
      candidateRecall: 1,
      manifestCompliance: 0,
      graphExpansionNoise: 1,
    }));
    expect(result?.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'manifest_ref_used_without_load', refIds: ['manifest-ref'] }),
      expect.objectContaining({ code: 'graph_expansion_noise', rejectedCount: 1 }),
    ]));
  });

  it('flags injectable refs that were selected for injection but never packed', async () => {
    await db.collection('node_context_packets').insertOne({
      packetId: 'packet-injectable-missing',
      executionId: 'exec-injectable-missing',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'implement',
      nodeRole: 'backend-developer',
      attempt: 1,
      repoId: 'repo-1',
      repoName: 'fixture-repo',
      indexId: 'index-1',
      selectedRefs: [{
        refId: 'snippet-ref',
        kind: 'doc',
        providerId: 'cognee_memory',
        providerMetadata: { injectionDecision: 'snippet' },
      }],
      injectableRefs: [{
        refId: 'snippet-ref',
        kind: 'doc',
        providerId: 'cognee_memory',
        providerMetadata: { injectionDecision: 'snippet' },
      }],
      contextInjection: { injectedRefs: [], skippedRefs: [], totalChars: 0 },
      createdAt: new Date(),
    });
    await db.collection('context_usage_traces').insertOne({
      traceId: 'usage-injectable-missing',
      executionId: 'exec-injectable-missing',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'implement',
      nodeRole: 'backend-developer',
      attempt: 1,
      packetId: 'packet-injectable-missing',
      loaded: [],
      claimedUsed: [],
      reportedLoaded: [],
      reportedApplied: [],
      skipped: [],
      validationPerformed: [],
      createdAt: new Date(),
    });

    const service = new ContextEvaluationService(db);
    const result = await service.evaluateUsageTrace({
      executionId: 'exec-injectable-missing',
      nodeName: 'implement',
      attempt: 1,
      packetId: 'packet-injectable-missing',
      usageTraceId: 'usage-injectable-missing',
    });

    expect(result?.scores).toEqual(expect.objectContaining({
      injectableFulfillment: 0,
    }));
    expect(result?.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'injectable_context_not_injected', refIds: ['snippet-ref'] }),
    ]));
    expect(result?.refScores).toEqual(expect.arrayContaining([
      expect.objectContaining({ refId: 'snippet-ref', injectable: true, injected: false }),
    ]));
  });

  it('attaches evaluation to the exact execution trace when node and attempt are duplicated', async () => {
    await insertEvaluationFixture(db, {
      executionId: 'exec-duplicate-trace',
      packetId: 'packet-duplicate-trace',
      usageTraceId: 'usage-duplicate-trace',
    });
    await db.collection('context_usage_traces').updateOne(
      { traceId: 'usage-duplicate-trace' },
      { $set: { executionTraceId: 'trace-new' } },
    );
    await db.collection('execution_traces').deleteMany({ executionId: 'exec-duplicate-trace' });
    await db.collection('execution_traces').insertMany([
      {
        executionId: 'exec-duplicate-trace',
        executionTraceId: 'trace-old',
        node: 'implement',
        agent: 'backend-developer',
        type: 'agent',
        attempt: 1,
        rawResponse: 'Old trace.',
      },
      {
        executionId: 'exec-duplicate-trace',
        executionTraceId: 'trace-new',
        node: 'implement',
        agent: 'backend-developer',
        type: 'agent',
        attempt: 1,
        rawResponse: 'New trace.',
      },
    ]);

    const service = new ContextEvaluationService(db);
    await service.evaluateUsageTrace({
      executionId: 'exec-duplicate-trace',
      executionTraceId: 'trace-new',
      nodeName: 'implement',
      attempt: 1,
      packetId: 'packet-duplicate-trace',
      usageTraceId: 'usage-duplicate-trace',
    });

    const oldTrace = await db.collection('execution_traces').findOne({ executionTraceId: 'trace-old' });
    const newTrace = await db.collection('execution_traces').findOne({ executionTraceId: 'trace-new' });
    const evaluation = await db.collection('context_evaluation_traces').findOne({ packetId: 'packet-duplicate-trace' });
    expect(oldTrace?.contextEvaluation).toBeUndefined();
    expect(newTrace?.contextEvaluation).toEqual(expect.objectContaining({ status: expect.any(String) }));
    expect(evaluation?.executionTraceId).toBe('trace-new');
  });

  it('uses human feedback as quality evidence during reevaluation', async () => {
    await db.collection('executions').insertOne({
      id: 'exec-feedback',
      workflowName: 'bug-investigate-and-fix',
      feedbackEntries: [{
        id: 'feedback-1',
        targetNodes: ['implement'],
        content: 'The backend developer should have used missing context from the production guidelines.',
        createdAt: new Date(),
      }],
      startedAt: new Date(),
    });
    await db.collection('node_context_packets').insertOne({
      packetId: 'packet-feedback',
      executionId: 'exec-feedback',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'implement',
      nodeRole: 'backend-developer',
      attempt: 1,
      repoId: 'repo-1',
      repoName: 'fixture-repo',
      indexId: 'index-1',
      selectedRefs: [{ refId: 'ref-prod', kind: 'production_note', mandatory: true }],
      contextInjection: { injectedRefs: [] },
      createdAt: new Date(),
    });
    await db.collection('context_usage_traces').insertOne({
      traceId: 'usage-feedback',
      executionId: 'exec-feedback',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'implement',
      nodeRole: 'backend-developer',
      attempt: 1,
      packetId: 'packet-feedback',
      loaded: [],
      claimedUsed: [],
      reportedLoaded: [],
      reportedApplied: [],
      skipped: [],
      validationPerformed: [],
      createdAt: new Date(),
    });

    const service = new ContextEvaluationService(db);
    await expect(service.reevaluateExecution('exec-feedback')).resolves.toBe(1);

    const stored = await db.collection('context_evaluation_traces').findOne({ packetId: 'packet-feedback' });
    expect(stored?.feedbackEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ classification: 'missing_context', source: 'execution_feedback' }),
    ]));
    expect(stored?.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'human_feedback_missing_context' }),
    ]));
  });

  it('marks node semantic evaluation as workflow-level by default', async () => {
    process.env.ALLEN_CONTEXT_SEMANTIC_EVALUATOR = 'deepeval';
    const script = writeDeepEvalScript('raise SystemExit("should not run inline")');
    process.env.ALLEN_DEEPEVAL_SCRIPT = script;
    await insertEvaluationFixture(db, {
      executionId: 'exec-queued',
      packetId: 'packet-queued',
      usageTraceId: 'usage-queued',
    });

    const service = new ContextEvaluationService(db);
    const result = await service.evaluateUsageTrace({
      executionId: 'exec-queued',
      nodeName: 'implement',
      attempt: 1,
      packetId: 'packet-queued',
      usageTraceId: 'usage-queued',
    });

    expect(result?.semantic).toEqual(expect.objectContaining({
      provider: 'deepeval',
      status: 'disabled',
      mode: 'workflow_summary',
    }));
    const stored = await db.collection('context_evaluation_traces').findOne({ packetId: 'packet-queued' });
    expect(stored?.semantic?.status).toBe('disabled');
  });

  it('runs queued semantic evaluations in the background and marks them completed', async () => {
    process.env.ALLEN_CONTEXT_SEMANTIC_EVALUATOR = 'deepeval';
    process.env.ALLEN_CONTEXT_SEMANTIC_MODE = 'per_node';
    process.env.ALLEN_DEEPEVAL_SCRIPT = writeDeepEvalScript(`
import json
print(json.dumps({"scores": {"precision": 0.8, "groundedness": 0.9}, "diagnostics": [{"code": "semantic_ok", "severity": "info"}]}))
`);
    await insertEvaluationFixture(db, {
      executionId: 'exec-semantic',
      packetId: 'packet-semantic',
      usageTraceId: 'usage-semantic',
    });
    const service = new ContextEvaluationService(db);
    const initial = await service.evaluateUsageTrace({
      executionId: 'exec-semantic',
      nodeName: 'implement',
      attempt: 1,
      packetId: 'packet-semantic',
      usageTraceId: 'usage-semantic',
    });

    await expect(service.runPendingSemanticEvaluations()).resolves.toBe(1);

    const stored = await db.collection('context_evaluation_traces').findOne({ traceId: initial?.traceId });
    expect(stored?.semantic).toEqual(expect.objectContaining({
      provider: 'deepeval',
      status: 'completed',
      attempts: 1,
      scores: expect.objectContaining({ precision: 0.8, groundedness: 0.9 }),
    }));
    expect(stored?.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'semantic_ok' }),
    ]));
    const trace = await db.collection('execution_traces').findOne({ executionId: 'exec-semantic', node: 'implement' });
    expect(trace?.contextEvaluation?.semantic?.status).toBe('completed');
  });

  it('marks semantic evaluation failures retryable and supports explicit retry', async () => {
    process.env.ALLEN_CONTEXT_SEMANTIC_EVALUATOR = 'deepeval';
    process.env.ALLEN_CONTEXT_SEMANTIC_MODE = 'per_node';
    process.env.ALLEN_DEEPEVAL_SCRIPT = writeDeepEvalScript('raise SystemExit("sidecar failed")');
    await insertEvaluationFixture(db, {
      executionId: 'exec-retry',
      packetId: 'packet-retry',
      usageTraceId: 'usage-retry',
    });
    const service = new ContextEvaluationService(db);
    const initial = await service.evaluateUsageTrace({
      executionId: 'exec-retry',
      nodeName: 'implement',
      attempt: 1,
      packetId: 'packet-retry',
      usageTraceId: 'usage-retry',
    });

    await expect(service.runSemanticEvaluation(String(initial?.traceId))).resolves.toEqual(expect.objectContaining({
      semantic: expect.objectContaining({ status: 'failed', attempts: 1 }),
    }));
    await expect(service.retrySemanticEvaluation(String(initial?.traceId))).resolves.toBe(true);
    process.env.ALLEN_DEEPEVAL_SCRIPT = writeDeepEvalScript('import json\nprint(json.dumps({"scores": {"usefulness": 1}, "diagnostics": []}))');
    await expect(service.runPendingSemanticEvaluations()).resolves.toBe(1);

    const stored = await db.collection('context_evaluation_traces').findOne({ traceId: initial?.traceId });
    expect(stored?.semantic).toEqual(expect.objectContaining({
      status: 'completed',
      attempts: 2,
      scores: expect.objectContaining({ usefulness: 1 }),
    }));
  });

  it('rolls node evaluations into execution-level averages and diagnostics', () => {
    const service = new ContextEvaluationService(db);
    const summary = service.rollup([
      {
        status: 'passed',
        executionId: 'exec-1',
        nodeName: 'investigate',
        packetId: 'packet-1',
        scores: { precision: 1, completeness: 1, usefulness: 0.5, groundedness: 1, correctness: 1, bloat: 0, overall: 0.9 },
        diagnostics: [],
      },
      {
        status: 'warning',
        executionId: 'exec-1',
        nodeName: 'implement',
        packetId: 'packet-2',
        scores: { precision: 0.5, completeness: 1, usefulness: 0, groundedness: 1, correctness: 1, bloat: 1, overall: 0.583 },
        diagnostics: [{ code: 'context_budget_bloat', severity: 'warn', message: 'unused context' }],
      },
    ]);

    expect(summary).toEqual(expect.objectContaining({
      nodeCount: 2,
      statusCounts: { passed: 1, warning: 1 },
      averageScores: expect.objectContaining({
        precision: 0.75,
        completeness: 1,
        bloat: 0.5,
      }),
    }));
    expect(summary.topDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'context_budget_bloat', nodeName: 'implement' }),
    ]));
  });
});

async function insertEvaluationFixture(
  db: Db,
  ids: { executionId: string; packetId: string; usageTraceId: string },
): Promise<void> {
  await db.collection('node_context_packets').insertOne({
    packetId: ids.packetId,
    executionId: ids.executionId,
    workflowName: 'bug-investigate-and-fix',
    nodeName: 'implement',
    nodeRole: 'backend-developer',
    attempt: 1,
    repoId: 'repo-1',
    repoName: 'fixture-repo',
    indexId: 'index-1',
    selectedRefs: [{ refId: 'ref-guidelines', kind: 'context_file', mandatory: true, path: 'docs/guidelines.md', summary: 'backend rule' }],
    contextInjection: {
      injectedRefs: [{ refId: 'ref-guidelines', kind: 'context_file', path: 'docs/guidelines.md', contentChars: 100 }],
      totalChars: 100,
    },
    createdAt: new Date(),
  });
  await db.collection('context_usage_traces').insertOne({
    traceId: ids.usageTraceId,
    executionId: ids.executionId,
    workflowName: 'bug-investigate-and-fix',
    nodeName: 'implement',
    nodeRole: 'backend-developer',
    attempt: 1,
    packetId: ids.packetId,
    loaded: [{ refId: 'ref-guidelines', source: 'allen_system_injection' }],
    claimedUsed: [{ refId: 'ref-guidelines', summary: 'Used backend rule' }],
    reportedLoaded: [],
    reportedApplied: [],
    skipped: [],
    validationPerformed: [],
    createdAt: new Date(),
  });
  await db.collection('execution_traces').insertOne({
    executionId: ids.executionId,
    node: 'implement',
    agent: 'backend-developer',
    type: 'agent',
    attempt: 1,
    rawResponse: 'Used backend rule.',
  });
}

function writeDeepEvalScript(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'allen-deepeval-script-'));
  tmpPath = dir;
  const scriptPath = join(dir, 'deepeval.py');
  writeFileSync(scriptPath, body);
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}
