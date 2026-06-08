import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAgents } from '../hooks/useAgents';
import { agents as agentsApi, teams as teamsApi, repos as reposApi, executions as executionsApi, skills as skillsApi, type SkillRecord } from '../services/api';
import RoleIcon from '../components/common/RoleIcon';
import RoleDialog from '../components/common/RoleDialog';
import Select from '../components/common/Select';
import DeleteConfirmDialog from '../components/common/DeleteConfirmDialog';
import IconTooltipButton from '../components/common/IconTooltipButton';
import { useToast } from '../components/common/Toast';
import { renderMarkdown } from '../components/chat/ChatMessageList';
import {
  RefreshCw, Sparkles, Users, Crown, Search, Play, ArrowRight,
  X, FolderGit2, Plus, Pencil, Trash2, LayoutGrid, Info, Home,
  ChevronRight, GitBranch, ExternalLink,
  Layers, Tag, FileText, Monitor, Download, ScanSearch, Settings, BookOpen,
} from 'lucide-react';
import { SpawnTargetGraph } from '../components/agents/SpawnTargetGraph';
import McpServerManager from '../components/settings/McpServerManager';
import {
  ImportAgentsFromRepoDialog,
  AssignToTeamDialog,
  CreateTeamFromAgentsDialog,
} from '../components/agents/ImportAndTeamDialogs';
import BulkAgentModelDialog from '../components/agents/BulkAgentModelDialog';
import {
  TeamDialog,
  TeamDeleteConfirm,
  type Team,
  type TeamDialogMode,
} from '../components/agents/TeamDialogs';
import { AgentCard } from '../components/agents/AgentCard';
import RepoManagerPage from './RepoManagerPage';

type Agent = Record<string, unknown>;
type Selection = { kind: 'overview' } | { kind: 'team'; name: string } | { kind: 'unassigned' };
type LibrarySection = 'teams-agents' | 'skills' | 'repos' | 'integrations';

// ── Agent detail panel (markdown viewer) ──────────────────────────────────

