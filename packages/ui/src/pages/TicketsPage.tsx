import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { McpPresetConnectModal } from '../components/settings/McpServerManager';
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
import Select from '../components/common/Select';
import {
  AlertCircle, ChevronDown, ChevronRight, Circle, Clock, ExternalLink,
  FolderGit2, KeyRound, Loader2, MinusCircle, Play, RefreshCw, Search, X, Sparkles, CheckCircle,
  List as ListIcon, LayoutGrid, TicketCheck,
} from 'lucide-react';
import IconTooltipButton from '../components/common/IconTooltipButton';

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

export interface LinearIssue {
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

function integrationErrorMessage(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message : String(err ?? '');
  if (!message || message === 'fetch failed' || message.includes('Failed to fetch')) return fallback;
  return message;
}

function dispatchTargetLabel(target: DispatchTarget | null): string {
  if (!target) return 'auto';
  if (target.kind === 'workflow') return `workflow: ${target.workflowName}`;
  if (target.kind === 'team-lead') return `team lead: ${target.agentName} (${target.teamName})`;
  return `agent: ${target.name}`;
}

export function compactWorkflowInputForPrompt(
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

export function buildChatDispatchPrompt(
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
  const lines: (string | null | (string | null)[])[] = [
    'Dispatch this Linear ticket through Allen.',
    '',
    `${issue.identifier} · ${issue.title}`,
    `URL: ${issue.url}`,
    `Status: ${issue.state?.name ?? 'unknown'}`,
    issue.priorityLabel ? `Priority: ${issue.priorityLabel}` : null,
    args.repoName ? `Repo: ${args.repoName}` : null,
    `Dispatch preference: ${dispatchTargetLabel(args.target)}`,
    args.extraInstructions ? `Extra instructions: ${args.extraInstructions}` : null,
    '',
    'Description:',
    issue.description?.trim() || '(no description)',
    args.promptTemplate ? ['', 'Target-specific prompt override:', args.promptTemplate] : null,
    workflowInputOverrides
      ? ['', 'Workflow input overrides:', '```json', JSON.stringify(workflowInputOverrides, null, 2), '```']
      : null,
    '',
    'Please move the issue to In Progress if needed, route to the best workflow/lead/specialist, create or reuse a workspace for code changes, and keep progress visible here with links.',
  ];
  return lines.flat().filter((line): line is string => line != null).join('\n');
}

export default function TicketsPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { agents } = useAgents();
  const [teams, setTeams] = useState<any[]>([]);

  const [showLinearModal, setShowLinearModal] = useState(false);
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
  const [viewMode, setViewMode] = useState<'list' | 'board'>('board');
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
      setStatus({
        configured: false,
        error: integrationErrorMessage(err, 'Allen could not check the Linear connection.'),
      });
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
      const error = integrationErrorMessage(err, 'Linear could not be reached. Check your network connection or Linear status, then retry.');
      setStatus(prev => ({ configured: prev?.configured ?? true, workspaceName: prev?.workspaceName, workspaceUrlKey: prev?.workspaceUrlKey, error }));
      setProjects([]);
    }
  }, []);

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
      // Cast: linear.issues() returns LinearIssueSummary[] (chat-mention minimal type);
      // the real API response includes all LinearIssue fields — safe at runtime.
      setIssues((list ?? []) as unknown as LinearIssue[]);
    } catch (err) {
      const error = integrationErrorMessage(err, 'Linear could not be reached. Check your network connection or Linear status, then retry.');
      setStatus(prev => ({ configured: prev?.configured ?? true, workspaceName: prev?.workspaceName, workspaceUrlKey: prev?.workspaceUrlKey, error }));
      setIssues([]);
    } finally {
      setListLoading(false);
    }
  }, [projectFilter, stateFilters, search]);

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

  const assigneeOptions = useMemo(
    () => [
      { value: 'any', label: 'Any assignee' },
      { value: 'unassigned', label: 'Unassigned' },
      ...linearAssignees.map(user => ({ value: user.id, label: user.name })),
    ],
    [linearAssignees],
  );

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

  const projectOptions = useMemo(
    () => [
      { value: '', label: 'All projects' },
      ...filteredProjects.map(project => ({
        value: project.id,
        label: project.name,
        sublabel: project.description || undefined,
      })),
    ],
    [filteredProjects],
  );

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
      <div className="content scroll-hide !p-0 h-full bg-app" data-screen-label="linear-tickets">
        <div className="flex h-full w-full items-center justify-center gap-2 px-8 py-8 font-mono text-[11px] text-theme-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking Linear connection...
        </div>
      </div>
    );
  }

  if (!status?.configured) {
    const statusCheckFailed = Boolean(status?.error);
    return (
      <div className="content scroll-hide !p-0 h-full bg-app" data-screen-label="linear-tickets">
        <div className="flex min-h-full w-full items-center justify-center px-8 py-8">
        <div className="w-full max-w-[480px] rounded-md border border-app bg-app-card px-6 py-8 text-center">
          <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-md border border-app bg-app text-accent">
            <AlertCircle className="h-5 w-5" />
          </span>
          <div>
            <h2 className="mt-5 text-[17px] font-semibold text-theme-primary">
              {statusCheckFailed ? 'Could not check Linear' : 'Linear is not connected'}
            </h2>
            <p className="mt-2 text-[13px] text-theme-muted">
              {statusCheckFailed
                ? status?.error
                : 'Add a Linear API token to Allen before tickets can be synced and dispatched.'}
            </p>
          </div>
          {!statusCheckFailed && (
            <div className="mt-5 inline-flex items-center gap-2 rounded-md border border-app bg-app px-3 py-2 font-mono text-[11px] text-accent">
              <KeyRound className="h-3.5 w-3.5" /> ALLEN_LINEAR_ACCESS_TOKEN
            </div>
          )}
          <div className="mt-6 flex items-center justify-center gap-2">
            {!statusCheckFailed && (
              <button
                onClick={() => setShowLinearModal(true)}
                className="inline-flex h-9 items-center gap-2 rounded-md bg-accent px-3 text-[13px] font-medium text-white transition-colors hover:bg-accent-hover"
                type="button"
              >
                Connect Linear
              </button>
            )}
            <button
              onClick={loadStatus}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-app bg-app px-3 text-[13px] font-medium text-theme-secondary transition-colors hover:border-app-strong hover:text-theme-primary"
              type="button"
            >
              <RefreshCw className="h-3.5 w-3.5" /> {statusCheckFailed ? 'Retry' : 'Recheck'}
            </button>
          </div>
        </div>
        </div>
        {showLinearModal && (
          <McpPresetConnectModal
            presetName="linear"
            onClose={() => setShowLinearModal(false)}
            onConnected={() => {
              setShowLinearModal(false);
              void loadStatus();
            }}
          />
        )}
      </div>
    );
  }

  if (status.configured && status.error) {
    return (
      <div className="content scroll-hide !p-0 h-full bg-app" data-screen-label="linear-tickets">
        <div className="flex min-h-full w-full items-center justify-center px-8 py-8">
        <div className="w-full max-w-[480px] rounded-md border border-accent-red/30 bg-accent-red/5 px-6 py-8 text-center">
          <AlertCircle className="mx-auto h-6 w-6 text-accent-red" />
          <h2 className="mt-4 text-[17px] font-semibold text-theme-primary">Could not reach Linear</h2>
          <p className="mt-2 text-[13px] text-theme-muted">{status.error}</p>
          <div className="mt-5 flex items-center justify-center gap-2">
            <button
              onClick={loadStatus}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-app bg-app px-3 text-[13px] font-medium text-theme-secondary transition-colors hover:border-app-strong hover:text-theme-primary"
              type="button"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Retry
            </button>
          </div>
        </div>
        </div>
      </div>
    );
  }

  const totalShown = topTab === 'running' ? runningIssues.length + recentCompletedIssues.length : filteredIssues.length;
  const activeCount = issues.filter(i => i.state.type === 'started' || i.state.type === 'unstarted').length;
  const runningCount = issues.filter(i => isActiveRun(i.agentAssignee) || isCompletedRun(i.agentAssignee)).length;

  return (
    <div className="content scroll-hide !p-0 bg-app" data-screen-label="linear-tickets">
      <div className="flex h-full w-full flex-col px-8 py-8">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-md border border-app bg-app-card text-theme-muted">
              <TicketCheck className="h-[18px] w-[18px]" />
            </span>
            <div>
              <h1 className="text-[24px] font-semibold leading-tight text-theme-primary">Linear</h1>
              <p className="mt-1 text-[13px] text-theme-muted">
                {status.workspaceName ?? 'Linear'} tickets ready for triage, dispatch, and follow-up.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex h-9 items-center rounded-md border border-app bg-app-card p-1">
              <button
                onClick={() => setViewMode('list')}
                className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium transition-colors ${
                  viewMode === 'list' ? 'bg-app-muted text-theme-primary' : 'text-theme-muted hover:text-theme-primary'
                }`}
                type="button"
              >
                <ListIcon className="h-3.5 w-3.5" /> List
              </button>
              <button
                onClick={() => setViewMode('board')}
                className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium transition-colors ${
                  viewMode === 'board' ? 'bg-app-muted text-theme-primary' : 'text-theme-muted hover:text-theme-primary'
                }`}
                type="button"
              >
                <LayoutGrid className="h-3.5 w-3.5" /> Board
              </button>
            </div>
            <button
              onClick={() => { void loadStatus(); void loadProjects(); void loadIssues(); }}
              disabled={listLoading}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-accent px-3 text-[13px] font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              type="button"
            >
              {listLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Refresh
            </button>
          </div>
        </div>

        <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-app bg-app-card px-3 py-2">
          <div className="flex items-center gap-1">
          {([
            { id: 'all', label: 'All', count: issues.length },
            { id: 'active', label: 'Active', count: activeCount },
            { id: 'running', label: 'Running', count: runningCount },
            { id: 'done', label: 'Done' },
          ] as { id: TopTab; label: string; count?: number }[]).map(t => (
            <button
              key={t.id}
              onClick={() => setTopTab(t.id)}
              className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12px] font-medium transition-colors ${
                topTab === t.id
                  ? 'bg-app-muted text-theme-primary shadow-sm'
                  : 'text-theme-muted hover:text-theme-primary'
              }`}
              type="button"
            >
              {t.label}
              {t.count != null && <span className="font-mono text-[11px] text-theme-muted">{t.count}</span>}
            </button>
          ))}
          </div>
          <span className="font-mono text-[11px] text-theme-muted">{totalShown} shown</span>
        </div>

      {/* ── Filter row + main list ──────────────────────────────────────── */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div className="min-h-0 w-full overflow-y-auto">
          <div className="space-y-4">
            {/* Filter row */}
            <div className="flex flex-wrap items-center gap-3 rounded-md border border-app bg-app-card px-3 py-3 text-[12px] text-theme-muted">
              <div className="relative min-w-[260px] flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-theme-muted" />
                <input
                  type="text"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search issues…"
                  className="h-9 w-full rounded-md border border-app bg-app-muted pl-8 pr-3 text-[13px] text-theme-primary outline-none transition-colors placeholder:text-theme-subtle focus:border-accent focus:shadow-[var(--focus-ring)]"
                />
              </div>
              <Select
                value={projectFilter}
                onChange={setProjectFilter}
                options={projectOptions}
                placeholder="All projects"
                searchPlaceholder="Search projects..."
                className="w-[220px]"
              />
              <Select
                value={assigneeFilter}
                onChange={(value) => setAssigneeFilter(value as 'any' | 'unassigned' | string)}
                options={assigneeOptions}
                placeholder="Any assignee"
                searchPlaceholder="Search assignees..."
                className="w-[200px]"
              />
              <span className="ml-auto font-mono text-[11px] text-theme-muted">{totalShown} of {issues.length}</span>
            </div>

            {topTab === 'running' ? (
              <div className="space-y-3">
                <div className="overflow-hidden rounded-md border border-app bg-app-card">
                  <div className="flex items-center justify-between gap-2 border-b border-app px-4 py-3">
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
                <div className="overflow-hidden rounded-md border border-app bg-app-card">
                  <div className="flex items-center justify-between gap-2 border-b border-app px-4 py-3">
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
                    <div key={g.key} className="overflow-hidden rounded-md border border-app bg-app-card">
                      <button
                        onClick={() => toggleGroupCollapsed(g.key)}
                        className="flex w-full items-center gap-2 border-b border-app px-4 py-3 text-left transition-colors hover:bg-app-muted/40"
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
                  <div className="rounded-md border border-dashed border-app bg-app-card p-12 text-center text-[13px] text-theme-muted">
                    No tickets match the current filters.
                  </div>
                )}
                {listLoading && issues.length === 0 && (
                  <div className="flex items-center gap-2 text-[11px] font-mono text-theme-muted py-6 px-2">
                    <Loader2 className="w-3 h-3 animate-spin" /> Loading from Linear...
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
                    <div key={g.key} className="flex w-[300px] shrink-0 flex-col overflow-hidden rounded-md border border-app bg-app-card">
                      <div className="flex shrink-0 items-center gap-2 border-b border-app px-3 py-2.5">
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
                  <div className="w-full rounded-md border border-dashed border-app bg-app-card p-12 text-center text-[13px] text-theme-muted">
                    No tickets match the current filters.
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

      </div>

      {/* Drawer */}
      {selectedId && (
        <div className="fixed bottom-0 right-0 top-0 z-50 flex w-[32rem] max-w-[calc(100vw-2rem)] flex-col border-l border-app bg-app-card shadow-[-24px_0_60px_rgba(0,0,0,0.28)]">
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
    </div>
  );
}


// ── Row component ───────────────────────────────────────────────────────────

function AssignmentPill({ assignee, onClick }: { assignee: AgentAssignee | null; onClick: () => void }) {
  if (!assignee) {
    return (
      <button
        onClick={onClick}
        className="inline-flex h-7 items-center gap-1 rounded-md border border-app bg-app px-2.5 font-mono text-[10.5px] text-theme-muted transition-colors hover:border-accent-green/40 hover:bg-accent-green/10 hover:text-accent-green"
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
    : 'border-accent/30 bg-accent/10 text-accent';
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
      className={`inline-flex h-7 items-center gap-1 rounded-md border px-2.5 font-mono text-[10.5px] transition-colors hover:brightness-110 ${tone}`}
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
    <div className="space-y-2 rounded-md border border-app bg-app px-3 py-2">
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
    <div className={`flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors ${active ? 'bg-accent/10' : 'hover:bg-app-muted/35'}`}>
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
          className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[9.5px]"
          style={{ color: issue.state.color, borderColor: issue.state.color + '60', backgroundColor: issue.state.color + '15' }}
        >
          {issue.state.name}
        </span>
        {issue.labels.slice(0, 2).map(l => (
          <span
            key={l.id}
            className="rounded-md border px-1.5 py-0.5 font-mono text-[9.5px]"
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
      className={`flex cursor-pointer flex-col gap-2 rounded-md border bg-app px-3 py-3 transition-colors hover:border-app-strong hover:bg-app-muted/25 ${
        active ? 'border-accent shadow-sm' : 'border-app'
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
          className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[9.5px]"
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
              className="rounded-md border px-1.5 py-0.5 font-mono text-[9.5px]"
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
    : 'border-accent/30 bg-accent/10 text-accent';

  const statusLabel =
    status === 'running' ? (isWorkflowRun ? 'Workflow is running' : 'Agent is working')
    : status === 'pending' ? (isWorkflowRun ? 'Workflow is queued…' : 'Workspace is being created…')
    : status === 'failed' ? 'Dispatch failed'
    : status === 'completed' ? 'Completed'
    : 'Assigned (not yet started)';

  return (
    <>
      <div className="flex shrink-0 items-center justify-between border-b border-app px-5 py-4">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-mono text-theme-subtle">{issue.identifier}</span>
          {issue.project && (
            <span className="text-[11px] font-mono text-theme-muted">· {issue.project.name}</span>
          )}
        </div>
        <IconTooltipButton label="Close" onClick={onClose} className="h-8 w-8">
          <X className="w-4 h-4" />
        </IconTooltipButton>
      </div>
      <div className="shrink-0 space-y-3 border-b border-app px-5 py-4">
        <h3 className="text-[16px] font-semibold leading-snug text-theme-primary">{issue.title}</h3>
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-[10px]"
            style={{ color: issue.state.color, borderColor: issue.state.color + '60', backgroundColor: issue.state.color + '15' }}
          >
            {issue.state.name}
          </span>
          <span className="inline-flex items-center gap-1 rounded-md border border-app bg-app px-2 py-0.5 font-mono text-[10px] text-theme-muted">
            <PriorityIcon p={issue.priority} /> {issue.priorityLabel}
          </span>
          {issue.labels.map(l => (
            <span
              key={l.id}
              className="rounded-md border px-1.5 py-0.5 font-mono text-[9.5px]"
              style={{ color: l.color, borderColor: l.color + '60', backgroundColor: l.color + '15' }}
            >
              {l.name}
            </span>
          ))}
        </div>
      </div>

      <div className="shrink-0 space-y-3 border-b border-app px-5 py-4">
        <div>
          <div className="mb-1.5 font-mono text-[10.5px] uppercase tracking-[0.16em] text-theme-muted">Ticket run</div>
          {assignee ? (
            <div className={`space-y-3 rounded-md border px-3 py-3 ${statusTone}`}>
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
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border border-accent/25 bg-accent/10 px-2.5 font-mono text-[10.5px] text-accent transition-colors hover:border-accent/40 hover:bg-accent/15"
                  >
                    <FolderGit2 className="h-3.5 w-3.5" />
                    Open workspace
                  </button>
                )}
                {assignee.executionId && (
                  <button
                    onClick={() => navigate(`/executions/${assignee.executionId}`)}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border border-accent-green/30 bg-accent-green/10 px-2.5 font-mono text-[10.5px] text-accent-green transition-colors hover:border-accent-green/45 hover:bg-accent-green/15"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    View {isWorkflowRun ? 'workflow' : 'agent'} execution
                  </button>
                )}
                <button
                  onClick={onDispatch}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-accent-yellow/30 bg-accent-yellow/10 px-2.5 font-mono text-[10.5px] text-accent-yellow transition-colors hover:border-accent-yellow/45 hover:bg-accent-yellow/15"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Re-dispatch
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={onDispatch}
              className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-md border border-accent-green/30 bg-accent-green/10 px-3 font-mono text-[11px] text-accent-green transition-colors hover:bg-accent-green/20"
            >
              <Sparkles className="w-3 h-3" /> Dispatch to an agent
            </button>
          )}
        </div>
        {issue.linearAssignee && (
          <div>
            <div className="mb-1 font-mono text-[10.5px] uppercase tracking-[0.16em] text-theme-muted">Linear assignee</div>
            <div className="text-[11px] font-mono text-theme-secondary">{issue.linearAssignee.name}{issue.linearAssignee.email ? ` · ${issue.linearAssignee.email}` : ''}</div>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="mb-3 font-mono text-[10.5px] uppercase tracking-[0.16em] text-theme-muted">Description</div>
        {issue.description ? (
          <div className="text-[13px] text-theme-secondary leading-relaxed prose-allen">
            {renderMarkdown(issue.description)}
          </div>
        ) : (
          <div className="text-[11px] text-theme-muted italic">No description.</div>
        )}

        <div className="mb-2 mt-6 font-mono text-[10.5px] uppercase tracking-[0.16em] text-theme-muted">Metadata</div>
        <div className="space-y-1 text-[11px] font-mono text-theme-muted">
          <div>Team: <span className="text-theme-secondary">{issue.team.name}</span></div>
          {issue.project && <div>Project: <span className="text-theme-secondary">{issue.project.name}</span></div>}
          <div className="inline-flex items-center gap-1">
            <Clock className="w-3 h-3" /> Updated {relative(issue.updatedAt)} · Created {relative(issue.createdAt)}
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-app px-5 py-4">
        <a
          href={issue.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-app bg-app px-3 font-mono text-[11px] text-theme-muted transition-colors hover:border-app-strong hover:text-theme-primary"
        >
          <ExternalLink className="w-3 h-3" /> Open in Linear
        </a>
      </div>
    </>
  );
}
