import type {
  HumanAction,
  HumanActionRoute,
  HumanEvent,
  HumanEvidence,
  HumanField,
  HumanInputFieldValue,
  HumanResumeInput,
  HumanWidget,
  HumanInterventionKind,
  HumanInterventionPayload,
  HumanInterventionSeverity,
  ResumeContext,
  NodeDef,
  RetryExhaustionContext,
  WorkflowDef,
} from './types.js';
import { renderTemplate } from './template.js';

const DEFAULT_CLARIFY_FIELD: HumanField = {
  name: 'clarification',
  type: 'text',
  label: 'Your response',
  required: true,
};

export function renderHumanIntervention(
  nodeName: string,
  nodeDef: NodeDef,
  state: Record<string, unknown>,
  workflow?: WorkflowDef,
  override?: Partial<HumanInterventionPayload>,
): HumanInterventionPayload {
  const configured = nodeDef.human;
  const kind = override?.kind ?? configured?.kind ?? inferKind(nodeName);
  const severity = override?.severity ?? severityForKind(kind, nodeName);
  const retryExhaustion = override?.retryExhaustion
    ?? retryExhaustionFromState(state)
    ?? undefined;
  const widget = override?.widget
    ?? configured?.widget
    ?? widgetForKind(kind, retryExhaustion);
  const fields = override?.fields
    ?? configured?.fields
    ?? nodeDef.fields
    ?? fieldsForWidget(widget, kind);
  const fallbackQuestion = fallbackQuestionForKind(kind, nodeName, state, retryExhaustion);
  const question = renderMaybe(
    override?.question
      ?? configured?.question
      ?? nodeDef.prompt
      ?? fallbackQuestion,
    state,
  );

  return {
    kind,
    widget,
    node: nodeName,
    title: renderTemplate(override?.title ?? configured?.title ?? humanizeNodeName(nodeName), state),
    summary: renderMaybe(override?.summary ?? configured?.summary, state),
    question: question ?? fallbackQuestion,
    severity,
    highlights: renderArray(override?.highlights ?? configured?.highlights, state),
    evidence: renderEvidence(override?.evidence ?? configured?.evidence, state),
    fields,
    actions: normalizeActions(override?.actions ?? configured?.actions, kind, fields, widget),
    retryExhaustion,
  };
}

export function renderClarifyIntervention(
  nodeName: string,
  reason: string,
  fields: HumanField[],
): HumanInterventionPayload {
  return renderHumanIntervention(
    nodeName,
    { type: 'agent' },
    {},
    undefined,
    {
      kind: 'clarify',
      widget: 'dynamic_form',
      severity: 'question',
      title: 'Clarification needed',
      summary: reason,
      question: reason,
      fields: fields.length > 0 ? fields : [DEFAULT_CLARIFY_FIELD],
      actions: [{ id: 'answer', label: 'Submit answer', intent: 'submit', route: { type: 'retry', targetNode: nodeName } }],
    },
  );
}

export function buildHumanEvent(
  intervention: HumanInterventionPayload,
  values: Record<string, unknown>,
): HumanEvent {
  const existingHumanInput = isHumanResumeInput(values.human_input) ? values.human_input : undefined;
  const meta = normalizeHumanMeta(values.__human_meta);
  const humanInput = existingHumanInput ?? buildHumanResumeInput(intervention, values);
  const cleanValues = { ...values };
  delete cleanValues.__human_meta;
  delete cleanValues.human_input;
  const action = meta.actionId
    ? intervention.actions.find((candidate) => candidate.id === meta.actionId)
    : undefined;
  const decision = humanInput.decision ?? meta.decision ?? inferDecision(cleanValues);
  const feedback = humanInput.feedback?.value ?? meta.feedback ?? inferFeedback(cleanValues);
  return {
    kind: intervention.kind,
    node: intervention.node,
    actionId: humanInput.actionId ?? meta.actionId,
    decision,
    humanInput,
    values: cleanValues,
    feedback,
    route: humanInput.route ?? action?.route,
    evidence: intervention.evidence,
    retryExhaustion: intervention.retryExhaustion,
    createdAt: new Date().toISOString(),
  };
}

export function appendHumanEvent(
  state: Record<string, unknown>,
  event: HumanEvent,
): void {
  const existing = Array.isArray(state.__human_events)
    ? state.__human_events as HumanEvent[]
    : [];
  state.__human_events = [...existing, event];
}

