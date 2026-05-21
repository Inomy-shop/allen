/**
 * ClarificationPanel — the single source of truth for how a human-in-the-loop
 * request is rendered. Used by:
 *   - HumanInputDialog (modal overlay on the execution page)
 *   - InterventionsPage detail view (inline page body)
 *   - Chat intervention card (future)
 *
 * All three surfaces render the same layout so moving between them is never
 * a re-learn. Pass `layout="modal"` for the dialog and `layout="inline"`
 * for the page view.
 *
 * Field types supported:
 *   text | textarea | number | boolean | select | radio | multiselect
 *   json | yaml | code | markdown | date | url | email | password
 *
 * Review content is rendered through the project-wide markdown renderer
 * (with syntax-highlighted code blocks) when contentType='markdown', or
 * as a monospace viewer with a copy button for json/code/text.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  HelpCircle, CheckCircle2, AlertTriangle, Info,
  Check, X as XIcon, MessageSquareQuote, RotateCcw, SendHorizontal,
  ChevronDown, FileText, BookOpen,
  Calendar, Link as LinkIcon, Mail, Lock, Hash, Type, List, Code2,
  AlertCircle, CheckSquare, Square,
} from 'lucide-react';
import { renderMarkdown } from '../chat/ChatMessageList';
import { CopyButton } from '../common/CopyDownload';

// ── Public types ───────────────────────────────────────────────────────

export type ClarificationFieldType =
  | 'text' | 'textarea' | 'number' | 'boolean'
  | 'select' | 'radio' | 'multiselect'
  | 'json' | 'yaml' | 'code' | 'markdown'
  | 'date' | 'url' | 'email' | 'password';

export interface ClarificationField {
  name: string;
  type: ClarificationFieldType | string;
  label?: string;
  required?: boolean;
  options?: string[] | Array<{ label: string; value: string; description?: string }>;
  default?: unknown;
  placeholder?: string;
  help?: string;
  /** Language hint for code fields — purely visual. */
  language?: string;
  rows?: number;
  min?: number;
  max?: number;
}

export type ClarificationSeverity = 'question' | 'approval' | 'escalation' | 'info';
export type ClarificationDecision = 'approve' | 'request_changes' | 'reject' | 'answer';

export interface ClarificationPanelProps {
  /** Prominent heading (e.g., intervention title). Optional. */
  title?: string;
  /** Short context line under the title. */
  subtitle?: string;
  /** The actual question / prompt text from the agent. */
  prompt?: string;
  /** Drives icon + accent color. */
  severity?: ClarificationSeverity;

  /** Input fields the user must fill. */
  fields: ClarificationField[];

  /** Reviewable content (PRD, JSON output, code, …). */
  reviewContent?: string;
  reviewContentType?: 'markdown' | 'json' | 'code' | 'text';
  reviewLanguage?: string;
  reviewLabel?: string;

  /**
   * Which decision buttons to show. `simple` = just a "Submit" button.
   * `approval` = approve + request_changes + reject.
   * `escalation` = feedback box + Submit, which retries with feedback.
   * `question` = answer + reject.
   */
  mode?: 'simple' | 'approval' | 'question' | 'escalation';

  /** Scope dropdown shown when user picks request_changes (plan gates). */
  scopeOptions?: Array<{ value: string; label: string; description?: string }>;

  /** Docs shown as pill links above the form. */
  docs?: Array<{ label: string; url: string }>;

  /** Round counter, e.g., "Round 2 of 3". */
  roundInfo?: { current: number; max: number };

  submitting?: boolean;
  locked?: boolean;
  lockedReason?: string;

  /** Visual layout — modal gives a two-column grid, inline stacks. */
  layout?: 'modal' | 'inline';

  onSubmit: (payload: ClarificationSubmitPayload) => void | Promise<void>;
  onCancel?: () => void;
}

export interface ClarificationSubmitPayload {
  decision?: ClarificationDecision;
  fieldValues: Record<string, unknown>;
  feedback?: string;
  scope?: string;
}

// ── Component ──────────────────────────────────────────────────────────

