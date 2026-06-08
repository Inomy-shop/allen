/**
 * Design Repos Routes — Design Repo Management and Preview Config
 *
 * All endpoints under /api/design/repos/* for the Allen Desktop Design Tab.
 * Handles listing, onboarding, and default management for design repos,
 * as well as CRUD and testing of preview configurations.
 */

import { Router, type Request, type Response } from 'express';
import type { NextFunction } from 'express';
import { ObjectId, type Db } from 'mongodb';
import { createProxyMiddleware, type RequestHandler } from 'http-proxy-middleware';
import { DesignRepoService } from '../services/design-repo.service.js';
import { DesignPreviewService } from '../services/design-preview.service.js';
import { DesignRepoPreviewManager } from '../services/design-repo-preview-manager.js';
import { param } from '../types.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function apiError(res: Response, status: number, message: string, code: string, details?: object): void {
  res.status(status).json({ error: message, code, ...(details ? { details } : {}) });
}

// ── Design Repo Preview Proxy Cache ──────────────────────────────────────────
const designPreviewProxyCache = new Map<string, RequestHandler>();

// ── Preview root resolver ──────────────────────────────────────────────────

/**
 * Resolve the preview working-root for a chatSession.
 * Checks four linkage shapes, in priority order, and returns
 * the worktreePath of the first matching active workspace.
 * Returns { root: fallback, source: 'repo.path' } when nothing matches.
 */
async function resolvePreviewRoot(
  db: Db,
  chatSessionId: string,
  fallback: string,
): Promise<{ root: string; source: string }> {
  const wsFilter = { status: { $nin: ['archived', 'failed'] } };
  const wsProj = { projection: { worktreePath: 1 } };

  // 1. workspaces.chatSessionId (direct scalar link)
  let ws = await db.collection('workspaces').findOne(
    { chatSessionId, ...wsFilter },
    wsProj,
  );
  if (ws?.worktreePath) return { root: ws.worktreePath as string, source: 'workspaces.chatSessionId' };

  // 2. workspaces.chatSessionIds (array link)
  ws = await db.collection('workspaces').findOne(
    { chatSessionIds: chatSessionId, ...wsFilter },
    wsProj,
  );
  if (ws?.worktreePath) return { root: ws.worktreePath as string, source: 'workspaces.chatSessionIds' };

  // 3. chat_sessions.workspaceId → look up workspace by that id
  if (ObjectId.isValid(chatSessionId)) {
    const session = await db.collection('chat_sessions').findOne(
      { _id: new ObjectId(chatSessionId) },
      { projection: { workspaceId: 1 } },
    );
    const wsId = session?.workspaceId as string | undefined;
    if (wsId && ObjectId.isValid(wsId)) {
      ws = await db.collection('workspaces').findOne(
        { _id: new ObjectId(wsId), ...wsFilter },
        wsProj,
      );
      if (ws?.worktreePath) return { root: ws.worktreePath as string, source: 'chat_sessions.workspaceId' };
    }
  }

  // 4. executions.meta.chatSessionId + meta.workspaceId → most-recent execution
  const exec = await db.collection('executions').findOne(
    {
      'meta.chatSessionId': chatSessionId,
      'meta.workspaceId': { $exists: true, $type: 'string' },
    },
    { sort: { createdAt: -1 }, projection: { 'meta.workspaceId': 1 } },
  );
  const execWsId = (exec?.meta as Record<string, unknown> | undefined)?.workspaceId as string | undefined;
  if (execWsId && ObjectId.isValid(execWsId)) {
    ws = await db.collection('workspaces').findOne(
      { _id: new ObjectId(execWsId), ...wsFilter },
      wsProj,
    );
    if (ws?.worktreePath) return { root: ws.worktreePath as string, source: 'executions.meta.workspaceId' };
  }

  return { root: fallback, source: 'repo.path' };
}

// ── Router ─────────────────────────────────────────────────────────────────

