import { useState, useEffect, useMemo } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { pullRequests } from '../services/workspaceService';
import {
  GitPullRequest, ArrowLeft, GitMerge, XCircle, ExternalLink,
  FolderGit2, Loader2, Clock, FileDiff, Plus, Minus, ArrowRight,
  MessageSquare, FileCode, CheckCircle2, AlertCircle, MessagesSquare,
} from 'lucide-react';
import { DiffEditor } from '@monaco-editor/react';
import { SetupProgressDialog } from '../components/workspace/SetupProgressDialog';
import { renderMarkdown } from '../components/chat/ChatMessageList';

interface DiffFile {
  path: string;
  diff: string;
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
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
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
      if (d.files.length > 0) setSelectedFile(d.files[0].path);
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

  const selectedDiff = diff.files.find(f => f.path === selectedFile);

  function detectLanguage(path: string | null): string {
    const ext = path?.split('.').pop()?.toLowerCase() ?? '';
    const langMap: Record<string, string> = {
      ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
      json: 'json', md: 'markdown', css: 'css', scss: 'scss', html: 'html',
      yml: 'yaml', yaml: 'yaml', py: 'python', sh: 'shell', go: 'go', rs: 'rust',
    };
    return langMap[ext] ?? 'plaintext';
  }

  const statusBadge = pr.status === 'merged' ? 'badge-human' : pr.status === 'closed' ? 'badge-err' : 'badge-ok';

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="px-6 pt-4 pb-3 border-b border-app shrink-0">
        <div className="flex items-center gap-2 mb-2 text-[12px] text-theme-muted">
          <Link to="/pull-requests" className="hover:text-theme-primary transition-colors flex items-center gap-1">
            <ArrowLeft className="w-3 h-3" /> Pull requests
          </Link>
          <span className="text-theme-subtle">/</span>
          <span className="font-mono">#{pr.number}</span>
        </div>
        <div className="flex items-start gap-3 mb-2">
          {pr.status === 'merged'
            ? <GitMerge className="w-5 h-5 text-accent-purple shrink-0 mt-1" />
            : pr.status === 'closed'
              ? <XCircle className="w-5 h-5 text-accent-red shrink-0 mt-1" />
              : <GitPullRequest className="w-5 h-5 text-accent-green shrink-0 mt-1" />}
          <h1 className="text-[20px] font-semibold text-theme-primary tracking-tight flex-1 leading-snug">
            <span className="font-mono text-theme-muted text-[16px] mr-2">#{pr.number}</span>
            {pr.title}
          </h1>
          <span className={`badge ${statusBadge} mt-1`}>{pr.status}</span>
          {pr.status === 'open' && (
            <button onClick={handleCreateWorkspace} className="btn btn-primary btn-sm mt-1">
              <FolderGit2 className="w-3.5 h-3.5" /> Create workspace
            </button>
          )}
          {pr.url && (
            <a href={pr.url} target="_blank" rel="noopener noreferrer" className="btn btn-secondary btn-sm mt-1">
              <ExternalLink className="w-3.5 h-3.5" /> Open in GitHub
            </a>
          )}
        </div>
        <div className="flex items-center gap-4 text-[11px] font-mono text-theme-muted ml-8">
          <span>{pr.repoName}</span>
          <span className="flex items-center gap-1">
            <span className="badge badge-muted">{pr.branch}</span>
            <ArrowRight className="w-3 h-3" />
            <span className="badge badge-muted">{pr.baseBranch}</span>
          </span>
          <span>by <span className="text-theme-secondary">{pr.author}</span></span>
          <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{timeAgo(pr.updatedAt)}</span>
          <span className="flex items-center gap-1"><FileDiff className="w-3 h-3" />{pr.changedFiles} files</span>
          <span className="text-accent-green flex items-center gap-0.5"><Plus className="w-3 h-3" />{pr.additions}</span>
          <span className="text-accent-red flex items-center gap-0.5"><Minus className="w-3 h-3" />{pr.deletions}</span>
        </div>

