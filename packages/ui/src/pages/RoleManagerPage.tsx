import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAgents } from '../hooks/useAgents';
import { agents as agentsApi, teams as teamsApi, repos as reposApi } from '../services/api';
import RoleIcon from '../components/common/RoleIcon';
import RoleDialog from '../components/common/RoleDialog';
import DeleteConfirmDialog from '../components/common/DeleteConfirmDialog';
import { useToast } from '../components/common/Toast';
import { renderMarkdown } from '../components/chat/ChatMessageList';
import {
  RefreshCw, Sparkles, Users, Crown, Search, Play, ArrowRight,
  X, FolderGit2, Plus, Pencil, Trash2, LayoutGrid, Info, Home,
  ChevronRight,
} from 'lucide-react';
import { DelegationGraph } from '../components/agents/DelegationGraph';
import {
  ImportAgentsFromRepoDialog,
  AssignToTeamDialog,
  CreateTeamFromAgentsDialog,
} from '../components/agents/ImportAndTeamDialogs';
import {
  TeamDialog,
  TeamDeleteConfirm,
  type Team,
  type TeamDialogMode,
} from '../components/agents/TeamDialogs';
import { AgentCard } from '../components/agents/AgentCard';

type Agent = Record<string, unknown>;
type Selection = { kind: 'overview' } | { kind: 'team'; name: string } | { kind: 'unassigned' };

// ── Agent detail panel (markdown viewer) ──────────────────────────────────

function AgentDetailPanel({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const system = (agent.system as string) ?? '';
  const capabilities = (agent.capabilities as string[] | undefined) ?? [];
  const delegateTargets = (agent.canDelegateTo as string[] | undefined) ?? [];
  const tools = (agent.tools as string[] | undefined) ?? [];

  const provider = String(agent.provider ?? 'claude');
  const model = String(agent.model ?? 'sonnet');
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-6" onClick={onClose}>
      <div className="card w-full max-w-5xl h-[92vh] overflow-hidden shadow-popover animate-in fade-in zoom-in-95 duration-200 flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="px-7 py-5 border-b border-app shrink-0">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-4 min-w-0">
              <div
                className="w-14 h-14 rounded-xl flex items-center justify-center border border-app shrink-0"
                style={{ backgroundColor: ((agent.color as string) ?? '#666') + '18' }}
              >
                <RoleIcon icon={agent.icon as string} color={agent.color as string} size={30} />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="text-[18px] font-semibold text-theme-primary tracking-tight truncate">
                    {(agent.displayName as string) ?? (agent.name as string)}
                  </h2>
                  {agent.teamRole === 'lead' && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-mono bg-accent-yellow/10 text-accent-yellow border border-accent-yellow/30">
                      <Crown className="w-3 h-3" /> Lead
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <span className="text-[11px] text-theme-subtle font-mono">{agent.name as string}</span>
                  {agent.teamName ? (
                    <span className="text-[11px] font-mono text-theme-muted">· team: <span className="text-theme-secondary">{String(agent.teamName)}</span></span>
                  ) : null}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <div
                className={`rounded-lg border overflow-hidden text-center ${
                  provider === 'codex' ? 'bg-accent-green/10 text-accent-green border-accent-green/30'
                  : provider === 'openai' ? 'bg-accent-green/10 text-accent-green border-emerald-500/30'
                  : 'bg-accent-blue/10 text-accent-blue border-accent-blue/30'
                }`}
                style={{ minWidth: '8rem' }}
              >
                <div className="overline px-3 py-1 border-b border-current/20 opacity-80">{provider}</div>
                <div className="text-xs font-mono px-3 py-1.5 text-theme-primary bg-app-muted/50">{model}</div>
              </div>
              <button onClick={onClose} className="p-2 rounded-md hover:bg-surface-200 text-theme-muted hover:text-theme-secondary transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        {/* Metadata strip */}
        {(capabilities.length > 0 || tools.length > 0 || delegateTargets.length > 0) && (
          <div className="px-7 py-3 border-b border-app flex items-center gap-5 flex-wrap shrink-0 bg-surface-200/15">
            {capabilities.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="overline">Capabilities:</span>
                <div className="flex items-center gap-1 flex-wrap">
                  {capabilities.map(cap => (
                    <span key={cap} className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-accent-purple/8 text-accent-purple/80 border border-accent-purple/20">{cap}</span>
                  ))}
                </div>
              </div>
            )}
            {tools.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="overline">Tools:</span>
                <span className="text-[11px] text-theme-secondary font-mono">{tools.join(', ')}</span>
              </div>
            )}
            {delegateTargets.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="overline">Delegates to:</span>
                <span className="text-[11px] text-theme-secondary font-mono">{delegateTargets.join(', ')}</span>
              </div>
            )}
          </div>
        )}

        {/* System instructions — big, readable reader */}
        <div className="flex-1 overflow-y-auto min-h-0">
          <div className="max-w-3xl mx-auto px-8 py-8">
            <div className="flex items-center gap-2 mb-5">
              <div className="h-px flex-1 bg-border/40" />
              <div className="overline font-semibold">
                Agent Instructions · README.md
              </div>
              <div className="h-px flex-1 bg-border/40" />
            </div>
            {system ? (
              <div className="text-[15px] text-theme-secondary leading-[1.75] prose-allen prose-lg">
                {renderMarkdown(system)}
              </div>
            ) : (
              <div className="text-center py-16 text-theme-muted italic font-body">
                No system prompt defined for this agent.
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-7 py-4 border-t border-app bg-surface-200/10 shrink-0 flex items-center justify-between">
          <div className="text-[10px] font-mono text-theme-subtle">
            Read-only view. Use Edit to modify.
          </div>
          <button onClick={onClose} className="btn-ghost text-xs">Close</button>
        </div>
      </div>
    </div>
  );
}

