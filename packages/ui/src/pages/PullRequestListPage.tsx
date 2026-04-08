import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { pullRequests, workspaces } from '../services/workspaceService';
import {
  GitPullRequest, RefreshCw, Loader2, ExternalLink,
  GitMerge, XCircle, FolderGit2, Clock, FileDiff,
  Plus, Minus, ArrowRight,
} from 'lucide-react';

export default function PullRequestListPage() {
  const navigate = useNavigate();
  const [prs, setPrs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>('open');
  const [repos, setRepos] = useState<any[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try { setPrs(await pullRequests.list({ status: statusFilter || undefined })); } catch {}
    setLoading(false);
  }, [statusFilter]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    fetch('/api/repos').then(r => r.json()).then(setRepos).catch(() => {});
  }, []);

  async function handleSync() {
    setSyncing(true);
    try {
      for (const repo of repos) {
        await pullRequests.sync(repo.path, repo._id, repo.name).catch(() => {});
      }
      await load();
    } catch {}
    setSyncing(false);
  }

  async function handleCreateWorkspace(prId: string) {
    try {
      const ws = await pullRequests.createWorkspace(prId);
      navigate(`/workspaces/${ws._id}`);
    } catch (err: any) { alert(err.message); }
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
      <div className="px-6 py-4 border-b border-border/30 bg-surface-50/50 shrink-0">
        <div className="flex items-center gap-3">
          <GitPullRequest className="w-5 h-5 text-blue-400" />
          <h1 className="text-lg font-heading font-semibold text-white">Pull Requests</h1>
          <span className="flex-1" />
          <button onClick={handleSync} disabled={syncing} className="btn-ghost text-xs py-1.5 px-3 flex items-center gap-1.5 disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Syncing...' : 'Sync from GitHub'}
          </button>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-2 mt-3">
          {['open', 'merged', 'closed', ''].map(s => (
            <button key={s} onClick={() => setStatusFilter(s)}
              className={`text-[11px] font-mono px-3 py-1 rounded-full border ${statusFilter === s
                ? 'bg-blue-500/10 text-blue-400 border-blue-500/30'
                : 'text-gray-500 border-border/20 hover:text-gray-300'}`}>
              {s || 'All'}
            </button>
          ))}
          <span className="text-[10px] text-gray-600 ml-2">{prs.length} results</span>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {loading ? (
          <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-gray-500" /></div>
        ) : prs.length === 0 ? (
          <div className="text-center py-12 text-gray-600">
            <GitPullRequest className="w-10 h-10 mx-auto mb-3 text-gray-700" />
            <p className="text-sm">No pull requests found</p>
            <p className="text-xs text-gray-700 mt-1">Click "Sync from GitHub" to import PRs</p>
          </div>
        ) : (
          <div className="space-y-3">
            {prs.map(pr => (
              <div key={pr._id} className="border border-border/20 rounded-lg p-4 hover:border-border/40 transition-colors bg-surface-50/20 cursor-pointer" onClick={() => navigate(`/pull-requests/${pr._id}`)}>
                <div className="flex items-start gap-3">
                  {statusIcon(pr.status)}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-white">#{pr.number}</span>
                      <span className="text-sm text-gray-300 truncate">{pr.title}</span>
                      {statusBadge(pr.status)}
                    </div>
                    <div className="flex items-center gap-3 mt-1.5 text-[11px] text-gray-500 font-mono">
                      <span>{pr.repoName}</span>
                      <span className="flex items-center gap-1">{pr.branch} <ArrowRight className="w-3 h-3" /> {pr.baseBranch}</span>
                      <span>by {pr.author}</span>
                      {pr.createdByAgent && <span className="text-blue-400">🤖 {pr.createdByAgent}</span>}
                    </div>
                    <div className="flex items-center gap-3 mt-1.5 text-[10px] text-gray-600">
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
    </div>
  );
}
