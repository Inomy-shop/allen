import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, ExternalLink, X } from 'lucide-react';
import { executions as executionsApi, interventions as interventionsApi, workflows as workflowsApi } from '../../services/api';
import ClarificationPanel, {
  type ClarificationDecision,
  type ClarificationField,
  type ClarificationSeverity,
} from '../clarification/ClarificationPanel';

export type WorkflowInterventionFieldLike = {
  name: string;
  label?: string;
  type?: string;
  required?: boolean;
  options?: Array<string | { label?: string; value?: string; description?: string }>;
  placeholder?: string;
  help?: string;
  default?: unknown;
  rows?: number;
};

export type WorkflowInterventionLike = {
  intervention_id?: string;
  status?: string;
  stage?: string;
  severity?: string;
  title?: string;
  question?: string;
  context_summary?: string;
  created_at?: string;
  createdAt?: string;
  fields?: WorkflowInterventionFieldLike[];
  options?: Array<{ label?: string; value?: string; primary?: boolean; destructive?: boolean; description?: string }>;
};

export type WorkflowInterventionRunLike = {
  executionId: string;
  runContext?: {
    humanInput?: {
      title?: string;
      stage?: string;
      severity?: string;
    };
    progress?: {
      currentStep?: string | null;
    };
  } | null;
};

export type WorkflowInterventionSubmit = {
  executionId: string;
  interventionId?: string;
  decision: 'approve' | 'request_changes' | 'reject' | 'answer';
  fieldValues?: Record<string, unknown>;
  feedback?: string;
  answer?: string;
  humanNodeName?: string;
};

