import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ContextLifecycleStore } from '../../../../src/services/context/lifecycle/context-lifecycle-store.js';

describe('ContextLifecycleStore', () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    db = client.db('allen-context-lifecycle-test');
    await db.collection('context_attempts').createIndex({ contextAttemptId: 1 }, { unique: true });
    await db.collection('context_refs').createIndex({ contextAttemptId: 1, refId: 1 }, { unique: true });
  });

  beforeEach(async () => {
    await Promise.all([
      db.collection('context_attempts').deleteMany({}),
      db.collection('context_refs').deleteMany({}),
      db.collection('context_ref_events').deleteMany({}),
      db.collection('context_evaluations').deleteMany({}),
      db.collection('context_artifacts').deleteMany({}),
      db.collection('execution_traces').deleteMany({}),
      db.collection('executions').deleteMany({}),
      db.collection('chat_sessions').deleteMany({}),
      db.collection('chat_messages').deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await client.close();
    await mongo.stop();
  });

  it('stores one attempt row, one ref row, append-only events, and hashed content artifacts', async () => {
    const store = new ContextLifecycleStore(db);
    await store.saveAttemptFromPacket(sampleAttempt());

    expect(await db.collection('context_attempts').countDocuments({ contextAttemptId: 'attempt-1' })).toBe(1);
    expect(await db.collection('context_refs').countDocuments({ contextAttemptId: 'attempt-1', refId: 'ref-1' })).toBe(1);
    expect(await db.collection('context_ref_events').countDocuments({ contextAttemptId: 'attempt-1', refId: 'ref-1' })).toBeGreaterThanOrEqual(3);
    expect(await db.collection('context_ref_events').countDocuments({ contextAttemptId: 'attempt-1', refId: 'ref-2', type: 'filtered' })).toBe(1);
    expect(await db.collection('context_artifacts').countDocuments({ kind: 'ref_content' })).toBe(1);
    expect(await db.collection('context_artifacts').countDocuments({ kind: 'context_query' })).toBe(1);
    expect(await db.collection('context_artifacts').countDocuments({ kind: 'context_query_intent' })).toBe(1);

    await store.recordSourceDiscoveryFromTrace({
      contextAttemptId: 'attempt-1',
      usageTraceId: 'usage-1',
      executionTraceId: 'trace-1',
      trace: {
        toolCalls: [
          {
            tool: 'exec_command',
            args: { command: 'sed -n 1,80p packages/server/src/guidelines.ts' },
            toolUseId: 'tool-1',
          },
        ],
      },
    });
    const usage = await store.getUsageView('attempt-1', 'usage-1');
    expect(usage?.sourceDiscoveryEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: 'exec_command',
        paths: expect.arrayContaining(['packages/server/src/guidelines.ts']),
      }),
    ]));

    const directPacket = await store.getAttemptPacketView('attempt-1');
    const directUsage = await store.getUsageView('attempt-1');
    const report = await store.getExecutionContextUsageReport('exec-1');
    expect(report.nodeAttempts).toEqual([
      expect.objectContaining({
        contextAttemptId: 'attempt-1',
        contextQuery: expect.objectContaining({
          role: 'backend-developer',
          roleFamily: 'backend',
          renderedQueryHash: 'query-hash',
          queryIntentHash: 'intent-hash',
          renderedQueryUrl: '/api/context/attempts/attempt-1/query',
          queryIntentUrl: '/api/context/attempts/attempt-1/query-intent',
        }),
        refs: expect.arrayContaining([
          expect.objectContaining({
            refId: 'ref-1',
            isMandatory: true,
            isInjected: true,
            injectionMode: 'full',
            sourceDiscovered: true,
            contentAvailable: true,
            contentUrl: '/api/context/attempts/attempt-1/refs/ref-1/content',
          }),
          expect.objectContaining({
            refId: 'ref-2',
            isFiltered: true,
            lifecycleStatus: 'filtered',
            filterReason: 'below score threshold',
            filterStage: 'threshold',
          }),
        ]),
      }),
    ]);
    expect(report.packets).toEqual([
      expect.objectContaining({
        contextAttemptId: directPacket?.contextAttemptId,
        contextQuery: directPacket?.contextQuery,
        selectedRefs: directPacket?.selectedRefs,
        filteredRefs: directPacket?.filteredRefs,
        rejectedRefs: directPacket?.rejectedRefs,
        candidateRefs: directPacket?.candidateRefs,
        lifecycle: directPacket?.lifecycle,
        contextInjection: expect.objectContaining({
          injectedRefs: directPacket?.contextInjection?.injectedRefs,
          skippedRefs: directPacket?.contextInjection?.skippedRefs,
          providerNativeRefs: directPacket?.contextInjection?.providerNativeRefs,
        }),
      }),
    ]);
    expect(report.usage).toEqual([
      expect.objectContaining({
        contextAttemptId: directUsage?.contextAttemptId,
        contextPreselected: directUsage?.contextPreselected,
        loaded: directUsage?.loaded,
        claimedUsed: directUsage?.claimedUsed,
        reportedLoaded: directUsage?.reportedLoaded,
        reportedApplied: directUsage?.reportedApplied,
        sourceDiscovery: directUsage?.sourceDiscovery,
        sourceDiscoveryEvidence: directUsage?.sourceDiscoveryEvidence,
        skipped: directUsage?.skipped,
        contextBodyLoads: directUsage?.contextBodyLoads,
        skillBodyLoads: directUsage?.skillBodyLoads,
      }),
    ]);
    const query = await store.getAttemptQueryContent('attempt-1', 'query');
    const intent = await store.getAttemptQueryContent('attempt-1', 'intent');
    expect(query).toEqual(expect.objectContaining({ content: expect.stringContaining('Retrieval signals: Fix payment writes') }));
    expect(intent?.content).toContain('"role":"backend-developer"');
  });

  it('returns summary, normalized, and attempt evidence views without dropping evidence handles', async () => {
    const store = new ContextLifecycleStore(db);
    await store.saveAttemptFromPacket(sampleAttempt());
    const sessionId = new ObjectId();
    const userMessageId = new ObjectId();
    const assistantMessageId = new ObjectId();
    await db.collection('chat_sessions').insertOne({
      _id: sessionId,
      title: 'Context evidence chat',
      source: 'ui',
      provider: 'codex',
      model: 'gpt-test',
      messageCount: 2,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:02.000Z'),
    });
    await db.collection('chat_messages').insertMany([
      {
        _id: userMessageId,
        sessionId: sessionId.toHexString(),
        role: 'user',
        content: 'User asked for a context-faithful implementation.',
        status: 'completed',
        createdAt: new Date('2026-01-01T00:00:01.000Z'),
      },
      {
        _id: assistantMessageId,
        sessionId: sessionId.toHexString(),
        role: 'assistant',
        content: 'Assistant response linked to the execution.',
        status: 'completed',
        toolCalls: [{ tool: 'run_workflow', result: { id: 'exec-1' } }],
        createdAt: new Date('2026-01-01T00:00:02.000Z'),
        completedAt: new Date('2026-01-01T00:00:03.000Z'),
      },
    ]);
    await db.collection('executions').insertOne({
      id: 'exec-1',
      status: 'completed',
      source: 'chat',
      meta: { chatSessionId: sessionId.toHexString(), parentMessageId: assistantMessageId.toHexString() },
    });
    await db.collection('execution_traces').insertOne({
      executionId: 'exec-1',
      executionTraceId: 'trace-1',
      type: 'agent',
      node: 'implement',
      agent: 'backend-developer',
      attempt: 1,
      contextAttemptId: 'attempt-1',
      inputState: { prompt: 'input-state prompt' },
      output: { final: 'final response object' },
      toolCalls: [{ tool: 'read_file', args: { path: 'packages/server/src/file.ts' } }],
      startedAt: new Date(),
    });
    await db.collection('context_source_evaluations').insertOne({
      sourceId: 'attempt-1',
      contextAttemptId: 'attempt-1',
      decision: 'no_issue',
      contextVerdict: 'correct',
      createdAt: new Date(),
    });
    await db.collection('context_findings').insertOne({
      findingId: 'finding-1',
      primarySourceId: 'attempt-1',
      contextAttemptId: 'attempt-1',
      classification: 'incomplete_context',
      status: 'open',
      createdAt: new Date(),
    });

    const summary = await store.getExecutionContextUsageReport('exec-1', { view: 'summary' });
    expect(summary).toEqual(expect.objectContaining({
      view: 'summary',
      counts: expect.objectContaining({ attempts: 1, refs: 2, events: expect.any(Number) }),
      nodeSummaries: expect.arrayContaining([expect.objectContaining({ contextAttemptId: 'attempt-1' })]),
      nodeAttempts: expect.arrayContaining([expect.objectContaining({ contextAttemptId: 'attempt-1' })]),
    }));
    expect(summary).not.toHaveProperty('refs');
    expect(summary).not.toHaveProperty('events');

    const normalized = await store.getExecutionContextUsageReport('exec-1', { view: 'normalized' });
    expect(normalized).toEqual(expect.objectContaining({
      view: 'normalized',
      attemptsById: expect.objectContaining({ 'attempt-1': expect.any(Object) }),
      refsById: expect.objectContaining({ 'attempt-1:ref-1': expect.any(Object) }),
      views: expect.objectContaining({
        selectedRefs: expect.arrayContaining(['attempt-1:ref-1']),
      }),
    }));

    const evidence = await store.getAttemptEvidence('attempt-1');
    expect(evidence).toEqual(expect.objectContaining({
      contextAttemptId: 'attempt-1',
      usage: expect.objectContaining({ contextAttemptId: 'attempt-1' }),
      completeness: expect.objectContaining({
        injectedContextIncluded: true,
        fullRenderedPromptIncluded: true,
        fullRenderedPromptAvailable: true,
        rawResponseIncluded: true,
        rawResponseAvailable: true,
        toolPayloadsIncluded: true,
        toolPayloadsAvailable: true,
        fullArtifactBodiesIncluded: true,
        sourceEvaluationsIncluded: true,
        priorFindingsIncluded: true,
        chatEvidenceIncluded: true,
        chatEvidenceAvailable: true,
      }),
      chatEvidence: expect.objectContaining({
        sessionId: sessionId.toHexString(),
        parentMessageId: assistantMessageId.toHexString(),
        messagesIncluded: true,
        messagesAvailable: true,
        handles: expect.objectContaining({
          chatSessionTool: 'get_chat_session',
          chatSessionArgs: { session_id: sessionId.toHexString() },
          chatMessagesTool: 'get_chat_messages',
          chatMessagesArgs: expect.objectContaining({ session_id: sessionId.toHexString() }),
          messageContentHandles: expect.arrayContaining([
            expect.objectContaining({
              tool: 'get_chat_messages',
              args: expect.objectContaining({ session_id: sessionId.toHexString() }),
            }),
          ]),
        }),
        messages: expect.arrayContaining([
          expect.objectContaining({
            messageId: userMessageId.toHexString(),
            role: 'user',
            content: 'User asked for a context-faithful implementation.',
            contentHandle: expect.objectContaining({ tool: 'get_chat_messages' }),
          }),
          expect.objectContaining({ messageId: assistantMessageId.toHexString(), role: 'assistant', content: 'Assistant response linked to the execution.' }),
        ]),
      }),
      traceEvidence: expect.arrayContaining([
        expect.objectContaining({
          renderedPrompt: 'input-state prompt',
          output: { final: 'final response object' },
          toolCalls: expect.arrayContaining([expect.objectContaining({ tool: 'read_file' })]),
        }),
      ]),
      artifactBodiesByHash: expect.any(Object),
      refContentById: expect.objectContaining({
        'ref-1': expect.objectContaining({ content: 'hello world' }),
      }),
      sourceEvaluations: expect.arrayContaining([expect.objectContaining({ decision: 'no_issue' })]),
      priorFindings: expect.arrayContaining([expect.objectContaining({ findingId: 'finding-1' })]),
      handles: expect.objectContaining({
        artifactContentBaseUrl: '/api/context/artifacts/{hash}',
        renderedContextQueryUrl: '/api/context/attempts/attempt-1/query',
        nodeTraceTool: 'get_node_trace',
      }),
    }));
    const artifactBody = Object.values(evidence?.artifactBodiesByHash as Record<string, any>)
      .find((body: any) => body.kind === 'ref_content') as any;
    expect(artifactBody.contentHandle).toEqual(expect.objectContaining({
      url: expect.stringMatching(/^\/api\/context\/artifacts\//),
      tool: 'query_database',
      args: expect.objectContaining({ collection: 'context_artifacts' }),
    }));
    expect((evidence?.views as any).injectedRefs[0]).toEqual(expect.objectContaining({ refId: 'ref-1', content: 'hello world' }));
  });

  it('stores Cognee scores only for Cognee refs and keeps rerank metadata from rejected snapshots', async () => {
    const store = new ContextLifecycleStore(db);
    await store.saveAttemptFromPacket(scorePersistenceAttempt());

    const mandatory = await db.collection('context_refs').findOne({ contextAttemptId: 'attempt-scores', refId: 'mandatory-ref' });
    expect(mandatory).toEqual(expect.objectContaining({
      providerId: 'mandatory_graph',
      score: 12140,
    }));
    expect(mandatory?.cogneeScore).toBeUndefined();

    const rejectedCognee = await db.collection('context_refs').findOne({ contextAttemptId: 'attempt-scores', refId: 'cognee:low-rerank' });
    expect(await db.collection('context_refs').countDocuments({ contextAttemptId: 'attempt-scores', refId: 'cognee:low-rerank' })).toBe(1);
    expect(rejectedCognee).toEqual(expect.objectContaining({
      providerId: 'cognee_memory',
      score: 0.76,
      cogneeScore: 0.76,
      rerankerScore: 0.05,
      filterReason: 'below_rerank_threshold',
      filterStage: 'selection',
      injectionPolicy: 'injectable',
      rerank: expect.objectContaining({
        providerId: 'bge',
        rerankScore: 0.05,
        finalRelevanceScore: 0.36,
      }),
      providerMetadata: expect.objectContaining({
        retrievalScore: 0.76,
        rejectionReason: 'below_rerank_threshold',
        rejectionThreshold: 0.45,
      }),
    }));
  });

  it('expires active evaluation rows and inserts a new active version on rerun', async () => {
    const store = new ContextLifecycleStore(db);
    await store.saveAttemptFromPacket(sampleAttempt());
    await store.saveEvaluationVersion({
      evaluation: {
        contextAttemptId: 'attempt-1',
        usageTraceId: 'usage-1',
        executionId: 'exec-1',
        nodeName: 'implement',
        attempt: 1,
        status: 'warning',
        scores: { overall: 0.4 },
      },
    });
    await store.saveEvaluationVersion({
      evaluation: {
        contextAttemptId: 'attempt-1',
        usageTraceId: 'usage-1',
        executionId: 'exec-1',
        nodeName: 'implement',
        attempt: 1,
        status: 'passed',
        scores: { overall: 0.9 },
      },
    });

    expect(await db.collection('context_evaluations').countDocuments({ contextAttemptId: 'attempt-1' })).toBe(2);
    expect(await db.collection('context_evaluations').countDocuments({ contextAttemptId: 'attempt-1', active: true })).toBe(1);
    const active = await db.collection('context_evaluations').findOne({ contextAttemptId: 'attempt-1', active: true });
    expect(active).toEqual(expect.objectContaining({ status: 'passed', version: 2 }));
  });

  it('replaces workflow evaluations without carrying persistence fields into the new version', async () => {
    const store = new ContextLifecycleStore(db);
    await db.collection('context_evaluations').insertOne({
      executionId: 'exec-workflow',
      rootExecutionId: 'exec-workflow',
      jobId: 'job-1',
      evaluationId: 'eval-old',
      traceId: 'trace-old',
      scope: 'workflow',
      provider: 'deepeval',
      mode: 'workflow_summary',
      status: 'queued',
      active: true,
      version: 1,
      queuedAt: new Date(),
      validFrom: new Date(),
      validTo: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const existing = await db.collection('context_evaluations').findOne({ jobId: 'job-1', active: true });

    const completed = await store.replaceWorkflowEvaluation({
      executionId: 'exec-workflow',
      rootExecutionId: 'exec-workflow',
      job: {
        ...existing,
        status: 'completed',
        result: { status: 'passed' },
        completedAt: new Date(),
      },
    });

    expect(completed).toEqual(expect.objectContaining({
      status: 'completed',
      active: true,
      version: 2,
      workflowJobId: 'job-1',
      previousEvaluationId: 'eval-old',
      previousTraceId: 'trace-old',
    }));
    expect(await db.collection('context_evaluations').countDocuments({ executionId: 'exec-workflow', scope: 'workflow', active: true })).toBe(1);
    const active = await db.collection('context_evaluations').findOne({ executionId: 'exec-workflow', scope: 'workflow', active: true });
    expect(active).toEqual(expect.objectContaining({ status: 'completed', result: { status: 'passed' } }));
    expect(String(active?._id)).not.toBe(String(existing?._id));
    const old = await db.collection('context_evaluations').findOne({ _id: existing?._id });
    expect(old).toEqual(expect.objectContaining({ active: false, status: 'queued' }));
  });

  it('keeps the existing active workflow evaluation visible when replacement insertion fails', async () => {
    const store = new ContextLifecycleStore(db);
    await db.collection('context_evaluations').insertOne({
      executionId: 'exec-workflow',
      rootExecutionId: 'exec-workflow',
      jobId: 'job-1',
      evaluationId: 'eval-old',
      traceId: 'trace-old',
      scope: 'workflow',
      provider: 'deepeval',
      mode: 'workflow_summary',
      status: 'running',
      active: true,
      version: 1,
      queuedAt: new Date(),
      validFrom: new Date(),
      validTo: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const unsafeStore = store as unknown as { evaluations: { insertOne: (row: Record<string, unknown>) => Promise<unknown> } };
    const insertSpy = vi.spyOn(unsafeStore.evaluations, 'insertOne').mockRejectedValueOnce(new Error('insert failed'));

    await expect(store.replaceWorkflowEvaluation({
      executionId: 'exec-workflow',
      rootExecutionId: 'exec-workflow',
      job: {
        jobId: 'job-1',
        status: 'completed',
        result: { status: 'passed' },
      },
    })).rejects.toThrow('insert failed');
    insertSpy.mockRestore();

    const active = await db.collection('context_evaluations').findOne({ executionId: 'exec-workflow', scope: 'workflow', active: true });
    expect(active).toEqual(expect.objectContaining({ status: 'running', jobId: 'job-1' }));
    expect(await db.collection('context_evaluations').countDocuments({ executionId: 'exec-workflow', scope: 'workflow' })).toBe(1);
  });
});

function sampleAttempt() {
  const ref = {
    refId: 'ref-1',
    kind: 'source_file' as const,
    title: 'Guidelines',
    path: 'packages/server/src/guidelines.ts',
    summary: 'Repo rules',
    tags: ['rules'],
    providerId: 'mandatory_graph',
    source: 'mandatory_graph',
    reason: 'Mandatory for role',
    score: 1,
    loadable: true,
    mandatory: true,
  };
  const filteredRef = {
    refId: 'ref-2',
    kind: 'source_file' as const,
    title: 'Low score',
    path: 'packages/server/src/low-score.ts',
    providerId: 'cognee',
    reason: 'below score threshold',
    score: 0.1,
    providerMetadata: {
      thresholdRejected: true,
      rejectionStage: 'threshold',
      rejectionReason: 'below score threshold',
    },
  };
  return {
    packet: {
      packetId: 'attempt-1',
      executionId: 'exec-1',
      workflowName: 'workflow',
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
      rejectedRefs: [filteredRef],
      availableRefs: [],
      candidateRefs: [ref, filteredRef],
      providerTraces: [],
      providerDiagnostics: [],
      rerankerTraces: [],
      rerankerDiagnostics: [],
      rerankerProviders: ['deterministic_policy_reranker'],
      retrievalProviders: ['mandatory_graph'],
      currentFiles: [],
      contextQueryIntent: {
        schemaVersion: 1,
        workflowName: 'workflow',
        nodeName: 'implement',
        role: 'backend-developer',
        roleFamily: 'backend',
        roleFocus: ['backend implementation'],
        rawRole: 'backend-developer',
        task: 'Fix payment writes',
        querySignalSources: ['raw_prompt_fallback'],
        querySignalSections: [],
        querySignalLength: 18,
        currentFiles: [],
        changedFiles: [],
        requiredCategories: ['source', 'guideline'],
        preferredCategories: ['design', 'runbook'],
        exclusionCategories: ['generated_doc', 'agent_persona'],
        pathHints: [],
        moduleHints: [],
        externalContextEligible: false,
      },
      renderedContextQuery: 'Workflow: workflow\nNode: implement\nRole: backend-developer\nRetrieval signals: Fix payment writes',
      contextQueryIntentHash: 'intent-hash',
      renderedContextQueryHash: 'query-hash',
      renderedContextQueryLength: 87,
      createdAt: new Date(),
    },
    injection: {
      injectionId: 'injection-1',
      graphVersion: 'index-1',
      provider: 'claude' as const,
      targetLayer: 'system_prompt' as const,
      maxFileChars: 1000,
      maxTotalChars: 2000,
      maxInjectedRefs: 2,
      totalChars: 12,
      consideredRefs: [ref],
      injectedRefs: [{ ...ref, content: 'hello world', contentSha256: 'hash-1', charCount: 11, packingDecision: 'injected' as const }],
      skippedRefs: [],
      providerNativeRefs: [],
      packingDecisions: [],
      packingDiagnostics: [],
      createdAt: new Date(),
    },
    contextInjection: { injectedRefs: [{ refId: 'ref-1' }] },
    promptBlock: 'manifest',
    systemPromptBlock: 'system prompt',
    contextProvider: 'allen',
    contextRetrievalMode: 'full',
  };
}

function scorePersistenceAttempt() {
  const mandatoryRef = {
    refId: 'mandatory-ref',
    kind: 'instruction_file' as const,
    title: 'Mandatory',
    path: '.claude/CLAUDE.md',
    providerId: 'mandatory_graph',
    source: 'mandatory_graph',
    reason: 'Mandatory for role',
    score: 12140,
    loadable: true,
    mandatory: true,
  };
  const cogneeCandidate = {
    refId: 'cognee:low-rerank',
    kind: 'doc' as const,
    title: 'PRD Vendor Onboarding',
    path: 'docs/prds/PRD-vendor-onboarding-v2-wizard.md',
    providerId: 'cognee_memory',
    reason: 'Cognee recalled this context.',
    score: 0.76,
    providerMetadata: {
      cogneeRawScore: 0.76,
      retrievalScore: 0.76,
      retrievalPolicyScore: 0.76,
      injectionPolicy: 'injectable',
    },
  };
  const cogneeRejected = {
    ...cogneeCandidate,
    reason: 'Rejected by context relevance threshold: below_rerank_threshold.',
    rerank: {
      providerId: 'bge',
      rerankScore: 0.05,
      semanticScore: 0.05,
      finalRelevanceScore: 0.36,
      finalRank: 4,
    },
    providerMetadata: {
      ...cogneeCandidate.providerMetadata,
      thresholdRejected: true,
      rejectionStage: 'selection',
      rejectionReason: 'below_rerank_threshold',
      rejectionThreshold: 0.45,
    },
  };
  return {
    packet: {
      packetId: 'attempt-scores',
      executionId: 'exec-scores',
      workflowName: 'workflow',
      nodeName: 'investigate',
      nodeRole: 'bug-investigator',
      attempt: 1,
      repoId: 'repo-1',
      repoName: 'repo',
      repoPath: '/repo',
      indexId: 'index-1',
      indexFreshness: 'fresh',
      selectedRefs: [mandatoryRef],
      injectableRefs: [mandatoryRef],
      rejectedRefs: [cogneeRejected],
      availableRefs: [],
      candidateRefs: [mandatoryRef, cogneeCandidate],
      providerTraces: [],
      providerDiagnostics: [],
      rerankerTraces: [],
      rerankerDiagnostics: [],
      rerankerProviders: ['bge'],
      retrievalProviders: ['mandatory_graph', 'cognee_memory', 'bge'],
      currentFiles: [],
      createdAt: new Date(),
    },
    injection: {
      injectionId: 'injection-scores',
      graphVersion: 'index-1',
      provider: 'claude' as const,
      targetLayer: 'system_prompt' as const,
      maxFileChars: 1000,
      maxTotalChars: 2000,
      maxInjectedRefs: 2,
      totalChars: 0,
      consideredRefs: [mandatoryRef],
      injectedRefs: [],
      skippedRefs: [],
      providerNativeRefs: [],
      packingDecisions: [],
      packingDiagnostics: [],
      createdAt: new Date(),
    },
    contextInjection: { injectedRefs: [] },
    promptBlock: '',
    systemPromptBlock: '',
    contextProvider: 'allen',
    contextRetrievalMode: 'full',
  };
}
