import { Router, type Request, type Response } from 'express';
import { RepoService } from '../services/repo.service.js';
import { param } from '../types.js';
import type { Db } from 'mongodb';

export function repoRoutes(db: Db): Router {
  const router = Router();
  const service = new RepoService(db);

  // GET /api/repos
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const repos = await service.list();
      res.json(repos);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/repos
  router.post('/', async (req: Request, res: Response) => {
    try {
      const repo = await service.create(req.body);
      res.status(201).json(repo);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // GET /api/repos/:id
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const repo = await service.getById(param(req, 'id'));
      if (!repo) return res.status(404).json({ error: 'Not found' });
      res.json(repo);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // PUT /api/repos/:id
  router.put('/:id', async (req: Request, res: Response) => {
    try {
      const repo = await service.update(param(req, 'id'), req.body);
      res.json(repo);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // DELETE /api/repos/:id
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      await service.delete(param(req, 'id'));
      res.status(204).send();
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/repos/:id/scan
  router.post('/:id/scan', async (req: Request, res: Response) => {
    try {
      const repo = await service.scan(param(req, 'id'));
      res.json(repo);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  return router;
}
