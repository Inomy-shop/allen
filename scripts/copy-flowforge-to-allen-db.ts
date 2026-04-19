/**
 * Copy every collection + document from the `flowforge` database to the
 * `allen` database, with the transformations needed so the renamed code
 * can read the data correctly:
 *
 *   1. In the `secrets` collection, rename each document's `name` field
 *      from `FLOWFORGE_*` → `ALLEN_*`. Encrypted payload is untouched
 *      (the master-key bytes didn't change, just the file path).
 *
 *   2. In every string field across every document, rewrite path
 *      fragments `/.flowforge/` → `/.allen/` (and `/var/lib/flowforge`,
 *      `/tmp/flowforge`) so stored repo / workspace paths match the
 *      new on-disk layout. Only the dot-directory form is touched — a
 *      project folder literally named `flowforge` is NOT renamed.
 *
 * Usage: fill SOURCE_URI / DEST_URI below and run:
 *
 *   npx tsx scripts/copy-flowforge-to-allen-db.ts
 *
 * Flags (env vars):
 *   DRY_RUN=1    — report what would be copied; write nothing.
 *   DROP_DEST=1  — drop each dest collection before writing (clean copy).
 *                  Safe only if `allen` DB hasn't been populated yet.
 */

import { MongoClient, type Document, type Collection } from 'mongodb';

// ── EDIT THESE ──────────────────────────────────────────────────────
const SOURCE_URI = 'mongodb://localhost:27017/flowforge';
const DEST_URI   = 'mongodb://localhost:27017/allen';
// ────────────────────────────────────────────────────────────────────

const DRY = process.env.DRY_RUN === '1';
const DROP_DEST = process.env.DROP_DEST === '1';
const BATCH_SIZE = 500;

/** Rewrite `.flowforge` / `/var/lib/flowforge` / `/tmp/flowforge` path fragments
 *  on a single string. Leaves plain `flowforge` (without a leading `/` or `.`)
 *  alone so project directories named `flowforge` survive. */
function rewritePathString(s: string): string {
  return s
    .replace(/\/\.flowforge(?=\/|$)/g, '/.allen')
    .replace(/\/var\/lib\/flowforge(?=\/|$)/g, '/var/lib/allen')
    .replace(/\/tmp\/flowforge(?=\/|$)/g, '/tmp/allen');
}

/** Walk an object tree in place, rewriting strings and counting path rewrites. */
function rewriteInPlace(node: unknown, counters: { paths: number }): void {
  if (node === null || typeof node !== 'object') return;
  // Skip Buffer / BSON binary / Date / ObjectId / RegExp — they aren't plain objects.
  // We only want to descend into plain arrays and plain objects.
  const proto = Object.getPrototypeOf(node);
  if (proto !== Object.prototype && !Array.isArray(node)) return;

  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const v = node[i];
      if (typeof v === 'string') {
        const next = rewritePathString(v);
        if (next !== v) { node[i] = next; counters.paths++; }
      } else {
        rewriteInPlace(v, counters);
      }
    }
    return;
  }

  const obj = node as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (typeof v === 'string') {
      const next = rewritePathString(v);
      if (next !== v) { obj[key] = next; counters.paths++; }
    } else {
      rewriteInPlace(v, counters);
    }
  }
}

async function flush(col: Collection, docs: Document[]): Promise<void> {
  // upsert by _id so re-running is safe (doesn't create duplicates).
  const ops = docs.map(doc => ({
    replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true },
  }));
  await col.bulkWrite(ops, { ordered: false });
}

async function main(): Promise<void> {
  console.log('=== flowforge → allen DB copy ===');
  console.log(`source: ${SOURCE_URI}`);
  console.log(`dest:   ${DEST_URI}`);
  console.log(`mode:   ${DRY ? 'DRY RUN' : 'LIVE'}${DROP_DEST ? ' + DROP_DEST' : ''}`);
  console.log('');

  const src = new MongoClient(SOURCE_URI);
  const dst = new MongoClient(DEST_URI);
  await Promise.all([src.connect(), dst.connect()]);

  try {
    const srcDb = src.db();
    const dstDb = dst.db();
    console.log(`source db: ${srcDb.databaseName}`);
    console.log(`dest db:   ${dstDb.databaseName}`);
    console.log('');

    const colls = await srcDb.listCollections({}, { nameOnly: true }).toArray();
    const userColls = colls.filter(c => !c.name.startsWith('system.'));
    console.log(`Found ${userColls.length} collection(s)`);
    console.log('');

    let totalDocs = 0;
    let totalSecretsRenamed = 0;
    let totalPathsRewritten = 0;

    for (const { name } of userColls) {
      const srcCol = srcDb.collection(name);
      const dstCol = dstDb.collection(name);
      const count = await srcCol.countDocuments();
      console.log(`• ${name.padEnd(30)} ${count.toString().padStart(6)} doc(s)`);

      if (DROP_DEST && !DRY) {
        await dstCol.drop().catch(() => {}); // ignore "ns not found"
      }
      if (count === 0) continue;

      let localSecretsRenamed = 0;
      let localPathCountersTotal = 0;
      let buffer: Document[] = [];

      for await (const doc of srcCol.find({})) {
        // Transformation 1: rename FLOWFORGE_* → ALLEN_* in secrets.name
        if (name === 'secrets' && typeof (doc as any).name === 'string' &&
            (doc as any).name.startsWith('FLOWFORGE_')) {
          (doc as any).name = (doc as any).name.replace(/^FLOWFORGE_/, 'ALLEN_');
          localSecretsRenamed++;
        }
        // Transformation 2: rewrite .flowforge / /var/lib/flowforge / /tmp/flowforge paths
        const counters = { paths: 0 };
        rewriteInPlace(doc, counters);
        localPathCountersTotal += counters.paths;

        buffer.push(doc);
        if (buffer.length >= BATCH_SIZE) {
          if (!DRY) await flush(dstCol, buffer);
          buffer = [];
        }
      }
      if (buffer.length > 0 && !DRY) await flush(dstCol, buffer);

      totalDocs += count;
      totalSecretsRenamed += localSecretsRenamed;
      totalPathsRewritten += localPathCountersTotal;
      if (localSecretsRenamed > 0) console.log(`    ↳ ${localSecretsRenamed} FLOWFORGE_* → ALLEN_*`);
      if (localPathCountersTotal > 0) console.log(`    ↳ ${localPathCountersTotal} path string(s) rewritten`);
    }

    console.log('');
    console.log('=== Summary ===');
    console.log(`Collections:      ${userColls.length}`);
    console.log(`Documents copied: ${totalDocs}`);
    console.log(`Secrets renamed:  ${totalSecretsRenamed}`);
    console.log(`Path strings:     ${totalPathsRewritten}`);
    console.log(DRY ? '(dry run — nothing was written)' : 'Done.');
  } finally {
    await Promise.allSettled([src.close(), dst.close()]);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
