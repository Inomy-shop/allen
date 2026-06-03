import { useState, useRef, useEffect } from 'react';
import { X, Plus, ChevronDown, Terminal } from 'lucide-react';

export type WorkspaceChatTabId =
  | { kind: 'session'; sessionId: string }
  | { kind: 'temp'; tempId: string }
  | { kind: 'terminal' };

export type WorkspaceChatTab = {
  id: WorkspaceChatTabId;
  title: string;
  isTemp: boolean;
  titleSource?: 'default' | 'auto' | 'user';
  tempIndex?: number;
  lastMessageAt?: string;
  streaming?: boolean;
};

export function getTabKey(tab: WorkspaceChatTab): string {
  if (tab.id.kind === 'session') return tab.id.sessionId;
  if (tab.id.kind === 'terminal') return 'terminal';
  return tab.id.tempId;
}

type Props = {
  tabs: WorkspaceChatTab[];
  activeTabKey: string | null;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
  onNewTab: () => void;
  availablePreviousChats: Array<{ _id: string; title?: string; lastMessageAt?: string }>;
  onRestore: (sessionId: string) => void;
};

export default function WorkspaceChatTabs({
  tabs,
  activeTabKey,
  onSelect,
  onClose,
  onNewTab,
  availablePreviousChats,
  onRestore,
}: Props) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState<{ top: number; right: number } | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const dropdownButtonRef = useRef<HTMLButtonElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    if (dropdownOpen) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [dropdownOpen]);

  useEffect(() => {
    if (!dropdownOpen) return;

    function updatePosition() {
      const rect = dropdownButtonRef.current?.getBoundingClientRect();
      if (!rect) return;
      setDropdownPosition({
        top: rect.bottom + 4,
        right: Math.max(8, window.innerWidth - rect.right),
      });
    }

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [dropdownOpen]);

  // Sort available previous chats by lastMessageAt desc, cap at 50
  const sortedPrev = [...availablePreviousChats]
    .sort((a, b) => {
      const at = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
      const bt = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
      return bt - at;
    })
    .slice(0, 50);

  function handleClose(e: React.MouseEvent, key: string, tab: WorkspaceChatTab) {
    e.stopPropagation();
    if (tab.streaming) {
      const confirmed = window.confirm('This chat is still streaming. Close anyway? (It will keep running in the background.)');
      if (!confirmed) return;
    }
    onClose(key);
  }

  return (
    <div className="workspace-chat-tabs flex items-center gap-0 border-b border-app bg-app overflow-x-auto shrink-0">
      <div className="flex items-stretch min-w-0">
        {tabs.map((tab) => {
          const key = getTabKey(tab);
          const isActive = key === activeTabKey;
          const isTerminal = tab.id.kind === 'terminal';
          const label = tab.title || (isTerminal ? 'Terminal' : tab.isTemp ? (tab.tempIndex != null && tab.tempIndex > 0 ? `New chat ${tab.tempIndex}` : 'New chat') : 'chat');
          return (
            <div
              key={key}
              role="tab"
              aria-selected={isActive}
              className={`group relative flex items-center gap-1.5 px-3 py-2 border-r border-t border-app cursor-pointer select-none max-w-[180px] min-w-[80px] shrink-0 transition-colors ${
                isActive
                  ? 'border-t-accent bg-accent-soft text-accent font-semibold'
                  : 'border-t-transparent bg-app text-theme-muted hover:bg-app-muted hover:text-theme-secondary'
              }`}
              onClick={() => onSelect(key)}
            >
              {isTerminal && (
                <Terminal className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              )}
              {tab.streaming && (
                <span className="h-1.5 w-1.5 rounded-full bg-green-500 shrink-0 animate-pulse" title="Streaming" />
              )}
              <span className="truncate flex-1 text-xs" title={label}>{label}</span>
              <button
                type="button"
                onClick={(e) => handleClose(e, key, tab)}
                className="shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 rounded hover:bg-app-muted p-0.5 transition-opacity"
                aria-label="Close tab"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
      </div>

      {/* New tab button */}
      <button
        type="button"
        onClick={onNewTab}
        className="flex items-center gap-1 px-2 py-2 text-theme-muted hover:text-theme-primary hover:bg-app-muted transition-colors shrink-0"
        aria-label="New chat tab"
        title="New chat"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>

      {/* Previous chats dropdown */}
      <div className="relative ml-auto shrink-0" ref={dropdownRef}>
        <button
          ref={dropdownButtonRef}
          type="button"
          disabled={sortedPrev.length === 0}
          onClick={() => setDropdownOpen((prev) => !prev)}
          className="flex items-center gap-1 px-2 py-2 text-xs text-theme-muted hover:text-theme-primary hover:bg-app-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          title="Restore previous chat"
        >
          Previous chats
          <ChevronDown className="h-3 w-3" />
        </button>
        {dropdownOpen && sortedPrev.length > 0 && dropdownPosition && (
          <div
            className="fixed z-50 w-64 rounded-md border border-app bg-app-card shadow-lg"
            style={{ top: dropdownPosition.top, right: dropdownPosition.right }}
          >
            <div className="max-h-60 overflow-y-auto py-1">
              {sortedPrev.map((chat) => {
                const chatTitle = chat.title || `chat ${chat._id.slice(-4)}`;
                return (
                  <button
                    key={chat._id}
                    type="button"
                    onClick={() => {
                      onRestore(chat._id);
                      setDropdownOpen(false);
                    }}
                    className="flex w-full items-center px-3 py-2 text-left text-xs text-theme-secondary hover:bg-app-muted hover:text-theme-primary transition-colors"
                    title={chatTitle}
                  >
                    <span className="truncate">{chatTitle}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
