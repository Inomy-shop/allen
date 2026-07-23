import { forwardRef, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Code2, FolderTree, MessageSquare, Plus, Server, Terminal } from 'lucide-react';

type Props = {
  onNewChat: () => void;
  onNewTerminal?: () => void;
  onOpenCodeDiff?: () => void;
  onOpenFileExplorer?: () => void;
  onOpenServers?: () => void;
};

const MENU_WIDTH = 188;

const ChatTabCreateMenu = forwardRef<HTMLButtonElement, Props>(function ChatTabCreateMenu({
  onNewChat,
  onNewTerminal,
  onOpenCodeDiff,
  onOpenFileExplorer,
  onOpenServers,
}, forwardedRef) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;

    function updatePosition() {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPosition({
        top: rect.bottom + 5,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8)),
      });
    }

    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }

    updatePosition();
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  function setTrigger(node: HTMLButtonElement | null) {
    triggerRef.current = node;
    if (typeof forwardedRef === 'function') forwardedRef(node);
    else if (forwardedRef) forwardedRef.current = node;
  }

  function run(action: () => void) {
    setOpen(false);
    action();
  }

  return (
    <>
      <button
        ref={setTrigger}
        type="button"
        className="chat-tab-create-trigger"
        onClick={() => setOpen(value => !value)}
        aria-label="Add tab"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Add tab"
      >
        <Plus aria-hidden="true" />
      </button>
      {open && position && createPortal(
        <div
          ref={menuRef}
          className="chat-tab-create-menu"
          role="menu"
          aria-label="Add tab"
          style={{ top: position.top, left: position.left, width: MENU_WIDTH }}
        >
          <button type="button" role="menuitem" onClick={() => run(onNewChat)}>
            <MessageSquare aria-hidden="true" />
            <span>New chat</span>
          </button>
          {onNewTerminal && (
            <button type="button" role="menuitem" onClick={() => run(onNewTerminal)}>
              <Terminal aria-hidden="true" />
              <span>Terminal</span>
            </button>
          )}
          {onOpenCodeDiff && (
            <button type="button" role="menuitem" onClick={() => run(onOpenCodeDiff)}>
              <Code2 aria-hidden="true" />
              <span>Code diff</span>
            </button>
          )}
          {onOpenFileExplorer && (
            <button type="button" role="menuitem" onClick={() => run(onOpenFileExplorer)}>
              <FolderTree aria-hidden="true" />
              <span>File explorer</span>
            </button>
          )}
          {onOpenServers && (
            <button type="button" role="menuitem" onClick={() => run(onOpenServers)}>
              <Server aria-hidden="true" />
              <span>Servers</span>
            </button>
          )}
        </div>,
        document.body,
      )}
    </>
  );
});

export default ChatTabCreateMenu;
