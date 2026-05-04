/**
 * Meta team chat tools — phase 4 of the teams architecture.
 *
 * These tools let the team-builder-agent and agent-builder-agent extend the
 * Allen org chart by creating teams and agents. They are gated by a
 * per-agent allow-list (see `assertCallerIsBuilder` below) — only the two
 * builder agents can call them. Every other agent gets a permission error.
 *
 * Tool catalog:
 *   read-only (any meta team agent can call):
 *     - list_teams
 *     - list_team_members
 *     - get_team_blueprint
 *
 *   create_agent / update_agent / delete_agent — both builders may call
 *
 *   create_team / update_team / delete_team — only team-builder-agent may call
 *
 * The "active session caller" is read from the active session registry, same
 * as how delegate_to_agent identifies who's calling it.
 */

import type { Db } from 'mongodb';
import type { ChatTool } from './chat-tools.js';
import { getAnyActiveSession } from './chat-tools.js';
import { TeamService } from './team.service.js';
import { WorkflowService } from './workflow.service.js';
import type { WorkflowDef } from '@allen/engine';
import yaml from 'js-yaml';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Some MCP clients/models send boolean parameters as strings ("true" / "false").
 * This helper accepts the actual `true` boolean OR a case-insensitive "true"
 * string. Used by the destructive tools' confirm parameter.
 */
function isConfirmed(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'string' && value.toLowerCase() === 'true') return true;
  return false;
}

// ── Permission gating ────────────────────────────────────────────────────────

/** Tools that ONLY team-builder-agent can call (creates/destroys whole teams) */
const TEAM_BUILDER_ONLY = new Set([
  'create_team',
  'update_team',
  'delete_team',
]);

/** Tools that team-builder-agent OR agent-builder-agent can call (mutates agents) */
const ANY_BUILDER = new Set([
  'create_agent',
  'update_agent',
  'delete_agent',
]);

/** Tools that ONLY workflow-builder-agent can call (creates/updates workflows) */
const WORKFLOW_BUILDER_ONLY = new Set([
  'create_workflow',
  'update_workflow',
]);

/**
 * Walk up the active-session registry to find which agent invoked this tool.
 * Returns the calling agent's name. Falls back to "assistant" if no agent
 * context (i.e., the user is calling it from a normal chat, not from inside
 * a delegated agent's turn).
 */
function getCallerAgent(): string {
  const ctx = getAnyActiveSession();
  return ctx?.currentAgent ?? 'assistant';
}

/**
 * Throw a permission error if the current caller isn't allowed to invoke this tool.
 * Returns the caller agent name on success for downstream use.
 */
function assertCallerCanCall(toolName: string): { ok: true; caller: string } | { ok: false; error: string } {
  const caller = getCallerAgent();

  if (TEAM_BUILDER_ONLY.has(toolName)) {
    if (caller !== 'team-builder-agent') {
      return {
        ok: false,
        error: `Permission denied: only team-builder-agent can call ${toolName}. Caller: "${caller}".`,
      };
    }
  }

  if (ANY_BUILDER.has(toolName)) {
    if (caller !== 'team-builder-agent' && caller !== 'agent-builder-agent') {
      return {
        ok: false,
        error: `Permission denied: only team-builder-agent or agent-builder-agent can call ${toolName}. Caller: "${caller}".`,
      };
    }
  }

  if (WORKFLOW_BUILDER_ONLY.has(toolName)) {
    if (caller !== 'workflow-builder-agent') {
      return {
        ok: false,
        error: `Permission denied: only workflow-builder-agent can call ${toolName}. Caller: "${caller}".`,
      };
    }
  }

  return { ok: true, caller };
}

// ── Read-only tools (no permission gating beyond meta-team membership at runtime) ──

const listTeamsTool: ChatTool = {
  name: 'list_teams',
  description: 'List all teams in the Allen org chart. Returns name, displayName, mission, leadAgentName, parentTeamName, and isBuiltIn for each. Read-only — no permission required.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async execute(_args, db) {
    const teams = await new TeamService(db).list();
    return {
      teams: teams.map((t) => ({
        name: t.name,
        displayName: t.displayName,
        description: t.description,
        mission: t.mission,
        leadAgentName: t.leadAgentName,
        parentTeamName: t.parentTeamName,
        isBuiltIn: t.isBuiltIn,
      })),
    };
  },
};

