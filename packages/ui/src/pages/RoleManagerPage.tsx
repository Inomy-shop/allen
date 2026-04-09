import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAgents } from '../hooks/useAgents';
import { agents as agentsApi, teams as teamsApi } from '../services/api';
import RoleIcon from '../components/common/RoleIcon';
import RoleDialog from '../components/common/RoleDialog';
import DeleteConfirmDialog from '../components/common/DeleteConfirmDialog';
import { CardSkeleton } from '../components/common/Skeleton';
import { RefreshCw, Sparkles, Pencil, Trash2, Users, Crown } from 'lucide-react';
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

// ── AgentRow ─────────────────────────────────────────────────────────────────
// Horizontal compact row used inside team sections. One agent per row, key
// metadata inline. The full system prompt + capabilities are still editable
// via the pencil button which opens the existing RoleDialog.

function AgentRow({ agent, onEdit, onDelete, isLead }: {
  agent: Record<string, unknown>;
  onEdit: (agent: Record<string, unknown>) => void;
  onDelete: (name: string) => void;
  isLead?: boolean;
}) {
  const capabilities = (agent.capabilities as string[] | undefined) ?? [];
  const tools = (agent.tools as string[] | undefined) ?? [];
  const delegateTargets = (agent.canDelegateTo as string[] | undefined) ?? [];
  const systemPreview = (agent.system as string | undefined)?.slice(0, 140) ?? '';

  return (
    <div
      className={`group flex items-center gap-3 px-3 py-2 border-b border-border/15 hover:bg-surface-200/30 transition-colors ${
        isLead ? 'bg-accent-yellow/[0.02]' : ''
      }`}
    >
      {/* Icon */}
      <div
        className="w-8 h-8 rounded-sm flex items-center justify-center border border-border/40 shrink-0"
        style={{ backgroundColor: ((agent.color as string) ?? '#666') + '15' }}
      >
        <RoleIcon icon={agent.icon as string} color={agent.color as string} size={16} />
      </div>

      {/* Name + crown */}
      <div className="w-44 shrink-0 min-w-0">
        <div className="flex items-center gap-1">
          <span className="text-sm text-white font-heading tracking-wide truncate">
            {(agent.displayName as string) ?? (agent.name as string)}
          </span>
          {isLead && <Crown className="w-3 h-3 text-accent-yellow shrink-0" />}
        </div>
        <div className="text-[10px] text-gray-600 font-mono truncate">{agent.name as string}</div>
      </div>

      {/* Provider / model badges */}
      <div className="flex items-center gap-1 shrink-0">
        {!!agent.provider && (
          <span
            className={`inline-flex items-center px-1.5 py-0.5 rounded-sm text-[10px] font-mono border ${
              agent.provider === 'codex'
                ? 'bg-green-500/10 text-green-400 border-green-500/20'
                : 'bg-blue-500/10 text-blue-400 border-blue-500/20'
            }`}
          >
            {String(agent.provider)}
          </span>
        )}
        <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm text-[10px] font-mono bg-surface-200 text-gray-400 border border-border/40">
          {String(agent.model ?? 'sonnet')}
        </span>
        {!!agent.isBuiltIn && (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm text-[10px] font-mono bg-surface-200 text-gray-500 border border-border/40">
            built-in
          </span>
        )}
      </div>

      {/* System prompt preview — flex-grow takes remaining space */}
      <div className="flex-1 min-w-0 hidden md:block">
        <p className="text-[11px] text-gray-500 font-body truncate" title={(agent.system as string) ?? ''}>
          {systemPreview}
        </p>
        {(capabilities.length > 0 || tools.length > 0 || delegateTargets.length > 0) && (
          <div className="flex items-center gap-2 mt-0.5 text-[10px] font-mono text-gray-600">
            {capabilities.length > 0 && (
              <span className="truncate">
                <span className="text-accent-blue/50">caps:</span>{' '}
                {capabilities.slice(0, 3).join(', ')}
                {capabilities.length > 3 && ` +${capabilities.length - 3}`}
              </span>
            )}
            {tools.length > 0 && (
              <span className="truncate">
                <span className="text-accent-blue/50">tools:</span> {tools.join(', ')}
              </span>
            )}
            {delegateTargets.length > 0 && (
              <span className="truncate">
                <span className="text-accent-blue/50">→</span> {delegateTargets.slice(0, 3).join(', ')}
                {delegateTargets.length > 3 && ` +${delegateTargets.length - 3}`}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Action buttons — visible on hover */}
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        <button
          onClick={() => onEdit(agent)}
          className="p-1.5 rounded text-gray-500 hover:text-accent-blue hover:bg-surface-100/60"
          title="Edit agent"
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => onDelete(agent.name as string)}
          className="p-1.5 rounded text-gray-500 hover:text-red-400 hover:bg-red-500/10"
          title="Delete agent"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

// ── AgentCard (legacy) ───────────────────────────────────────────────────────
// Kept for the "Unassigned" section since those agents typically lack the
// team metadata that makes the row layout meaningful. Can be removed if you
// switch unassigned to rows too.

function AgentCard({ agent, onEdit, onDelete, isLead }: {
  agent: Record<string, unknown>;
  onEdit: (agent: Record<string, unknown>) => void;
  onDelete: (name: string) => void;
  isLead?: boolean;
}) {
  return (
    <div className={`card p-4 hover:shadow-glow-blue/10 transition-shadow duration-300 group relative ${isLead ? 'border-accent-yellow/30' : ''}`}>
      {/* Action buttons — visible on hover */}
      <div className="absolute top-3 right-3 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={() => onEdit(agent)}
          className="btn-ghost p-1.5 text-gray-400 hover:text-accent-blue"
          title="Edit agent"
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => onDelete(agent.name as string)}
          className="btn-ghost p-1.5 text-gray-400 hover:text-red-400"
          title="Delete agent"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Header: icon + name */}
      <div className="flex items-center gap-3 mb-3">
        <div
          className="w-9 h-9 rounded-sm flex items-center justify-center border border-border/40"
          style={{ backgroundColor: ((agent.color as string) ?? '#666') + '15' }}
        >
          <RoleIcon icon={agent.icon as string} color={agent.color as string} size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-heading text-sm font-semibold text-white tracking-wider truncate flex items-center gap-1.5">
            {(agent.displayName as string) ?? (agent.name as string)}
            {isLead && <Crown className="w-3 h-3 text-accent-yellow shrink-0" />}
          </h3>
          <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
            {!!agent.provider && (
              <span className={`inline-flex items-center px-2 py-0.5 rounded-sm text-[10px] font-mono border ${
                agent.provider === 'codex'
                  ? 'bg-green-500/10 text-green-400 border-green-500/20'
                  : 'bg-blue-500/10 text-blue-400 border-blue-500/20'
              }`}>
                {String(agent.provider)}
              </span>
            )}
            <span className="inline-flex items-center px-2 py-0.5 rounded-sm text-[10px] font-mono bg-surface-200 text-gray-400 border border-border/40">
              {String(agent.model ?? 'sonnet')}
            </span>
            {!!agent.isBuiltIn && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-sm text-[10px] font-mono bg-surface-200 text-gray-500 border border-border/40">
                built-in
              </span>
            )}
            {!!agent.previousSystemPrompt && (
              <span className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-sm text-[10px] font-mono bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">
                <Sparkles className="w-2.5 h-2.5" />
                evolved
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Capabilities (for team agents) */}
      {(agent.capabilities as string[])?.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {(agent.capabilities as string[]).slice(0, 4).map((cap: string) => (
            <span key={cap} className="badge bg-accent-blue/5 text-accent-blue/60 text-[9px] border border-accent-blue/15">
              {cap}
            </span>
          ))}
          {(agent.capabilities as string[]).length > 4 && (
            <span className="badge bg-surface-200 text-gray-500 text-[9px] border border-border/30">
              +{(agent.capabilities as string[]).length - 4}
            </span>
          )}
        </div>
      )}

      {/* System prompt preview */}
      <p className="text-xs text-gray-400 line-clamp-2 mb-3 font-body">
        {(agent.system as string)?.slice(0, 120)}
      </p>

      {/* Tools */}
      {(agent.tools as string[])?.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {(agent.tools as string[]).map((tool: string) => (
            <span key={tool} className="badge bg-surface-200 text-accent-blue/70 text-[10px] border border-accent-blue/20">
              {tool}
            </span>
          ))}
        </div>
      )}

      {/* Delegation info (for team agents) */}
      {(agent.canDelegateTo as string[])?.length > 0 && (
        <div className="mt-2 pt-2 border-t border-border/20">
          <span className="text-[10px] text-gray-600 font-mono">
            delegates to: {(agent.canDelegateTo as string[]).join(', ')}
          </span>
        </div>
      )}
    </div>
  );
}

