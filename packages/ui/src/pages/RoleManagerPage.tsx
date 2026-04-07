import { useState } from 'react';
import { useRoles } from '../hooks/useRoles';
import { roles as rolesApi } from '../services/api';
import RoleIcon from '../components/common/RoleIcon';
import RoleDialog from '../components/common/RoleDialog';
import DeleteConfirmDialog from '../components/common/DeleteConfirmDialog';
import { CardSkeleton } from '../components/common/Skeleton';
import { RefreshCw, Plus, Pencil, Trash2, Sparkles } from 'lucide-react';

export default function RoleManagerPage() {
  const { roles, loading, refresh } = useRoles();
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
      await rolesApi.delete(deletingRole);
      setDeletingRole(null);
      refresh();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to delete role');
    }
  }

  async function handleSave(data: Record<string, unknown>) {
    if (editingRole) {
      await rolesApi.update(data.name as string, data);
    } else {
      await rolesApi.create(data);
    }
    refresh();
  }

  if (loading) {
    return (
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <h1 className="font-heading text-xl font-bold text-white tracking-widest uppercase">Roles</h1>
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
        <h1 className="font-heading text-xl font-bold text-white tracking-widest uppercase">Roles</h1>
        <div className="flex items-center gap-2">
          <button title="Refresh roles" onClick={refresh} className="btn-ghost text-xs">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button title="Create new role" onClick={handleCreate} className="btn-primary text-xs inline-flex items-center gap-1.5 whitespace-nowrap">
            <Plus className="w-3.5 h-3.5" /> Create Role
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {roles.map((role: any) => (
          <div key={role.name} className="card p-4 hover:shadow-glow-blue/10 transition-shadow duration-300 group relative">
            {/* Action buttons — visible on hover */}
            <div className="absolute top-3 right-3 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={() => handleEdit(role)}
                className="btn-ghost p-1.5 text-gray-400 hover:text-accent-blue"
                title="Edit"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setDeletingRole(role.name)}
                className="btn-ghost p-1.5 text-gray-400 hover:text-red-400"
                title="Delete"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Header: icon + name */}
            <div className="flex items-center gap-3 mb-3">
              <div
                className="w-9 h-9 rounded-sm flex items-center justify-center border border-border/40"
                style={{ backgroundColor: (role.color ?? '#666') + '15' }}
              >
                <RoleIcon icon={role.icon} color={role.color} size={20} />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="font-heading text-sm font-semibold text-white tracking-wider truncate">{role.name}</h3>
                <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
                  {role.provider && (
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-sm text-[10px] font-mono border ${
                      role.provider === 'codex'
                        ? 'bg-green-500/10 text-green-400 border-green-500/20'
                        : 'bg-blue-500/10 text-blue-400 border-blue-500/20'
                    }`}>
                      {role.provider}
                    </span>
                  )}
                  <span className="inline-flex items-center px-2 py-0.5 rounded-sm text-[10px] font-mono bg-surface-200 text-gray-400 border border-border/40">
                    {role.model ?? 'sonnet'}
                  </span>
                  {role.isBuiltIn && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-sm text-[10px] font-mono bg-surface-200 text-gray-500 border border-border/40">
                      built-in
                    </span>
                  )}
                  {role.previousSystemPrompt && (
                    <span className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-sm text-[10px] font-mono bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">
                      <Sparkles className="w-2.5 h-2.5" />
                      evolved
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* System prompt preview */}
            <p className="text-xs text-gray-400 line-clamp-3 mb-3 font-body">
              {role.system?.slice(0, 150)}
            </p>

            {/* Tools */}
            {role.tools?.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {role.tools.map((tool: string) => (
                  <span key={tool} className="badge bg-surface-200 text-accent-blue/70 text-[10px] border border-accent-blue/20">
                    {tool}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <RoleDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSave={handleSave}
        role={editingRole}
      />

      <DeleteConfirmDialog
        open={!!deletingRole}
        resourceType="role"
        resourceName={deletingRole ?? ''}
        onConfirm={handleDelete}
        onCancel={() => setDeletingRole(null)}
      />
    </div>
  );
}
