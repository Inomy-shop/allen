import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  linear as linearApi,
  teams as teamsApi,
  repos as reposApi,
  workflows as workflowsApi,
} from '../services/api';
import { useAgents } from '../hooks/useAgents';
import { useRunContext } from '../hooks/useRunContext';
import { useToast } from '../components/common/Toast';
import { renderMarkdown } from '../components/chat/ChatMessageList';
import { type AgentOption, type TeamOption } from '../components/agents/AgentAssignDropdown';
import DispatchModal, { type DispatchTarget, type WorkflowOption } from '../components/linear/DispatchModal';
import RunStatusCard from '../components/executions/RunStatusCard';
import {
  AlertCircle, ChevronDown, ChevronRight, Circle, Clock, ExternalLink,
  FolderGit2, KeyRound, Loader2, MinusCircle, Play, RefreshCw, Search, X, Sparkles, CheckCircle,
  List as ListIcon, LayoutGrid,
} from 'lucide-react';

type StateType = 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled' | 'triage';

type AssignmentStatus = 'manual' | 'pending' | 'running' | 'failed' | 'completed';

interface AgentAssignee {
  linearIssueId: string;
  agentName?: string;
  targetKind?: 'agent' | 'workflow';
  targetName?: string;
  workflowId?: string;
  workflowName?: string;
  assignedAt: string;
  assignedBy: string;
  status?: AssignmentStatus;
  workspaceId?: string;
  workspacePath?: string;
  executionId?: string;
  executionStatus?: string | null;
  error?: string | null;
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

const STATE_TYPE_ORDER: Record<string, number> = {
  backlog: 0,
  unstarted: 1,
  triage: 2,
  started: 3,
  completed: 4,
  canceled: 5,
};

interface IssueStateGroup {
  key: string;
  label: string;
  color: string;
  type: string;
  issues: LinearIssue[];
}

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

function runTargetKind(assignee: AgentAssignee | null): 'agent' | 'workflow' {
  return assignee?.targetKind === 'workflow' ? 'workflow' : 'agent';
}

function runTargetName(assignee: AgentAssignee | null): string {
  if (!assignee) return '';
  return assignee.targetName ?? assignee.agentName ?? assignee.workflowName ?? 'Unknown';
}

function isActiveRun(assignee: AgentAssignee | null): boolean {
  return !!assignee && (assignee.status === 'pending' || assignee.status === 'running');
}

function isCompletedRun(assignee: AgentAssignee | null): boolean {
  return assignee?.status === 'completed';
}

function compareRunRecency(a: LinearIssue, b: LinearIssue): number {
  const aTime = a.agentAssignee?.assignedAt ? new Date(a.agentAssignee.assignedAt).getTime() : 0;
  const bTime = b.agentAssignee?.assignedAt ? new Date(b.agentAssignee.assignedAt).getTime() : 0;
  return bTime - aTime;
}

function dispatchTargetLabel(target: DispatchTarget | null): string {
  if (!target) return 'auto';
  if (target.kind === 'workflow') return `workflow: ${target.workflowName}`;
  if (target.kind === 'team-lead') return `team lead: ${target.agentName} (${target.teamName})`;
  return `agent: ${target.name}`;
}

function compactWorkflowInputForPrompt(
  issue: LinearIssue,
  input?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!input) return undefined;
  const seedTask = `[${issue.identifier}] ${issue.title}${issue.description ? `\n\n${issue.description}` : ''}`;
  const duplicateByKey: Record<string, string[]> = {
    task: [seedTask, issue.title, issue.description ?? ''],
    topic: [seedTask, issue.title, issue.description ?? ''],
    description: [seedTask, issue.description ?? '', issue.title],
    user_request: [seedTask, issue.description ?? '', issue.title],
    bug_report: [seedTask, issue.description ?? '', issue.title],
    ticket_id: [issue.identifier, issue.id],
    identifier: [issue.identifier],
    title: [issue.title],
    ticket_url: [issue.url],
    url: [issue.url],
  };
  const compact = Object.fromEntries(
    Object.entries(input).filter(([key, value]) => {
      if (value == null || value === '') return false;
      const normalized = typeof value === 'string' ? value.trim() : value;
      if (typeof normalized !== 'string') return true;
      const duplicates = duplicateByKey[key] ?? [];
      return !duplicates.some(item => item.trim() === normalized);
    }),
  );
  return Object.keys(compact).length > 0 ? compact : undefined;
}

