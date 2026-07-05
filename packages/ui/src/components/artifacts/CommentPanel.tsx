/**
 * CommentPanel — slide-out panel listing threaded comments.
 *
 * Shows author (human/agent), anchor preview, resolved/open/stale status,
 * reopen/resolve controls. Groups comments by thread.
 */
import { useEffect, useState, useCallback } from 'react';
import {
  MessageSquare, MessageSquareOff, CheckCircle2, RotateCcw,
  AlertTriangle, User, Bot, X as XIcon, RefreshCw,
} from 'lucide-react';
import { documents as documentsApi } from '../../services/api';
import type { DocumentCommentDoc } from '../../services/documents';
import CommentInput from './CommentInput';

export interface CommentPanelProps {
  documentId: string;
  currentVersion: number;
  onClose: () => void;
  onJumpToAnchor: (anchor: DocumentCommentDoc['anchor']) => void;
}

export default function CommentPanel({
  documentId, currentVersion, onClose, onJumpToAnchor,
}: CommentPanelProps) {
  const [comments, setComments] = useState<DocumentCommentDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'open' | 'resolved' | 'stale' | 'all'>('open');
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [replyingId, setReplyingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showInput, setShowInput] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Tabs filter whole threads, not individual comment rows. Fetch all rows so a
      // resolved/open/stale thread can still render every reply in chronological order.
      const data = await documentsApi.listComments(documentId, 'all');
      setComments(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [documentId]);

  useEffect(() => { load(); }, [load]);

  // Group top-level comments (no parentCommentId) with their replies.
  // The active tab filters threads by the top-level comment status. Once a thread
  // is included, render all of its replies so Resolved/Open/Stale views stay as
  // complete as the All view.
  const threads = comments
    .filter(c => !c.parentCommentId)
    .map(top => ({
      top,
      replies: comments
        .filter(r => r.threadId === top.threadId && r.parentCommentId)
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    }))
    .filter(({ top }) => filter === 'all' || top.status === filter);

  // ── Actions ─────────────────────────────────────────────────────────

  async function handleResolve(commentId: string) {
    setActionError(null);
    try {
      await documentsApi.resolveComment(documentId, commentId, { resolutionNote: 'Resolved' });
      load();
    } catch (err) {
      setActionError((err as Error).message);
    }
  }

  async function handleReopen(commentId: string) {
    setActionError(null);
    try {
      await documentsApi.reopenComment(documentId, commentId);
      load();
    } catch (err) {
      setActionError((err as Error).message);
    }
  }

  async function handleReply(commentId: string) {
    if (!replyText.trim()) return;
    setReplyingId(commentId);
    setActionError(null);
    try {
      await documentsApi.replyToComment(documentId, commentId, { body: replyText.trim() });
      setReplyText('');
      setReplyingTo(null);
      load();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setReplyingId(null);
    }
  }

  return (
    <div className="flex h-full flex-col bg-app-card border-l border-app w-[360px] shrink-0">
      {/* Header */}
      <div className="shrink-0 border-b border-app px-3 py-2.5">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-theme-muted shrink-0" />
          <h3 className="text-[13px] font-semibold text-theme-primary flex-1 truncate">
            Comments
          </h3>
          <button
            onClick={load}
            disabled={loading}
            className="rounded p-1 text-theme-muted transition-colors hover:bg-app-muted hover:text-theme-primary disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={onClose}
            className="rounded p-1 text-theme-muted transition-colors hover:bg-app-muted hover:text-theme-primary"
            title="Close"
          >
            <XIcon className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex items-center gap-1.5 mt-1.5">
          {(['open', 'resolved', 'stale', 'all'] as const).map(f => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`rounded px-2 py-0.5 text-[10px] font-mono transition-colors ${
                filter === f
                  ? 'bg-accent-blue/15 text-accent-blue'
                  : 'text-theme-muted hover:bg-app-muted hover:text-theme-primary'
              }`}
            >
              {f === 'open' ? 'Open' : f === 'resolved' ? 'Resolved' : f === 'stale' ? 'Stale' : 'All'}
            </button>
          ))}
        </div>
      </div>

      {/* Action error */}
      {actionError && (
        <div className="shrink-0 px-3 py-1.5 text-[10px] text-accent-red font-mono bg-accent-red/5 border-b border-app">
          {actionError}
        </div>
      )}

      {/* Comment list */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && comments.length === 0 && (
          <div className="p-4 space-y-2">
            {[0, 1, 2].map(i => (
              <div key={i} className="h-20 rounded-md bg-app-muted/50 animate-pulse" />
            ))}
          </div>
        )}
        {error && (
          <div className="p-4 text-[11px] text-accent-red font-mono">{error}</div>
        )}
        {!loading && !error && threads.length === 0 && (
          <div className="p-6 text-center">
            <MessageSquareOff className="w-8 h-8 text-theme-subtle mx-auto mb-2" />
            <div className="text-xs text-theme-muted font-body">
              {filter === 'all' ? 'No comments yet' : `No ${filter} comments`}
            </div>
          </div>
        )}
        {threads.map(({ top, replies }) => (
          <div key={top.commentId} className="border-b border-app last:border-b-0">
            <CommentThreadCard
              comment={top}
              currentVersion={currentVersion}
              onResolve={handleResolve}
              onReopen={handleReopen}
              onJumpToAnchor={onJumpToAnchor}
              replying={replyingTo === top.commentId}
              onReplyToggle={() =>
                setReplyingTo(replyingTo === top.commentId ? null : top.commentId)
              }
            />
            {replies.map(r => (
              <CommentReplyCard key={r.commentId} comment={r} />
            ))}
            {replyingTo === top.commentId && (
              <div className="px-4 pb-3 pt-1 pl-12">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={replyText}
                    onChange={e => setReplyText(e.target.value)}
                    placeholder="Write a reply…"
                    className="flex-1 rounded border border-app bg-app-card px-2 py-1 text-[11px] text-theme-primary placeholder:text-theme-subtle focus:border-accent-blue/60 focus:outline-none focus:ring-1 focus:ring-accent-blue/30"
                    disabled={replyingId === top.commentId}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleReply(top.commentId);
                      }
                      if (e.key === 'Escape') {
                        setReplyingTo(null);
                        setReplyText('');
                      }
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => handleReply(top.commentId)}
                    disabled={!replyText.trim() || replyingId === top.commentId}
                    className="rounded bg-accent-blue px-2 py-1 text-[10px] text-white disabled:opacity-40"
                  >
                    {replyingId === top.commentId ? '…' : 'Send'}
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* New comment input */}
      {showInput ? (
        <CommentInput
          documentId={documentId}
          anchor={{
            type: 'line',
            lineStart: currentVersion,
            context: `Version ${currentVersion}`,
          }}
          onSubmitted={() => { setShowInput(false); load(); }}
          onCancel={() => setShowInput(false)}
        />
      ) : (
        <div className="shrink-0 border-t border-app px-3 py-2">
          <button
            type="button"
            onClick={() => setShowInput(true)}
            className="w-full rounded-md border border-dashed border-app py-2 text-[11px] font-body text-theme-muted transition-colors hover:border-accent-blue/40 hover:text-accent-blue"
          >
            + Add comment
          </button>
        </div>
      )}
    </div>
  );
}

