/**
 * InterventionsPage
 *
 * Dedicated page for the Human Intervention Protocol:
 *   - /interventions        — list view, sectioned into Pending + History
 *   - /interventions/:id    — detail view with action zone + full history
 *
 * Replaces the old inline human-input form on the execution page. Every
 * human pause in any workflow lands here — pending interventions are
 * actionable, answered ones stay visible as an audit trail.
 */

import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { interventions as interventionsApi } from '../services/api';
import { useToast } from '../components/common/Toast';
import {
  ArrowRight, Check, X, AlertTriangle, CheckCircle, HelpCircle,
  Clock, FileText, ExternalLink, RefreshCw, Search, Inbox,
  Archive, Send, Activity, ChevronLeft, User,
} from 'lucide-react';

// ── Types (envelope documented in backend §9.1) ────────────────────────

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

// ── Visual helpers ─────────────────────────────────────────────────────

function severityEmoji(severity: Intervention['severity']): string {
  switch (severity) {
    case 'question': return '🟡';
    case 'approval': return '🟢';
    case 'escalation': return '🔴';
  }
}

function severityLabel(severity: Intervention['severity']): string {
  switch (severity) {
    case 'question': return 'Question';
    case 'approval': return 'Approval';
    case 'escalation': return 'Escalation';
  }
}

function severityColorBase(severity: Intervention['severity']): {
  text: string;
  bg: string;
  border: string;
  strip: string;
} {
  switch (severity) {
    case 'question':
      return {
        text: 'text-accent-yellow',
        bg: 'bg-accent-yellow/10',
        border: 'border-accent-yellow/30',
        strip: 'bg-accent-yellow',
      };
    case 'approval':
      return {
        text: 'text-accent-green',
        bg: 'bg-accent-green/10',
        border: 'border-accent-green/30',
        strip: 'bg-accent-green',
      };
    case 'escalation':
      return {
        text: 'text-accent-red',
        bg: 'bg-accent-red/10',
        border: 'border-accent-red/30',
        strip: 'bg-accent-red',
      };
  }
}

function SeverityIcon({ severity, className = 'w-4 h-4' }: {
  severity: Intervention['severity'];
  className?: string;
}) {
  switch (severity) {
    case 'question': return <HelpCircle className={className} />;
    case 'approval': return <CheckCircle className={className} />;
    case 'escalation': return <AlertTriangle className={className} />;
  }
}

/**
 * Short relative time like "2 min ago", "3 hr ago", "5 days ago",
 * falls back to a locale date if older than a week.
 */
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
    case 'approve': return { label: 'Approved', color: 'text-accent-green' };
    case 'reject': return { label: 'Rejected', color: 'text-accent-red' };
    case 'request_changes': return { label: 'Changes requested', color: 'text-accent-yellow' };
    case 'answer': return { label: 'Answered', color: 'text-accent-blue' };
    default: return { label: d ?? 'unknown', color: 'text-theme-muted' };
  }
}

// ── Row component ──────────────────────────────────────────────────────