export function renderHumanHistory(state: Record<string, unknown>, maxEvents = 8): string {
  const events = Array.isArray(state.__human_events)
    ? state.__human_events as HumanEvent[]
    : [];
  if (events.length === 0) return '';
  const selected = events.filter(shouldRenderHumanHistoryEvent).slice(-maxEvents);
  if (selected.length === 0) return '';
  const lines: string[] = [
    'HUMAN INPUT HISTORY',
    '',
  ];
  selected.forEach((event, index) => {
    lines.push(`${index + 1}. ${event.kind} at ${event.node}`);
    if (event.retryExhaustion) {
      const r = event.retryExhaustion;
      const max = r.maxRetries != null ? ` of ${r.maxRetries}` : '';
      lines.push(`Failed stage: ${r.exhaustedFrom}`);
      lines.push(`Retry attempts used: ${r.attemptsUsed}${max}`);
      if (r.lastFailureSummary) lines.push(`Last failure: ${r.lastFailureSummary}`);
    }
    if (event.decision) lines.push(`Decision: ${event.decision}`);
    if (event.feedback) lines.push(`Feedback: ${event.feedback}`);
    if (event.route) {
      lines.push(`Route: ${event.route.type}${event.route.targetNode ? ` ${event.route.targetNode}` : ''}`);
    }
    const fields = event.humanInput ? renderableHumanFields(event.humanInput) : [];
    const fieldEntries = fields.length
      ? fields.map((field) => `- ${field.label}: ${formatValue(field.value)}`)
      : Object.entries(event.values ?? {})
        .filter(([key]) => !key.startsWith('__') && !isDecisionFieldName(key) && !isFeedbackFieldName(key))
        .map(([key, value]) => `- ${key}: ${formatValue(value)}`);
    if (fieldEntries.length > 0) {
      lines.push('User provided:');
      lines.push(...fieldEntries);
    }
    lines.push('');
  });
  lines.push('Treat this human input as authoritative.');
  return lines.join('\n');
}

export function buildHumanResumeInput(
  intervention: HumanInterventionPayload,
  values: Record<string, unknown>,
): HumanResumeInput {
  if (isHumanResumeInput(values.human_input)) return values.human_input;
  const meta = normalizeHumanMeta(values.__human_meta);
  const cleanValues = { ...values };
  delete cleanValues.__human_meta;
  delete cleanValues.human_input;

  const actionId = meta.actionId ?? inferDecision(cleanValues);
  const action = actionId
    ? intervention.actions.find((candidate) => candidate.id === actionId)
    : undefined;
  const decision = meta.decision ?? inferDecision(cleanValues) ?? actionId;
  const feedback = meta.feedback ?? inferFeedback(cleanValues);
  const feedbackFieldName = feedbackFieldNameForValues(cleanValues);
  const feedbackField = feedbackFieldName
    ? intervention.fields.find((field) => field.name === feedbackFieldName)
    : undefined;
  const fields = intervention.fields
    .filter((field) => Object.prototype.hasOwnProperty.call(cleanValues, field.name))
    .map((field): HumanInputFieldValue => ({
      name: field.name,
      label: field.label ?? humanizeNodeName(field.name),
      value: cleanValues[field.name],
    }));
  const fieldsByName = Object.fromEntries(fields.map((field) => [field.name, field]));

  return {
    kind: intervention.kind,
    sourceNode: intervention.node,
    actionId,
    decision,
    route: action?.route,
    summary: summarizeHumanInput(intervention.kind, intervention.node, decision, feedback),
    fields,
    fieldsByName,
    feedback: feedback
      ? {
          label: feedbackField?.label ?? labelForFeedback(intervention.kind),
          value: feedback,
        }
      : undefined,
    retryExhaustion: intervention.retryExhaustion,
    createdAt: new Date().toISOString(),
  };
}

