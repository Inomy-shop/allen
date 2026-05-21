import { describe, it, expect } from 'vitest';
import { buildOrgContextBlock } from './org-context.js';

/**
 * Builds a minimal in-memory Db mock that satisfies the shape used by
 * buildOrgContextBlock (teams and agents collections with find().toArray()).
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
  { name: 'engineering', displayName: 'Engineering', description: 'Builds and ships code.' },
  { name: 'meta', displayName: 'Meta', description: 'Agents that extend the org itself.' },
];

const AGENTS = [
  {
    name: 'ceo',
    displayName: 'CEO',
    description: 'Top-level orchestrator.',
    teamName: 'executive',
    teamRole: 'lead',
    canDelegateTo: ['engineering-lead'],
  },
  {
    name: 'engineering-lead',
    displayName: 'Engineering Lead',
    description: 'Designs implementation plans.',
    teamName: 'engineering',
    teamRole: 'lead',
    canDelegateTo: ['backend-developer'],
  },
  {
    name: 'backend-developer',
    displayName: 'Backend Developer',
    description: 'Writes server-side code.',
    teamName: 'engineering',
    teamRole: 'member',
    canDelegateTo: [],
  },
  {
    name: 'team-builder-agent',
    displayName: 'Team Builder',
    description: 'Designs and creates new teams.',
    teamName: 'meta',
    teamRole: 'lead',
    canDelegateTo: [],
  },
];

describe('buildOrgContextBlock', () => {
  it('renders the full org chart with all teams', async () => {
    const db = mockDb(TEAMS, AGENTS);
    const result = await buildOrgContextBlock(db, { includeFullChart: true });
    expect(result).toContain('## Organisation');
    expect(result).toContain('**Executive team**');
    expect(result).toContain('**Engineering team**');
    expect(result).toContain('**Meta team**');
  });

  it('puts the team lead first within each team', async () => {
    const db = mockDb(TEAMS, AGENTS);
    const result = await buildOrgContextBlock(db, { includeFullChart: true });
    const engSection = result.split('**Engineering team**')[1]?.split('**')[0] ?? '';
    // engineering-lead (lead) should appear before backend-developer (member)
    const leadIdx = engSection.indexOf('engineering-lead');
    const memberIdx = engSection.indexOf('backend-developer');
    expect(leadIdx).toBeGreaterThanOrEqual(0);
    expect(memberIdx).toBeGreaterThan(leadIdx);
  });

  it('includes the agent description in the chart', async () => {
    const db = mockDb(TEAMS, AGENTS);
    const result = await buildOrgContextBlock(db, { includeFullChart: true });
    expect(result).toContain('Designs implementation plans.');
    expect(result).toContain('Writes server-side code.');
  });

  it('excludes meta team when includeMeta is false', async () => {
    const db = mockDb(TEAMS, AGENTS);
    const result = await buildOrgContextBlock(db, { includeFullChart: true, includeMeta: false });
    expect(result).toContain('**Engineering team**');
    expect(result).not.toContain('**Meta team**');
    expect(result).not.toContain('team-builder-agent');
  });

  it('renders per-agent delegation targets when forAgent is set', async () => {
    const db = mockDb(TEAMS, AGENTS);
    const result = await buildOrgContextBlock(db, {
      forAgent: 'ceo',
      includeFullChart: false,
    });
    expect(result).toContain('## Your delegation targets');
    expect(result).toContain('engineering-lead');
    expect(result).toContain('[engineering]');
    expect(result).toContain('Designs implementation plans.');
  });

  it('does not render delegation targets section for agents with no canDelegateTo', async () => {
    const db = mockDb(TEAMS, AGENTS);
    const result = await buildOrgContextBlock(db, {
      forAgent: 'backend-developer',
      includeFullChart: false,
    });
    expect(result).not.toContain('## Your delegation targets');
  });

  it('returns empty string when DB throws (defensive)', async () => {
    const brokenDb = {
      collection: () => ({
        find: () => ({
          toArray: async () => {
            throw new Error('db down');
          },
        }),
      }),
    } as any;
    const result = await buildOrgContextBlock(brokenDb, { includeFullChart: true });
    expect(result).toBe('');
  });

  it('skips teams with zero members', async () => {
    const teamsWithEmpty = [...TEAMS, { name: 'empty', displayName: 'Empty', description: 'No one here.' }];
    const db = mockDb(teamsWithEmpty, AGENTS);
    const result = await buildOrgContextBlock(db, { includeFullChart: true });
    expect(result).not.toContain('**Empty team**');
  });
});
