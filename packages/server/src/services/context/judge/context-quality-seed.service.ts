/**
 * Context Quality Bootstrap — idempotent startup seed/backfill.
 *
 * Runs at every server boot via runBootTasks(). Safe to call multiple times.
 *
 * What it does:
 * 1. Upsert context_judge_config singleton (preserves existing custom values).
 * 2. Upsert 8 scheduler cursor rows in context_judge_scheduler_state.
 * 3. Additive backfill: add contextEligibility field to learnings (null default).
 * 4. Additive backfill: add semantic.judgeRunId field to context_evaluations (null default).
 * 5. Additive backfill: add entryVersionId/lastEditedBy/lastEditedAt to
 *    repo_context_curation_entries (for entries that pre-date edit tracking).
 * 6. Seed one initial revision row per existing curated entry that has no revision yet.
 *
 * Indexes for these collections are handled by ensureIndexes() in database/indexes.ts
 * and must not be duplicated here.
 *
 * Note: No demo/sample findings are seeded in production boot.
 */

import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { logger } from '../../../logger.js';
import type {
  ContextJudgeConfig,
  SchedulerCursorRow,
  SchedulerSourceType,
} from './context-judge.types.js';

const COMPONENT = 'context-quality-seed';

const SCHEDULER_SOURCE_TYPES: SchedulerSourceType[] = [
  'workflow_run',
  'spawned_agent_run',
  'chat_turn',
  'context_usage_trace',
  'deterministic_warning',
  'human_feedback',
  'chat_learning',
  'stale_finding',
];

const DEFAULT_CONFIG: ContextJudgeConfig = {
  configId: 'singleton',
  autoRemediationEnabled: false,
  autoRemediationThresholds: {
    minConfidence: 0.85,
    maxRisk: 'low',
    allowedFixTypes: [
      'curated_context_edit',
      'curated_context_create',
      'curated_context_archive',
      'no_action',
    ],
  },
  mandatoryHumanReview: {
    lowConfidenceThreshold: 0.5,
    highRiskLevels: ['high', 'critical'],
    alwaysForScopes: ['cross_repo', 'global'],
    alwaysForLearningDerived: true,
    alwaysForCodeFix: true,
  },
  updatedAt: new Date(),
};

