import { Router, type Request, type Response } from 'express';
import { WorkflowService } from '../services/workflow.service.js';
import { param } from '../types.js';
import type { Db } from 'mongodb';

export function workflowRoutes(db: Db): Router {
  const router = Router();
  const service = new WorkflowService(db);

  // GET /api/workflows
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const workflows = await service.list();
      res.json(workflows);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/workflows
  router.post('/', async (req: Request, res: Response) => {
    try {
      const workflow = await service.create(req.body);
      res.status(201).json(workflow);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.post('/ensure-defaults', async (req: Request, res: Response) => {
    try {
      const names = Array.isArray(req.body?.names)
        ? req.body.names.filter((name: unknown): name is string => typeof name === 'string')
        : [];
      const ensured = await service.ensureDefaultWorkflows(names);
      res.json(ensured);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/workflows/:id
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const workflow = await service.getById(param(req, 'id'));
      if (!workflow) return res.status(404).json({ error: 'Not found' });
      res.json(workflow);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // PUT /api/workflows/:id
  router.put('/:id', async (req: Request, res: Response) => {
    try {
      const workflow = await service.update(param(req, 'id'), req.body);
      res.json(workflow);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // DELETE /api/workflows/:id
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      await service.delete(param(req, 'id'));
      res.status(204).send();
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/workflows/:id/validate
  router.post('/:id/validate', async (req: Request, res: Response) => {
    try {
      const result = await service.validateById(param(req, 'id'));
      res.json(result);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // GET /api/workflows/:id/mermaid
  router.get('/:id/mermaid', async (req: Request, res: Response) => {
    try {
      const mermaid = await service.getMermaid(param(req, 'id'));
      res.type('text/plain').send(mermaid);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/workflows/import
  router.post('/import', async (req: Request, res: Response) => {
    try {
      const yamlContent = req.body.yaml ?? req.body;
      const workflow = await service.importFromYaml(
        typeof yamlContent === 'string' ? yamlContent : JSON.stringify(yamlContent),
      );
      res.status(201).json(workflow);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // GET /api/workflows/:id/export
  router.get('/:id/export', async (req: Request, res: Response) => {
    try {
      const yamlContent = await service.exportAsYaml(param(req, 'id'));
      res.setHeader('Content-Disposition', 'attachment; filename=workflow.yml');
      res.type('text/yaml').send(yamlContent);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
