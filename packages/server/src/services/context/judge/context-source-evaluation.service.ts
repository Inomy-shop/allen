/**
 * ContextSourceEvaluationService — durable ledger for source evaluation outcomes.
 *
 * Collection: context_source_evaluations
 *
 * Each document records the outcome of evaluating one source (workflow_run,
 * spawned_agent_run, chat_turn, context_usage_trace, etc.) during an
 * orchestration session. Both "found findings" and "no issue" outcomes are
 * persisted here so the scheduler's pending discovery can anti-join against
 * this collection and avoid re-evaluating sources that have already been
 * fully processed — including unevaluated older sources that predate the
 * current scheduler cursor.
 *
 * Upsert contract: sourceKey + evaluationVersion is the idempotency key.
 * A rerun or repair-mode agent can revisit the same source by incrementing
 * evaluationVersion; the older record is superseded, not deleted.
 */

import { randomUUID } from 'node:crypto';
import type { Db, Collection } from 'mongodb';
import { sourceEvaluationKey } from './context-judge-policy.js';

export type SourceEvaluationDecision = 'finding_created' | 'no_issue' | 'skipped' | 'error';
export type SourceEvaluationStatus = 'completed' | 'failed' | 'retryable';
export type ContextVerdict = 'correct' | 'wrong' | 'incomplete' | 'missing' | 'not_needed' | 'unjudgeable';

