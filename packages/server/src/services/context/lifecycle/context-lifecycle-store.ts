import { createHash, randomUUID } from 'node:crypto';
import type { Collection, Db } from 'mongodb';
import type { KnowledgeCandidateRef, RepoContextPacket } from '../core/repo-context-engine.js';
import type { WorkflowContextInjection } from '../core/workflow-context-injection-adapter.js';
import { firstString, isRecord } from '../common/context-utils.js';
import { normalizeUsageArray } from '../common/context-usage-utils.js';

export type ContextRefEventType =
  | 'candidate'
  | 'selected'
  | 'filtered'
  | 'rejected'
  | 'injectable'
  | 'injected_full'
  | 'injected_manifest'
  | 'provider_native'
  | 'skipped'
  | 'loaded'
  | 'applied'
  | 'reported_loaded'
  | 'reported_applied'
  | 'tool_body_loaded'
  | 'source_discovered'
  | 'evaluation_scored';

type ContextArtifactKind =
  | 'ref_content'
  | 'prompt_block'
  | 'diagnostics'
  | 'context_query_intent'
  | 'context_query'
  | 'deepeval_evidence'
  | 'deepeval_prompt'
  | 'raw_judge_response'
  | 'output_excerpt';

type StoredRef = Record<string, unknown> & {
  contextAttemptId: string;
  refId: string;
};

type StoredAttempt = Record<string, unknown> & {
  contextAttemptId: string;
  executionId: string;
  nodeName: string;
  attempt: number;
};

export class ContextLifecycleStore {
  private attempts: Collection;
  private refs: Collection<StoredRef>;
  private events: Collection;
  private artifacts: Collection;
  private evaluations: Collection;
  private traces: Collection;
  private executions: Collection;

  constructor(private readonly db: Db) {
    this.attempts = db.collection('context_attempts');
    this.refs = db.collection<StoredRef>('context_refs');
    this.events = db.collection('context_ref_events');
    this.artifacts = db.collection('context_artifacts');
    this.evaluations = db.collection('context_evaluations');
    this.traces = db.collection('execution_traces');
    this.executions = db.collection('executions');
  }

  async saveAttemptFromPacket(input: {
    packet: RepoContextPacket;
    injection: WorkflowContextInjection;
    contextInjection: Record<string, unknown>;
    promptBlock: string;
    systemPromptBlock: string;
    contextProvider?: string | null;
    contextRetrievalMode?: string;
  }): Promise<void> {
    const { packet, injection } = input;
    const now = new Date();
    const contextAttemptId = packet.packetId;
    const diagnosticsArtifactHash = packet.providerDiagnostics.length || packet.rerankerDiagnostics.length || injection.packingDiagnostics.length
      ? await this.putJsonArtifact('diagnostics', {
        providerDiagnostics: packet.providerDiagnostics,
        rerankerDiagnostics: packet.rerankerDiagnostics,
        packingDiagnostics: injection.packingDiagnostics,
      }, {
        contextAttemptId,
        executionId: packet.executionId,
        nodeName: packet.nodeName,
        attempt: packet.attempt,
      })
      : undefined;
    const promptBlockArtifactHash = input.promptBlock
      ? await this.putTextArtifact('prompt_block', input.promptBlock, {
        contextAttemptId,
        executionId: packet.executionId,
        nodeName: packet.nodeName,
        attempt: packet.attempt,
        promptBlock: 'manifest',
      })
      : undefined;
    const systemPromptBlockArtifactHash = input.systemPromptBlock
      ? await this.putTextArtifact('prompt_block', input.systemPromptBlock, {
        contextAttemptId,
        executionId: packet.executionId,
        nodeName: packet.nodeName,
        attempt: packet.attempt,
        promptBlock: 'system',
      })
      : undefined;
    const contextQueryIntentArtifactHash = packet.contextQueryIntent
      ? await this.putJsonArtifact('context_query_intent', packet.contextQueryIntent, {
        contextAttemptId,
        executionId: packet.executionId,
        nodeName: packet.nodeName,
        attempt: packet.attempt,
      })
      : undefined;
    const renderedContextQueryArtifactHash = packet.renderedContextQuery
      ? await this.putTextArtifact('context_query', packet.renderedContextQuery, {
        contextAttemptId,
        executionId: packet.executionId,
        nodeName: packet.nodeName,
        attempt: packet.attempt,
      })
      : undefined;

    await this.attempts.updateOne(
      { contextAttemptId },
      {
        $setOnInsert: {
          contextAttemptId,
          executionId: packet.executionId,
          workflowName: packet.workflowName,
          nodeName: packet.nodeName,
          nodeRole: packet.nodeRole,
          executionKind: packet.executionKind,
          targetRole: packet.targetRole,
          callerRole: packet.callerRole,
          attempt: packet.attempt,
          repoId: packet.repoId,
          repoName: packet.repoName,
          repoPath: packet.repoPath,
          worktreePath: packet.worktreePath,
          parentContextAttemptId: packet.parentPacketId,
          parentExecutionId: packet.parentExecutionId,
          rootExecutionId: packet.rootExecutionId,
          indexId: packet.indexId,
          indexFreshness: packet.indexFreshness,
          taskPrompt: packet.taskPrompt,
          retrievalProviders: packet.retrievalProviders,
          rerankerProviders: packet.rerankerProviders,
          currentFiles: packet.currentFiles,
          contextProvider: input.contextProvider,
          contextRetrievalMode: input.contextRetrievalMode,
          injectionId: injection.injectionId,
          injectionTargetLayer: injection.targetLayer,
          injectionLimits: {
            maxFileChars: injection.maxFileChars,
            maxTotalChars: injection.maxTotalChars,
            maxInjectedRefs: injection.maxInjectedRefs,
          },
          injectionTotalChars: injection.totalChars,
          injectionContentHash: injection.contentHash,
          contextInjection: input.contextInjection,
          diagnosticsArtifactHash,
          promptBlockArtifactHash,
          systemPromptBlockArtifactHash,
          contextQueryIntentArtifactHash,
          renderedContextQueryArtifactHash,
          contextQueryIntentHash: packet.contextQueryIntentHash,
          renderedContextQueryHash: packet.renderedContextQueryHash,
          renderedContextQueryLength: packet.renderedContextQueryLength,
          contextQuerySummary: contextQuerySummary(packet.contextQueryIntent),
          createdAt: packet.createdAt ?? now,
        },
      },
      { upsert: true },
    );

    const refRows = [];
    for (const ref of mergeRefs(packet, injection)) {
      const row = compactRefSnapshot(packet, ref);
      if (typeof ref.content === 'string' && ref.content.trim()) {
        row.contentArtifactHash = await this.putTextArtifact('ref_content', ref.content, {
          contextAttemptId,
          refId: ref.refId,
          executionId: packet.executionId,
          nodeName: packet.nodeName,
          attempt: packet.attempt,
        });
        row.contentAvailable = true;
      }
      refRows.push(row);
    }
    if (refRows.length) {
      await this.refs.bulkWrite(refRows.map((row) => ({
        updateOne: {
          filter: { contextAttemptId, refId: row.refId },
          update: { $setOnInsert: { ...row, createdAt: now } },
          upsert: true,
        },
      })), { ordered: false });
    }

    const events: Array<Record<string, unknown>> = [];
    const pushRefs = (type: ContextRefEventType, refs: Array<Record<string, unknown>>, extra?: (ref: Record<string, unknown>) => Record<string, unknown>) => {
      for (const ref of refs) {
        const refId = firstString(ref.refId, ref.ref_id, ref.id);
        if (!refId) continue;
        events.push(this.event(contextAttemptId, refId, type, packet as unknown as Record<string, unknown>, extra?.(ref)));
      }
    };

    pushRefs('candidate', normalizeUsageArray(packet.candidateRefs));
    pushRefs('selected', normalizeUsageArray(packet.selectedRefs));
    pushRefs('injectable', normalizeUsageArray(packet.injectableRefs));
    pushRefs('filtered', normalizeUsageArray(packet.rejectedRefs).filter(isFilteredRef), (ref) => ({
      stage: firstString((ref.providerMetadata as Record<string, unknown> | undefined)?.rejectionStage) ?? 'selection',
      reason: firstString((ref.providerMetadata as Record<string, unknown> | undefined)?.rejectionReason, ref.reason) ?? 'filtered',
    }));
    pushRefs('rejected', normalizeUsageArray(packet.rejectedRefs), (ref) => ({
      stage: firstString((ref.providerMetadata as Record<string, unknown> | undefined)?.rejectionStage) ?? 'selection',
      reason: firstString((ref.providerMetadata as Record<string, unknown> | undefined)?.rejectionReason, ref.reason),
    }));
    pushRefs('injected_manifest', normalizeUsageArray(injection.consideredRefs));
    for (const ref of normalizeUsageArray(injection.injectedRefs)) {
      const refId = firstString(ref.refId, ref.ref_id, ref.id);
      if (!refId) continue;
      const content = firstString(ref.content);
      const artifactHash = content
        ? await this.putTextArtifact('ref_content', content, {
          contextAttemptId,
          refId,
          executionId: packet.executionId,
          nodeName: packet.nodeName,
          attempt: packet.attempt,
        })
        : firstString(ref.contentSha256);
      events.push(this.event(contextAttemptId, refId, 'injected_full', packet as unknown as Record<string, unknown>, {
        contentArtifactHash: artifactHash,
        contentSha256: firstString(ref.contentSha256),
        charCount: numberValue(ref.charCount, ref.finalCharCount),
        targetLayer: injection.targetLayer,
      }));
    }
    pushRefs('provider_native', normalizeUsageArray(injection.providerNativeRefs), (ref) => ({
      reason: firstString(ref.skipReason) ?? 'provider_native',
      targetLayer: injection.targetLayer,
    }));
    pushRefs('skipped', normalizeUsageArray(injection.skippedRefs), (ref) => ({
      reason: firstString(ref.skipReason),
      stage: 'packing',
      targetLayer: injection.targetLayer,
    }));

    if (events.length) await this.events.insertMany(events, { ordered: false });
  }

