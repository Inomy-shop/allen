import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Play, RefreshCw, Search } from 'lucide-react';
import { executions as api } from '../services/api';
import StatusBadge from '../components/common/StatusBadge';

type TypeFilter = '' | 'agent' | 'workflow';

const PAGE_SIZE = 50;

export interface PaginationViewModel {
  visible: boolean;
  pageCount: number;
  currentPageLabel: number; // 1-indexed display
  prevDisabled: boolean;
  nextDisabled: boolean;
}

export function paginationViewModel({
  page,
  total,
  pageSize,
}: {
  page: number;
  total: number | null | undefined;
  pageSize: number;
}): PaginationViewModel {
  const safeTotal = total ?? 0;
  const safePage = Math.max(0, page);
  return {
    visible: safeTotal > pageSize,
    pageCount: Math.max(1, Math.ceil(safeTotal / pageSize)),
    currentPageLabel: safePage + 1,
    prevDisabled: safePage === 0,
    nextDisabled: (safePage + 1) * pageSize >= safeTotal,
  };
}

function shortDuration(ms: number | null | undefined): string {
  if (ms == null) return '-';
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.floor(s % 60)}s`;
}

function shortAge(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return '—';
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function progressFor(status: string): number {
  switch (status) {
    case 'completed': return 100;
    case 'failed': return 60;
    case 'cancelled': return 20;
    case 'waiting_for_input': return 35;
    case 'running': return 58;
    case 'queued': return 12;
    default: return 25;
  }
}

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

  const sorted = useMemo(() => {
    const copy = [...data];
    copy.sort((a, b) => {
      const aVal = new Date(a.startedAt ?? 0).getTime();
      const bVal = new Date(b.startedAt ?? 0).getTime();
      return bVal - aVal;
    });
    return copy;
  }, [data]);

  const statuses = ['', 'running', 'completed', 'failed', 'cancelled', 'queued', 'waiting_for_input'];
  const runningNow = sorted.filter(exec => exec.status === 'running' || exec.status === 'queued' || exec.status === 'waiting_for_input');
  const recentExecs = sorted;

  const vm = paginationViewModel({ page, total, pageSize: PAGE_SIZE });

  return (
    <div className="content scroll-hide" data-screen-label="activity">
      <div className="page-head">
        <div className="ph-row">
          <div>
            <h1>activity</h1>
            <p className="sub">what's running, queued, and just finished across the org</p>
          </div>
          <button title="Refresh executions" onClick={refresh} className="btn btn-secondary btn-sm" type="button">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <div className="activity-filterbar">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-theme-muted pointer-events-none" />
            <input
              type="text"
              value={searchInput}
              onChange={e => onSearchChange(e.target.value)}
              placeholder="Search id, workflow, node…"
              className="input pl-8 w-64 py-1.5 text-[12px]"
            />
          </div>
          <select
            value={typeFilter}
            onChange={e => setTypeFilter(e.target.value)}
            className="input py-1.5 text-[12px] w-auto"
            title="Filter by execution type"
          >
            <option value="">All types</option>
            <option value="workflow">Workflow</option>
            <option value="agent">Agent</option>
          </select>
          <select
            value={filter}
            onChange={e => setFilter(e.target.value)}
            className="input py-1.5 text-[12px] w-auto"
          >
            {statuses.map(s => (
              <option key={s} value={s}>{s || 'All statuses'}</option>
            ))}
          </select>
          <button title="Refresh executions" onClick={refresh} className="btn btn-secondary btn-sm">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="an-body">
        <section className="an-section">
          <header className="an-h">
            <h3><Play className="h-3 w-3" /> running now <span className="an-h-ct">{runningNow.length}</span></h3>
            <button className="an-h-link" onClick={() => setFilter('running')} type="button">view all <span>→</span></button>
          </header>
          {runningNow.length === 0 ? (
            <div className="an-empty">no executions running.</div>
          ) : (
            <div className="an-runlist">
              {runningNow.map((exec: any) => (
                <Link key={exec.id ?? exec._id} className="an-run" to={`/executions/${exec.id}`}>
                  <span className="mono an-run-id">{exec.id?.slice(0, 8) ?? 'N/A'}</span>
                  <span className="an-run-wf">{exec.workflowName}</span>
                  <StatusBadge status={exec.status} />
                  <span className="mono">{shortDuration(exec.durationMs)}</span>
                </Link>
              ))}
            </div>
          )}
        </section>

        <section className="an-section">
          <header className="an-h">
            <h3><Play className="h-3 w-3" /> recent executions</h3>
            <span className="an-h-ct">{total} total</span>
          </header>
          <div className="an-runlist">
            {recentExecs.length === 0 ? (
              <div className="an-empty">no executions yet.</div>
            ) : recentExecs.map((exec: any) => (
              <Link key={exec.id ?? exec._id} className="an-run" to={`/executions/${exec.id}`}>
                <span className="mono an-run-id">{exec.id?.slice(0, 8) ?? 'N/A'}</span>
                <span className="an-run-wf">{exec.workflowName}</span>
                <StatusBadge status={exec.status} />
                <span className="mono">{shortDuration(exec.durationMs)}</span>
                <span className="muted mono">{shortAge(exec.startedAt)}</span>
              </Link>
            ))}
          </div>
          {vm.visible && (
            <div className="an-pagination">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={vm.prevDisabled}
                aria-label="Previous page"
                onClick={() => updateParams({ page: String(page - 1) })}
              >
                Previous
              </button>
              <span className="an-pagination-label">
                Page {vm.currentPageLabel} of {vm.pageCount}
              </span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={vm.nextDisabled}
                aria-label="Next page"
                onClick={() => updateParams({ page: String(page + 1) })}
              >
                Next
              </button>
            </div>
          )}
        </section>

        <section className="an-section">
          <header className="an-h">
            <h3><Play className="h-3 w-3" /> tasks in motion</h3>
          </header>
          {runningNow.length === 0 ? (
            <div className="an-empty">no tasks in motion.</div>
          ) : (
            <div className="th-list p-0">
              {runningNow.map((exec: any) => (
                <Link key={exec.id ?? exec._id} className="th-row" to={`/executions/${exec.id}`}>
                  <div className="r-refs">
                    <span className="r-ref linear">{exec.type ?? 'run'}</span>
                    <span className="r-ref gh">{exec.id?.slice(0, 8) ?? 'N/A'}</span>
                  </div>
                  <div className="th-body">
                    <div className="th-title">{exec.workflowName}</div>
                    <div className="th-sub">{exec.status}</div>
                  </div>
                  <div className="bar th-prog"><span style={{ width: `${progressFor(exec.status)}%` }} /></div>
                  <StatusBadge status={exec.status} />
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