// ── Thread Card ────────────────────────────────────────────────────────────

function CommentThreadCard({
  comment, currentVersion, onResolve, onReopen, onJumpToAnchor,
  replying, onReplyToggle,
}: {
  comment: DocumentCommentDoc;
  currentVersion: number;
  onResolve: (id: string) => void;
  onReopen: (id: string) => void;
  onJumpToAnchor: (anchor: DocumentCommentDoc['anchor']) => void;
  replying: boolean;
  onReplyToggle: () => void;
}) {
  const isStale = comment.status === 'stale';
  const isResolved = comment.status === 'resolved';
  const canResolve = !isResolved && !isStale;
  const canReopen = isResolved && !isStale;

  return (
    <div className={`px-3 py-2.5 ${isStale ? 'opacity-70' : ''}`}>
      {/* Author + Status */}
      <div className="flex items-center gap-1.5 mb-1">
        {comment.authorType === 'agent' ? (
          <Bot className="w-3.5 h-3.5 text-accent-purple shrink-0" />
        ) : (
          <User className="w-3.5 h-3.5 text-accent-blue shrink-0" />
        )}
        <span className="text-[11px] font-mono text-theme-primary truncate flex-1">
          {comment.authorAgentName ?? comment.authorUserId ?? 'Unknown'}
        </span>
        {isStale && (
          <span className="flex items-center gap-0.5 text-[9px] font-mono text-accent-orange uppercase">
            <AlertTriangle className="w-3 h-3" /> Stale
          </span>
        )}
        {isResolved && (
          <span className="text-[9px] font-mono text-accent-green uppercase">Resolved</span>
        )}
      </div>

      {/* Anchor preview */}
      <button
        type="button"
        onClick={() => onJumpToAnchor(comment.anchor)}
        className="mb-1 block w-full text-left rounded border border-app bg-app-muted/30 px-2 py-1 text-[9px] font-mono text-theme-muted truncate hover:border-accent-blue/30 hover:bg-app-muted/60"
        title="Jump to anchor location"
      >
        {comment.anchor.type === 'line' && comment.anchor.lineStart && (
          <>Line {comment.anchor.lineStart}</>
        )}
        {comment.anchor.type === 'range' && comment.anchor.lineStart && (
          <>Lines {comment.anchor.lineStart}–{comment.anchor.lineEnd}</>
        )}
        {comment.anchor.type === 'text_snippet' && (
          <>{comment.anchor.snippet?.slice(0, 80)}{(comment.anchor.snippet?.length ?? 0) > 80 ? '…' : ''}</>
        )}
        {comment.anchor.staleReason && (
          <span className="ml-1 text-accent-orange">· {comment.anchor.staleReason}</span>
        )}
      </button>

      {/* Body */}
      <div className="text-[11px] font-body text-theme-secondary leading-relaxed mb-1.5 whitespace-pre-wrap break-words">
        {comment.body}
      </div>

      {/* Resolution note */}
      {comment.resolution && (
        <div className="mb-1.5 rounded border border-accent-green/20 bg-accent-green/5 px-2 py-1 text-[10px] text-accent-green/80 font-mono">
          Resolved: {comment.resolution.resolutionNote}
          {comment.resolution.resolvedAtVersion > 0 && (
            <> · v{comment.resolution.resolvedAtVersion}</>
          )}
        </div>
      )}

      {/* Meta + actions */}
      <div className="flex items-center gap-2 text-[9px] font-mono text-theme-subtle">
        <span>{formatTime(comment.createdAt)}</span>
        {comment.reopenCount > 0 && (
          <span>Reopened {comment.reopenCount}x</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {canResolve && (
            <button
              type="button"
              onClick={() => onResolve(comment.commentId)}
              title="Resolve"
              className="rounded p-0.5 text-accent-green/60 hover:text-accent-green hover:bg-accent-green/10 transition-colors"
            >
              <CheckCircle2 className="w-3 h-3" />
            </button>
          )}
          {canReopen && (
            <button
              type="button"
              onClick={() => onReopen(comment.commentId)}
              title="Reopen"
              className="rounded p-0.5 text-accent-orange/60 hover:text-accent-orange hover:bg-accent-orange/10 transition-colors"
            >
              <RotateCcw className="w-3 h-3" />
            </button>
          )}
          <button
            type="button"
            onClick={onReplyToggle}
            className="rounded px-1.5 py-0.5 text-theme-muted hover:bg-app-muted hover:text-theme-primary transition-colors"
          >
            {replying ? 'Cancel' : 'Reply'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Reply Card ─────────────────────────────────────────────────────────────

function CommentReplyCard({ comment }: { comment: DocumentCommentDoc }) {
  return (
    <div className="border-t border-app/50 pl-8 pr-3 py-2">
      <div className="flex items-center gap-1.5 mb-1">
        {comment.authorType === 'agent' ? (
          <Bot className="w-3 h-3 text-accent-purple shrink-0" />
        ) : (
          <User className="w-3 h-3 text-accent-blue shrink-0" />
        )}
        <span className="text-[10px] font-mono text-theme-primary truncate flex-1">
          {comment.authorAgentName ?? comment.authorUserId ?? 'Unknown'}
        </span>
        <span className="text-[9px] font-mono text-theme-subtle">{formatTime(comment.createdAt)}</span>
      </div>
      <div className="text-[11px] font-body text-theme-secondary leading-relaxed whitespace-pre-wrap break-words">
        {comment.body}
      </div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return new Date(iso).toLocaleDateString();
}