const listTeamMembersTool: ChatTool = {
  name: 'list_team_members',
  description: 'List all agents that belong to a given team. Returns each member with their name, displayName, teamRole, capabilities, tools, and canDelegateTo list.',
  inputSchema: {
    type: 'object',
    properties: {
      team_name: { type: 'string', description: 'The team slug to list members of' },
    },
    required: ['team_name'],
  },
  async execute(args, db) {
    const teamName = args.team_name as string;
    const team = await new TeamService(db).getByName(teamName);
    if (!team) return { error: `Team "${teamName}" not found` };
    const members = await new TeamService(db).listMembers(teamName);
    return {
      team: { name: team.name, displayName: team.displayName, mission: team.mission },
      members: members.map((m) => ({
        name: m.name,
        displayName: m.displayName,
        teamRole: m.teamRole,
        capabilities: m.capabilities,
        tools: m.tools,
        canDelegateTo: m.canDelegateTo,
      })),
    };
  },
};

const getTeamBlueprintTool: ChatTool = {
  name: 'get_team_blueprint',
  description: 'Return a team\'s full blueprint: team metadata, all member agents (with system prompts), and the internal delegation edges. Use this BEFORE adding a new agent to an existing team so your blueprint integrates with what already exists.',
  inputSchema: {
    type: 'object',
    properties: {
      team_name: { type: 'string', description: 'The team slug' },
    },
    required: ['team_name'],
  },
  async execute(args, db) {
    const teamName = args.team_name as string;
    const blueprint = await new TeamService(db).getBlueprint(teamName);
    if (!blueprint) return { error: `Team "${teamName}" not found` };
    // Spread into a plain object so the return type matches Record<string, unknown>
    // without the unsafe double cast.
    return {
      team: blueprint.team,
      agents: blueprint.agents,
      delegationEdges: blueprint.delegationEdges,
    };
  },
};

// ── Team management tools (team-builder only) ─────────────────────────────────

const createTeamTool: ChatTool = {
  name: 'create_team',
  description: 'Create a new team in the org chart. Only team-builder-agent can call this. The lead agent must already exist (call create_agent for the lead first, then create_team).',
  destructive: true,
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Lowercase slug, e.g. "finance"' },
      displayName: { type: 'string', description: 'Human-readable name, e.g. "Finance Team"' },
      description: { type: 'string', description: '1-sentence description' },
      mission: { type: 'string', description: '2-3 sentence mission used in agent system prompts' },
      leadAgentName: { type: 'string', description: 'Name of the team lead agent (must already exist)' },
      parentTeamName: { type: 'string', description: 'Optional parent team name (defaults to "executive")' },
    },
    required: ['name', 'displayName', 'leadAgentName'],
  },
  async execute(args, db) {
    const guard = assertCallerCanCall('create_team');
    if (!guard.ok) return { error: guard.error };

    const name = args.name as string;
    const teamService = new TeamService(db);

    // Verify the lead exists
    const lead = await db.collection('agents').findOne({ name: args.leadAgentName as string });
    if (!lead) {
      return { error: `Lead agent "${args.leadAgentName}" not found. Create the lead agent first via create_agent, then call create_team.` };
    }

    // Reject duplicates
    const existing = await teamService.getByName(name);
    if (existing) return { error: `Team "${name}" already exists` };

    // Validate parent team exists if provided
    if (args.parentTeamName) {
      const parent = await teamService.getByName(args.parentTeamName as string);
      if (!parent) return { error: `Parent team "${args.parentTeamName}" not found` };
    }

    try {
      // Promote the lead BEFORE creating the team so a cross-team-move violation
      // aborts the whole operation cleanly with no orphan team left behind.
      await teamService.promoteToLead(args.leadAgentName as string, name);

      const team = await teamService.create(
        {
          name,
          displayName: args.displayName as string,
          description: (args.description as string) ?? '',
          mission: args.mission as string | undefined,
          leadAgentName: args.leadAgentName as string,
          parentTeamName: args.parentTeamName as string | undefined,
        },
        { isBuiltIn: false, createdBy: 'team-builder' },
      );

      return {
        success: true,
        team: { name: team.name, displayName: team.displayName, leadAgentName: team.leadAgentName, parentTeamName: team.parentTeamName },
      };
    } catch (err) {
      return { error: (err as Error).message };
    }
  },
};

