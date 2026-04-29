import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Plus, FolderGit2, GitBranch, Search,
  PanelLeftClose, PanelLeftOpen, ChevronRight, ChevronDown,
} from 'lucide-react';
import { workspaces as wsApi } from '../../services/workspaceService';

const COLLAPSED_REPOS_KEY = 'allen-ws-sidebar-collapsed-repos';

function loadCollapsedRepos(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(COLLAPSED_REPOS_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch { return new Set(); }
}
function saveCollapsedRepos(set: Set<string>) {
  try { localStorage.setItem(COLLAPSED_REPOS_KEY, JSON.stringify(Array.from(set))); } catch { /* ignore */ }
}

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

interface Props {
  collapsed: boolean;
  onToggle: () => void;
  onNew?: () => void;
}

/**
 * In-page Workspaces sidebar — analog to ConversationsSidebar. Renders
 * a 260px column with the workspace list grouped by repo, the active
 * one highlighted, plus a search box and "new" button. Lets users
 * hop between workspaces without losing the in-page detail view.
 *
 * Collapsible: when `collapsed` is true the panel shrinks to a 36px
 * rail with a single expand icon.
 */
export default function WorkspacesSidebar({ collapsed, onToggle, onNew }: Props) {
  const { id: activeId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [list, setList] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(() => loadCollapsedRepos());

  function toggleRepo(repoKey: string) {
    setCollapsedRepos((prev) => {
      const next = new Set(prev);
      next.has(repoKey) ? next.delete(repoKey) : next.add(repoKey);
      saveCollapsedRepos(next);
      return next;
    });
  }

  useEffect(() => {
    setLoading(true);
    wsApi.list()
      .then((data: Workspace[]) => setList(data ?? []))
      .catch(() => setList([]))
      .finally(() => setLoading(false));
  }, [activeId]);

  // Collapsed rail — just an expand button
  if (collapsed) {
    return (
      <aside className="w-[36px] shrink-0 border-r border-app flex flex-col items-center pt-2 gap-2">
        <button
          onClick={onToggle}
          className="w-7 h-7 flex items-center justify-center rounded text-theme-muted hover:text-accent hover:bg-app-muted transition-colors"
          title="Expand workspaces sidebar"
        >
          <PanelLeftOpen className="w-4 h-4" />
        </button>
        {onNew && (
          <button
            onClick={onNew}
            className="w-7 h-7 flex items-center justify-center rounded text-theme-muted hover:text-accent hover:bg-app-muted transition-colors"
            title="New workspace"
          >
            <Plus className="w-4 h-4" />
          </button>
        )}
      </aside>
    );
  }

  const filter = q.trim().toLowerCase();
  const visible = filter
    ? list.filter((w) => w.name.toLowerCase().includes(filter) || (w.repoName ?? '').toLowerCase().includes(filter))
    : list;

  // Group by repo
  const grouped = new Map<string, { repoName: string; items: Workspace[] }>();
  for (const w of visible) {
    const key = w.repoId ?? 'unknown';
    if (!grouped.has(key)) grouped.set(key, { repoName: w.repoName || 'Unknown repo', items: [] });
    grouped.get(key)!.items.push(w);
  }

  return (
    <aside className="w-[260px] shrink-0 border-r border-app flex flex-col min-h-0">
      <div className="px-3 py-2.5 flex items-center justify-between border-b border-app">
        <span className="text-[13px] font-medium text-theme-primary">Workspaces</span>
        <div className="flex items-center gap-1">
          {onNew && (
            <button
              onClick={onNew}
              className="w-6 h-6 flex items-center justify-center rounded text-theme-muted hover:text-accent hover:bg-app-muted transition-colors"
              title="New workspace"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={onToggle}
            className="w-6 h-6 flex items-center justify-center rounded text-theme-muted hover:text-theme-primary hover:bg-app-muted transition-colors"
            title="Collapse sidebar"
          >
            <PanelLeftClose className="w-3.5 h-3.5" />
          </button>
        </div>
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
          <div className="px-3 py-4 text-center text-[12px] text-theme-subtle animate-pulse">Loading workspaces…</div>
        )}
        {!loading && visible.length === 0 && (
          <div className="px-3 py-4 text-center text-[12px] text-theme-subtle">
            {filter ? 'No matches.' : 'No workspaces yet.'}
          </div>
        )}
        {Array.from(grouped.entries()).map(([repoKey, group]) => {
          const isRepoCollapsed = collapsedRepos.has(repoKey);
          // Expand the repo automatically if the active workspace is inside
          // it, even if the user previously collapsed it. Without this
          // toggle the active row would be hidden after a sidebar reload.
          const hasActive = group.items.some((w) => w._id === activeId);
          const showItems = !isRepoCollapsed || hasActive;
          return (
          <div key={repoKey}>
            <button
              onClick={() => toggleRepo(repoKey)}
              className="w-full flex items-center gap-1.5 px-2 mb-1 py-1 rounded hover:bg-app-muted text-left"
              title={isRepoCollapsed ? 'Expand' : 'Collapse'}
            >
              {isRepoCollapsed
                ? <ChevronRight className="w-3 h-3 text-theme-subtle shrink-0" />
                : <ChevronDown className="w-3 h-3 text-theme-subtle shrink-0" />}
              <FolderGit2 className="w-3 h-3 text-theme-muted shrink-0" />
              <span className="text-[11px] font-medium text-theme-secondary truncate flex-1">{group.repoName}</span>
              <span className="text-[10px] font-mono text-theme-subtle">{group.items.length}</span>
            </button>
            {showItems && group.items.map((w) => {
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
          );
        })}
      </div>
    </aside>
  );
}