export default function RoleManagerPage() {
  const navigate = useNavigate();
  const { agents: allAgents, loading, refresh } = useAgents();
  const [allTeams, setAllTeams] = useState<TeamSummary[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  // editingRole is always set to a non-null record now — the create flow goes
  // through the AI agent-builder, not this dialog. Kept as `Record | null` for
  // backwards compatibility with RoleDialog's type signature.
  const [editingRole, setEditingRole] = useState<Record<string, unknown> | null>(null);
  const [deletingRole, setDeletingRole] = useState<string | null>(null);

  // Fetch teams once on mount and on refresh
  useEffect(() => {
    teamsApi.list()
      .then((t: TeamSummary[]) => setAllTeams((t ?? []).slice().sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => setAllTeams([]));
  }, [allAgents]);

  // "Create Agent" button → opens a chat with agent-builder-agent preselected.
  // The user tells it which team and what role; the agent-builder researches
  // the role, designs the agent, and creates it after approval.
  function handleCreate() {
    const teamList = allTeams.length > 0
      ? allTeams.map((t) => t.name).join(', ')
      : '(no teams yet — create one first via the Teams page)';
    const prompt = `Add a new agent to a team. Tell me:\n\n1. Which team should it join? Available teams: ${teamList}\n2. What role should the agent fill? (e.g. "tax specialist", "frontend engineer", "content strategist")\n\nI'll research the role and design the agent for your approval.`;
    const params = new URLSearchParams({ agent: 'agent-builder-agent', prompt });
    navigate(`/chat?${params.toString()}`);
  }

  function handleEdit(role: Record<string, unknown>) {
    setEditingRole(role);
    setDialogOpen(true);
  }

  async function handleDelete() {
    if (!deletingRole) return;
    try {
      await agentsApi.delete(deletingRole);
      setDeletingRole(null);
      refresh();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to delete agent');
    }
  }

  // Edit-only save handler — manual create has been moved to the AI agent-builder.
  async function handleSave(data: Record<string, unknown>) {
    if (!editingRole) return; // create path is no longer reachable from this page
    await agentsApi.update(data.name as string, data);
    refresh();
  }

  // Group agents by their teamName. Agents without a teamName fall into "Unassigned".
  const agentsByTeam = new Map<string, any[]>();
  const unassigned: any[] = [];
  for (const a of allAgents) {
    const tn = (a as any).teamName as string | undefined;
    if (!tn) { unassigned.push(a); continue; }
    const list = agentsByTeam.get(tn) ?? [];
    list.push(a);
    agentsByTeam.set(tn, list);
  }

  // Sort each team's members: lead first, then alphabetical
  for (const list of agentsByTeam.values()) {
    list.sort((x, y) => {
      if (x.teamRole === 'lead' && y.teamRole !== 'lead') return -1;
      if (x.teamRole !== 'lead' && y.teamRole === 'lead') return 1;
      return ((x.displayName ?? x.name) as string).localeCompare((y.displayName ?? y.name) as string);
    });
  }

  // Display order for teams: those that appear in `allTeams` (server's list) first
  // in their natural order, then any teams that have agents but no team document
  // (transitional state during migration)
  const knownTeamNames = new Set(allTeams.map((t) => t.name));
  const orphanTeamNames = Array.from(agentsByTeam.keys()).filter((n) => !knownTeamNames.has(n));

  if (loading) {
    return (
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <h1 className="font-heading text-xl font-bold text-white tracking-widest uppercase">Agents</h1>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 9 }).map((_, i) => <CardSkeleton key={i} />)}
        </div>
      </div>
    );
  }

  const totalInTeams = Array.from(agentsByTeam.values()).reduce((s, l) => s + l.length, 0);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="font-heading text-xl font-bold text-white tracking-widest uppercase">Agents</h1>
          <p className="text-xs text-gray-500 mt-1 font-body">
            {totalInTeams} agent{totalInTeams === 1 ? '' : 's'} across {allTeams.length} team{allTeams.length === 1 ? '' : 's'}
            {unassigned.length > 0 && ` · ${unassigned.length} unassigned`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button title="Refresh agents" onClick={refresh} className="btn-ghost text-xs">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            title="Open the AI agent-builder in a new chat — it researches the role, designs the agent, and creates it after your approval"
            onClick={handleCreate}
            className="btn-primary text-xs inline-flex items-center gap-1.5 whitespace-nowrap"
          >
            <Sparkles className="w-3.5 h-3.5" /> Create Agent
          </button>
        </div>
      </div>

      {/* Delegation Graph */}
      {allAgents.length > 0 && (
        <div className="mb-6">
          <DelegationGraph agents={allAgents} />
        </div>
      )}

      {/* Per-team sections */}
      {allTeams.map((team) => {
        const members = agentsByTeam.get(team.name) ?? [];
        if (members.length === 0) return null;
        return (
          <TeamSection key={team.name} team={team} members={members} onEdit={handleEdit} onDelete={setDeletingRole} />
        );
      })}

      {/* Orphan team sections — agents whose teamName references a team that doesn't exist (yet) */}
      {orphanTeamNames.map((tn) => {
        const members = agentsByTeam.get(tn) ?? [];
        return (
          <TeamSection
            key={tn}
            team={{
              name: tn,
              displayName: tn,
              description: '(team document missing — migration may not have run yet)',
              leadAgentName: '',
              isBuiltIn: false,
            }}
            members={members}
            onEdit={handleEdit}
            onDelete={setDeletingRole}
          />
        );
      })}

      {/* Unassigned agents — no teamName at all */}
      {unassigned.length > 0 && (
        <div className="mb-8">
          <div className="flex items-center gap-2 mb-3">
            <Users className="w-4 h-4 text-gray-500" />
            <h2 className="font-heading text-sm font-semibold text-gray-300 tracking-wider uppercase">Unassigned</h2>
            <span className="text-[10px] font-mono text-gray-600 bg-surface-200 px-2 py-0.5 rounded-sm">{unassigned.length}</span>
          </div>
          <p className="text-[11px] text-gray-600 mb-3 font-body">
            Agents that don't belong to any team yet. (Custom agents created before phase 1, or yet-to-be-migrated.)
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {unassigned.map((agent: any) => (
              <AgentCard key={agent.name} agent={agent} onEdit={handleEdit} onDelete={setDeletingRole} />
            ))}
          </div>
        </div>
      )}

      <RoleDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSave={handleSave}
        role={editingRole}
      />

      <DeleteConfirmDialog
        open={!!deletingRole}
        resourceType="agent"
        resourceName={deletingRole ?? ''}
        onConfirm={handleDelete}
        onCancel={() => setDeletingRole(null)}
      />
    </div>
  );
}

