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

  it('preserves existing agent provider and model during SEED_OVERRIDE=true seed refresh (AC1, AC2, AC3)', async () => {
    process.env.SEED_OVERRIDE = 'true';
    const db = makeDb({
      agents: [
        {
          name: 'engineering-lead',
          displayName: 'Old Engineering Lead',
          system: 'old instructions — should be refreshed',
          provider: 'codex',
          model: 'gpt-9-custom-test-value',
          spawnTargets: ['ui-copywriter'],
          teamName: 'engineering',
          teamRole: 'lead',
          isBuiltIn: true,
        },
      ],
    });

    await new OrgSeedService(db).seed();

    const lead = db.store.agents.find((a: any) => a.name === 'engineering-lead');
    expect(lead.provider).toBe('codex');
    expect(lead.model).toBe('gpt-9-custom-test-value');
    expect(lead.displayName).toBe('Engineering Lead');
    expect(lead.system).not.toContain('old instructions');
  });

  it('preserves team lead agent provider and model during seed refresh (AC5)', async () => {
    process.env.SEED_OVERRIDE = 'true';
    const db = makeDb({
      agents: [
        {
          name: 'qa-lead',
          displayName: 'Old QA Lead',
          system: 'old qa lead prompt',
          provider: 'codex',
          model: 'claude-5-custom',
          spawnTargets: ['acceptance-tester'],
          teamName: 'quality',
          teamRole: 'lead',
          isBuiltIn: true,
        },
      ],
    });

    await new OrgSeedService(db).seed();

    const lead = db.store.agents.find((a: any) => a.name === 'qa-lead');
    expect(lead.provider).toBe('codex');
    expect(lead.model).toBe('claude-5-custom');
    expect(lead.displayName).toBe('QA Lead');
    expect(lead.system).not.toContain('old qa lead prompt');
  });

  it('preserves workflow-related agent provider and model during seed refresh (AC6)', async () => {
    process.env.SEED_OVERRIDE = 'true';
    const db = makeDb({
      agents: [
        {
          name: 'backend-developer',
          displayName: 'Old Backend Dev',
          system: 'old backend prompt',
          provider: 'google',
          model: 'gemini-ultra-custom',
          spawnTargets: [],
          teamName: 'engineering',
          teamRole: 'member',
          isBuiltIn: true,
        },
      ],
    });

    await new OrgSeedService(db).seed();

    const agent = db.store.agents.find((a: any) => a.name === 'backend-developer');
    expect(agent.provider).toBe('google');
    expect(agent.model).toBe('gemini-ultra-custom');
    expect(agent.system).not.toContain('old backend prompt');
  });

  it('preserves custom provider/model on multiple existing agents during seed refresh (AC7 regression)', async () => {
    process.env.SEED_OVERRIDE = 'true';
    const db = makeDb({
      agents: [
        {
          name: 'engineering-lead',
          displayName: 'Old Engineering Lead',
          system: 'old lead prompt',
          provider: 'codex',
          model: 'gpt-lead-custom',
          spawnTargets: ['backend-developer', 'frontend-developer'],
          teamName: 'engineering',
          teamRole: 'lead',
          isBuiltIn: true,
        },
        {
          name: 'backend-developer',
          displayName: 'Old Backend Dev',
          system: 'old backend prompt',
          provider: 'anthropic',
          model: 'claude-4-custom',
          spawnTargets: [],
          teamName: 'engineering',
          teamRole: 'member',
          isBuiltIn: true,
        },
        {
          name: 'frontend-developer',
          displayName: 'Old Frontend Dev',
          system: 'old frontend prompt',
          provider: 'google',
          model: 'gemini-ultra-custom',
          spawnTargets: [],
          teamName: 'engineering',
          teamRole: 'member',
          isBuiltIn: true,
        },
      ],
    });

    await new OrgSeedService(db).seed();

    const lead = db.store.agents.find((a: any) => a.name === 'engineering-lead');
    const backend = db.store.agents.find((a: any) => a.name === 'backend-developer');
    const frontend = db.store.agents.find((a: any) => a.name === 'frontend-developer');

    expect(lead.provider).toBe('codex');
    expect(lead.model).toBe('gpt-lead-custom');
    expect(lead.displayName).toBe('Engineering Lead');
    expect(lead.system).not.toContain('old lead prompt');

    expect(backend.provider).toBe('anthropic');
    expect(backend.model).toBe('claude-4-custom');
    expect(backend.system).not.toContain('old backend prompt');

    expect(frontend.provider).toBe('google');
    expect(frontend.model).toBe('gemini-ultra-custom');
    expect(frontend.system).not.toContain('old frontend prompt');
  });

  it('creates new seeded agents with seed provider and model defaults (AC4)', async () => {
    const db = makeDb();

    await new OrgSeedService(db).seed();

    const lead = db.store.agents.find((a: any) => a.name === 'engineering-lead');
    expect(lead, 'engineering-lead must be seeded').toBeDefined();
    expect(typeof lead.provider).toBe('string');
    expect(lead.provider.length).toBeGreaterThan(0);
    expect(typeof lead.model).toBe('string');
    expect(lead.model.length).toBeGreaterThan(0);
  });

  it('does not overwrite pr-creator when SEED_OVERRIDE is disabled', async () => {
    // pr-creator used to be in FORCE_UPDATE_AGENT_NAMES, but that bypass
    // was removed so SEED_OVERRIDE=false means ALL built-ins are preserved.
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

    // No SEED_OVERRIDE — existing pr-creator must not be overwritten
    await new OrgSeedService(db).seed();

    const agent = db.store.agents.find((a: any) => a.name === 'pr-creator');
    expect(agent, 'pr-creator must be seeded').toBeDefined();
    expect(agent.system, 'pr-creator must NOT be overwritten').toBe(
      'old prompt — hardcoded allen@local',
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

  it('agent builder seed enforces the same adaptive core-job gate as planning and validation', async () => {
    const db = makeDb();

    await new OrgSeedService(db).seed();

    const agent = db.store.agents.find((a: any) => a.name === 'agent-builder-agent');
    expect(agent, 'agent-builder-agent must be seeded').toBeDefined();
    const system: string = agent.system;

    expect(system).toContain('adaptive core-job instruction gate');
    expect(system).toContain('task-appropriate');
    expect(system).toContain('not merely a role label');
    expect(system).toContain('core-job verdict did not pass');
    expect(system).toContain('does not repair non-compliant blueprints');
  });

  it('design agent seeds include the professional visual quality / no-emoji / no-decorative constraints', async () => {
    const db = makeDb();

    await new OrgSeedService(db).seed();

    // Agents that must carry the professional quality contract
    const agentsRequiringQualityContract = [
      'design-variation-generator',
      'prototype-route-builder',
      'design-critic',
      'prd-ux-translator',
    ];

    for (const agentName of agentsRequiringQualityContract) {
      const agent = db.store.agents.find((a: any) => a.name === agentName);
      expect(agent, `${agentName} must be seeded`).toBeDefined();
      const system: string = agent.system;

      // Every design agent must explicitly ban emoji (various phrasings accepted:
      //   "NO EMOJI", "no emoji", "ban emoji", "emoji … violation", "emoji … blocker", etc.)
      expect(
        system,
        `${agentName} must contain a no-emoji instruction`,
      ).toMatch(/no.{0,20}emoji|emoji.{0,40}(ban|violat|blocker|check|present)|ban.{0,10}emoji/i);

      // Every design agent must explicitly ban decorative gimmicks or consumer-app fluff
      expect(
        system,
        `${agentName} must contain a no-decorative-gimmicks or professional-quality instruction`,
      ).toMatch(/decorative|gimmick|glassmorphism|professional.*visual|visual.*quality/i);
    }
  });

  it('design-variation-generator no longer instructs concept routes to be /options/option-XX when a plan provides concept_slug/primary_route', async () => {
    const db = makeDb();

    await new OrgSeedService(db).seed();

    const agent = db.store.agents.find((a: any) => a.name === 'design-variation-generator');
    expect(agent, 'design-variation-generator must be seeded').toBeDefined();
    const system: string = agent.system;

    // Must NOT contain the old /options/option-01 through option-NN routing rule
    // as a write-target instruction (the old line was:
    //   `repos/{prd_slug}/options/option-01.md` through `option-NN.md`
    // which conflated the URL slug with option_id)
    expect(
      system,
      'design-variation-generator must not instruct concept routes to use /options/option-XX as write targets',
    ).not.toMatch(/options\/option-0[1-9]\.md/);

    // Must contain an instruction that option_id is NOT a URL segment
    expect(
      system,
      'design-variation-generator must state that option_id is NOT a URL segment',
    ).toMatch(/option_id.*NOT.*URL|NOT.*option_id.*URL|option_id is not a URL/i);

    // Must contain concept_slug-based write target rule
    expect(
      system,
      'design-variation-generator must use concept_slug for write targets / spec filenames',
    ).toMatch(/concept_slug/);
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

  it('design-assistant system prompt references Design Studio and does not mention old workflow', async () => {
    const db = makeDb();
    await new OrgSeedService(db).seed();
    const agent = db.store.agents.find((a: any) => a.name === 'design-assistant');
    expect(agent.system).not.toContain('source-prd-to-ui-designs-variations');
    expect(agent.system).toContain('Design Studio');
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
