import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Collection, Db } from 'mongodb';
import { normalizeUsageArray } from './repo-knowledge-graph-usage.js';
import { firstString, isRecord } from './repo-knowledge-graph-utils.js';
import { resolveAllenPython } from './python-runtime.js';
import { isContextEngineEnabled } from './context-provider-config.js';

export type ContextEvaluationStatus = 'passed' | 'warning' | 'failed';
export type SemanticEvaluationStatus = 'disabled' | 'queued' | 'running' | 'completed' | 'failed';

type ScoreSet = {
  precision: number;
  completeness: number;
  usefulness: number;
  groundedness: number;
  correctness: number;
  bloat: number;
  candidateRecall: number;
  selectionPrecision: number;
  injectionPrecision: number;
  injectableFulfillment: number;
  manifestCompliance: number;
  graphExpansionYield: number;
  graphExpansionNoise: number;
  overall: number;
};

type SemanticEvaluation = {
  provider: 'none' | 'deepeval';
  status: SemanticEvaluationStatus;
  mode?: 'per_node' | 'workflow_summary';
  reason?: string;
  attempts?: number;
  maxAttempts?: number;
  queuedAt?: Date;
  lastAttemptAt?: Date;
  completedAt?: Date;
  nextRetryAt?: Date;
  scores?: Partial<ScoreSet>;
  diagnostics?: Array<Record<string, unknown>>;
  error?: string;
};

type EvaluationInput = {
  executionId: string;
  executionTraceId?: string;
  nodeName: string;
  attempt: number;
  packetId: string;
  usageTraceId?: string;
};

const DEFAULT_SEMANTIC_MAX_ATTEMPTS = 3;

export class ContextEvaluationService {
  private packets: Collection;
  private usage: Collection;
  private evaluations: Collection;
  private traces: Collection;
  private executions: Collection;
  private interventions: Collection;

  constructor(private db: Db) {
    this.packets = db.collection('node_context_packets');
    this.usage = db.collection('context_usage_traces');
    this.evaluations = db.collection('context_evaluation_traces');
    this.traces = db.collection('execution_traces');
    this.executions = db.collection('executions');
    this.interventions = db.collection('workflow_interventions');
  }

  async evaluateUsageTrace(input: EvaluationInput): Promise<Record<string, unknown> | null> {
    if (!isContextEngineEnabled()) return null;
    const [packet, usageRow, trace, existing] = await Promise.all([
      this.packets.findOne({ packetId: input.packetId }),
      input.usageTraceId
        ? this.usage.findOne({ traceId: input.usageTraceId })
        : this.usage.findOne({ packetId: input.packetId, executionId: input.executionId, nodeName: input.nodeName, attempt: input.attempt }),
      this.findExecutionTrace(input),
      input.usageTraceId
        ? this.evaluations.findOne({ packetId: input.packetId, usageTraceId: input.usageTraceId })
        : this.evaluations.findOne({ packetId: input.packetId }),
    ]);
    if (!packet || !usageRow) return null;

    const feedbackEvidence = await this.collectFeedbackEvidence(input.executionId, input.nodeName);
    const deterministic = this.evaluateDeterministic(packet, usageRow, trace, feedbackEvidence);
    const semantic = nextSemanticState(isRecord(existing?.semantic) ? existing.semantic as SemanticEvaluation : undefined);
    const traceId = firstString(existing?.traceId) ?? randomUUID();
    const doc = {
      traceId,
      executionId: input.executionId,
      executionTraceId: input.executionTraceId,
      nodeName: input.nodeName,
      nodeRole: packet.nodeRole ?? trace?.agent,
      attempt: input.attempt,
      packetId: input.packetId,
      usageTraceId: usageRow.traceId,
      repoId: packet.repoId,
      repoName: packet.repoName,
      indexId: packet.indexId,
      retrievalProviders: packet.retrievalProviders ?? [],
      status: this.statusFrom(deterministic.scores, deterministic.diagnostics),
      scores: deterministic.scores,
      semantic,
      diagnostics: deterministic.diagnostics,
      refScores: deterministic.refScores,
      feedbackEvidence,
      updatedAt: new Date(),
      createdAt: new Date(),
    };
    await this.evaluations.updateOne(
      { packetId: input.packetId, usageTraceId: usageRow.traceId },
      { $set: doc },
      { upsert: true },
    );
    await this.traces.updateOne(
      input.executionTraceId
        ? { executionTraceId: input.executionTraceId, executionId: input.executionId, type: 'agent' }
        : { executionId: input.executionId, node: input.nodeName, attempt: input.attempt, type: 'agent' },
      { $set: { contextEvaluation: summarizeEvaluation(doc) } },
    ).catch(() => undefined);
    return doc;
  }

