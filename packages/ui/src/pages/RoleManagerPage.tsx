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
          <h1 className="text-xl font-bold text-white">Roles</h1>
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
        <h1 className="text-xl font-bold text-white">Roles</h1>
        <button onClick={refresh} className="btn-ghost text-xs">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {roles.map((role: any) => (
          <div key={role.name} className="card p-4">
            <div className="flex items-center gap-3 mb-3">
              <div
                className="w-9 h-9 rounded-lg flex items-center justify-center"
                style={{ backgroundColor: (role.color ?? '#666') + '20' }}
              >
                <RoleIcon icon={role.icon} color={role.color} size={20} />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-white">{role.name}</h3>
                <span className="text-xs text-gray-500">
                  {role.model ?? 'sonnet'}
                  {role.isBuiltIn && ' · built-in'}
                </span>
              </div>
            </div>

            <p className="text-xs text-gray-400 line-clamp-3 mb-3">
              {role.system?.slice(0, 150)}
            </p>

            {role.tools?.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {role.tools.map((tool: string) => (
                  <span key={tool} className="badge bg-surface-200 text-gray-400 text-[10px]">
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
