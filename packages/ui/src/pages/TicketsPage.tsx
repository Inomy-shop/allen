import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { linear as linearApi, teams as teamsApi, repos as reposApi } from '../services/api';
import { useAgents } from '../hooks/useAgents';
import { useToast } from '../components/common/Toast';
import { renderMarkdown } from '../components/chat/ChatMessageList';
import AgentAssignDropdown, { type AgentOption, type TeamOption } from '../components/agents/AgentAssignDropdown';
import DispatchModal from '../components/linear/DispatchModal';
import {
  AlertCircle, ChevronDown, ChevronRight, Circle, Clock, ExternalLink,
  KeyRound, Loader2, MinusCircle, Play, RefreshCw, Search, Settings, X, Sparkles,
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

  // Filter by agent assignee locally
  const filteredIssues = useMemo(() => {
    if (assigneeFilter === 'any') return issues;
    if (assigneeFilter === 'unassigned') return issues.filter(i => !i.agentAssignee);
    return issues.filter(i => i.agentAssignee?.agentName === assigneeFilter);
  }, [issues, assigneeFilter]);

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

  async function handleDispatch(issue: LinearIssue, args: { agentName: string; repoId: string; extraInstructions: string }) {
    const { assignment } = await linearApi.dispatch(issue.id, args);
    setIssues(prev => prev.map(i => i.id === issue.id ? { ...i, agentAssignee: assignment } : i));
    if (detail?.id === issue.id) setDetail({ ...detail, agentAssignee: assignment });
    toast.success(`Dispatching ${args.agentName} to ${issue.identifier}…`);
    setDispatchFor(null);
    // Refresh the detail view after a beat so the user sees the workspace link once the setup finishes
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

  return (
    <div className="flex h-full min-h-0">
      {/* ── Sidebar ──────────────────────────────────────────────────────── */}
      <aside className="w-72 shrink-0 border-r border-app bg-app-muted/40 flex flex-col min-h-0">
        <div className="px-4 py-4 border-b border-app">
          <h1 className="text-[14px] font-semibold text-theme-primary tracking-tight">Linear</h1>
          <div className="mt-1.5 flex items-center gap-2 text-[11px] font-mono text-theme-muted">
            <span className="inline-flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-accent-green" /> {status.workspaceName ?? 'Linear'}
            </span>
            <span>·</span>
            <span>{issues.length} issues</span>
          </div>
        </div>

        <div className="px-4 py-3 border-b border-app">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-theme-subtle pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search projects and issues…"
              className="input text-xs pl-8 pr-3 py-1.5 w-full"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0 px-4 py-3 space-y-5">
          {/* Projects */}
          <div>
            <div className="overline mb-2">Projects</div>
            <button
              onClick={() => setProjectFilter('')}
              className={`w-full flex items-center justify-between px-2 py-1.5 rounded-md text-[11px] font-mono transition-colors ${
                projectFilter === ''
                  ? 'bg-accent-soft text-accent'
                  : 'text-theme-secondary hover:bg-app-muted'
              }`}
            >
              <span>★ All projects</span>
              <span className="text-theme-subtle">{issues.length}</span>
            </button>
            {filteredProjects.map(p => (
              <button
                key={p.id}
                onClick={() => setProjectFilter(p.id)}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] font-mono transition-colors ${
                  projectFilter === p.id
                    ? 'bg-accent-soft text-accent'
                    : 'text-theme-secondary hover:bg-app-muted'
                }`}
                title={p.description || p.name}
              >
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: p.color ?? '#888' }}
                />
                <span className="truncate flex-1 text-left">{p.name}</span>
              </button>
            ))}
            {search.trim() && filteredProjects.length === 0 && (
              <div className="text-[10px] text-theme-subtle italic font-body py-1.5">
                No projects match "{search}".
              </div>
            )}
            {!search.trim() && projects.length === 0 && (
              <div className="text-[10px] text-theme-subtle italic font-body py-1.5">No projects.</div>
            )}
          </div>

          {/* Status */}
          <div>
            <div className="overline mb-2">Status</div>
            {STATUS_GROUPS.map(g => (
              <label
                key={g.type}
                className="flex items-center gap-2 px-2 py-1 rounded-md cursor-pointer text-[11px] font-mono text-theme-secondary hover:bg-app-muted"
              >
                <input
                  type="checkbox"
                  checked={stateFilters.has(g.type)}
                  onChange={() => toggleStateFilter(g.type)}
                  className="accent-violet-500"
                />
                <span className="flex-1">{g.label}</span>
                <span className="text-theme-subtle">{grouped.get(g.type)?.length ?? 0}</span>
              </label>
            ))}
          </div>

          {/* Assignee */}
          <div>
            <div className="overline mb-2">Agent assignee</div>
            <div className="space-y-0.5">
              <button
                onClick={() => setAssigneeFilter('any')}
                className={`w-full text-left px-2 py-1 rounded-md text-[11px] font-mono transition-colors ${
                  assigneeFilter === 'any' ? 'bg-accent-soft text-accent' : 'text-theme-secondary hover:bg-app-muted'
                }`}
              >
                Any
              </button>
              <button
                onClick={() => setAssigneeFilter('unassigned')}
                className={`w-full text-left px-2 py-1 rounded-md text-[11px] font-mono transition-colors ${
                  assigneeFilter === 'unassigned' ? 'bg-accent-soft text-accent' : 'text-theme-secondary hover:bg-app-muted'
                }`}
              >
                Unassigned
              </button>
              <div className="pt-1">
                <AgentAssignDropdown
                  value={assigneeFilter === 'any' || assigneeFilter === 'unassigned' ? null : assigneeFilter}
                  onChange={(name) => setAssigneeFilter(name ?? 'any')}
                  agents={agentOptions}
                  teams={teamOptions}
                  placeholder="Pick an agent…"
                  size="input"
                  allowClear={false}
                />
              </div>
            </div>
          </div>

          <button
            onClick={() => { setSearch(''); setProjectFilter(''); setAssigneeFilter('any'); setStateFilters(new Set(['backlog', 'unstarted', 'started', 'triage'])); }}
            className="w-full text-[10px] font-mono text-theme-muted hover:text-theme-primary text-left"
          >
            Clear filters
          </button>
        </div>

        <div className="p-3 border-t border-app">
          <button
            onClick={() => { void loadStatus(); void loadProjects(); void loadIssues(); }}
            disabled={listLoading}
            className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[11px] font-mono bg-accent-soft text-accent hover:bg-accent/20 disabled:opacity-50"
          >
            {listLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            Refresh from Linear
          </button>
        </div>
      </aside>

      {/* ── Main list ───────────────────────────────────────────────────── */}
      <main className="flex-1 overflow-y-auto min-h-0">
        <div className="p-6">
          <div className="flex items-center justify-between mb-5">
            <div>
              <h2 className="text-[18px] font-semibold text-theme-primary tracking-tight">
                {projectFilter
                  ? (projects.find(p => p.id === projectFilter)?.name ?? 'Project')
                  : 'All Tickets'}
              </h2>
              <div className="text-[10px] font-mono text-theme-muted mt-0.5">
                {totalShown} visible · grouped by status
              </div>
            </div>
          </div>

          {listLoading && issues.length === 0 ? (
            <div className="flex items-center gap-2 text-[11px] font-mono text-theme-muted">
              <Loader2 className="w-3 h-3 animate-spin" /> Loading from Linear…
            </div>
          ) : filteredIssues.length === 0 ? (
            <div className="rounded-xl border border-dashed border-app p-12 text-center text-[12px] text-theme-muted font-body italic">
              No tickets match the current filters.
            </div>
          ) : (
            <div className="space-y-5">
              {STATUS_GROUPS.map(g => {
                const list = grouped.get(g.type) ?? [];
                if (list.length === 0) return null;
                const collapsed = collapsedGroups.has(g.type);
                return (
                  <div key={g.type}>
                    <button
                      onClick={() => toggleGroupCollapsed(g.type)}
                      className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-surface-200/20 rounded-md transition-colors mb-1"
                    >
                      {collapsed ? <ChevronRight className="w-3.5 h-3.5 text-theme-muted" /> : <ChevronDown className="w-3.5 h-3.5 text-theme-muted" />}
                      <span className="overline font-semibold">{g.label}</span>
                      <span className="text-[10px] font-mono text-theme-subtle">{list.length}</span>
                    </button>
                    {!collapsed && (
                      <div className="rounded-lg border border-app divide-y divide-border/20 overflow-hidden">
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
            </div>
          )}
        </div>
      </main>

      {/* ── Drawer ──────────────────────────────────────────────────────── */}
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

      {/* Dispatch modal */}
      {dispatchFor && (
        <DispatchModal
          open={true}
          issue={{ id: dispatchFor.id, identifier: dispatchFor.identifier, title: dispatchFor.title }}
          currentAgent={dispatchFor.agentAssignee?.agentName ?? null}
          agents={agentOptions}
          teams={teamOptions}
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