  private async findExecutionTrace(input: EvaluationInput): Promise<Record<string, unknown> | null> {
    const projection = { rawResponse: 1, output: 1, toolCalls: 1, agent: 1 };
    if (input.executionTraceId) {
      const exact = await this.traces.findOne(
        { executionTraceId: input.executionTraceId, executionId: input.executionId, type: 'agent' },
        { projection },
      );
      if (exact) return exact;
    }
    return this.traces.findOne(
      { executionId: input.executionId, node: input.nodeName, attempt: input.attempt, type: 'agent' },
      { projection },
    );
  }

  async runPendingSemanticEvaluations(limit = 10): Promise<number> {
    if (!isContextEngineEnabled()) return 0;
    if (!isDeepEvalEnabled()) return 0;
    if (semanticMode() !== 'per_node') return 0;
    const now = new Date();
    const maxAttempts = semanticMaxAttempts();
    const rows = await this.evaluations.find({
      'semantic.provider': 'deepeval',
      $or: [
        { 'semantic.status': 'queued' },
        {
          'semantic.status': 'running',
          'semantic.lastAttemptAt': { $lte: semanticRunningStaleBefore(now) },
          'semantic.attempts': { $lt: maxAttempts },
        },
        {
          'semantic.status': 'failed',
          'semantic.attempts': { $lt: maxAttempts },
          $or: [
            { 'semantic.nextRetryAt': { $exists: false } },
            { 'semantic.nextRetryAt': { $lte: now } },
          ],
        },
      ],
    }).sort({ 'semantic.lastAttemptAt': 1, createdAt: 1 }).limit(limit).toArray();
    let count = 0;
    for (const row of rows) {
      const traceId = firstString(row.traceId);
      if (!traceId) continue;
      const result = await this.runSemanticEvaluation(traceId).catch(() => null);
      if (result) count += 1;
    }
    return count;
  }

  async retrySemanticEvaluation(traceId: string): Promise<boolean> {
    if (!isContextEngineEnabled()) return false;
    if (semanticMode() !== 'per_node') return false;
    const result = await this.evaluations.updateOne(
      { traceId },
      {
        $set: {
          'semantic.provider': 'deepeval',
          'semantic.status': 'queued',
          'semantic.queuedAt': new Date(),
          'semantic.nextRetryAt': new Date(),
        },
        $unset: {
          'semantic.error': '',
          'semantic.completedAt': '',
        },
      },
    );
    return result.matchedCount > 0;
  }

