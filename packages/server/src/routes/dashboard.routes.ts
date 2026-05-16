import { Router, type Request, type Response } from 'express';
import { DashboardService } from '../services/dashboard.service.js';
import { LinearService } from '../services/linear.service.js';
import type { Db } from 'mongodb';

export function dashboardRoutes(db: Db): Router {
  const router = Router();
  const service = new DashboardService(db);

  // GET /api/dashboard/stats
  router.get('/stats', async (_req: Request, res: Response) => {
    try {
      const stats = await service.getStats();
      res.json(stats);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/dashboard/cost
  router.get('/cost', async (_req: Request, res: Response) => {
    try {
      const cost = await service.getCostBreakdown();
      res.json(cost);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/dashboard/nav-counts
  //
  // Compact counts for the app shell badges. This keeps every page from
  // downloading full ticket/PR/session/workspace/execution lists just to
  // render numbers in the sidebar.
  router.get('/nav-counts', async (_req: Request, res: Response) => {
    try {
      const linearService = new LinearService(db);
      const [
        pendingInterventions,
        chatSessions,
        linearIssues,
        pullRequests,
        workspaces,
        executions,
        activeChatRuns,
        learnings,
      ] = await Promise.all([
        db.collection('workflow_interventions').countDocuments({ status: 'pending' }),
        db.collection('chat_sessions').countDocuments({}),
        linearService.listIssues({ limit: 200 }).then(issues => issues.length).catch(() => 0),
        db.collection('pull_requests').countDocuments({}),
        db.collection('workspaces').countDocuments({ status: { $ne: 'archived' } }),
        db.collection('executions').countDocuments({}),
        db.collection('executions').countDocuments({
          status: 'running',
          'meta.chatSessionId': { $exists: true, $nin: [null, ''] },
        }),
        db.collection('learnings').countDocuments({}),
      ]);

      res.json({
        mywork: pendingInterventions + activeChatRuns,
        inbox: pendingInterventions,
        threads: chatSessions,
        tickets: linearIssues,
        pulls: pullRequests,
        workspaces,
        activity: executions,
        learnings,
      });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