  async recordUsage(input: {
    contextAttemptId: string;
    usageTraceId: string;
    executionId: string;
    executionTraceId?: string;
    nodeName: string;
    attempt: number;
    parsed: Record<string, unknown>;
    diagnostics?: Array<Record<string, unknown>>;
  }): Promise<Record<string, unknown> | null> {
    const attempt = await this.attempts.findOne({ contextAttemptId: input.contextAttemptId });
    if (!attempt) return null;
    const now = new Date();
    const events: Array<Record<string, unknown>> = [];
    const push = (type: ContextRefEventType, values: unknown, detail?: (row: Record<string, unknown>) => Record<string, unknown>) => {
      for (const row of normalizeUsageArray(values)) {
        const refId = firstString(row.refId, row.ref_id, row.id);
        if (!refId) continue;
        events.push(this.event(input.contextAttemptId, refId, type, attempt, {
          usageTraceId: input.usageTraceId,
          executionTraceId: input.executionTraceId,
          ...detail?.(row),
        }, now));
      }
    };
    push('loaded', input.parsed.loaded);
    push('applied', input.parsed.applied);
    push('reported_loaded', input.parsed.reportedLoaded);
    push('reported_applied', input.parsed.reportedApplied);
    push('skipped', input.parsed.skipped, (row) => ({ reason: firstString(row.reason, row.summary), stage: 'agent_usage' }));
    push('tool_body_loaded', input.parsed.contextBodyLoads);
    push('tool_body_loaded', input.parsed.skillBodyLoads);
    if (events.length) await this.events.insertMany(events, { ordered: false });

    if (input.diagnostics?.length) {
      await this.putJsonArtifact('diagnostics', input.diagnostics, {
        contextAttemptId: input.contextAttemptId,
        usageTraceId: input.usageTraceId,
        executionId: input.executionId,
        nodeName: input.nodeName,
        attempt: input.attempt,
      });
    }
    return this.getUsageView(input.contextAttemptId, input.usageTraceId);
  }

  async recordSourceDiscoveryFromTrace(input: {
    contextAttemptId: string;
    usageTraceId?: string;
    executionTraceId?: string;
    trace?: Record<string, unknown> | null;
  }): Promise<void> {
    const evidence = collectSourceDiscoveryEvidence(input.trace);
    if (evidence.length === 0) return;
    const [attempt, refs] = await Promise.all([
      this.attempts.findOne({ contextAttemptId: input.contextAttemptId }),
      this.refs.find({ contextAttemptId: input.contextAttemptId }).toArray(),
    ]);
    if (!attempt || refs.length === 0) return;
    const events: Array<Record<string, unknown>> = [];
    for (const ref of refs) {
      if (!sourceDiscoverySatisfiesRef(ref, evidence)) continue;
      const matchedEvidence = evidence.filter((item) => sourceDiscoverySatisfiesRef(ref, [item])).slice(0, 5);
      events.push(this.event(input.contextAttemptId, ref.refId, 'source_discovered', attempt, {
        usageTraceId: input.usageTraceId,
        executionTraceId: input.executionTraceId,
        sourceDiscoveryEvidence: matchedEvidence,
      }));
    }
    if (events.length) await this.events.insertMany(events, { ordered: false });
  }