  async runSemanticEvaluation(traceId: string): Promise<Record<string, unknown> | null> {
    if (!isContextEngineEnabled()) return null;
    if (!isDeepEvalEnabled()) return null;
    if (semanticMode() !== 'per_node') return null;
    const evaluation = await this.evaluations.findOne({ traceId });
    if (!evaluation) return null;
    const attempts = Number((evaluation.semantic as Record<string, unknown> | undefined)?.attempts ?? 0);
    const maxAttempts = semanticMaxAttempts();
    if (attempts >= maxAttempts && (evaluation.semantic as Record<string, unknown> | undefined)?.status !== 'queued') return evaluation;

    const [packet, usageRow, trace] = await Promise.all([
      this.packets.findOne({ packetId: evaluation.packetId }),
      this.usage.findOne({ traceId: evaluation.usageTraceId }),
      this.traces.findOne(
        { executionId: evaluation.executionId, node: evaluation.nodeName, attempt: evaluation.attempt, type: 'agent' },
        { projection: { rawResponse: 1, output: 1, toolCalls: 1, agent: 1 } },
      ),
    ]);
    if (!packet || !usageRow) return null;

    const nextAttempt = attempts + 1;
    await this.evaluations.updateOne(
      { traceId },
      {
        $set: {
          'semantic.status': 'running',
          'semantic.provider': 'deepeval',
          'semantic.attempts': nextAttempt,
          'semantic.maxAttempts': maxAttempts,
          'semantic.lastAttemptAt': new Date(),
        },
      },
    );

    try {
      const semantic = await this.evaluateSemanticNow(
        packet,
        usageRow,
        trace,
        {
          scores: evaluation.scores as ScoreSet,
          diagnostics: normalizeUsageArray(evaluation.diagnostics),
          refScores: normalizeUsageArray(evaluation.refScores),
        },
        normalizeUsageArray(evaluation.feedbackEvidence),
      );
      semantic.attempts = nextAttempt;
      semantic.maxAttempts = maxAttempts;
      const diagnostics = [
        ...normalizeUsageArray(evaluation.diagnostics).filter((diag) => firstString(diag.code) !== 'semantic_eval_failed'),
        ...normalizeUsageArray(semantic.diagnostics),
      ];
      const updated = {
        semantic,
        diagnostics,
        updatedAt: new Date(),
      };
      await this.evaluations.updateOne({ traceId }, { $set: updated });
      const refreshed = await this.evaluations.findOne({ traceId });
      if (refreshed) await this.updateTraceSummary(refreshed);
      return refreshed;
    } catch (err) {
      const failedSemantic: SemanticEvaluation = {
        provider: 'deepeval',
        status: 'failed',
        attempts: nextAttempt,
        maxAttempts,
        lastAttemptAt: new Date(),
        nextRetryAt: nextAttempt < maxAttempts ? retryAt(nextAttempt) : undefined,
        error: (err as Error).message,
        diagnostics: [diagnostic('semantic_eval_failed', 'info', (err as Error).message)],
      };
      const diagnostics = [
        ...normalizeUsageArray(evaluation.diagnostics).filter((diag) => firstString(diag.code) !== 'semantic_eval_failed'),
        ...normalizeUsageArray(failedSemantic.diagnostics),
      ];
      await this.evaluations.updateOne(
        { traceId },
        { $set: { semantic: failedSemantic, diagnostics, updatedAt: new Date() } },
      );
      const refreshed = await this.evaluations.findOne({ traceId });
      if (refreshed) await this.updateTraceSummary(refreshed);
      return refreshed;
    }
  }

  async reevaluateExecution(executionId: string): Promise<number> {
    if (!isContextEngineEnabled()) return 0;
    const usageRows = await this.usage.find({
      $or: [
        { executionId },
        { rootExecutionId: executionId },
        { parentExecutionId: executionId },
      ],
    }).toArray();
    let count = 0;
    for (const row of usageRows) {
      const packetId = firstString(row.packetId);
      const nodeName = firstString(row.nodeName);
      if (!packetId || !nodeName) continue;
      const evaluated = await this.evaluateUsageTrace({
        executionId: String(row.executionId ?? executionId),
        nodeName,
        attempt: Number(row.attempt ?? 1),
        packetId,
        usageTraceId: firstString(row.traceId),
      }).catch(() => null);
      if (evaluated) count += 1;
    }
    return count;
  }

  async getEvaluationsForExecutions(executionIds: string[]): Promise<Record<string, unknown>[]> {
    return this.evaluations
      .find({ executionId: { $in: executionIds } })
      .sort({ createdAt: 1 })
      .toArray();
  }

