import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAgents } from '../hooks/useAgents';
import { agents as agentsApi, teams as teamsApi } from '../services/api';
import RoleIcon from '../components/common/RoleIcon';
import RoleDialog from '../components/common/RoleDialog';
import DeleteConfirmDialog from '../components/common/DeleteConfirmDialog';
import { useToast } from '../components/common/Toast';
import { renderMarkdown } from '../components/chat/ChatMessageList';
import {
  RefreshCw, Sparkles, Pencil, Trash2, Users, Crown,
  Search, Play, ArrowRight, X, Eye, FolderGit2, Plus,
} from 'lucide-react';
import { DelegationGraph } from '../components/agents/DelegationGraph';
import {
  ImportAgentsFromRepoDialog,
  AssignToTeamDialog,
  CreateTeamFromAgentsDialog,
} from '../components/agents/ImportAndTeamDialogs';

interface TeamSummary {
  name: string;
  displayName: string;
  description: string;
  mission?: string;
  leadAgentName: string;
  parentTeamName?: string;
  isBuiltIn: boolean;
}

// ── Agent Detail Panel (markdown viewer for instructions) ────────────────────

function AgentDetailPanel({ agent, onClose }: { agent: Record<string, unknown>; onClose: () => void }) {
  const system = (agent.system as string) ?? '';
  const capabilities = (agent.capabilities as string[] | undefined) ?? [];
  const delegateTargets = (agent.canDelegateTo as string[] | undefined) ?? [];
  const tools = (agent.tools as string[] | undefined) ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md" onClick={onClose}>
      <div className="card w-full max-w-3xl max-h-[90vh] overflow-hidden shadow-glow-blue/20 animate-in fade-in zoom-in-95 duration-200 flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="px-6 py-5 border-b border-border/60 shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-lg flex items-center justify-center border border-border/30"
                style={{ backgroundColor: ((agent.color as string) ?? '#666') + '15' }}
              >
                <RoleIcon icon={agent.icon as string} color={agent.color as string} size={22} />
              </div>
              <div>
                <h2 className="font-heading text-sm font-bold text-theme-primary tracking-wider uppercase">
                  {(agent.displayName as string) ?? (agent.name as string)}
                </h2>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-[10px] text-theme-subtle font-mono">{agent.name as string}</span>
                  <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border ${
                    agent.provider === 'codex' ? 'bg-green-500/10 text-green-500 border-green-500/20' : 'bg-blue-500/10 text-blue-500 border-blue-500/20'
                  }`}>{String(agent.provider ?? 'claude')}</span>
                  <span className="text-[9px] font-mono text-theme-subtle">{String(agent.model ?? 'sonnet')}</span>
                  {agent.teamRole === 'lead' && <Crown className="w-3 h-3 text-accent-yellow" />}
                </div>
              </div>
            </div>
            <button onClick={onClose} className="p-2 rounded-sm hover:bg-surface-200 text-theme-muted hover:text-theme-secondary transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Metadata bar */}
        <div className="px-6 py-3 border-b border-border/30 flex items-center gap-4 flex-wrap shrink-0 bg-surface-200/15">
          {agent.teamName ? (
            <div className="text-[10px]">
              <span className="text-theme-subtle">Team:</span>{' '}
              <span className="text-theme-secondary font-mono">{String(agent.teamName)}</span>
            </div>
          ) : null}
          {capabilities.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              {capabilities.map(cap => (
                <span key={cap} className="text-[8px] font-mono px-1.5 py-0.5 rounded bg-accent-purple/8 text-accent-purple/70 border border-accent-purple/15">{cap}</span>
              ))}
            </div>
          )}
          {tools.length > 0 && (
            <div className="text-[10px]">
              <span className="text-theme-subtle">Tools:</span>{' '}
              <span className="text-theme-secondary font-mono">{tools.join(', ')}</span>
            </div>
          )}
          {delegateTargets.length > 0 && (
            <div className="text-[10px]">
              <span className="text-theme-subtle">Delegates to:</span>{' '}
              <span className="text-theme-secondary font-mono">{delegateTargets.join(', ')}</span>
            </div>
          )}
        </div>

        {/* System prompt — rendered as markdown */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="text-[10px] font-label uppercase tracking-widest text-theme-subtle mb-3">System Instructions</div>
          <div className="text-sm text-theme-secondary leading-relaxed prose-allen">
            {system ? renderMarkdown(system) : <span className="text-theme-muted italic">No system prompt defined.</span>}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-border/60 bg-surface-200/10 shrink-0">
          <button onClick={onClose} className="btn-ghost text-xs">Close</button>
        </div>
      </div>
    </div>
  );
}

// ── Agent Row ────────────────────────────────────────────────────────────────

function AgentRow({ agent, onEdit, onDelete, onRun, onView, selected, onToggleSelect }: {
  agent: Record<string, unknown>;
  onEdit: (agent: Record<string, unknown>) => void;
  onDelete: (name: string) => void;
  onRun: (agent: Record<string, unknown>) => void;
  onView: (agent: Record<string, unknown>) => void;
  selected?: boolean;
  onToggleSelect?: (name: string) => void;
}) {
  const isLead = agent.teamRole === 'lead';
  const isBuiltIn = !!agent.isBuiltIn;
  const capabilities = (agent.capabilities as string[] | undefined) ?? [];
  const delegateTargets = (agent.canDelegateTo as string[] | undefined) ?? [];
  const fromRepo = !!agent.sourceRepoId;

  return (
    <div className={`flex items-center gap-4 px-4 py-3 border-b border-border/10 hover:bg-surface-200/10 transition-colors ${
      isLead ? 'bg-accent-yellow/[0.02]' : ''
    } ${selected ? 'bg-accent-blue/5' : ''}`}>
      {/* Checkbox — disabled for built-ins */}
      <input
        type="checkbox"
        checked={!!selected}
        disabled={isBuiltIn}
        onChange={() => onToggleSelect?.(agent.name as string)}
        title={isBuiltIn ? 'Built-in agents cannot be moved' : 'Select'}
        className="shrink-0"
      />

      {/* Icon with colored bg */}
      <button
        onClick={() => onView(agent)}
        className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 hover:opacity-80 transition-opacity"
        style={{ backgroundColor: ((agent.color as string) ?? '#666') + '15' }}
        title="View instructions"
      >
        <RoleIcon icon={agent.icon as string} color={agent.color as string} size={16} />
      </button>

      {/* Name */}
      <button onClick={() => onView(agent)} className="w-48 min-w-0 text-left shrink-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] text-theme-primary font-body font-medium truncate">{(agent.displayName as string) ?? (agent.name as string)}</span>
          {isLead && <Crown className="w-3 h-3 text-accent-yellow shrink-0" />}
          {fromRepo && (
            <span
              title={`Imported from ${agent.sourceFile ?? 'repo'}`}
              className="inline-flex items-center gap-0.5 text-[8px] font-mono px-1 py-0 rounded-full bg-accent-purple/10 text-accent-purple"
            >
              <FolderGit2 className="w-2.5 h-2.5" /> repo
            </span>
          )}
        </div>
        <span className="text-[10px] text-theme-subtle font-mono block truncate">{agent.name as string}</span>
      </button>

      {/* Provider badge */}
      <span className={`text-[9px] font-mono px-2 py-0.5 rounded-full shrink-0 ${
        agent.provider === 'codex' ? 'bg-accent-green/10 text-accent-green' : 'bg-accent-blue/10 text-accent-blue'
      }`}>{String(agent.provider ?? 'claude')}</span>

      {/* Model badge */}
      <span className="text-[9px] font-mono px-2 py-0.5 rounded-full bg-surface-200/50 text-theme-muted shrink-0">
        {String(agent.model ?? 'sonnet')}
      </span>

      {/* Capabilities tags */}
      <div className="flex-1 min-w-0 flex items-center gap-1 flex-wrap">
        {capabilities.slice(0, 3).map(cap => (
          <span key={cap} className="text-[8px] font-mono px-1.5 py-0.5 rounded-full bg-accent-purple/8 text-accent-purple/60 border border-accent-purple/10">{cap}</span>
        ))}
        {capabilities.length > 3 && <span className="text-[8px] text-theme-subtle">+{capabilities.length - 3}</span>}
      </div>

      {/* Delegation count stat */}
      {delegateTargets.length > 0 && (
        <div className="flex items-center gap-1 text-[10px] font-mono text-theme-muted shrink-0">
          <ArrowRight className="w-3 h-3 text-accent-blue" /> {delegateTargets.length}
        </div>
      )}

      {/* Action buttons — always visible */}
      <div className="flex items-center gap-1.5 shrink-0">
        <button onClick={() => onView(agent)} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-mono bg-accent-blue/10 text-accent-blue hover:bg-accent-blue/20 transition-colors">
          <Eye className="w-3 h-3" /> View
        </button>
        <button onClick={() => onRun(agent)} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-mono bg-accent-green/10 text-accent-green hover:bg-accent-green/20 transition-colors">
          <Play className="w-3 h-3" /> Run
        </button>
        <button onClick={() => onEdit(agent)} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-mono bg-accent-yellow/10 text-accent-yellow hover:bg-accent-yellow/20 transition-colors">
          <Pencil className="w-3 h-3" /> Edit
        </button>
        {!agent.isBuiltIn && (
          <button onClick={() => onDelete(agent.name as string)} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-mono bg-accent-red/10 text-accent-red hover:bg-accent-red/20 transition-colors">
            <Trash2 className="w-3 h-3" /> Delete
          </button>
        )}
      </div>
    </div>
  );
}

// ── Run Agent Dialog ─────────────────────────────────────────────────────────
//
// Fires POST /api/agents/:name/run, which calls the same `spawn_agent` chat
// tool that orchestrator agents use internally — so the execution row shape,
// background runner, and tracing are identical to an MCP-initiated spawn.

function RunAgentDialog({
  agent,
  onClose,
  onStarted,
}: {
  agent: Record<string, unknown>;
  onClose: () => void;
  onStarted: (executionId: string) => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [repoPath, setRepoPath] = useState(((agent.sourceRepoPath as string) ?? '').trim());
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();

  async function submit() {
    const trimmed = prompt.trim();
    if (!trimmed) {
      toast.error('Prompt is required');
      return;
    }
    setSubmitting(true);
    try {
      const result = await agentsApi.run(agent.name as string, {
        prompt: trimmed,
        repo_path: repoPath.trim() || undefined,
      });
      if (result.error) {
        toast.error(result.error);
        setSubmitting(false);
        return;
      }
      toast.success(`Agent "${agent.name as string}" started.`);
      onStarted(result.execution_id);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to start agent');
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md" onClick={onClose}>
      <div className="card w-full max-w-2xl shadow-glow-blue/20 animate-in fade-in zoom-in-95 duration-200" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-5 border-b border-border/60">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-lg flex items-center justify-center border border-border/30"
                style={{ backgroundColor: ((agent.color as string) ?? '#666') + '15' }}
              >
                <RoleIcon icon={agent.icon as string} color={agent.color as string} size={22} />
              </div>
              <div>
                <h2 className="font-heading text-sm font-bold text-theme-primary tracking-wider uppercase">
                  Run {(agent.displayName as string) ?? (agent.name as string)}
                </h2>
                <div className="text-[10px] text-theme-subtle font-mono mt-0.5">{agent.name as string}</div>
              </div>
            </div>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-surface-200/50 transition-colors">
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
              onKeyDown={e => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit();
              }}
              rows={8}
              placeholder="Describe the task for the agent…"
              className="w-full px-3 py-2 rounded-lg bg-surface-200/40 border border-border/50 text-sm text-theme-primary placeholder:text-theme-subtle focus:outline-none focus:border-accent-blue/50"
            />
          </div>
          <div>
            <label className="block text-[10px] font-mono text-theme-muted uppercase tracking-wider mb-1.5">
              Repo path <span className="text-theme-subtle normal-case">(optional — defaults to the agent's source repo)</span>
            </label>
            <input
              type="text"
              value={repoPath}
              onChange={e => setRepoPath(e.target.value)}
              placeholder="/absolute/path/to/repo"
              className="w-full px-3 py-2 rounded-lg bg-surface-200/40 border border-border/50 text-sm text-theme-primary placeholder:text-theme-subtle focus:outline-none focus:border-accent-blue/50"
            />
          </div>
        </div>
        <div className="px-6 py-4 border-t border-border/60 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-[11px] font-mono text-theme-muted hover:text-theme-primary hover:bg-surface-200/40 transition-colors"
          >
            Cancel
          </button>
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

// ── Loading Row Skeleton ────────────────────────────────────────────────────

function RowSkeleton() {
  return (
    <div className="flex items-center gap-4 px-4 py-3 border-b border-border/10 animate-pulse">
      <div className="w-8 h-8 rounded-lg bg-surface-200/50" />
      <div className="w-48 space-y-1.5">
        <div className="h-3.5 w-32 bg-surface-200/50 rounded" />
        <div className="h-2.5 w-20 bg-surface-200/30 rounded" />
      </div>
      <div className="h-4 w-12 bg-surface-200/30 rounded-full" />
      <div className="h-4 w-12 bg-surface-200/30 rounded-full" />
      <div className="flex-1 flex gap-1">
        <div className="h-4 w-16 bg-surface-200/20 rounded-full" />
        <div className="h-4 w-16 bg-surface-200/20 rounded-full" />
      </div>
      <div className="flex gap-1.5">
        <div className="h-6 w-14 bg-surface-200/30 rounded-full" />
        <div className="h-6 w-14 bg-surface-200/30 rounded-full" />
        <div className="h-6 w-14 bg-surface-200/30 rounded-full" />
      </div>
    </div>
  );
}

// ── Main Page ────────────────────────────────────────────────────────────────

export default function RoleManagerPage() {
  const navigate = useNavigate();
  const { agents: allAgents, loading, refresh } = useAgents();
  const [allTeams, setAllTeams] = useState<TeamSummary[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<Record<string, unknown> | null>(null);
  const [deletingRole, setDeletingRole] = useState<string | null>(null);
  const [viewingAgent, setViewingAgent] = useState<Record<string, unknown> | null>(null);
  const [runningAgent, setRunningAgent] = useState<Record<string, unknown> | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  // Import + team-assignment state
  const [importOpen, setImportOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [createTeamOpen, setCreateTeamOpen] = useState(false);
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(new Set());
  const toast = useToast();

  function toggleAgentSelection(name: string) {
    setSelectedAgents(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function clearSelection() {
    setSelectedAgents(new Set());
  }

  useEffect(() => {
    teamsApi.list()
      .then((t: TeamSummary[]) => setAllTeams((t ?? []).slice().sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => setAllTeams([]));
  }, [allAgents]);

  function handleCreate() {
    const teamList = allTeams.length > 0 ? allTeams.map(t => t.name).join(', ') : '(no teams yet)';
    navigate(`/chat?${new URLSearchParams({ agent: 'agent-builder-agent', prompt: `Add a new agent. Available teams: ${teamList}` }).toString()}`);
  }

  function handleRun(agent: Record<string, unknown>) {
    setRunningAgent(agent);
  }

  function handleEdit(role: Record<string, unknown>) { setEditingRole(role); setDialogOpen(true); }

  async function handleDelete() {
    if (!deletingRole) return;
    try {
      await agentsApi.delete(deletingRole);
      toast.success(`Agent "${deletingRole}" deleted.`);
      setDeletingRole(null);
      refresh();
    } catch (err: unknown) { toast.error(err instanceof Error ? err.message : 'Failed to delete'); }
  }

  async function handleSave(data: Record<string, unknown>) {
    if (!editingRole) return;
    await agentsApi.update(data.name as string, data);
    toast.success('Agent updated.');
    refresh();
  }

  // Group by team
  const agentsByTeam = new Map<string, any[]>();
  const unassigned: any[] = [];
  for (const a of allAgents) {
    const tn = (a as any).teamName as string | undefined;
    if (!tn) { unassigned.push(a); continue; }
    (agentsByTeam.get(tn) ?? (agentsByTeam.set(tn, []), agentsByTeam.get(tn)!)).push(a);
  }
  for (const list of agentsByTeam.values()) {
    list.sort((x: any, y: any) => {
      if (x.teamRole === 'lead' && y.teamRole !== 'lead') return -1;
      if (x.teamRole !== 'lead' && y.teamRole === 'lead') return 1;
      return ((x.displayName ?? x.name) as string).localeCompare((y.displayName ?? y.name) as string);
    });
  }

  // Search
  const q = searchQuery.trim().toLowerCase();
  const filteredAgents = q
    ? allAgents.filter((a: any) =>
        (a.name as string).toLowerCase().includes(q)
        || (a.displayName as string)?.toLowerCase().includes(q)
        || (a.teamName as string)?.toLowerCase().includes(q))
    : null;

  const total = allAgents.length;

  if (loading) {
    return (
      <div className="p-6">
        <h1 className="font-heading text-xl font-bold text-theme-primary tracking-widest uppercase mb-6">Agents</h1>
        <div>{Array.from({ length: 6 }).map((_, i) => <RowSkeleton key={i} />)}</div>
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-4">
          <h1 className="font-heading text-xl font-bold text-theme-primary tracking-widest uppercase">Agents</h1>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1 text-[10px] font-mono text-theme-muted">
              <Users className="w-3 h-3 text-accent-blue" /> {total} agents
            </div>
            <div className="flex items-center gap-1 text-[10px] font-mono text-theme-muted">
              <Users className="w-3 h-3 text-accent-purple" /> {allTeams.length} teams
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-theme-subtle" />
            <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search agents..." className="input text-xs pl-8 pr-3 py-1.5 w-44" />
          </div>
          <button title="Refresh" onClick={refresh} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-mono bg-surface-200/30 text-theme-muted hover:bg-surface-200/50 transition-colors">
            <RefreshCw className="w-3 h-3" />
          </button>
          <button onClick={() => setImportOpen(true)} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-[10px] font-mono bg-accent-purple/10 text-accent-purple hover:bg-accent-purple/20 transition-colors">
            <FolderGit2 className="w-3 h-3" /> Import from Repo
          </button>
          <button
            onClick={() => {
              // No agents selected → scaffold an empty team. Otherwise the
              // selected agents become the initial members.
              setCreateTeamOpen(true);
            }}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-[10px] font-mono bg-accent-green/10 text-accent-green hover:bg-accent-green/20 transition-colors"
          >
            <Plus className="w-3 h-3" /> Create Team
          </button>
          <button onClick={handleCreate} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-[10px] font-mono bg-accent-blue/10 text-accent-blue hover:bg-accent-blue/20 transition-colors">
            <Sparkles className="w-3 h-3" /> Create Agent
          </button>
        </div>
      </div>

      {/* Selection bar — appears when any agent is checked */}
      {selectedAgents.size > 0 && (
        <div className="flex items-center justify-between gap-3 mb-4 px-4 py-2 rounded-lg bg-accent-blue/5 border border-accent-blue/20">
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
              className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-[10px] font-mono bg-surface-200/30 text-theme-muted hover:bg-surface-200/50"
            >
              <X className="w-3 h-3" /> Clear
            </button>
          </div>
        </div>
      )}

      {/* Org Chart */}
      {!searchQuery && allAgents.length > 0 && (
        <div className="mb-6"><DelegationGraph agents={allAgents} /></div>
      )}

      {/* Search results */}
      {filteredAgents && (
        <div className="mb-6">
          <span className="text-[10px] text-theme-muted font-mono block mb-2">{filteredAgents.length} result{filteredAgents.length !== 1 ? 's' : ''}</span>
          {/* Column headers */}
          <div className="flex items-center gap-4 px-4 py-2 border-b border-border/20 text-[10px] font-label uppercase tracking-widest text-theme-subtle">
            <span className="w-4" />
            <span className="w-8" />
            <span className="w-48">Name</span>
            <span className="w-16">Provider</span>
            <span className="w-16">Model</span>
            <span className="flex-1">Capabilities</span>
            <span className="w-12 text-right">Deleg.</span>
            <span className="text-right">Actions</span>
          </div>
          {filteredAgents.map((agent: any) => (
            <AgentRow key={agent.name} agent={agent} onEdit={handleEdit} onDelete={setDeletingRole} onRun={handleRun} onView={setViewingAgent} selected={selectedAgents.has(agent.name)} onToggleSelect={toggleAgentSelection} />
          ))}
        </div>
      )}

      {/* Team list */}
      {!searchQuery && (
        <div>
          {allTeams.map(team => {
            const members = agentsByTeam.get(team.name) ?? [];
            if (members.length === 0) return null;
            return (
              <div key={team.name}>
                {/* Team section header */}
                <div className="flex items-center gap-3 px-4 py-3 mt-4 first:mt-0">
                  <div className="w-8 h-8 rounded-lg bg-accent-blue/10 flex items-center justify-center">
                    <Users className="w-4 h-4 text-accent-blue" />
                  </div>
                  <span className="text-sm font-heading font-semibold text-theme-primary tracking-wide">{team.displayName}</span>
                  <div className="flex items-center gap-1 text-[10px] font-mono text-theme-muted">
                    <Users className="w-3 h-3 text-accent-blue" /> {members.length}
                  </div>
                  {team.description && (
                    <span className="text-[11px] text-theme-muted font-body truncate">{team.description}</span>
                  )}
                </div>
                {/* Column headers */}
                <div className="flex items-center gap-4 px-4 py-2 border-b border-border/20 text-[10px] font-label uppercase tracking-widest text-theme-subtle">
                  <span className="w-8" />
                  <span className="w-48">Name</span>
                  <span className="w-16">Provider</span>
                  <span className="w-16">Model</span>
                  <span className="flex-1">Capabilities</span>
                  <span className="w-12 text-right">Deleg.</span>
                  <span className="text-right">Actions</span>
                </div>
                {/* Agent rows */}
                {members.map((agent: any) => (
                  <AgentRow key={agent.name} agent={agent} onEdit={handleEdit} onDelete={setDeletingRole} onRun={handleRun} onView={setViewingAgent} selected={selectedAgents.has(agent.name)} onToggleSelect={toggleAgentSelection} />
                ))}
              </div>
            );
          })}
          {unassigned.length > 0 && (
            <div>
              <div className="flex items-center gap-3 px-4 py-3 mt-4">
                <div className="w-8 h-8 rounded-lg bg-surface-200/30 flex items-center justify-center">
                  <Users className="w-4 h-4 text-theme-muted" />
                </div>
                <span className="text-sm font-heading font-semibold text-theme-muted tracking-wide">Unassigned</span>
                <div className="flex items-center gap-1 text-[10px] font-mono text-theme-muted">
                  <Users className="w-3 h-3 text-theme-subtle" /> {unassigned.length}
                </div>
              </div>
              <div className="flex items-center gap-4 px-4 py-2 border-b border-border/20 text-[10px] font-label uppercase tracking-widest text-theme-subtle">
                <span className="w-8" />
                <span className="w-48">Name</span>
                <span className="w-16">Provider</span>
                <span className="w-16">Model</span>
                <span className="flex-1">Capabilities</span>
                <span className="w-12 text-right">Deleg.</span>
                <span className="text-right">Actions</span>
              </div>
              {unassigned.map((agent: any) => (
                <AgentRow key={agent.name} agent={agent} onEdit={handleEdit} onDelete={setDeletingRole} onRun={handleRun} onView={setViewingAgent} selected={selectedAgents.has(agent.name)} onToggleSelect={toggleAgentSelection} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Agent detail viewer (markdown) */}
      {viewingAgent && <AgentDetailPanel agent={viewingAgent} onClose={() => setViewingAgent(null)} />}

      {/* Run-agent dialog — replaces the old chat redirect. Calls the same
          spawn_agent tool orchestrators use, then jumps to the execution page. */}
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

      {/* Dialogs */}
      <RoleDialog open={dialogOpen} onClose={() => setDialogOpen(false)} onSave={handleSave} role={editingRole} />
      <DeleteConfirmDialog open={!!deletingRole} resourceType="agent" resourceName={deletingRole ?? ''} onConfirm={handleDelete} onCancel={() => setDeletingRole(null)} />
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
        onCreated={() => { clearSelection(); refresh(); }}
      />
    </div>
  );
}