export function designReposRoutes(db: Db): Router {
  const router = Router();
  const repoService = new DesignRepoService(db);
  const previewService = new DesignPreviewService();

  // ── GET /api/design/repos ────────────────────────────────────────────────
  // List design repos
  router.get('/repos', async (req: Request, res: Response) => {
    try {
      const { includeAll } = req.query as Record<string, string>;
      const repos = await repoService.listDesignRepos(includeAll === 'true');
      res.json(repos);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message, code: 'INTERNAL_ERROR' });
    }
  });

  // ── GET /api/design/repos/default ───────────────────────────────────────
  // Get the default design repo
  // NOTE: This route must be defined BEFORE /repos/:repoId to avoid
  // 'default' being captured as a repoId param.
  router.get('/repos/default', async (_req: Request, res: Response) => {
    try {
      const repo = await repoService.getDefault();
      if (!repo) {
        return apiError(res, 404, 'No default design repo configured', 'DESIGN_REPO_NOT_FOUND');
      }
      res.json(repo);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message, code: 'INTERNAL_ERROR' });
    }
  });

  // ── PUT /api/design/repos/default ───────────────────────────────────────
  // Set the default design repo
  router.put('/repos/default', async (req: Request, res: Response) => {
    try {
      const { repoId } = req.body ?? {};
      if (!repoId) {
        return apiError(res, 400, 'repoId is required', 'DESIGN_REPO_REQUIRED');
      }
      const repo = await repoService.setDefault(repoId);
      res.json(repo);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message, code: 'INTERNAL_ERROR' });
    }
  });

  // ── POST /api/design/repos/onboard ──────────────────────────────────────
  // Onboard an existing repo as a design repo (AC-004)
  router.post('/repos/onboard', async (req: Request, res: Response) => {
    try {
      const { path, cloneUrl, name, makeDefault, previewConfig } = req.body ?? {};

      if (!name) {
        return apiError(res, 400, 'name is required', 'DESIGN_REPO_REQUIRED');
      }
      if (!path && !cloneUrl) {
        return apiError(res, 400, 'Either path or cloneUrl is required', 'REPO_PATH_INVALID');
      }

      // Validate previewConfig if provided
      if (previewConfig) {
        const validation = previewService.validateConfig(previewConfig);
        if (!validation.ok) {
          return apiError(res, 400, `Invalid preview config: ${validation.code}`, validation.code!, validation.details);
        }
      }

      const repo = await repoService.onboardRepo({ path, cloneUrl, name, makeDefault, previewConfig });
      res.status(201).json(repo);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message, code: 'INTERNAL_ERROR' });
    }
  });

  // ── POST /api/design/repos/bootstrap-ui-designs ─────────────────────────
  // Bootstrap the ui-designs template repo
  router.post('/repos/bootstrap-ui-designs', async (req: Request, res: Response) => {
    try {
      const { name, path } = req.body ?? {};
      const repo = await repoService.bootstrapUiDesigns(name, path);
      res.status(201).json(repo);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message, code: 'INTERNAL_ERROR' });
    }
  });

  // ── GET /api/design/repos/:repoId/preview-config ─────────────────────────
  // Get preview config for a repo
  router.get('/repos/:repoId/preview-config', async (req: Request, res: Response) => {
    try {
      const repoId = param(req, 'repoId');
      const config = await repoService.getPreviewConfig(repoId);
      if (!config) {
        return apiError(res, 404, 'No preview config found for this repo', 'DESIGN_PREVIEW_NOT_CONFIGURED');
      }
      res.json(config);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message, code: 'INTERNAL_ERROR' });
    }
  });

  // ── PUT /api/design/repos/:repoId/preview-config ─────────────────────────
  // Save/update preview config for a repo (AC-005)
  router.put('/repos/:repoId/preview-config', async (req: Request, res: Response) => {
    try {
      const repoId = param(req, 'repoId');
      const config = req.body;

      if (!config || typeof config !== 'object') {
        return apiError(res, 400, 'Preview config body is required', 'DESIGN_PREVIEW_INVALID');
      }

      // Validate first (AC-007)
      const validation = previewService.validateConfig(config);
      if (!validation.ok) {
        return apiError(
          res,
          400,
          `Preview config validation failed: ${validation.code}`,
          validation.code!,
          validation.details,
        );
      }

      const saved = await repoService.savePreviewConfig(repoId, config);
      res.json(saved);
    } catch (err: unknown) {
      const code = (err as any).code;
      if (code && code.startsWith('DESIGN_PREVIEW_')) {
        return res.status(400).json({ error: (err as Error).message, code, details: (err as any).details });
      }
      res.status(500).json({ error: (err as Error).message, code: 'INTERNAL_ERROR' });
    }
  });

  // ── POST /api/design/repos/:repoId/preview-config/test ───────────────────
  // Test preview config for a repo (AC-008)
  router.post('/repos/:repoId/preview-config/test', async (req: Request, res: Response) => {
    try {
      const repoId = param(req, 'repoId');
      const { workspaceId } = req.body ?? {};

      const config = await repoService.getPreviewConfig(repoId);
      if (!config) {
        return apiError(res, 404, 'No preview config found for this repo', 'DESIGN_PREVIEW_NOT_CONFIGURED');
      }

      const result = await repoService.testPreviewConfig(repoId, workspaceId);
      if (result.status === 'failed') {
        return res.status(422).json({
          error: 'Preview config test failed',
          code: 'DESIGN_PREVIEW_TEST_FAILED',
          logs: result.logs,
        });
      }
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message, code: 'INTERNAL_ERROR' });
    }
  });

  // ── GET /api/design/repos/:repoId/preview-status ─────────────────────────
  router.get('/repos/:repoId/preview-status', async (req: Request, res: Response) => {
    try {
      const repoId = param(req, 'repoId');
      const chatSessionId = (req.query.chatSessionId as string) || 'global';
      const entry = DesignRepoPreviewManager.getStatus(repoId, chatSessionId);
      if (!entry) {
        return res.json({ status: 'stopped' });
      }
      // Prefer the actual URL discovered from the Next dev lock (may differ from the
      // initial 127.0.0.1 URL when Next logs a different hostname/URL at startup).
      const previewUrl = entry.previewUrl ?? `http://127.0.0.1:${entry.port}/`;
      return res.json({ status: entry.status, port: entry.port, previewUrl, cwd: entry.cwd });
    } catch (err: unknown) {
      return res.status(500).json({ error: (err as Error).message, code: 'INTERNAL_ERROR' });
    }
  });

  // ── POST /api/design/repos/:repoId/preview-start ──────────────────────────
  router.post('/repos/:repoId/preview-start', async (req: Request, res: Response) => {
    try {
      const repoId = param(req, 'repoId');
      const chatSessionId = (req.body.chatSessionId as string) || null;
      const explicitWorkspaceId = (req.body.workspaceId as string) || null;

      const config = await repoService.getPreviewConfig(repoId);
      if (!config || !config.enabled) {
        return apiError(res, 404, 'Preview is not configured or not enabled for this repo', 'DESIGN_PREVIEW_NOT_CONFIGURED');
      }
      const repo = await repoService.getRepoById(repoId);
      if (!repo?.path) {
        return apiError(res, 400, 'Repo path not found — cannot start preview', 'DESIGN_REPO_PATH_MISSING');
      }

      let previewRoot = repo.path as string;
      let resolvedSource = 'repo.path';

      if (explicitWorkspaceId) {
        // Priority: explicit workspaceId from the UI (e.g., visible in spawnedAgents runContext)
        if (!ObjectId.isValid(explicitWorkspaceId)) {
          return apiError(res, 400, 'workspaceId is not a valid ObjectId', 'WORKSPACE_ID_INVALID');
        }
        const ws = await db.collection('workspaces').findOne(
          { _id: new ObjectId(explicitWorkspaceId), status: { $nin: ['archived', 'failed'] } },
          { projection: { worktreePath: 1 } },
        );
        if (!ws) {
          return apiError(res, 404, 'Workspace not found or not active', 'WORKSPACE_NOT_FOUND');
        }
        if (!ws.worktreePath) {
          return apiError(res, 422, 'Workspace has no worktreePath — cannot start preview', 'WORKSPACE_PATH_MISSING');
        }
        previewRoot = ws.worktreePath as string;
        resolvedSource = 'explicit.workspaceId';
        console.info(`[design-preview-route] explicit workspaceId ${explicitWorkspaceId} → ${previewRoot}`);
      } else if (chatSessionId && chatSessionId !== 'global') {
        // Fallback: infer from chatSession DB linkage
        const resolved = await resolvePreviewRoot(db, chatSessionId, repo.path as string);
        previewRoot = resolved.root;
        resolvedSource = resolved.source;
        if (resolved.source !== 'repo.path') {
          console.info(`[design-preview-route] resolved worktree ${previewRoot} (via ${resolvedSource}) for chatSession ${chatSessionId}`);
        }
      }

      const effectiveChatSessionId = chatSessionId || 'global';
      const { port, previewUrl } = await DesignRepoPreviewManager.start(repoId, config, previewRoot, effectiveChatSessionId);
      return res.json({ status: 'starting', port, previewUrl, cwd: previewRoot });
    } catch (err: unknown) {
      return res.status(500).json({ error: (err as Error).message, code: 'DESIGN_PREVIEW_START_FAILED' });
    }
  });

  // ── POST /api/design/repos/:repoId/preview-stop ───────────────────────────
  router.post('/repos/:repoId/preview-stop', async (req: Request, res: Response) => {
    try {
      const repoId = param(req, 'repoId');
      const chatSessionId = (req.body.chatSessionId as string) || 'global';
      DesignRepoPreviewManager.stop(repoId, chatSessionId);
      return res.json({ status: 'stopped' });
    } catch (err: unknown) {
      return res.status(500).json({ error: (err as Error).message, code: 'INTERNAL_ERROR' });
    }
  });

  return router;
}

