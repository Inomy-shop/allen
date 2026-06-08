import { Plus } from 'lucide-react';
import type { DesignSession } from '../../services/designService';

interface DesignConversationListProps {
  sessions: DesignSession[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}

function statusDot(status: DesignSession['status']): string {
  if (status === 'running') return 'bg-accent-green animate-pulse';
  if (status === 'failed') return 'bg-red-400';
  if (status === 'archived') return 'bg-theme-subtle';
  return 'bg-theme-subtle/60';
}

export default function DesignConversationList({
  sessions,
  activeSessionId,
  onSelect,
  onNew,
}: DesignConversationListProps) {
  const sorted = [...sessions].sort((a, b) => {
    const aTime = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : new Date(a.createdAt).getTime();
    const bTime = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : new Date(b.createdAt).getTime();
    return bTime - aTime;
  });

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-app px-3 py-2">
        <button
          type="button"
          onClick={onNew}
          className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-app bg-app-muted px-3 py-2 text-[12px] font-medium text-theme-secondary transition-colors hover:border-app-strong hover:text-theme-primary"
        >
          <Plus className="h-3.5 w-3.5" />
          New design
        </button>
      </div>

      <div className="flex-1 overflow-y-auto scroll-hide py-1">
        {sorted.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px] text-theme-subtle">
            No design sessions yet.
          </div>
        ) : (
          sorted.map((session) => {
            const active = session._id === activeSessionId;
            return (
              <button
                key={session._id}
                type="button"
                onClick={() => onSelect(session._id)}
                className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-left transition-colors mx-1 my-0.5 ${
                  active
                    ? 'bg-accent-soft text-accent'
                    : 'text-theme-secondary hover:bg-app-muted hover:text-theme-primary'
                }`}
                style={{ width: 'calc(100% - 8px)' }}
              >
                <span
                  className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${statusDot(session.status)}`}
                  aria-label={session.status}
                />
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
                  {session.title || 'Untitled design'}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
