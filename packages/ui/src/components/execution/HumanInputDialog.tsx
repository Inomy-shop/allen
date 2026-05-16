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
      className="fixed inset-0 z-[9999] flex items-start justify-center bg-black/35 p-6 overflow-y-auto"
      onClick={onCancel}
    >
      {/* Card grows with content; the OUTER overlay scrolls when the card
          exceeds the viewport. Previously the card was capped at 92vh +
          overflow-hidden, which clipped tall prompts/forms and hid the
          submit button below the fold with no scroll path. */}
      <div
        className={`bg-app-card border border-app rounded-lg shadow-xl w-full my-[3vh] flex flex-col overflow-hidden ${
          hasReview ? 'max-w-6xl' : 'max-w-2xl'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Tight top bar with node name and close */}
        <div className="flex items-center justify-between px-4 py-3 bg-app-card border-b border-app shrink-0">
          <div className="text-[11px] font-mono text-theme-muted flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-accent-yellow animate-pulse" />
            <span>Waiting at node</span>
            <span className="text-theme-primary">{node}</span>
          </div>
          <button
            onClick={onCancel}
            className="p-1 rounded-md hover:bg-app-muted text-theme-muted hover:text-theme-secondary transition-colors"
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
