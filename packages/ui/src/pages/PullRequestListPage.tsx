import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { pullRequests, workspaces } from '../services/workspaceService';
import { repos as reposApi } from '../services/api';
import {
  GitPullRequest, RefreshCw, Loader2, ExternalLink,
  GitMerge, XCircle, FolderGit2, Clock, FileDiff,
  Plus, Minus, ArrowRight, Wrench, X,
} from 'lucide-react';
import { SetupProgressDialog } from '../components/workspace/SetupProgressDialog';
import { workflows as workflowsApi, executions as executionsApi } from '../services/api';

export default function PullRequestListPage() {
  const navigate = useNavigate();
  const [prs, setPrs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>('open');
  const [pendingWsId, setPendingWsId] = useState<string | null>(null);
  const [repos, setRepos] = useState<any[]>([]);
  // Resolve-CodeRabbit manual trigger state
  const [resolveOpen, setResolveOpen] = useState(false);
  const [resolveUrl, setResolveUrl] = useState('');
  const [resolveBusy, setResolveBusy] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setPrs(await pullRequests.list({ status: statusFilter || undefined })); } catch {}
    setLoading(false);
  }, [statusFilter]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    reposApi.list().then(setRepos).catch(() => {});
  }, []);

  async function handleSync() {
    setSyncing(true);
    try {
      // One server-side sweep instead of an N-request client-side loop.
      // Delegates to the same `syncAllActivePrs` helper the pr-sync-all
      // cron uses, so the manual button and the 30-min auto-sync stay
      // consistent by construction.
      await pullRequests.syncAll().catch(() => {});
      await load();
    } catch {}
    setSyncing(false);
  }

  async function handleCreateWorkspace(prId: string) {
    try {
      const ws = await pullRequests.createWorkspace(prId);
      setPendingWsId(ws._id);
    } catch (err: any) { alert(err.message); }
  }

  /** Kick off the resolve-pr-reviews workflow for a PR URL — either a
   *  workflow-owned PR (Flow A) or an external one (Flow B). The server
   *  built-in handles the branching; the UI just submits the URL. */
  async function handleTriggerResolve(prUrl: string, navigateAfter = true) {
    setResolveBusy(true);
    setResolveError(null);
    try {
      const list = await workflowsApi.list();
      const workflow = list.find((w: any) => w.name === 'resolve-pr-reviews');
      if (!workflow) throw new Error('resolve-pr-reviews workflow not found on the server');
      const exec = await executionsApi.start(workflow._id, {
        pr_url: prUrl.trim(),
        review_bot_logins: 'coderabbitai,coderabbitai[bot]',
        already_processed_comment_ids: '[]',
      });
      setResolveOpen(false);
      setResolveUrl('');
      if (navigateAfter) navigate(`/executions/${exec.id}`);
    } catch (err: any) {
      setResolveError(err?.message ?? 'Failed to trigger resolution');
    } finally {
      setResolveBusy(false);
    }
  }

  function statusIcon(status: string) {
    if (status === 'merged') return <GitMerge className="w-4 h-4 text-purple-400" />;
    if (status === 'closed') return <XCircle className="w-4 h-4 text-red-400" />;
    return <GitPullRequest className="w-4 h-4 text-emerald-400" />;
  }

  function statusBadge(status: string) {
    const cls = status === 'merged' ? 'bg-purple-500/10 text-purple-400 border-purple-500/20'
      : status === 'closed' ? 'bg-red-500/10 text-red-400 border-red-500/20'
      : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
    return <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${cls}`}>{status}</span>;
  }

  function timeAgo(date: string) {
    const s = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-6 pt-5 pb-3 border-b border-app shrink-0">
        <div className="flex items-center gap-2 mb-2 text-[12px] text-theme-muted">
          <span>Code</span>
          <span className="text-theme-subtle">/</span>
          <span>Pull requests</span>
        </div>
        <div className="flex items-center gap-3">
          <h1 className="text-[20px] font-semibold text-theme-primary tracking-tight">Pull requests</h1>
          <span className="text-[12px] font-mono text-theme-muted">{prs.length}</span>
          <span className="flex-1" />
          <button
            onClick={() => { setResolveOpen(true); setResolveUrl(''); setResolveError(null); }}
            className="btn btn-secondary btn-sm"
            title="Manually trigger CodeRabbit review resolution for any PR URL (including external ones)"
          >
            <Wrench className="w-3.5 h-3.5" />
            Resolve CodeRabbit
          </button>
          <button onClick={handleSync} disabled={syncing} className="btn btn-secondary btn-sm disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Syncing…' : 'Sync from GitHub'}
          </button>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-1 mt-3">
          {['open', 'merged', 'closed', ''].map(s => (
            <button key={s} onClick={() => setStatusFilter(s)}
              className={`text-[12px] font-mono px-2.5 py-1 rounded-md transition-colors ${statusFilter === s
                ? 'bg-accent-soft text-accent'
                : 'text-theme-muted hover:text-theme-primary hover:bg-app-muted'}`}>
              {s || 'All'}
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {loading ? (
          <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-theme-muted" /></div>
        ) : prs.length === 0 ? (
          <div className="text-center py-12 text-theme-subtle">
            <GitPullRequest className="w-10 h-10 mx-auto mb-3 text-theme-subtle" />
            <p className="text-sm">No pull requests found</p>
            <p className="text-xs text-theme-subtle mt-1">Click "Sync from GitHub" to import PRs</p>
          </div>
        ) : (
          <div className="space-y-3">
            {prs.map(pr => (
              <div key={pr._id} className="card-hover p-4 cursor-pointer" onClick={() => navigate(`/pull-requests/${pr._id}`)}>
                <div className="flex items-start gap-3">
                  {statusIcon(pr.status)}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-theme-primary">#{pr.number}</span>
                      <span className="text-sm text-theme-secondary truncate">{pr.title}</span>
                      {statusBadge(pr.status)}
                    </div>
                    <div className="flex items-center gap-3 mt-1.5 text-[11px] text-theme-muted font-mono">
                      <span>{pr.repoName}</span>
                      <span className="flex items-center gap-1">{pr.branch} <ArrowRight className="w-3 h-3" /> {pr.baseBranch}</span>
                      <span>by {pr.author}</span>
                      {pr.createdByAgent && <span className="text-blue-400">🤖 {pr.createdByAgent}</span>}
                    </div>
                    <div className="flex items-center gap-3 mt-1.5 text-[10px] text-theme-subtle">
                      <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{timeAgo(pr.updatedAt)}</span>
                      <span className="flex items-center gap-1"><FileDiff className="w-3 h-3" />{pr.changedFiles} files</span>
                      <span className="text-emerald-400 flex items-center gap-0.5"><Plus className="w-3 h-3" />{pr.additions}</span>
                      <span className="text-red-400 flex items-center gap-0.5"><Minus className="w-3 h-3" />{pr.deletions}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {pr.status === 'open' && (
                      <button onClick={() => handleCreateWorkspace(pr._id)} className="btn-ghost text-[11px] py-1 px-2 flex items-center gap-1">
                        <FolderGit2 className="w-3.5 h-3.5" /> Open Workspace
                      </button>
                    )}
                    {pr.status === 'open' && pr.url && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleTriggerResolve(pr.url, true); }}
                        className="btn-ghost text-[11px] py-1 px-2 flex items-center gap-1"
                        title="Trigger the resolve-pr-reviews workflow for this PR"
                      >
                        <Wrench className="w-3.5 h-3.5" /> Resolve CodeRabbit
                      </button>
                    )}
                    {pr.url && (
                      <a href={pr.url} target="_blank" rel="noopener noreferrer" className="btn-ghost p-1.5" title="View on GitHub">
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {pendingWsId && (
        <SetupProgressDialog
          workspaceId={pendingWsId}
          onComplete={(ws) => { setPendingWsId(null); navigate(`/workspaces/${ws._id}`); }}
          onFailed={() => setPendingWsId(null)}
        />
      )}

      {resolveOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md">
          <div className="card w-full max-w-lg overflow-hidden shadow-glow-blue/20 animate-in fade-in zoom-in-95 duration-200">
            <div className="px-6 py-5 border-b border-border/60 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-sm bg-accent-yellow/10 border border-accent-yellow/30 flex items-center justify-center">
                  <Wrench className="w-5 h-5 text-accent-yellow" />
                </div>
                <div>
                  <h2 className="font-heading text-sm font-bold text-theme-primary tracking-wider uppercase">Resolve CodeRabbit Comments</h2>
                  <p className="text-[11px] text-theme-muted font-mono">Paste any GitHub PR URL — external PRs create a fresh workspace automatically.</p>
                </div>
              </div>
              <button onClick={() => setResolveOpen(false)} className="p-2 rounded-sm hover:bg-surface-200 text-theme-muted hover:text-theme-secondary">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-6 py-5 space-y-3">
              {resolveError && (
                <div className="text-xs text-accent-red bg-accent-red/10 border border-accent-red/20 rounded-sm px-3 py-2">{resolveError}</div>
              )}
              <label className="flex items-center gap-1 text-xs font-label font-semibold text-theme-secondary uppercase tracking-widest">
                PR URL <span className="text-accent-red normal-case text-[10px]">*</span>
              </label>
              <input
                type="text"
                value={resolveUrl}
                onChange={e => setResolveUrl(e.target.value)}
                placeholder="https://github.com/owner/repo/pull/123"
                className="input w-full font-mono text-sm"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && resolveUrl.trim() && !resolveBusy) {
                    handleTriggerResolve(resolveUrl, true);
                  }
                }}
              />
              <p className="text-[10px] text-theme-muted">
                <strong>Flow A:</strong> if this PR was created by an Allen workflow, the original workspace will be reused. <br />
                <strong>Flow B:</strong> otherwise, the repo must be registered at /repos — a fresh workspace will be created and archived after the fix lands.
              </p>
            </div>
            <div className="flex items-center gap-3 px-6 py-5 border-t border-border/60 bg-surface-50/50">
              <button onClick={() => setResolveOpen(false)} className="flex-1 btn-ghost">Cancel</button>
              <button
                onClick={() => handleTriggerResolve(resolveUrl, true)}
                disabled={resolveBusy || !resolveUrl.trim()}
                className="flex-1 btn-primary inline-flex items-center justify-center gap-2"
              >
                {resolveBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wrench className="w-4 h-4" />}
                {resolveBusy ? 'Starting…' : 'Run Workflow'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
