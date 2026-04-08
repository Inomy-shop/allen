/**
 * Pull Request Service
 * Syncs PRs from GitHub via `gh` CLI, manages PR lifecycle.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Db, ObjectId } from 'mongodb';

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
    // Use gh CLI to list PRs
    let prList: any[];
    try {
      const { stdout } = await exec('gh', [
        'pr', 'list', '--json',
        'number,title,body,headRefName,baseRefName,state,author,url,additions,deletions,changedFiles,labels,createdAt,updatedAt,mergedAt',
        '--limit', '50',
        '--state', 'all',
      ], { cwd: repoPath });
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

  async getDiff(repoPath: string, branch: string, baseBranch: string): Promise<{ diff: string; files: { path: string; diff: string }[] }> {
    try {
      await exec('git', ['fetch', 'origin', branch], { cwd: repoPath }).catch(() => {});
      const { stdout } = await exec('git', ['diff', `origin/${baseBranch}...origin/${branch}`], { cwd: repoPath });
      const files: { path: string; diff: string }[] = [];
      const fileDiffs = stdout.split(/^diff --git /m).filter(Boolean);
      for (const fd of fileDiffs) {
        const pathMatch = fd.match(/a\/(.+?) b\//);
        if (pathMatch) files.push({ path: pathMatch[1], diff: 'diff --git ' + fd });
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
    // Push first
    await exec('git', ['push', '-u', 'origin', branch], { cwd: repoPath });

    // Create via gh CLI
    const { stdout: createOut } = await exec('gh', [
      'pr', 'create',
      '--title', title,
      '--body', body,
      '--base', baseBranch,
      '--head', branch,
    ], { cwd: repoPath });

    // createOut is the PR URL, e.g. "https://github.com/user/repo/pull/42\n"
    const prUrl = createOut.trim();

    // Fetch PR details
    const { stdout: viewOut } = await exec('gh', [
      'pr', 'view', branch,
      '--json', 'number,url,additions,deletions,changedFiles',
    ], { cwd: repoPath });

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
      author: 'flowforge',
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
}
