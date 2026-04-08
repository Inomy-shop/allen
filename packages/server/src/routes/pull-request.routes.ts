import { Router, type Request, type Response } from 'express';
import type { Db } from 'mongodb';
import { PullRequestService } from '../services/pull-request.service.js';
import { WorkspaceManager } from '../services/workspace.service.js';

function p(req: Request, name: string): string {
  const v = req.params[name];
  return Array.isArray(v) ? v[0] : v;
}

export function pullRequestRoutes(db: Db): Router {
  const router = Router();
  const prService = new PullRequestService(db);
  const wsManager = new WorkspaceManager(db);

  // List PRs
  router.get('/', async (req: Request, res: Response) => {
    try {
      const { repoId, status } = req.query as any;
      res.json(await prService.list({ repoId, status }));
    } catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  // Get PR by ID
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const pr = await prService.get(p(req, 'id'));
      if (!pr) return res.status(404).json({ error: 'PR not found' });
      res.json(pr);
    } catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  // Sync PRs from GitHub for a repo
  router.post('/sync', async (req: Request, res: Response) => {
    try {
      const { repoPath, repoId, repoName } = req.body;
      if (!repoPath || !repoId) return res.status(400).json({ error: 'repoPath and repoId required' });
      const result = await prService.syncFromGitHub(repoPath, repoId, repoName ?? '');
      res.json(result);
    } catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  // Get PR diff
  router.get('/:id/diff', async (req: Request, res: Response) => {
    try {
      const pr = await prService.get(p(req, 'id'));
      if (!pr) return res.status(404).json({ error: 'PR not found' });
      const diff = await prService.getDiff(pr.repoPath, pr.branch, pr.baseBranch);
      res.json(diff);
    } catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  // Create workspace from PR
  router.post('/:id/workspace', async (req: Request, res: Response) => {
    try {
      const pr = await prService.get(p(req, 'id'));
      if (!pr) return res.status(404).json({ error: 'PR not found' });

      const ws = await wsManager.create({
        repoId: pr.repoId,
        repoName: pr.repoName,
        repoPath: pr.repoPath,
        branch: pr.branch,
        baseBranch: pr.baseBranch,
        name: `pr-${pr.number}-${pr.branch}`,
        source: 'pr',
        prNumber: pr.number,
        prTitle: pr.title,
        prUrl: pr.url,
      });

      await prService.linkWorkspace(p(req, 'id'), ws._id!.toString());
      res.status(201).json(ws);
    } catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  // Create PR from workspace
  router.post('/from-workspace/:workspaceId', async (req: Request, res: Response) => {
    try {
      const ws = await wsManager.get(p(req, 'workspaceId'));
      if (!ws) return res.status(404).json({ error: 'Workspace not found' });
      const { title, body } = req.body;
      if (!title) return res.status(400).json({ error: 'title is required' });

      // Push first
      await wsManager.push(p(req, 'workspaceId'));

      const pr = await prService.createPR(
        ws.worktreePath, ws.repoId, ws.repoName,
        ws.branch, ws.baseBranch, title, body ?? '',
      );
      await prService.linkWorkspace(pr._id!.toString(), p(req, 'workspaceId'));
      res.status(201).json(pr);
    } catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  return router;
}
