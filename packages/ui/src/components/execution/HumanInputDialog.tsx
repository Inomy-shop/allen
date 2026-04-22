import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X as XIcon } from 'lucide-react';
import ClarificationPanel, { type ClarificationField } from '../clarification/ClarificationPanel';

interface Props {
  node: string;
  prompt: string;
  fields: ClarificationField[];
  reviewContent?: string;
  reviewContentType?: 'markdown' | 'json' | 'code' | 'text';
  reviewLanguage?: string;
  onSubmit: (data: Record<string, unknown>) => void;
  onCancel: () => void;
}

/**
 * Modal wrapper around ClarificationPanel. Keeps the same API the execution
 * page calls — the actual rendering lives in the shared component so the
 * inline intervention page looks identical.
 */
export default function HumanInputDialog({
  node, prompt, fields,
  reviewContent, reviewContentType, reviewLanguage,
  onSubmit, onCancel,
}: Props) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [onCancel]);

  const hasReview = !!reviewContent && reviewContent.trim().length > 0;

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-start justify-center bg-black/70 backdrop-blur-sm p-4 overflow-y-auto"
      onClick={onCancel}
    >
      <div
        className={`bg-surface-50 border border-border/30 rounded-xl shadow-2xl w-full mt-[4vh] max-h-[92vh] flex flex-col overflow-hidden ${
          hasReview ? 'max-w-6xl' : 'max-w-2xl'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Tight top bar with node name and close */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-surface-100/50 border-b border-border/20 shrink-0">
          <div className="text-[11px] font-mono text-theme-muted flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-accent-yellow animate-pulse" />
            <span>Waiting at node</span>
            <span className="text-theme-primary">{node}</span>
          </div>
          <button
            onClick={onCancel}
            className="p-1 rounded-md hover:bg-surface-200/60 text-theme-muted hover:text-theme-secondary transition-colors"
            title="Close — does not discard the pending request"
          >
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        <ClarificationPanel
          layout="modal"
          title="Input required"
          subtitle={`node · ${node}`}
          prompt={prompt}
          severity="question"
          fields={fields}
          reviewContent={reviewContent}
          reviewContentType={reviewContentType}
          reviewLanguage={reviewLanguage}
          mode="simple"
          onSubmit={async (payload) => {
            onSubmit(payload.fieldValues);
          }}
          onCancel={onCancel}
        />
      </div>
    </div>,
    document.body,
  );
}
