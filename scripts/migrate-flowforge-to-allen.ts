/**
 * One-shot migration: FlowForge → Allen
 *
 * Run ONCE on the deployed box AFTER you've:
 *   1. mongodump'd the old `flowforge` database and mongorestore'd it as `allen`
 *   2. Deployed the new code (the server has NOT yet been restarted)
 *
 * What this script does:
 *   A. Moves ~/.flowforge/ → ~/.allen/ (or $ALLEN_HOME if set)
 *      - If both exist, bails — you resolve manually.
 *      - Runs `git worktree repair` in each repo under repositories/ so existing
 *        worktrees under workspaces/ keep pointing at the right parent.
 *   B. Renames every document in the `secrets` collection whose `name`
 *      starts with `FLOWFORGE_` to `ALLEN_`. The encrypted payload is NOT
 *      changed — the master key bytes are the same, just stored at a new
 *      file path.
 *   C. Rewrites any stored `path` fields in the `repos` and `workspaces`
 *      collections that still reference /old/.flowforge/ to the new root.
 *
 * What this script does NOT do (you must handle manually):
 *   - `codex mcp remove flowforge` — run once on the EC2 box so the old
 *     Codex MCP registration is cleaned up before the new server registers
 *     the `allen` MCP on boot.
 *   - Terraform `terraform state mv` for renamed AWS resources (cert, DNS,
 *     ALB target group, listener rule). See docs/plans/aws-deployment-allen.md.
 *   - Route53 zone creation for allen.inomy.ai — new TLD, you need to own it
 *     and add the NS records with your registrar.
 *
 * Usage:
 *   MONGODB_URI=mongodb://localhost:27017/allen \
 *     npx tsx scripts/migrate-flowforge-to-allen.ts
 *
 * Dry-run (reports what would change without touching anything):
 *   DRY_RUN=1 npx tsx scripts/migrate-flowforge-to-allen.ts
 */

import { MongoClient } from 'mongodb';
import { existsSync, renameSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

const DRY = process.env.DRY_RUN === '1';
const log = (msg: string) => console.log(`${DRY ? '[dry-run] ' : ''}${msg}`);
const err = (msg: string) => console.error(`[error] ${msg}`);

// ──────────────────────────────────────────────────────────────────────
// A. Rename on-disk directory
// ──────────────────────────────────────────────────────────────────────

function migrateOnDisk(): { oldRoot: string; newRoot: string } | null {
  const home = homedir();
  const oldRoot = join(home, '.flowforge');
  const newRoot = process.env.ALLEN_HOME || join(home, '.allen');

  if (!existsSync(oldRoot)) {
    log(`A. No ${oldRoot} to migrate — skipping disk rename.`);
    return null;
  }
  if (existsSync(newRoot)) {
    err(`Both ${oldRoot} and ${newRoot} exist. Merge or remove one manually, then re-run.`);
    process.exit(1);
  }

  log(`A. Renaming ${oldRoot} → ${newRoot}`);
  if (!DRY) renameSync(oldRoot, newRoot);
  return { oldRoot, newRoot };
}

function repairWorktrees(newRoot: string): void {
  const reposDir = join(newRoot, 'repositories');
  if (!existsSync(reposDir)) {
    log('   No repositories/ subdir — skipping `git worktree repair`.');
    return;
  }
  for (const entry of readdirSync(reposDir)) {
    const repoPath = join(reposDir, entry);
    if (!statSync(repoPath).isDirectory()) continue;
    const gitDir = join(repoPath, '.git');
    if (!existsSync(gitDir)) continue;

    log(`   Running \`git worktree repair\` in ${repoPath}`);
    if (!DRY) {
      try {
        execFileSync('git', ['worktree', 'repair'], { cwd: repoPath, stdio: 'inherit' });
      } catch (e) {
        err(`   git worktree repair failed in ${repoPath}: ${(e as Error).message}`);
      }
    }
  }
}

// ──────────────────────────────────────────────────────────────────────
// B+C. Mongo rewrites
// ──────────────────────────────────────────────────────────────────────

async function migrateMongo(oldRoot: string | null, newRoot: string | null): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    err('MONGODB_URI not set. Aborting Mongo migration.');
    process.exit(1);
  }
  const client = new MongoClient(uri);
  await client.connect();
  try {
    const db = client.db();
    log(`B. Connected to ${db.databaseName}. Renaming FLOWFORGE_* secrets → ALLEN_*`);

    // B. Rename secrets
    const secrets = db.collection('secrets');
    const flowforgeSecrets = await secrets.find({ name: { $regex: /^FLOWFORGE_/ } }).toArray();
    log(`   Found ${flowforgeSecrets.length} secrets with FLOWFORGE_ prefix`);
    for (const doc of flowforgeSecrets) {
      const oldName = doc.name as string;
      const newName = oldName.replace(/^FLOWFORGE_/, 'ALLEN_');
      const exists = await secrets.findOne({ name: newName });
      if (exists) {
        err(`   Skipping ${oldName}: ${newName} already exists. Reconcile manually.`);
        continue;
      }
      log(`   ${oldName} → ${newName}`);
      if (!DRY) {
        await secrets.updateOne({ _id: doc._id }, { $set: { name: newName } });
      }
    }

    // C. Rewrite stored paths in repos and workspaces if disk moved
    if (oldRoot && newRoot) {
      log(`C. Rewriting stored paths: ${oldRoot} → ${newRoot}`);
      for (const collName of ['repos', 'workspaces']) {
        const col = db.collection(collName);
        const docs = await col.find({
          $or: [
            { path: { $regex: `^${escapeRegex(oldRoot)}` } },
            { worktreePath: { $regex: `^${escapeRegex(oldRoot)}` } },
            { repoPath: { $regex: `^${escapeRegex(oldRoot)}` } },
          ],
        }).toArray();
        log(`   ${collName}: ${docs.length} document(s) reference the old path`);
        for (const doc of docs) {
          const updates: Record<string, string> = {};
          for (const field of ['path', 'worktreePath', 'repoPath']) {
            const v = doc[field];
            if (typeof v === 'string' && v.startsWith(oldRoot)) {
              updates[field] = newRoot + v.slice(oldRoot.length);
            }
          }
          log(`   ${collName}/${doc._id}: ${JSON.stringify(updates)}`);
          if (!DRY && Object.keys(updates).length > 0) {
            await col.updateOne({ _id: doc._id }, { $set: updates });
          }
        }
      }
    }
  } finally {
    await client.close();
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ──────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log('=== FlowForge → Allen migration ===');
  log(DRY ? 'DRY RUN — no changes will be written.' : 'LIVE RUN — changes will be persisted.');
  log('');

  const moved = migrateOnDisk();
  if (moved && !DRY) repairWorktrees(moved.newRoot);

  await migrateMongo(moved?.oldRoot ?? null, moved?.newRoot ?? null);

  log('');
  log('=== Migration complete ===');
  log('Next steps (do these manually):');
  log('  1. codex mcp remove flowforge        # cleanup old MCP registration');
  log('  2. restart the allen server');
  log('  3. terraform state mv (see README / docs/plans/aws-deployment-allen.md)');
}

main().catch(e => {
  err((e as Error).stack || (e as Error).message);
  process.exit(1);
});
