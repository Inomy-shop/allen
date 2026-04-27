import { Router, type Request, type Response } from 'express';
import type { Db } from 'mongodb';
import { WorkspaceManager } from '../services/workspace.service.js';
import { PullRequestService } from '../services/pull-request.service.js';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync, statSync } from 'node:fs';
import { join, dirname, normalize, resolve } from 'node:path';

function p(req: Request, name: string): string {
  const v = req.params[name];
  return Array.isArray(v) ? v[0] : v;
}

export function workspaceRoutes(db: Db): Router {
  const router = Router();
  const manager = new WorkspaceManager(db);
  const prService = new PullRequestService(db);

  // ── Workspace CRUD ──

  router.get('/', async (_req: Request, res: Response) => {
    try { res.json(await manager.list()); }
    catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const ws = await manager.get(p(req, 'id'));
      if (!ws) return res.status(404).json({ error: 'Workspace not found' });
      res.json(ws);
    } catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  router.post('/', async (req: Request, res: Response) => {
    try {
      const { repoId, repoName, repoPath, branch, baseBranch, name } = req.body;
      if (!repoId || !repoPath || !branch || !baseBranch || !name) {
        return res.status(400).json({ error: 'repoId, repoPath, branch, baseBranch, and name are required' });
      }
      const ws = await manager.create({ repoId, repoName: repoName ?? '', repoPath, branch, baseBranch, name });
      res.status(201).json(ws);
    } catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  router.post('/from-pr', async (req: Request, res: Response) => {
    try {
      const { repoId, repoName, repoPath, branch, baseBranch, prNumber, prTitle, prUrl } = req.body;
      if (!repoId || !repoPath || !branch) {
        return res.status(400).json({ error: 'repoId, repoPath, and branch are required' });
      }
      const ws = await manager.create({
        repoId, repoName: repoName ?? '', repoPath,
        branch, baseBranch: baseBranch ?? 'main',
        name: `pr-${prNumber}-${branch}`,
        source: 'pr', prNumber, prTitle, prUrl,
      });
      res.status(201).json(ws);
    } catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      await manager.archive(p(req, 'id'));
      res.json({ archived: true });
    } catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  // ── Git Operations ──

  router.get('/:id/diff', async (req: Request, res: Response) => {
    try { res.json(await manager.getDiff(p(req, 'id'))); }
    catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  router.get('/:id/files', async (req: Request, res: Response) => {
    try { res.json(await manager.getChangedFiles(p(req, 'id'))); }
    catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  router.get('/:id/all-files', async (req: Request, res: Response) => {
    try { res.json(await manager.listFiles(p(req, 'id'))); }
    catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  router.get('/:id/file/*', async (req: Request, res: Response) => {
    try {
      const ws = await manager.get(p(req, 'id'));
      if (!ws) return res.status(404).json({ error: 'Workspace not found' });

      // Decode and normalize path to prevent URL-encoded traversal attacks
      const rawFilePath = (req.params as any)[0] ?? '';
      const decodedPath = decodeURIComponent(rawFilePath);
      const normalizedPath = normalize(decodedPath);

      // Additional security check for traversal patterns
      if (normalizedPath.includes('..') || normalizedPath.startsWith('/')) {
        return res.status(403).json({ error: 'Invalid file path' });
      }

      const fullPath = resolve(join(ws.worktreePath, normalizedPath));
      const normalizedWorktree = resolve(ws.worktreePath);

      // Security: ensure resolved path is within worktree (prevents all traversal attacks)
      if (!fullPath.startsWith(normalizedWorktree + '/') && fullPath !== normalizedWorktree) {
        return res.status(403).json({ error: 'Path traversal blocked' });
      }

      // Check file exists and get stats for size validation
      if (!existsSync(fullPath)) {
        return res.status(404).json({ error: 'File not found' });
      }

      const stats = statSync(fullPath);
      if (stats.isDirectory()) {
        return res.status(400).json({ error: 'Path is a directory' });
      }

      // Check if file is an image based on extension (case-insensitive)
      const ext = normalizedPath.split('.').pop()?.toLowerCase() ?? '';
      const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'svg'];
      const isImage = imageExtensions.includes(ext);

      if (isImage) {
        // File size limit for images: 50MB to prevent memory exhaustion
        const maxImageSize = 50 * 1024 * 1024; // 50MB in bytes
        if (stats.size > maxImageSize) {
          return res.status(413).json({ error: 'Image file too large (max 50MB)' });
        }

        const buffer = readFileSync(fullPath);
        const base64 = buffer.toString('base64');
        res.json({
          path: rawFilePath,
          content: base64,
          isImage: true,
          mimeType: `image/${ext === 'jpg' ? 'jpeg' : ext === 'svg' ? 'svg+xml' : ext}`
        });
      } else {
        // File size limit for text files: 10MB to prevent memory issues
        const maxTextSize = 10 * 1024 * 1024; // 10MB in bytes
        if (stats.size > maxTextSize) {
          return res.status(413).json({ error: 'Text file too large (max 10MB)' });
        }

        const content = readFileSync(fullPath, 'utf-8');
        res.json({ path: rawFilePath, content, isImage: false });
      }
    } catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  // Write / save file
  router.put('/:id/file/*', async (req: Request, res: Response) => {
    try {
      const ws = await manager.get(p(req, 'id'));
      if (!ws) return res.status(404).json({ error: 'Workspace not found' });
      const filePath = (req.params as any)[0] ?? '';
      const fullPath = join(ws.worktreePath, filePath);
      if (!fullPath.startsWith(ws.worktreePath)) return res.status(403).json({ error: 'Path traversal blocked' });
      const { content } = req.body;
      if (content === undefined) return res.status(400).json({ error: 'content is required' });
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content, 'utf-8');
      res.json({ path: filePath, saved: true });
    } catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  // Create new file
  router.post('/:id/create-file', async (req: Request, res: Response) => {
    try {
      const ws = await manager.get(p(req, 'id'));
      if (!ws) return res.status(404).json({ error: 'Workspace not found' });
      const { path: filePath, content } = req.body;
      if (!filePath) return res.status(400).json({ error: 'path is required' });
      const fullPath = join(ws.worktreePath, filePath);
      if (!fullPath.startsWith(ws.worktreePath)) return res.status(403).json({ error: 'Path traversal blocked' });
      if (existsSync(fullPath)) return res.status(409).json({ error: 'File already exists' });
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content ?? '', 'utf-8');
      res.status(201).json({ path: filePath, created: true });
    } catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  // Delete file
  router.delete('/:id/file/*', async (req: Request, res: Response) => {
    try {
      const ws = await manager.get(p(req, 'id'));
      if (!ws) return res.status(404).json({ error: 'Workspace not found' });
      const filePath = (req.params as any)[0] ?? '';
      const fullPath = join(ws.worktreePath, filePath);
      if (!fullPath.startsWith(ws.worktreePath)) return res.status(403).json({ error: 'Path traversal blocked' });
      if (!existsSync(fullPath)) return res.status(404).json({ error: 'File not found' });
      unlinkSync(fullPath);
      res.json({ path: filePath, deleted: true });
    } catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  router.post('/:id/commit', async (req: Request, res: Response) => {
    try {
      const { message } = req.body;
      if (!message) return res.status(400).json({ error: 'message is required' });
      const result = await manager.commit(p(req, 'id'), message);
      res.json(result);
    } catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  router.post('/:id/push', async (req: Request, res: Response) => {
    try { await manager.push(p(req, 'id')); res.json({ pushed: true }); }
    catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  router.post('/:id/pull', async (req: Request, res: Response) => {
    try { await manager.pull(p(req, 'id')); res.json({ pulled: true }); }
    catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  // ── Create PR from Workspace ──

  router.post('/:id/create-pr', async (req: Request, res: Response) => {
    try {
      const ws = await manager.get(p(req, 'id'));
      if (!ws) return res.status(404).json({ error: 'Workspace not found' });
      const { title, body, skipChecks } = req.body;
      if (!title) return res.status(400).json({ error: 'title is required' });

      // Run pre-PR checks if configured
      if (!skipChecks) {
        const config = await manager.getConfig(ws.repoId);
        if (config?.prePrScript?.length) {
          const { execFile: execF } = await import('node:child_process');
          const { promisify: prom } = await import('node:util');
          const run = prom(execF);
          for (const cmd of config.prePrScript) {
            try {
              await run('sh', ['-c', cmd], { cwd: ws.worktreePath, env: { ...process.env } });
            } catch (err: any) {
              return res.status(422).json({ error: `Pre-PR check failed: ${cmd}`, output: err.stderr ?? err.message });
            }
          }
        }
      }

      await manager.push(p(req, 'id'));
      const pr = await prService.createPR(ws.worktreePath, ws.repoId, ws.repoName, ws.branch, ws.baseBranch, title, body ?? '');
      res.status(201).json(pr);
    } catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  // ── Services ──

  router.get('/:id/services', async (req: Request, res: Response) => {
    try {
      const ws = await manager.get(p(req, 'id'));
      if (!ws) return res.status(404).json({ error: 'Workspace not found' });
      res.json(ws.services);
    } catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  router.post('/:id/services/:name/start', async (req: Request, res: Response) => {
    try { await manager.startService(p(req, 'id'), p(req, 'name')); res.json({ started: true }); }
    catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  router.post('/:id/services/:name/stop', async (req: Request, res: Response) => {
    try { await manager.stopService(p(req, 'id'), p(req, 'name')); res.json({ stopped: true }); }
    catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  router.post('/:id/services/:name/restart', async (req: Request, res: Response) => {
    try {
      await manager.stopService(p(req, 'id'), p(req, 'name'));
      await manager.startService(p(req, 'id'), p(req, 'name'));
      res.json({ restarted: true });
    } catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  // ── Chat Link ──

  router.post('/:id/link-chat', async (req: Request, res: Response) => {
    try {
      const { sessionId } = req.body;
      if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
      await manager.linkChat(p(req, 'id'), sessionId);
      res.json({ linked: true });
    } catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  // ── Simple Exec (temporary — will be replaced by WebSocket PTY) ──

  router.post('/:id/exec', async (req: Request, res: Response) => {
    try {
      const ws = await manager.get(p(req, 'id'));
      if (!ws) return res.status(404).json({ error: 'Workspace not found' });
      const { command } = req.body;
      if (!command) return res.status(400).json({ error: 'command is required' });
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const exec = promisify(execFile);
      try {
        const { stdout, stderr } = await exec('sh', ['-c', command], { cwd: ws.worktreePath, env: process.env });
        res.json({ stdout, stderr });
      } catch (err: any) {
        res.json({ stdout: err.stdout ?? '', stderr: err.stderr ?? err.message });
      }
    } catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  // ── Config ──

  router.get('/config/:repoId', async (req: Request, res: Response) => {
    try {
      const config = await manager.getConfig(p(req, 'repoId'));
      res.json(config ?? { setupScript: [], cleanupScript: [], services: [] });
    } catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  router.put('/config/:repoId', async (req: Request, res: Response) => {
    try {
      await manager.saveConfig(p(req, 'repoId'), req.body);
      res.json({ saved: true });
    } catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  // ── Templates ──

  router.get('/templates', async (_req: Request, res: Response) => {
    try { res.json(await manager.listTemplates()); }
    catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  router.post('/templates', async (req: Request, res: Response) => {
    try {
      const { name, ...rest } = req.body;
      if (!name) return res.status(400).json({ error: 'name is required' });
      await manager.saveTemplate(name, rest);
      res.json({ saved: true });
    } catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  router.delete('/templates/:name', async (req: Request, res: Response) => {
    try { await manager.deleteTemplate(p(req, 'name')); res.json({ deleted: true }); }
    catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  // ── Bulk Operations ──

  router.post('/bulk-archive', async (req: Request, res: Response) => {
    try {
      const { ids } = req.body;
      if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array is required' });
      const result = await manager.bulkArchive(ids);
      res.json(result);
    } catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  // ── Activity Timeline ──

  router.get('/:id/activity', async (req: Request, res: Response) => {
    try { res.json(await manager.getActivity(p(req, 'id'))); }
    catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  return router;
}

// Mounted BEFORE requireAuth in app.ts because EventSource (the SSE
// client used by the UI to stream service logs) cannot set custom
// headers, so it can't send the Bearer token. The workspace id is an
// unguessable 24-char ObjectId, used as the capability — same pattern
// as /api/executions SSE and /api/files public downloads.
export function publicWorkspaceRoutes(db: Db): Router {
  const router = Router();
  const manager = new WorkspaceManager(db);

  router.get('/:id/services/:name/logs', (req: Request, res: Response) => {
    try {
      const logBuf = manager.getLogBuffer(p(req, 'id'), p(req, 'name'));

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const snapshot = logBuf.snapshot();
      for (const line of snapshot) {
        res.write(`data: ${JSON.stringify(line)}\n\n`);
      }

      const unsub = logBuf.subscribe(line => {
        res.write(`data: ${JSON.stringify(line)}\n\n`);
      });

      req.on('close', unsub);
    } catch (err: unknown) { res.status(500).json({ error: (err as Error).message }); }
  });

  return router;
}