// ── Run-agent dialog ────────────────────────────────────────────────────────

function RunAgentDialog({
  agent, onClose, onStarted,
}: {
  agent: Agent;
  onClose: () => void;
  onStarted: (executionId: string) => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [repoId, setRepoId] = useState<string>('');
  const [repoList, setRepoList] = useState<any[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    setLoadingRepos(true);
    reposApi.list()
      .then((list: any[]) => {
        if (cancelled) return;
        const repos = (list ?? []).slice().sort((a, b) =>
          String(a.name ?? '').localeCompare(String(b.name ?? '')),
        );
        setRepoList(repos);
        // Pre-select the agent's source repo if it matches a known repo
        const sourceId = (agent.sourceRepoId as string | undefined) ?? '';
        const sourcePath = (agent.sourceRepoPath as string | undefined) ?? '';
        const matched = repos.find(r =>
          (sourceId && String(r._id) === sourceId)
          || (sourcePath && r.path === sourcePath),
        );
        if (matched) setRepoId(String(matched._id));
      })
      .catch(() => setRepoList([]))
      .finally(() => { if (!cancelled) setLoadingRepos(false); });
    return () => { cancelled = true; };
  }, [agent]);

  const selectedRepo = repoList.find(r => String(r._id) === repoId);

  async function submit() {
    const trimmed = prompt.trim();
    if (!trimmed) { toast.error('Prompt is required'); return; }
    setSubmitting(true);
    try {
      const result = await agentsApi.run(agent.name as string, {
        prompt: trimmed,
        repo_path: selectedRepo?.path || undefined,
      });
      if (result.error) { toast.error(result.error); setSubmitting(false); return; }
      toast.success(`Agent "${agent.name as string}" started.`);
      onStarted(result.execution_id);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to start agent');
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md" onClick={onClose}>
      <div className="card w-full max-w-2xl shadow-popover animate-in fade-in zoom-in-95 duration-200" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-5 border-b border-app">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-lg flex items-center justify-center border border-app"
                style={{ backgroundColor: ((agent.color as string) ?? '#666') + '15' }}
              >
                <RoleIcon icon={agent.icon as string} color={agent.color as string} size={22} />
              </div>
              <div>
                <h2 className="text-[14px] font-semibold text-theme-primary tracking-tight">
                  Run {(agent.displayName as string) ?? (agent.name as string)}
                </h2>
                <div className="text-[10px] text-theme-subtle font-mono mt-0.5">{agent.name as string}</div>
              </div>
            </div>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-app-muted transition-colors">
              <X className="w-4 h-4 text-theme-muted" />
            </button>
          </div>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-[10px] font-mono text-theme-muted uppercase tracking-wider mb-1.5">Prompt</label>
            <textarea
              autoFocus
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit(); }}
              rows={8}
              placeholder="Describe the task for the agent…"
              className="w-full px-3 py-2 rounded-lg bg-app-muted border border-app text-sm text-theme-primary placeholder:text-theme-subtle focus:outline-none focus:border-accent-blue/50"
            />
          </div>
          <div>
            <label className="block text-[10px] font-mono text-theme-muted uppercase tracking-wider mb-1.5">
              Repository <span className="text-theme-subtle normal-case">(optional)</span>
            </label>
            <select
              value={repoId}
              onChange={e => setRepoId(e.target.value)}
              disabled={loadingRepos}
              className="w-full px-3 py-2 rounded-lg bg-app-muted border border-app text-sm text-theme-primary focus:outline-none focus:border-accent-blue/50 disabled:opacity-50"
            >
              <option value="">
                {loadingRepos ? 'Loading repos…' : '— No repository (agent runs without a repo) —'}
              </option>
              {repoList.map(r => (
                <option key={String(r._id)} value={String(r._id)}>
                  {r.name}{r.path ? ` · ${r.path}` : ''}
                </option>
              ))}
            </select>
            {selectedRepo?.path && (
              <div className="mt-1.5 text-[10px] font-mono text-theme-subtle">
                Path: <span className="text-theme-muted">{selectedRepo.path}</span>
              </div>
            )}
            {!loadingRepos && repoList.length === 0 && (
              <div className="mt-1.5 text-[10px] font-mono text-theme-muted italic">
                No repos registered. Add one on the Repos page to attach it here.
              </div>
            )}
          </div>
        </div>
        <div className="px-6 py-4 border-t border-app flex items-center justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-[11px] font-mono text-theme-muted hover:text-theme-primary hover:bg-app-muted transition-colors">Cancel</button>
          <button
            onClick={submit}
            disabled={submitting || !prompt.trim()}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-[11px] font-mono bg-accent-green/10 text-accent-green hover:bg-accent-green/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Play className="w-3 h-3" /> {submitting ? 'Starting…' : 'Run agent'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ───────────────────────────────────────────────────────────────

export default function RoleManagerPage() {
  const navigate = useNavigate();
  const { agents: allAgents, loading, refresh } = useAgents();
  const toast = useToast();

  // Team data
  const [allTeams, setAllTeams] = useState<Team[]>([]);
  // Selection + search
  const [selection, setSelection] = useState<Selection>({ kind: 'overview' });
  const [sidebarSearch, setSidebarSearch] = useState('');
  const [memberSearch, setMemberSearch] = useState('');

  // Agent CRUD dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<Agent | null>(null);
  const [deletingRole, setDeletingRole] = useState<string | null>(null);
  const [viewingAgent, setViewingAgent] = useState<Agent | null>(null);
  const [runningAgent, setRunningAgent] = useState<Agent | null>(null);
  // Import + bulk selection
  const [importOpen, setImportOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [createTeamOpen, setCreateTeamOpen] = useState(false);
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(new Set());
  // Team CRUD dialog state
  const [teamDialog, setTeamDialog] = useState<TeamDialogMode>({ type: 'closed' });
  const [deletingTeam, setDeletingTeam] = useState<Team | null>(null);

  function toggleAgentSelection(name: string) {
    setSelectedAgents(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function clearSelection() { setSelectedAgents(new Set()); }

  async function reloadTeams() {
    try {
      const t: Team[] = await teamsApi.list();
      setAllTeams((t ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)));
    } catch {
      setAllTeams([]);
    }
  }

  useEffect(() => {
    void reloadTeams();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allAgents]);

  // ── Handlers ──────────────────────────────────────────────────────────────

  function handleCreate() {
    const teamList = allTeams.length > 0 ? allTeams.map(t => t.name).join(', ') : '(no teams yet)';
    navigate(`/chat?${new URLSearchParams({ agent: 'agent-builder-agent', prompt: `Add a new agent. Available teams: ${teamList}` }).toString()}`);
  }

  function handleRun(agent: Agent) { setRunningAgent(agent); }
  function handleEdit(role: Agent) { setEditingRole(role); setDialogOpen(true); }

  async function handleDeleteAgent() {
    if (!deletingRole) return;
    try {
      await agentsApi.delete(deletingRole);
      toast.success(`Agent "${deletingRole}" deleted.`);
      setDeletingRole(null);
      refresh();
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Failed to delete'); }
  }

  async function handleSaveAgent(data: Record<string, unknown>) {
    if (!editingRole) return;
    await agentsApi.update(data.name as string, data);
    toast.success('Agent updated.');
    refresh();
  }

  async function handleSubmitTeam(input: Partial<Team>) {
    if (teamDialog.type === 'edit') {
      await teamsApi.update(teamDialog.team.name, input);
      toast.success(`"${input.displayName}" updated.`);
    } else {
      await teamsApi.create(input);
      toast.success(`"${input.displayName}" created.`);
    }
    await reloadTeams();
    refresh();
  }

  async function handleDeleteTeam() {
    if (!deletingTeam) return;
    try {
      await teamsApi.delete(deletingTeam.name);
      toast.success(`"${deletingTeam.displayName}" deleted.`);
      const wasSelected = selection.kind === 'team' && selection.name === deletingTeam.name;
      setDeletingTeam(null);
      if (wasSelected) setSelection({ kind: 'overview' });
      await reloadTeams();
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete team');
    }
  }

  function handleAddAgentToTeamWithAi(team: Team) {
    const memberNames =
      allAgents
        .filter((a: any) => a.teamName === team.name)
        .map((m: any) => m.displayName ?? m.name)
        .join(', ') || '(no members yet)';
    const prompt = `Add a new agent to the "${team.displayName}" team.\n\nCurrent members: ${memberNames}\nMission: ${team.mission ?? team.description}\n\nWhat role would you like to add?`;
    navigate(`/chat?${new URLSearchParams({ agent: 'agent-builder-agent', prompt }).toString()}`);
  }

  function handleBuildTeamWithAi() {
    const prompt =
      "Build me a new team. Tell me what kind of team you want (e.g. 'finance', 'marketing', 'design ops') and I'll research the domain, design the team structure, and create the agents after you approve.";
    navigate(`/chat?${new URLSearchParams({ agent: 'team-builder-agent', prompt }).toString()}`);
  }

  // ── Derived data ──────────────────────────────────────────────────────────

  const agentsByTeam = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const a of allAgents) {
      const tn = (a as any).teamName as string | undefined;
      if (!tn) continue;
      (m.get(tn) ?? (m.set(tn, []), m.get(tn)!)).push(a);
    }
    for (const list of m.values()) {
      list.sort((x: any, y: any) => {
        if (x.teamRole === 'lead' && y.teamRole !== 'lead') return -1;
        if (x.teamRole !== 'lead' && y.teamRole === 'lead') return 1;
        return ((x.displayName ?? x.name) as string).localeCompare((y.displayName ?? y.name) as string);
      });
    }
    return m;
  }, [allAgents]);

  const unassigned = useMemo(
    () => allAgents.filter((a: any) => !a.teamName),
    [allAgents],
  );

  const total = allAgents.length;
  const assignedCount = total - unassigned.length;

  // Sidebar search — filters teams AND surfaces matching agents
  const q = sidebarSearch.trim().toLowerCase();
  const filteredTeams = useMemo(() => {
    if (!q) return allTeams;
    return allTeams.filter(t =>
      t.name.toLowerCase().includes(q)
      || t.displayName.toLowerCase().includes(q)
      || (t.mission ?? '').toLowerCase().includes(q)
      || t.leadAgentName.toLowerCase().includes(q),
    );
  }, [allTeams, q]);

  const matchingAgents = useMemo(() => {
    if (!q) return [];
    return allAgents.filter((a: any) =>
      (a.name as string).toLowerCase().includes(q)
      || ((a.displayName as string) ?? '').toLowerCase().includes(q),
    ).slice(0, 8);
  }, [allAgents, q]);

  // Global stats: provider/model distribution
  const globalProviders = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of allAgents) {
      const p = ((a as any).provider as string) ?? 'claude';
      map.set(p, (map.get(p) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [allAgents]);

  const globalModels = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of allAgents) {
      const m = ((a as any).model as string) ?? 'sonnet';
      map.set(m, (map.get(m) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [allAgents]);

  const topTeams = useMemo(() => {
    return allTeams
      .map(t => ({ team: t, count: agentsByTeam.get(t.name)?.length ?? 0 }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);
  }, [allTeams, agentsByTeam]);

  // Team detail derived data
  const activeTeam = selection.kind === 'team' ? allTeams.find(t => t.name === selection.name) : null;
  const activeMembers: any[] = activeTeam ? (agentsByTeam.get(activeTeam.name) ?? []) : [];
  const activeLead = activeMembers.find(m => m.teamRole === 'lead');

  const activeTeamProviders = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of activeMembers) {
      const p = (a.provider as string) ?? 'claude';
      map.set(p, (map.get(p) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [activeMembers]);

  const activeTeamModels = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of activeMembers) {
      const m = (a.model as string) ?? 'sonnet';
      map.set(m, (map.get(m) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [activeMembers]);

  const filteredActiveMembers = useMemo(() => {
    const mq = memberSearch.trim().toLowerCase();
    if (!mq) return activeMembers;
    return activeMembers.filter((a: any) =>
      (a.name as string).toLowerCase().includes(mq)
      || ((a.displayName as string) ?? '').toLowerCase().includes(mq)
      || ((a.capabilities as string[]) ?? []).some(c => c.toLowerCase().includes(mq)),
    );
  }, [activeMembers, memberSearch]);

  // Jump helper — select the team that owns an agent
  function jumpToAgent(a: any) {
    if (a.teamName) setSelection({ kind: 'team', name: a.teamName });
    else setSelection({ kind: 'unassigned' });
    setMemberSearch('');
    setViewingAgent(a);
  }

  // ── Render ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="p-6">
        <h1 className="text-[20px] font-semibold text-theme-primary tracking-tight mb-6">Agents</h1>
        <div className="grid grid-cols-[18rem_1fr] gap-4">
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-12 rounded-md bg-app-muted animate-pulse" />
            ))}
          </div>
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-24 rounded-lg bg-app-muted animate-pulse" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      {/* ── Left sidebar ─────────────────────────────────────────────────── */}
      <aside className="w-72 shrink-0 border-r border-app bg-app-muted/40 flex flex-col min-h-0">
        {/* Title + refresh */}
        <div className="px-4 py-4 border-b border-app flex items-center justify-between">
          <h1 className="text-[14px] font-semibold text-theme-primary tracking-tight">Agents &amp; Teams</h1>
          <button
            title="Refresh"
            onClick={() => { refresh(); void reloadTeams(); }}
            className="p-1.5 rounded-md text-theme-muted hover:text-theme-primary hover:bg-app-card transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Search */}
        <div className="px-4 py-3 border-b border-app">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-theme-muted pointer-events-none" />
            <input
              type="text"
              value={sidebarSearch}
              onChange={e => setSidebarSearch(e.target.value)}
              placeholder="Search teams or agents…"
              className="input pl-8 pr-3 py-1.5 w-full text-[12px]"
            />
          </div>
        </div>

        {/* Scrollable list */}
        <div className="flex-1 overflow-y-auto min-h-0 py-2">
          {/* Overview entry */}
          <button
            onClick={() => setSelection({ kind: 'overview' })}
            className={`w-full flex items-center gap-2 px-4 py-1.5 text-left transition-colors border-l-2 ${
              selection.kind === 'overview'
                ? 'bg-app-card text-theme-primary border-accent font-medium'
                : 'text-theme-secondary hover:bg-app-card border-transparent'
            }`}
          >
            <Home className={`w-3.5 h-3.5 ${selection.kind === 'overview' ? 'text-accent' : 'text-theme-muted'}`} />
            <span className="text-[13px]">Overview</span>
          </button>

          <div className="px-4 py-2 overline">
            Teams
          </div>

          {filteredTeams.length === 0 && (
            <div className="px-4 py-3 text-[11px] text-theme-muted italic font-body">
              {q ? 'No teams match your search.' : 'No teams yet.'}
            </div>
          )}

          {filteredTeams.map(team => {
            const members = agentsByTeam.get(team.name) ?? [];
            const lead = members.find((m: any) => m.teamRole === 'lead');
            const isActive = selection.kind === 'team' && selection.name === team.name;
            return (
              <button
                key={team.name}
                onClick={() => { setSelection({ kind: 'team', name: team.name }); setMemberSearch(''); }}
                className={`w-full flex items-start gap-2.5 px-4 py-2.5 text-left transition-colors border-l-2 ${
                  isActive
                    ? 'bg-accent-blue/10 border-accent-blue'
                    : 'border-transparent hover:bg-app-muted/50'
                }`}
              >
                <div className="w-7 h-7 rounded-md bg-accent-blue/10 flex items-center justify-center shrink-0 mt-0.5">
                  <Users className="w-3.5 h-3.5 text-accent-blue" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className={`text-[12px] font-heading font-semibold tracking-wide truncate ${
                      isActive ? 'text-accent-blue' : 'text-theme-primary'
                    }`}>{team.displayName}</span>
                    {team.isBuiltIn && (
                      <span className="text-[8px] font-mono px-1 py-0 rounded-full bg-app-muted text-theme-muted">BI</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px] font-mono text-theme-muted">{members.length} {members.length === 1 ? 'member' : 'members'}</span>
                    {lead && (
                      <span className="flex items-center gap-1 text-[10px] font-mono text-theme-subtle truncate">
                        <Crown className="w-2.5 h-2.5 text-accent-yellow shrink-0" />
                        <span className="truncate">{lead.displayName ?? lead.name}</span>
                      </span>
                    )}
                  </div>
                </div>
                {isActive && <ChevronRight className="w-3.5 h-3.5 text-accent-blue shrink-0 mt-2" />}
              </button>
            );
          })}

          {/* Unassigned */}
          {unassigned.length > 0 && (
            <>
              <div className="px-4 pt-4 pb-2 overline">
                Other
              </div>
              <button
                onClick={() => { setSelection({ kind: 'unassigned' }); setMemberSearch(''); }}
                className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-left transition-colors border-l-2 ${
                  selection.kind === 'unassigned'
                    ? 'bg-accent-yellow/10 border-accent-yellow'
                    : 'border-transparent hover:bg-app-muted/50'
                }`}
              >
                <div className="w-7 h-7 rounded-md bg-app-muted flex items-center justify-center shrink-0">
                  <Users className="w-3.5 h-3.5 text-theme-muted" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] font-heading font-semibold text-theme-secondary tracking-wide">Unassigned</div>
                  <div className="text-[10px] font-mono text-theme-muted mt-0.5">
                    {unassigned.length} {unassigned.length === 1 ? 'agent' : 'agents'}
                  </div>
                </div>
              </button>
            </>
          )}

          {/* Matching agent results during search */}
          {q && matchingAgents.length > 0 && (
            <>
              <div className="px-4 pt-4 pb-2 overline">
                Matching agents
              </div>
              {matchingAgents.map(a => (
                <button
                  key={a.name as string}
                  onClick={() => jumpToAgent(a)}
                  className="w-full flex items-center gap-2.5 px-4 py-2 text-left hover:bg-app-muted/50 transition-colors"
                >
                  <div
                    className="w-6 h-6 rounded flex items-center justify-center shrink-0"
                    style={{ backgroundColor: (((a as any).color as string) ?? '#666') + '18' }}
                  >
                    <RoleIcon icon={(a as any).icon} color={(a as any).color} size={12} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] text-theme-primary font-body truncate">
                      {((a as any).displayName as string) ?? (a.name as string)}
                    </div>
                    <div className="text-[9px] font-mono text-theme-subtle truncate">
                      {(a as any).teamName ? `${(a as any).teamName} · ` : 'unassigned · '}
                      {String((a as any).provider ?? 'claude')}/{String((a as any).model ?? 'sonnet')}
                    </div>
                  </div>
                </button>
              ))}
            </>
          )}
        </div>

        {/* Footer CTAs */}
        <div className="p-3 border-t border-app flex flex-col gap-2">
          <button
            onClick={handleCreate}
            className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[11px] font-mono bg-accent-blue/10 text-accent-blue hover:bg-accent-blue/20 transition-colors"
          >
            <Sparkles className="w-3 h-3" /> Create Agent
          </button>
          <button
            onClick={() => setCreateTeamOpen(true)}
            className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[11px] font-mono bg-accent-green/10 text-accent-green hover:bg-accent-green/20 transition-colors"
          >
            <Plus className="w-3 h-3" /> New Team
          </button>
          <div className="flex gap-2">
            <button
              onClick={handleBuildTeamWithAi}
              title="Build a team with AI"
              className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg text-[10px] font-mono bg-app-muted text-theme-muted hover:bg-app-muted transition-colors"
            >
              <Sparkles className="w-3 h-3" /> AI
            </button>
            <button
              onClick={() => setImportOpen(true)}
              title="Import agents from a repository"
              className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg text-[10px] font-mono bg-app-muted text-theme-muted hover:bg-app-muted transition-colors"
            >
              <FolderGit2 className="w-3 h-3" /> Import
            </button>
          </div>
        </div>
      </aside>

      {/* ── Right pane ───────────────────────────────────────────────────── */}
      <main className="flex-1 overflow-y-auto min-h-0">
        {/* Bulk selection bar */}
        {selectedAgents.size > 0 && (
          <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-6 py-3 bg-accent-blue/10 border-b border-accent-blue/30">
            <span className="text-[11px] font-mono text-accent-blue">
              {selectedAgents.size} selected
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setAssignOpen(true)}
                className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-[10px] font-mono bg-accent-blue/10 text-accent-blue hover:bg-accent-blue/20"
              >
                <ArrowRight className="w-3 h-3" /> Assign to team
              </button>
              <button
                onClick={() => setCreateTeamOpen(true)}
                className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-[10px] font-mono bg-accent-green/10 text-accent-green hover:bg-accent-green/20"
              >
                <Plus className="w-3 h-3" /> Create team with these
              </button>
              <button
                onClick={clearSelection}
                className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-[10px] font-mono bg-app-muted/50 text-theme-muted hover:bg-app-muted"
              >
                <X className="w-3 h-3" /> Clear
              </button>
            </div>
          </div>
        )}

        {selection.kind === 'overview' && (
          <OverviewContent
            total={total}
            teamsCount={allTeams.length}
            assignedCount={assignedCount}
            unassignedCount={unassigned.length}
            providers={globalProviders}
            models={globalModels}
            topTeams={topTeams}
            allAgents={allAgents}
            onSelectTeam={(name) => { setSelection({ kind: 'team', name }); setMemberSearch(''); }}
          />
        )}

        {selection.kind === 'team' && activeTeam && (
          <TeamDetailContent
            team={activeTeam}
            members={activeMembers}
            filteredMembers={filteredActiveMembers}
            lead={activeLead}
            providers={activeTeamProviders}
            models={activeTeamModels}
            memberSearch={memberSearch}
            onMemberSearch={setMemberSearch}
            selectedAgents={selectedAgents}
            onToggleSelect={toggleAgentSelection}
            onView={setViewingAgent}
            onEdit={handleEdit}
            onDelete={setDeletingRole}
            onRun={handleRun}
            onEditTeam={() => setTeamDialog({ type: 'edit', team: activeTeam })}
            onDeleteTeam={() => setDeletingTeam(activeTeam)}
            onAddAgentWithAi={() => handleAddAgentToTeamWithAi(activeTeam)}
          />
        )}

        {selection.kind === 'team' && !activeTeam && (
          <div className="p-8 text-center text-theme-muted text-sm">
            Team not found. <button className="text-accent-blue underline" onClick={() => setSelection({ kind: 'overview' })}>Back to overview</button>
          </div>
        )}

        {selection.kind === 'unassigned' && (
          <UnassignedContent
            agents={unassigned}
            selectedAgents={selectedAgents}
            onToggleSelect={toggleAgentSelection}
            onView={setViewingAgent}
            onEdit={handleEdit}
            onDelete={setDeletingRole}
            onRun={handleRun}
          />
        )}
      </main>

      {/* Modals */}
      {viewingAgent && <AgentDetailPanel agent={viewingAgent} onClose={() => setViewingAgent(null)} />}
      {runningAgent && (
        <RunAgentDialog
          agent={runningAgent}
          onClose={() => setRunningAgent(null)}
          onStarted={(executionId) => {
            setRunningAgent(null);
            navigate(`/executions/${executionId}`);
          }}
        />
      )}
      <RoleDialog open={dialogOpen} onClose={() => setDialogOpen(false)} onSave={handleSaveAgent} role={editingRole} />
      <DeleteConfirmDialog open={!!deletingRole} resourceType="agent" resourceName={deletingRole ?? ''} onConfirm={handleDeleteAgent} onCancel={() => setDeletingRole(null)} />
      <ImportAgentsFromRepoDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => { refresh(); }}
      />
      <AssignToTeamDialog
        open={assignOpen}
        onClose={() => setAssignOpen(false)}
        agentNames={Array.from(selectedAgents)}
        onAssigned={() => { clearSelection(); refresh(); }}
      />
      <CreateTeamFromAgentsDialog
        open={createTeamOpen}
        onClose={() => setCreateTeamOpen(false)}
        memberAgentNames={Array.from(selectedAgents)}
        onCreated={() => { clearSelection(); refresh(); void reloadTeams(); }}
      />
      <TeamDialog
        mode={teamDialog}
        allAgents={allAgents as any}
        allTeams={allTeams}
        onClose={() => setTeamDialog({ type: 'closed' })}
        onSubmit={handleSubmitTeam}
      />
      <TeamDeleteConfirm
        team={deletingTeam}
        memberCount={deletingTeam ? (agentsByTeam.get(deletingTeam.name)?.length ?? 0) : 0}
        onCancel={() => setDeletingTeam(null)}
        onConfirm={handleDeleteTeam}
      />
    </div>
  );
}

// ── Overview pane ──────────────────────────────────────────────────────────

function OverviewContent({
  total, teamsCount, assignedCount, unassignedCount, providers, models, topTeams, allAgents, onSelectTeam,
}: {
  total: number;
  teamsCount: number;
  assignedCount: number;
  unassignedCount: number;
  providers: [string, number][];
  models: [string, number][];
  topTeams: { team: Team; count: number }[];
  allAgents: any[];
  onSelectTeam: (name: string) => void;
}) {
  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Home className="w-5 h-5 text-accent-blue" />
        <h2 className="text-[18px] font-semibold text-theme-primary tracking-tight">Overview</h2>
      </div>

      {/* Global stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatTile label="Agents" value={total} accent="blue" />
        <StatTile label="Teams" value={teamsCount} accent="purple" />
        <StatTile label="Assigned" value={assignedCount} accent="green" />
        <StatTile label="Unassigned" value={unassignedCount} accent="yellow" />
      </div>

      {/* Providers / Models distribution */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <DistributionCard title="Providers" entries={providers} accent="blue" />
        <DistributionCard title="Models" entries={models} accent="purple" />
      </div>

      {/* Org chart */}
      <div className="rounded-xl border border-app bg-app-muted/40 p-4">
        <div className="flex items-center gap-2 mb-3">
          <LayoutGrid className="w-4 h-4 text-accent-blue" />
          <span className="overline">Delegation Graph</span>
        </div>
        {allAgents.length > 0 ? (
          <DelegationGraph agents={allAgents} />
        ) : (
          <div className="text-[11px] text-theme-muted italic font-body py-8 text-center">
            No agents yet. Create one to get started.
          </div>
        )}
      </div>

      {/* Largest teams */}
      <div className="rounded-xl border border-app bg-app-muted/40 p-4">
        <div className="flex items-center gap-2 mb-3">
          <Users className="w-4 h-4 text-accent-purple" />
          <span className="overline">Largest Teams</span>
        </div>
        {topTeams.length === 0 ? (
          <div className="text-[11px] text-theme-muted italic font-body py-2">No teams yet.</div>
        ) : (
          <div className="space-y-2">
            {topTeams.map(({ team, count }) => {
              const max = Math.max(1, topTeams[0].count);
              const pct = (count / max) * 100;
              return (
                <button
                  key={team.name}
                  onClick={() => onSelectTeam(team.name)}
                  className="w-full flex items-center gap-3 px-2 py-1.5 rounded-md hover:bg-app-muted transition-colors group"
                >
                  <span className="w-32 text-[11px] font-heading font-semibold text-theme-primary tracking-wide truncate text-left">
                    {team.displayName}
                  </span>
                  <div className="flex-1 h-2 rounded-full bg-app-muted/50 overflow-hidden">
                    <div className="h-full bg-accent-blue/40 group-hover:bg-accent-blue/60 transition-colors" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="w-14 text-right text-[10px] font-mono text-theme-muted">{count} {count === 1 ? 'agent' : 'agents'}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function StatTile({ label, value, accent }: { label: string; value: number; accent: 'blue' | 'purple' | 'green' | 'yellow' }) {
  const tone =
    accent === 'blue' ? 'border-accent-blue/30 bg-accent-blue/5'
    : accent === 'purple' ? 'border-accent-purple/30 bg-accent-purple/5'
    : accent === 'green' ? 'border-accent-green/30 bg-accent-green/5'
    : 'border-accent-yellow/30 bg-accent-yellow/5';
  const text =
    accent === 'blue' ? 'text-accent-blue'
    : accent === 'purple' ? 'text-accent-purple'
    : accent === 'green' ? 'text-accent-green'
    : 'text-accent-yellow';
  return (
    <div className={`rounded-xl border ${tone} p-4`}>
      <div className="overline mb-1">{label}</div>
      <div className={`text-3xl font-heading font-bold ${text}`}>{value}</div>
    </div>
  );
}

function DistributionCard({ title, entries, accent }: { title: string; entries: [string, number][]; accent: 'blue' | 'purple' }) {
  const tone = accent === 'blue' ? 'text-accent-blue' : 'text-accent-purple';
  return (
    <div className="rounded-xl border border-app bg-app-muted/40 p-4">
      <div className="overline mb-3">{title}</div>
      {entries.length === 0 ? (
        <div className="text-[11px] text-theme-muted italic font-body">—</div>
      ) : (
        <div className="space-y-2">
          {entries.map(([key, count]) => (
            <div key={key} className="flex items-center justify-between text-[11px]">
              <span className={`font-mono ${tone}`}>{key}</span>
              <span className="font-mono text-theme-muted">{count}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Team detail pane ───────────────────────────────────────────────────────

function TeamDetailContent({
  team, members, filteredMembers, lead, providers, models,
  memberSearch, onMemberSearch,
  selectedAgents, onToggleSelect,
  onView, onEdit, onDelete, onRun,
  onEditTeam, onDeleteTeam, onAddAgentWithAi,
}: {
  team: Team;
  members: any[];
  filteredMembers: any[];
  lead: any;
  providers: [string, number][];
  models: [string, number][];
  memberSearch: string;
  onMemberSearch: (v: string) => void;
  selectedAgents: Set<string>;
  onToggleSelect: (name: string) => void;
  onView: (a: Agent) => void;
  onEdit: (a: Agent) => void;
  onDelete: (name: string) => void;
  onRun: (a: Agent) => void;
  onEditTeam: () => void;
  onDeleteTeam: () => void;
  onAddAgentWithAi: () => void;
}) {
  const canAddAgent = team.name !== 'meta';
  return (
    <div className="p-6 space-y-5">
      {/* Team header */}
      <div className="rounded-xl border border-app bg-app-muted/40 p-5">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-lg bg-accent-blue/10 flex items-center justify-center shrink-0">
            <Users className="w-6 h-6 text-accent-blue" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-[18px] font-semibold text-theme-primary tracking-tight">{team.displayName}</h2>
              {team.isBuiltIn && (
                <span className="text-[9px] font-mono px-1.5 py-0.5 rounded-full bg-app-muted text-theme-muted">built-in</span>
              )}
              <span className="text-[11px] font-mono text-theme-subtle">{team.name}</span>
            </div>
            {team.description && (
              <p className="text-[12px] text-theme-muted font-body mt-1">{team.description}</p>
            )}
            {team.mission && (
              <div className="mt-3 flex items-start gap-2 px-3 py-2 rounded-md bg-surface-200/25 border border-app">
                <Info className="w-3.5 h-3.5 text-accent-blue shrink-0 mt-0.5" />
                <div className="text-[12px] text-theme-secondary font-body italic">{team.mission}</div>
              </div>
            )}
            <div className="flex items-center gap-4 mt-3 flex-wrap">
              {lead ? (
                <div className="flex items-center gap-1.5 text-[11px]">
                  <span className="text-theme-subtle overline">Lead:</span>
                  <Crown className="w-3.5 h-3.5 text-accent-yellow" />
                  <span className="font-mono text-theme-secondary">{lead.displayName ?? lead.name}</span>
                </div>
              ) : (
                <div className="flex items-center gap-1.5 text-[11px] text-accent-yellow/80">
                  <Crown className="w-3.5 h-3.5" /> <span>No lead assigned</span>
                </div>
              )}
              {team.parentTeamName && (
                <div className="flex items-center gap-1.5 text-[11px]">
                  <span className="text-theme-subtle overline">Parent:</span>
                  <span className="font-mono text-theme-secondary">{team.parentTeamName}</span>
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {canAddAgent && (
              <button
                onClick={onAddAgentWithAi}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-mono bg-accent-purple/10 text-accent-purple hover:bg-accent-purple/20 transition-colors"
              >
                <Sparkles className="w-3 h-3" /> Add Agent
              </button>
            )}
            {!team.isBuiltIn && (
              <>
                <button
                  onClick={onEditTeam}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-mono bg-accent-yellow/10 text-accent-yellow hover:bg-accent-yellow/20 transition-colors"
                >
                  <Pencil className="w-3 h-3" /> Edit
                </button>
                <button
                  onClick={onDeleteTeam}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-mono bg-accent-red/10 text-accent-red hover:bg-accent-red/20 transition-colors"
                >
                  <Trash2 className="w-3 h-3" /> Delete
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <StatTile label="Members" value={members.length} accent="blue" />
        <DistributionCard title="Providers" entries={providers} accent="blue" />
        <DistributionCard title="Models" entries={models} accent="purple" />
      </div>

      {/* Member search + list */}
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="overline">
            Members ({filteredMembers.length}{filteredMembers.length !== members.length ? ` of ${members.length}` : ''})
          </div>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-theme-subtle pointer-events-none" />
            <input
              type="text"
              value={memberSearch}
              onChange={e => onMemberSearch(e.target.value)}
              placeholder="Search members…"
              className="input text-xs pl-8 pr-3 py-1.5 w-56"
            />
          </div>
        </div>

        {members.length === 0 ? (
          <div className="rounded-xl border border-dashed border-app p-8 text-center">
            <div className="text-[13px] text-theme-muted font-body">No members in this team yet.</div>
            {canAddAgent && (
              <button
                onClick={onAddAgentWithAi}
                className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-mono bg-accent-purple/10 text-accent-purple hover:bg-accent-purple/20 transition-colors"
              >
                <Sparkles className="w-3 h-3" /> Add the first agent
              </button>
            )}
          </div>
        ) : filteredMembers.length === 0 ? (
          <div className="rounded-xl border border-dashed border-app p-6 text-center text-[12px] text-theme-muted font-body italic">
            No members match "{memberSearch}".
          </div>
        ) : (
          <div className="space-y-2">
            {filteredMembers.map((agent: any) => (
              <AgentCard
                key={agent.name}
                agent={agent}
                onEdit={onEdit}
                onDelete={onDelete}
                onRun={onRun}
                onView={onView}
                selected={selectedAgents.has(agent.name)}
                onToggleSelect={onToggleSelect}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Unassigned pane ────────────────────────────────────────────────────────

function UnassignedContent({
  agents, selectedAgents, onToggleSelect, onView, onEdit, onDelete, onRun,
}: {
  agents: any[];
  selectedAgents: Set<string>;
  onToggleSelect: (name: string) => void;
  onView: (a: Agent) => void;
  onEdit: (a: Agent) => void;
  onDelete: (name: string) => void;
  onRun: (a: Agent) => void;
}) {
  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-3">
        <Users className="w-5 h-5 text-theme-muted" />
        <h2 className="text-[18px] font-semibold text-theme-primary tracking-tight">Unassigned</h2>
        <span className="text-[11px] font-mono text-theme-muted">
          {agents.length} {agents.length === 1 ? 'agent' : 'agents'}
        </span>
      </div>
      <p className="text-[12px] text-theme-muted font-body">
        These agents aren't members of any team. Select them to assign to an existing team or create a new one.
      </p>
      {agents.length === 0 ? (
        <div className="rounded-xl border border-dashed border-app p-8 text-center text-[12px] text-theme-muted font-body italic">
          No unassigned agents.
        </div>
      ) : (
        <div className="space-y-2">
          {agents.map((agent: any) => (
            <AgentCard
              key={agent.name}
              agent={agent}
              onEdit={onEdit}
              onDelete={onDelete}
              onRun={onRun}
              onView={onView}
              selected={selectedAgents.has(agent.name)}
              onToggleSelect={onToggleSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}
