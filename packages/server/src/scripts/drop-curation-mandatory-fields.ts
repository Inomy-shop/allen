import dotenv from 'dotenv';
import type { Db } from 'mongodb';
import { connectDB, disconnectDB } from '../database/mongo.js';

dotenv.config();

const MANDATORY_ROLE_FIELDS = [
  'mandatoryForNodeRoles',
  'mandatoryForSpawnedAgentRoles',
  'mandatoryForSpawnerRoles',
] as const;

type Options = {
  apply: boolean;
};

type CleanupReport = {
  mode: 'dry-run' | 'apply';
  targetFields: string[];
  collections: Record<string, Record<string, unknown>>;
};

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const db = await connectDB();
  try {
    const report: CleanupReport = {
      mode: options.apply ? 'apply' : 'dry-run',
      targetFields: [...MANDATORY_ROLE_FIELDS, 'injectionPolicy=mandatory_full'],
      collections: {
        repo_context_curation_entries: await cleanupFinalEntries(db, options),
        repo_context_curation_profiles: await cleanupProfileEntries(db, options),
        repo_context_curation_stage_entries: await cleanupStageEntries(db, options),
      },
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await disconnectDB();
  }
}

async function cleanupFinalEntries(db: Db, options: Options): Promise<Record<string, unknown>> {
  const collection = db.collection('repo_context_curation_entries');
  const mandatoryQuery = existsAny(MANDATORY_ROLE_FIELDS);
  const policyQuery = { injectionPolicy: 'mandatory_full' };
  const report = {
    mandatoryFieldDocuments: await collection.countDocuments(mandatoryQuery),
    mandatoryPolicyDocuments: await collection.countDocuments(policyQuery),
    unsetModified: 0,
    policyModified: 0,
  };
  if (!options.apply) return report;
  const now = new Date();
  if (report.mandatoryFieldDocuments > 0) {
    const result = await collection.updateMany(
      mandatoryQuery,
      { $unset: unsetSpec(MANDATORY_ROLE_FIELDS), $set: { updatedAt: now } },
    );
    report.unsetModified = result.modifiedCount;
  }
  if (report.mandatoryPolicyDocuments > 0) {
    const result = await collection.updateMany(
      policyQuery,
      { $set: { injectionPolicy: 'snippet', updatedAt: now } },
    );
    report.policyModified = result.modifiedCount;
  }
  return report;
}

async function cleanupProfileEntries(db: Db, options: Options): Promise<Record<string, unknown>> {
  const collection = db.collection('repo_context_curation_profiles');
  const mandatoryQuery = existsAny(MANDATORY_ROLE_FIELDS.map((field) => `entries.${field}`));
  const policyQuery = { 'entries.injectionPolicy': 'mandatory_full' };
  const report = {
    mandatoryFieldDocuments: await collection.countDocuments(mandatoryQuery),
    mandatoryPolicyDocuments: await collection.countDocuments(policyQuery),
    unsetModified: 0,
    policyModified: 0,
  };
  if (!options.apply) return report;
  const now = new Date();
  if (report.mandatoryFieldDocuments > 0) {
    const result = await collection.updateMany(
      mandatoryQuery,
      {
        $unset: unsetSpec(MANDATORY_ROLE_FIELDS.map((field) => `entries.$[].${field}`)),
        $set: { updatedAt: now },
      },
    );
    report.unsetModified = result.modifiedCount;
  }
  if (report.mandatoryPolicyDocuments > 0) {
    const result = await collection.updateMany(
      policyQuery,
      { $set: { 'entries.$[entry].injectionPolicy': 'snippet', updatedAt: now } },
      { arrayFilters: [{ 'entry.injectionPolicy': 'mandatory_full' }] },
    );
    report.policyModified = result.modifiedCount;
  }
  return report;
}

async function cleanupStageEntries(db: Db, options: Options): Promise<Record<string, unknown>> {
  const collection = db.collection('repo_context_curation_stage_entries');
  const mandatoryQuery = existsAny(MANDATORY_ROLE_FIELDS.map((field) => `entry.${field}`));
  const policyQuery = { 'entry.injectionPolicy': 'mandatory_full' };
  const report = {
    mandatoryFieldDocuments: await collection.countDocuments(mandatoryQuery),
    mandatoryPolicyDocuments: await collection.countDocuments(policyQuery),
    unsetModified: 0,
    policyModified: 0,
  };
  if (!options.apply) return report;
  const now = new Date();
  if (report.mandatoryFieldDocuments > 0) {
    const result = await collection.updateMany(
      mandatoryQuery,
      { $unset: unsetSpec(MANDATORY_ROLE_FIELDS.map((field) => `entry.${field}`)), $set: { updatedAt: now } },
    );
    report.unsetModified = result.modifiedCount;
  }
  if (report.mandatoryPolicyDocuments > 0) {
    const result = await collection.updateMany(
      policyQuery,
      { $set: { 'entry.injectionPolicy': 'snippet', updatedAt: now } },
    );
    report.policyModified = result.modifiedCount;
  }
  return report;
}

function existsAny(fields: readonly string[]): Record<string, unknown> {
  return { $or: fields.map((field) => ({ [field]: { $exists: true } })) };
}

function unsetSpec(fields: readonly string[]): Record<string, ''> {
  return Object.fromEntries(fields.map((field) => [field, ''])) as Record<string, ''>;
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
