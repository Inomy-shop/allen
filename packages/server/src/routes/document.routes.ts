/**
 * Document Routes (TDD §2.6 — D0 through D13)
 *
 * All endpoints are mounted after `requireAuth`. Factory pattern.
 *
 * Route ordering requirement (TDD §2.6):
 *   GET /:documentId/versions/compare  MUST be registered before
 *   GET /:documentId/versions/:versionNumber
 *   Otherwise Express would match "compare" as `:versionNumber`.
 */
import { Router, type Request, type Response } from 'express';
import type { Db } from 'mongodb';
import { DocumentService } from '../services/document.service.js';
import { param } from '../types.js';

export function documentRoutes(db: Db): Router {
  const router = Router();
  const service = new DocumentService(db);

  // ── D0: GET /by-artifact/:artifactId  ────────────────────────────────
  // MUST be registered before any /:documentId routes to prevent "by-artifact"
  // from being parsed as a documentId.
  router.get('/by-artifact/:artifactId', async (req: Request, res: Response) => {
    try {
      const artifactId = param(req, 'artifactId');
      const identity = await service.findIdentityByArtifactId(artifactId);
      if (!identity) {
        // Check eligibility via ArtifactService
        const { ArtifactService } = await import('../services/artifact.service.js');
        const artifactService = new ArtifactService(db);
        const artifact = await artifactService.get(artifactId);
        const eligible = artifact
          ? ['markdown', 'text', 'code', 'json', 'csv'].includes(artifact.contentType)
          : false;
        return res.status(404).json({
          error: 'No document identity found for this artifact',
          eligibleForCommenting: eligible,
          contentType: artifact?.contentType ?? null,
        });
      }

      const latestVersion = identity.versions[identity.versions.length - 1];
      const commentCounts = await getCommentCountsForDoc(service, identity.documentId);

      res.json({
        documentId: identity.documentId,
        sourceArtifactId: identity.sourceArtifactId,
        latestVersionNumber: identity.latestVersionNumber,
        contentType: identity.contentType,
        latestContent: latestVersion.content,
        unresolvedCommentCount: commentCounts.unresolved,
        resolvedCommentCount: commentCounts.resolved,
        staleCommentCount: commentCounts.stale,
      });
    } catch (err: unknown) {
      if ((err as { statusCode?: number }).statusCode) {
        const e = err as { statusCode: number; message: string; code?: string };
        return res.status(e.statusCode).json({ error: e.message, code: e.code });
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── D1: POST /  ───────────────────────────────────────────────────────
  router.post('/', async (req: Request, res: Response) => {
    try {
      const { artifactId } = req.body ?? {};
      if (!artifactId) {
        return res.status(400).json({ error: '"artifactId" is required', code: 'ARTIFACT_ID_REQUIRED' });
      }

      const user = (req as unknown as { user?: { _id?: unknown } }).user;
      const agentName = (req.headers['x-agent-name'] as string) || req.body?._agentName;

      const identity = await service.createFromArtifact(artifactId, {
        createdByUserId: user?._id ? String(user._id) : undefined,
        createdByAgentName: agentName || undefined,
      });
      res.status(201).json(identity);
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message: string; code?: string };
      const code = e.statusCode ?? 500;
      res.status(code).json({ error: e.message, code: e.code });
    }
  });

  // ── D2: GET /:documentId  ─────────────────────────────────────────────
  router.get('/:documentId', async (req: Request, res: Response) => {
    try {
      const summary = await service.getDocumentSummary(param(req, 'documentId'));
      res.json(summary);
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message: string; code?: string };
      const code = e.statusCode ?? 500;
      res.status(code).json({ error: e.message, code: e.code });
    }
  });

  // ── D3: GET /:documentId/versions  ────────────────────────────────────
  router.get('/:documentId/versions', async (req: Request, res: Response) => {
    try {
      const result = await service.listVersions(param(req, 'documentId'));
      res.json(result);
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message: string; code?: string };
      const code = e.statusCode ?? 500;
      res.status(code).json({ error: e.message, code: e.code });
    }
  });

  // ── D7: GET /:documentId/versions/compare (BEFORE D4!)  ──────────────
  router.get('/:documentId/versions/compare', async (req: Request, res: Response) => {
    try {
      const documentId = param(req, 'documentId');
      const v1 = parseInt(req.query.v1 as string, 10);
      const v2 = parseInt(req.query.v2 as string, 10);

      if (!Number.isInteger(v1) || !Number.isInteger(v2)) {
        return res.status(400).json({
          error: 'Query parameters "v1" and "v2" must be valid version numbers',
          code: 'INVALID_VERSION_PARAM',
        });
      }

      const result = await service.compareVersions(documentId, v1, v2);
      res.json(result);
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message: string; code?: string };
      const code = e.statusCode ?? 500;
      res.status(code).json({ error: e.message, code: e.code });
    }
  });

  // ── D4: GET /:documentId/versions/:versionNumber  ────────────────────
  router.get('/:documentId/versions/:versionNumber', async (req: Request, res: Response) => {
    try {
      const versionNumber = parseInt(param(req, 'versionNumber'), 10);
      if (!Number.isInteger(versionNumber) || versionNumber < 1) {
        return res.status(400).json({ error: 'versionNumber must be a positive integer', code: 'VERSION_NOT_FOUND' });
      }
      const result = await service.getVersion(param(req, 'documentId'), versionNumber);
      res.json(result);
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message: string; code?: string };
      const code = e.statusCode ?? 500;
      res.status(code).json({ error: e.message, code: e.code });
    }
  });

  // ── D5: POST /:documentId/versions  ───────────────────────────────────
  router.post('/:documentId/versions', async (req: Request, res: Response) => {
    try {
      const { content, addressedCommentIds, createdReason } = req.body ?? {};
      const user = (req as unknown as { user?: { _id?: unknown } }).user;
      const agentName = (req.headers['x-agent-name'] as string) || req.body?._agentName;

      const result = await service.addVersion(param(req, 'documentId'), content, {
        createdByUserId: user?._id ? String(user._id) : undefined,
        createdByAgentName: agentName || undefined,
        addressedCommentIds: addressedCommentIds ?? [],
        createdReason: createdReason || undefined,
      });
      res.status(201).json(result);
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message: string; code?: string };
      const code = e.statusCode ?? 500;
      res.status(code).json({ error: e.message, code: e.code });
    }
  });

  // ── D6: POST /:documentId/versions/:versionNumber/restore  ───────────
  router.post('/:documentId/versions/:versionNumber/restore', async (req: Request, res: Response) => {
    try {
      const versionNumber = parseInt(param(req, 'versionNumber'), 10);
      if (!Number.isInteger(versionNumber) || versionNumber < 1) {
        return res.status(400).json({ error: 'versionNumber must be a positive integer', code: 'VERSION_NOT_FOUND' });
      }
      const user = (req as unknown as { user?: { _id?: unknown } }).user;
      const agentName = (req.headers['x-agent-name'] as string) || req.body?._agentName;

      const result = await service.restoreVersion(param(req, 'documentId'), versionNumber, {
        createdByUserId: user?._id ? String(user._id) : undefined,
        createdByAgentName: agentName || undefined,
      });
      res.status(201).json(result);
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message: string; code?: string };
      const code = e.statusCode ?? 500;
      res.status(code).json({ error: e.message, code: e.code });
    }
  });

  // ── D8: GET /:documentId/comments  ────────────────────────────────────
  router.get('/:documentId/comments', async (req: Request, res: Response) => {
    try {
      const status = (req.query.status as string) || 'open';
      const validStatuses = ['open', 'resolved', 'stale', 'all'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
      }
      const comments = await service.listComments(
        param(req, 'documentId'),
        status as 'open' | 'resolved' | 'stale' | 'all',
      );
      res.json(comments);
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message: string; code?: string };
      const code = e.statusCode ?? 500;
      res.status(code).json({ error: e.message, code: e.code });
    }
  });

  // ── D9: POST /:documentId/comments  ───────────────────────────────────
  router.post('/:documentId/comments', async (req: Request, res: Response) => {
    try {
      const { body, anchor } = req.body ?? {};
      const user = (req as unknown as { user?: { _id?: unknown } }).user;
      const agentName = (req.headers['x-agent-name'] as string) || req.body?._agentName;

      const comment = await service.addComment(param(req, 'documentId'), body, anchor, {
        userId: user?._id ? String(user._id) : undefined,
        agentName: agentName || undefined,
      });
      res.status(201).json(comment);
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message: string; code?: string };
      const code = e.statusCode ?? 500;
      res.status(code).json({ error: e.message, code: e.code });
    }
  });

  // ── D10: POST /:documentId/comments/:commentId/reply  ─────────────────
  router.post('/:documentId/comments/:commentId/reply', async (req: Request, res: Response) => {
    try {
      const { body } = req.body ?? {};
      const user = (req as unknown as { user?: { _id?: unknown } }).user;
      const agentName = (req.headers['x-agent-name'] as string) || req.body?._agentName;

      const reply = await service.addReply(
        param(req, 'documentId'),
        param(req, 'commentId'),
        body,
        {
          userId: user?._id ? String(user._id) : undefined,
          agentName: agentName || undefined,
        },
      );
      res.status(201).json(reply);
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message: string; code?: string };
      const code = e.statusCode ?? 500;
      res.status(code).json({ error: e.message, code: e.code });
    }
  });

  // ── D11: POST /:documentId/comments/:commentId/resolve  ──────────────
  router.post('/:documentId/comments/:commentId/resolve', async (req: Request, res: Response) => {
    try {
      const { resolutionNote } = req.body ?? {};
      const user = (req as unknown as { user?: { _id?: unknown } }).user;
      const agentName = (req.headers['x-agent-name'] as string) || req.body?._agentName;

      const result = await service.resolveComment(
        param(req, 'documentId'),
        param(req, 'commentId'),
        resolutionNote,
        {
          userId: user?._id ? String(user._id) : undefined,
          agentName: agentName || undefined,
        },
      );
      res.json(result);
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message: string; code?: string };
      const code = e.statusCode ?? 500;
      res.status(code).json({ error: e.message, code: e.code });
    }
  });

  // ── D12: POST /:documentId/comments/:commentId/reopen  ───────────────
  router.post('/:documentId/comments/:commentId/reopen', async (req: Request, res: Response) => {
    try {
      const user = (req as unknown as { user?: { _id?: unknown } }).user;
      const result = await service.reopenComment(
        param(req, 'documentId'),
        param(req, 'commentId'),
        user?._id ? String(user._id) : undefined,
      );
      res.json(result);
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message: string; code?: string };
      const code = e.statusCode ?? 500;
      res.status(code).json({ error: e.message, code: e.code });
    }
  });

  // ── D13: GET /:documentId/timeline  ───────────────────────────────────
  router.get('/:documentId/timeline', async (req: Request, res: Response) => {
    try {
      const events = await service.getTimeline(param(req, 'documentId'));
      res.json(events);
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message: string; code?: string };
      const code = e.statusCode ?? 500;
      res.status(code).json({ error: e.message, code: e.code });
    }
  });

  return router;
}

/**
 * Helper to fetch comment counts for a document via the service's private
 * pattern — using direct DB queries to avoid exposing internal method.
 */
async function getCommentCountsForDoc(service: DocumentService, documentId: string) {
  // Access the collection through the service's internal pattern via direct DB access
  const db = (service as unknown as { db: Db }).db;
  const commentsCol = db.collection('document_comments');
  const [unresolved, resolved, stale] = await Promise.all([
    commentsCol.countDocuments({ documentId, status: 'open' }),
    commentsCol.countDocuments({ documentId, status: 'resolved' }),
    commentsCol.countDocuments({ documentId, status: 'stale' }),
  ]);
  return { unresolved, resolved, stale };
}
