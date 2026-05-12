/**
 * Tests for cron-seed.service.ts
 *
 * Verifies:
 *  1. daily-status-prep job is seeded when absent
 *  2. linkedChatSessionId is NOT overwritten when SEED_OVERRIDE=true
 *  3. Other fields ARE updated when SEED_OVERRIDE=true
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedCronJobs } from './cron-seed.service.js';

function makeDb(seed: Record<string, Record<string, unknown>[]> = {}): any {
  const store: Record<string, Record<string, unknown>[]> = {
    cron_jobs: [],
    ...seed,
  };

  function matches(doc: Record<string, unknown>, query: Record<string, unknown>): boolean {
    return Object.entries(query).every(([key, value]) => doc[key] === value);
  }

  return {
    store,
    collection: (name: string) => ({
      find: (_q: Record<string, unknown>) => ({
        toArray: async () => store[name] ?? [],
      }),
      findOne: async (query: Record<string, unknown>) =>
        (store[name] ?? []).find((doc) => matches(doc, query)) ?? null,
      insertOne: async (doc: Record<string, unknown>) => {
        (store[name] = store[name] ?? []).push({
          _id: `${name}-${(store[name] ?? []).length}`,
          ...doc,
        });
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

describe('cron-seed.service: daily-status-prep', () => {
  const originalSeedOverride = process.env.SEED_OVERRIDE;

  beforeEach(() => {
    delete process.env.SEED_OVERRIDE;
  });

  afterEach(() => {
    if (originalSeedOverride === undefined) delete process.env.SEED_OVERRIDE;
    else process.env.SEED_OVERRIDE = originalSeedOverride;
  });

  it('seeds daily-status-prep when the job does not exist', async () => {
    const db = makeDb();
    const created = await seedCronJobs(db);

    const job = db.store.cron_jobs.find((j: any) => j.name === 'daily-status-prep');
    expect(job).toBeDefined();
    expect(job.displayName).toBe('Daily Status Prep');
    expect(job.schedule).toBe('45 9 * * 1-5');
    expect(job.timezone).toBe('America/New_York');
    expect(job.target.type).toBe('agent');
    expect(job.target.agentName).toBe('daily-status-prep');
    expect(job.isBuiltIn).toBe(true);
    expect(job.createdBy).toBe('seed');
    expect(created).toBeGreaterThan(0);
  });

  it('does NOT overwrite linkedChatSessionId when SEED_OVERRIDE=true', async () => {
    process.env.SEED_OVERRIDE = 'true';
    const existingSessionId = 'aabbccddee112233445566aa';

    const db = makeDb({
      cron_jobs: [
        {
          name: 'daily-status-prep',
          displayName: 'Old Display Name',
          description: 'old description',
          schedule: '0 10 * * 1-5',
          timezone: 'UTC',
          target: { type: 'agent', agentName: 'daily-status-prep', prompt: 'old prompt' },
          isBuiltIn: true,
          createdBy: 'seed',
          linkedChatSessionId: existingSessionId,
          runCount: 5,
          runStatus: 'idle',
          lastRunAt: null,
          lastRunStatus: null,
          lastRunError: null,
          lastRunExecutionId: null,
          nextRunAt: null,
          enabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });

    await seedCronJobs(db);

    const job = db.store.cron_jobs.find((j: any) => j.name === 'daily-status-prep');
    // Display fields should be updated
    expect(job.displayName).toBe('Daily Status Prep');
    expect(job.schedule).toBe('45 9 * * 1-5');
    expect(job.timezone).toBe('America/New_York');
    // linkedChatSessionId must NOT be touched
    expect(job.linkedChatSessionId).toBe(existingSessionId);
  });

  it('does not create duplicate when called twice without SEED_OVERRIDE', async () => {
    const db = makeDb();

    // First call: seeds the job (insertOne runs)
    const created1 = await seedCronJobs(db);
    expect(created1).toBeGreaterThan(0);

    const jobsAfterFirst = db.store.cron_jobs.filter((j: any) => j.name === 'daily-status-prep');
    expect(jobsAfterFirst).toHaveLength(1);

    // Second call without SEED_OVERRIDE: findOne returns the job, no insertOne
    const created2 = await seedCronJobs(db);
    expect(created2).toBe(0);

    // Total count must still be exactly 1
    const jobsAfterSecond = db.store.cron_jobs.filter((j: any) => j.name === 'daily-status-prep');
    expect(jobsAfterSecond).toHaveLength(1);
  });

  it('updates schedule and display fields when SEED_OVERRIDE=true', async () => {
    process.env.SEED_OVERRIDE = 'true';

    const db = makeDb({
      cron_jobs: [
        {
          name: 'daily-status-prep',
          displayName: 'Stale Name',
          description: 'stale description',
          schedule: '0 12 * * *',
          timezone: 'UTC',
          target: { type: 'agent', agentName: 'daily-status-prep', prompt: 'stale prompt' },
          isBuiltIn: true,
          createdBy: 'seed',
          runCount: 2,
          runStatus: 'idle',
          lastRunAt: null,
          lastRunStatus: null,
          lastRunError: null,
          lastRunExecutionId: null,
          nextRunAt: null,
          enabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });

    await seedCronJobs(db);

    const job = db.store.cron_jobs.find((j: any) => j.name === 'daily-status-prep');
    expect(job.schedule).toBe('45 9 * * 1-5');
    expect(job.timezone).toBe('America/New_York');
    expect(job.displayName).toBe('Daily Status Prep');
    expect(job.description).toContain('weekday morning briefing');
    expect(job.target.agentName).toBe('daily-status-prep');
  });
});
