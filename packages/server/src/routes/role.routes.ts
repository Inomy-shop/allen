import { Router, type Request, type Response } from 'express';
import { param } from '../types.js';
import type { Db } from 'mongodb';

export function roleRoutes(db: Db): Router {
  const router = Router();
  const col = db.collection('roles');

  // GET /api/roles
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const roles = await col.find({}).sort({ name: 1 }).toArray();
      res.json(roles);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/roles
  router.post('/', async (req: Request, res: Response) => {
    try {
      const role = {
        ...req.body,
        isBuiltIn: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const result = await col.insertOne(role);
      res.status(201).json({ ...role, _id: result.insertedId });
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // PUT /api/roles/:name
  router.put('/:name', async (req: Request, res: Response) => {
    try {
      const { name } = req.params;
      const updates = { ...req.body, updatedAt: new Date() };
      delete updates._id;
      delete updates.name;
      const result = await col.updateOne({ name }, { $set: updates });
      if (result.matchedCount === 0) return res.status(404).json({ error: 'Role not found' });
      res.json({ name, ...updates });
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // DELETE /api/roles/:name
  router.delete('/:name', async (req: Request, res: Response) => {
    try {
      const role = await col.findOne({ name: param(req, 'name') });
      if (!role) return res.status(404).json({ error: 'Role not found' });
      if (role.isBuiltIn) return res.status(400).json({ error: 'Cannot delete built-in role' });
      await col.deleteOne({ name: param(req, 'name') });
      res.status(204).send();
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
