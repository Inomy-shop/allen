/**
 * InterventionsPage
 *
 * Dedicated page for the Human Intervention Protocol:
 *   - /interventions        — list view, sectioned into Pending + History
 *   - /interventions/:id    — detail view powered by ClarificationPanel
 *
 * All field rendering, review content viewing, and action buttons now flow
 * through the shared ClarificationPanel — same visual language as the
 * execution page's HumanInputDialog.
 */

import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { interventions as interventionsApi } from '../services/api';
import { useRunContext } from '../hooks/useRunContext';
import { useToast } from '../components/common/Toast';
import ClarificationPanel, {
  type ClarificationField,
  type ClarificationSeverity,
} from '../components/clarification/ClarificationPanel';
import RunStatusCard from '../components/executions/RunStatusCard';
import {
  ArrowRight, Check, AlertTriangle, CheckCircle2, HelpCircle,
  Clock, RefreshCw, Search, Inbox as InterventionIcon,
  Archive, Activity, ChevronLeft, User,
  Sparkles, ShieldCheck, Shield,
} from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────────────

interface InterventionField {
  name: string;
  label?: string;
  type?: string;
  required?: boolean;
  options?: string[];
  placeholder?: string;
}

interface Intervention {
  _id: string;
  intervention_id: string;
  workflow_run_id: string;
  workflow_name: string;
  stage: string;
  severity: 'question' | 'approval' | 'escalation';
  title: string;
  context_summary: string;
  question: string;
  options: Array<{ label: string; value: string; primary?: boolean; destructive?: boolean }>;
  fields?: InterventionField[];
  docs: Array<{ label: string; url: string; kind?: string }>;
  round_info?: { current: number; max: number };
  user_request?: string;
  review_content?: string;
  review_content_type?: 'markdown' | 'json' | 'code' | 'text';
  review_language?: string;
  status: 'pending' | 'answered' | 'expired' | 'skipped';
  response?: {
    decision: string;
    feedback?: string;
    scope?: string | null;
    answer?: string;
  };
  retry_triggered?: { target_node: string; retry_attempt: number; retry_source: string };
  answered_at?: string;
  answered_by_user_id?: string;
  created_at: string;
}

// ── Severity visual helpers ────────────────────────────────────────────

function SeverityIcon({ severity, className = 'w-4 h-4' }: {
  severity: Intervention['severity'];
  className?: string;
}) {
  switch (severity) {
    case 'question':   return <HelpCircle className={className} />;
    case 'approval':   return <ShieldCheck className={className} />;
    case 'escalation': return <AlertTriangle className={className} />;
  }
}

function severityLabel(severity: Intervention['severity']): string {
  switch (severity) {
    case 'question':   return 'Question';
    case 'approval':   return 'Approval';
    case 'escalation': return 'Escalation';
  }
}

function severityTheme(severity: Intervention['severity']): {
  text: string;
  bg: string;
  bgSoft: string;
  border: string;
  strip: string;
  badge: string;
} {
  switch (severity) {
    case 'question':
      return {
        text: 'text-accent-yellow',
        bg: 'bg-accent-yellow/10',
        bgSoft: 'bg-accent-yellow/5',
        border: 'border-accent-yellow/30',
        strip: 'bg-accent-yellow',
        badge: 'bg-accent-yellow/15 text-accent-yellow border border-accent-yellow/30',
      };
    case 'approval':
      return {
        text: 'text-accent-green',
        bg: 'bg-accent-green/10',
        bgSoft: 'bg-accent-green/5',
        border: 'border-accent-green/30',
        strip: 'bg-accent-green',
        badge: 'bg-accent-green/15 text-accent-green border border-accent-green/30',
      };
    case 'escalation':
      return {
        text: 'text-accent-red',
        bg: 'bg-accent-red/10',
        bgSoft: 'bg-accent-red/5',
        border: 'border-accent-red/30',
        strip: 'bg-accent-red',
        badge: 'bg-accent-red/15 text-accent-red border border-accent-red/30',
      };
  }
}

