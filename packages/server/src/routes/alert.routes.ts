import { Router, type Request, type Response } from 'express';
import { param } from '../types.js';
import { AlertService } from '../services/alert.service.js';
import type { Db } from 'mongodb';

export function alertRoutes(db: Db): Router {
  const router = Router();
  const service = new AlertService(db);

  router.get('/', async (req: Request, res: Response) => {
    try {
      const unreadOnly = req.query.unread === 'true';
      const limit = parseInt(req.query.limit as string ?? '50', 10);
      const alerts = await service.list({ unreadOnly, limit });
      res.json(alerts);
    } catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  router.get('/count', async (_req: Request, res: Response) => {
    try {
      const count = await service.unreadCount();
      res.json({ count });
    } catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  router.post('/:id/read', async (req: Request, res: Response) => {
    try { await service.markRead(param(req, 'id')); res.json({ ok: true }); }
    catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  router.post('/read-all', async (_req: Request, res: Response) => {
    try { await service.markAllRead(); res.json({ ok: true }); }
    catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  router.delete('/:id', async (req: Request, res: Response) => {
    try { await service.dismiss(param(req, 'id')); res.status(204).send(); }
    catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  return router;
}
