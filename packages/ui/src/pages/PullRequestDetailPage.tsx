import { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { pullRequests } from '../services/workspaceService';
import {
  GitPullRequest, ArrowLeft, GitMerge, XCircle, ExternalLink,
  FolderGit2, Loader2, Clock, FileDiff, Plus, Minus, ArrowRight,
} from 'lucide-react';
import Editor, { DiffEditor } from '@monaco-editor/react';
import { SetupProgressDialog } from '../components/workspace/SetupProgressDialog';

export default function PullRequestDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [pr, setPr] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [diff, setDiff] = useState<{ diff: string; files: { path: string; diff: string; originalContent?: string; modifiedContent?: string }[] }>({ diff: '', files: [] });
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [pendingWsId, setPendingWsId] = useState<string | null>(null);

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

  async function handleCreateWorkspace() {
    if (!id) return;
    try {
      const ws = await pullRequests.createWorkspace(id);
      setPendingWsId(ws._id);
    } catch (err: any) { alert(err.message); }
  }

  function timeAgo(date: string) {
    const s = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  function statusColor(status: string) {
    return status === 'merged' ? 'text-accent-purple' : status === 'closed' ? 'text-accent-red' : 'text-accent-green';
  }

  if (loading || !pr) return <div className="flex items-center justify-center h-full"><Loader2 className="w-6 h-6 animate-spin text-theme-muted" /></div>;

  const selectedDiff = diff.files.find(f => f.path === selectedFile);

  // Language from file extension — Monaco does its own diff between the
  // full original/modified file contents the server returns.
  function detectLanguage(path: string | null): string {
    const ext = path?.split('.').pop()?.toLowerCase() ?? '';
    const langMap: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', json: 'json', md: 'markdown', css: 'css', scss: 'scss', html: 'html', yml: 'yaml', yaml: 'yaml', py: 'python', sh: 'shell', go: 'go', rs: 'rust' };
    return langMap[ext] ?? 'plaintext';
  }

  // Map PR status → v2 .badge class
  const statusBadge = pr.status === 'merged' ? 'badge-human' : pr.status === 'closed' ? 'badge-err' : 'badge-ok';

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header — matches handoff/pages/detail-views.jsx PRDetailV2 */}
      <div className="px-6 pt-4 pb-3 border-b border-app shrink-0">
        <div className="flex items-center gap-2 mb-2 text-[12px] text-theme-muted">
          <Link to="/pull-requests" className="hover:text-theme-primary transition-colors flex items-center gap-1">
            <ArrowLeft className="w-3 h-3" /> Pull requests
          </Link>
          <span className="text-theme-subtle">/</span>
          <span className="font-mono">#{pr.number}</span>
        </div>
        <div className="flex items-center gap-3 mb-1.5">
          {pr.status === 'merged'
            ? <GitMerge className="w-4 h-4 text-accent-purple shrink-0" />
            : pr.status === 'closed'
              ? <XCircle className="w-4 h-4 text-accent-red shrink-0" />
              : <GitPullRequest className="w-4 h-4 text-accent-green shrink-0" />}
          <h1 className="text-[20px] font-semibold text-theme-primary tracking-tight truncate">
            <span className="font-mono text-theme-muted text-[16px] mr-2">#{pr.number}</span>
            {pr.title}
          </h1>
          <span className={`badge ${statusBadge}`}>{pr.status}</span>
          <div className="flex-1" />
          {pr.status === 'open' && (
            <button onClick={handleCreateWorkspace} className="btn btn-secondary btn-sm">
              <FolderGit2 className="w-3.5 h-3.5" /> Open workspace
            </button>
          )}
          {pr.url && (
            <a href={pr.url} target="_blank" rel="noopener noreferrer" className="btn btn-primary btn-sm">
              <ExternalLink className="w-3.5 h-3.5" /> GitHub
            </a>
          )}
        </div>
        <div className="flex items-center gap-4 text-[11px] font-mono text-theme-muted">
          <span>{pr.repoName}</span>
          <span className="flex items-center gap-1">{pr.branch} <ArrowRight className="w-3 h-3" /> {pr.baseBranch}</span>
          <span>by {pr.author}</span>
          <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{timeAgo(pr.updatedAt)}</span>
          <span className="flex items-center gap-1"><FileDiff className="w-3 h-3" />{pr.changedFiles} files</span>
          <span className="text-accent-green"><Plus className="w-3 h-3 inline" />{pr.additions}</span>
          <span className="text-accent-red"><Minus className="w-3 h-3 inline" />{pr.deletions}</span>
        </div>
        {pr.description && <p className="mt-2 text-[12px] text-theme-muted line-clamp-2">{pr.description}</p>}
      </div>

      {/* Body: file list + diff */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* File list */}
        <div className="w-64 border-r border-app bg-app-muted/30 overflow-y-auto shrink-0">
          <div className="px-3 py-2 overline">Changed files ({diff.files.length})</div>
          {diff.files.map(f => (
            <button key={f.path} onClick={() => setSelectedFile(f.path)}
              className={`w-full text-left px-3 py-1.5 text-[11px] font-mono truncate ${selectedFile === f.path ? 'bg-accent-soft text-accent' : 'text-theme-secondary hover:bg-app-muted/50'}`}>
              {f.path}
            </button>
          ))}
          {diff.files.length === 0 && <div className="px-3 py-4 text-xs text-theme-subtle">No diff available</div>}
        </div>

        {/* Diff viewer */}
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
            <div className="flex items-center justify-center h-full text-theme-subtle text-sm">Select a file to view diff</div>
          )}
        </div>
      </div>
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
