
import type { Request, Response } from 'express';
import { isContextEngineEnabled } from '../services/context/config/context-provider-config.js';
import { param } from '../types.js';
import { contextProviderDisabledPayload, type ContextQualityRouteDeps } from './context-quality.route-utils.js';
import type { Router } from 'express';
import type { JudgeScope } from '../services/context/judge/context-judge.types.js';

export function registerContextQualityJudgeReviewRoutes(router: Router, deps: ContextQualityRouteDeps): void {
  const { db, judgeService, findingService, reviewService } = deps;
    // ─── Judge Runs ─────────────────────────────────────────────────────────────
  
    router.get('/judge-runs', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const { scope, status, active, limit, offset } = req.query;
        const runs = await judgeService.listJudgeRuns({
          scope: scope as JudgeScope | undefined,
          status: status as string | undefined,
          active: active !== undefined ? active === 'true' : undefined,
          limit: limit ? parseInt(limit as string, 10) : undefined,
          offset: offset ? parseInt(offset as string, 10) : undefined,
        });
        res.json(runs);
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    router.post('/judge-runs', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const result = await judgeService.judge(req.body ?? {});
        res.status(201).json(result);
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    router.get('/judge-runs/:judgeRunId', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const run = await judgeService.getJudgeRun(param(req, 'judgeRunId'));
        if (!run) return res.status(404).json({ error: 'Judge run not found' });
        res.json(run);
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    router.post('/judge-runs/:judgeRunId/rejudge', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const original = await judgeService.getJudgeRun(param(req, 'judgeRunId'));
        if (!original) return res.status(404).json({ error: 'Judge run not found' });
        const result = await judgeService.judge({
          trigger: 'rejudge',
          sourceId: original.sourceId,
          sourceKind: original.sourceKind,
          scope: original.scope,
          repoId: original.repoId,
        });
        res.status(201).json(result);
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    // ─── Findings ────────────────────────────────────────────────────────────────
  
    router.get('/findings', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const { judgeRunId, scope, status, reliabilityLabel, active, learningId, limit, offset } = req.query;
        const findings = await findingService.list({
          judgeRunId: judgeRunId as string | undefined,
          scope: scope as JudgeScope | undefined,
          status: status as string | undefined,
          reliabilityLabel: reliabilityLabel as any,
          active: active !== undefined ? active === 'true' : undefined,
          learningId: learningId as string | undefined,
          limit: limit ? parseInt(limit as string, 10) : undefined,
          offset: offset ? parseInt(offset as string, 10) : undefined,
        });
        res.json(findings);
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    router.get('/findings/:findingId', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const finding = await findingService.getById(param(req, 'findingId'));
        if (!finding) return res.status(404).json({ error: 'Finding not found' });
        res.json(finding);
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    router.patch('/findings/:findingId', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const { status, suggestedRemediation, reliabilityLabel } = req.body ?? {};
        const updated = await findingService.update(param(req, 'findingId'), {
          status,
          suggestedRemediation,
          reliabilityLabel,
        });
        if (!updated) return res.status(404).json({ error: 'Finding not found or not updated' });
        res.json({ updated: true });
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    // ─── Review Queues ───────────────────────────────────────────────────────────
  
    router.get('/review/queues', async (_req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const counts = await reviewService.getQueues();
        res.json(counts);
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    router.get('/review/queues/:queue', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const queue = param(req, 'queue');
        const {
          scope, fixType, risk, severity, classification, confidenceBand,
          sourceType, repoId, status, limit, offset, includeTotal,
        } = req.query;
        const parsedLimit = limit ? parseInt(limit as string, 10) : undefined;
        const parsedOffset = offset ? parseInt(offset as string, 10) : undefined;
        const tasks = await reviewService.list({
          queue,
          scope: scope as JudgeScope | undefined,
          fixType: fixType as any,
          risk: risk as any,
          severity: severity as any,
          classification: classification as string | undefined,
          confidenceBand: confidenceBand as string | undefined,
          sourceType: sourceType as string | undefined,
          repoId: repoId as string | undefined,
          status: status as any,
          limit: parsedLimit,
          offset: parsedOffset,
        });
        if (includeTotal === 'true') {
          const total = await reviewService.count({
            queue,
            scope: scope as JudgeScope | undefined,
            fixType: fixType as any,
            risk: risk as any,
            severity: severity as any,
            classification: classification as string | undefined,
            confidenceBand: confidenceBand as string | undefined,
            sourceType: sourceType as string | undefined,
            repoId: repoId as string | undefined,
            status: status as any,
          });
          return res.json({ items: tasks, total, limit: Math.min(parsedLimit ?? 50, 200), offset: parsedOffset ?? 0 });
        }
        res.json(tasks);
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    router.post('/review/:taskId/decisions', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const { actor, action, notes, remediationHint } = req.body ?? {};
        if (!actor || !action) {
          return res.status(400).json({ error: 'actor and action are required' });
        }
        await reviewService.addDecision(param(req, 'taskId'), { actor, action, notes, remediationHint });
        res.status(201).json({ success: true });
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    router.get('/review/history', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const { taskId, limit, offset } = req.query;
        const filter: Record<string, unknown> = {};
        if (taskId) filter['taskId'] = taskId;
        const decisions = await db
          .collection('context_review_decisions')
          .find(filter)
          .sort({ createdAt: -1 })
          .skip(offset ? parseInt(offset as string, 10) : 0)
          .limit(Math.min(limit ? parseInt(limit as string, 10) : 50, 200))
          .toArray();
        res.json(decisions);
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
}
