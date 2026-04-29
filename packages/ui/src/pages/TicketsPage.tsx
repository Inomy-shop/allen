import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  linear as linearApi,
  teams as teamsApi,
  repos as reposApi,
  workflows as workflowsApi,
  executions as executionsApi,
} from '../services/api';
import { useAgents } from '../hooks/useAgents';
import { useToast } from '../components/common/Toast';
import { renderMarkdown } from '../components/chat/ChatMessageList';
import { type AgentOption, type TeamOption } from '../components/agents/AgentAssignDropdown';
import DispatchModal, { type DispatchTarget, type WorkflowOption } from '../components/linear/DispatchModal';
import {
  AlertCircle, ChevronDown, ChevronRight, Circle, Clock, ExternalLink,
  KeyRound, Loader2, MinusCircle, Play, RefreshCw, Search, Settings, X, Sparkles,
  List as ListIcon, LayoutGrid,
} from 'lucide-react';

type StateType = 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled' | 'triage';

type AssignmentStatus = 'manual' | 'pending' | 'running' | 'failed' | 'completed';

interface AgentAssignee {
  linearIssueId: string;
  agentName: string;
  assignedAt: string;
  assignedBy: string;
  status?: AssignmentStatus;
  workspaceId?: string;
  workspacePath?: string;
  executionId?: string;
  error?: string;
  branch?: string;
}

interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  priorityLabel: string;
  state: { id: string; name: string; type: StateType; color: string };
  team: { id: string; name: string; key: string };
  project: { id: string; name: string } | null;
  linearAssignee: { id: string; name: string; email?: string | null } | null;
  agentAssignee: AgentAssignee | null;
  labels: { id: string; name: string; color: string }[];
  createdAt: string;
  updatedAt: string;
  url: string;
}

interface LinearProject {
  id: string;
  name: string;
  description: string;
  color: string | null;
  state: string;
  icon: string | null;
  progress: number;
  issueCount: number;
  url: string;
}

interface LinearStatus {
  configured: boolean;
  workspaceName?: string;
  workspaceUrlKey?: string;
  error?: string;
}

const STATUS_GROUPS: { type: StateType; label: string }[] = [
  { type: 'triage', label: 'Triage' },
  { type: 'backlog', label: 'Backlog' },
  { type: 'unstarted', label: 'Todo' },
  { type: 'started', label: 'In Progress' },
  { type: 'completed', label: 'Done' },
  { type: 'canceled', label: 'Canceled' },
];

function PriorityIcon({ p }: { p: number }) {
  const tone =
    p === 1 ? 'text-accent-red'
    : p === 2 ? 'text-accent-orange'
    : p === 3 ? 'text-accent-yellow'
    : p === 4 ? 'text-accent-green'
    : 'text-theme-subtle';
  if (p === 0) return <MinusCircle className={`w-3.5 h-3.5 ${tone}`} />;
  return <Circle className={`w-3.5 h-3.5 ${tone} fill-current/30`} fill="currentColor" />;
}

function relative(dateIso: string): string {
  const d = new Date(dateIso).getTime();
  const now = Date.now();
  const diff = (now - d) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 2_592_000) return `${Math.floor(diff / 604800)}w ago`;
  return new Date(dateIso).toLocaleDateString();
}

