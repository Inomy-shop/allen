/**
 * Cron Service — Generic scheduler for agents, workflows, and system actions.
 *
 * Uses `node-cron` to register a real cron task per enabled job. No polling
 * loop — each job fires precisely on its schedule via node-cron's internal
 * timer. When a job is created/updated/enabled/disabled, we create/destroy
 * the corresponding node-cron task.
 *
 * Agent/workflow targets are dispatched via HTTP self-call to the server's own
 * REST endpoints so they flow through the full existing pipeline (tracing,
 * execution logs, MCP servers, repo context injection, etc.).
 *
 * System targets are dispatched in-process via a registered handler map.
 */

import type { Collection, Db } from 'mongodb';
import cron from 'node-cron';
import { logger } from '../logger.js';
import { CronExpressionParser } from 'cron-parser';
import { signAccessToken } from '../auth/jwt.js';
import type { CronJob, CronRun, CronRunStatus, SystemAction } from './cron.types.js';

const PORT = parseInt(process.env.PORT ?? '4000', 10);

export function buildInternalApiHeaders(): Record<string, string> {
  const token = signAccessToken({
    sub: 'cron-system',
    email: 'cron@internal.local',
    role: 'admin',
    mustResetPassword: false,
  });

  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

export class CronService {
  private db: Db;
  private jobs: Collection<CronJob>;
  private runs: Collection<CronRun>;
  /** Live node-cron task handles keyed by cron_jobs._id string. */
  private tasks = new Map<string, cron.ScheduledTask>();
  private inFlight = new Set<string>();
  private systemActions = new Map<string, SystemAction>();

  constructor(db: Db) {
    this.db = db;
    this.jobs = db.collection<CronJob>('cron_jobs');
    this.runs = db.collection<CronRun>('cron_runs');
  }

  // ── Lifecycle ──

  /** Boot the scheduler: recover stale runs, then register a node-cron task for every enabled job. */
  async start(): Promise<void> {
    await this.recoverStaleRuns();

    const enabledJobs = await this.jobs.find({ enabled: true }).toArray();
    for (const job of enabledJobs) {
      this.registerTask(job);
    }

    // Also recompute nextRunAt for all enabled jobs (informational for the UI)
    for (const job of enabledJobs) {
      const next = computeNextRun(job.schedule, job.timezone);
      await this.jobs.updateOne({ _id: job._id }, { $set: { nextRunAt: next } });
    }

    logger.info('cron scheduler started', { component: 'cron', jobCount: enabledJobs.length });
  }

  /** Stop all cron tasks (graceful shutdown). */
  stop(): void {
    for (const task of this.tasks.values()) {
      task.stop();
    }
    this.tasks.clear();
  }

  // ── Task registration (node-cron) ──

  /** Create and start a node-cron task for a job. Replaces any existing task for this job. */
  registerTask(job: CronJob): void {
    const jobId = String(job._id);
    this.unregisterTask(jobId);

    if (!job.enabled) return;
    if (!cron.validate(job.schedule)) {
      logger.warn('invalid cron schedule', { component: 'cron', jobName: job.name, schedule: job.schedule });
      return;
    }

    const task = cron.schedule(
      job.schedule,
      () => {
        // Refresh the job from DB (schedule/target may have changed)
        this.jobs.findOne({ _id: job._id }).then((freshJob) => {
          if (!freshJob || !freshJob.enabled) return;
          this.executeJob(freshJob, 'schedule').catch((err) => {
            logger.error('cron job execution error', { component: 'cron', jobName: job.name, error: (err as Error).message });
          });
        }).catch((err) => {
          logger.error('cron findOne error', { component: 'cron', jobName: job.name, error: (err as Error).message });
        });
      },
      { timezone: job.timezone || 'UTC' },
    );

    this.tasks.set(jobId, task);
  }

  /** Stop and remove a node-cron task for a job. */
  unregisterTask(jobId: string): void {
    const existing = this.tasks.get(jobId);
    if (existing) {
      existing.stop();
      this.tasks.delete(jobId);
    }
  }

  // ── System action registry ──

  registerSystemAction(action: SystemAction): void {
    this.systemActions.set(action.name, action);
    logger.info('registered cron system action', { component: 'cron', action: action.name });
  }

  getSystemActions(): SystemAction[] {
    return [...this.systemActions.values()];
  }

  // ── Execute a job ──

  /**
   * Run a job. Called by the node-cron callback (triggeredBy=schedule) or
   * by the run-now API (triggeredBy=manual).
   */
  async executeJob(job: CronJob, triggeredBy: 'schedule' | 'manual'): Promise<void> {
    const jobId = String(job._id);

    // Skip if already in-flight (prevents overlap if a job runs longer than its interval)
    if (this.inFlight.has(jobId)) {
      logger.info('skipping cron job - previous run in progress', { component: 'cron', jobName: job.name });
      return;
    }

    // Atomic claim in DB
    const { ObjectId } = await import('mongodb');
    const claim = await this.jobs.updateOne(
      { _id: job._id, runStatus: { $ne: 'running' } },
      { $set: { runStatus: 'running' } },
    );
    if (claim.modifiedCount === 0) return;

    this.inFlight.add(jobId);

    const runStartMs = Date.now();
    const runId = new ObjectId();
    let status: CronRunStatus = 'running';
    let executionId: string | undefined;
    let error: string | undefined;
    let notes: string | undefined;

    // Insert the cron_runs row immediately (so the UI can show "running")
    await this.runs.insertOne({
      _id: runId,
      cronJobId: job._id!,
      cronJobName: job.name,
      startedAt: new Date(),
      completedAt: null,
      status: 'running',
      triggeredBy,
    });

    try {
      const result = await this.dispatch(job);
      executionId = result.executionId;
      notes = result.notes;
      status = result.status;
    } catch (err) {
      status = 'failed';
      error = (err as Error).message ?? String(err);
    }

    const durationMs = Date.now() - runStartMs;

    // Finalize the cron_runs row
    await this.runs.updateOne(
      { _id: runId },
      {
        $set: {
          status,
          error,
          executionId,
          notes,
          durationMs,
          completedAt: new Date(),
        },
      },
    );

    // Update the cron_jobs row
    const nextRunAt = computeNextRun(job.schedule, job.timezone);
    await this.jobs.updateOne(
      { _id: job._id },
      {
        $set: {
          lastRunAt: new Date(),
          lastRunStatus: status,
          lastRunError: error ?? null,
          lastRunExecutionId: executionId ?? null,
          nextRunAt,
          runStatus: 'idle',
          updatedAt: new Date(),
        },
        $inc: { runCount: 1 },
      },
    );

    this.inFlight.delete(jobId);
  }

  // ── Dispatcher ──

  private async dispatch(job: CronJob): Promise<{
    executionId?: string;
    notes?: string;
    status: CronRunStatus;
  }> {
    const { target } = job;

    switch (target.type) {
      case 'agent':
        return this.dispatchAgent(target, job.name);

      case 'workflow':
        return this.dispatchWorkflow(target, job.name);

      case 'system':
        return this.dispatchSystem(target);

      default:
        throw new Error(`Unknown target type: ${(target as any).type}`);
    }
  }

  private async dispatchAgent(
    target: Extract<CronJob['target'], { type: 'agent' }>,
    jobName: string,
  ): Promise<{ executionId?: string; notes?: string; status: CronRunStatus }> {
    const url = `http://localhost:${PORT}/api/chat/spawn-agent`;
    const res = await fetch(url, {
      method: 'POST',
      headers: buildInternalApiHeaders(),
      body: JSON.stringify({
        agent_name: target.agentName,
        prompt: target.prompt,
        repo_path: target.repoPath,
      }),
    });
    const data = (await res.json()) as Record<string, unknown>;
    if (!res.ok || data.error) {
      throw new Error(String(data.error ?? `HTTP ${res.status}`));
    }
    return {
      executionId: data.execution_id as string | undefined,
      notes: `Spawned agent "${target.agentName}" via cron:${jobName}`,
      status: 'success',
    };
  }

  private async dispatchWorkflow(
    target: Extract<CronJob['target'], { type: 'workflow' }>,
    jobName: string,
  ): Promise<{ executionId?: string; notes?: string; status: CronRunStatus }> {
    const wfDoc = await this.db.collection('workflows').findOne({ 'parsed.name': target.workflowName });
    if (!wfDoc) throw new Error(`Workflow "${target.workflowName}" not found`);

    const url = `http://localhost:${PORT}/api/executions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: buildInternalApiHeaders(),
      body: JSON.stringify({
        workflowId: String(wfDoc._id),
        input: target.workflowInput ?? {},
      }),
    });
    const data = (await res.json()) as Record<string, unknown>;
    if (!res.ok || data.error) {
      throw new Error(String(data.error ?? `HTTP ${res.status}`));
    }
    return {
      executionId: (data.id as string) ?? undefined,
      notes: `Triggered workflow "${target.workflowName}" via cron:${jobName}`,
      status: 'success',
    };
  }

  private async dispatchSystem(
    target: Extract<CronJob['target'], { type: 'system' }>,
  ): Promise<{ executionId?: string; notes?: string; status: CronRunStatus }> {
    const handler = this.systemActions.get(target.systemAction);
    if (!handler) throw new Error(`Unknown system action: ${target.systemAction}`);

    const notes = await handler.run(target.systemArgs);
    return { notes, status: 'success' };
  }

  // ── Helpers ──

  /** On startup, reset any rows left as 'running' from a previous crash. */
  private async recoverStaleRuns(): Promise<void> {
    const updated = await this.jobs.updateMany(
      { runStatus: 'running' },
      { $set: { runStatus: 'idle', lastRunStatus: 'failed', lastRunError: 'Interrupted by server restart' } },
    );
    if (updated.modifiedCount > 0) {
      logger.warn('recovered stale cron jobs from crash', { component: 'cron', count: updated.modifiedCount });
    }
    await this.runs.updateMany(
      { status: 'running' },
      { $set: { status: 'failed', error: 'Interrupted by server restart', completedAt: new Date() } },
    );
  }
}

/** Compute the next occurrence of a cron expression from now (for UI display). */
export function computeNextRun(schedule: string, timezone = 'UTC'): Date | null {
  try {
    const interval = CronExpressionParser.parse(schedule, { tz: timezone });
    return interval.next().toDate();
  } catch {
    return null;
  }
}

/** Validate a cron expression. Returns an error message or null if valid. */
export function validateCronExpression(schedule: string, timezone = 'UTC'): string | null {
  try {
    // Validate with node-cron (the runtime)
    if (!cron.validate(schedule)) return 'Invalid cron expression';
    // Also validate with cron-parser (for nextRunAt computation)
    CronExpressionParser.parse(schedule, { tz: timezone });
    return null;
  } catch (err) {
    return (err as Error).message ?? 'Invalid cron expression';
  }
}
