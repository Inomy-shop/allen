import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X as XIcon } from 'lucide-react';
import CheckpointsPanel from './CheckpointsPanel';
import type { WorkflowFeedbackEntry } from './WorkflowFeedbackDrawer';

interface Props {
  open: boolean;
  onClose: () => void;
  executionId: string;
  executionStatus: string;
  checkpointCount: number | null;
  feedbackEntries: WorkflowFeedbackEntry[];
  canAppendFeedback: boolean;
  agentNodeNames: string[];
  onFeedbackCreated: (entries: WorkflowFeedbackEntry[]) => void;
  onRefreshExecution: () => void;
}

export default function RunControlsDrawer({
  open,
  onClose,
  executionId,
  executionStatus,
  checkpointCount,
  feedbackEntries,
  canAppendFeedback,
  agentNodeNames,
  onFeedbackCreated,
  onRefreshExecution,
}: Props) {
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
    <div className="fixed inset-0 z-50 bg-black/30 p-6" role="dialog" aria-modal="true" aria-label="Run controls">
      <button className="absolute inset-0" type="button" onClick={onClose} aria-label="Close run controls" />
      <div
        className="relative ml-auto flex h-full w-[min(1120px,calc(100vw-48px))] flex-col overflow-hidden rounded-lg border border-app-strong bg-app-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-app px-4 py-3">
          <div>
            <div className="text-[13px] font-semibold text-theme-primary">Rerun from Saved State</div>
            <div className="font-mono text-[10px] text-theme-muted">
              choose a saved state, edit it, then resume or fork the execution
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1.5 text-theme-muted hover:bg-app-muted hover:text-theme-primary" aria-label="Close run controls">
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <CheckpointsPanel
            executionId={executionId}
            executionStatus={executionStatus}
            feedbackEntries={feedbackEntries}
            canAppendFeedback={canAppendFeedback}
            agentNodeNames={agentNodeNames}
            onFeedbackCreated={onFeedbackCreated}
            onRefreshExecution={onRefreshExecution}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
