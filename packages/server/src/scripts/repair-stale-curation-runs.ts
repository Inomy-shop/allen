import dotenv from 'dotenv';
import { connectDB, disconnectDB } from '../database/mongo.js';

dotenv.config();

const STALE_RUNNING_MS = 12 * 60 * 60 * 1000;

type Options = {
  apply: boolean;
};

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const db = await connectDB();
  try {
    const runningProfiles = await db.collection('repo_context_curation_profiles')
      .find({ status: 'running' }, { sort: { createdAt: -1 } })
      .toArray();
    const staleProfiles = [];
    const activeProfiles = [];

    for (const profile of runningProfiles) {
      const executionId = stringValue(profile.executionId);
      const execution = executionId
        ? await db.collection('executions').findOne(
          { id: executionId },
          { projection: { id: 1, status: 1, updatedAt: 1, startedAt: 1, createdAt: 1, completedAt: 1 } },
        )
        : null;
      const active = isActive(profile, execution);
      const record = {
        profileId: profile.profileId,
        repoId: profile.repoId,
        executionId,
        executionStatus: execution?.status,
        profileUpdatedAt: profile.updatedAt,
        executionUpdatedAt: execution?.updatedAt,
      };
      if (active) activeProfiles.push(record);
      else staleProfiles.push(record);
    }

    let modifiedProfiles = 0;
    let modifiedRuns = 0;
    if (options.apply && staleProfiles.length) {
      const now = new Date();
      const message = 'Context curation was interrupted or abandoned; latest completed profile is authoritative.';
      const profileIds = staleProfiles.map((item) => item.profileId).filter(Boolean);
      const executionIds = staleProfiles.map((item) => item.executionId).filter(Boolean);
      const profileResult = await db.collection('repo_context_curation_profiles').updateMany(
        { profileId: { $in: profileIds }, status: 'running' },
        { $set: { status: 'stopped', message, completedAt: now, updatedAt: now } },
      );
      modifiedProfiles = profileResult.modifiedCount;
      if (executionIds.length) {
        const runResult = await db.collection('repo_context_curation_runs').updateMany(
          { executionId: { $in: executionIds }, status: 'running' },
          { $set: { status: 'stopped', message, completedAt: now, updatedAt: now } },
        );
        modifiedRuns = runResult.modifiedCount;
      }
    }

    console.log(JSON.stringify({
      mode: options.apply ? 'apply' : 'dry-run',
      staleThresholdHours: STALE_RUNNING_MS / 60 / 60 / 1000,
      runningProfiles: runningProfiles.length,
      activeProfiles,
      staleProfiles,
      modifiedProfiles,
      modifiedRuns,
    }, null, 2));
  } finally {
    await disconnectDB();
  }
}

function isActive(profile: Record<string, unknown>, execution: Record<string, unknown> | null): boolean {
  if (!execution) return !isStaleDate(profile.updatedAt ?? profile.createdAt);
  if (execution.completedAt) return false;
  const status = String(execution.status ?? '');
  if (!['queued', 'running'].includes(status)) return false;
  return !isStaleDate(execution.updatedAt ?? execution.startedAt ?? execution.createdAt ?? profile.updatedAt ?? profile.createdAt);
}

function isStaleDate(value: unknown): boolean {
  const date = value instanceof Date ? value : typeof value === 'string' || typeof value === 'number' ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) return true;
  return Date.now() - date.getTime() > STALE_RUNNING_MS;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseOptions(args: string[]): Options {
  const unknown = args.filter((arg) => arg !== '--apply');
  if (unknown.length > 0) throw new Error(`Unknown option(s): ${unknown.join(', ')}`);
  return { apply: args.includes('--apply') };
}

main().catch(async (err) => {
  console.error(JSON.stringify({ error: (err as Error).message }, null, 2));
  await disconnectDB().catch(() => undefined);
  process.exitCode = 1;
});
