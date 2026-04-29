import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Trash2, Search } from 'lucide-react';
import { useChat } from '../../hooks/useChat';
import DeleteConfirmDialog from '../common/DeleteConfirmDialog';

const PROV: Record<string, { label: string; color: string }> = {
  codex: { label: 'Codex', color: 'text-accent-green' },
  'claude-cli': { label: 'Claude', color: 'text-accent' },
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

/**
 * In-page conversations sidebar — matches handoff/pages/chat.jsx ChatV2.
 * Renders a 260px column with the conversation list, a "+" button to start
 * a new chat, and per-row delete with confirm dialog. All session/state
 * management goes through the existing useChat hook.
 */
export default function ConversationsSidebar() {
  const navigate = useNavigate();
  const { sessions, activeSessionId, loadingSessions, switchSession, deleteSession } = useChat();
  const [deleting, setDeleting] = useState<{ id: string; title: string } | null>(null);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => (s.title ?? '').toLowerCase().includes(q));
  }, [sessions, query]);

  function handleNew() {
    switchSession('');
    navigate('/chat', { replace: true });
  }

  async function handleDelete() {
    if (!deleting) return;
    await deleteSession(deleting.id);
    setDeleting(null);
    if (activeSessionId === deleting.id) navigate('/chat', { replace: true });
  }

  return (
    <aside className="w-[260px] shrink-0 border-r border-app flex flex-col min-h-0">
      <div className="px-3 py-2.5 flex items-center justify-between border-b border-app">
        <span className="text-[13px] font-medium text-theme-primary">Conversations</span>
        <button
          onClick={handleNew}
          className="w-6 h-6 flex items-center justify-center rounded text-theme-muted hover:text-accent hover:bg-app-muted transition-colors"
          title="New conversation"
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
            placeholder="Search conversations…"
            className="input pl-8 pr-3 py-1.5 w-full text-[12px]"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-1.5 py-1.5 space-y-1">
        {loadingSessions && sessions.length === 0 && (
          <div className="px-3 py-4 text-center text-[12px] text-theme-subtle animate-pulse">Loading conversations…</div>
        )}
        {!loadingSessions && sessions.length === 0 && (
          <div className="px-3 py-4 text-center text-[12px] text-theme-subtle">No conversations yet</div>
        )}
        {!loadingSessions && sessions.length > 0 && filtered.length === 0 && (
          <div className="px-3 py-4 text-center text-[12px] text-theme-subtle">No matches.</div>
        )}
        {filtered.map((s) => {
          const isActive = s._id === activeSessionId;
          const p = PROV[s.provider] ?? { label: s.provider, color: 'text-theme-muted' };
          const dotBg = p.color.replace('text-', 'bg-');
          return (
            <div
              key={s._id}
              role="button"
              tabIndex={0}
              onClick={() => { switchSession(s._id); navigate(`/chat/${s._id}`, { replace: true }); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  switchSession(s._id);
                  navigate(`/chat/${s._id}`, { replace: true });
                }
              }}
              className={`group relative flex items-start gap-2 px-2.5 py-2 rounded-md cursor-pointer transition-colors ${
                isActive
                  ? 'bg-app-card border border-border shadow-sm'
                  : 'hover:bg-app-muted border border-transparent'
              }`}
              title={s.title}
            >
              <span
                className={`mt-[6px] w-1.5 h-1.5 rounded-full shrink-0 ${dotBg}`}
                aria-hidden="true"
              />
              <div className="flex-1 min-w-0">
                <div
                  className={`text-[13px] truncate leading-snug ${
                    isActive ? 'text-theme-primary font-medium' : 'text-theme-secondary group-hover:text-theme-primary'
                  }`}
                >
                  {s.title}
                </div>
                <div className="flex items-center gap-1.5 mt-0.5 text-[11px] font-mono">
                  <span className={p.color}>{p.label}</span>
                  <span className="text-theme-subtle/60">·</span>
                  <span className="text-theme-subtle">{timeAgo(s.lastMessageAt)}</span>
                  {s.messageCount > 0 && (
                    <>
                      <span className="text-theme-subtle/60">·</span>
                      <span className="text-theme-subtle">{s.messageCount} msg</span>
                    </>
                  )}
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setDeleting({ id: s._id, title: s.title });
                }}
                className="opacity-0 group-hover:opacity-100 focus:opacity-100 shrink-0 w-6 h-6 -mr-0.5 flex items-center justify-center rounded text-theme-subtle hover:text-accent-red hover:bg-accent-red/10 transition-all"
                title="Delete conversation"
                aria-label="Delete conversation"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          );
        })}
      </div>
      <DeleteConfirmDialog
        open={!!deleting}
        resourceType="conversation"
        resourceName={deleting?.title ?? ''}
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />
    </aside>
  );
}
