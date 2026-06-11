
import type { Request, Response } from 'express';
import { isContextEngineEnabled } from '../services/context/config/context-provider-config.js';
import { param } from '../types.js';
import { contextProviderDisabledPayload, type ContextQualityRouteDeps } from './context-quality.route-utils.js';
import type { Router } from 'express';
import type { JudgeScope } from '../services/context/judge/context-judge.types.js';

export function registerContextQualityOrchestratorRoutes(router: Router, deps: ContextQualityRouteDeps): void {
  const { db, orchestratorService, workerOrchestrator, reviewService, promotionService, resolvedAdapter } = deps;
    // ─── Orchestrator Sessions ────────────────────────────────────────────────────
  
    router.get('/orchestrator/sessions', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const { scope, status, limit, offset } = req.query;
        const sessions = await orchestratorService.listSessions({
          scope: scope as JudgeScope | undefined,
          status: status as string | undefined,
          limit: limit ? parseInt(limit as string, 10) : undefined,
          offset: offset ? parseInt(offset as string, 10) : undefined,
        });
        res.json(sessions);
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    router.post('/orchestrator/sessions', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const { agentModel, agentProvider, agentRationale, scope, runScope, sourceId, sourceKind, repoId, dry_run, rootExecutionId } = req.body ?? {};
        const resolvedRootExecutionId = rootExecutionId ?? req.header('x-allen-root-execution-id') ?? undefined;
        if (!scope) {
          return res.status(400).json({ error: 'scope is required' });
        }
        const session = await orchestratorService.beginOrchestration({
          agentModel,
          agentProvider,
          agentRationale,
          scope: scope as JudgeScope,
          runScope: runScope as any,
          sourceId,
          sourceKind,
          repoId,
          dry_run: dry_run === true,
          rootExecutionId: resolvedRootExecutionId,
        });
        res.status(201).json(session);
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    router.get('/orchestrator/sessions/:sessionId', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const session = await orchestratorService.getSessionWithSummary(param(req, 'sessionId'));
        if (!session) return res.status(404).json({ error: 'Orchestration session not found' });
        res.json(session);
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    router.post('/orchestrator/sessions/:sessionId/decisions', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const { kind, detail, metadata } = req.body ?? {};
        if (!kind || !detail) {
          return res.status(400).json({ error: 'kind and detail are required' });
        }
        await orchestratorService.logAgentDecision(param(req, 'sessionId'), {
          at: new Date(),
          kind,
          detail,
          metadata,
        });
        res.status(201).json({ success: true });
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    router.post('/orchestrator/sessions/:sessionId/findings', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const { findings } = req.body ?? {};
        if (!Array.isArray(findings)) {
          return res.status(400).json({ error: 'findings must be an array' });
        }
        // Fix 1: Load config from db with lazy-bootstrap fallback.
        // If the singleton config is missing (e.g. missed startup bootstrap),
        // upsert it idempotently rather than returning 409. This prevents
        // context_quality_submit_findings from failing just because bootstrap
        // ran before the DB was ready or was interrupted.
        let config = await db.collection('context_judge_config').findOne({ configId: 'singleton' }) as any;
        if (!config) {
          const defaultConfig = {
            configId: 'singleton',
            autoRemediationEnabled: false,
            autoRemediationThresholds: { minConfidence: 0.85, maxRisk: 'low', allowedFixTypes: ['no_action'] },
            mandatoryHumanReview: {
              lowConfidenceThreshold: 0.5,
              highRiskLevels: ['high', 'critical'],
              alwaysForScopes: ['cross_repo', 'global'],
              alwaysForLearningDerived: true,
              alwaysForCodeFix: true,
            },
            updatedAt: new Date(),
          };
          await db.collection('context_judge_config').updateOne(
            { configId: 'singleton' },
            { $setOnInsert: defaultConfig },
            { upsert: true },
          );
          config = await db.collection('context_judge_config').findOne({ configId: 'singleton' }) as any;
        }
        if (!config) {
          // Should never happen after the upsert above, but be explicit
          return res.status(500).json({
            error: 'context_judge_config singleton could not be created. Check DB connectivity.',
            code: 'CONFIG_BOOTSTRAP_FAILED',
          });
        }
        const result = await orchestratorService.submitFindings(
          param(req, 'sessionId'),
          findings,
          config,
        );
        res.status(201).json(result);
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    router.post('/orchestrator/sessions/:sessionId/finalize', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const { summary } = req.body ?? {};
        const session = await orchestratorService.finalizeOrchestration(param(req, 'sessionId'), summary);
        res.json(session);
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    router.get('/orchestrator/sessions/:sessionId/stage-state', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const session = await orchestratorService.getSession(param(req, 'sessionId'));
        if (!session) return res.status(404).json({ error: 'Orchestration session not found' });
        res.json(await orchestratorService.computeStageState(param(req, 'sessionId')));
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    router.post('/orchestrator/repair-state', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const { sessionId, rootExecutionId, executionId } = req.body ?? {};
        const state = await orchestratorService.getRepairResumeState({
          sessionId,
          rootExecutionId: rootExecutionId ?? executionId,
        });
        if (!state.found) return res.status(404).json(state);
        res.json(state);
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    // ─── Worker Assignments ──────────────────────────────────────────────────────
  
    // List worker assignments
    router.get('/worker-assignments', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const { status, limit } = req.query;
        const assignments = await workerOrchestrator.listAssignments({
          status: status as string | undefined,
          limit: limit ? parseInt(limit as string, 10) : undefined,
        });
        res.json(assignments);
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    // Create worker assignment
    router.post('/worker-assignments', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const { maxBatch, workerAgentName, workerRole, repoId, repoIds, allowBackfill, remediationIds, repairMode, rootExecutionId, sessionId } = req.body ?? {};
        const result = await workerOrchestrator.assignBacklog({
          maxBatch,
          workerAgentName,
          workerRole,
          repoId,
          repoIds,
          allowBackfill,
          remediationIds,
          repairMode,
          rootExecutionId,
          sessionId,
        });
        res.status(201).json(result);
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    // Dispatch assignment to Allen agent
    router.post('/worker-assignments/:assignmentId/dispatch', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const result = await workerOrchestrator.dispatchAssignmentToAgent(param(req, 'assignmentId'));
        res.json(result);
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    // List agent dispatch queue
    router.get('/agent-dispatch-queue', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const { status, limit } = req.query;
        const records = await workerOrchestrator.listDispatchQueue({
          status: status as string | undefined,
          limit: limit ? parseInt(limit as string, 10) : undefined,
        });
        res.json(records);
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    // ─── Review Task Split ───────────────────────────────────────────────────────
  
    // Split cross-repo/global task
    router.post('/review/:taskId/split', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const { repoIds } = req.body ?? {};
        if (!Array.isArray(repoIds) || repoIds.length === 0) {
          return res.status(400).json({ error: 'repoIds must be a non-empty array' });
        }
        const children = await reviewService.splitCrossRepoTask(param(req, 'taskId'), repoIds);
        res.status(201).json(children);
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    // ─── Learning Promotion Validation ──────────────────────────────────────────
  
    router.patch('/learning-promotions/:id/validation', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const updated = await promotionService.updateValidation(param(req, 'id'), req.body ?? {});
        if (!updated) return res.status(404).json({ error: 'Promotion not found' });
        res.json(updated);
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
    // ─── Scheduler State ─────────────────────────────────────────────────────────
  
    router.get('/scheduler-state', async (_req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const rows = await db
          .collection('context_judge_scheduler_state')
          .find({})
          .toArray();
        res.json(rows);
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    // ─── Orchestrator Run Records ────────────────────────────────────────────────
  
    router.post('/orchestrator/trigger', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const { repoId, repoIds: rawRepoIds, global: rawGlobal, triggeredBy } = req.body ?? {};
  
        // Parse repoIds: accept array or comma-separated string
        let repoIds: string[] | undefined;
        if (Array.isArray(rawRepoIds)) {
          repoIds = rawRepoIds as string[];
        } else if (typeof rawRepoIds === 'string') {
          repoIds = rawRepoIds.split(',').map((s: string) => s.trim()).filter(Boolean);
        }
  
        const isGlobal = rawGlobal !== undefined
          ? Boolean(rawGlobal)
          : (!repoId && !(repoIds && repoIds.length > 0));
  
        const triggeredByValue: string = triggeredBy ?? 'api';
  
        const record = await orchestratorService.createRunRecord({
          triggeredBy: triggeredByValue as any,
          repoId,
          repoIds,
          global: isGlobal,
        });
  
        // Fire-and-forget: dispatch to the orchestrator agent asynchronously.
        // Any error here must NOT propagate to the HTTP response.
        void (async () => {
          try {
            await orchestratorService.updateRunRecord(record.runId, { status: 'running' });
            const result = await resolvedAdapter.dispatch({
              runId: record.runId,
              triggeredBy: triggeredByValue,
              repoId,
              repoIds,
              global: isGlobal,
            });
            if (!result.queued) {
              // Adapter was a no-op (Null adapter) — mark completed so state is consistent
              await orchestratorService.updateRunRecord(record.runId, { status: 'completed' });
            }
            // If queued, the spawned agent is responsible for updating status to completed/failed
          } catch (err: unknown) {
            await orchestratorService.updateRunRecord(record.runId, {
              status: 'failed',
              errors: [(err as Error).message],
            });
          }
        })();
  
        res.status(201).json(record);
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    router.get('/orchestrator/runs', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const { status, limit, offset } = req.query;
        const records = await orchestratorService.listRunRecords({
          status: status as string | undefined,
          limit: limit ? parseInt(limit as string, 10) : undefined,
          offset: offset ? parseInt(offset as string, 10) : undefined,
        });
        res.json(records);
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
    // Update worker assignment lifecycle (workers call this to report status)
    // The dispatch queue is audit/fallback; this is for worker → orchestrator reporting.
    router.patch('/worker-assignments/:assignmentId', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const { status, notes, result, agentRunId, agentExecutionId, workerRole, agentName } = req.body ?? {};
        const updated = await workerOrchestrator.updateAssignment(
          param(req, 'assignmentId'),
          { status, notes, result, agentRunId, agentExecutionId, workerRole, agentName },
        );
        if (!updated) return res.status(404).json({ error: 'Assignment not found or not updated' });
        res.json({ updated: true });
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
}
