import { randomUUID } from 'node:crypto';
import type { Db, Collection } from 'mongodb';
import type { CuratedContextEditorService, CuratedContextPatch } from './curated-context-editor.service.js';
import { AUTO_CURATION_CONFIDENCE_THRESHOLD } from './context-judge-policy.js';
import { ContextRemediationTaskService } from './context-remediation-task.service.js';

export interface LearningPromotion {
  promotionId: string;
  rootExecutionId?: string;
  sessionId?: string;
  learningId: string;
  reviewTaskId?: string;
  action: 'create_curated_context' | 'remediate_curated_context';
  targetRepoId?: string;
  targetEntryId?: string;
  targetEntryIds?: string[];
  targetRefIds?: string[];
  affectedRefIds?: string[];
  sourceEvaluationIds?: string[];
  proposedPatch?: Record<string, unknown>;
  confidence?: number;
  estimatedRisk?: string;
  humanGateRequired?: boolean;
  suggestedContent?: string;
  targetRepoIds?: string[];
  decision?: 'approved' | 'rejected' | 'deferred';
  decidedBy?: string;
  decidedAt?: Date;
  remediationId?: string;
  remediationStatus?: string;
  status: 'pending' | 'approved' | 'rejected' | 'deferred' | 'executed' | 'failed';
  sourceValidationStatus?: 'not_required' | 'pending' | 'validated' | 'failed';
  sourceValidationNotes?: string;
  conflictStatus?: 'no_conflict' | 'conflict_detected' | 'conflict_resolved';
  conflictNotes?: string;
  proposedCuratedText?: string;
  reviewerNotes?: string;
  curationQualityWarnings?: string[];
  scope?: 'repo' | 'cross_repo' | 'global' | 'workflow' | 'agent' | 'user_preference';
  createdAt: Date;
  updatedAt: Date;
}

export class LearningPromotionService {
  private collection: Collection<LearningPromotion>;

  constructor(private db: Db) {
    this.collection = db.collection<LearningPromotion>('context_learning_promotions');
  }

  async create(input: {
    learningId: string;
    rootExecutionId?: string;
    sessionId?: string;
    reviewTaskId?: string;
    action: 'create_curated_context' | 'remediate_curated_context' | 'update_curated_context';
    targetRepoId?: string;
    targetEntryId?: string;
    targetEntryIds?: string[];
    targetRefIds?: string[];
    affectedRefIds?: string[];
    sourceEvaluationIds?: string[];
    proposedPatch?: Record<string, unknown>;
    confidence?: number;
    estimatedRisk?: string;
    humanGateRequired?: boolean;
    suggestedContent?: string;
    proposedCuratedText?: string;
    targetRepoIds?: string[];
    remediationId?: string;
    sourceValidationStatus?: LearningPromotion['sourceValidationStatus'];
    conflictStatus?: LearningPromotion['conflictStatus'];
    curationQualityWarnings?: string[];
    scope?: LearningPromotion['scope'];
  }): Promise<LearningPromotion> {
    const now = new Date();
    const action = input.action === 'update_curated_context' ? 'remediate_curated_context' : input.action;
    const humanGateRequired = this.resolveHumanGate(input);
    const promotion: LearningPromotion = {
      promotionId: randomUUID(),
      rootExecutionId: input.rootExecutionId,
      sessionId: input.sessionId,
      learningId: input.learningId,
      reviewTaskId: input.reviewTaskId,
      action,
      targetRepoId: input.targetRepoId,
      targetRepoIds: input.targetRepoIds,
      targetEntryId: input.targetEntryId,
      targetEntryIds: input.targetEntryIds ?? (input.targetEntryId ? [input.targetEntryId] : undefined),
      targetRefIds: input.targetRefIds,
      affectedRefIds: input.affectedRefIds,
      sourceEvaluationIds: input.sourceEvaluationIds,
      proposedPatch: input.proposedPatch,
      confidence: input.confidence,
      estimatedRisk: input.estimatedRisk,
      humanGateRequired,
      suggestedContent: input.suggestedContent,
      proposedCuratedText: input.proposedCuratedText,
      remediationId: input.remediationId,
      sourceValidationStatus: input.sourceValidationStatus,
      conflictStatus: input.conflictStatus,
      curationQualityWarnings: input.curationQualityWarnings,
      scope: input.scope,
      status: humanGateRequired ? 'pending' : 'approved',
      decision: humanGateRequired ? undefined : 'approved',
      decidedBy: humanGateRequired ? undefined : 'system:auto_curation',
      decidedAt: humanGateRequired ? undefined : now,
      createdAt: now,
      updatedAt: now,
    };
    for (const key of Object.keys(promotion) as (keyof LearningPromotion)[]) {
      if (promotion[key] === undefined) delete promotion[key];
    }
    await this.collection.insertOne(promotion as any);
    if (!humanGateRequired && !promotion.remediationId) {
      const remediation = await this.createAutoRemediation(promotion);
      promotion.remediationId = remediation.remediationId;
      await this.collection.updateOne(
        { promotionId: promotion.promotionId },
        { $set: { remediationId: remediation.remediationId, updatedAt: now } },
      );
    }
    return promotion;
  }