export function renderHumanResumePrompt(input: unknown): string {
  if (!isHumanResumeInput(input)) return '';
  if (isPlainApproval(input)) return '';
  const lines = [
    'HUMAN INPUT FROM WORKFLOW PAUSE',
    '',
    `Type: ${input.kind}`,
    `Source node: ${input.sourceNode}`,
  ];
  if (input.decision) lines.push(`Decision: ${input.decision}`);
  if (input.route) {
    lines.push(`Route: ${input.route.type}${input.route.targetNode ? ` ${input.route.targetNode}` : ''}`);
  }
  lines.push('', input.summary);
  if (input.retryExhaustion) {
    const r = input.retryExhaustion;
    const max = r.maxRetries != null ? ` of ${r.maxRetries}` : '';
    lines.push('', 'Retry exhaustion:', `- Failed stage: ${r.exhaustedFrom}`, `- Attempts used: ${r.attemptsUsed}${max}`);
    if (r.lastFailureSummary) lines.push(`- Last failure: ${r.lastFailureSummary}`);
    const failureFields = Object.entries(r.availableFailureFields ?? {})
      .filter(([, value]) => value != null && value !== '')
      .slice(0, 10);
    if (failureFields.length > 0) {
      lines.push('', 'Failure context from exhausted node:');
      for (const [key, value] of failureFields) {
        lines.push(`- ${humanizeNodeName(key)}: ${truncateForPrompt(formatValue(value), 1200)}`);
      }
    }
  }
  const fields = renderableHumanFields(input);
  if (fields.length > 0) {
    lines.push('', 'User-provided fields:');
    for (const field of fields) {
      lines.push(`- ${field.label}: ${formatValue(field.value)}`);
    }
  }
  if (input.feedback) {
    lines.push('', `${input.feedback.label}:`, input.feedback.value);
  }
  lines.push('', 'Use only this human input and the relevant upstream artifacts/outputs for the requested retry or continuation.');
  return lines.join('\n');
}

export function renderClarificationResumePrompt(input: unknown): string {
  const humanInput = isResumeContext(input)
    ? input.humanInput
    : isHumanResumeInput(input)
      ? input
      : undefined;
  if (!humanInput || humanInput.kind !== 'clarify') return '';

  const lines = ['USER CLARIFICATIONS', ''];
  if (humanInput.fields.length > 0) {
    for (const field of humanInput.fields) {
      lines.push(`- ${field.label}: ${formatValue(field.value)}`);
    }
  } else if (humanInput.feedback) {
    lines.push(`${humanInput.feedback.label}: ${humanInput.feedback.value}`);
  } else {
    lines.push('(No clarification fields were provided.)');
  }
  return lines.join('\n');
}

export function renderResumeContextPrompt(input: unknown): string {
  if (!isResumeContext(input)) return '';
  const lines = [
    'RESUME CONTEXT',
    '',
    `Type: ${input.type}`,
    `Source node: ${input.sourceNode}`,
  ];
  if (input.targetNode) lines.push(`Target node: ${input.targetNode}`);

  if (input.nodeFeedback) {
    lines.push('', 'Node feedback:');
    if (input.nodeFeedback.summary) lines.push(input.nodeFeedback.summary);
    for (const field of input.nodeFeedback.fields) {
      lines.push(`- ${field.label}: ${truncateForPrompt(formatValue(field.value), 1200)}`);
    }
  }

  const retry = input.retryExhaustion ?? input.humanInput?.retryExhaustion;
  if (retry) {
    const max = retry.maxRetries != null ? ` of ${retry.maxRetries}` : '';
    lines.push('', 'Retry exhaustion:', `- Failed stage: ${retry.exhaustedFrom}`, `- Attempts used: ${retry.attemptsUsed}${max}`);
    if (retry.lastFailureSummary) lines.push(`- Last failure: ${retry.lastFailureSummary}`);
    const failureFields = Object.entries(retry.availableFailureFields ?? {})
      .filter(([, value]) => value != null && value !== '')
      .slice(0, 10);
    if (failureFields.length > 0) {
      lines.push('', 'Failure context from exhausted node:');
      for (const [key, value] of failureFields) {
        lines.push(`- ${humanizeNodeName(key)}: ${truncateForPrompt(formatValue(value), 1200)}`);
      }
    }
  }

  const humanPrompt = renderHumanResumePrompt(input.humanInput);
  if (humanPrompt) {
    lines.push('', humanPrompt);
  }

  if (input.history?.length) {
    lines.push('', 'Prior human feedback for this gate:');
    for (const [index, item] of input.history.entries()) {
      const feedback = item.feedback?.value ?? '';
      const decision = item.decision ? `${item.decision}` : 'response';
      lines.push(`${index + 1}. ${decision}${feedback ? ` — ${feedback}` : ''}`);
    }
  }

  lines.push('', 'Use this scoped resume context instead of inferring from unrelated workflow state.');
  return lines.join('\n');
}

