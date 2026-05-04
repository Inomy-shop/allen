/**
 * Team Service
 *
 * Manages the `teams` collection — explicit groupings of agents that mirror an
 * organizational structure. Every agent belongs to exactly one team. Teams form
 * a tree via `parentTeamName`. Each team has exactly one lead agent (the only
 * member with cross-team reach).
 *
 * Phase 1 of the team architecture — pure data layer, no behavior change.
 * Isolation enforcement comes in phase 2, UI in phase 3, chat tools in phase 4.
 */

import type { Db } from 'mongodb';
import { ObjectId } from 'mongodb';

// ── Types ──

export interface Team {
  _id?: ObjectId;
  name: string;                 // unique slug, e.g. "engineering"
  displayName: string;          // "Engineering Team"
  description: string;          // 1-2 sentence summary
  mission?: string;             // longer mission, used in agent system prompts
  leadAgentName: string;        // foreign key → agents.name; the team lead
  parentTeamName?: string;      // null for top-level (Executive); set for sub-teams
  isBuiltIn: boolean;           // true for seed teams, false for user-created
  createdBy?: 'seed' | 'user' | 'team-builder';
  createdAt: Date;
  updatedAt: Date;
}

export type TeamInput = Omit<Team, '_id' | 'createdAt' | 'updatedAt' | 'isBuiltIn' | 'createdBy'>;

// ── Service ──

export class TeamService {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  private get collection() {
    return this.db.collection<Team>('teams');
  }

  async list(): Promise<Team[]> {
    return this.collection.find({}).sort({ name: 1 }).toArray();
  }

  async getByName(name: string): Promise<Team | null> {
    return this.collection.findOne({ name });
  }

  async getById(id: string): Promise<Team | null> {
    return this.collection.findOne({ _id: new ObjectId(id) });
  }

  async create(
    input: TeamInput,
    opts: { isBuiltIn?: boolean; createdBy?: Team['createdBy'] } = {},
  ): Promise<Team> {
    const now = new Date();
    const doc: Team = {
      ...input,
      isBuiltIn: opts.isBuiltIn ?? false,
      createdBy: opts.createdBy ?? 'user',
      createdAt: now,
      updatedAt: now,
    };
    const result = await this.collection.insertOne(doc);
    return { ...doc, _id: result.insertedId };
  }

  async update(name: string, updates: Partial<TeamInput>): Promise<Team | null> {
    const team = await this.getByName(name);
    if (!team) return null;
    if (team.isBuiltIn) {
      throw new Error(`Team "${name}" is built-in and cannot be modified`);
    }
    await this.collection.updateOne(
      { name },
      { $set: { ...updates, updatedAt: new Date() } },
    );
    return this.getByName(name);
  }

  /**
   * Delete a team. Refuses if the team has any agents (must move/delete them first).
   * Refuses to delete built-in teams.
   */
  async delete(name: string): Promise<void> {
    const team = await this.getByName(name);
    if (!team) throw new Error(`Team "${name}" not found`);
    if (team.isBuiltIn) {
      throw new Error(`Team "${name}" is built-in and cannot be deleted`);
    }
    const memberCount = await this.db.collection('agents').countDocuments({ teamName: name });
    if (memberCount > 0) {
      throw new Error(
        `Team "${name}" still has ${memberCount} agent(s). Delete or move them first.`,
      );
    }
    await this.collection.deleteOne({ name });
  }

  /**
   * List all agents in a team. Returns the lead first, then members alphabetically.
   */
  async listMembers(teamName: string): Promise<Array<Record<string, unknown>>> {
    const agents = await this.db
      .collection('agents')
      .find({ teamName })
      .toArray();
    // Lead first, then alphabetical
    return agents.sort((a, b) => {
      if (a.teamRole === 'lead') return -1;
      if (b.teamRole === 'lead') return 1;
      return (a.name as string).localeCompare(b.name as string);
    });
  }

  /**
   * Return a team's full blueprint: the team document + all its members + its
   * delegation edges. Used by the agent-builder/team-builder for context, and
   * by the UI for the org chart.
   */
  async getBlueprint(teamName: string): Promise<{
    team: Team;
    agents: Array<Record<string, unknown>>;
    delegationEdges: Array<{ from: string; to: string }>;
  } | null> {
    const team = await this.getByName(teamName);
    if (!team) return null;
    const agents = await this.listMembers(teamName);
    const edges: Array<{ from: string; to: string }> = [];
    for (const a of agents) {
      const targets = (a.canDelegateTo as string[] | undefined) ?? [];
      for (const t of targets) edges.push({ from: a.name as string, to: t });
    }
    return { team, agents, delegationEdges: edges };
  }