function relativeTime(dateStr?: string): string {
  if (!dateStr) return '';
  const ms = Date.now() - new Date(dateStr).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} day${day === 1 ? '' : 's'} ago`;
  return new Date(dateStr).toLocaleDateString();
}

function humaniseStage(stage: string): string {
  return stage
    .split(/[_-]/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function responseDecisionLabel(d?: string): { label: string; color: string } {
  switch (d) {
    case 'approve':         return { label: 'Approved',          color: 'text-accent-green' };
    case 'reject':          return { label: 'Rejected',          color: 'text-accent-red' };
    case 'request_changes': return { label: 'Changes requested', color: 'text-accent-yellow' };
    case 'answer':          return { label: 'Answered',          color: 'text-accent-blue' };
    default:                return { label: d ?? 'unknown',      color: 'text-theme-muted' };
  }
}

// ── Row ────────────────────────────────────────────────────────────────

function InterventionRow({ item, emphasized }: { item: Intervention; emphasized: boolean }) {
  const theme = severityTheme(item.severity);
  const decision = responseDecisionLabel(item.response?.decision);
  const isPending = item.status === 'pending';

  return (
    <Link
      to={`/interventions/${item.intervention_id}`}
      className={`group flex items-stretch border-b border-border/10 last:border-b-0 transition-colors ${
        emphasized ? 'hover:bg-app-muted/50' : 'hover:bg-surface-200/15'
      }`}
    >
      {/* Severity strip */}
      <div className={`w-1 shrink-0 ${theme.strip} ${isPending ? '' : 'opacity-30'}`} />

      <div className={`flex-1 flex items-start gap-4 px-4 py-3.5 min-w-0 ${emphasized ? '' : 'opacity-80'}`}>
        {/* Severity icon tile — lucide, not emoji */}
        <div className={`shrink-0 w-10 h-10 rounded-lg ${theme.bg} border ${theme.border} flex items-center justify-center`}>
          <SeverityIcon severity={item.severity} className={`w-4 h-4 ${theme.text}`} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className={`text-[13px] font-body font-medium truncate ${
              emphasized ? 'text-theme-primary' : 'text-theme-secondary'
            }`}>
              {item.title}
            </span>
            {item.round_info && (
              <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded-full ${theme.bg} ${theme.text} shrink-0`}>
                {item.round_info.current}/{item.round_info.max}
              </span>
            )}
            <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded-full shrink-0 ${theme.badge}`}>
              {severityLabel(item.severity)}
            </span>
          </div>

          {item.context_summary && (
            <p className="text-[11px] text-theme-muted font-body line-clamp-1 mb-1.5">
              {item.context_summary}
            </p>
          )}

          <div className="flex items-center gap-3 text-[10px] font-mono text-theme-subtle">
            <span className="flex items-center gap-1">
              <Activity className="w-3 h-3" />
              {item.workflow_name}
            </span>
            <span>·</span>
            <span>{humaniseStage(item.stage)}</span>
            <span>·</span>
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {relativeTime(item.created_at)}
            </span>
            {!isPending && item.response && (
              <>
                <span>·</span>
                <span className={`flex items-center gap-1 ${decision.color}`}>
                  <Check className="w-3 h-3" />
                  {decision.label}
                  {item.answered_at && <span className="text-theme-subtle"> · {relativeTime(item.answered_at)}</span>}
                </span>
              </>
            )}
          </div>
        </div>

        <div className="shrink-0 self-center">
          {isPending ? (
            <div className="flex items-center gap-1 text-[10px] font-mono text-accent-blue opacity-0 group-hover:opacity-100 transition-opacity">
              Respond <ArrowRight className="w-3 h-3" />
            </div>
          ) : (
            <Archive className="w-3.5 h-3.5 text-theme-subtle" />
          )}
        </div>
      </div>
    </Link>
  );
}

// ── List ───────────────────────────────────────────────────────────────

function InterventionsListView() {
  const [items, setItems] = useState<Intervention[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'gate' | 'review' | 'question' | 'blocked' | 'mention'>('all');
  const [search, setSearch] = useState('');

  async function load() {
    setLoading(true);
    try {
      const data = await interventionsApi.list({ limit: 500 });
      setItems(data ?? []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const pendingCount = useMemo(() => items.filter(i => i.status === 'pending').length, [items]);
  const answeredCount = useMemo(() => items.filter(i => i.status === 'answered').length, [items]);

  useEffect(() => {
    if (pendingCount === 0) return;
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [pendingCount]);

  function kindFor(item: Intervention): 'gate' | 'review' | 'question' | 'blocked' | 'mention' {
    const haystack = `${item.title} ${item.context_summary} ${item.question} ${item.user_request ?? ''}`.toLowerCase();
    if (filter === 'mention' && haystack.includes('@')) return 'mention';
    if (item.severity === 'escalation') return 'blocked';
    if (item.severity === 'approval') return item.stage?.toLowerCase().includes('gate') ? 'gate' : 'review';
    return 'question';
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter(i => {
      const matchesSearch = !q
        || i.title.toLowerCase().includes(q)
        || i.context_summary.toLowerCase().includes(q)
        || i.workflow_name.toLowerCase().includes(q)
        || i.stage.toLowerCase().includes(q)
        || (i.user_request ?? '').toLowerCase().includes(q);
      if (!matchesSearch) return false;
      if (filter === 'all') return true;
      return kindFor(i) === filter;
    });
  }, [filter, items, search]);

  const pending = filtered.filter(i => i.status === 'pending');
  const groups = {
    urgent: pending.filter(i => i.severity === 'escalation'),
    today: pending.filter(i => i.severity !== 'escalation'),
    fyi: filtered.filter(i => i.status !== 'pending'),
  };

  return (
    <div className="content scroll-hide" data-screen-label="interventions">
      <div className="page-head">
        <div className="ph-row">
          <div>
            <h1>interventions</h1>
            <p className="sub">
              {pendingCount} things waiting on you · {answeredCount} answered · {items.length} total
            </p>
          </div>
          <button onClick={load} disabled={loading} className="btn btn-secondary btn-sm" type="button">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <div className="filter-row">
        {(['all', 'gate', 'review', 'question', 'blocked', 'mention'] as const).map((key) => (
          <button key={key} className={`fchip ${filter === key ? 'active' : ''}`} onClick={() => setFilter(key)} type="button">
            {key}
          </button>
        ))}
        <div className="th-search min-w-[240px] flex-1 p-0">
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="search interventions..."
          />
        </div>
      </div>

      {loading && items.length === 0 && <div className="task-empty">loading interventions...</div>}
      {!loading && filtered.length === 0 && <EmptyState hasFilters={filter !== 'all' || search.trim() !== ''} />}

      {Object.entries(groups).filter(([, arr]) => arr.length > 0).map(([group, arr]) => (
        <section key={group} className="ib-grp">
          <h4 className="grp-h">{group} <span className="ct">{arr.length}</span></h4>
          <div className="ib-list">
            {arr.map((item) => (
              <Link key={item.intervention_id} className="ib-row" to={`/interventions/${item.intervention_id}`}>
                <span className={`ib-kind ${kindFor(item)}`}>{kindFor(item)}</span>
                <div className="ib-body">
                  <div className="ib-title">{item.title}</div>
                  <div className="ib-sub">{item.context_summary || `${item.workflow_name} · ${humaniseStage(item.stage)}`}</div>
                </div>
                <span className="ib-age">{relativeTime(item.created_at)}</span>
                <span className="btn btn-secondary btn-sm">open</span>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function SectionHeader({
  icon, label, count, emphasized,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  emphasized: boolean;
}) {
  return (
    <div className="flex items-center gap-2 px-6 py-3">
      {icon}
      <span className={`overline ${
        emphasized ? 'text-theme-primary' : 'text-theme-muted'
      }`}>
        {label}
      </span>
      <span className={`text-[10px] font-mono ${
        emphasized ? 'text-accent-yellow' : 'text-theme-subtle'
      }`}>
        ({count})
      </span>
    </div>
  );
}

function EmptyState({ hasFilters }: { hasFilters: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 px-6 text-center">
      <div className="w-16 h-16 rounded-full bg-app-muted/50 flex items-center justify-center mb-4">
        <InterventionIcon className="w-8 h-8 text-theme-subtle" />
      </div>
      {hasFilters ? (
        <>
          <h3 className="text-sm font-heading font-semibold text-theme-primary mb-1">
            No interventions match your filters
          </h3>
          <p className="text-xs text-theme-muted font-body max-w-md">
            Try loosening the filters — set status to "All statuses" and severity to "Any severity".
          </p>
        </>
      ) : (
        <>
          <h3 className="text-sm font-heading font-semibold text-theme-primary mb-1">
            No interventions yet
          </h3>
          <p className="text-xs text-theme-muted font-body max-w-md">
            When a workflow pauses for human input — a clarification, plan approval, or escalation —
            it shows up here.
          </p>
        </>
      )}
    </div>
  );
}

// ── Detail view ────────────────────────────────────────────────────────

function InterventionDetailView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const [item, setItem] = useState<Intervention | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const { runContext, loading: runContextLoading, error: runContextError } = useRunContext(item?.workflow_run_id);

  async function load() {
    if (!id) return;
    setLoading(true);
    try {
      const data = await interventionsApi.get(id);
      setItem(data);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-theme-muted">
        <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
        Loading intervention…
      </div>
    );
  }
  if (!item) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-6">
        <AlertTriangle className="w-8 h-8 text-accent-red mb-3" />
        <h3 className="text-sm font-heading text-theme-primary">Intervention not found</h3>
        <p className="text-xs text-theme-muted mt-1">It may have been archived or the ID is wrong.</p>
        <button
          onClick={() => navigate('/interventions')}
          className="mt-4 inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-[10px] font-mono bg-app-muted/50 text-theme-muted hover:bg-app-muted"
        >
          <ChevronLeft className="w-3 h-3" /> Back to interventions
        </button>
      </div>
    );
  }

  const theme = severityTheme(item.severity);
  const isPending = item.status === 'pending';
  const isPlanApproval = item.stage === 'plan_approval_gate';

  // Map intervention → ClarificationPanel props.
  // Mode is derived from CONTENT (does this intervention carry options or
  // a decision field?), not from severity. Driving it from severity alone
  // silently dropped the buttons on `escalation` and `question`-with-options
  // interventions — they all rendered as a single textarea.
  const interventionHasOptions = Array.isArray(item.options) && item.options.length > 0;
  const interventionHasDecisionField = (item.fields ?? []).some(f => {
    const fname = (f.name ?? '').toLowerCase();
    const ftype = String(f.type ?? '').toLowerCase();
    const opts = Array.isArray(f.options) ? f.options : [];
    const optValues = opts.map(o => typeof o === 'string' ? o.toLowerCase() : '');
    return fname.includes('decision')
      || fname.includes('approval')
      || fname === 'action'
      || ((ftype === 'select' || ftype === 'radio') && optValues.some(v =>
        v === 'approve' || v === 'request_changes' || v === 'reject' || v === 'cancel'
        || v === 'retry_with_feedback' || v === 'override_and_continue' || v === 'abandon'
      ));
  });
  const panelMode: 'simple' | 'approval' =
    (interventionHasOptions || interventionHasDecisionField) ? 'approval' : 'simple';

  const panelSeverity: ClarificationSeverity =
    item.severity === 'approval'   ? 'approval'
    : item.severity === 'escalation' ? 'escalation'
    : 'question';

  const originalFields: ClarificationField[] = (item.fields ?? []).map(f => ({
    name: f.name,
    type: (f.type as ClarificationField['type']) ?? 'text',
    label: f.label,
    required: f.required !== false,
    options: f.options,
    placeholder: f.placeholder,
  }));
  const responseField = originalFields.find(f => {
    const name = f.name.toLowerCase();
    const type = String(f.type || '').toLowerCase();
    return name.includes('feedback') || name.includes('reason') || name.includes('comment') || type === 'textarea';
  }) ?? originalFields.find(f => !isDecisionFieldName(f.name));
  const fields: ClarificationField[] = panelMode === 'approval'
    ? originalFields
    : [{
      name: '__human_response',
      type: 'textarea',
      label: responseField?.label ?? 'Your response',
      required: true,
      placeholder: responseField?.placeholder ?? 'Type your response...',
    }];

  const scopeOptions = isPlanApproval ? [
    { value: 'requirements',     label: 'Requirements (PRD)',   description: 'Re-runs PRD → HLA → TDD' },
    { value: 'architecture',     label: 'Architecture (HLA)',   description: 'Re-runs HLA → TDD' },
    { value: 'technical_design', label: 'Technical Design',     description: 'Re-runs TDD only' },
    { value: 'all',              label: 'All three',            description: 'Start from PRD' },
  ] : undefined;

  async function onSubmit(payload: {
    decision?: 'approve' | 'request_changes' | 'reject' | 'answer';
    fieldValues: Record<string, unknown>;
    feedback?: string;
    scope?: string;
  }) {
    if (!item || (panelMode === 'approval' && !payload.decision)) return;
    setSubmitting(true);
    try {
      const decision = panelMode === 'approval' ? payload.decision! : 'answer';
      const fieldValues = panelMode === 'approval'
        ? payload.fieldValues
        : freeformFieldValues(originalFields, payload.fieldValues);
      await interventionsApi.respond(item.intervention_id, {
        decision,
        feedback: payload.feedback,
        scope: payload.scope as 'requirements' | 'architecture' | 'technical_design' | 'all' | undefined,
        field_values:
          decision === 'answer' || decision === 'approve'
            ? (fieldValues as Record<string, string>)
            : undefined,
        human_node_name: item.stage,
      });
      toast.success(`Response submitted: ${decision}`);
      await load();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to submit response');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="w-full p-6">
      {/* Breadcrumb + status pill + quick meta */}
      <div className="mb-4 flex items-center gap-3 text-[11px] font-mono text-theme-muted flex-wrap">
        <Link to="/interventions" className="flex items-center gap-1 hover:text-theme-primary transition-colors">
          <ChevronLeft className="w-3 h-3" /> Interventions
        </Link>
        <span>/</span>
        <span className="text-theme-primary">{item.intervention_id}</span>
        <span className="ml-auto">
          {isPending ? (
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-accent-yellow/10 text-accent-yellow border border-accent-yellow/30">
              <span className="w-1.5 h-1.5 rounded-full bg-accent-yellow animate-pulse" /> Awaiting response
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-app-muted text-theme-muted border border-app">
              <Check className="w-3 h-3" /> Resolved
            </span>
          )}
        </span>
      </div>

      {/* Compact hero — identity only (severity/stage/title/workflow/time).
          Context summary and question live inside the panel to avoid
          duplicating the same text in two places. */}
      <div className={`relative border ${theme.border} ${theme.bgSoft} rounded-xl mb-5 overflow-hidden shadow-sm`}>
        <div className={`absolute left-0 top-0 bottom-0 w-1 ${theme.strip}`} />
        <div className="p-5 pl-7">
          <div className="flex items-center gap-4">
            <div className={`shrink-0 w-12 h-12 rounded-xl ${theme.bg} border ${theme.border} flex items-center justify-center shadow-sm`}>
              <SeverityIcon severity={item.severity} className={`w-5 h-5 ${theme.text}`} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-medium uppercase tracking-wider ${theme.badge}`}>
                  <SeverityIcon severity={item.severity} className="w-2.5 h-2.5" />
                  {severityLabel(item.severity)}
                </span>
                <span className="text-[10px] font-mono text-theme-muted">{humaniseStage(item.stage)}</span>
                {item.round_info && (
                  <span className="text-[10px] font-mono text-theme-muted bg-app-muted px-2 py-0.5 rounded-full border border-app">
                    Round {item.round_info.current} / {item.round_info.max}
                  </span>
                )}
              </div>
              <h1 className="text-lg font-heading font-semibold text-theme-primary tracking-tight leading-snug truncate">
                {item.title}
              </h1>
            </div>
            <div className="shrink-0 flex flex-col items-end gap-1 text-[10px] font-mono text-theme-muted">
              <Link
                to={`/executions/${item.workflow_run_id}`}
                className="flex items-center gap-1 hover:text-accent-blue transition-colors"
              >
                <Activity className="w-3 h-3" />
                {item.workflow_name}
              </Link>
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" /> {relativeTime(item.created_at)}
              </span>
            </div>
          </div>

          {item.user_request && (
            <div className="mt-4 pt-3 border-t border-current/10">
              <div className="overline mb-1 flex items-center gap-1.5">
                <Sparkles className="w-3 h-3" /> Original request
              </div>
              <p className="text-sm italic text-theme-primary font-body leading-relaxed">
                "{item.user_request}"
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Context summary — one-liner above the panel. Skip rendering if the
          summary would just repeat the question (common for short
          single-sentence clarifies). */}
      {item.context_summary && item.context_summary !== item.question && (
        <div className="mb-5 px-4 py-3 rounded-lg bg-app-muted/50 border border-app text-sm text-theme-secondary font-body leading-relaxed">
          {item.context_summary}
        </div>
      )}

      <div className="mb-5">
        <RunStatusCard
          context={runContext}
          loading={runContextLoading}
          error={runContextError}
          title={isPending ? 'Paused execution' : 'Execution status'}
        />
      </div>

      {/* Action panel (pending) — shared ClarificationPanel.
          Note: we pass no `title` so the panel skips its own header and
          doesn't duplicate the hero above. */}
      {isPending && (
        <div className="rounded-xl border border-app bg-surface-50 overflow-hidden shadow-sm">
          <ClarificationPanel
            layout="inline"
            prompt={item.question}
            severity={panelSeverity}
            fields={fields}
            reviewContent={item.review_content}
            reviewContentType={item.review_content_type}
            reviewLanguage={item.review_language}
            mode={panelMode}
            scopeOptions={scopeOptions}
            docs={item.docs?.map(d => ({ label: d.label, url: d.url }))}
            submitting={submitting}
            onSubmit={onSubmit}
          />
        </div>
      )}

      {/* Answered record */}
      {!isPending && item.response && (
        <div className="rounded-xl border border-app bg-surface-50 overflow-hidden shadow-sm">
          <div className="px-6 py-4 border-b border-app bg-app-muted/40">
            <div className="overline">
              Response
            </div>
          </div>
          <div className="p-6">
            <AnsweredBlock item={item} />
          </div>
        </div>
      )}
    </div>
  );
}

