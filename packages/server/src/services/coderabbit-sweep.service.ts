/**
 * CodeRabbit sweep — cron-driven system action that scans workflow-owned
 * open PRs and triggers the `resolve-pr-reviews` workflow for any PR
 * that's eligible (under attempt cap, past cooldown, no active lock).
 *
 * Eligibility is enforced by PullRequestService.listSweepCandidates:
 *   - status = 'open'
 *   - workspaceId set                         (Flow A only)
 *   - resolutionAttempts < 3
 *   - 30-min cooldown since lastReviewSyncAt elapsed
 *   - no live resolutionInProgress lock
 *
 * External PRs (no workspaceId) are NEVER picked up by this sweep —
 * those require a manual trigger from the Pull Requests page.
 */

import type { Db } from 'mongodb';
import { PullRequestService } from './pull-request.service.js';
import { ExecutionService } from './execution.service.js';

/** Name under which the workflow is seeded in MongoDB. */
const WORKFLOW_NAME = 'resolve-pr-reviews';

/** Max concurrent sweep-triggered workflow executions. Prevents a burst
 *  of open PRs from exhausting the engine's capacity. */
const MAX_CONCURRENT_TRIGGERS = 3;

export function createCodeRabbitSweepAction(db: Db): {
  name: string;
  description: string;
  run: () => Promise<string>;
} {
  return {
    name: 'coderabbit-sweep',
    description: 'Scans workflow-owned open PRs and triggers resolve-pr-reviews for any with new CodeRabbit comments.',
    async run() {
      const prService = new PullRequestService(db);
      const executionService = new ExecutionService(db);

      // Find the workflow doc so we can pass its _id to executionService.start.
      const workflow = await db.collection('workflows').findOne({ name: WORKFLOW_NAME });
      if (!workflow) {
        return `Workflow "${WORKFLOW_NAME}" not found — seed it and try again.`;
      }

      const candidates = await prService.listSweepCandidates();
      if (candidates.length === 0) return 'No eligible PRs.';

      const triggered: string[] = [];
      const skipped: string[] = [];
      const errors: string[] = [];

      // Cap concurrent triggers per tick.
      const slice = candidates.slice(0, MAX_CONCURRENT_TRIGGERS);

      for (const pr of slice) {
        // Best-effort lock acquire — skip if already in-progress (another
        // tick is still running this PR, or the workflow itself is live).
        // We intentionally DON'T pre-acquire here; the workflow execution's
        // start writes the lock itself so we don't leak a lock if the
        // engine refuses to start the workflow for any reason.
        try {
          const prevAttempts = (pr as any).resolutionAttempts ?? 0;
          const input = {
            pr_url: pr.url,
            review_bot_logins: 'coderabbitai,coderabbitai[bot]',
            already_processed_comment_ids: JSON.stringify(
              (pr as any).processedCommentIds ?? [],
            ),
          };
          const exec = await executionService.start(String(workflow._id), input);
          triggered.push(`${pr.url} (attempt ${prevAttempts + 1}) → ${exec.id}`);
        } catch (err) {
          errors.push(`${pr.url}: ${(err as Error).message}`);
        }
      }

      for (const pr of candidates.slice(MAX_CONCURRENT_TRIGGERS)) {
        skipped.push(`${pr.url} (deferred to next tick)`);
      }

      const parts = [
        triggered.length > 0 ? `Triggered ${triggered.length}: ${triggered.join('; ')}` : null,
        skipped.length > 0 ? `Deferred ${skipped.length}` : null,
        errors.length > 0 ? `Errors: ${errors.join('; ')}` : null,
      ].filter(Boolean);
      return parts.join(' | ') || 'No-op.';
    },
  };
}