function AgentDetailPanel({
  agent, onClose, onRun, onEdit, runs7d = 0,
}: {
  agent: Agent;
  onClose: () => void;
  onRun?: (a: Agent) => void;
  onEdit?: (a: Agent) => void;
  runs7d?: number;
}) {
  const system = (agent.system as string) ?? '';
  const capabilities = (agent.capabilities as string[] | undefined) ?? [];
  const spawnTargets = (agent.spawnTargets as string[] | undefined) ?? [];
  const tools = (agent.tools as string[] | undefined) ?? [];
  const externalMcpServers = Array.isArray(agent.externalMcpServers)
    ? agent.externalMcpServers as string[]
    : [];
  const configuredDisabledMcpTools = agent.disabledMcpTools && typeof agent.disabledMcpTools === 'object' && !Array.isArray(agent.disabledMcpTools)
    ? agent.disabledMcpTools as Record<string, unknown>
    : {};
  const disabledAllenMcpTools = [
    ...new Set([
      ...(Array.isArray(configuredDisabledMcpTools.allen) ? configuredDisabledMcpTools.allen : []),
      ...(Array.isArray(agent.disabledAllenMcpTools) ? agent.disabledAllenMcpTools : []),
    ].filter((tool): tool is string => typeof tool === 'string')),
  ];
  const disabledExternalMcpToolCount = Object.entries(configuredDisabledMcpTools)
    .filter(([server]) => server !== 'allen')
    .reduce((count, [, tools]) => count + (Array.isArray(tools) ? tools.filter((tool) => typeof tool === 'string').length : 0), 0);

  const provider = String(agent.provider ?? 'claude');
  const model = String(agent.model ?? 'sonnet');
  const reasoningEffort = (agent.reasoningEffort as string | undefined) ?? null;
  const planMode = (agent.planMode as boolean | undefined) ?? null;
  const isLead = agent.teamRole === 'lead';
  const teamName = agent.teamName as string | undefined;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6 backdrop-blur-sm" onClick={onClose}>
      <div
        className="flex h-[90vh] w-full max-w-[1180px] flex-col overflow-hidden rounded-md border border-app bg-app-card shadow-[0_24px_80px_rgba(0,0,0,0.34)] animate-in fade-in zoom-in-95 duration-200"
        onClick={e => e.stopPropagation()}
      >
        {/* ── Header ────────────────────────────────────────────────── */}
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-app px-6 py-5">
          <div className="flex items-start gap-4 min-w-0">
            <div
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md border border-app"
              style={{ backgroundColor: ((agent.color as string) ?? '#2a76e2') + '20' }}
            >
              <RoleIcon icon={agent.icon as string} color={agent.color as string} size={22} />
            </div>
            <div className="min-w-0 flex flex-col gap-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="truncate text-[22px] font-semibold tracking-tight text-theme-primary">
                  {(agent.displayName as string) ?? (agent.name as string)}
                </h2>
                {isLead && (
                  <span className="badge" style={{ background: 'rgb(var(--color-accent-yellow) / 0.15)', color: 'rgb(var(--color-accent-yellow))' }}>
                    <Crown className="w-3 h-3" /> Lead
                  </span>
                )}
                <span className={`badge ${runs7d > 0 ? 'badge-ok' : 'badge-muted'}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${runs7d > 0 ? 'bg-accent-green' : 'bg-theme-subtle'}`} />
                  {runs7d > 0 ? `${runs7d} run${runs7d === 1 ? '' : 's'} · 7d` : 'Idle · 7d'}
                </span>
              </div>
              <div className="flex items-center gap-2 font-mono text-[12px] text-theme-muted">
                <span className="text-theme-subtle">{agent.name as string}</span>
                {teamName && (
                  <>
                    <span className="text-theme-subtle">·</span>
                    <span>team <span className="text-theme-secondary">{teamName}</span></span>
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {onEdit && (
              <button onClick={() => onEdit(agent)} className="btn btn-secondary btn-sm">
                <Pencil className="w-3.5 h-3.5" /> Edit
              </button>
            )}
            {onRun && (
              <button onClick={() => onRun(agent)} className="btn btn-primary btn-sm">
                <Play className="w-3.5 h-3.5" /> Run agent
              </button>
            )}
            <IconTooltipButton label="Close" onClick={onClose} className="h-9 w-9">
              <X className="h-4 w-4" />
            </IconTooltipButton>
          </div>
        </div>

        {/* ── Two-column body: instructions left, metadata right ────── */}
        <div className="flex-1 flex overflow-hidden min-h-0">
          {/* Instructions column */}
          <div className="flex-1 overflow-y-auto min-h-0">
            <div className="px-8 py-7 max-w-[920px] mx-auto">
              <div className="overline mb-3">Agent instructions</div>
              {system ? (
                <div className="text-[14px] text-theme-secondary leading-[1.7] prose-allen">
                  {renderMarkdown(system)}
                </div>
              ) : (
                <div className="text-center py-16 text-theme-muted italic font-body text-[13px]">
                  No system prompt defined for this agent.
                </div>
              )}
            </div>
          </div>

          {/* Metadata rail */}
          <aside className="w-[320px] shrink-0 overflow-y-auto border-l border-app bg-app-muted/25">
            <div className="p-5 space-y-5">
              <DetailSection label="Model">
                <div className="flex flex-col gap-1.5">
                  <DetailRow k="Provider" v={<span className="font-mono text-theme-primary">{provider}</span>} />
                  <DetailRow k="Model" v={<span className="font-mono text-theme-primary">{model}</span>} />
                  {reasoningEffort && (
                    <DetailRow k="Reasoning" v={<span className="font-mono text-theme-primary">{reasoningEffort}</span>} />
                  )}
                  {planMode != null && (
                    <DetailRow k="Plan mode" v={<span className="font-mono text-theme-primary">{planMode ? 'on' : 'off'}</span>} />
                  )}
                </div>
              </DetailSection>

              <DetailSection label="Activity">
                <DetailRow
                  k="Last 7 days"
                  v={
                    <span className={`font-mono ${runs7d > 0 ? 'text-accent-green' : 'text-theme-muted'}`}>
                      {runs7d} {runs7d === 1 ? 'run' : 'runs'}
                    </span>
                  }
                />
                <DetailRow
                  k="Status"
                  v={
                    <span className="inline-flex items-center gap-1 font-mono">
                      <span className={`w-1.5 h-1.5 rounded-full ${runs7d > 0 ? 'bg-accent-green' : 'bg-theme-subtle'}`} />
                      <span className={runs7d > 0 ? 'text-accent-green' : 'text-theme-muted'}>
                        {runs7d > 0 ? 'Active' : 'Idle'}
                      </span>
                    </span>
                  }
                />
              </DetailSection>

              {capabilities.length > 0 && (
                <DetailSection label={`Capabilities · ${capabilities.length}`}>
                  <div className="flex flex-wrap gap-1.5">
                    {capabilities.map(cap => (
                      <span
                        key={cap}
                        className="text-[10.5px] font-mono px-1.5 py-0.5 rounded bg-accent-purple/10 text-accent-purple"
                      >
                        {cap}
                      </span>
                    ))}
                  </div>
                </DetailSection>
              )}

              {tools.length > 0 && (
                <DetailSection label={`Tools · ${tools.length}`}>
                  <div className="flex flex-wrap gap-1.5">
                    {tools.map(t => (
                      <span
                        key={t}
                        className="text-[10.5px] font-mono px-1.5 py-0.5 rounded bg-app-muted text-theme-secondary"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                </DetailSection>
              )}

              <DetailSection label="External MCP">
                {externalMcpServers.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {externalMcpServers.map(t => (
                      <span
                        key={t}
                        className="text-[10.5px] font-mono px-1.5 py-0.5 rounded bg-app-muted text-theme-secondary"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                ) : (
                  <span className="text-[11px] font-mono text-theme-muted">None</span>
                )}
                <div className="text-[10px] text-theme-subtle mt-1">Allen MCP selected by default</div>
              </DetailSection>

              <DetailSection label="MCP Tools">
                <div className="flex flex-col gap-1 text-[11px] font-mono text-theme-muted">
                  <span>
                    Allen: {disabledAllenMcpTools.length === 0
                      ? 'all tools enabled'
                      : `${disabledAllenMcpTools.length} disabled`}
                  </span>
                  {disabledExternalMcpToolCount > 0 && (
                    <span>External: {disabledExternalMcpToolCount} disabled</span>
                  )}
                </div>
              </DetailSection>

              {spawnTargets.length > 0 && (
                <DetailSection label={`Can spawn · ${spawnTargets.length}`}>
                  <div className="flex flex-col gap-0.5">
                    {spawnTargets.map(t => (
                      <div key={t} className="flex items-center gap-1.5 text-[12px] font-mono text-theme-secondary">
                        <ArrowRight className="w-3 h-3 text-theme-subtle" />
                        {t}
                      </div>
                    ))}
                  </div>
                </DetailSection>
              )}
            </div>
          </aside>
        </div>

        {/* ── Footer ──────────────────────────────────────────────── */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-app bg-app-muted/25 px-6 py-4">
          <div className="font-mono text-[11px] text-theme-muted">
            Read-only view · {teamName ? `Member of ${teamName}` : 'Unassigned'} · {provider}/{model}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="btn btn-ghost btn-sm">Close</button>
            {onEdit && (
              <button onClick={() => onEdit(agent)} className="btn btn-secondary btn-sm">
                <Pencil className="w-3.5 h-3.5" /> Edit
              </button>
            )}
            {onRun && (
              <button onClick={() => onRun(agent)} className="btn btn-primary btn-sm">
                <Play className="w-3.5 h-3.5" /> Run agent
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function DetailSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="overline mb-2">{label}</div>
      {children}
    </div>
  );
}

function DetailRow({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 text-[12px]">
      <span className="text-theme-muted">{k}</span>
      {v}
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
            <Select
              value={repoId}
              onChange={setRepoId}
              disabled={loadingRepos}
              placeholder={loadingRepos ? 'Loading repos...' : 'No repository'}
              options={[
                {
                  value: '',
                  label: loadingRepos ? 'Loading repos...' : 'No repository',
                  sublabel: 'Agent runs without a repository',
                },
                ...repoList.map(r => ({
                  value: String(r._id),
                  label: r.name,
                  sublabel: r.path,
                })),
              ]}
              searchPlaceholder="Search repositories..."
            />
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
  const [searchParams] = useSearchParams();
  const { agents: allAgents, loading, refresh } = useAgents();
  const toast = useToast();

  // Team data
  const [allTeams, setAllTeams] = useState<Team[]>([]);
  const [skillList, setSkillList] = useState<SkillRecord[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(true);
  const sectionParam = searchParams.get('section') ?? searchParams.get('tab');
  const librarySection: LibrarySection =
    sectionParam === 'skills'
      || sectionParam === 'repos'
      || sectionParam === 'integrations'
      || sectionParam === 'teams-agents'
      ? sectionParam
      : 'teams-agents';
  // Selection + search
  const [selection, setSelection] = useState<Selection>({ kind: 'overview' });
  const [sidebarSearch, setSidebarSearch] = useState('');
  const [memberSearch, setMemberSearch] = useState('');
  // Tab on the Overview pane (matches handoff/pages/agents.jsx AgentsV2)
  type Tab = 'directory' | 'teams' | 'graph' | 'models';
  const [activeTab, setActiveTab] = useState<Tab>('directory');

  // Per-agent activity in the last 7 days, regardless of caller (chat,
  // workflow orchestrator, direct run). We pull every agent execution
  // (anything whose workflowName contains :spawn_agent/), filter by
  // startedAt within the window, then group by agent name.
  const [activityByAgent, setActivityByAgent] = useState<Map<string, number>>(new Map());
  const reloadActivity = useCallback(async () => {
    try {
      const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
      // 500 should comfortably cover 7d for most installs; fetch DESC by
      // startedAt and stop when we cross the cutoff.
      const { items } = await executionsApi.listPaged({ type: 'agent', limit: 500, offset: 0 });
      const map = new Map<string, number>();
      for (const e of items as any[]) {
        const startedAt = e.startedAt ? new Date(e.startedAt).getTime() : 0;
        if (!startedAt || startedAt < since) continue;
        const wfName: string = e.workflowName ?? '';
        if (!wfName.includes(':spawn_agent/')) continue;
        const agentName = wfName.split(':spawn_agent/')[1];
        if (!agentName) continue;
        map.set(agentName, (map.get(agentName) ?? 0) + 1);
      }
      setActivityByAgent(map);
    } catch {
      setActivityByAgent(new Map());
    }
  }, []);
  useEffect(() => { void reloadActivity(); }, [reloadActivity]);

  const reloadSkills = useCallback(async () => {
    setSkillsLoading(true);
    try {
      const list = await skillsApi.list(true);
      setSkillList((list ?? []).slice().sort((a, b) =>
        (Number(b.priority ?? 0) - Number(a.priority ?? 0))
        || String(a.name ?? '').localeCompare(String(b.name ?? '')),
      ));
    } catch {
      setSkillList([]);
    } finally {
      setSkillsLoading(false);
    }
  }, []);
  useEffect(() => { void reloadSkills(); }, [reloadSkills]);

  // Agent CRUD dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<Agent | null>(null);
  const [creatingForTeam, setCreatingForTeam] = useState<Team | null>(null);
  const [deletingRole, setDeletingRole] = useState<string | null>(null);
  const [viewingAgent, setViewingAgent] = useState<Agent | null>(null);
  const [runningAgent, setRunningAgent] = useState<Agent | null>(null);
  // Import + bulk selection
  const [importOpen, setImportOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [createTeamOpen, setCreateTeamOpen] = useState(false);
  const [bulkModelOpen, setBulkModelOpen] = useState(false);
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

  function closeRoleDialog() {
    setDialogOpen(false);
    setEditingRole(null);
    setCreatingForTeam(null);
  }

  function handleCreate(team?: Team) {
    setEditingRole(null);
    setCreatingForTeam(team ?? null);
    setDialogOpen(true);
  }

  function handleRun(agent: Agent) { setRunningAgent(agent); }
  function handleEdit(role: Agent) {
    setCreatingForTeam(null);
    setEditingRole(role);
    setDialogOpen(true);
  }

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
    if (editingRole) {
      const updated = await agentsApi.update(data.name as string, data);
      setEditingRole({ ...editingRole, ...data, ...(updated ?? {}) });
      toast.success('Agent updated.');
      await refresh();
      return;
    }

    const targetTeamName = typeof data.teamName === 'string' && data.teamName
      ? data.teamName
      : creatingForTeam?.name;
    const { teamName: _teamName, ...agentData } = data;
    const created = await agentsApi.create(agentData);
    if (targetTeamName) {
      await agentsApi.moveToTeam(String(created?.name ?? data.name), targetTeamName, 'member');
    }
    toast.success(creatingForTeam
      ? `Agent created in ${creatingForTeam.displayName}.`
      : 'Agent created.');
    await refresh();
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

  function handleAddAgentToTeam(team: Team) {
    handleCreate(team);
  }

  function handleBuildTeamWithAi() {
    const prompt =
      "Build me a new team. Tell me what kind of team you want (e.g. 'finance', 'marketing', 'design ops') and I'll research the domain, design the team structure, and create the agents after you approve.";
    navigate(`/chat?${new URLSearchParams({ agent: 'team-builder-agent', prompt }).toString()}`);
  }

  async function handleSaveSkill(skill: Partial<SkillRecord>) {
    const id = skill._id ?? skill.id;
    if (id) {
      await skillsApi.update(id, skill);
      toast.success(`Skill "${skill.name}" updated.`);
    } else {
      await skillsApi.create(skill);
      toast.success(`Skill "${skill.name}" created.`);
    }
    await reloadSkills();
  }

  async function handleDeleteSkill(skill: SkillRecord) {
    const id = skill._id ?? skill.id;
    if (!id) return;
    await skillsApi.delete(id);
    toast.success(`Skill "${skill.name}" deleted.`);
    await reloadSkills();
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
      <div className="w-full px-8 py-8">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <div className="h-8 w-56 rounded-md bg-app-muted animate-pulse" />
            <div className="mt-2 h-4 w-80 rounded bg-app-muted/70 animate-pulse" />
          </div>
          <div className="h-9 w-32 rounded-md bg-app-muted animate-pulse" />
        </div>
        <div className="grid grid-cols-[280px_minmax(0,1fr)] gap-4">
          <div className="h-[560px] rounded-md border border-app bg-app-card p-3">
            {Array.from({ length: 7 }).map((_, i) => <div key={i} className="mb-2 h-14 rounded-md bg-app-muted animate-pulse" />)}
          </div>
          <div className="h-[560px] rounded-md border border-app bg-app-card p-4">
            {Array.from({ length: 6 }).map((_, i) => <div key={i} className="mb-3 h-16 rounded-md bg-app-muted animate-pulse" />)}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto" data-screen-label="library">
      <main className="min-h-full">
        {selectedAgents.size > 0 && (
          <div className="fixed bottom-6 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-md border border-app bg-[rgb(var(--color-text-primary))] px-3 py-2 text-[12px] text-[rgb(var(--color-surface-100))] shadow-lg">
            <span className="font-mono">{selectedAgents.size} selected</span>
            <button className="inline-flex h-8 items-center gap-1.5 rounded px-2.5 transition-colors hover:bg-white/10" onClick={() => setAssignOpen(true)}><ArrowRight className="h-3.5 w-3.5" /> Assign</button>
            <button className="inline-flex h-8 items-center gap-1.5 rounded px-2.5 transition-colors hover:bg-white/10" onClick={() => setBulkModelOpen(true)}><Settings className="h-3.5 w-3.5" /> Change model</button>
            <button className="inline-flex h-8 items-center gap-1.5 rounded px-2.5 transition-colors hover:bg-white/10" onClick={() => setCreateTeamOpen(true)}><Plus className="h-3.5 w-3.5" /> Create team</button>
            <button className="inline-flex h-8 items-center gap-1.5 rounded px-2.5 transition-colors hover:bg-white/10" onClick={clearSelection}><X className="h-3.5 w-3.5" /> Clear</button>
          </div>
        )}

        {librarySection === 'teams-agents' && (
          <LibraryTeamsAgentsPane
            teams={allTeams}
            agents={allAgents as any[]}
            agentsByTeam={agentsByTeam}
            activityByAgent={activityByAgent}
            selectedAgents={selectedAgents}
            onToggleSelect={toggleAgentSelection}
            onViewAgent={setViewingAgent}
            onEditAgent={handleEdit}
            onDeleteAgent={setDeletingRole}
            onRunAgent={handleRun}
            onCreateTeam={() => setCreateTeamOpen(true)}
            onBuildTeamWithAi={handleBuildTeamWithAi}
            onCreateAgent={() => handleCreate()}
            onImportAgents={() => setImportOpen(true)}
            onEditTeam={(team) => setTeamDialog({ type: 'edit', team })}
            onDeleteTeam={setDeletingTeam}
            onAddAgentToTeam={handleAddAgentToTeam}
            onRefresh={() => { refresh(); void reloadTeams(); void reloadActivity(); }}
          />
        )}
        {librarySection === 'skills' && (
          <LibrarySkillsPane
            skills={skillList}
            loading={skillsLoading}
            onRefresh={reloadSkills}
            onSave={handleSaveSkill}
            onDelete={handleDeleteSkill}
          />
        )}
        {librarySection === 'repos' && (
          <RepoManagerPage />
        )}
        {librarySection === 'integrations' && <LibraryIntegrationsPane />}
      </main>

      {/* Modals */}
      {viewingAgent && (
        <AgentDetailPanel
          agent={viewingAgent}
          runs7d={activityByAgent.get(viewingAgent.name as string) ?? 0}
          onClose={() => setViewingAgent(null)}
          onRun={(a) => {
            setViewingAgent(null);
            handleRun(a);
          }}
          onEdit={(a) => {
            setViewingAgent(null);
            handleEdit(a);
          }}
        />
      )}
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
      <RoleDialog
        open={dialogOpen}
        onClose={closeRoleDialog}
        onSave={handleSaveAgent}
        role={editingRole}
        teams={allTeams}
        initialTeamName={creatingForTeam?.name ?? ''}
      />
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
      <BulkAgentModelDialog
        open={bulkModelOpen}
        onClose={() => setBulkModelOpen(false)}
        agentNames={Array.from(selectedAgents)}
        onUpdated={async () => {
          clearSelection();
          await refresh();
        }}
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

const ROUTE_OPTIONS = ['direct_answer', 'data_query', 'spawn_agent', 'run_workflow'];

function csvToArray(value: string): string[] {
  return value.split(',').map(part => part.trim()).filter(Boolean);
}

function arrayToCsv(value: unknown): string {
  return Array.isArray(value) ? value.join(', ') : '';
}

function blankSkill(): SkillRecord {
  return {
    name: '',
    displayName: '',
    description: '',
    category: 'routing',
    triggers: [],
    excludes: [],
    priority: 50,
    enabled: true,
    allowedRoutes: ['direct_answer'],
    relatedWorkflows: [],
    relatedAgents: [],
    tags: [],
    body: `# New Skill

## When to use

## When not to use

## Evidence

## Routing

## Output
`,
  };
}

function LibrarySkillsPane({
  skills, loading, onRefresh, onSave, onDelete,
}: {
  skills: SkillRecord[];
  loading: boolean;
  onRefresh: () => void;
  onSave: (skill: Partial<SkillRecord>) => Promise<void>;
  onDelete: (skill: SkillRecord) => Promise<void>;
}) {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState<string>('new');
  const [draft, setDraft] = useState<SkillRecord>(blankSkill());
  const [saving, setSaving] = useState(false);
  const [testerQuery, setTesterQuery] = useState('');
  const [testerResult, setTesterResult] = useState<any>(null);
  const [testing, setTesting] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter(skill =>
      String(skill.name ?? '').toLowerCase().includes(q)
      || String(skill.displayName ?? '').toLowerCase().includes(q)
      || String(skill.description ?? '').toLowerCase().includes(q)
      || String(skill.category ?? '').toLowerCase().includes(q)
      || (skill.triggers ?? []).some(t => t.toLowerCase().includes(q)),
    );
  }, [query, skills]);

  async function selectSkill(skill: SkillRecord) {
    const key = skill._id ?? skill.id ?? skill.name;
    setActiveId(key);
    try {
      const full = await skillsApi.get(key);
      setDraft({
        ...full,
        triggers: full.triggers ?? [],
        excludes: full.excludes ?? [],
        allowedRoutes: full.allowedRoutes ?? ['direct_answer'],
        relatedWorkflows: full.relatedWorkflows ?? [],
        relatedAgents: full.relatedAgents ?? [],
        tags: full.tags ?? [],
        body: full.body ?? '',
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load skill');
    }
  }

  function newSkill() {
    setActiveId('new');
    setDraft(blankSkill());
  }

  function duplicateSkill(skill: SkillRecord) {
    setActiveId('new');
    setDraft({
      ...skill,
      _id: undefined,
      id: undefined,
      name: `${skill.name}-copy`,
      displayName: `${skill.displayName ?? skill.name} Copy`,
      createdAt: undefined,
      updatedAt: undefined,
      version: undefined,
    });
  }

  async function saveDraft() {
    if (!draft.name.trim()) {
      toast.error('Skill name is required.');
      return;
    }
    setSaving(true);
    try {
      await onSave(draft);
      if (activeId === 'new') newSkill();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save skill');
    } finally {
      setSaving(false);
    }
  }

  async function deleteActive() {
    if (!draft._id && !draft.id) return;
    if (!window.confirm(`Delete skill "${draft.name}"?`)) return;
    try {
      await onDelete(draft);
      newSkill();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete skill');
    }
  }

  async function runTester() {
    if (!testerQuery.trim()) return;
    setTesting(true);
    try {
      setTesterResult(await skillsApi.search({ query: testerQuery, limit: 5, includeDisabled: true }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Skill search failed');
    } finally {
      setTesting(false);
    }
  }

  function setArrayField(field: keyof SkillRecord, value: string) {
    setDraft(prev => ({ ...prev, [field]: csvToArray(value) }));
  }

  function toggleRoute(route: string) {
    setDraft(prev => {
      const current = new Set(prev.allowedRoutes ?? []);
      if (current.has(route)) current.delete(route);
      else current.add(route);
      return { ...prev, allowedRoutes: Array.from(current) };
    });
  }

  return (
    <div className="lib-section lib-skills-section">
      <div className="lib-page-head lib-skills-head">
        <div>
          <h2>skills</h2>
          <p>{skills.length} routing playbooks · loaded on demand by the assistant</p>
        </div>
        <div className="lib-actions">
          <button className="btn btn-secondary btn-sm" onClick={onRefresh}><RefreshCw className="w-3 h-3" /></button>
          <button className="btn btn-primary btn-sm" onClick={newSkill}><Plus className="w-3 h-3" /> new skill</button>
        </div>
      </div>

      <div className="lib-skills-layout">
        <aside className="lib-skills-list-panel">
          <div className="lib-skills-search">
            <div className="lib-search">
              <Search className="w-4 h-4" />
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search skills" />
            </div>
          </div>
          <div className="lib-skills-list-scroll scroll-hide">
            {loading ? (
              Array.from({ length: 8 }).map((_, i) => <div key={i} className="lib-row-skel" />)
            ) : filtered.length === 0 ? (
              <div className="lib-empty">no skills found</div>
            ) : filtered.map(skill => {
              const id = skill._id ?? skill.id ?? skill.name;
              const active = activeId === id;
              return (
                <button
                  key={id}
                  className={`lib-skill-row ${active ? 'active' : ''}`}
                  onClick={() => { void selectSkill(skill); }}
                >
                  <div className="flex items-start gap-3">
                    <BookOpen className="h-4 w-4 text-accent mt-0.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="skill-row-title font-medium text-theme-primary truncate">{skill.displayName ?? skill.name}</span>
                        <span className={`badge ${skill.enabled === false ? 'badge-muted' : 'badge-ok'}`}>
                          {skill.enabled === false ? 'disabled' : 'enabled'}
                        </span>
                      </div>
                      <p className="text-xs text-theme-secondary mt-1 line-clamp-2">{skill.description || 'No description'}</p>
                      <div className="lib-workflow-meta mt-2">
                        <span>{skill.category ?? 'routing'}</span>
                        <span>p{skill.priority ?? 50}</span>
                        <span>{(skill.triggers ?? []).length} triggers</span>
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="lib-skills-editor-scroll scroll-hide">
          <div className="lib-skill-editor">
            <div className="flex items-center justify-between gap-3 mb-4">
              <div>
                <h3 className="text-sm font-semibold text-theme-primary">{activeId === 'new' ? 'new skill' : draft.name}</h3>
                <p className="text-xs text-theme-secondary">Metadata is used for matching. Body is loaded only after a skill is selected.</p>
              </div>
              <div className="lib-actions">
                {(draft._id || draft.id) && (
                  <>
                    <button className="btn btn-secondary btn-sm" onClick={() => duplicateSkill(draft)}>duplicate</button>
                    <button className="btn btn-danger btn-sm" onClick={deleteActive}><Trash2 className="w-3 h-3" /></button>
                  </>
                )}
                <button className="btn btn-primary btn-sm" onClick={saveDraft} disabled={saving}>
                  {saving ? 'saving...' : 'save skill'}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="form-field">
                <span>name</span>
                <input value={draft.name} onChange={e => setDraft(prev => ({ ...prev, name: e.target.value }))} placeholder="bug-fix-routing" />
              </label>
              <label className="form-field">
                <span>display name</span>
                <input value={draft.displayName ?? ''} onChange={e => setDraft(prev => ({ ...prev, displayName: e.target.value }))} placeholder="Bug Fix Routing" />
              </label>
              <label className="form-field">
                <span>category</span>
                <input value={draft.category ?? ''} onChange={e => setDraft(prev => ({ ...prev, category: e.target.value }))} placeholder="implementation" />
              </label>
              <label className="form-field">
                <span>priority</span>
                <input type="number" value={draft.priority ?? 50} onChange={e => setDraft(prev => ({ ...prev, priority: Number(e.target.value) }))} />
              </label>
              <label className="form-field md:col-span-2">
                <span>description</span>
                <input value={draft.description ?? ''} onChange={e => setDraft(prev => ({ ...prev, description: e.target.value }))} placeholder="What this skill routes or explains" />
              </label>
              <label className="form-field">
                <span>triggers</span>
                <input value={arrayToCsv(draft.triggers)} onChange={e => setArrayField('triggers', e.target.value)} placeholder="fix bug, regression, error" />
              </label>
              <label className="form-field">
                <span>excludes</span>
                <input value={arrayToCsv(draft.excludes)} onChange={e => setArrayField('excludes', e.target.value)} placeholder="build feature, create workflow" />
              </label>
              <label className="form-field">
                <span>related workflows</span>
                <input value={arrayToCsv(draft.relatedWorkflows)} onChange={e => setArrayField('relatedWorkflows', e.target.value)} placeholder="bug-investigate-and-fix" />
              </label>
              <label className="form-field">
                <span>related agents</span>
                <input value={arrayToCsv(draft.relatedAgents)} onChange={e => setArrayField('relatedAgents', e.target.value)} placeholder="coding-investigator" />
              </label>
            </div>

            <div className="mt-4">
              <div className="text-xs font-medium text-theme-secondary mb-2">allowed routes</div>
              <div className="flex flex-wrap gap-2">
                {ROUTE_OPTIONS.map(route => (
                  <button
                    key={route}
                    type="button"
                    className={`badge ${draft.allowedRoutes?.includes(route) ? 'badge-ok' : 'badge-muted'}`}
                    onClick={() => toggleRoute(route)}
                  >
                    {route}
                  </button>
                ))}
                <button
                  type="button"
                  className={`badge ${draft.enabled === false ? 'badge-muted' : 'badge-ok'}`}
                  onClick={() => setDraft(prev => ({ ...prev, enabled: prev.enabled === false }))}
                >
                  {draft.enabled === false ? 'disabled' : 'enabled'}
                </button>
              </div>
            </div>

            <label className="form-field mt-4">
              <span>skill body</span>
              <textarea
                className="font-mono text-xs min-h-[360px]"
                value={draft.body ?? ''}
                onChange={e => setDraft(prev => ({ ...prev, body: e.target.value }))}
              />
            </label>
          </div>

          <div className="lib-skill-tester">
            <div className="flex items-center justify-between gap-3 mb-3">
              <div>
                <h3 className="text-sm font-semibold text-theme-primary">skill matcher</h3>
                <p className="text-xs text-theme-secondary">Test the same search endpoint the assistant uses before loading a full skill.</p>
              </div>
              <button className="btn btn-secondary btn-sm" onClick={runTester} disabled={testing || !testerQuery.trim()}>
                {testing ? 'matching...' : 'test'}
              </button>
            </div>
            <textarea
              className="skill-test-textarea w-full min-h-[88px]"
              value={testerQuery}
              onChange={e => setTesterQuery(e.target.value)}
              placeholder="Investigate why checkout is failing in shop repo"
            />
            {testerResult?.matches?.length > 0 && (
              <div className="mt-3 space-y-2">
                {testerResult.matches.map((match: any) => (
                  <div key={match.id ?? match.name} className="rounded-md border border-app p-3">
                    <div className="flex items-center justify-between gap-3">
                      <strong className="text-sm text-theme-primary">{match.displayName ?? match.name}</strong>
                      <span className="mono text-xs text-theme-secondary">score {match.score}</span>
                    </div>
                    <p className="text-xs text-theme-secondary mt-1">{match.description}</p>
                    {match.matched?.length > 0 && (
                      <div className="lib-workflow-meta mt-2">
                        {match.matched.slice(0, 5).map((m: string) => <span key={m}>{m}</span>)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function LibraryTeamsAgentsPane({
  teams, agents, agentsByTeam, activityByAgent, selectedAgents,
  onToggleSelect, onViewAgent, onEditAgent, onDeleteAgent, onRunAgent,
  onCreateTeam, onBuildTeamWithAi, onCreateAgent, onImportAgents, onEditTeam, onDeleteTeam,
  onAddAgentToTeam, onRefresh,
}: {
  teams: Team[];
  agents: any[];
  agentsByTeam: Map<string, any[]>;
  activityByAgent: Map<string, number>;
  selectedAgents: Set<string>;
  onToggleSelect: (name: string) => void;
  onViewAgent: (agent: Agent) => void;
  onEditAgent: (agent: Agent) => void;
  onDeleteAgent: (name: string) => void;
  onRunAgent: (agent: Agent) => void;
  onCreateTeam: () => void;
  onBuildTeamWithAi: () => void;
  onCreateAgent: () => void;
  onImportAgents: () => void;
  onEditTeam: (team: Team) => void;
  onDeleteTeam: (team: Team) => void;
  onAddAgentToTeam: (team: Team) => void;
  onRefresh: () => void;
}) {
  const [activeName, setActiveName] = useState('all');
  const [teamQuery, setTeamQuery] = useState('');
  const [agentQuery, setAgentQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<'all' | 'lead' | 'member'>('all');

  useEffect(() => {
    if (activeName !== 'all' && !teams.some(t => t.name === activeName)) setActiveName('all');
  }, [activeName, teams]);

  const totalAgents = agents.length;
  const leadCount = agents.filter(agent => agent.teamRole === 'lead').length;
  const q = teamQuery.trim().toLowerCase();
  const filteredTeams = teams.filter(team =>
    !q
    || team.name.toLowerCase().includes(q)
    || team.displayName.toLowerCase().includes(q)
    || (team.leadAgentName ?? '').toLowerCase().includes(q)
    || (team.mission ?? '').toLowerCase().includes(q),
  );
  const activeTeam = activeName === 'all' ? null : teams.find(t => t.name === activeName) ?? null;
  const activeMembers = activeTeam ? (agentsByTeam.get(activeTeam.name) ?? []) : agents;
  const activeLead = activeMembers.find(member => member.teamRole === 'lead');
  const memberQ = agentQuery.trim().toLowerCase();
  const matchesAgentFilters = (member: any) => {
    const matchesRole = roleFilter === 'all' || member.teamRole === roleFilter;
    const matchesText = !memberQ
      || String(member.name ?? '').toLowerCase().includes(memberQ)
      || String(member.displayName ?? '').toLowerCase().includes(memberQ)
      || String(member.teamName ?? '').toLowerCase().includes(memberQ)
      || ((member.capabilities as string[] | undefined) ?? []).some(cap => cap.toLowerCase().includes(memberQ));
    return matchesRole && matchesText;
  };
  const filteredMembers = activeMembers.filter(matchesAgentFilters);
  const filteredTeamSet = new Set(filteredTeams.map(team => team.name));
  const groupedFilteredMembers = teams
    .filter(team => activeTeam ? team.name === activeTeam.name : filteredTeamSet.has(team.name))
    .map(team => ({
      team,
      members: (agentsByTeam.get(team.name) ?? []).filter(matchesAgentFilters),
    }))
    .filter(group => group.members.length > 0);
  const unassignedMembers = activeTeam ? [] : agents
    .filter(agent => !agent.teamName && matchesAgentFilters)
    .filter(() => !q || 'unassigned'.includes(q));
  const visibleGroupCount = groupedFilteredMembers.length + (unassignedMembers.length > 0 ? 1 : 0);
  const showingAllAgents = !activeTeam;

  return (
    <div className="flex w-full flex-col gap-5 px-8 py-8">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md border border-app bg-app-card text-accent">
            <Users className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h1 className="text-[24px] font-semibold tracking-tight text-theme-primary">Teams & Agents</h1>
            <p className="mt-1 text-[13px] text-theme-muted">Organize specialist agents, leads, and team ownership.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <IconTooltipButton label="Refresh" onClick={onRefresh} className="h-9 w-9 rounded-md border border-app bg-app-card">
            <RefreshCw className="h-4 w-4" />
          </IconTooltipButton>
          <button className="btn btn-secondary btn-sm h-9" onClick={onImportAgents}>
            <FolderGit2 className="h-3.5 w-3.5" /> Import
          </button>
          <button className="btn btn-secondary btn-sm h-9" onClick={onCreateTeam}>
            <Plus className="h-3.5 w-3.5" /> New team
          </button>
          <button className="btn btn-primary btn-sm h-9" onClick={activeTeam ? () => onAddAgentToTeam(activeTeam) : onCreateAgent}>
            <Sparkles className="h-3.5 w-3.5" /> Add agent
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 rounded-md border border-app bg-app-card px-4 py-3">
        <div className="relative w-[360px] max-w-full">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-theme-muted" />
          <input
            value={agentQuery}
            onChange={event => setAgentQuery(event.target.value)}
            placeholder="Search agents or capabilities..."
            className="h-10 w-full rounded-md border border-app bg-app-muted pl-9 pr-3 text-[13px] text-theme-primary outline-none transition-colors placeholder:text-theme-subtle focus:border-accent focus:shadow-[var(--focus-ring)]"
          />
        </div>
        <div className="flex items-center gap-1 rounded-md border border-app bg-app-muted p-1">
          {(['all', 'lead', 'member'] as const).map(filter => (
            <button
              key={filter}
              onClick={() => setRoleFilter(filter)}
              className={`h-8 rounded px-3 text-[12px] font-medium transition-colors ${
                roleFilter === filter
                  ? 'bg-app-card text-theme-primary shadow-sm'
                  : 'text-theme-muted hover:text-theme-primary'
              }`}
            >
              {filter === 'all' ? 'All roles' : filter === 'lead' ? 'Leads' : 'Members'}
            </button>
          ))}
        </div>
        <div className="hidden items-center gap-2 font-mono text-[12px] text-theme-muted md:flex">
          <span>{teams.length} teams</span>
          <span className="text-theme-subtle">·</span>
          <span>{totalAgents} agents</span>
          <span className="text-theme-subtle">·</span>
          <span>{leadCount} leads</span>
        </div>
      </div>

      <div className="grid min-h-[560px] grid-cols-[280px_minmax(0,1fr)] gap-4">
        <aside className="overflow-hidden rounded-md border border-app bg-app-card">
          <div className="border-b border-app p-3">
            <div className="mb-3 flex items-center justify-between">
              <span className="overline">Teams</span>
              <span className="font-mono text-[11px] text-theme-muted">{filteredTeams.length}</span>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-theme-muted" />
              <input
                placeholder="Search teams..."
                value={teamQuery}
                onChange={event => setTeamQuery(event.target.value)}
                className="h-9 w-full rounded-md border border-app bg-app-muted pl-8 pr-3 text-[12px] text-theme-primary outline-none placeholder:text-theme-subtle focus:border-accent focus:shadow-[var(--focus-ring)]"
              />
            </div>
          </div>
          <div className="max-h-[calc(100vh-310px)] overflow-auto p-2">
            <button
              className={`mb-1 flex w-full items-center justify-between rounded-md px-3 py-2.5 text-left transition-colors ${
                showingAllAgents ? 'bg-app-muted text-theme-primary' : 'text-theme-muted hover:bg-app-muted/60 hover:text-theme-primary'
              }`}
              onClick={() => setActiveName('all')}
            >
              <span>
                <span className="block text-[13px] font-semibold">All agents</span>
                <span className="mt-0.5 block text-[11px] text-theme-muted">Grouped by team</span>
              </span>
              <span className="font-mono text-[11px] text-theme-muted">{totalAgents}</span>
            </button>
            {filteredTeams.length === 0 && (
              <div className="px-3 py-6 text-center text-[12px] text-theme-muted">No teams match "{teamQuery}".</div>
            )}
            {filteredTeams.map(team => {
              const active = activeTeam?.name === team.name;
              const count = agentsByTeam.get(team.name)?.length ?? 0;
              return (
                <button
                  key={team.name}
                  className={`mb-1 flex w-full items-center justify-between rounded-md px-3 py-2.5 text-left transition-colors ${
                    active ? 'bg-accent-soft text-theme-primary' : 'text-theme-muted hover:bg-app-muted/60 hover:text-theme-primary'
                  }`}
                  onClick={() => setActiveName(team.name)}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-semibold">{team.displayName}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-theme-muted">
                      {team.leadAgentName ? `Lead ${team.leadAgentName}` : 'No lead assigned'}
                    </span>
                  </span>
                  <span className="ml-3 shrink-0 font-mono text-[11px] text-theme-muted">{count}</span>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="min-w-0 overflow-hidden rounded-md border border-app bg-app-card">
          {teams.length > 0 || showingAllAgents ? (
            <>
              <header className="flex items-start justify-between gap-4 border-b border-app px-5 py-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-[18px] font-semibold tracking-tight text-theme-primary">
                      {activeTeam ? activeTeam.displayName : 'All agents'}
                    </h2>
                    {activeTeam?.isBuiltIn && <span className="badge badge-muted">built-in</span>}
                  </div>
                  <p className="mt-1 max-w-[720px] text-[13px] text-theme-muted">
                    {activeTeam
                      ? activeTeam.mission || activeTeam.description || 'No mission defined.'
                      : 'Browse every agent grouped by team. Search across names, roles, and capabilities.'}
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-3 font-mono text-[11px] text-theme-muted">
                    {activeTeam ? (
                      <>
                        <span>{activeMembers.length} agents</span>
                        <span className="text-theme-subtle">·</span>
                        <span>Lead {activeLead?.displayName ?? activeLead?.name ?? activeTeam.leadAgentName ?? 'none'}</span>
                        <span className="text-theme-subtle">·</span>
                        <span>{activeTeam.name}</span>
                      </>
                    ) : (
                      <>
                        <span>{teams.length} teams</span>
                        <span className="text-theme-subtle">·</span>
                        <span>{totalAgents} agents</span>
                        <span className="text-theme-subtle">·</span>
                        <span>{leadCount} leads</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {activeTeam && (
                    <IconTooltipButton label="Edit team" onClick={() => onEditTeam(activeTeam)} className="h-9 w-9 rounded-md border border-app">
                      <Pencil className="h-4 w-4" />
                    </IconTooltipButton>
                  )}
                  {activeTeam && !activeTeam.isBuiltIn && (
                    <IconTooltipButton label="Delete team" tone="danger" onClick={() => onDeleteTeam(activeTeam)} className="h-9 w-9 rounded-md border border-app">
                      <Trash2 className="h-4 w-4" />
                    </IconTooltipButton>
                  )}
                </div>
              </header>

              <div className="max-h-[calc(100vh-360px)] overflow-auto p-4">
                {showingAllAgents ? (
                  <div className="space-y-4">
                    {visibleGroupCount === 0 ? (
                      <div className="rounded-md border border-dashed border-app px-4 py-12 text-center text-[13px] text-theme-muted">
                        No agents match these filters.
                      </div>
                    ) : (
                      <>
                        {groupedFilteredMembers.map(group => (
                          <div className="overflow-hidden rounded-md border border-app" key={group.team.name}>
                            <button
                              className="flex w-full items-center justify-between border-b border-app bg-app-muted/45 px-4 py-2.5 text-left transition-colors hover:bg-app-muted"
                              onClick={() => setActiveName(group.team.name)}
                            >
                              <span className="text-[13px] font-semibold text-theme-primary">{group.team.displayName}</span>
                              <span className="font-mono text-[11px] text-theme-muted">{group.members.length} agents</span>
                            </button>
                            <div className="[&>*+*]:border-t [&>*+*]:border-app">
                              {group.members.map(agent => (
                                <LibraryAgentListRow
                                  key={agent.name}
                                  agent={agent}
                                  runs7d={activityByAgent.get(agent.name as string) ?? 0}
                                  selected={selectedAgents.has(agent.name)}
                                  onToggle={() => onToggleSelect(agent.name)}
                                  onView={() => onViewAgent(agent)}
                                  onEdit={() => onEditAgent(agent)}
                                  onDelete={() => onDeleteAgent(agent.name)}
                                  onRun={() => onRunAgent(agent)}
                                />
                              ))}
                            </div>
                          </div>
                        ))}
                        {unassignedMembers.length > 0 && (
                          <div className="overflow-hidden rounded-md border border-app">
                            <div className="flex items-center justify-between border-b border-app bg-app-muted/45 px-4 py-2.5">
                              <span className="text-[13px] font-semibold text-theme-primary">Unassigned</span>
                              <span className="font-mono text-[11px] text-theme-muted">{unassignedMembers.length} agents</span>
                            </div>
                            <div className="[&>*+*]:border-t [&>*+*]:border-app">
                              {unassignedMembers.map(agent => (
                                <LibraryAgentListRow
                                  key={agent.name}
                                  agent={agent}
                                  runs7d={activityByAgent.get(agent.name as string) ?? 0}
                                  selected={selectedAgents.has(agent.name)}
                                  onToggle={() => onToggleSelect(agent.name)}
                                  onView={() => onViewAgent(agent)}
                                  onEdit={() => onEditAgent(agent)}
                                  onDelete={() => onDeleteAgent(agent.name)}
                                  onRun={() => onRunAgent(agent)}
                                />
                              ))}
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-md border border-app">
                    {filteredMembers.length === 0 ? (
                      <div className="px-4 py-12 text-center text-[13px] text-theme-muted">No agents match these filters.</div>
                    ) : (
                      <div className="[&>*+*]:border-t [&>*+*]:border-app">
                        {filteredMembers.map(agent => (
                          <LibraryAgentListRow
                            key={agent.name}
                            agent={agent}
                            runs7d={activityByAgent.get(agent.name as string) ?? 0}
                            selected={selectedAgents.has(agent.name)}
                            onToggle={() => onToggleSelect(agent.name)}
                            onView={() => onViewAgent(agent)}
                            onEdit={() => onEditAgent(agent)}
                            onDelete={() => onDeleteAgent(agent.name)}
                            onRun={() => onRunAgent(agent)}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex h-full min-h-[420px] flex-col items-center justify-center px-6 text-center">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-md border border-app bg-accent-soft text-accent">
                <Users className="h-5 w-5" />
              </div>
              <h2 className="text-[18px] font-semibold text-theme-primary">No teams yet</h2>
              <p className="mt-2 max-w-sm text-[13px] text-theme-muted">Import agents from a repository or create a focused team for Allen to dispatch work.</p>
              <div className="mt-5 flex justify-center gap-2">
                <button className="btn btn-secondary btn-sm" onClick={onBuildTeamWithAi}>Build with AI</button>
                <button className="btn btn-secondary btn-sm" onClick={onImportAgents}>Import</button>
                <button className="btn btn-primary btn-sm" onClick={onCreateAgent}>New agent</button>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function LibraryAgentListRow({
  agent, runs7d, selected, onToggle, onView, onEdit, onDelete, onRun,
}: {
  agent: any;
  runs7d: number;
  selected: boolean;
  onToggle: () => void;
  onView: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onRun: () => void;
}) {
  const isLead = agent.teamRole === 'lead';
  const isBuiltIn = !!agent.isBuiltIn;
  const provider = String(agent.provider ?? 'claude');
  const model = String(agent.model ?? 'sonnet');

  return (
    <div className="grid grid-cols-[28px_minmax(0,1fr)_120px_116px] items-center gap-3 px-4 py-3 transition-colors hover:bg-app-muted/30">
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        aria-label={`Select ${agent.displayName ?? agent.name}`}
        className="h-4 w-4 rounded border-app bg-app-muted text-accent focus:ring-accent"
      />
      <button className="flex min-w-0 items-center gap-3 text-left" onClick={onView}>
        <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-1.5">
            <strong className="truncate text-[13.5px] font-semibold text-theme-primary">{agent.displayName ?? agent.name}</strong>
            {isLead && <Crown className="h-3.5 w-3.5 shrink-0 text-accent-yellow" />}
            {isBuiltIn && <span className="shrink-0 font-mono text-[10px] text-theme-subtle">built-in</span>}
          </span>
          <span className="mt-1 block truncate font-mono text-[11px] text-theme-muted">
            {agent.name}
          </span>
        </span>
      </button>
      <div className="min-w-0 font-mono text-[11px] text-theme-muted">
        <div className="truncate text-theme-secondary">{provider}</div>
        <div className="truncate text-theme-muted">{model}</div>
      </div>
      <div className="flex items-center justify-end gap-1">
        <IconTooltipButton label="Run agent" side="left" onClick={onRun} className="h-8 w-8">
          <Play className="h-3.5 w-3.5" />
        </IconTooltipButton>
        <IconTooltipButton label="Edit agent" side="left" onClick={onEdit} className="h-8 w-8">
          <Pencil className="h-3.5 w-3.5" />
        </IconTooltipButton>
        {!isBuiltIn && (
          <IconTooltipButton label="Delete agent" side="left" tone="danger" onClick={onDelete} className="h-8 w-8">
            <Trash2 className="h-3.5 w-3.5" />
          </IconTooltipButton>
        )}
        {isBuiltIn && (
          <IconTooltipButton label="Built-in agent" side="left" disabled className="h-8 w-8">
            <Trash2 className="h-3.5 w-3.5" />
          </IconTooltipButton>
        )}
      </div>
    </div>
  );
}

function LibraryReposPane({
  repos, loading, onRefresh, onAdd, onOpen,
}: {
  repos: any[];
  loading: boolean;
  onRefresh: () => void;
  onAdd: () => void;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="lib-section">
      <div className="lib-page-head">
        <div>
          <h2>repositories</h2>
          <p>{repos.length} repos registered</p>
        </div>
        <div className="lib-actions">
          <button className="btn btn-secondary btn-sm" onClick={onRefresh}><RefreshCw className="w-3 h-3" /></button>
          <button className="btn btn-primary btn-sm" onClick={onAdd}><Plus className="w-3 h-3" /> add repo</button>
        </div>
      </div>
      <div className="lib-repo-grid">
        {loading ? Array.from({ length: 4 }).map((_, i) => <div key={i} className="lib-repo-skel" />)
          : repos.length === 0 ? <div className="lib-empty">no repositories registered</div>
          : repos.map(repo => (
            <button key={repo._id ?? repo.name} className={`lib-repo-current-card ${repo.status === 'archived' ? 'opacity-50' : ''}`} onClick={() => onOpen(String(repo._id ?? repo.name))}>
              <div className="lib-repo-top">
                <div className="lib-repo-icon"><FolderGit2 className="h-4 w-4" /></div>
                <div className="min-w-0 flex-1">
                  <div className="lib-repo-title-row">
                    <span>{repo.name}</span>
                    {repo.status === 'archived' && <span className="badge badge-muted">archived</span>}
                    {repo.executionCount > 0 && <em>· {repo.executionCount} runs</em>}
                  </div>
                  {repo.description && <p>{repo.description}</p>}
                </div>
                <span className="dot dot-ok mt-1 shrink-0" />
              </div>

              {(repo.detected?.language?.length || repo.detected?.framework?.length || repo.tags?.length) ? (
                <div className="lib-repo-tags">
                  {(repo.detected?.language ?? []).filter((lang: string) => lang !== 'unknown').map((lang: string) => (
                    <span key={lang}>{lang}</span>
                  ))}
                  {(repo.detected?.framework ?? []).map((fw: string) => <span key={fw}>{fw}</span>)}
                  {(repo.tags ?? []).slice(0, 3).map((tag: string) => (
                    <span key={tag}><Tag className="h-2.5 w-2.5" /> {tag}</span>
                  ))}
                </div>
              ) : null}

              <div className="lib-repo-meta">
                <span><GitBranch className="h-3 w-3" />{repo.detected?.defaultBranch ?? repo.branch ?? 'main'}</span>
                {(repo.detected?.remoteUrl || repo.remoteUrl) && (() => {
                  const remote = repo.detected?.remoteUrl ?? repo.remoteUrl;
                  const sshMatch = remote.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
                  const display = remote.replace(/^git@([^:]+):/, '$1/').replace(/^https?:\/\//, '').replace(/\.git$/, '');
                  return <span className="truncate"><ExternalLink className="h-3 w-3" />{display || sshMatch?.[2]}</span>;
                })()}
                {repo.detected?.packageManager && <span>{repo.detected.packageManager}</span>}
              </div>

              <div className="lib-repo-actions">
                <span title="View context"><FileText className="h-3.5 w-3.5" /></span>
                <span title="New workspace"><Monitor className="h-3.5 w-3.5" /></span>
                <span title="Pull latest"><Download className="h-3.5 w-3.5" /></span>
                <span title="Scan"><ScanSearch className="h-3.5 w-3.5" /></span>
                <span title="Workspace config"><Settings className="h-3.5 w-3.5" /></span>
                <span title="Edit"><Pencil className="h-3.5 w-3.5" /></span>
                <span className="ml-auto" title="Delete"><Trash2 className="h-3.5 w-3.5" /></span>
              </div>
            </button>
          ))}
      </div>
    </div>
  );
}

function LibraryIntegrationsPane() {
  return (
    <div className="lib-section lib-integrations-section">
      <div className="lib-page-head">
        <div>
          <h2>integrations</h2>
          <p>MCP servers and external tools available to Allen</p>
        </div>
      </div>
      <McpServerManager />
    </div>
  );
}

// ── Directory shell — tabbed view that drives the Overview pane ──────────
// Matches handoff/pages/agents.jsx AgentsV2:
//   • Breadcrumb + Agents h1 + tab row (Directory / Teams / Graph / Models)
//   • Directory: 3-col grid of agent cards grouped by team
//   • Teams: card per team
//   • Graph: existing SpawnTargetGraph
//   • Models: provider + model distribution

interface DirectoryShellProps {
  total: number;
  teamsCount: number;
  assignedCount: number;
  unassignedCount: number;
  providers: [string, number][];
  models: [string, number][];
  topTeams: { team: Team; count: number }[];
  allTeams: Team[];
  allAgents: any[];
  agentsByTeam: Map<string, any[]>;
  /** runs in last 7 days, keyed by agent.name */
  activityByAgent: Map<string, number>;
  activeTab: 'directory' | 'teams' | 'graph' | 'models';
  onTabChange: (t: 'directory' | 'teams' | 'graph' | 'models') => void;
  search: string;
  onSearchChange: (q: string) => void;
  onSelectTeam: (name: string) => void;
  onViewAgent: (a: any) => void;
  onCreateAgent: () => void;
  onCreateTeam: () => void;
  onRefresh: () => void;
}

function DirectoryShell({
  total, teamsCount, assignedCount, unassignedCount, providers, models, topTeams,
  allTeams, allAgents, agentsByTeam, activityByAgent, activeTab, onTabChange,
  search, onSearchChange,
  onSelectTeam, onViewAgent, onCreateAgent, onCreateTeam, onRefresh,
}: DirectoryShellProps) {
  const q = search.trim().toLowerCase();
  // # of agents that ran at least once in the past 7 days.
  const activeAgentsCount = activityByAgent.size;
  // Total runs across all agents (so the user sees overall throughput).
  const totalRuns7d = useMemo(() => {
    let s = 0;
    for (const v of activityByAgent.values()) s += v;
    return s;
  }, [activityByAgent]);
  return (
    <div className="page-shell">
      {/* Breadcrumb */}
      <div className="page-crumb">
        <span>Org</span>
        <span className="text-theme-subtle">/</span>
        <span>Library</span>
      </div>

      {/* Title + actions */}
      <div className="page-head mb-3">
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="page-title">Library</h1>
          <span className="text-[12px] font-mono text-theme-muted">
            {total} agents · {teamsCount} teams
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* Search — filters Directory + Teams + Models top-list */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-theme-muted pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search teams or agents…"
              className="input pl-8 pr-3 py-1.5 w-64 text-[12px]"
            />
          </div>
          <button onClick={onRefresh} className="btn btn-secondary btn-sm" title="Refresh">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button onClick={onCreateTeam} className="btn btn-secondary btn-sm">
            <Plus className="w-3.5 h-3.5" /> New team
          </button>
          <button onClick={onCreateAgent} className="btn btn-primary btn-sm">
            <Sparkles className="w-3.5 h-3.5" /> New agent
          </button>
        </div>
      </div>

      {/* Tab row */}
      <div className="flex items-center gap-1 mb-5 border-b border-app">
        {([
          { id: 'directory', label: 'Directory' },
          { id: 'teams', label: 'Teams', count: teamsCount },
          { id: 'graph', label: 'Spawn target graph' },
          { id: 'models', label: 'Models' },
        ] as { id: 'directory' | 'teams' | 'graph' | 'models'; label: string; count?: number }[]).map((t) => (
          <button
            key={t.id}
            onClick={() => onTabChange(t.id)}
            className={`px-2.5 py-1.5 text-[13px] -mb-px transition-colors flex items-center gap-1.5 border-b-2 ${
              activeTab === t.id
                ? 'text-theme-primary font-medium border-accent'
                : 'text-theme-muted hover:text-theme-primary border-transparent'
            }`}
          >
            {t.label}
            {t.count != null && <span className="text-[11px] font-mono text-theme-muted">{t.count}</span>}
          </button>
        ))}
      </div>

      {/* KPI strip — visible on every tab so context is always there.
          "Active 7d" counts distinct agents that ran in the last 7 days
          via any caller (chat, workflow orchestrator, direct run). */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-5">
        <KpiTile label="Agents" value={total} />
        <KpiTile label="Teams" value={teamsCount} />
        <KpiTile label="Assigned" value={assignedCount} accent="green" />
        <KpiTile label="Unassigned" value={unassignedCount} accent={unassignedCount > 0 ? 'yellow' : 'muted'} />
        <KpiTile
          label={totalRuns7d > 0 ? `Active 7d · ${totalRuns7d} runs` : 'Active 7d'}
          value={activeAgentsCount}
          accent={activeAgentsCount > 0 ? 'green' : 'muted'}
        />
      </div>

      {activeTab === 'directory' && (
        <DirectoryTab
          allTeams={allTeams}
          agentsByTeam={agentsByTeam}
          activityByAgent={activityByAgent}
          query={q}
          onSelectTeam={onSelectTeam}
          onViewAgent={onViewAgent}
        />
      )}

      {activeTab === 'teams' && (
        <TeamsTab
          allTeams={allTeams}
          agentsByTeam={agentsByTeam}
          query={q}
          onSelectTeam={onSelectTeam}
        />
      )}

      {activeTab === 'graph' && (
        <div className="card p-4">
          <div className="flex items-center gap-2 mb-3">
            <LayoutGrid className="w-4 h-4 text-accent" />
            <span className="overline">Spawn target graph</span>
          </div>
          {allAgents.length > 0 ? (
            <SpawnTargetGraph agents={allAgents} />
          ) : (
            <div className="text-[12px] text-theme-muted italic font-body py-8 text-center">
              No agents yet. Create one to get started.
            </div>
          )}
        </div>
      )}

      {activeTab === 'models' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <DistributionCard title="Providers" entries={providers} accent="blue" />
          <DistributionCard title="Models" entries={models} accent="purple" />
          <div className="md:col-span-2">
            <div className="card p-4">
              <div className="flex items-center gap-2 mb-3">
                <Users className="w-4 h-4 text-accent" />
                <span className="overline">Top teams by size</span>
              </div>
              <div className="space-y-2">
                {topTeams.map(({ team, count }) => (
                  <button
                    key={team.name}
                    onClick={() => onSelectTeam(team.name)}
                    className="w-full flex items-center gap-3 px-2 py-1.5 rounded hover:bg-app-muted transition-colors text-left"
                  >
                    <span className="text-[13px] text-theme-primary flex-1 truncate">{team.displayName}</span>
                    <span className="text-[11px] font-mono text-theme-muted">{count} {count === 1 ? 'member' : 'members'}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Render a 3-col grid of agent cards grouped by team — matches AgentsV2
// reference layout (avatar with initials + name + provider/model meta + dot).
function DirectoryTab({
  allTeams, agentsByTeam, activityByAgent, query, onSelectTeam, onViewAgent,
}: {
  allTeams: Team[];
  agentsByTeam: Map<string, any[]>;
  activityByAgent: Map<string, number>;
  query: string;
  onSelectTeam: (name: string) => void;
  onViewAgent: (a: any) => void;
}) {
  // Filter:
  //  • If query matches a team name/displayName → keep ALL members.
  //  • Otherwise filter members per team by name/displayName/capabilities.
  //  • Hide teams that match nothing.
  const filtered = allTeams
    .map(team => {
      const members = agentsByTeam.get(team.name) ?? [];
      if (!query) return { team, members };
      const teamMatches =
        team.name.toLowerCase().includes(query)
        || team.displayName.toLowerCase().includes(query)
        || (team.mission ?? '').toLowerCase().includes(query);
      if (teamMatches) return { team, members };
      const filteredMembers = members.filter((a: any) =>
        (a.name as string).toLowerCase().includes(query)
        || ((a.displayName as string) ?? '').toLowerCase().includes(query)
        || ((a.capabilities as string[]) ?? []).some((c: string) => c.toLowerCase().includes(query)),
      );
      return { team, members: filteredMembers };
    })
    .filter(g => g.members.length > 0);

  if (filtered.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-app p-12 text-center text-[12px] text-theme-muted font-body italic">
        {query ? `No teams or agents match "${query}".` : 'No teams with agents yet. Create a team and add agents to get started.'}
      </div>
    );
  }
  return (
    <div className="space-y-6">
      {filtered.map(({ team, members }) => {
        const lead = members.find(m => m.teamRole === 'lead');
        return (
          <div key={team.name}>
            <div className="flex items-baseline gap-3 mb-2.5">
              <button
                onClick={() => onSelectTeam(team.name)}
                className="text-[16px] font-semibold text-theme-primary tracking-tight hover:text-accent transition-colors"
              >
                {team.displayName}
              </button>
              <span className="text-[12px] text-theme-muted">
                {members.length} {members.length === 1 ? 'member' : 'members'}
                {lead && (
                  <> · led by <span className="text-theme-secondary">{lead.displayName ?? lead.name}</span></>
                )}
              </span>
              {team.mission && (
                <span className="text-[12px] text-theme-muted truncate ml-auto max-w-[40rem] hidden lg:block">
                  {team.mission}
                </span>
              )}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
              {members.map(a => (
                <AgentRow
                  key={a.name}
                  agent={a}
                  runs7d={activityByAgent.get(a.name as string) ?? 0}
                  onClick={() => onViewAgent(a)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AgentRow({ agent, runs7d, onClick }: { agent: any; runs7d: number; onClick: () => void }) {
  const initials = String(agent.displayName ?? agent.name)
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w: string) => w[0]?.toUpperCase())
    .slice(0, 2)
    .join('');
  const provider = String(agent.provider ?? 'claude');
  const model = String(agent.model ?? 'sonnet');
  const isActive = runs7d > 0;
  return (
    <button
      onClick={onClick}
      className="card-hover p-3 flex items-center gap-3 text-left"
    >
      <div
        className="w-8 h-8 rounded-md flex items-center justify-center text-white text-[11px] font-mono font-semibold shrink-0"
        style={{
          background: `linear-gradient(135deg, ${(agent.color as string) ?? '#2a76e2'}, #9763cc)`,
        }}
      >
        {initials || '?'}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[12.5px] font-medium text-theme-primary truncate">
            {agent.displayName ?? agent.name}
          </span>
          {agent.teamRole === 'lead' && (
            <Crown className="w-3 h-3 text-accent-yellow shrink-0" />
          )}
        </div>
        <div className="text-[11px] font-mono text-theme-muted truncate">
          {provider} · {model}
          {isActive && (
            <>
              <span className="mx-1 text-theme-subtle">·</span>
              <span className="text-accent-green">{runs7d} run{runs7d === 1 ? '' : 's'} · 7d</span>
            </>
          )}
        </div>
      </div>
      <span
        className={`dot ${isActive ? 'dot-ok' : 'dot-idle'} shrink-0`}
        title={isActive ? `${runs7d} runs in the last 7 days` : 'No runs in the last 7 days'}
      />
    </button>
  );
}

// Card-per-team grid for the Teams tab.
function TeamsTab({
  allTeams, agentsByTeam, query, onSelectTeam,
}: {
  allTeams: Team[];
  agentsByTeam: Map<string, any[]>;
  query: string;
  onSelectTeam: (name: string) => void;
}) {
  const visible = !query
    ? allTeams
    : allTeams.filter(t =>
        t.name.toLowerCase().includes(query)
        || t.displayName.toLowerCase().includes(query)
        || (t.mission ?? '').toLowerCase().includes(query),
      );
  if (visible.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-app p-12 text-center text-[12px] text-theme-muted font-body italic">
        {query ? `No teams match "${query}".` : 'No teams yet. Create one to get started.'}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      {visible.map(team => {
        const members = agentsByTeam.get(team.name) ?? [];
        const lead = members.find(m => m.teamRole === 'lead');
        return (
          <button
            key={team.name}
            onClick={() => onSelectTeam(team.name)}
            className="card-hover p-4 text-left flex flex-col gap-2"
          >
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-md bg-accent-soft flex items-center justify-center shrink-0">
                <Users className="w-4 h-4 text-accent" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-[14px] font-semibold text-theme-primary tracking-tight truncate">
                    {team.displayName}
                  </span>
                  {team.isBuiltIn && <span className="badge badge-muted">built-in</span>}
                </div>
                <div className="text-[11px] font-mono text-theme-muted truncate">{team.name}</div>
              </div>
            </div>
            {team.mission && (
              <p className="text-[12px] text-theme-muted line-clamp-2">{team.mission}</p>
            )}
            <div className="flex items-center gap-3 text-[11px] font-mono text-theme-muted mt-auto pt-1">
              <span>{members.length} {members.length === 1 ? 'member' : 'members'}</span>
              {lead && (
                <span className="flex items-center gap-1 truncate">
                  <Crown className="w-3 h-3 text-accent-yellow shrink-0" />
                  <span className="truncate">{lead.displayName ?? lead.name}</span>
                </span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function KpiTile({
  label, value, accent = 'default',
}: {
  label: string;
  value: number;
  accent?: 'default' | 'green' | 'yellow' | 'muted';
}) {
  const valueColor = accent === 'green'
    ? 'text-accent-green'
    : accent === 'yellow'
      ? 'text-accent-yellow'
      : accent === 'muted'
        ? 'text-theme-secondary'
        : 'text-theme-primary';
  return (
    <div className="card p-4">
      <div className={`text-[24px] font-semibold tabular-nums leading-none tracking-tight ${valueColor}`}>
        {value}
      </div>
      <div className="overline mt-2">{label}</div>
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
    <div className="px-6 pt-5 pb-6 space-y-5">
      {/* Breadcrumb (matches handoff/pages/agents.jsx AgentsV2) */}
      <div>
        <div className="flex items-center gap-2 mb-2 text-[12px] text-theme-muted">
          <span>Build</span>
          <span className="text-theme-subtle">/</span>
          <span>Agents</span>
        </div>
        <div className="flex items-center gap-3">
          <h1 className="text-[20px] font-semibold text-theme-primary tracking-tight">Agents</h1>
          <span className="text-[12px] font-mono text-theme-muted">{total} agents · {teamsCount} teams</span>
        </div>
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
          <span className="overline">Spawn Target Graph</span>
        </div>
        {allAgents.length > 0 ? (
          <SpawnTargetGraph agents={allAgents} />
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
  onEditTeam, onDeleteTeam, onAddAgentWithAi, onBackToOverview,
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
  onBackToOverview?: () => void;
}) {
  const canAddAgent = team.name !== 'meta';
  return (
    <div className="page-shell space-y-5">
      {/* Breadcrumb (matches handoff/pages/agents.jsx AgentsV2) */}
      <div className="page-crumb">
        <button onClick={onBackToOverview} className="hover:text-theme-primary transition-colors">Org</button>
        <span className="text-theme-subtle">/</span>
        <button onClick={onBackToOverview} className="hover:text-theme-primary transition-colors">Library</button>
        <span className="text-theme-subtle">/</span>
        <span className="truncate text-theme-secondary">{team.displayName}</span>
      </div>
      {/* Team header */}
      <div className="rounded-xl border border-app bg-app-muted/40 p-5">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-lg bg-accent-soft flex items-center justify-center shrink-0">
            <Users className="w-6 h-6 text-accent" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-[20px] font-semibold text-theme-primary tracking-tight">{team.displayName}</h2>
              {team.isBuiltIn && (
                <span className="badge badge-muted">built-in</span>
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
                className="btn btn-primary btn-sm"
              >
                <Sparkles className="w-3 h-3" /> Add agent
              </button>
            )}
            {!team.isBuiltIn && (
              <>
                <button
                  onClick={onEditTeam}
                  className="btn btn-secondary btn-sm"
                >
                  <Pencil className="w-3 h-3" /> Edit
                </button>
                <button
                  onClick={onDeleteTeam}
                  className="btn btn-ghost btn-sm hover:text-accent-red"
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