  /**
   * Promote an existing agent to be the lead of a team. Sets `teamName` and
   * `teamRole: 'lead'` on the agent. Refuses cross-team moves: if the agent
   * already belongs to a DIFFERENT team, throws an error.
   *
   * Used by both `chat-tools-meta.ts:create_team` and `routes/team.routes.ts:POST`
   * so the two paths converge on the same lead-promotion semantics.
   */
  async promoteToLead(agentName: string, teamName: string): Promise<void> {
    const agents = this.db.collection('agents');
    const lead = await agents.findOne({ name: agentName });
    if (!lead) throw new Error(`Lead agent "${agentName}" not found`);

    const currentTeam = lead.teamName as string | undefined;
    // Allow moves FROM 'unassigned' — it's a holding pen for imported
    // agents, not a real team assignment. Without this, creating a new
    // team with an imported agent as lead is impossible (circular:
    // team creation needs the lead, but the lead is "in a team").
    if (currentTeam && currentTeam !== teamName && currentTeam !== 'unassigned') {
      throw new Error(
        `Agent "${agentName}" is already a member of team "${currentTeam}". ` +
          `Cross-team agent moves are not allowed — pick a different lead, or delete the agent and recreate it under "${teamName}".`,
      );
    }

    await agents.updateOne(
      { name: agentName },
      { $set: { teamName, teamRole: 'lead', updatedAt: new Date() } },
    );
  }

  // ── Phase 2: Team isolation rules ──

  /**
   * Returns true if `caller` is allowed to delegate to `target` under the team
   * isolation rules. Both arguments are agent names.
   *
   * Rules (per the architecture plan):
   *   1. Same team — always allowed.
   *   2. Lead-to-lead — always allowed (any team lead can reach any other team lead).
   *   3. Worker-to-own-lead — always allowed (escalation never blocked).
   *   4. Lead delegating UP to parent team's lead — allowed (lead-to-lead, covered by rule 2).
   *   5. Anything else (worker-to-foreign-anything, lead-to-foreign-worker) — DENIED.
   *
   * Returns { allowed, reason } so callers can surface a clear error.
   */
  async canDelegate(
    callerName: string,
    targetName: string,
  ): Promise<{ allowed: boolean; reason?: string; hint?: string }> {
    const agents = this.db.collection('agents');
    const [caller, target] = await Promise.all([
      agents.findOne({ name: callerName }),
      agents.findOne({ name: targetName }),
    ]);

    if (!caller) return { allowed: false, reason: `Caller agent "${callerName}" not found` };
    if (!target) return { allowed: false, reason: `Target agent "${targetName}" not found` };

    const callerTeam = caller.teamName as string | undefined;
    const targetTeam = target.teamName as string | undefined;
    const callerRole = caller.teamRole as 'lead' | 'member' | undefined;
    const targetRole = target.teamRole as 'lead' | 'member' | undefined;

    // Backwards-compat: only allow if BOTH sides have no team membership.
    // That's the legitimate "this DB predates the teams migration" case.
    // If only one side has a team, that's anomalous (e.g. a custom agent
    // someone created without going through the team-builder) and we err
    // on the side of blocking — better a clear error than a silent bypass.
    if (!callerTeam && !targetTeam) {
      return { allowed: true };
    }
    if (!callerTeam || !targetTeam) {
      return {
        allowed: false,
        reason: `One side has no team membership (caller=${callerTeam ?? 'none'}, target=${targetTeam ?? 'none'}) — cross-boundary delegation blocked`,
        hint: 'Assign both agents to a team before delegating, or use the team-builder to create them properly.',
      };
    }

    // Rule 1: same team
    if (callerTeam === targetTeam) return { allowed: true };

    // Rule 2: lead-to-lead (cross-team coordination)
    if (callerRole === 'lead' && targetRole === 'lead') return { allowed: true };

    // Otherwise: blocked. Build a helpful hint.
    const callerTeamObj = await this.getByName(callerTeam);
    const callerLead = callerTeamObj?.leadAgentName;
    let hint: string;
    if (callerRole === 'member' && callerLead && callerLead !== callerName) {
      // Worker trying to reach foreign team — must escalate to own lead
      hint = `As a member of "${callerTeam}", route this through your team lead "${callerLead}", who can delegate cross-team.`;
    } else if (callerRole === 'lead' && targetRole === 'member') {
      // Lead trying to reach a foreign worker — go through that team's lead
      const targetTeamObj = await this.getByName(targetTeam);
      const targetLead = targetTeamObj?.leadAgentName;
      hint = targetLead
        ? `As a team lead, delegate to the "${targetTeam}" lead "${targetLead}" instead, who will route it to "${targetName}".`
        : `Delegate to the "${targetTeam}" team lead instead.`;
    } else {
      hint = `Cross-team delegation must go through team leads.`;
    }

    return {
      allowed: false,
      reason: `"${callerName}" (${callerTeam}/${callerRole ?? 'unknown'}) cannot delegate directly to "${targetName}" (${targetTeam}/${targetRole ?? 'unknown'})`,
      hint,
    };
  }
}
