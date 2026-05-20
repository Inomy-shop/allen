import { accessSync, constants as fsConstants, existsSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Collection, Db } from 'mongodb';
import { resolveRepositoriesDir } from '@allen/engine';
import { scanRepo } from './repo-scanner.js';
import { RepoContextScannerService } from './context/scanner/repo-context-scanner.service.js';
import { RepoKnowledgeGraphService } from './context/allen-knowledge-graph/repo-knowledge-graph.service.js';
import { isContextEngineEnabled, isGraphContextEnabled } from './context/config/context-provider-config.js';

const exec = promisify(execFile);

export interface RepoValidationCheck {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

export interface RepoValidationResult {
  ok: boolean;
  source: 'local' | 'clone';
  name?: string;
  path?: string;
  clonePath?: string;
  cloneUrl?: string;
  sshUrl?: string;
  httpsUrl?: string;
  requiresSsh?: boolean;
  branch?: string;
  detected?: {
    language: string[];
    framework: string[];
    packageManager: string;
    defaultBranch: string;
    remoteUrl?: string;
  };
  checks: RepoValidationCheck[];
}

/**
 * Parse a GitHub URL (HTTPS or SSH) into clone URL variants.
 * Accepts:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo.git
 *   github.com/owner/repo
 *   git@github.com:owner/repo.git
 */
function parseGitHubUrl(input: string): { sshUrl: string; httpsUrl: string; repoName: string } {
  const trimmed = input.trim().replace(/\/$/, '');

  // Already SSH: git@github.com:owner/repo.git
  const sshMatch = trimmed.match(/^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    const [, host, owner, repo] = sshMatch;
    return {
      sshUrl: `git@${host}:${owner}/${repo}.git`,
      httpsUrl: `https://${host}/${owner}/${repo}.git`,
      repoName: repo,
    };
  }

  // HTTPS: https://github.com/owner/repo or github.com/owner/repo
  const httpsMatch = trimmed.match(/^(?:https?:\/\/)?([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (httpsMatch) {
    const [, host, owner, repo] = httpsMatch;
    return {
      sshUrl: `git@${host}:${owner}/${repo}.git`,
      httpsUrl: `https://${host}/${owner}/${repo}.git`,
      repoName: repo,
    };
  }

  throw new Error(`Invalid repository URL: "${input}". Expected GitHub HTTPS or SSH URL.`);
}

async function runGit(repoPath: string, args: string[], timeout = 5000): Promise<string> {
  const { stdout } = await exec('git', args, { cwd: repoPath, timeout });
  return stdout.trim();
}

async function canReadRepoOverHttps(httpsUrl: string): Promise<boolean> {
  try {
    await exec('git', ['ls-remote', '--exit-code', httpsUrl, 'HEAD'], { timeout: 12_000 });
    return true;
  } catch {
    return false;
  }
}

export class RepoService {
  private db: Db;
  private col: Collection;
  private contextScanner: RepoContextScannerService;
  private knowledgeGraph: RepoKnowledgeGraphService;

  constructor(db: Db) {
    this.db = db;
    this.col = db.collection('repos');
    this.contextScanner = new RepoContextScannerService(db);
    this.knowledgeGraph = new RepoKnowledgeGraphService(db);
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
      knowledgeGraphIndex: { status: 'pending' as const, indexedAt: null },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await this.col.insertOne(doc);

    if (isGraphContextEnabled()) {
      // Fire context scans in the background — don't await, don't fail create.
      this.contextScanner.scheduleScan(String(result.insertedId)).catch((err) => {
        console.error(`[repos] failed to schedule deep scan for ${result.insertedId}:`, err);
      });
    }
    if (isContextEngineEnabled()) {
      this.knowledgeGraph.scheduleProviderContextIndex(String(result.insertedId)).catch((err) => {
        console.error(`[repos] failed to schedule provider context index for ${result.insertedId}:`, err);
      });
    }

    return { ...doc, _id: result.insertedId };
  }

  async validateLocalPath(repoPathRaw: string): Promise<RepoValidationResult> {
    const repoPath = String(repoPathRaw ?? '').trim();
    const checks: RepoValidationCheck[] = [];

    if (!repoPath) {
      return {
        ok: false,
        source: 'local',
        checks: [{
          id: 'path',
          label: 'Path',
          status: 'fail',
          detail: 'Enter a local repository path.',
        }],
      };
    }

    const add = (check: RepoValidationCheck) => checks.push(check);

    if (!existsSync(repoPath)) {
      add({ id: 'exists', label: 'Path exists', status: 'fail', detail: 'Path does not exist.' });
      return { ok: false, source: 'local', path: repoPath, checks };
    }
    add({ id: 'exists', label: 'Path exists', status: 'pass', detail: 'Path exists.' });

    if (!statSync(repoPath).isDirectory()) {
      add({ id: 'directory', label: 'Directory', status: 'fail', detail: 'Path is not a directory.' });
      return { ok: false, source: 'local', path: repoPath, checks };
    }
    add({ id: 'directory', label: 'Directory', status: 'pass', detail: 'Path is a directory.' });

    try {
      accessSync(repoPath, fsConstants.R_OK | fsConstants.W_OK);
      add({ id: 'access', label: 'Read/write access', status: 'pass', detail: 'Allen can read and write this path.' });
    } catch {
      add({ id: 'access', label: 'Read/write access', status: 'fail', detail: 'Allen needs read/write access to create workspaces.' });
    }

    let isGit = false;
    try {
      const inside = await runGit(repoPath, ['rev-parse', '--is-inside-work-tree']);
      isGit = inside === 'true';
    } catch {
      isGit = false;
    }
    add({
      id: 'git',
      label: 'Git repository',
      status: isGit ? 'pass' : 'fail',
      detail: isGit ? 'Path is a git repository.' : 'Path is not a git repository.',
    });

    const existing = await this.col.findOne({ path: repoPath });
    add({
      id: 'unique',
      label: 'Not already registered',
      status: existing ? 'fail' : 'pass',
      detail: existing ? 'This repository is already registered in Allen.' : 'Repository is not registered yet.',
    });

    let branch = '';
    if (isGit) {
      try {
        branch = await runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
      } catch {
        branch = '';
      }
      add({
        id: 'branch',
        label: 'Current branch',
        status: branch && branch !== 'HEAD' ? 'pass' : 'warn',
        detail: branch && branch !== 'HEAD' ? `Current branch is ${branch}.` : 'Repository appears to be in detached HEAD state.',
      });

      try {
        const dirty = await runGit(repoPath, ['status', '--porcelain']);
        add({
          id: 'dirty',
          label: 'Working tree',
          status: dirty ? 'warn' : 'pass',
          detail: dirty ? 'Repository has uncommitted changes. Allen will create separate workspaces, but review local work first.' : 'Working tree is clean.',
        });
      } catch {
        add({ id: 'dirty', label: 'Working tree', status: 'warn', detail: 'Could not inspect working tree status.' });
      }
    }

    let scanResult: Awaited<ReturnType<typeof scanRepo>> | null = null;
    if (checks.every(check => check.status !== 'fail')) {
      scanResult = await scanRepo(repoPath);
    }

    return {
      ok: checks.every(check => check.status !== 'fail'),
      source: 'local',
      name: basename(repoPath),
      path: repoPath,
      branch: branch || scanResult?.defaultBranch,
      detected: scanResult ? {
        language: scanResult.language,
        framework: scanResult.framework,
        packageManager: scanResult.packageManager,
        defaultBranch: scanResult.defaultBranch,
        remoteUrl: scanResult.remoteUrl,
      } : undefined,
      checks,
    };
  }

  async validateCloneUrl(body: {
    url: string;
    branch?: string;
    name?: string;
  }): Promise<RepoValidationResult> {
    const checks: RepoValidationCheck[] = [];
    const url = String(body.url ?? '').trim();
    if (!url) {
      return {
        ok: false,
        source: 'clone',
        checks: [{ id: 'url', label: 'Repository URL', status: 'fail', detail: 'Enter a GitHub repository URL.' }],
      };
    }

    let parsed: { sshUrl: string; httpsUrl: string; repoName: string };
    try {
      parsed = parseGitHubUrl(url);
    } catch (err) {
      checks.push({ id: 'url', label: 'Repository URL', status: 'fail', detail: (err as Error).message });
      return { ok: false, source: 'clone', checks };
    }

    const httpsReadable = await canReadRepoOverHttps(parsed.httpsUrl);
    const cloneUrl = httpsReadable ? parsed.httpsUrl : parsed.sshUrl;
    const requiresSsh = !httpsReadable;
    checks.push({
      id: 'url',
      label: 'Repository URL',
      status: 'pass',
      detail: httpsReadable
        ? `HTTPS access works. Allen will clone ${parsed.httpsUrl}.`
        : `HTTPS access was not available. Allen will clone ${parsed.sshUrl} with SSH access.`,
    });
    checks.push({
      id: 'access',
      label: 'Clone access',
      status: httpsReadable ? 'pass' : 'warn',
      detail: httpsReadable
        ? 'No GitHub SSH key is required. This repo is readable over HTTPS, either because it is public or because HTTPS credentials are available.'
        : 'This repo is not readable over HTTPS from this machine. Verify GitHub SSH before cloning.',
    });

    const repoName = body.name?.trim() || parsed.repoName;
    const clonePath = join(resolveRepositoriesDir(), repoName);

    const existingByName = await this.col.findOne({ name: repoName });
    checks.push({
      id: 'name',
      label: 'Repository name',
      status: existingByName ? 'fail' : 'pass',
      detail: existingByName ? `A repo named "${repoName}" is already registered.` : `Repository will be named "${repoName}".`,
    });

    const existingByPath = await this.col.findOne({ path: clonePath });
    checks.push({
      id: 'path',
      label: 'Clone path',
      status: existingByPath || existsSync(clonePath) ? 'fail' : 'pass',
      detail: existingByPath || existsSync(clonePath)
        ? `Clone path already exists: ${clonePath}`
        : `Clone path is available.`,
    });

    const branch = body.branch?.trim() || 'main';
    checks.push({
      id: 'branch',
      label: 'Branch',
      status: 'pass',
      detail: `Allen will check out ${branch} after cloning.`,
    });

    return {
      ok: checks.every(check => check.status !== 'fail'),
      source: 'clone',
      name: repoName,
      cloneUrl,
      sshUrl: parsed.sshUrl,
      httpsUrl: parsed.httpsUrl,
      requiresSsh,
      clonePath,
      branch,
      checks,
    };
  }

  /**
   * Clone a repo from a GitHub URL and register it.
   * 1. Parse URL → HTTPS/SSH clone URLs + repo name
   * 2. Check for duplicates (name in DB + directory on disk)
   * 3. git clone via HTTPS when readable, otherwise SSH, to <ALLEN_HOME>/repositories/<repo-name>
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
    const { sshUrl, httpsUrl, repoName: parsedName } = parseGitHubUrl(body.url);
    const repoName = body.name?.trim() || parsedName;
    const branch = body.branch?.trim() || 'main';
    const clonePath = join(resolveRepositoriesDir(), repoName);
    const httpsReadable = await canReadRepoOverHttps(httpsUrl);
    const cloneUrl = httpsReadable ? httpsUrl : sshUrl;

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
      await exec('git', ['clone', cloneUrl, clonePath], { timeout: 120_000 });
    } catch (err: any) {
      throw new Error(`Failed to clone ${cloneUrl}: ${err.stderr || err.message}`);
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
      url: cloneUrl,
      description: body.description?.trim() || '',
      detected: {
        language: scanResult.language,
        framework: scanResult.framework,
        packageManager: scanResult.packageManager,
        defaultBranch: branch,
        remoteUrl: cloneUrl,
      },
      tags: body.tags ?? [],
      defaultWorkflow: undefined,
      context: scanResult.context,
      status: 'active' as const,
      lastUsedAt: undefined,
      executionCount: 0,
      contextScan: { status: 'pending' as const, scannedAt: null },
      knowledgeGraphIndex: { status: 'pending' as const, indexedAt: null },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await this.col.insertOne(doc);

    if (isGraphContextEnabled()) {
      // Fire deep context scan in the background.
      this.contextScanner.scheduleScan(String(result.insertedId)).catch((err) => {
        console.error(`[repos] failed to schedule deep scan for ${result.insertedId}:`, err);
      });
    }
    if (isContextEngineEnabled()) {
      this.knowledgeGraph.scheduleProviderContextIndex(String(result.insertedId)).catch((err) => {
        console.error(`[repos] failed to schedule provider context index for ${result.insertedId}:`, err);
      });
    }

    return { ...doc, _id: result.insertedId };
  }

  /** Trigger a fresh deep context scan for a repo. Async — returns immediately. */
  async rescanContext(id: string): Promise<{ scheduled: boolean; reason?: string }> {
    if (!isGraphContextEnabled()) return { scheduled: false, reason: 'Allen context provider is disabled' };
    return this.contextScanner.scheduleScan(id);
  }

  async indexKnowledgeGraph(id: string): Promise<{ scheduled: boolean; reason?: string; executionId?: string }> {
    if (!isGraphContextEnabled()) return { scheduled: false, reason: 'Allen context provider is disabled' };
    return this.knowledgeGraph.scheduleIndex(id);
  }

  /** Fetch the stored detailed context document for a repo. */
  async getContext(id: string): Promise<Record<string, unknown> | null> {
    if (!isGraphContextEnabled()) return null;
    const ctx = await this.contextScanner.getByRepoId(id);
    return ctx as unknown as Record<string, unknown> | null;
  }

  /** Fetch context by repo path (used by MCP get_repo_context tool). */
  async getContextByPath(repoPath: string): Promise<Record<string, unknown> | null> {
    if (!isGraphContextEnabled()) return null;
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
    const existing = await this.col.findOne({ _id: new ObjectId(id) });
    await this.col.deleteOne({ _id: new ObjectId(id) });
    // Cascade-delete the deep context row so we don't leave orphans
    await this.db.collection('repo_contexts').deleteOne({ repoId: id }).catch(() => {});
    await this.db.collection('repo_knowledge_indexes').deleteMany({ repoId: id }).catch(() => {});
    await this.db.collection('knowledge_nodes').deleteMany({ repoId: id }).catch(() => {});
    await this.db.collection('knowledge_edges').deleteMany({ repoId: id }).catch(() => {});
    // Remove the cloned directory from disk
    const clonePath = existing?.path as string | undefined;
    if (clonePath && existsSync(clonePath)) {
      try {
        rmSync(clonePath, { recursive: true, force: true });
      } catch (err) {
        console.error(`[repos] failed to remove clone directory ${clonePath}:`, err);
      }
    }
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

    const deepResult = isGraphContextEnabled()
      ? await this.contextScanner.scheduleScan(id)
      : { scheduled: false, reason: 'Allen context provider is disabled' };

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
