
import type { Request, Response } from 'express';
import { isContextEngineEnabled } from '../services/context/config/context-provider-config.js';
import { param } from '../types.js';
import { contextProviderDisabledPayload, type ContextQualityRouteDeps } from './context-quality.route-utils.js';
import type { Router } from 'express';
import type { RemediationActionKind } from '../services/context/judge/context-judge.types.js';
import type { RemediationKind } from '../services/context/judge/context-remediation-task.service.js';
import { curatedContextQualityWarnings, normalizeCuratedEditPatch } from './context-quality.route-utils.js';

export function registerContextQualityRemediationRoutes(router: Router, deps: ContextQualityRouteDeps): void {
  const { db, remediationService, editorService, promotionService } = deps;
    // ─── Remediation Tasks ───────────────────────────────────────────────────────
  
    router.get('/remediation-tasks', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const {
          taskId, remediationId, workerRole, status, repoId, targetRepoId,
          includeAssignments, includeRevisions, limit, offset, includeTotal,
        } = req.query;
        const parsedLimit = limit ? parseInt(limit as string, 10) : undefined;
        const parsedOffset = offset ? parseInt(offset as string, 10) : undefined;
        const remediations = await remediationService.list({
          taskId: taskId as string | undefined,
          remediationId: remediationId as string | undefined,
          workerRole: workerRole as string | undefined,
          status: status as string | undefined,
          targetRepoId: (targetRepoId ?? repoId) as string | undefined,
          includeAssignments: includeAssignments === 'true',
          includeRevisions: includeRevisions === 'true',
          limit: parsedLimit,
          offset: parsedOffset,
        });
        if (includeTotal === 'true') {
          const total = await remediationService.count({
            taskId: taskId as string | undefined,
            remediationId: remediationId as string | undefined,
            workerRole: workerRole as string | undefined,
            status: status as string | undefined,
            targetRepoId: (targetRepoId ?? repoId) as string | undefined,
          });
          return res.json({ items: remediations, total, limit: Math.min(parsedLimit ?? 50, 200), offset: parsedOffset ?? 0 });
        }
        res.json(remediations);
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    router.post('/remediation-tasks', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const {
          taskId, findingId, judgeRunId, actionKind, fixType,
          remediationKind, workerRole, targetEntryId, targetEntryIds,
          targetRefId, targetRefIds, targetMappingId, targetMappingIds,
          targetRepoId, sourceEvaluationIds, affectedRefIds, proposedPatch, retrievalReplayId, validationPlan,
          estimatedRisk, confidence, humanGateRequired,
        } = req.body ?? {};
        // GAP 6: accept fixType as backwards-compat alias for actionKind so the
        // context_quality_create_remediation_task MCP tool (which uses fixType) works.
        const resolvedActionKind = (actionKind ?? fixType) as RemediationActionKind | undefined;
        if (!taskId || !findingId || !judgeRunId || !resolvedActionKind) {
          return res.status(400).json({ error: 'taskId, findingId, judgeRunId, actionKind (or fixType) are required' });
        }
        const remediation = await remediationService.create({
          taskId,
          findingId,
          judgeRunId,
          actionKind: resolvedActionKind,
          remediationKind: remediationKind as RemediationKind | undefined,
          workerRole,
          targetEntryIds: Array.isArray(targetEntryIds) ? targetEntryIds : (targetEntryId ? [String(targetEntryId)] : undefined),
          targetRefIds: Array.isArray(targetRefIds) ? targetRefIds : (targetRefId ? [String(targetRefId)] : undefined),
          targetMappingIds: Array.isArray(targetMappingIds) ? targetMappingIds : (targetMappingId ? [String(targetMappingId)] : undefined),
          targetRepoId,
          sourceEvaluationIds: Array.isArray(sourceEvaluationIds) ? sourceEvaluationIds : undefined,
          affectedRefIds: Array.isArray(affectedRefIds) ? affectedRefIds : undefined,
          proposedPatch,
          retrievalReplayId,
          validationPlan,
          estimatedRisk,
          confidence,
          humanGateRequired,
        });
        res.status(201).json(remediation);
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    router.patch('/remediation-tasks/:taskId', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const remediationId = param(req, 'taskId');
        const { status, result, error } = req.body ?? {};
        let updated = false;
        if (status === 'completed' && result) {
          updated = await remediationService.complete(remediationId, result);
        } else if (status === 'failed' && error) {
          updated = await remediationService.fail(remediationId, error);
        } else {
          return res.status(400).json({ error: 'Provide status=completed+result or status=failed+error' });
        }
        if (!updated) return res.status(404).json({ error: 'Remediation not found or not updated' });
        res.json({ updated: true });
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    router.post('/remediation-tasks/:taskId/dispatch', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const dispatched = await remediationService.dispatch(param(req, 'taskId'));
        if (!dispatched) return res.status(404).json({ error: 'Remediation not found or not updated' });
        res.json({ dispatched: true });
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    // ─── Curated Edits ───────────────────────────────────────────────────────────
  
    router.get('/curated-entries/:repoId/:entryId', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const entry = await editorService.getEntry(param(req, 'repoId'), param(req, 'entryId'));
        if (!entry) return res.status(404).json({ error: 'Curated entry not found' });
        res.json(entry);
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    router.get('/curated-edits/:repoId/:entryId/history', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const { limit } = req.query;
        const history = await editorService.getHistory(
          param(req, 'repoId'),
          param(req, 'entryId'),
          limit ? parseInt(limit as string, 10) : undefined,
        );
        res.json(history);
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    router.post('/curated-edits/:repoId/:entryId', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const {
          chunks, content, title, category, description, summary, curatedContext, retrievalText,
          inclusion, injectionPolicy, authority, freshness, memoryType,
          appliesToAgents, appliesToGlobs, appliesToTaskKinds,
          positiveTaskHints, negativeTaskHints, demoteWhen, requirePositiveSignals, budgetPolicy,
          patch, proposedPatch, metadataUpdates, action, actor, source,
          sourceReviewTaskId, sourceLearningId, sourcePromotionId, remediationId,
          expectedEntryVersionId, expected_entry_version_id,
        } = req.body ?? {};
        const structuredPatch = normalizeCuratedEditPatch({
          chunks,
          content,
          title,
          category,
          description,
          summary,
          curatedContext,
          retrievalText,
          inclusion,
          injectionPolicy,
          authority,
          freshness,
          memoryType,
          appliesToAgents,
          appliesToGlobs,
          appliesToTaskKinds,
          positiveTaskHints,
          negativeTaskHints,
          demoteWhen,
          requirePositiveSignals,
          budgetPolicy,
          patch,
          proposedPatch,
          metadataUpdates,
        });
        const qualityWarnings = curatedContextQualityWarnings(structuredPatch);
        const result = await editorService.applyEdit(
          param(req, 'repoId'),
          param(req, 'entryId'),
          structuredPatch,
          {
            actor: actor ?? 'system',
            source: source ?? 'manual_edit',
            reviewTaskId: sourceReviewTaskId,
            learningId: sourceLearningId ?? sourcePromotionId,
            remediationId,
            action: action === 'archive' ? 'archive' : action === 'create' ? 'create' : 'update',
            expectedEntryVersionId: expectedEntryVersionId ?? expected_entry_version_id,
          },
        );
        if (remediationId) {
          await remediationService.recordAppliedRevision({
            remediationId: String(remediationId),
            revisionId: result.revision.revisionId,
            entryVersionId: result.revision.afterEntryVersionId,
          }).catch(() => {});
        }
        res.status(201).json({ ...result, qualityWarnings });
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    router.post('/curated-edits/:repoId/:entryId/revert/:revisionId', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const { actor } = req.body ?? {};
        const result = await editorService.revert(
          param(req, 'repoId'),
          param(req, 'entryId'),
          param(req, 'revisionId'),
          { actor: actor ?? 'system' },
        );
        res.status(201).json(result);
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    // ─── Learning Promotions ─────────────────────────────────────────────────────
  
    router.get('/learning-promotions', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const { learningId, decision, status, repoId, targetRepoId, remediationStatus, limit, offset, includeTotal } = req.query;
        const parsedLimit = limit ? parseInt(limit as string, 10) : undefined;
        const parsedOffset = offset ? parseInt(offset as string, 10) : undefined;
        const promotions = await promotionService.list({
          learningId: learningId as string | undefined,
          decision: decision as string | undefined,
          status: status as string | undefined,
          targetRepoId: (targetRepoId ?? repoId) as string | undefined,
          remediationStatus: remediationStatus as string | undefined,
          limit: parsedLimit,
          offset: parsedOffset,
        });
        if (includeTotal === 'true') {
          const total = await promotionService.count({
            learningId: learningId as string | undefined,
            decision: decision as string | undefined,
            status: status as string | undefined,
            targetRepoId: (targetRepoId ?? repoId) as string | undefined,
            remediationStatus: remediationStatus as string | undefined,
          });
          return res.json({ items: promotions, total, limit: Math.min(parsedLimit ?? 50, 200), offset: parsedOffset ?? 0 });
        }
        res.json(promotions);
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    router.post('/learning-promotions', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const {
          learningId, rootExecutionId, sessionId, reviewTaskId, action, targetRepoId, targetEntryId, targetEntryIds,
          targetRefIds, affectedRefIds, sourceEvaluationIds, proposedPatch, confidence,
          estimatedRisk, humanGateRequired, suggestedContent, proposedCuratedText,
          targetRepoIds, remediationId, sourceValidationStatus, conflictStatus,
          curationQualityWarnings, scope,
        } = req.body ?? {};
        if (!learningId || !action) {
          return res.status(400).json({ error: 'learningId and action are required' });
        }
        const promotion = await promotionService.create({
          learningId,
          rootExecutionId,
          sessionId,
          reviewTaskId,
          action,
          targetRepoId,
          targetRepoIds,
          targetEntryId,
          targetEntryIds,
          targetRefIds,
          affectedRefIds,
          sourceEvaluationIds,
          proposedPatch,
          confidence,
          estimatedRisk,
          humanGateRequired,
          suggestedContent,
          proposedCuratedText,
          remediationId,
          sourceValidationStatus,
          conflictStatus,
          curationQualityWarnings,
          scope,
        });
        res.status(201).json(promotion);
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    router.post('/learning-promotions/:id/decisions', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const { actor, decision, notes } = req.body ?? {};
        if (!actor || !decision) {
          return res.status(400).json({ error: 'actor and decision are required' });
        }
        const updated = await promotionService.decide(param(req, 'id'), { actor, decision, notes });
        res.status(201).json(updated);
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    // ─── Config ──────────────────────────────────────────────────────────────────
  
    router.get('/config', async (_req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        const config = await db
          .collection('context_judge_config')
          .findOne({ configId: 'singleton' });
        if (!config) return res.status(404).json({ error: 'Config not found' });
        res.json(config);
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  
    router.patch('/config', async (req: Request, res: Response) => {
      try {
        if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
        // Admin-only: requireAuth sets req.user. Auth shape uses (req as any).user?.role
        // Note: the actual req.user shape depends on requireAuth middleware which may vary;
        // using (req as any).user?.role is the safe approach until the auth shape is confirmed.
        if ((req as any).user?.role !== 'admin') {
          return res.status(403).json({ error: 'Admin role required to update config' });
        }
        const patch = req.body ?? {};
        await db.collection('context_judge_config').updateOne(
          { configId: 'singleton' },
          { $set: { ...patch, updatedAt: new Date() } },
        );
        const updated = await db.collection('context_judge_config').findOne({ configId: 'singleton' });
        res.json(updated);
      } catch (err: unknown) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
}
