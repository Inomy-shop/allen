import type { Db } from 'mongodb';
import type { SchedulerCursorRow, SchedulerSourceType } from './context-judge.types.js';
import { ContextObservabilityDiscoveryService } from './context-observability-discovery.service.js';
import { sourceEvaluationKey } from './context-judge-policy.js';

export interface RepoFilter {
  repoId?: string;
  repoIds?: string[];
}

/**
 * Represents one pending source candidate returned by discoverPending().
 * All source types include sourceId, sourceKind, repoId.
 * context_usage_trace candidates additionally include contextAttemptId,
 * executionId, and flowKind so judge agents do not confuse sourceId with an
 * executionId. sourceId === contextAttemptId is guaranteed for backwards
 * compatibility with existing consumers.
 */
export interface SchedulerPendingCandidate {
  sourceId: string;
  sourceKind: string;
  repoId?: string;
  createdAt?: Date;
  /**
   * Only present for context_usage_trace candidates.
   * Equals sourceId — explicit field so agents prefer contextAttemptId
   * over sourceId when calling context_quality_get_usage_trace.
   */
  contextAttemptId?: string;
  /**
   * Only present for context_usage_trace candidates.
   * The executionId associated with this context attempt.
   * Do NOT pass this to context_quality_get_usage_trace as a contextAttemptId.
   */
  executionId?: string;
  /**
   * Only present for context_usage_trace candidates.
   * Maps from context_attempts.executionKind (e.g. 'workflow_node', 'spawned_agent').
   */
  flowKind?: string;
}

export class ContextEvaluationScheduler {
  private discovery: ContextObservabilityDiscoveryService;

  constructor(private db: Db) {
    this.discovery = new ContextObservabilityDiscoveryService(db);
  }

  async getState(): Promise<SchedulerCursorRow[]> {
    const docs = await this.db
      .collection('context_judge_scheduler_state')
      .find({})
      .toArray();
    return docs as unknown as SchedulerCursorRow[];
  }