export function renderReviewFeedbackRetryPrompt(input: {
  resumeContext?: unknown;
  humanInput?: unknown;
  retryContext?: unknown;
}): string {
  const feedback = extractReviewFeedback(input) || '(No feedback text was provided.)';
  return [
    'REVIEW FEEDBACK',
    '',
    'Your previous output was reviewed and feedback was provided.',
    'Use the feedback below to update your previous result and re-emit the required JSON output.',
    '',
    'Feedback:',
    feedback,
    '',
    'Apply this as a targeted update. Do not redo analysis that is still valid.',
    'Use whatever verification your node role requires before returning.',
  ].join('\n');
}

export function buildRetryExhaustionContext(input: {
  exhaustedFrom: string;
  retryEdgeKey?: string;
  attemptsUsed: number;
  maxRetries?: number;
  retryTarget?: string;
  state: Record<string, unknown>;
}): RetryExhaustionContext {
  const availableFailureFields = pickFailureFields(input.state);
  return {
    exhaustedFrom: input.exhaustedFrom,
    retryEdgeKey: input.retryEdgeKey,
    attemptsUsed: input.attemptsUsed,
    maxRetries: input.maxRetries,
    retryTarget: input.retryTarget,
    lastFailureSummary: summarizeFailure(availableFailureFields),
    availableFailureFields,
  };
}

function inferKind(nodeName: string): HumanInterventionKind {
  const lower = nodeName.toLowerCase();
  if (lower.includes('escalation')) return 'recover';
  if (lower.includes('approval') || lower.endsWith('_gate') || lower.includes('review')) return 'review';
  return 'clarify';
}

function severityForKind(kind: HumanInterventionKind, nodeName: string): HumanInterventionSeverity {
  if (kind === 'recover') return 'escalation';
  if (kind === 'review') return 'approval';
  const lower = nodeName.toLowerCase();
  if (lower.includes('approval') || lower.endsWith('_gate')) return 'approval';
  if (lower.includes('escalation')) return 'escalation';
  return 'question';
}

function widgetForKind(
  kind: HumanInterventionKind,
  retryExhaustion?: RetryExhaustionContext,
): HumanWidget {
  if (kind === 'clarify') return 'dynamic_form';
  if (kind === 'review') return 'approval_gate';
  if (retryExhaustion) return 'retry_exhausted_gate';
  return 'escalation_gate';
}

function fieldsForWidget(widget: HumanWidget | undefined, kind: HumanInterventionKind): HumanField[] {
  if (widget === 'approval_gate') {
    return [
      {
        name: 'decision',
        label: 'Decision',
        type: 'select',
        options: ['approve', 'request_changes', 'reject'],
        required: true,
      },
      {
        name: 'feedback',
        label: 'Feedback',
        type: 'textarea',
        required: false,
      },
    ];
  }
  if (widget === 'retry_exhausted_gate' || widget === 'escalation_gate' || kind === 'recover') {
    return [
      {
        name: 'decision',
        label: 'Decision',
        type: 'select',
        options: ['retry_with_feedback', 'override_and_continue', 'abandon'],
        required: true,
      },
      {
        name: 'feedback',
        label: 'Feedback',
        type: 'textarea',
        required: false,
      },
    ];
  }
  return kind === 'clarify' ? [DEFAULT_CLARIFY_FIELD] : [];
}

function fallbackQuestionForKind(
  kind: HumanInterventionKind,
  nodeName: string,
  state: Record<string, unknown>,
  retryExhaustion?: RetryExhaustionContext,
): string {
  if (kind === 'recover') {
    const exhausted = retryExhaustion ?? retryExhaustionFromState(state);
    if (exhausted) {
      const max = exhausted.maxRetries != null ? ` of ${exhausted.maxRetries}` : '';
      return [
        'The workflow could not recover automatically.',
        '',
        `Failed stage: ${exhausted.exhaustedFrom}`,
        `Retry attempts used: ${exhausted.attemptsUsed}${max}`,
        exhausted.lastFailureSummary ? `Last failure: ${exhausted.lastFailureSummary}` : undefined,
        '',
        'Choose how to recover.',
      ].filter(Boolean).join('\n');
    }
    return 'The workflow is blocked and needs a recovery decision.';
  }
  if (kind === 'review') return 'Review the work and choose how to proceed.';
  return `The workflow needs input at ${humanizeNodeName(nodeName)}.`;
}

