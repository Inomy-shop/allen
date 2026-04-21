import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X as XIcon } from 'lucide-react';
import StateTimeline from './StateTimeline';

interface Props {
  executionId: string;
  open: boolean;
  onClose: () => void;
}

/**
 * Right-side drawer hosting the chronological state-change log. Same
 * pattern as CheckpointsDrawer / TimelineDrawer.
 */
export default function StateChangesDrawer({ executionId, open, onClose }: Props) {
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
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-in fade-in duration-150"
        onClick={onClose}
      />
      <aside
        className="absolute top-0 right-0 h-full w-full sm:w-[560px] max-w-full bg-surface-50 border-l border-border/40 shadow-2xl flex flex-col animate-in slide-in-from-right duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border/20 shrink-0">
          <h3 className="font-heading text-sm text-theme-primary tracking-wider uppercase">State Changes</h3>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-surface-200/60 text-theme-muted hover:text-theme-secondary transition-colors"
            title="Close"
          >
            <XIcon className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-4">
          <StateTimeline executionId={executionId} />
        </div>
      </aside>
    </div>,
    document.body,
  );
}
