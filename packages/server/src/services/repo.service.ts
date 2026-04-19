import { existsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Collection, Db } from 'mongodb';
import { resolveRepositoriesDir } from '@allen/engine';
import { scanRepo } from './repo-scanner.js';
import { RepoContextScannerService } from './repo-context-scanner.service.js';

const exec = promisify(execFile);

/**
 * Parse a GitHub URL (HTTPS or SSH) into { sshUrl, repoName }.
 * Accepts:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo.git
 *   github.com/owner/repo
 *   git@github.com:owner/repo.git
 */
function parseGitHubUrl(input: string): { sshUrl: string; repoName: string } {
  const trimmed = input.trim().replace(/\/$/, '');

  // Already SSH: git@github.com:owner/repo.git
  const sshMatch = trimmed.match(/^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    const [, host, owner, repo] = sshMatch;
    return { sshUrl: `git@${host}:${owner}/${repo}.git`, repoName: repo };
  }

  // HTTPS: https://github.com/owner/repo or github.com/owner/repo
  const httpsMatch = trimmed.match(/^(?:https?:\/\/)?([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (httpsMatch) {
    const [, host, owner, repo] = httpsMatch;
    return { sshUrl: `git@${host}:${owner}/${repo}.git`, repoName: repo };
  }

  throw new Error(`Invalid repository URL: "${input}". Expected GitHub HTTPS or SSH URL.`);
}

export class RepoService {
  private db: Db;
  private col: Collection;
  private contextScanner: RepoContextScannerService;

  constructor(db: Db) {
    this.db = db;
    this.col = db.collection('repos');
    this.contextScanner = new RepoContextScannerService(db);
  }

  async list(): Promise<Record<string, unknown>[]> {
    return this.col.find({}).sort({ lastUsedAt: -1, createdAt: -1 }).toArray();
  }

  async getById(id: string): Promise<Record<string, unknown> | null> {
    const { ObjectId } = await import('mongodb');
    return this.col.findOne({ _id: new ObjectId(id) });
  }

  async create(body: {
    path: string;
    name?: string;
    description?: string;
    tags?: string[];
  }): Promise<Record<string, unknown>> {
    const repoPath = body.path.trim();

    // Validate path
    if (!repoPath) throw new Error('Path is required');
    if (!existsSync(repoPath)) throw new Error(`Path does not exist: ${repoPath}`);
    if (!statSync(repoPath).isDirectory()) throw new Error(`Path is not a directory: ${repoPath}`);

    // Check uniqueness
    const existing = await this.col.findOne({ path: repoPath });
    if (existing) throw new Error(`Repo already registered at path: ${repoPath}`);

    // Scan
    const scanResult = await scanRepo(repoPath);

    const doc = {
      name: body.name?.trim() || basename(repoPath),
      path: repoPath,
      description: body.description?.trim() || '',
      detected: {
        language: scanResult.language,
        framework: scanResult.framework,
        packageManager: scanResult.packageManager,
        defaultBranch: scanResult.defaultBranch,
        remoteUrl: scanResult.remoteUrl,
      },
      tags: body.tags ?? [],
      defaultWorkflow: undefined,
      context: scanResult.context,
      status: 'active' as const,
      lastUsedAt: undefined,
      executionCount: 0,
      contextScan: { status: 'pending' as const, scannedAt: null },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await this.col.insertOne(doc);

    // Fire deep context scan in the background — don't await, don't fail create
    this.contextScanner.scheduleScan(String(result.insertedId)).catch((err) => {
      console.error(`[repos] failed to schedule deep scan for ${result.insertedId}:`, err);
    });

    return { ...doc, _id: result.insertedId };
  }

  /**
   * Clone a repo from a GitHub URL and register it.
   * 1. Parse URL → SSH clone URL + repo name
   * 2. Check for duplicates (name in DB + directory on disk)
   * 3. git clone via SSH to <ALLEN_HOME>/repositories/<repo-name>
   * 4. git checkout the specified branch
   * 5. Scan the repo
   * 6. Save to DB
   */
  async createFromUrl(body: {
    url: string;
    branch?: string;
    name?: string;
    description?: string;
    tags?: string[];
  }): Promise<Record<string, unknown>> {
    const { sshUrl, repoName: parsedName } = parseGitHubUrl(body.url);
    const repoName = body.name?.trim() || parsedName;
    const branch = body.branch?.trim() || 'main';
    const clonePath = join(resolveRepositoriesDir(), repoName);

    // Check if repo with same name already exists in DB
    const existingByName = await this.col.findOne({ name: repoName });
    if (existingByName) {
      throw new Error(`A repo named "${repoName}" already exists`);
    }

    // Check if path already exists in DB
    const existingByPath = await this.col.findOne({ path: clonePath });
    if (existingByPath) {
      throw new Error(`A repo is already registered at path: ${clonePath}`);
    }

    // Check if directory already exists on disk
    if (existsSync(clonePath)) {
      throw new Error(`Directory already exists at ${clonePath}. Delete it first or use a different name.`);
    }

    // Clone
    try {
      await exec('git', ['clone', sshUrl, clonePath], { timeout: 120_000 });
    } catch (err: any) {
      throw new Error(`Failed to clone ${sshUrl}: ${err.stderr || err.message}`);
    }

    // Checkout the specified branch
    try {
      await exec('git', ['checkout', branch], { cwd: clonePath, timeout: 30_000 });
    } catch (err: any) {
      throw new Error(`Failed to checkout branch "${branch}": ${err.stderr || err.message}`);
    }

    // Scan
    const scanResult = await scanRepo(clonePath);

    const doc = {
      name: repoName,
      path: clonePath,
      url: sshUrl,
      description: body.description?.trim() || '',
      detected: {
        language: scanResult.language,
        framework: scanResult.framework,
        packageManager: scanResult.packageManager,
        defaultBranch: branch,
        remoteUrl: sshUrl,
      },
      tags: body.tags ?? [],
      defaultWorkflow: undefined,
      context: scanResult.context,
      status: 'active' as const,
      lastUsedAt: undefined,
      executionCount: 0,
      contextScan: { status: 'pending' as const, scannedAt: null },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await this.col.insertOne(doc);

    // Fire deep context scan in the background
    this.contextScanner.scheduleScan(String(result.insertedId)).catch((err) => {
      console.error(`[repos] failed to schedule deep scan for ${result.insertedId}:`, err);
    });

    return { ...doc, _id: result.insertedId };
  }

  /** Trigger a fresh deep context scan for a repo. Async — returns immediately. */
  async rescanContext(id: string): Promise<{ scheduled: boolean; reason?: string }> {
    return this.contextScanner.scheduleScan(id);
  }

  /** Fetch the stored detailed context document for a repo. */
  async getContext(id: string): Promise<Record<string, unknown> | null> {
    const ctx = await this.contextScanner.getByRepoId(id);
    return ctx as unknown as Record<string, unknown> | null;
  }

  /** Fetch context by repo path (used by MCP get_repo_context tool). */
  async getContextByPath(repoPath: string): Promise<Record<string, unknown> | null> {
    const repo = await this.col.findOne({ path: repoPath });
    if (!repo) return null;
    const ctx = await this.contextScanner.getByRepoId(String(repo._id));
    return ctx as unknown as Record<string, unknown> | null;
  }

  /**
   * Pull latest changes from origin for the repo's default branch.
   * Fetches from origin, checks out the branch, and pulls.
   * Optionally triggers a rescan after pull.
   */
  async pull(id: string, options?: { rescan?: boolean }): Promise<{ updated: boolean; branch: string; behind: number; commits: string[] }> {
    const { ObjectId } = await import('mongodb');
    const repo = await this.col.findOne({ _id: new ObjectId(id) });
    if (!repo) throw new Error('Repo not found');

    const repoPath = repo.path as string;
    if (!existsSync(repoPath)) throw new Error(`Repo path does not exist: ${repoPath}`);

    const branch = (repo.detected as any)?.defaultBranch || 'main';

    // Get current HEAD before pull
    const { stdout: beforeHash } = await exec('git', ['rev-parse', 'HEAD'], { cwd: repoPath });

    // Fetch + checkout + pull
    await exec('git', ['fetch', 'origin'], { cwd: repoPath, timeout: 60_000 });
    await exec('git', ['checkout', branch], { cwd: repoPath, timeout: 10_000 }).catch(() => {});
    await exec('git', ['pull', 'origin', branch], { cwd: repoPath, timeout: 60_000 });

    // Get new HEAD after pull
    const { stdout: afterHash } = await exec('git', ['rev-parse', 'HEAD'], { cwd: repoPath });

    const updated = beforeHash.trim() !== afterHash.trim();

    // Get list of new commits
    let commits: string[] = [];
    if (updated) {
      const { stdout: log } = await exec('git', ['log', '--oneline', `${beforeHash.trim()}..${afterHash.trim()}`], { cwd: repoPath }).catch(() => ({ stdout: '' }));
      commits = log.trim().split('\n').filter(Boolean);
    }

    // Count how many commits behind origin (should be 0 after pull)
    const { stdout: revList } = await exec('git', ['rev-list', '--count', `HEAD..origin/${branch}`], { cwd: repoPath }).catch(() => ({ stdout: '0' }));
    const behind = parseInt(revList.trim()) || 0;

    await this.col.updateOne({ _id: new ObjectId(id) }, { $set: { updatedAt: new Date() } });

    // Optionally rescan after pull
    if (options?.rescan && updated) {
      this.scan(id).catch(err => console.error(`[repos] post-pull rescan failed for ${id}:`, err));
    }

    return { updated, branch, behind, commits };
  }

  async update(id: string, body: {
    name?: string;
    description?: string;
    tags?: string[];
    context?: string;
    defaultWorkflow?: string;
    status?: 'active' | 'archived';
  }): Promise<Record<string, unknown>> {
    const { ObjectId } = await import('mongodb');
    const existing = await this.col.findOne({ _id: new ObjectId(id) });
    if (!existing) throw new Error('Repo not found');

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name !== undefined) updates.name = body.name.trim();
    if (body.description !== undefined) updates.description = body.description.trim();
    if (body.tags !== undefined) updates.tags = body.tags;
    if (body.context !== undefined) updates.context = body.context;
    if (body.defaultWorkflow !== undefined) updates.defaultWorkflow = body.defaultWorkflow;
    if (body.status !== undefined) updates.status = body.status;

    await this.col.updateOne({ _id: new ObjectId(id) }, { $set: updates });
    return { ...existing, ...updates };
  }

  async delete(id: string): Promise<void> {
    const { ObjectId } = await import('mongodb');
    await this.col.deleteOne({ _id: new ObjectId(id) });
    // Cascade-delete the deep context row so we don't leave orphans
    await this.db.collection('repo_contexts').deleteOne({ repoId: id }).catch(() => {});
  }

  /**
   * Trigger a deep scan. Refreshes the heuristic `detected` metadata
   * synchronously, then schedules the agent-driven deep context rebuild
   * in the background. Returns immediately — caller should poll
   * `contextScan.status` on the repo doc or hit GET /:id/context.
   *
   * No shallow path: every explicit scan is a deep scan.
   */
  async scan(id: string): Promise<Record<string, unknown>> {
    const { ObjectId } = await import('mongodb');
    const existing = await this.col.findOne({ _id: new ObjectId(id) });
    if (!existing) throw new Error('Repo not found');

    // Refresh the cheap heuristic metadata first so the repo list UI is up to date
    const scanResult = await scanRepo(existing.path as string);
    const updates = {
      detected: {
        language: scanResult.language,
        framework: scanResult.framework,
        packageManager: scanResult.packageManager,
        defaultBranch: scanResult.defaultBranch,
        remoteUrl: scanResult.remoteUrl,
      },
      context: scanResult.context,
      updatedAt: new Date(),
    };
    await this.col.updateOne({ _id: new ObjectId(id) }, { $set: updates });

    // Kick off the deep agent scan in the background
    const deepResult = await this.contextScanner.scheduleScan(id);

    return { ...existing, ...updates, deepScan: deepResult };
  }
}

/**
 * Factory for the "repo-pull-all" system action. Iterates all active repos
 * and pulls the latest from origin on their default branch.
 * Runs every 30 min via cron to keep repos from going stale.
 */
export function createRepoPullAllAction(db: Db): { name: string; description: string; run: () => Promise<string> } {
  return {
    name: 'repo-pull-all',
    description: 'Pull latest changes from origin for all active repos.',
    async run() {
      const service = new RepoService(db);
      const repos = await db.collection('repos').find({ status: 'active' }).toArray();
      const pulled: string[] = [];
      const upToDate: string[] = [];
      const errors: string[] = [];

      for (const repo of repos) {
        try {
          const result = await service.pull(String(repo._id));
          if (result.updated) {
            pulled.push(`${repo.name}: ${result.commits.length} new commit(s)`);
          } else {
            upToDate.push(repo.name as string);
          }
        } catch (err) {
          errors.push(`${repo.name}: ${(err as Error).message}`);
        }
      }

      const parts = [
        pulled.length ? `Pulled: ${pulled.join('; ')}` : null,
        upToDate.length ? `Up to date: ${upToDate.join(', ')}` : null,
        errors.length ? `Errors: ${errors.join('; ')}` : null,
      ].filter(Boolean);
      return parts.join(' | ') || 'No active repos found';
    },
  };
}
