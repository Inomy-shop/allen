import { describe, it, expect } from 'vitest';
import { buildOrgContextBlock } from './org-context.js';

/**
 * Minimal in-memory Db mock satisfying the shape used by buildOrgContextBlock.
 * Kept in sync with the engine-side copy (packages/engine/src/org-context.test.ts).
 */
function mockDb(teams: any[], agents: any[]): any {
  return {
    collection: (name: string) => ({
      find: () => ({
        toArray: async () =>
          name === 'teams' ? teams : name === 'agents' ? agents : [],
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
    canDelegateTo: ['product-manager'],
  },
  {
    name: 'product-manager',
    displayName: 'Product Manager',
    description: 'Owns product strategy.',
    teamName: 'product',
    teamRole: 'lead',
    canDelegateTo: [],
  },
  {
    name: 'team-builder-agent',
    displayName: 'Team Builder',
    description: 'Designs new teams.',
    teamName: 'meta',
    teamRole: 'lead',
    canDelegateTo: [],
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

  it('renders per-agent delegation targets for the requesting agent', async () => {
    const db = mockDb(TEAMS, AGENTS);
    const result = await buildOrgContextBlock(db, {
      forAgent: 'ceo',
      includeFullChart: false,
    });
    expect(result).toContain('## Your delegation targets');
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
