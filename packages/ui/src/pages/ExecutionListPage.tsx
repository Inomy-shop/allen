import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Play, RefreshCw, RotateCcw, Download, ChevronUp, ChevronDown,
  Search, ChevronLeft, ChevronRight,
} from 'lucide-react';
import { executions as api } from '../services/api';
import StatusBadge from '../components/common/StatusBadge';
import CostDisplay from '../components/common/CostDisplay';
import { TableSkeleton } from '../components/common/Skeleton';

type SortKey = 'status' | 'workflowName' | 'durationMs' | 'startedAt';
type SortDir = 'asc' | 'desc';
type TypeFilter = '' | 'agent' | 'workflow';

const PAGE_SIZE = 50;

export default function ExecutionListPage() {
  const [data, setData] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = searchParams.get('status') ?? '';
  const typeFilter = (searchParams.get('type') ?? '') as TypeFilter;
  const search = searchParams.get('q') ?? '';
  const page = Math.max(0, Number(searchParams.get('page') ?? '0') || 0);

  const updateParams = (updates: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(updates)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    setSearchParams(next);
  };

  const setFilter = (s: string) => updateParams({ status: s || null, page: null });
  const setTypeFilter = (t: string) => updateParams({ type: t || null, page: null });
  const setPage = (p: number) => updateParams({ page: p > 0 ? String(p) : null });

  // Local search input state — debounced into the URL so list refreshes
  // don't fire on every keystroke.
  const [searchInput, setSearchInput] = useState(search);
  useEffect(() => { setSearchInput(search); }, [search]);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSearchChange = (v: string) => {
    setSearchInput(v);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      updateParams({ q: v || null, page: null });
    }, 300);
  };

  const [sortKey, setSortKey] = useState<SortKey>('startedAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const navigate = useNavigate();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.listPaged({
        status: filter || undefined,
        type: typeFilter || undefined,
        search: search || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      setData(result.items);
      setTotal(result.total);
    } catch { /* ignore */ }
    setLoading(false);
  }, [filter, typeFilter, search, page]);

  useEffect(() => { refresh(); }, [refresh]);

  // Auto-refresh every 5s when there are running executions
  useEffect(() => {
    const hasRunning = data.some(e => e.status === 'running' || e.status === 'queued');
    if (!hasRunning) return;
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [data, refresh]);

  // Sorted data
  const sorted = useMemo(() => {
    const copy = [...data];
    copy.sort((a, b) => {
      let aVal = a[sortKey];
      let bVal = b[sortKey];
      if (sortKey === 'startedAt') {
        aVal = new Date(aVal ?? 0).getTime();
        bVal = new Date(bVal ?? 0).getTime();
      }
      if (sortKey === 'durationMs') {
        aVal = aVal ?? 0;
        bVal = bVal ?? 0;
      }
      if (aVal < bVal) return sortDir === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return copy;
  }, [data, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return null;
    return sortDir === 'asc'
      ? <ChevronUp className="w-3 h-3 inline ml-0.5" />
      : <ChevronDown className="w-3 h-3 inline ml-0.5" />;
  };

  const handleRerun = useCallback(async (exec: any) => {
    try {
      const result = await api.start(exec.workflowId, exec.input ?? {});
      navigate(`/executions/${result.id}`);
    } catch (e: any) {
      alert(e.message);
    }
  }, [navigate]);

  const handleExport = useCallback(async (execId: string) => {
    const traces = await api.traces(execId);
    const blob = new Blob([JSON.stringify(traces, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `execution-${execId}-traces.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const statuses = ['', 'running', 'completed', 'failed', 'cancelled', 'queued', 'waiting_for_input'];
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const fromIdx = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const toIdx = Math.min(total, (page + 1) * PAGE_SIZE);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6 gap-3 flex-wrap">
        <h1 className="font-heading text-xl font-bold text-theme-primary tracking-widest uppercase">Executions</h1>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-theme-subtle pointer-events-none" />
            <input
              type="text"
              value={searchInput}
              onChange={e => onSearchChange(e.target.value)}
              placeholder="Search id, workflow, node…"
              className="input text-xs pl-7 w-56"
            />
          </div>
          <select
            value={typeFilter}
            onChange={e => setTypeFilter(e.target.value)}
            className="input text-xs"
            title="Filter by execution type"
          >
            <option value="">All types</option>
            <option value="workflow">Workflow</option>
            <option value="agent">Agent</option>
          </select>
          <select
            value={filter}
            onChange={e => setFilter(e.target.value)}
            className="input text-xs"
          >
            {statuses.map(s => (
              <option key={s} value={s}>{s || 'All statuses'}</option>
            ))}
          </select>
          <button title="Refresh executions" onClick={refresh} className="btn-ghost text-xs">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {loading && data.length === 0 ? (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-theme-muted bg-surface-50 text-xs font-label uppercase tracking-wider">
                <th className="text-left px-4 py-3 font-medium">ID</th>
                <th className="text-left px-4 py-3 font-medium">Workflow</th>
                <th className="text-left px-4 py-3 font-medium">Status</th>
                <th className="text-left px-4 py-3 font-medium">Duration</th>
                <th className="text-left px-4 py-3 font-medium">Cost</th>
                <th className="text-left px-4 py-3 font-medium">Started</th>
                <th className="text-left px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40">
              <TableSkeleton rows={5} cols={7} />
            </tbody>
          </table>
        </div>
      ) : data.length === 0 ? (
        <div className="card p-8 text-center">
          <Play className="w-8 h-8 text-theme-subtle mx-auto mb-3" />
          {(search || filter || typeFilter) ? (
            <>
              <p className="text-theme-secondary text-sm font-body">No executions match your filters</p>
              <p className="text-theme-subtle text-xs mt-1 font-mono">CLEAR SEARCH OR FILTERS TO SEE MORE</p>
            </>
          ) : (
            <>
              <p className="text-theme-secondary text-sm font-body">No executions yet</p>
              <p className="text-theme-subtle text-xs mt-1 font-mono">START A WORKFLOW TO SEE EXECUTIONS HERE</p>
            </>
          )}
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm font-body">
            <thead>
              <tr className="text-theme-muted bg-surface-50 text-xs font-label uppercase tracking-wider">
                <th className="text-left px-4 py-3 font-medium">ID</th>
                <th
                  className="text-left px-4 py-3 font-medium cursor-pointer hover:text-accent-blue transition-colors"
                  onClick={() => toggleSort('workflowName')}
                >
                  Workflow <SortIcon col="workflowName" />
                </th>
                <th
                  className="text-left px-4 py-3 font-medium cursor-pointer hover:text-accent-blue transition-colors"
                  onClick={() => toggleSort('status')}
                >
                  Status <SortIcon col="status" />
                </th>
                <th
                  className="text-left px-4 py-3 font-medium cursor-pointer hover:text-accent-blue transition-colors"
                  onClick={() => toggleSort('durationMs')}
                >
                  Duration <SortIcon col="durationMs" />
                </th>
                <th className="text-left px-4 py-3 font-medium">Cost</th>
                <th
                  className="text-left px-4 py-3 font-medium cursor-pointer hover:text-accent-blue transition-colors"
                  onClick={() => toggleSort('startedAt')}
                >
                  Started <SortIcon col="startedAt" />
                </th>
                <th className="text-left px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40">
              {sorted.map((exec: any) => (
                <tr key={exec.id ?? exec._id} className="hover:bg-accent-blue/5 transition-colors">
                  <td className="px-4 py-3">
                    <Link
                      to={`/executions/${exec.id}`}
                      className="text-accent-blue hover:text-accent-blue/80 font-mono text-xs"
                    >
                      {exec.id?.slice(0, 8) ?? 'N/A'}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-gray-200">{exec.workflowName}</td>
                  <td className="px-4 py-3"><StatusBadge status={exec.status} /></td>
                  <td className="px-4 py-3 text-theme-secondary text-xs tabular-nums font-mono">
                    {exec.durationMs != null ? `${(exec.durationMs / 1000).toFixed(1)}s` : '-'}
                  </td>
                  <td className="px-4 py-3"><CostDisplay cost={exec.cost} /></td>
                  <td className="px-4 py-3 text-theme-secondary text-xs font-mono">
                    {exec.startedAt ? new Date(exec.startedAt).toLocaleString() : '-'}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      {/* Re-run */}
                      {exec.workflowId && (
                        <button
                          onClick={() => handleRerun(exec)}
                          className="btn-ghost text-xs p-1"
                          title="Re-run workflow"
                        >
                          <Play className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {/* Retry from failed node */}
                      {exec.status === 'failed' && exec.failedNode && (
                        <button
                          onClick={async () => {
                            await api.retryFrom(exec.id, exec.failedNode);
                            refresh();
                          }}
                          className="btn-ghost text-xs p-1 text-accent-yellow"
                          title={`Retry from ${exec.failedNode}`}
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {/* Export traces */}
                      <button
                        onClick={() => handleExport(exec.id)}
                        className="btn-ghost text-xs p-1"
                        title="Export traces as JSON"
                      >
                        <Download className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between px-4 py-3 border-t border-border/40 text-xs text-theme-secondary font-mono">
            <span>
              {fromIdx}–{toIdx} of {total}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage(page - 1)}
                disabled={page === 0 || loading}
                className="btn-ghost text-xs p-1 disabled:opacity-40 disabled:cursor-not-allowed"
                title="Previous page"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <span>
                Page {page + 1} of {totalPages}
              </span>
              <button
                onClick={() => setPage(page + 1)}
                disabled={page + 1 >= totalPages || loading}
                className="btn-ghost text-xs p-1 disabled:opacity-40 disabled:cursor-not-allowed"
                title="Next page"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