const updateTeamTool: ChatTool = {
  name: 'update_team',
  description: 'Update a team\'s description, mission, or parent. The team slug and lead cannot be changed. Only team-builder-agent can call this. Built-in teams cannot be updated.',
  destructive: true,
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Team slug' },
      displayName: { type: 'string' },
      description: { type: 'string' },
      mission: { type: 'string' },
      parentTeamName: { type: 'string' },
    },
    required: ['name'],
  },
  async execute(args, db) {
    const guard = assertCallerCanCall('update_team');
    if (!guard.ok) return { error: guard.error };

    const name = args.name as string;
    const updates: Record<string, unknown> = {};
    if (args.displayName !== undefined) updates.displayName = args.displayName;
    if (args.description !== undefined) updates.description = args.description;
    if (args.mission !== undefined) updates.mission = args.mission;
    if (args.parentTeamName !== undefined) updates.parentTeamName = args.parentTeamName;

    try {
      const team = await new TeamService(db).update(name, updates);
      if (!team) return { error: `Team "${name}" not found` };
      return { success: true, team: { name: team.name, displayName: team.displayName } };
    } catch (err) {
      return { error: (err as Error).message };
    }
  },
};

const deleteTeamTool: ChatTool = {
  name: 'delete_team',
  description: 'Delete a team from the org chart. Refuses if the team has any members (delete or move them first). Refuses to delete built-in teams. Only team-builder-agent can call this. Requires confirm=true to actually run.',
  destructive: true,
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Team slug to delete' },
      confirm: { type: 'boolean', description: 'Must be true to actually delete (safety check)' },
    },
    required: ['name', 'confirm'],
  },
  async execute(args, db) {
    const guard = assertCallerCanCall('delete_team');
    if (!guard.ok) return { error: guard.error };

    if (!isConfirmed(args.confirm)) {
      return { error: 'delete_team requires confirm=true (boolean). This is a safety check — confirm with the user first.' };
    }

    try {
      await new TeamService(db).delete(args.name as string);
      return { success: true, deleted: args.name };
    } catch (err) {
      return { error: (err as Error).message };
    }
  },
};

// ── Agent management tools (either builder) ──────────────────────────────────

