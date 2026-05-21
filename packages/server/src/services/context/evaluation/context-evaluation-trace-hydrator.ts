import type { Db } from 'mongodb';
import { firstString, isRecord } from '../allen-knowledge-graph/repo-knowledge-graph-utils.js';
import { normalizeUsageArray } from '../allen-knowledge-graph/repo-knowledge-graph-usage.js';
import { ContextLifecycleStore } from '../lifecycle/context-lifecycle-store.js';

type EvaluationRow = Record<string, unknown>;
type TraceRow = Record<string, unknown>;

export async function hydrateTraceContextEvaluations(
  db: Db,
  executionId: string,
  traces: TraceRow[],
): Promise<TraceRow[]> {
  if (traces.length === 0) return traces;
  const lifecycle = new ContextLifecycleStore(db);
  const attemptRows = await db.collection('context_attempts')
    .find({ executionId })
    .sort({ createdAt: 1 })
    .toArray();
  const attemptIdByIdentity = new Map<string, string>();
  for (const attempt of attemptRows) {
    const contextAttemptId = firstString(attempt.contextAttemptId);
    if (!contextAttemptId) continue;
    attemptIdByIdentity.set(traceIdentity(attempt.executionId, attempt.nodeName, attempt.attempt), contextAttemptId);
  }
  const contextAttemptIdForTrace = (trace: TraceRow): string | undefined => firstString(trace.contextAttemptId)
    ?? attemptIdByIdentity.get(traceIdentity(trace.executionId ?? executionId, trace.node, trace.attempt));
  const attemptIds = Array.from(new Set(traces.map(contextAttemptIdForTrace).filter((id): id is string => Boolean(id))));
  const [attemptPairs, usagePairs, evaluations] = await Promise.all([
    Promise.all(attemptIds.map(async (contextAttemptId) => [contextAttemptId, await lifecycle.getAttemptPacketView(contextAttemptId)] as const)),
    Promise.all(traces.map(async (trace) => {
      const contextAttemptId = contextAttemptIdForTrace(trace);
      if (!contextAttemptId) return null;
      const usageTraceId = firstString(trace.contextUsageTraceId);
      return [trace, await lifecycle.getUsageView(contextAttemptId, usageTraceId)] as const;
    })),
    db.collection('context_evaluations')
      .find({ executionId, scope: 'node', active: true })
      .sort({ createdAt: 1 })
      .toArray(),
  ]);
  const attemptsById = new Map(attemptPairs.filter((entry): entry is readonly [string, Record<string, unknown>] => entry[1] != null));
  const usageByTrace = new Map<TraceRow, Record<string, unknown>>();
  for (const entry of usagePairs) {
    if (entry?.[1]) usageByTrace.set(entry[0], entry[1]);
  }
  if (evaluations.length === 0) {
    return traces.map((trace) => withNormalizedLifecycle(withMissingReason(trace, null), attemptsById, usageByTrace.get(trace)));
  }

  const usedEvaluationIds = new Set<string>();
  return traces.map((trace) => {
    const normalizedTrace = withNormalizedLifecycle(trace, attemptsById, usageByTrace.get(trace));
    if (isRecord(trace.contextEvaluation)) return normalizedTrace;
    const match = findBestEvaluation(trace, evaluations, usedEvaluationIds);
    if (!match) return withMissingReason(normalizedTrace, evaluations);
    usedEvaluationIds.add(evaluationKey(match));
    return {
      ...normalizedTrace,
      contextEvaluation: summarizeEvaluation(match),
    };
  });
}

function withNormalizedLifecycle(
  trace: TraceRow,
  attemptsById: Map<string, Record<string, unknown>>,
  usage: Record<string, unknown> | undefined,
): TraceRow {
  const contextAttemptId = firstString(trace.contextAttemptId, usage?.contextAttemptId, usage?.packetId);
  const attempt = contextAttemptId ? attemptsById.get(contextAttemptId) : undefined;
  if (!attempt && !usage) return trace;
  return {
    ...trace,
    contextAttemptId,
    contextUsageTraceId: firstString(trace.contextUsageTraceId, usage?.usageTraceId),
    contextLifecycleAttempt: attempt,
    contextUsage: usage ? summarizeUsage(usage) : trace.contextUsage,
  };
}

function findBestEvaluation(
  trace: TraceRow,
  evaluations: EvaluationRow[],
  usedEvaluationIds: Set<string>,
): EvaluationRow | null {
  const executionTraceId = firstString(trace.executionTraceId);
  if (executionTraceId) {
    const exact = evaluations.find((row) => !usedEvaluationIds.has(evaluationKey(row)) && firstString(row.executionTraceId) === executionTraceId);
    if (exact) return exact;
  }

  const node = firstString(trace.node);
  const attempt = Number(trace.attempt);
  const traceTime = dateMs(trace.completedAt) ?? dateMs(trace.startedAt);
  const candidates = evaluations.filter((row) => {
    if (usedEvaluationIds.has(evaluationKey(row))) return false;
    if (firstString(row.nodeName) !== node) return false;
    return Number(row.attempt) === attempt;
  });
  if (candidates.length === 0) return null;
  if (traceTime == null) return candidates[candidates.length - 1] ?? null;
  return candidates
    .map((row) => ({ row, distance: Math.abs((dateMs(row.createdAt) ?? traceTime) - traceTime) }))
    .sort((a, b) => a.distance - b.distance)[0]?.row ?? null;
}

function withMissingReason(trace: TraceRow, evaluations: EvaluationRow[] | null): TraceRow {
  if (String(trace.type) !== 'agent') return trace;
  if (!trace.contextAttemptId && !trace.contextUsageTraceId && !trace.repoKnowledgeInjected && !trace.contextUsage) {
    return {
      ...trace,
      contextEvaluationMissingReason: 'No repo context packet or usage trace was captured for this agent attempt.',
    };
  }
  if (evaluations && evaluations.length > 0) {
    return {
      ...trace,
      contextEvaluationMissingReason: 'Context evaluation exists for this execution but did not match this specific trace.',
    };
  }
  return {
    ...trace,
    contextEvaluationMissingReason: 'No context evaluation trace was captured for this agent attempt.',
  };
}

function summarizeEvaluation(doc: EvaluationRow): Record<string, unknown> {
  return {
    traceId: doc.traceId,
    status: doc.status,
    scores: doc.scores,
    semantic: doc.semantic,
    diagnostics: normalizeUsageArray(doc.diagnostics).slice(0, 10),
    feedbackEvidenceCount: normalizeUsageArray(doc.feedbackEvidence).length,
  };
}

function summarizeUsage(doc: Record<string, unknown>): Record<string, unknown> {
  return {
    traceId: doc.traceId,
    usageTraceId: doc.usageTraceId,
    preselectedCount: normalizeUsageArray(doc.contextPreselected).length,
    loadedCount: normalizeUsageArray(doc.loaded).length,
    appliedCount: normalizeUsageArray(doc.claimedUsed).length,
    skippedCount: normalizeUsageArray(doc.skipped).length,
    sourceDiscoveryCount: normalizeUsageArray(doc.sourceDiscoveryEvidence).length,
  };
}

function evaluationKey(row: EvaluationRow): string {
  return firstString(row._id, row.traceId) ?? JSON.stringify([row.executionId, row.nodeName, row.attempt, row.packetId, row.usageTraceId]);
}

function traceIdentity(executionId: unknown, nodeName: unknown, attempt: unknown): string {
  return `${String(executionId ?? '')}:${String(nodeName ?? '')}:${Number(attempt ?? 1)}`;
}

function dateMs(value: unknown): number | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.getTime() : null;
  }
  return null;
}