export default function TicketsPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { agents } = useAgents();
  const [teams, setTeams] = useState<any[]>([]);

  const [status, setStatus] = useState<LinearStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [projects, setProjects] = useState<LinearProject[]>([]);
  const [issues, setIssues] = useState<LinearIssue[]>([]);
  const [listLoading, setListLoading] = useState(false);

  const [projectFilter, setProjectFilter] = useState<string>(''); // '' = all
  const [stateFilters, setStateFilters] = useState<Set<StateType>>(
    new Set<StateType>(['backlog', 'unstarted', 'started', 'triage']),
  );
  const [assigneeFilter, setAssigneeFilter] = useState<'any' | 'unassigned' | string>('any');
  const [search, setSearch] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<StateType>>(new Set());

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<LinearIssue | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Dispatch modal + repo list
  const [dispatchFor, setDispatchFor] = useState<LinearIssue | null>(null);
  const [repos, setRepos] = useState<any[]>([]);
  const [reposLoading, setReposLoading] = useState(true);
  const [workflowList, setWorkflowList] = useState<WorkflowOption[]>([]);
  const [workflowsLoading, setWorkflowsLoading] = useState(true);

  // Top-tab filter + view mode — must live above the early-return paths
  // to satisfy React's rules of hooks.
  type TopTab = 'all' | 'active' | 'done';
  const [topTab, setTopTab] = useState<TopTab>('all');
  const [viewMode, setViewMode] = useState<'list' | 'board'>('list');
  useEffect(() => {
    if (topTab === 'active') setStateFilters(new Set<StateType>(['started', 'unstarted']));
    else if (topTab === 'done') setStateFilters(new Set<StateType>(['completed']));
    else setStateFilters(new Set<StateType>(['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled']));
  }, [topTab]);

  // Teams list for agent dropdown grouping
  useEffect(() => {
    teamsApi.list()
      .then((t: any[]) => setTeams((t ?? []).slice().sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => setTeams([]));
  }, []);

  // Repos (for dispatch modal)
  useEffect(() => {
    setReposLoading(true);
    reposApi.list()
      .then((r: any[]) => setRepos((r ?? []).slice().sort((a, b) => String(a.name).localeCompare(b.name))))
      .catch(() => setRepos([]))
      .finally(() => setReposLoading(false));
  }, []);

  // Workflows (for dispatch modal — third dispatch target type)
  useEffect(() => {
    setWorkflowsLoading(true);
    workflowsApi.list()
      .then((wfs: any[]) => setWorkflowList(
        (wfs ?? [])
          .filter((w: any) => w.validation?.valid !== false)
          .map((w: any) => ({ _id: w._id, name: w.name, description: w.description, parsed: w.parsed }))
          .sort((a: WorkflowOption, b: WorkflowOption) => a.name.localeCompare(b.name)),
      ))
      .catch(() => setWorkflowList([]))
      .finally(() => setWorkflowsLoading(false));
  }, []);

  // Initial status check
  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const s = await linearApi.status();
      setStatus(s);
    } catch (err) {
      setStatus({ configured: false, error: (err as Error).message });
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  // Load projects + issues when connected
  const loadProjects = useCallback(async () => {
    try {
      const p = await linearApi.projects();
      setProjects(p ?? []);
    } catch (err) {
      toast.error(`Failed to load Linear projects: ${(err as Error).message}`);
      setProjects([]);
    }
  }, [toast]);

  const loadIssues = useCallback(async () => {
    setListLoading(true);
    try {
      const state = Array.from(stateFilters).join(',');
      const list = await linearApi.issues({
        projectId: projectFilter || undefined,
        state: state || undefined,
        q: search.trim() || undefined,
        limit: 200,
      });
      setIssues(list ?? []);
    } catch (err) {
      toast.error(`Failed to load Linear issues: ${(err as Error).message}`);
      setIssues([]);
    } finally {
      setListLoading(false);
    }
  }, [projectFilter, stateFilters, search, toast]);

  useEffect(() => {
    if (!status?.configured) return;
    void loadProjects();
  }, [status?.configured, loadProjects]);

  useEffect(() => {
    if (!status?.configured) return;
    void loadIssues();
  }, [status?.configured, loadIssues]);

  // Load detail
  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    setDetailLoading(true);
    linearApi.issue(selectedId)
      .then((d: any) => setDetail(d))
      .catch((err: any) => toast.error(`Failed to load ticket: ${err.message}`))
      .finally(() => setDetailLoading(false));
  }, [selectedId, toast]);

  // Filter by Linear assignee (the human user assigned in Linear).
  // assigneeFilter holds the linear user id ('any' / 'unassigned' / <id>).
  const filteredIssues = useMemo(() => {
    if (assigneeFilter === 'any') return issues;
    if (assigneeFilter === 'unassigned') return issues.filter(i => !i.linearAssignee);
    return issues.filter(i => i.linearAssignee?.id === assigneeFilter);
  }, [issues, assigneeFilter]);

  // Build the unique list of Linear assignees we've seen across the
  // issue set. Sorted by name for a stable dropdown order.
  const linearAssignees = useMemo(() => {
    const seen = new Map<string, { id: string; name: string }>();
    for (const i of issues) {
      const a = i.linearAssignee;
      if (a?.id && !seen.has(a.id)) seen.set(a.id, { id: a.id, name: a.name });
    }
    return Array.from(seen.values()).sort((x, y) => x.name.localeCompare(y.name));
  }, [issues]);

  // Filter projects locally by the sidebar search — so "search projects and issues"
  // narrows both lists at once.
  const filteredProjects = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(p =>
      p.name.toLowerCase().includes(q)
      || (p.description ?? '').toLowerCase().includes(q),
    );
  }, [projects, search]);

  // Group by status type
  const grouped = useMemo(() => {
    const m = new Map<StateType, LinearIssue[]>();
    for (const g of STATUS_GROUPS) m.set(g.type, []);
    for (const issue of filteredIssues) {
      const key = issue.state?.type ?? 'backlog';
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(issue);
    }
    return m;
  }, [filteredIssues]);

  function toggleStateFilter(t: StateType) {
    setStateFilters(prev => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }

  function toggleGroupCollapsed(t: StateType) {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }

  async function handleClearAssignment(issueId: string) {
    try {
      const { assignment } = await linearApi.assignAgent(issueId, null);
      setIssues(prev => prev.map(i => i.id === issueId ? { ...i, agentAssignee: assignment } : i));
      if (detail?.id === issueId) setDetail({ ...detail, agentAssignee: assignment });
      toast.success('Assignment cleared');
    } catch (err) {
      toast.error(`Failed to clear assignment: ${(err as Error).message}`);
    }
  }

  async function handleDispatch(
    issue: LinearIssue,
    args: { target: DispatchTarget; repoId: string; extraInstructions: string },
  ) {
    if (args.target.kind === 'workflow') {
      // Run the workflow with the ticket as the `task` input. Extra
      // instructions get appended to the task body so the workflow has
      // the full context.
      const taskBody = [
        `[${issue.identifier}] ${issue.title}`,
        issue.description || '',
        args.extraInstructions ? `\nAdditional instructions:\n${args.extraInstructions}` : '',
      ].filter(Boolean).join('\n\n');
      const exec = await executionsApi.start(args.target.workflowId, {
        task: taskBody,
        ticket_id: issue.identifier,
        ticket_url: issue.url,
      });
      toast.success(`Started ${args.target.workflowName} on ${issue.identifier}`);
      setDispatchFor(null);
      navigate(`/executions/${exec.id}`);
      return;
    }

    // Both 'agent' and 'team-lead' route through the existing
    // /linear/dispatch endpoint with the resolved agent name.
    const agentName = args.target.kind === 'agent' ? args.target.name : args.target.agentName;
    const { assignment } = await linearApi.dispatch(issue.id, {
      agentName,
      repoId: args.repoId,
      extraInstructions: args.extraInstructions,
    });
    setIssues(prev => prev.map(i => i.id === issue.id ? { ...i, agentAssignee: assignment } : i));
    if (detail?.id === issue.id) setDetail({ ...detail, agentAssignee: assignment });
    toast.success(`Dispatching ${agentName} to ${issue.identifier}…`);
    setDispatchFor(null);
    setTimeout(() => { if (selectedId === issue.id) void linearApi.issue(issue.id).then(setDetail).catch(() => {}); }, 3000);
  }

  const agentOptions: AgentOption[] = useMemo(
    () => (agents ?? []).map((a: any) => ({
      name: a.name,
      displayName: a.displayName,
      icon: a.icon,
      color: a.color,
      teamName: a.teamName,
      teamRole: a.teamRole,
    })),
    [agents],
  );
  const teamOptions: TeamOption[] = useMemo(
    () => teams.map(t => ({ name: t.name, displayName: t.displayName })),
    [teams],
  );

  // ── Render ───────────────────────────────────────────────────────────────

  if (statusLoading) {
    return (
      <div className="p-6 flex items-center gap-2 text-[11px] font-mono text-theme-muted">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking Linear connection…
      </div>
    );
  }

  if (!status?.configured) {
    return (
      <div className="flex items-center justify-center h-full p-8">
        <div className="max-w-md w-full rounded-xl border border-app bg-app-muted/50 p-8 text-center space-y-4">
          <div className="w-12 h-12 mx-auto rounded-full bg-accent-yellow/10 flex items-center justify-center">
            <AlertCircle className="w-6 h-6 text-accent-yellow" />
          </div>
          <div>
            <h2 className="font-heading text-lg font-bold text-theme-primary tracking-wide">Linear not connected</h2>
            <p className="text-[12px] text-theme-muted font-body mt-2">
              Add a Linear API token to Allen Secrets under the key:
            </p>
          </div>
          <div className="inline-flex items-center gap-2 px-3 py-2 rounded-md bg-app-muted border border-app text-[11px] font-mono text-accent">
            <KeyRound className="w-3.5 h-3.5" /> ALLEN_LINEAR_ACCESS_TOKEN
          </div>
          <div className="flex items-center justify-center gap-2 pt-2">
            <button
              onClick={() => navigate('/settings/secrets')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-mono bg-accent-soft text-accent hover:bg-accent/20 transition-colors"
            >
              <Settings className="w-3 h-3" /> Open Settings · Secrets
            </button>
            <button
              onClick={loadStatus}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-mono bg-app-muted text-theme-muted hover:bg-app-muted transition-colors"
            >
              <RefreshCw className="w-3 h-3" /> Recheck
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (status.configured && status.error) {
    return (
      <div className="flex items-center justify-center h-full p-8">
        <div className="max-w-md w-full rounded-xl border border-accent-red/30 bg-accent-red/5 p-6 text-center space-y-3">
          <AlertCircle className="w-6 h-6 text-accent-red mx-auto" />
          <h2 className="font-heading text-base font-bold text-theme-primary">Couldn't reach Linear</h2>
          <p className="text-[12px] text-theme-muted font-body">{status.error}</p>
          <button
            onClick={loadStatus}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-mono bg-app-muted text-theme-muted hover:bg-app-muted"
          >
            <RefreshCw className="w-3 h-3" /> Retry
          </button>
        </div>
      </div>
    );
  }

  const totalShown = filteredIssues.length;
  const activeCount = (grouped.get('started')?.length ?? 0) + (grouped.get('unstarted')?.length ?? 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ── Top bar (matches handoff/pages/remaining.jsx LinearV2) ──────── */}
      <div className="px-6 pt-5 pb-0 border-b border-app shrink-0">
        <div className="flex items-center gap-2 mb-2 text-[12px] text-theme-muted">
          <span>Code</span>
          <span className="text-theme-subtle">/</span>
          <span>Linear</span>
        </div>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <h1 className="text-[20px] font-semibold text-theme-primary tracking-tight">Linear</h1>
            <div className="flex items-center gap-1.5 text-[11px] font-mono text-theme-muted">
              <span className="w-1.5 h-1.5 rounded-full bg-accent-green" />
              {status.workspaceName ?? 'Linear'} · {issues.length} issues
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* List/Board view toggle */}
            <div className="flex items-center bg-app-muted rounded-md p-0.5">
              <button
                onClick={() => setViewMode('list')}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-[12px] transition-colors ${
                  viewMode === 'list' ? 'bg-app-card text-theme-primary shadow-sm font-medium' : 'text-theme-muted hover:text-theme-primary'
                }`}
                title="List view"
              >
                <ListIcon className="w-3.5 h-3.5" /> List
              </button>
              <button
                onClick={() => setViewMode('board')}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-[12px] transition-colors ${
                  viewMode === 'board' ? 'bg-app-card text-theme-primary shadow-sm font-medium' : 'text-theme-muted hover:text-theme-primary'
                }`}
                title="Board view"
              >
                <LayoutGrid className="w-3.5 h-3.5" /> Board
              </button>
            </div>
            <button
              onClick={() => { void loadStatus(); void loadProjects(); void loadIssues(); }}
              disabled={listLoading}
              className="btn btn-secondary btn-sm"
            >
              {listLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              Refresh
            </button>
          </div>
        </div>

        {/* Tab row */}
        <div className="flex items-center gap-1 -mb-px">
          {([
            { id: 'all', label: 'All', count: issues.length },
            { id: 'active', label: 'Active', count: activeCount },
            { id: 'done', label: 'Done' },
          ] as { id: TopTab; label: string; count?: number }[]).map(t => (
            <button
              key={t.id}
              onClick={() => setTopTab(t.id)}
              className={`px-2.5 py-1.5 text-[13px] -mb-px transition-colors flex items-center gap-1.5 border-b-2 ${
                topTab === t.id
                  ? 'text-theme-primary font-medium border-accent'
                  : 'text-theme-muted hover:text-theme-primary border-transparent'
              }`}
            >
              {t.label}
              {t.count != null && <span className="text-[11px] text-theme-muted font-mono">{t.count}</span>}
            </button>
          ))}
        </div>
      </div>

      {/* ── Filter row + main list ──────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <div className="flex-1 overflow-y-auto min-h-0">
          <div className="px-6 py-4 space-y-3">
            {/* Filter row */}
            <div className="flex items-center gap-3 text-[12px] text-theme-muted">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-theme-muted pointer-events-none" />
                <input
                  type="text"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search issues…"
                  className="input pl-8 pr-3 py-1.5 w-64 text-[12px]"
                />
              </div>
              <span>Project:</span>
              <select
                value={projectFilter}
                onChange={e => setProjectFilter(e.target.value)}
                className="input py-1.5 text-[12px] w-auto"
              >
                <option value="">All projects</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <span>Assignee:</span>
              <select
                value={assigneeFilter}
                onChange={e => setAssigneeFilter(e.target.value)}
                className="input py-1.5 text-[12px] w-auto"
              >
                <option value="any">Any</option>
                <option value="unassigned">Unassigned</option>
                {linearAssignees.map(u => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </select>
              <div className="flex-1" />
              <span className="text-[11px] font-mono">{totalShown} of {issues.length}</span>
            </div>

            {/* Issue groups — list view */}
            {viewMode === 'list' && (
              <div className="space-y-3">
                {STATUS_GROUPS.map(g => {
                  const list = grouped.get(g.type) ?? [];
                  if (list.length === 0) return null;
                  const collapsed = collapsedGroups.has(g.type);
                  return (
                    <div key={g.type} className="card overflow-hidden">
                      <button
                        onClick={() => toggleGroupCollapsed(g.type)}
                        className="w-full flex items-center gap-2 px-3.5 py-2 text-left bg-app-muted hover:bg-app-muted/80 border-b border-app transition-colors"
                      >
                        {collapsed ? <ChevronRight className="w-3.5 h-3.5 text-theme-muted" /> : <ChevronDown className="w-3.5 h-3.5 text-theme-muted" />}
                        <span className="text-[13px] font-medium text-theme-primary">{g.label}</span>
                        <span className="text-[11px] font-mono text-theme-muted">{list.length} issue{list.length !== 1 ? 's' : ''}</span>
                      </button>
                      {!collapsed && (
                        <div className="divide-y divide-border">
                          {list.map(issue => (
                            <TicketRow
                              key={issue.id}
                              issue={issue}
                              active={issue.id === selectedId}
                              onSelect={() => setSelectedId(issue.id)}
                              onDispatch={() => setDispatchFor(issue)}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
                {!listLoading && filteredIssues.length === 0 && (
                  <div className="rounded-xl border border-dashed border-app p-12 text-center text-[12px] text-theme-muted font-body italic">
                    No tickets match the current filters.
                  </div>
                )}
                {listLoading && issues.length === 0 && (
                  <div className="flex items-center gap-2 text-[11px] font-mono text-theme-muted py-6 px-2">
                    <Loader2 className="w-3 h-3 animate-spin" /> Loading from Linear…
                  </div>
                )}
              </div>
            )}

            {/* Board view — Kanban columns by status */}
            {viewMode === 'board' && (
              <div className="flex gap-3 overflow-x-auto pb-3">
                {STATUS_GROUPS.map(g => {
                  const list = grouped.get(g.type) ?? [];
                  return (
                    <div key={g.type} className="w-[300px] shrink-0 flex flex-col card overflow-hidden">
                      <div className="flex items-center gap-2 px-3 py-2 bg-app-muted border-b border-app shrink-0">
                        <span className="text-[13px] font-medium text-theme-primary">{g.label}</span>
                        <span className="text-[11px] font-mono text-theme-muted">{list.length}</span>
                      </div>
                      <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-[200px]">
                        {list.length === 0 && (
                          <div className="text-[11px] text-theme-subtle italic font-body py-4 text-center">
                            No issues
                          </div>
                        )}
                        {list.map(issue => (
                          <BoardCard
                            key={issue.id}
                            issue={issue}
                            active={issue.id === selectedId}
                            onSelect={() => setSelectedId(issue.id)}
                            onDispatch={() => setDispatchFor(issue)}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
                {!listLoading && filteredIssues.length === 0 && (
                  <div className="rounded-xl border border-dashed border-app p-12 text-center text-[12px] text-theme-muted font-body italic w-full">
                    No tickets match the current filters.
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Drawer */}
        {selectedId && (
          <div className="w-[32rem] shrink-0 border-l border-app bg-app-muted/50 overflow-y-auto min-h-0 flex flex-col">
            {detailLoading && !detail ? (
              <div className="p-6 flex items-center gap-2 text-[11px] font-mono text-theme-muted">
                <Loader2 className="w-3 h-3 animate-spin" /> Loading…
              </div>
            ) : detail ? (
              <TicketDrawer
                issue={detail}
                onClose={() => { setSelectedId(null); setDetail(null); }}
                onDispatch={() => setDispatchFor(detail)}
                onClearAssignment={() => handleClearAssignment(detail.id)}
                navigate={navigate}
              />
            ) : (
              <div className="p-6 text-[12px] text-theme-muted">Not found.</div>
            )}
          </div>
        )}
      </div>

      {/* Dispatch modal */}
      {dispatchFor && (
        <DispatchModal
          open={true}
          issue={{ id: dispatchFor.id, identifier: dispatchFor.identifier, title: dispatchFor.title, description: dispatchFor.description ?? null }}
          currentAgent={dispatchFor.agentAssignee?.agentName ?? null}
          agents={agentOptions}
          teams={teamOptions}
          workflows={workflowList}
          workflowsLoading={workflowsLoading}
          repos={repos}
          reposLoading={reposLoading}
          onClose={() => setDispatchFor(null)}
          onSubmit={(args) => handleDispatch(dispatchFor, args)}
        />
      )}
    </div>
  );
}


// ── Row component ───────────────────────────────────────────────────────────

function AssignmentPill({ assignee, onClick }: { assignee: AgentAssignee | null; onClick: () => void }) {
  if (!assignee) {
    return (
      <button
        onClick={onClick}
        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-mono bg-app-muted text-theme-muted hover:bg-accent-green/10 hover:text-accent-green border border-app hover:border-accent-green/40 transition-colors"
      >
        <Sparkles className="w-3 h-3" /> Dispatch
      </button>
    );
  }
  const status = assignee.status ?? 'manual';
  const tone =
    status === 'running' ? 'bg-accent-green/10 text-accent-green border-accent-green/30'
    : status === 'pending' ? 'bg-accent-yellow/10 text-accent-yellow border-accent-yellow/30'
    : status === 'failed' ? 'bg-accent-red/10 text-accent-red border-accent-red/30'
    : 'bg-accent-soft text-accent border-accent/30';
  const icon =
    status === 'running' ? <Play className="w-3 h-3" />
    : status === 'pending' ? <Loader2 className="w-3 h-3 animate-spin" />
    : status === 'failed' ? <AlertCircle className="w-3 h-3" />
    : <Sparkles className="w-3 h-3" />;
  const label =
    status === 'running' ? 'running'
    : status === 'pending' ? 'starting'
    : status === 'failed' ? 'failed'
    : null;
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-mono border transition-colors hover:brightness-110 ${tone}`}
      title={status === 'failed' ? assignee.error : `Dispatched to ${assignee.agentName}${label ? ` · ${label}` : ''}`}
    >
      {icon}
      <span className="truncate max-w-[8rem]">{assignee.agentName}</span>
      {label && <span className="text-current/60">· {label}</span>}
    </button>
  );
}

function TicketRow({
  issue, active, onSelect, onDispatch,
}: {
  issue: LinearIssue;
  active: boolean;
  onSelect: () => void;
  onDispatch: () => void;
}) {
  return (
    <div className={`flex items-center gap-3 px-3 py-2.5 transition-colors cursor-pointer ${active ? 'bg-accent-soft' : 'hover:bg-app-muted/50'}`}>
      <div className="shrink-0" title={issue.priorityLabel}>
        <PriorityIcon p={issue.priority} />
      </div>
      <button onClick={onSelect} className="flex-1 min-w-0 text-left flex items-center gap-3">
        <span className="text-[10px] font-mono text-theme-subtle shrink-0 w-20 truncate">{issue.identifier}</span>
        <span className="flex-1 min-w-0">
          <span className="text-[13px] text-theme-primary font-body truncate block">{issue.title}</span>
        </span>
      </button>
      <div className="flex items-center gap-1.5 shrink-0">
        {issue.labels.slice(0, 2).map(l => (
          <span
            key={l.id}
            className="text-[9px] font-mono px-1.5 py-0.5 rounded border"
            style={{ color: l.color, borderColor: l.color + '60', backgroundColor: l.color + '15' }}
          >
            {l.name}
          </span>
        ))}
        {issue.labels.length > 2 && (
          <span className="text-[9px] text-theme-subtle font-mono">+{issue.labels.length - 2}</span>
        )}
      </div>
      <div className="shrink-0" onClick={e => e.stopPropagation()}>
        <AssignmentPill assignee={issue.agentAssignee} onClick={onDispatch} />
      </div>
      <span className="text-[10px] font-mono text-theme-subtle shrink-0 w-16 text-right">{relative(issue.updatedAt)}</span>
    </div>
  );
}

// ── Board card (Kanban) ─────────────────────────────────────────────────────

function BoardCard({
  issue, active, onSelect, onDispatch,
}: {
  issue: LinearIssue;
  active: boolean;
  onSelect: () => void;
  onDispatch: () => void;
}) {
  return (
    <div
      onClick={onSelect}
      className={`card-hover p-2.5 cursor-pointer flex flex-col gap-1.5 ${
        active ? 'border-accent shadow-sm' : ''
      }`}
    >
      <div className="flex items-center gap-1.5">
        <PriorityIcon p={issue.priority} />
        <span className="text-[10.5px] font-mono text-theme-muted">{issue.identifier}</span>
        <span className="flex-1" />
        {issue.project && (
          <span className="text-[10px] font-mono text-theme-subtle truncate max-w-[100px]" title={issue.project.name}>
            {issue.project.name}
          </span>
        )}
      </div>
      <div className="text-[12.5px] text-theme-primary leading-snug line-clamp-2 font-body">
        {issue.title}
      </div>
      {issue.labels.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap">
          {issue.labels.slice(0, 3).map(l => (
            <span
              key={l.id}
              className="text-[9.5px] font-mono px-1.5 py-px rounded bg-app-muted text-theme-secondary"
              style={{ borderLeft: `2px solid ${l.color}` }}
            >
              {l.name}
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between gap-2 mt-0.5" onClick={e => e.stopPropagation()}>
        <AssignmentPill assignee={issue.agentAssignee} onClick={onDispatch} />
        <span className="text-[10px] font-mono text-theme-subtle">{relative(issue.updatedAt)}</span>
      </div>
    </div>
  );
}

// ── Drawer component ────────────────────────────────────────────────────────

function TicketDrawer({
  issue, onClose, onDispatch, onClearAssignment, navigate,
}: {
  issue: LinearIssue;
  onClose: () => void;
  onDispatch: () => void;
  onClearAssignment: () => void;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const assignee = issue.agentAssignee;
  const status = assignee?.status ?? 'manual';

  const statusTone =
    status === 'running' ? 'bg-accent-green/10 text-accent-green border-accent-green/30'
    : status === 'pending' ? 'bg-accent-yellow/10 text-accent-yellow border-accent-yellow/30'
    : status === 'failed' ? 'bg-accent-red/10 text-accent-red border-accent-red/30'
    : 'bg-accent-soft text-accent border-accent/30';

  const statusLabel =
    status === 'running' ? 'Agent is working'
    : status === 'pending' ? 'Workspace is being created…'
    : status === 'failed' ? 'Dispatch failed'
    : 'Assigned (not yet started)';

  return (
    <>
      <div className="px-5 py-4 border-b border-app flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-mono text-theme-subtle">{issue.identifier}</span>
          {issue.project && (
            <span className="text-[11px] font-mono text-theme-muted">· {issue.project.name}</span>
          )}
        </div>
        <button onClick={onClose} className="p-1.5 rounded-md text-theme-muted hover:text-theme-primary hover:bg-app-muted">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="px-5 py-4 border-b border-app shrink-0 space-y-3">
        <h3 className="font-heading text-base font-bold text-theme-primary tracking-wide leading-snug">{issue.title}</h3>
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono border"
            style={{ color: issue.state.color, borderColor: issue.state.color + '60', backgroundColor: issue.state.color + '15' }}
          >
            {issue.state.name}
          </span>
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono bg-app-muted text-theme-muted border border-app">
            <PriorityIcon p={issue.priority} /> {issue.priorityLabel}
          </span>
          {issue.labels.map(l => (
            <span
              key={l.id}
              className="text-[9px] font-mono px-1.5 py-0.5 rounded border"
              style={{ color: l.color, borderColor: l.color + '60', backgroundColor: l.color + '15' }}
            >
              {l.name}
            </span>
          ))}
        </div>
      </div>

      <div className="px-5 py-4 border-b border-app shrink-0 space-y-3">
        <div>
          <div className="overline mb-1.5">Agent assignment</div>
          {assignee ? (
            <div className={`rounded-lg border px-3 py-2 space-y-2 ${statusTone}`}>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  {status === 'pending' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                  <span className="text-[13px] font-mono font-semibold truncate">{assignee.agentName}</span>
                </div>
                <span className="text-[10px] font-mono opacity-80">{statusLabel}</span>
              </div>
              <div className="text-[10px] font-mono text-theme-subtle">
                by {assignee.assignedBy} · {relative(assignee.assignedAt)}
                {assignee.branch && <> · branch <span className="text-theme-muted">{assignee.branch}</span></>}
              </div>
              {assignee.error && (
                <div className="text-[10px] font-mono text-accent-red break-words">{assignee.error}</div>
              )}
              <div className="flex items-center gap-2 pt-1">
                {assignee.workspaceId && (
                  <button
                    onClick={() => navigate(`/workspaces/${assignee.workspaceId}`)}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono bg-surface-100/50 text-theme-secondary hover:bg-surface-100"
                  >
                    Open workspace →
                  </button>
                )}
                {assignee.executionId && (
                  <button
                    onClick={() => navigate(`/executions/${assignee.executionId}`)}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono bg-surface-100/50 text-theme-secondary hover:bg-surface-100"
                  >
                    View execution →
                  </button>
                )}
                <button
                  onClick={onDispatch}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono bg-surface-100/50 text-theme-secondary hover:bg-surface-100"
                >
                  Re-dispatch
                </button>
                <button
                  onClick={onClearAssignment}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono bg-surface-100/50 text-theme-muted hover:bg-accent-red/10 hover:text-accent-red"
                >
                  Clear
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={onDispatch}
              className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[11px] font-mono bg-accent-green/10 text-accent-green hover:bg-accent-green/20 border border-accent-green/30 transition-colors"
            >
              <Sparkles className="w-3 h-3" /> Dispatch to an agent
            </button>
          )}
        </div>
        {issue.linearAssignee && (
          <div>
            <div className="overline mb-1">Linear assignee</div>
            <div className="text-[11px] font-mono text-theme-secondary">{issue.linearAssignee.name}{issue.linearAssignee.email ? ` · ${issue.linearAssignee.email}` : ''}</div>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 px-5 py-4">
        <div className="overline mb-3">Description</div>
        {issue.description ? (
          <div className="text-[13px] text-theme-secondary leading-relaxed prose-allen">
            {renderMarkdown(issue.description)}
          </div>
        ) : (
          <div className="text-[11px] text-theme-muted italic">No description.</div>
        )}

        <div className="mt-6 overline mb-2">Metadata</div>
        <div className="space-y-1 text-[11px] font-mono text-theme-muted">
          <div>Team: <span className="text-theme-secondary">{issue.team.name}</span></div>
          {issue.project && <div>Project: <span className="text-theme-secondary">{issue.project.name}</span></div>}
          <div className="inline-flex items-center gap-1">
            <Clock className="w-3 h-3" /> Updated {relative(issue.updatedAt)} · Created {relative(issue.createdAt)}
          </div>
        </div>
      </div>

      <div className="px-5 py-4 border-t border-app shrink-0 flex items-center gap-2">
        <a
          href={issue.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-full text-[11px] font-mono bg-app-muted text-theme-muted hover:bg-app-muted transition-colors"
        >
          <ExternalLink className="w-3 h-3" /> Open in Linear
        </a>
      </div>
    </>
  );
}

