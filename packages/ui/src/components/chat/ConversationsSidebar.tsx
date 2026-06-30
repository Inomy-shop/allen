import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Trash2, Search, Pencil, Sparkles, LoaderCircle, Download, ArrowDownToLine } from 'lucide-react';
import { useChat } from '../../hooks/useChat';
import DeleteConfirmDialog from '../common/DeleteConfirmDialog';
import ChatImportPreviewModal from './ChatImportPreviewModal';
import { PROVIDER_COLORS } from '../../lib/model-catalog';
import { getModelDisplay } from '../../hooks/useModelRegistry';


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
  const { sessions, activeSessionId, loadingSessions, switchSession, deleteSession, updateSessionTitle, generateSessionTitle } = useChat();
  const [deleting, setDeleting] = useState<{ id: string; title: string } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  const [query, setQuery] = useState('');
  const [pendingTitle, setPendingTitle] = useState<string | null>(null);
  const [importModalOpen, setImportModalOpen] = useState(false);
  // useRef available for future focus management if needed
  const _renameRef = useRef<HTMLInputElement | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => (s.title ?? '').toLowerCase().includes(q));
  }, [sessions, query]);

  function handleNew() {
    switchSession('');
    navigate('/chat', { replace: true });
  }

  function handleImported(sessionId: string) {
    setImportModalOpen(false);
    switchSession(sessionId);
    navigate(`/chat/${sessionId}`, { replace: true });
  }

  async function handleDelete() {
    if (!deleting) return;
    await deleteSession(deleting.id);
    setDeleting(null);
    if (activeSessionId === deleting.id) navigate('/chat', { replace: true });
  }

  async function handleRenameCommit() {
    if (!renaming) return;
    const trimmed = renaming.draft.trim();
    if (trimmed && trimmed !== sessions.find(s => s._id === renaming.id)?.title) {
      try { await updateSessionTitle(renaming.id, trimmed); } catch {}
    }
    setRenaming(null);
  }

  return (
    <aside className="w-[260px] shrink-0 border-r border-app flex flex-col min-h-0">
      <div className="px-3 py-2.5 flex items-center justify-between border-b border-app">
        <span className="text-[13px] font-medium text-theme-primary">Conversations</span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setImportModalOpen(true)}
            className="w-6 h-6 flex items-center justify-center rounded text-theme-muted hover:text-accent hover:bg-app-muted transition-colors"
            title="Import chat"
            aria-label="Import chat"
          >
            <Download className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleNew}
            className="w-6 h-6 flex items-center justify-center rounded text-theme-muted hover:text-accent hover:bg-app-muted transition-colors"
            title="New conversation"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
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
          const { providerLabel } = getModelDisplay(s.provider);
          const colors = PROVIDER_COLORS[s.provider] ?? { color: 'text-theme-muted', dotBg: 'bg-theme-muted' };
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
                className={`mt-[6px] w-1.5 h-1.5 rounded-full shrink-0 ${colors.dotBg}`}
                aria-hidden="true"
              />
              <div className="flex-1 min-w-0">
                {renaming?.id === s._id ? (
                  <input
                    autoFocus
                    value={renaming.draft}
                    onChange={(e) => setRenaming(r => r ? { ...r, draft: e.target.value } : r)}
                    onBlur={handleRenameCommit}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); handleRenameCommit(); }
                      if (e.key === 'Escape') { e.preventDefault(); setRenaming(null); }
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="input py-0.5 px-1 text-[13px] w-full leading-snug"
                  />
                ) : (
                  <div
                    className={`text-[13px] truncate leading-snug ${
                      isActive ? 'text-theme-primary font-medium' : 'text-theme-secondary group-hover:text-theme-primary'
                    }`}
                  >
                    {s.title}
                  </div>
                )}
                <div className="flex items-center gap-1.5 mt-0.5 text-[11px] font-mono">
                  <span className={colors.color}>{providerLabel}</span>
                  <span className="text-theme-subtle/60">·</span>
                  <span className="text-theme-subtle">{timeAgo(s.lastMessageAt)}</span>
                  {s.messageCount > 0 && (
                    <>
                      <span className="text-theme-subtle/60">·</span>
                      <span className="text-theme-subtle">{s.messageCount} msg</span>
                    </>
                  )}
                  {s.isImported && (
                    <>
                      <span className="text-theme-subtle/60">·</span>
                      <span className="inline-flex items-center gap-1 text-[10px] text-yellow-600 bg-yellow-100/60 rounded-full px-1.5 py-0 leading-tight">
                        <ArrowDownToLine className="w-2.5 h-2.5" />
                        Imported
                      </span>
                    </>
                  )}
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setRenaming({ id: s._id, draft: s.title });
                }}
                className="opacity-0 group-hover:opacity-100 focus:opacity-100 shrink-0 w-6 h-6 flex items-center justify-center rounded text-theme-subtle hover:text-accent hover:bg-accent/10 transition-all"
                title="Rename conversation"
                aria-label="Rename conversation"
              >
                <Pencil className="w-3 h-3" />
              </button>
              {s.title === 'New Conversation' && (s.messageCount ?? 0) > 0 && (
                <button
                  onClick={async (e) => {
                    e.stopPropagation();
                    setPendingTitle(s._id);
                    try { await generateSessionTitle(s._id); } catch {} finally { setPendingTitle(null); }
                  }}
                  disabled={pendingTitle === s._id}
                  className="opacity-0 group-hover:opacity-100 focus:opacity-100 shrink-0 w-6 h-6 flex items-center justify-center rounded text-theme-subtle hover:text-accent hover:bg-accent/10 transition-all"
                  title="Generate title"
                  aria-label="Generate title"
                >
                  {pendingTitle === s._id
                    ? <LoaderCircle className="w-3 h-3 animate-spin" />
                    : <Sparkles className="w-3 h-3" />}
                </button>
              )}
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
      <ChatImportPreviewModal
        isOpen={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        onImported={handleImported}
      />
    </aside>
  );
}
