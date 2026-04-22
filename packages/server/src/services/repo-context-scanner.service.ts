/**
 * Repo Context Scanner Service
 *
 * Spawns the `repo-scanner` agent headlessly via the Claude Code SDK against
 * a registered repo's path. The agent explores the repo (git-tracked files
 * only) and produces a long, detailed markdown document describing each
 * module. We extract that markdown, redact obvious secrets, and persist it
 * to the `repo_contexts` collection.
 *
 * Trigger points:
 *   - Repo create (fire-and-forget from RepoService.create)
 *   - Manual rescan endpoint (POST /api/repos/:id/rescan-context)
 *   - Lazy refresh from buildRepoContextBlock when context is stale
 *
 * The scanner runs in the BACKGROUND. Callers should never await it on a
 * user-facing request. A concurrency guard prevents overlapping scans for
 * the same repo.
 */

import type { Collection, Db, ObjectId } from 'mongodb';
import { withArtifactsGuidance } from '@allen/engine';

/** Bump when scanner prompt or storage shape changes meaningfully. */
export const SCAN_VERSION = 1;

/** Hard wall-time cap for a single scan. Generous — deep scans on large repos can take a while. */
const SCAN_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes

/**
 * Patterns we redact from the agent output as a defense-in-depth pass.
 * Only well-known token prefixes — never a generic length-based catch-all,
 * because that matches git SHAs (40 hex chars) and breaks the documented
 * lastCommitSha field.
 */
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{20,}/g,                  // OpenAI / Anthropic style
  /sk-ant-[A-Za-z0-9_-]{20,}/g,              // Anthropic API key
  /ghp_[A-Za-z0-9]{20,}/g,                   // GitHub personal access token
  /gho_[A-Za-z0-9]{20,}/g,                   // GitHub OAuth token
  /ghu_[A-Za-z0-9]{20,}/g,                   // GitHub user-to-server
  /ghs_[A-Za-z0-9]{20,}/g,                   // GitHub server-to-server
  /github_pat_[A-Za-z0-9_]{20,}/g,           // Fine-grained PAT
  /AKIA[0-9A-Z]{16}/g,                       // AWS access key id
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,           // Slack tokens
  /AIza[0-9A-Za-z_-]{30,}/g,                 // Google API key
];

export interface RepoContextRecord {
  _id?: ObjectId;
  repoId: string;
  repoPath: string;
  scanVersion: number;
  headSha?: string;
  branch?: string;
  contextMarkdown: string;
  scannedAt: Date;
  scanDurationMs: number;
  scanCostUsd: number;
  scanError?: string;
  scanAgentExecutionId?: string;
  branchNotes?: string[];
}

export class RepoContextScannerService {
  private repos: Collection;
  private contexts: Collection<RepoContextRecord>;

  constructor(private db: Db) {
    this.repos = db.collection('repos');
    this.contexts = db.collection<RepoContextRecord>('repo_contexts');
  }

  /**
   * True if the cached context is stale and should be refreshed.
   * Refresh triggers: missing, scan-version bumped, or git HEAD changed.
   * (No time-based expiry — explicit triggers via UI/API handle that.)
   */
  static isStale(rec: RepoContextRecord | null, currentHeadSha: string | undefined): boolean {
    if (!rec) return true;
    if (rec.scanVersion < SCAN_VERSION) return true;
    if (currentHeadSha && rec.headSha && rec.headSha !== currentHeadSha) return true;
    return false;
  }

  /** Lookup a stored context by repo id. */
  async getByRepoId(repoId: string): Promise<RepoContextRecord | null> {
    return this.contexts.findOne({ repoId });
  }