  async getAttemptById(contextAttemptId: string): Promise<Record<string, unknown> | null> {
    return this.attempts.findOne({ contextAttemptId });
  }

  async getAttemptPacketView(contextAttemptId: string): Promise<Record<string, unknown> | null> {
    const [attempt, refs, events] = await Promise.all([
      this.attempts.findOne({ contextAttemptId }),
      this.refs.find({ contextAttemptId }).toArray(),
      this.events.find({ contextAttemptId }).sort({ createdAt: 1 }).toArray(),
    ]);
    if (!attempt) return null;
    const byType = eventsByType(events);
    const refsById = new Map(refs.map((ref) => [ref.refId, ref]));
    const rowsFor = (type: ContextRefEventType) => uniqueByRefId((byType.get(type) ?? [])
      .map((event) => refFromEvent(event, refsById))
      .filter(Boolean) as Array<Record<string, unknown>>);
    const injectedRefs = await this.withEventContent(rowsFor('injected_full'), byType.get('injected_full') ?? []);
    const providerNativeRefs = rowsFor('provider_native');
    const skippedRefs = rowsFor('skipped').filter((ref) => firstString(ref.stage) === 'packing');
    const refReadModel = refs.map((ref) => lifecycleRefReadModel(ref, events));
    return {
      ...attempt,
      packetId: contextAttemptId,
      parentPacketId: attempt.parentContextAttemptId,
      refs: refReadModel,
      lifecycle: events.map((event) => lifecycleEventReadModel(event)),
      selectedRefs: rowsFor('selected'),
      injectableRefs: rowsFor('injectable'),
      filteredRefs: rowsFor('filtered'),
      rejectedRefs: rowsFor('rejected'),
      candidateRefs: rowsFor('candidate'),
      availableRefs: rowsFor('selected').filter((ref) => ref.mandatory !== true),
      contextInjection: {
        ...(isRecord(attempt.contextInjection) ? attempt.contextInjection : {}),
        injectedRefs,
        providerNativeRefs,
        skippedProviderNativeRefs: providerNativeRefs,
        skippedRefs,
      },
      contextQuery: contextQueryReadModel(attempt),
      providerDiagnostics: [],
      rerankerDiagnostics: [],
    };
  }

  async getUsageView(contextAttemptId: string, usageTraceId?: string): Promise<Record<string, unknown> | null> {
    const attempt = await this.attempts.findOne({ contextAttemptId });
    if (!attempt) return null;
    const eventFilter: Record<string, unknown> = { contextAttemptId };
    if (usageTraceId) eventFilter.usageTraceId = usageTraceId;
    const [events, refs] = await Promise.all([
      this.events.find(eventFilter).sort({ createdAt: 1 }).toArray(),
      this.refs.find({ contextAttemptId }).toArray(),
    ]);
    const refsById = new Map(refs.map((ref) => [ref.refId, ref]));
    const byType = eventsByType(events);
    const rowsFor = (type: ContextRefEventType) => uniqueByRefId((byType.get(type) ?? [])
      .map((event) => refFromEvent(event, refsById))
      .filter(Boolean) as Array<Record<string, unknown>>);
    return {
      traceId: usageTraceId,
      usageTraceId,
      executionId: attempt.executionId,
      executionTraceId: firstString(events.find((event) => event.executionTraceId)?.executionTraceId),
      workflowName: attempt.workflowName,
      nodeName: attempt.nodeName,
      nodeRole: attempt.nodeRole,
      attempt: attempt.attempt,
      packetId: contextAttemptId,
      contextAttemptId,
      contextPreselected: rowsFor('selected'),
      loaded: rowsFor('loaded'),
      claimedUsed: rowsFor('applied'),
      reportedLoaded: rowsFor('reported_loaded'),
      reportedApplied: rowsFor('reported_applied'),
      sourceDiscovery: rowsFor('source_discovered'),
      sourceDiscoveryEvidence: (byType.get('source_discovered') ?? [])
        .flatMap((event) => normalizeUsageArray(event.sourceDiscoveryEvidence)),
      skipped: rowsFor('skipped').filter((ref) => firstString(ref.stage) === 'agent_usage'),
      contextBodyLoads: rowsFor('tool_body_loaded'),
      skillBodyLoads: rowsFor('tool_body_loaded').filter((ref) => ref.kind === 'skill' || ref.kind === 'skill_reference'),
      diagnostics: [],
      sawUsageKeys: events.some((event) => event.usageTraceId === usageTraceId),
      createdAt: events.find((event) => event.usageTraceId === usageTraceId)?.createdAt,
    };
  }

  async saveEvaluationVersion(input: {
    evaluation: Record<string, unknown>;
    artifacts?: {
      deepevalEvidence?: unknown;
      deepevalPrompt?: string;
      rawJudgeResponse?: string;
      outputExcerpt?: string;
    };
  }): Promise<Record<string, unknown>> {
    const now = new Date();
    const contextAttemptId = firstString(input.evaluation.contextAttemptId, input.evaluation.packetId) ?? '';
    const usageTraceId = firstString(input.evaluation.usageTraceId);
    const scope = firstString(input.evaluation.scope) ?? 'node';
    const artifactHashes: Record<string, string> = {};
    if (input.artifacts?.deepevalEvidence !== undefined) artifactHashes.deepevalEvidence = await this.putJsonArtifact('deepeval_evidence', input.artifacts.deepevalEvidence, { contextAttemptId, usageTraceId });
    if (input.artifacts?.deepevalPrompt) artifactHashes.deepevalPrompt = await this.putTextArtifact('deepeval_prompt', input.artifacts.deepevalPrompt, { contextAttemptId, usageTraceId });
    if (input.artifacts?.rawJudgeResponse) artifactHashes.rawJudgeResponse = await this.putTextArtifact('raw_judge_response', input.artifacts.rawJudgeResponse, { contextAttemptId, usageTraceId });
    if (input.artifacts?.outputExcerpt) artifactHashes.outputExcerpt = await this.putTextArtifact('output_excerpt', input.artifacts.outputExcerpt, { contextAttemptId, usageTraceId });

    const version = await this.evaluations.countDocuments({ contextAttemptId, usageTraceId, scope }) + 1;
    const row = {
      ...stripEvaluationPersistence(input.evaluation),
      evaluationId: randomUUID(),
      traceId: randomUUID(),
      previousEvaluationId: firstString(input.evaluation.evaluationId),
      previousTraceId: firstString(input.evaluation.traceId),
      contextAttemptId,
      packetId: contextAttemptId,
      usageTraceId,
      scope,
      version,
      active: false,
      validFrom: now,
      validTo: null,
      artifactHashes,
      createdAt: now,
      updatedAt: now,
    };
    const inserted = await this.evaluations.insertOne(row);
    await this.evaluations.updateMany(
      { contextAttemptId, usageTraceId, scope, active: true },
      { $set: { active: false, validTo: now, supersededAt: now } },
    );
    await this.evaluations.updateOne({ _id: inserted.insertedId }, { $set: { active: true } });
    row.active = true;
    for (const ref of normalizeUsageArray((row as Record<string, unknown>).refScores)) {
      const refId = firstString(ref.refId, ref.ref_id, ref.id);
      if (!refId) continue;
      await this.events.insertOne(this.event(contextAttemptId, refId, 'evaluation_scored', row, {
        evaluationId: row.evaluationId,
        usageTraceId,
        score: ref.score,
      }));
    }
    return row;
  }

