/**
 * CommentPanel — slide-out panel listing threaded document comments.
 *
 * Compact, metadata-first layout: actor, line anchor, and time live in one row.
 * Reply and resolve actions expand inline so the thread stays in context.
 */
import { useEffect, useState, useCallback } from 'react';
import {
  MessageSquare, MessageSquareOff, CheckCircle2, RotateCcw,
  AlertTriangle, User, Bot, X as XIcon, RefreshCw, Send,
} from 'lucide-react';
import { documents as documentsApi } from '../../services/api';
import type { DocumentCommentDoc } from '../../services/documents';

export interface CommentPanelProps {
  documentId: string;
  currentVersion: number;
  onClose: () => void;
  onJumpToAnchor: (anchor: DocumentCommentDoc['anchor']) => void;
  onCommentsChanged?: () => void;
}

export default function CommentPanel({
  documentId, currentVersion, onClose, onJumpToAnchor, onCommentsChanged,
}: CommentPanelProps) {
  const [comments, setComments] = useState<DocumentCommentDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'open' | 'resolved' | 'stale' | 'all'>('open');
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [replyingId, setReplyingId] = useState<string | null>(null);
  const [resolvingCommentId, setResolvingCommentId] = useState<string | null>(null);
  const [resolutionNote, setResolutionNote] = useState('');
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await documentsApi.listComments(documentId, 'all');
      setComments(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [documentId]);

  useEffect(() => { load(); }, [load]);

  const threads = comments
    .filter(c => !c.parentCommentId)
    .map(top => ({
      top,
      replies: comments
        .filter(r => r.threadId === top.threadId && r.parentCommentId)
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    }))
    .filter(({ top }) => filter === 'all' || top.status === filter);

  async function handleResolve(commentId: string) {
    setResolvingId(commentId);
    setActionError(null);
    try {
      await documentsApi.resolveComment(documentId, commentId, {
        resolutionNote: resolutionNote.trim() || 'Resolved',
      });
      setResolutionNote('');
      setResolvingCommentId(null);
      load();
      onCommentsChanged?.();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setResolvingId(null);
    }
  }

  async function handleReopen(commentId: string) {
    setActionError(null);
    try {
      await documentsApi.reopenComment(documentId, commentId);
      load();
      onCommentsChanged?.();
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
      onCommentsChanged?.();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setReplyingId(null);
    }
  }

  return (
    <div className="flex h-full w-[400px] shrink-0 flex-col border-l border-app bg-app-card">
      <div className="shrink-0 border-b border-app px-3 py-2.5">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4 shrink-0 text-theme-muted" />
          <h3 className="flex-1 truncate text-[13px] font-semibold text-theme-primary">Comments</h3>
          <button
            onClick={load}
            disabled={loading}
            className="rounded p-1 text-theme-muted transition-colors hover:bg-app-muted hover:text-theme-primary disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={onClose}
            className="rounded p-1 text-theme-muted transition-colors hover:bg-app-muted hover:text-theme-primary"
            title="Close"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="mt-1.5 flex items-center gap-1.5">
          {(['open', 'resolved', 'stale', 'all'] as const).map(f => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`rounded px-2 py-0.5 font-mono text-[10px] transition-colors ${
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

      {actionError && (
        <div className="shrink-0 border-b border-app bg-accent-red/5 px-3 py-1.5 font-mono text-[10px] text-accent-red">
          {actionError}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && comments.length === 0 && (
          <div className="space-y-2 p-4">
            {[0, 1, 2].map(i => <div key={i} className="h-20 animate-pulse rounded-md bg-app-muted/50" />)}
          </div>
        )}
        {error && <div className="p-4 font-mono text-[11px] text-accent-red">{error}</div>}
        {!loading && !error && threads.length === 0 && (
          <div className="p-6 text-center">
            <MessageSquareOff className="mx-auto mb-2 h-8 w-8 text-theme-subtle" />
            <div className="font-body text-xs text-theme-muted">
              {filter === 'all' ? 'No comments yet' : `No ${filter} comments`}
            </div>
            <div className="mt-1 text-[11px] text-theme-subtle">Select text in the document to add a comment.</div>
          </div>
        )}
        {threads.map(({ top, replies }) => (
          <div key={top.commentId} className="border-b border-app last:border-b-0">
            <CommentThreadCard
              comment={top}
              currentVersion={currentVersion}
              resolving={resolvingCommentId === top.commentId}
              resolutionNote={resolutionNote}
              resolvingId={resolvingId}
              onResolutionNoteChange={setResolutionNote}
              onResolve={() => handleResolve(top.commentId)}
              onStartResolve={() => {
                setReplyingTo(null);
                setReplyText('');
                setResolutionNote('');
                setResolvingCommentId(top.commentId);
              }}
              onCancelResolve={() => {
                setResolvingCommentId(null);
                setResolutionNote('');
              }}
              onReopen={handleReopen}
              onJumpToAnchor={onJumpToAnchor}
              replying={replyingTo === top.commentId}
              onReplyToggle={() => {
                setResolvingCommentId(null);
                setResolutionNote('');
                setReplyingTo(replyingTo === top.commentId ? null : top.commentId);
              }}
            />
            {replies.map(r => <CommentReplyCard key={r.commentId} comment={r} />)}
            {replyingTo === top.commentId && (
              <div className="px-3 pb-3 pl-9">
                <div className="rounded-md border border-app bg-app-muted/25 p-2">
                  <div className="mb-1 text-[10px] text-theme-muted">Reply to {actorLabel(top)}</div>
                  <textarea
                    value={replyText}
                    onChange={e => setReplyText(e.target.value)}
                    placeholder="Write a reply…"
                    rows={3}
                    className="w-full resize-none rounded border border-app bg-app-card px-2 py-1.5 text-[12px] text-theme-primary placeholder:text-theme-subtle focus:border-accent-blue/60 focus:outline-none focus:ring-1 focus:ring-accent-blue/30"
                    disabled={replyingId === top.commentId}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        handleReply(top.commentId);
                      }
                      if (e.key === 'Escape') {
                        setReplyingTo(null);
                        setReplyText('');
                      }
                    }}
                  />
                  <div className="mt-2 flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => { setReplyingTo(null); setReplyText(''); }}
                      className="rounded px-2 py-1 text-[11px] text-theme-muted hover:bg-app-muted hover:text-theme-primary"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => handleReply(top.commentId)}
                      disabled={!replyText.trim() || replyingId === top.commentId}
                      className="inline-flex items-center gap-1 rounded bg-accent-blue px-2.5 py-1 text-[11px] text-white disabled:opacity-40"
                    >
                      <Send className="h-3 w-3" /> {replyingId === top.commentId ? 'Replying…' : 'Reply'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="shrink-0 border-t border-app px-3 py-2 text-center text-[11px] text-theme-subtle">
        Select text in the document to add a line comment.
      </div>
    </div>
  );
}

function CommentThreadCard({
  comment, currentVersion, resolving, resolutionNote, resolvingId,
  onResolutionNoteChange, onResolve, onStartResolve, onCancelResolve,
  onReopen, onJumpToAnchor, replying, onReplyToggle,
}: {
  comment: DocumentCommentDoc;
  currentVersion: number;
  resolving: boolean;
  resolutionNote: string;
  resolvingId: string | null;
  onResolutionNoteChange: (note: string) => void;
  onResolve: () => void;
  onStartResolve: () => void;
  onCancelResolve: () => void;
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
      <div className="mb-1 flex items-center gap-1.5 text-[10px] text-theme-subtle">
        {comment.authorType === 'agent' ? (
          <Bot className="h-3.5 w-3.5 shrink-0 text-accent-purple" />
        ) : (
          <User className="h-3.5 w-3.5 shrink-0 text-accent-blue" />
        )}
        <span className="truncate font-mono text-[11px] font-medium text-theme-primary">{actorLabel(comment)}</span>
        <button
          type="button"
          onClick={() => onJumpToAnchor(comment.anchor)}
          className="shrink-0 rounded px-1 py-0.5 font-mono text-[10px] text-theme-muted hover:bg-app-muted hover:text-accent-blue"
          title="Jump to anchor location"
        >
          {anchorLabel(comment)}
        </button>
        <span className="shrink-0">· {formatTime(comment.createdAt)}</span>
        {isStale && <span className="ml-auto inline-flex items-center gap-0.5 font-mono text-[9px] uppercase text-accent-orange"><AlertTriangle className="h-3 w-3" /> Stale</span>}
        {isResolved && <span className="ml-auto font-mono text-[9px] uppercase text-accent-green">Resolved</span>}
      </div>

      <div className="mb-1.5 whitespace-pre-wrap break-words font-body text-[11px] leading-relaxed text-theme-secondary">
        {comment.body}
      </div>

      {comment.anchor.staleReason && (
        <div className="mb-1.5 font-mono text-[10px] text-accent-orange">{comment.anchor.staleReason}</div>
      )}

      {comment.resolution && (
        <div className="mb-1.5 rounded-md border border-accent-green/20 bg-accent-green/5 px-2 py-1.5 text-[10px] text-theme-secondary">
          <div className="mb-0.5 flex items-center gap-1 font-mono text-accent-green">
            <CheckCircle2 className="h-3 w-3" />
            Resolved by {resolutionActorLabel(comment)} · v{comment.resolution.resolvedAtVersion || currentVersion} · {formatTime(comment.resolution.resolvedAt)}
          </div>
          <div className="whitespace-pre-wrap font-body text-theme-muted">{comment.resolution.resolutionNote}</div>
        </div>
      )}

      {resolving && (
        <div className="mb-2 rounded-md border border-app bg-app-muted/25 p-2">
          <div className="mb-1 text-[10px] text-theme-muted">Resolve thread</div>
          <textarea
            value={resolutionNote}
            onChange={e => onResolutionNoteChange(e.target.value)}
            placeholder="Optional resolution note…"
            rows={2}
            className="w-full resize-none rounded border border-app bg-app-card px-2 py-1.5 text-[12px] text-theme-primary placeholder:text-theme-subtle focus:border-accent-green/60 focus:outline-none focus:ring-1 focus:ring-accent-green/30"
          />
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" onClick={onCancelResolve} className="rounded px-2 py-1 text-[11px] text-theme-muted hover:bg-app-muted hover:text-theme-primary">Cancel</button>
            <button
              type="button"
              onClick={onResolve}
              disabled={resolvingId === comment.commentId}
              className="inline-flex items-center gap-1 rounded bg-accent-green px-2.5 py-1 text-[11px] text-white disabled:opacity-40"
            >
              <CheckCircle2 className="h-3 w-3" /> {resolvingId === comment.commentId ? 'Resolving…' : 'Resolve'}
            </button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 font-mono text-[9px] text-theme-subtle">
        {comment.reopenCount > 0 && <span>Reopened {comment.reopenCount}x</span>}
        <div className="ml-auto flex items-center gap-1">
          {canResolve && !resolving && (
            <button type="button" onClick={onStartResolve} className="rounded px-1.5 py-0.5 text-accent-green/70 transition-colors hover:bg-accent-green/10 hover:text-accent-green">Resolve</button>
          )}
          {canReopen && (
            <button type="button" onClick={() => onReopen(comment.commentId)} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-accent-orange/70 transition-colors hover:bg-accent-orange/10 hover:text-accent-orange">
              <RotateCcw className="h-3 w-3" /> Reopen
            </button>
          )}
          {!isStale && (
            <button type="button" onClick={onReplyToggle} className="rounded px-1.5 py-0.5 text-theme-muted transition-colors hover:bg-app-muted hover:text-theme-primary">
              {replying ? 'Cancel reply' : 'Reply'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function CommentReplyCard({ comment }: { comment: DocumentCommentDoc }) {
  return (
    <div className="border-t border-app/50 py-2 pl-9 pr-3">
      <div className="mb-1 flex items-center gap-1.5">
        {comment.authorType === 'agent' ? (
          <Bot className="h-3 w-3 shrink-0 text-accent-purple" />
        ) : (
          <User className="h-3 w-3 shrink-0 text-accent-blue" />
        )}
        <span className="flex-1 truncate font-mono text-[10px] text-theme-primary">{actorLabel(comment)}</span>
        <span className="font-mono text-[9px] text-theme-subtle">{formatTime(comment.createdAt)}</span>
      </div>
      <div className="whitespace-pre-wrap break-words font-body text-[11px] leading-relaxed text-theme-secondary">{comment.body}</div>
    </div>
  );
}

function actorLabel(comment: DocumentCommentDoc): string {
  if (comment.authorType === 'agent') return comment.authorAgentName || 'Assistant';
  return comment.authorDisplayName || comment.authorEmail || comment.authorUserId || 'Unknown user';
}

function resolutionActorLabel(comment: DocumentCommentDoc): string {
  const resolution = comment.resolution;
  if (!resolution) return 'Unknown';
  return resolution.resolvedByAgentName
    || resolution.resolvedByDisplayName
    || resolution.resolvedByEmail
    || resolution.resolvedByUserId
    || 'Assistant';
}

function anchorLabel(comment: DocumentCommentDoc): string {
  const anchor = comment.anchor;
  if (anchor.type === 'line' && anchor.lineStart) return `Line ${anchor.lineStart}`;
  if (anchor.type === 'range' && anchor.lineStart) return `Lines ${anchor.lineStart}–${anchor.lineEnd ?? anchor.lineStart}`;
  if (anchor.type === 'text_snippet') return 'Selected text';
  return `v${anchor.anchoredAtVersion}`;
}

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
