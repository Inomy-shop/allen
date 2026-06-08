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
          spawnTargets: ['ui-copywriter'],
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
    expect(lead.spawnTargets).toEqual(['ui-copywriter']);
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
          spawnTargets: ['ui-copywriter'],
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

  it('force-updates pr-creator even without SEED_OVERRIDE', async () => {
    // pr-creator must be in FORCE_UPDATE_AGENT_NAMES so its prompt stays current
    // across deployments without requiring the operator to set SEED_OVERRIDE=true.
    const db = makeDb({
      agents: [
        {
          name: 'pr-creator',
          displayName: 'Old PR Creator',
          system: 'old prompt — hardcoded allen@local',
          spawnTargets: [],
          teamName: 'engineering',
          teamRole: 'member',
          isBuiltIn: true,
        },
      ],
      teams: [],
    });

    // No SEED_OVERRIDE — only FORCE_UPDATE_AGENT_NAMES members should be updated
    await new OrgSeedService(db).seed();

    const agent = db.store.agents.find((a: any) => a.name === 'pr-creator');
    expect(agent, 'pr-creator must be seeded').toBeDefined();
    expect(agent.system, 'pr-creator must be force-updated with the new prompt').not.toBe(
      'old prompt — hardcoded allen@local',
    );
    expect(agent.system, 'updated pr-creator prompt must contain GitHub identity setup').toContain(
      'gh api user',
    );
  });

  it('seeds pr-creator with GitHub-aware identity setup in step 1', async () => {
    const db = makeDb();

    await new OrgSeedService(db).seed();

    const agent = db.store.agents.find((a: any) => a.name === 'pr-creator');
    expect(agent, 'pr-creator must be seeded').toBeDefined();

    const system: string = agent.system;

    // Must verify gh auth before any git work
    expect(system).toContain('gh auth status');

    // Must fetch login and numeric id — both are required
    expect(system).toContain('GH_LOGIN');
    expect(system).toContain('GH_ID');

    // Must try gh api user/emails for verified primary email (graceful on scope failure)
    expect(system).toContain('gh api user/emails');

    // Must use noreply fallback when no email is available
    expect(system).toContain('@users.noreply.github.com');

    // Must configure git with resolved identity variables (not hardcoded strings)
    expect(system).toContain('git config user.name "$GH_AUTHOR_NAME"');
    expect(system).toContain('git config user.email "$GH_AUTHOR_EMAIL"');

    // Must NOT contain the old hardcoded allen@local identity in this step
    // (the devops-engineer agent still uses it — that is intentional and unrelated)
    // We test the pr-creator step block specifically by checking the key text around it
    expect(system).not.toContain('git config user.email "allen@local"');
    expect(system).not.toContain('git config user.name "Allen Agent"');

    // Must fall back to login when display name is null/empty
    expect(system).toContain('GH_AUTHOR_NAME="$GH_LOGIN"');
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

  it('seeds a structurally complete org chart', async () => {
    const db = makeDb();

    await new OrgSeedService(db).seed();

    const agentNames = db.store.agents.map((agent: any) => agent.name);
    const teamNames = db.store.teams.map((team: any) => team.name);
    const agentNameSet = new Set(agentNames);
    const teamNameSet = new Set(teamNames);

    expect(agentNames).toHaveLength(agentNameSet.size);
    expect(teamNames).toHaveLength(teamNameSet.size);

    for (const team of db.store.teams) {
      expect(
        agentNameSet.has(team.leadAgentName),
        `team '${team.name}' references missing lead '${team.leadAgentName}'`,
      ).toBe(true);
    }

    for (const agent of db.store.agents) {
      expect(
        teamNameSet.has(agent.teamName),
        `agent '${agent.name}' references missing team '${agent.teamName}'`,
      ).toBe(true);

      for (const target of agent.spawnTargets ?? []) {
        expect(
          agentNameSet.has(target),
          `agent '${agent.name}' references missing spawn target '${target}'`,
        ).toBe(true);
      }
    }
  });

  it('preserves the Design team while keeping its existing lead orchestration contract', async () => {
    const db = makeDb();

    await new OrgSeedService(db).seed();

    const designTeam = db.store.teams.find((team: any) => team.name === 'd');
    const designLead = db.store.agents.find((agent: any) => agent.name === 'd-lead');
    const designSpecialists = [
      'prd-ux-translator',
      'design-system-archaeologist',
      'design-system-syncer',
      'design-divergence-planner',
      'design-variation-generator',
      'prototype-route-builder',
      'design-critic',
      'frontend-feasibility-reviewer',
      'options-synthesizer',
      'design-iteration-refiner',
      'ui-design-orchestrator',
    ];

    expect(designTeam).toBeDefined();
    expect(designTeam.leadAgentName).toBe('d-lead');
    expect(designLead).toBeDefined();
    expect(designLead.teamName).toBe('d');
    expect(designLead.teamRole).toBe('lead');
    expect(designLead.spawnTargets).toEqual(expect.arrayContaining(designSpecialists));

    for (const agentName of designSpecialists) {
      const agent = db.store.agents.find((candidate: any) => candidate.name === agentName);
      expect(agent, `${agentName} must be seeded`).toBeDefined();
      expect(agent.teamName, `${agentName} must remain on the Design team`).toBe('d');
    }

    if (designLead.system.includes('wait_for_execution')) {
      expect(designLead.system).toContain('spawn_agent');
      expect(designLead.system).toContain('wait_for_execution');
      expect(designLead.system).not.toContain('delegate_to_agent');
      expect(designLead.system).not.toContain('wait_for_delegation');
      expect(designLead.system).not.toContain('answer_delegator');
    } else {
      expect(designLead.system).toContain('delegate_to_agent');
      expect(designLead.system).toContain('wait_for_delegation');
    }
  });
});

describe('design-assistant agent seed', () => {
  it('seeds design-assistant agent in the d team', async () => {
    const db = makeDb();
    await new OrgSeedService(db).seed();
    const agent = db.store.agents.find((a: any) => a.name === 'design-assistant');
    expect(agent, 'design-assistant must be seeded').toBeDefined();
    expect(agent.teamName).toBe('d');
    expect(agent.teamRole).toBe('member');
    expect(agent.displayName).toBe('Design Assistant');
  });

  it('design-assistant system prompt contains workflow invocation rules', async () => {
    const db = makeDb();
    await new OrgSeedService(db).seed();
    const agent = db.store.agents.find((a: any) => a.name === 'design-assistant');
    expect(agent.system).toContain('source-prd-to-ui-designs-variations');
    expect(agent.system).toContain('frontend-developer');
  });

  it('design-assistant system prompt does not contain hardcoded clarification strings from old routing service', async () => {
    const db = makeDb();
    await new OrgSeedService(db).seed();
    const agent = db.store.agents.find((a: any) => a.name === 'design-assistant');
    // Old DesignRoutingService hardcoded: "I'd love to generate design variations for you!"
    expect(agent.system).not.toContain("I'd love to generate design variations for you");
    // Old DesignRoutingService hardcoded: "source repo selector in the Design context controls"
    expect(agent.system).not.toContain('source repo selector in the Design context controls');
  });

  it('design-assistant has design-focused capabilities', async () => {
    const db = makeDb();
    await new OrgSeedService(db).seed();
    const agent = db.store.agents.find((a: any) => a.name === 'design-assistant');
    expect(agent.capabilities).toContain('design');
    expect(agent.spawnTargets).toContain('frontend-developer');
  });
});
