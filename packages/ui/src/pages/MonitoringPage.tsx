import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle, ExternalLink, Loader2, Play, RefreshCw, ShieldAlert, Ticket, Wrench } from 'lucide-react';
import { monitoring as monitoringApi } from '../services/api';
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
  firstSeenAt: string;
  lastSeenAt: string;
  occurrenceCount: number;
  linearIssueId?: string | null;
  linearIdentifier?: string | null;
  linearUrl?: string | null;
  dispatchExecutionId?: string | null;
  routingTarget?: any;
  relatedIds?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
}

const severityClass: Record<string, string> = {
  critical: 'bg-accent-red/20 text-accent-red border-accent-red/40',
  high: 'bg-accent-orange/20 text-accent-orange border-accent-orange/40',
  medium: 'bg-accent-yellow/20 text-accent-yellow border-accent-yellow/40',
  low: 'bg-accent-blue/15 text-accent-blue border-accent-blue/30',
};

const statusClass: Record<string, string> = {
  ticketed: 'bg-accent-blue/15 text-accent-blue border-accent-blue/30',
  updated_existing: 'bg-accent-blue/15 text-accent-blue border-accent-blue/30',
  dispatched: 'bg-accent-green/15 text-accent-green border-accent-green/30',
  resolved: 'bg-accent-green/15 text-accent-green border-accent-green/30',
  ignored: 'bg-app-muted text-theme-muted border-app',
  suppressed: 'bg-app-muted text-theme-muted border-app',
  failed_to_ticket: 'bg-accent-red/15 text-accent-red border-accent-red/30',
  failed_to_dispatch: 'bg-accent-red/15 text-accent-red border-accent-red/30',
};