function AnsweredBlock({ item }: { item: Intervention }) {
  const decision = responseDecisionLabel(item.response?.decision);
  return (
    <div>
      <div className="flex items-center gap-3 mb-5 pb-4 border-b border-app">
        <div className={`w-11 h-11 rounded-xl bg-app-muted border border-app flex items-center justify-center ${decision.color}`}>
          <Check className="w-5 h-5" />
        </div>
        <div className="flex-1">
          <div className={`text-sm font-heading font-semibold ${decision.color}`}>{decision.label}</div>
          <div className="text-[10px] font-mono text-theme-muted mt-0.5 flex items-center gap-2">
            <User className="w-3 h-3" />
            {item.answered_by_user_id ?? 'unknown user'}
            <span>·</span>
            <Clock className="w-3 h-3" />
            {item.answered_at ? relativeTime(item.answered_at) : 'unknown time'}
          </div>
        </div>
      </div>

      {item.response?.scope && (
        <ResponseField label="Scope" value={item.response.scope} mono />
      )}
      {item.response?.feedback && (
        <ResponseField label="Feedback" value={item.response.feedback} pre />
      )}
      {item.response?.answer && (
        <ResponseField label="Answer" value={item.response.answer} pre />
      )}
      {item.retry_triggered && (
        <div className="mt-4 pt-4 border-t border-app text-[11px] font-mono text-theme-muted flex items-center gap-2">
          <RefreshCw className="w-3 h-3" />
          Retry triggered at <span className="text-accent-blue">{item.retry_triggered.target_node}</span>
          <span>(attempt {item.retry_triggered.retry_attempt} · {item.retry_triggered.retry_source})</span>
        </div>
      )}
    </div>
  );
}

