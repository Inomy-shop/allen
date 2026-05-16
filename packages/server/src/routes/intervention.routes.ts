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
import { ObjectId, type Db } from 'mongodb';
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
      if (typeof req.query.workflow_run_id === 'string') {
        await ensurePendingInterventionForWaitingRun(db, service, req.query.workflow_run_id);
      }
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
      const workflowRunId = param(req, 'workflowRunId');
      await ensurePendingInterventionForWaitingRun(db, service, workflowRunId);
      const docs = await service.listForWorkflowRun(workflowRunId);
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
        source,
      } = (req.body ?? {}) as {
        decision?: InterventionDecision;
        field_values?: Record<string, unknown>;
        feedback?: string;
        scope?: InterventionScope;
        answer?: string;
        answered_by_user_id?: string;
        human_node_name?: string;
        retry_target_override?: string;
        source?: 'chat' | 'execution_page' | 'interventions_page';
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
        const isApprovalNode = originalFields.some(f => f.name === 'approval_decision')
          || String(existing.stage ?? '').toLowerCase().includes('approval')
          || String(existing.severity ?? '').toLowerCase() === 'approval';

        const explicitApprovalDecision = field_values && typeof field_values === 'object'
          ? (field_values.approval_decision ?? field_values.decision)
          : undefined;

        if (decision === 'approve' && isApprovalNode && explicitApprovalDecision !== 'approve') {
          return res.status(400).json({
            error: 'Approval requires an explicit approval decision payload.',
          });
        }

        if (field_values && typeof field_values === 'object') {
          // Preferred: UI sent explicit field_values keyed by field name.
          for (const [k, v] of Object.entries(field_values)) {
            payload[k] = v;
          }
        } else if (originalFields.some(f => f.name === 'approval_decision')) {
          payload.approval_decision = 'approve';
          if (feedback != null) payload.approval_feedback = feedback;
        } else if (originalFields.some(f => f.name === 'decision')) {
          payload.decision = 'approve';
          if (feedback != null) payload.feedback = feedback;
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
        const originalFields = (existing as unknown as { fields?: Array<{ name: string }> }).fields ?? [];
        const nodeName = human_node_name ?? existing.stage;
        const payload: Record<string, unknown> = field_values && typeof field_values === 'object'
          ? { ...field_values }
          : {};
        const isEscalation = existing.severity === 'escalation'
          || String(existing.stage ?? '').toLowerCase().includes('escalation');
        const hasDecisionField = originalFields.some(f => f.name === 'approval_decision' || f.name === 'decision');
        if (hasDecisionField) {
          if (originalFields.some(f => f.name === 'approval_decision') && payload.approval_decision == null) {
            payload.approval_decision = 'request_changes';
          }
          if (originalFields.some(f => f.name === 'decision')) {
            payload.decision = isEscalation ? 'retry_with_feedback' : (payload.decision ?? 'request_changes');
          }
          if (originalFields.some(f => f.name === 'approval_feedback') && payload.approval_feedback == null) {
            payload.approval_feedback = feedback ?? answer ?? '';
          }
          if (originalFields.some(f => f.name === 'feedback') && payload.feedback == null) {
            payload.feedback = feedback ?? answer ?? '';
          }

          const delivered = await executionService.submitInput(existing.workflow_run_id, nodeName, payload);
          if (delivered) {
            await execCol.updateOne(
              { id: existing.workflow_run_id },
              { $set: { status: 'running' } },
            );
            retry_triggered = {
              target_node: nodeName,
              retry_attempt: 1,
              retry_source: 'human_node_decision',
            };
          } else {
            console.warn(`[intervention.respond] no pending input resolver for ${existing.workflow_run_id}:${nodeName}; falling back to retryFromNode`);
          }
          if (delivered) {
            const updated = await service.recordResponse(intervention_id, {
              decision,
              feedback,
              scope,
              answer,
              answered_by_user_id,
              retry_triggered,
            });

            await clearChatPendingQuestionForIntervention(
              db,
              existing.workflow_run_id,
              intervention_id,
              existing.stage,
              decision,
              field_values,
              answer,
              feedback,
              source,
            );

            return res.json(updated);
          }
        }

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

      await clearChatPendingQuestionForIntervention(
        db,
        existing.workflow_run_id,
        intervention_id,
        existing.stage,
        decision,
        field_values,
        answer,
        feedback,
        source,
      );

      res.json(updated);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function clearChatPendingQuestionForIntervention(
  db: Db,
  executionId: string,
  interventionId: string,
  stage: string,
  decision: InterventionDecision,
  fieldValues?: Record<string, unknown>,
  answer?: string,
  feedback?: string,
  source?: string,
): Promise<void> {
  const idPatterns = [executionId, interventionId]
    .filter(Boolean)
    .map((value) => new RegExp(escapeRegex(value), 'i'));
  if (idPatterns.length === 0) return;

  const match = {
    'pendingUserQuestion.status': 'pending',
    $or: [
      { 'pendingUserQuestion.executionId': executionId },
      { 'pendingUserQuestion.interventionId': interventionId },
      { 'pendingUserQuestion.question': { $in: idPatterns } },
    ],
  };

  const sessions = await db.collection('chat_sessions')
    .find(match, { projection: { _id: 1 } })
    .toArray();

  if (sessions.length === 0) return;

  const now = new Date();
  const answerForAssistant = interventionAnswerForAssistant({
    executionId,
    interventionId,
    stage,
    decision,
    fieldValues,
    answer,
    feedback,
  });

  await db.collection('chat_sessions').updateMany(match, {
    $set: {
      'pendingUserQuestion.status': 'answered',
      'pendingUserQuestion.answer': answerForAssistant,
      'pendingUserQuestion.answeredAt': now,
      'pendingUserQuestion.workflowResolution': {
        executionId,
        interventionId,
        stage,
        decision,
      },
    },
  });

  if (source === 'chat') return;

  const exec = await db.collection('executions').findOne(
    { id: executionId },
    { projection: { status: 1 } },
  );
  const content = [
    `Workflow input was submitted for execution \`${executionId}\`.`,
    `Intervention \`${interventionId}\` at \`${stage}\` was resolved with \`${decision}\`.`,
    `Current execution status: \`${String(exec?.status ?? 'running')}\`.`,
    'Continue from the latest execution state; do not ask for this same input again.',
  ].join('\n');

  await db.collection('chat_messages').insertMany(sessions.map((session) => ({
    sessionId: String(session._id),
    role: 'assistant',
    content,
    status: 'completed',
    senderSource: 'system',
    createdAt: now,
    completedAt: now,
  })));

  await db.collection('chat_sessions').updateMany(
    { _id: { $in: sessions.map((session) => session._id) } },
    {
      $set: { lastMessageAt: now, updatedAt: now },
      $inc: { messageCount: 1 },
    },
  );
}

function interventionAnswerForAssistant(input: {
  executionId: string;
  interventionId: string;
  stage: string;
  decision: InterventionDecision;
  fieldValues?: Record<string, unknown>;
  answer?: string;
  feedback?: string;
}): string {
  const values = input.fieldValues && Object.keys(input.fieldValues).length > 0
    ? `\nField values: ${JSON.stringify(input.fieldValues)}`
    : '';
  const answer = input.answer ? `\nAnswer: ${input.answer}` : '';
  const feedback = input.feedback ? `\nFeedback: ${input.feedback}` : '';
  return [
    `The workflow intervention has already been answered.`,
    `Execution: ${input.executionId}`,
    `Intervention: ${input.interventionId}`,
    `Stage: ${input.stage}`,
    `Decision: ${input.decision}`,
    `${values}${answer}${feedback}`,
    `Continue from the latest workflow state and do not ask for this same input again.`,
  ].filter(Boolean).join('\n');
}

async function ensurePendingInterventionForWaitingRun(
  db: Db,
  service: InterventionService,
  executionId: string,
): Promise<void> {
  const exec = await db.collection('executions').findOne({ id: executionId });
  if (!exec || exec.status !== 'waiting_for_input') return;
  const nodeName = Array.isArray(exec.currentNodes) ? String(exec.currentNodes[0] ?? '') : '';
  if (!nodeName || nodeName === 'END') return;

  const existing = await db.collection('workflow_interventions').findOne({
    workflow_run_id: executionId,
    stage: nodeName,
    status: 'pending',
  });
  if (existing) return;

  const workflowDoc = exec.workflowId && ObjectId.isValid(String(exec.workflowId))
    ? await db.collection('workflows').findOne({ _id: new ObjectId(String(exec.workflowId)) })
    : await db.collection('workflows').findOne({ name: exec.workflowName });
  const workflow = (workflowDoc?.parsed ?? workflowDoc ?? {}) as Record<string, any>;
  const nodeDef = workflow?.nodes?.[nodeName] ?? workflow?.parsed?.nodes?.[nodeName] ?? {};
  const state = (exec.state ?? {}) as Record<string, unknown>;
  const prompt = renderTemplate(String(nodeDef.prompt ?? `Input required for ${nodeName}`), state);
  const rawFields = Array.isArray(nodeDef.fields) ? nodeDef.fields : [];
  const fields = rawFields.map((field: any) => ({
    name: String(field.name),
    label: field.label,
    type: field.type,
    required: field.required,
    options: field.options,
    placeholder: field.placeholder,
  })).filter((field: any) => field.name);
  let severity: InterventionSeverity = 'question';
  const stageLower = nodeName.toLowerCase();
  if (stageLower.endsWith('_gate') || stageLower.includes('approval')) severity = 'approval';
  else if (stageLower.includes('escalation')) severity = 'escalation';
  const options = fields.flatMap((field: any) => {
    if (field.type !== 'select' || !Array.isArray(field.options)) return [];
    return field.options.map((option: string) => ({
      label: option.replace(/_/g, ' '),
      value: option,
      primary: option === 'approve' || option === 'continue',
      destructive: option === 'reject' || option === 'cancel' || option === 'abort',
    }));
  });
  if (options.length === 0) {
    if (severity === 'escalation') {
      options.push(
        { label: 'Retry with feedback', value: 'retry_with_feedback', primary: true, destructive: false },
        { label: 'Override and continue', value: 'override_and_continue', primary: false, destructive: false },
        { label: 'Abandon', value: 'abandon', primary: false, destructive: true },
      );
    } else if (severity === 'approval') {
      options.push(
        { label: 'Approve', value: 'approve', primary: true, destructive: false },
        { label: 'Request changes', value: 'request_changes', primary: false, destructive: false },
        { label: 'Reject', value: 'reject', primary: false, destructive: true },
      );
    } else {
      options.push(
        { label: 'Answer', value: 'answer', primary: true, destructive: false },
        { label: 'Reject', value: 'reject', primary: false, destructive: true },
      );
    }
  }

  await service.create({
    workflow_run_id: executionId,
    workflow_name: String(exec.workflowName ?? workflow.name ?? ''),
    chat_session_id: typeof (exec.input as any)?.chat_session_id === 'string' ? (exec.input as any).chat_session_id : undefined,
    started_by_user_id: typeof (exec.input as any)?.started_by_user_id === 'string' ? (exec.input as any).started_by_user_id : undefined,
    started_by_user_email: typeof (exec.input as any)?.started_by_user_email === 'string' ? (exec.input as any).started_by_user_email : undefined,
    stage: nodeName,
    severity,
    title: String(nodeDef.displayName ?? humaniseNodeName(nodeName)),
    context_summary: prompt.slice(0, 400) || `The workflow is paused at node "${nodeName}".`,
    question: prompt || 'Please respond to continue.',
    options,
    fields,
    docs: [],
    user_request: typeof (exec.input as any)?.user_request === 'string'
      ? (exec.input as any).user_request
      : typeof (exec.input as any)?.bug_report === 'string'
        ? (exec.input as any).bug_report
        : typeof (exec.input as any)?.task === 'string'
          ? (exec.input as any).task
          : undefined,
  });
}

function renderTemplate(template: string, state: Record<string, unknown>): string {
  let rendered = template;
  for (const [key, value] of Object.entries(state)) {
    rendered = rendered.replace(new RegExp(`\\{\\{${escapeRegExp(key)}\\}\\}`, 'g'), String(value ?? ''));
  }
  return rendered;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function humaniseNodeName(s: string): string {
  return s.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
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
    implementation_approval_human: 'investigate',
    feature_escalation: 'investigate',
    repro_question: 'investigate',
  };
  return map[stage] ?? stage;
}