  async replaceWorkflowEvaluation(input: {
    executionId: string;
    rootExecutionId: string;
    job: Record<string, unknown>;
    artifacts?: {
      evidencePayload?: unknown;
      packedEvidencePayload?: unknown;
      prompt?: string;
      rawJudgeResponse?: string;
    };
  }): Promise<Record<string, unknown>> {
    const now = new Date();
    const scope = 'workflow';
    const artifactHashes: Record<string, string> = {};
    if (input.artifacts?.evidencePayload !== undefined) artifactHashes.deepevalEvidence = await this.putJsonArtifact('deepeval_evidence', input.artifacts.evidencePayload, { executionId: input.executionId, scope });
    if (input.artifacts?.packedEvidencePayload !== undefined) artifactHashes.deepevalPackedEvidence = await this.putJsonArtifact('deepeval_evidence', input.artifacts.packedEvidencePayload, { executionId: input.executionId, scope, packed: true });
    if (input.artifacts?.prompt) artifactHashes.deepevalPrompt = await this.putTextArtifact('deepeval_prompt', input.artifacts.prompt, { executionId: input.executionId, scope });
    if (input.artifacts?.rawJudgeResponse) artifactHashes.rawJudgeResponse = await this.putTextArtifact('raw_judge_response', input.artifacts.rawJudgeResponse, { executionId: input.executionId, scope });
    const version = await this.evaluations.countDocuments({ executionId: input.executionId, scope }) + 1;
    const row = {
      ...stripEvaluationPersistence(input.job),
      evaluationId: randomUUID(),
      traceId: randomUUID(),
      workflowJobId: firstString(input.job.jobId),
      previousEvaluationId: firstString(input.job.evaluationId),
      previousTraceId: firstString(input.job.traceId),
      executionId: input.executionId,
      rootExecutionId: input.rootExecutionId,
      scope,
      version,
      active: false,
      validFrom: now,
      validTo: null,
      artifactHashes,
      createdAt: now,
      updatedAt: now,
    };
    const inserted = await this.evaluations.insertOne(row);
    await this.evaluations.updateMany(
      { executionId: input.executionId, scope, active: true },
      { $set: { active: false, validTo: now, supersededAt: now } },
    );
    await this.evaluations.updateOne({ _id: inserted.insertedId }, { $set: { active: true } });
    row.active = true;
    return row;
  }

  async getActiveEvaluation(filter: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return this.evaluations.findOne({ ...filter, active: true });
  }

  async getEvaluationsForExecutions(executionIds: string[], scope = 'node'): Promise<Record<string, unknown>[]> {
    return this.evaluations.find({ executionId: { $in: executionIds }, scope, active: true }).sort({ createdAt: 1 }).toArray();
  }

  async getWorkflowEvaluation(executionId: string): Promise<Record<string, unknown> | null> {
    return this.evaluations.findOne({ executionId, scope: 'workflow', active: true });
  }