  async get(promotionId: string): Promise<LearningPromotion | null> {
    return this.collection.findOne({ promotionId }) as Promise<LearningPromotion | null>;
  }

  async list(params: {
    learningId?: string;
    decision?: string;
    status?: string;
    limit?: number;
    offset?: number;
    targetRepoId?: string;
    remediationStatus?: string;
  }): Promise<LearningPromotion[]> {
    const filter = await this.buildListFilter(params);
    const limit = Math.min(params.limit ?? 50, 200);
    const offset = params.offset ?? 0;
    const promotions = await this.collection
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limit)
      .toArray() as LearningPromotion[];
    const remediationIds = promotions.map((promotion) => promotion.remediationId).filter((id): id is string => Boolean(id));
    if (remediationIds.length === 0) return promotions;
    const remediations = await this.db.collection('context_remediations')
      .find({ remediationId: { $in: remediationIds } })
      .project({ _id: 0, remediationId: 1, status: 1 })
      .toArray();
    const statusById = new Map(remediations.map((doc) => [doc['remediationId'] as string, doc['status'] as string]));
    const enriched = promotions
      .map((promotion) => ({
        ...promotion,
        remediationStatus: promotion.remediationId ? statusById.get(promotion.remediationId) : undefined,
      }));
    return enriched as LearningPromotion[];
  }

  async count(params: {
    learningId?: string;
    decision?: string;
    status?: string;
    targetRepoId?: string;
    remediationStatus?: string;
  }): Promise<number> {
    return this.collection.countDocuments(await this.buildListFilter(params));
  }

  private async buildListFilter(params: {
    learningId?: string;
    decision?: string;
    status?: string;
    targetRepoId?: string;
    remediationStatus?: string;
  }): Promise<Record<string, unknown>> {
    const filter: Record<string, unknown> = {};
    if (params.learningId) filter.learningId = params.learningId;
    if (params.decision) filter.decision = params.decision;
    if (params.status) filter.status = params.status;
    if (params.targetRepoId) filter.targetRepoId = params.targetRepoId;
    if (params.remediationStatus) {
      const remediationIds = await this.db.collection('context_remediations')
        .find({ status: params.remediationStatus })
        .project({ _id: 0, remediationId: 1 })
        .toArray();
      filter.remediationId = remediationIds.length > 0
        ? { $in: remediationIds.map((doc) => doc['remediationId'] as string).filter(Boolean) }
        : '__no_matching_remediation__';
    }
    return filter;
  }

  async decide(
    promotionId: string,
    decision: {
      actor: string;
      decision: 'approved' | 'rejected' | 'deferred';
      notes?: string;
    },
  ): Promise<LearningPromotion> {
    const now = new Date();
    const newStatus = decision.decision === 'approved'
      ? 'approved'
      : decision.decision === 'rejected'
        ? 'rejected'
        : 'deferred';

    await this.collection.updateOne(
      { promotionId },
      {
        $set: {
          decision: decision.decision,
          decidedBy: decision.actor,
          decidedAt: now,
          status: newStatus,
          updatedAt: now,
        },
      },
    );

    const updated = await this.get(promotionId);
    if (!updated) throw new Error(`Promotion not found: ${promotionId}`);
    return updated;
  }

  async updateValidation(
    promotionId: string,
    update: {
      sourceValidationStatus?: 'not_required' | 'pending' | 'validated' | 'failed';
      sourceValidationNotes?: string;
      conflictStatus?: 'no_conflict' | 'conflict_detected' | 'conflict_resolved';
      conflictNotes?: string;
      proposedCuratedText?: string;
      reviewerNotes?: string;
      scope?: 'repo' | 'cross_repo' | 'global' | 'workflow' | 'agent' | 'user_preference';
    },
  ): Promise<LearningPromotion | null> {
    const now = new Date();
    const $set: Record<string, unknown> = { updatedAt: now };
    if (update.sourceValidationStatus !== undefined) $set['sourceValidationStatus'] = update.sourceValidationStatus;
    if (update.sourceValidationNotes !== undefined) $set['sourceValidationNotes'] = update.sourceValidationNotes;
    if (update.conflictStatus !== undefined) $set['conflictStatus'] = update.conflictStatus;
    if (update.conflictNotes !== undefined) $set['conflictNotes'] = update.conflictNotes;
    if (update.proposedCuratedText !== undefined) $set['proposedCuratedText'] = update.proposedCuratedText;
    if (update.reviewerNotes !== undefined) $set['reviewerNotes'] = update.reviewerNotes;
    if (update.scope !== undefined) $set['scope'] = update.scope;

    await this.collection.updateOne({ promotionId }, { $set });
    return this.get(promotionId);
  }

  async execute(promotionId: string, editor: CuratedContextEditorService): Promise<LearningPromotion> {
    const promotion = await this.get(promotionId);
    if (!promotion) throw new Error(`Promotion not found: ${promotionId}`);
    if (promotion.decision !== 'approved') {
      throw new Error(`Promotion ${promotionId} is not approved (status: ${promotion.status})`);
    }

    const now = new Date();

    try {
      if (promotion.action === 'create_curated_context') {
        // Create a new entry in repo_context_curation_entries
        const entryId = firstString(promotion.proposedPatch?.['path'])
          ?? firstString(promotion.targetEntryId)
          ?? `learning:${promotion.promotionId}`;
        const repoId = promotion.targetRepoId ?? 'global';
        await editor.applyEdit(
          repoId,
          entryId,
          buildPatchFromPromotion(promotion),
          {
            actor: promotion.decidedBy ?? 'system',
            source: 'learning_promotion',
            learningId: promotion.learningId,
            reviewTaskId: promotion.reviewTaskId,
          },
        );
      } else if (promotion.action === 'remediate_curated_context') {
        if (!promotion.targetRepoId || !promotion.targetEntryId) {
          throw new Error('remediate_curated_context requires targetRepoId and targetEntryId');
        }
        await editor.applyEdit(
          promotion.targetRepoId,
          promotion.targetEntryId,
          buildPatchFromPromotion(promotion),
          {
            actor: promotion.decidedBy ?? 'system',
            source: 'learning_promotion',
            learningId: promotion.learningId,
            reviewTaskId: promotion.reviewTaskId,
          },
        );
      }

      await this.collection.updateOne(
        { promotionId },
        { $set: { status: 'executed', updatedAt: now } },
      );
    } catch (err) {
      await this.collection.updateOne(
        { promotionId },
        {
          $set: {
            status: 'failed',
            updatedAt: now,
          },
        },
      );
      throw err;
    }

    const result = await this.get(promotionId);
    return result!;
  }

  private resolveHumanGate(input: {
    confidence?: number;
    estimatedRisk?: string;
    humanGateRequired?: boolean;
    sourceValidationStatus?: LearningPromotion['sourceValidationStatus'];
    conflictStatus?: LearningPromotion['conflictStatus'];
  }): boolean {
    if (input.estimatedRisk === 'high' || input.estimatedRisk === 'critical') return true;
    if (typeof input.confidence !== 'number' || input.confidence < AUTO_CURATION_CONFIDENCE_THRESHOLD) return true;
    if (input.sourceValidationStatus === 'failed' || input.sourceValidationStatus === 'pending') return true;
    if (input.conflictStatus === 'conflict_detected') return true;
    return false;
  }

  private async createAutoRemediation(promotion: LearningPromotion) {
    const proposedPatch = buildPatchFromPromotion(promotion);
    const targetEntryId = promotion.targetEntryId
      ?? firstString(promotion.proposedPatch?.['path'])
      ?? `learning:${promotion.promotionId}`;
    const remediation = await new ContextRemediationTaskService(this.db).create({
      taskId: promotion.reviewTaskId ?? promotion.promotionId,
      rootExecutionId: promotion.rootExecutionId,
      sessionId: promotion.sessionId,
      findingId: promotion.learningId,
      judgeRunId: promotion.sourceEvaluationIds?.[0] ?? promotion.promotionId,
      actionKind: promotion.action === 'create_curated_context' ? 'curated_entry_create' : 'curated_entry_edit',
      remediationKind: promotion.action === 'create_curated_context' ? 'memory_add' : 'curation_metadata_update',
      workerRole: 'context_curation_fix',
      targetRepoId: promotion.targetRepoId,
      targetEntryIds: promotion.targetEntryIds ?? [targetEntryId],
      targetRefIds: promotion.targetRefIds,
      affectedRefIds: promotion.affectedRefIds,
      sourceEvaluationIds: promotion.sourceEvaluationIds,
      proposedPatch: {
        ...(promotion.proposedPatch ?? {}),
        ...proposedPatch,
        sourcePromotionId: promotion.promotionId,
        sourceLearningId: promotion.learningId,
      },
      validationPlan: 'Verify the curated entry revision exists, Cognee curation is marked stale, and retrievalText/curatedContext are runtime-impacting fields.',
      estimatedRisk: promotion.estimatedRisk,
      confidence: promotion.confidence,
      humanGateRequired: false,
    });
    return remediation;
  }
}

