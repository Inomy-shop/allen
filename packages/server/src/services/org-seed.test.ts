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

  it('inlines the full coding-guidelines body into code-writing and design/planning specialists only', async () => {
    const db = makeDb();

    await new OrgSeedService(db).seed();

    // Agents that MUST contain the full coding-guidelines body — the 7 code-writing
    // agents plus the 4 design/planning specialists that produce written artifacts.
    const guidelineRecipients = [
      // Code-writing specialists
      'backend-developer', 'frontend-developer', 'devops-engineer',
      'pr-creator', 'documentation-writer', 'test-writer', 'pr-review-bot',
      // Design / planning specialists
      'solution-architect', 'technical-designer', 'test-planner', 'requirements-analyst',
    ];
    for (const agentName of guidelineRecipients) {
      const agent = db.store.agents.find((a: any) => a.name === agentName);
      expect(agent, `${agentName} must be seeded`).toBeDefined();
      expect(agent.system, `${agentName} must contain the # Coding Guidelines heading`).toContain('# Coding Guidelines');
      expect(agent.system, `${agentName} must contain the ## Think Before Coding section`).toContain('## Think Before Coding');
      expect(agent.system, `${agentName} must contain the ## Surgical Changes section`).toContain('## Surgical Changes');
      expect(agent.system, `${agentName} must contain the ## Goal-Driven Execution section`).toContain('## Goal-Driven Execution');
    }

    // Agents that must NOT contain the coding-guidelines body — leads/team agents
    // (don't use SPECIALIST_PREAMBLE) and the read-only / review specialists that
    // were intentionally excluded from the recipient list.
    const nonRecipients = [
      // Lead / team agents
      'engineering-lead', 'codebase-navigator', 'implementation-self-checker',
      'qa-lead', 'product-manager', 'ceo',
      // Specialists that read/review but do not produce writeable artifacts
      'code-reviewer', 'bug-investigator', 'implementation-validator',
      'acceptance-tester', 'security-specialist', 'doc-auditor', 'pr-workspace-resolver',
    ];
    for (const agentName of nonRecipients) {
      const agent = db.store.agents.find((a: any) => a.name === agentName);
      expect(agent, `${agentName} must be seeded (update this list if the agent was renamed/removed)`).toBeDefined();
      expect(
        agent.system,
        `${agentName} must NOT contain the coding-guidelines body — it is not a code-writer or design/planning agent`,
      ).not.toContain('# Coding Guidelines');
    }
  });
});
