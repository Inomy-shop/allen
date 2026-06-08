
import type { Request, Response } from 'express';
import { isContextEngineEnabled } from '../services/context/config/context-provider-config.js';
import { param } from '../types.js';
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
        const { executionId, contextAttemptId } = req.query;
        if (!executionId && !contextAttemptId) {
          return res.status(400).json({ error: 'executionId or contextAttemptId is required' });
        }
  
        // Query context_attempts to resolve the attempt
        const attemptQuery: Record<string, unknown> = {};
        if (contextAttemptId) {
          attemptQuery['contextAttemptId'] = String(contextAttemptId);
        } else {
          // When executionId is given, find the primary attempt for that execution
          attemptQuery['executionId'] = String(executionId);
        }
  
        const attempt = await db.collection('context_attempts').findOne(attemptQuery, {
          projection: {
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
          },
        });
  
        if (!attempt) {
          // Fall back: if lookup by executionId found no attempt, still try the
          // execution-level context usage (different pipeline)
          if (executionId) {
            const execId = String(executionId);
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
        const execKind = (attempt as Record<string, unknown>)['executionKind'] as string | undefined;
        let sourceKind = 'context_usage_trace';
        if (execKind === 'workflow_node') sourceKind = 'workflow_run';
        else if (execKind === 'spawned_agent') sourceKind = 'spawned_agent_run';
        else if (execKind === 'chat') sourceKind = 'chat_turn';
  
        return res.json({
          // Normalized identifiers for judge agent
          sourceId: resolvedAttemptId ?? resolvedExecutionId,
          executionId: resolvedExecutionId,
          contextAttemptId: resolvedAttemptId,
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
        const { executionId, contextAttemptId } = req.query;
        if (!executionId && !contextAttemptId) {
          return res.status(400).json({ error: 'executionId or contextAttemptId is required' });
        }
  
        const attemptQuery: Record<string, unknown> = {};
        if (contextAttemptId) attemptQuery['contextAttemptId'] = String(contextAttemptId);
        else attemptQuery['executionId'] = String(executionId);
  
        const attempt = await db.collection('context_attempts').findOne(attemptQuery, {
          projection: { _id: 0 },
        });
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
          contextInjection: (attempt as any).contextInjection,
          candidateRefs: refs.map(compactRef),
          selectedRefs: refs.filter((ref: any) => !isRejected(ref)).map(compactRef),
          injectedRefs: refs.filter(isInjected).map(compactRef),
          rejectedRefs: refs.filter(isRejected).map(compactRef),
          skippedBudgetRefs: refs.filter(isBudgetSkipped).map(compactRef),
          curatedEntryMatches: curationEntries,
        });
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
}
