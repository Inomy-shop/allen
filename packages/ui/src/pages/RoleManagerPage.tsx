import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAgents } from '../hooks/useAgents';
import { agents as agentsApi, teams as teamsApi } from '../services/api';
import RoleIcon from '../components/common/RoleIcon';
import RoleDialog from '../components/common/RoleDialog';
import DeleteConfirmDialog from '../components/common/DeleteConfirmDialog';
import { CardSkeleton } from '../components/common/Skeleton';
import { useToast } from '../components/common/Toast';
import {
  RefreshCw, Sparkles, Pencil, Trash2, Users, Crown,
  ChevronDown, ChevronRight, Search, Play, ArrowRight,
} from 'lucide-react';
import { DelegationGraph } from '../components/agents/DelegationGraph';

interface TeamSummary {
  name: string;
  displayName: string;
  description: string;
  mission?: string;
  leadAgentName: string;
  parentTeamName?: string;
  isBuiltIn: boolean;
}

// ── Team Card ────────────────────────────────────────────────────────────────

function TeamCard({
  team, members, onEdit, onDelete, onRun,
}: {
  team: TeamSummary;
  members: any[];
  onEdit: (agent: Record<string, unknown>) => void;
  onDelete: (name: string) => void;
  onRun: (agent: Record<string, unknown>) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const lead = members.find((m: any) => m.teamRole === 'lead');
  const rest = members.filter((m: any) => m.teamRole !== 'lead');

  return (
    <div className={`rounded-lg border overflow-hidden transition-all duration-200 ${
      expanded ? 'border-accent-blue/25 bg-surface-100/60' : 'border-border/15 bg-surface-100/30 hover:border-border/30'
    }`}>
      {/* Header — always visible */}
      <button onClick={() => setExpanded(!expanded)} className="w-full flex items-center gap-3 px-4 py-3.5 text-left group">
        <div className="shrink-0 text-theme-subtle group-hover:text-theme-muted transition-colors">
          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </div>

        <div className="w-9 h-9 rounded-lg bg-accent-blue/8 border border-accent-blue/15 flex items-center justify-center shrink-0">
          <Users className="w-4.5 h-4.5 text-accent-blue" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-heading font-semibold text-theme-primary tracking-wide">{team.displayName}</span>
            <span className="text-[10px] font-mono text-theme-subtle bg-surface-200/50 px-1.5 py-0.5 rounded">{members.length}</span>
            {team.parentTeamName && <span className="text-[9px] font-mono text-theme-subtle">under {team.parentTeamName}</span>}
          </div>
          {team.description && !expanded && (
            <p className="text-[11px] text-theme-muted mt-0.5 truncate">{team.description}</p>
          )}
        </div>

        {/* Lead preview when collapsed */}
        {lead && !expanded && (
          <div className="flex items-center gap-1.5 shrink-0 mr-1">
            <div className="w-5 h-5 rounded flex items-center justify-center" style={{ backgroundColor: ((lead.color as string) ?? '#666') + '20' }}>
              <RoleIcon icon={lead.icon as string} color={lead.color as string} size={12} />
            </div>
            <span className="text-[10px] font-mono text-theme-muted hidden md:inline">{lead.displayName ?? lead.name}</span>
            <Crown className="w-3 h-3 text-accent-yellow" />
          </div>
        )}
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-border/10">
          {/* Mission */}
          {team.mission && (
            <div className="px-5 py-2 bg-surface-200/15 border-b border-border/10">
              <p className="text-[11px] text-theme-muted italic leading-relaxed">{team.mission}</p>
            </div>
          )}

          {/* Agents */}
          {members.map((agent: any) => (
            <AgentRow key={agent.name} agent={agent} onEdit={onEdit} onDelete={onDelete} onRun={onRun} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Agent Row ────────────────────────────────────────────────────────────────

function AgentRow({ agent, onEdit, onDelete, onRun }: {
  agent: Record<string, unknown>;
  onEdit: (agent: Record<string, unknown>) => void;
  onDelete: (name: string) => void;
  onRun: (agent: Record<string, unknown>) => void;
}) {
  const isLead = agent.teamRole === 'lead';
  const capabilities = (agent.capabilities as string[] | undefined) ?? [];
  const delegateTargets = (agent.canDelegateTo as string[] | undefined) ?? [];

  return (
    <div className={`group flex items-center gap-3 px-4 py-3 border-b border-border/8 last:border-0 hover:bg-surface-200/15 transition-colors ${
      isLead ? 'bg-accent-yellow/[0.02]' : ''
    }`}>
      {/* Icon */}
      <div
        className="w-9 h-9 rounded-lg flex items-center justify-center border border-border/20 shrink-0"
        style={{ backgroundColor: ((agent.color as string) ?? '#666') + '12' }}
      >
        <RoleIcon icon={agent.icon as string} color={agent.color as string} size={18} />
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] text-theme-primary font-body font-medium">{(agent.displayName as string) ?? (agent.name as string)}</span>
          {isLead && <Crown className="w-3 h-3 text-accent-yellow shrink-0" />}
          {!!agent.isBuiltIn && (
            <span className="text-[8px] font-mono text-accent-blue/60 bg-accent-blue/8 px-1 py-0 rounded">built-in</span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[10px] text-theme-subtle font-mono">{agent.name as string}</span>
          <span className={`text-[9px] font-mono px-1 py-0 rounded ${
            agent.provider === 'codex' ? 'bg-green-500/10 text-green-500' : 'bg-blue-500/10 text-blue-500'
          }`}>{String(agent.provider ?? 'claude')}</span>
          <span className="text-[9px] font-mono text-theme-subtle">{String(agent.model ?? 'sonnet')}</span>
        </div>
        {/* Capabilities + delegates */}
        {(capabilities.length > 0 || delegateTargets.length > 0) && (
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            {capabilities.slice(0, 4).map(cap => (
              <span key={cap} className="text-[8px] font-mono px-1.5 py-0 rounded bg-accent-purple/6 text-accent-purple/60 border border-accent-purple/10">{cap}</span>
            ))}
            {capabilities.length > 4 && <span className="text-[8px] text-theme-subtle">+{capabilities.length - 4}</span>}
            {delegateTargets.length > 0 && (
              <span className="text-[8px] font-mono text-theme-subtle flex items-center gap-0.5">
                <ArrowRight className="w-2.5 h-2.5" /> {delegateTargets.slice(0, 3).join(', ')}
                {delegateTargets.length > 3 && ` +${delegateTargets.length - 3}`}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Actions — always visible but subtle, bold on hover */}
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={() => onRun(agent)}
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-mono text-accent-green/70 hover:text-accent-green hover:bg-accent-green/10 transition-colors"
          title="Run this agent in chat"
        >
          <Play className="w-3 h-3" /> Run
        </button>
        <button onClick={() => onEdit(agent)} className="p-1.5 rounded text-theme-subtle hover:text-accent-blue hover:bg-accent-blue/10 transition-colors" title="Edit">
          <Pencil className="w-3.5 h-3.5" />
        </button>
        {!agent.isBuiltIn && (
          <button onClick={() => onDelete(agent.name as string)} className="p-1.5 rounded text-theme-subtle hover:text-accent-red hover:bg-accent-red/10 transition-colors" title="Delete">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
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
  const [searchQuery, setSearchQuery] = useState('');
  const toast = useToast();

  useEffect(() => {
    teamsApi.list()
      .then((t: TeamSummary[]) => setAllTeams((t ?? []).slice().sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => setAllTeams([]));
  }, [allAgents]);

  function handleCreate() {
    const teamList = allTeams.length > 0 ? allTeams.map(t => t.name).join(', ') : '(no teams yet)';
    const prompt = `Add a new agent to a team. Available teams: ${teamList}\n\nTell me the team and role.`;
    navigate(`/chat?${new URLSearchParams({ agent: 'agent-builder-agent', prompt }).toString()}`);
  }

  function handleRun(agent: Record<string, unknown>) {
    const name = agent.name as string;
    const displayName = (agent.displayName as string) ?? name;
    navigate(`/chat?${new URLSearchParams({ agent: name, prompt: `You are now talking to ${displayName}. What would you like it to do?` }).toString()}`);
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
        || (a.teamName as string)?.toLowerCase().includes(q)
        || (a.capabilities as string[])?.some(c => c.toLowerCase().includes(q)))
    : null;

  const knownTeamNames = new Set(allTeams.map(t => t.name));
  const orphanTeamNames = Array.from(agentsByTeam.keys()).filter(n => !knownTeamNames.has(n));
  const total = allAgents.length;

  if (loading) {
    return (
      <div className="p-6">
        <h1 className="font-heading text-xl font-bold text-theme-primary tracking-widest uppercase mb-6">Agents</h1>
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => <CardSkeleton key={i} />)}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="font-heading text-xl font-bold text-theme-primary tracking-widest uppercase">Agents</h1>
          <p className="text-xs text-theme-muted mt-0.5 font-body">{total} agents across {allTeams.length} teams</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-theme-subtle" />
            <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search agents..." className="input text-xs pl-8 pr-3 py-1.5 w-44" />
          </div>
          <button title="Refresh" onClick={refresh} className="btn-ghost text-xs"><RefreshCw className="w-3.5 h-3.5" /></button>
          <button onClick={handleCreate} className="btn-primary text-xs inline-flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5" /> Create Agent
          </button>
        </div>
      </div>

      {/* Org Chart */}
      {!searchQuery && allAgents.length > 0 && (
        <div className="mb-6">
          <DelegationGraph agents={allAgents} />
        </div>
      )}

      {/* Search results */}
      {filteredAgents && (
        <div className="mb-6">
          <span className="text-[10px] text-theme-muted font-mono block mb-2">{filteredAgents.length} result{filteredAgents.length !== 1 ? 's' : ''}</span>
          <div className="rounded-lg border border-border/15 bg-surface-100/30 overflow-hidden">
            {filteredAgents.map((agent: any) => (
              <AgentRow key={agent.name} agent={agent} onEdit={handleEdit} onDelete={setDeletingRole} onRun={handleRun} />
            ))}
          </div>
        </div>
      )}

      {/* Team cards */}
      {!searchQuery && (
        <div className="space-y-3">
          {allTeams.map(team => {
            const members = agentsByTeam.get(team.name) ?? [];
            if (members.length === 0) return null;
            return <TeamCard key={team.name} team={team} members={members} onEdit={handleEdit} onDelete={setDeletingRole} onRun={handleRun} />;
          })}

          {orphanTeamNames.map(tn => (
            <TeamCard key={tn}
              team={{ name: tn, displayName: tn, description: '(orphan)', leadAgentName: '', isBuiltIn: false }}
              members={agentsByTeam.get(tn) ?? []} onEdit={handleEdit} onDelete={setDeletingRole} onRun={handleRun} />
          ))}

          {unassigned.length > 0 && (
            <TeamCard
              team={{ name: 'unassigned', displayName: 'Unassigned', description: 'Agents not assigned to any team', leadAgentName: '', isBuiltIn: false }}
              members={unassigned} onEdit={handleEdit} onDelete={setDeletingRole} onRun={handleRun} />
          )}
        </div>
      )}

      <RoleDialog open={dialogOpen} onClose={() => setDialogOpen(false)} onSave={handleSave} role={editingRole} />
      <DeleteConfirmDialog open={!!deletingRole} resourceType="agent" resourceName={deletingRole ?? ''} onConfirm={handleDelete} onCancel={() => setDeletingRole(null)} />
    </div>
  );
}