const createAgentTool: ChatTool = {
  name: 'create_agent',
  description: 'Create a new agent in an existing team. team-builder-agent and agent-builder-agent can call this. The team must already exist. The agent slug must be unique system-wide. The new agent\'s teamName and teamRole are set from the args.',
  destructive: true,
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Lowercase slug, unique across all agents' },
      displayName: { type: 'string', description: 'Human-readable name' },
      teamName: { type: 'string', description: 'Existing team slug to add this agent to' },
      teamRole: { type: 'string', enum: ['lead', 'member'], description: 'Role within the team' },
      system: { type: 'string', description: 'Full system prompt for the agent' },
      provider: { type: 'string', enum: ['claude-cli', 'codex'], description: 'Which CLI provider to use' },
      model: { type: 'string', description: 'Model name (e.g. "sonnet", "gpt-5.5")' },
      tools: { type: 'array', items: { type: 'string' }, description: 'Array of tool names this agent can use' },
      capabilities: { type: 'array', items: { type: 'string' }, description: 'Array of capability tags' },
      canDelegateTo: { type: 'array', items: { type: 'string' }, description: 'Names of agents this agent can delegate to' },
      personality: { type: 'string', description: 'Brief personality descriptor' },
      icon: { type: 'string', description: 'Icon name for UI' },
      color: { type: 'string', description: 'Hex color for UI' },
    },
    required: ['name', 'displayName', 'teamName', 'teamRole', 'system', 'provider'],
  },
  async execute(args, db) {
    const guard = assertCallerCanCall('create_agent');
    if (!guard.ok) return { error: guard.error };

    const name = args.name as string;
    const teamName = args.teamName as string;
    const teamRole = args.teamRole as 'lead' | 'member' | undefined;

    // Verify team exists. EXCEPTION: when creating a LEAD, allow the team
    // to not exist yet. This breaks the chicken-and-egg deadlock between
    // create_team (needs lead) and create_agent (needs team). The lead is
    // created first, then create_team is called which finds the lead already
    // in the right team and succeeds without a cross-team move check.
    const team = await new TeamService(db).getByName(teamName);
    if (!team && teamRole !== 'lead') {
      return { error: `Team "${teamName}" not found. Create the team first via create_team.` };
    }
    // If we're bootstrapping a lead for a not-yet-existing team, log it so the
    // operator can spot stuck state if create_team is never called afterward.
    if (!team && teamRole === 'lead') {
      console.log(`[meta] create_agent bootstrap: creating lead "${name}" for not-yet-existing team "${teamName}". Team must be created next via create_team.`);
    }

    // Reject duplicate agent names
    const existingAgent = await db.collection('agents').findOne({ name });
    if (existingAgent) {
      return { error: `Agent "${name}" already exists. Pick a different name.` };
    }

    // If creating a lead, ensure no other lead exists in the team
    if (teamRole === 'lead') {
      const existingLead = await db.collection('agents').findOne({ teamName, teamRole: 'lead' });
      if (existingLead) {
        return { error: `Team "${teamName}" already has a lead: "${existingLead.name}". Demote the existing lead first.` };
      }
    }

    try {
      await db.collection('agents').insertOne({
        name,
        displayName: args.displayName,
        teamName,
        teamRole: args.teamRole,
        type: args.teamRole === 'lead' ? 'team' : 'technical', // legacy field for backwards compat
        system: args.system,
        provider: args.provider,
        model: args.model ?? 'sonnet',
        tools: args.tools ?? [],
        capabilities: args.capabilities ?? [],
        canDelegateTo: args.canDelegateTo ?? [],
        canTrigger: [],
        personality: args.personality,
        icon: args.icon ?? 'bot',
        color: args.color ?? '#3b82f6',
        isBuiltIn: false,
        createdBy: guard.caller === 'team-builder-agent' ? 'team-builder' : 'agent-builder',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      return {
        success: true,
        agent: { name, displayName: args.displayName, teamName, teamRole: args.teamRole },
      };
    } catch (err) {
      return { error: (err as Error).message };
    }
  },
};

const updateAgentTool: ChatTool = {
  name: 'update_agent',
  description: `Update an existing agent. Both builders can call this, but with constraints:

- team-builder-agent: can update any field on any non-built-in agent.
- agent-builder-agent: can ONLY update canDelegateTo on existing agents (this is needed when adding a new team member to make them reachable).

Built-in agents cannot be updated.`,
  destructive: true,
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Agent name to update' },
      displayName: { type: 'string' },
      system: { type: 'string' },
      tools: { type: 'array', items: { type: 'string' } },
      capabilities: { type: 'array', items: { type: 'string' } },
      canDelegateTo: { type: 'array', items: { type: 'string' } },
      personality: { type: 'string' },
      model: { type: 'string' },
      provider: { type: 'string', enum: ['claude-cli', 'codex'] },
    },
    required: ['name'],
  },
  async execute(args, db) {
    const guard = assertCallerCanCall('update_agent');
    if (!guard.ok) return { error: guard.error };

    const name = args.name as string;
    const target = await db.collection('agents').findOne({ name });
    if (!target) return { error: `Agent "${name}" not found` };
    if (target.isBuiltIn) {
      return { error: `Agent "${name}" is built-in and cannot be modified` };
    }

    // Build updates object
    const allowedKeys = ['displayName', 'system', 'tools', 'capabilities', 'canDelegateTo', 'personality', 'model', 'provider'];
    const updates: Record<string, unknown> = {};
    for (const key of allowedKeys) {
      if (args[key] !== undefined) updates[key] = args[key];
    }

    // agent-builder-agent constraint: can ONLY touch canDelegateTo
    if (guard.caller === 'agent-builder-agent') {
      const violatingKeys = Object.keys(updates).filter((k) => k !== 'canDelegateTo');
      if (violatingKeys.length > 0) {
        return {
          error: `agent-builder-agent can only update canDelegateTo. Refused fields: ${violatingKeys.join(', ')}. Use team-builder-agent for broader changes.`,
        };
      }
    }

    if (Object.keys(updates).length === 0) {
      return { error: 'No valid fields to update' };
    }

    updates.updatedAt = new Date();
    await db.collection('agents').updateOne({ name }, { $set: updates });

    return { success: true, name, updated: Object.keys(updates).filter((k) => k !== 'updatedAt') };
  },
};

