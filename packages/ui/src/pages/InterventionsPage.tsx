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
import { useToast } from '../components/common/Toast';
import ClarificationPanel, {
  type ClarificationField,
  type ClarificationSeverity,
} from '../components/clarification/ClarificationPanel';
import {
  ArrowRight, Check, AlertTriangle, CheckCircle2, HelpCircle,
  Clock, RefreshCw, Search, Inbox,
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
        emphasized ? 'hover:bg-surface-200/30' : 'hover:bg-surface-200/15'
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
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'answered'>('all');
  const [severityFilter, setSeverityFilter] = useState<'all' | Intervention['severity']>('all');
  const [search, setSearch] = useState('');

  async function load() {
    setLoading(true);
    try {
      const data = await interventionsApi.list({
        status: statusFilter === 'all' ? undefined : statusFilter,
        severity: severityFilter === 'all' ? undefined : severityFilter,
        limit: 500,
      });
      setItems(data ?? []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [statusFilter, severityFilter]);

  const pendingCount = useMemo(() => items.filter(i => i.status === 'pending').length, [items]);
  const answeredCount = useMemo(() => items.filter(i => i.status === 'answered').length, [items]);

  useEffect(() => {
    if (pendingCount === 0) return;
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [pendingCount, statusFilter, severityFilter]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(i =>
      i.title.toLowerCase().includes(q)
      || i.context_summary.toLowerCase().includes(q)
      || i.workflow_name.toLowerCase().includes(q)
      || i.stage.toLowerCase().includes(q)
      || (i.user_request ?? '').toLowerCase().includes(q),
    );
  }, [items, search]);

  const pending = filtered.filter(i => i.status === 'pending');
  const history = filtered.filter(i => i.status !== 'pending');

  return (
    <div className="flex flex-col h-full">
      <div className="sticky top-0 z-10 bg-surface-50 border-b border-border/30">
        <div className="p-6 pb-4">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <Shield className="w-5 h-5 text-accent-blue" />
                <h1 className="font-heading text-xl font-bold text-theme-primary tracking-widest uppercase">
                  Interventions
                </h1>
              </div>
              <div className="flex items-center gap-3 mt-1 text-[10px] font-mono text-theme-muted">
                <span className="flex items-center gap-1">
                  <Clock className="w-3 h-3 text-accent-yellow" />
                  <span className="text-theme-primary font-semibold">{pendingCount}</span> pending
                </span>
                <span className="flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3 text-accent-green" />
                  <span className="text-theme-primary font-semibold">{answeredCount}</span> answered
                </span>
                <span>· {items.length} total</span>
                {pendingCount > 0 && (
                  <span className="ml-2 flex items-center gap-1 text-accent-blue">
                    <RefreshCw className="w-3 h-3 animate-spin" />
                    auto-refresh on
                  </span>
                )}
              </div>
            </div>
            <button
              onClick={load}
              disabled={loading}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[10px] font-mono bg-surface-200/30 text-theme-muted hover:bg-surface-200/50 disabled:opacity-50"
            >
              <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-theme-subtle pointer-events-none" />
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search title, workflow, stage, user request…"
                className="input text-xs pl-8 pr-3 py-1.5 w-full"
              />
            </div>
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value as 'all' | 'pending' | 'answered')}
              className="input text-xs px-2 py-1.5"
            >
              <option value="all">All statuses</option>
              <option value="pending">Pending only</option>
              <option value="answered">Answered only</option>
            </select>
            <select
              value={severityFilter}
              onChange={e => setSeverityFilter(e.target.value as 'all' | Intervention['severity'])}
              className="input text-xs px-2 py-1.5"
            >
              <option value="all">Any severity</option>
              <option value="question">Question</option>
              <option value="approval">Approval</option>
              <option value="escalation">Escalation</option>
            </select>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && items.length === 0 && (
          <div className="flex items-center justify-center py-16 text-xs text-theme-muted">
            <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
            Loading interventions…
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <EmptyState hasFilters={statusFilter !== 'all' || severityFilter !== 'all' || search.trim() !== ''} />
        )}

        {filtered.length > 0 && (
          <div className="pb-8">
            {pending.length > 0 && (
              <section>
                <SectionHeader
                  icon={<Inbox className="w-3.5 h-3.5 text-accent-yellow" />}
                  label="Pending"
                  count={pending.length}
                  emphasized
                />
                <div className="border-y border-border/30 bg-surface-100">
                  {pending.map(i => (
                    <InterventionRow key={i.intervention_id} item={i} emphasized />
                  ))}
                </div>
              </section>
            )}
            {history.length > 0 && (
              <section className="mt-6">
                <SectionHeader
                  icon={<Archive className="w-3.5 h-3.5 text-theme-muted" />}
                  label="History"
                  count={history.length}
                  emphasized={false}
                />
                <div className="border-y border-border/20 bg-surface-50">
                  {history.map(i => (
                    <InterventionRow key={i.intervention_id} item={i} emphasized={false} />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
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
      <span className={`text-[10px] font-label uppercase tracking-widest ${
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
      <div className="w-16 h-16 rounded-full bg-surface-200/30 flex items-center justify-center mb-4">
        <Inbox className="w-8 h-8 text-theme-subtle" />
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
            it shows up here. Try running <span className="font-mono text-theme-primary">test-human-intervention</span>.
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
          className="mt-4 inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-[10px] font-mono bg-surface-200/30 text-theme-muted hover:bg-surface-200/50"
        >
          <ChevronLeft className="w-3 h-3" /> Back to interventions
        </button>
      </div>
    );
  }

  const theme = severityTheme(item.severity);
  const isPending = item.status === 'pending';
  const isPlanApproval = item.stage === 'plan_approval_gate';

  // Map intervention → ClarificationPanel props
  const panelMode: 'simple' | 'approval' | 'question' | 'escalation' =
    item.severity === 'approval'   ? 'approval'
    : item.severity === 'escalation' ? 'escalation'
    : item.severity === 'question'   ? 'question'
    : 'simple';

  const panelSeverity: ClarificationSeverity =
    item.severity === 'approval'   ? 'approval'
    : item.severity === 'escalation' ? 'escalation'
    : 'question';

  const fields: ClarificationField[] = (item.fields ?? []).map(f => ({
    name: f.name,
    type: (f.type as ClarificationField['type']) ?? 'text',
    label: f.label,
    required: f.required !== false,
    options: f.options,
    placeholder: f.placeholder,
  }));

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
    if (!item || !payload.decision) return;
    setSubmitting(true);
    try {
      await interventionsApi.respond(item.intervention_id, {
        decision: payload.decision,
        feedback: payload.feedback,
        scope: payload.scope as 'requirements' | 'architecture' | 'technical_design' | 'all' | undefined,
        field_values:
          payload.decision === 'answer' || payload.decision === 'approve'
            ? (payload.fieldValues as Record<string, string>)
            : undefined,
        human_node_name: item.stage,
      });
      toast.success(`Response submitted: ${payload.decision}`);
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
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-surface-200/40 text-theme-muted border border-border/30">
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
                  <span className="text-[10px] font-mono text-theme-muted bg-surface-200/40 px-2 py-0.5 rounded-full border border-border/20">
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
              <div className="text-[10px] font-label uppercase tracking-widest text-theme-muted mb-1 flex items-center gap-1.5">
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
        <div className="mb-5 px-4 py-3 rounded-lg bg-surface-100/40 border border-border/20 text-sm text-theme-secondary font-body leading-relaxed">
          {item.context_summary}
        </div>
      )}

      {/* Action panel (pending) — shared ClarificationPanel.
          Note: we pass no `title` so the panel skips its own header and
          doesn't duplicate the hero above. */}
      {isPending && (
        <div className="rounded-xl border border-border/30 bg-surface-50 overflow-hidden shadow-sm">
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
        <div className="rounded-xl border border-border/30 bg-surface-50 overflow-hidden shadow-sm">
          <div className="px-6 py-4 border-b border-border/15 bg-surface-100/30">
            <div className="text-[10px] font-label uppercase tracking-widest text-theme-muted">
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
      <div className="flex items-center gap-3 mb-5 pb-4 border-b border-border/15">
        <div className={`w-11 h-11 rounded-xl bg-surface-200/40 border border-border/20 flex items-center justify-center ${decision.color}`}>
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
        <div className="mt-4 pt-4 border-t border-border/15 text-[11px] font-mono text-theme-muted flex items-center gap-2">
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
      <div className="text-[10px] font-label uppercase tracking-widest text-theme-subtle mb-1.5">{label}</div>
      {pre ? (
        <pre className={`text-xs whitespace-pre-wrap text-theme-primary font-body bg-surface-100/50 border border-border/20 rounded-md p-3 leading-relaxed ${mono ? 'font-mono' : ''}`}>
          {value}
        </pre>
      ) : (
        <span className={`text-xs text-theme-primary ${mono ? 'font-mono' : ''}`}>{value}</span>
      )}
    </div>
  );
}

// ── Page component ────────────────────────────────────────────────────

export default function InterventionsPage() {
  const { id } = useParams<{ id?: string }>();
  return id ? <InterventionDetailView /> : <InterventionsListView />;
}
