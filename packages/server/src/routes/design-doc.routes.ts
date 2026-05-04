/**
 * Design Doc Routes
 *
 * Manual CRUD over the `design_docs` collection. These endpoints back
 * the Design Docs list / detail pages in the UI and are called by the
 * producer agents (via the Allen MCP server) to persist their
 * output.
 *
 * Write endpoints are intended to be called by workflow nodes running
 * on the server, not directly by end users — the design producers
 * emit structured output and a thin wrapper in the workflow YAML
 * POSTs it here. Auth is the same as every other /api/* route.
 */

import { Router, type Request, type Response } from 'express';
import type { Db } from 'mongodb';
import { DesignDocService, type DesignDocSectionKind } from '../services/design-doc.service.js';
import { param } from '../types.js';

export function designDocRoutes(db: Db): Router {
  const router = Router();
  const service = new DesignDocService(db);

  // GET /api/design-docs — list with optional filters
  router.get('/', async (req: Request, res: Response) => {
    try {
      const status = req.query.status as string | undefined;
      const chatSessionId = req.query.chatSessionId as string | undefined;
      const docs = await service.list({
        status: status as any,
        chatSessionId,
      });
      res.json(docs);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/design-docs/:id
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const doc = await service.findById(param(req, 'id'));
      if (!doc) return res.status(404).json({ error: 'Design doc not found' });
      res.json(doc);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/design-docs/by-workflow-run/:workflowRunId
  router.get('/by-workflow-run/:workflowRunId', async (req: Request, res: Response) => {
    try {
      const doc = await service.findByWorkflowRun(param(req, 'workflowRunId'));
      if (!doc) return res.status(404).json({ error: 'No design doc for this run' });
      res.json(doc);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/design-docs — create a new design doc (start of a feature run)
  router.post('/', async (req: Request, res: Response) => {
    try {
      const { userRequest, chatSessionId, workflowRunId, startedByUserId } = req.body ?? {};
      if (!userRequest) return res.status(400).json({ error: 'userRequest is required' });
      const doc = await service.create({ userRequest, chatSessionId, workflowRunId, startedByUserId });
      res.status(201).json(doc);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/design-docs/:id/sections/:section — append a new section version
  router.post('/:id/sections/:section', async (req: Request, res: Response) => {
    try {
      const section = param(req, 'section') as DesignDocSectionKind;
      if (!['requirements', 'architecture', 'technical_design'].includes(section)) {
        return res.status(400).json({ error: `Invalid section "${section}"` });
      }
      const { body, body_json, producer_agent, caused_by_intervention_id } = req.body ?? {};
      if (!body || !producer_agent) {
        return res.status(400).json({ error: 'body and producer_agent are required' });
      }
      const version = await service.upsertSection({
        designDocId: param(req, 'id'),
        section,
        body,
        bodyJson: body_json,
        producerAgent: producer_agent,
        causedByInterventionId: caused_by_intervention_id,
      });
      res.status(201).json(version);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/design-docs/:id/approve
  router.post('/:id/approve', async (req: Request, res: Response) => {
    try {
      const userId = (req.body?.userId as string) ?? 'unknown';
      await service.markApproved(param(req, 'id'), userId);
      res.status(204).send();
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/design-docs/:id/handoff
  router.post('/:id/handoff', async (req: Request, res: Response) => {
    try {
      const { executionId } = req.body ?? {};
      if (!executionId) return res.status(400).json({ error: 'executionId is required' });
      await service.markHandedOff(param(req, 'id'), executionId);
      res.status(204).send();
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/design-docs/:id/abandon
  router.post('/:id/abandon', async (_req: Request, res: Response) => {
    try {
      await service.markAbandoned(param(_req, 'id'));
      res.status(204).send();
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
