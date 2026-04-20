/**
 * One-way sync of `teams`, `agents`, `users`, and `learnings` collections
 * from a source DocumentDB to a destination one. Inserts only what's missing
 * in the destination (matched per-collection by a business key). Existing
 * docs in the destination are NEVER modified — this is strictly additive.
 *
 * Dedup keys per collection:
 *   teams     → `name`   (unique slug)
 *   agents    → `name`   (unique slug)
 *   users     → `email`  (unique business key; _id would not match across DBs)
 *   learnings → `_id`    (no natural key; ObjectId preservation is the dedup)
 *
 * Designed to run LOCALLY on your Mac against DocumentDB via an SSM
 * port-forwarding tunnel. Both URIs point at `localhost:27027` and SSM
 * bridges that to the real DocDB cluster inside the EC2's VPC.
 *
 * ── Prerequisites ──────────────────────────────────────────────────────
 *
 * 1. Download the DocumentDB CA bundle to your Mac (one-time):
 *
 *    curl -o ~/rds-combined-ca-bundle.pem \
 *      https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
 *
 * 2. Find your DocumentDB cluster endpoint:
 *
 *    aws docdb describe-db-clusters \
 *      --query 'DBClusters[].{id:DBClusterIdentifier,endpoint:Endpoint}' \
 *      --output table
 *
 * 3. Open an SSM port-forwarding tunnel in a separate terminal and leave
 *    it running while you run this script:
 *
 *    aws ssm start-session \
 *      --target i-086efc3e8ad92eb7f \
 *      --document-name AWS-StartPortForwardingSessionToRemoteHost \
 *      --parameters host="<docdb-endpoint>",portNumber="27027",localPortNumber="27027"
 *
 * 4. Update SOURCE_URI + DEST_URI below with your actual DocDB credentials
 *    (grab them from the EC2: `sudo grep MONGODB_URI /home/ubuntu/allen/.env.production`).
 *
 * 5. Run:
 *
 *    DRY_RUN=1 npx tsx scripts/sync-teams-and-agents.ts   # dry run
 *    npx tsx scripts/sync-teams-and-agents.ts             # live
 *
 *    Or restrict to specific collections:
 *
 *    ONLY=users,learnings npx tsx scripts/sync-teams-and-agents.ts
 *
 * ── URI notes for SSM-tunneled DocumentDB ──────────────────────────────
 *
 *   tls=true                        — required, DocumentDB always uses TLS
 *   tlsAllowInvalidHostnames=true   — required, cert is for real DocDB
 *                                     hostname, not `localhost`
 *   directConnection=true           — required, stops the driver from
 *                                     trying to discover replica-set
 *                                     members via their real hostnames
 *                                     (which don't resolve on your Mac)
 *   retryWrites=false               — required, DocumentDB doesn't
 *                                     support retryable writes
 */

import { MongoClient, type Document, type MongoClientOptions } from 'mongodb';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ── EDIT THESE ──────────────────────────────────────────────────────
const SOURCE_URI = '';
const DEST_URI   = '';

// Path to the RDS CA bundle on your Mac. Default: ~/rds-combined-ca-bundle.pem
const TLS_CA_FILE = join(homedir(), 'rds-combined-ca-bundle.pem');
// ────────────────────────────────────────────────────────────────────

function clientOptions(uri: string): MongoClientOptions {
  const opts: MongoClientOptions = {};
  if (/[?&]tls=true\b/i.test(uri) && !/[?&]tlsCAFile=/i.test(uri) && TLS_CA_FILE) {
    opts.tlsCAFile = TLS_CA_FILE;
  }
  return opts;
}

const DRY = process.env.DRY_RUN === '1';
const ONLY = (process.env.ONLY ?? '').split(',').map(s => s.trim()).filter(Boolean);

interface SyncConfig {
  collName: string;
  /** Business key used for dedup. '_id' means "preserve source _id and skip
   *  if that _id already exists in dest". */
  matchField: '_id' | 'name' | 'email';
  /** Produces a short human-readable label for console output. */
  label: (doc: Document) => string;
}

const SYNC_PLAN: SyncConfig[] = [
  { collName: 'teams',     matchField: 'name',  label: d => String(d.name ?? d._id) },
  { collName: 'agents',    matchField: 'name',  label: d => String(d.name ?? d._id) },
  { collName: 'users',     matchField: 'email', label: d => String(d.email ?? d._id) },
  { collName: 'learnings', matchField: '_id',   label: d => {
      const content = typeof d.content === 'string' ? (d.content as string) : '';
      const preview = content.length > 60 ? content.slice(0, 60) + '…' : content;
      const tag = d.type ? `[${String(d.type)}] ` : '';
      return `${tag}${preview || String(d._id)}`;
    } },
];