  async getExecutionContextUsageReport(executionId: string): Promise<Record<string, unknown>> {
    const descendants = await this.executions.find(
      { $or: [{ parentExecutionId: executionId }, { rootExecutionId: executionId }] },
      { projection: { id: 1 } },
    ).toArray();
    const executionIds = Array.from(new Set([executionId, ...descendants.map((row) => String(row.id)).filter(Boolean)]));
    const [attempts, refs, events, evaluations, traces, workflowSemanticEvaluation] = await Promise.all([
      this.attempts.find({ executionId: { $in: executionIds } }).sort({ createdAt: 1 }).toArray(),
      this.refs.find({ executionId: { $in: executionIds } }).sort({ rank: 1, createdAt: 1 }).toArray(),
      this.events.find({
        $or: [
          { executionId: { $in: executionIds } },
          { parentExecutionId: executionId },
          { rootExecutionId: executionId },
        ],
      }).sort({ createdAt: 1 }).toArray(),
      this.evaluations.find({ executionId: { $in: executionIds }, active: true }).sort({ createdAt: 1 }).toArray(),
      this.traces.find({ executionId: { $in: executionIds }, type: 'agent' }).sort({ startedAt: 1 }).toArray(),
      this.getWorkflowEvaluation(executionId),
    ]);
    const refsByAttempt = groupBy(refs, (row) => String(row.contextAttemptId));
    const eventsByAttempt = groupBy(events, (row) => String(row.contextAttemptId));
    const evaluationsByAttempt = new Map(evaluations.filter((row) => row.scope !== 'workflow').map((row) => [String(row.contextAttemptId), row]));
    const nodeAttempts = attempts.map((attempt) => {
      const contextAttemptId = String(attempt.contextAttemptId);
      const attemptRefs = refsByAttempt.get(contextAttemptId) ?? [];
      const attemptEvents = eventsByAttempt.get(contextAttemptId) ?? [];
      const refRows = attemptRefs.map((ref) => lifecycleRefReadModel(ref, attemptEvents));
      const evaluation = evaluationsByAttempt.get(contextAttemptId);
      return {
        contextAttemptId,
        packetId: contextAttemptId,
        executionId: attempt.executionId,
        workflowName: attempt.workflowName,
        nodeName: attempt.nodeName,
        nodeRole: attempt.nodeRole,
        attempt: attempt.attempt,
        repoId: attempt.repoId,
        repoName: attempt.repoName,
        indexId: attempt.indexId,
        indexFreshness: attempt.indexFreshness,
        retrievalProviders: attempt.retrievalProviders,
        contextInjection: attempt.contextInjection,
        contextQuery: contextQueryReadModel(attempt),
        refs: refRows,
        lifecycle: attemptEvents.map((event) => lifecycleEventReadModel(event)),
        contextEvaluation: evaluation ? summarizeEvaluation(evaluation) : undefined,
        diagnostics: diagnosticsForAttempt(attempt, attemptEvents, refRows),
      };
    });
    return {
      executionId,
      executionIds,
      attempts,
      refs,
      events,
      evaluations,
      packets: await Promise.all(attempts.map((attempt) => this.getAttemptPacketView(String(attempt.contextAttemptId)))),
      usage: await Promise.all(attempts.map((attempt) => this.getUsageView(String(attempt.contextAttemptId)))),
      nodeAttempts,
      nodeSummaries: nodeAttempts.map((attempt) => ({
        executionId: attempt.executionId,
        nodeName: attempt.nodeName,
        nodeRole: attempt.nodeRole,
        attempt: attempt.attempt,
        packetId: attempt.contextAttemptId,
        contextAttemptId: attempt.contextAttemptId,
        usageTraceId: firstString((attempt.lifecycle.find((event) => event.usageTraceId) as Record<string, unknown> | undefined)?.usageTraceId),
        contextInjection: attempt.contextInjection,
        contextQuery: attempt.contextQuery,
        contextEvaluation: attempt.contextEvaluation,
        preselectedCount: attempt.refs.filter((ref) => ref.lifecycleStatus === 'selected' || ref.isInjected).length,
        loadedCount: attempt.refs.filter((ref) => ref.lifecycleStatus === 'loaded').length,
        appliedCount: attempt.refs.filter((ref) => ref.lifecycleStatus === 'applied').length,
        skippedCount: attempt.refs.filter((ref) => ref.lifecycleStatus === 'skipped').length,
        diagnostics: attempt.diagnostics.map((diag) => diag.code).filter(Boolean),
      })),
      diagnostics: nodeAttempts.flatMap((attempt) => attempt.diagnostics),
      contextPreselected: refs.filter((ref) => hasEvent(events, ref, 'selected')),
      contextInjections: nodeAttempts.map((attempt) => ({
        contextAttemptId: attempt.contextAttemptId,
        packetId: attempt.contextAttemptId,
        executionId: attempt.executionId,
        nodeName: attempt.nodeName,
        ...(isRecord(attempt.contextInjection) ? attempt.contextInjection : {}),
      })),
      workflowSemanticEvaluation,
      traces: traces.map((trace) => ({
        executionId: trace.executionId,
        executionTraceId: trace.executionTraceId,
        node: trace.node,
        agent: trace.agent,
        attempt: trace.attempt,
        contextAttemptId: trace.contextAttemptId,
        contextUsageTraceId: trace.contextUsageTraceId,
      })),
      evaluationSummary: rollup(evaluations.filter((row) => row.scope !== 'workflow')),
    };
  }

  async getRefContent(contextAttemptId: string, refId: string): Promise<Record<string, unknown> | null> {
    const [ref, events] = await Promise.all([
      this.refs.findOne({ contextAttemptId, refId }),
      this.events.find({ contextAttemptId, refId }).sort({ createdAt: -1 }).toArray(),
    ]);
    if (!ref) return null;
    const contentHash = firstString(...events.map((event) => event.contentArtifactHash), ref.contentArtifactHash);
    const artifact = contentHash ? await this.artifacts.findOne({ hash: contentHash }) : null;
    return {
      contextAttemptId,
      refId,
      title: ref.title,
      path: ref.path,
      kind: ref.kind,
      providerId: ref.providerId,
      providerMetadata: ref.providerMetadata,
      content: firstString(artifact?.content),
      contentAvailable: Boolean(artifact?.content),
      contentHash,
      tokenEstimate: Math.ceil((firstString(artifact?.content) ?? '').length / 4),
    };
  }

  async getAttemptQueryContent(contextAttemptId: string, kind: 'query' | 'intent'): Promise<Record<string, unknown> | null> {
    const attempt = await this.attempts.findOne({ contextAttemptId });
    if (!attempt) return null;
    const artifactHash = kind === 'query'
      ? firstString(attempt.renderedContextQueryArtifactHash)
      : firstString(attempt.contextQueryIntentArtifactHash);
    const artifact = artifactHash ? await this.artifacts.findOne({ hash: artifactHash }) : null;
    return {
      contextAttemptId,
      kind,
      content: firstString(artifact?.content),
      contentAvailable: Boolean(artifact?.content),
      contentHash: artifactHash,
      contentType: firstString(artifact?.contentType),
      tokenEstimate: Math.ceil((firstString(artifact?.content) ?? '').length / 4),
    };
  }

  async putTextArtifact(kind: ContextArtifactKind, content: string, metadata: Record<string, unknown> = {}): Promise<string> {
    const hash = sha256(content);
    await this.artifacts.updateOne(
      { hash },
      {
        $setOnInsert: {
          artifactId: `ctx_artifact_${hash.slice(0, 24)}`,
          hash,
          kind,
          contentType: 'text/plain',
          content,
          sizeBytes: Buffer.byteLength(content),
          metadata,
          createdAt: new Date(),
        },
      },
      { upsert: true },
    );
    return hash;
  }

  async putJsonArtifact(kind: ContextArtifactKind, value: unknown, metadata: Record<string, unknown> = {}): Promise<string> {
    return this.putTextArtifact(kind, JSON.stringify(value ?? null), metadata);
  }

  private event(
    contextAttemptId: string,
    refId: string,
    type: ContextRefEventType,
    base: Record<string, unknown>,
    detail: Record<string, unknown> = {},
    createdAt = new Date(),
  ): Record<string, unknown> {
    return {
      eventId: randomUUID(),
      contextAttemptId,
      packetId: contextAttemptId,
      refId,
      type,
      executionId: base.executionId,
      executionTraceId: detail.executionTraceId,
      workflowName: base.workflowName,
      nodeName: base.nodeName,
      attempt: base.attempt,
      parentExecutionId: base.parentExecutionId,
      rootExecutionId: base.rootExecutionId,
      createdAt,
      ...pruneUndefined(detail),
    };
  }

