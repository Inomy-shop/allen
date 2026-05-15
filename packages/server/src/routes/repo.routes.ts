import { Router, type Request, type Response } from 'express';
import { RepoService } from '../services/repo.service.js';
import { param } from '../types.js';
import type { Db } from 'mongodb';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

function safeRepoPath(repoPath: string, rawPath: string): string | null {
  const root = resolve(repoPath);
  const fullPath = resolve(root, rawPath);
  return fullPath === root || fullPath.startsWith(`${root}${sep}`) ? fullPath : null;
}

async function listRepoFiles(repoPath: string): Promise<Array<{ path: string; isDir: boolean }>> {
  const [tracked, untracked] = await Promise.all([
    exec('git', ['ls-files'], { cwd: repoPath }).catch(() => ({ stdout: '' })),
    exec('git', ['ls-files', '--others', '--exclude-standard'], { cwd: repoPath }).catch(() => ({ stdout: '' })),
  ]);
  const ignored = ['.git', 'node_modules/', '.DS_Store', 'dist/', '.turbo/', 'coverage/', '.next/'];
  return Array.from(new Set([
    ...tracked.stdout.trim().split('\n').filter(Boolean),
    ...untracked.stdout.trim().split('\n').filter(Boolean),
  ]))
    .filter(file => !ignored.some(ig => file.startsWith(ig) || file.includes(`/${ig}`)))
    .sort()
    .map(path => ({ path, isDir: false }));
}

function readRepoFile(repoPath: string, rawFilePath: string): Record<string, unknown> {
  const fullPath = safeRepoPath(repoPath, rawFilePath);
  if (!fullPath) {
    const err = new Error('Path traversal blocked') as Error & { status?: number };
    err.status = 403;
    throw err;
  }
  if (!existsSync(fullPath)) {
    const err = new Error('File not found') as Error & { status?: number };
    err.status = 404;
    throw err;
  }
  const stats = statSync(fullPath);
  if (!stats.isFile()) {
    const err = new Error('Path is not a file') as Error & { status?: number };
    err.status = 400;
    throw err;
  }
  const ext = extname(rawFilePath).slice(1).toLowerCase();
  const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
  if (imageExtensions.includes(ext)) {
    const maxImageSize = 50 * 1024 * 1024;
    if (stats.size > maxImageSize) {
      const err = new Error('Image file too large (max 50MB)') as Error & { status?: number };
      err.status = 413;
      throw err;
    }
    return {
      path: rawFilePath,
      content: readFileSync(fullPath).toString('base64'),
      isImage: true,
      mimeType: `image/${ext === 'jpg' ? 'jpeg' : ext === 'svg' ? 'svg+xml' : ext}`,
    };
  }
  const maxTextSize = 10 * 1024 * 1024;
  if (stats.size > maxTextSize) {
    const err = new Error('Text file too large (max 10MB)') as Error & { status?: number };
    err.status = 413;
    throw err;
  }
  return { path: rawFilePath, content: readFileSync(fullPath, 'utf-8'), isImage: false };
}

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

  // POST /api/repos/validate-local — preflight local repo connection
  router.post('/validate-local', async (req: Request, res: Response) => {
    try {
      const { path } = req.body ?? {};
      const result = await service.validateLocalPath(String(path ?? ''));
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/repos/validate-clone — preflight GitHub clone connection
  router.post('/validate-clone', async (req: Request, res: Response) => {
    try {
      const result = await service.validateCloneUrl(req.body ?? {});
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
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

  // GET /api/repos/:id/all-files — browse registered repository files.
  router.get('/:id/all-files', async (req: Request, res: Response) => {
    try {
      const repo = await service.getById(param(req, 'id'));
      if (!repo?.path || typeof repo.path !== 'string') return res.status(404).json({ error: 'Repo not found' });
      res.json(await listRepoFiles(repo.path));
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/repos/:id/file/* — read a file from a registered repository.
  router.get('/:id/file/*', async (req: Request, res: Response) => {
    try {
      const repo = await service.getById(param(req, 'id'));
      if (!repo?.path || typeof repo.path !== 'string') return res.status(404).json({ error: 'Repo not found' });
      const rawFilePath = (req.params as Record<string, string>)[0] ?? '';
      res.json(readRepoFile(repo.path, rawFilePath));
    } catch (err: unknown) {
      const status = typeof (err as { status?: unknown }).status === 'number' ? (err as { status: number }).status : 500;
      res.status(status).json({ error: (err as Error).message });
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
