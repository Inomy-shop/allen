import { Router, type Response } from 'express';
import type { Db } from 'mongodb';
import { LinearService, type LinearStateType } from '../services/linear.service.js';
import type { AuthedRequest } from '../middleware/requireAuth.js';
import { param } from '../types.js';

const VALID_STATE_TYPES: LinearStateType[] = ['backlog', 'unstarted', 'started', 'completed', 'canceled', 'triage'];

function parseStateTypes(raw: unknown): LinearStateType[] | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean) as LinearStateType[];
  const filtered = parts.filter(p => VALID_STATE_TYPES.includes(p));
  return filtered.length > 0 ? filtered : undefined;
}

export function linearRoutes(db: Db): Router {
  const router = Router();
  const service = new LinearService(db);

  // GET /api/linear/status
  router.get('/status', async (_req: AuthedRequest, res: Response) => {
    try {
      const status = await service.status();
      res.json(status);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/linear/projects
  router.get('/projects', async (_req: AuthedRequest, res: Response) => {
    try {
      const projects = await service.listProjects();
      res.json(projects);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/linear/issues?projectId=&state=backlog,started&q=&limit=
  router.get('/issues', async (req: AuthedRequest, res: Response) => {
    try {
      const projectId = typeof req.query.projectId === 'string' && req.query.projectId ? req.query.projectId : undefined;
      const stateTypes = parseStateTypes(req.query.state);
      const q = typeof req.query.q === 'string' ? req.query.q : undefined;
      const limitRaw = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : NaN;
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;

      // When assignee=me, resolve to authenticated user's email
      const assigneeEmail = req.query.assignee === 'me' && req.user?.email
        ? req.user.email : undefined;

      if (req.query.assignee === 'me') {
        if (req.user?.email) {
          console.log('[linear] assignee=me resolved — email present');
        } else {
          console.log('[linear] assignee=me ignored — req.user.email missing');
        }
      }

      const issues = await service.listIssues({ projectId, stateTypes, q, limit, assigneeEmail });
      res.json(issues);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/linear/issues/:id
  router.get('/issues/:id', async (req: AuthedRequest, res: Response) => {
    try {
      const issue = await service.getIssue(param(req, 'id'));
      if (!issue) return res.status(404).json({ error: 'not_found' });
      res.json(issue);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // PATCH /api/linear/issues/:id/assign-agent  body: { agentName: string | null }
  router.patch('/issues/:id/assign-agent', async (req: AuthedRequest, res: Response) => {
    try {
      const agentName = req.body?.agentName;
      if (agentName !== null && typeof agentName !== 'string') {
        return res.status(400).json({ error: 'agentName must be a string or null' });
      }
      const assignedBy = req.user?.email ?? 'unknown';
      const assignment = await service.assignAgent(param(req, 'id'), agentName, assignedBy);
      res.json({ assignment });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/linear/issues/:id/dispatch  body: { agentName, repoId, extraInstructions?, promptTemplate? }
  // Creates a workspace from the chosen repo, waits for it to be ready, then
  // spawns the agent with the ticket body as the prompt. Returns the initial
  // "pending" assignment immediately; the UI polls /issues/:id to see progress.
  router.post('/issues/:id/dispatch', async (req: AuthedRequest, res: Response) => {
    try {
      const { agentName, repoId, extraInstructions, promptTemplate } = req.body ?? {};
      if (typeof agentName !== 'string' || !agentName.trim()) {
        return res.status(400).json({ error: 'agentName is required' });
      }
      if (typeof repoId !== 'string' || !repoId.trim()) {
        return res.status(400).json({ error: 'repoId is required' });
      }
      if (promptTemplate != null && typeof promptTemplate !== 'string') {
        return res.status(400).json({ error: 'promptTemplate must be a string' });
      }
      const dispatchedBy = req.user?.email ?? 'unknown';
      const assignment = await service.dispatch({
        linearIssueId: param(req, 'id'),
        agentName,
        repoId,
        extraInstructions: typeof extraInstructions === 'string' ? extraInstructions : undefined,
        promptTemplate: typeof promptTemplate === 'string' ? promptTemplate : undefined,
        dispatchedBy,
      });
      res.status(202).json({ assignment });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/linear/issues/:id/dispatch-workflow  body: { workflowId, input }
  router.post('/issues/:id/dispatch-workflow', async (req: AuthedRequest, res: Response) => {
    try {
      const { workflowId, input } = req.body ?? {};
      if (typeof workflowId !== 'string' || !workflowId.trim()) {
        return res.status(400).json({ error: 'workflowId is required' });
      }
      if (input != null && typeof input !== 'object') {
        return res.status(400).json({ error: 'input must be an object' });
      }
      const dispatchedBy = req.user?.email ?? 'unknown';
      const assignment = await service.dispatchWorkflow({
        linearIssueId: param(req, 'id'),
        workflowId,
        input: (input ?? {}) as Record<string, unknown>,
        dispatchedBy,
      });
      res.status(202).json({ assignment });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
