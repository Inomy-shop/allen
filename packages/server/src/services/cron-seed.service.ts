/**
 * Cron seed — idempotent startup migration that ensures built-in cron jobs exist.
 *
 * Currently seeds one job: "repo-scan-daily" which runs at 5 AM UTC daily and
 * re-scans repos whose base-branch HEAD has changed.
 *
 * Syncs display fields on existing rows so code changes propagate to previously
 * seeded DBs. Never deletes user-created jobs. Safe to call on every startup.
 */

import type { Db } from 'mongodb';
import { computeNextRun } from './cron.service.js';
import type { CronJob } from './cron.types.js';

const SEED_JOBS: Omit<CronJob, '_id' | 'nextRunAt' | 'lastRunAt' | 'lastRunStatus' | 'lastRunError' | 'lastRunExecutionId' | 'runCount' | 'runStatus' | 'createdAt' | 'updatedAt'>[] = [
  {
    name: 'repo-scan-daily',
    displayName: 'Daily Repo Context Refresh',
    description:
      'Re-scans every registered repo whose base-branch HEAD has changed since the last scan. Only queues scans for repos with actual changes — unchanged repos are skipped.',
    enabled: true,
    schedule: '0 5 * * *',
    timezone: 'UTC',
    target: {
      type: 'system',
      systemAction: 'repo-scan-if-changed',
    },
    isBuiltIn: true,
    createdBy: 'seed',
  },
];

export async function seedCronJobs(db: Db): Promise<number> {
  const col = db.collection('cron_jobs');
  let created = 0;

  for (const seed of SEED_JOBS) {
    const existing = await col.findOne({ name: seed.name });

    if (!existing) {
      await col.insertOne({
        ...seed,
        nextRunAt: computeNextRun(seed.schedule, seed.timezone),
        lastRunAt: null,
        lastRunStatus: null,
        lastRunError: null,
        lastRunExecutionId: null,
        runCount: 0,
        runStatus: 'idle',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as CronJob);
      created++;
      console.log(`[cron] seeded built-in job: ${seed.name}`);
    } else {
      // Sync display fields + schedule so code changes propagate
      await col.updateOne(
        { name: seed.name },
        {
          $set: {
            displayName: seed.displayName,
            description: seed.description,
            schedule: seed.schedule,
            timezone: seed.timezone,
            target: seed.target,
            isBuiltIn: true,
            updatedAt: new Date(),
          },
        },
      );
    }
  }

  return created;
}