  rollup(evaluations: Array<Record<string, unknown>>): Record<string, unknown> {
    const rows = evaluations.filter((row) => isRecord(row.scores));
    const statusCounts = rows.reduce<Record<string, number>>((acc, row) => {
      const status = String(row.status ?? 'unknown');
      acc[status] = (acc[status] ?? 0) + 1;
      return acc;
    }, {});
    const avg = (key: keyof ScoreSet) => rows.length === 0 ? undefined : round(rows.reduce((sum, row) => sum + Number((row.scores as Record<string, unknown>)[key] ?? 0), 0) / rows.length);
    const diagnostics = rows.flatMap((row) => normalizeUsageArray(row.diagnostics).map((diag) => ({
      ...diag,
      executionId: row.executionId,
      nodeName: row.nodeName,
      packetId: row.packetId,
    })));
    return {
      nodeCount: rows.length,
      statusCounts,
      averageScores: {
        precision: avg('precision'),
        completeness: avg('completeness'),
        usefulness: avg('usefulness'),
        groundedness: avg('groundedness'),
        correctness: avg('correctness'),
        bloat: avg('bloat'),
        candidateRecall: avg('candidateRecall'),
        selectionPrecision: avg('selectionPrecision'),
        injectionPrecision: avg('injectionPrecision'),
        injectableFulfillment: avg('injectableFulfillment'),
        manifestCompliance: avg('manifestCompliance'),
        graphExpansionYield: avg('graphExpansionYield'),
        graphExpansionNoise: avg('graphExpansionNoise'),
        overall: avg('overall'),
      },
      topDiagnostics: diagnostics.slice(0, 50),
    };
  }

