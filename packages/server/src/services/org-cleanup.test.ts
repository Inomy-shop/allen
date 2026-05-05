import { describe, it, expect, beforeEach } from 'vitest';
import { cleanupOrphanedSeedEntities } from './org-cleanup.js';

/**
 * In-memory Db mock that supports the ops used by cleanupOrphanedSeedEntities:
 *   db.collection(name).find(filter).toArray()
 *   db.collection(name).deleteOne({ _id })
 *
 * Filters supported: $nin, $ne, $exists, $or, plain equality.
 */
function matches(doc: any, filter: any): boolean {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === '$or') {
      if (!(cond as any[]).some((sub) => matches(doc, sub))) return false;
      continue;
    }
    const val = doc[key];
    if (cond === null || typeof cond !== 'object') {
      if (val !== cond) return false;
      continue;
    }
    const c = cond as any;
    if ('$nin' in c && (c.$nin as any[]).includes(val)) return false;
    if ('$ne' in c && val === c.$ne) return false;
    if ('$exists' in c) {
      const present = key in doc && doc[key] !== undefined;
      if (present !== c.$exists) return false;
    }
  }
  return true;
}

function mockDb(data: {
  agents: any[];
  teams: any[];
  workflows: any[];
}): any {
  let nextId = 1;
  // Assign ids to any doc missing one
  for (const c of ['agents', 'teams', 'workflows'] as const) {
    data[c] = data[c].map((d) => ({ _id: d._id ?? nextId++, ...d }));
  }
  return {
    collection: (name: 'agents' | 'teams' | 'workflows') => ({
      find: (filter: any) => ({
        toArray: async () => data[name].filter((d) => matches(d, filter)),
      }),
      deleteOne: async (q: { _id: unknown }) => {
        const idx = data[name].findIndex((d) => d._id === q._id);
        if (idx >= 0) data[name].splice(idx, 1);
        return { deletedCount: idx >= 0 ? 1 : 0 };
      },
    }),
    // Expose for assertions
    __data: data,
  };
}

