import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Clock3,
  ExternalLink,
  FolderGit2,
  GitBranch,
  ListFilter,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Workflow,
} from 'lucide-react';
import { executions as api } from '../services/api';
import StatusBadge from '../components/common/StatusBadge';
import Select from '../components/common/Select';
import IconTooltipButton from '../components/common/IconTooltipButton';

type TypeFilter = '' | 'agent' | 'workflow';
type ActivityTab = 'running' | 'recent';

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

function executionDurationMs(exec: any, nowMs: number): number | null | undefined {
  if (!isActiveStatus(exec.status)) return exec.durationMs;
  const startedAt = exec.startedAt ?? exec.createdAt;
  const startedMs = startedAt ? new Date(startedAt).getTime() : NaN;
  if (!Number.isFinite(startedMs)) return exec.durationMs;
  return Math.max(exec.durationMs ?? 0, nowMs - startedMs);
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

function executionId(exec: any): string {
  return String(exec?.id ?? exec?._id ?? '');
}

function isActiveStatus(status: string): boolean {
  return status === 'running' || status === 'queued' || status === 'waiting_for_input';
}

function isTerminalStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'canceled';
}

function isDelegatedAgentExecution(exec: any): boolean {
  return exec?.type === 'agent'
    || exec?.source === 'spawn'
    || typeof exec?.workflowName === 'string' && exec.workflowName.includes(':spawn_agent/');
}

