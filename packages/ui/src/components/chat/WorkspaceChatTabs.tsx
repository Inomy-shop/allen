import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { X, Plus, ChevronDown, MessageSquare, Server, Terminal } from 'lucide-react';

export type WorkspaceChatTabId =
  | { kind: 'session'; sessionId: string }
  | { kind: 'temp'; tempId: string }
  | { kind: 'terminal' }
  | { kind: 'servers' };

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
  if (tab.id.kind === 'servers') return 'servers';
  return tab.id.tempId;
}

type Props = {
  tabs: WorkspaceChatTab[];
  activeTabKey: string | null;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
  onReorder: (dragKey: string, targetKey: string, position: 'before' | 'after') => void;
  onNewTab: () => void;
  availablePreviousChats: Array<{ _id: string; title?: string; lastMessageAt?: string }>;
  onRestore: (sessionId: string) => void;
};

export default function WorkspaceChatTabs({
  tabs,
  activeTabKey,
  onSelect,
  onClose,
  onReorder,
  onNewTab,
  availablePreviousChats,
  onRestore,
}: Props) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState<{ top: number; right: number } | null>(null);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<{ key: string; position: 'before' | 'after' } | null>(null);
  const [tabMetrics, setTabMetrics] = useState({ tabWidth: 300, railWidth: 300 });
  const rootRef = useRef<HTMLDivElement>(null);
  const newTabButtonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const dropdownButtonRef = useRef<HTMLButtonElement>(null);

  // Sort available previous chats by lastMessageAt desc, cap at 50
  const sortedPrev = [...availablePreviousChats]
    .sort((a, b) => {
      const at = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
      const bt = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
      return bt - at;
    })
    .slice(0, 50);

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

  useLayoutEffect(() => {
    function updateTabWidth() {
      const root = rootRef.current;
      if (!root || tabs.length === 0) return;
      const newTabWidth = newTabButtonRef.current?.offsetWidth ?? 32;
      const previousChatsWidth = dropdownButtonRef.current?.offsetWidth ?? 0;
      const reservedWidth = newTabWidth + previousChatsWidth;
      const availableWidth = Math.max(0, root.clientWidth - reservedWidth);
      const nextWidth = Math.min(300, Math.max(88, Math.floor(availableWidth / tabs.length)));
      const nextRailWidth = Math.min(nextWidth * tabs.length, availableWidth);
      setTabMetrics(current => (
        current.tabWidth === nextWidth && current.railWidth === nextRailWidth
          ? current
          : { tabWidth: nextWidth, railWidth: nextRailWidth }
      ));
    }

    updateTabWidth();
    const observer = new ResizeObserver(updateTabWidth);
    if (rootRef.current) observer.observe(rootRef.current);
    if (newTabButtonRef.current) observer.observe(newTabButtonRef.current);
    if (dropdownButtonRef.current) observer.observe(dropdownButtonRef.current);
    return () => observer.disconnect();
  }, [tabs.length, sortedPrev.length]);

  function handleClose(e: React.MouseEvent, key: string, tab: WorkspaceChatTab) {
    e.stopPropagation();
    if (tab.streaming) {
      const confirmed = window.confirm('This chat is still streaming. Close anyway? (It will keep running in the background.)');
      if (!confirmed) return;
    }
    onClose(key);
  }

  function dragPosition(event: React.DragEvent<HTMLElement>): 'before' | 'after' {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
  }

  return (
    <div ref={rootRef} className="workspace-chat-tabs flex items-center gap-0 border-b border-app bg-app shrink-0 overflow-hidden">
      <div
        className="flex min-w-0 shrink items-stretch overflow-hidden"
        style={{ width: tabMetrics.railWidth }}
      >
        {tabs.map((tab) => {
          const key = getTabKey(tab);
          const isActive = key === activeTabKey;
          const isTerminal = tab.id.kind === 'terminal';
          const isServers = tab.id.kind === 'servers';
          const isChat = !isTerminal && !isServers;
          const label = tab.title || (isTerminal ? 'Terminal' : isServers ? 'Servers' : tab.isTemp ? (tab.tempIndex != null && tab.tempIndex > 0 ? `New chat ${tab.tempIndex}` : 'New chat') : 'chat');
          const isDragging = draggingKey === key;
          const dropBefore = dragOver?.key === key && dragOver.position === 'before' && draggingKey !== key;
          const dropAfter = dragOver?.key === key && dragOver.position === 'after' && draggingKey !== key;
          return (
            <div
              key={key}
              role="tab"
              aria-selected={isActive}
              draggable
              className={`group relative flex items-center gap-1.5 border-r border-t border-app px-3 py-2 transition-colors cursor-pointer select-none ${
                isActive
                  ? 'border-t-accent bg-accent-soft text-accent font-semibold'
                  : 'border-t-transparent bg-app text-theme-muted hover:bg-app-muted hover:text-theme-secondary'
              } ${isDragging ? 'opacity-55' : ''} ${dropBefore ? 'before:absolute before:left-0 before:top-1 before:bottom-1 before:w-0.5 before:bg-accent' : ''} ${dropAfter ? 'after:absolute after:right-0 after:top-1 after:bottom-1 after:w-0.5 after:bg-accent' : ''}`}
              style={{ width: tabMetrics.tabWidth, minWidth: tabMetrics.tabWidth, maxWidth: 300 }}
              onClick={() => onSelect(key)}
              onDragStart={(event) => {
                setDraggingKey(key);
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', key);
              }}
              onDragOver={(event) => {
                if (!draggingKey || draggingKey === key) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setDragOver({ key, position: dragPosition(event) });
              }}
              onDragLeave={() => {
                setDragOver(current => current?.key === key ? null : current);
              }}
              onDrop={(event) => {
                event.preventDefault();
                const dragKey = event.dataTransfer.getData('text/plain') || draggingKey;
                const position = dragPosition(event);
                setDraggingKey(null);
                setDragOver(null);
                if (!dragKey || dragKey === key) return;
                onReorder(dragKey, key, position);
              }}
              onDragEnd={() => {
                setDraggingKey(null);
                setDragOver(null);
              }}
            >
              {isChat && (
                <MessageSquare className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              )}
              {isTerminal && (
                <Terminal className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              )}
              {isServers && (
                <Server className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
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
        ref={newTabButtonRef}
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
