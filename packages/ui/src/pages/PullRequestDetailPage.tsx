import { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { pullRequests } from '../services/workspaceService';
import {
  GitPullRequest, ArrowLeft, GitMerge, XCircle, ExternalLink,
  FolderGit2, Loader2, Clock, FileDiff, Plus, Minus, ArrowRight,
} from 'lucide-react';
import Editor, { DiffEditor } from '@monaco-editor/react';

export default function PullRequestDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [pr, setPr] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [diff, setDiff] = useState<{ diff: string; files: { path: string; diff: string }[] }>({ diff: '', files: [] });
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

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
      navigate(`/workspaces/${ws._id}`);
    } catch (err: any) { alert(err.message); }
  }

  function timeAgo(date: string) {
    const s = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  function statusColor(status: string) {
    return status === 'merged' ? 'text-purple-400' : status === 'closed' ? 'text-red-400' : 'text-emerald-400';
  }

  if (loading || !pr) return <div className="flex items-center justify-center h-full"><Loader2 className="w-6 h-6 animate-spin text-gray-500" /></div>;

  const selectedDiff = diff.files.find(f => f.path === selectedFile);

  // Parse diff into original/modified for Monaco DiffEditor
  function parseDiffContent(diffText: string): { original: string; modified: string; language: string } {
    const lines = diffText.split('\n');
    const origLines: string[] = [];
    const modLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('@@') || line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) continue;
      if (line.startsWith('-')) origLines.push(line.slice(1));
      else if (line.startsWith('+')) modLines.push(line.slice(1));
      else { origLines.push(line.startsWith(' ') ? line.slice(1) : line); modLines.push(line.startsWith(' ') ? line.slice(1) : line); }
    }
    const ext = selectedFile?.split('.').pop()?.toLowerCase() ?? '';
    const langMap: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', json: 'json', md: 'markdown', css: 'css', html: 'html', yml: 'yaml', yaml: 'yaml', py: 'python' };
    return { original: origLines.join('\n'), modified: modLines.join('\n'), language: langMap[ext] ?? 'plaintext' };
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-6 py-3 border-b border-border/30 bg-surface-50/50 shrink-0">
        <div className="flex items-center gap-3">
          <Link to="/pull-requests" className="text-gray-400 hover:text-white"><ArrowLeft className="w-4 h-4" /></Link>
          {pr.status === 'merged' ? <GitMerge className="w-4 h-4 text-purple-400" /> : pr.status === 'closed' ? <XCircle className="w-4 h-4 text-red-400" /> : <GitPullRequest className="w-4 h-4 text-emerald-400" />}
          <span className="text-sm font-semibold text-white">#{pr.number}</span>
          <span className="text-sm text-gray-300">{pr.title}</span>
          <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${statusColor(pr.status)} border-current/20 bg-current/5`}>{pr.status}</span>
          <span className="flex-1" />
          {pr.status === 'open' && (
            <button onClick={handleCreateWorkspace} className="btn-ghost text-xs py-1.5 px-3 flex items-center gap-1.5">
              <FolderGit2 className="w-3.5 h-3.5" /> Open Workspace
            </button>
          )}
          {pr.url && (
            <a href={pr.url} target="_blank" rel="noopener noreferrer" className="btn-ghost text-xs py-1.5 px-3 flex items-center gap-1.5">
              <ExternalLink className="w-3.5 h-3.5" /> GitHub
            </a>
          )}
        </div>
        <div className="flex items-center gap-4 mt-2 text-[11px] font-mono text-gray-500">
          <span>{pr.repoName}</span>
          <span className="flex items-center gap-1">{pr.branch} <ArrowRight className="w-3 h-3" /> {pr.baseBranch}</span>
          <span>by {pr.author}</span>
          <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{timeAgo(pr.updatedAt)}</span>
          <span className="flex items-center gap-1"><FileDiff className="w-3 h-3" />{pr.changedFiles} files</span>
          <span className="text-emerald-400"><Plus className="w-3 h-3 inline" />{pr.additions}</span>
          <span className="text-red-400"><Minus className="w-3 h-3 inline" />{pr.deletions}</span>
        </div>
        {pr.description && <p className="mt-2 text-xs text-gray-500 line-clamp-2">{pr.description}</p>}
      </div>

      {/* Body: file list + diff */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* File list */}
        <div className="w-64 border-r border-border/20 bg-surface-50/30 overflow-y-auto shrink-0">
          <div className="px-3 py-2 text-[10px] font-label uppercase tracking-wider text-gray-600">Changed Files ({diff.files.length})</div>
          {diff.files.map(f => (
            <button key={f.path} onClick={() => setSelectedFile(f.path)}
              className={`w-full text-left px-3 py-1.5 text-[11px] font-mono truncate ${selectedFile === f.path ? 'bg-blue-500/10 text-blue-400' : 'text-gray-400 hover:bg-white/5'}`}>
              {f.path}
            </button>
          ))}
          {diff.files.length === 0 && <div className="px-3 py-4 text-xs text-gray-600">No diff available</div>}
        </div>

        {/* Diff viewer */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {selectedDiff ? (() => {
            const { original, modified, language } = parseDiffContent(selectedDiff.diff);
            return (
              <DiffEditor
                height="100%"
                language={language}
                original={original}
                modified={modified}
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
            );
          })() : (
            <div className="flex items-center justify-center h-full text-gray-600 text-sm">Select a file to view diff</div>
          )}
        </div>
      </div>
    </div>
  );
}