function retryExhaustionFromState(state: Record<string, unknown>): RetryExhaustionContext | null {
  const raw = state.__retry_exhaustion;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.exhaustedFrom !== 'string') return null;
  return {
    exhaustedFrom: r.exhaustedFrom,
    retryEdgeKey: typeof r.retryEdgeKey === 'string' ? r.retryEdgeKey : undefined,
    attemptsUsed: typeof r.attemptsUsed === 'number' ? r.attemptsUsed : 0,
    maxRetries: typeof r.maxRetries === 'number' ? r.maxRetries : undefined,
    lastFailureSummary: typeof r.lastFailureSummary === 'string' ? r.lastFailureSummary : undefined,
    retryTarget: typeof r.retryTarget === 'string' ? r.retryTarget : undefined,
    availableFailureFields: r.availableFailureFields && typeof r.availableFailureFields === 'object' && !Array.isArray(r.availableFailureFields)
      ? r.availableFailureFields as Record<string, unknown>
      : undefined,
  };
}

function normalizeActions(
  raw: HumanAction[] | Record<string, Omit<HumanAction, 'id'> | string> | undefined,
  kind: HumanInterventionKind,
  fields: HumanField[],
  widget?: HumanWidget,
): HumanAction[] {
  if (Array.isArray(raw) && raw.length > 0) return raw.map(normalizeAction);
  if (raw && typeof raw === 'object') {
    return Object.entries(raw).map(([id, value]) => {
      if (typeof value === 'string') return normalizeAction({ id, label: value });
      return normalizeAction({ id, ...(value as Omit<HumanAction, 'id'>) });
    });
  }
  const actionsFromFields = inferActionsFromFields(fields, kind);
  if (actionsFromFields.length > 0) return actionsFromFields;
  if (kind === 'recover' || widget === 'retry_exhausted_gate' || widget === 'escalation_gate') {
    return [
      { id: 'retry_with_feedback', label: 'Retry with feedback', intent: 'retry', feedbackRequired: true, route: { type: 'retry' } },
      { id: 'override_and_continue', label: 'Override and continue', intent: 'override', feedbackOptional: true, route: { type: 'continue' }, warning: 'Continue only if you accept the risk of unresolved failures.' },
      { id: 'abandon', label: 'Abandon', intent: 'abandon', route: { type: 'end' } },
    ];
  }
  if (kind === 'review' || widget === 'approval_gate') {
    return [
      { id: 'approve', label: 'Approve', intent: 'approve', feedbackOptional: true, route: { type: 'continue' } },
      { id: 'request_changes', label: 'Request changes', intent: 'request_changes', feedbackRequired: true, route: { type: 'retry' } },
      { id: 'reject', label: 'Reject', intent: 'reject', route: { type: 'end' } },
    ];
  }
  return [
    { id: 'answer', label: 'Submit answer', intent: 'submit', route: { type: 'retry' } },
    { id: 'cancel', label: 'Cancel workflow', intent: 'reject', route: { type: 'end' } },
  ];
}

function inferActionsFromFields(fields: HumanField[], kind: HumanInterventionKind): HumanAction[] {
  const decisionField = fields.find((field) => {
    const lower = field.name.toLowerCase();
    const type = String(field.type ?? '').toLowerCase();
    return lower.includes('decision')
      || lower.includes('approval')
      || lower === 'action'
      || type === 'select'
      || type === 'radio';
  });
  const options = decisionField?.options;
  if (!Array.isArray(options) || options.length === 0) return [];
  return options.map((id) => {
    const label = labelForAction(id, kind);
    return normalizeAction({
      id,
      label,
      intent: intentFromActionId(id),
      feedbackRequired: id === 'request_changes' || id === 'retry_with_feedback',
      feedbackOptional: id === 'approve' || id === 'override_and_continue' || id === 'force_continue',
      route: routeForActionId(id),
    });
  }).filter((action) => action.id);
}

