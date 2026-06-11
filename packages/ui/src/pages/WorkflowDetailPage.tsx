import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, ExternalLink, FileText, GitBranch, Layers, MessageSquare, Pencil, Play, RefreshCw, Shield,
} from 'lucide-react';
import { executions as executionsApi, users as usersApi, workflows as workflowsApi } from '../services/api';
import type { AuthUser } from '../stores/authStore';
import StatusBadge from '../components/common/StatusBadge';
import Select from '../components/common/Select';
import IconTooltipButton from '../components/common/IconTooltipButton';
import WorkflowRunDialog from '../components/workflow/WorkflowRunDialog';
import WorkflowBuilderPage from './WorkflowBuilderPage';
import {
  workflowDescription,
  workflowEdges,
  workflowInput,
  workflowName,
  workflowNodes,
} from '../utils/workflowShape';

type WorkflowTab = 'runs' | 'description' | 'edit';
type ChatFilter = 'all' | 'linked' | 'unlinked';

function shortDuration(ms: number | null | undefined): string {
  if (ms == null) return '-';
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.floor(s % 60)}s`;
}

function runUserLabel(run: any): string {
  return run?.user?.email
    ?? run?.chat?.userEmail
    ?? run?.meta?.startedByUserEmail
    ?? run?.user?.name
    ?? run?.chat?.userName
    ?? run?.meta?.startedByUserName
    ?? '—';
}

function runUserId(run: any): string | null {
  return run?.user?.userId
    ?? run?.chat?.userId
    ?? run?.meta?.startedByUserId
    ?? null;
}

function runHasLinkedChat(run: any): boolean {
  return Boolean(runChatSessionId(run));
}

function runChatSessionId(run: any): string | null {
  return run?.chat?.sessionId
    ?? run?.meta?.chatSessionId
    ?? null;
}

function runId(run: any): string {
  return String(run?.id ?? run?._id ?? '');
}

function runTitle(run: any, fallback: string): string {
  return run?.workflowName
    ?? run?.name
    ?? fallback;
}

function runStartedAt(run: any): string {
  const value = run?.startedAt ?? run?.createdAt;
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

export default function WorkflowDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const tab: WorkflowTab = requestedTab === 'description' || requestedTab === 'edit' ? requestedTab : 'runs';

  const [workflow, setWorkflow] = useState<any | null>(null);
  const [runs, setRuns] = useState<any[]>([]);
  const [runsTotal, setRunsTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [runsLoading, setRunsLoading] = useState(true);
  const [runDialogOpen, setRunDialogOpen] = useState(false);
  const [allUsers, setAllUsers] = useState<AuthUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState('all');
  const [chatFilter, setChatFilter] = useState<ChatFilter>('all');

  const loadWorkflow = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      setWorkflow(await workflowsApi.get(id));
    } finally {
      setLoading(false);
    }
  }, [id]);

  const loadRuns = useCallback(async (wf = workflow) => {
    if (!id) return;
    setRunsLoading(true);
    try {
      const result = await executionsApi.listPaged({
        workflowId: id,
        type: 'workflow',
        limit: 100,
        offset: 0,
        includeTotal: true,
        enrich: true,
      });

      setRuns(result.items);
      setRunsTotal(result.total ?? result.items.length);
    } finally {
      setRunsLoading(false);
    }
  }, [id, workflow]);

  useEffect(() => { void loadWorkflow(); }, [loadWorkflow]);
  useEffect(() => {
    usersApi.list().then(setAllUsers).catch(() => setAllUsers([]));
  }, []);
  useEffect(() => {
    if (workflow) void loadRuns(workflow);
  }, [workflow, loadRuns]);

  const nodes = useMemo(() => workflowNodes(workflow), [workflow]);
  const edges = useMemo(() => workflowEdges(workflow), [workflow]);
  const input = useMemo(() => workflowInput(workflow), [workflow]);
  const inputKeys = Object.keys(input);
  const name = workflow ? workflowName(workflow) : 'Workflow';
  const description = workflow ? workflowDescription(workflow) : '';
  const isValid = Boolean(workflow?.validation?.valid);
  const isEditing = tab === 'edit';
  const filteredRuns = useMemo(() => {
    return runs.filter((run) => {
      const userId = runUserId(run);
      const matchesUser = selectedUserId === 'all'
        || !userId
        || userId === selectedUserId;
      const linkedToChat = runHasLinkedChat(run);
      const matchesChat = chatFilter === 'all'
        || (chatFilter === 'linked' && linkedToChat)
        || (chatFilter === 'unlinked' && !linkedToChat);
      return matchesUser && matchesChat;
    });
  }, [runs, selectedUserId, chatFilter]);
  const hasRunFilters = selectedUserId !== 'all' || chatFilter !== 'all';

  function setTab(next: WorkflowTab) {
    const params = new URLSearchParams(searchParams);
    if (next === 'runs') params.delete('tab');
    else params.set('tab', next);
    setSearchParams(params);
  }

  // Edit mode is a full-bleed surface: the embedded builder (which carries its
  // own toolbar + back button) fills the entire content area with no
  // detail-page chrome or padding around it. Returned before the loading guard
  // so the builder — which fetches its own workflow by id — shows immediately.
  if (isEditing) {
    return (
      <div className="h-full w-full overflow-hidden">
        <WorkflowBuilderPage embedded onBack={() => setTab('runs')} />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="page-shell">
        <div className="h-8 w-52 rounded bg-app-muted animate-pulse" />
        <div className="card mt-4 h-72 animate-pulse bg-app-muted" />
      </div>
    );
  }

  if (!workflow) {
    return (
      <div className="page-shell">
        <button className="btn btn-secondary btn-sm" onClick={() => navigate('/workflows')}>
          <ArrowLeft className="w-3 h-3" /> Back
        </button>
        <div className="card mt-4 p-6 text-theme-muted">Workflow not found.</div>
      </div>
    );
  }

  return (
    <div className="w-full px-8 py-8">
      <div className="page-crumb">
        <Link to="/workflows">Workflows</Link>
        <span className="text-theme-subtle">/</span>
        <span>{name}</span>
      </div>

      <div className="page-head">
        <div className="min-w-0">
          <div className="flex items-center gap-3 min-w-0">
            <h1 className="page-title truncate">{name}</h1>
            <span className={`badge ${isValid ? 'badge-ok' : 'badge-err'}`}>
              <Shield className="w-3 h-3" /> {isValid ? 'valid' : 'invalid'}
            </span>
          </div>
          <p className="text-[13px] text-theme-muted font-body mt-1">
            {Object.keys(nodes).length} nodes · {edges.length} edges · v{workflow.version ?? 1}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <IconTooltipButton
            label="Refresh workflow"
            onClick={() => { void loadWorkflow(); void loadRuns(); }}
            className="h-9 w-9 rounded-md border border-app bg-app-card"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </IconTooltipButton>
          <IconTooltipButton
            label="Run workflow"
            tone="accent"
            onClick={() => setRunDialogOpen(true)}
            disabled={!isValid}
            className="h-9 w-9 rounded-md border border-app bg-app-card"
          >
            <Play className="h-3.5 w-3.5" />
          </IconTooltipButton>
          <IconTooltipButton
            label={isEditing ? 'View runs' : 'Edit workflow'}
            onClick={() => setTab(isEditing ? 'runs' : 'edit')}
            className="h-9 w-9 rounded-md border border-app bg-app-card"
          >
            {isEditing ? <ArrowLeft className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
          </IconTooltipButton>
        </div>
      </div>

      {!isEditing && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <nav className="topfilter-tabs">
            {[
              { key: 'runs', label: 'runs', count: runsTotal },
              { key: 'description', label: 'description', count: null },
            ].map(item => (
              <button
                key={item.key}
                type="button"
                className={`tft ${tab === item.key ? 'active' : ''}`}
                onClick={() => setTab(item.key as WorkflowTab)}
              >
                {item.label}
                {item.key === 'runs' && hasRunFilters ? (
                  <span className="tft-ct">{filteredRuns.length}/{runsTotal}</span>
                ) : item.count != null && <span className="tft-ct">{item.count}</span>}
              </button>
            ))}
          </nav>
          {tab === 'runs' && (
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={selectedUserId}
                onChange={setSelectedUserId}
                className="min-w-[190px]"
                searchable={allUsers.length > 6}
                options={[
                  { value: 'all', label: 'All users' },
                  ...allUsers.map((user) => ({
                    value: user.id,
                    label: user.name || user.email,
                    sublabel: user.email,
                  })),
                ]}
              />
              <Select
                value={chatFilter}
                onChange={(value) => setChatFilter(value as ChatFilter)}
                className="min-w-[150px]"
                searchable={false}
                options={[
                  { value: 'all', label: 'All chat links' },
                  { value: 'linked', label: 'Linked to chat' },
                  { value: 'unlinked', label: 'Not linked to chat' },
                ]}
              />
              {hasRunFilters && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm !h-8"
                  onClick={() => {
                    setSelectedUserId('all');
                    setChatFilter('all');
                  }}
                >
                  Clear
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {tab === 'runs' && (
        <div className="mt-4">
          <div className="overflow-hidden rounded-md border border-app bg-app-card">
            <div className="flex items-center justify-between gap-4 border-b border-app bg-app-muted/25 px-4 py-3">
              <div>
                <div className="text-[13px] font-semibold text-theme-primary">Workflow runs</div>
                <div className="mt-0.5 font-mono text-[11px] text-theme-muted">
                  {filteredRuns.length} shown{hasRunFilters ? ` · ${runsTotal} total` : ''}
                </div>
              </div>
              <IconTooltipButton
                label="Refresh workflow runs"
                onClick={() => { void loadRuns(); }}
                className="h-8 w-8 rounded-md border border-app"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${runsLoading ? 'animate-spin' : ''}`} />
              </IconTooltipButton>
            </div>
            {runsLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="border-b border-app px-4 py-3 last:border-b-0">
                  <div className="flex items-center gap-3">
                    <div className="h-9 w-9 animate-pulse rounded-md bg-app-muted" />
                    <div className="min-w-0 flex-1">
                      <div className="h-4 w-56 animate-pulse rounded-md bg-app-muted" />
                      <div className="mt-2 h-3 w-72 animate-pulse rounded-md bg-app-muted" />
                    </div>
                    <div className="h-7 w-24 animate-pulse rounded-md bg-app-muted" />
                  </div>
                </div>
              ))
            ) : runs.length === 0 ? (
              <div className="px-5 py-12 text-center">
                <Play className="mx-auto h-8 w-8 text-theme-subtle" />
                <div className="mt-4 text-[15px] font-semibold text-theme-primary">No runs yet</div>
                <p className="mt-1 text-[13px] text-theme-muted">Run this workflow to see execution history here.</p>
              </div>
            ) : filteredRuns.length === 0 ? (
              <div className="p-10 text-center text-[13px] text-theme-muted">No runs match these filters.</div>
            ) : filteredRuns.map((run) => (
              <div
                key={runId(run)}
                role="button"
                tabIndex={0}
                onClick={() => navigate(`/executions/${runId(run)}`)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    navigate(`/executions/${runId(run)}`);
                  }
                }}
                className="grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_120px_132px_112px_104px] items-center gap-4 border-b border-app px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-app-muted/35"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-app bg-app text-theme-muted">
                    <Play className="h-3.5 w-3.5" />
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-[13.5px] font-semibold text-theme-primary">{runTitle(run, name)}</div>
                    <div className="mt-1 flex min-w-0 items-center gap-2">
                      <span className="truncate font-mono text-[11px] text-theme-muted" title={runUserLabel(run)}>{runUserLabel(run)}</span>
                      {runChatSessionId(run) && (
                        <>
                          <span className="text-theme-subtle">·</span>
                          <span className="inline-flex items-center gap-1 font-mono text-[11px] text-accent-green">
                            <MessageSquare className="h-3 w-3" /> chat
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
                <span
                  className="min-w-0 truncate font-mono text-[11px] text-theme-secondary"
                  title={runUserId(run) ? `${runUserLabel(run)} · ${runUserId(run)}` : runUserLabel(run)}
                >
                  {runStartedAt(run)}
                </span>
                <span><StatusBadge status={run.status} /></span>
                <span className="font-mono text-[11px] text-theme-muted">{shortDuration(run.durationMs)}</span>
                <div className="flex items-center justify-end gap-1.5">
                  {runChatSessionId(run) ? (
                    <IconTooltipButton
                      label={run.chat?.title ? `Open chat: ${run.chat.title}` : 'Open linked chat'}
                      onClick={(event) => {
                        event.stopPropagation();
                        const sessionId = runChatSessionId(run);
                        if (sessionId) navigate(`/chat/${sessionId}`);
                      }}
                      className="h-8 w-8 rounded-md border border-app"
                    >
                      <MessageSquare className="h-3.5 w-3.5" />
                    </IconTooltipButton>
                  ) : null}
                  <span className="flex h-8 w-8 items-center justify-center rounded-md text-theme-muted">
                    <ExternalLink className="h-3.5 w-3.5" />
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'description' && (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4 mt-4">
          <section className="card p-5">
            <div className="overline mb-2">Description</div>
            <p className="text-[14px] text-theme-primary font-body leading-relaxed whitespace-pre-wrap">
              {description || 'No description provided.'}
            </p>
          </section>
          <aside className="card p-5 space-y-5">
            <div>
              <div className="overline mb-2">Structure</div>
              <div className="flex flex-col gap-2 text-[12px] text-theme-secondary">
                <span className="flex items-center gap-2"><Layers className="w-3 h-3" /> {Object.keys(nodes).length} nodes</span>
                <span className="flex items-center gap-2"><GitBranch className="w-3 h-3" /> {edges.length} edges</span>
                <span className="flex items-center gap-2"><FileText className="w-3 h-3" /> {inputKeys.length} inputs</span>
              </div>
            </div>
            <div>
              <div className="overline mb-2">Inputs</div>
              {inputKeys.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {inputKeys.map(key => (
                    <span key={key} className="badge">
                      {key}{input[key]?.required === true ? ' *' : ''}
                    </span>
                  ))}
                </div>
              ) : (
                <span className="text-[12px] text-theme-muted">No inputs defined.</span>
              )}
            </div>
          </aside>
        </div>
      )}

      {runDialogOpen && (
        <WorkflowRunDialog
          workflow={workflow}
          onClose={() => setRunDialogOpen(false)}
          onStarted={(exec) => {
            setRunDialogOpen(false);
            navigate(`/executions/${exec.id}`);
          }}
        />
      )}
    </div>
  );
}
