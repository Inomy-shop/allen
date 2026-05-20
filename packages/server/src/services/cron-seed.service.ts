/**
 * Cron seed — idempotent startup migration that ensures built-in cron jobs exist.
 *
 * Currently seeds one job: "repo-scan-daily" which runs at 5 AM UTC daily and
 * re-scans repos whose base-branch HEAD has changed.
 *
 * Existing rows are only updated when SEED_OVERRIDE=true. Never deletes
 * user-created jobs. Safe to call on every startup.
 */

import type { Db } from 'mongodb';
import { computeNextRun } from './cron.service.js';
import type { CronJob } from './cron.types.js';
import { getSelfHealingLinearConfig } from './self-healing-env.js';
import { isSeedOverrideEnabled } from './seed-policy.js';

const selfHealingLinearConfig = getSelfHealingLinearConfig();

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
    name: 'pr-sync-30min',
    displayName: 'GitHub PR Sync (every 30 min)',
    description:
      'Refreshes the local pull_requests mirror by running `gh pr list` against every active repo. Keeps the PR list in the UI current without requiring a manual refresh.',
    enabled: true,
    schedule: '*/30 * * * *',
    timezone: 'UTC',
    target: {
      type: 'system',
      systemAction: 'pr-sync-all',
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
  {
    name: 'allen-self-healing-monitor-hourly',
    displayName: 'Allen Self-Healing Monitor',
    description:
      'Every hour, starts the agent-led self-healing workflow. Allen monitoring agents collect evidence through Allen MCP tools, create/update Linear issues through Linear MCP, and dispatch bug-fix-by-severity for Allen-owned incidents.',
    enabled: true,
    schedule: '17 * * * *',
    timezone: 'UTC',
    target: {
      type: 'workflow',
      workflowName: 'allen-self-healing-monitor-hourly',
      workflowInput: {
        mode: 'hourly_scan',
        scan_window_hours: 1,
        overlap_hours: 24,
        lookbackHours: 24,
        max_records_per_surface: 100,
        maxTicketsPerRun: 20,
        auto_dispatch: true,
        linear_team_key: selfHealingLinearConfig?.teamKey ?? null,
        linear_project_name: selfHealingLinearConfig?.projectName ?? null,
        linear_assignee_email: selfHealingLinearConfig?.assigneeEmail ?? null,
        statuses: ['completed', 'failed', 'cancelled', 'canceled', 'interrupted', 'running', 'waiting_for_input'],
        scan_surfaces: [
          'chat_sessions',
          'chat_messages',
          'chat_logs',
          'agent_conversations',
          'agent_activity',
          'executions',
          'execution_logs',
          'execution_traces',
          'memory_injection_audits',
          'learnings',
          'ticket_assignments',
          'monitoring_events',
        ],
        stuck_thresholds: {
          chatStreamingMinutes: 10,
          agentRunningMinutes: 45,
          delegationActiveMinutes: 45,
          workflowRunningMinutes: 90,
          workflowWaitingForInputMinutes: 1440,
        },
      },
    },
    isBuiltIn: true,
    createdBy: 'seed',
  },
];

export async function seedCronJobs(db: Db): Promise<number> {
  const col = db.collection('cron_jobs');
  const override = isSeedOverrideEnabled();
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
    } else if (override) {
      // Sync display fields + schedule only when seed override is explicit.
      // NOTE: linkedChatSessionId is intentionally excluded from this $set so
      // that the persistent automation chat thread is never overwritten by a
      // seed update — once ensureLinkedSession() sets it on first dispatch,
      // it must survive restarts and SEED_OVERRIDE re-runs.
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
