/**
 * CommentInput — textarea + anchor preview + submit/cancel.
 *
 * Props include selected anchor (`{ type, lineStart?, lineEnd?, snippet?, context }`).
 * Calls `documents.createComment` on submit.
 */
import { useState, useRef, useEffect } from 'react';
import { MessageSquarePlus, X as XIcon, Send } from 'lucide-react';
import { documents as documentsApi } from '../../services/api';
import type { DocumentCommentDoc, WriteAnchor } from '../../services/documents';

export interface CommentInputProps {
  documentId: string;
  /** The text anchor selected by the user. Undefined when no selection. */
  anchor?: WriteAnchor;
  onSubmitted: (comment: DocumentCommentDoc) => void;
  onCancel: () => void;
  variant?: 'default' | 'rail';
}

export default function CommentInput({ documentId, anchor, onSubmitted, onCancel, variant = 'default' }: CommentInputProps) {
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textRef.current?.focus();
  }, []);

  const canSubmit = body.trim().length > 0 && !!anchor;

  async function handleSubmit() {
    if (!canSubmit || !anchor) return;
    setSubmitting(true);
    setError(null);
    try {
      const comment = await documentsApi.createComment(documentId, { body: body.trim(), anchor });
      setBody('');
      onSubmitted(comment);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to create comment');
    } finally {
      setSubmitting(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape' && !submitting) {
      onCancel();
      return;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }

  if (variant === 'rail') {
    const anchorText = anchor?.type === 'text_snippet'
      ? 'Entire document'
      : anchor?.snippet?.trim() || (
        anchor?.type === 'range'
          ? `Lines ${anchor.lineStart ?? 1}–${anchor.lineEnd ?? anchor.lineStart ?? 1}`
          : `Line ${anchor?.lineStart ?? 1}`
      );

    return (
      <div className="document-review-composer" onMouseUp={event => event.stopPropagation()}>
        <span className="document-review-composer__anchor" title={anchor?.snippet || anchorText}>{anchorText}</span>
        {error && <div className="document-review-composer__error">{error}</div>}
        <textarea
          ref={textRef}
          value={body}
          onChange={event => setBody(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Comment…"
          rows={3}
          disabled={submitting}
        />
        <div className="document-review-composer__actions">
          <button type="button" onClick={onCancel} disabled={submitting}>Cancel</button>
          <button type="button" className="primary" onClick={handleSubmit} disabled={!canSubmit || submitting}>
            {submitting ? 'Posting…' : 'Post'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="border-t border-app bg-app-card px-3 py-2.5"
      onMouseUp={event => event.stopPropagation()}
    >
      <div className="flex items-start gap-2 mb-2">
        <MessageSquarePlus className="w-3.5 h-3.5 text-accent-blue shrink-0 mt-1" />
        <div className="text-[11px] font-mono text-theme-secondary leading-relaxed">
          Add a comment{anchor ? ' at the selected location' : ''}
        </div>
      </div>

      {anchor && (
        <div className="mb-2 flex min-w-0 items-center gap-2 text-[10px] text-theme-muted">
          <span className="shrink-0 rounded bg-yellow-400/15 px-1.5 py-0.5 font-mono text-yellow-700 dark:text-yellow-300">
            {anchor.type === 'line' && anchor.lineStart && <>Line {anchor.lineStart}</>}
            {anchor.type === 'range' && anchor.lineStart && anchor.lineEnd && <>Lines {anchor.lineStart}–{anchor.lineEnd}</>}
            {anchor.type === 'text_snippet' && <>Selected text</>}
          </span>
          {anchor.snippet && (
            <span className="truncate font-body italic text-theme-subtle">"{anchor.snippet}"</span>
          )}
        </div>
      )}

      {error && (
        <div className="mb-2 text-[10px] text-accent-red font-mono">{error}</div>
      )}

      <textarea
        ref={textRef}
        value={body}
        onChange={e => setBody(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Write a comment… (⌘Enter to submit)"
        rows={3}
        className="w-full resize-none rounded border border-app bg-app-card px-2.5 py-1.5 text-[12px] font-body text-theme-primary placeholder:text-theme-subtle focus:border-accent-blue/60 focus:outline-none focus:ring-1 focus:ring-accent-blue/30"
        disabled={submitting}
      />

      <div className="flex items-center justify-end gap-2 mt-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="rounded-md px-2.5 py-1.5 text-[11px] font-body text-theme-muted transition-colors hover:bg-app-muted hover:text-theme-primary disabled:opacity-50 flex items-center gap-1"
        >
          <XIcon className="w-3 h-3" /> Cancel
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit || submitting}
          className="rounded-md px-3 py-1.5 text-[11px] font-body bg-accent-blue text-white transition-colors hover:opacity-90 disabled:opacity-40 flex items-center gap-1"
        >
          <Send className="w-3 h-3" />
          {submitting ? 'Sending…' : 'Comment'}
        </button>
      </div>
    </div>
  );
}