export interface ContextSourceEvaluation {
  evaluationId: string;
  sessionId: string;
  judgeRunId?: string;
  repoId?: string;
  sourceType: string;
  sourceId: string;
  /** "{sourceType}:{sourceId}" — primary lookup / anti-join key. */
  sourceKey: string;
  /** Human-readable kind label (e.g. 'context_usage_trace', 'workflow_run'). */
  sourceKind?: string;
  contextAttemptId?: string;
  executionId?: string;
  flowKind?: string;
  /** Links this evaluation to a trace-analysis assignment if one was used. */
  workerAssignmentId?: string;
  decision: SourceEvaluationDecision;
  status: SourceEvaluationStatus;
  reason?: string;
  classification?: string;
  fixType?: string;
  confidence?: number;
  risk?: string;
  severity?: string;
  findingIds?: string[];
  /** Was the injected context correct/sufficient for this trace? */
  contextCorrect?: boolean | 'unknown';
  contextVerdict?: ContextVerdict;
  contextIncomplete?: boolean;
  contextIrrelevant?: boolean;
  mandatoryMissing?: boolean;
  mandatoryIncorrect?: boolean;
  overFiltered?: boolean;
  overInjected?: boolean;
  wrongScope?: boolean;
  staleContext?: boolean;
  affectedRefIds?: string[];
  expectedContextKinds?: string[];
  remediationHints?: string[];
  /** Structured evidence references for this evaluation. */
  evidence?: Array<{ kind: string; refId?: string; snippet?: string; score?: number; label?: string }>;
  /** Free-text evaluation notes from the worker. */
  notes?: string;
  evidenceSummary?: Record<string, unknown>;
  evaluationVersion: number;
  evaluatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export class ContextSourceEvaluationService {
  private collection: Collection<ContextSourceEvaluation>;

  constructor(private db: Db) {
    this.collection = db.collection<ContextSourceEvaluation>('context_source_evaluations');
  }

  /**
   * Upsert a source evaluation outcome.
   *
   * Idempotency key: `{ sourceKey, evaluationVersion }`.
   * On insert: generates evaluationId, sets createdAt.
   * On update: refreshes mutable fields (decision, status, findingIds, etc.)
   *            and bumps updatedAt / evaluatedAt.
   */
  async upsert(input: {
    sessionId: string;
    judgeRunId?: string;
    repoId?: string;
    sourceType: string;
    sourceId: string;
    sourceKind?: string;
    contextAttemptId?: string;
    executionId?: string;
    flowKind?: string;
    workerAssignmentId?: string;
    decision: SourceEvaluationDecision;
    status: SourceEvaluationStatus;
    reason?: string;
    classification?: string;
    fixType?: string;
    confidence?: number;
    risk?: string;
    severity?: string;
    findingIds?: string[];
    contextCorrect?: boolean | 'unknown';
    contextVerdict?: ContextVerdict;
    contextIncomplete?: boolean;
    contextIrrelevant?: boolean;
    mandatoryMissing?: boolean;
    mandatoryIncorrect?: boolean;
    overFiltered?: boolean;
    overInjected?: boolean;
    wrongScope?: boolean;
    staleContext?: boolean;
    affectedRefIds?: string[];
    expectedContextKinds?: string[];
    remediationHints?: string[];
    evidence?: Array<{ kind: string; refId?: string; snippet?: string; score?: number; label?: string }>;
    notes?: string;
    evidenceSummary?: Record<string, unknown>;
    evaluationVersion?: number;
  }): Promise<ContextSourceEvaluation> {
    const now = new Date();
    const sourceKey = sourceEvaluationKey({
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      repoId: input.repoId,
    });
    const evaluationVersion = input.evaluationVersion ?? 1;

    const mutableFields: Partial<ContextSourceEvaluation> = {
      sessionId: input.sessionId,
      judgeRunId: input.judgeRunId,
      repoId: input.repoId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      sourceKey,
      sourceKind: input.sourceKind,
      contextAttemptId: input.contextAttemptId,
      executionId: input.executionId,
      flowKind: input.flowKind,
      workerAssignmentId: input.workerAssignmentId,
      decision: input.decision,
      status: input.status,
      reason: input.reason,
      classification: input.classification,
      fixType: input.fixType,
      confidence: input.confidence,
      risk: input.risk,
      severity: input.severity,
      findingIds: input.findingIds,
      contextCorrect: input.contextCorrect,
      contextVerdict: input.contextVerdict,
      contextIncomplete: input.contextIncomplete,
      contextIrrelevant: input.contextIrrelevant,
      mandatoryMissing: input.mandatoryMissing,
      mandatoryIncorrect: input.mandatoryIncorrect,
      overFiltered: input.overFiltered,
      overInjected: input.overInjected,
      wrongScope: input.wrongScope,
      staleContext: input.staleContext,
      affectedRefIds: input.affectedRefIds,
      expectedContextKinds: input.expectedContextKinds,
      remediationHints: input.remediationHints,
      evidence: input.evidence,
      notes: input.notes,
      evidenceSummary: input.evidenceSummary,
      evaluationVersion,
      evaluatedAt: now,
      updatedAt: now,
    };

    // Remove undefined values so they don't overwrite existing fields with $set
    for (const key of Object.keys(mutableFields) as (keyof typeof mutableFields)[]) {
      if (mutableFields[key] === undefined) {
        delete mutableFields[key];
      }
    }

    await this.collection.updateOne(
      { sourceKey, evaluationVersion },
      {
        $set: mutableFields,
        $setOnInsert: { evaluationId: randomUUID(), createdAt: now } as any,
      },
      { upsert: true },
    );

    const stored = await this.collection.findOne({ sourceKey, evaluationVersion }) as ContextSourceEvaluation | null;
    const sessionPatch: Record<string, unknown> = {
      updatedAt: now,
    };
    const addToSet: Record<string, unknown> = {};
    const evaluationId = stored?.evaluationId;
    if (evaluationId) addToSet['sourceEvaluationIds'] = evaluationId;
    if (input.judgeRunId) addToSet['judgeRunIds'] = input.judgeRunId;
    if (Array.isArray(input.findingIds) && input.findingIds.length > 0) {
      addToSet['findingIds'] = { $each: input.findingIds };
    }
    if (Object.keys(addToSet).length > 0) {
      await this.db.collection('context_orchestration_sessions').updateOne(
        { sessionId: input.sessionId },
        {
          $set: sessionPatch,
          $addToSet: addToSet,
        } as any,
      );
    }
    // If findOne returns null for some edge case, construct a best-effort return
    if (!stored) {
      return {
        ...mutableFields,
        evaluationId: randomUUID(),
        createdAt: now,
      } as ContextSourceEvaluation;
    }
    return stored;
  }

  /**
   * Find the most recent evaluation for a given sourceKey.
   */
  async findBySourceKey(sourceKey: string): Promise<ContextSourceEvaluation | null> {
    return this.collection.findOne(
      { sourceKey },
      { sort: { evaluatedAt: -1 } },
    ) as Promise<ContextSourceEvaluation | null>;
  }

  /**
   * Check whether a sourceKey has a completed evaluation.
   * Used by the scheduler's anti-join to filter out already-evaluated sources.
   */
  async isEvaluated(sourceKey: string): Promise<boolean> {
    const doc = await this.collection.findOne(
      { sourceKey, status: 'completed' },
      { projection: { _id: 1 } },
    );
    return doc !== null;
  }

  /**
   * List evaluation records for a session, with optional filters.
   */
  async listBySession(
    sessionId: string,
    params?: {
      sourceType?: string;
      decision?: SourceEvaluationDecision;
      limit?: number;
    },
  ): Promise<ContextSourceEvaluation[]> {
    const filter: Record<string, unknown> = { sessionId };
    if (params?.sourceType) filter.sourceType = params.sourceType;
    if (params?.decision) filter.decision = params.decision;
    const limit = Math.min(params?.limit ?? 200, 500);
    return this.collection
      .find(filter as any)
      .sort({ evaluatedAt: -1 })
      .limit(limit)
      .toArray() as Promise<ContextSourceEvaluation[]>;
  }

  /**
   * Count evaluation records for a session, broken down by decision and
   * source type. Used to populate dbSummary source evaluation coverage counts.
   */
  async countBySession(sessionId: string): Promise<{
    total: number;
    byDecision: Partial<Record<SourceEvaluationDecision, number>>;
    byType: Record<string, number>;
  }> {
    const docs = await this.collection
      .find({ sessionId }, { projection: { sourceType: 1, decision: 1 } })
      .toArray();

    const byDecision: Partial<Record<SourceEvaluationDecision, number>> = {};
    const byType: Record<string, number> = {};

    for (const doc of docs) {
      const d = (doc as any).decision as SourceEvaluationDecision;
      byDecision[d] = (byDecision[d] ?? 0) + 1;
      const t = (doc as any).sourceType as string;
      if (t) byType[t] = (byType[t] ?? 0) + 1;
    }

    return { total: docs.length, byDecision, byType };
  }
}