function InterventionRow({ item, emphasized }: { item: Intervention; emphasized: boolean }) {
  const colors = severityColorBase(item.severity);
  const decision = responseDecisionLabel(item.response?.decision);
  const isPending = item.status === 'pending';

  return (
    <Link
      to={`/interventions/${item.intervention_id}`}
      className={`group flex items-stretch gap-0 border-b border-border/10 last:border-b-0 transition-colors ${
        emphasized ? 'hover:bg-surface-200/30' : 'hover:bg-surface-200/15'
      }`}
    >
      {/* Left severity strip — vertical bar for quick visual scanning */}
      <div className={`w-1 shrink-0 ${colors.strip} ${isPending ? '' : 'opacity-30'}`} />

      <div className={`flex-1 flex items-start gap-4 px-4 py-3 min-w-0 ${emphasized ? '' : 'opacity-80'}`}>
        {/* Severity badge */}
        <div className={`shrink-0 w-9 h-9 rounded-lg ${colors.bg} border ${colors.border} flex items-center justify-center`}>
          <span className="text-lg leading-none">{severityEmoji(item.severity)}</span>
        </div>

        {/* Main content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={`text-[13px] font-body font-medium truncate ${
              emphasized ? 'text-theme-primary' : 'text-theme-secondary'
            }`}>
              {item.title}
            </span>
            {item.round_info && (
              <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded-full ${colors.bg} ${colors.text} shrink-0`}>
                {item.round_info.current}/{item.round_info.max}
              </span>
            )}
            <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded-full border shrink-0 ${colors.bg} ${colors.text} ${colors.border}`}>
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

        {/* Right-side action hint */}
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

// ── List view ──────────────────────────────────────────────────────────

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

  // Auto-refresh every 15s while we have pending interventions to catch
  // new ones without manual reload. Stops when there's nothing pending.
  const pendingCount = useMemo(
    () => items.filter(i => i.status === 'pending').length,
    [items],
  );
  const answeredCount = useMemo(
    () => items.filter(i => i.status === 'answered').length,
    [items],
  );

  useEffect(() => {
    if (pendingCount === 0) return;
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [pendingCount, statusFilter, severityFilter]);

  // Search across title, summary, workflow name, stage
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
      {/* Sticky header */}
      <div className="sticky top-0 z-10 bg-surface-50 border-b border-border/30">
        <div className="p-6 pb-4">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="font-heading text-xl font-bold text-theme-primary tracking-widest uppercase">
                Interventions
              </h1>
              <div className="flex items-center gap-3 mt-1 text-[10px] font-mono text-theme-muted">
                <span className="flex items-center gap-1">
                  <Clock className="w-3 h-3 text-accent-yellow" />
                  <span className="text-theme-primary font-semibold">{pendingCount}</span> pending
                </span>
                <span className="flex items-center gap-1">
                  <CheckCircle className="w-3 h-3 text-accent-green" />
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

          {/* Filters row */}
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-theme-subtle pointer-events-none" />
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search title, workflow, stage, user request..."
                className="input text-xs pl-8 pr-3 py-1.5 w-full"
              />
            </div>
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value as any)}
              className="input text-xs px-2 py-1.5"
            >
              <option value="all">All statuses</option>
              <option value="pending">Pending only</option>
              <option value="answered">Answered only</option>
            </select>
            <select
              value={severityFilter}
              onChange={e => setSeverityFilter(e.target.value as any)}
              className="input text-xs px-2 py-1.5"
            >
              <option value="all">Any severity</option>
              <option value="question">🟡 Question</option>
              <option value="approval">🟢 Approval</option>
              <option value="escalation">🔴 Escalation</option>
            </select>
          </div>
        </div>
      </div>

      {/* Body — scrollable list */}
      <div className="flex-1 overflow-y-auto">
        {loading && items.length === 0 && (
          <div className="flex items-center justify-center py-16 text-xs text-theme-muted">
            <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
            Loading interventions...
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <EmptyState hasFilters={statusFilter !== 'all' || severityFilter !== 'all' || search.trim() !== ''} />
        )}

        {filtered.length > 0 && (
          <div className="pb-8">
            {/* Pending section — emphasized */}
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

            {/* History section — muted */}
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
            When a workflow pauses and needs human input — a clarification question, a plan approval,
            or an escalation — it'll show up here. Try running <span className="font-mono text-theme-primary">test-human-intervention</span> to
            see the different severity types.
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
  const [decision, setDecision] = useState<'approve' | 'request_changes' | 'reject' | 'answer' | null>(null);
  const [feedback, setFeedback] = useState('');
  const [scope, setScope] = useState<'requirements' | 'architecture' | 'technical_design' | 'all'>('requirements');
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  async function load() {
    if (!id) return;
    setLoading(true);
    try {
      const data = await interventionsApi.get(id);
      setItem(data);
      // Seed field values from the intervention's declared fields —
      // selects default to the first option, text fields to empty.
      if (data?.fields && data.fields.length > 0) {
        const initial: Record<string, string> = {};
        for (const f of data.fields as InterventionField[]) {
          if (f.type === 'select' && f.options && f.options.length > 0) {
            initial[f.name] = f.options[0];
          } else {
            initial[f.name] = '';
          }
        }
        setFieldValues(initial);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [id]);

  async function submit() {
    if (!item || !decision) return;
    setSubmitting(true);
    try {
      await interventionsApi.respond(item.intervention_id, {
        decision,
        feedback: decision === 'request_changes' ? feedback : undefined,
        scope: decision === 'request_changes' && item.stage === 'plan_approval_gate' ? scope : undefined,
        field_values: decision === 'answer' || decision === 'approve' ? fieldValues : undefined,
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

  // Check that all required fields have values (for submit button enable)
  function requiredFieldsFilled(): boolean {
    if (!item?.fields || item.fields.length === 0) return true;
    for (const f of item.fields) {
      if (f.required !== false && !fieldValues[f.name]?.trim()) return false;
    }
    return true;
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-theme-muted">
        <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
        Loading intervention...
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

  const colors = severityColorBase(item.severity);
  const isPending = item.status === 'pending';
  const isPlanApproval = item.stage === 'plan_approval_gate';

  return (
    <div className="max-w-4xl mx-auto p-6">
      {/* Breadcrumb */}
      <div className="mb-4 flex items-center gap-2 text-[11px] font-mono text-theme-muted">
        <Link to="/interventions" className="flex items-center gap-1 hover:text-theme-primary transition-colors">
          <ChevronLeft className="w-3 h-3" /> Interventions
        </Link>
        <span>/</span>
        <span className="text-theme-primary">{item.intervention_id}</span>
      </div>

      {/* Hero card */}
      <div className={`relative border ${colors.border} ${colors.bg} rounded-xl p-6 mb-6 overflow-hidden`}>
        {/* Left severity strip */}
        <div className={`absolute left-0 top-0 bottom-0 w-1.5 ${colors.strip}`} />

        <div className="flex items-start gap-4 pl-2">
          <div className={`w-14 h-14 rounded-xl ${colors.bg} border ${colors.border} flex items-center justify-center shrink-0`}>
            <span className="text-3xl leading-none">{severityEmoji(item.severity)}</span>
          </div>
          <div className="flex-1 min-w-0">
            <div className={`flex items-center gap-2 text-[10px] font-mono uppercase tracking-widest ${colors.text} mb-1`}>
              <SeverityIcon severity={item.severity} className="w-3 h-3" />
              {severityLabel(item.severity)}
              <span className="text-theme-subtle">·</span>
              <span className="text-theme-muted">{humaniseStage(item.stage)}</span>
              {item.round_info && (
                <>
                  <span className="text-theme-subtle">·</span>
                  <span className="text-theme-muted">round {item.round_info.current}/{item.round_info.max}</span>
                </>
              )}
            </div>
            <h1 className="text-xl font-heading font-bold text-theme-primary mb-2">{item.title}</h1>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-mono text-theme-muted">
              <Link
                to={`/executions/${item.workflow_run_id}`}
                className="flex items-center gap-1 hover:text-accent-blue transition-colors"
              >
                <Activity className="w-3 h-3" />
                {item.workflow_name}
              </Link>
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" /> Created {relativeTime(item.created_at)}
              </span>
              <span className="text-theme-subtle">{item.intervention_id}</span>
            </div>
          </div>
        </div>

        {item.user_request && (
          <div className="mt-4 pl-2 pt-4 border-t border-current/10">
            <div className="text-[10px] font-label uppercase tracking-widest text-theme-muted mb-1">
              Original Request
            </div>
            <p className="text-sm italic text-theme-primary font-body">"{item.user_request}"</p>
          </div>
        )}
      </div>

      {/* Summary */}
      <Section label="Summary">
        <p className="text-sm text-theme-primary font-body leading-relaxed">{item.context_summary}</p>
      </Section>

      {/* Question */}
      <Section label="Question">
        <div className="bg-surface-100 border border-border/30 rounded-lg p-4">
          <pre className="text-xs text-theme-primary font-body whitespace-pre-wrap leading-relaxed">
            {item.question}
          </pre>
        </div>
      </Section>

      {/* Docs */}
      {item.docs.length > 0 && (
        <Section label={`Linked Docs (${item.docs.length})`}>
          <div className="flex flex-wrap gap-2">
            {item.docs.map((d, i) => (
              <a
                key={i}
                href={d.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono bg-surface-200/30 text-accent-blue hover:bg-accent-blue/10 border border-border/30 hover:border-accent-blue/40 transition-colors"
              >
                <FileText className="w-3 h-3" />
                {d.label}
                <ExternalLink className="w-3 h-3 opacity-60" />
              </a>
            ))}
          </div>
        </Section>
      )}

      {/* Action zone (when pending) */}
      {isPending && (
        <Section label="Action Required" emphasis>
          <div className="border border-border/30 rounded-lg p-5 bg-surface-100">
            {/* Dynamic field rendering — if the intervention carries the
                original human node's fields, render them BEFORE the
                action buttons. The field values are what the engine's
                submitInput needs to unblock the pause. */}
            {item.fields && item.fields.length > 0 && (
              <div className="mb-5 space-y-4">
                {item.fields.map(f => (
                  <FieldInput
                    key={f.name}
                    field={f}
                    value={fieldValues[f.name] ?? ''}
                    onChange={v => setFieldValues(prev => ({ ...prev, [f.name]: v }))}
                  />
                ))}
              </div>
            )}

            <div className="flex flex-wrap gap-2 mb-5">
              {item.severity === 'approval' && (
                <>
                  <ActionBtn label="Approve" icon={<Check className="w-3 h-3" />} color="green" active={decision === 'approve'} onClick={() => setDecision('approve')} />
                  <ActionBtn label="Request changes" icon={<RefreshCw className="w-3 h-3" />} color="yellow" active={decision === 'request_changes'} onClick={() => setDecision('request_changes')} />
                  <ActionBtn label="Reject" icon={<X className="w-3 h-3" />} color="red" active={decision === 'reject'} onClick={() => setDecision('reject')} />
                </>
              )}
              {item.severity === 'question' && (
                <>
                  <ActionBtn label="Submit" icon={<Send className="w-3 h-3" />} color="blue" active={decision === 'answer'} onClick={() => setDecision('answer')} />
                  <ActionBtn label="Reject" icon={<X className="w-3 h-3" />} color="red" active={decision === 'reject'} onClick={() => setDecision('reject')} />
                </>
              )}
              {item.severity === 'escalation' && (
                <>
                  <ActionBtn label="Approve (accept deviations)" icon={<Check className="w-3 h-3" />} color="green" active={decision === 'approve'} onClick={() => setDecision('approve')} />
                  <ActionBtn label="Request changes" icon={<RefreshCw className="w-3 h-3" />} color="yellow" active={decision === 'request_changes'} onClick={() => setDecision('request_changes')} />
                  <ActionBtn label="Reject (abandon)" icon={<X className="w-3 h-3" />} color="red" active={decision === 'reject'} onClick={() => setDecision('reject')} />
                </>
              )}
            </div>

            {decision === 'request_changes' && (
              <>
                {isPlanApproval && (
                  <div className="mb-4">
                    <label className="block text-[10px] font-label uppercase tracking-widest text-theme-subtle mb-1.5">
                      Which section needs changes?
                    </label>
                    <select
                      value={scope}
                      onChange={e => setScope(e.target.value as any)}
                      className="input text-xs w-full"
                    >
                      <option value="requirements">Requirements (PRD) — also re-runs HLA + TDD</option>
                      <option value="architecture">Architecture (HLA) — also re-runs TDD</option>
                      <option value="technical_design">Technical Design (TDD) only</option>
                      <option value="all">All three — start from PRD</option>
                    </select>
                  </div>
                )}
                <div className="mb-4">
                  <label className="block text-[10px] font-label uppercase tracking-widest text-theme-subtle mb-1.5">
                    Feedback for the agent
                  </label>
                  <textarea
                    value={feedback}
                    onChange={e => setFeedback(e.target.value)}
                    rows={6}
                    className="input text-xs w-full font-body leading-relaxed"
                    placeholder="Be specific — the agent gets this verbatim as its retry feedback."
                    autoFocus
                  />
                </div>
              </>
            )}

            <div className="flex items-center justify-between pt-2 border-t border-border/20">
              <span className="text-[10px] font-mono text-theme-subtle">
                {decision ? `Submitting: ${decision}` : 'Pick an action above'}
              </span>
              <button
                onClick={submit}
                disabled={
                  !decision
                  || submitting
                  || (decision === 'request_changes' && !feedback.trim())
                  || ((decision === 'answer' || decision === 'approve') && !requiredFieldsFilled())
                }
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-mono bg-accent-blue/10 text-accent-blue hover:bg-accent-blue/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {submitting ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                Submit response
              </button>
            </div>
          </div>
        </Section>
      )}

      {/* Answered record (when not pending) */}
      {!isPending && item.response && (
        <Section label="Response">
          <AnsweredBlock item={item} />
        </Section>
      )}
    </div>
  );
}

function Section({
  label, children, emphasis = false,
}: {
  label: string;
  children: React.ReactNode;
  emphasis?: boolean;
}) {
  return (
    <div className="mb-6">
      <div className={`text-[10px] font-label uppercase tracking-widest mb-2 ${
        emphasis ? 'text-accent-blue' : 'text-theme-subtle'
      }`}>
        {label}
      </div>
      {children}
    </div>
  );
}

/**
 * Dynamic field renderer — reads the intervention's stored fields
 * (captured from the original human node's `fields` config at create
 * time) and renders the matching input type. Values flow back via the
 * `field_values` object that's sent to the respond endpoint, where the
 * keys match the workflow YAML's declared field names exactly.
 */
function FieldInput({
  field, value, onChange,
}: {
  field: InterventionField;
  value: string;
  onChange: (v: string) => void;
}) {
  const label = field.label ?? field.name;
  const required = field.required !== false;

  if (field.type === 'select' && field.options && field.options.length > 0) {
    return (
      <div>
        <label className="block text-[10px] font-label uppercase tracking-widest text-theme-subtle mb-1.5">
          {label}{required && <span className="text-accent-red ml-1">*</span>}
        </label>
        <select
          value={value}
          onChange={e => onChange(e.target.value)}
          className="input text-xs w-full"
        >
          {field.options.map(opt => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      </div>
    );
  }

  if (field.type === 'textarea') {
    return (
      <div>
        <label className="block text-[10px] font-label uppercase tracking-widest text-theme-subtle mb-1.5">
          {label}{required && <span className="text-accent-red ml-1">*</span>}
        </label>
        <textarea
          value={value}
          onChange={e => onChange(e.target.value)}
          rows={5}
          className="input text-xs w-full font-body leading-relaxed"
          placeholder={field.placeholder ?? ''}
          autoFocus
        />
      </div>
    );
  }

  // Default to single-line text input
  return (
    <div>
      <label className="block text-[10px] font-label uppercase tracking-widest text-theme-subtle mb-1.5">
        {label}{required && <span className="text-accent-red ml-1">*</span>}
      </label>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        className="input text-xs w-full font-body"
        placeholder={field.placeholder ?? ''}
        autoFocus
      />
    </div>
  );
}

function ActionBtn({
  label, icon, color, active, onClick,
}: {
  label: string;
  icon: React.ReactNode;
  color: 'green' | 'yellow' | 'red' | 'blue';
  active: boolean;
  onClick: () => void;
}) {
  const colorMap = {
    green: { base: 'bg-accent-green/10 text-accent-green hover:bg-accent-green/20', ring: 'ring-accent-green/60' },
    yellow: { base: 'bg-accent-yellow/10 text-accent-yellow hover:bg-accent-yellow/20', ring: 'ring-accent-yellow/60' },
    red: { base: 'bg-accent-red/10 text-accent-red hover:bg-accent-red/20', ring: 'ring-accent-red/60' },
    blue: { base: 'bg-accent-blue/10 text-accent-blue hover:bg-accent-blue/20', ring: 'ring-accent-blue/60' },
  };
  const c = colorMap[color];
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full text-[11px] font-mono transition-all ${c.base} ${
        active ? `ring-2 ring-offset-2 ring-offset-surface-100 ${c.ring}` : ''
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function AnsweredBlock({ item }: { item: Intervention }) {
  const decision = responseDecisionLabel(item.response?.decision);
  return (
    <div className="border border-border/30 rounded-lg p-5 bg-surface-100">
      <div className="flex items-center gap-3 mb-4 pb-3 border-b border-border/20">
        <div className={`w-10 h-10 rounded-full bg-surface-200/40 flex items-center justify-center ${decision.color}`}>
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
        <div className="mt-3 pt-3 border-t border-border/20 text-[10px] font-mono text-theme-muted">
          <RefreshCw className="w-3 h-3 inline mr-1.5" />
          Retry triggered: <span className="text-accent-blue">{item.retry_triggered.target_node}</span>
          {' '}(attempt {item.retry_triggered.retry_attempt}, source: {item.retry_triggered.retry_source})
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
    <div className="mb-3 last:mb-0">
      <div className="text-[10px] font-label uppercase tracking-widest text-theme-subtle mb-1">{label}</div>
      {pre ? (
        <pre className={`text-xs whitespace-pre-wrap text-theme-primary font-body bg-surface-200/30 border border-border/20 rounded p-3 ${mono ? 'font-mono' : ''}`}>
          {value}
        </pre>
      ) : (
        <span className={`text-xs text-theme-primary ${mono ? 'font-mono' : ''}`}>{value}</span>
      )}
    </div>
  );
}

// ── Page component — routes between list and detail ───────────────────

export default function InterventionsPage() {
  const { id } = useParams<{ id?: string }>();
  return id ? <InterventionDetailView /> : <InterventionsListView />;
}