describe('cleanupOrphanedSeedEntities', () => {
  let db: any;

  beforeEach(() => {
    db = mockDb({
      agents: [
        // Meta team — MUST never be deleted
        { name: 'team-builder-agent', teamName: 'meta', createdBy: 'seed' },
        { name: 'agent-builder-agent', teamName: 'meta', createdBy: 'seed' },
        { name: 'research-agent', teamName: 'meta', createdBy: 'seed' },
        // Non-meta agents in the current seed — kept
        { name: 'ceo', teamName: 'executive', createdBy: 'seed' },
        { name: 'engineering-lead', teamName: 'engineering', createdBy: 'seed' },
        // Orphaned seed agents from a prior seed — must be deleted
        { name: 'backend-lead', teamName: 'backend', createdBy: 'seed' },
        { name: 'frontend-lead', teamName: 'frontend', createdBy: 'seed' },
        { name: 'security-lead', teamName: 'security', createdBy: 'seed' },
        // User-created agent — must NOT be deleted
        { name: 'custom-helper', teamName: 'engineering', createdBy: 'user' },
      ],
      teams: [
        { name: 'meta', isBuiltIn: true },
        { name: 'executive', isBuiltIn: true },
        { name: 'engineering', isBuiltIn: true },
        { name: 'backend', isBuiltIn: true },
        { name: 'frontend', isBuiltIn: true },
        { name: 'security', isBuiltIn: true },
        // User-created team — must NOT be deleted
        { name: 'my-custom-team', isBuiltIn: false },
      ],
      workflows: [
        { name: 'coding-workflow', createdBy: 'system' },
        { name: 'bug-investigate-and-fix', createdBy: 'system' },
        { name: 'feature-development', createdBy: 'system' }, // orphan
        { name: 'quick-bugfix', createdBy: 'system' }, // orphan
        { name: 'my-custom-workflow', createdBy: 'user' }, // must NOT be deleted
      ],
    });
  });

  it('deletes orphaned seed agents not in keepAgents', async () => {
    const result = await cleanupOrphanedSeedEntities(
      db,
      ['meta', 'executive', 'engineering'],
      ['team-builder-agent', 'agent-builder-agent', 'research-agent', 'ceo', 'engineering-lead'],
      ['bug-investigate-and-fix'],
    );
    expect(result.agentsDeleted).toBe(3); // backend-lead, frontend-lead, security-lead
    expect(result.deletedAgentNames).toEqual(
      expect.arrayContaining(['backend-lead', 'frontend-lead', 'security-lead']),
    );
    const remaining = db.__data.agents.map((a: any) => a.name);
    expect(remaining).not.toContain('backend-lead');
    expect(remaining).not.toContain('frontend-lead');
    expect(remaining).not.toContain('security-lead');
  });

  it('NEVER deletes meta team agents even if they are missing from keepAgents', async () => {
    // Caller forgot to list meta agents in keepAgents — they must still survive.
    const result = await cleanupOrphanedSeedEntities(
      db,
      ['executive', 'engineering'], // NO 'meta'
      ['ceo', 'engineering-lead'],   // NO meta agents
      ['bug-investigate-and-fix'],
    );
    const remaining = db.__data.agents.map((a: any) => a.name);
    expect(remaining).toContain('team-builder-agent');
    expect(remaining).toContain('agent-builder-agent');
    expect(remaining).toContain('research-agent');
    // The non-meta agents also shouldn't have been protected — orphaned ones get cleaned.
    expect(result.agentsDeleted).toBeGreaterThan(0);
  });

  it('NEVER deletes the meta team itself even if it is not in keepTeams', async () => {
    await cleanupOrphanedSeedEntities(
      db,
      ['executive', 'engineering'], // NO 'meta'
      ['ceo', 'engineering-lead', 'team-builder-agent', 'agent-builder-agent', 'research-agent'],
      ['bug-investigate-and-fix'],
    );
    const remainingTeams = db.__data.teams.map((t: any) => t.name);
    expect(remainingTeams).toContain('meta');
  });

  it('deletes orphaned seed teams not in keepTeams', async () => {
    const result = await cleanupOrphanedSeedEntities(
      db,
      ['meta', 'executive', 'engineering'],
      ['team-builder-agent', 'agent-builder-agent', 'research-agent', 'ceo', 'engineering-lead'],
      ['bug-investigate-and-fix'],
    );
    expect(result.teamsDeleted).toBe(3); // backend, frontend, security
    expect(result.deletedTeamNames).toEqual(
      expect.arrayContaining(['backend', 'frontend', 'security']),
    );
  });

  it('does NOT delete user-created agents (createdBy: user)', async () => {
    await cleanupOrphanedSeedEntities(
      db,
      ['meta', 'executive', 'engineering'],
      ['team-builder-agent', 'agent-builder-agent', 'research-agent', 'ceo', 'engineering-lead'],
      ['bug-investigate-and-fix'],
    );
    const remaining = db.__data.agents.map((a: any) => a.name);
    expect(remaining).toContain('custom-helper');
  });

  it('does NOT delete user-created teams (isBuiltIn: false)', async () => {
    await cleanupOrphanedSeedEntities(
      db,
      ['meta', 'executive', 'engineering'],
      ['team-builder-agent', 'agent-builder-agent', 'research-agent', 'ceo', 'engineering-lead'],
      ['bug-investigate-and-fix'],
    );
    const remainingTeams = db.__data.teams.map((t: any) => t.name);
    expect(remainingTeams).toContain('my-custom-team');
  });

  it('deletes orphaned seed workflows but preserves user workflows', async () => {
    const result = await cleanupOrphanedSeedEntities(
      db,
      ['meta', 'executive', 'engineering'],
      ['team-builder-agent', 'agent-builder-agent', 'research-agent', 'ceo', 'engineering-lead'],
      ['bug-investigate-and-fix'],
    );
    expect(result.workflowsDeleted).toBe(3); // coding-workflow, feature-development, quick-bugfix
    const remaining = db.__data.workflows.map((w: any) => w.name);
    expect(remaining).toContain('bug-investigate-and-fix');
    expect(remaining).toContain('my-custom-workflow');
    expect(remaining).not.toContain('coding-workflow');
    expect(remaining).not.toContain('feature-development');
    expect(remaining).not.toContain('quick-bugfix');
  });

  it('returns zero counts when nothing is orphaned', async () => {
    // Fresh db with only the current seed — nothing should be deleted.
    const cleanDb = mockDb({
      agents: [
        { name: 'team-builder-agent', teamName: 'meta', createdBy: 'seed' },
        { name: 'ceo', teamName: 'executive', createdBy: 'seed' },
      ],
      teams: [
        { name: 'meta', isBuiltIn: true },
        { name: 'executive', isBuiltIn: true },
      ],
      workflows: [{ name: 'bug-investigate-and-fix', createdBy: 'system' }],
    });
    const result = await cleanupOrphanedSeedEntities(
      cleanDb,
      ['meta', 'executive'],
      ['team-builder-agent', 'ceo'],
      ['bug-investigate-and-fix'],
    );
    expect(result.agentsDeleted).toBe(0);
    expect(result.teamsDeleted).toBe(0);
    expect(result.workflowsDeleted).toBe(0);
  });
});