const deleteAgentTool: ChatTool = {
  name: 'delete_agent',
  description: 'Delete an agent. Both builders can call this. Refuses to delete built-in agents. Requires confirm=true. If the agent is a team lead, the team becomes leaderless and must have a new lead assigned (or the team should be deleted).',
  destructive: true,
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Agent slug to delete' },
      confirm: { type: 'boolean', description: 'Must be true to actually delete' },
    },
    required: ['name', 'confirm'],
  },
  async execute(args, db) {
    const guard = assertCallerCanCall('delete_agent');
    if (!guard.ok) return { error: guard.error };

    if (!isConfirmed(args.confirm)) {
      return { error: 'delete_agent requires confirm=true (boolean). Confirm with the user first.' };
    }

    const name = args.name as string;
    const target = await db.collection('agents').findOne({ name });
    if (!target) return { error: `Agent "${name}" not found` };

    // Check 1: built-in agents are never deletable. Catches built-in leads
    // before the lead check below ever runs.
    if (target.isBuiltIn) {
      return { error: `Agent "${name}" is built-in and cannot be deleted` };
    }

    // Check 2 (independent): refuse to leave a non-built-in team leaderless.
    // Built-in teams are protected by Check 1 above (their leads are always
    // built-in), so we only worry about user-created teams here.
    if (target.teamRole === 'lead' && target.teamName) {
      const team = await db.collection('teams').findOne({ name: target.teamName });
      if (team && !team.isBuiltIn) {
        return {
          error: `Cannot delete "${name}" — they are the lead of team "${target.teamName}". Either assign a new lead first (via update_agent on a different member), or delete the team via delete_team.`,
        };
      }
    }

    await db.collection('agents').deleteOne({ name });
    return { success: true, deleted: name };
  },
};

// ── Workflow management tools (workflow-builder-agent only) ──────────────────
//
// These let the workflow-builder-agent persist agent-designed workflows
// directly to the database. The DB is the source of truth for both the
// editor and the executor — workflows created here are usable immediately
// without a restart and without writing a YAML seed file.
//
// Workflows are created with createdBy="workflow-builder" so the YAML
// seed loop never overwrites them.

function parseWorkflowInput(args: Record<string, unknown>): { yaml?: string; parsed?: WorkflowDef; error?: string } {
  const rawYaml = args.yaml as string | undefined;
  const rawParsed = args.parsed;
  if (!rawYaml && !rawParsed) {
    return { error: 'Provide either `yaml` (string) or `parsed` (object).' };
  }
  if (rawYaml) {
    try {
      const parsed = yaml.load(rawYaml) as WorkflowDef;
      if (!parsed || typeof parsed !== 'object' || !parsed.name) {
        return { error: 'YAML did not parse into a workflow object with a `name` field.' };
      }
      return { yaml: rawYaml, parsed };
    } catch (err) {
      return { error: `Invalid YAML: ${(err as Error).message}` };
    }
  }
  // parsed object branch
  if (typeof rawParsed !== 'object' || rawParsed === null || !(rawParsed as WorkflowDef).name) {
    return { error: '`parsed` must be an object with at least a `name` field.' };
  }
  return { parsed: rawParsed as WorkflowDef };
}

const validateWorkflowTool: ChatTool = {
  name: 'validate_workflow',
  description: 'Validate a workflow definition (YAML or parsed object) against the live agent registry and built-ins. Returns { valid, errors, warnings }. No permission required — read-only check.',
  inputSchema: {
    type: 'object',
    properties: {
      yaml: { type: 'string', description: 'YAML source of the workflow' },
      parsed: { type: 'object', description: 'Parsed workflow object (alternative to yaml)' },
    },
  },
  async execute(args, db) {
    const input = parseWorkflowInput(args);
    if (input.error) return { error: input.error };
    try {
      const result = await new WorkflowService(db).validate(input.parsed!);
      return { ...result };
    } catch (err) {
      return { error: (err as Error).message };
    }
  },
};

