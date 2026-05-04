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

  // POST /api/repos — create from local path (legacy)
  router.post('/', async (req: Request, res: Response) => {
    try {
      const repo = await service.create(req.body);
      res.status(201).json(repo);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // POST /api/repos/clone — clone from GitHub URL and register
  router.post('/clone', async (req: Request, res: Response) => {
    try {
      const { url, branch, name, description, tags } = req.body;
      if (!url) return res.status(400).json({ error: 'url is required' });
      const repo = await service.createFromUrl({ url, branch, name, description, tags });
      res.status(201).json(repo);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // GET /api/repos/context?path=... — path-based context lookup (used by MCP tool)
  // MUST be registered BEFORE GET /:id, otherwise Express matches /:id first with
  // id="context" and the ObjectId() call throws.
  router.get('/context', async (req: Request, res: Response) => {
    try {
      const path = String(req.query.path ?? '');
      if (!path) return res.status(400).json({ error: 'path query param is required' });
      const ctx = await service.getContextByPath(path);
      if (!ctx) return res.status(404).json({ error: 'No context found for that path' });
      res.json(ctx);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/repos/by-pr-url?url=<pr_url>
  // Identify the registered repo whose remote matches the GitHub PR URL.
  // Used by the pr-workspace-resolver agent via Allen MCP's
  // find_repo_for_pr_url tool.
  router.get('/by-pr-url', async (req: Request, res: Response) => {
    try {
      const url = String(req.query.url ?? '');
      if (!url) return res.status(400).json({ error: 'url query param is required' });
      const { PullRequestService } = await import('../services/pull-request.service.js');
      const prService = new PullRequestService(db);
      const repo = await prService.identifyRepoForPrUrl(url);
      if (!repo) return res.status(404).json({ error: 'No registered repo matches this PR URL' });
      res.json(repo);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
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

  // POST /api/repos/:id/pull — pull latest from origin
  router.post('/:id/pull', async (req: Request, res: Response) => {
    try {
      const rescan = req.query.rescan === 'true' || req.body?.rescan === true;
      const result = await service.pull(param(req, 'id'), { rescan });
      res.json(result);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // POST /api/repos/:id/scan — shallow rescan (existing)
  router.post('/:id/scan', async (req: Request, res: Response) => {
    try {
      const repo = await service.scan(param(req, 'id'));
      res.json(repo);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // POST /api/repos/:id/rescan-context — deep agent-driven context rescan (async, returns 202)
  router.post('/:id/rescan-context', async (req: Request, res: Response) => {
    try {
      const result = await service.rescanContext(param(req, 'id'));
      res.status(result.scheduled ? 202 : 409).json(result);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // GET /api/repos/:id/context — fetch the stored deep context doc
  router.get('/:id/context', async (req: Request, res: Response) => {
    try {
      const ctx = await service.getContext(param(req, 'id'));
      if (!ctx) return res.status(404).json({ error: 'No context found for that repo' });
      res.json(ctx);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
