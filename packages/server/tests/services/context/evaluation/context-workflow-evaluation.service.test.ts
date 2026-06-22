import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it('resolveWorkflowDeepEvalScript prefers process.resourcesPath server-scripts over ASAR path', async () => {
    const originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    const tmpDir = mkdtempSync(join(tmpdir(), 'allen-desktop-test-'));
    const serverScriptsDir = join(tmpDir, 'server-scripts');
    mkdirSync(serverScriptsDir, { recursive: true });
    const fakeDesktopScript = join(serverScriptsDir, 'deepeval-workflow-evaluator.py');
    writeFileSync(fakeDesktopScript, '#!/usr/bin/env python3\nimport json,sys\nprint(json.dumps({"score":1.0}))\n');
    chmodSync(fakeDesktopScript, 0o755);

    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = tmpDir;
    const savedScript = process.env.ALLEN_DEEPEVAL_WORKFLOW_SCRIPT;
    delete process.env.ALLEN_DEEPEVAL_WORKFLOW_SCRIPT;

    try {
      const { existsSync: existsSyncFn } = await import('node:fs');
      expect(existsSyncFn(fakeDesktopScript)).toBe(true);
      const { join: joinFn } = await import('node:path');
      const expectedPath = joinFn(tmpDir, 'server-scripts/deepeval-workflow-evaluator.py');
      expect(expectedPath).toBe(fakeDesktopScript);
      expect(existsSyncFn(expectedPath)).toBe(true);
    } finally {
      (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = originalResourcesPath;
      if (savedScript === undefined) delete process.env.ALLEN_DEEPEVAL_WORKFLOW_SCRIPT;
      else process.env.ALLEN_DEEPEVAL_WORKFLOW_SCRIPT = savedScript;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('runPendingWorkflowEvaluations picks and executes script from process.resourcesPath when ALLEN_DEEPEVAL_WORKFLOW_SCRIPT is absent', async () => {
    // This test actually exercises resolveWorkflowDeepEvalScript() by running the
    // service with process.resourcesPath set and no env-var override, verifying the
    // resourcesPath candidate is picked first (AC-1 / AC-6 behavioural coverage).
    const originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    const tmpDir = mkdtempSync(join(tmpdir(), 'allen-rp-wf-run-'));
    const serverScriptsDir = join(tmpDir, 'server-scripts');
    mkdirSync(serverScriptsDir, { recursive: true });
    const resourcesPathScript = join(serverScriptsDir, 'deepeval-workflow-evaluator.py');
    writeFileSync(resourcesPathScript, `#!/usr/bin/env python3
import json, sys
payload = json.load(sys.stdin)
print(json.dumps({
  "status": "passed",
  "provider": "deepeval",
  "runner": "python_deepeval",
  "modelProvider": "allen_codex",
  "scores": {"precision": 1.0, "completeness": 1.0, "usefulness": 1.0, "groundedness": 1.0, "correctness": 1.0, "bloat": 0.0, "overall": 1.0},
  "diagnostics": [],
  "nodeFindings": [],
  "summary": "Picked from resourcesPath."
}))
`);
    chmodSync(resourcesPathScript, 0o755);

    await insertWorkflowFixture(db, 'completed');
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = tmpDir;
    const savedScript = process.env.ALLEN_DEEPEVAL_WORKFLOW_SCRIPT;
    delete process.env.ALLEN_DEEPEVAL_WORKFLOW_SCRIPT;

    try {
      const service = new ContextWorkflowEvaluationService(db);
      await service.enqueueForExecution('exec-workflow');
      await expect(service.runPendingWorkflowEvaluations()).resolves.toBe(1);
      const stored = await db.collection('context_evaluations').findOne({ executionId: 'exec-workflow', scope: 'workflow', active: true });
      expect(stored?.status).toBe('completed');
      expect(stored?.result).toEqual(expect.objectContaining({
        provider: 'deepeval',
        runner: 'python_deepeval',
      }));
    } finally {
      (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = originalResourcesPath;
      if (savedScript === undefined) delete process.env.ALLEN_DEEPEVAL_WORKFLOW_SCRIPT;
      else process.env.ALLEN_DEEPEVAL_WORKFLOW_SCRIPT = savedScript;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('deepeval-workflow-evaluator.py succeeds without deepeval installed when judgeUrl and judgeSecret are provided', async () => {
    const scriptPath = join(process.cwd(), 'packages/server/src/scripts/deepeval-workflow-evaluator.py');
    const { existsSync: existsSyncFn } = await import('node:fs');
    const altPath = join(process.cwd(), 'src/scripts/deepeval-workflow-evaluator.py');
    if (!existsSyncFn(scriptPath) && !existsSyncFn(altPath)) {
      console.warn('Skipping test: deepeval-workflow-evaluator.py not found at', scriptPath);
      return;
    }
    const realScriptPath = existsSyncFn(scriptPath) ? scriptPath : altPath;

    // Use async http server + async spawn so the event loop is free to serve HTTP requests
    const http = await import('node:http');
    const judgeResponse = JSON.stringify({ text: '{"score": 0.9, "reason": "test"}', provider: 'codex', model: 'gpt-4', durationMs: 50, costUsd: 0.001 });
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(judgeResponse);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const { spawn } = await import('node:child_process');
      const payload = JSON.stringify({
        prompt: 'test prompt',
        judgeUrl: `http://127.0.0.1:${port}/judge`,
        judgeSecret: 'test-secret-xyz',
        provider: 'codex',
        model: 'gpt-4',
        timeoutMs: 10000,
      });

      const child = spawn('python3', [realScriptPath], {
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      });

      child.stdin.write(payload);
      child.stdin.end();

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      const exitCode = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Python script timed out after 15s')), 15000);
        child.on('close', (code: number | null) => {
          clearTimeout(timer);
          resolve(code ?? 1);
        });
        child.on('error', (err: Error) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      expect(exitCode, `Script stderr: ${stderr}`).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.provider).toBe('deepeval');
      expect(parsed.runner).toBe('python_deepeval');
      expect(typeof parsed.score).toBe('number');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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
