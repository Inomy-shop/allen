import { Router, type Request, type Response } from 'express';
import type { Db } from 'mongodb';
import { ContextLifecycleStore } from '../services/context/lifecycle/context-lifecycle-store.js';
import { isContextEngineEnabled } from '../services/context/config/context-provider-config.js';
import { param } from '../types.js';

export function contextRoutes(db: Db): Router {
  const router = Router();
  const lifecycle = new ContextLifecycleStore(db);

  router.post('/attempts/evidence/batch', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
      const body = isRecord(req.body) ? req.body : {};
      const contextAttemptIds = Array.isArray(body.context_attempt_ids)
        ? body.context_attempt_ids.map(String).filter(Boolean)
        : Array.isArray(body.contextAttemptIds)
          ? body.contextAttemptIds.map(String).filter(Boolean)
          : [];
      if (!contextAttemptIds.length) {
        return res.status(400).json({ error: 'context_attempt_ids is required' });
      }
      res.json(await lifecycle.getAttemptEvidenceBatch(contextAttemptIds));
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/attempts/:contextAttemptId/evidence', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
      const evidence = await lifecycle.getAttemptEvidence(param(req, 'contextAttemptId'));
      if (!evidence) return res.status(404).json({ error: 'Context attempt evidence not found' });
      res.json(evidence);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/attempts/:contextAttemptId/refs/:refId/content', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
      const content = await lifecycle.getRefContent(param(req, 'contextAttemptId'), param(req, 'refId'));
      if (!content) return res.status(404).json({ error: 'Context ref content not found' });
      res.json(content);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/artifacts/:hash', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
      const artifact = await lifecycle.getArtifactByHash(param(req, 'hash'));
      if (!artifact) return res.status(404).json({ error: 'Context artifact not found' });
      res.json(artifact);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/attempts/:contextAttemptId/query', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
      const content = await lifecycle.getAttemptQueryContent(param(req, 'contextAttemptId'), 'query');
      if (!content) return res.status(404).json({ error: 'Context query not found' });
      res.json(content);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/attempts/:contextAttemptId/semantic-query', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
      const content = await lifecycle.getAttemptQueryContent(param(req, 'contextAttemptId'), 'semantic');
      if (!content) return res.status(404).json({ error: 'Semantic context query not found' });
      res.json(content);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/attempts/:contextAttemptId/query-intent', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
      const content = await lifecycle.getAttemptQueryContent(param(req, 'contextAttemptId'), 'intent');
      if (!content) return res.status(404).json({ error: 'Context query intent not found' });
      res.json(content);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function contextProviderDisabledPayload(error = 'Context provider is disabled. Set ALLEN_CONTEXT_PROVIDER to enable context engine flows.'): Record<string, unknown> {
  return { error, code: 'CONTEXT_PROVIDER_DISABLED' };
}
