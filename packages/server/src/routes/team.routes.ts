/**
 * Team API routes — phase 3 of the teams architecture.
 *
 * Manual CRUD over the `teams` collection. Built-in teams cannot be modified
 * or deleted (the service enforces this). Teams with members cannot be deleted.
 */

import { Router, type Request, type Response } from 'express';
import type { Db } from 'mongodb';
import { TeamService, type TeamInput } from '../services/team.service.js';
import { param } from '../types.js';

export function teamRoutes(db: Db): Router {
  const router = Router();
  const service = new TeamService(db);

  // GET /api/teams — list all teams
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const teams = await service.list();
      res.json(teams);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/teams/:name — get one team
  router.get('/:name', async (req: Request, res: Response) => {
    try {
      const team = await service.getByName(param(req, 'name'));
      if (!team) return res.status(404).json({ error: 'Team not found' });
      res.json(team);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/teams/:name/members — list agents in this team
  router.get('/:name/members', async (req: Request, res: Response) => {
    try {
      const members = await service.listMembers(param(req, 'name'));
      res.json(members);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/teams/:name/blueprint — full blueprint (team + members + delegation edges)
  router.get('/:name/blueprint', async (req: Request, res: Response) => {
    try {
      const blueprint = await service.getBlueprint(param(req, 'name'));
      if (!blueprint) return res.status(404).json({ error: 'Team not found' });
      res.json(blueprint);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/teams — create a new team (manual)
  router.post('/', async (req: Request, res: Response) => {
    try {
      const { name, displayName, description, mission, leadAgentName, parentTeamName } = req.body;
      if (!name || !displayName || !leadAgentName) {
        return res.status(400).json({ error: 'name, displayName, and leadAgentName are required' });
      }

      // Validate that the lead exists
      const lead = await db.collection('agents').findOne({ name: leadAgentName });
      if (!lead) {
        return res.status(400).json({ error: `Lead agent "${leadAgentName}" not found. Create the agent first, then create the team.` });
      }

      // Reject duplicates explicitly
      const existing = await service.getByName(name);
      if (existing) {
        return res.status(409).json({ error: `Team "${name}" already exists` });
      }

      // Validate parent team exists if provided
      if (parentTeamName) {
        const parent = await service.getByName(parentTeamName);
        if (!parent) {
          return res.status(400).json({ error: `Parent team "${parentTeamName}" not found` });
        }
      }

      // Promote the lead first (sets teamName/teamRole on the agent, refuses
      // cross-team moves). If it throws, we abort before creating the team.
      try {
        await service.promoteToLead(leadAgentName, name);
      } catch (promoteErr) {
        return res.status(400).json({ error: (promoteErr as Error).message });
      }

      const input: TeamInput = {
        name,
        displayName,
        description: description ?? '',
        mission,
        leadAgentName,
        parentTeamName,
      };
      const team = await service.create(input, { isBuiltIn: false, createdBy: 'user' });
      res.status(201).json(team);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // PUT /api/teams/:name — update a team
  router.put('/:name', async (req: Request, res: Response) => {
    try {
      // Strip immutable & protected fields. leadAgentName is intentionally
      // immutable after team creation — changing it would silently break the
      // org chart anchoring and `canDelegate` enforcement.
      const updates = { ...req.body };
      delete updates._id;
      delete updates.name;
      delete updates.leadAgentName;
      delete updates.isBuiltIn;
      delete updates.createdBy;
      delete updates.createdAt;
      const team = await service.update(param(req, 'name'), updates);
      if (!team) return res.status(404).json({ error: 'Team not found' });
      res.json(team);
    } catch (err: unknown) {
      const msg = (err as Error).message;
      // built-in protection raises a clear error — surface it as 403
      if (msg.includes('built-in')) return res.status(403).json({ error: msg });
      res.status(400).json({ error: msg });
    }
  });

  // DELETE /api/teams/:name — delete a team (only if empty + not built-in)
  router.delete('/:name', async (req: Request, res: Response) => {
    try {
      await service.delete(param(req, 'name'));
      res.status(204).send();
    } catch (err: unknown) {
      const msg = (err as Error).message;
      if (msg.includes('built-in')) return res.status(403).json({ error: msg });
      if (msg.includes('still has')) return res.status(409).json({ error: msg });
      if (msg.includes('not found')) return res.status(404).json({ error: msg });
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
