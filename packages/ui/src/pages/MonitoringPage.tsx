import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Check,
  CheckCircle,
  Clock,
  DollarSign,
  ExternalLink,
  Loader2,
  Play,
  RefreshCw,
  ShieldAlert,
  Ticket,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import StatusBadge from '../components/common/StatusBadge';
import { executions as executionsApi, monitoring as monitoringApi } from '../services/api';
import { useToast } from '../components/common/Toast';

interface MonitoringIncident {
  _id: string;
  fingerprint: string;
  sourceType: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  status: string;
  rootCauseArea: string;
  confidence: number;
  title: string;
  summary: string;
  lastSeenAt: string;
  linearIdentifier?: string | null;
  linearUrl?: string | null;
  dispatchExecutionId?: string | null;
}

type AnalyticsTab = 'overview' | 'workflows' | 'agents' | 'cost' | 'monitor';

function shortDuration(ms: number | null | undefined): string {
  if (ms == null) return '-';
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  return `${min}m ${Math.floor(sec % 60)}s`;
}

function relative(dateIso?: string): string {
  if (!dateIso) return '-';
  const diff = (Date.now() - new Date(dateIso).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(dateIso).toLocaleDateString();
}

function executionCost(exec: any): number {
  const cost = exec?.cost;
  if (typeof cost === 'number') return cost;
  return Number(cost?.actual ?? cost?.estimated ?? 0) || 0;
}

function workflowName(exec: any): string {
  return exec?.workflowName ?? exec?.workflowId ?? exec?.type ?? 'unknown';
}

function KpiCard({
  icon: Icon,
  label,
  value,
  tone = 'muted',
}: {
  icon: typeof Play;
  label: string;
  value: string | number;
  tone?: 'muted' | 'info' | 'ok' | 'warn' | 'err';
}) {
  return (
    <div className="an-kpi">
      <span className={`an-kpi-ic ${tone}`}><Icon className="h-3.5 w-3.5" /></span>
      <div className="an-kpi-v">{value}</div>
      <div className="an-kpi-l">{label}</div>
    </div>
  );
}

function MetricList({
  title,
  rows,
  value,
}: {
  title: string;
  rows: Array<{ name: string; metric: number; runs: number; label: string }>;
  value: 'duration' | 'cost';
}) {
  const max = Math.max(...rows.map(row => row.metric), 1);
  return (
    <section className="an-section an-card">
      <header className="an-h">
        <h3>{value === 'cost' ? <Zap className="h-3 w-3" /> : <Clock className="h-3 w-3" />} {title}</h3>
      </header>
      <div className="an-metric-list">
        {rows.length === 0 ? (
          <div className="an-empty">no data yet.</div>
        ) : rows.map((row, index) => (
          <div key={row.name} className="an-metric-row">
            <span className="an-rank">{index + 1}</span>
            <span className="an-metric-name mono">{row.name}</span>
            <span className="an-meter"><i style={{ width: `${Math.max(4, (row.metric / max) * 100)}%` }} /></span>
            <span className="an-metric-value mono">{row.label}</span>
            <span className="an-metric-runs mono">{row.runs} runs</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function MonitoringPage() {
  const toast = useToast();
  const [executions, setExecutions] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [incidents, setIncidents] = useState<MonitoringIncident[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [tab, setTab] = useState<AnalyticsTab>('overview');
  const [range, setRange] = useState('24h');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [execRes, incidentRes] = await Promise.all([
        executionsApi.listPaged({ limit: 100, offset: 0, includeTotal: true }),
        monitoringApi.incidents({ status: statusFilter || undefined, limit: 100 }).catch(() => ({ incidents: [] })),
      ]);
      setExecutions(execRes.items ?? []);
      setTotal(execRes.total ?? 0);
      setIncidents(incidentRes.incidents ?? []);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, toast]);

  useEffect(() => { void load(); }, [load]);

  const analytics = useMemo(() => {
    const completed = executions.filter(e => e.status === 'completed').length;
    const failed = executions.filter(e => e.status === 'failed').length;
    const running = executions.filter(e => ['running', 'queued', 'waiting_for_input'].includes(e.status)).length;
    const totalCost = executions.reduce((sum, exec) => sum + executionCost(exec), 0);

    const byWorkflow = new Map<string, { cost: number; duration: number; durationCount: number; runs: number }>();
    for (const exec of executions) {
      const key = workflowName(exec);
      const current = byWorkflow.get(key) ?? { cost: 0, duration: 0, durationCount: 0, runs: 0 };
      current.cost += executionCost(exec);
      if (typeof exec.durationMs === 'number') {
        current.duration += exec.durationMs;
        current.durationCount += 1;
      }
      current.runs += 1;
      byWorkflow.set(key, current);
    }

    const durationRows = [...byWorkflow.entries()]
      .map(([name, row]) => ({
        name,
        metric: row.durationCount ? row.duration / row.durationCount : 0,
        runs: row.runs,
        label: shortDuration(row.durationCount ? row.duration / row.durationCount : null),
      }))
      .sort((a, b) => b.metric - a.metric)
      .slice(0, 6);

    const costRows = [...byWorkflow.entries()]
      .map(([name, row]) => ({
        name,
        metric: row.cost,
        runs: row.runs,
        label: `$${row.cost.toFixed(2)}`,
      }))
      .sort((a, b) => b.metric - a.metric)
      .slice(0, 6);

    return { completed, failed, running, totalCost, durationRows, costRows };
  }, [executions]);

  async function runMonitorAction(action: 'scan' | 'ticket' | 'dispatch' | 'ignored' | 'suppressed' | 'resolved', incident?: MonitoringIncident) {
    const key = `${action}:${incident?.fingerprint ?? 'global'}`;
    setBusy(key);
    try {
      if (action === 'scan') {
        const result = await monitoringApi.scan({});
        toast.success(`Agent-led monitoring workflow started: ${result.executionId ?? 'pending'}`);
      } else if (incident) {
        if (action === 'ticket') await monitoringApi.ticket(incident.fingerprint);
        else if (action === 'dispatch') await monitoringApi.dispatch(incident.fingerprint);
        else await monitoringApi.mark(incident.fingerprint, action);
        toast.success('Incident updated');
      }
      await load();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const monitorOpen = incidents.filter(i => !['resolved', 'ignored', 'suppressed'].includes(i.status)).length;
  const monitorFailed = incidents.filter(i => i.status.startsWith('failed')).length;

  return (
    <div className="content scroll-hide analytics-page" data-screen-label="analytics">
      <div className="page-head">
        <div className="ph-row">
          <div>
            <h1>analytics</h1>
            <p className="sub">cost, runtime, and run health across the org</p>
          </div>
          <div className="row gap-2">
            <select className="lrn-select min-w-[140px]" value={range} onChange={e => setRange(e.target.value)}>
              <option value="24h">Last 24 hours</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
            </select>
            <button className="btn btn-secondary btn-sm" onClick={load} disabled={loading} title="Refresh analytics">
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
        <nav className="topfilter-tabs mt-3">
          {[
            ['overview', 'overview'],
            ['workflows', 'workflows'],
            ['agents', 'agents'],
            ['cost', 'cost'],
            ['monitor', 'monitor'],
          ].map(([key, label]) => (
            <button key={key} type="button" className={`tft ${tab === key ? 'active' : ''}`} onClick={() => setTab(key as AnalyticsTab)}>
              {label}
            </button>
          ))}
        </nav>
      </div>

      {tab !== 'monitor' ? (
        <div className="an-dashboard">
          <div className="an-kpis">
            <KpiCard icon={Play} label="total executions" value={total.toLocaleString()} />
            <KpiCard icon={Loader2} label="running" value={analytics.running} tone="info" />
            <KpiCard icon={Check} label="completed" value={analytics.completed} tone="ok" />
            <KpiCard icon={X} label="failed" value={analytics.failed} tone="err" />
            <KpiCard icon={DollarSign} label="total cost (est.)" value={`$${analytics.totalCost.toFixed(2)}`} tone="warn" />
          </div>

          <div className="an-body">
            {(tab === 'overview' || tab === 'workflows' || tab === 'agents') && (
              <MetricList title="avg duration by workflow" rows={analytics.durationRows} value="duration" />
            )}
            {(tab === 'overview' || tab === 'cost') && (
              <MetricList title="cost by workflow" rows={analytics.costRows} value="cost" />
            )}
            <section className="an-section an-card">
              <header className="an-h">
                <h3><Play className="h-3 w-3" /> recent executions</h3>
                <span className="an-h-ct">{total} total</span>
              </header>
              <div className="an-runlist">
                {executions.slice(0, 10).map((exec: any) => (
                  <Link key={exec.id ?? exec._id} className="an-run" to={`/executions/${exec.id}`}>
                    <span className="mono an-run-id">{exec.id?.slice(0, 8) ?? 'N/A'}</span>
                    <span className="an-run-wf">{workflowName(exec)}</span>
                    <StatusBadge status={exec.status} />
                    <span className="mono">{shortDuration(exec.durationMs)}</span>
                  </Link>
                ))}
                {!loading && executions.length === 0 && <div className="an-empty">no executions yet.</div>}
              </div>
            </section>
          </div>
        </div>
      ) : (
        <div className="monitor-panel">
          <div className="monitor-head">
            <div>
              <div className="row gap-2">
                <ShieldAlert className="h-5 w-5 text-accent" />
                <h2>self-healing monitor</h2>
              </div>
              <p className="sub">hourly scan of chats, agents, workflows, logs, traces, memory, tool calls, and dispatch records</p>
            </div>
            <div className="row gap-2">
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="lrn-select min-w-[150px]">
                <option value="">All statuses</option>
                <option value="ticketed">Ticketed</option>
                <option value="updated_existing">Updated existing</option>
                <option value="dispatched">Dispatched</option>
                <option value="failed_to_ticket">Ticket failed</option>
                <option value="failed_to_dispatch">Dispatch failed</option>
                <option value="ignored">Ignored</option>
                <option value="suppressed">Suppressed</option>
                <option value="resolved">Resolved</option>
              </select>
              <button className="btn btn-secondary btn-sm" onClick={load} disabled={loading}>
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                refresh
              </button>
              <button className="btn btn-primary btn-sm" onClick={() => runMonitorAction('scan')} disabled={!!busy}>
                {busy === 'scan:global' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                run scan
              </button>
            </div>
          </div>

          <div className="monitor-stats">
            <KpiCard icon={ShieldAlert} label="total" value={incidents.length} />
            <KpiCard icon={AlertTriangle} label="open" value={monitorOpen} tone="warn" />
            <KpiCard icon={Wrench} label="dispatched" value={incidents.filter(i => i.status === 'dispatched').length} tone="info" />
            <KpiCard icon={X} label="failed" value={monitorFailed} tone="err" />
          </div>

          <div className="monitor-list">
            {loading && incidents.length === 0 && <div className="an-empty">loading incidents...</div>}
            {!loading && incidents.length === 0 && (
              <div className="an-empty">
                <CheckCircle className="mx-auto mb-2 h-8 w-8 text-accent-green" />
                no monitoring incidents.
              </div>
            )}
            {incidents.map((incident) => (
              <div key={incident.fingerprint} className="monitor-row">
                <div className="min-w-0">
                  <div className="monitor-title">{incident.title}</div>
                  <div className="monitor-sub">{incident.summary}</div>
                  <div className="monitor-tags">
                    <span className={`pill pill-${incident.severity === 'critical' || incident.severity === 'high' ? 'failed' : incident.severity === 'medium' ? 'warn' : 'queued'}`}>{incident.severity}</span>
                    <span className="pill">{incident.sourceType}</span>
                    <span className="pill">{incident.rootCauseArea}</span>
                    <span className="pill">{incident.status}</span>
                    <span className="muted mono">{relative(incident.lastSeenAt)}</span>
                  </div>
                </div>
                <div className="monitor-actions">
                  {incident.linearUrl && (
                    <a href={incident.linearUrl} target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm">
                      <ExternalLink className="h-3.5 w-3.5" />
                      {incident.linearIdentifier ?? 'linear'}
                    </a>
                  )}
                  {incident.dispatchExecutionId && (
                    <Link to={`/executions/${incident.dispatchExecutionId}`} className="btn btn-secondary btn-sm">
                      <Wrench className="h-3.5 w-3.5" />
                      bug-fix execution
                    </Link>
                  )}
                  {!incident.linearUrl && (
                    <button className="btn btn-secondary btn-sm" onClick={() => runMonitorAction('ticket', incident)} disabled={!!busy}>
                      <Ticket className="h-3.5 w-3.5" />
                      ticket
                    </button>
                  )}
                  <button className="btn btn-secondary btn-sm" onClick={() => runMonitorAction('dispatch', incident)} disabled={!!busy}>
                    <Play className="h-3.5 w-3.5" />
                    dispatch
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