  /**
   * Discover pending source candidates for the given sourceType.
   *
   * @param allowBackfill - When true, ignore the scheduler cursor so that
   *   unevaluated sources older than the cursor window are still discoverable
   *   (repair/backfill mode). The cursor is then used as a scan optimisation
   *   only — not as a correctness gate.
   *
   * Deduplication order (sources are included only when ALL pass):
   *   1. NOT in context_source_evaluations with status='completed' (durable ledger)
   *   2. NOT in context_judge_runs with the same sourceKey and active=true (in-progress)
   *
   * Candidates are sorted newest-first before the limit is applied so that
   * the most recent sources are evaluated first.
   */
  async discoverPending(
    sourceType: SchedulerSourceType,
    limit = 20,
    repoFilter?: RepoFilter,
    allowBackfill = false,
  ): Promise<SchedulerPendingCandidate[]> {
    const cursorRow = await this.getCursorRow(sourceType, repoFilter);

    // When allowBackfill=true, ignore the cursor so older unevaluated sources
    // are still discoverable. The cursor is an optimisation — not a correctness gate.
    const cursorDate = allowBackfill
      ? new Date(0)
      : (cursorRow?.cursor ? new Date(cursorRow.cursor) : new Date(0));

    // Resolve repoIds array from filter
    const repoIds = repoFilter?.repoIds
      ?? (repoFilter?.repoId ? [repoFilter.repoId] : null);

    const results: SchedulerPendingCandidate[] = [];

    try {
      if (sourceType === 'workflow_run') {
        // Use context_attempts (executionKind='workflow_node') as source of truth.
        // Fetch limit*4 candidates (sorted newest-first) to get enough distinct executionIds.
        const candidates = await this.discovery.discoverCandidates({
          cursorDate,
          repoIds,
          executionKind: 'workflow_node',
          limit: limit * 4,
        });

        const seenExecutionIds = new Set<string>();
        for (const candidate of candidates) {
          const executionId = candidate.executionId;
          if (!executionId) continue;
          if (seenExecutionIds.has(executionId)) continue;
          seenExecutionIds.add(executionId);

          const sourceKey = `workflow_run:${executionId}`;
          if (await this.isSourcePending(sourceKey)) {
            results.push({ sourceId: executionId, sourceKind: 'workflow_run', repoId: candidate.repoId });
          }
          if (results.length >= limit) break;
        }
      } else if (sourceType === 'spawned_agent_run') {
        // Use context_attempts (executionKind='spawned_agent') as source of truth.
        const candidates = await this.discovery.discoverCandidates({
          cursorDate,
          repoIds,
          executionKind: 'spawned_agent',
          limit: limit * 4,
        });

        const seenExecutionIds = new Set<string>();
        for (const candidate of candidates) {
          const executionId = candidate.executionId;
          if (!executionId) continue;
          if (seenExecutionIds.has(executionId)) continue;
          seenExecutionIds.add(executionId);

          const sourceKey = `spawned_agent_run:${executionId}`;
          if (await this.isSourcePending(sourceKey)) {
            results.push({ sourceId: executionId, sourceKind: 'spawned_agent_run', repoId: candidate.repoId });
          }
          if (results.length >= limit) break;
        }
      } else if (sourceType === 'chat_turn') {
        const query: Record<string, unknown> = { updatedAt: { $gt: cursorDate } };

        // Repo-scoped: derive session IDs from context_attempts where repoId matches
        if (repoIds) {
          const sessionIds = await this.db
            .collection('context_attempts')
            .distinct('executionId', { repoId: { $in: repoIds } });
          if (sessionIds.length === 0) {
            // No chat sessions associated with this repo — return empty
            return results;
          }
          query['sessionId'] = { $in: sessionIds };
        }

        // Sort newest-first before limit (primary requirement)
        const docs = await this.db
          .collection('chat_sessions')
          .find(query)
          .sort({ updatedAt: -1 })
          .limit(limit * 2)  // fetch extra to absorb dedup
          .project({ _id: 0, sessionId: 1 })
          .toArray();

        for (const doc of docs) {
          const sourceId = doc['sessionId'] as string | undefined;
          if (!sourceId) continue;
          const sourceKey = `chat_turn:${sourceId}`;
          if (await this.isSourcePending(sourceKey)) {
            results.push({ sourceId, sourceKind: 'chat_turn' });
          }
          if (results.length >= limit) break;
        }
      } else if (sourceType === 'context_usage_trace') {
        // Use context_attempts as source of truth (context_ref_events with type='used' is empty).
        // sourceId = contextAttemptId (not executionId) — one judge run per attempt.
        // discoverCandidates already sorts newest-first (updated in discovery service).
        const candidates = await this.discovery.discoverCandidates({
          cursorDate,
          repoIds,
          limit: limit * 2,  // fetch extra to absorb dedup
        });

        for (const candidate of candidates) {
          const sourceId = candidate.contextAttemptId;
          if (!sourceId) continue;
          const sourceKey = `context_usage_trace:${sourceId}`;
          if (await this.isSourcePending(sourceKey)) {
            results.push({
              sourceId,
              sourceKind: 'context_usage_trace',
              repoId: candidate.repoId,
              // Explicit fields so judge agents do not confuse sourceId with executionId.
              // sourceId === contextAttemptId is guaranteed for backwards compatibility.
              contextAttemptId: candidate.contextAttemptId,
              executionId: candidate.executionId || undefined,
              flowKind: candidate.executionKind || undefined,
            });
          }
          if (results.length >= limit) break;
        }
      } else if (sourceType === 'deterministic_warning') {
        const query: Record<string, unknown> = { 'semantic.overallScore': { $lt: 0.5 }, updatedAt: { $gt: cursorDate } };
        if (repoIds) query['repoId'] = { $in: repoIds };

        // Sort newest-first before limit (primary requirement)
        const docs = await this.db
          .collection('context_evaluations')
          .find(query)
          .sort({ updatedAt: -1 })
          .limit(limit * 2)
          .project({ _id: 0, evaluationId: 1, repoId: 1 })
          .toArray();

        for (const doc of docs) {
          const sourceId = doc['evaluationId'] as string | undefined;
          if (!sourceId) continue;
          const sourceKey = `deterministic_warning:${sourceId}`;
          if (await this.isSourcePending(sourceKey)) {
            results.push({ sourceId, sourceKind: 'deterministic_warning', repoId: doc['repoId'] as string | undefined });
          }
          if (results.length >= limit) break;
        }
      } else if (sourceType === 'human_feedback') {
        // Source of truth: workflow_interventions with status='answered' and
        // non-empty response.feedback OR response.answer.
        // context_ref_events does NOT contain feedback events — do not query it here.
        const interventionQuery: Record<string, unknown> = {
          status: 'answered',
          $or: [
            { 'response.feedback': { $type: 'string', $ne: '' } },
            { 'response.answer': { $type: 'string', $ne: '' } },
          ],
          answered_at: { $gt: cursorDate },
        };

        // Sort newest-first before limit (primary requirement)
        const interventionDocs = await this.db
          .collection('workflow_interventions')
          .find(interventionQuery)
          .sort({ answered_at: -1 })
          // Fetch extra candidates to absorb repo-filter exclusions and dedup
          .limit(limit * 4)
          .project({
            _id: 0,
            intervention_id: 1,
            workflow_run_id: 1,
            workflow_name: 1,
            stage: 1,
            retry_triggered: 1,
            answered_at: 1,
            created_at: 1,
          })
          .toArray();

        // Batch-resolve repoId from context_attempts using workflow_run_id.
        // workflow_interventions does not carry a repoId field itself.
        const workflowRunIds = interventionDocs
          .map(d => d['workflow_run_id'] as string | undefined)
          .filter((id): id is string => typeof id === 'string' && id.length > 0);

        const repoIdByRunId = new Map<string, string>();
        if (workflowRunIds.length > 0) {
          const attemptsForRunIds = await this.db
            .collection('context_attempts')
            .find({ executionId: { $in: workflowRunIds } })
            .project({ _id: 0, executionId: 1, repoId: 1 })
            .toArray();
          for (const a of attemptsForRunIds) {
            const eid = a['executionId'] as string | undefined;
            const rid = a['repoId'] as string | undefined;
            if (eid && rid && !repoIdByRunId.has(eid)) {
              repoIdByRunId.set(eid, rid);
            }
          }
        }

        for (const doc of interventionDocs) {
          const interventionId = doc['intervention_id'] as string | undefined;
          if (!interventionId) continue;

          const workflowRunId = doc['workflow_run_id'] as string | undefined;
          const resolvedRepoId = workflowRunId ? repoIdByRunId.get(workflowRunId) : undefined;

          // Apply repo filter: if a repoIds filter is present and the repoId
          // cannot be resolved or does not match, exclude this candidate.
          if (repoIds) {
            if (!resolvedRepoId || !repoIds.includes(resolvedRepoId)) continue;
          }

          const sourceKey = `human_feedback:intervention:${interventionId}`;
          if (await this.isSourcePending(sourceKey)) {
            results.push({
              sourceId: interventionId,
              sourceKind: 'human_feedback',
              repoId: resolvedRepoId,
            });
          }
          if (results.length >= limit) break;
        }
      } else if (sourceType === 'chat_learning') {
        const learningResults = await this.discoverPendingLearnings(limit, repoIds, allowBackfill);
        results.push(...learningResults);
      } else if (sourceType === 'stale_finding') {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const query: Record<string, unknown> = { status: 'open', active: true, updatedAt: { $lt: sevenDaysAgo } };
        if (repoIds) query['repoId'] = { $in: repoIds };

        // Sort newest (most-recently stale) first before limit (primary requirement)
        const docs = await this.db
          .collection('context_findings')
          .find(query)
          .sort({ updatedAt: -1 })
          .limit(limit * 2)
          .project({ _id: 0, findingId: 1, repoId: 1 })
          .toArray();

        for (const doc of docs) {
          const sourceId = doc['findingId'] as string | undefined;
          if (!sourceId) continue;
          const sourceKey = `stale_finding:${sourceId}`;
          if (await this.isSourcePending(sourceKey)) {
            results.push({ sourceId, sourceKind: 'stale_finding', repoId: doc['repoId'] as string | undefined });
          }
          if (results.length >= limit) break;
        }
      }
    } catch {
      // Gracefully handle empty or missing collections
    }

    return results.slice(0, limit);
  }