function ResponseField({ label, value, pre, mono }: {
  label: string;
  value: string;
  pre?: boolean;
  mono?: boolean;
}) {
  return (
    <div className="mb-4 last:mb-0">
      <div className="overline mb-1.5">{label}</div>
      {pre ? (
        <pre className={`text-xs whitespace-pre-wrap text-theme-primary font-body bg-surface-100/50 border border-app rounded-md p-3 leading-relaxed ${mono ? 'font-mono' : ''}`}>
          {value}
        </pre>
      ) : (
        <span className={`text-xs text-theme-primary ${mono ? 'font-mono' : ''}`}>{value}</span>
      )}
    </div>
  );
}

function isDecisionFieldName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('decision') || lower.includes('approval') || lower === 'action';
}

function freeformFieldValues(
  fields: ClarificationField[],
  submitted: Record<string, unknown>,
): Record<string, unknown> {
  const text = firstTextValue(submitted);
  const values: Record<string, unknown> = {};
  const decisionField = fields.find(f => isDecisionFieldName(f.name));
  const responseField = fields.find(f => {
    const name = f.name.toLowerCase();
    const type = String(f.type || '').toLowerCase();
    return name.includes('feedback') || name.includes('reason') || name.includes('comment') || type === 'textarea';
  }) ?? fields.find(f => !isDecisionFieldName(f.name));

  if (decisionField) {
    const optionValues = (decisionField.options ?? []).map(option => (
      typeof option === 'string' ? option : option.value
    ));
    if (optionValues.includes('retry_with_feedback')) values[decisionField.name] = 'retry_with_feedback';
    else if (optionValues.includes('request_changes')) values[decisionField.name] = 'request_changes';
    else values[decisionField.name] = text;
  }
  values[responseField?.name ?? 'answer'] = text;
  return values;
}

function firstTextValue(values: Record<string, unknown>): string {
  for (const value of Object.values(values)) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

// ── Page component ────────────────────────────────────────────────────

export default function InterventionsPage() {
  const { id } = useParams<{ id?: string }>();
  return id ? <InterventionDetailView /> : <InterventionsListView />;
}