// ── Per-team section ──────────────────────────────────────────────────────────

function TeamSection({
  team, members, onEdit, onDelete,
}: {
  team: TeamSummary;
  members: any[];
  onEdit: (agent: Record<string, unknown>) => void;
  onDelete: (name: string) => void;
}) {
  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-2">
        <Users className="w-4 h-4 text-accent-blue" />
        <h2 className="font-heading text-sm font-semibold text-gray-300 tracking-wider uppercase">
          {team.displayName}
        </h2>
        <span className="text-[10px] font-mono text-gray-600 bg-surface-200 px-2 py-0.5 rounded-sm">
          {members.length}
        </span>
        {team.parentTeamName && (
          <span className="text-[10px] font-mono text-gray-600">↳ under {team.parentTeamName}</span>
        )}
        {team.isBuiltIn && (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-sm bg-surface-200 text-gray-500 border border-border/40">
            built-in
          </span>
        )}
      </div>
      {team.description && (
        <p className="text-[11px] text-gray-600 mb-2 font-body">{team.description}</p>
      )}
      <div className="rounded-md border border-border/30 bg-surface-100/30 overflow-hidden">
        {members.map((agent: any) => (
          <AgentRow
            key={agent.name}
            agent={agent}
            onEdit={onEdit}
            onDelete={onDelete}
            isLead={agent.teamRole === 'lead'}
          />
        ))}
      </div>
    </div>
  );
}
