import { Router, type Request, type Response } from 'express';
import type { Db } from 'mongodb';
import { CronExpressionParser } from 'cron-parser';
import { CronService, computeNextRun, validateCronExpression } from '../services/cron.service.js';
import type { CronJobInput, CronJob } from '../services/cron.types.js';
import { param } from '../types.js';

export function cronRoutes(db: Db, cronService: CronService): Router {
  const router = Router();
  const col = db.collection<CronJob>('cron_jobs');
  const runCol = db.collection('cron_runs');

  // ── Utility routes (must come BEFORE /:id to avoid matching) ──

  // GET /api/crons/preview-schedule?cron=...&n=5&timezone=UTC
  router.get('/preview-schedule', (_req: Request, res: Response) => {
    try {
      const cron = String(_req.query.cron ?? '');
      const n = Math.min(parseInt(String(_req.query.n ?? '5'), 10) || 5, 20);
      const tz = String(_req.query.timezone ?? 'UTC');
      if (!cron) return res.status(400).json({ error: 'cron query param is required' });
      const err = validateCronExpression(cron, tz);
      if (err) return res.status(400).json({ error: err });

      const interval = CronExpressionParser.parse(cron, { tz });
      const dates: string[] = [];
      for (let i = 0; i < n; i++) {
        dates.push(interval.next().toDate().toISOString());
      }
      res.json({ schedule: cron, timezone: tz, next: dates });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/crons/system-actions — list registered system action handlers
  router.get('/system-actions', (_req: Request, res: Response) => {
    const actions = cronService.getSystemActions().map((a) => ({
      name: a.name,
      description: a.description,
    }));
    res.json(actions);
  });

  // ── CRUD ──

  // GET /api/crons
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const jobs = await col.find({}).sort({ createdAt: -1 }).toArray();
      res.json(jobs);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/crons
  router.post('/', async (req: Request, res: Response) => {
    try {
      const body = req.body as CronJobInput;
      if (!body.name || !body.displayName || !body.schedule || !body.target) {
        return res.status(400).json({ error: 'name, displayName, schedule, and target are required' });
      }
      const tz = body.timezone ?? 'UTC';
      const scheduleErr = validateCronExpression(body.schedule, tz);
      if (scheduleErr) return res.status(400).json({ error: `Invalid schedule: ${scheduleErr}` });

      // Uniqueness
      const existing = await col.findOne({ name: body.name });
      if (existing) return res.status(409).json({ error: `Cron job with name "${body.name}" already exists` });

      const doc: CronJob = {
        name: body.name.trim(),
        displayName: body.displayName.trim(),
        description: body.description?.trim(),
        enabled: body.enabled !== false,
        schedule: body.schedule.trim(),
        timezone: tz,
        nextRunAt: computeNextRun(body.schedule, tz),
        target: body.target,
        lastRunAt: null,
        lastRunStatus: null,
        lastRunError: null,
        lastRunExecutionId: null,
        runCount: 0,
        runStatus: 'idle',
        isBuiltIn: false,
        createdBy: 'user',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as CronJob;

      const result = await col.insertOne(doc);
      const saved = { ...doc, _id: result.insertedId } as CronJob;
      // Register with node-cron so it fires on schedule
      cronService.registerTask(saved);
      res.status(201).json(saved);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/crons/:id
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const { ObjectId } = await import('mongodb');
      const job = await col.findOne({ _id: new ObjectId(param(req, 'id')) });
      if (!job) return res.status(404).json({ error: 'Not found' });
      res.json(job);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // PUT /api/crons/:id
  router.put('/:id', async (req: Request, res: Response) => {
    try {
      const { ObjectId } = await import('mongodb');
      const id = new ObjectId(param(req, 'id'));
      const existing = await col.findOne({ _id: id });
      if (!existing) return res.status(404).json({ error: 'Not found' });

      const body = req.body;
      const updates: Record<string, unknown> = { updatedAt: new Date() };

      if (body.displayName !== undefined) updates.displayName = body.displayName.trim();
      if (body.description !== undefined) updates.description = body.description.trim();
      if (body.target !== undefined) updates.target = body.target;

      if (body.schedule !== undefined) {
        const tz = body.timezone ?? existing.timezone ?? 'UTC';
        const scheduleErr = validateCronExpression(body.schedule, tz);
        if (scheduleErr) return res.status(400).json({ error: `Invalid schedule: ${scheduleErr}` });
        updates.schedule = body.schedule.trim();
        updates.timezone = tz;
        updates.nextRunAt = computeNextRun(body.schedule, tz);
      }
      if (body.timezone !== undefined && body.schedule === undefined) {
        const tz = body.timezone;
        updates.timezone = tz;
        updates.nextRunAt = computeNextRun(existing.schedule, tz);
      }
      if (body.enabled !== undefined) {
        updates.enabled = body.enabled;
        if (body.enabled) {
          updates.nextRunAt = computeNextRun(
            (updates.schedule as string) ?? existing.schedule,
            (updates.timezone as string) ?? existing.timezone ?? 'UTC',
          );
        }
      }

      await col.updateOne({ _id: id }, { $set: updates });
      // Re-register the node-cron task with the updated config
      const updated = await col.findOne({ _id: id });
      if (updated) cronService.registerTask(updated);
      res.json({ ...existing, ...updates });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // DELETE /api/crons/:id
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const { ObjectId } = await import('mongodb');
      const id = new ObjectId(param(req, 'id'));
      const existing = await col.findOne({ _id: id });
      if (!existing) return res.status(404).json({ error: 'Not found' });
      if (existing.isBuiltIn) return res.status(409).json({ error: 'Cannot delete a built-in cron job. Disable it instead.' });

      cronService.unregisterTask(String(id));
      await col.deleteOne({ _id: id });
      res.status(204).send();
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Actions ──

  // POST /api/crons/:id/enable
  router.post('/:id/enable', async (req: Request, res: Response) => {
    try {
      const { ObjectId } = await import('mongodb');
      const id = new ObjectId(param(req, 'id'));
      const job = await col.findOne({ _id: id });
      if (!job) return res.status(404).json({ error: 'Not found' });
      const nextRunAt = computeNextRun(job.schedule, job.timezone);
      await col.updateOne({ _id: id }, { $set: { enabled: true, nextRunAt, updatedAt: new Date() } });
      // Register the node-cron task
      const updated = await col.findOne({ _id: id });
      if (updated) cronService.registerTask(updated);
      res.json({ enabled: true, nextRunAt });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/crons/:id/disable
  router.post('/:id/disable', async (req: Request, res: Response) => {
    try {
      const { ObjectId } = await import('mongodb');
      const id = new ObjectId(param(req, 'id'));
      await col.updateOne({ _id: id }, { $set: { enabled: false, updatedAt: new Date() } });
      // Unregister the node-cron task
      cronService.unregisterTask(String(id));
      res.json({ enabled: false });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/crons/:id/run-now — fire immediately, ignoring schedule
  router.post('/:id/run-now', async (req: Request, res: Response) => {
    try {
      const { ObjectId } = await import('mongodb');
      const job = await col.findOne({ _id: new ObjectId(param(req, 'id')) });
      if (!job) return res.status(404).json({ error: 'Not found' });

      // Execute immediately, no claim needed (manual trigger)
      cronService.executeJob(job, 'manual').catch(console.error);
      res.status(202).json({ status: 'triggered', jobName: job.name });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/crons/:id/runs — run history
  router.get('/:id/runs', async (req: Request, res: Response) => {
    try {
      const { ObjectId } = await import('mongodb');
      const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
      const runs = await runCol
        .find({ cronJobId: new ObjectId(param(req, 'id')) })
        .sort({ startedAt: -1 })
        .limit(limit)
        .toArray();
      res.json(runs);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
