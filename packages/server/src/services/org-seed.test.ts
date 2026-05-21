import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OrgSeedService } from './org-seed.js';

function makeDb(seed: Record<string, Record<string, unknown>[]> = {}): any {
  const store: Record<string, Record<string, unknown>[]> = {
    agents: [],
    teams: [],
    ...seed,
  };

  function matches(doc: Record<string, unknown>, query: Record<string, unknown>): boolean {
    return Object.entries(query).every(([key, value]) => doc[key] === value);
  }

  return {
    store,
    collection: (name: string) => ({
      findOne: async (query: Record<string, unknown>) =>
        (store[name] ?? []).find((doc) => matches(doc, query)) ?? null,
      insertOne: async (doc: Record<string, unknown>) => {
        (store[name] = store[name] ?? []).push({ _id: `${name}-${store[name].length}`, ...doc });
        return { insertedId: `${name}-${store[name].length - 1}` };
      },
      updateOne: async (query: Record<string, unknown>, update: Record<string, unknown>) => {
        const idx = (store[name] ?? []).findIndex((doc) => matches(doc, query));
        if (idx >= 0 && (update as any).$set) {
          store[name][idx] = { ...store[name][idx], ...(update as any).$set };
        }
        return { matchedCount: idx >= 0 ? 1 : 0, modifiedCount: idx >= 0 ? 1 : 0 };
      },
    }),
  };
}

describe('OrgSeedService SEED_OVERRIDE policy', () => {
  const originalSeedOverride = process.env.SEED_OVERRIDE;

  beforeEach(() => {
    delete process.env.SEED_OVERRIDE;
  });

  afterEach(() => {
    if (originalSeedOverride === undefined) delete process.env.SEED_OVERRIDE;
    else process.env.SEED_OVERRIDE = originalSeedOverride;
  });

  it('creates missing seed rows without overwriting existing agents or teams by default', async () => {
    const db = makeDb({
      agents: [
        {
          name: 'engineering-lead',
          displayName: 'Custom Engineering Lead',
          system: 'custom prompt',
          canDelegateTo: ['ui-copywriter'],
          teamName: 'engineering',
          teamRole: 'lead',
          isBuiltIn: true,
        },
      ],
      teams: [
        {
          name: 'engineering',
          displayName: 'Custom Engineering',
          mission: 'custom mission',
          leadAgentName: 'engineering-lead',
          isBuiltIn: true,
        },
      ],
    });

    await new OrgSeedService(db).seed();

    const lead = db.store.agents.find((a: any) => a.name === 'engineering-lead');
    const team = db.store.teams.find((t: any) => t.name === 'engineering');
    expect(lead.displayName).toBe('Custom Engineering Lead');
    expect(lead.system).toBe('custom prompt');
    expect(lead.canDelegateTo).toEqual(['ui-copywriter']);
    expect(team.displayName).toBe('Custom Engineering');
    expect(team.mission).toBe('custom mission');
    expect(db.store.agents.length).toBeGreaterThan(1);
    expect(db.store.teams.length).toBeGreaterThan(1);
  });

  it('overwrites existing seed rows when SEED_OVERRIDE=true', async () => {
    process.env.SEED_OVERRIDE = 'true';
    const db = makeDb({
      agents: [
        {
          name: 'engineering-lead',
          displayName: 'Custom Engineering Lead',
          system: 'custom prompt',
          canDelegateTo: ['ui-copywriter'],
          teamName: 'engineering',
          teamRole: 'lead',
          isBuiltIn: true,
        },
      ],
      teams: [
        {
          name: 'engineering',
          displayName: 'Custom Engineering',
          mission: 'custom mission',
          leadAgentName: 'engineering-lead',
          isBuiltIn: true,
        },
      ],
    });

    await new OrgSeedService(db).seed();

    const lead = db.store.agents.find((a: any) => a.name === 'engineering-lead');
    const team = db.store.teams.find((t: any) => t.name === 'engineering');
    expect(lead.displayName).toBe('Engineering Lead');
    expect(lead.system).not.toBe('custom prompt');
    expect(team.displayName).toBe('Engineering');
    expect(team.mission).not.toBe('custom mission');
  });

  it('seeds mandatory repo knowledge graph persistence instructions', async () => {
    const db = makeDb();

    await new OrgSeedService(db).seed();

    const indexer = db.store.agents.find((a: any) => a.name === 'repo-knowledge-graph-indexer');
    expect(indexer.model).toBe('opus');
    expect(indexer.system).toContain('MUST call save_repo_knowledge_graph');
    expect(indexer.system).toContain('Every indexing job MUST specify exactly one mode');
    expect(indexer.system).toContain('mandatory_context_map');
    expect(indexer.system).toContain('graph_mode');
    expect(indexer.system).toContain('mcp__allen__save_repo_knowledge_graph');
    expect(indexer.system).toContain('allen_save_artifact');
    expect(indexer.system).toContain('is not graph persistence');
    expect(indexer.system).toContain('KNOWLEDGE_GRAPH_VALIDATION_FAILED');
    expect(indexer.system).toContain('mandatoryForNodeRoles means "always-load workflow node role guideline."');
    expect(indexer.system).toContain('mandatoryForSpawnedAgentRoles');
    expect(indexer.system).toContain('mandatoryForSpawnerRoles');
    expect(indexer.system).toContain('It is valid for a role to have no mandatory mapping');
    expect(indexer.system).toContain('Command profile files such as package.json');
    expect(indexer.system).toContain('Cognee uses this graph only to identify Allen mandatory always-load context');
    expect(indexer.system).toContain('"mandatoryForNodeRoles": []');
    expect(indexer.system).toContain('"mandatoryForSpawnedAgentRoles": []');
    expect(indexer.system).toContain('"mandatoryForSpawnerRoles": []');
    expect(indexer.system).not.toContain('"mandatoryForNodeRoles": ["backend-developer", "qa-lead"]');
  });
});
