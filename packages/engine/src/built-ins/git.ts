import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BuiltInFunction } from '../types.js';

const exec = promisify(execFile);

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

export const gitCreateBranch: BuiltInFunction = async (config, state) => {
  const repoPath = (state.repo_path as string) ?? process.cwd();
  const baseBranch = (config.base_branch as string) ?? 'main';
  const taskSlug = String(state.task ?? 'feature')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40);
  const branchName = `flowforge/${taskSlug}-${Date.now().toString(36)}`;

  // Create worktree directory (ensure parent exists)
  const worktreeBase = join(tmpdir(), 'flowforge', 'wt');
  await mkdir(worktreeBase, { recursive: true });
  const worktreePath = await mkdtemp(join(worktreeBase, 'exec-'));

  await git(['worktree', 'add', '-b', branchName, worktreePath, baseBranch], repoPath);

  return { worktree_path: worktreePath, branch_name: branchName };
};

export const gitCommit: BuiltInFunction = async (config, state) => {
  const cwd = (state.worktree_path as string) ?? process.cwd();
  const message = (config.message as string) ?? (state.summary as string) ?? 'FlowForge: automated changes';

  await git(['add', '-A'], cwd);
  const status = await git(['status', '--porcelain'], cwd);
  if (!status) {
    return { committed: false, message: 'No changes to commit' };
  }
  await git(['commit', '-m', message], cwd);
  const hash = await git(['rev-parse', 'HEAD'], cwd);
  return { committed: true, commit_hash: hash };
};

export const gitPush: BuiltInFunction = async (_config, state) => {
  const cwd = (state.worktree_path as string) ?? process.cwd();
  const branch = state.branch_name as string;
  await git(['push', '-u', 'origin', branch], cwd);
  return { pushed: true };
};

export const gitCreatePR: BuiltInFunction = async (config, state) => {
  const cwd = (state.worktree_path as string) ?? process.cwd();
  const title = (config.title as string) ?? (state.summary as string) ?? 'FlowForge PR';
  const body = (config.body as string) ?? '';
  const base = (config.base as string) ?? 'main';

  const { stdout } = await exec('gh', [
    'pr', 'create',
    '--title', title,
    '--body', body,
    '--base', base,
  ], { cwd });

  return { pr_url: stdout.trim() };
};

export const gitCleanupWorktree: BuiltInFunction = async (_config, state) => {
  const repoPath = (state.repo_path as string) ?? process.cwd();
  const worktreePath = state.worktree_path as string;
  if (worktreePath) {
    try {
      await git(['worktree', 'remove', worktreePath, '--force'], repoPath);
    } catch {
      // Worktree may already be cleaned up
    }
  }
  return { cleaned: true };
};
