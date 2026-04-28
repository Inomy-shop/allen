import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X as XIcon } from 'lucide-react';
import CheckpointsPanel from './CheckpointsPanel';
import { useResizable } from '../../hooks/useResizable';

interface Props {
  executionId: string;
  executionStatus: string;
  open: boolean;
  onClose: () => void;
}

/**
 * Right-side slide-out drawer that hosts the CheckpointsPanel. Triggered by
 * the "Checkpoints" button in the execution detail page header. Full-height,
 * fixed width, Portal-rendered so ancestor `backdrop-filter` contexts don't
 * clip the `position: fixed` overlay.
 */
export default function CheckpointsDrawer({ executionId, executionStatus, open, onClose }: Props) {
  // Drawer width — resizable via the left-edge drag handle. Matches the
  // same pattern used on the main execution page (right node-detail
  // pane) so users get one consistent resize UX.
  const { size: drawerWidth, handleMouseDown: drawerResizeStart } = useResizable({
    direction: 'horizontal',
    initialSize: 560,
    minSize: 360,
    maxSize: 1200,
    side: 'end',
  });

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[9999]">
      {/* Backdrop — dimmer but transparent enough to see the underlying page.
          Click to close. */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-in fade-in duration-150"
        onClick={onClose}
      />
      {/* Slide-out panel from the right. Width is now user-resizable via
          the left-edge drag handle (default 560px, min 360, max 1200).
          The `calc(100vw - 40px)` cap guarantees the user can't drag it
          off-screen on narrow viewports. */}
      <aside
        className="absolute top-0 right-0 h-full bg-surface-50 border-l border-app shadow-2xl flex flex-col animate-in slide-in-from-right duration-200"
        style={{ width: `min(${drawerWidth}px, calc(100vw - 40px))` }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left-edge drag handle. Wide (8px) invisible hit zone for easy
            grabbing; on hover only a thin 1px line appears in the centre
            so the indicator stays unobtrusive. */}
        <div
          className="absolute top-0 left-0 bottom-0 w-2 cursor-col-resize z-10 group"
          onMouseDown={drawerResizeStart}
          title="Drag to resize"
        >
          <div className="absolute left-1/2 -translate-x-1/2 top-0 bottom-0 w-px bg-transparent group-hover:bg-accent-blue/60 transition-colors" />
        </div>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-app shrink-0">
          <h3 className="text-[14px] font-medium text-theme-primary tracking-tight">
            Checkpoints
          </h3>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-app-muted text-theme-muted hover:text-theme-secondary transition-colors"
            title="Close"
          >
            <XIcon className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-4">
          <CheckpointsPanel executionId={executionId} executionStatus={executionStatus} />
        </div>
      </aside>
    </div>,
    document.body,
  );
}
