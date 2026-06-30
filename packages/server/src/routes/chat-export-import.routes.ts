/**
 * Chat Export / Import Routes
 *
 * API surface for exporting a chat session as a portable bundle and
 * importing a bundle as a read-only replay.
 *
 * @see TDD §2 — API Contracts
 * @see TDD §4 — Error Taxonomy
 */

import { Router, type Request, type Response } from 'express';
import { type Db } from 'mongodb';
import { ObjectId } from 'mongodb';
import { param } from '../types.js';
import { ChatExportService, type ExportOptions } from '../services/chat-export.service.js';
import { ChatImportService } from '../services/chat-import.service.js';
import { logger } from '../logger.js';

export function chatExportImportRoutes(db: Db): Router {
  const router = Router();
  const exportService = new ChatExportService(db);
  const importService = new ChatImportService(db);

  // ── Export Endpoints ─────────────────────────────────────────────────────

  // GET /api/chat/sessions/:id/export-options
  // Returns counts and estimated size so the UI can show a preview dialog.
  router.get('/sessions/:id/export-options', async (req: Request, res: Response) => {
    try {
      const sessionId = param(req, 'id');
      const options = await exportService.getExportOptions(sessionId);
      res.json(options);
    } catch (err: unknown) {
      const error = err as Error & { statusCode?: number; errorCode?: string };
      if (error.statusCode === 404 || error.message.includes('not found')) {
        return res.status(404).json({ error: 'EXPORT_SESSION_NOT_FOUND', message: 'Session not found' });
      }
      logger.error('[chat.export] Failed to get export options', {
        component: 'chat-export',
        error: error.message,
      });
      res.status(500).json({ error: 'EXPORT_ASSEMBLY_FAILED', message: 'Failed to assemble export bundle' });
    }
  });

  // POST /api/chat/sessions/:id/export
  // Assembles and returns the export bundle as a JSON download.
  router.post('/sessions/:id/export', async (req: Request, res: Response) => {
    try {
      const sessionId = param(req, 'id');
      const authUser = (req as unknown as Record<string, unknown>).user as Record<string, unknown> | undefined;
      const userId = (authUser?.sub as string) ?? 'unknown';

      const options: ExportOptions = {
        includeHiddenMessages: req.body?.includeHiddenMessages ?? false,
        includeLogs: req.body?.includeLogs ?? true,
        includeTraces: req.body?.includeTraces ?? true,
        includeArtifacts: req.body?.includeArtifacts ?? true,
        includeArtifactContents: req.body?.includeArtifactContents ?? false,
        includeCodeDiffs: req.body?.includeCodeDiffs ?? true,
        includeThinking: req.body?.includeThinking ?? false,
        redactPaths: req.body?.redactPaths ?? true,
        redactIdentity: req.body?.redactIdentity ?? false,
        redactSecrets: req.body?.redactSecrets ?? true,
        maxBundleSizeBytes: req.body?.maxBundleSizeBytes ?? undefined,
      };

      const result = await exportService.assembleBundle(sessionId, options, userId);

      // Build a safe filename
      const safeTitle = (result.bundle.session.title ?? 'chat').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
      const date = new Date().toISOString().split('T')[0];
      const filename = `allen-chat-${safeTitle}-${date}.json`;

      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', 'application/json');
      // Omit _id
      const { _id: _omitId, ...bundleWithoutId } = result.bundle as unknown as Record<string, unknown>;
      res.json(bundleWithoutId);
    } catch (err: unknown) {
      const error = err as Error & { statusCode?: number; errorCode?: string; estimatedSizeBytes?: number; maxSizeBytes?: number; suggestedExclusions?: string[] };
      if (error.errorCode === 'EXPORT_SIZE_LIMIT_EXCEEDED') {
        return res.status(400).json({
          error: 'EXPORT_SIZE_LIMIT_EXCEEDED',
          message: 'Export would exceed size limit',
          estimatedSizeBytes: error.estimatedSizeBytes,
          maxSizeBytes: error.maxSizeBytes,
          suggestedExclusions: error.suggestedExclusions,
        });
      }
      if (error.statusCode === 404) {
        return res.status(404).json({ error: 'EXPORT_SESSION_NOT_FOUND', message: 'Session not found' });
      }
      logger.error('[chat.export] Assembly failed', {
        component: 'chat-export',
        error: error.message,
      });
      res.status(500).json({ error: 'EXPORT_ASSEMBLY_FAILED', message: 'Failed to assemble export bundle' });
    }
  });

  // GET /api/chat/sessions/:id/export-bundle
  // Re-download the latest completed export bundle without re-assembling it.
  router.get('/sessions/:id/export-bundle', async (req: Request, res: Response) => {
    try {
      const sessionId = param(req, 'id');
      const authUser = (req as unknown as Record<string, unknown>).user as Record<string, unknown> | undefined;
      const userId = (authUser?.sub as string) ?? 'unknown';

      const bundle = await exportService.getExportBundle(sessionId, userId);
      if (!bundle) {
        return res.status(404).json({ error: 'EXPORT_SESSION_NOT_FOUND', message: 'No export bundle found for this session' });
      }

      const safeTitle = (bundle.session.title ?? 'chat').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
      const date = new Date().toISOString().split('T')[0];
      const filename = `allen-chat-${safeTitle}-${date}.json`;

      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', 'application/json');
      const { _id: _omitId2, ...bundleWithoutId } = bundle as unknown as Record<string, unknown>;
      res.json(bundleWithoutId);
    } catch (err: unknown) {
      const error = err as Error;
      logger.error('[chat.export] Failed to get export bundle', {
        component: 'chat-export',
        error: error.message,
      });
      res.status(500).json({ error: 'EXPORT_ASSEMBLY_FAILED', message: 'Failed to retrieve export bundle' });
    }
  });

  // ── Import Endpoints ─────────────────────────────────────────────────────

  // POST /api/chat/import/preview
  // Accepts JSON body { bundle: <object> } OR raw JSON text/plain body.
  router.post('/import/preview', async (req: Request, res: Response) => {
    try {
      const authUser = (req as unknown as Record<string, unknown>).user as Record<string, unknown> | undefined;
      const userId = (authUser?.sub as string) ?? 'unknown';

      // Accept either { bundle: <object> } or a raw JSON object/array body
      let payload: string | object;

      if (req.body && typeof req.body === 'object' && 'bundle' in req.body) {
        payload = (req.body as Record<string, unknown>).bundle as object;
      } else if (req.body && typeof req.body === 'object') {
        payload = req.body;
      } else {
        payload = req.body ?? '';
      }

      const result = await importService.preview(payload, userId);
      res.json(result);
    } catch (err: unknown) {
      const error = err as Error & { statusCode?: number; errorCode?: string; detail?: unknown };
      const status = error.statusCode ?? 400;

      if (error.errorCode === 'IMPORT_INVALID_JSON') {
        return res.status(status).json({ error: 'IMPORT_INVALID_JSON', message: error.message });
      }
      if (error.errorCode === 'IMPORT_UNSUPPORTED_VERSION') {
        return res.status(status).json({
          error: 'IMPORT_UNSUPPORTED_VERSION',
          message: error.message,
          bundleVersion: (error as { bundleVersion?: unknown }).bundleVersion,
          supportedVersions: [1],
        });
      }
      if (error.errorCode === 'IMPORT_MISSING_FIELDS') {
        return res.status(status).json({ error: 'IMPORT_MISSING_FIELDS', message: error.message });
      }
      if (error.errorCode === 'IMPORT_XSS_REJECTED') {
        return res.status(status).json({ error: 'IMPORT_XSS_REJECTED', message: error.message });
      }
      if (error.errorCode === 'IMPORT_SIZE_EXCEEDED') {
        return res.status(status).json({ error: 'IMPORT_SIZE_EXCEEDED', message: error.message });
      }

      logger.error('[chat.import] Preview failed', {
        component: 'chat-import',
        error: error.message,
        errorCode: error.errorCode,
      });
      res.status(status).json({ error: 'IMPORT_INVALID_JSON', message: error.message });
    }
  });

  // POST /api/chat/import/confirm
  // Body: { bundleId: string }
  router.post('/import/confirm', async (req: Request, res: Response) => {
    try {
      const bundleId = req.body?.bundleId as string | undefined;
      if (!bundleId || typeof bundleId !== 'string') {
        return res.status(400).json({ error: 'IMPORT_BUNDLE_NOT_FOUND', message: 'bundleId is required' });
      }

      const authUser = (req as unknown as Record<string, unknown>).user as Record<string, unknown> | undefined;
      const userId = (authUser?.sub as string) ?? 'unknown';

      const result = await importService.confirm(bundleId, userId);
      res.status(201).json(result);
    } catch (err: unknown) {
      const error = err as Error & { statusCode?: number; errorCode?: string; detail?: string; existingSessionId?: string };
      const status = error.statusCode ?? 500;

      if (error.errorCode === 'IMPORT_BUNDLE_NOT_FOUND') {
        return res.status(status).json({ error: 'IMPORT_BUNDLE_NOT_FOUND', message: error.message });
      }
      if (error.errorCode === 'IMPORT_ALREADY_COMPLETED') {
        return res.status(status).json({
          error: 'IMPORT_ALREADY_COMPLETED',
          message: error.message,
          existingSessionId: error.existingSessionId,
        });
      }
      if (error.errorCode === 'IMPORT_BUNDLE_ROLLED_BACK') {
        return res.status(status).json({ error: 'IMPORT_BUNDLE_ROLLED_BACK', message: error.message });
      }
      if (error.errorCode === 'IMPORT_XSS_REJECTED') {
        return res.status(status).json({ error: 'IMPORT_XSS_REJECTED', message: error.message });
      }
      if (error.errorCode === 'IMPORT_PERSIST_FAILED') {
        return res.status(status).json({ error: 'IMPORT_PERSIST_FAILED', message: error.message });
      }

      logger.error('[chat.import] Confirm failed', {
        component: 'chat-import',
        error: error.message,
        errorCode: error.errorCode,
      });
      res.status(status).json({ error: error.errorCode ?? 'IMPORT_PERSIST_FAILED', message: error.message });
    }
  });

  return router;
}
