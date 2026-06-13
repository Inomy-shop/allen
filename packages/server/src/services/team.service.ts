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
import { notDeletedFilter, softDeleteSet, restoreSet } from './soft-delete.js';

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
    return this.collection.find(notDeletedFilter).sort({ name: 1 }).toArray();
  }

  async getByName(name: string): Promise<Team | null> {
    return this.collection.findOne({ name, ...notDeletedFilter });
  }

  async getById(id: string): Promise<Team | null> {
    return this.collection.findOne({ _id: new ObjectId(id), ...notDeletedFilter });
  }

  async create(
    input: TeamInput,
    opts: { isBuiltIn?: boolean; createdBy?: Team['createdBy'] } = {},
  ): Promise<Team & { restored?: boolean }> {
    const now = new Date();

    // Check for soft-deleted record with the same name — restore instead of insert
    const deleted = await this.collection.findOne({ name: input.name, isDeleted: true });
    if (deleted) {
      const payload = {
        ...input,
        isBuiltIn: opts.isBuiltIn ?? false,
        createdBy: opts.createdBy ?? 'user',
      };
      await this.collection.updateOne({ name: input.name }, restoreSet(payload as unknown as Record<string, unknown>));
      const restored = await this.collection.findOne({ name: input.name, ...notDeletedFilter });
      if (restored) return { ...restored, restored: true };
    }

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
    await this.collection.updateOne({ name }, softDeleteSet());
  }

  /**
   * List all agents in a team. Returns the lead first, then members alphabetically.
   */
  async listMembers(teamName: string): Promise<Array<Record<string, unknown>>> {
    const agents = await this.db
      .collection('agents')
      .find({ teamName, ...notDeletedFilter })
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
   * spawn-target edges. Used by the agent-builder/team-builder for context,
   * and by the UI for the org chart.
   */
  async getBlueprint(teamName: string): Promise<{
    team: Team;
    agents: Array<Record<string, unknown>>;
    spawnTargetEdges: Array<{ from: string; to: string }>;
  } | null> {
    const team = await this.getByName(teamName);
    if (!team) return null;
    const agents = await this.listMembers(teamName);
    const edges: Array<{ from: string; to: string }> = [];
    for (const a of agents) {
      const targets = (a.spawnTargets as string[] | undefined) ?? [];
      for (const t of targets) edges.push({ from: a.name as string, to: t });
    }
    return { team, agents, spawnTargetEdges: edges };
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
    const lead = await agents.findOne({ name: agentName, ...notDeletedFilter });
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

}