  private evaluateDeterministic(
    packet: Record<string, unknown>,
    usageRow: Record<string, unknown>,
    trace: Record<string, unknown> | null,
    feedbackEvidence: Array<Record<string, unknown>>,
  ): { scores: ScoreSet; diagnostics: Array<Record<string, unknown>>; refScores: Array<Record<string, unknown>> } {
    const selectedRefs = normalizeUsageArray(packet.selectedRefs);
    const injectableRefs = normalizeUsageArray(packet.injectableRefs);
    const candidateRefs = normalizeUsageArray(packet.candidateRefs);
    const rejectedRefs = normalizeUsageArray(packet.rejectedRefs);
    const availableRefs = normalizeUsageArray(packet.availableRefs);
    const injection = isRecord(packet.contextInjection) ? packet.contextInjection : {};
    const injectedRefs = normalizeUsageArray(injection.injectedRefs);
    const providerNativeRefs = normalizeUsageArray(injection.skippedProviderNativeRefs);
    const skippedRefs = normalizeUsageArray(injection.skippedRefs);
    const loaded = normalizeUsageArray(usageRow.loaded);
    const claimedUsed = normalizeUsageArray(usageRow.claimedUsed);
    const reportedLoaded = normalizeUsageArray(usageRow.reportedLoaded);
    const reportedApplied = normalizeUsageArray(usageRow.reportedApplied);
    const contextPreselected = normalizeUsageArray(usageRow.contextPreselected);
    const selectedIds = idSet(selectedRefs);
    const availableIds = new Set([...selectedIds, ...idSet(availableRefs), ...idSet(injectedRefs), ...idSet(providerNativeRefs)]);
    const loadedIds = idSet(loaded);
    const appliedIds = idSet(claimedUsed);
    const injectedIds = idSet(injectedRefs);
    const injectableIds = idSet(injectableRefs);
    const providerNativeIds = idSet(providerNativeRefs);
    const claimedIds = new Set([...idSet(reportedLoaded), ...idSet(reportedApplied), ...appliedIds]);
    const expectedRefs = selectedRefs.filter((ref) => ref.mandatory === true || String(ref.reason ?? '').toLowerCase().includes('mandatory'));
    const expectedIds = idSet(expectedRefs);
    const satisfiedExpected = intersectionSize(expectedIds, new Set([...injectedIds, ...providerNativeIds, ...loadedIds, ...appliedIds]));
    const usedSelected = intersectionSize(selectedIds, new Set([...loadedIds, ...appliedIds]));
    const usefulSelected = intersectionSize(selectedIds, appliedIds);
    const claimedWithEvidence = intersectionSize(claimedIds, new Set([...injectedIds, ...providerNativeIds, ...loadedIds]));
    const invalidClaimIds = [...claimedIds].filter((id) => !availableIds.has(id));
    const unverifiedClaimIds = [...claimedIds].filter((id) => availableIds.has(id) && !injectedIds.has(id) && !providerNativeIds.has(id) && !loadedIds.has(id));
    const unusedInjectedRefs = injectedRefs.filter((ref) => {
      const id = refId(ref);
      return id && !appliedIds.has(id);
    });
    const unresolvedInjectableRefs = injectableRefs.filter((ref) => {
      const id = refId(ref);
      return id && !injectedIds.has(id) && !providerNativeIds.has(id);
    });
    const totalInjectedChars = Number(injection.totalChars ?? injectedRefs.reduce((sum, ref) => sum + Number(ref.contentChars ?? 0), 0));
    const unusedInjectedChars = unusedInjectedRefs.reduce((sum, ref) => sum + Number(ref.contentChars ?? 0), 0);
    const selectedRefById = new Map(selectedRefs.map((ref) => [refId(ref), ref]).filter((entry): entry is [string, Record<string, unknown>] => Boolean(entry[0])));
    const manifestOnlyClaimIds = [...claimedIds].filter((id) => {
      const ref = selectedRefById.get(id);
      const metadata = isRecord(ref?.providerMetadata) ? ref.providerMetadata : {};
      const decision = metadata.injectionDecision ?? metadata.injectionPolicy;
      return decision === 'manifest_only' && !loadedIds.has(id) && !injectedIds.has(id) && !providerNativeIds.has(id);
    });
    const graphSelectedRefs = selectedRefs.filter((ref) => isRecord(ref.providerMetadata) && ref.providerMetadata.graphExpansion === true);
    const graphAppliedIds = graphSelectedRefs
      .map(refId)
      .filter((id): id is string => Boolean(id))
      .filter((id) => appliedIds.has(id));
    const graphRejectedRefs = rejectedRefs.filter((ref) => isRecord(ref.providerMetadata) && ref.providerMetadata.graphExpansion === true);
    const scores: ScoreSet = {
      precision: ratio(usedSelected, selectedRefs.length),
      completeness: ratio(satisfiedExpected, expectedRefs.length),
      usefulness: ratio(usefulSelected, selectedRefs.length),
      groundedness: ratio(claimedWithEvidence, claimedIds.size),
      correctness: ratio(Math.max(0, claimedIds.size - invalidClaimIds.length - unverifiedClaimIds.length), claimedIds.size),
      bloat: ratio(unusedInjectedRefs.length, injectedRefs.length),
      candidateRecall: ratio(selectedRefs.length + rejectedRefs.length, candidateRefs.length || selectedRefs.length + rejectedRefs.length),
      selectionPrecision: ratio(usefulSelected, selectedRefs.length),
      injectionPrecision: ratio(injectedRefs.length - unusedInjectedRefs.length, injectedRefs.length),
      injectableFulfillment: ratio(injectableRefs.length - unresolvedInjectableRefs.length, injectableRefs.length),
      manifestCompliance: ratio(Math.max(0, claimedIds.size - manifestOnlyClaimIds.length), claimedIds.size),
      graphExpansionYield: ratio(graphAppliedIds.length, graphSelectedRefs.length),
      graphExpansionNoise: ratio(graphRejectedRefs.length, graphSelectedRefs.length + graphRejectedRefs.length),
      overall: 0,
    };
    scores.overall = round((scores.precision + scores.completeness + scores.usefulness + scores.groundedness + scores.correctness + (1 - scores.bloat) + scores.manifestCompliance) / 7);

    const diagnostics: Array<Record<string, unknown>> = [];
    if (scores.precision < 0.5 && selectedRefs.length > 0) diagnostics.push(diagnostic('low_context_precision', 'warn', `Only ${usedSelected}/${selectedRefs.length} selected refs had load/apply evidence.`));
    if (scores.completeness < 1 && expectedRefs.length > 0) diagnostics.push(diagnostic('missing_mandatory_context', 'warn', `Only ${satisfiedExpected}/${expectedRefs.length} mandatory refs were injected, provider-native, loaded, or applied.`));
    if (invalidClaimIds.length > 0) diagnostics.push(diagnostic('context_claimed_but_not_selected', 'warn', `Usage claims referenced refs outside selected/available context: ${invalidClaimIds.join(', ')}`, { refIds: invalidClaimIds }));
    if (unverifiedClaimIds.length > 0) diagnostics.push(diagnostic('unverified_context_claim', 'warn', `Usage claims lacked injection or body-load evidence: ${unverifiedClaimIds.join(', ')}`, { refIds: unverifiedClaimIds }));
    if (unusedInjectedRefs.length > 0) diagnostics.push(diagnostic('injected_context_unused', 'info', `${unusedInjectedRefs.length}/${injectedRefs.length} injected refs had no applied-context evidence.`, { refIds: unusedInjectedRefs.map(refId).filter(Boolean) }));
    if (unresolvedInjectableRefs.length > 0) diagnostics.push(diagnostic('injectable_context_not_injected', 'warn', `${unresolvedInjectableRefs.length}/${injectableRefs.length} injectable refs were not injected or provider-native.`, { refIds: unresolvedInjectableRefs.map(refId).filter(Boolean) }));
    if (scores.bloat > 0.5 && injectedRefs.length > 1) diagnostics.push(diagnostic('context_budget_bloat', 'warn', 'Most injected refs were not applied by the agent.'));
    if (manifestOnlyClaimIds.length > 0) diagnostics.push(diagnostic('manifest_ref_used_without_load', 'warn', `Manifest-only refs were claimed without body-load or injection evidence: ${manifestOnlyClaimIds.join(', ')}`, { refIds: manifestOnlyClaimIds }));
    if (candidateRefs.length > 0 && selectedRefs.length === 0) diagnostics.push(diagnostic('over_filtered_context', 'warn', 'Context retrieval returned candidates but none were selected.', { candidateCount: candidateRefs.length }));
    if (graphRejectedRefs.length > 0 && graphSelectedRefs.length === 0) diagnostics.push(diagnostic('graph_expansion_noise', 'info', 'Cognee graph expansion produced only rejected or shadow candidates.', { rejectedCount: graphRejectedRefs.length }));
    for (const ref of skippedRefs) {
      const reason = firstString(ref.skipReason);
      if (reason === 'budget' || reason === 'oversize') {
        diagnostics.push(diagnostic('mandatory_context_skipped', 'warn', `${ref.path ?? ref.refId} was skipped because of ${reason}.`, { refId: refId(ref), path: ref.path, reason }));
      }
    }
    diagnostics.push(...this.feedbackDiagnostics(feedbackEvidence, selectedIds, injectedIds));

    const refScores = selectedRefs.map((ref) => {
      const id = refId(ref);
      return {
        refId: id,
        path: ref.path,
        kind: ref.kind,
        mandatory: ref.mandatory === true,
        selected: true,
        injected: Boolean(id && injectedIds.has(id)),
        providerNative: Boolean(id && providerNativeIds.has(id)),
        injectable: Boolean(id && injectableIds.has(id)),
        loaded: Boolean(id && loadedIds.has(id)),
        applied: Boolean(id && appliedIds.has(id)),
        score: Boolean(id && appliedIds.has(id)) ? 1 : Boolean(id && loadedIds.has(id)) ? 0.7 : Boolean(id && injectedIds.has(id)) ? 0.4 : 0,
      };
    });

    return { scores, diagnostics, refScores };
  }