export default function ClarificationPanel({
  title, subtitle, prompt, severity = 'question',
  fields, reviewContent, reviewContentType = 'markdown', reviewLanguage,
  reviewLabel = 'Content for review',
  mode = 'simple', scopeOptions, docs, roundInfo,
  submitting = false, locked = false, lockedReason,
  layout = 'inline',
  onSubmit, onCancel,
}: ClarificationPanelProps) {
  // ── State ──
  const [values, setValues] = useState<Record<string, unknown>>(() => seedValues(fields));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [decision, setDecision] = useState<ClarificationDecision | null>(defaultDecision(mode));
  const [feedback, setFeedback] = useState('');
  const [scope, setScope] = useState<string>(scopeOptions?.[0]?.value ?? '');

  // Seed again if fields prop identity changes (rare but possible in streaming).
  useEffect(() => { setValues(seedValues(fields)); }, [fields.map(f => f.name).join('|')]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasReview = !!reviewContent && reviewContent.trim().length > 0;
  // Two-column split when there's review content — regardless of layout.
  // Inline pages benefit the same way modals do: content on the left, form
  // on the right. Single column when there's nothing to review.
  const isTwoCol = hasReview;
  const severityTheme = themeForSeverity(severity);

  function setValue(name: string, v: unknown) {
    setValues(prev => ({ ...prev, [name]: v }));
    if (errors[name]) setErrors(prev => { const n = { ...prev }; delete n[name]; return n; });
  }

  function validate(): Record<string, string> {
    const errs: Record<string, string> = {};
    // Decision-driven rules — don't enforce field required-ness when the
    // user is rejecting or requesting changes (feedback is the payload).
    const needsFields = decision === null || decision === 'approve' || decision === 'answer';
    if (needsFields) {
      for (const f of fields) {
        const v = values[f.name];
        if (f.required && (v === '' || v === null || v === undefined)) {
          errs[f.name] = 'Required';
          continue;
        }
        if (f.type === 'json' && typeof v === 'string' && v.trim()) {
          try { JSON.parse(v); } catch (e) { errs[f.name] = `Invalid JSON — ${(e as Error).message}`; }
        }
        if (f.type === 'number' && typeof v === 'string' && v !== '' && Number.isNaN(Number(v))) {
          errs[f.name] = 'Not a number';
        }
        if (f.type === 'url' && typeof v === 'string' && v.trim()) {
          try { new URL(v); } catch { errs[f.name] = 'Invalid URL'; }
        }
      }
    }
    if (decision === 'request_changes' && !feedback.trim()) {
      errs.__feedback = 'Feedback is required when requesting changes';
    }
    return errs;
  }

  async function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault();
    const errs = validate();
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    const final: Record<string, unknown> = {};
    for (const f of fields) {
      const raw = values[f.name];
      if (f.type === 'json' && typeof raw === 'string' && raw.trim()) {
        try { final[f.name] = JSON.parse(raw); } catch { final[f.name] = raw; }
      } else if (f.type === 'number' && typeof raw === 'string' && raw !== '') {
        final[f.name] = Number(raw);
      } else {
        final[f.name] = raw;
      }
    }

    await onSubmit({
      decision: decision ?? undefined,
      fieldValues: final,
      feedback: decision === 'request_changes' ? feedback : undefined,
      scope: decision === 'request_changes' && scopeOptions ? scope : undefined,
    });
  }

  // ── Render ──
  // Card flows naturally; the modal wrapper's outer overlay handles
  // viewport-overflow scrolling. Previously this used h-full + child
  // overflow-auto, which only worked when the card had a bounded height
  // and silently clipped tall content otherwise.
  return (
    <div className="flex flex-col min-h-0">
      {/* Header — icon + title + subtitle. Only renders when a title is
          supplied; callers that provide their own outer header (e.g. the
          intervention detail hero card) pass only `prompt` and skip this. */}
      {title && (
        <ClarificationHeader
          title={title}
          subtitle={subtitle}
          severity={severity}
          roundInfo={roundInfo}
          theme={severityTheme}
        />
      )}

      {/* Prompt / question text */}
      {prompt && (
        <div className={`px-6 py-4 border-b border-app ${severityTheme.bgSoft}`}>
          <div className="flex items-start gap-3">
            <MessageSquareQuote className={`w-4 h-4 shrink-0 mt-0.5 ${severityTheme.iconClass}`} />
            <div className="flex-1 min-w-0">
              <div className="overline text-theme-subtle mb-1">
                {severity === 'approval' ? 'Approval requested'
                  : severity === 'escalation' ? 'Escalated'
                  : severity === 'info' ? 'Notice'
                  : 'Question'}
              </div>
              <div className="text-[13px] text-theme-primary font-body leading-relaxed whitespace-pre-wrap">
                {prompt}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Locked banner */}
      {locked && (
        <div className="px-6 py-3 bg-amber-500/10 border-b border-amber-500/30 flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-accent-yellow shrink-0 mt-0.5" />
          <div className="text-xs text-amber-200 font-body">
            <div className="font-semibold">This clarification is locked</div>
            <div className="text-amber-300/80 mt-0.5">{lockedReason ?? 'You cannot submit a response right now.'}</div>
          </div>
        </div>
      )}

      {/* Docs — pill row */}
      {docs && docs.length > 0 && (
        <div className="px-6 pt-4 flex flex-wrap gap-2">
          {docs.map((d, i) => (
            <a
              key={i}
              href={d.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-mono bg-app-muted hover:bg-surface-200/70 text-theme-secondary hover:text-theme-primary border border-app transition-colors"
            >
              <BookOpen className="w-3 h-3" />
              {d.label}
            </a>
          ))}
        </div>
      )}

      {/* Two-column body (review + form) OR single-column. Both columns
          flow naturally — the outer modal overlay (or the page) handles
          scroll. Internal scroll caps live on ReviewContent so a giant
          PRD doesn't push the form off-screen. */}
      <div className={isTwoCol ? 'grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] divide-x divide-border/15' : ''}>
        {/* Review content */}
        {hasReview && (
          <div className={`p-6 ${isTwoCol ? 'bg-app-muted/40' : ''}`}>
            <SectionLabel icon={<FileText className="w-3 h-3" />} text={reviewLabel} />
            <ReviewContent
              content={reviewContent!}
              type={reviewContentType}
              language={reviewLanguage}
            />
          </div>
        )}

        {/* Form */}
        <form
          onSubmit={handleSubmit}
          className="p-6 flex flex-col gap-5"
        >
          {fields.length > 0 && (
            <div className="space-y-5">
              <SectionLabel
                icon={<CheckSquare className="w-3 h-3" />}
                text={fields.length === 1 ? 'Your response' : `Your response · ${fields.length} fields`}
              />
              {fields.map(field => (
                <FieldRenderer
                  key={field.name}
                  field={field}
                  value={values[field.name]}
                  onChange={v => setValue(field.name, v)}
                  error={errors[field.name]}
                  disabled={locked || submitting}
                />
              ))}
            </div>
          )}

          {fields.length === 0 && mode === 'simple' && (
            <div className="text-[12px] text-theme-muted italic">
              No fields to fill — submit to continue.
            </div>
          )}

          {/* Decision buttons — only for approval. Question
              mode has just two choices (answer / reject), which we collapse
              into a single primary Submit + a secondary Reject link below
              the action bar to avoid the redundant "Choose an action" card.
              Escalation review intentionally keeps only the feedback box. */}
          {mode === 'approval' && (
            <DecisionButtons
              mode={mode}
              decision={decision}
              onChange={setDecision}
              disabled={locked || submitting}
            />
          )}

          {/* Scope picker + feedback when requesting changes */}
          {decision === 'request_changes' && (
            <div className="space-y-4 pt-2 border-t border-app">
              {scopeOptions && scopeOptions.length > 0 && (
                <div>
                  <FieldLabel label="Which section needs changes?" required />
                  <select
                    value={scope}
                    onChange={e => setScope(e.target.value)}
                    disabled={locked || submitting}
                    className="w-full px-3 py-2 rounded-md border border-app bg-app-card text-theme-primary text-sm font-body focus:outline-none focus:border-accent-blue/60 focus:ring-1 focus:ring-accent-blue/30 transition-colors disabled:opacity-50"
                  >
                    {scopeOptions.map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <FieldLabel label="Feedback for the agent" required />
                <HelpText text="Be specific — this text is passed verbatim as retry guidance." />
                <textarea
                  value={feedback}
                  onChange={e => setFeedback(e.target.value)}
                  placeholder="Explain what needs to change and why..."
                  rows={5}
                  disabled={locked || submitting}
                  autoFocus
                  className="w-full px-3 py-2 rounded-md border border-app bg-app-card text-theme-primary text-sm font-body leading-relaxed focus:outline-none focus:border-accent-blue/60 focus:ring-1 focus:ring-accent-blue/30 transition-colors resize-y disabled:opacity-50"
                />
                {errors.__feedback && (
                  <FieldError text={errors.__feedback} />
                )}
              </div>
            </div>
          )}

          {/* Action bar */}
          <div className="flex items-center justify-between gap-3 pt-4 mt-auto border-t border-app">
            {/* Left side: discreet Reject link for question mode — gives the
                user a secondary abandon path without inflating the UI with
                a decision card. For other modes, this slot stays empty. */}
            <div>
              {mode === 'question' && (
                <button
                  type="button"
                  onClick={() => setDecision('reject')}
                  disabled={locked || submitting}
                  className={`text-[11px] font-body transition-colors ${
                    decision === 'reject'
                      ? 'text-accent-red underline'
                      : 'text-theme-muted hover:text-accent-red'
                  }`}
                >
                  {decision === 'reject' ? 'Will reject — click submit to confirm' : 'Reject instead'}
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              {onCancel && (
                <button
                  type="button"
                  onClick={onCancel}
                  disabled={submitting}
                  className="px-3.5 py-2 rounded-md border border-app text-theme-secondary hover:bg-app-muted text-sm font-body transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
              )}
              <button
                type="submit"
                disabled={locked || submitting || (mode === 'approval' && !decision)}
                className={`px-4 py-2 rounded-md text-sm font-medium flex items-center gap-2 transition-all shadow-sm disabled:opacity-40 disabled:cursor-not-allowed ${submitButtonClass(decision, severity)}`}
              >
                {submitting
                  ? <span className="w-3.5 h-3.5 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                  : <SendHorizontal className="w-3.5 h-3.5" />}
                {submitButtonLabel(mode, decision)}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Header ─────────────────────────────────────────────────────────────

function ClarificationHeader({
  title, subtitle, severity, roundInfo, theme,
}: {
  title?: string;
  subtitle?: string;
  severity: ClarificationSeverity;
  roundInfo?: { current: number; max: number };
  theme: SeverityTheme;
}) {
  const Icon = theme.Icon;
  return (
    <div className="px-6 pt-5 pb-4 border-b border-app shrink-0">
      <div className="flex items-start gap-3.5">
        {/* Icon tile with soft gradient ring — replaces the old emoji circle. */}
        <div className={`relative shrink-0 w-11 h-11 rounded-xl ${theme.iconTileBg} ${theme.iconTileBorder} border flex items-center justify-center shadow-sm`}>
          <Icon className={`w-5 h-5 ${theme.iconClass}`} />
          <span className={`absolute -inset-px rounded-xl ${theme.glow} pointer-events-none`} aria-hidden />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-medium uppercase tracking-wider ${theme.badge}`}>
              <Icon className="w-2.5 h-2.5" />
              {labelForSeverity(severity)}
            </span>
            {roundInfo && (
              <span className="text-[10px] font-mono text-theme-muted bg-app-muted px-2 py-0.5 rounded-full border border-app">
                Round {roundInfo.current} / {roundInfo.max}
              </span>
            )}
          </div>
          {title && (
            <h2 className="text-base font-heading font-semibold text-theme-primary tracking-tight leading-snug">
              {title}
            </h2>
          )}
          {subtitle && (
            <p className="text-[11px] font-mono text-theme-muted mt-1 truncate">{subtitle}</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Review content renderer ────────────────────────────────────────────

function ReviewContent({
  content, type, language,
}: {
  content: string;
  type: 'markdown' | 'json' | 'code' | 'text';
  language?: string;
}) {
  if (type === 'markdown') {
    return (
      <div className="rounded-lg border border-app bg-surface-100/50 p-4 max-h-[70vh] overflow-auto">
        <div className="prose prose-sm prose-invert max-w-none prose-pre:bg-app-muted prose-code:text-accent-blue prose-headings:font-heading prose-headings:tracking-tight">
          {renderMarkdown(content) as React.ReactNode}
        </div>
      </div>
    );
  }
  if (type === 'json') {
    const formatted = tryFormatJSON(content);
    return (
      <div className="rounded-lg border border-app bg-surface-100/50 overflow-hidden">
        <div className="flex items-center justify-between px-3 py-1.5 bg-app-muted border-b border-app">
          <span className="text-[10px] font-mono text-theme-muted uppercase tracking-wider flex items-center gap-1.5">
            <Code2 className="w-3 h-3" /> json
          </span>
          <CopyButton text={formatted} />
        </div>
        <pre className="px-4 py-3 text-[12px] font-mono text-theme-secondary whitespace-pre-wrap break-all max-h-[60vh] overflow-auto leading-relaxed">
          {formatted}
        </pre>
      </div>
    );
  }
  if (type === 'code') {
    return (
      <div className="rounded-lg border border-app bg-surface-100/50 overflow-hidden">
        <div className="flex items-center justify-between px-3 py-1.5 bg-app-muted border-b border-app">
          <span className="text-[10px] font-mono text-theme-muted uppercase tracking-wider flex items-center gap-1.5">
            <Code2 className="w-3 h-3" /> {language || 'code'}
          </span>
          <CopyButton text={content} />
        </div>
        <pre className="px-4 py-3 text-[12px] font-mono text-theme-secondary whitespace-pre-wrap break-words max-h-[60vh] overflow-auto leading-relaxed">
          {content}
        </pre>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-app bg-surface-100/50 p-4 max-h-[60vh] overflow-auto">
      <pre className="text-[12px] font-body text-theme-secondary whitespace-pre-wrap break-words leading-relaxed">
        {content}
      </pre>
    </div>
  );
}

// ── Field renderer ─────────────────────────────────────────────────────

function FieldRenderer({
  field, value, onChange, error, disabled,
}: {
  field: ClarificationField;
  value: unknown;
  onChange: (v: unknown) => void;
  error?: string;
  disabled: boolean;
}) {
  const t = String(field.type || 'text').toLowerCase();
  const label = field.label ?? prettifyName(field.name);

  const inputBase =
    'w-full px-3 py-2 rounded-md border bg-app-card text-theme-primary text-sm font-body transition-colors focus:outline-none focus:ring-1 focus:ring-accent-blue/30 disabled:opacity-50 '
    + (error ? 'border-accent-red/60 focus:border-accent-red' : 'border-app focus:border-accent-blue/60');

  const monoInputBase =
    'w-full px-3 py-2 rounded-md border bg-[rgb(var(--color-editor-background))] text-theme-primary text-[12px] font-mono transition-colors focus:outline-none focus:ring-1 focus:ring-accent-blue/30 disabled:opacity-50 resize-y '
    + (error ? 'border-accent-red/60 focus:border-accent-red' : 'border-app focus:border-accent-blue/60');

  return (
    <div>
      <FieldLabel
        label={label}
        required={!!field.required}
        icon={iconForFieldType(t)}
      />
      {field.help && <HelpText text={field.help} />}

      {/* boolean — toggle switch */}
      {t === 'boolean' && (
        <BooleanToggle
          checked={!!value}
          onChange={v => onChange(v)}
          disabled={disabled}
        />
      )}

      {/* select — dropdown */}
      {t === 'select' && (
        <SelectField
          value={String(value ?? '')}
          options={normalizeOptions(field.options)}
          onChange={v => onChange(v)}
          disabled={disabled}
          error={!!error}
          placeholder={field.placeholder}
        />
      )}

      {/* radio — vertical list with visual selection */}
      {t === 'radio' && (
        <RadioGroup
          name={field.name}
          value={String(value ?? '')}
          options={normalizeOptions(field.options)}
          onChange={v => onChange(v)}
          disabled={disabled}
        />
      )}

      {/* multiselect — checkboxes */}
      {t === 'multiselect' && (
        <MultiSelect
          value={Array.isArray(value) ? (value as string[]) : []}
          options={normalizeOptions(field.options)}
          onChange={v => onChange(v)}
          disabled={disabled}
        />
      )}

      {/* large monospace editors for json/yaml/code/markdown */}
      {(t === 'json' || t === 'yaml' || t === 'code' || t === 'markdown') && (
        <div>
          <textarea
            value={String(value ?? '')}
            onChange={e => onChange(e.target.value)}
            placeholder={field.placeholder ?? (t === 'json' ? '{\n  "key": "value"\n}' : '')}
            rows={field.rows ?? 8}
            spellCheck={false}
            disabled={disabled}
            className={`${monoInputBase} min-h-[140px]`}
          />
          <div className="flex items-center justify-between mt-1 text-[10px] font-mono text-theme-subtle">
            <span className="flex items-center gap-1.5">
              <Code2 className="w-3 h-3" />
              {field.language ?? t}
            </span>
            {typeof value === 'string' && value.length > 0 && (
              <span>{value.length} chars</span>
            )}
          </div>
        </div>
      )}

      {/* textarea */}
      {t === 'textarea' && (
        <textarea
          value={String(value ?? '')}
          onChange={e => onChange(e.target.value)}
          placeholder={field.placeholder}
          rows={field.rows ?? 5}
          disabled={disabled}
          className={inputBase + ' leading-relaxed resize-y min-h-[110px]'}
        />
      )}

      {/* number */}
      {t === 'number' && (
        <input
          type="number"
          value={value === undefined || value === null ? '' : String(value)}
          onChange={e => onChange(e.target.value)}
          placeholder={field.placeholder}
          min={field.min}
          max={field.max}
          disabled={disabled}
          className={inputBase + ' tabular-nums'}
        />
      )}

      {/* date */}
      {t === 'date' && (
        <input
          type="date"
          value={String(value ?? '')}
          onChange={e => onChange(e.target.value)}
          disabled={disabled}
          className={inputBase}
        />
      )}

      {/* url / email / password — typed inputs with matching icons. */}
      {(t === 'url' || t === 'email' || t === 'password') && (
        <input
          type={t}
          value={String(value ?? '')}
          onChange={e => onChange(e.target.value)}
          placeholder={field.placeholder ?? (t === 'url' ? 'https://…' : '')}
          disabled={disabled}
          className={inputBase}
        />
      )}

      {/* default text */}
      {(t === 'text' || t === 'string') && (
        <input
          type="text"
          value={String(value ?? '')}
          onChange={e => onChange(e.target.value)}
          placeholder={field.placeholder}
          disabled={disabled}
          className={inputBase}
        />
      )}

      {/* fallback for unknown types — render as text */}
      {!['text', 'string', 'textarea', 'number', 'boolean', 'select', 'radio', 'multiselect', 'json', 'yaml', 'code', 'markdown', 'date', 'url', 'email', 'password'].includes(t) && (
        <input
          type="text"
          value={String(value ?? '')}
          onChange={e => onChange(e.target.value)}
          placeholder={field.placeholder}
          disabled={disabled}
          className={inputBase}
        />
      )}

      {error && <FieldError text={error} />}
    </div>
  );
}

// ── Subcomponents ──────────────────────────────────────────────────────

function BooleanToggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={`relative inline-flex items-center gap-2.5 h-9 px-3 rounded-md border transition-all disabled:opacity-50 ${
        checked
          ? 'border-accent-green/40 bg-accent-green/10 text-accent-green'
          : 'border-app bg-app-card text-theme-secondary'
      }`}
    >
      <span className={`relative w-8 h-4 rounded-full transition-colors ${checked ? 'bg-accent-green' : 'bg-surface-200/80'}`}>
        <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-4' : 'translate-x-0.5'}`} />
      </span>
      <span className="text-xs font-body">{checked ? 'Yes' : 'No'}</span>
    </button>
  );
}

function SelectField({
  value, options, onChange, disabled, error, placeholder,
}: {
  value: string;
  options: Array<{ label: string; value: string; description?: string }>;
  onChange: (v: string) => void;
  disabled: boolean;
  error: boolean;
  placeholder?: string;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        className={`w-full px-3 py-2 pr-9 rounded-md border bg-app-card text-theme-primary text-sm font-body focus:outline-none focus:ring-1 focus:ring-accent-blue/30 appearance-none disabled:opacity-50 ${
          error ? 'border-accent-red/60 focus:border-accent-red' : 'border-app focus:border-accent-blue/60'
        }`}
      >
        {placeholder && !value && <option value="">{placeholder}</option>}
        {options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-theme-subtle pointer-events-none" />
    </div>
  );
}

function RadioGroup({
  name, value, options, onChange, disabled,
}: {
  name: string;
  value: string;
  options: Array<{ label: string; value: string; description?: string }>;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-2">
      {options.map(o => {
        const selected = value === o.value;
        return (
          <label
            key={o.value}
            className={`flex items-start gap-3 p-3 rounded-md border cursor-pointer transition-all ${
              selected
                ? 'border-accent-blue/50 bg-accent-blue/5'
                : 'border-app bg-app-muted/50 hover:border-app'
            } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={selected}
              onChange={() => onChange(o.value)}
              disabled={disabled}
              className="sr-only"
            />
            <span className={`mt-0.5 w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center transition-colors ${
              selected ? 'border-accent-blue' : 'border-app'
            }`}>
              {selected && <span className="w-2 h-2 rounded-full bg-accent-blue" />}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-sm text-theme-primary font-body">{o.label}</div>
              {o.description && (
                <div className="text-[11px] text-theme-muted font-body mt-0.5">{o.description}</div>
              )}
            </div>
          </label>
        );
      })}
    </div>
  );
}

function MultiSelect({
  value, options, onChange, disabled,
}: {
  value: string[];
  options: Array<{ label: string; value: string; description?: string }>;
  onChange: (v: string[]) => void;
  disabled: boolean;
}) {
  function toggle(v: string) {
    if (value.includes(v)) onChange(value.filter(x => x !== v));
    else onChange([...value, v]);
  }
  return (
    <div className="space-y-1.5">
      {options.map(o => {
        const checked = value.includes(o.value);
        return (
          <label
            key={o.value}
            className={`flex items-start gap-3 px-3 py-2 rounded-md border cursor-pointer transition-colors ${
              checked
                ? 'border-accent-blue/50 bg-accent-blue/5'
                : 'border-app bg-app-muted/50 hover:border-app'
            } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            <input
              type="checkbox"
              checked={checked}
              onChange={() => toggle(o.value)}
              disabled={disabled}
              className="sr-only"
            />
            {checked
              ? <CheckSquare className="w-4 h-4 text-accent-blue shrink-0 mt-0.5" />
              : <Square className="w-4 h-4 text-theme-subtle shrink-0 mt-0.5" />}
            <div className="flex-1 min-w-0">
              <div className="text-sm text-theme-primary font-body">{o.label}</div>
              {o.description && (
                <div className="text-[11px] text-theme-muted font-body mt-0.5">{o.description}</div>
              )}
            </div>
          </label>
        );
      })}
    </div>
  );
}

function DecisionButtons({
  mode, decision, onChange, disabled,
}: {
  mode: 'approval' | 'question' | 'escalation';
  decision: ClarificationDecision | null;
  onChange: (d: ClarificationDecision) => void;
  disabled: boolean;
}) {
  const buttons: Array<{ key: ClarificationDecision; label: string; icon: React.ReactNode; tone: 'green' | 'yellow' | 'red' | 'blue' }> =
    mode === 'question'
      ? [
        { key: 'answer',  label: 'Submit answer', icon: <SendHorizontal className="w-3.5 h-3.5" />, tone: 'blue' },
        { key: 'reject',  label: 'Reject',        icon: <XIcon className="w-3.5 h-3.5" />,          tone: 'red' },
      ]
      : mode === 'escalation'
        ? [
          { key: 'approve',         label: 'Accept deviations', icon: <Check className="w-3.5 h-3.5" />,      tone: 'green' },
          { key: 'request_changes', label: 'Request changes',   icon: <RotateCcw className="w-3.5 h-3.5" />, tone: 'yellow' },
          { key: 'reject',          label: 'Abandon',           icon: <XIcon className="w-3.5 h-3.5" />,     tone: 'red' },
        ]
        : [
          { key: 'approve',         label: 'Approve',         icon: <Check className="w-3.5 h-3.5" />,      tone: 'green' },
          { key: 'request_changes', label: 'Request changes', icon: <RotateCcw className="w-3.5 h-3.5" />, tone: 'yellow' },
          { key: 'reject',          label: 'Reject',          icon: <XIcon className="w-3.5 h-3.5" />,     tone: 'red' },
        ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
      {buttons.map(b => {
          const selected = decision === b.key;
          return (
            <button
              key={b.key}
              type="button"
              onClick={() => onChange(b.key)}
              disabled={disabled}
              className={`group flex items-center gap-2 px-3.5 py-2.5 rounded-md border text-[13px] font-body transition-all disabled:opacity-50 ${decisionButtonClass(b.tone, selected)}`}
            >
              <span className="shrink-0">{b.icon}</span>
              <span className="text-left">{b.label}</span>
              {selected && <Check className="w-3.5 h-3.5 ml-auto opacity-80" />}
            </button>
          );
        })}
    </div>
  );
}

// ── Small atoms ────────────────────────────────────────────────────────

function SectionLabel({ icon, text }: { icon?: React.ReactNode; text: string }) {
  return (
    <div className="flex items-center gap-1.5 mb-2.5 overline">
      {icon}
      {text}
    </div>
  );
}

function FieldLabel({ label, required, icon }: { label: string; required?: boolean; icon?: React.ReactNode }) {
  return (
    <label className="flex items-center gap-1.5 mb-1.5 text-[11px] font-label uppercase tracking-[0.1em] text-theme-secondary">
      {icon && <span className="text-theme-subtle">{icon}</span>}
      <span>{label}</span>
      {required && <span className="text-accent-red">*</span>}
    </label>
  );
}

function HelpText({ text }: { text: string }) {
  return <div className="text-[11px] text-theme-muted font-body mb-1.5 leading-snug">{text}</div>;
}

function FieldError({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-1.5 mt-1.5 text-[11px] text-accent-red font-body">
      <AlertCircle className="w-3 h-3 shrink-0" />
      {text}
    </div>
  );
}

// ── Theme + helpers ────────────────────────────────────────────────────

interface SeverityTheme {
  Icon: React.ComponentType<{ className?: string }>;
  iconClass: string;
  iconTileBg: string;
  iconTileBorder: string;
  glow: string;
  bgSoft: string;
  textAccent: string;
  badge: string;
}

function themeForSeverity(severity: ClarificationSeverity): SeverityTheme {
  switch (severity) {
    case 'approval':
      return {
        Icon: CheckCircle2,
        iconClass: 'text-accent-green',
        iconTileBg: 'bg-accent-green/10',
        iconTileBorder: 'border-accent-green/30',
        glow: 'ring-1 ring-inset ring-accent-green/10',
        bgSoft: 'bg-accent-green/5',
        textAccent: 'text-accent-green',
        badge: 'bg-accent-green/15 text-accent-green border border-accent-green/30',
      };
    case 'escalation':
      return {
        Icon: AlertTriangle,
        iconClass: 'text-accent-red',
        iconTileBg: 'bg-accent-red/10',
        iconTileBorder: 'border-accent-red/30',
        glow: 'ring-1 ring-inset ring-accent-red/10',
        bgSoft: 'bg-accent-red/5',
        textAccent: 'text-accent-red',
        badge: 'bg-accent-red/15 text-accent-red border border-accent-red/30',
      };
    case 'info':
      return {
        Icon: Info,
        iconClass: 'text-accent-blue',
        iconTileBg: 'bg-accent-blue/10',
        iconTileBorder: 'border-accent-blue/30',
        glow: 'ring-1 ring-inset ring-accent-blue/10',
        bgSoft: 'bg-accent-blue/5',
        textAccent: 'text-accent-blue',
        badge: 'bg-accent-blue/15 text-accent-blue border border-accent-blue/30',
      };
    case 'question':
    default:
      return {
        Icon: HelpCircle,
        iconClass: 'text-accent-yellow',
        iconTileBg: 'bg-accent-yellow/10',
        iconTileBorder: 'border-accent-yellow/30',
        glow: 'ring-1 ring-inset ring-accent-yellow/10',
        bgSoft: 'bg-accent-yellow/5',
        textAccent: 'text-accent-yellow',
        badge: 'bg-accent-yellow/15 text-accent-yellow border border-accent-yellow/30',
      };
  }
}

// Tailwind JIT purge requires static class strings — can't interpolate color
// names into class fragments. Every variant has its explicit classes.
function decisionButtonClass(tone: 'green' | 'yellow' | 'red' | 'blue', selected: boolean): string {
  if (selected) {
    switch (tone) {
      case 'green':  return 'border-accent-green/60 bg-accent-green/15 text-accent-green shadow-sm';
      case 'yellow': return 'border-accent-yellow/60 bg-accent-yellow/15 text-accent-yellow shadow-sm';
      case 'red':    return 'border-accent-red/60 bg-accent-red/15 text-accent-red shadow-sm';
      case 'blue':   return 'border-accent-blue/60 bg-accent-blue/15 text-accent-blue shadow-sm';
    }
  }
  switch (tone) {
    case 'green':  return 'border-app bg-app-muted/50 text-theme-secondary hover:border-accent-green/40 hover:text-accent-green hover:bg-accent-green/5';
    case 'yellow': return 'border-app bg-app-muted/50 text-theme-secondary hover:border-accent-yellow/40 hover:text-accent-yellow hover:bg-accent-yellow/5';
    case 'red':    return 'border-app bg-app-muted/50 text-theme-secondary hover:border-accent-red/40 hover:text-accent-red hover:bg-accent-red/5';
    case 'blue':   return 'border-app bg-app-muted/50 text-theme-secondary hover:border-accent-blue/40 hover:text-accent-blue hover:bg-accent-blue/5';
  }
}

function submitButtonClass(decision: ClarificationDecision | null, severity: ClarificationSeverity): string {
  // Color the submit button to match the current decision so users get
  // visual confirmation of what they're about to do.
  if (decision === 'reject')          return 'bg-accent-red text-white hover:bg-accent-red/90';
  if (decision === 'request_changes') return 'bg-accent-yellow text-black hover:bg-accent-yellow/90';
  if (decision === 'approve')         return 'bg-accent-green text-black hover:bg-accent-green/90';
  if (decision === 'answer')          return 'bg-accent-blue text-white hover:bg-accent-blue/90';
  if (severity === 'approval')        return 'bg-accent-green text-black hover:bg-accent-green/90';
  if (severity === 'escalation')      return 'bg-accent-red text-white hover:bg-accent-red/90';
  return 'bg-accent-blue text-white hover:bg-accent-blue/90';
}

function iconForFieldType(t: string): React.ReactNode {
  switch (t) {
    case 'json': case 'yaml': case 'code': case 'markdown': return <Code2 className="w-3 h-3" />;
    case 'number': return <Hash className="w-3 h-3" />;
    case 'boolean': return <CheckSquare className="w-3 h-3" />;
    case 'select': case 'radio': case 'multiselect': return <List className="w-3 h-3" />;
    case 'date': return <Calendar className="w-3 h-3" />;
    case 'url': return <LinkIcon className="w-3 h-3" />;
    case 'email': return <Mail className="w-3 h-3" />;
    case 'password': return <Lock className="w-3 h-3" />;
    case 'textarea': return <Type className="w-3 h-3" />;
    default: return <Type className="w-3 h-3" />;
  }
}

function labelForSeverity(s: ClarificationSeverity): string {
  switch (s) {
    case 'approval':   return 'Approval';
    case 'escalation': return 'Escalation';
    case 'info':       return 'Info';
    case 'question':
    default:           return 'Question';
  }
}

/** Submit button text that echoes what the user is actually about to do,
 *  so we don't need a separate "Will submit as X" hint line. */
function submitButtonLabel(
  mode: ClarificationPanelProps['mode'],
  decision: ClarificationDecision | null,
): string {
  if (mode === 'escalation')          return 'Submit';
  if (decision === 'reject')          return 'Reject';
  if (decision === 'request_changes') return 'Request changes';
  if (decision === 'approve')         return 'Approve';
  if (decision === 'answer')          return 'Submit answer';
  if (mode === 'approval')            return 'Choose an action';
  return 'Submit';
}

function defaultDecision(mode: ClarificationPanelProps['mode']): ClarificationDecision | null {
  // Auto-select the primary action so single-click flows work. User can
  // still change it.
  switch (mode) {
    case 'question':   return 'answer';
    case 'escalation': return 'request_changes';
    default:           return null;
  }
}

function seedValues(fields: ClarificationField[]): Record<string, unknown> {
  const initial: Record<string, unknown> = {};
  for (const f of fields) {
    const t = String(f.type || 'text').toLowerCase();
    if (f.default !== undefined) {
      initial[f.name] = f.default;
    } else if (t === 'boolean') {
      initial[f.name] = false;
    } else if (t === 'multiselect') {
      initial[f.name] = [];
    } else if (t === 'select' || t === 'radio') {
      const opts = normalizeOptions(f.options);
      initial[f.name] = opts[0]?.value ?? '';
    } else {
      initial[f.name] = '';
    }
  }
  return initial;
}

function normalizeOptions(
  options?: string[] | Array<{ label: string; value: string; description?: string }>,
): Array<{ label: string; value: string; description?: string }> {
  if (!options) return [];
  return options.map(o =>
    typeof o === 'string'
      ? { label: o, value: o }
      : o,
  );
}

function prettifyName(name: string): string {
  return name
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function tryFormatJSON(s: string): string {
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
}