export function WorkflowInterventionAction({
  run,
  intervention,
  onAnswer,
  className = 'cr-approval-button',
  showTitleMeta = false,
  label = 'Approve',
}: {
  run: WorkflowInterventionRunLike;
  intervention: WorkflowInterventionLike;
  onAnswer?: (input: WorkflowInterventionSubmit) => Promise<void> | void;
  className?: string;
  showTitleMeta?: boolean;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  if (!intervention || !onAnswer) return null;

  const title = intervention.title ?? run.runContext?.humanInput?.title ?? 'Workflow input needed';
  const age = timeAgo(intervention.created_at ?? intervention.createdAt ?? null);
  const postedLabel = age === 'recently' || age === 'just now' ? 'posted now' : `posted ${age}`;

  return (
    <>
      <button
        type="button"
        className={className}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen(true);
        }}
        title={title}
      >
        <span className="cr-approval-main">{label}</span>
        <ChevronRight className="h-3.5 w-3.5" />
        {showTitleMeta && (
          <>
            <span className="cr-approval-title">{title}</span>
            <span className="cr-approval-meta">{postedLabel}</span>
          </>
        )}
      </button>
      {open && (
        <WorkflowInterventionDialog
          run={run}
          intervention={intervention}
          onAnswer={onAnswer}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

export function WorkflowInterventionDialog({
  run,
  intervention,
  onAnswer,
  onClose,
}: {
  run: WorkflowInterventionRunLike;
  intervention: WorkflowInterventionLike;
  onAnswer: (input: WorkflowInterventionSubmit) => Promise<void> | void;
  onClose: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hydratedIntervention, setHydratedIntervention] = useState<WorkflowInterventionLike>(intervention);
  const activeIntervention = hydratedIntervention;
  const title = activeIntervention.title ?? run.runContext?.humanInput?.title ?? 'Workflow input needed';
  const question = activeIntervention.question ?? activeIntervention.context_summary ?? '';
  const model = useMemo(() => buildPresentationModel(activeIntervention), [activeIntervention]);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose, submitting]);

  useEffect(() => {
    let cancelled = false;
    const shouldHydrate = !intervention.intervention_id
      || !intervention.question
      || !intervention.fields?.length
      || !intervention.options?.length;
    if (!shouldHydrate) {
      setHydratedIntervention(intervention);
      return () => { cancelled = true; };
    }

    hydrateIntervention(run, intervention)
      .then((nextIntervention) => {
        if (cancelled) return;
        if (nextIntervention) setHydratedIntervention(nextIntervention);
      })
      .catch(() => {});

    return () => { cancelled = true; };
  }, [intervention, run.executionId, run.runContext?.humanInput?.stage, run.runContext?.progress?.currentStep]);

  async function submit(payload: {
    decision?: ClarificationDecision;
    fieldValues: Record<string, unknown>;
    feedback?: string;
    scope?: string;
  }) {
    setSubmitting(true);
    setError(null);
    try {
      let submitIntervention = activeIntervention;
      let submitModel = model;
      if (!submitIntervention.intervention_id) {
        const hydrated = await hydrateIntervention(run, submitIntervention);
        if (hydrated) {
          submitIntervention = hydrated;
          submitModel = buildPresentationModel(hydrated);
          setHydratedIntervention(hydrated);
        }
      }
      if (!submitIntervention.intervention_id) {
        throw new Error('Workflow input is still syncing. Please wait a moment and try again.');
      }

      if (submitModel.mode === 'approval' && !payload.decision) {
        throw new Error('Choose approve, request changes, or reject before submitting.');
      }

      const decision = payload.decision ?? 'answer';
      const fieldValues = toWorkflowFieldValues(payload, submitModel);
      await onAnswer({
        executionId: run.executionId,
        interventionId: submitIntervention.intervention_id,
        decision,
        fieldValues,
        feedback: payload.feedback,
        answer: decision === 'answer' ? firstTextValue(fieldValues) : undefined,
        humanNodeName: submitIntervention.stage ?? run.runContext?.humanInput?.stage,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit response');
      setSubmitting(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={() => !submitting && onClose()}
    >
      <div
        className="my-[3vh] flex w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-app-strong bg-app-card shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-app bg-app-card px-4 py-3">
          <div className="flex min-w-0 items-center gap-2 text-[11px] font-mono text-theme-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-accent-yellow animate-pulse" />
            <span>Waiting for response</span>
            <span className="truncate text-theme-primary">
              {activeIntervention.stage ?? run.runContext?.progress?.currentStep ?? run.executionId.slice(0, 8)}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <a
              href={`/executions/${run.executionId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md p-1 text-theme-muted transition-colors hover:bg-app-muted hover:text-accent"
              title="Open execution"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
            <button
              type="button"
              onClick={() => !submitting && onClose()}
              className="rounded-md p-1 text-theme-muted transition-colors hover:bg-app-muted hover:text-theme-primary"
              disabled={submitting}
              aria-label="Close approval dialog"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <ClarificationPanel
          layout="modal"
          title={model.title ?? title}
          subtitle={activeIntervention.stage ? `node · ${activeIntervention.stage}` : `execution · ${run.executionId.slice(0, 8)}`}
          prompt={question}
          severity={model.severity}
          fields={model.visibleFields}
          mode={model.mode}
          submitting={submitting}
          onSubmit={submit}
          onCancel={onClose}
        />
        {error && (
          <div className="border-t border-app px-6 py-3 text-[12px] text-accent-red">
            {error}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

type DialogMode = 'simple' | 'approval' | 'question' | 'escalation';

type PresentationModel = {
  mode: DialogMode;
  severity: ClarificationSeverity;
  title: string;
  visibleFields: ClarificationField[];
  decisionField?: ClarificationField;
  feedbackField?: ClarificationField;
  responseField?: ClarificationField;
};

const FREEFORM_RESPONSE_FIELD = '__human_response';

function buildPresentationModel(intervention: WorkflowInterventionLike): PresentationModel {
  const rawFields = normalizeClarificationFields(intervention.fields);
  const optionField = optionsFieldFromIntervention(intervention);
  const fields = optionField && !rawFields.some(field => field.name === optionField.name)
    ? [optionField, ...rawFields]
    : rawFields;
  const severity = severityForIntervention(intervention, fields);
  const mode: DialogMode = severity === 'approval' ? 'approval' : 'simple';
  const decisionField = fields.find(isDecisionField) ?? (mode === 'approval'
    ? defaultDecisionField(intervention)
    : undefined);
  const feedbackField = fields.find((field) => {
    if (field === decisionField) return false;
    const name = field.name.toLowerCase();
    const type = String(field.type || '').toLowerCase();
    return name.includes('feedback') || name.includes('reason') || name.includes('comment') || type === 'textarea';
  });

  if (mode !== 'approval') {
    const responseField = feedbackField ?? fields.find(field => field !== decisionField);
    return {
      mode,
      severity,
      title: severity === 'escalation' ? 'Escalation Review' : 'Input Required',
      visibleFields: [{
        name: FREEFORM_RESPONSE_FIELD,
        label: responseField?.label ?? 'Your response',
        type: 'textarea',
        required: true,
        rows: responseField?.rows ?? 5,
        placeholder: responseField?.placeholder ?? 'Type your response...',
        help: responseField?.help,
      }],
      decisionField,
      feedbackField,
      responseField,
    };
  }

  return {
    mode,
    severity,
    title: 'Approval Required',
    visibleFields: fields.filter(field => field !== decisionField && field !== feedbackField),
    decisionField,
    feedbackField,
  };
}

async function hydrateIntervention(
  run: WorkflowInterventionRunLike,
  intervention: WorkflowInterventionLike,
): Promise<WorkflowInterventionLike | null> {
  const stage = intervention.stage ?? run.runContext?.humanInput?.stage ?? run.runContext?.progress?.currentStep ?? undefined;

  const pendingFromList = await interventionsApi.listForWorkflowRun(run.executionId)
    .then((items) => pickPendingIntervention(items, stage))
    .catch(() => null);
  if (pendingFromList) return mergeHydrated(intervention, pendingFromList);

  const context = await executionsApi.context(run.executionId).catch(() => null);
  const pendingFromContext = pickPendingIntervention(context?.interventions, stage);
  if (pendingFromContext) return mergeHydrated(intervention, pendingFromContext);

  const execution = await executionsApi.get(run.executionId).catch(() => null);
  const waitingNode = stage
    ?? (Array.isArray(execution?.currentNodes) ? execution.currentNodes[0] : undefined)
    ?? undefined;
  if (!waitingNode || !execution?.workflowId) return null;

  const workflow = await workflowsApi.get(execution.workflowId).catch(() => null);
  const nodeDef = workflow?.parsed?.nodes?.[waitingNode] ?? workflow?.nodes?.[waitingNode];
  if (!nodeDef) return null;

  return {
    ...intervention,
    stage: waitingNode,
    severity: intervention.severity ?? (waitingNode.toLowerCase().includes('approval') ? 'approval' : waitingNode.toLowerCase().includes('escalation') ? 'escalation' : 'question'),
    title: intervention.title ?? nodeDef.displayName ?? humanLabel(waitingNode),
    question: renderTemplate(nodeDef.prompt ?? intervention.question ?? intervention.context_summary ?? '', execution.state ?? {}),
    fields: Array.isArray(nodeDef.fields) ? nodeDef.fields : intervention.fields,
    options: intervention.options,
  };
}

function pickPendingIntervention(items: unknown, stage?: string): WorkflowInterventionLike | null {
  if (!Array.isArray(items)) return null;
  const pending = items.filter((item: any) => item?.status === 'pending');
  return (pending.find((item: any) => !stage || item.stage === stage) ?? pending[0] ?? null) as WorkflowInterventionLike | null;
}

function mergeHydrated(
  fallback: WorkflowInterventionLike,
  hydrated: WorkflowInterventionLike,
): WorkflowInterventionLike {
  return {
    ...fallback,
    ...hydrated,
    stage: hydrated.stage ?? fallback.stage,
    severity: hydrated.severity ?? fallback.severity,
    title: hydrated.title ?? fallback.title,
    question: hydrated.question ?? fallback.question,
    context_summary: hydrated.context_summary ?? fallback.context_summary,
    fields: hydrated.fields ?? fallback.fields,
    options: hydrated.options ?? fallback.options,
  };
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

function normalizeClarificationFields(fields: WorkflowInterventionFieldLike[] | undefined): ClarificationField[] {
  if (!Array.isArray(fields)) return [];
  return fields.map(field => ({
    name: field.name,
    type: field.type ?? 'text',
    label: field.label,
    required: field.required,
    options: normalizeOptions(field.options),
    default: field.default,
    placeholder: field.placeholder,
    help: field.help,
    rows: field.rows,
  }));
}

function optionsFieldFromIntervention(intervention: WorkflowInterventionLike): ClarificationField | undefined {
  if (!intervention.options?.length) return undefined;
  const stage = intervention.stage?.toLowerCase() ?? '';
  return {
    name: stage.includes('approval') ? 'approval_decision' : 'decision',
    type: 'select',
    options: intervention.options.map(option => ({
      label: option.label ?? humanLabel(option.value ?? ''),
      value: option.value ?? option.label ?? '',
      description: option.description,
    })).filter(option => option.value),
    required: true,
  };
}

function defaultDecisionField(intervention: WorkflowInterventionLike): ClarificationField {
  const stage = intervention.stage?.toLowerCase() ?? '';
  const isEscalation = stage.includes('escalation') || intervention.severity === 'escalation';
  return {
    name: stage.includes('approval') ? 'approval_decision' : 'decision',
    type: 'select',
    options: isEscalation
      ? [
        { label: 'Retry with feedback', value: 'retry_with_feedback' },
        { label: 'Override and continue', value: 'override_and_continue' },
        { label: 'Abandon', value: 'abandon' },
      ]
      : [
        { label: 'Approve', value: 'approve' },
        { label: 'Request changes', value: 'request_changes' },
        { label: 'Cancel', value: 'cancel' },
      ],
    required: true,
  };
}

function severityForIntervention(
  intervention: WorkflowInterventionLike,
  fields: ClarificationField[],
): ClarificationSeverity {
  const haystack = [
    intervention.severity,
    intervention.title,
    intervention.stage,
  ].filter(Boolean).join(' ').toLowerCase();
  if (haystack.includes('approval') || haystack.includes('gate')) return 'approval';
  if (haystack.includes('escalation')) return 'escalation';
  return 'question';
}

function isDecisionField(field: ClarificationField): boolean {
  const name = field.name.toLowerCase();
  const type = String(field.type || '').toLowerCase();
  const optionValues = normalizeFieldOptions(field).map(option => option.value.toLowerCase());
  return name.includes('decision')
    || name.includes('approval')
    || name === 'action'
    || ((type === 'select' || type === 'radio') && optionValues.some(value => (
      value === 'approve'
      || value === 'request_changes'
      || value === 'reject'
      || value === 'cancel'
    )));
}

function toWorkflowFieldValues(
  payload: {
    decision?: ClarificationDecision;
    fieldValues: Record<string, unknown>;
    feedback?: string;
  },
  model: PresentationModel,
): Record<string, unknown> {
  if (model.mode !== 'approval') {
    const text = firstTextValue(payload.fieldValues);
    const values: Record<string, unknown> = {};
    if (model.decisionField) {
      values[model.decisionField.name] = responseDecisionValueForField(model.decisionField, text);
    }
    if (model.responseField) {
      values[model.responseField.name] = text;
    } else {
      values.answer = text;
    }
    return values;
  }

  const values: Record<string, unknown> = { ...payload.fieldValues };
  if (model.mode === 'approval' && payload.decision && model.decisionField) {
    values[model.decisionField.name] = decisionValueForField(payload.decision, model.decisionField);
  }
  if (payload.feedback) {
    if (model.feedbackField) {
      values[model.feedbackField.name] = payload.feedback;
    } else if (model.decisionField?.name.toLowerCase().includes('approval')) {
      values.approval_feedback = payload.feedback;
    } else {
      values.feedback = payload.feedback;
    }
  }
  return values;
}

function responseDecisionValueForField(field: ClarificationField, text: string): string {
  const values = normalizeFieldOptions(field).map(option => option.value);
  if (values.includes('retry_with_feedback')) return 'retry_with_feedback';
  if (values.includes('request_changes')) return 'request_changes';
  return text;
}

function decisionValueForField(decision: ClarificationDecision, field: ClarificationField): string {
  const values = normalizeFieldOptions(field).map(option => option.value);
  if (decision === 'request_changes' && values.includes('retry_with_feedback')) return 'retry_with_feedback';
  if (decision === 'approve' && values.includes('override_and_continue')) return 'override_and_continue';
  if (decision === 'reject' && values.includes('abandon')) return 'abandon';
  if (decision === 'reject' && values.includes('cancel')) return 'cancel';
  if (values.includes(decision)) return decision;
  return decision;
}

function normalizeFieldOptions(field: ClarificationField): Array<{ label: string; value: string }> {
  if (!field.options) return [];
  return field.options.map(option => (
    typeof option === 'string'
      ? { label: option, value: option }
      : { label: option.label, value: option.value }
  ));
}

function normalizeOptions(
  options: WorkflowInterventionFieldLike['options'],
): ClarificationField['options'] {
  if (!options) return undefined;
  return options.map(option => {
    if (typeof option === 'string') return { label: humanLabel(option), value: option };
    const value = option.value ?? option.label ?? '';
    return {
      label: option.label ?? humanLabel(value),
      value,
      description: option.description,
    };
  }).filter(option => (typeof option === 'string' ? option : option.value));
}

function firstTextValue(values: Record<string, unknown>): string {
  for (const value of Object.values(values)) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function humanLabel(value: string): string {
  if (!value) return '';
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function timeAgo(dateStr?: string | null): string {
  if (!dateStr) return 'recently';
  const ms = Date.now() - new Date(dateStr).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}
