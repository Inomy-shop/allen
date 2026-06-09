
import type { Request, Response } from 'express';
import { isContextEngineEnabled } from '../services/context/config/context-provider-config.js';
import { contextProviderDisabledPayload, type ContextQualityRouteDeps } from './context-quality.route-utils.js';
import type { Router } from 'express';

export function registerContextQualityUsageRoutes(router: Router, deps: ContextQualityRouteDeps): void {
  const { db } = deps;
    // ─── Unified Context Usage Trace (Fix 2) ─────────────────────────────────────
    // Resolves context usage trace by executionId OR contextAttemptId.
    // Normalizes identifiers across injection flows: { sourceId, executionId, contextAttemptId,
    //   sourceKind, flowKind } plus injection metadata.
    //
    // Problem solved: context_usage_trace pending candidates expose contextAttemptId
    // but get_node_context_usage(execution_id) only accepts executionId. This endpoint
    // bridges that gap by accepting either and resolving the other.
    router.get('/usage-trace', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const executionId = firstQueryString(req.query.executionId);
        const contextAttemptId = firstQueryString(req.query.contextAttemptId);
        const sessionId = firstQueryString(req.query.sessionId);
        if (!executionId && !contextAttemptId && !sessionId) {
          return res.status(400).json({ error: 'executionId, contextAttemptId, or sessionId is required' });
        }

        const attempts = await resolveContextAttempts(db, { executionId, contextAttemptId, sessionId });
        const attempt = attempts[0];
  
        if (!attempt) {
          // Fall back: if lookup by executionId found no attempt, still try the
          // execution-level context usage (different pipeline)
          const execId = executionId ?? sessionId;
          if (execId) {
            const usageData = await db.collection('memory_injection_audits').findOne(
              { executionId: execId },
              { projection: { _id: 0 } },
            );
            if (usageData) {
              return res.json({
                sourceId: execId,
                executionId: execId,
                contextAttemptId: null,
                sourceKind: 'workflow_run',
                flowKind: 'execution_level',
                injectionData: usageData,
                resolved: true,
              });
            }
          }
          return res.status(404).json({ error: 'No context attempt found for the provided identifier' });
        }
  
        const injection = (attempt as Record<string, unknown>)['contextInjection'] as Record<string, unknown> | undefined;
        const resolvedExecutionId = (attempt as Record<string, unknown>)['executionId'] as string | undefined;
        const resolvedAttemptId = (attempt as Record<string, unknown>)['contextAttemptId'] as string | undefined;
  
        // Derive sourceKind from executionKind
        const execKind = firstQueryString((attempt as Record<string, unknown>)['executionKind']);
        const sourceKind = sourceKindForExecutionKind(execKind);
        const matchingContextAttempts = attempts.map(compactAttempt);
  
        return res.json({
          // Normalized identifiers for judge agent
          sourceId: resolvedAttemptId ?? resolvedExecutionId,
          executionId: resolvedExecutionId,
          contextAttemptId: resolvedAttemptId,
          contextAttemptIds: matchingContextAttempts.map((row) => row.contextAttemptId).filter(Boolean),
          matchingContextAttempts,
          attemptCount: matchingContextAttempts.length,
          sourceKind,
          flowKind: execKind ?? 'unknown',
          // Injection metadata
          repoId: (attempt as Record<string, unknown>)['repoId'],
          repoName: (attempt as Record<string, unknown>)['repoName'],
          workflowName: (attempt as Record<string, unknown>)['workflowName'],
          nodeName: (attempt as Record<string, unknown>)['nodeName'],
          status: (attempt as Record<string, unknown>)['status'],
          consideredCount: injection?.['consideredCount'],
          injectedCount: injection?.['injectedCount'],
          createdAt: (attempt as Record<string, unknown>)['createdAt'],
          resolved: true,
        });
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    router.get('/usage-trace/replay', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const executionId = firstQueryString(req.query.executionId);
        const contextAttemptId = firstQueryString(req.query.contextAttemptId);
        const sessionId = firstQueryString(req.query.sessionId);
        if (!executionId && !contextAttemptId && !sessionId) {
          return res.status(400).json({ error: 'executionId, contextAttemptId, or sessionId is required' });
        }
  
        const attempts = await resolveContextAttempts(db, { executionId, contextAttemptId, sessionId }, { full: true });
        const attempt = attempts[0];
        if (!attempt) return res.status(404).json({ error: 'No context attempt found for replay' });
  
        const resolvedAttemptId = String((attempt as any).contextAttemptId ?? '');
        const refs = await db.collection('context_refs')
          .find({ contextAttemptId: resolvedAttemptId }, { projection: { _id: 0, embedding: 0 } })
          .sort({ rank: 1, finalRank: 1, createdAt: 1 })
          .toArray();
  
        const compactRef = (ref: any) => ({
          refId: ref.refId,
          title: ref.title,
          path: ref.path,
          providerId: ref.providerId,
          grounding: ref.grounding,
          kind: ref.kind,
          itemType: ref.itemType,
          rank: ref.rank,
          score: ref.score,
          finalRelevanceScore: ref.finalRelevanceScore,
          rerankerScore: ref.rerankerScore,
          filterReason: ref.filterReason,
          rejectionReason: ref.rejectionReason ?? ref.providerMetadata?.rejectionReason,
          injectionPolicy: ref.injectionPolicy,
          injectionDecision: ref.metadataSummary?.injectionDecision ?? ref.providerMetadata?.injectionDecision,
          curationEntryId: ref.providerMetadata?.curationEntryId ?? ref.providerMetadata?.sourceMetadata?.entryId,
          curationCategory: ref.providerMetadata?.curationCategory,
          curatedInjectionPolicy: ref.providerMetadata?.curatedInjectionPolicy,
          retrievalReasons: ref.providerMetadata?.retrievalReasons,
        });
  
        const isRejected = (ref: any) => Boolean(ref.filterReason || ref.rejectionReason || ref.providerMetadata?.rejectionReason);
        const isBudgetSkipped = (ref: any) => /budget/i.test(String(ref.filterReason ?? ref.rejectionReason ?? ref.providerMetadata?.rejectionReason ?? ref.reason ?? ''));
        const isInjected = (ref: any) => !isRejected(ref)
          && String(ref.injectionPolicy ?? '').toLowerCase() !== 'manifest_only'
          && String(ref.metadataSummary?.injectionDecision ?? ref.providerMetadata?.injectionDecision ?? '').toLowerCase() !== 'manifest_only';
  
        const curationEntryIds = Array.from(new Set(refs
          .map((ref: any) => ref.providerMetadata?.curationEntryId ?? ref.providerMetadata?.sourceMetadata?.entryId)
          .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)));
        const paths = Array.from(new Set(refs.map((ref: any) => ref.path).filter((p: unknown): p is string => typeof p === 'string' && p.length > 0)));
        const curationEntries = await db.collection('repo_context_curation_entries')
          .find({
            active: { $ne: false },
            $or: [
              { entryId: { $in: curationEntryIds } },
              { 'entry.entryId': { $in: curationEntryIds } },
              { path: { $in: paths } },
              { 'entry.path': { $in: paths } },
            ],
          }, {
            projection: {
              _id: 0,
              entryId: 1,
              entryKey: 1,
              path: 1,
              repoId: 1,
              'entry.title': 1,
              'entry.category': 1,
              'entry.injectionPolicy': 1,
              'entry.appliesToGlobs': 1,
              'entry.aliases': 1,
              'entry.reasoning': 1,
            },
          })
          .limit(100)
          .toArray();
  
        const buildReplayForAttempt = async (row: Record<string, unknown>) => {
          const attemptId = String(row.contextAttemptId ?? '');
          const rowRefs = await db.collection('context_refs')
            .find({ contextAttemptId: attemptId }, { projection: { _id: 0, embedding: 0 } })
            .sort({ rank: 1, finalRank: 1, createdAt: 1 })
            .toArray();
          return {
            contextAttemptId: attemptId,
            executionId: row.executionId,
            sourceKind: sourceKindForExecutionKind(firstQueryString(row.executionKind)),
            flowKind: row.executionKind,
            candidateRefs: rowRefs.map(compactRef),
            selectedRefs: rowRefs.filter((ref: any) => !isRejected(ref)).map(compactRef),
            injectedRefs: rowRefs.filter(isInjected).map(compactRef),
            rejectedRefs: rowRefs.filter(isRejected).map(compactRef),
            skippedBudgetRefs: rowRefs.filter(isBudgetSkipped).map(compactRef),
          };
        };
        const attemptReplays = attempts.length > 1
          ? await Promise.all(attempts.map((row) => buildReplayForAttempt(row as Record<string, unknown>)))
          : undefined;

        return res.json({
          replayId: `captured:${resolvedAttemptId}`,
          replayMode: 'captured_production_envelope',
          liveReplay: false,
          reason: 'Reconstructed from persisted context_attempts/context_refs captured by the production retrieval/injection path.',
          contextAttemptId: resolvedAttemptId,
          executionId: (attempt as any).executionId,
          repoId: (attempt as any).repoId,
          repoName: (attempt as any).repoName,
          workflowName: (attempt as any).workflowName,
          nodeName: (attempt as any).nodeName,
          status: (attempt as any).status,
          contextAttemptIds: attempts.map((row) => String((row as any).contextAttemptId ?? '')).filter(Boolean),
          matchingContextAttempts: attempts.map(compactAttempt),
          attemptCount: attempts.length,
          contextInjection: (attempt as any).contextInjection,
          candidateRefs: refs.map(compactRef),
          selectedRefs: refs.filter((ref: any) => !isRejected(ref)).map(compactRef),
          injectedRefs: refs.filter(isInjected).map(compactRef),
          rejectedRefs: refs.filter(isRejected).map(compactRef),
          skippedBudgetRefs: refs.filter(isBudgetSkipped).map(compactRef),
          curatedEntryMatches: curationEntries,
          attemptReplays,
        });
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
}

function firstQueryString(value: unknown): string | undefined {
  if (Array.isArray(value)) return firstQueryString(value[0]);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function sourceKindForExecutionKind(executionKind?: string): string {
  if (executionKind === 'workflow_node') return 'workflow_run';
  if (executionKind === 'spawned_agent') return 'spawned_agent_run';
  if (executionKind === 'chat' || executionKind === 'chat_agent' || executionKind === 'chat_turn') return 'chat_turn';
  return 'context_usage_trace';
}

function compactAttempt(attempt: Record<string, unknown>): Record<string, unknown> {
  const injection = isRecord(attempt.contextInjection) ? attempt.contextInjection : {};
  return {
    contextAttemptId: attempt.contextAttemptId,
    executionId: attempt.executionId,
    sourceId: attempt.contextAttemptId ?? attempt.executionId,
    sourceKind: sourceKindForExecutionKind(firstQueryString(attempt.executionKind)),
    flowKind: attempt.executionKind,
    repoId: attempt.repoId,
    repoName: attempt.repoName,
    workflowName: attempt.workflowName,
    nodeName: attempt.nodeName,
    status: attempt.status,
    consideredCount: injection.consideredCount,
    injectedCount: injection.injectedCount,
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
  };
}

async function resolveContextAttempts(
  db: ContextQualityRouteDeps['db'],
  input: { executionId?: string; contextAttemptId?: string; sessionId?: string },
  options: { full?: boolean } = {},
): Promise<Array<Record<string, unknown>>> {
  const projection = options.full ? { _id: 0 } : {
    _id: 0,
    contextAttemptId: 1,
    executionId: 1,
    repoId: 1,
    repoName: 1,
    workflowName: 1,
    nodeName: 1,
    executionKind: 1,
    status: 1,
    'contextInjection.consideredCount': 1,
    'contextInjection.injectedCount': 1,
    createdAt: 1,
    updatedAt: 1,
  };

  if (input.contextAttemptId) {
    return db.collection('context_attempts').find(
      { contextAttemptId: input.contextAttemptId },
      { projection },
    ).sort({ createdAt: 1 }).toArray();
  }

  const identifiers = Array.from(new Set([input.executionId, input.sessionId].filter((value): value is string => Boolean(value))));
  const relatedIds = new Set<string>(identifiers);
  if (input.executionId) {
    const execution = await db.collection('executions').findOne(
      { id: input.executionId },
      { projection: { _id: 0, id: 1, rootExecutionId: 1, parentExecutionId: 1, source: 1, input: 1, meta: 1 } },
    ).catch(() => null);
    if (isRecord(execution)) {
      for (const value of [
        execution.id,
        execution.rootExecutionId,
        execution.parentExecutionId,
        isRecord(execution.meta) ? execution.meta.chatSessionId : undefined,
        isRecord(execution.meta) ? execution.meta.sessionId : undefined,
        isRecord(execution.input) ? execution.input.chatSessionId : undefined,
        isRecord(execution.input) ? execution.input.sessionId : undefined,
      ]) {
        const id = firstQueryString(value);
        if (id) relatedIds.add(id);
      }
    }
  }
  if (relatedIds.size === 0) return [];
  const ids = [...relatedIds];
  return db.collection('context_attempts').find({
    $or: [
      { executionId: { $in: ids } },
      { rootExecutionId: { $in: ids } },
      { parentExecutionId: { $in: ids } },
      { chatSessionId: { $in: ids } },
      { sessionId: { $in: ids } },
    ],
  }, { projection }).sort({ createdAt: 1 }).toArray();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