  /**
   * Kick off a scan in the background. Returns immediately.
   *
   * Concurrency guard: if a scan is already running for this repo, this is a
   * no-op (caller will see the in-progress status reflected on the repos doc).
   */
  async scheduleScan(repoId: string): Promise<{ scheduled: boolean; reason?: string }> {
    const { ObjectId } = await import('mongodb');
    const repo = await this.repos.findOne({ _id: new ObjectId(repoId) });
    if (!repo) return { scheduled: false, reason: 'Repo not found' };

    // Atomic concurrency guard via the repos doc
    const claim = await this.repos.updateOne(
      { _id: new ObjectId(repoId), 'contextScan.status': { $ne: 'scanning' } },
      { $set: { contextScan: { status: 'scanning', startedAt: new Date() } } },
    );
    if (claim.matchedCount === 0) {
      return { scheduled: false, reason: 'Scan already in progress' };
    }

    // Fire and forget — log errors, never throw to the caller
    this.runScan(repoId, repo.path as string, repo.name as string).catch((err) => {
      console.error(`[repo-scanner] background scan failed for ${repoId}:`, err);
    });

    return { scheduled: true };
  }

  /** The actual scan — runs the repo-scanner agent and persists the result. */
  private async runScan(repoId: string, repoPath: string, repoName: string): Promise<void> {
    const { ObjectId } = await import('mongodb');
    const startMs = Date.now();
    const { randomUUID } = await import('node:crypto');
    const executionId = randomUUID();

    let headSha: string | undefined;
    let contextMarkdown = '';
    let costUsd = 0;
    let error: string | undefined;
    let prompt = '';
    let model = 'sonnet';
    let toolCalls: { tool: string; args: Record<string, unknown> }[] = [];
    const branchNotes: string[] = [];

    try {
      // Switch to the repo's base branch before scanning so the context reflects
      // the canonical state, not whatever feature branch the user had checked out.
      // Non-destructive: bails if working tree is dirty.
      const repoDoc = await this.repos.findOne({ _id: new ObjectId(repoId) });
      const defaultBranch =
        ((repoDoc?.detected as Record<string, unknown> | undefined)?.defaultBranch as string | undefined) ??
        (await this.detectDefaultBranch(repoPath));
      if (defaultBranch) {
        const note = await this.ensureOnBaseBranch(repoPath, defaultBranch);
        if (note) branchNotes.push(note);
      } else {
        branchNotes.push('No default branch could be determined; scanning current branch.');
      }

      // Capture HEAD as the cache key (after the branch switch)
      headSha = await this.gitHeadSha(repoPath);

      // Load the scanner agent definition
      const agent = await this.db.collection('agents').findOne({ name: 'repo-scanner' });
      if (!agent) throw new Error('repo-scanner agent not seeded');

      const { normalizeModelAlias } = await import('@allen/engine');
      model = normalizeModelAlias((agent.model as string) ?? 'sonnet') ?? 'sonnet';

      // Trace the scan as an agent execution — same shape as chat:spawn_agent
      // so the UI renders the agent execution view with tool calls and logs.
      await this.db.collection('executions').insertOne({
        id: executionId,
        workflowName: `chat:spawn_agent/repo-scanner`,
        workflowId: null,
        workflowVersion: 0,
        status: 'running',
        source: 'chat',
        input: { prompt: `repo-scan: ${repoName}`, agent_name: 'repo-scanner', repo_path: repoPath },
        meta: { cwd: repoPath, provider: 'claude', model, spawnedBy: 'repo-context-scanner' },
        state: {},
        sessions: {},
        retryCounts: {},
        currentNodes: ['repo-scanner'],
        completedNodes: [],
        cost: { actual: null, estimated: 0 },
        durationMs: 0,
        startedAt: new Date(),
      });

      /** Log helper — persists to execution_logs for the live streaming UI. */
      const liveLog = (entry: { type: string; tool?: string; command?: string; content?: string }) => {
        this.db.collection('execution_logs').insertOne({
          executionId, agent: 'repo-scanner', ...entry, timestamp: new Date(),
        }).catch(() => {});
      };
      liveLog({ type: 'started', content: `Repo scan for ${repoName} in ${repoPath}` });

      // Run the agent headlessly via Claude SDK — no chat session, no broadcast
      const { query } = await import('@anthropic-ai/claude-code');
      const abortController = new AbortController();
      const timer = setTimeout(() => abortController.abort(), SCAN_TIMEOUT_MS);

      const branchPreamble = branchNotes.length
        ? `\n\nBranch state:\n${branchNotes.map((n) => `- ${n}`).join('\n')}`
        : '';
      prompt = `Scan the repository "${repoName}" at the current working directory and produce the comprehensive markdown context document per your system prompt. Be thorough — read each significant module. The repo path is: ${repoPath}${branchPreamble}`;

      const sdkOptions: Record<string, unknown> = {
        model,
        permissionMode: 'bypassPermissions',
        cwd: repoPath,
        customSystemPrompt: withArtifactsGuidance(agent.system as string),
        abortController,
      };

      let finalText = '';
      toolCalls = [];
      try {
        for await (const msg of query({ prompt, options: sdkOptions as any })) {
          if (msg.type === 'assistant') {
            const blocks = (msg as any).message?.content as Array<{ type: string; text?: string; name?: string; input?: unknown }> ?? [];
            const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
            if (text) {
              finalText = text;
              liveLog({ type: 'text', content: text.slice(-300) });
            }
            // Capture tool calls for the trace
            for (const block of blocks) {
              if (block.type === 'tool_use' && block.name) {
                const args = (block.input as Record<string, unknown>) ?? {};
                toolCalls.push({ tool: block.name, args });
                const desc = block.name === 'Bash' ? `$ ${(args.command as string ?? '').slice(0, 150)}` :
                  block.name === 'Read' ? `Read ${args.file_path ?? ''}` :
                  block.name === 'Grep' ? `Search: ${args.pattern ?? ''}` :
                  block.name === 'Glob' ? `Find: ${args.pattern ?? ''}` :
                  `${block.name}`;
                liveLog({ type: 'tool_start', tool: block.name, content: desc });
              }
            }
          }
          if ((msg as any).type === 'tool_result' || ((msg as any).message?.role === 'tool')) {
            const toolName = (msg as any).tool_name ?? (msg as any).name ?? '';
            liveLog({ type: 'tool_done', tool: toolName });
          }
          if (msg.type === 'result') {
            costUsd = (msg as any).total_cost_usd ?? 0;
            if ((msg as any).subtype === 'success' && (msg as any).result) {
              finalText = (msg as any).result;
            }
          }
        }
      } finally {
        clearTimeout(timer);
      }

      liveLog({ type: 'completed', content: `Done: ${toolCalls.length} tools, ${(finalText?.length ?? 0)} chars output` });

      // The agent's final text is the context. No parsing, no fence stripping —
      // it's prompt-injected as-is into downstream agents.
      contextMarkdown = (finalText ?? '').trim();
      if (!contextMarkdown) {
        throw new Error('Scanner agent returned empty output');
      }
      contextMarkdown = redactSecrets(contextMarkdown);
    } catch (err) {
      error = (err as Error).message ?? String(err);
      console.error(`[repo-scanner] scan failed for ${repoPath}:`, error);
    }

    const scanDurationMs = Date.now() - startMs;

    // Persist execution result
    await this.db.collection('executions').updateOne(
      { id: executionId },
      {
        $set: {
          status: error ? 'failed' : 'completed',
          completedNodes: error ? [] : ['repo-scanner'],
          currentNodes: [],
          cost: { actual: costUsd, estimated: costUsd },
          durationMs: scanDurationMs,
          completedAt: new Date(),
          ...(error ? { errorMessage: error } : {}),
        },
      },
    );

    // Save trace with tool calls + response — matches the spawn_agent trace shape
    await this.db.collection('execution_traces').insertOne({
      executionId,
      node: 'repo-scanner',
      attempt: 1,
      status: error ? 'failed' : 'completed',
      type: 'agent',
      agent: 'repo-scanner',
      inputState: { prompt: `repo-scan: ${repoName}`, repoId, repoPath },
      renderedPrompt: prompt,
      rawResponse: contextMarkdown || '',
      output: error ? { error } : { response: contextMarkdown, contextChars: contextMarkdown.length },
      toolCalls,
      activity: toolCalls.map(tc => ({ type: 'tool_call' as const, tool: tc.tool, timestamp: new Date(), content: tc.tool })),
      cost: { actual: costUsd, estimated: costUsd, model, method: 'sdk_reported' as const },
      durationMs: scanDurationMs,
      startedAt: new Date(startMs),
      completedAt: new Date(),
    });

    if (error) {
      // Mark scan failed but keep any previous context intact
      await this.repos.updateOne(
        { _id: new ObjectId(repoId) },
        {
          $set: {
            contextScan: {
              status: 'error',
              scannedAt: new Date(),
              error,
              executionId,
            },
          },
        },
      );
      return;
    }

    // Branch we ended up scanning, for the record
    const { stdout: scannedBranchOut } = await runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const scannedBranch = scannedBranchOut.trim() || undefined;

    // Upsert the new context
    await this.contexts.updateOne(
      { repoId },
      {
        $set: {
          repoId,
          repoPath,
          scanVersion: SCAN_VERSION,
          headSha,
          branch: scannedBranch,
          contextMarkdown,
          scannedAt: new Date(),
          scanDurationMs,
          scanCostUsd: costUsd,
          scanAgentExecutionId: executionId,
          branchNotes: branchNotes.length ? branchNotes : undefined,
        },
        $unset: { scanError: '' },
      },
      { upsert: true },
    );

    await this.repos.updateOne(
      { _id: new ObjectId(repoId) },
      {
        $set: {
          contextScan: {
            status: 'ready',
            scannedAt: new Date(),
            headSha,
            executionId,
          },
        },
      },
    );

    console.log(
      `[repo-scanner] ${repoName} scanned in ${(scanDurationMs / 1000).toFixed(1)}s, ${contextMarkdown.length} chars, $${costUsd.toFixed(4)}`,
    );
  }

