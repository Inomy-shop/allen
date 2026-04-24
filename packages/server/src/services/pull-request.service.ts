/**
 * Pull Request Service
 * Syncs PRs from GitHub via `gh` CLI, manages PR lifecycle.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Db, ObjectId } from 'mongodb';
import { buildGhEnv } from './github-auth.js';

const exec = promisify(execFile);

export interface PullRequest {
  _id?: ObjectId;
  repoId: string;
  repoName: string;
  repoPath: string;
  number: number;
  title: string;
  description: string;
  branch: string;
  baseBranch: string;
  status: 'open' | 'merged' | 'closed';
  author: string;
  url: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  labels: string[];
  createdByAgent?: string;
  chatSessionId?: string;
  workspaceId?: string;
  createdAt: Date;
  updatedAt: Date;
  mergedAt?: Date;
  // ── CodeRabbit resolution state ──────────────────────────────────
  /** true when this PR was created by an Allen workflow execution
   *  (vs. an external PR registered via a manual trigger). Controls
   *  whether the auto-sweep cron will pick it up. */
  createdByWorkflow?: boolean;
  /** The workflow execution that created this PR. Used to load the
   *  originating design docs / final summary as context for the
   *  review resolver. */
  originatingExecutionId?: string;
  /** GH comment IDs (review_comment.id as string) we've already
   *  acted on. Dedup key for the resolver — new runs skip these. */
  processedCommentIds?: string[];
  /** PR head SHA at the time of the last sync. Purely informational;
   *  do NOT use as a skip key — new comments can arrive on the same
   *  SHA. See processedCommentIds for the real dedup. */
  lastReviewedHeadSha?: string;
  /** When we last fetched CodeRabbit comments for this PR. Drives
   *  the 30-min per-PR cooldown on auto-sweep. */
  lastReviewSyncAt?: Date;
  /** Monotonic count of successful auto-apply+push rounds. Cap at 3
   *  before the sweep stops retrying. Reset on a human-authored
   *  commit newer than the last attempt. */
  resolutionAttempts?: number;
  /** Advisory lock — present while a resolution workflow is actively
   *  running against this PR. TTL via startedAt (30 min). */
  resolutionInProgress?: { startedAt: Date; executionId: string } | null;
}

/** Parse a GitHub PR URL into owner/repo/number.
 *  Accepts: https://github.com/<owner>/<repo>/pull/<number>  (+ optional suffix)  */
export function parseGhPrUrl(url: string): { owner: string; repo: string; number: number } | null {
  const m = url.trim().match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: parseInt(m[3], 10) };
}

export class PullRequestService {
  constructor(private db: Db) {}
  private get col() { return this.db.collection('pull_requests'); }

  async list(filters?: { repoId?: string; status?: string }): Promise<PullRequest[]> {
    const query: any = {};
    if (filters?.repoId) query.repoId = filters.repoId;
    if (filters?.status) query.status = filters.status;
    return this.col.find(query).sort({ updatedAt: -1 }).limit(100).toArray() as Promise<PullRequest[]>;
  }

  async get(id: string): Promise<PullRequest | null> {
    const { ObjectId } = await import('mongodb');
    return this.col.findOne({ _id: new ObjectId(id) }) as Promise<PullRequest | null>;
  }

  async getByNumber(repoId: string, number: number): Promise<PullRequest | null> {
    return this.col.findOne({ repoId, number }) as Promise<PullRequest | null>;
  }

  async syncFromGitHub(repoPath: string, repoId: string, repoName: string): Promise<{ synced: number; total: number }> {
    // Use gh CLI to list PRs (auth via stored secret if present, else local gh auth)
    const ghEnv = await buildGhEnv(this.db);
    let prList: any[];
    try {
      const { stdout } = await exec('gh', [
        'pr', 'list', '--json',
        'number,title,body,headRefName,baseRefName,state,author,url,additions,deletions,changedFiles,labels,createdAt,updatedAt,mergedAt',
        '--limit', '50',
        '--state', 'all',
      ], { cwd: repoPath, env: ghEnv });
      prList = JSON.parse(stdout);
    } catch (err: any) {
      throw new Error(`Failed to fetch PRs: ${err.message}`);
    }

    let synced = 0;
    for (const pr of prList) {
      const doc: Partial<PullRequest> = {
        repoId,
        repoName,
        repoPath,
        number: pr.number,
        title: pr.title,
        description: pr.body ?? '',
        branch: pr.headRefName,
        baseBranch: pr.baseRefName,
        status: pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : 'open',
        author: pr.author?.login ?? 'unknown',
        url: pr.url,
        additions: pr.additions ?? 0,
        deletions: pr.deletions ?? 0,
        changedFiles: pr.changedFiles ?? 0,
        labels: pr.labels?.map((l: any) => l.name) ?? [],
        updatedAt: new Date(pr.updatedAt),
        mergedAt: pr.mergedAt ? new Date(pr.mergedAt) : undefined,
      };

      const existing = await this.col.findOne({ repoId, number: pr.number });
      if (existing) {
        await this.col.updateOne({ _id: existing._id }, { $set: doc });
      } else {
        await this.col.insertOne({ ...doc, createdAt: new Date(pr.createdAt) });
      }
      synced++;
    }

    return { synced, total: prList.length };
  }