function relative(dateIso?: string): string {
  if (!dateIso) return '-';
  const diff = (Date.now() - new Date(dateIso).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(dateIso).toLocaleDateString();
}

function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[10px] font-mono uppercase ${className ?? 'bg-app-muted text-theme-muted border-app'}`}>
      {children}
    </span>
  );
}

export default function MonitoringPage() {
  const toast = useToast();
  const [incidents, setIncidents] = useState<MonitoringIncident[]>([]);
  const [selected, setSelected] = useState<MonitoringIncident | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await monitoringApi.incidents({ status: statusFilter || undefined, limit: 100 });
      setIncidents(res.incidents ?? []);
      setSelected((prev) => {
        if (!prev) return (res.incidents ?? [])[0] ?? null;
        return (res.incidents ?? []).find((i: MonitoringIncident) => i.fingerprint === prev.fingerprint) ?? (res.incidents ?? [])[0] ?? null;
      });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, toast]);

  useEffect(() => { load(); }, [load]);

  const stats = useMemo(() => {
    const byStatus = new Map<string, number>();
    for (const incident of incidents) byStatus.set(incident.status, (byStatus.get(incident.status) ?? 0) + 1);
    return {
      total: incidents.length,
      open: incidents.filter(i => !['resolved', 'ignored', 'suppressed'].includes(i.status)).length,
      dispatched: byStatus.get('dispatched') ?? 0,
      failed: incidents.filter(i => i.status.startsWith('failed')).length,
    };
  }, [incidents]);

  async function runAction(action: 'scan' | 'ticket' | 'dispatch' | 'ignored' | 'suppressed' | 'resolved', incident?: MonitoringIncident) {
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

  return (
    <div className="h-full flex flex-col bg-app">
      <div className="border-b border-app px-6 py-4 bg-app-card/60">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-5 h-5 text-accent-blue" />
              <h1 className="text-lg font-semibold text-theme-primary">Self-Healing Monitor</h1>
            </div>
            <p className="text-xs text-theme-muted mt-1">
              Hourly scan of Allen chats, agents, workflows, logs, traces, memory, tool calls, and dispatch records.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="input text-xs h-8"
            >
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
            <button className="btn-ghost text-xs" onClick={load} disabled={loading}>
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            <button className="btn-primary text-xs" onClick={() => runAction('scan')} disabled={!!busy}>
              {busy === 'scan:global' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
              Run scan
            </button>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-3 mt-4">
          <div className="panel px-3 py-2"><div className="text-[10px] overline">Total</div><div className="text-xl font-semibold">{stats.total}</div></div>
          <div className="panel px-3 py-2"><div className="text-[10px] overline">Open</div><div className="text-xl font-semibold">{stats.open}</div></div>
          <div className="panel px-3 py-2"><div className="text-[10px] overline">Dispatched</div><div className="text-xl font-semibold">{stats.dispatched}</div></div>
          <div className="panel px-3 py-2"><div className="text-[10px] overline">Failed</div><div className="text-xl font-semibold">{stats.failed}</div></div>
        </div>
      </div>

      <div className="flex-1 grid grid-cols-[minmax(420px,0.9fr)_minmax(420px,1.1fr)] min-h-0">
        <div className="border-r border-app overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-16 text-theme-muted">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          )}
          {!loading && incidents.length === 0 && (
            <div className="text-center py-16 text-theme-muted">
              <CheckCircle className="w-8 h-8 mx-auto mb-2 text-accent-green" />
              <div className="text-sm">No monitoring incidents</div>
            </div>
          )}
          {incidents.map((incident) => (
            <button
              key={incident.fingerprint}
              onClick={() => setSelected(incident)}
              className={`w-full text-left border-b border-app px-4 py-3 hover:bg-app-card transition-colors ${selected?.fingerprint === incident.fingerprint ? 'bg-app-card' : ''}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-theme-primary truncate">{incident.title}</div>
                  <div className="text-xs text-theme-muted mt-1 line-clamp-2">{incident.summary}</div>
                </div>
                <Badge className={severityClass[incident.severity]}>{incident.severity}</Badge>
              </div>
              <div className="flex items-center gap-2 mt-2">
                <Badge>{incident.sourceType}</Badge>
                <Badge>{incident.rootCauseArea}</Badge>
                <Badge className={statusClass[incident.status]}>{incident.status}</Badge>
                <span className="text-[11px] text-theme-subtle ml-auto">{relative(incident.lastSeenAt)}</span>
              </div>
            </button>
          ))}
        </div>

        <div className="overflow-y-auto">
          {!selected ? (
            <div className="h-full flex items-center justify-center text-theme-muted">
              <AlertTriangle className="w-5 h-5 mr-2" />
              Select an incident
            </div>
          ) : (
            <div className="p-6 space-y-5">
              <div>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-base font-semibold text-theme-primary">{selected.title}</h2>
                    <p className="text-sm text-theme-muted mt-1">{selected.summary}</p>
                  </div>
                  <Badge className={statusClass[selected.status]}>{selected.status}</Badge>
                </div>
                <div className="flex flex-wrap gap-2 mt-3">
                  <Badge className={severityClass[selected.severity]}>{selected.severity}</Badge>
                  <Badge>{selected.sourceType}</Badge>
                  <Badge>{selected.rootCauseArea}</Badge>
                  <Badge>{Math.round((selected.confidence ?? 0) * 100)}% confidence</Badge>
                  <Badge>{selected.occurrenceCount} occurrence{selected.occurrenceCount === 1 ? '' : 's'}</Badge>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                {selected.linearUrl && (
                  <a href={selected.linearUrl} target="_blank" rel="noreferrer" className="btn-ghost text-xs">
                    <ExternalLink className="w-3.5 h-3.5" />
                    {selected.linearIdentifier ?? 'Linear'}
                  </a>
                )}
                {selected.dispatchExecutionId && (
                  <Link to={`/executions/${selected.dispatchExecutionId}`} className="btn-ghost text-xs">
                    <Wrench className="w-3.5 h-3.5" />
                    Repair execution
                  </Link>
                )}
                {!selected.linearIssueId && (
                  <button className="btn-ghost text-xs" onClick={() => runAction('ticket', selected)} disabled={!!busy}>
                    <Ticket className="w-3.5 h-3.5" />
                    Ask agent to ticket
                  </button>
                )}
                <button className="btn-ghost text-xs" onClick={() => runAction('dispatch', selected)} disabled={!!busy}>
                  <Play className="w-3.5 h-3.5" />
                  Ask agent to dispatch
                </button>
                <button className="btn-ghost text-xs" onClick={() => runAction('resolved', selected)} disabled={!!busy}>Resolve</button>
                <button className="btn-ghost text-xs" onClick={() => runAction('suppressed', selected)} disabled={!!busy}>Suppress</button>
                <button className="btn-ghost text-xs" onClick={() => runAction('ignored', selected)} disabled={!!busy}>Ignore</button>
              </div>

              <section className="panel p-4">
                <h3 className="text-sm font-semibold text-theme-primary mb-2">Timeline</h3>
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div><span className="text-theme-muted">First seen</span><div className="font-mono">{new Date(selected.firstSeenAt).toLocaleString()}</div></div>
                  <div><span className="text-theme-muted">Last seen</span><div className="font-mono">{new Date(selected.lastSeenAt).toLocaleString()}</div></div>
                  <div><span className="text-theme-muted">Fingerprint</span><div className="font-mono break-all">{selected.fingerprint}</div></div>
                  <div><span className="text-theme-muted">Route</span><div className="font-mono">{selected.routingTarget?.workflowName ?? selected.routingTarget?.agentName ?? '-'}</div></div>
                </div>
              </section>

              <section className="panel p-4">
                <h3 className="text-sm font-semibold text-theme-primary mb-2">Related IDs</h3>
                <pre className="text-xs font-mono whitespace-pre-wrap overflow-x-auto text-theme-secondary">{JSON.stringify(selected.relatedIds ?? {}, null, 2)}</pre>
              </section>

              <section className="panel p-4">
                <h3 className="text-sm font-semibold text-theme-primary mb-2">Evidence</h3>
                <pre className="text-xs font-mono whitespace-pre-wrap overflow-x-auto text-theme-secondary">{JSON.stringify(selected.evidence ?? {}, null, 2)}</pre>
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
