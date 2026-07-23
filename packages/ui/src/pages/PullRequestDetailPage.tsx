import { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { pullRequests } from '../services/workspaceService';
import {
  ArrowLeft, ExternalLink, FolderGit2, Loader2, Plus, Minus,
  MessageSquare, CheckCircle2, AlertCircle,
} from 'lucide-react';
import { SetupProgressDialog } from '../components/workspace/SetupProgressDialog';
import { renderMarkdown } from '../components/chat/ChatMessageList';
import { workspaceChatPath } from '../lib/workspace-routes';

interface DiffFile {
  path: string;
  diff: string;
  status?: string;
  additions?: number;
  deletions?: number;
  originalContent?: string;
  modifiedContent?: string;
}

interface Comment {
  id: string;
  kind: 'comment' | 'review' | 'review-comment';
  author: string;
  body: string;
  url?: string;
  createdAt: string;
  path?: string;
  line?: number;
  reviewState?: string;
}

type Tab = 'conversation' | 'files';

export default function PullRequestDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [pr, setPr] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [diff, setDiff] = useState<{ diff: string; files: DiffFile[] }>({ diff: '', files: [] });
  const [pendingWsId, setPendingWsId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('conversation');
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [commentsLoading, setCommentsLoading] = useState(false);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    Promise.all([
      pullRequests.get(id),
      pullRequests.getDiff(id).catch(() => ({ diff: '', files: [] })),
    ]).then(([p, d]) => {
      setPr(p);
      setDiff(d);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [id]);

  // Lazy-load comments the first time the Conversation tab is active.
  useEffect(() => {
    if (!id || tab !== 'conversation' || comments !== null) return;
    setCommentsLoading(true);
    pullRequests.getComments(id)
      .then(({ comments: c }) => setComments(c))
      .catch(() => setComments([]))
      .finally(() => setCommentsLoading(false));
  }, [id, tab, comments]);


  async function handleCreateWorkspace() {
    if (!id) return;
    try {
      const ws = await pullRequests.createWorkspace(id);
      setPendingWsId(ws._id);
    } catch (err: any) { alert(err.message); }
  }

  function timeAgo(date: string) {
    const s = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
    return new Date(date).toLocaleDateString();
  }

  if (loading || !pr) return (
    <div className="flex items-center justify-center h-full">
      <Loader2 className="w-6 h-6 animate-spin text-theme-muted" />
    </div>
  );

  return (
    <div className="v8-page v8-pr-detail" data-screen-label="pull-request-detail">
      <div className="v8-page__wrap">
        <Link to="/pull-requests" className="v8-pr-detail__crumb"><ArrowLeft /> Pull requests</Link>

        <header className="v8-pr-detail__head">
          <div>
            <h1>#{pr.number} · {pr.title}</h1>
            <p>
              <span className={`v8-pr-detail__status ${pr.status}`}>{pr.status}{pr.reviewed ? ' · reviewed' : ''}</span>
              <span> · {pr.repoName} · </span>
              <span className="mono">{pr.branch} → {pr.baseBranch}</span>
              <span> · by {pr.author} · {timeAgo(pr.updatedAt)} · </span>
              <b className="add">+{pr.additions ?? 0}</b>{' '}
              <b className="del">−{pr.deletions ?? 0}</b>
            </p>
          </div>
          <span />
          {pr.status === 'open' && <button onClick={handleCreateWorkspace} className="v8-btn v8-btn--ink" type="button">Create workspace</button>}
          {pr.url && <a href={pr.url} target="_blank" rel="noopener noreferrer" className="v8-btn v8-btn--ghost">Open in GitHub</a>}
        </header>

        <div className="v8-tabs v8-pr-detail__tabs">
          <button className={tab === 'conversation' ? 'on' : ''} type="button" onClick={() => setTab('conversation')}>
            Conversation <span>{comments?.length ?? 0}</span>
          </button>
          <button className={tab === 'files' ? 'on' : ''} type="button" onClick={() => setTab('files')}>
            Files changed <span>{diff.files.length || pr.changedFiles || 0}</span>
          </button>
        </div>

        {tab === 'conversation' && (
          <div className="v8-pr-detail__conversation">
            <h2>Summary</h2>
            {pr.description ? (
              <div className="prose-allen v8-pr-detail__markdown">{renderMarkdown(pr.description)}</div>
            ) : (
              <p className="v8-pr-detail__muted">No description provided.</p>
            )}
            {commentsLoading && <div className="v8-pr-detail__loading"><Loader2 /> Loading comments…</div>}
            {!commentsLoading && comments && comments.length > 0 && (
              <section className="v8-pr-detail__comments">
                <h2>Conversation</h2>
                {comments.map(comment => <CommentCard key={comment.id} c={comment} timeAgo={timeAgo} />)}
              </section>
            )}
          </div>
        )}

        {tab === 'files' && (
          <div className="v8-pr-detail__files">
            {diff.files.map(file => (
              <div className="v8-pr-detail__file" key={file.path}>
                <span>{file.path}</span>
                <span>
                  <b className="add">+{file.additions ?? 0}</b>{' '}
                  <b className="del">−{file.deletions ?? 0}</b>
                </span>
              </div>
            ))}
            {diff.files.length === 0 && <div className="v8-filter-empty">No diff available.</div>}
          </div>
        )}

        <p className="v8-page-foot">PR detail · conversation and milestones as written by the implementing session</p>
      </div>

      {pendingWsId && (
        <SetupProgressDialog
          workspaceId={pendingWsId}
          onComplete={(ws) => { setPendingWsId(null); navigate(workspaceChatPath(ws._id)); }}
          onFailed={() => setPendingWsId(null)}
          onCancel={() => setPendingWsId(null)}
        />
      )}
    </div>
  );
}

// ── Conversation comments ────────────────────────────────────────────────

function CommentCard({ c, timeAgo }: { c: Comment; timeAgo: (s: string) => string }) {
  const isReview = c.kind === 'review';
  const isReviewComment = c.kind === 'review-comment';

  // Review-state badge color
  const reviewStateBadge =
    c.reviewState === 'APPROVED' ? 'badge-ok'
    : c.reviewState === 'CHANGES_REQUESTED' ? 'badge-err'
    : c.reviewState === 'COMMENTED' ? 'badge-info'
    : 'badge-muted';

  const reviewStateIcon =
    c.reviewState === 'APPROVED' ? <CheckCircle2 className="w-3 h-3" />
    : c.reviewState === 'CHANGES_REQUESTED' ? <AlertCircle className="w-3 h-3" />
    : <MessageSquare className="w-3 h-3" />;

  return (
    <div className={`card overflow-hidden ${isReviewComment ? 'border-l-2 border-l-accent' : ''}`}>
      <div className="flex items-center gap-2 px-4 py-2 border-b border-app bg-app-muted/40">
        <div className="w-6 h-6 rounded-full bg-gradient-to-br from-accent to-accent-purple flex items-center justify-center text-white text-[10px] font-semibold shrink-0">
          {(c.author ?? '?').charAt(0).toUpperCase()}
        </div>
        <span className="text-[13px] font-medium text-theme-primary">{c.author}</span>
        {isReview && (
          <span className={`badge ${reviewStateBadge} flex items-center gap-1`}>
            {reviewStateIcon}
            {(c.reviewState ?? 'commented').toLowerCase().replace(/_/g, ' ')}
          </span>
        )}
        {isReviewComment && c.path && (
          <span className="text-[11px] font-mono text-theme-muted truncate max-w-[24rem]">
            {c.path}{c.line != null ? `:${c.line}` : ''}
          </span>
        )}
        {!isReview && !isReviewComment && (
          <span className="text-[11px] text-theme-muted">commented</span>
        )}
        <span className="text-[11px] text-theme-subtle">· {timeAgo(c.createdAt)}</span>
        <div className="flex-1" />
        {c.url && (
          <a
            href={c.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-theme-muted hover:text-theme-primary"
            title="View on GitHub"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        )}
      </div>
      <div className="px-4 py-3">
        {c.body && c.body.trim() ? (
          <div className="prose-allen text-[13px] text-theme-secondary leading-relaxed">
            {renderMarkdown(c.body)}
          </div>
        ) : (
          <div className="text-[12px] text-theme-subtle italic">
            {isReview ? `Submitted a ${(c.reviewState ?? 'review').toLowerCase().replace(/_/g, ' ')}` : 'No body'}
          </div>
        )}
      </div>
    </div>
  );
}