const createWorkflowTool: ChatTool = {
  name: 'create_workflow',
  description: 'Persist a new workflow to the database. ONLY workflow-builder-agent can call this. Validates first; returns the validation result inline so the caller can read errors and retry. Created workflows are usable immediately by the editor and executor — no restart needed. Stored with createdBy="workflow-builder" so the YAML seed loop will not touch them.',
  destructive: true,
  inputSchema: {
    type: 'object',
    properties: {
      yaml: { type: 'string', description: 'Full YAML source of the workflow (preferred)' },
      parsed: { type: 'object', description: 'Parsed workflow object (alternative to yaml)' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
    },
  },
  async execute(args, db) {
    const guard = assertCallerCanCall('create_workflow');
    if (!guard.ok) return { error: guard.error };

    const input = parseWorkflowInput(args);
    if (input.error) return { error: input.error };

    try {
      const created = await new WorkflowService(db).create({
        yaml: input.yaml,
        parsed: input.parsed,
        createdBy: 'workflow-builder',
        tags: (args.tags as string[]) ?? ['agent-built'],
      });
      return {
        success: true,
        workflow: {
          _id: String(created._id),
          name: created.name,
          version: created.version,
          validation: created.validation,
        },
      };
    } catch (err) {
      return { error: (err as Error).message };
    }
  },
};

const updateWorkflowTool: ChatTool = {
  name: 'update_workflow',
  description: 'Update an existing workflow by id (or by name if id is omitted). ONLY workflow-builder-agent can call this. Bumps version. Refuses to touch workflows with createdBy="system" — those are managed by the YAML seed loop.',
  destructive: true,
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Workflow MongoDB ObjectId' },
      name: { type: 'string', description: 'Workflow name (used when id is omitted)' },
      yaml: { type: 'string', description: 'New YAML source' },
      parsed: { type: 'object', description: 'New parsed workflow object (alternative to yaml)' },
    },
  },
  async execute(args, db) {
    const guard = assertCallerCanCall('update_workflow');
    if (!guard.ok) return { error: guard.error };

    const input = parseWorkflowInput(args);
    if (input.error) return { error: input.error };

    const service = new WorkflowService(db);
    let id = args.id as string | undefined;
    if (!id && args.name) {
      const existing = await service.getByName(args.name as string);
      if (!existing) return { error: `Workflow "${args.name}" not found` };
      id = String(existing._id);
    }
    if (!id) return { error: 'Provide either `id` or `name` to identify the workflow.' };

    const existing = await service.getById(id);
    if (!existing) return { error: `Workflow ${id} not found` };
    if (existing.createdBy === 'system') {
      return { error: `Workflow "${existing.name}" is system-seeded and managed by the YAML seed loop. Edit the YAML file or save it under a new name.` };
    }

    try {
      const updated = await service.update(id, { yaml: input.yaml, parsed: input.parsed });
      return {
        success: true,
        workflow: {
          _id: String(updated._id ?? id),
          name: updated.name,
          version: updated.version,
          validation: updated.validation,
        },
      };
    } catch (err) {
      return { error: (err as Error).message };
    }
  },
};

// ── Self-introspection tools (any agent can call) ────────────────────────────
//
// These let a running agent inspect its own context — what the user originally
// asked for, what tools the agent has called so far, and what those tools
// returned. Critical for self-diagnosis when something goes wrong: the agent
// can re-read the user's request, see prior tool results, and figure out what
// to do next instead of guessing.
//
// No permission gating — any agent can read its own session/conversation.

