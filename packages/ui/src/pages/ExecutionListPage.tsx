import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Search } from 'lucide-react';
import { executions as api } from '../services/api';
import { mergeExecutionSnapshot, snapshotFromExecution, useExecutionStore } from '../stores/executionStore';

type TypeFilter = '' | 'agent' | 'workflow';
type SourceFilter = '' | 'chat' | 'workflow' | 'design';

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

function displayedDuration(exec: any, nowMs: number): string {
  const duration = shortDuration(executionDurationMs(exec, nowMs));
  if (!isActiveStatus(exec.status) || duration === '-') return duration;
  const minuteMatch = duration.match(/^(\d+)m/);
  return minuteMatch ? `${minuteMatch[1]}m…` : `${duration.replace(/\.0s$/, 's')}…`;
}

function executionDurationMs(exec: any, nowMs: number): number | null | undefined {
  if (!isActiveStatus(exec.status)) return exec.durationMs;
  const startedAt = exec.startedAt ?? exec.createdAt;
  const startedMs = startedAt ? new Date(startedAt).getTime() : NaN;
  if (!Number.isFinite(startedMs)) return exec.durationMs;
  return Math.max(exec.durationMs ?? 0, nowMs - startedMs);
}

function executionId(exec: any): string {
  return String(exec?.id ?? exec?._id ?? '');
}

function isActiveStatus(status: string): boolean {
  return status === 'running' || status === 'queued' || status === 'waiting_for_input';
}

function isTerminalStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'canceled';
}

function isSpawnedAgentExecution(exec: any): boolean {
  return exec?.type === 'agent'
    || exec?.source === 'spawn'
    || typeof exec?.workflowName === 'string' && exec.workflowName.includes(':spawn_agent/');
}

function hasParentExecutionVisible(exec: any, candidates: any[]): boolean {
  if (!isSpawnedAgentExecution(exec)) return false;
  const parentId = exec?.parentExecutionId ? String(exec.parentExecutionId) : null;
  const rootId = exec?.rootExecutionId ? String(exec.rootExecutionId) : null;
  const chatSessionId = exec?.meta?.chatSessionId ? String(exec.meta.chatSessionId) : null;

  return candidates.some((candidate) => {
    if (candidate === exec || isSpawnedAgentExecution(candidate)) return false;
    const candidateId = executionId(candidate);
    const candidateRootId = candidate?.rootExecutionId ? String(candidate.rootExecutionId) : null;
    const candidateChatSessionId = candidate?.meta?.chatSessionId ? String(candidate.meta.chatSessionId) : null;
    return Boolean(
      (parentId && parentId === candidateId)
      || (rootId && (rootId === candidateId || rootId === candidateRootId))
      || (chatSessionId && candidateChatSessionId && chatSessionId === candidateChatSessionId),
    );
  });
}

function hideSpawnedChildrenWhenParentVisible(items: any[]): any[] {
  return items.filter((exec) => !hasParentExecutionVisible(exec, items));
}

function executionSourceLabel(exec: any): string {
  const origin = String(exec?.origin ?? exec?.meta?.origin ?? exec?.source ?? '').toLowerCase();
  if (origin === 'chat' || exec?.meta?.chatSessionId) return 'chat';
  if (origin === 'linear') return 'linear';
  if (exec?.source === 'spawn' || origin === 'direct_agent' || isSpawnedAgentExecution(exec)) return 'agent';
  return 'manual';
}

function prettyWorkflowName(exec: any): string {
  const name = String(exec?.title ?? exec?.workflowName ?? exec?.name ?? 'Untitled execution');
  return name.replace(/^.*:spawn_agent\//, '').replace(/[-_]/g, ' ');
}

function executionStartedAt(exec: any): string {
  const value = exec?.startedAt ?? exec?.createdAt;
  if (!value) return 'not started';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'not started';

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase();
  if (startOfDate === startOfToday) return `today ${time}`;
  if (startOfDate === startOfToday - 86_400_000) return `yesterday ${time}`;
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).toLowerCase();
}