function buildPatchFromPromotion(promotion: LearningPromotion): CuratedContextPatch & Record<string, unknown> {
  const proposed = promotion.proposedPatch ?? {};
  const curatedContext = firstString(proposed['curatedContext'])
    ?? firstString(proposed['curated_context'])
    ?? promotion.proposedCuratedText
    ?? promotion.suggestedContent;
  const retrievalText = firstString(proposed['retrievalText'])
    ?? firstString(proposed['retrieval_text'])
    ?? promotion.suggestedContent
    ?? promotion.proposedCuratedText;
  const patch: CuratedContextPatch & Record<string, unknown> = {
    ...proposed,
    title: firstString(proposed['title']) ?? `Learning promotion ${promotion.promotionId}`,
    category: firstString(proposed['category']) ?? (promotion.scope === 'global' || promotion.scope === 'user_preference' ? 'user_preference' : 'module_rule'),
    injectionPolicy: firstString(proposed['injectionPolicy']) ?? 'snippet',
  };
  if (curatedContext) patch['curatedContext'] = curatedContext;
  if (retrievalText) patch['retrievalText'] = retrievalText;
  if (!patch['chunks'] && (curatedContext || retrievalText)) {
    patch['chunks'] = [{ text: String(curatedContext ?? retrievalText) }];
  }
  return patch;
}

function firstString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}
