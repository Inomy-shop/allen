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

  // POST /api/executions/:id/resume-agent  { prompt }
  // Resume a completed/failed agent execution as a new attempt on the SAME
  // executionId. Unlike /resume (workflow checkpoint resume), this variant is
  // specific to spawn_agent-initiated executions and appends attempt #N to
  // the existing trace stream so the UI can show attempt tabs.
  router.post('/:id/resume-agent', async (req: Request, res: Response) => {
    try {
      const prompt = req.body?.prompt as string | undefined;
      if (!prompt || !prompt.trim()) {
        return res.status(400).json({ error: 'prompt is required' });
      }
      const { resumeAgentExecution } = await import('../services/chat-tools.js');
      const result = await resumeAgentExecution(db, param(req, 'id'), prompt.trim());
      if ('error' in result) return res.status(400).json(result);
      res.status(202).json(result);
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

  // POST /api/executions/:id/cancel-subtree
  //
  // Cancels this execution AND every spawn-tree descendant via the
  // rootExecutionId index. Used from the Spawned Agents panel to kill a
  // whole branch without having to click through each child. The parent
  // /cancel route handles the top execution, we just need to reach the
  // already-running descendants.
  router.post('/:id/cancel-subtree', async (req: Request, res: Response) => {
    try {
      const id = param(req, 'id');
      // Gather descendants (running or not — we try to cancel each).
      const descendants = await db
        .collection('executions')
        .find(
          { rootExecutionId: id, id: { $ne: id } },
          { projection: { id: 1, status: 1 } },
        )
        .toArray();
      const ids = [id, ...descendants.map(d => d.id as string)];
      const results: { id: string; ok: boolean; error?: string }[] = [];
      for (const execId of ids) {
        try {
          await service.cancel(execId);
          results.push({ id: execId, ok: true });
        } catch (err: unknown) {
          results.push({ id: execId, ok: false, error: (err as Error).message });
        }
      }
      res.json({ cancelled: results.filter(r => r.ok).length, total: ids.length, results });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/executions/:id/children
  //
  // Returns every execution spawned by this one. Two scopes:
  //   mode=direct      → only rows where parentExecutionId === :id
  //                      (children immediately under this execution)
  //   mode=descendants → every row where rootExecutionId === :id
  //                      (entire spawn subtree — children, grandchildren, ...)
  // Default is `direct`. The rows carry the minimum fields the execution
  // detail page needs to render the "Spawned Agents" panel without a
  // second round-trip.
  router.get('/:id/children', async (req: Request, res: Response) => {
    try {
      const mode = (req.query.mode as string) === 'descendants' ? 'descendants' : 'direct';
      const rows = await service.getChildren(param(req, 'id'), mode);
      res.json(rows);
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
  //
  // Returns the execution's own log rows plus, by default, any rows from
  // spawn-tree descendants (children spawned via spawn_agent) so the
  // workflow execution page reconstructs the same merged view the live
  // SSE fan-out produces. Descendant rows are decorated with
  // `childExecutionId` / `childAgentName` fields so the UI can render
  // them indented with their origin tag.
  //
  // Query params:
  //   include_descendants=false   — exclude child logs (child pages use this)
  //   limit / offset              — standard pagination
  //   node / category / level     — field filters on the PARENT's own rows;
  //                                 not applied to descendant rows so the
  //                                 user sees the full child context
  router.get('/:id/logs', async (req: Request, res: Response) => {
    try {
      const executionId = param(req, 'id');
      const includeDescendants = req.query.include_descendants !== 'false';

      // Start with the parent's own filter. These field filters only apply
      // to parent rows, not descendants — descendant rows carry different
      // categories (tool/agent) that the user probably still wants to see.
      const parentFilter: Record<string, unknown> = { executionId };
      if (req.query.node) parentFilter.node = String(req.query.node);
      if (req.query.category) parentFilter.category = String(req.query.category);
      if (req.query.level) parentFilter.level = String(req.query.level);

      // Find every descendant execution id (any depth) via the
      // rootExecutionId index, excluding the root itself. Also capture
      // each descendant's agent name + caller so we can decorate the
      // returned rows with child-tag fields the UI uses for indentation.
      let descendantIds: string[] = [];
      const descendantMeta = new Map<string, { agentName: string; parentCaller: string | null; depth: number }>();
      if (includeDescendants) {
        const descendants = await db
          .collection('executions')
          .find(
            { rootExecutionId: executionId, id: { $ne: executionId } },
            { projection: { id: 1, workflowName: 1, parentCaller: 1, spawnDepth: 1 } },
          )
          .toArray();
        for (const d of descendants) {
          const wf = (d.workflowName as string | undefined) ?? '';
          const agentNameFromWf = wf.includes(':spawn_agent/') ? wf.split(':spawn_agent/')[1] : '';
          descendantIds.push(d.id as string);
          descendantMeta.set(d.id as string, {
            agentName: agentNameFromWf || 'unknown',
            parentCaller: (d.parentCaller as string | undefined) ?? null,
            depth: (d.spawnDepth as number | undefined) ?? 1,
          });
        }
      }

      const filter: Record<string, unknown> = descendantIds.length > 0
        ? { $or: [parentFilter, { executionId: { $in: descendantIds } }] }
        : parentFilter;

      const limit = Math.min(parseInt(String(req.query.limit ?? '500'), 10), 2000);
      const offset = parseInt(String(req.query.offset ?? '0'), 10);

      const logs = await db.collection('execution_logs')
        .find(filter)
        .sort({ timestamp: 1 })
        .skip(offset)
        .limit(limit)
        .toArray();

      // Normalize descendant rows into the engine's log shape so the UI
      // renders them natively. The child's own execution_logs rows use a
      // different schema (`{ type, tool, content, agent }`) than engine
      // logs (`{ category, level, node, message, data }`) because the
      // chat-tools liveLog helper predates the engine's structured log
      // schema. Parent rows pass through unchanged.
      const normalized = logs.map(row => {
        const rowExecId = row.executionId as string;
        const meta = descendantMeta.get(rowExecId);
        if (!meta) return row; // parent row, pass through

        // Already in engine shape? (Future: if we migrate liveLog to the
        // engine schema, descendant rows will come out typed correctly.)
        if (typeof row.category === 'string' && typeof row.message === 'string') {
          return {
            ...row,
            data: {
              ...((row.data as Record<string, unknown>) ?? {}),
              childExecutionId: rowExecId,
              childAgentName: meta.agentName,
              childParentCaller: meta.parentCaller,
              childDepth: meta.depth,
            },
          };
        }

        // Legacy liveLog shape — transform into engine shape.
        const type = row.type as string | undefined;
        const tool = row.tool as string | undefined;
        const content = row.content as string | undefined;
        const category: 'tool' | 'agent' | 'system' =
          type === 'tool_use' || tool ? 'tool'
          : type === 'text' ? 'agent'
          : 'system';
        const message = content ?? (tool ? `Tool: ${tool}` : type ?? '(child log)');
        return {
          _id: row._id,
          executionId: rowExecId,
          timestamp: row.timestamp ?? new Date(),
          level: 'info',
          category,
          node: meta.parentCaller ?? meta.agentName,
          message,
          data: {
            childExecutionId: rowExecId,
            childAgentName: meta.agentName,
            childParentCaller: meta.parentCaller,
            childDepth: meta.depth,
            originalType: type,
            originalTool: tool,
          },
        };
      });

      res.json(normalized);
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