  private cursorScopeFor(sourceType: SchedulerSourceType, repoFilter?: RepoFilter): {
    sourceType: SchedulerSourceType;
    scopeType: 'repo' | 'global' | 'legacy';
    scopeKey: string;
  } {
    if (sourceType !== 'chat_learning') {
      return { sourceType, scopeType: 'legacy', scopeKey: 'legacy' };
    }
    if (repoFilter?.repoId) {
      return { sourceType, scopeType: 'repo', scopeKey: repoFilter.repoId };
    }
    if (repoFilter?.repoIds?.length === 1) {
      return { sourceType, scopeType: 'repo', scopeKey: repoFilter.repoIds[0]! };
    }
    return { sourceType, scopeType: 'global', scopeKey: 'global' };
  }

  private async getCursorRow(sourceType: SchedulerSourceType, repoFilter?: RepoFilter): Promise<SchedulerCursorRow | null> {
    const scope = this.cursorScopeFor(sourceType, repoFilter);
    if (scope.scopeType === 'legacy') {
      return this.db
        .collection('context_judge_scheduler_state')
        .findOne({ sourceType }) as Promise<SchedulerCursorRow | null>;
    }
    const scoped = await this.db
      .collection('context_judge_scheduler_state')
      .findOne({ sourceType, scopeType: scope.scopeType, scopeKey: scope.scopeKey }) as SchedulerCursorRow | null;
    if (scoped) return scoped;
    return this.db
      .collection('context_judge_scheduler_state')
      .findOne({ sourceType, scopeType: { $exists: false } }) as Promise<SchedulerCursorRow | null>;
  }

