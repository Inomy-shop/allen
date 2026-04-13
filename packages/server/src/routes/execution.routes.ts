import { Router, type Request, type Response } from 'express';
import { ExecutionService } from '../services/execution.service.js';
import { param } from '../types.js';
import type { Db } from 'mongodb';

export function executionRoutes(db: Db): Router {
  const router = Router();
  const service = new ExecutionService(db);

  // POST /api/executions
  router.post('/', async (req: Request, res: Response) => {
    try {
      const { workflowId, input } = req.body;
      if (!workflowId) return res.status(400).json({ error: 'workflowId is required' });
      const execution = await service.start(workflowId, input ?? {});
      res.status(201).json(execution);
    } catch (err: unknown) {
      const msg = (err as Error).message;
      const status = msg.includes('Concurrency limit') ? 429 : 500;
      res.status(status).json({ error: msg });
    }
  });

  // GET /api/executions
  router.get('/', async (req: Request, res: Response) => {
    try {
      const filter: Record<string, unknown> = {};
      if (req.query.status) filter.status = String(req.query.status);
      if (req.query.workflowId) filter.workflowId = String(req.query.workflowId);
      if (req.query.workflowName) filter.workflowName = String(req.query.workflowName);
      const executions = await service.list(filter);
      res.json(executions);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/executions/:id
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const execution = await service.getById(param(req, 'id'));
      if (!execution) return res.status(404).json({ error: 'Not found' });
      res.json(execution);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/executions/:id/failure-report
  // Returns the detailed failure report saved when an execution transitions
  // to `failed` (gate-specific diagnostic fields + final state snapshot).
  router.get('/:id/failure-report', async (req: Request, res: Response) => {
    try {
      const report = await db
        .collection('execution_failure_reports')
        .findOne({ executionId: param(req, 'id') });
      if (!report) return res.status(404).json({ error: 'No failure report for this execution' });
      res.json(report);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/executions/:id/cancel
  router.post('/:id/cancel', async (req: Request, res: Response) => {
    try {
      await service.cancel(param(req, 'id'));
      res.json({ status: 'cancelled' });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/executions/:id/pause
  router.post('/:id/pause', async (req: Request, res: Response) => {
    try {
      await service.pause(param(req, 'id'));
      res.json({ status: 'paused' });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/executions/:id/resume
  router.post('/:id/resume', async (req: Request, res: Response) => {
    try {
      await service.resume(param(req, 'id'));
      res.json({ status: 'resumed' });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/executions/:id/input
  router.post('/:id/input', async (req: Request, res: Response) => {
    try {
      const { node, data } = req.body;
      if (!node) return res.status(400).json({ error: 'node is required' });
      const delivered = await service.submitInput(param(req, 'id'), node, data ?? {});
      if (!delivered) {
        return res.status(404).json({ error: 'No pending input request found for this execution/node' });
      }
      res.json({ status: 'input_received' });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/executions/:id/retry-from/:node
  router.post('/:id/retry-from/:node', async (req: Request, res: Response) => {
    try {
      const result = await service.retryFromNode(param(req, 'id'), param(req, 'node'));
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/executions/:id/traces
  router.get('/:id/traces', async (req: Request, res: Response) => {
    try {
      const traces = await service.getTraces(param(req, 'id'));
      res.json(traces);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/executions/:id/traces/:node
  router.get('/:id/traces/:node', async (req: Request, res: Response) => {
    try {
      const traces = await service.getTracesByNode(param(req, 'id'), param(req, 'node'));
      res.json(traces);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/executions/:id/logs
  router.get('/:id/logs', async (req: Request, res: Response) => {
    try {
      const executionId = param(req, 'id');
      const filter: Record<string, unknown> = { executionId };
      if (req.query.node) filter.node = String(req.query.node);
      if (req.query.category) filter.category = String(req.query.category);
      if (req.query.level) filter.level = String(req.query.level);

      const limit = Math.min(parseInt(String(req.query.limit ?? '500'), 10), 2000);
      const offset = parseInt(String(req.query.offset ?? '0'), 10);

      const logs = await db.collection('execution_logs')
        .find(filter)
        .sort({ timestamp: 1 })
        .skip(offset)
        .limit(limit)
        .toArray();

      res.json(logs);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/executions/:id/traces/:node/:attempt
  router.get('/:id/traces/:node/:attempt', async (req: Request, res: Response) => {
    try {
      const attempt = parseInt(param(req, 'attempt'), 10);
      if (isNaN(attempt)) return res.status(400).json({ error: 'attempt must be a number' });
      const trace = await service.getTraceByAttempt(param(req, 'id'), param(req, 'node'), attempt);
      if (!trace) return res.status(404).json({ error: 'Trace not found' });
      res.json(trace);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
