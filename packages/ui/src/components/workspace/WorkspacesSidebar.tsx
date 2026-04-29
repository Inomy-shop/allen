import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Plus, FolderGit2, GitBranch, Search } from 'lucide-react';
import { workspaces as wsApi } from '../../services/workspaceService';

const STATUS_BADGE: Record<string, string> = {
  creating: 'badge-warn',
  setting_up: 'badge-warn',
  active: 'badge-ok',
  running: 'badge-info',
  archiving: 'badge-muted',
  failed: 'badge-err',
};

interface Workspace {
  _id: string;
  name: string;
  branch: string;
  baseBranch: string;
  basePort?: number;
  status: string;
  source?: string;
  prNumber?: number;
  repoId?: string;
  repoName?: string;
}

/**
 * In-page workspaces sidebar — analog to ConversationsSidebar. Renders
 * a 260px column with the workspace list grouped by repo, the active
 * one highlighted, plus a search box and "new" button. Lets users hop
 * between sandboxes without going back to /workspaces first.
 */
export default function WorkspacesSidebar() {
  const { id: activeId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [list, setList] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');

  useEffect(() => {
    setLoading(true);
    wsApi.list()
      .then((data: Workspace[]) => setList(data ?? []))
      .catch(() => setList([]))
      .finally(() => setLoading(false));
  }, [activeId]);

  // Group by repo (case-insensitive name; fall back to "Unknown")
  const filter = q.trim().toLowerCase();
  const visible = filter
    ? list.filter((w) => w.name.toLowerCase().includes(filter) || (w.repoName ?? '').toLowerCase().includes(filter))
    : list;

  const grouped = new Map<string, { repoName: string; items: Workspace[] }>();
  for (const w of visible) {
    const key = w.repoId ?? 'unknown';
    if (!grouped.has(key)) grouped.set(key, { repoName: w.repoName || 'Unknown repo', items: [] });
    grouped.get(key)!.items.push(w);
  }

  return (
    <aside className="w-[260px] shrink-0 border-r border-app flex flex-col min-h-0">
      <div className="px-3 py-2.5 flex items-center justify-between border-b border-app">
        <span className="text-[13px] font-medium text-theme-primary">Sandboxes</span>
        <button
          onClick={() => navigate('/workspaces')}
          className="w-6 h-6 flex items-center justify-center rounded text-theme-muted hover:text-accent hover:bg-app-muted transition-colors"
          title="New sandbox"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="px-2 pt-2 pb-1">
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-theme-muted pointer-events-none" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search…"
            className="input pl-8 pr-3 py-1.5 w-full text-[12px]"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-1.5 py-1.5 space-y-3">
        {loading && (
          <div className="px-3 py-4 text-center text-[12px] text-theme-subtle animate-pulse">Loading sandboxes…</div>
        )}
        {!loading && visible.length === 0 && (
          <div className="px-3 py-4 text-center text-[12px] text-theme-subtle">
            {filter ? 'No matches.' : 'No sandboxes yet.'}
          </div>
        )}
        {Array.from(grouped.values()).map((group) => (
          <div key={group.repoName}>
            <div className="flex items-center gap-1.5 px-2 mb-1">
              <FolderGit2 className="w-3 h-3 text-theme-muted" />
              <span className="text-[11px] font-medium text-theme-secondary truncate">{group.repoName}</span>
              <span className="text-[10px] font-mono text-theme-subtle">{group.items.length}</span>
            </div>
            {group.items.map((w) => {
              const isActive = w._id === activeId;
              return (
                <div
                  key={w._id}
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(`/workspaces/${w._id}`)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      navigate(`/workspaces/${w._id}`);
                    }
                  }}
                  className={`group flex items-start gap-2 px-2.5 py-1.5 rounded-md cursor-pointer transition-colors ${
                    isActive
                      ? 'bg-app-card border border-border shadow-sm'
                      : 'hover:bg-app-muted border border-transparent'
                  }`}
                  title={w.name}
                >
                  <GitBranch
                    className={`w-3 h-3 mt-[3px] shrink-0 ${isActive ? 'text-accent' : 'text-theme-muted'}`}
                  />
                  <div className="flex-1 min-w-0">
                    <div
                      className={`text-[12.5px] font-mono truncate leading-snug ${
                        isActive ? 'text-theme-primary font-medium' : 'text-theme-secondary group-hover:text-theme-primary'
                      }`}
                    >
                      {w.name}
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5 text-[10.5px] font-mono">
                      <span className={`badge ${STATUS_BADGE[w.status] ?? 'badge-muted'} !text-[9.5px] !px-1.5 !py-0`}>
                        {w.status}
                      </span>
                      {w.basePort && (
                        <span className="text-theme-subtle">:{w.basePort}</span>
                      )}
                      {w.source === 'pr' && (
                        <span className="text-accent-purple">PR #{w.prNumber}</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </aside>
  );
}
