import { Router, type Request, type Response } from 'express';
import { SecretService } from '../services/secret.service.js';
import { param } from '../types.js';
import type { Db } from 'mongodb';

export function secretRoutes(db: Db): Router {
  const router = Router();
  const service = new SecretService(db);

  // GET /api/secrets — list keys only; supports ?prefix=FLOWFORGE_ filter
  router.get('/', async (req: Request, res: Response) => {
    try {
      const keys = await service.list();
      const prefix = typeof req.query.prefix === 'string' ? req.query.prefix : '';
      const filtered = prefix ? keys.filter(k => k.startsWith(prefix)) : keys;
      res.json(filtered);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/secrets
  router.post('/', async (req: Request, res: Response) => {
    try {
      const { key, value } = req.body;
      if (!key || !value) return res.status(400).json({ error: 'key and value are required' });
      await service.set(key, value);
      res.status(201).json({ key });
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // PUT /api/secrets/:key
  router.put('/:key', async (req: Request, res: Response) => {
    try {
      const { value } = req.body;
      if (!value) return res.status(400).json({ error: 'value is required' });
      await service.set(param(req, 'key'), value);
      res.json({ key: param(req, 'key') });
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // DELETE /api/secrets/:key
  router.delete('/:key', async (req: Request, res: Response) => {
    try {
      await service.delete(param(req, 'key'));
      res.status(204).send();
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
