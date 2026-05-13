import { Router, type Request, type Response } from 'express';
import type { Db } from 'mongodb';
import { SkillService } from '../services/skill.service.js';
import { param } from '../types.js';

export function skillRoutes(db: Db): Router {
  const router = Router();
  const service = new SkillService(db);

  router.get('/', async (req: Request, res: Response) => {
    try {
      const includeDisabled = req.query.includeDisabled === 'true';
      res.json(await service.list(includeDisabled));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/search', async (req: Request, res: Response) => {
    try {
      res.json(await service.search(req.body ?? {}));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.post('/validate', async (req: Request, res: Response) => {
    try {
      res.json(await service.validate(req.body ?? {}));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.post('/', async (req: Request, res: Response) => {
    try {
      const skill = await service.create(req.body);
      res.status(201).json(skill);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.get('/:idOrName', async (req: Request, res: Response) => {
    try {
      const key = param(req, 'idOrName');
      const skill = key.match(/^[a-f0-9]{24}$/)
        ? await service.getById(key)
        : await service.getByName(key);
      if (!skill) return res.status(404).json({ error: 'Skill not found' });
      res.json(skill);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/:id', async (req: Request, res: Response) => {
    try {
      res.json(await service.update(param(req, 'id'), req.body));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      await service.delete(param(req, 'id'));
      res.status(204).send();
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