function compactPath(path?: string | null): string {
  if (!path) return '';
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 3) return normalized;
  return `.../${parts.slice(-3).join('/')}`;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function executionRunContext(exec: any): { label: string; detail: string; title?: string } {
  const workspace = exec?.workspace ?? null;
  const repository = exec?.repository ?? null;
  const input = exec?.input ?? {};
  const state = exec?.state ?? {};
  const meta = exec?.meta ?? {};
  const workspacePath = firstString(
    workspace?.worktreePath,
    meta?.workspacePath,
    state?.worktree_path,
    input?.worktree_path,
  );
  const repoPath = firstString(repository?.path, meta?.repoPath, state?.repo_path, input?.repo_path);
  const fallbackPath = firstString(workspacePath, repoPath, meta?.cwd);

  if (workspace) {
    const label = firstString(workspace.branch, workspace.name) ?? 'workspace';
    const repo = firstString(workspace.repoName, repository?.name) ?? 'no repository context';
    return {
      label,
      detail: repo,
      title: workspacePath ?? undefined,
    };
  }

  if (repository) {
    return {
      label: 'no workspace',
      detail: firstString(repository.name) ?? 'repository context',
      title: repoPath ?? undefined,
    };
  }

  if (fallbackPath) {
    return {
      label: 'no workspace',
      detail: compactPath(fallbackPath),
      title: fallbackPath,
    };
  }

  return { label: 'no workspace', detail: 'no repository context' };
}

function executionKindLabel(exec: any): string {
  const surface = String(exec?.meta?.sourceSurface ?? '').toLowerCase();
  if (surface === 'design_tab') return 'design';
  if (executionSourceLabel(exec) === 'chat') {
    return exec?.meta?.executionMode === 'build' ? 'chat · build' : 'chat';
  }
  if (isSpawnedAgentExecution(exec)) return 'agent';
  return 'workflow';
}

function executionStatusLabel(exec: any): string {
  const status = String(exec?.status ?? 'pending').replaceAll('_', ' ').toLowerCase();
  if (!isActiveStatus(exec?.status)) return status;
  const completed = Number(exec?.progress?.completed ?? exec?.completedNodes?.length ?? 0);
  const total = Number(exec?.progress?.total ?? exec?.totalNodes ?? 0);
  return total > 0 ? `${status} · ${completed}/${total}` : status;
}

function executionStatusTone(status: string): string {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'error';
  if (status === 'waiting_for_input' || status === 'queued') return 'warning';
  if (isActiveStatus(status)) return 'running';
  return 'neutral';
}

function ExecutionRow({ exec, nowMs }: { exec: any; nowMs: number }) {
  const id = executionId(exec);
  const context = executionRunContext(exec);
  const tone = executionStatusTone(exec?.status);

  return (
    <Link
      to={`/executions/${id}`}
      className="v8-execution-list__row"
    >
      <div className="v8-execution-list__primary">
        <b>
          {prettyWorkflowName(exec)}
          <span className="v8-execution-list__kind">{executionKindLabel(exec)}</span>
        </b>
        <small title={context.title}>{context.label} · {context.detail}</small>
      </div>
      <span className={`v8-execution-list__status is-${tone} ${isActiveStatus(exec?.status) ? 'is-pulsing' : ''}`}>
        {executionStatusLabel(exec)}
      </span>
      <time>{executionStartedAt(exec)}</time>
      <time>{displayedDuration(exec, nowMs)}</time>
      <span className="v8-execution-list__arrow" aria-hidden="true">→</span>
    </Link>
  );
}