// ── Design Repo Preview Proxy ─────────────────────────────────────────────
// Registered in server.ts BEFORE requireAuth so the iframe (which cannot
// send a Bearer header) can load the preview without an auth failure.
export function createDesignRepoPreviewHandler(db: Db): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  const repoService = new DesignRepoService(db);

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const repoId = Array.isArray(req.params.repoId) ? req.params.repoId[0] : (req.params.repoId ?? '');
    if (!repoId) {
      res.status(400).json({ error: 'Missing repoId', code: 'DESIGN_REPO_REQUIRED' });
      return;
    }

    // Check current status — proxy auto-start uses the 'global' session scope
    let entry = DesignRepoPreviewManager.getStatus(repoId, 'global');

    // Auto-start if not running and config + path exist
    if (!entry || entry.status === 'stopped' || entry.status === 'failed') {
      const config = await repoService.getPreviewConfig(repoId).catch(() => null);
      const repo = config?.enabled ? await repoService.getRepoById(repoId).catch(() => null) : null;

      if (config?.enabled && repo?.path) {
        try {
          await DesignRepoPreviewManager.start(repoId, config, repo.path, 'global');
          entry = DesignRepoPreviewManager.getStatus(repoId, 'global');
        } catch (startErr) {
          console.error('[design-preview-proxy] failed to auto-start:', startErr);
          res.status(503).json({ error: 'Preview could not start', code: 'DESIGN_PREVIEW_START_FAILED' });
          return;
        }
      } else {
        res.status(503).json({ error: 'Preview not running and no valid config to start', code: 'DESIGN_PREVIEW_NOT_RUNNING' });
        return;
      }
    }

    if (!entry) {
      res.status(503).json({ error: 'Preview not available', code: 'DESIGN_PREVIEW_NOT_RUNNING' });
      return;
    }

    const cacheKey = `${repoId}:${entry.port}`;
    let proxy = designPreviewProxyCache.get(cacheKey);
    if (!proxy) {
      proxy = createProxyMiddleware({
        target: `http://127.0.0.1:${entry.port}`,
        changeOrigin: true,
        pathRewrite: (path: string) => path || '/',
        on: {
          error: (err, _req, res) => {
            console.error(`[design-preview-proxy] proxy error for ${cacheKey}:`, (err as Error).message);
            if (res && 'writeHead' in res) {
              (res as Response).status(502).json({ error: 'Preview service unavailable' });
            }
          },
        },
      });
      designPreviewProxyCache.set(cacheKey, proxy);
    }

    proxy(req, res, next);
  };
}
