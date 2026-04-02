import { Router, type Request, type Response } from 'express';
import { DashboardService } from '../services/dashboard.service.js';
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

  return router;
}
