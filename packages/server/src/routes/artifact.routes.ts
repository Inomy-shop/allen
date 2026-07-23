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
import { createHash } from 'node:crypto';
import type { Db } from 'mongodb';
import {
  ArtifactService,
  type ArtifactDoc,
  type ArtifactRootType,
  type ArtifactContentType,
  type SaveArtifactInput,
} from '../services/artifact.service.js';
import { param } from '../types.js';
import { parseTeamClassification } from '../types/team-classification.js';

const ROOT_TYPES = new Set(['chat', 'workflow', 'agent']);
const CONTENT_TYPES = new Set(['markdown', 'json', 'csv', 'text', 'code', 'binary']);

function libraryUserId(req: Request): string {
  const user = (req as unknown as {
    user?: { _id?: unknown; id?: unknown; sub?: unknown; email?: unknown };
  }).user;
  return String(user?._id ?? user?.id ?? user?.sub ?? user?.email ?? 'local-user');
}

function artifactForUser(doc: ArtifactDoc, userId: string) {
  const { savedByUserIds: _savedByUserIds, favoriteByUserIds: _favoriteByUserIds, ...artifact } = doc;
  return {
    ...artifact,
    saved: doc.savedByUserIds?.includes(userId) ?? false,
    favorite: doc.favoriteByUserIds?.includes(userId) ?? false,
  };
}

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
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('ETag', `"${doc.sha256 ?? contentSha256(content)}"`);
      // Add a filename hint for downloads without forcing the download.
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${doc.filename.replace(/"/g, '')}"`,
      );

      const range = parseByteRange(req.headers.range, content.length);
      if (range === 'invalid') {
        res.setHeader('Content-Range', `bytes */${content.length}`);
        return res.status(416).end();
      }
      if (range) {
        const chunk = content.subarray(range.start, range.end + 1);
        res.status(206);
        res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${content.length}`);
        res.setHeader('Content-Length', String(chunk.length));
        return res.end(chunk);
      }

      res.setHeader('Content-Length', String(content.length));
      res.end(content);
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
      const userId = libraryUserId(req);
      res.json(docs.map(doc => artifactForUser(doc, userId)));
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/artifacts/:id — metadata only
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const doc = await service.get(param(req, 'id'));
      if (!doc) return res.status(404).json({ error: 'Artifact not found' });
      res.json(artifactForUser(doc, libraryUserId(req)));
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
      const createdByUserId = user?._id ? String(user._id) : undefined;
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
        createdByAgent: body.createdByAgent,
        createdByUserId,
      });
      res.status(201).json(result);
    } catch (err: unknown) {
      const code = (err as { statusCode?: number }).statusCode ?? 500;
      res.status(code).json({ error: (err as Error).message });
    }
  });

  // PATCH /api/artifacts/:id/library-state — persist Documents-library state.
  router.patch('/:id/library-state', async (req: Request, res: Response) => {
    try {
      const { saved, favorite } = req.body ?? {};
      if (saved === undefined && favorite === undefined) {
        return res.status(400).json({ error: 'saved or favorite is required' });
      }
      if (
        (saved !== undefined && typeof saved !== 'boolean')
        || (favorite !== undefined && typeof favorite !== 'boolean')
      ) {
        return res.status(400).json({ error: 'saved and favorite must be booleans' });
      }

      const userId = libraryUserId(req);
      const doc = await service.updateLibraryState(param(req, 'id'), userId, { saved, favorite });
      if (!doc) return res.status(404).json({ error: 'Artifact not found' });
      res.json(artifactForUser(doc, userId));
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // PATCH /api/artifacts/:id/classification — manual Documents classification.
  router.patch('/:id/classification', async (req: Request, res: Response) => {
    try {
      const classification = parseTeamClassification(req.body?.teamClassification);
      if (classification === undefined) {
        return res.status(400).json({ error: 'teamClassification is required' });
      }
      const userId = libraryUserId(req);
      const doc = await service.updateClassification(
        param(req, 'id'),
        classification,
      );
      if (!doc) return res.status(404).json({ error: 'Artifact not found' });
      res.json(artifactForUser(doc, userId));
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
    mp4: 'video/mp4', webm: 'video/webm',
  };
  return map[ext] ?? null;
}

function contentSha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function parseByteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'invalid' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || size === 0) return 'invalid';

  const [, startText, endText] = match;
  if (!startText && !endText) return 'invalid';

  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return 'invalid';
    return { start: Math.max(size - suffixLength, 0), end: size - 1 };
  }

  const start = Number(startText);
  const requestedEnd = endText ? Number(endText) : size - 1;
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(requestedEnd)
    || start < 0
    || start >= size
    || requestedEnd < start
  ) return 'invalid';

  return { start, end: Math.min(requestedEnd, size - 1) };
}
