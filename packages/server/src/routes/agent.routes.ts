import { Router, type Request, type Response } from 'express';
import { param } from '../types.js';
import type { Db } from 'mongodb';
import { resolveAgentSettings, AgentSettingsValidationError, type AgentLike } from '../services/agent-settings.js';

const ALLOWED_EFFORTS = new Set(['off', 'low', 'medium', 'high', 'max']);

function validateAgentSettingsFields(body: Record<string, unknown>): void {
  if (body.reasoningEffort !== undefined && body.reasoningEffort !== null) {
    if (typeof body.reasoningEffort !== 'string' || !ALLOWED_EFFORTS.has(body.reasoningEffort)) {
      throw new AgentSettingsValidationError(
        'invalid_reasoning_effort',
        `reasoningEffort must be one of ${[...ALLOWED_EFFORTS].join(', ')}`,
      );
    }
  }
  if (body.planMode !== undefined && body.planMode !== null && typeof body.planMode !== 'boolean') {
    throw new AgentSettingsValidationError('invalid_plan_mode', 'planMode must be a boolean');
  }
  // Semantic validation (planMode+provider, effort=max+model) runs via resolve on the merged agent.
  const probe: AgentLike = {
    name: (body.name as string) ?? 'probe',
    provider: body.provider as string | undefined,
    model: body.model as string | undefined,
    reasoningEffort: body.reasoningEffort as AgentLike['reasoningEffort'],
    planMode: body.planMode as boolean | undefined,
  };
  resolveAgentSettings(probe);
}

export function agentRoutes(db: Db): Router {
  const router = Router();
  const col = db.collection('agents');

  // GET /api/agents
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const agents = await col.find({}).sort({ name: 1 }).toArray();
      res.json(agents);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/agents
  router.post('/', async (req: Request, res: Response) => {
    try {
      // Strip protected fields — these can ONLY be set by the seed migration or
      // by team-builder/agent-builder via the meta chat tools. Allowing them on
      // a public POST would let any client bypass the meta-team permission gating.
      const body = { ...req.body };
      delete body._id;
      delete body.teamName;
      delete body.teamRole;
      delete body.isBuiltIn;
      delete body.createdBy;
      delete body.createdAt;

      validateAgentSettingsFields(body);

      const agent = {
        ...body,
        isBuiltIn: false,
        createdBy: 'user',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const result = await col.insertOne(agent);
      res.status(201).json({ ...agent, _id: result.insertedId });
    } catch (err: unknown) {
      if (err instanceof AgentSettingsValidationError) {
        return res.status(400).json({ error: err.message, code: err.code });
      }
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // PUT /api/agents/:name
  router.put('/:name', async (req: Request, res: Response) => {
    try {
      const { name } = req.params;
      // Strip protected fields — see POST handler comment. The meta team is
      // the only authority on team membership, lead promotion, and built-in flags.
      const updates = { ...req.body, updatedAt: new Date() };
      delete updates._id;
      delete updates.name;
      delete updates.teamName;
      delete updates.teamRole;
      delete updates.isBuiltIn;
      delete updates.createdBy;
      delete updates.createdAt;

      // For PUT, fold the update over the existing doc before validating — that
      // way someone toggling just `planMode` doesn't have to resend `provider`.
      const existing = await col.findOne({ name });
      if (!existing) return res.status(404).json({ error: 'Agent not found' });
      validateAgentSettingsFields({ ...existing, ...updates });

      const result = await col.updateOne({ name }, { $set: updates });
      if (result.matchedCount === 0) return res.status(404).json({ error: 'Agent not found' });
      res.json({ name, ...updates });
    } catch (err: unknown) {
      if (err instanceof AgentSettingsValidationError) {
        return res.status(400).json({ error: err.message, code: err.code });
      }
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // DELETE /api/agents/:name
  router.delete('/:name', async (req: Request, res: Response) => {
    try {
      const agent = await col.findOne({ name: param(req, 'name') });
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      await col.deleteOne({ name: param(req, 'name') });
      res.status(204).send();
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