  private async withEventContent(refs: Array<Record<string, unknown>>, events: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
    const eventByRefId = new Map(events.map((event) => [String(event.refId), event]));
    return Promise.all(refs.map(async (ref) => {
      const event = eventByRefId.get(String(ref.refId));
      const hash = firstString(event?.contentArtifactHash);
      const artifact = hash ? await this.artifacts.findOne({ hash }) : null;
      return {
        ...ref,
        content: firstString(artifact?.content),
        contentSha256: firstString(event?.contentSha256, ref.contentSha256, hash),
        charCount: numberValue(event?.charCount),
      };
    }));
  }
}

function mergeRefs(packet: RepoContextPacket, injection: WorkflowContextInjection): KnowledgeCandidateRef[] {
  const refs = [
    ...normalizeUsageArray(packet.candidateRefs),
    ...normalizeUsageArray(packet.selectedRefs),
    ...normalizeUsageArray(packet.injectableRefs),
    ...normalizeUsageArray(packet.rejectedRefs),
    ...normalizeUsageArray(injection.consideredRefs),
    ...normalizeUsageArray(injection.injectedRefs),
    ...normalizeUsageArray(injection.providerNativeRefs),
    ...normalizeUsageArray(injection.skippedRefs),
  ] as unknown as KnowledgeCandidateRef[];
  return mergeByRefId(refs as unknown as Array<Record<string, unknown>>) as unknown as KnowledgeCandidateRef[];
}

function compactRefSnapshot(packet: RepoContextPacket, ref: KnowledgeCandidateRef): StoredRef {
  const metadata = isRecord(ref.providerMetadata) ? ref.providerMetadata : {};
  const rerank = isRecord(ref.rerank) ? ref.rerank : {};
  const rank = numberValue(rerank.finalRank, rerank.rank);
  const isCognee = isCogneeRef(ref);
  return pruneUndefined({
    contextAttemptId: packet.packetId,
    executionId: packet.executionId,
    workflowName: packet.workflowName,
    nodeName: packet.nodeName,
    attempt: packet.attempt,
    repoId: packet.repoId,
    repoName: packet.repoName,
    indexId: packet.indexId,
    refId: ref.refId,
    kind: ref.kind,
    title: ref.title,
    path: ref.path,
    summary: ref.summary,
    tags: ref.tags,
    providerId: ref.providerId,
    source: ref.source,
    reason: ref.reason,
    score: ref.score,
    cogneeScore: isCognee ? numberValue(metadata.retrievalScore, metadata.retrievalPolicyScore, ref.score) : undefined,
    rerankerScore: numberValue(rerank.rerankScore, rerank.semanticScore, rerank.score),
    rank,
    injectionPolicy: firstString(metadata.injectionPolicy, metadata.injectionDecision),
    filterReason: firstString(metadata.rejectionReason),
    filterStage: firstString(metadata.rejectionStage),
    metadataSummary: summarizeMetadata(metadata),
    providerMetadata: metadata,
    rerank,
    loadable: ref.loadable,
    mandatory: ref.mandatory,
    itemType: ref.itemType,
    grounding: ref.grounding,
    contentSha256: ref.contentSha256,
    contentAvailable: typeof ref.content === 'string' && ref.content.length > 0,
  }) as StoredRef;
}

function lifecycleRefReadModel(ref: StoredRef, events: Array<Record<string, unknown>>): Record<string, unknown> {
  const refEvents = events.filter((event) => String(event.refId) === ref.refId);
  const eventTypes = new Set(refEvents.map((event) => String(event.type)));
  const injected = eventTypes.has('injected_full');
  const providerNative = eventTypes.has('provider_native');
  const filtered = eventTypes.has('filtered') || eventTypes.has('rejected');
  const skipped = refEvents.find((event) => event.type === 'skipped');
  const applied = eventTypes.has('applied') || eventTypes.has('reported_applied');
  const loaded = eventTypes.has('loaded') || eventTypes.has('reported_loaded') || eventTypes.has('tool_body_loaded');
  const sourceDiscovered = eventTypes.has('source_discovered');
  const lifecycleStatus = applied ? 'applied'
    : loaded ? 'loaded'
      : sourceDiscovered ? 'source_discovered'
        : injected ? 'injected'
          : providerNative ? 'provider_native'
            : skipped ? 'skipped'
              : filtered ? 'filtered'
                : eventTypes.has('selected') ? 'selected'
                  : eventTypes.has('candidate') ? 'candidate'
                    : 'unknown';
  const injectionMode = injected ? 'full'
    : providerNative ? 'provider_native'
      : eventTypes.has('injected_manifest') ? 'manifest'
        : skipped ? 'skipped'
          : undefined;
  return pruneUndefined({
    ...ref,
    isMandatory: ref.mandatory === true,
    isCognee: String(ref.providerId ?? '').includes('cognee') || /^cognee(?::|$)/i.test(ref.refId),
    lifecycleStatus,
    injectionMode,
    isInjected: injected || providerNative,
    isFiltered: filtered,
    sourceDiscovered,
    filterReason: firstString(ref.filterReason, skipped?.reason),
    filterStage: firstString(ref.filterStage, skipped?.stage),
    contentAvailable: Boolean(ref.contentAvailable || refEvents.some((event) => event.contentArtifactHash)),
    contentUrl: `/api/context/attempts/${encodeURIComponent(String(ref.contextAttemptId))}/refs/${encodeURIComponent(ref.refId)}/content`,
    timeline: refEvents.map(lifecycleEventReadModel),
  });
}

function lifecycleEventReadModel(event: Record<string, unknown>): Record<string, unknown> {
  return pruneUndefined({
    eventId: event.eventId,
    type: event.type,
    refId: event.refId,
    usageTraceId: event.usageTraceId,
    evaluationId: event.evaluationId,
    reason: event.reason,
    stage: event.stage,
    score: event.score,
    createdAt: event.createdAt,
  });
}

function contextQuerySummary(intent: unknown): Record<string, unknown> | undefined {
  if (!isRecord(intent)) return undefined;
  return pruneUndefined({
    schemaVersion: intent.schemaVersion,
    workflowName: intent.workflowName,
    nodeName: intent.nodeName,
    role: intent.role,
    roleFamily: intent.roleFamily,
    roleFocus: stringArray(intent.roleFocus),
    querySignalSources: stringArray(intent.querySignalSources),
    querySignalSections: stringArray(intent.querySignalSections),
    querySignalLength: numberValue(intent.querySignalLength),
    requiredCategories: stringArray(intent.requiredCategories),
    preferredCategories: stringArray(intent.preferredCategories),
    exclusionCategories: stringArray(intent.exclusionCategories),
    currentFiles: stringArray(intent.currentFiles),
    changedFiles: stringArray(intent.changedFiles),
    pathHints: stringArray(intent.pathHints),
    moduleHints: stringArray(intent.moduleHints),
    externalContextEligible: intent.externalContextEligible === true,
  });
}