  private async discoverPendingLearnings(
    limit: number,
    repoIds: string[] | null,
    allowBackfill: boolean,
  ): Promise<SchedulerPendingCandidate[]> {
    const results: SchedulerPendingCandidate[] = [];
    const seen = new Set<string>();

    if (!repoIds || repoIds.length === 0) {
      const docs = await this.db.collection('learnings')
        .find({
          contextEligibility: { $ne: 'ineligible' },
        })
        .sort({ createdAt: -1 })
        .project({ learningId: 1, repoId: 1, repoIds: 1, scope: 1, createdAt: 1 })
        .toArray();

      for (const doc of docs) {
        const sourceId = this.learningIdFromDoc(doc);
        if (!sourceId) continue;
        if (seen.has(sourceId)) continue;
        seen.add(sourceId);
        const repoId = doc['repoId'] as string | undefined;
        const sourceKey = sourceEvaluationKey({ sourceType: 'chat_learning', sourceId, repoId });
        const legacySourceKey = `chat_learning:${sourceId}`;
        if (await this.isSourcePending(sourceKey) && await this.isSourcePending(legacySourceKey)) {
          results.push({ sourceId, sourceKind: 'chat_learning', repoId, createdAt: doc['createdAt'] as Date | undefined });
        }
        if (results.length >= limit) break;
      }
      return results;
    }

    for (const repoId of repoIds) {
      const docs = await this.db.collection('learnings')
        .find({
          contextEligibility: { $ne: 'ineligible' },
          $or: [
            { repoId },
            { repoIds: repoId },
            { repoId: null },
            { repoId: { $exists: false } },
          ],
        })
        .sort({ createdAt: -1 })
        .project({ learningId: 1, repoId: 1, repoIds: 1, scope: 1, createdAt: 1 })
        .toArray();

      for (const doc of docs) {
        const sourceId = this.learningIdFromDoc(doc);
        if (!sourceId) continue;
        const dedupeKey = `${repoId}:${sourceId}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        const docRepoId = doc['repoId'] as string | undefined;
        const evaluatedRepoId = docRepoId ?? repoId;
        const sourceKey = sourceEvaluationKey({ sourceType: 'chat_learning', sourceId, repoId: evaluatedRepoId });
        const legacySourceKey = `chat_learning:${sourceId}`;
        if (await this.isSourcePending(sourceKey) && await this.isSourcePending(legacySourceKey)) {
          results.push({ sourceId, sourceKind: 'chat_learning', repoId: evaluatedRepoId, createdAt: doc['createdAt'] as Date | undefined });
        }
        if (results.length >= limit) return results;
      }
    }

    return results.slice(0, limit);
  }

  private learningIdFromDoc(doc: Record<string, unknown>): string | undefined {
    const explicit = doc['learningId'];
    if (typeof explicit === 'string' && explicit.length > 0) return explicit;
    const id = doc['_id'];
    if (typeof id === 'string') return id;
    if (id && typeof (id as { toString?: () => string }).toString === 'function') return (id as { toString: () => string }).toString();
    return undefined;
  }

  private async cursorDateFor(
    sourceType: SchedulerSourceType,
    scopeType: 'repo' | 'global',
    scopeKey: string,
  ): Promise<Date> {
    const row = await this.db.collection('context_judge_scheduler_state')
      .findOne({ sourceType, scopeType, scopeKey }) as SchedulerCursorRow | null;
    return row?.cursor ? new Date(row.cursor) : new Date(0);
  }

  /**
   * Anti-join helper: returns true only if a source has NOT yet been
   * fully evaluated (neither in context_source_evaluations as completed
   * nor in context_judge_runs as an active in-progress run).
   *
   * Deduplication order:
   *   1. context_source_evaluations status='completed' → definitively done, skip
   *   2. context_judge_runs active=true with matching sourceKey → in-progress, skip
   *   3. Neither → include as pending
   */
  private async isSourcePending(sourceKey: string): Promise<boolean> {
    // 1. Check durable evaluation ledger first (GAP 1/2: anti-join)
    const alreadyEvaluated = await this.db
      .collection('context_source_evaluations')
      .findOne({ sourceKey, status: 'completed' }, { projection: { _id: 1 } });
    if (alreadyEvaluated) return false;

    // 2. Check for an in-progress judge run
    const existingRun = await this.db
      .collection('context_judge_runs')
      .findOne({ sourceKey, active: true }, { projection: { _id: 1 } });
    return existingRun === null;
  }

  async markRunning(sourceType: SchedulerSourceType, repoFilter?: RepoFilter): Promise<void> {
    const scope = this.cursorScopeFor(sourceType, repoFilter);
    const filter = scope.scopeType === 'legacy' ? { sourceType } : scope;
    await this.db.collection('context_judge_scheduler_state').updateOne(
      filter,
      {
        $set: { ...filter, status: 'running', lastRunAt: new Date(), updatedAt: new Date() },
      },
      { upsert: true },
    );
  }

  async markIdle(sourceType: SchedulerSourceType, cursor?: string, repoFilter?: RepoFilter): Promise<void> {
    const scope = this.cursorScopeFor(sourceType, repoFilter);
    const filter = scope.scopeType === 'legacy' ? { sourceType } : scope;
    const update: Record<string, unknown> = { status: 'idle', updatedAt: new Date() };
    if (cursor) update['cursor'] = cursor;
    await this.db.collection('context_judge_scheduler_state').updateOne(
      filter,
      { $set: update },
      { upsert: true },
    );
  }

  async markError(sourceType: SchedulerSourceType, message: string, repoFilter?: RepoFilter): Promise<void> {
    const scope = this.cursorScopeFor(sourceType, repoFilter);
    const filter = scope.scopeType === 'legacy' ? { sourceType } : scope;
    await this.db.collection('context_judge_scheduler_state').updateOne(
      filter,
      { $set: { status: 'error', errorMessage: message, updatedAt: new Date() } },
      { upsert: true },
    );
  }

  async markSourcesAssigned(sourceType: SchedulerSourceType, candidates: SchedulerPendingCandidate[]): Promise<void> {
    if (sourceType !== 'chat_learning' || candidates.length === 0) return;
    const now = new Date();
    const byRepo = new Map<string, SchedulerPendingCandidate[]>();
    const globalCandidates: SchedulerPendingCandidate[] = [];
    for (const candidate of candidates) {
      if (candidate.repoId) {
        const bucket = byRepo.get(candidate.repoId) ?? [];
        bucket.push(candidate);
        byRepo.set(candidate.repoId, bucket);
      } else {
        globalCandidates.push(candidate);
      }
    }
    for (const [repoId, repoCandidates] of byRepo) {
      await this.updateCursorForAssigned('chat_learning', 'repo', repoId, repoCandidates, now);
    }
    if (globalCandidates.length > 0) {
      await this.updateCursorForAssigned('chat_learning', 'global', 'global', globalCandidates, now);
    }
  }

  async markSourcesEvaluated(sourceType: SchedulerSourceType, candidates: SchedulerPendingCandidate[]): Promise<void> {
    if (sourceType !== 'chat_learning' || candidates.length === 0) return;
    const now = new Date();
    for (const candidate of candidates) {
      const scopeType = candidate.repoId ? 'repo' : 'global';
      const scopeKey = candidate.repoId ?? 'global';
      const update: Record<string, unknown> = {
        $set: {
          sourceType,
          scopeType,
          scopeKey,
          status: 'idle',
          lastEvaluatedAt: now,
          updatedAt: now,
          lastEvaluatedSourceIds: [candidate.sourceId],
          cursorReason: 'evaluated',
        },
      };
      if (candidate.createdAt) {
        update['$max'] = { lastCandidateCreatedAt: candidate.createdAt };
      }
      await this.db.collection('context_judge_scheduler_state').updateOne(
        { sourceType, scopeType, scopeKey },
        update as any,
        { upsert: true },
      );
    }
  }

  private async updateCursorForAssigned(
    sourceType: SchedulerSourceType,
    scopeType: 'repo' | 'global',
    scopeKey: string,
    candidates: SchedulerPendingCandidate[],
    now: Date,
  ): Promise<void> {
    const update: Record<string, unknown> = {
      sourceType,
      scopeType,
      scopeKey,
      status: 'idle',
      lastRunAt: now,
      updatedAt: now,
      lastAssignedSourceIds: candidates.map((candidate) => candidate.sourceId),
      cursorReason: 'assigned',
    };
    await this.db.collection('context_judge_scheduler_state').updateOne(
      { sourceType, scopeType, scopeKey },
      { $set: update },
      { upsert: true },
    );
  }

  /**
   * Convenience wrapper: advance the cursor to now and mark idle.
   * Called after a successful discovery batch.
   */
  async advanceCursor(sourceType: SchedulerSourceType): Promise<void> {
    await this.markIdle(sourceType, new Date().toISOString());
  }

  /**
   * List unevaluated context_usage_trace candidates for the exhaustive trace
   * evaluation orchestrator.
   *
   * Key differences from discoverPending('context_usage_trace'):
   *   - Cursor-based pagination using contextAttemptId (deterministic, not date).
   *   - Anti-joins against BOTH context_source_evaluations (completed evaluations)
   *     AND context_trace_analysis_assignments (in-flight assignments) to avoid
   *     assigning the same trace to multiple workers.
   *   - Failed assignments' sourceIds ARE included so they can be retried.
   *   - No date-cursor / scheduler state involved — pure DB-derived anti-join.
   *
   * The orchestrator loops until this returns an empty array.
   * It MUST NOT treat a result of exactly `limit` as meaning there are no more traces.
   *
   * @param params.repoId  - optional repo filter
   * @param params.limit   - max batch size (default 20, max 20)
   * @param params.cursor  - last contextAttemptId from previous page (exclusive lower bound)
   */
  async listUnevaluatedContextTraces(params: {
    repoId?: string;
    sessionId?: string;
    limit?: number;
    cursor?: string;
    excludeExecutionIds?: string[];
    excludeRootExecutionId?: string;
    excludeAgentNames?: string[];
  }): Promise<SchedulerPendingCandidate[]> {
    const limit = Math.min(params.limit ?? 20, 20);
    // Internal page size — large enough to absorb many excluded rows per page
    // without loading all rows at once. If an entire page is filtered out
    // (all evaluated or in-flight), the loop advances the cursor and fetches
    // the next page, preventing a false empty result.
    const INTERNAL_PAGE_SIZE = 100;

    const session = params.sessionId
      ? await this.db.collection('context_orchestration_sessions').findOne(
          { sessionId: params.sessionId },
          {
            projection: {
              rootExecutionId: 1,
              traceSnapshotStartedAt: 1,
              traceSnapshotMaxContextAttemptId: 1,
            },
          },
        ) as any
      : null;

    const excludedExecutionIds = new Set<string>(params.excludeExecutionIds ?? []);
    const rootExecutionId = params.excludeRootExecutionId ?? session?.rootExecutionId;
    if (rootExecutionId) {
      excludedExecutionIds.add(rootExecutionId);
      try {
        const children = await this.db.collection('executions')
          .find({ rootExecutionId }, { projection: { _id: 0, id: 1 } })
          .toArray();
        for (const child of children) {
          const id = (child as any).id as string | undefined;
          if (id) excludedExecutionIds.add(id);
        }
      } catch {
        // If executions are unavailable, keep explicit exclusions only.
      }
    }

    const excludedAgentNames = new Set<string>([
      'context-judge-orchestrator',
      'context-trace-analysis-agent',
      'context-learning-curator-agent',
      'context-review-triage-agent',
      'context-remediation-planner-agent',
      'context-curation-fix-agent',
      'context-ingestion-repair-agent',
      'context-code-fix-agent',
      'context-qa-eval-agent',
      ...(params.excludeAgentNames ?? []),
    ]);

    if (excludedAgentNames.size > 0) {
      try {
        const docs = await this.db.collection('executions')
          .find(
            {
              $or: [
                { agent_name: { $in: Array.from(excludedAgentNames) } },
                { workflowName: { $regex: 'context-(judge|trace|learning|review|remediation|curation|ingestion|code|qa)' } },
              ],
            },
            { projection: { _id: 0, id: 1 } },
          )
          .toArray();
        for (const doc of docs) {
          const id = (doc as any).id as string | undefined;
          if (id) excludedExecutionIds.add(id);
        }
      } catch {
        // Best-effort self-trace exclusion.
      }
    }

    // Load active (non-failed) assignment sourceIds once per call.
    // This is a bounded set (one entry per assignment) and avoids per-candidate
    // queries against the assignments collection.
    const activelyAssignedIds = new Set<string>();
    try {
      const activeDocs = await this.db
        .collection('context_trace_analysis_assignments')
        .find(
          { status: { $ne: 'failed' } },
          { projection: { sourceIds: 1 } },
        )
        .toArray();
      for (const d of activeDocs) {
        const ids = (d as any).sourceIds as string[] | undefined;
        if (Array.isArray(ids)) {
          for (const id of ids) activelyAssignedIds.add(id);
        }
      }
    } catch {
      // If collection doesn't exist yet, treat as empty
    }

    const results: SchedulerPendingCandidate[] = [];
    // internalCursor tracks where we are within the full context_attempts set.
    // It starts at the caller-provided cursor (orchestrator's pagination position)
    // and advances page-by-page within this call.
    let internalCursor = params.cursor;

    while (results.length < limit) {
      // Build query for this internal page
      const attemptQuery: Record<string, unknown> = {};
      if (params.repoId) attemptQuery['repoId'] = params.repoId;
      if (internalCursor) {
        attemptQuery['contextAttemptId'] = { $gt: internalCursor };
      }
      if (session?.traceSnapshotMaxContextAttemptId) {
        attemptQuery['contextAttemptId'] = {
          ...((attemptQuery['contextAttemptId'] as Record<string, unknown> | undefined) ?? {}),
          $lte: session.traceSnapshotMaxContextAttemptId,
        };
      }
      if (session?.traceSnapshotStartedAt) {
        attemptQuery['$or'] = [
          { createdAt: { $lte: new Date(session.traceSnapshotStartedAt) } },
          { createdAt: { $exists: false } },
        ];
      }
      if (excludedExecutionIds.size > 0) {
        attemptQuery['executionId'] = { $nin: Array.from(excludedExecutionIds) };
      }

      let pageCandidates: Array<{
        contextAttemptId: string;
        executionId?: string;
        repoId?: string;
        executionKind?: string;
      }> = [];

      try {
        const docs = await this.db
          .collection('context_attempts')
          .find(attemptQuery)
          .sort({ contextAttemptId: 1 })
          .limit(INTERNAL_PAGE_SIZE)
          .project({
            _id: 0,
            contextAttemptId: 1,
            executionId: 1,
            repoId: 1,
            executionKind: 1,
            createdAt: 1,
          })
          .toArray();

        pageCandidates = docs
          .map((d) => ({
            contextAttemptId: d['contextAttemptId'] as string,
            executionId: d['executionId'] as string | undefined,
            repoId: d['repoId'] as string | undefined,
            executionKind: d['executionKind'] as string | undefined,
          }))
          .filter((c) => Boolean(c.contextAttemptId));
      } catch {
        break;
      }

      // No more rows — exhausted the collection
      if (pageCandidates.length === 0) break;

      for (const candidate of pageCandidates) {
        if (results.length >= limit) break;

        const { contextAttemptId } = candidate;
        if (!contextAttemptId) continue;

        // Exclude in-flight assignments (non-failed)
        if (activelyAssignedIds.has(contextAttemptId)) continue;

        // Exclude already-completed evaluations
        const sourceKey = `context_usage_trace:${contextAttemptId}`;
        const alreadyEvaluated = await this.db
          .collection('context_source_evaluations')
          .findOne({ sourceKey, status: 'completed' }, { projection: { _id: 1 } });
        if (alreadyEvaluated) continue;

        results.push({
          sourceId: contextAttemptId,
          sourceKind: 'context_usage_trace',
          repoId: candidate.repoId,
          contextAttemptId,
          executionId: candidate.executionId || undefined,
          flowKind: candidate.executionKind || undefined,
        });
      }

      // Advance internal cursor to the last contextAttemptId in this page
      internalCursor = pageCandidates[pageCandidates.length - 1].contextAttemptId;

      // If page returned fewer than INTERNAL_PAGE_SIZE rows, we've reached
      // the end of context_attempts — no further pages exist
      if (pageCandidates.length < INTERNAL_PAGE_SIZE) break;
    }

    return results;
  }
}