function labelForAction(id: string, kind: HumanInterventionKind): string {
  if (id === 'retry_with_feedback') return 'Retry with feedback';
  if (id === 'override_and_continue' || id === 'force_continue') return 'Override and continue';
  if (id === 'request_changes') return kind === 'recover' ? 'Retry with feedback' : 'Request changes';
  if (id === 'approve') return 'Approve';
  if (id === 'reject') return 'Reject';
  if (id === 'cancel') return 'Cancel';
  if (id === 'abandon') return 'Abandon';
  if (id === 'answer') return 'Submit answer';
  return humanizeNodeName(id);
}

function routeForActionId(id: string): HumanActionRoute {
  if (id === 'request_changes' || id === 'retry_with_feedback') return { type: 'retry' };
  if (id === 'approve' || id === 'override_and_continue' || id === 'force_continue') return { type: 'continue' };
  if (id === 'reject' || id === 'cancel' || id === 'abandon') return { type: 'end' };
  return { type: 'retry' };
}

function normalizeAction(action: HumanAction): HumanAction {
  return {
    ...action,
    label: action.label ?? humanizeNodeName(action.id),
    intent: action.intent ?? intentFromActionId(action.id),
  };
}

function intentFromActionId(id: string): NonNullable<HumanAction['intent']> {
  if (id.includes('retry')) return 'retry';
  if (id.includes('override') || id.includes('force_continue')) return 'override';
  if (id.includes('abandon')) return 'abandon';
  if (id.includes('reject') || id.includes('cancel')) return 'reject';
  if (id.includes('request')) return 'request_changes';
  if (id.includes('approve')) return 'approve';
  return 'submit';
}

function renderMaybe(value: string | undefined, state: Record<string, unknown>): string | undefined {
  return typeof value === 'string' ? renderTemplate(value, state) : value;
}

function renderArray(values: string[] | undefined, state: Record<string, unknown>): string[] | undefined {
  if (!values) return undefined;
  return values.map((value) => renderTemplate(value, state)).filter((value) => value.trim().length > 0);
}

function renderEvidence(values: HumanEvidence[] | undefined, state: Record<string, unknown>): HumanEvidence[] | undefined {
  if (!values) return undefined;
  return values.map((item) => ({
    ...item,
    type: item.type ?? (item.url ? 'artifact' : 'text'),
    value: renderMaybe(item.value, state),
    url: renderMaybe(item.url, state),
  })).filter((item) => !!item.value || !!item.url);
}