function contextQueryReadModel(attempt: Record<string, unknown>): Record<string, unknown> | undefined {
  const summary = isRecord(attempt.contextQuerySummary) ? attempt.contextQuerySummary : {};
  const renderedQueryHash = firstString(attempt.renderedContextQueryHash);
  const intentHash = firstString(attempt.contextQueryIntentHash);
  if (!renderedQueryHash && !intentHash && Object.keys(summary).length === 0) return undefined;
  const contextAttemptId = String(attempt.contextAttemptId);
  return pruneUndefined({
    ...summary,
    queryIntentHash: intentHash,
    renderedQueryHash,
    renderedQueryLength: numberValue(attempt.renderedContextQueryLength),
    queryIntentAvailable: Boolean(attempt.contextQueryIntentArtifactHash),
    renderedQueryAvailable: Boolean(attempt.renderedContextQueryArtifactHash),
    queryIntentUrl: attempt.contextQueryIntentArtifactHash ? `/api/context/attempts/${encodeURIComponent(contextAttemptId)}/query-intent` : undefined,
    renderedQueryUrl: attempt.renderedContextQueryArtifactHash ? `/api/context/attempts/${encodeURIComponent(contextAttemptId)}/query` : undefined,
  });
}

function refFromEvent(event: Record<string, unknown>, refsById: Map<string, StoredRef>): Record<string, unknown> | null {
  const refId = firstString(event.refId);
  if (!refId) return null;
  const ref = refsById.get(refId);
  return pruneUndefined({
    ...(ref ?? {}),
    refId,
    reason: firstString(event.reason, ref?.reason),
    skipReason: firstString(event.reason, ref?.skipReason),
    stage: firstString(event.stage),
    score: numberValue(event.score, ref?.score),
  });
}

function eventsByType(events: Array<Record<string, unknown>>): Map<ContextRefEventType, Array<Record<string, unknown>>> {
  const map = new Map<ContextRefEventType, Array<Record<string, unknown>>>();
  for (const event of events) {
    const type = event.type as ContextRefEventType;
    const rows = map.get(type) ?? [];
    rows.push(event);
    map.set(type, rows);
  }
  return map;
}

function diagnosticsForAttempt(
  attempt: Record<string, unknown>,
  events: Array<Record<string, unknown>>,
  refs: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const diagnostics: Array<Record<string, unknown>> = [];
  if (!events.some((event) => event.type === 'loaded' || event.type === 'applied' || event.type === 'reported_loaded' || event.type === 'reported_applied')) {
    diagnostics.push({
      code: 'usage_missing',
      severity: 'warn',
      message: `${String(attempt.nodeName)} had a context attempt but no usage lifecycle events.`,
      contextAttemptId: attempt.contextAttemptId,
    });
  }
  for (const ref of refs) {
    if (ref.isMandatory && !ref.isInjected && ref.lifecycleStatus !== 'loaded' && ref.lifecycleStatus !== 'applied') {
      diagnostics.push({
        code: 'mandatory_context_not_available',
        severity: 'warn',
        message: `${String(ref.refId)} was mandatory but was not injected, provider-native, loaded, or applied.`,
        contextAttemptId: attempt.contextAttemptId,
        refId: ref.refId,
      });
    }
  }
  return diagnostics;
}

function summarizeEvaluation(row: Record<string, unknown>): Record<string, unknown> {
  return {
    traceId: row.traceId,
    evaluationId: row.evaluationId,
    status: row.status,
    scores: row.scores,
    semantic: row.semantic,
    diagnostics: normalizeUsageArray(row.diagnostics).slice(0, 10),
    feedbackEvidenceCount: normalizeUsageArray(row.feedbackEvidence).length,
    version: row.version,
  };
}

function rollup(evaluations: Array<Record<string, unknown>>): Record<string, unknown> {
  const rows = evaluations.filter((row) => isRecord(row.scores));
  const avg = (key: string) => rows.length === 0 ? undefined : round(rows.reduce((sum, row) => sum + Number((row.scores as Record<string, unknown>)[key] ?? 0), 0) / rows.length);
  return {
    nodeCount: rows.length,
    statusCounts: rows.reduce<Record<string, number>>((acc, row) => {
      const status = String(row.status ?? 'unknown');
      acc[status] = (acc[status] ?? 0) + 1;
      return acc;
    }, {}),
    averageScores: {
      precision: avg('precision'),
      completeness: avg('completeness'),
      usefulness: avg('usefulness'),
      groundedness: avg('groundedness'),
      correctness: avg('correctness'),
      bloat: avg('bloat'),
      overall: avg('overall'),
    },
  };
}

function hasEvent(events: Array<Record<string, unknown>>, ref: Record<string, unknown>, type: ContextRefEventType): boolean {
  return events.some((event) => event.contextAttemptId === ref.contextAttemptId && event.refId === ref.refId && event.type === type);
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const group = map.get(k) ?? [];
    group.push(row);
    map.set(k, group);
  }
  return map;
}

function uniqueByRefId<T extends Record<string, unknown>>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const refId = firstString(row.refId, row.ref_id, row.id);
    if (!refId || seen.has(refId)) continue;
    seen.add(refId);
    out.push({ ...row, refId });
  }
  return out;
}

function mergeByRefId<T extends Record<string, unknown>>(rows: T[]): T[] {
  const byRefId = new Map<string, T>();
  for (const row of rows) {
    const refId = firstString(row.refId, row.ref_id, row.id);
    if (!refId) continue;
    const normalized = { ...row, refId } as T;
    const existing = byRefId.get(refId);
    byRefId.set(refId, existing ? mergeRefSnapshot(existing, normalized) : normalized);
  }
  return [...byRefId.values()];
}

function mergeRefSnapshot<T extends Record<string, unknown>>(base: T, next: T): T {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(next)) {
    if (!hasMeaningfulValue(value)) continue;
    if (key === 'providerMetadata' || key === 'rerank') {
      merged[key] = mergeRecordValues(merged[key], value);
    } else {
      merged[key] = value;
    }
  }
  return merged as T;
}

