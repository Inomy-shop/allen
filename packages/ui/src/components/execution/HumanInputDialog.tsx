import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X as XIcon } from 'lucide-react';
import ClarificationPanel, {
  type ClarificationDecision,
  type ClarificationField,
  type ClarificationSeverity,
} from '../clarification/ClarificationPanel';

interface Props {
  node: string;
  prompt: string;
  fields: ClarificationField[];
  reviewContent?: string;
  reviewContentType?: 'markdown' | 'json' | 'code' | 'text';
  reviewLanguage?: string;
  onSubmit: (data: Record<string, unknown>) => void;
  onCancel: () => void;
}

/**
 * Modal wrapper around ClarificationPanel. Keeps the same API the execution
 * page calls — the actual rendering lives in the shared component so the
 * inline intervention page looks identical.
 */
export default function HumanInputDialog({
  node, prompt, fields,
  reviewContent, reviewContentType, reviewLanguage,
  onSubmit, onCancel,
}: Props) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [onCancel]);

  const hasReview = !!reviewContent && reviewContent.trim().length > 0;
  const presentation = buildPresentationModel(node, fields);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 p-6"
      onClick={onCancel}
    >
      {/* Card grows with content; the OUTER overlay scrolls when the card
          exceeds the viewport. Previously the card was capped at 92vh +
          overflow-hidden, which clipped tall prompts/forms and hid the
          submit button below the fold with no scroll path. */}
      <div
        className={`my-[3vh] flex w-full flex-col overflow-hidden rounded-xl border border-app-strong bg-app-card shadow-2xl ${
          hasReview ? 'max-w-6xl' : 'max-w-2xl'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Tight top bar with node name and close */}
        <div className="flex shrink-0 items-center justify-between border-b border-app bg-app-card px-4 py-3">
          <div className="flex min-w-0 items-center gap-2 text-[11px] font-mono text-theme-muted">
            <span className="w-1.5 h-1.5 rounded-full bg-accent-yellow animate-pulse" />
            <span>Waiting for response</span>
            <span className="truncate text-theme-primary">{node}</span>
          </div>
          <button
            onClick={onCancel}
            className="p-1 rounded-md hover:bg-app-muted text-theme-muted hover:text-theme-secondary transition-colors"
            title="Close — does not discard the pending request"
          >
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        <ClarificationPanel
          layout="modal"
          title={presentation.title}
          subtitle={`node · ${node}`}
          prompt={prompt}
          severity={presentation.severity}
          fields={presentation.visibleFields}
          reviewContent={reviewContent}
          reviewContentType={reviewContentType}
          reviewLanguage={reviewLanguage}
          mode={presentation.mode}
          onSubmit={async (payload) => {
            onSubmit(toWorkflowFieldValues(payload, presentation));
          }}
          onCancel={onCancel}
        />
      </div>
    </div>,
    document.body,
  );
}

type DialogMode = 'simple' | 'approval' | 'question' | 'escalation';

interface PresentationModel {
  mode: DialogMode;
  severity: ClarificationSeverity;
  title: string;
  visibleFields: ClarificationField[];
  decisionField?: ClarificationField;
  feedbackField?: ClarificationField;
  responseField?: ClarificationField;
}

const FREEFORM_RESPONSE_FIELD = '__human_response';

function buildPresentationModel(node: string, fields: ClarificationField[]): PresentationModel {
  const lowerNode = node.toLowerCase();
  const decisionField = fields.find(isDecisionField);
  const feedbackField = fields.find((field) => {
    if (field === decisionField) return false;
    const name = field.name.toLowerCase();
    const type = String(field.type || '').toLowerCase();
    return name.includes('feedback') || name.includes('reason') || name.includes('comment') || type === 'textarea';
  });

  const isEscalation = lowerNode.includes('escalation')
    || fields.some(field => field.name.toLowerCase().includes('escalation'));
  const isApproval = !isEscalation && (lowerNode.includes('approval') || lowerNode.includes('gate'));

  if (isApproval) {
    return {
      mode: 'approval',
      severity: 'approval',
      title: 'Approval Required',
      visibleFields: fields.filter(field => field !== decisionField && field !== feedbackField),
      decisionField,
      feedbackField,
    };
  }

  const responseField = feedbackField ?? fields.find(field => field !== decisionField);
  return {
    mode: 'simple',
    severity: isEscalation ? 'escalation' : 'question',
    title: isEscalation ? 'Escalation Review' : 'Input Required',
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

function isDecisionField(field: ClarificationField): boolean {
  const name = field.name.toLowerCase();
  const type = String(field.type || '').toLowerCase();
  const optionValues = normalizeFieldOptions(field).map(option => option.value.toLowerCase());
  return (
    name.includes('decision')
    || name.includes('approval')
    || name === 'action'
    || ((type === 'select' || type === 'radio') && optionValues.some(value => (
      value === 'approve'
      || value === 'request_changes'
      || value === 'reject'
      || value === 'cancel'
    )))
  );
}

function toWorkflowFieldValues(
  payload: {
    decision?: ClarificationDecision;
    fieldValues: Record<string, unknown>;
    feedback?: string;
    scope?: string;
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

  if (payload.scope) values.scope = payload.scope;
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

function firstTextValue(values: Record<string, unknown>): string {
  for (const value of Object.values(values)) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}