function buildChatDispatchPrompt(
  issue: LinearIssue,
  args: {
    target: DispatchTarget | null;
    repoId: string;
    repoName?: string;
    repoPath?: string;
    extraInstructions: string;
    promptTemplate?: string;
    workflowInput?: Record<string, unknown>;
  },
): string {
  const workflowInputOverrides = compactWorkflowInputForPrompt(issue, args.workflowInput);
  const lines = [
    'Dispatch this Linear ticket through Allen.',
    '',
    'Ticket:',
    `- Identifier: ${issue.identifier}`,
    `- Linear issue id: ${issue.id}`,
    `- Title: ${issue.title}`,
    `- URL: ${issue.url}`,
    `- Current status: ${issue.state?.name ?? 'unknown'} (${issue.state?.type ?? 'unknown'})`,
    issue.project ? `- Project: ${issue.project.name}` : null,
    issue.team ? `- Team: ${issue.team.name} (${issue.team.key})` : null,
    issue.priorityLabel ? `- Priority: ${issue.priorityLabel}` : null,
    issue.linearAssignee ? `- Linear assignee: ${issue.linearAssignee.name}` : null,
    issue.labels.length > 0 ? `- Labels: ${issue.labels.map(label => label.name).join(', ')}` : null,
    '',
    'Description:',
    issue.description?.trim() || '(no description)',
    '',
    'User dispatch preference:',
    `- Selected target: ${dispatchTargetLabel(args.target)}`,
    `- Target kind: ${args.target?.kind ?? 'auto'}`,
    args.repoId ? `- Repo id: ${args.repoId}` : '- Repo id: not selected',
    args.repoName ? `- Repo name: ${args.repoName}` : null,
    args.repoPath ? `- Repo path: ${args.repoPath}` : null,
    args.extraInstructions ? `- Extra instructions: ${args.extraInstructions}` : '- Extra instructions: none',
    args.promptTemplate ? ['', 'Target-specific prompt override:', args.promptTemplate] : null,
    workflowInputOverrides ? ['', 'Workflow input overrides:', '```json', JSON.stringify(workflowInputOverrides, null, 2), '```'] : null,
    '',
    'Instructions:',
    '1. First update the Linear ticket status from Backlog/Todo/Unstarted to In Progress if it is not already in progress.',
    '2. Decide the best route. If a target was selected, use it as a preference, but override it if another available workflow, lead agent, or specialist agent is clearly better. If target kind is auto, choose from available workflows, lead agents, and specialists yourself.',
    '3. Use a matching workflow if available; if the chosen workflow has a workspace/create-workspace step, do not create a separate workspace first. Pass the ticket, repo, and dispatch context into the workflow and let the workflow create or reuse its workspace.',
    '4. If assigning a lead agent or specialist agent directly and code changes are required, create or reuse a workspace before assigning implementation work.',
    '5. Otherwise use a lead agent for multi-agent work, or the best specialist agent for single-agent work.',
    '6. Keep progress visible in this chat with execution, workspace, and PR links when available.',
    '7. If human input is needed, ask clearly in this chat.',
  ];
  return lines.flat().filter((line): line is string => line != null).join('\n');
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
    new Set<StateType>(['backlog', 'unstarted', 'started']),
  );
  const [assigneeFilter, setAssigneeFilter] = useState<'any' | 'unassigned' | string>('any');
  const [search, setSearch] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

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
  type TopTab = 'all' | 'active' | 'done' | 'running';
  const [topTab, setTopTab] = useState<TopTab>('all');
  const [viewMode, setViewMode] = useState<'list' | 'board'>('list');
  useEffect(() => {
    if (topTab === 'active') setStateFilters(new Set<StateType>(['started', 'unstarted']));
    else if (topTab === 'done') setStateFilters(new Set<StateType>(['completed']));
    else if (topTab === 'running') setStateFilters(new Set<StateType>(['backlog', 'unstarted', 'started', 'completed', 'canceled']));
    else setStateFilters(new Set<StateType>(['backlog', 'unstarted', 'started', 'completed', 'canceled']));
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
    let next = issues;
    if (assigneeFilter === 'unassigned') next = next.filter(i => !i.linearAssignee);
    else if (assigneeFilter !== 'any') next = next.filter(i => i.linearAssignee?.id === assigneeFilter);
    return next;
  }, [issues, assigneeFilter]);

  const runningIssues = useMemo(
    () => filteredIssues.filter(i => isActiveRun(i.agentAssignee)).sort(compareRunRecency),
    [filteredIssues],
  );

  const recentCompletedIssues = useMemo(
    () => filteredIssues.filter(i => isCompletedRun(i.agentAssignee)).sort(compareRunRecency).slice(0, 12),
    [filteredIssues],
  );

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
  const groupedStateSections = useMemo(() => {
    const m = new Map<string, IssueStateGroup>();
    for (const issue of filteredIssues) {
      const key = issue.state?.id || issue.state?.name || 'unknown';
      if (!m.has(key)) {
        m.set(key, {
          key,
          label: issue.state?.name || 'Unknown',
          color: issue.state?.color || '#999',
          type: issue.state?.type || 'backlog',
          issues: [],
        });
      }
      m.get(key)!.issues.push(issue);
    }
    return Array.from(m.values()).sort((a, b) => {
      const typeDelta = (STATE_TYPE_ORDER[a.type] ?? 999) - (STATE_TYPE_ORDER[b.type] ?? 999);
      if (typeDelta !== 0) return typeDelta;
      return a.label.localeCompare(b.label);
    });
  }, [filteredIssues]);

  function toggleGroupCollapsed(t: string) {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }

  async function handleDispatch(
    issue: LinearIssue,
    args: {
      target: DispatchTarget | null;
      repoId: string;
      extraInstructions: string;
      promptTemplate?: string;
      workflowInput?: Record<string, unknown>;
    },
  ) {
    const repo = repos.find(r => String(r._id) === args.repoId);
    const prompt = buildChatDispatchPrompt(issue, {
      ...args,
      repoName: repo?.name,
      repoPath: repo?.path,
    });
    setDispatchFor(null);
    toast.success(`Opening chat to dispatch ${issue.identifier}`);
    const params = new URLSearchParams({
      autosend: '1',
      prompt,
    });
    if (args.repoId) params.set('repoId', args.repoId);
    navigate(`/chat?${params.toString()}`);
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
              Add a Linear API token to Allen's <code className="font-mono">.env</code> under the key:
            </p>
          </div>
          <div className="inline-flex items-center gap-2 px-3 py-2 rounded-md bg-app-muted border border-app text-[11px] font-mono text-accent">
            <KeyRound className="w-3.5 h-3.5" /> ALLEN_LINEAR_ACCESS_TOKEN
          </div>
          <p className="text-[11px] text-theme-muted font-body">
            Then restart the Allen server.
          </p>
          <div className="flex items-center justify-center gap-2 pt-2">
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

  const totalShown = topTab === 'running' ? runningIssues.length + recentCompletedIssues.length : filteredIssues.length;
  const activeCount = issues.filter(i => i.state.type === 'started' || i.state.type === 'unstarted').length;
  const runningCount = issues.filter(i => isActiveRun(i.agentAssignee) || isCompletedRun(i.agentAssignee)).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ── Top bar (matches handoff/pages/remaining.jsx LinearV2) ──────── */}
      <div className="surface-bar pb-0 shrink-0">
        <div className="page-crumb">
          <span>Sources</span>
          <span className="text-theme-subtle">/</span>
          <span>Tickets</span>
        </div>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <h1 className="page-title">Tickets</h1>
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
            { id: 'running', label: 'Running', count: runningCount },
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

            {topTab === 'running' ? (
              <div className="space-y-3">
                <div className="card overflow-hidden">
                  <div className="flex items-center justify-between gap-2 border-b border-app bg-app-muted px-3.5 py-2">
                    <div>
                      <div className="text-[13px] font-medium text-theme-primary">Running now</div>
                      <div className="text-[10px] font-mono text-theme-muted">Pending and active ticket runs</div>
                    </div>
                    <span className="text-[11px] font-mono text-theme-muted">{runningIssues.length}</span>
                  </div>
                  {runningIssues.length > 0 ? (
                    <div className="divide-y divide-border">
                      {runningIssues.map(issue => (
                        <TicketRow
                          key={issue.id}
                          issue={issue}
                          active={issue.id === selectedId}
                          onSelect={() => setSelectedId(issue.id)}
                          onDispatch={() => setDispatchFor(issue)}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="px-4 py-8 text-center text-[12px] italic text-theme-muted">
                      No ticket runs are active right now.
                    </div>
                  )}
                </div>
                <div className="card overflow-hidden">
                  <div className="flex items-center justify-between gap-2 border-b border-app bg-accent-green/5 px-3.5 py-2">
                    <div>
                      <div className="text-[13px] font-medium text-theme-primary">Recent completed</div>
                      <div className="text-[10px] font-mono text-theme-muted">Latest successful ticket runs</div>
                    </div>
                    <span className="text-[11px] font-mono text-theme-muted">{recentCompletedIssues.length}</span>
                  </div>
                  {recentCompletedIssues.length > 0 ? (
                    <div className="divide-y divide-border">
                      {recentCompletedIssues.map(issue => (
                        <TicketRow
                          key={issue.id}
                          issue={issue}
                          active={issue.id === selectedId}
                          onSelect={() => setSelectedId(issue.id)}
                          onDispatch={() => setDispatchFor(issue)}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="px-4 py-8 text-center text-[12px] italic text-theme-muted">
                      No completed ticket runs yet.
                    </div>
                  )}
                </div>
              </div>
            ) : viewMode === 'list' && (
              <div className="space-y-3">
                {groupedStateSections.map(g => {
                  const list = g.issues;
                  if (list.length === 0) return null;
                  const collapsed = collapsedGroups.has(g.key);
                  return (
                    <div key={g.key} className="card overflow-hidden">
                      <button
                        onClick={() => toggleGroupCollapsed(g.key)}
                        className="w-full flex items-center gap-2 px-3.5 py-2 text-left bg-app-muted hover:bg-app-muted/80 border-b border-app transition-colors"
                      >
                        {collapsed ? <ChevronRight className="w-3.5 h-3.5 text-theme-muted" /> : <ChevronDown className="w-3.5 h-3.5 text-theme-muted" />}
                        <span
                          className="inline-flex items-center gap-2 text-[13px] font-medium text-theme-primary"
                        >
                          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: g.color }} />
                          {g.label}
                        </span>
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
                {groupedStateSections.map(g => {
                  const list = g.issues;
                  return (
                    <div key={g.key} className="w-[300px] shrink-0 flex flex-col card overflow-hidden">
                      <div className="flex items-center gap-2 px-3 py-2 bg-app-muted border-b border-app shrink-0">
                        <span className="inline-flex items-center gap-2 text-[13px] font-medium text-theme-primary">
                          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: g.color }} />
                          {g.label}
                        </span>
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
          currentAgent={runTargetKind(dispatchFor.agentAssignee) === 'agent' ? (dispatchFor.agentAssignee?.agentName ?? dispatchFor.agentAssignee?.targetName ?? null) : null}
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
  const kind = runTargetKind(assignee);
  const targetName = runTargetName(assignee);
  const tone =
    status === 'running' ? 'bg-accent/10 text-accent border-accent/30'
    : status === 'pending' ? 'bg-accent-yellow/10 text-accent-yellow border-accent-yellow/30'
    : status === 'failed' ? 'bg-accent-red/10 text-accent-red border-accent-red/30'
    : status === 'completed' ? 'bg-accent-green/10 text-accent-green border-accent-green/30'
    : 'bg-accent-soft text-accent border-accent/30';
  const icon =
    status === 'running' ? <Play className="w-3 h-3" />
    : status === 'pending' ? <Loader2 className="w-3 h-3 animate-spin" />
    : status === 'failed' ? <AlertCircle className="w-3 h-3" />
    : status === 'completed' ? <CheckCircle className="w-3 h-3" />
    : <Sparkles className="w-3 h-3" />;
  const label =
    status === 'running' ? 'running'
    : status === 'pending' ? 'starting'
    : status === 'failed' ? 'failed'
    : status === 'completed' ? 'done'
    : null;
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-mono border transition-colors hover:brightness-110 ${tone}`}
      title={status === 'failed' ? (assignee.error ?? undefined) : `${kind === 'workflow' ? 'Workflow' : 'Agent'} ${targetName}${label ? ` · ${label}` : ''}`}
    >
      {icon}
      <span className="truncate max-w-[8rem]">{targetName}</span>
      {label && <span className="text-current/60">· {label}</span>}
    </button>
  );
}

type RunStepState = 'done' | 'current' | 'pending' | 'failed';

function StepIndicator({ state }: { state: RunStepState }) {
  if (state === 'done') return <CheckCircle className="h-4 w-4 text-accent-green" />;
  if (state === 'current') return <Loader2 className="h-4 w-4 animate-spin text-accent" />;
  if (state === 'failed') return <AlertCircle className="h-4 w-4 text-accent-red" />;
  return <Circle className="h-4 w-4 text-theme-subtle" />;
}

function TicketRunSteps({ assignee }: { assignee: AgentAssignee }) {
  const isWorkflowRun = runTargetKind(assignee) === 'workflow';
  const status = assignee.status ?? 'manual';
  const hasExecution = !!assignee.executionId;

  const steps = isWorkflowRun
    ? [
        {
          label: 'Ticket dispatched',
          detail: `Sent to ${runTargetName(assignee)}`,
          state: 'done' as RunStepState,
        },
        {
          label: 'Execution started',
          detail: assignee.executionId ? `Execution ${assignee.executionId}` : 'Waiting for execution to start',
          state: (
            status === 'failed' ? 'failed'
            : status === 'completed' ? 'done'
            : status === 'pending' || status === 'running' ? 'current'
            : 'pending'
          ) as RunStepState,
        },
        {
          label: 'Execution completed',
          detail: status === 'completed' ? 'Finished successfully' : 'Completion pending',
          state: (status === 'completed' ? 'done' : 'pending') as RunStepState,
        },
      ]
    : [
        {
          label: 'Ticket dispatched',
          detail: `Assigned to ${runTargetName(assignee)}`,
          state: 'done' as RunStepState,
        },
        {
          label: 'Worktree prepared',
          detail: assignee.workspaceId ? `Workspace ${assignee.workspaceId}` : 'Waiting for workspace reservation',
          state: (
            status === 'failed' && !hasExecution ? 'failed'
            : hasExecution || status === 'completed' ? 'done'
            : status === 'pending' ? 'current'
            : 'pending'
          ) as RunStepState,
        },
        {
          label: 'Parent agent started',
          detail: assignee.executionId ? `Execution ${assignee.executionId}` : 'Waiting for agent startup',
          state: (
            status === 'failed' && hasExecution ? 'failed'
            : status === 'completed' ? 'done'
            : status === 'running' ? 'current'
            : 'pending'
          ) as RunStepState,
        },
        {
          label: 'Execution completed',
          detail: status === 'completed' ? 'Finished successfully' : 'Completion pending',
          state: (status === 'completed' ? 'done' : 'pending') as RunStepState,
        },
      ];

  return (
    <div className="space-y-2 rounded-lg border border-app/70 bg-black/5 px-3 py-2">
      {steps.map(step => (
        <div key={step.label} className="flex items-start gap-2.5">
          <div className="pt-0.5">
            <StepIndicator state={step.state} />
          </div>
          <div className="min-w-0">
            <div className="text-[11px] font-mono text-theme-primary">{step.label}</div>
            <div className="text-[10px] font-mono text-theme-subtle break-all">{step.detail}</div>
          </div>
        </div>
      ))}
    </div>
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
        <span
          className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-mono"
          style={{ color: issue.state.color, borderColor: issue.state.color + '60', backgroundColor: issue.state.color + '15' }}
        >
          {issue.state.name}
        </span>
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
      <div className="flex items-center gap-1.5">
        <span
          className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-mono"
          style={{ color: issue.state.color, borderColor: issue.state.color + '60', backgroundColor: issue.state.color + '15' }}
        >
          {issue.state.name}
        </span>
      </div>
      {issue.labels.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {issue.labels.slice(0, 3).map(l => (
            <span
              key={l.id}
              className="text-[9px] font-mono px-1.5 py-0.5 rounded border"
              style={{ color: l.color, borderColor: l.color + '60', backgroundColor: l.color + '15' }}
            >
              {l.name}
            </span>
          ))}
          {issue.labels.length > 3 && (
            <span className="text-[9px] text-theme-subtle font-mono">+{issue.labels.length - 3}</span>
          )}
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
  issue, onClose, onDispatch, navigate,
}: {
  issue: LinearIssue;
  onClose: () => void;
  onDispatch: () => void;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const assignee = issue.agentAssignee;
  const status = assignee?.status ?? 'manual';
  const targetKind = runTargetKind(assignee);
  const targetName = runTargetName(assignee);
  const isWorkflowRun = targetKind === 'workflow';
  const { runContext, loading: runContextLoading, error: runContextError } = useRunContext(assignee?.executionId);

  const statusTone =
    status === 'running' ? 'bg-accent/10 text-accent border-accent/30'
    : status === 'pending' ? 'bg-accent-yellow/10 text-accent-yellow border-accent-yellow/30'
    : status === 'failed' ? 'bg-accent-red/10 text-accent-red border-accent-red/30'
    : status === 'completed' ? 'bg-accent-green/10 text-accent-green border-accent-green/30'
    : 'bg-accent-soft text-accent border-accent/30';

  const statusLabel =
    status === 'running' ? (isWorkflowRun ? 'Workflow is running' : 'Agent is working')
    : status === 'pending' ? (isWorkflowRun ? 'Workflow is queued…' : 'Workspace is being created…')
    : status === 'failed' ? 'Dispatch failed'
    : status === 'completed' ? 'Completed'
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
          <div className="overline mb-1.5">Ticket run</div>
          {assignee ? (
            <div className={`rounded-lg border px-3 py-2 space-y-2 ${statusTone}`}>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  {status === 'pending' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : status === 'completed' ? <CheckCircle className="w-3.5 h-3.5" /> : status === 'running' ? <Play className="w-3.5 h-3.5" /> : status === 'failed' ? <AlertCircle className="w-3.5 h-3.5" /> : <Sparkles className="w-3.5 h-3.5" />}
                  <span className="text-[13px] font-mono font-semibold truncate">{targetName}</span>
                </div>
                <span className="text-[10px] font-mono opacity-80">{statusLabel}</span>
              </div>
              <div className="text-[10px] font-mono text-theme-subtle">
                by {assignee.assignedBy} · {relative(assignee.assignedAt)}
                {isWorkflowRun && assignee.workflowId && <> · workflow <span className="text-theme-muted">{assignee.workflowName ?? assignee.workflowId}</span></>}
                {assignee.branch && <> · branch <span className="text-theme-muted">{assignee.branch}</span></>}
              </div>
              {assignee.executionId && (
                <RunStatusCard
                  context={runContext}
                  loading={runContextLoading}
                  error={runContextError}
                  title="Live execution"
                  compact
                />
              )}
              <TicketRunSteps assignee={assignee} />
              {assignee.error && (
                <div className="text-[10px] font-mono text-accent-red break-words">{assignee.error}</div>
              )}
              <div className="flex items-center gap-2 pt-1">
                {assignee.workspaceId && (
                  <button
                    onClick={() => navigate(`/workspaces/${assignee.workspaceId}`)}
                    className="inline-flex items-center gap-1.5 rounded-full border border-accent/25 bg-accent/10 px-2.5 py-1 text-[10px] font-mono text-accent transition-colors hover:bg-accent/15 hover:border-accent/40"
                  >
                    <FolderGit2 className="h-3.5 w-3.5" />
                    Open workspace
                  </button>
                )}
                {assignee.executionId && (
                  <button
                    onClick={() => navigate(`/executions/${assignee.executionId}`)}
                    className="inline-flex items-center gap-1.5 rounded-full border border-accent-green/30 bg-accent-green/10 px-2.5 py-1 text-[10px] font-mono text-accent-green transition-colors hover:bg-accent-green/15 hover:border-accent-green/45"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    View {isWorkflowRun ? 'workflow' : 'agent'} execution
                  </button>
                )}
                <button
                  onClick={onDispatch}
                  className="inline-flex items-center gap-1.5 rounded-full border border-accent-yellow/30 bg-accent-yellow/10 px-2.5 py-1 text-[10px] font-mono text-accent-yellow transition-colors hover:bg-accent-yellow/15 hover:border-accent-yellow/45"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Re-dispatch
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
