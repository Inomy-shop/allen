import { Router, type Request, type Response } from 'express';
import { LearningService } from '../services/learning.service.js';
import { LearningManager } from '@flowforge/engine';
import { embedAndSave } from '../services/embedding.service.js';
import { param } from '../types.js';
import type { Db } from 'mongodb';

export function learningRoutes(db: Db): Router {
  const router = Router();
  const service = new LearningService(db);
  const learningManager = new LearningManager(db);

  // GET /api/learnings/evolution-candidates
  router.get('/evolution-candidates', async (req: Request, res: Response) => {
    try {
      const roleName = req.query.roleName ? String(req.query.roleName) : undefined;
      const candidates = await learningManager.getEvolutionCandidates(roleName);

      const roles = Object.entries(candidates).map(([name, data]) => ({
        roleName: name,
        learningCount: data.count,
        learnings: data.learnings,
      }));

      res.json({ roles });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/learnings/evolve/:roleName/preview
  router.get('/evolve/:roleName/preview', async (req: Request, res: Response) => {
    try {
      const roleName = param(req, 'roleName');
      const rolesCollection = db.collection('roles');
      const role = await rolesCollection.findOne({ name: roleName });
      if (!role) return res.status(404).json({ error: `Role "${roleName}" not found` });

      const candidates = await learningManager.getEvolutionCandidates(roleName);

      // Collect learnings for this role + globals
      const roleLearnings = [
        ...(candidates[roleName]?.learnings ?? []),
        ...(candidates['__global__']?.learnings ?? []),
      ];

      if (roleLearnings.length === 0) {
        return res.json({ roleName, currentPrompt: role.system ?? '', newPrompt: '', learnings: [] });
      }

      const newPrompt = await learningManager.previewEvolution(roleName, role.system ?? '', roleLearnings);

      res.json({
        roleName,
        currentPrompt: role.system ?? '',
        newPrompt,
        learnings: roleLearnings,
      });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/learnings/evolve/:roleName
  router.post('/evolve/:roleName', async (req: Request, res: Response) => {
    try {
      const roleName = param(req, 'roleName');
      const { newPrompt } = req.body;
      if (!newPrompt) return res.status(400).json({ error: 'newPrompt is required' });

      // Get learning IDs to mark as evolved
      const candidates = await learningManager.getEvolutionCandidates(roleName);
      const learningIds = [
        ...(candidates[roleName]?.learnings ?? []),
        ...(candidates['__global__']?.learnings ?? []),
      ].map(l => l._id).filter(Boolean);

      const result = await learningManager.evolveRole(roleName, newPrompt, learningIds, db);

      res.json({
        roleName,
        previousPrompt: result.previousPrompt,
        newPrompt: result.newPrompt,
        evolvedCount: result.evolvedCount,
      });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/learnings/stats
  router.get('/stats', async (_req: Request, res: Response) => {
    try {
      const stats = await service.stats();
      res.json(stats);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/learnings
  router.get('/', async (req: Request, res: Response) => {
    try {
      const params: Record<string, unknown> = {};
      if (req.query.scope) params.scope = String(req.query.scope);
      if (req.query.type) params.type = String(req.query.type);
      if (req.query.status) params.status = String(req.query.status);
      if (req.query.tags) params.tags = String(req.query.tags).split(',').filter(Boolean);
      if (req.query.workflowName) params.workflowName = String(req.query.workflowName);
      if (req.query.confidence_min) params.confidence_min = parseFloat(String(req.query.confidence_min));
      if (req.query.search) params.search = String(req.query.search);
      if (req.query.limit) params.limit = parseInt(String(req.query.limit), 10);
      if (req.query.offset) params.offset = parseInt(String(req.query.offset), 10);

      const learnings = await service.list(params as any);
      res.json(learnings);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/learnings/:id
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const learning = await service.getById(param(req, 'id'));
      if (!learning) return res.status(404).json({ error: 'Not found' });
      res.json(learning);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/learnings
  router.post('/', async (req: Request, res: Response) => {
    try {
      const { content, type, scope, tags } = req.body;
      if (!content || !type || !scope) {
        return res.status(400).json({ error: 'content, type, and scope are required' });
      }
      const learning = await service.create({ content, type, scope, tags });
      // Generate embedding (non-blocking)
      if (learning._id) {
        embedAndSave(db, learning._id.toString(), content).catch(() => {});
      }
      res.status(201).json(learning);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // PUT /api/learnings/:id
  router.put('/:id', async (req: Request, res: Response) => {
    try {
      const learning = await service.update(param(req, 'id'), req.body);
      if (!learning) return res.status(404).json({ error: 'Not found' });
      res.json(learning);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/learnings/:id/approve
  router.post('/:id/approve', async (req: Request, res: Response) => {
    try {
      const learning = await service.approve(param(req, 'id'));
      if (!learning) return res.status(404).json({ error: 'Not found' });
      res.json(learning);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/learnings/:id/reject
  router.post('/:id/reject', async (req: Request, res: Response) => {
    try {
      const learning = await service.reject(param(req, 'id'));
      if (!learning) return res.status(404).json({ error: 'Not found' });
      res.json(learning);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // DELETE /api/learnings/:id
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      await service.archive(param(req, 'id'));
      res.status(204).send();
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}

/**
 * Execution learnings route — mounted on execution routes.
 */
export function executionLearningsRoute(db: Db): Router {
  const router = Router({ mergeParams: true });
  const service = new LearningService(db);

  // GET /api/executions/:id/learnings
  router.get('/:id/learnings', async (req: Request, res: Response) => {
    try {
      const result = await service.forExecution(param(req, 'id'));
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