export default function ExecutionListPage() {
  const [data, setData] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [nowMs, setNowMs] = useState(Date.now());
  const [searchParams, setSearchParams] = useSearchParams();
  const snapshots = useExecutionStore((state) => state.entities);
  const filter = searchParams.get('status') ?? '';
  const typeFilter = (searchParams.get('type') ?? '') as TypeFilter;
  const sourceFilter = (searchParams.get('source') ?? '') as SourceFilter;
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

  const setSourceFilter = (s: string) => updateParams({ source: s || null, page: null });

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
        includeTotal: true,
        enrich: true,
      });
      setData(result.items);
      useExecutionStore.getState().ingestMany(
        result.items.map((item) => snapshotFromExecution(item)).filter((item): item is NonNullable<typeof item> => Boolean(item)),
      );
      setTotal(result.total ?? result.items.length);
    } catch { /* ignore */ }
    setLoading(false);
  }, [filter, typeFilter, search, page]);

  // Client-side source filter helper
  // TODO: If the API supports sourceSurface query param in the future, pass it
  //       to api.listPaged and remove the client-side filter below.
  function matchesSourceFilter(exec: any): boolean {
    if (!sourceFilter) return true;
    const surface = exec?.meta?.sourceSurface ?? '';
    if (sourceFilter === 'design') return surface === 'design_tab';
    if (sourceFilter === 'chat') return surface !== 'design_tab' && executionSourceLabel(exec) === 'chat';
    if (sourceFilter === 'workflow') return executionKindLabel(exec) === 'workflow';
    return true;
  }

  useEffect(() => { refresh(); }, [refresh]);

  const liveData = useMemo(
    () => data.map((execution) => mergeExecutionSnapshot(execution, snapshots[String(execution.id ?? execution.executionId ?? '')])),
    [data, snapshots],
  );

  useEffect(() => {
    const hasRunning = liveData.some(e => isActiveStatus(e.status));
    if (!hasRunning) return;
    const interval = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [liveData]);

  const sorted = useMemo(() => {
    const copy = [...liveData].filter(matchesSourceFilter);
    copy.sort((a, b) => {
      const aVal = new Date(a.startedAt ?? 0).getTime();
      const bVal = new Date(b.startedAt ?? 0).getTime();
      return bVal - aVal;
    });
    return copy;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveData, sourceFilter]);

  const runningNow = hideSpawnedChildrenWhenParentVisible(sorted.filter(exec => isActiveStatus(exec.status)));
  const recentExecs = hideSpawnedChildrenWhenParentVisible(sorted.filter(exec => isTerminalStatus(exec.status)));
  const visibleExecs = hideSpawnedChildrenWhenParentVisible(sorted);
  const recentCount = Math.max(recentExecs.length, total - runningNow.length);

  const vm = paginationViewModel({ page, total, pageSize: PAGE_SIZE });

  return (
    <div className="v8-execution-list content scroll-hide bg-app" data-screen-label="activity">
      <div className="v8-execution-list__wrap">
        <header className="v8-execution-list__header">
          <div className="v8-execution-list__headline">
            <h1>Executions</h1>
            <p>Live workflow and agent runs across Allen.</p>
          </div>
          <div className="v8-execution-list__counts" aria-label="Execution counts">
            <span className={`v8-execution-list__count is-running ${runningNow.length ? 'is-pulsing' : ''}`}>{runningNow.length} running</span>
            <span className="v8-execution-list__count is-recent">{recentCount} recent</span>
          </div>
        </header>

        <div className="v8-execution-list__toolbar">
          <label className="v8-execution-list__search">
            <Search aria-hidden="true" />
            <input
              type="text"
              value={searchInput}
              onChange={e => onSearchChange(e.target.value)}
              placeholder="Search execution, workflow, or node"
            />
          </label>
          <div className="v8-execution-list__sources" role="group" aria-label="Filter executions by source">
            {(['', 'chat', 'workflow', 'design'] as SourceFilter[]).map((source) => {
              const label = source === '' ? 'All' : source === 'chat' ? 'Chat' : source === 'workflow' ? 'Workflow' : 'Design';
              return (
                <button
                  key={source}
                  type="button"
                  aria-pressed={sourceFilter === source}
                  onClick={() => setSourceFilter(source)}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <span className="v8-execution-list__shown">{visibleExecs.length} shown</span>
        </div>

        <section className="v8-execution-list__table" aria-label="Executions">
          {visibleExecs.length > 0 && (
            <div className="v8-execution-list__row v8-execution-list__table-head">
              <span>Execution</span>
              <span>Status</span>
              <time>Started</time>
              <time>Duration</time>
              <span />
            </div>
          )}
          {loading && visibleExecs.length === 0 ? (
            Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className="v8-execution-list__row v8-execution-list__skeleton" aria-hidden="true">
                <span><i /><i /></span><i /><i /><i /><i />
              </div>
            ))
          ) : visibleExecs.length === 0 ? (
            <div className="v8-execution-list__empty">
              <strong>No executions found</strong>
              <p>Runs will appear here as soon as Allen starts workflow or agent work.</p>
            </div>
          ) : (
            visibleExecs.map((exec: any) => (
              <ExecutionRow key={executionId(exec)} exec={exec} nowMs={nowMs} />
            ))
          )}
        </section>

        <p className="v8-execution-list__footnote">Click a run to open its detail. Failed runs open at the decision that needs you.</p>

        {vm.visible && (
          <div className="v8-execution-list__pagination">
            <button
              type="button"
              className="inline-flex h-9 items-center rounded-md border border-app bg-app px-3 text-[13px] font-medium text-theme-secondary transition-colors hover:border-app-strong hover:text-theme-primary disabled:cursor-not-allowed disabled:opacity-40"
              disabled={vm.prevDisabled}
              aria-label="Previous page"
              onClick={() => updateParams({ page: String(page - 1) })}
            >
              Previous
            </button>
            <span className="font-mono text-[11px] text-theme-muted">
              Page {vm.currentPageLabel} of {vm.pageCount}
            </span>
            <button
              type="button"
              className="inline-flex h-9 items-center rounded-md border border-app bg-app px-3 text-[13px] font-medium text-theme-secondary transition-colors hover:border-app-strong hover:text-theme-primary disabled:cursor-not-allowed disabled:opacity-40"
              disabled={vm.nextDisabled}
              aria-label="Next page"
              onClick={() => updateParams({ page: String(page + 1) })}
            >
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
