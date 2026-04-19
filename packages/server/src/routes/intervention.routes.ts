/**
 * Intervention Routes
 *
 * REST surface for the workflow_interventions collection. Powers:
 *   - the Interventions list page (/interventions)
 *   - the Intervention detail page (/interventions/:id)
 *   - the workflow execution page's pending-intervention indicator
 *   - the chat intervention card's action buttons
 *   - the Slack "Review in Allen →" link-through
 *
 * Response handling:
 *   POST /api/interventions/:id/respond with body:
 *     { decision, feedback?, scope?, answer? }
 *   triggers the downstream workflow action — advance, loop-back
 *   retry with feedback (via existing submit_execution_input), or
 *   abandon. The actual retry mechanics set workflow state fields
 *   that the engine's existing useMinimalRetryPrompt logic picks up;
 *   zero engine changes.
 */

import { Router, type Request, type Response } from 'express';
import type { Db } from 'mongodb';
import {
  InterventionService,
  type InterventionDecision,
  type InterventionScope,
  type InterventionSeverity,
  type InterventionStatus,
} from '../services/intervention.service.js';
import { ExecutionService } from '../services/execution.service.js';
import { param } from '../types.js';

export function interventionRoutes(db: Db): Router {
  const router = Router();
  const service = new InterventionService(db);
  const executionService = new ExecutionService(db);

  // GET /api/interventions
  router.get('/', async (req: Request, res: Response) => {
    try {
      const docs = await service.list({
        status: req.query.status as InterventionStatus | undefined,
        workflow_run_id: req.query.workflow_run_id as string | undefined,
        started_by_user_id: req.query.started_by_user_id as string | undefined,
        workflow_name: req.query.workflow_name as string | undefined,
        severity: req.query.severity as InterventionSeverity | undefined,
        limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      });
      res.json(docs);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/interventions/by-workflow-run/:workflowRunId
  router.get('/by-workflow-run/:workflowRunId', async (req: Request, res: Response) => {
    try {
      const docs = await service.listForWorkflowRun(param(req, 'workflowRunId'));
      res.json(docs);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/interventions/:id
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const doc = await service.get(param(req, 'id'));
      if (!doc) return res.status(404).json({ error: 'Intervention not found' });
      res.json(doc);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/interventions/:id/respond
  // Body: {
  //   decision,
  //   field_values?,     ← NEW: map of field name → value, keys must match
  //                        the original human node's fields. The UI
  //                        collects these dynamically from the intervention's
  //                        stored `fields` array. If absent, we fall back
  //                        to the legacy `answer` field for backward compat.
  //   feedback?, scope?, answer?, answered_by_user_id?,
  //   human_node_name?, retry_target_override?
  // }
  //
  // Decision → downstream action:
  //
  //   approve / answer → call ExecutionService.submitInput with the
  //     field_values payload (keys = original field names). The engine
  //     merges this into state so downstream nodes see the right keys.
  //
  //   request_changes → set retry state fields, call retryFromNode.
  //
  //   reject → cancel the execution.
  router.post('/:id/respond', async (req: Request, res: Response) => {
    try {
      const intervention_id = param(req, 'id');
      const {
        decision,
        field_values,
        feedback,
        scope,
        answer,
        answered_by_user_id,
        human_node_name,
        retry_target_override,
      } = (req.body ?? {}) as {
        decision?: InterventionDecision;
        field_values?: Record<string, unknown>;
        feedback?: string;
        scope?: InterventionScope;
        answer?: string;
        answered_by_user_id?: string;
        human_node_name?: string;
        retry_target_override?: string;
      };

      if (!decision) {
        return res.status(400).json({ error: 'decision is required' });
      }

      const existing = await service.get(intervention_id);
      if (!existing) return res.status(404).json({ error: 'Intervention not found' });
      if (existing.status !== 'pending') {
        return res.status(409).json({
          error: `Intervention is already ${existing.status}`,
        });
      }

      const execCol = db.collection('executions');

      // ── APPROVE / ANSWER → submitInput to the engine's human node ──
      if (decision === 'approve' || decision === 'answer') {
        // Build the submitInput payload using the ORIGINAL field names
        // from the human node's config (stored on the intervention at
        // create time). The payload merges into state, so keys must
        // match what the workflow YAML declared.
        const nodeName = human_node_name ?? existing.stage;
        const payload: Record<string, unknown> = {};

        const originalFields = (existing as unknown as { fields?: Array<{ name: string }> }).fields ?? [];

        if (field_values && typeof field_values === 'object') {
          // Preferred: UI sent explicit field_values keyed by field name.
          for (const [k, v] of Object.entries(field_values)) {
            payload[k] = v;
          }
        } else if (answer != null && originalFields.length > 0) {
          // Legacy fallback: single-field nodes where the UI only sent
          // a free-form `answer` string. Use the first field's name as
          // the key so state.questionName (or whatever) gets set.
          payload[originalFields[0].name] = answer;
        } else if (answer != null) {
          // Last resort: no fields recorded. Use the literal `answer`
          // key. Legacy interventions from before this fix will hit
          // this path; they'll still submit but the state key may be
          // wrong. New interventions always have fields populated.
          payload.answer = answer;
        }

        try {
          await executionService.submitInput(existing.workflow_run_id, nodeName, payload);
        } catch (err) {
          console.error('[intervention.respond] submitInput failed:', err);
        }
        await execCol.updateOne(
          { id: existing.workflow_run_id },
          { $set: { status: 'running' } },
        );
      }

      // ── REQUEST CHANGES → patch state + retryFromNode ──
      let retry_triggered;
      if (decision === 'request_changes') {
        const targetNode = retry_target_override ?? retryTargetForStage(existing.stage, scope);
        retry_triggered = {
          target_node: targetNode,
          retry_attempt: 1,
          retry_source: 'human_feedback',
        };

        // Set the retry state fields the node-executor's
        // useMinimalRetryPrompt logic picks up on the re-run. These
        // get merged into the execution state before retryFromNode
        // re-enters the graph.
        await execCol.updateOne(
          { id: existing.workflow_run_id },
          {
            $set: {
              'state.__retry_target': [targetNode],
              'state.__retry_source': 'human_feedback',
              'state.__retry_attempt': 1,
              'state.retry_context': feedback ?? '',
            },
          },
        );

        try {
          await executionService.retryFromNode(existing.workflow_run_id, targetNode);
        } catch (err) {
          console.error('[intervention.respond] retryFromNode failed:', err);
          return res.status(500).json({
            error: `Failed to re-enter workflow at ${targetNode}: ${(err as Error).message}`,
          });
        }
      }

      // ── REJECT → cancel ──
      if (decision === 'reject') {
        await execCol.updateOne(
          { id: existing.workflow_run_id },
          { $set: { status: 'cancelled' } },
        );
      }

      const updated = await service.recordResponse(intervention_id, {
        decision,
        feedback,
        scope,
        answer,
        answered_by_user_id,
        retry_triggered,
      });

      res.json(updated);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}

/**
 * Map an intervention stage to the workflow node that should be
 * retried when the user clicks "Request changes." Scope is only
 * consulted for `plan_approval_gate` — requirements → produce_prd,
 * architecture → produce_hla, technical_design → produce_tdd.
 * For `all` or null scope, default to the earliest section so
 * downstream docs are re-produced too.
 *
 * Extensible by adding new entries as new gate types are introduced.
 */
function retryTargetForStage(stage: string, scope?: string | null): string {
  if (stage === 'plan_approval_gate') {
    switch (scope) {
      case 'requirements': return 'produce_prd';
      case 'architecture':  return 'produce_hla';
      case 'technical_design': return 'produce_tdd';
      case 'all':
      default:              return 'produce_prd';
    }
  }
  const map: Record<string, string> = {
    clarify_round_1: 'clarify',
    clarify_round_2: 'clarify',
    clarify_round_3: 'clarify',
    audit_prd_escalation: 'produce_prd',
    audit_hla_escalation: 'produce_hla',
    audit_tdd_escalation: 'produce_tdd',
    qa_escalation: 'qa_failure_triage',
    validator_escalation: 'plan_implementation',
    feature_escalation: 'investigate',
    repro_question: 'investigate',
  };
  return map[stage] ?? stage;
}
