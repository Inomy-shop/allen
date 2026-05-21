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
 * Right-side overlay hosting the chronological state-change log. Matches
 * the execution logs panel shell so auxiliary run views feel consistent.
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
    <div className="fixed inset-0 z-50 bg-black/30 p-6" role="dialog" aria-modal="true" aria-label="State changes">
      <button className="absolute inset-0" type="button" onClick={onClose} aria-label="Close state changes" />
      <aside
        className="relative ml-auto flex h-full w-[min(860px,calc(100vw-48px))] flex-col overflow-hidden rounded-lg border border-app-strong bg-app-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-app px-4 py-3">
          <div>
            <h3 className="text-[13px] font-semibold text-theme-primary">State Changes</h3>
            <p className="text-[10px] text-theme-muted font-mono">Checkpoint diffs by completed node</p>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1.5 text-theme-muted hover:bg-app-muted hover:text-theme-primary"
            title="Close"
            aria-label="Close state changes"
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
