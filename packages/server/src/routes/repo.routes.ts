import { Router, type Request, type Response } from 'express';
import { dirname } from 'node:path';
import { RepoService } from '../services/repo.service.js';
import { RepoKnowledgeGraphService, isRepoKnowledgeGraphValidationError } from '../services/repo-knowledge-graph.service.js';
import { CogneeMemoryService } from '../services/cognee-memory.service.js';
import { isCogneeContextEnabled, isContextEngineEnabled, isGraphContextEnabled } from '../services/context-provider-config.js';
import { param } from '../types.js';
import { ObjectId, type Db } from 'mongodb';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

function contextProviderDisabledPayload(error = 'Context provider is disabled. Set ALLEN_CONTEXT_PROVIDER to enable context engine flows.'): Record<string, unknown> {
  return { error, code: 'CONTEXT_PROVIDER_DISABLED' };
}

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
  const knowledgeGraph = new RepoKnowledgeGraphService(db);
  const cogneeMemory = new CogneeMemoryService(db);

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
      if (!isGraphContextEnabled()) return res.status(409).json(contextProviderDisabledPayload('Allen context provider is disabled.'));
      const path = String(req.query.path ?? '');
      if (!path) return res.status(400).json({ error: 'path query param is required' });
      const ctx = await service.getContextByPath(path);
      if (!ctx) return res.status(404).json({ error: 'No context found for that path' });
      res.json(ctx);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/repos/knowledge-graph?path=... — path-based graph lookup (used by MCP tool)
  router.get('/knowledge-graph', async (req: Request, res: Response) => {
    try {
      if (!isGraphContextEnabled()) return res.status(409).json(contextProviderDisabledPayload('Allen context provider is disabled.'));
      const path = String(req.query.path ?? '');
      if (!path) return res.status(400).json({ error: 'path query param is required' });
      let current = path;
      let resolvedRepo: Record<string, unknown> | null = null;
      for (let i = 0; i < 10; i++) {
        const repo = await db.collection('repos').findOne({ path: current });
        if (repo) { resolvedRepo = repo; break; }
        const workspace = await db.collection('workspaces').findOne({ worktreePath: current }).catch(() => null);
        if (workspace?.repoId) {
          resolvedRepo = await db.collection('repos').findOne({ _id: new ObjectId(workspace.repoId as string) });
          if (resolvedRepo) break;
        }
        const parent = dirname(current);
        if (!parent || parent === current || parent === '/') break;
        current = parent;
      }
      if (!resolvedRepo) return res.status(404).json({ error: 'No registered repo found for that path' });
      const graph = await knowledgeGraph.getLatestGraph(String(resolvedRepo._id));
      if (!graph) return res.status(404).json({ error: 'No knowledge graph found for that repo' });
      res.json(graph);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/repos/knowledge-graph?path=... — path-based save for MCP agents.
  router.post('/knowledge-graph', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
      const path = String(req.query.path ?? req.body?.repo_path ?? '');
      if (!path) return res.status(400).json({ error: 'path query param or repo_path body field is required' });
      const result = await knowledgeGraph.saveGeneratedGraph({
        repoPath: path,
        graph: req.body?.graph,
        graphJson: req.body?.graph_json ?? req.body?.graphJson,
        graphMode: req.body?.graph_mode ?? req.body?.graphMode,
        sourceExecutionId: req.body?.source_execution_id ?? req.body?.sourceExecutionId,
        source: 'agent_tool',
      });
      res.status(201).json(result);
    } catch (err: unknown) {
      if (isRepoKnowledgeGraphValidationError(err)) {
        return res.status(400).json((err as { payload: unknown }).payload);
      }
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // GET /api/repos/skill-body?path=...&refId=... — load full repo skill file by graph ref.
  router.get('/skill-body', async (req: Request, res: Response) => {
    try {
      if (!isGraphContextEnabled()) return res.status(409).json(contextProviderDisabledPayload('Allen context provider is disabled.'));
      const path = String(req.query.path ?? '');
      const refId = req.query.refId ? String(req.query.refId) : undefined;
      const skillPath = req.query.skillPath ? String(req.query.skillPath) : undefined;
      if (!path) return res.status(400).json({ error: 'path query param is required' });
      if (!refId && !skillPath) return res.status(400).json({ error: 'refId or skillPath is required' });
      const result = await knowledgeGraph.getSkillBody({ repoPath: path, refId, skillPath });
      res.json(result);
    } catch (err: unknown) {
      const msg = (err as Error).message;
      const status = msg.includes('not found') || msg.includes('No knowledge graph') ? 404 : 400;
      res.status(status).json({ error: msg });
    }
  });

  // GET /api/repos/context-body?path=...&refId=... — load full repo context file or selected Cognee ref.
  router.get('/context-body', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload('Allen context provider is disabled.'));
      const path = String(req.query.path ?? '');
      const refId = req.query.refId ? String(req.query.refId) : undefined;
      const contextPath = req.query.contextPath ? String(req.query.contextPath) : undefined;
      if (!path) return res.status(400).json({ error: 'path query param is required' });
      if (!refId && !contextPath) return res.status(400).json({ error: 'refId or contextPath is required' });
      const result = await knowledgeGraph.getContextBody({ repoPath: path, refId, contextPath });
      res.json(result);
    } catch (err: unknown) {
      const msg = (err as Error).message;
      const status = msg.includes('not found') || msg.includes('No knowledge graph') ? 404 : 400;
      res.status(status).json({ error: msg });
    }
  });

  // GET /api/repos/search-knowledge?path=...&query=... — find knowledge refs for follow-up context loading.
  router.get('/search-knowledge', async (req: Request, res: Response) => {
    try {
      if (!isGraphContextEnabled()) return res.status(409).json(contextProviderDisabledPayload('Allen context provider is disabled.'));
      const path = String(req.query.path ?? '');
      const query = String(req.query.query ?? '');
      const nodeRole = req.query.nodeRole ? String(req.query.nodeRole) : undefined;
      const currentFilesRaw = req.query.currentFiles;
      const currentFiles = Array.isArray(currentFilesRaw)
        ? currentFilesRaw.map(String)
        : typeof currentFilesRaw === 'string' && currentFilesRaw.length > 0
          ? currentFilesRaw.split(',').map((v) => v.trim()).filter(Boolean)
          : undefined;
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      if (!path) return res.status(400).json({ error: 'path query param is required' });
      if (!query.trim()) return res.status(400).json({ error: 'query query param is required' });
      const result = await knowledgeGraph.searchRepoKnowledge({ repoPath: path, query, nodeRole, currentFiles, limit });
      res.json(result);
    } catch (err: unknown) {
      const msg = (err as Error).message;
      const status = msg.includes('not found') || msg.includes('No knowledge graph') ? 404 : 400;
      res.status(status).json({ error: msg });
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
      if (!isGraphContextEnabled()) return res.status(409).json(contextProviderDisabledPayload('Allen context provider is disabled.'));
      const result = await service.rescanContext(param(req, 'id'));
      res.status(result.scheduled ? 202 : 409).json(result);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // GET /api/repos/:id/cognee — local Cognee dataset ingestion status.
  router.get('/:id/cognee', async (req: Request, res: Response) => {
    try {
      if (!isCogneeContextEnabled()) return res.status(409).json(contextProviderDisabledPayload('Cognee context provider is disabled.'));
      const status = await cogneeMemory.getStatus(param(req, 'id'));
      if (!status) return res.status(404).json({ error: 'No Cognee dataset found for repo' });
      res.json(status);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // POST /api/repos/:id/cognee/refresh — manually ingest/cognify repo memory.
  router.post('/:id/cognee/refresh', async (req: Request, res: Response) => {
    try {
      if (!isCogneeContextEnabled()) return res.status(409).json(contextProviderDisabledPayload('Cognee context provider is disabled.'));
      const pullLatest = req.query.pullLatest === 'false' || req.body?.pullLatest === false ? false : true;
      const cleanRebuild = req.query.cleanRebuild === 'true' || req.body?.cleanRebuild === true;
      const status = await cogneeMemory.scheduleRefreshRepo(param(req, 'id'), { pullLatest, cleanRebuild });
      res.status(202).json(status);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // POST /api/repos/:id/cognee/stop — stop an active local Cognee context build.
  router.post('/:id/cognee/stop', async (req: Request, res: Response) => {
    try {
      if (!isCogneeContextEnabled()) return res.status(409).json(contextProviderDisabledPayload('Cognee context provider is disabled.'));
      const status = await cogneeMemory.stopRefreshRepo(param(req, 'id'));
      res.status(202).json(status);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // GET /api/repos/:id/context — fetch the stored deep context doc
  router.get('/:id/context', async (req: Request, res: Response) => {
    try {
      if (!isGraphContextEnabled()) return res.status(409).json(contextProviderDisabledPayload('Allen context provider is disabled.'));
      const ctx = await service.getContext(param(req, 'id'));
      if (!ctx) return res.status(404).json({ error: 'No context found for that repo' });
      res.json(ctx);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
