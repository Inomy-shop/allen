import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ContextEvaluationService } from '../../../../src/services/context/evaluation/context-evaluation.service.js';
import { ContextLifecycleStore } from '../../../../src/services/context/lifecycle/context-lifecycle-store.js';
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
      db.collection('context_attempts').deleteMany({}),
      db.collection('context_refs').deleteMany({}),
      db.collection('context_ref_events').deleteMany({}),
      db.collection('context_evaluations').deleteMany({}),
      db.collection('context_artifacts').deleteMany({}),
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
    await insertPacketFixture(db, {
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
    await insertUsageFixture(db, {
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

    const stored = await db.collection('context_evaluations').findOne({ packetId: 'packet-quality', active: true });
    expect(stored?.usageTraceId).toBe('usage-quality');
    expect(stored?.semantic).toEqual(expect.objectContaining({ provider: 'none', status: 'disabled' }));

    expect(stored).toEqual(expect.objectContaining({
      status: 'warning',
    }));
    expect(stored?.feedbackEvidence).toHaveLength(0);
  });

  it('flags manifest-only claims without load evidence and reports retrieval lifecycle metrics', async () => {
    await insertPacketFixture(db, {
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
    await insertUsageFixture(db, {
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
    expect(result?.contextLifecycle).toEqual(expect.arrayContaining([
      expect.objectContaining({
        refId: 'manifest-ref',
        providerId: 'cognee_memory',
        selected: true,
        applied: true,
        injected: false,
        loaded: false,
        injectionDecision: 'manifest_only',
      }),
      expect.objectContaining({
        refId: 'graph-shadow-ref',
        providerId: 'cognee_memory',
        rejected: true,
      }),
    ]));
  });

  it('treats provider-native mandatory refs as available without Allen body injection', async () => {
    await insertPacketFixture(db, {
      packetId: 'packet-provider-native',
      executionId: 'exec-provider-native',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'review',
      nodeRole: 'code-reviewer',
      attempt: 1,
      repoId: 'repo-1',
      repoName: 'fixture-repo',
      indexId: 'index-1',
      selectedRefs: [{
        refId: 'repo:claude-md',
        kind: 'instruction_file',
        mandatory: true,
        path: '.claude/CLAUDE.md',
        providerId: 'mandatory_graph',
      }],
      contextInjection: {
        injectedRefs: [],
        skippedProviderNativeRefs: [{
          refId: 'repo:claude-md',
          kind: 'instruction_file',
          mandatory: true,
          path: '.claude/CLAUDE.md',
          providerId: 'mandatory_graph',
          skipReason: 'provider_native',
        }],
        totalChars: 0,
      },
      createdAt: new Date(),
    });
    await insertUsageFixture(db, {
      traceId: 'usage-provider-native',
      executionId: 'exec-provider-native',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'review',
      nodeRole: 'code-reviewer',
      attempt: 1,
      packetId: 'packet-provider-native',
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
      executionId: 'exec-provider-native',
      nodeName: 'review',
      attempt: 1,
      packetId: 'packet-provider-native',
      usageTraceId: 'usage-provider-native',
    });

    expect(result?.scores).toEqual(expect.objectContaining({ completeness: 1 }));
    expect(result?.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'provider_native_context_available' }),
    ]));
    expect(result?.refScores).toEqual(expect.arrayContaining([
      expect.objectContaining({ refId: 'repo:claude-md', providerNative: true, score: 0.6 }),
    ]));
    expect(result?.contextLifecycle).toEqual(expect.arrayContaining([
      expect.objectContaining({ refId: 'repo:claude-md', providerNative: true, selected: true, skipReason: 'provider_native' }),
    ]));
  });

  it('flags injectable refs that were selected for injection but never packed', async () => {
    await insertPacketFixture(db, {
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
    await insertUsageFixture(db, {
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
      executionTraceId: 'trace-new',
    });
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
    const evaluation = await db.collection('context_evaluations').findOne({ packetId: 'packet-duplicate-trace', active: true });
    expect(oldTrace?.contextEvaluation).toBeUndefined();
    expect(newTrace?.contextEvaluation).toBeUndefined();
    expect(evaluation).toEqual(expect.objectContaining({ status: expect.any(String) }));
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
    await insertPacketFixture(db, {
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
    await insertUsageFixture(db, {
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

    const stored = await db.collection('context_evaluations').findOne({ packetId: 'packet-feedback', active: true });
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
    const stored = await db.collection('context_evaluations').findOne({ packetId: 'packet-queued', active: true });
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

    const stored = await db.collection('context_evaluations').findOne({ packetId: 'packet-semantic', active: true });
    expect(stored?.semantic).toEqual(expect.objectContaining({
      provider: 'deepeval',
      status: 'completed',
      attempts: 1,
      scores: expect.objectContaining({ precision: 0.8, groundedness: 0.9 }),
    }));
    expect(stored?.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'semantic_ok' }),
    ]));
    expect(stored?.semantic?.status).toBe('completed');
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
    const failed = await db.collection('context_evaluations').findOne({ packetId: 'packet-retry', active: true });
    await expect(service.retrySemanticEvaluation(String(failed?.traceId))).resolves.toBe(true);
    process.env.ALLEN_DEEPEVAL_SCRIPT = writeDeepEvalScript('import json\nprint(json.dumps({"scores": {"usefulness": 1}, "diagnostics": []}))');
    await expect(service.runPendingSemanticEvaluations()).resolves.toBe(1);

    const stored = await db.collection('context_evaluations').findOne({ packetId: 'packet-retry', active: true });
    expect(stored?.semantic).toEqual(expect.objectContaining({
      status: 'completed',
      attempts: 2,
      scores: expect.objectContaining({ usefulness: 1 }),
    }));
  });

  it('treats direct source file inspection as evidence for source refs', async () => {
    await insertPacketFixture(db, {
      packetId: 'packet-source-discovery',
      executionId: 'exec-source-discovery',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'investigate',
      nodeRole: 'bug-investigator',
      attempt: 1,
      repoId: 'repo-1',
      repoName: 'fixture-repo',
      indexId: 'index-1',
      selectedRefs: [{
        refId: 'source-ref',
        kind: 'source_file',
        itemType: 'repo_file',
        path: 'packages/server/src/services/vendor.service.ts',
        providerId: 'cognee_memory',
        providerMetadata: { injectionPolicy: 'manifest_only' },
      }],
      contextInjection: { injectedRefs: [], totalChars: 0 },
      createdAt: new Date(),
    });
    await insertUsageFixture(db, {
      traceId: 'usage-source-discovery',
      executionId: 'exec-source-discovery',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'investigate',
      nodeRole: 'bug-investigator',
      attempt: 1,
      packetId: 'packet-source-discovery',
      loaded: [],
      claimedUsed: [],
      reportedLoaded: [],
      reportedApplied: [],
      skipped: [],
      validationPerformed: [],
      createdAt: new Date(),
    });
    await db.collection('execution_traces').insertOne({
      executionId: 'exec-source-discovery',
      node: 'investigate',
      agent: 'bug-investigator',
      type: 'agent',
      attempt: 1,
      rawResponse: 'Inspected vendor.service.ts and found the root cause.',
      toolCalls: [{
        tool: 'Read',
        args: { path: 'packages/server/src/services/vendor.service.ts' },
        toolUseId: 'read-1',
      }],
    });

    const service = new ContextEvaluationService(db);
    const result = await service.evaluateUsageTrace({
      executionId: 'exec-source-discovery',
      nodeName: 'investigate',
      attempt: 1,
      packetId: 'packet-source-discovery',
      usageTraceId: 'usage-source-discovery',
    });

    expect(result?.scores).toEqual(expect.objectContaining({
      precision: 1,
      usefulness: 1,
      selectionPrecision: 1,
      bloat: 0,
    }));
    expect(result?.refScores).toEqual(expect.arrayContaining([
      expect.objectContaining({ refId: 'source-ref', sourceDiscovered: true, score: 0.7 }),
    ]));
    expect((result?.diagnostics as Array<{ code: string }>).map((diag) => diag.code)).not.toContain('low_context_precision');
  });

  it('drains queued per-node semantic evaluations after reevaluating an execution', async () => {
    process.env.ALLEN_CONTEXT_SEMANTIC_EVALUATOR = 'deepeval';
    process.env.ALLEN_CONTEXT_SEMANTIC_MODE = 'per_node';
    process.env.ALLEN_DEEPEVAL_SCRIPT = writeDeepEvalScript(`
import json
print(json.dumps({"scores": {"precision": 1, "usefulness": 1}, "diagnostics": [{"code": "semantic_drained", "severity": "info"}]}))
`);
    await insertEvaluationFixture(db, {
      executionId: 'exec-reeval-drain',
      packetId: 'packet-reeval-drain',
      usageTraceId: 'usage-reeval-drain',
    });

    const service = new ContextEvaluationService(db);
    await expect(service.reevaluateExecution('exec-reeval-drain')).resolves.toBe(1);

    const deadline = Date.now() + 5000;
    let stored = await db.collection('context_evaluations').findOne({ packetId: 'packet-reeval-drain', active: true });
    while (stored?.semantic?.status !== 'completed' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      stored = await db.collection('context_evaluations').findOne({ packetId: 'packet-reeval-drain', active: true });
    }

    expect(stored?.semantic).toEqual(expect.objectContaining({
      status: 'completed',
      scores: expect.objectContaining({ precision: 1, usefulness: 1 }),
    }));
    expect(stored?.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'semantic_drained' }),
    ]));
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
  ids: { executionId: string; packetId: string; usageTraceId: string; executionTraceId?: string },
): Promise<void> {
  await insertPacketFixture(db, {
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
  await insertUsageFixture(db, {
    traceId: ids.usageTraceId,
    executionId: ids.executionId,
    executionTraceId: ids.executionTraceId,
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

async function insertPacketFixture(db: Db, doc: Record<string, unknown>): Promise<void> {
  const lifecycle = new ContextLifecycleStore(db);
  const contextInjection = recordValue(doc.contextInjection);
  const selectedRefs = usageArray(doc.selectedRefs);
  const injectableRefs = usageArray(doc.injectableRefs);
  const rejectedRefs = usageArray(doc.rejectedRefs);
  const candidateRefs = usageArray(doc.candidateRefs);
  const injectedRefs = usageArray(contextInjection.injectedRefs);
  const providerNativeRefs = [
    ...usageArray(contextInjection.providerNativeRefs),
    ...usageArray(contextInjection.skippedProviderNativeRefs),
  ];
  const skippedRefs = [
    ...usageArray(contextInjection.skippedRefs),
    ...usageArray(contextInjection.skippedOversizeRefs),
  ];
  await lifecycle.saveAttemptFromPacket({
    packet: {
      packetId: String(doc.packetId),
      executionId: String(doc.executionId),
      workflowName: String(doc.workflowName ?? 'bug-investigate-and-fix'),
      nodeName: String(doc.nodeName),
      nodeRole: String(doc.nodeRole ?? ''),
      attempt: Number(doc.attempt ?? 1),
      repoId: String(doc.repoId ?? 'repo-1'),
      repoName: String(doc.repoName ?? 'fixture-repo'),
      repoPath: String(doc.repoPath ?? '/tmp/fixture-repo'),
      indexId: String(doc.indexId ?? 'index-1'),
      indexFreshness: String(doc.indexFreshness ?? 'fresh'),
      selectedRefs,
      injectableRefs,
      rejectedRefs,
      candidateRefs: candidateRefs.length > 0 ? candidateRefs : uniqueRefs([...selectedRefs, ...rejectedRefs]),
      availableRefs: usageArray(doc.availableRefs),
      providerTraces: [],
      providerDiagnostics: [],
      rerankerTraces: [],
      rerankerDiagnostics: [],
      rerankerProviders: [],
      retrievalProviders: ['fixture'],
      currentFiles: [],
      createdAt: doc.createdAt instanceof Date ? doc.createdAt : new Date(),
    } as never,
    injection: {
      injectionId: `injection-${String(doc.packetId)}`,
      graphVersion: String(doc.indexId ?? 'index-1'),
      provider: 'fixture',
      targetLayer: 'system_prompt',
      maxFileChars: Number(contextInjection.maxFileChars ?? 0),
      maxTotalChars: Number(contextInjection.maxTotalChars ?? 0),
      maxInjectedRefs: Number(contextInjection.maxInjectedRefs ?? 99),
      totalChars: Number(contextInjection.totalChars ?? 0),
      consideredRefs: uniqueRefs([...selectedRefs, ...injectableRefs]),
      injectedRefs,
      providerNativeRefs,
      skippedRefs,
      packingDecisions: usageArray(contextInjection.packingDecisions),
      packingDiagnostics: [],
      createdAt: new Date(),
    } as never,
    contextInjection,
    promptBlock: String(doc.promptBlock ?? ''),
    systemPromptBlock: String(doc.systemPromptBlock ?? ''),
  });
}

async function insertUsageFixture(db: Db, doc: Record<string, unknown>): Promise<void> {
  const lifecycle = new ContextLifecycleStore(db);
  await lifecycle.recordUsage({
    contextAttemptId: String(doc.packetId),
    usageTraceId: String(doc.traceId),
    executionId: String(doc.executionId),
    executionTraceId: typeof doc.executionTraceId === 'string' ? doc.executionTraceId : undefined,
    nodeName: String(doc.nodeName),
    attempt: Number(doc.attempt ?? 1),
    parsed: {
      loaded: usageArray(doc.loaded),
      applied: usageArray(doc.claimedUsed),
      reportedLoaded: usageArray(doc.reportedLoaded),
      reportedApplied: usageArray(doc.reportedApplied),
      skipped: usageArray(doc.skipped),
      contextBodyLoads: usageArray(doc.contextBodyLoads),
      skillBodyLoads: usageArray(doc.skillBodyLoads),
    },
    diagnostics: usageArray(doc.diagnostics),
  });
}

function usageArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    : [];
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function uniqueRefs(refs: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const out: Array<Record<string, unknown>> = [];
  for (const ref of refs) {
    const refId = typeof ref.refId === 'string' ? ref.refId : undefined;
    if (!refId || seen.has(refId)) continue;
    seen.add(refId);
    out.push(ref);
  }
  return out;
}

function writeDeepEvalScript(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'allen-deepeval-script-'));
  tmpPath = dir;
  const scriptPath = join(dir, 'deepeval.py');
  writeFileSync(scriptPath, body);
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}