interface SyncResult {
  inserted: string[];
  skipped: string[];
}

async function syncCollection(
  srcClient: MongoClient,
  dstClient: MongoClient,
  cfg: SyncConfig,
): Promise<SyncResult> {
  const src = srcClient.db().collection(cfg.collName);
  const dst = dstClient.db().collection(cfg.collName);

  // Read the full set of existing keys in the destination up-front so we
  // check inclusion without a per-doc round trip.
  const existingKeys = new Set<string>();
  const projection: Record<string, number> = { [cfg.matchField]: 1 };
  for await (const doc of dst.find({}, { projection })) {
    const key = keyOf(doc as Document, cfg.matchField);
    if (key != null) existingKeys.add(key);
  }

  const inserted: string[] = [];
  const skipped: string[] = [];

  for await (const doc of src.find({})) {
    const key = keyOf(doc as Document, cfg.matchField);
    if (key == null) {
      console.warn(`  [${cfg.collName}] skipping doc with missing/invalid ${cfg.matchField}:`, doc._id);
      continue;
    }

    if (existingKeys.has(key)) {
      skipped.push(cfg.label(doc as Document));
      continue;
    }

    if (!DRY) {
      // Preserve _id so any cross-collection references by ObjectId still
      // resolve. On _id collision with an unrelated dest doc (very
      // unlikely — the keys set just said "missing"), fall back to a
      // fresh _id so the doc still lands.
      try {
        await dst.insertOne(doc);
      } catch (err: unknown) {
        const msg = (err as Error).message;
        if (msg.includes('duplicate key')) {
          const { _id, ...rest } = doc as Record<string, unknown>;
          await dst.insertOne(rest as Document);
        } else {
          throw err;
        }
      }
    }
    inserted.push(cfg.label(doc as Document));
    existingKeys.add(key);
  }

  return { inserted, skipped };
}

/** Extract the dedup key from a document as a string. Returns null for
 *  missing / wrong-type values so the caller can skip them cleanly. */
function keyOf(doc: Document, field: '_id' | 'name' | 'email'): string | null {
  const v = (doc as Record<string, unknown>)[field];
  if (v == null) return null;
  // ObjectId / Date / nested object → use toString() canonical form
  if (typeof v === 'object') return String(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

async function main(): Promise<void> {
  const plan = ONLY.length > 0 ? SYNC_PLAN.filter(c => ONLY.includes(c.collName)) : SYNC_PLAN;
  if (plan.length === 0) {
    console.error(`No collections selected. ONLY filter "${ONLY.join(',')}" matched nothing.`);
    console.error(`Available: ${SYNC_PLAN.map(c => c.collName).join(', ')}`);
    process.exit(1);
  }

  console.log(`=== sync: ${plan.map(c => c.collName).join(' + ')} ===`);
  console.log(`source: ${SOURCE_URI}`);
  console.log(`dest:   ${DEST_URI}`);
  console.log(`mode:   ${DRY ? 'DRY RUN' : 'LIVE (additive only — nothing in dest will be modified)'}`);
  console.log('');

  const src = new MongoClient(SOURCE_URI, clientOptions(SOURCE_URI));
  const dst = new MongoClient(DEST_URI, clientOptions(DEST_URI));
  await Promise.all([src.connect(), dst.connect()]);

  try {
    console.log(`source db: ${src.db().databaseName}`);
    console.log(`dest db:   ${dst.db().databaseName}`);
    console.log('');

    let totalInserted = 0;
    let totalSkipped = 0;

    for (const cfg of plan) {
      console.log(`─── ${cfg.collName} (dedup by ${cfg.matchField}) ───`);
      const result = await syncCollection(src, dst, cfg);
      console.log(`  inserted: ${result.inserted.length}`);
      for (const n of result.inserted) console.log(`    + ${n}`);
      console.log(`  already in dest (skipped): ${result.skipped.length}`);
      if (result.skipped.length > 0 && result.skipped.length <= 20) {
        for (const n of result.skipped) console.log(`    ~ ${n}`);
      }
      console.log('');
      totalInserted += result.inserted.length;
      totalSkipped += result.skipped.length;
    }

    console.log('=== Summary ===');
    console.log(`  Collections synced: ${plan.length}`);
    console.log(`  Inserted:           ${totalInserted}`);
    console.log(`  Skipped (existing): ${totalSkipped}`);
    console.log(DRY ? '(dry run — nothing was written)' : 'Done.');
  } finally {
    await Promise.allSettled([src.close(), dst.close()]);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
