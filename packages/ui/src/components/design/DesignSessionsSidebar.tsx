import { useMemo, useState } from 'react';
import { Plus, Trash2, Search } from 'lucide-react';
import type { DesignSession } from '../../services/designService';
import DeleteConfirmDialog from '../common/DeleteConfirmDialog';

interface DesignSessionsSidebarProps {
  sessions: DesignSession[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete?: (id: string) => void;
  loadingSessions?: boolean;
}

function statusDot(status: DesignSession['status']): string {
  if (status === 'running') return 'bg-accent-green animate-pulse';
  if (status === 'failed') return 'bg-red-400';
  if (status === 'archived') return 'bg-theme-subtle';
  return 'bg-theme-subtle/60';
}

function timeAgo(dateStr: string): string {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

/**
 * Design sessions sidebar — visual twin of ConversationsSidebar,
 * but drives design sessions rather than chat sessions.
 */
export default function DesignSessionsSidebar({
  sessions,
  activeSessionId,
  onSelect,
  onNew,
  onDelete,
  loadingSessions,
}: DesignSessionsSidebarProps) {
  const [query, setQuery] = useState('');
  const [deleting, setDeleting] = useState<{ id: string; title: string } | null>(null);

  const sorted = useMemo(() => {
    return [...sessions].sort((a, b) => {
      const at = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : new Date(a.updatedAt).getTime();
      const bt = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : new Date(b.updatedAt).getTime();
      return bt - at;
    });
  }, [sessions]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((s) => (s.title ?? '').toLowerCase().includes(q));
  }, [sorted, query]);

  async function handleDelete() {
    if (!deleting) return;
    onDelete?.(deleting.id);
    setDeleting(null);
  }

  return (
    <aside className="w-[260px] shrink-0 border-r border-app flex flex-col min-h-0">
      <div className="px-3 py-2.5 flex items-center justify-between border-b border-app">
        <span className="text-[13px] font-medium text-theme-primary">Designs</span>
        <button
          onClick={onNew}
          className="w-6 h-6 flex items-center justify-center rounded text-theme-muted hover:text-accent hover:bg-app-muted transition-colors"
          title="New design session"
          aria-label="New design session"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="px-2 pt-2 pb-1">
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-theme-muted pointer-events-none" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sessions…"
            aria-label="Search design sessions"
            className="input pl-8 pr-3 py-1.5 w-full text-[12px]"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-1.5 py-1.5 space-y-1">
        {loadingSessions && sessions.length === 0 && (
          <div className="px-3 py-4 text-center text-[12px] text-theme-subtle animate-pulse">
            Loading sessions…
          </div>
        )}
        {!loadingSessions && sessions.length === 0 && (
          <div className="px-3 py-4 text-center text-[12px] text-theme-subtle">
            No design sessions yet
          </div>
        )}
        {!loadingSessions && sessions.length > 0 && filtered.length === 0 && (
          <div className="px-3 py-4 text-center text-[12px] text-theme-subtle">No matches.</div>
        )}
        {filtered.map((s) => {
          const isActive = s._id === activeSessionId;
          return (
            <div
              key={s._id}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(s._id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(s._id);
                }
              }}
              className={`group relative flex items-start gap-2 px-2.5 py-2 rounded-md cursor-pointer transition-colors ${
                isActive
                  ? 'bg-app-card border border-border shadow-sm'
                  : 'hover:bg-app-muted border border-transparent'
              }`}
              title={s.title || 'Untitled design'}
            >
              <span
                className={`mt-[6px] w-1.5 h-1.5 rounded-full shrink-0 ${statusDot(s.status)}`}
                aria-hidden="true"
              />
              <div className="flex-1 min-w-0">
                <div
                  className={`text-[13px] truncate leading-snug ${
                    isActive
                      ? 'text-theme-primary font-medium'
                      : 'text-theme-secondary group-hover:text-theme-primary'
                  }`}
                >
                  {s.title || 'Untitled design'}
                </div>
                <div className="flex items-center gap-1.5 mt-0.5 text-[11px] font-mono">
                  <span className="text-theme-subtle">
                    {timeAgo(s.lastMessageAt || s.updatedAt)}
                  </span>
                </div>
              </div>
              {onDelete && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleting({ id: s._id, title: s.title || 'Untitled design' });
                  }}
                  className="opacity-0 group-hover:opacity-100 focus:opacity-100 shrink-0 w-6 h-6 -mr-0.5 flex items-center justify-center rounded text-theme-subtle hover:text-accent-red hover:bg-accent-red/10 transition-all"
                  title="Delete session"
                  aria-label="Delete session"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              )}
            </div>
          );
        })}
      </div>

      <DeleteConfirmDialog
        open={!!deleting}
        resourceType="session"
        resourceName={deleting?.title ?? ''}
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />
    </aside>
  );
}
