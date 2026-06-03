import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedDefaultWorkflows, seedDefaultSkills } from './seed.js';

function makeDb(seed: Record<string, Record<string, unknown>[]> = {}): any {
  const store: Record<string, Record<string, unknown>[]> = {
    agents: [],
    workflows: [],
    skills: [],
    agent_conversations: [],
    ...seed,
  };

  function matches(doc: Record<string, unknown>, query: Record<string, unknown>): boolean {
    return Object.entries(query).every(([key, value]) => doc[key] === value || doc[key]?.toString?.() === value);
  }

  return {
    store,
    collection: (name: string) => ({
      findOne: async (query: Record<string, unknown>) =>
        (store[name] ?? []).find((doc) => matches(doc, query)) ?? null,
      find: () => ({
        toArray: async () => store[name] ?? [],
      }),
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
      createIndex: async () => undefined,
    }),
  };
}

describe('seedDefaultSkills', () => {
  const originalSeedOverride = process.env.SEED_OVERRIDE;

  beforeEach(() => {
    delete process.env.SEED_OVERRIDE;
  });

  afterEach(() => {
    if (originalSeedOverride === undefined) delete process.env.SEED_OVERRIDE;
    else process.env.SEED_OVERRIDE = originalSeedOverride;
  });

  it('seeds coding-guidelines as a low-priority implementation-guidelines skill', async () => {
    const db = makeDb();

    await seedDefaultSkills(db);

    const skill = db.store.skills?.find((s: any) => s.name === 'coding-guidelines');
    expect(skill, 'coding-guidelines skill must be seeded').toBeDefined();
    expect(skill.category).toBe('implementation-guidelines');
    expect(skill.priority).toBeLessThan(72); // must not outbid routing skills
    expect(skill.body).toContain('Coding Guidelines');
    expect(skill.body).toContain('Surface assumptions');
    expect(skill.body).toContain('Minimum code');
    expect(skill.body).toContain('Surgical Changes');
    expect(skill.body).toContain('Verify before reporting done');
  });

  it('seeds coding-guidelines with a low enough priority not to outbid routing skills', async () => {
    const db = makeDb();

    await seedDefaultSkills(db);

    // Collect all seeded skills and verify coding-guidelines has lower priority
    const skills: any[] = db.store.skills ?? [];
    const codingGuidelines = skills.find((s: any) => s.name === 'coding-guidelines');
    expect(codingGuidelines).toBeDefined();

    // All domain routing skills (bug-fix-routing, feature-routing, etc.) should
    // have higher priority than the guideline skill.
    const routingSkills = skills.filter((s: any) =>
      ['bug-fix-routing', 'feature-routing', 'capability-routing', 'review-routing', 'workspace-pr-routing', 'team-assignment-routing'].includes(s.name),
    );
    for (const routing of routingSkills) {
      expect(routing.priority).toBeGreaterThan(codingGuidelines.priority);
    }
  });

  it('does not overwrite a user-edited coding-guidelines body when SEED_OVERRIDE is false', async () => {
    const db = makeDb({
      skills: [
        {
          _id: 'skill-coding-guidelines',
          name: 'coding-guidelines',
          body: 'custom user body',
          createdBy: 'user',
          version: 1,
        },
      ],
    });

    await seedDefaultSkills(db);

    const skill = db.store.skills?.find((s: any) => s.name === 'coding-guidelines');
    // User-owned skill must not be overwritten
    expect(skill.body).toBe('custom user body');
  });
});

describe('seedDefaultWorkflows SEED_OVERRIDE policy', () => {
  const originalSeedOverride = process.env.SEED_OVERRIDE;

  beforeEach(() => {
    delete process.env.SEED_OVERRIDE;
  });

  afterEach(() => {
    if (originalSeedOverride === undefined) delete process.env.SEED_OVERRIDE;
    else process.env.SEED_OVERRIDE = originalSeedOverride;
  });

  it('does not overwrite an existing system workflow by default', async () => {
    const db = makeDb({
      workflows: [
        {
          _id: 'workflow-existing',
          name: 'allen-self-healing-monitor-hourly',
          yaml: 'custom yaml',
          description: 'custom description',
          createdBy: 'system',
        },
      ],
    });

    await seedDefaultWorkflows(db);

    const workflow = db.store.workflows.find((w: any) => w.name === 'allen-self-healing-monitor-hourly');
    expect(workflow.yaml).toBe('custom yaml');
    expect(workflow.description).toBe('custom description');
  });

  it('overwrites an existing system workflow when SEED_OVERRIDE=true', async () => {
    process.env.SEED_OVERRIDE = 'true';
    const db = makeDb({
      workflows: [
        {
          _id: 'workflow-existing',
          name: 'allen-self-healing-monitor-hourly',
          yaml: 'custom yaml',
          description: 'custom description',
          createdBy: 'system',
        },
      ],
    });

    await seedDefaultWorkflows(db);

    const workflow = db.store.workflows.find((w: any) => w.name === 'allen-self-healing-monitor-hourly');
    expect(workflow.yaml).not.toBe('custom yaml');
    expect(workflow.description).not.toBe('custom description');
  });
});