  /** Read git HEAD sha for cache invalidation. Returns undefined on failure. */
  private async gitHeadSha(repoPath: string): Promise<string | undefined> {
    const { stdout } = await runGit(repoPath, ['rev-parse', 'HEAD']);
    return stdout.trim() || undefined;
  }

  /**
   * Detect the repo's default branch by asking git directly. Tries the
   * symbolic-ref of origin/HEAD first; falls back to common branch names.
   */
  private async detectDefaultBranch(repoPath: string): Promise<string | undefined> {
    const { stdout, code } = await runGit(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    if (code === 0 && stdout.trim()) {
      return stdout.trim().replace(/^origin\//, '');
    }
    // Fallback: look for common branch names
    for (const candidate of ['main', 'master', 'develop']) {
      const { code: c } = await runGit(repoPath, ['rev-parse', '--verify', candidate]);
      if (c === 0) return candidate;
    }
    return undefined;
  }

  /**
   * Switch the repo to its base branch before scanning. Non-destructive:
   *   - If working tree is dirty, log a warning and DO NOT switch (user work wins).
   *   - Best-effort fetch + ff-pull to bring the branch up to date.
   *   - Returns a human-readable note describing what happened (or undefined if uneventful).
   */
  private async ensureOnBaseBranch(repoPath: string, defaultBranch: string): Promise<string | undefined> {
    // Check working tree cleanliness
    const { stdout: status } = await runGit(repoPath, ['status', '--porcelain']);
    if (status.trim()) {
      const note = `Working tree dirty — kept current branch instead of switching to "${defaultBranch}". Scan may not reflect canonical state.`;
      console.warn(`[repo-scanner] ${repoPath}: ${note}`);
      return note;
    }

    // Best-effort fetch (ignore network failures, missing remote, etc.)
    await runGit(repoPath, ['fetch', '--quiet', 'origin', defaultBranch]).catch(() => {});

    // Determine current branch
    const { stdout: currentBranchOut } = await runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const currentBranch = currentBranchOut.trim();

    // Switch if needed
    if (currentBranch !== defaultBranch) {
      const { code, stderr } = await runGit(repoPath, ['checkout', defaultBranch]);
      if (code !== 0) {
        const note = `Failed to checkout "${defaultBranch}": ${stderr.trim() || 'unknown error'}. Scanning current branch "${currentBranch}".`;
        console.warn(`[repo-scanner] ${repoPath}: ${note}`);
        return note;
      }
    }

    // Best-effort fast-forward pull (ignore failures: no upstream, no network, conflicts)
    await runGit(repoPath, ['pull', '--ff-only', '--quiet', 'origin', defaultBranch]).catch(() => {});

    return currentBranch !== defaultBranch
      ? `Switched from "${currentBranch}" to "${defaultBranch}" before scan.`
      : undefined;
  }
}

// ── System action handler for the cron service ──

import type { SystemAction } from './cron.types.js';

/**
 * Factory for the "repo-scan-if-changed" system action. Iterates all active
 * repos, checks whether the base-branch HEAD has moved since the last scan,
 * and queues a deep scan for any that changed.
 *
 * Does NOT do destructive branch checkouts — it compares remote HEAD only via
 * `git fetch` + `git rev-parse origin/<branch>`. The actual scan (which may
 * switch branches) happens later when the queued scanner runs.
 */
export function createRepoScanIfChangedAction(db: Db): SystemAction {
  return {
    name: 'repo-scan-if-changed',
    description: 'Re-scan repos whose base-branch HEAD has changed since the last scan.',
    async run() {
      const scanner = new RepoContextScannerService(db);
      const repos = await db.collection('repos').find({ status: 'active' }).toArray();
      const scanned: string[] = [];
      const skipped: string[] = [];
      const errors: string[] = [];

      for (const repo of repos) {
        const repoId = String(repo._id);
        const repoPath = repo.path as string;
        const detected = repo.detected as Record<string, unknown> | undefined;
        const defaultBranch = (detected?.defaultBranch as string) ?? 'main';

        try {
          // Best-effort fetch (read-only, no checkout)
          await runGit(repoPath, ['fetch', '--quiet', 'origin', defaultBranch]).catch(() => {});

          // Read the remote HEAD (not the local working tree HEAD)
          const { stdout: remoteHeadOut, code } = await runGit(repoPath, ['rev-parse', `origin/${defaultBranch}`]);
          const remoteHead = code === 0 ? remoteHeadOut.trim() : undefined;

          // Compare with stored context headSha
          const ctx = await scanner.getByRepoId(repoId);
          if (ctx && remoteHead && ctx.headSha === remoteHead) {
            skipped.push(`${repo.name}: HEAD unchanged (${remoteHead.slice(0, 8)})`);
            continue;
          }

          // HEAD changed (or no context yet) — queue a scan
          const { scheduled, reason } = await scanner.scheduleScan(repoId);
          if (scheduled) {
            scanned.push(`${repo.name}: HEAD moved → queued scan`);
          } else {
            skipped.push(`${repo.name}: ${reason ?? 'not scheduled'}`);
          }
        } catch (err) {
          errors.push(`${repo.name}: ${(err as Error).message}`);
        }
      }

      const parts = [
        scanned.length ? `Scanned: ${scanned.join('; ')}` : null,
        skipped.length ? `Skipped: ${skipped.join('; ')}` : null,
        errors.length ? `Errors: ${errors.join('; ')}` : null,
      ].filter(Boolean);
      return parts.join(' | ') || 'No active repos found';
    },
  };
}

/**
 * Tiny git runner — captures stdout/stderr/exit code without throwing on
 * non-zero exit, so callers can handle each command's outcome explicitly.
 */
async function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolveP) => {
    const proc = spawn('git', args, { cwd });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    proc.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    proc.on('close', (code) => resolveP({ stdout, stderr, code: code ?? 1 }));
    proc.on('error', () => resolveP({ stdout, stderr, code: 1 }));
  });
}

/** Defense-in-depth secret redaction over the agent output. */
function redactSecrets(text: string): string {
  let out = text;
  for (const pat of SECRET_PATTERNS) {
    out = out.replace(pat, '[REDACTED]');
  }
  return out;
}
