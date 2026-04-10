/**
 * Shared types for the Cron service.
 *
 * A cron job is a persistent, schedulable trigger that fires an agent spawn,
 * a workflow execution, or an in-process "system action" on a cron schedule.
 */

import type { ObjectId } from 'mongodb';

export type CronTargetType = 'agent' | 'workflow' | 'system';

/** Discriminated union for cron targets. */
export type CronTarget =
  | {
      type: 'agent';
      agentName: string;
      prompt: string;
      repoPath?: string;
    }
  | {
      type: 'workflow';
      workflowName: string;
      workflowInput?: Record<string, unknown>;
    }
  | {
      type: 'system';
      systemAction: string;
      systemArgs?: Record<string, unknown>;
    };

export type CronRunStatus = 'running' | 'success' | 'failed' | 'skipped';

export interface CronJob {
  _id?: ObjectId;
  name: string;
  displayName: string;
  description?: string;
  enabled: boolean;

  schedule: string; // 5-field cron expression, e.g. "0 5 * * *"
  timezone: string; // IANA tz, default "UTC"
  nextRunAt: Date | null;

  target: CronTarget;

  // Run tracking
  lastRunAt: Date | null;
  lastRunStatus: CronRunStatus | null;
  lastRunError: string | null;
  lastRunExecutionId: string | null;
  runCount: number;

  // Soft lock — set when a tick claims the job, cleared when the run finishes.
  // Used by the atomic claim guard to prevent double-fire across overlapping ticks.
  runStatus: 'idle' | 'running';

  isBuiltIn: boolean;
  createdBy: 'seed' | 'user';
  createdAt: Date;
  updatedAt: Date;
}

export interface CronRun {
  _id?: ObjectId;
  cronJobId: ObjectId;
  cronJobName: string;
  startedAt: Date;
  completedAt: Date | null;
  status: CronRunStatus;
  triggeredBy: 'schedule' | 'manual';
  executionId?: string;
  error?: string;
  notes?: string;
  durationMs?: number;
}

/** Body for POST /api/crons */
export interface CronJobInput {
  name: string;
  displayName: string;
  description?: string;
  enabled?: boolean;
  schedule: string;
  timezone?: string;
  target: CronTarget;
}

/** Registered system action handler — runs in-process when a system-target cron fires. */
export interface SystemAction {
  name: string;
  description: string;
  /** Returns a brief summary stored in cron_runs.notes. Throws on failure. */
  run: (args: Record<string, unknown> | undefined) => Promise<string | undefined>;
}
