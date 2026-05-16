import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, FileText, GitBranch, Layers, MessageSquare, Pencil, Play, RefreshCw, Shield,
} from 'lucide-react';
import { executions as executionsApi, users as usersApi, workflows as workflowsApi } from '../services/api';
import type { AuthUser } from '../stores/authStore';
import StatusBadge from '../components/common/StatusBadge';
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
  return `${Math.floor(hours / 24)}d ago`;
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
  return Boolean(run?.chat?.sessionId ?? run?.meta?.chatSessionId);
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
      let result = await executionsApi.listPaged({
        workflowId: id,
        type: 'workflow',
        limit: 100,
        offset: 0,
        includeTotal: true,
      });

      if (result.total === 0 && wf) {
        result = await executionsApi.listPaged({
          workflowName: workflowName(wf),
          type: 'workflow',
          limit: 100,
          offset: 0,
          includeTotal: true,
        });
      }

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
    <div className="page-shell">
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
          <button title="Refresh" className="btn btn-secondary btn-sm" onClick={() => { void loadWorkflow(); void loadRuns(); }}>
            <RefreshCw className="w-3 h-3" />
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => setRunDialogOpen(true)} disabled={!isValid}>
            <Play className="w-3 h-3" /> Run
          </button>
          <button
            className={`btn btn-sm ${isEditing ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setTab(isEditing ? 'runs' : 'edit')}
          >
            {isEditing ? <ArrowLeft className="w-3 h-3" /> : <Pencil className="w-3 h-3" />}
            {isEditing ? 'View' : 'Edit'}
          </button>
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
              <select
                value={selectedUserId}
                onChange={(event) => setSelectedUserId(event.target.value)}
                className="input !h-8 !w-auto !min-w-[190px] !py-1 text-[12px]"
                aria-label="Filter workflow runs by user"
              >
                <option value="all">All users</option>
                {allUsers.map((user) => (
                  <option key={user.id} value={user.id}>{user.name || user.email}</option>
                ))}
              </select>
              <select
                value={chatFilter}
                onChange={(event) => setChatFilter(event.target.value as ChatFilter)}
                className="input !h-8 !w-auto !min-w-[150px] !py-1 text-[12px]"
                aria-label="Filter linked chat runs"
              >
                <option value="all">All chat links</option>
                <option value="linked">Linked to chat</option>
                <option value="unlinked">Not linked to chat</option>
              </select>
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
          <div className="card overflow-hidden">
            <div className="grid grid-cols-[110px_1fr_220px_140px_110px_110px_92px] items-center gap-4 border-b border-app bg-app-muted px-4 py-2">
              <span className="overline">Run</span>
              <span className="overline">Workflow</span>
              <span className="overline">User</span>
              <span className="overline">Status</span>
              <span className="overline">Duration</span>
              <span className="overline">Started</span>
              <span className="overline">Chat</span>
            </div>
            {runsLoading ? (
              Array.from({ length: 5 }).map((_, i) => <div key={i} className="m-3 h-14 rounded-md bg-app-muted animate-pulse" />)
            ) : runs.length === 0 ? (
              <div className="p-10 text-center text-[13px] text-theme-muted">No runs yet.</div>
            ) : filteredRuns.length === 0 ? (
              <div className="p-10 text-center text-[13px] text-theme-muted">No runs match these filters.</div>
            ) : filteredRuns.map((run) => (
              <div
                key={run.id ?? run._id}
                role="button"
                tabIndex={0}
                onClick={() => navigate(`/executions/${run.id ?? run._id}`)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    navigate(`/executions/${run.id ?? run._id}`);
                  }
                }}
                className="grid w-full grid-cols-[110px_1fr_220px_140px_110px_110px_92px] items-center gap-4 border-b border-app px-4 py-3.5 text-left transition-colors last:border-b-0 hover:bg-app-muted"
              >
                <span className="font-mono text-[12px] text-theme-muted truncate">{(run.id ?? run._id ?? '').slice(0, 8)}</span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-medium text-theme-primary">{run.workflowName ?? name}</span>
                  <span className="mt-0.5 block truncate font-mono text-[10.5px] text-theme-subtle">{run.id ?? run._id}</span>
                </span>
                <span
                  className="min-w-0 truncate font-mono text-[12px] text-theme-secondary"
                  title={runUserId(run) ? `${runUserLabel(run)} · ${runUserId(run)}` : runUserLabel(run)}
                >
                  {runUserLabel(run)}
                </span>
                <span><StatusBadge status={run.status} /></span>
                <span className="font-mono text-[12px] text-theme-muted">{shortDuration(run.durationMs)}</span>
                <span className="font-mono text-[12px] text-theme-muted">{shortAge(run.startedAt)}</span>
                <span>
                  {run.chat?.sessionId ? (
                    <Link
                      to={`/chat/${run.chat.sessionId}`}
                      className="btn btn-secondary btn-sm inline-flex"
                      title={run.chat?.title ? `Open chat: ${run.chat.title}` : 'Open linked chat'}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <MessageSquare className="w-3 h-3" /> Open
                    </Link>
                  ) : (
                    <span className="text-[12px] text-theme-subtle">—</span>
                  )}
                </span>
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
                      {key}{input[key]?.required !== false ? ' *' : ''}
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

      {tab === 'edit' && (
        <div className="mt-3 h-[calc(100vh-220px)] min-h-[720px] min-w-0 overflow-hidden rounded-lg border border-app bg-app-card">
          <WorkflowBuilderPage embedded onBack={() => setTab('runs')} />
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
