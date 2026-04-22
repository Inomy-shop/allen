import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X as XIcon } from 'lucide-react';
import CheckpointsPanel from './CheckpointsPanel';

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
      {/* Slide-out panel from the right. `max-w-xl` keeps it readable on
          wide monitors while still leaving the underlying page visible. */}
      <aside
        className="absolute top-0 right-0 h-full w-full sm:w-[560px] max-w-full bg-surface-50 border-l border-border/40 shadow-2xl flex flex-col animate-in slide-in-from-right duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border/20 shrink-0">
          <h3 className="font-heading text-sm text-theme-primary tracking-wider uppercase">
            Checkpoints
          </h3>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-surface-200/60 text-theme-muted hover:text-theme-secondary transition-colors"
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
