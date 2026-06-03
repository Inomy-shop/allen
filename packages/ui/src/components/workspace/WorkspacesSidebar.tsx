import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Plus, FolderGit2, Search,
  PanelLeftClose, PanelLeftOpen, ChevronRight, ChevronDown,
} from 'lucide-react';
import { workspaces as wsApi } from '../../services/workspaceService';
import { WorkspaceCreateDialog, type WorkspaceCreateRepo } from './WorkspaceCreateDialog';

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
  repoPath?: string;
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
  const [workspaceCreateRepo, setWorkspaceCreateRepo] = useState<WorkspaceCreateRepo | null>(null);

  function toggleRepo(repoKey: string) {
    setCollapsedRepos((prev) => {
      const next = new Set(prev);
      next.has(repoKey) ? next.delete(repoKey) : next.add(repoKey);
      saveCollapsedRepos(next);
      return next;
    });
  }

  function createWorkspaceForRepo(repo?: WorkspaceCreateRepo | null) {
    if (!repo) return;
    setWorkspaceCreateRepo(repo);
  }

  function prependWorkspace(workspace: Workspace) {
    setList(prev => [workspace, ...prev.filter(item => item._id !== workspace._id)]);
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
          const repoWorkspace = group.items.find((w) => w.repoId) ?? group.items[0];
          const repo = repoWorkspace?.repoId
            ? { _id: repoWorkspace.repoId, name: group.repoName, path: repoWorkspace.repoPath }
            : null;
          return (
          <div key={repoKey}>
            <div className="mb-1 flex items-center gap-1">
              <button
                onClick={() => toggleRepo(repoKey)}
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-2 py-1 text-left hover:bg-app-muted"
                title={isRepoCollapsed ? 'Expand' : 'Collapse'}
                type="button"
              >
                <FolderGit2 className="w-3 h-3 text-theme-muted shrink-0" />
                <span className="text-[11px] font-medium text-theme-secondary truncate flex-1">{group.repoName}</span>
                {isRepoCollapsed
                  ? <ChevronRight className="w-3 h-3 text-theme-subtle shrink-0" />
                  : <ChevronDown className="w-3 h-3 text-theme-subtle shrink-0" />}
              </button>
              <button
                type="button"
                onClick={() => createWorkspaceForRepo(repo)}
                disabled={!repo}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-theme-muted transition-colors hover:bg-app-muted hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
                title={`New workspace in ${group.repoName}`}
                aria-label={`New workspace in ${group.repoName}`}
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
            {showItems && group.items.map((w) => {
              const isActive = w._id === activeId;
              return (
                <div
                  key={w._id}
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(`/chat?workspaceId=${w._id}`)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      navigate(`/chat?workspaceId=${w._id}`);
                    }
                  }}
                  className={`group flex items-center gap-2 px-2.5 py-1.5 rounded-md cursor-pointer transition-colors ${
                    isActive
                      ? 'border border-accent/30 bg-accent-soft shadow-sm'
                      : 'hover:bg-app-muted border border-transparent'
                  }`}
                  title={w.name}
                >
                  <span
                    className={`min-w-0 flex-1 truncate text-[12.5px] font-mono leading-5 ${
                      isActive ? 'text-accent font-medium' : 'text-theme-secondary group-hover:text-theme-primary'
                    }`}
                  >
                    {w.name}
                  </span>
                </div>
              );
            })}
          </div>
          );
        })}
      </div>
      {workspaceCreateRepo && (
        <WorkspaceCreateDialog
          repo={workspaceCreateRepo}
          onClose={() => setWorkspaceCreateRepo(null)}
          onCreatedPending={(workspace) => prependWorkspace(workspace as Workspace)}
          onCreated={(workspace) => {
            prependWorkspace(workspace as Workspace);
            setWorkspaceCreateRepo(null);
            navigate(`/chat?workspaceId=${workspace._id}`);
          }}
        />
      )}
    </aside>
  );
}