  private feedbackDiagnostics(feedbackEvidence: Array<Record<string, unknown>>, selectedIds: Set<string>, injectedIds: Set<string>): Array<Record<string, unknown>> {
    return feedbackEvidence.flatMap((item) => {
      const classification = firstString(item.classification);
      if (!classification || classification === 'task_issue_not_context_related') return [];
      const severity = classification === 'useful_context' ? 'info' : 'warn';
      return [diagnostic(`human_feedback_${classification}`, severity, String(item.summary ?? item.content ?? ''), {
        feedbackId: item.id,
        source: item.source,
        targetNode: item.targetNode,
        selectedRefCount: selectedIds.size,
        injectedRefCount: injectedIds.size,
      })];
    });
  }

  private async evaluateSemanticNow(
    packet: Record<string, unknown>,
    usageRow: Record<string, unknown>,
    trace: Record<string, unknown> | null,
    deterministic: { scores: ScoreSet; diagnostics: Array<Record<string, unknown>>; refScores: Array<Record<string, unknown>> },
    feedbackEvidence: Array<Record<string, unknown>>,
  ): Promise<SemanticEvaluation> {
    const payload = {
      taskPrompt: firstString(packet.prompt, (trace?.output as Record<string, unknown> | undefined)?.prompt),
      finalOutput: firstString(trace?.rawResponse, JSON.stringify(trace?.output ?? {})),
      nodeRole: packet.nodeRole,
      selectedRefs: normalizeUsageArray(packet.selectedRefs).slice(0, 20),
      injectedRefs: normalizeUsageArray((packet.contextInjection as Record<string, unknown> | undefined)?.injectedRefs).slice(0, 12),
      usage: usageRow,
      deterministic,
      feedbackEvidence,
    };
    const result = await runDeepEval(payload);
    return {
      provider: 'deepeval',
      status: 'completed',
      maxAttempts: semanticMaxAttempts(),
      completedAt: new Date(),
      scores: isRecord(result.scores) ? result.scores as Partial<ScoreSet> : undefined,
      diagnostics: normalizeUsageArray(result.diagnostics),
    };
  }

