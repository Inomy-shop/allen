/**
 * Artifact routes — public content endpoint + auth-gated management.
 *
 * Mount pattern (in app.ts):
 *   // BEFORE requireAuth:
 *   app.use('/api/artifacts', publicArtifactRoutes(db));
 *   // AFTER requireAuth:
 *   app.use('/api/artifacts', artifactRoutes(db));
 *
 * The public router only handles GET :id/content so artifact URLs embedded
 * in chat / Slack / markdown docs are clickable without a session. The
 * artifact UUID acts as the access control — same pattern as /api/files/.
 */
import { Router, type Request, type Response } from 'express';
import type { Db } from 'mongodb';
import {
  ArtifactService,
  type ArtifactRootType,
  type ArtifactContentType,
  type SaveArtifactInput,
} from '../services/artifact.service.js';
import { param } from '../types.js';

const ROOT_TYPES = new Set(['chat', 'workflow', 'agent']);
const CONTENT_TYPES = new Set(['markdown', 'json', 'csv', 'text', 'code', 'binary']);

export function publicArtifactRoutes(db: Db): Router {
  const router = Router();
  const service = new ArtifactService(db);

  // GET /api/artifacts/:id/content — serve the raw file.
  // Content-Type comes from the artifact's stored contentType so the
  // browser renders markdown/json/csv as text, not downloads.
  router.get('/:id/content', async (req: Request, res: Response) => {
    try {
      const result = await service.readContent(param(req, 'id'));
      if (!result) return res.status(404).json({ error: 'Artifact not found' });
      const { doc, content } = result;
      const mime = mimeForArtifact(doc.contentType, doc.filename);
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Length', String(doc.sizeBytes));
      // Add a filename hint for downloads without forcing the download.
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${doc.filename.replace(/"/g, '')}"`,
      );
      res.send(content);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}

export function artifactRoutes(db: Db): Router {
  const router = Router();
  const service = new ArtifactService(db);

  // GET /api/artifacts — list with filter
  router.get('/', async (req: Request, res: Response) => {
    try {
      const rootType = req.query.rootType as ArtifactRootType | undefined;
      const rootId = req.query.rootId as string | undefined;
      if (rootType && !ROOT_TYPES.has(rootType)) {
        return res.status(400).json({ error: 'rootType must be chat | workflow | agent' });
      }
      const docs = await service.list({
        rootType,
        rootId,
        limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
        skip: req.query.skip ? parseInt(req.query.skip as string, 10) : undefined,
      });
      res.json(docs);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/artifacts/:id — metadata only
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const doc = await service.get(param(req, 'id'));
      if (!doc) return res.status(404).json({ error: 'Artifact not found' });
      res.json(doc);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/artifacts — save from the UI or from a server-side caller
  router.post('/', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Partial<SaveArtifactInput>;
      if (!body.rootType || !ROOT_TYPES.has(body.rootType)) {
        return res.status(400).json({ error: 'rootType must be chat | workflow | agent' });
      }
      if (!body.rootId || !body.filename || body.content == null) {
        return res.status(400).json({ error: 'rootId, filename, and content are required' });
      }
      if (body.contentType && !CONTENT_TYPES.has(body.contentType)) {
        return res.status(400).json({ error: `contentType must be one of ${[...CONTENT_TYPES].join(', ')}` });
      }
      const user = (req as unknown as { user?: { _id?: unknown } }).user;
      const result = await service.save({
        rootType: body.rootType as ArtifactRootType,
        rootId: body.rootId,
        filename: body.filename,
        content: String(body.content),
        contentType: body.contentType as ArtifactContentType | undefined,
        description: body.description,
        language: body.language,
        spawnContext: body.spawnContext,
        overwrite: body.overwrite,
        createdByUserId: user?._id ? String(user._id) : undefined,
      });
      res.status(201).json(result);
    } catch (err: unknown) {
      const code = (err as { statusCode?: number }).statusCode ?? 500;
      res.status(code).json({ error: (err as Error).message });
    }
  });

  // DELETE /api/artifacts/:id
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const ok = await service.delete(param(req, 'id'));
      if (!ok) return res.status(404).json({ error: 'Artifact not found' });
      res.json({ deleted: true });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}

/**
 * Pick a Content-Type header. Markdown/json/csv/text get `text/*` so
 * browsers show them inline without downloading; binary falls back to
 * octet-stream so the browser prompts to save.
 */
function mimeForArtifact(contentType: ArtifactContentType, filename: string): string {
  // HTML artifacts (e.g. Design Studio prototypes) must render, not show source.
  // The artifact contentType union has no "html", so key off the extension.
  if (/\.html?$/i.test(filename)) return 'text/html; charset=utf-8';
  switch (contentType) {
    case 'markdown': return 'text/markdown; charset=utf-8';
    case 'json':     return 'application/json; charset=utf-8';
    case 'csv':      return 'text/csv; charset=utf-8';
    case 'text':     return 'text/plain; charset=utf-8';
    case 'code':     return 'text/plain; charset=utf-8';
    case 'binary':   return guessBinaryMime(filename) ?? 'application/octet-stream';
  }
}

function guessBinaryMime(filename: string): string | null {
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (!ext) return null;
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    pdf: 'application/pdf', zip: 'application/zip',
  };
  return map[ext] ?? null;
}
