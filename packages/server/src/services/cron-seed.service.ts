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
  {
    name: 'repo-pull-30min',
    displayName: 'Repo Pull (every 30 min)',
    description:
      'Pulls the latest changes from origin for all active repos every 30 minutes so code stays up to date.',
    enabled: true,
    schedule: '*/30 * * * *',
    timezone: 'UTC',
    target: {
      type: 'system',
      systemAction: 'repo-pull-all',
    },
    isBuiltIn: true,
    createdBy: 'seed',
  },
  {
    name: 'mcp-bundle-cleanup-hourly',
    displayName: 'MCP Bundle Cleanup',
    description:
      'Deletes uploaded MCP server bundles that were never linked to a server record (orphans older than 24 hours).',
    enabled: true,
    schedule: '0 * * * *',
    timezone: 'UTC',
    target: {
      type: 'system',
      systemAction: 'mcp-bundle-cleanup',
    },
    isBuiltIn: true,
    createdBy: 'seed',
  },
  {
    name: 'coderabbit-sweep-15min',
    displayName: 'CodeRabbit Review Sweep',
    description:
      'Every 15 minutes, scans open workflow-owned PRs for unresolved CodeRabbit comments and triggers the resolve-pr-reviews workflow. External PRs (not created by a workflow) are skipped — trigger those manually from the Pull Requests page.',
    enabled: true,
    schedule: '*/15 * * * *',
    timezone: 'UTC',
    target: {
      type: 'system',
      systemAction: 'coderabbit-sweep',
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