  private async collectFeedbackEvidence(executionId: string, nodeName: string): Promise<Array<Record<string, unknown>>> {
    const exec = await this.executions.findOne({ id: executionId }, { projection: { feedbackEntries: 1, state: 1, parentExecutionId: 1, rootExecutionId: 1 } }).catch(() => null);
    const rootId = firstString(exec?.rootExecutionId, exec?.parentExecutionId, executionId) ?? executionId;
    const [interventions, rootExec] = await Promise.all([
      this.interventions.find({
        workflow_run_id: { $in: Array.from(new Set([executionId, rootId])) },
        status: 'answered',
      }).toArray().catch(() => []),
      rootId !== executionId ? this.executions.findOne({ id: rootId }, { projection: { feedbackEntries: 1 } }).catch(() => null) : Promise.resolve(null),
    ]);
    const feedbackEntries = [
      ...normalizeUsageArray(exec?.feedbackEntries),
      ...normalizeUsageArray(rootExec?.feedbackEntries),
    ];
    const rows: Array<Record<string, unknown>> = [];
    for (const entry of feedbackEntries) {
      const targets = Array.isArray(entry.targetNodes) ? entry.targetNodes.map(String) : [];
      if (targets.length > 0 && !targets.includes(nodeName)) continue;
      const content = firstString(entry.content);
      if (!content) continue;
      rows.push({
        id: entry.id,
        source: 'execution_feedback',
        content,
        targetNode: nodeName,
        classification: classifyFeedback(content),
        summary: content.slice(0, 500),
      });
    }
    for (const item of interventions) {
      const response = isRecord(item.response) ? item.response : {};
      const feedback = firstString(response.feedback, response.answer);
      if (!feedback) continue;
      const targetNode = firstString((item.retry_triggered as Record<string, unknown> | undefined)?.target_node, item.stage);
      if (targetNode && targetNode !== nodeName && item.stage !== nodeName) continue;
      rows.push({
        id: item.intervention_id,
        source: 'workflow_intervention',
        decision: response.decision,
        content: feedback,
        targetNode,
        classification: classifyFeedback(feedback),
        summary: feedback.slice(0, 500),
      });
    }
    return rows;
  }

  private statusFrom(scores: ScoreSet, diagnostics: Array<Record<string, unknown>>): ContextEvaluationStatus {
    const hasWarn = diagnostics.some((d) => d.severity === 'warn');
    if (scores.completeness < 0.5 || scores.groundedness < 0.5 || scores.correctness < 0.5) return 'failed';
    if (hasWarn || scores.precision < 0.5 || scores.usefulness < 0.25 || scores.bloat > 0.5) return 'warning';
    return 'passed';
  }

  private async updateTraceSummary(doc: Record<string, unknown>): Promise<void> {
    await this.traces.updateOne(
      firstString(doc.executionTraceId)
        ? { executionTraceId: doc.executionTraceId, executionId: doc.executionId, type: 'agent' }
        : { executionId: doc.executionId, node: doc.nodeName, attempt: doc.attempt, type: 'agent' },
      { $set: { contextEvaluation: summarizeEvaluation(doc) } },
    ).catch(() => undefined);
  }
}

function summarizeEvaluation(doc: Record<string, unknown>): Record<string, unknown> {
  return {
    traceId: doc.traceId,
    status: doc.status,
    scores: doc.scores,
    semantic: doc.semantic,
    diagnostics: normalizeUsageArray(doc.diagnostics).slice(0, 10),
    feedbackEvidenceCount: normalizeUsageArray(doc.feedbackEvidence).length,
  };
}

