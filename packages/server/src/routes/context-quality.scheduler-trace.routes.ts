
import type { Request, Response } from 'express';
import { isContextEngineEnabled } from '../services/context/config/context-provider-config.js';
import { param } from '../types.js';
import { contextProviderDisabledPayload, type ContextQualityRouteDeps } from './context-quality.route-utils.js';
import type { Router } from 'express';
import type { SourceEvaluationDecision, SourceEvaluationStatus } from '../services/context/judge/context-source-evaluation.service.js';
import type { TraceAssignmentStatus } from '../services/context/judge/context-trace-analysis-assignment.service.js';
import { parseStringList } from './context-quality.route-utils.js';

export function registerContextQualitySchedulerTraceRoutes(router: Router, deps: ContextQualityRouteDeps): void {
  const { db, scheduler, sourceEvalService, traceAssignmentService } = deps;
    // ─── Scheduler Pending Discovery ─────────────────────────────────────────────
    // The orchestrator agent calls this to discover actual pending work sources
    // (not just cursor state). Delegates to ContextEvaluationScheduler.discoverPending().
    router.get('/scheduler/pending', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const { sourceType, limit, repoId, repoIds: rawRepoIds, allowBackfill } = req.query;
        if (!sourceType) {
          return res.status(400).json({ error: 'sourceType query parameter is required' });
        }
        const parsedLimit = limit ? parseInt(limit as string, 10) : 20;
        // allowBackfill=true ignores the cursor so older unevaluated sources are discoverable
        const backfill = allowBackfill === 'true' || allowBackfill === '1';
  
        // Build repoFilter from query params
        let repoIds: string[] | undefined;
        if (typeof rawRepoIds === 'string') {
          try {
            // Try JSON array first, then comma-separated
            const parsed = JSON.parse(rawRepoIds);
            if (Array.isArray(parsed)) {
              repoIds = parsed as string[];
            }
          } catch {
            repoIds = rawRepoIds.split(',').map((s: string) => s.trim()).filter(Boolean);
          }
        }
        const repoFilter = (repoId || repoIds?.length)
          ? { repoId: repoId as string | undefined, repoIds }
          : undefined;
  
        // Cursor lifecycle: mark running before discovery
        await scheduler.markRunning(sourceType as any, repoFilter);
        try {
          const candidates = await scheduler.discoverPending(
            sourceType as any,
            isNaN(parsedLimit) ? 20 : parsedLimit,
            repoFilter,
            backfill,
          );
          await scheduler.markIdle(sourceType as any, undefined, repoFilter);
          res.json({ sourceType, candidates });
        } catch (innerErr: unknown) {
          await scheduler.markError(sourceType as any, (innerErr as Error).message, repoFilter);
          throw innerErr;
        }
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    // ─── Source Evaluations ──────────────────────────────────────────────────────
    // GAP 1: durable per-source evaluation ledger. Agents log evaluation outcomes
    // (finding_created, no_issue, skipped, error) here. The scheduler anti-joins
    // against this collection to avoid re-evaluating sources.
  
    router.post('/source-evaluations', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const {
          sessionId, judgeRunId, repoId, sourceType, sourceId,
          contextAttemptId, executionId, flowKind,
          decision, status: evalStatus, reason, classification,
          findingIds, evidenceSummary, evaluationVersion,
        } = req.body ?? {};
        if (!sessionId || !sourceType || !sourceId || !decision) {
          return res.status(400).json({ error: 'sessionId, sourceType, sourceId, decision are required' });
        }
        const evaluation = await sourceEvalService.upsert({
          sessionId,
          judgeRunId,
          repoId,
          sourceType,
          sourceId,
          contextAttemptId,
          executionId,
          flowKind,
          decision: decision as SourceEvaluationDecision,
          status: (evalStatus ?? 'completed') as SourceEvaluationStatus,
          reason,
          classification,
          findingIds,
          evidenceSummary,
          evaluationVersion,
        });
        if (sourceType === 'chat_learning' && (evalStatus ?? 'completed') === 'completed') {
          await scheduler.markSourcesEvaluated('chat_learning', [{ sourceId, sourceKind: 'chat_learning', repoId }]);
        }
        res.status(201).json(evaluation);
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    router.get('/source-evaluations', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const { sessionId, sourceType, decision, limit } = req.query;
        if (!sessionId) {
          return res.status(400).json({ error: 'sessionId query parameter is required' });
        }
        const evaluations = await sourceEvalService.listBySession(sessionId as string, {
          sourceType: sourceType as string | undefined,
          decision: decision as SourceEvaluationDecision | undefined,
          limit: limit ? parseInt(limit as string, 10) : undefined,
        });
        res.json(evaluations);
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
    // ─── Unevaluated Context Traces ──────────────────────────────────────────────
    // MCP tool: context_quality_list_unevaluated_traces
    // Exhaustive discovery for the trace-analysis orchestrator.
    // Returns traces NOT yet in context_source_evaluations (completed) AND NOT
    // already in active context_trace_analysis_assignments (non-failed).
    // The orchestrator loops until this returns an empty array.
    // Limit is capped at 20 per call (one assignment batch = one call).
    router.get('/scheduler/unevaluated-traces', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const { repoId, sessionId, limit, cursor, excludeRootExecutionId, excludeExecutionIds, excludeAgentNames } = req.query;
      const parsedLimit = limit ? Math.min(parseInt(limit as string, 10), 20) : 20;
        const candidates = await scheduler.listUnevaluatedContextTraces({
          repoId: repoId as string | undefined,
          sessionId: sessionId as string | undefined,
          limit: isNaN(parsedLimit) ? 20 : parsedLimit,
          cursor: cursor as string | undefined,
          excludeRootExecutionId: excludeRootExecutionId as string | undefined,
          excludeExecutionIds: parseStringList(excludeExecutionIds),
          excludeAgentNames: parseStringList(excludeAgentNames),
        });
        res.json({ candidates, count: candidates.length });
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    // ─── Trace Analysis Assignments ───────────────────────────────────────────────
    // MCP tool: context_quality_create_trace_analysis_assignment
    // Workers call this to register their batch of traces before starting evaluation.
    // One assignment = one worker batch = at most 20 contextAttemptIds.
    router.post('/trace-analysis-assignments', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const { sessionId, repoId, sourceIds, workerAgentName, retryOfAssignmentId } = req.body ?? {};
        if (!sessionId || !Array.isArray(sourceIds) || sourceIds.length === 0) {
          return res.status(400).json({
            error: 'sessionId and sourceIds (non-empty array) are required',
          });
        }
        if (sourceIds.length > 20) {
          return res.status(400).json({
            error: 'sourceIds must contain at most 20 trace IDs per assignment',
          });
        }
        const assignment = await traceAssignmentService.create({
          sessionId: sessionId as string,
          repoId: repoId as string | undefined,
          sourceIds: sourceIds as string[],
          workerAgentName: workerAgentName as string | undefined,
          retryOfAssignmentId: retryOfAssignmentId as string | undefined,
        });
        res.status(201).json(assignment);
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    // MCP tool: context_quality_create_trace_analysis_wave
    // Creates up to 4 non-overlapping trace-analysis assignments for one parallel wave.
    router.post('/trace-analysis-assignments/wave', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const {
          sessionId,
          repoId,
          maxAssignments,
          limitPerAssignment,
          excludeRootExecutionId,
          excludeExecutionIds,
          excludeAgentNames,
        } = req.body ?? {};
        if (!sessionId) {
          return res.status(400).json({ error: 'sessionId is required' });
        }
  
        const assignmentLimit = Math.min(Math.max(Number(maxAssignments ?? 4) || 4, 1), 4);
        const traceLimit = Math.min(Math.max(Number(limitPerAssignment ?? 20) || 20, 1), 20);
        const assignments = [];
        let assignedTraceCount = 0;
        let exhausted = false;
        let cursor: string | undefined;
  
        for (let i = 0; i < assignmentLimit; i++) {
          const candidates = await scheduler.listUnevaluatedContextTraces({
            repoId: repoId as string | undefined,
            sessionId: sessionId as string,
            limit: traceLimit,
            cursor,
            excludeRootExecutionId: excludeRootExecutionId as string | undefined,
            excludeExecutionIds: Array.isArray(excludeExecutionIds) ? excludeExecutionIds.map(String) : undefined,
            excludeAgentNames: Array.isArray(excludeAgentNames) ? excludeAgentNames.map(String) : undefined,
          });
          if (candidates.length === 0) {
            exhausted = true;
            break;
          }
  
          const sourceIds = candidates
            .map((candidate: { contextAttemptId?: string; sourceId?: string }) => candidate.contextAttemptId ?? candidate.sourceId)
            .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0);
          const assignment = await traceAssignmentService.create({
            sessionId: sessionId as string,
            repoId: repoId as string | undefined,
            sourceIds,
            workerAgentName: 'context-trace-analysis-agent',
          });
          assignments.push(assignment);
          assignedTraceCount += sourceIds.length;
          cursor = sourceIds[sourceIds.length - 1];
  
          if (sourceIds.length < traceLimit) {
            exhausted = true;
            break;
          }
        }
  
        res.status(201).json({
          assignments,
          assignedTraceCount,
          exhausted,
          maxAssignments: assignmentLimit,
          limitPerAssignment: traceLimit,
        });
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    // MCP tool: context_quality_list_trace_analysis_assignments
    router.get('/trace-analysis-assignments', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const { sessionId, status, limit, offset } = req.query;
        const assignments = await traceAssignmentService.list({
          sessionId: sessionId as string | undefined,
          status: status as TraceAssignmentStatus | undefined,
          limit: limit ? parseInt(limit as string, 10) : undefined,
          offset: offset ? parseInt(offset as string, 10) : undefined,
        });
        res.json(assignments);
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    // GET /trace-analysis-assignments/:assignmentId
    router.get('/trace-analysis-assignments/:assignmentId', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const assignment = await traceAssignmentService.get(param(req, 'assignmentId'));
        if (!assignment) return res.status(404).json({ error: 'Trace analysis assignment not found' });
        res.json(assignment);
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    // MCP tool: context_quality_update_trace_analysis_assignment
    // Workers call this to report progress and lifecycle transitions.
    router.patch('/trace-analysis-assignments/:assignmentId', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const {
          status,
          workerExecutionId,
          workerAgentName,
          evaluatedCount,
          skippedCount,
          failedCount,
          findingCount,
          error,
          terminalReason,
        } = req.body ?? {};
        const updated = await traceAssignmentService.update(param(req, 'assignmentId'), {
          status: status as TraceAssignmentStatus | undefined,
          workerExecutionId,
          workerAgentName,
          evaluatedCount,
          skippedCount,
          failedCount,
          findingCount,
          error,
          terminalReason,
        });
        if (!updated) return res.status(404).json({ error: 'Trace analysis assignment not found or not updated' });
        res.json({ updated: true });
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    // ─── Enhanced Source Evaluations ─────────────────────────────────────────────
    // MCP tool: context_quality_submit_source_evaluation
    // Accepts all ENG-1760 fields including workerAssignmentId, contextCorrect, evidence, etc.
    // This route supersedes the previous /source-evaluations POST and accepts all new fields.
    // (The route path is the same; the handler is enhanced to accept new fields.)
    // Note: the existing POST /source-evaluations handler above already handles the basic fields.
    // We add a dedicated enhanced alias route for explicit MCP tool mapping.
    router.post('/source-evaluations/submit', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const {
          sessionId, judgeRunId, repoId, sourceType, sourceId,
          sourceKind, contextAttemptId, executionId, flowKind,
          workerAssignmentId,
          decision, status: evalStatus, reason, classification,
          fixType, confidence, risk, severity,
          findingIds, evidenceSummary,
          contextCorrect, contextVerdict, contextIncomplete, contextIrrelevant,
          mandatoryMissing, mandatoryIncorrect,
          overFiltered, overInjected, wrongScope, staleContext,
          affectedRefIds, expectedContextKinds, remediationHints,
          evidence, notes,
          evaluationVersion,
        } = req.body ?? {};
        if (!sessionId || !sourceType || !sourceId || !decision) {
          return res.status(400).json({
            error: 'sessionId, sourceType, sourceId, decision are required',
          });
        }
        const evaluation = await sourceEvalService.upsert({
          sessionId,
          judgeRunId,
          repoId,
          sourceType,
          sourceId,
          sourceKind,
          contextAttemptId,
          executionId,
          flowKind,
          workerAssignmentId,
          decision: decision as SourceEvaluationDecision,
          status: (evalStatus ?? 'completed') as SourceEvaluationStatus,
          reason,
          classification,
          fixType,
          confidence,
          risk,
          severity,
          findingIds,
          contextCorrect,
          contextVerdict,
          contextIncomplete,
          contextIrrelevant,
          mandatoryMissing,
          mandatoryIncorrect,
          overFiltered,
          overInjected,
          wrongScope,
          staleContext,
          affectedRefIds,
          expectedContextKinds,
          remediationHints,
          evidence,
          notes,
          evidenceSummary,
          evaluationVersion,
        });
        if (sourceType === 'chat_learning' && (evalStatus ?? 'completed') === 'completed') {
          await scheduler.markSourcesEvaluated('chat_learning', [{ sourceId, sourceKind: 'chat_learning', repoId }]);
        }
        res.status(201).json(evaluation);
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
}