export async function seedContextQuality(db: Db): Promise<void> {
  try {
    // 1. Upsert singleton config — only inserts if missing; preserves existing values.
    await db.collection('context_judge_config').updateOne(
      { configId: 'singleton' },
      { $setOnInsert: DEFAULT_CONFIG },
      { upsert: true },
    );
    logger.info('[context-quality-seed] Singleton config ensured', { component: COMPONENT });

    // 2. Upsert 8 scheduler cursor rows — only inserts missing rows.
    const now = new Date();
    let schedulerSeeded = 0;
    for (const sourceType of SCHEDULER_SOURCE_TYPES) {
      const row: SchedulerCursorRow = {
        sourceType,
        status: 'idle',
        updatedAt: now,
      };
      const result = await db.collection('context_judge_scheduler_state').updateOne(
        { sourceType },
        { $setOnInsert: row },
        { upsert: true },
      );
      if (result.upsertedCount > 0) schedulerSeeded++;
    }
    await db.collection('context_judge_scheduler_state').updateOne(
      { sourceType: 'chat_learning', scopeType: 'global', scopeKey: 'global' },
      {
        $setOnInsert: {
          sourceType: 'chat_learning',
          scopeType: 'global',
          scopeKey: 'global',
          status: 'idle',
          updatedAt: now,
        } satisfies SchedulerCursorRow,
      },
      { upsert: true },
    );
    if (schedulerSeeded > 0) {
      logger.info(`[context-quality-seed] Seeded ${schedulerSeeded} scheduler cursor rows`, { component: COMPONENT });
    }

    // 3. Additive backfill: contextEligibility on learnings (null for pre-existing docs)
    const learningsResult = await db.collection('learnings').updateMany(
      { contextEligibility: { $exists: false } },
      { $set: { contextEligibility: null } },
    );
    if (learningsResult.modifiedCount > 0) {
      logger.info(`[context-quality-seed] Backfilled contextEligibility on ${learningsResult.modifiedCount} learnings`, { component: COMPONENT });
    }

    // 3b. Reconcile stale review queue values from older planner dispatches.
    // Planning-dispatched review tasks are not fix-worker dispatches; they must
    // not appear in the Dispatched tab after queue semantics changed.
    const stalePlanningAuto = await db.collection('context_review_tasks').updateMany(
      {
        queue: 'dispatched',
        remediationStatus: 'planning_dispatched',
        requiresHumanReview: { $ne: true },
      },
      { $set: { queue: 'open', updatedAt: now } },
    );
    const stalePlanningHuman = await db.collection('context_review_tasks').updateMany(
      {
        queue: 'dispatched',
        remediationStatus: 'planning_dispatched',
        requiresHumanReview: true,
      },
      { $set: { queue: 'needs_review', updatedAt: now } },
    );
    const stalePlanningCount = stalePlanningAuto.modifiedCount + stalePlanningHuman.modifiedCount;
    if (stalePlanningCount > 0) {
      logger.info(`[context-quality-seed] Reconciled ${stalePlanningCount} stale planning-dispatched review tasks`, { component: COMPONENT });
    }

    // 4. Additive backfill: semantic.judgeRunId on context_evaluations
    const evalsResult = await db.collection('context_evaluations').updateMany(
      { 'semantic.judgeRunId': { $exists: false } },
      { $set: { 'semantic.judgeRunId': null } },
    );
    if (evalsResult.modifiedCount > 0) {
      logger.info(`[context-quality-seed] Backfilled semantic.judgeRunId on ${evalsResult.modifiedCount} context_evaluations`, { component: COMPONENT });
    }

    // 5. Additive backfill: temporal edit tracking fields on repo_context_curation_entries
    const curationResult = await db.collection('repo_context_curation_entries').updateMany(
      {
        $or: [
          { active: { $exists: false } },
          { validFrom: { $exists: false } },
        ],
      },
      {
        $set: {
          active: true,
          validTo: null,
        },
      },
    );
    await db.collection('repo_context_curation_entries').updateMany(
      { lastEditedBy: { $exists: false } },
      { $set: { lastEditedBy: null, lastEditedAt: null } },
    );
    const entriesMissingVersionId = await db.collection('repo_context_curation_entries')
      .find({
        $or: [
          { entryVersionId: { $exists: false } },
          { validFrom: { $exists: false } },
        ],
      })
      .project({ _id: 1, entryVersionId: 1, createdAt: 1, updatedAt: 1 })
      .toArray();
    for (const entry of entriesMissingVersionId) {
      await db.collection('repo_context_curation_entries').updateOne(
        { _id: entry['_id'] },
        {
          $set: {
            ...(entry['entryVersionId'] ? {} : { entryVersionId: randomUUID() }),
            validFrom: entry['createdAt'] ?? entry['updatedAt'] ?? now,
          },
        },
      );
    }
    if (curationResult.modifiedCount > 0) {
      logger.info(`[context-quality-seed] Backfilled edit tracking on ${curationResult.modifiedCount} curation entries`, { component: COMPONENT });
    }

    // 6. Seed initial revision rows for curated entries that have no revision yet.
    // Reads are batched via cursor; inserts only when no revision exists for the entry.
    const existingEntries = await db
      .collection('repo_context_curation_entries')
      .find({})
      .project({ _id: 0, repoId: 1, entryId: 1, chunks: 1, createdAt: 1 })
      .toArray();

    let revisionsSeedCount = 0;
    for (const entry of existingEntries) {
      if (!entry['entryId']) continue;
      const existing = await db
        .collection('repo_context_curation_entry_revisions')
        .findOne({ entryId: entry['entryId'] });
      if (existing) continue;

      await db.collection('repo_context_curation_entry_revisions').insertOne({
        revisionId: randomUUID(),
        repoId: entry['repoId'],
        entryId: entry['entryId'],
        before: null,
        after: { chunks: entry['chunks'] },
        diff: null,
        source: 'boot_seed',
        actor: 'system',
        reviewTaskId: null,
        remediationId: null,
        learningId: null,
        createdAt: entry['createdAt'] ?? now,
      });
      revisionsSeedCount++;
    }
    if (revisionsSeedCount > 0) {
      logger.info(`[context-quality-seed] Seeded ${revisionsSeedCount} initial curation entry revision rows`, { component: COMPONENT });
    }

    logger.info('[context-quality-seed] Bootstrap complete', { component: COMPONENT });
  } catch (err) {
    // Log and rethrow — boot task failures are surfaced by the caller.
    logger.error('[context-quality-seed] Bootstrap failed', {
      component: COMPONENT,
      error: (err as Error).message,
    });
    throw err;
  }
}
