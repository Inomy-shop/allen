import type { Db } from 'mongodb';
import { firstString, isRecord } from '../allen-knowledge-graph/repo-knowledge-graph-utils.js';
import { normalizeUsageArray } from '../allen-knowledge-graph/repo-knowledge-graph-usage.js';

type EvaluationRow = Record<string, unknown>;
type TraceRow = Record<string, unknown>;

export async function hydrateTraceContextEvaluations(
  db: Db,
  executionId: string,
  traces: TraceRow[],
): Promise<TraceRow[]> {
  if (traces.length === 0) return traces;
  const evaluations = await db.collection('context_evaluation_traces')
    .find({ executionId })
    .sort({ createdAt: 1 })
    .toArray();
  if (evaluations.length === 0) {
    return traces.map((trace) => withMissingReason(trace, null));
  }

  const usedEvaluationIds = new Set<string>();
  return traces.map((trace) => {
    if (isRecord(trace.contextEvaluation)) return trace;
    const match = findBestEvaluation(trace, evaluations, usedEvaluationIds);
    if (!match) return withMissingReason(trace, evaluations);
    usedEvaluationIds.add(evaluationKey(match));
    return {
      ...trace,
      contextEvaluation: summarizeEvaluation(match),
    };
  });
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
  if (!trace.repoKnowledgeInjected && !trace.contextUsage) {
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

function evaluationKey(row: EvaluationRow): string {
  return firstString(row._id, row.traceId) ?? JSON.stringify([row.executionId, row.nodeName, row.attempt, row.packetId, row.usageTraceId]);
}

function dateMs(value: unknown): number | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.getTime() : null;
  }
  return null;
}
