import { useEffect, useMemo, useState } from 'react';
import { Check, MessageSquareOff, X } from 'lucide-react';
import { documents as documentsApi } from '../../services/documents';
import type { DocumentCommentDoc, VersionListEntry, WriteAnchor } from '../../services/documents';
import CommentInput from './CommentInput';

type ReviewTab = 'comments' | 'summary' | 'history';

interface DocumentReviewRailProps {
  documentId?: string;
  documentTitle: string;
  currentVersion: number;
  comments: DocumentCommentDoc[];
  loading?: boolean;
  onClose: () => void;
  onCommentDocument: () => void;
  onJumpToAnchor: (anchor: DocumentCommentDoc['anchor']) => void;
  onCommentsChanged: (updates?: DocumentCommentDoc[]) => void | Promise<void>;
  onViewVersion: (versionNumber: number) => void;
  commentAnchor?: WriteAnchor;
  onCommentSubmitted?: (comment: DocumentCommentDoc) => void;
  onCommentCancel?: () => void;
}

export default function DocumentReviewRail({
  documentId,
  documentTitle,
  currentVersion,
  comments,
  loading,
  onClose,
  onCommentDocument,
  onJumpToAnchor,
  onCommentsChanged,
  onViewVersion,
  commentAnchor,
  onCommentSubmitted,
  onCommentCancel,
}: DocumentReviewRailProps) {
  const [tab, setTab] = useState<ReviewTab>('comments');
  const [versions, setVersions] = useState<VersionListEntry[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [actionError, setActionError] = useState('');
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [resolving, setResolving] = useState<string | null>(null);

  useEffect(() => {
    if (tab !== 'history' || !documentId) return;
    let cancelled = false;
    setVersionsLoading(true);
    documentsApi.listVersions(documentId)
      .then(result => { if (!cancelled) setVersions([...result.versions].sort((a, b) => b.versionNumber - a.versionNumber)); })
      .catch(error => { if (!cancelled) setActionError(error instanceof Error ? error.message : 'History could not be loaded.'); })
      .finally(() => { if (!cancelled) setVersionsLoading(false); });
    return () => { cancelled = true; };
  }, [documentId, tab]);

  const threads = useMemo(() => comments
    .filter(comment => !comment.parentCommentId)
    .map(comment => ({
      comment,
      replies: comments.filter(reply => reply.threadId === comment.threadId && reply.parentCommentId),
    })), [comments]);
  const handled = threads.filter(({ comment }) => Boolean(comment.resolution));
  const openCount = threads.filter(({ comment }) => comment.status === 'open').length;

  async function reopen(commentId: string) {
    if (!documentId) return;
    setActionError('');
    try {
      const updated = await documentsApi.reopenComment(documentId, commentId);
      await onCommentsChanged([updated]);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Comment could not be reopened.');
    }
  }

  async function resolve(commentId: string) {
    if (!documentId) return;
    setActionError('');
    setResolving(commentId);
    try {
      const updated = await documentsApi.resolveComment(documentId, commentId, { resolutionNote: 'Addressed in the current document version.' });
      await onCommentsChanged([updated]);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Comment could not be resolved.');
    } finally {
      setResolving(null);
    }
  }

  async function reply(commentId: string) {
    if (!documentId || !replyText.trim()) return;
    setActionError('');
    try {
      const replyComment = await documentsApi.replyToComment(documentId, commentId, { body: replyText.trim() });
      setReplyText('');
      setReplyingTo(null);
      await onCommentsChanged([replyComment]);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Reply could not be added.');
    }
  }

  return (
    <aside className="document-review-panel" aria-label="Document comments">
      <header className="document-review-panel__header">
        <span>Comments</span>
        <button type="button" onClick={onClose} title="Close panel" aria-label="Close comments panel"><X /></button>
      </header>

      <div className="document-review-panel__scroll">
        <nav className="document-review-tabs" aria-label="Document review views">
          <button className={tab === 'comments' ? 'on' : ''} type="button" onClick={() => setTab('comments')}>
            Comments {openCount > 0 && <span>{openCount}</span>}
          </button>
          <button className={tab === 'summary' ? 'on' : ''} type="button" onClick={() => setTab('summary')}>Summary</button>
          <button className={tab === 'history' ? 'on' : ''} type="button" onClick={() => setTab('history')}>History</button>
        </nav>

        {actionError && <div className="document-review-error">{actionError}</div>}

        {tab === 'comments' && (
          <div className="document-review-comments">
            <div className="document-review-comments__topbar">
              <button type="button" onClick={onCommentDocument} disabled={!documentId}>Comment on document</button>
            </div>
            {documentId && commentAnchor && onCommentSubmitted && onCommentCancel && (
              <CommentInput
                documentId={documentId}
                anchor={commentAnchor}
                variant="rail"
                onSubmitted={onCommentSubmitted}
                onCancel={onCommentCancel}
              />
            )}
            {loading && threads.length === 0 && <div className="document-review-empty">Loading comments…</div>}
            {!loading && !documentId && <div className="document-review-empty">Enable commenting to start a document review.</div>}
            {!loading && documentId && threads.length === 0 && (
              <div className="document-review-empty"><MessageSquareOff />No comments yet.<br />Select text in the document to start a thread.</div>
            )}
            <div className="document-review-thread-list">
              {threads.map(({ comment, replies }) => (
                <article className={`document-review-thread ${comment.status !== 'open' ? 'done' : ''}`} key={comment.commentId}>
                  <div className="document-review-thread__head">
                    <span className={`document-review-avatar ${comment.authorType === 'agent' ? 'is-agent' : ''}`}>{actorInitial(comment)}</span>
                    <b>{actorLabel(comment)}</b>
                    <button type="button" className="document-review-anchor" onClick={() => onJumpToAnchor(comment.anchor)} title={comment.anchor.snippet || 'Jump to comment anchor'}>
                      {anchorLabel(comment)}
                    </button>
                    <span className={`document-review-state ${comment.status === 'open' ? 'is-open' : ''}`}>{comment.status === 'resolved' ? (comment.resolution ? 'addressed' : 'resolved') : comment.status}</span>
                    {comment.status !== 'open' && <Check className="document-review-check" />}
                    <time dateTime={comment.createdAt}>{formatTime(comment.createdAt)}</time>
                  </div>
                  <p className="document-review-thread__body">{comment.body}</p>

                  {comment.resolution && (
                    <div className="document-review-receipt">
                      <div className="document-review-receipt__top">
                        <span><Check /></span>
                        <p>{comment.status === 'resolved' ? 'Addressed' : 'Resolved'} by <b>{resolutionActor(comment)}</b> · v{comment.resolution.resolvedAtVersion || currentVersion} · {formatTime(comment.resolution.resolvedAt)}</p>
                      </div>
                      <div className="document-review-receipt__summary">{comment.resolution.resolutionNote}</div>
                      <button type="button" onClick={() => { setTab('history'); onViewVersion(comment.resolution?.resolvedAtVersion || currentVersion); }}>See what changed →</button>
                    </div>
                  )}

                  {replies.length > 0 && (
                    <div className="document-review-replies">
                      {replies.map(replyComment => (
                        <div className="document-review-reply" key={replyComment.commentId}>
                          <span className={`document-review-avatar ${replyComment.authorType === 'agent' ? 'is-agent' : ''}`}>{actorInitial(replyComment)}</span>
                          <div><b>{actorLabel(replyComment)}</b><time>{formatTime(replyComment.createdAt)}</time><p>{replyComment.body}</p></div>
                        </div>
                      ))}
                    </div>
                  )}

                  {replyingTo === comment.commentId && (
                    <div className="document-review-replybox">
                      <input
                        autoFocus
                        value={replyText}
                        onChange={event => setReplyText(event.target.value)}
                        onKeyDown={event => { if (event.key === 'Enter') void reply(comment.commentId); }}
                        placeholder="Reply…"
                      />
                      <button type="button" disabled={!replyText.trim()} onClick={() => void reply(comment.commentId)}>Post</button>
                    </div>
                  )}

                  <div className="document-review-thread__actions">
                    {comment.status === 'resolved' && <button type="button" onClick={() => void reopen(comment.commentId)}>Reopen</button>}
                    {comment.status === 'open' && <button type="button" disabled={resolving === comment.commentId} onClick={() => void resolve(comment.commentId)}>{resolving === comment.commentId ? 'Resolving…' : 'Resolve'}</button>}
                    {comment.status === 'open' && <button type="button" onClick={() => { setReplyingTo(replyingTo === comment.commentId ? null : comment.commentId); setReplyText(''); }}>{replyingTo === comment.commentId ? 'Cancel reply' : 'Reply'}</button>}
                  </div>
                </article>
              ))}
            </div>
            {threads.length > 0 && <div className="document-review-foot">Select text in the document to start a new thread.</div>}
          </div>
        )}

        {tab === 'summary' && (
          <div className="document-review-summary">
            {handled.length > 0 ? (
              <>
                <div className="document-review-summary__head"><b>{handled.length} {handled.length === 1 ? 'comment' : 'comments'} handled</b><span>Allen updated {documentTitle} and recorded each outcome.</span></div>
                <div className="document-review-summary__list">
                  {handled.map(({ comment }) => (
                    <div className="document-review-summary__row" key={comment.commentId}>
                      <div><b>{anchorLabel(comment)}</b><p>{comment.resolution?.resolutionNote}</p></div>
                      <span className="document-review-summary__state">addressed</span>
                      <span className="document-review-summary__when">{resolutionActor(comment)} · {formatTime(comment.resolution?.resolvedAt || comment.updatedAt)} · v{comment.resolution?.resolvedAtVersion || currentVersion}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : <div className="document-review-empty">No comment outcomes recorded for this document.</div>}
          </div>
        )}

        {tab === 'history' && (
          <div className="document-review-history">
            {versionsLoading && <div className="document-review-empty">Loading history…</div>}
            {!versionsLoading && versions.length === 0 && <div className="document-review-empty">No document history is available.</div>}
            {versions.map(version => (
              <div className={`document-review-version ${version.versionNumber === currentVersion ? 'current reading' : ''}`} key={version.versionNumber}>
                <span className="document-review-version__dot" />
                <div className="document-review-version__line1">
                  <b>v{version.versionNumber}</b>
                  {version.versionNumber === currentVersion && <span className="document-review-version__current">current</span>}
                  <span>{version.createdReason || (version.versionNumber === 1 ? 'Initial document version' : 'Document updated')}</span>
                </div>
                <div className="document-review-version__line2">
                  <span>{version.createdByAgentName || 'Allen'} · {formatTime(version.createdAt)}</span>
                  <button type="button" onClick={() => onViewVersion(version.versionNumber)}>{version.versionNumber === currentVersion ? 'Reading' : 'View'}</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

function actorLabel(comment: DocumentCommentDoc) {
  return comment.authorType === 'agent'
    ? comment.authorAgentName || 'Allen'
    : comment.authorDisplayName || comment.authorEmail || 'User';
}

function actorInitial(comment: DocumentCommentDoc) {
  return actorLabel(comment).slice(0, 1).toUpperCase();
}

function resolutionActor(comment: DocumentCommentDoc) {
  return comment.resolution?.resolvedByAgentName
    || comment.resolution?.resolvedByDisplayName
    || comment.resolution?.resolvedByEmail
    || 'Allen';
}

function anchorLabel(comment: DocumentCommentDoc) {
  if (comment.anchor.type === 'line' && comment.anchor.lineStart) return `Line ${comment.anchor.lineStart}`;
  if (comment.anchor.type === 'range' && comment.anchor.lineStart) return `Lines ${comment.anchor.lineStart}–${comment.anchor.lineEnd || comment.anchor.lineStart}`;
  if (comment.anchor.snippet) return comment.anchor.snippet.length > 28 ? `${comment.anchor.snippet.slice(0, 28)}…` : comment.anchor.snippet;
  return `Document · v${comment.anchor.anchoredAtVersion}`;
}

function formatTime(iso: string) {
  const elapsed = Date.now() - new Date(iso).getTime();
  const minutes = Math.max(0, Math.floor(elapsed / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString();
}