  async getDiff(repoPath: string, branch: string, baseBranch: string): Promise<{ diff: string; files: { path: string; diff: string; originalContent: string; modifiedContent: string }[] }> {
    try {
      await exec('git', ['fetch', 'origin', branch], { cwd: repoPath }).catch(() => {});
      await exec('git', ['fetch', 'origin', baseBranch], { cwd: repoPath }).catch(() => {});
      const { stdout } = await exec('git', ['diff', `origin/${baseBranch}...origin/${branch}`], { cwd: repoPath });
      const files: { path: string; diff: string; originalContent: string; modifiedContent: string }[] = [];
      const fileDiffs = stdout.split(/^diff --git /m).filter(Boolean);
      // Fetch full file contents at base and head so the UI's DiffEditor can
      // show real file-level diffs (not just hunks). Parallel for speed.
      const fileMeta = fileDiffs
        .map((fd) => ({ fd, match: fd.match(/a\/(.+?) b\//) }))
        .filter((x) => x.match)
        .map((x) => ({ fd: x.fd, path: x.match![1] }));
      const contents = await Promise.all(fileMeta.map(async ({ path }) => {
        const [orig, mod] = await Promise.all([
          exec('git', ['show', `origin/${baseBranch}:${path}`], { cwd: repoPath }).then(r => r.stdout).catch(() => ''),
          exec('git', ['show', `origin/${branch}:${path}`], { cwd: repoPath }).then(r => r.stdout).catch(() => ''),
        ]);
        return { path, originalContent: orig, modifiedContent: mod };
      }));
      for (let i = 0; i < fileMeta.length; i++) {
        const { fd, path } = fileMeta[i];
        const { originalContent, modifiedContent } = contents[i];
        files.push({ path, diff: 'diff --git ' + fd, originalContent, modifiedContent });
      }
      return { diff: stdout, files };
    } catch {
      return { diff: '', files: [] };
    }
  }

  async createPR(
    repoPath: string,
    repoId: string,
    repoName: string,
    branch: string,
    baseBranch: string,
    title: string,
    body: string,
  ): Promise<PullRequest> {
    // Push first (uses git's own credential helper, not gh)
    await exec('git', ['push', '-u', 'origin', branch], { cwd: repoPath });

    // Create via gh CLI (auth via stored secret if present, else local gh auth)
    const ghEnv = await buildGhEnv(this.db);
    const { stdout: createOut } = await exec('gh', [
      'pr', 'create',
      '--title', title,
      '--body', body,
      '--base', baseBranch,
      '--head', branch,
    ], { cwd: repoPath, env: ghEnv });

    // createOut is the PR URL, e.g. "https://github.com/user/repo/pull/42\n"
    const prUrl = createOut.trim();

    // Fetch PR details
    const { stdout: viewOut } = await exec('gh', [
      'pr', 'view', branch,
      '--json', 'number,url,additions,deletions,changedFiles',
    ], { cwd: repoPath, env: ghEnv });

    const result = JSON.parse(viewOut);
    if (!result.url) result.url = prUrl;
    const doc: PullRequest = {
      repoId,
      repoName,
      repoPath,
      number: result.number,
      title,
      description: body,
      branch,
      baseBranch,
      status: 'open',
      author: 'allen',
      url: result.url,
      additions: result.additions ?? 0,
      deletions: result.deletions ?? 0,
      changedFiles: result.changedFiles ?? 0,
      labels: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.col.insertOne(doc);
    return doc;
  }

  async linkWorkspace(prId: string, workspaceId: string): Promise<void> {
    const { ObjectId } = await import('mongodb');
    await this.col.updateOne({ _id: new ObjectId(prId) }, { $set: { workspaceId, updatedAt: new Date() } });
  }

  // ── CodeRabbit resolution support ────────────────────────────────

  /** Find a PR by its full GitHub URL (the primary identifier used by
   *  the resolve-pr-reviews workflow's entry point). */
  async findByPrUrl(url: string): Promise<PullRequest | null> {
    return this.col.findOne({ url }) as Promise<PullRequest | null>;
  }

  /** Given a PR URL, return the workspace that was used to create it
   *  (Flow A). Returns null if the PR isn't tracked or has no
   *  workspaceId yet — caller should fall back to Flow B
   *  (create-workspace-for-review) in that case. */
  async findWorkspaceByPrUrl(url: string): Promise<Record<string, unknown> | null> {
    const pr = await this.findByPrUrl(url);
    if (!pr?.workspaceId) return null;
    const { ObjectId } = await import('mongodb');
    try {
      return this.db.collection('workspaces').findOne({ _id: new ObjectId(pr.workspaceId) });
    } catch { return null; }
  }

  /** Given a PR URL, find the registered repo it belongs to. Used by
   *  Flow B to decide which repo to create a fresh workspace from.
   *  Returns null if the repo isn't registered in the `repos`
   *  collection — the caller should surface a "register the repo
   *  first" error to the user. */
  async identifyRepoForPrUrl(url: string): Promise<Record<string, unknown> | null> {
    const parsed = parseGhPrUrl(url);
    if (!parsed) return null;
    // Canonical SSH form used by repo.service.createFromUrl.
    const sshUrl = `git@github.com:${parsed.owner}/${parsed.repo}.git`;
    // Try exact SSH match first, then remoteUrl suffix match as a
    // backstop for repos imported via a different form.
    const exact = await this.db.collection('repos').findOne({ url: sshUrl });
    if (exact) return exact;
    const suffix = `${parsed.owner}/${parsed.repo}.git`;
    return this.db.collection('repos').findOne({
      $or: [
        { 'detected.remoteUrl': { $regex: `${suffix.replace(/\./g, '\\.')}$`, $options: 'i' } },
        { url: { $regex: `${suffix.replace(/\./g, '\\.')}$`, $options: 'i' } },
      ],
    });
  }

  /** Mark a successful CodeRabbit resolution pass:
   *   - appends the processed comment IDs
   *   - stamps lastReviewSyncAt + lastReviewedHeadSha
   *   - increments resolutionAttempts (capped by the sweep's filter) */
  async markReviewsSynced(
    prId: string,
    newlyProcessedCommentIds: string[],
    headSha: string,
  ): Promise<void> {
    const { ObjectId } = await import('mongodb');
    await this.col.updateOne(
      { _id: new ObjectId(prId) },
      {
        $set: { lastReviewSyncAt: new Date(), lastReviewedHeadSha: headSha, updatedAt: new Date() },
        $addToSet: { processedCommentIds: { $each: newlyProcessedCommentIds } },
        $inc: { resolutionAttempts: 1 },
      },
    );
  }

  /** Reset the attempt counter when a human (not 'Allen Agent')
   *  has pushed a newer commit than our last attempt. Keeps the cap
   *  from permanently locking out PRs that have had manual fixes. */
  async resetAttemptsOnHumanPush(prId: string): Promise<void> {
    const { ObjectId } = await import('mongodb');
    await this.col.updateOne(
      { _id: new ObjectId(prId) },
      { $set: { resolutionAttempts: 0, updatedAt: new Date() } },
    );
  }

  /** Acquire an advisory lock so two sweeps don't race on the same PR.
   *  Returns false if a live lock already exists (within 30-min TTL). */
  async acquireResolutionLock(prId: string, executionId: string): Promise<boolean> {
    const { ObjectId } = await import('mongodb');
    const STALE_MS = 30 * 60 * 1000;
    const now = new Date();
    const staleCutoff = new Date(now.getTime() - STALE_MS);
    // Succeed if no lock, or existing lock is stale.
    const result = await this.col.updateOne(
      {
        _id: new ObjectId(prId),
        $or: [
          { resolutionInProgress: null },
          { resolutionInProgress: { $exists: false } },
          { 'resolutionInProgress.startedAt': { $lt: staleCutoff } },
        ],
      },
      { $set: { resolutionInProgress: { startedAt: now, executionId }, updatedAt: now } },
    );
    return result.matchedCount === 1;
  }

  async releaseResolutionLock(prId: string): Promise<void> {
    const { ObjectId } = await import('mongodb');
    await this.col.updateOne(
      { _id: new ObjectId(prId) },
      { $set: { resolutionInProgress: null, updatedAt: new Date() } },
    );
  }

  /** Return PRs eligible for an auto-sweep this tick:
   *   - status = 'open'
   *   - workspaceId is set                       (workflow-owned)
   *   - resolutionAttempts < 3
   *   - no live resolutionInProgress lock
   *   - 30-min cooldown since lastReviewSyncAt elapsed */
  async listSweepCandidates(cooldownMs = 30 * 60 * 1000, attemptCap = 3): Promise<PullRequest[]> {
    const cutoff = new Date(Date.now() - cooldownMs);
    const staleLockCutoff = new Date(Date.now() - 30 * 60 * 1000);
    return this.col.find({
      status: 'open',
      workspaceId: { $exists: true, $ne: null },
      $and: [
        { $or: [{ resolutionAttempts: { $exists: false } }, { resolutionAttempts: { $lt: attemptCap } }] },
        {
          $or: [
            { lastReviewSyncAt: { $exists: false } },
            { lastReviewSyncAt: { $lt: cutoff } },
          ],
        },
        {
          $or: [
            { resolutionInProgress: null },
            { resolutionInProgress: { $exists: false } },
            { 'resolutionInProgress.startedAt': { $lt: staleLockCutoff } },
          ],
        },
      ],
    }).sort({ lastReviewSyncAt: 1 }).limit(25).toArray() as Promise<PullRequest[]>;
  }
}

/**
 * Shared helper: sync GitHub PRs for every active repo via `gh pr list`.
 *
 * One source of truth for the "sync all repos" operation. Called by:
 *   - The `pr-sync-all` cron system action (every 30 min).
 *   - The `POST /api/pull-requests/sync-all` route (UI "Sync from GitHub" button).
 *
 * One bad repo doesn't halt the sweep — each repo's failure is captured
 * and surfaced in the returned structured result AND rendered into a
 * single-line summary for the cron_runs.notes / UI toast.
 */
export interface SyncAllResult {
  /** Machine-readable per-repo results. */
  repos: Array<{
    repoId: string;
    repoName: string;
    status: 'synced' | 'error';
    synced?: number;   // count of PRs upserted
    total?: number;    // count from `gh pr list`
    error?: string;
  }>;
  /** Human-readable single-line summary (used by cron UI + toasts). */
  summary: string;
  /** Aggregates for the UI: "Synced 3 repos (18 PRs). 1 error." */
  totalSynced: number;
  totalPrs: number;
  errorCount: number;
}

export async function syncAllActivePrs(db: import('mongodb').Db): Promise<SyncAllResult> {
  const service = new PullRequestService(db);
  const repos = await db.collection('repos').find({ status: 'active' }).toArray();
  const results: SyncAllResult['repos'] = [];
  const synced: string[] = [];
  const errors: string[] = [];
  let totalPrs = 0;

  for (const repo of repos) {
    const repoId = String(repo._id);
    const repoName = repo.name as string;
    try {
      const result = await service.syncFromGitHub(
        repo.path as string,
        repoId,
        repoName,
      );
      results.push({ repoId, repoName, status: 'synced', synced: result.synced, total: result.total });
      synced.push(`${repoName}: ${result.synced}/${result.total}`);
      totalPrs += result.synced;
    } catch (err) {
      const message = (err as Error).message;
      results.push({ repoId, repoName, status: 'error', error: message });
      errors.push(`${repoName}: ${message}`);
    }
  }

  const parts = [
    synced.length ? `Synced: ${synced.join('; ')}` : null,
    errors.length ? `Errors: ${errors.join('; ')}` : null,
  ].filter(Boolean);

  return {
    repos: results,
    summary: parts.join(' | ') || 'No active repos found',
    totalSynced: synced.length,
    totalPrs,
    errorCount: errors.length,
  };
}

/**
 * Factory for the "pr-sync-all" system action. Delegates to the shared
 * `syncAllActivePrs` helper so the cron and the UI button share a single
 * implementation.
 */
export function createPrSyncAllAction(db: import('mongodb').Db): { name: string; description: string; run: () => Promise<string> } {
  return {
    name: 'pr-sync-all',
    description: 'Sync GitHub PRs for all active repos via `gh pr list`. Updates the local pull_requests mirror.',
    async run() {
      const result = await syncAllActivePrs(db);
      return result.summary;
    },
  };
}
