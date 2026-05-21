/**
 * Org Cleanup — removes seed teams, agents, and workflows that are no longer
 * in the current seed definition.
 *
 * Called only when SEED_OVERRIDE=true, AFTER `OrgSeedService.seed()` creates or
 * updates the current set of teams and agents. Any seed entity not in the
 * `keep` lists is hard-deleted.
 *
 * CRITICAL SAFETY RULES:
 * - The meta team and every agent inside it are NEVER deleted, even if the
 *   caller forgets to list them in keepAgents/keepTeams.
 * - User-created entities (createdBy !== 'seed' / !== 'system') are NEVER
 *   touched, even if they share a name with a deleted seed entry.
 */

import type { Db } from 'mongodb';

const PROTECTED_TEAM = 'meta';

export interface CleanupResult {
  teamsDeleted: number;
  agentsDeleted: number;
  workflowsDeleted: number;
  deletedTeamNames: string[];
  deletedAgentNames: string[];
  deletedWorkflowNames: string[];
}

export async function cleanupOrphanedSeedEntities(
  db: Db,
  keepTeams: string[],
  keepAgents: string[],
  keepWorkflows: string[],
): Promise<CleanupResult> {
  const result: CleanupResult = {
    teamsDeleted: 0,
    agentsDeleted: 0,
    workflowsDeleted: 0,
    deletedTeamNames: [],
    deletedAgentNames: [],
    deletedWorkflowNames: [],
  };

  // ── 1. Delete orphaned seed agents ──
  //    NOT in keepAgents AND NOT in meta team AND seeded by system
  const agents = db.collection('agents');
  const agentsToDelete = await agents
    .find({
      name: { $nin: keepAgents },
      teamName: { $ne: PROTECTED_TEAM },
      $or: [{ createdBy: 'seed' }, { createdBy: { $exists: false } }],
    })
    .toArray();

  for (const a of agentsToDelete) {
    await agents.deleteOne({ _id: a._id });
    console.log(`[org-cleanup] Deleted agent: ${a.name} (team=${a.teamName})`);
    result.agentsDeleted++;
    result.deletedAgentNames.push(a.name as string);
  }

  // ── 2. Delete orphaned seed teams ──
  //    NOT in keepTeams AND NOT meta AND built-in
  const teams = db.collection('teams');
  const teamsToDelete = await teams
    .find({
      name: { $nin: [...keepTeams, PROTECTED_TEAM] },
      isBuiltIn: true,
    })
    .toArray();

  for (const t of teamsToDelete) {
    await teams.deleteOne({ _id: t._id });
    console.log(`[org-cleanup] Deleted team: ${t.name}`);
    result.teamsDeleted++;
    result.deletedTeamNames.push(t.name as string);
  }

  // ── 3. Delete orphaned seed workflows ──
  //    NOT in keepWorkflows AND createdBy: 'system'
  const workflows = db.collection('workflows');
  const workflowsToDelete = await workflows
    .find({
      name: { $nin: keepWorkflows },
      createdBy: 'system',
    })
    .toArray();

  for (const w of workflowsToDelete) {
    await workflows.deleteOne({ _id: w._id });
    console.log(`[org-cleanup] Deleted workflow: ${w.name}`);
    result.workflowsDeleted++;
    result.deletedWorkflowNames.push(w.name as string);
  }

  if (result.teamsDeleted + result.agentsDeleted + result.workflowsDeleted > 0) {
    console.log(
      `[org-cleanup] Removed ${result.teamsDeleted} teams, ${result.agentsDeleted} agents, ${result.workflowsDeleted} workflows`,
    );
  }

  return result;
}
