import { Router, type Request, type Response } from 'express';
import { param } from '../types.js';
import type { Db } from 'mongodb';

export function agentRoutes(db: Db): Router {
  const router = Router();
  const col = db.collection('agents');

  // GET /api/agents
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const agents = await col.find({}).sort({ name: 1 }).toArray();
      res.json(agents);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/agents
  router.post('/', async (req: Request, res: Response) => {
    try {
      // Strip protected fields — these can ONLY be set by the seed migration or
      // by team-builder/agent-builder via the meta chat tools. Allowing them on
      // a public POST would let any client bypass the meta-team permission gating.
      const body = { ...req.body };
      delete body._id;
      delete body.teamName;
      delete body.teamRole;
      delete body.isBuiltIn;
      delete body.createdBy;
      delete body.createdAt;

      const agent = {
        ...body,
        isBuiltIn: false,
        createdBy: 'user',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const result = await col.insertOne(agent);
      res.status(201).json({ ...agent, _id: result.insertedId });
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // PUT /api/agents/:name
  router.put('/:name', async (req: Request, res: Response) => {
    try {
      const { name } = req.params;
      // Strip protected fields — see POST handler comment. The meta team is
      // the only authority on team membership, lead promotion, and built-in flags.
      const updates = { ...req.body, updatedAt: new Date() };
      delete updates._id;
      delete updates.name;
      delete updates.teamName;
      delete updates.teamRole;
      delete updates.isBuiltIn;
      delete updates.createdBy;
      delete updates.createdAt;
      const result = await col.updateOne({ name }, { $set: updates });
      if (result.matchedCount === 0) return res.status(404).json({ error: 'Agent not found' });
      res.json({ name, ...updates });
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // DELETE /api/agents/:name
  router.delete('/:name', async (req: Request, res: Response) => {
    try {
      const agent = await col.findOne({ name: param(req, 'name') });
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      await col.deleteOne({ name: param(req, 'name') });
      res.status(204).send();
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