function humanizeNodeName(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function normalizeHumanMeta(value: unknown): {
  actionId?: string;
  decision?: string;
  feedback?: string;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return {
    actionId: typeof record.actionId === 'string' ? record.actionId : undefined,
    decision: typeof record.decision === 'string' ? record.decision : undefined,
    feedback: typeof record.feedback === 'string' ? record.feedback : undefined,
  };
}

function inferDecision(values: Record<string, unknown>): string | undefined {
  for (const key of ['decision', 'approval_decision', 'escalation_decision']) {
    const value = values[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function inferFeedback(values: Record<string, unknown>): string | undefined {
  for (const key of ['feedback', 'approval_feedback', 'escalation_feedback', 'reason']) {
    const value = values[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function feedbackFieldNameForValues(values: Record<string, unknown>): string | undefined {
  for (const key of ['approval_feedback', 'escalation_feedback', 'feedback', 'reason']) {
    const value = values[key];
    if (typeof value === 'string' && value.trim()) return key;
  }
  return undefined;
}

function renderableHumanFields(input: HumanResumeInput): HumanInputFieldValue[] {
  if (input.kind === 'clarify') return input.fields;
  return input.fields.filter((field) => {
    if (isDecisionFieldName(field.name)) return false;
    if (input.feedback && isFeedbackFieldName(field.name)) return false;
    return true;
  });
}

function shouldRenderHumanHistoryEvent(event: HumanEvent): boolean {
  if (!event.humanInput) return true;
  return !isPlainApproval(event.humanInput);
}

function isPlainApproval(input: HumanResumeInput): boolean {
  return input.kind === 'review'
    && input.decision === 'approve'
    && !input.feedback
    && renderableHumanFields(input).length === 0
    && !input.retryExhaustion;
}

function isDecisionFieldName(name: string): boolean {
  return ['decision', 'approval_decision', 'escalation_decision'].includes(name);
}

function isFeedbackFieldName(name: string): boolean {
  return ['feedback', 'approval_feedback', 'escalation_feedback', 'reason'].includes(name);
}

function labelForFeedback(kind: HumanInterventionKind): string {
  if (kind === 'clarify') return 'Clarification';
  if (kind === 'recover') return 'Recovery guidance';
  return 'Review feedback';
}

function summarizeHumanInput(
  kind: HumanInterventionKind,
  nodeName: string,
  decision?: string,
  feedback?: string,
): string {
  if (kind === 'clarify') return `The user answered the clarification requested by ${humanizeNodeName(nodeName)}.`;
  if (kind === 'recover') {
    if (decision === 'retry_with_feedback') return 'The user allowed another retry and provided recovery guidance.';
    if (decision === 'override_and_continue' || decision === 'force_continue') return 'The user accepted the exhausted retry state and chose to continue.';
    if (decision === 'abandon') return 'The user abandoned the workflow after retry exhaustion.';
    return 'The user responded to a retry-exhaustion recovery prompt.';
  }
  if (decision === 'approve') return feedback ? 'The user approved the work with additional guidance.' : 'The user approved the work.';
  if (decision === 'request_changes') return 'The user requested changes before the workflow continues.';
  if (decision === 'reject' || decision === 'cancel') return 'The user rejected the work and stopped this path.';
  return `The user responded to ${humanizeNodeName(nodeName)}.`;
}

function isHumanResumeInput(value: unknown): value is HumanResumeInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.kind === 'string'
    && typeof record.sourceNode === 'string'
    && Array.isArray(record.fields)
    && typeof record.summary === 'string';
}

function isResumeContext(value: unknown): value is ResumeContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.type === 'string'
    && typeof record.sourceNode === 'string'
    && typeof record.createdAt === 'string';
}

function extractReviewFeedback(input: {
  resumeContext?: unknown;
  humanInput?: unknown;
  retryContext?: unknown;
}): string {
  const parts: string[] = [];
  const resumeContext = isResumeContext(input.resumeContext) ? input.resumeContext : undefined;
  const humanInput = isHumanResumeInput(input.humanInput) ? input.humanInput : resumeContext?.humanInput;
  if (humanInput?.feedback?.value) parts.push(humanInput.feedback.value);

  const feedbackFields = resumeContext?.nodeFeedback?.fields
    .filter((field) => /feedback/i.test(field.name) || /feedback/i.test(field.label))
    .map((field) => formatValue(field.value))
    .filter((value) => value.trim().length > 0)
    ?? [];
  parts.push(...feedbackFields);

  if (parts.length === 0 && resumeContext?.nodeFeedback?.summary) {
    parts.push(resumeContext.nodeFeedback.summary);
  }
  if (parts.length === 0 && typeof input.retryContext === 'string') {
    parts.push(input.retryContext);
  }

  const seen = new Set<string>();
  return parts
    .map((part) => part.trim())
    .filter((part) => {
      if (!part || seen.has(part)) return false;
      seen.add(part);
      return true;
    })
    .join('\n\n');
}

function pickFailureFields(state: Record<string, unknown>): Record<string, unknown> {
  const patterns = [
    /failure/i,
    /error/i,
    /verdict/i,
    /blocked/i,
    /blocker/i,
    /violation/i,
    /status/i,
    /report/i,
    /artifact_url/i,
  ];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (key.startsWith('__')) continue;
    if (patterns.some((pattern) => pattern.test(key))) out[key] = value;
  }
  return out;
}

function summarizeFailure(fields: Record<string, unknown>): string | undefined {
  const preferred = [
    'qa_failure_details',
    'implement_failure_details',
    'error',
    'validator_feedback',
    'implementation_readiness_blockers',
    'milestone_validation_failures',
    'final_validation_failures',
    'blocking_violations',
  ];
  for (const key of preferred) {
    const value = fields[key];
    if (value == null || value === '') continue;
    return formatValue(value).slice(0, 500);
  }
  for (const value of Object.values(fields)) {
    if (typeof value === 'string' && value.trim()) return value.slice(0, 500);
  }
  return undefined;
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateForPrompt(value: string, maxChars: number): string {
  return value.length > maxChars
    ? `${value.slice(0, maxChars)} ... (${value.length - maxChars} chars truncated)`
    : value;
}
