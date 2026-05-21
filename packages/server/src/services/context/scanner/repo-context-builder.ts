/**
 * Repo Context Builder
 *
 * Resolves a path hint (repo path, workspace worktree path, or a subdirectory
 * of either) to a registered repo, loads its stored markdown context document,
 * and renders the prompt block that gets injected into agent system prompts.
 *
 * The block is wrapped in <repo_context> tags so it's unmistakable to the
 * agent and easy to spot in execution traces.
 *
 * If the context is missing or stale, this function triggers a background
 * rescan but never blocks the caller — agents always get an immediate answer
 * (the current cached context, or empty string if nothing is cached yet).
 */

import { dirname } from 'node:path';
import type { Db } from 'mongodb';
import { RepoContextScannerService } from './repo-context-scanner.service.js';

/**
 * Build the markdown context block to inject into an agent's system prompt.
 * Returns '' if no repo can be resolved from the path hint.
 *
 * No budget cap — the full markdown produced by the scanner agent is injected
 * verbatim. The agent receiving this context is expected to handle large
 * system prompts.
 *
 * @param db        MongoDB handle
 * @param pathHint  Either a registered repo path, a workspace worktreePath,
 *                  or any subdirectory of one of those.
 */
export async function buildRepoContextBlock(db: Db, pathHint: string | undefined): Promise<string> {
  if (!pathHint || pathHint === '/tmp' || pathHint === '/tmp/allen') return '';

  const repo = await resolveRepoFromPath(db, pathHint);
  if (!repo) return '';

  const scanner = new RepoContextScannerService(db);
  const repoIdStr = String(repo._id);
  const ctx = await scanner.getByRepoId(repoIdStr);

  // Check freshness and trigger background refresh if needed.
  // We never block the caller — they get whatever is cached right now.
  const currentHead = await safeGitHead(repo.path as string);
  if (RepoContextScannerService.isStale(ctx, currentHead)) {
    scanner.scheduleScan(repoIdStr).catch(() => {});
  }

  if (!ctx || !ctx.contextMarkdown) {
    // Nothing cached yet. Return a tiny fallback so the agent at least knows
    // which repo it's in while the scan runs in the background.
    return wrap(repo.name as string, 'pending', `Repo: ${repo.name}\nPath: ${repo.path}\n\n_Detailed context is being generated. The first scan can take a while._`);
  }

  // Inject the FULL markdown — no truncation, no budget.
  return wrap(repo.name as string, ctx.scannedAt.toISOString(), ctx.contextMarkdown);
}

/**
 * Resolve a path hint to a repo doc by checking, in order:
 *   1. workspaces.worktreePath === pathHint  (workspace lookup → repoId)
 *   2. repos.path === pathHint                (direct repo match)
 *   3. ancestor walk of pathHint              (subdir launches)
 */
async function resolveRepoFromPath(db: Db, pathHint: string): Promise<Record<string, unknown> | null> {
  const { ObjectId } = await import('mongodb');

  // 1. Workspace match
  try {
    const ws = await db.collection('workspaces').findOne({ worktreePath: pathHint });
    if (ws?.repoId) {
      const repo = await db.collection('repos').findOne({ _id: new ObjectId(ws.repoId as string) });
      if (repo) return repo;
    }
  } catch {}

  // 2. Direct repo path match
  const direct = await db.collection('repos').findOne({ path: pathHint });
  if (direct) return direct;

  // 3. Ancestor walk — handles subdir launches and workspace subpaths
  let current = pathHint;
  for (let i = 0; i < 10; i++) {
    const parent = dirname(current);
    if (!parent || parent === current || parent === '/') break;
    current = parent;

    // Try workspace match first at this ancestor
    try {
      const ws = await db.collection('workspaces').findOne({ worktreePath: current });
      if (ws?.repoId) {
        const repo = await db.collection('repos').findOne({ _id: new ObjectId(ws.repoId as string) });
        if (repo) return repo;
      }
    } catch {}

    const repo = await db.collection('repos').findOne({ path: current });
    if (repo) return repo;
  }

  return null;
}

/** Wrap the body in unmistakable tags so agents recognize it as authoritative. */
function wrap(repoName: string, scannedAt: string, body: string): string {
  return `\n\n<repo_context repo="${escapeAttr(repoName)}" scanned="${escapeAttr(scannedAt)}">
# Authoritative Repository Context
${body}
</repo_context>\n`;
}

function escapeAttr(s: string): string {
  return String(s).replace(/"/g, '&quot;').replace(/[<>]/g, '');
}

/** Read git HEAD sha non-throwing. */
async function safeGitHead(repoPath: string): Promise<string | undefined> {
  try {
    const { spawn } = await import('node:child_process');
    return await new Promise<string | undefined>((resolveP) => {
      const proc = spawn('git', ['rev-parse', 'HEAD'], { cwd: repoPath });
      let out = '';
      proc.stdout.on('data', (c: Buffer) => (out += c.toString()));
      proc.on('close', () => resolveP(out.trim() || undefined));
      proc.on('error', () => resolveP(undefined));
    });
  } catch {
    return undefined;
  }
}
