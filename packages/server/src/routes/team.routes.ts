/**
 * Team API routes — phase 3 of the teams architecture.
 *
 * Manual CRUD over the `teams` collection. Built-in teams cannot be modified
 * or deleted (the service enforces this). Teams with members require an
 * explicit cascading delete request so the UI can show a guarded confirmation.
 */

import { Router, type Request, type Response } from 'express';
import type { Db } from 'mongodb';
import { TeamService, type TeamInput } from '../services/team.service.js';
import { restoreSet } from '../services/soft-delete.js';
import { buildTeamLeadSystemPrompt, defaultAutoLeadSlug } from '../services/team-lead-template.js';
import { getAgentDefaults } from '../services/llm-defaults.js';
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

  // GET /api/teams/:name/blueprint — full blueprint (team + members + spawn-target edges)
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
      // org chart anchoring and team lead ownership.
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

  // POST /api/teams/with-members — create a team with an auto-generated lead
  // and optional members in one shot. This is the endpoint the "Create Team"
  // and "Create Team from selected agents" flows on the agents page call.
  //
  // Body:
  //   team: { name, displayName, description?, mission?, parentTeamName? }
  //   lead?: { name?, displayName?, model?, reasoningEffort?, system? }  // all optional
  //   memberAgentNames?: string[]  // existing agents to move into the new team
  //   autoWireSpawnTargets?: boolean // default true — add members to lead.spawnTargets
  //
  // Transactional-ish: if any step fails, we best-effort roll back the lead
  // insert so the operator can retry without a dangling agent.
  router.post('/with-members', async (req: Request, res: Response) => {
    try {
      const team = (req.body?.team ?? {}) as Partial<TeamInput>;
      const leadSpec = (req.body?.lead ?? {}) as {
        name?: string;
        displayName?: string;
        model?: string;
        reasoningEffort?: string;
        system?: string;
      };
      const memberAgentNames = (req.body?.memberAgentNames ?? []) as string[];
      const autoWire = req.body?.autoWireSpawnTargets ?? true;

      if (!team.name || !team.displayName) {
        return res.status(400).json({ error: 'team.name and team.displayName are required' });
      }

      const deletedTeam = await db.collection('teams').findOne({ name: team.name, isDeleted: true });
      const existing = deletedTeam ? null : await service.getByName(team.name);
      if (existing) return res.status(409).json({ error: `Team "${team.name}" already exists` });

      if (team.parentTeamName) {
        const parent = await service.getByName(team.parentTeamName);
        if (!parent) return res.status(400).json({ error: `Parent team "${team.parentTeamName}" not found` });
      }

      // Resolve lead identity
      const leadName = leadSpec.name?.trim() || defaultAutoLeadSlug(team.name);
      if (!/^[a-z][a-z0-9-]*$/.test(leadName)) {
        return res.status(400).json({ error: `Lead slug "${leadName}" must be a lowercase slug` });
      }
      let existingLead: Record<string, unknown> | null = null;
      const leadClash = await db.collection('agents').findOne({ name: leadName });
      if (leadClash && !leadClash.isDeleted) {
        return res.status(409).json({
          error: `Lead slug "${leadName}" already exists. Rename the team or pass lead.name explicitly.`,
          code: 'lead-slug-taken',
        });
      }
      // If leadClash exists but isDeleted, it's a soft-deleted agent — proceed (it'll be restored implicitly)
      if (leadClash && leadClash.isDeleted) {
        existingLead = leadClash;
      }

      // Verify all member agents exist.
      const memberDocs = memberAgentNames.length > 0
        ? await db.collection('agents').find({ name: { $in: memberAgentNames } }).toArray()
        : [];
      if (memberDocs.length !== memberAgentNames.length) {
        const found = new Set(memberDocs.map(m => m.name));
        const missing = memberAgentNames.filter(n => !found.has(n));
        return res.status(400).json({ error: `Member agent(s) not found: ${missing.join(', ')}` });
      }

      // Step 1: insert the auto-lead agent.
      const leadSystemPrompt = leadSpec.system?.trim()
        ? leadSpec.system
        : buildTeamLeadSystemPrompt({
            displayName: team.displayName,
            mission: team.mission,
            memberNames: memberAgentNames,
          });
      const defaults = getAgentDefaults();
      const leadDoc = {
        name: leadName,
        displayName: leadSpec.displayName ?? `${team.displayName} Lead`,
        description: `Lead of the ${team.displayName} team.`,
        teamName: team.name,
        teamRole: 'lead' as const,
        type: 'team' as const,
        icon: 'users',
        color: '#6366f1',
        provider: defaults.provider,
        model: leadSpec.model ?? defaults.model,
        reasoningEffort: (leadSpec.reasoningEffort ?? 'high') as 'off' | 'low' | 'medium' | 'high' | 'max',
        planMode: false,
        tools: [],
        capabilities: ['coordination', 'spawn-orchestration'],
        spawnTargets: autoWire ? memberAgentNames : [],
        canTrigger: [],
        personality: 'Pragmatic coordinator. Breaks work into clear briefs and waits on spawned-agent results.',
        system: leadSystemPrompt,
        isBuiltIn: false,
        createdBy: 'user',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      if (existingLead) {
        await db.collection('agents').updateOne({ name: leadName }, restoreSet(leadDoc));
      } else {
        await db.collection('agents').insertOne(leadDoc);
      }

      // Step 2: create the team row.
      let createdTeam;
      try {
        createdTeam = await service.create(
          {
            name: team.name,
            displayName: team.displayName,
            description: team.description ?? '',
            mission: team.mission,
            leadAgentName: leadName,
            parentTeamName: team.parentTeamName,
          },
          { isBuiltIn: false, createdBy: 'user' },
        );
      } catch (err) {
        // Roll back the lead insert so the operator can retry cleanly.
        await db.collection('agents').deleteOne({ name: leadName });
        return res.status(500).json({ error: `Failed to create team row: ${(err as Error).message}` });
      }

      // Step 3: move members into the new team.
      const moved: string[] = [];
      const skipped: { name: string; reason: string }[] = [];
      for (const memberName of memberAgentNames) {
        try {
          await db.collection('agents').updateOne(
            { name: memberName },
            { $set: { teamName: team.name, teamRole: 'member', updatedAt: new Date() } },
          );
          moved.push(memberName);
        } catch (err) {
          skipped.push({ name: memberName, reason: (err as Error).message });
        }
      }

      const wasRestored = !!(deletedTeam || existingLead);
      res.status(201).json({ team: { ...createdTeam, restored: wasRestored }, lead: { name: leadName, restored: !!existingLead }, moved, skipped, restored: wasRestored });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // DELETE /api/teams/:name — delete a team (not built-in). Pass
  // { deleteAgents: true } after user confirmation to also soft-delete all
  // active non-built-in agents in the team.
  router.delete('/:name', async (req: Request, res: Response) => {
    try {
      const result = await service.delete(param(req, 'name'), {
        deleteAgents: req.body?.deleteAgents === true,
        deletedBy: req.body?.userId?.toString?.() ?? null,
      });
      res.json(result);
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
