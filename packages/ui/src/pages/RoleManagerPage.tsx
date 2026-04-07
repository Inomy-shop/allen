import { useState } from 'react';
import { useAgents } from '../hooks/useAgents';
import { agents as agentsApi } from '../services/api';
import RoleIcon from '../components/common/RoleIcon';
import RoleDialog from '../components/common/RoleDialog';
import DeleteConfirmDialog from '../components/common/DeleteConfirmDialog';
import { CardSkeleton } from '../components/common/Skeleton';
import { RefreshCw, Plus, Pencil, Trash2, Sparkles, Users, Wrench } from 'lucide-react';
import { DelegationGraph } from '../components/agents/DelegationGraph';

function AgentCard({ agent, onEdit, onDelete }: {
  agent: Record<string, unknown>;
  onEdit: (agent: Record<string, unknown>) => void;
  onDelete: (name: string) => void;
}) {
  return (
    <div className="card p-4 hover:shadow-glow-blue/10 transition-shadow duration-300 group relative">
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
          <h3 className="font-heading text-sm font-semibold text-white tracking-wider truncate">
            {(agent.displayName as string) ?? (agent.name as string)}
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
  const { agents: allAgents, loading, refresh } = useAgents();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<Record<string, unknown> | null>(null);
  const [deletingRole, setDeletingRole] = useState<string | null>(null);

  function handleCreate() {
    setEditingRole(null);
    setDialogOpen(true);
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

  async function handleSave(data: Record<string, unknown>) {
    if (editingRole) {
      await agentsApi.update(data.name as string, data);
    } else {
      await agentsApi.create(data);
    }
    refresh();
  }

  const teamAgents = allAgents.filter((r: any) => r.type === 'team');
  const technicalAgents = allAgents.filter((r: any) => r.type !== 'team');

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

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="font-heading text-xl font-bold text-white tracking-widest uppercase">Agents</h1>
          <p className="text-xs text-gray-500 mt-1 font-body">
            {teamAgents.length} team agents, {technicalAgents.length} technical agents
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button title="Refresh agents" onClick={refresh} className="btn-ghost text-xs">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button title="Create new agent" onClick={handleCreate} className="btn-primary text-xs inline-flex items-center gap-1.5 whitespace-nowrap">
            <Plus className="w-3.5 h-3.5" /> Create Agent
          </button>
        </div>
      </div>

      {/* Delegation Graph */}
      {teamAgents.length > 0 && (
        <div className="mb-6">
          <DelegationGraph agents={allAgents} />
        </div>
      )}

      {/* Team Agents Section */}
      <div className="mb-8">
        <div className="flex items-center gap-2 mb-4">
          <Users className="w-4 h-4 text-accent-blue" />
          <h2 className="font-heading text-sm font-semibold text-gray-300 tracking-wider uppercase">Team Agents</h2>
          <span className="text-[10px] font-mono text-gray-600 bg-surface-200 px-2 py-0.5 rounded-sm">{teamAgents.length}</span>
        </div>
        <p className="text-[11px] text-gray-600 mb-3 font-body">
          High-level agents that communicate, delegate, and coordinate work across the team.
        </p>
        {teamAgents.length === 0 ? (
          <div className="text-xs text-gray-600 font-body py-4">No team agents defined yet.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {teamAgents.map((agent: any) => (
              <AgentCard
                key={agent.name}
                agent={agent}
                onEdit={handleEdit}
                onDelete={setDeletingRole}
              />
            ))}
          </div>
        )}
      </div>

      {/* Technical Agents Section */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <Wrench className="w-4 h-4 text-accent-green" />
          <h2 className="font-heading text-sm font-semibold text-gray-300 tracking-wider uppercase">Technical Agents</h2>
          <span className="text-[10px] font-mono text-gray-600 bg-surface-200 px-2 py-0.5 rounded-sm">{technicalAgents.length}</span>
        </div>
        <p className="text-[11px] text-gray-600 mb-3 font-body">
          Specialized execution agents that perform specific tasks like coding, testing, and reviewing.
        </p>
        {technicalAgents.length === 0 ? (
          <div className="text-xs text-gray-600 font-body py-4">No technical agents defined yet.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {technicalAgents.map((agent: any) => (
              <AgentCard
                key={agent.name}
                agent={agent}
                onEdit={handleEdit}
                onDelete={setDeletingRole}
              />
            ))}
          </div>
        )}
      </div>

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