function hasParentExecutionVisible(exec: any, candidates: any[]): boolean {
  if (!isDelegatedAgentExecution(exec)) return false;
  const parentId = exec?.parentExecutionId ? String(exec.parentExecutionId) : null;
  const rootId = exec?.rootExecutionId ? String(exec.rootExecutionId) : null;
  const chatSessionId = exec?.meta?.chatSessionId ? String(exec.meta.chatSessionId) : null;

  return candidates.some((candidate) => {
    if (candidate === exec || isDelegatedAgentExecution(candidate)) return false;
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

function hideDelegatedChildrenWhenParentVisible(items: any[]): any[] {
  return items.filter((exec) => !hasParentExecutionVisible(exec, items));
}

function executionSourceLabel(exec: any): string {
  const origin = String(exec?.origin ?? exec?.meta?.origin ?? exec?.source ?? '').toLowerCase();
  if (origin === 'chat' || exec?.meta?.chatSessionId) return 'chat';
  if (origin === 'linear') return 'linear';
  if (exec?.source === 'spawn' || origin === 'direct_agent' || isDelegatedAgentExecution(exec)) return 'agent';
  return 'manual';
}

function prettyWorkflowName(exec: any): string {
  const name = String(exec?.workflowName ?? exec?.name ?? 'Untitled execution');
  return name.replace(/^.*:spawn_agent\//, '').replace(/[-_]/g, ' ');
}

function executionStartedAt(exec: any): string {
  const value = exec?.startedAt ?? exec?.createdAt;
  if (!value) return 'Not started';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Not started';
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
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

function executionRunContext(exec: any): { kind: 'workspace' | 'repository' | 'path' | 'none'; label: string; detail?: string; title?: string } {
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
    const label = firstString(workspace.name) ?? 'Workspace';
    const repo = firstString(workspace.repoName);
    return {
      kind: 'workspace',
      label,
      detail: repo ?? undefined,
      title: workspacePath ?? undefined,
    };
  }

  if (repository) {
    return {
      kind: 'repository',
      label: firstString(repository.name) ?? 'Repository',
      detail: firstString(repository.defaultBranch) ? `default ${repository.defaultBranch}` : undefined,
      title: repoPath ?? undefined,
    };
  }

  if (fallbackPath) {
    return {
      kind: 'path',
      label: 'Path',
      detail: compactPath(fallbackPath),
      title: fallbackPath,
    };
  }

  return { kind: 'none', label: 'No workspace', detail: 'No repository context' };
}

function ContextIcon({ kind }: { kind: 'workspace' | 'repository' | 'path' | 'none' }) {
  if (kind === 'workspace') return <FolderGit2 className="h-3 w-3 shrink-0 text-accent" />;
  if (kind === 'repository') return <GitBranch className="h-3 w-3 shrink-0 text-accent-blue" />;
  if (kind === 'path') return <GitBranch className="h-3 w-3 shrink-0 text-theme-subtle" />;
  return <Workflow className="h-3 w-3 shrink-0 text-theme-subtle" />;
}

function sourceTextClass(source: string): string {
  if (source === 'agent') return 'text-accent-blue';
  if (source === 'chat') return 'text-accent-green';
  if (source === 'linear') return 'text-accent-yellow';
  return 'text-theme-muted';
}

function ExecutionRow({ exec, nowMs }: { exec: any; nowMs: number }) {
  const id = executionId(exec);
  const source = executionSourceLabel(exec);
  const duration = shortDuration(executionDurationMs(exec, nowMs));
  const isActive = isActiveStatus(exec.status);
  const context = executionRunContext(exec);
  const currentStep = firstString(
    exec?.currentStep,
    Array.isArray(exec?.currentNodes) ? exec.currentNodes.filter(Boolean).join(', ') : null,
    exec?.failedNode,
  );

  return (
    <Link
      to={`/executions/${id}`}
      className="group grid min-h-[58px] grid-cols-[minmax(0,1fr)_116px_132px_96px_36px] items-center gap-4 border-t border-app px-4 py-2.5 transition-colors first:border-t-0 hover:bg-app-muted/30"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[13.5px] font-semibold text-theme-primary">{prettyWorkflowName(exec)}</span>
            {isActive && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-accent-green" />}
            <span className={`shrink-0 font-mono text-[10.5px] ${sourceTextClass(source)}`}>{source}</span>
            {currentStep && (
              <>
                <span className="text-theme-subtle">·</span>
                <span className="min-w-0 truncate font-mono text-[11px] text-theme-muted">{currentStep}</span>
              </>
            )}
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11.5px] text-theme-muted">
            <ContextIcon kind={context.kind} />
            <span className="shrink-0 text-theme-secondary">{context.label}</span>
            {context.detail && <><span className="text-theme-subtle">·</span><span className="truncate font-mono" title={context.kind === 'path' ? context.title ?? context.detail : context.detail}>{context.detail}</span></>}
          </div>
        </div>
      </div>

      <div className="justify-self-start">
        <StatusBadge status={exec.status ?? 'pending'} />
      </div>
      <span className="truncate font-mono text-[11px] text-theme-muted">{executionStartedAt(exec)}</span>
      <span className="font-mono text-[11px] text-theme-secondary">{isActive ? duration : duration}</span>
      <span className="flex h-8 w-8 items-center justify-center rounded-md text-theme-muted transition-colors group-hover:bg-app group-hover:text-theme-primary">
        <ExternalLink className="h-3.5 w-3.5" />
      </span>
    </Link>
  );
}

export default function ExecutionListPage() {
  const [data, setData] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [nowMs, setNowMs] = useState(Date.now());
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = searchParams.get('status') ?? '';
  const typeFilter = (searchParams.get('type') ?? '') as TypeFilter;
  const search = searchParams.get('q') ?? '';
  const requestedView = searchParams.get('view');
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
  const setActiveTab = (view: ActivityTab) => updateParams({ view, page: null });

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
      setTotal(result.total ?? result.items.length);
    } catch { /* ignore */ }
    setLoading(false);
  }, [filter, typeFilter, search, page]);

  useEffect(() => { refresh(); }, [refresh]);

  // Auto-refresh every 5s when there are running executions
  useEffect(() => {
    const hasRunning = data.some(e => isActiveStatus(e.status));
    if (!hasRunning) return;
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [data, refresh]);

  useEffect(() => {
    const hasRunning = data.some(e => isActiveStatus(e.status));
    if (!hasRunning) return;
    const interval = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [data]);

  const sorted = useMemo(() => {
    const copy = [...data];
    copy.sort((a, b) => {
      const aVal = new Date(a.startedAt ?? 0).getTime();
      const bVal = new Date(b.startedAt ?? 0).getTime();
      return bVal - aVal;
    });
    return copy;
  }, [data]);

  const statusOptions = [
    { value: '', label: 'All statuses' },
    { value: 'running', label: 'Running' },
    { value: 'completed', label: 'Completed' },
    { value: 'failed', label: 'Failed' },
    { value: 'cancelled', label: 'Cancelled' },
    { value: 'queued', label: 'Queued' },
    { value: 'waiting_for_input', label: 'Waiting for input' },
  ];
  const typeOptions = [
    { value: '', label: 'All types' },
    { value: 'workflow', label: 'Workflow' },
    { value: 'agent', label: 'Agent' },
  ];
  const runningNow = hideDelegatedChildrenWhenParentVisible(sorted.filter(exec => isActiveStatus(exec.status)));
  const recentExecs = hideDelegatedChildrenWhenParentVisible(sorted.filter(exec => isTerminalStatus(exec.status)));
  const activeTab: ActivityTab =
    requestedView === 'running' || requestedView === 'recent'
      ? requestedView
      : runningNow.length > 0
        ? 'running'
        : 'recent';
  const visibleExecs = activeTab === 'running' ? runningNow : recentExecs;

  const vm = paginationViewModel({ page, total, pageSize: PAGE_SIZE });

  return (
    <div className="content scroll-hide bg-app" data-screen-label="activity">
      <div className="w-full px-8 py-8">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-md border border-app bg-app-card text-theme-muted">
              <Play className="h-[18px] w-[18px]" />
            </span>
            <div>
              <h1 className="text-[24px] font-semibold leading-tight text-theme-primary">Executions</h1>
              <p className="mt-1 text-[13px] text-theme-muted">Live workflow and agent runs across Allen.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="inline-flex h-9 items-center rounded-md border border-app bg-app-card p-1">
              <button
                type="button"
                className={`inline-flex h-7 items-center gap-2 rounded-md px-2.5 text-[12px] font-medium transition-colors ${
                  activeTab === 'running'
                    ? 'bg-app-muted text-theme-primary'
                    : 'text-theme-muted hover:text-theme-primary'
                }`}
                onClick={() => setActiveTab('running')}
              >
                <Loader2 className={`h-3.5 w-3.5 ${runningNow.length ? 'animate-spin text-accent-green' : ''}`} />
                <span>Running</span>
                <span className="font-mono text-[11px]">{runningNow.length}</span>
              </button>
              <button
                type="button"
                className={`inline-flex h-7 items-center gap-2 rounded-md px-2.5 text-[12px] font-medium transition-colors ${
                  activeTab === 'recent'
                    ? 'bg-app-muted text-theme-primary'
                    : 'text-theme-muted hover:text-theme-primary'
                }`}
                onClick={() => setActiveTab('recent')}
              >
                <Clock3 className="h-3.5 w-3.5" />
                <span>Recent</span>
                <span className="font-mono text-[11px]">{recentExecs.length}</span>
              </button>
            </div>
            <IconTooltipButton
              label="Refresh executions"
              onClick={() => void refresh()}
              className="h-9 w-9 border border-app bg-app-card hover:border-app-strong"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            </IconTooltipButton>
          </div>
        </div>

        <div className="mb-4 rounded-md border border-app bg-app-card px-4 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-[300px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-theme-muted" />
              <input
                type="text"
                value={searchInput}
                onChange={e => onSearchChange(e.target.value)}
                placeholder="Search execution id, workflow, or node"
                className="h-9 w-full rounded-md border border-app bg-app px-8 text-[13px] text-theme-primary outline-none transition-colors placeholder:text-theme-subtle focus:border-accent focus:shadow-[var(--focus-ring)]"
              />
            </div>
            <div className="w-[156px]">
              <Select
                value={typeFilter}
                onChange={setTypeFilter}
                options={typeOptions}
                searchPlaceholder="Search type"
                searchable={false}
              />
            </div>
            <div className="w-[184px]">
              <Select
                value={filter}
                onChange={setFilter}
                options={statusOptions}
                searchPlaceholder="Search status"
                searchable={false}
              />
            </div>
            <div className="flex shrink-0 items-center gap-2 font-mono text-[11px] text-theme-muted">
              <ListFilter className="h-3.5 w-3.5" />
              <span>{visibleExecs.length} shown</span>
            </div>
          </div>
        </div>

        <section className="overflow-hidden rounded-md border border-app bg-app-card">
          {visibleExecs.length > 0 && (
            <div className="grid grid-cols-[minmax(0,1fr)_116px_132px_96px_36px] items-center gap-4 border-b border-app bg-app-muted/25 px-4 py-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-theme-muted">
              <span>Execution</span>
              <span>Status</span>
              <span>Started</span>
              <span>Duration</span>
              <span />
            </div>
          )}
          {loading && visibleExecs.length === 0 ? (
            Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className="border-t border-app px-4 py-3 first:border-t-0">
                <div className="flex items-center gap-4">
                  <div className="h-9 w-9 animate-pulse rounded-md bg-app-muted" />
                  <div className="min-w-0 flex-1">
                    <div className="h-4 w-56 animate-pulse rounded-md bg-app-muted" />
                    <div className="mt-2 h-3 w-80 animate-pulse rounded-md bg-app-muted" />
                  </div>
                  <div className="h-7 w-24 animate-pulse rounded-md bg-app-muted" />
                </div>
              </div>
            ))
          ) : visibleExecs.length === 0 ? (
            <div className="px-5 py-12 text-center">
              <Play className="mx-auto h-8 w-8 text-theme-subtle" />
              <div className="mt-4 text-[15px] font-semibold text-theme-primary">
                {activeTab === 'running' ? 'No executions running' : 'No recent executions'}
              </div>
              <p className="mt-1 text-[13px] text-theme-muted">
                {activeTab === 'running'
                  ? 'New agent work appears here as soon as Allen starts a run.'
                  : 'Completed, failed, and cancelled runs will appear here.'}
              </p>
            </div>
          ) : (
            visibleExecs.map((exec: any) => (
              <ExecutionRow key={executionId(exec)} exec={exec} nowMs={nowMs} />
            ))
          )}
        </section>

        {activeTab === 'recent' && vm.visible && (
          <div className="mt-5 flex items-center justify-between border-t border-app pt-4">
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
