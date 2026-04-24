import { Router, type Request, type Response } from 'express';
import type { Db } from 'mongodb';
import { PullRequestService, syncAllActivePrs } from '../services/pull-request.service.js';
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

  // Sync PRs from GitHub for a single repo. Kept for programmatic
  // single-repo use; the UI's "Sync from GitHub" button uses /sync-all
  // below to hit every active repo in one request.
  router.post('/sync', async (req: Request, res: Response) => {
    try {
      const { repoPath, repoId, repoName } = req.body;
      if (!repoPath || !repoId) return res.status(400).json({ error: 'repoPath and repoId required' });
      const result = await prService.syncFromGitHub(repoPath, repoId, repoName ?? '');
      res.json(result);
    } catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  // Sync PRs from GitHub for every active repo in one request. Shares
  // its implementation (`syncAllActivePrs`) with the `pr-sync-all` cron,
  // so the manual button and the 30-min auto-sync are guaranteed to
  // behave identically. Returns structured per-repo results + aggregates.
  router.post('/sync-all', async (_req: Request, res: Response) => {
    try {
      const result = await syncAllActivePrs(db);
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

  // GET /api/pull-requests/by-url?url=<pr_url>
  // Lookup a PR row by its full GitHub URL. Used by the pr-workspace-resolver
  // agent via Allen MCP's find_pr_by_url tool.
  router.get('/by-url', async (req: Request, res: Response) => {
    try {
      const url = String(req.query.url ?? '');
      if (!url) return res.status(400).json({ error: 'url is required' });
      const pr = await prService.findByPrUrl(url);
      if (!pr) return res.status(404).json({ error: 'PR not found' });
      res.json(pr);
    } catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  // POST /api/pull-requests/:id/mark-synced
  // Called by the resolve-pr-reviews workflow after a successful apply
  // round. Records which CodeRabbit comment ids have been addressed so
  // the next sweep skips them and stamps the cooldown timer.
  router.post('/:id/mark-synced', async (req: Request, res: Response) => {
    try {
      const id = p(req, 'id');
      const headSha = (req.body?.headSha as string | undefined) ?? '';
      const processedCommentIds = Array.isArray(req.body?.processedCommentIds)
        ? (req.body.processedCommentIds as unknown[]).map(String)
        : [];
      await prService.markReviewsSynced(id, processedCommentIds, headSha);
      res.json({ status: 'ok', processedCount: processedCommentIds.length });
    } catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  return router;
}
