/**
 * Cost-singularity migration.
 *
 * Enforces the "store single" invariant on historical data:
 *   1. Workflow-type node traces used to store a COPY of their child
 *      workflow's total cost/tokens (the same dollars also live on the child
 *      execution's own traces). Zero them and mark method='child_execution'
 *      so trace sums count each LLM run exactly once.
 *   2. Execution rows used to store rolled-up cost/tokenUsage. New code
 *      neither writes nor reads them — move the old values aside (legacyCost
 *      / legacyTokenUsage) so the live fields are gone but nothing is lost.
 *
 * Idempotent: both filters exclude already-migrated documents. Originals are
 * preserved under legacy* fields for audit/rollback.
 *
 * Usage:
 *   node dist/scripts/migrate-cost-singularity.js           # dry run (default)
 *   node dist/scripts/migrate-cost-singularity.js --apply   # apply
 */
import dotenv from 'dotenv';
import { connectDB, disconnectDB } from '../database/mongo.js';

dotenv.config();

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const db = await connectDB();

  // ── 1. Workflow-node traces carrying duplicated child totals ──────────────
  const traceFilter = {
    type: 'workflow',
    'cost.method': { $ne: 'child_execution' },
  };
  const traceCount = await db.collection('execution_traces').countDocuments(traceFilter);

  // ── 2. Execution rows still carrying stored rollups ───────────────────────
  const execFilter = {
    $or: [{ cost: { $exists: true } }, { tokenUsage: { $exists: true } }],
  };
  const execCount = await db.collection('executions').countDocuments(execFilter);

  console.log(`[migrate-cost-singularity] mode=${apply ? 'APPLY' : 'dry-run'}`);
  console.log(`  workflow-node traces to zero: ${traceCount}`);
  console.log(`  execution rows to strip:      ${execCount}`);

  if (apply) {
    if (traceCount > 0) {
      const res = await db.collection('execution_traces').updateMany(traceFilter, [
        {
          $set: {
            legacyCost: '$cost',
            legacyTokenUsage: '$tokenUsage',
            cost: { actual: null, estimated: 0, method: 'child_execution' },
            tokenUsage: null,
          },
        },
      ]);
      console.log(`  traces zeroed: ${res.modifiedCount}`);
    }
    if (execCount > 0) {
      const res = await db.collection('executions').updateMany(execFilter, [
        { $set: { legacyCost: '$cost', legacyTokenUsage: '$tokenUsage' } },
        { $unset: ['cost', 'tokenUsage'] },
      ]);
      console.log(`  execution rows stripped: ${res.modifiedCount}`);
    }
    console.log('[migrate-cost-singularity] done.');
  } else {
    console.log('[migrate-cost-singularity] dry run only — re-run with --apply to migrate.');
  }

  await disconnectDB();
}

main().catch((err) => {
  console.error('[migrate-cost-singularity] failed:', err);
  process.exit(1);
});
