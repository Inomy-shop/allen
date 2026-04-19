import { GIT_BRANCH_PREFIX } from '../brand.js';
import type { BuiltInFunction } from '../types.js';

/**
 * Create an Allen workspace — identical to the "New Workspace" flow on the
 * Repos page in the UI. Takes a repo (by id or name) and a branch, calls the
 * internal /api/workspaces endpoint, then polls until setup completes.
 *
 * Config:
 *   repo_id?: string           — repo _id (preferred). If absent, repo_name is required.
 *   repo_name?: string         — repo name (used when repo_id is missing)
 *   branch?: string            — new branch name (default: derived from task/state)
 *   base_branch?: string       — base to branch from (default: repo default branch)
 *   name?: string              — workspace display name (default: branch name)
 *   wait_for_setup?: boolean   — poll until status=active (default: true)
 *   timeout_sec?: number       — max seconds to wait for setup (default: 600)
 *
 * State fallbacks (used if corresponding config is absent):
 *   repo_id, repo_name, repo_path, branch, base_branch
 *
 * Returns:
 *   workspace_id, workspace_name, branch, worktree_path, base_port, status
 */
/**
 * Return undefined for:
 *   - non-strings
 *   - empty / whitespace-only strings
 *   - unresolved handlebars templates like "{{repo_name}}" (the engine
 *     doesn't interpolate code node config values, so literal templates
 *     mean "not actually provided")
 */
function nonEmpty(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  if (!trimmed) return undefined;
  if (/^\{\{\s*[\w.]+\s*\}\}$/.test(trimmed)) return undefined;
  return trimmed;
}

export const createWorkspace: BuiltInFunction = async (config, state, ctx) => {
  if (!ctx.db) throw new Error('create-workspace requires a database connection');

  // Resolve repo — accept id, name, or absolute path. The repo MUST be
  // registered in Allen; unregistered paths are not supported.
  const repoId = nonEmpty(config.repo_id) ?? nonEmpty(state.repo_id);
  const repoName = nonEmpty(config.repo_name) ?? nonEmpty(state.repo_name);
  const repoPath = nonEmpty(config.repo_path) ?? nonEmpty(state.repo_path);

  let repo: Record<string, unknown> | null = null;
  const repoCol = ctx.db.collection('repos');
  if (repoId) {
    const { ObjectId } = await import('mongodb');
    try {
      repo = await repoCol.findOne({ _id: new ObjectId(repoId) });
    } catch {
      throw new Error(`Invalid repo_id: ${repoId}`);
    }
  }
  // Try repo_name against `name`, and if that misses, against `path` too
  // (users commonly pass an absolute path into a `repo_name` field).
  if (!repo && repoName) {
    repo = await repoCol.findOne({ name: repoName });
    if (!repo && repoName.startsWith('/')) {
      repo = await repoCol.findOne({ path: repoName });
    }
  }
  // Try repo_path — same dual lookup in case someone passed a bare name
  if (!repo && repoPath) {
    repo = await repoCol.findOne({ path: repoPath });
    if (!repo) {
      repo = await repoCol.findOne({ name: repoPath });
    }
  }
  if (!repo) {
    const tried = [repoId, repoName, repoPath].filter(Boolean).join(', ') || '(none)';
    throw new Error(
      `Repo not found. Tried: ${tried}. ` +
      `Register the repo from the Repos page first, then pass its name or path.`,
    );
  }

  const detected = (repo.detected as Record<string, unknown>) ?? {};
  const defaultBranch = (detected.defaultBranch as string) ?? 'main';

  // Derive branch slug from whichever common input field the workflow uses.
  // Each workflow names it differently — task, bug, feature, target, incident, etc.
  const taskSource =
    (state.task as string | undefined) ??
    (state.bug as string | undefined) ??
    (state.feature as string | undefined) ??
    (state.target as string | undefined) ??
    (state.incident as string | undefined) ??
    'feature';
  const taskSlug = String(taskSource)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'feature';
  const branch =
    nonEmpty(config.branch) ??
    nonEmpty(state.branch) ??
    `${GIT_BRANCH_PREFIX}/${taskSlug}-${Date.now().toString(36)}`;
  const baseBranch =
    nonEmpty(config.base_branch) ?? nonEmpty(state.base_branch) ?? defaultBranch;
  const workspaceName = nonEmpty(config.name) ?? branch;

  const payload = {
    repoId: String(repo._id),
    repoName: repo.name as string,
    repoPath: repo.path as string,
    branch,
    baseBranch,
    name: workspaceName,
  };

  ctx.emitter.emit({
    event: 'execution_log',
    data: {
      level: 'info',
      category: 'workspace',
      message: `Creating workspace "${workspaceName}" on branch ${branch} (from ${baseBranch})`,
      details: payload,
    },
  });

  // In-process path: the host (server) passes a WorkspaceManager wrapper via
  // ctx.services.workspaces. We use it directly so the engine doesn't have to
  // loop back through /api/workspaces (which requires a Bearer token now).
  // No auth dance, no self-call, no port coupling — same process, same Mongo.
  const wsService = ctx.services?.workspaces;
  if (!wsService) {
    throw new Error(
      'create-workspace: no workspace service bound on the engine context. ' +
      'The host must pass `services.workspaces` when constructing AllenEngine.',
    );
  }

  const workspace = await wsService.create(payload);
  const workspaceId = String((workspace as { _id: unknown })._id);

  // Poll for setup completion (default on)
  const waitForSetup = (config.wait_for_setup as boolean | undefined) ?? true;
  const timeoutSec = (config.timeout_sec as number | undefined) ?? 600;

  let finalStatus = workspace.status as string;
  let worktreePath = workspace.worktreePath as string;
  let basePort = workspace.basePort as number;

  if (waitForSetup) {
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000));
      const ws = await wsService.get(workspaceId);
      if (!ws) continue;
      finalStatus = ws.status as string;
      worktreePath = ws.worktreePath as string;
      basePort = ws.basePort as number;
      if (finalStatus === 'active' || finalStatus === 'running') break;
      if (finalStatus === 'failed' || finalStatus === 'archived') {
        throw new Error(`Workspace setup failed (status=${finalStatus})`);
      }
    }
    if (finalStatus !== 'active' && finalStatus !== 'running') {
      throw new Error(`Workspace setup timed out after ${timeoutSec}s (status=${finalStatus})`);
    }
  }

  ctx.emitter.emit({
    event: 'execution_log',
    data: {
      level: 'info',
      category: 'workspace',
      message: `Workspace ready: ${workspaceName} (id=${workspaceId})`,
      details: { workspaceId, worktreePath, basePort, status: finalStatus },
    },
  });

  return {
    workspace_id: workspaceId,
    workspace_name: workspaceName,
    branch,
    // Alias: existing workflows interpolate {{branch_name}} from git-create-branch
    branch_name: branch,
    base_branch: baseBranch,
    worktree_path: worktreePath,
    base_port: basePort,
    status: finalStatus,
    // Convenience aliases so downstream git nodes (git-commit, git-push)
    // that read `worktree_path` keep working without re-wiring state.
    repo_path: worktreePath,
  };
};
