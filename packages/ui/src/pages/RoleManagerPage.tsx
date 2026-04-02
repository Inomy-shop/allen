import { useRoles } from '../hooks/useRoles';
import RoleIcon from '../components/common/RoleIcon';
import { CardSkeleton } from '../components/common/Skeleton';
import { RefreshCw } from 'lucide-react';

export default function RoleManagerPage() {
  const { roles, loading, refresh } = useRoles();

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
        <button onClick={refresh} className="btn-ghost text-xs">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {roles.map((role: any) => (
          <div key={role.name} className="card p-4 hover:shadow-glow-blue/10 transition-shadow duration-300">
            <div className="flex items-center gap-3 mb-3">
              <div
                className="w-9 h-9 rounded-sm flex items-center justify-center border border-border/40"
                style={{ backgroundColor: (role.color ?? '#666') + '15' }}
              >
                <RoleIcon icon={role.icon} color={role.color} size={20} />
              </div>
              <div>
                <h3 className="font-heading text-sm font-semibold text-white tracking-wider">{role.name}</h3>
                <span className="text-xs text-gray-500 font-mono">
                  {role.model ?? 'sonnet'}
                  {role.isBuiltIn && ' | built-in'}
                </span>
              </div>
            </div>

            <p className="text-xs text-gray-400 line-clamp-3 mb-3 font-body">
              {role.system?.slice(0, 150)}
            </p>

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
    </div>
  );
}
