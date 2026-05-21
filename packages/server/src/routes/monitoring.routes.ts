import { Router, type Response } from 'express';
import type { Db } from 'mongodb';
import type { AuthedRequest } from '../middleware/requireAuth.js';
import { param } from '../types.js';
import { MonitoringService, type MonitoringIncidentStatus, type MonitoringScanArgs } from '../services/self-healing-monitor.service.js';

const MUTABLE_STATUSES: MonitoringIncidentStatus[] = ['ignored', 'suppressed', 'resolved'];

export function monitoringRoutes(db: Db): Router {
  const router = Router();
  const service = new MonitoringService(db);

  router.get('/incidents', async (req: AuthedRequest, res: Response) => {
    try {
      const limitRaw = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : NaN;
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const incidents = await service.listIncidents({ limit, status });
      res.json({ incidents });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/incidents/:id', async (req: AuthedRequest, res: Response) => {
    try {
      const incident = await service.getIncident(param(req, 'id'));
      if (!incident) return res.status(404).json({ error: 'not_found' });
      res.json({ incident });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/scan', async (req: AuthedRequest, res: Response) => {
    try {
      const result = await service.scan((req.body ?? {}) as MonitoringScanArgs);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/incidents/:id/ticket', async (req: AuthedRequest, res: Response) => {
    try {
      const incident = await service.ticketIncident(param(req, 'id'));
      if (!incident) return res.status(404).json({ error: 'not_found' });
      res.json({ incident });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/incidents/:id/dispatch', async (req: AuthedRequest, res: Response) => {
    try {
      const incident = await service.dispatchIncident(param(req, 'id'));
      if (!incident) return res.status(404).json({ error: 'not_found' });
      res.json({ incident });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/incidents/:id/:status', async (req: AuthedRequest, res: Response) => {
    try {
      const status = param(req, 'status') as MonitoringIncidentStatus;
      if (!MUTABLE_STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${MUTABLE_STATUSES.join(', ')}` });
      }
      const incident = await service.markIncident(param(req, 'id'), status);
      if (!incident) return res.status(404).json({ error: 'not_found' });
      res.json({ incident });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