const getMySessionHistory: ChatTool = {
  name: 'get_my_session_history',
  description: `Return the message history of the top-level chat session you are running in. Use this to:
- Re-read the user's original request when you have been working for a while
- See your prior assistant responses and tool calls
- Self-diagnose when you're confused about what the user wanted

Returns up to 'limit' messages (default 30). Each message has role, content (truncated to 2000 chars), and toolCalls (with summarized results). The messages are sorted oldest-first.`,
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Max messages to return (default: 30, max: 100)' },
    },
  },
  async execute(args, db) {
    const ctx = getAnyActiveSession();
    if (!ctx?.chatSessionId) {
      return { error: 'No active chat session context — this tool only works inside an agent run' };
    }
    const limit = Math.min((args.limit as number) ?? 30, 100);
    const messages = await db
      .collection('chat_messages')
      .find({ sessionId: ctx.chatSessionId })
      .sort({ createdAt: 1 })
      .limit(limit)
      .toArray();
    return {
      sessionId: ctx.chatSessionId,
      currentAgent: ctx.currentAgent ?? 'assistant',
      delegationDepth: ctx.delegationDepth,
      messageCount: messages.length,
      messages: messages.map((m: any) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content.slice(0, 2000) : '',
        status: m.status,
        toolCalls: ((m.toolCalls as any[]) ?? []).map((tc: any) => {
          const result = tc.result;
          let resultSummary: string;
          if (result == null) resultSummary = '(empty)';
          else if (typeof result === 'string') resultSummary = result.slice(0, 200);
          else {
            try { resultSummary = JSON.stringify(result).slice(0, 200); }
            catch { resultSummary = '(unserializable)'; }
          }
          return { tool: tc.tool, result_summary: resultSummary };
        }),
        createdAt: m.createdAt,
      })),
    };
  },
};

const getMyDelegationThread: ChatTool = {
  name: 'get_my_delegation_thread',
  description: `Return the messages and tool results in your current delegation thread — the multi-turn conversation between you and the agent that delegated to you. Use this when:
- You have been called multiple times in the same conversation and want to see your prior responses
- You're partway through a complex task and need to remember what you've already done
- A user asked for clarification and you want to re-read your prior turns

Returns the conversation metadata (caller, task, status, depth) and the full message log including tool calls. Only useful for delegated agents — returns an error if called from a top-level chat.`,
  inputSchema: { type: 'object', properties: {} },
  async execute(_args, db) {
    const ctx = getAnyActiveSession();
    if (!ctx?.currentConversationId) {
      return { error: 'No active delegation conversation — this tool only works for delegated agents (not top-level chat)' };
    }
    const { ObjectId } = await import('mongodb');
    let conv: any;
    try {
      conv = await db.collection('agent_conversations').findOne({ _id: new ObjectId(ctx.currentConversationId) });
    } catch {
      return { error: `Invalid conversation ID: ${ctx.currentConversationId}` };
    }
    if (!conv) return { error: `Delegation conversation ${ctx.currentConversationId} not found` };

    return {
      conversationId: ctx.currentConversationId,
      fromAgent: conv.fromAgent,
      toAgent: conv.toAgent,
      task: conv.task,
      depth: conv.depth,
      status: conv.status,
      turnCount: conv.turnCount,
      costUsd: conv.costUsd,
      messages: ((conv.messages as any[]) ?? []).map((m: any) => ({
        agent: m.agent,
        type: m.type,
        content: typeof m.content === 'string' ? m.content.slice(0, 2000) : '',
        toolCalls: ((m.toolCalls as any[]) ?? []).map((tc: any) => {
          const result = tc.result;
          let resultSummary: string;
          if (result == null) resultSummary = '(empty)';
          else if (typeof result === 'string') resultSummary = result.slice(0, 300);
          else {
            try { resultSummary = JSON.stringify(result).slice(0, 300); }
            catch { resultSummary = '(unserializable)'; }
          }
          return { tool: tc.tool, result_summary: resultSummary };
        }),
        timestamp: m.timestamp,
      })),
    };
  },
};

// ── Export the meta tool list ────────────────────────────────────────────────

export const metaChatTools: ChatTool[] = [
  // Read-only
  listTeamsTool,
  listTeamMembersTool,
  getTeamBlueprintTool,
  // Self-introspection (any agent)
  getMySessionHistory,
  getMyDelegationThread,
  // Team management (team-builder only)
  createTeamTool,
  updateTeamTool,
  deleteTeamTool,
  // Agent management (either builder)
  createAgentTool,
  updateAgentTool,
  deleteAgentTool,
  // Workflow management (workflow-builder only)
  validateWorkflowTool,
  createWorkflowTool,
  updateWorkflowTool,
];

/** Tool names that are destructive — added to the global DESTRUCTIVE_TOOLS set. */
export const META_DESTRUCTIVE_TOOLS = [
  'create_team',
  'update_team',
  'delete_team',
  'create_agent',
  'update_agent',
  'delete_agent',
  'create_workflow',
  'update_workflow',
];