function mergeRecordValues(base: unknown, next: unknown): Record<string, unknown> | undefined {
  const left = isRecord(base) ? base : {};
  const right = isRecord(next) ? next : {};
  const merged: Record<string, unknown> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (!hasMeaningfulValue(value)) continue;
    merged[key] = value;
  }
  return Object.keys(merged).length ? merged : undefined;
}

function hasMeaningfulValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

function isCogneeRef(ref: { providerId?: unknown; refId?: unknown }): boolean {
  return firstString(ref.providerId) === 'cognee_memory' || /^cognee:/i.test(firstString(ref.refId) ?? '');
}

function summarizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return pruneUndefined({
    retrievalStage: metadata.retrievalStage,
    retrievalScore: metadata.retrievalScore,
    retrievalPolicyScore: metadata.retrievalPolicyScore,
    injectionDecision: metadata.injectionDecision,
    injectionPolicy: metadata.injectionPolicy,
    graphExpansion: metadata.graphExpansion,
    source: metadata.source,
  });
}

function stripEvaluationPersistence(row: Record<string, unknown>): Record<string, unknown> {
  const {
    _id: _discardId,
    active: _discardActive,
    validFrom: _discardValidFrom,
    validTo: _discardValidTo,
    supersededAt: _discardSupersededAt,
    artifactHashes: _discardArtifactHashes,
    version: _discardVersion,
    createdAt: _discardCreatedAt,
    updatedAt: _discardUpdatedAt,
    ...rest
  } = row;
  void _discardId;
  void _discardActive;
  void _discardValidFrom;
  void _discardValidTo;
  void _discardSupersededAt;
  void _discardArtifactHashes;
  void _discardVersion;
  void _discardCreatedAt;
  void _discardUpdatedAt;
  return rest;
}

function isFilteredRef(ref: Record<string, unknown>): boolean {
  const metadata = isRecord(ref.providerMetadata) ? ref.providerMetadata : {};
  if (metadata.thresholdRejected === true || metadata.filtered === true) return true;
  const stage = firstString(metadata.rejectionStage);
  const reason = firstString(metadata.rejectionReason, ref.reason) ?? '';
  if (stage && /filter|threshold|rerank|selection|policy|dedupe|duplicate/i.test(stage)) return true;
  return /filter|threshold|below|dedupe|duplicate|rerank|policy|score/i.test(reason);
}

function collectSourceDiscoveryEvidence(trace: Record<string, unknown> | null | undefined): Array<Record<string, unknown>> {
  const calls = normalizeUsageArray(trace?.toolCalls);
  return calls.flatMap((call): Array<Record<string, unknown>> => {
    const tool = firstString(call.tool, call.name);
    if (!tool || !isSourceDiscoveryTool(tool, call)) return [];
    const args = isRecord(call.args) ? call.args : {};
    const paths = extractToolPaths(args, call);
    const command = firstString(args.command, args.cmd, call.command, call.content);
    return [pruneUndefined({
      tool,
      paths,
      commandPreview: command ? command.slice(0, 300) : undefined,
      toolUseId: firstString(call.toolUseId, call.toolCallId, call.id),
    })];
  });
}

function isSourceDiscoveryTool(tool: string, call: Record<string, unknown>): boolean {
  const lower = tool.toLowerCase();
  if (/(^|__)(read|grep|glob|ls|find)$/.test(lower)) return true;
  if (/(^|__)(bash|shell|exec_command)$/.test(lower)) {
    const args = isRecord(call.args) ? call.args : {};
    const command = firstString(args.command, args.cmd, call.command, call.content) ?? '';
    return /\b(rg|grep|find|ls|sed|cat|head|tail|git\s+(show|diff|grep))\b/.test(command);
  }
  return false;
}

function extractToolPaths(args: Record<string, unknown>, call: Record<string, unknown>): string[] {
  const values = [
    args.path,
    args.file_path,
    args.filePath,
    args.absolute_path,
    args.relative_path,
    args.relativePath,
    args.glob,
    args.pattern,
    call.path,
  ];
  const paths = values.flatMap((value) => typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
  const command = firstString(args.command, args.cmd, call.command, call.content);
  if (command) paths.push(...extractPathLikeTokens(command));
  return Array.from(new Set(paths.map((path) => path.trim()).filter(Boolean))).slice(0, 20);
}

function extractPathLikeTokens(command: string): string[] {
  const matches = command.match(/[A-Za-z0-9_./@-]+\.(?:ts|tsx|js|jsx|py|java|go|rs|rb|php|css|scss|html|json|ya?ml|md|sql|sh|bash|zsh|toml|ini|env|Dockerfile)|(?:^|\s)(?:src|packages|apps|tests|test|docs|e2e|\.claude|\.github)\/[A-Za-z0-9_./@-]+/g) ?? [];
  return matches.map((match) => match.trim());
}

function sourceDiscoveryCanSatisfyRef(ref: Record<string, unknown>): boolean {
  const itemType = firstString(ref.itemType);
  const kind = firstString(ref.kind);
  const path = firstString(ref.path);
  if (kind === 'source_file' || itemType === 'repo_file' || itemType === 'repo_chunk') return true;
  if (!path) return false;
  return /\.(ts|tsx|js|jsx|py|java|go|rs|rb|php|css|scss|html|sql|sh|bash|zsh|json|ya?ml|toml)$/i.test(path)
    || /(^|\/)(src|packages|apps|tests?|e2e)\//.test(path);
}

function sourceDiscoverySatisfiesRef(ref: Record<string, unknown>, evidence: Array<Record<string, unknown>>): boolean {
  if (!sourceDiscoveryCanSatisfyRef(ref)) return false;
  const path = firstString(ref.path);
  if (!path || evidence.length === 0) return false;
  const normalizedPath = normalizeRepoPath(path);
  const basename = normalizedPath.split('/').pop();
  return evidence.some((item) => {
    const paths = Array.isArray(item.paths) ? item.paths.filter((value): value is string => typeof value === 'string') : [];
    const command = firstString(item.commandPreview) ?? '';
    return paths.some((candidate) => pathsOverlap(normalizedPath, normalizeRepoPath(candidate)))
      || command.includes(path)
      || Boolean(basename && command.includes(basename));
  });
}

function pathsOverlap(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`) || a.includes(`/${b}/`) || b.includes(`/${a}/`);
}

function normalizeRepoPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^.*?((?:packages|apps|src|tests?|e2e|docs|\.claude|\.github)\/)/, '$1').replace(/^\.\//, '');
}

function numberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function pruneUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
