import { describe, it, expect } from 'vitest';
import { buildOrgContextBlock } from './org-context.js';

/**
 * Minimal in-memory Db mock satisfying the shape used by buildOrgContextBlock.
 * Applies the `notDeletedFilter` (excludes rows where isDeleted is true) when
 * it is passed as the first argument to `.find()`. Kept in sync with the
 * engine-side copy (packages/engine/src/org-context.test.ts).
 */
function mockDb(teams: any[], agents: any[]): any {
  const applyNotDeleted = (rows: any[], filter?: Record<string, unknown>) => {
    if (filter && (filter as any).isDeleted && (filter as any).isDeleted.$ne === true) {
      return rows.filter((r) => !r.isDeleted);
    }
    return rows;
  };
  return {
    collection: (name: string) => ({
      find: (filter?: Record<string, unknown>) => ({
        toArray: async () => {
          if (name === 'teams') return applyNotDeleted(teams, filter);
          if (name === 'agents') return applyNotDeleted(agents, filter);
          return [];
        },
      }),
    }),
  };
}

const TEAMS = [
  { name: 'executive', displayName: 'Executive', description: 'Top-level coordination.' },
  { name: 'product', displayName: 'Product', description: 'Owns requirements.' },
  { name: 'meta', displayName: 'Meta', description: 'Builders.' },
];

const AGENTS = [
  {
    name: 'ceo',
    displayName: 'CEO',
    description: 'Top-level orchestrator.',
    teamName: 'executive',
    teamRole: 'lead',
    spawnTargets: ['product-manager'],
  },
  {
    name: 'product-manager',
    displayName: 'Product Manager',
    description: 'Owns product strategy.',
    teamName: 'product',
    teamRole: 'lead',
    spawnTargets: [],
  },
  {
    name: 'team-builder-agent',
    displayName: 'Team Builder',
    description: 'Designs new teams.',
    teamName: 'meta',
    teamRole: 'lead',
    spawnTargets: [],
  },
];

describe('server org-context — buildOrgContextBlock', () => {
  it('renders a full org chart with team headers', async () => {
    const db = mockDb(TEAMS, AGENTS);
    const result = await buildOrgContextBlock(db, { includeFullChart: true });
    expect(result).toContain('## Organisation');
    expect(result).toContain('**Executive team**');
    expect(result).toContain('**Product team**');
  });

  it('includes every agent name in its team section', async () => {
    const db = mockDb(TEAMS, AGENTS);
    const result = await buildOrgContextBlock(db, { includeFullChart: true });
    expect(result).toContain('- ceo (lead) — Top-level orchestrator.');
    expect(result).toContain('- product-manager (lead) — Owns product strategy.');
  });

  it('omits meta team when includeMeta is false', async () => {
    const db = mockDb(TEAMS, AGENTS);
    const result = await buildOrgContextBlock(db, { includeFullChart: true, includeMeta: false });
    expect(result).not.toContain('**Meta team**');
    expect(result).not.toContain('team-builder-agent');
  });

  it('renders compact summary mode with team leads only', async () => {
    const db = mockDb(TEAMS, AGENTS);
    const result = await buildOrgContextBlock(db, { includeFullChart: true, chartMode: 'summary' });
    expect(result).toContain('- Executive team');
    expect(result).toContain('lead(s): ceo');
    expect(result).not.toContain('- ceo (lead) — Top-level orchestrator.');
  });

  it('renders per-agent spawn targets for the requesting agent', async () => {
    const db = mockDb(TEAMS, AGENTS);
    const result = await buildOrgContextBlock(db, {
      forAgent: 'ceo',
      includeFullChart: false,
    });
    expect(result).toContain('## Suggested spawn targets');
    expect(result).toContain('product-manager [product]');
  });

  it('returns empty string when DB throws', async () => {
    const db: any = {
      collection: () => ({
        find: () => ({
          toArray: async () => {
            throw new Error('connection refused');
          },
        }),
      }),
    };
    const result = await buildOrgContextBlock(db, { includeFullChart: true });
    expect(result).toBe('');
  });
});

describe('org-context soft delete filtering', () => {
  const TEAMS = [
    { name: 'executive', displayName: 'Executive', description: 'Top-level.' },
    { name: 'product', displayName: 'Product', description: 'Owns requirements.' },
    { name: 'meta', displayName: 'Meta', description: 'Builders.' },
  ];

  it('FR1-AC1: buildOrgContextBlock excludes soft-deleted teams', async () => {
    const teamsWithDeleted = [
      ...TEAMS,
      { name: 'deleted-team', displayName: 'Deleted', description: 'Gone.', isDeleted: true, deletedAt: new Date() },
    ];
    const db = mockDb(teamsWithDeleted, []);
    const result = await buildOrgContextBlock(db, { includeFullChart: true });
    expect(result).not.toContain('deleted-team');
    expect(result).not.toContain('Deleted');
  });

  it('FR1-AC1: buildOrgContextBlock excludes soft-deleted agents from teams', async () => {
    const agents = [
      { name: 'alice', displayName: 'Alice', description: 'Active.', teamName: 'executive', teamRole: 'member', spawnTargets: [] },
      { name: 'bob', displayName: 'Bob', description: 'Deleted.', teamName: 'executive', teamRole: 'member', spawnTargets: [], isDeleted: true, deletedAt: new Date() },
    ];
    const db = mockDb(TEAMS, agents);
    const result = await buildOrgContextBlock(db, { includeFullChart: true });
    expect(result).toContain('alice');
    expect(result).not.toContain('bob');
  });

  it('FR1-AC4: buildOrgContextBlock includes agents with deletedAt=null but no isDeleted', async () => {
    const agents = [
      { name: 'carol', displayName: 'Carol', description: 'Has null deletedAt.', teamName: 'executive', teamRole: 'member', spawnTargets: [], deletedAt: null },
    ];
    const db = mockDb(TEAMS, agents);
    const result = await buildOrgContextBlock(db, { includeFullChart: true });
    expect(result).toContain('carol');
  });

  it('forAgent spawn targets exclude soft-deleted agents', async () => {
    const agents = [
      { name: 'ceo', displayName: 'CEO', description: 'CEO.', teamName: 'executive', teamRole: 'lead', spawnTargets: ['alive-target', 'deleted-target'] },
      { name: 'alive-target', displayName: 'Alive', description: 'Active.', teamName: 'product', teamRole: 'member', spawnTargets: [] },
      { name: 'deleted-target', displayName: 'Deleted', description: 'Gone.', teamName: 'product', teamRole: 'member', spawnTargets: [], isDeleted: true, deletedAt: new Date() },
    ];
    const db = mockDb(TEAMS, agents);
    const result = await buildOrgContextBlock(db, { forAgent: 'ceo', includeFullChart: false });
    // Spawn targets section should be present
    expect(result).toContain('## Suggested spawn targets');
    // Alive target should be listed
    expect(result).toContain('alive-target');
    // Deleted target should NOT be listed
    expect(result).not.toContain('deleted-target');
  });
});