        {/* Tab row */}
        <div className="flex items-center gap-1 mt-3 -mb-px">
          <button
            onClick={() => setTab('conversation')}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 text-[13px] -mb-px transition-colors border-b-2 ${
              tab === 'conversation'
                ? 'text-theme-primary font-medium border-accent'
                : 'text-theme-muted hover:text-theme-primary border-transparent'
            }`}
          >
            <MessagesSquare className="w-3.5 h-3.5" /> Conversation
            {comments && (
              <span className="text-[11px] font-mono text-theme-muted">{comments.length}</span>
            )}
          </button>
          <button
            onClick={() => setTab('files')}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 text-[13px] -mb-px transition-colors border-b-2 ${
              tab === 'files'
                ? 'text-theme-primary font-medium border-accent'
                : 'text-theme-muted hover:text-theme-primary border-transparent'
            }`}
          >
            <FileCode className="w-3.5 h-3.5" /> Files changed
            <span className="text-[11px] font-mono text-theme-muted">{diff.files.length}</span>
          </button>
        </div>
      </div>

      {/* ── Body ─────────────────────────────────────────────────────────── */}
      {tab === 'conversation' && (
        <ConversationTab
          pr={pr}
          comments={comments}
          loading={commentsLoading}
          timeAgo={timeAgo}
        />
      )}

      {tab === 'files' && (
        <div className="flex-1 flex overflow-hidden min-h-0">
          <div className="w-64 border-r border-app bg-app-muted/30 overflow-y-auto shrink-0">
            <div className="px-3 py-2 overline">Changed files ({diff.files.length})</div>
            {diff.files.map(f => (
              <button
                key={f.path}
                onClick={() => setSelectedFile(f.path)}
                className={`w-full text-left px-3 py-1.5 text-[11px] font-mono truncate ${
                  selectedFile === f.path
                    ? 'bg-accent-soft text-accent'
                    : 'text-theme-secondary hover:bg-app-muted/50'
                }`}
              >
                {f.path}
              </button>
            ))}
            {diff.files.length === 0 && (
              <div className="px-3 py-4 text-xs text-theme-subtle">No diff available</div>
            )}
          </div>
          <div className="flex-1 min-h-0 overflow-hidden">
            {selectedDiff ? (
              <DiffEditor
                height="100%"
                language={detectLanguage(selectedFile)}
                original={selectedDiff.originalContent ?? ''}
                modified={selectedDiff.modifiedContent ?? ''}
                theme="vs-dark"
                options={{
                  readOnly: true,
                  fontSize: 12,
                  fontFamily: "'JetBrains Mono', monospace",
                  renderSideBySide: true,
                  scrollBeyondLastLine: false,
                  minimap: { enabled: false },
                }}
              />
            ) : (
              <div className="flex items-center justify-center h-full text-theme-subtle text-sm">
                Select a file to view diff
              </div>
            )}
          </div>
        </div>
      )}

      {pendingWsId && (
        <SetupProgressDialog
          workspaceId={pendingWsId}
          onComplete={(ws) => { setPendingWsId(null); navigate(`/workspaces/${ws._id}`); }}
          onFailed={() => setPendingWsId(null)}
        />
      )}
    </div>
  );
}

// ── Conversation tab ──────────────────────────────────────────────────────

function ConversationTab({
  pr, comments, loading, timeAgo,
}: {
  pr: any;
  comments: Comment[] | null;
  loading: boolean;
  timeAgo: (date: string) => string;
}) {
  // Group inline review comments by file path so each review thread renders
  // with the file context next to the body.
  const grouped = useMemo(() => {
    if (!comments) return [];
    return comments;
  }, [comments]);

  return (
    <div className="flex-1 overflow-y-auto min-h-0">
      <div className="max-w-4xl mx-auto px-6 py-6 space-y-4">
        {/* Description card */}
        <div className="card overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-app bg-app-muted/40">
            <div className="w-6 h-6 rounded-full bg-gradient-to-br from-accent to-accent-purple flex items-center justify-center text-white text-[10px] font-semibold shrink-0">
              {(pr.author ?? '?').charAt(0).toUpperCase()}
            </div>
            <span className="text-[13px] font-medium text-theme-primary">{pr.author}</span>
            <span className="text-[11px] text-theme-muted">opened this pull request</span>
            <span className="text-[11px] text-theme-subtle">· {timeAgo(pr.createdAt)}</span>
          </div>
          <div className="px-4 py-4">
            {pr.description ? (
              <div className="prose-allen text-[13px] text-theme-secondary leading-relaxed">
                {renderMarkdown(pr.description)}
              </div>
            ) : (
              <div className="text-[12px] text-theme-subtle italic">No description provided.</div>
            )}
          </div>
        </div>

        {/* Comments timeline */}
        {loading && (
          <div className="flex items-center justify-center py-8 text-[12px] text-theme-muted">
            <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading comments…
          </div>
        )}

        {!loading && comments !== null && comments.length === 0 && (
          <div className="rounded-xl border border-dashed border-app p-8 text-center text-[12px] text-theme-muted font-body italic">
            No comments yet on this pull request.
          </div>
        )}

        {!loading && grouped.length > 0 && (
          <div className="space-y-3">
            {grouped.map((c) => (
              <CommentCard key={c.id} c={c} timeAgo={timeAgo} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

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