function nextSemanticState(existing?: SemanticEvaluation): SemanticEvaluation {
  if (!isDeepEvalEnabled()) return { provider: 'none', status: 'disabled' };
  if (semanticMode() !== 'per_node') {
    return {
      provider: 'deepeval',
      status: 'disabled',
      mode: 'workflow_summary',
      reason: 'Semantic evaluation runs once at workflow completion.',
    };
  }
  const maxAttempts = semanticMaxAttempts();
  const attempts = Number(existing?.attempts ?? 0);
  if (existing?.status === 'running') return existing;
  return {
    provider: 'deepeval',
    status: 'queued',
    mode: 'per_node',
    attempts,
    maxAttempts,
    queuedAt: new Date(),
  };
}

function isDeepEvalEnabled(): boolean {
  return (process.env.ALLEN_CONTEXT_SEMANTIC_EVALUATOR ?? '').toLowerCase() === 'deepeval';
}

function semanticMode(): 'per_node' | 'workflow_summary' {
  return (process.env.ALLEN_CONTEXT_SEMANTIC_MODE ?? 'workflow_summary').toLowerCase() === 'per_node'
    ? 'per_node'
    : 'workflow_summary';
}

function semanticMaxAttempts(): number {
  const value = Number(process.env.ALLEN_CONTEXT_SEMANTIC_MAX_ATTEMPTS ?? DEFAULT_SEMANTIC_MAX_ATTEMPTS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_SEMANTIC_MAX_ATTEMPTS;
}

function retryAt(attempt: number): Date {
  const delayMs = Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt - 1));
  return new Date(Date.now() + delayMs);
}

function semanticRunningStaleBefore(now: Date): Date {
  const timeoutMs = Number(process.env.ALLEN_DEEPEVAL_STALE_RUNNING_MS ?? 10 * 60_000);
  const safeTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10 * 60_000;
  return new Date(now.getTime() - safeTimeoutMs);
}

function classifyFeedback(content: string): string {
  const value = content.toLowerCase();
  if (/missing|did not include|not included|forgot|should have used|should read|need(ed)? context|not aware/.test(value)) return 'missing_context';
  if (/ignored|did not follow|violated|contradict|against the guideline|not following/.test(value)) return 'ignored_context';
  if (/wrong context|irrelevant context|unrelated context|too much context|too broad|bloated|noise/.test(value)) return 'wrong_context';
  if (/stale|outdated|old instruction|no longer true/.test(value)) return 'stale_context';
  if (/context helped|used the context|guideline was useful|instruction was useful/.test(value)) return 'useful_context';
  return 'task_issue_not_context_related';
}

function refId(row: Record<string, unknown>): string | undefined {
  return firstString(row.refId, row.ref_id, row.id);
}

function idSet(rows: Array<Record<string, unknown>>): Set<string> {
  return new Set(rows.map(refId).filter((id): id is string => Boolean(id)));
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const value of a) if (b.has(value)) count += 1;
  return count;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 1;
  return round(Math.max(0, Math.min(1, numerator / denominator)));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function diagnostic(code: string, severity: 'info' | 'warn', message: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { code, severity, message, ...extra };
}

async function runDeepEval(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const script = resolveDeepEvalScript();
  const python = resolveAllenPython();
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('DeepEval semantic evaluator timed out'));
    }, Number(process.env.ALLEN_DEEPEVAL_TIMEOUT_MS ?? 120_000));
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `DeepEval evaluator exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout || '{}') as Record<string, unknown>);
      } catch (err) {
        reject(new Error(`DeepEval evaluator returned invalid JSON: ${(err as Error).message}`));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function resolveDeepEvalScript(): string {
  if (process.env.ALLEN_DEEPEVAL_SCRIPT) return process.env.ALLEN_DEEPEVAL_SCRIPT;
  const candidates = [
    join(dirname(fileURLToPath(import.meta.url)), '../scripts/deepeval-context-evaluator.py'),
    join(process.cwd(), 'packages/server/src/scripts/deepeval-context-evaluator.py'),
    join(process.cwd(), 'src/scripts/deepeval-context-evaluator.py'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}
