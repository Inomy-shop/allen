import { useState, useEffect, useCallback } from 'react';
import { repos as repoApi, workflows as wfApi } from '../services/api';
import DeleteConfirmDialog from '../components/common/DeleteConfirmDialog';
import {
  FolderGit2, Plus, RefreshCw, Trash2, Pencil, ScanSearch, X,
  GitBranch, Package, Code2, Sparkles, ExternalLink, Loader2, Settings, Monitor, FileText,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { renderMarkdown } from '../components/chat/ChatMessageList';
import { WorkspaceConfigEditor } from '../components/workspace/WorkspaceConfigEditor';
import { workspaces as wsApi } from '../services/workspaceService';
import { SetupProgressDialog } from '../components/workspace/SetupProgressDialog';
import { useToast } from '../components/common/Toast';

interface Repo {
  _id: string;
  name: string;
  path: string;
  description?: string;
  detected: {
    language: string[];
    framework: string[];
    packageManager: string;
    defaultBranch: string;
    remoteUrl?: string;
  };
  tags: string[];
  defaultWorkflow?: string;
  context?: string;
  status: 'active' | 'archived';
  lastUsedAt?: string;
  executionCount: number;
  createdAt: string;
  updatedAt: string;
}

/* ── Add Dialog ─────────────────────────────────────────────────────────── */

function AddRepoDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [url, setUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    if (!url.trim()) { setError('Repository URL is required'); return; }
    setSaving(true);
    setError('');
    try {
      await repoApi.clone({
        url: url.trim(),
        branch: branch.trim() || 'main',
        name: name.trim() || undefined,
        description: description.trim() || undefined,
        tags: tags.trim() ? tags.split(',').map(t => t.trim()).filter(Boolean) : [],
      });
      setUrl(''); setBranch('main'); setName(''); setDescription(''); setTags('');
      onCreated();
      onClose();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md">
      <div className="card w-full max-w-lg overflow-hidden shadow-glow-blue/20 animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="px-6 py-5 border-b border-border/60">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-sm bg-accent-blue/10 border border-accent-blue/30 flex items-center justify-center">
                <Plus className="w-5 h-5 text-accent-blue" />
              </div>
              <div>
                <h2 className="font-heading text-sm font-bold text-theme-primary tracking-wider uppercase">Add Repository</h2>
                <p className="text-[11px] text-theme-muted font-mono">Clone from GitHub &middot; auto-detects language, framework</p>
              </div>
            </div>
            <button onClick={onClose} className="p-2 rounded-sm hover:bg-surface-200 text-theme-muted hover:text-theme-secondary transition-colors" title="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Fields */}
        <div className="px-6 py-5 space-y-4 max-h-[50vh] overflow-auto">
          {error && (
            <div className="text-xs text-accent-red bg-accent-red/10 border border-accent-red/20 rounded-sm px-3 py-2">{error}</div>
          )}
          <div>
            <label className="flex items-center gap-1 text-xs font-label font-semibold text-theme-secondary mb-2 uppercase tracking-widest">
              Repository URL <span className="text-accent-red normal-case text-[10px]">*</span>
            </label>
            <input type="text" value={url} onChange={e => setUrl(e.target.value)}
              placeholder="https://github.com/owner/repo or git@github.com:owner/repo.git" className="input w-full font-mono text-sm" />
            <p className="text-[10px] text-theme-muted mt-1">HTTPS or SSH URL. Clones via SSH to /tmp/repositories/&lt;repo-name&gt;</p>
          </div>
          <div>
            <label className="flex items-center gap-1 text-xs font-label font-semibold text-theme-secondary mb-2 uppercase tracking-widest">
              Branch <span className="text-accent-red normal-case text-[10px]">*</span>
            </label>
            <input type="text" value={branch} onChange={e => setBranch(e.target.value)}
              placeholder="main" className="input w-full font-mono text-sm" />
            <p className="text-[10px] text-theme-muted mt-1">Branch to checkout after cloning. Scanning runs on this branch.</p>
          </div>
          <div>
            <label className="text-xs font-label font-semibold text-theme-secondary mb-2 uppercase tracking-widest block">Name</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)}
              placeholder="Auto-derived from repo name" className="input w-full text-sm" />
          </div>
          <div>
            <label className="text-xs font-label font-semibold text-theme-secondary mb-2 uppercase tracking-widest block">Description</label>
            <input type="text" value={description} onChange={e => setDescription(e.target.value)}
              placeholder="Brief description" className="input w-full text-sm" />
          </div>
          <div>
            <label className="text-xs font-label font-semibold text-theme-secondary mb-2 uppercase tracking-widest block">Tags</label>
            <input type="text" value={tags} onChange={e => setTags(e.target.value)}
              placeholder="Comma-separated, e.g. backend, api" className="input w-full text-sm font-mono" />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center gap-3 px-6 py-5 border-t border-border/60 bg-surface-50/50">
          <button onClick={onClose} className="flex-1 btn-ghost">Cancel</button>
          <button onClick={handleSubmit} disabled={saving} className="flex-1 btn-primary inline-flex items-center justify-center gap-2">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <FolderGit2 className="w-4 h-4" />}
            {saving ? 'Cloning...' : 'Clone & Add'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Edit Dialog ────────────────────────────────────────────────────────── */

function EditRepoDialog({ repo, open, onClose, onUpdated }: { repo: Repo | null; open: boolean; onClose: () => void; onUpdated: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [context, setContext] = useState('');
  const [defaultWorkflow, setDefaultWorkflow] = useState('');
  const [status, setStatus] = useState<'active' | 'archived'>('active');
  const [workflows, setWorkflows] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (repo && open) {
      setName(repo.name);
      setDescription(repo.description ?? '');
      setTags(repo.tags?.join(', ') ?? '');
      setContext(repo.context ?? '');
      setDefaultWorkflow(repo.defaultWorkflow ?? '');
      setStatus(repo.status);
      setError('');
      wfApi.list().then(setWorkflows).catch(() => {});
    }
  }, [repo, open]);

  const handleSubmit = async () => {
    if (!repo) return;
    setSaving(true);
    setError('');
    try {
      await repoApi.update(repo._id, {
        name: name.trim(),
        description: description.trim(),
        tags: tags.trim() ? tags.split(',').map(t => t.trim()).filter(Boolean) : [],
        context: context.trim(),
        defaultWorkflow: defaultWorkflow || undefined,
        status,
      });
      onUpdated();
      onClose();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (!open || !repo) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md">
      <div className="card w-full max-w-lg overflow-hidden shadow-glow-blue/20 animate-in fade-in zoom-in-95 duration-200">
        <div className="px-6 py-5 border-b border-border/60">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-sm bg-accent-blue/10 border border-accent-blue/30 flex items-center justify-center">
                <Pencil className="w-5 h-5 text-accent-blue" />
              </div>
              <div>
                <h2 className="font-heading text-sm font-bold text-theme-primary tracking-wider uppercase">Edit Repository</h2>
                <p className="text-[11px] text-theme-muted font-mono">{repo.path}</p>
              </div>
            </div>
            <button onClick={onClose} className="p-2 rounded-sm hover:bg-surface-200 text-theme-muted hover:text-theme-secondary transition-colors" title="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="px-6 py-5 space-y-4 max-h-[50vh] overflow-auto">
          {error && (
            <div className="text-xs text-accent-red bg-accent-red/10 border border-accent-red/20 rounded-sm px-3 py-2">{error}</div>
          )}
          <div>
            <label className="text-xs font-label font-semibold text-theme-secondary mb-2 uppercase tracking-widest block">Name</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)} className="input w-full text-sm" />
          </div>
          <div>
            <label className="text-xs font-label font-semibold text-theme-secondary mb-2 uppercase tracking-widest block">Description</label>
            <input type="text" value={description} onChange={e => setDescription(e.target.value)} className="input w-full text-sm" />
          </div>
          <div>
            <label className="text-xs font-label font-semibold text-theme-secondary mb-2 uppercase tracking-widest block">Tags</label>
            <input type="text" value={tags} onChange={e => setTags(e.target.value)}
              placeholder="Comma-separated" className="input w-full text-sm font-mono" />
          </div>
          <div>
            <label className="text-xs font-label font-semibold text-theme-secondary mb-2 uppercase tracking-widest block">Context</label>
            <textarea value={context} onChange={e => setContext(e.target.value)}
              rows={3} className="input w-full text-sm resize-none" placeholder="Brief context for chat agent" />
          </div>
          <div>
            <label className="text-xs font-label font-semibold text-theme-secondary mb-2 uppercase tracking-widest block">Default Workflow</label>
            <select value={defaultWorkflow} onChange={e => setDefaultWorkflow(e.target.value)} className="input w-full text-sm">
              <option value="">None</option>
              {workflows.map((wf: any) => (
                <option key={wf._id} value={wf.name}>{wf.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-label font-semibold text-theme-secondary mb-2 uppercase tracking-widest block">Status</label>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="status" value="active" checked={status === 'active'}
                  onChange={() => setStatus('active')} className="accent-accent-blue" />
                <span className="text-sm text-theme-secondary">Active</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="status" value="archived" checked={status === 'archived'}
                  onChange={() => setStatus('archived')} className="accent-gray-500" />
                <span className="text-sm text-theme-secondary">Archived</span>
              </label>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 px-6 py-5 border-t border-border/60 bg-surface-50/50">
          <button onClick={onClose} className="flex-1 btn-ghost">Cancel</button>
          <button onClick={handleSubmit} disabled={saving} className="flex-1 btn-primary inline-flex items-center justify-center gap-2">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Pencil className="w-4 h-4" />}
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Language / framework color helpers ──────────────────────────────────── */

const langColors: Record<string, string> = {
  typescript: 'bg-accent-blue/15 text-accent-blue border-accent-blue/30',
  javascript: 'bg-accent-yellow/15 text-accent-yellow border-accent-yellow/30',
  python: 'bg-accent-green/15 text-accent-green border-accent-green/30',
  rust: 'bg-accent-orange/15 text-accent-orange border-accent-orange/30',
  go: 'bg-accent-cyan/15 text-accent-cyan border-accent-cyan/30',
  java: 'bg-accent-red/15 text-accent-red border-accent-red/30',
};

const fwColors: Record<string, string> = {
  react: 'bg-accent-cyan/15 text-accent-cyan border-accent-cyan/30',
  express: 'bg-accent-green/15 text-accent-green border-accent-green/30',
  next: 'bg-surface-100/10 text-theme-primary border-border/30',
  vite: 'bg-accent-purple/15 text-accent-purple border-accent-purple/30',
  vue: 'bg-accent-green/15 text-accent-green border-accent-green/30',
  tailwind: 'bg-accent-cyan/15 text-accent-cyan border-accent-cyan/30',
};

function Badge({ label, colorClass }: { label: string; colorClass?: string }) {
  const cls = colorClass ?? 'bg-surface-200/60 text-theme-muted border-border/30';
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded-sm font-mono uppercase border ${cls}`}>
      {label}
    </span>
  );
}

/* ── Main Page ──────────────────────────────────────────────────────────── */

export default function RepoManagerPage() {
  const [repoList, setRepoList] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [editRepo, setEditRepo] = useState<Repo | null>(null);
  const [scanningId, setScanningId] = useState<string | null>(null);
  const [deletingRepo, setDeletingRepo] = useState<{ id: string; name: string } | null>(null);
  const [configRepoId, setConfigRepoId] = useState<string | null>(null);
  const [wsCreateRepo, setWsCreateRepo] = useState<Repo | null>(null);
  const [contextRepo, setContextRepo] = useState<Repo | null>(null);
  const navigate = useNavigate();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await repoApi.list();
      setRepoList(list);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleDelete = async () => {
    if (!deletingRepo) return;
    await repoApi.delete(deletingRepo.id);
    setDeletingRepo(null);
    refresh();
  };

  const toast = useToast();

  const handleScan = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setScanningId(id);
    try {
      const result = await repoApi.scan(id);
      const deepScan = (result as any)?.deepScan;
      if (deepScan?.scheduled) {
        toast.success('Deep scan started. Check Executions page for progress.');
      } else if (deepScan?.reason) {
        toast.info(`Scan: ${deepScan.reason}`);
      } else {
        toast.success('Scan complete.');
      }
      refresh();
    } catch (err: any) {
      toast.error(err.message ?? 'Scan failed');
    }
    setScanningId(null);
  };

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="font-heading text-xl font-bold text-theme-primary tracking-widest uppercase">Repositories</h1>
          <p className="text-xs text-theme-muted mt-1 font-body">{repoList.length} repo{repoList.length !== 1 ? 's' : ''} registered</p>
        </div>
        <div className="flex items-center gap-2">
          <button title="Refresh" onClick={refresh} className="btn-ghost text-xs"><RefreshCw className="w-3.5 h-3.5" /></button>
          <button onClick={() => setAddOpen(true)} className="btn-primary text-xs inline-flex items-center gap-1.5">
            <Plus className="w-3.5 h-3.5" /> Add Repo
          </button>
        </div>
      </div>

      {/* Loading */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="card p-6 animate-pulse">
              <div className="h-5 w-32 bg-surface-200 rounded-sm mb-3" />
              <div className="h-3 w-48 bg-surface-200 rounded-sm mb-4" />
              <div className="flex gap-2 mb-3">
                <div className="h-4 w-16 bg-surface-200 rounded-sm" />
                <div className="h-4 w-16 bg-surface-200 rounded-sm" />
              </div>
              <div className="h-3 w-full bg-surface-200 rounded-sm" />
            </div>
          ))}
        </div>
      ) : repoList.length === 0 ? (
        <div className="text-center py-12">
          <FolderGit2 className="w-10 h-10 text-theme-subtle mx-auto mb-3" />
          <p className="text-sm text-theme-muted font-body">No repositories yet. Add one to get started.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {repoList.map((repo) => {
            const isScanning = scanningId === repo._id;
            const isArchived = repo.status === 'archived';
            return (
              <div key={repo._id} className={`p-4 rounded-lg border border-border/20 bg-surface-100/20 hover:bg-surface-100/40 transition-colors group ${isArchived ? 'opacity-50' : ''}`}>
                <div className="flex items-center gap-3">
                  <FolderGit2 className="w-5 h-5 text-blue-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-heading font-semibold text-theme-primary">{repo.name}</span>
                      {isArchived && <span className="text-[10px] font-mono text-theme-subtle bg-surface-200/40 px-1.5 py-0.5 rounded border border-border/20">archived</span>}
                      {/* Badges */}
                      {repo.detected?.language?.filter(l => l !== 'unknown').map(lang => (
                        <Badge key={lang} label={lang} colorClass={langColors[lang]} />
                      ))}
                      {repo.detected?.framework?.map(fw => (
                        <Badge key={fw} label={fw} colorClass={fwColors[fw]} />
                      ))}
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-[10px] text-theme-muted font-mono">
                      <span className="truncate max-w-[300px]" title={repo.path}>{repo.path}</span>
                      <span className="flex items-center gap-1"><GitBranch className="w-3 h-3" />{repo.detected?.defaultBranch ?? 'main'}</span>
                      {repo.detected?.remoteUrl && (
                        <span className="flex items-center gap-1 truncate max-w-[200px]">
                          <ExternalLink className="w-3 h-3 shrink-0" />
                          {repo.detected.remoteUrl.replace(/^https?:\/\//, '').replace(/\.git$/, '')}
                        </span>
                      )}
                      {repo.executionCount > 0 && <span><Package className="w-3 h-3 inline mr-0.5" />{repo.executionCount} runs</span>}
                    </div>
                    {repo.description && <p className="text-[11px] text-theme-subtle mt-1 truncate">{repo.description}</p>}
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={(e) => { e.stopPropagation(); setContextRepo(repo); }} className="btn-ghost p-1.5 text-xs text-accent-blue" title="View Context">
                      <FileText className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); setWsCreateRepo(repo); }} className="btn-ghost p-1.5 text-xs text-emerald-400" title="New Workspace">
                      <Monitor className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={(e) => handleScan(e, repo._id)} disabled={isScanning} className="btn-ghost p-1.5 text-xs" title="Scan">
                      {isScanning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ScanSearch className="w-3.5 h-3.5" />}
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); setConfigRepoId(repo._id); }} className="btn-ghost p-1.5 text-xs" title="Workspace Config">
                      <Settings className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => setEditRepo(repo)} className="btn-ghost p-1.5 text-xs" title="Edit">
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); setDeletingRepo({ id: repo._id, name: repo.name }); }} className="btn-ghost p-1.5 text-xs text-red-400" title="Delete">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Dialogs */}
      <AddRepoDialog open={addOpen} onClose={() => setAddOpen(false)} onCreated={refresh} />
      <EditRepoDialog repo={editRepo} open={!!editRepo} onClose={() => setEditRepo(null)} onUpdated={refresh} />
      <DeleteConfirmDialog
        open={!!deletingRepo}
        resourceType="repo"
        resourceName={deletingRepo?.name ?? ''}
        onConfirm={handleDelete}
        onCancel={() => setDeletingRepo(null)}
      />
      {configRepoId && <WorkspaceConfigEditor repoId={configRepoId} onClose={() => setConfigRepoId(null)} />}
      {wsCreateRepo && <QuickWorkspaceDialog repo={wsCreateRepo} onClose={() => setWsCreateRepo(null)} onCreated={(id) => { setWsCreateRepo(null); navigate(`/workspaces/${id}`); }} />}
      {contextRepo && <RepoContextViewer repoId={contextRepo._id} repoName={contextRepo.name} onClose={() => setContextRepo(null)} />}
    </div>
  );
}

/* ── Repo Context Viewer ──────────────────────────────────────────────── */

function RepoContextViewer({ repoId, repoName, onClose }: { repoId: string; repoName: string; onClose: () => void }) {
  const [context, setContext] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [rescanning, setRescanning] = useState(false);
  const toast = useToast();

  useEffect(() => {
    setLoading(true);
    setError('');
    repoApi.context(repoId)
      .then((ctx) => setContext(ctx))
      .catch((err) => setError(err.message ?? 'Failed to load context'))
      .finally(() => setLoading(false));
  }, [repoId]);

  const handleRescan = async () => {
    setRescanning(true);
    try {
      await repoApi.rescanContext(repoId);
      toast.success('Deep scan started — this runs in the background and may take a few minutes.');
    } catch (err: any) {
      toast.error(err.message ?? 'Failed to start rescan');
    } finally {
      setRescanning(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md" onClick={onClose}>
      <div className="card w-full max-w-4xl max-h-[90vh] overflow-hidden shadow-glow-blue/20 animate-in fade-in zoom-in-95 duration-200 flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="px-6 py-4 border-b border-border/60 shrink-0 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <FileText className="w-5 h-5 text-accent-blue" />
            <div>
              <h2 className="font-heading text-sm font-bold text-theme-primary tracking-wider uppercase">Repo Context</h2>
              <p className="text-[10px] text-theme-muted font-mono">{repoName} — agent-generated codebase analysis</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={handleRescan} disabled={rescanning} className="btn-ghost text-xs inline-flex items-center gap-1" title="Trigger a fresh deep scan">
              {rescanning ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              Rescan
            </button>
            <button onClick={onClose} className="p-2 rounded-sm hover:bg-surface-200 text-theme-muted hover:text-theme-secondary transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {loading ? (
            <div className="text-xs text-theme-muted animate-pulse">Loading context...</div>
          ) : error ? (
            <div className="space-y-3">
              <div className="text-xs text-theme-muted">{error}</div>
              <p className="text-[11px] text-theme-subtle">
                No context available yet. Click "Rescan" to trigger a deep scan — the repo-scanner agent will explore the codebase and generate a comprehensive analysis. This runs in the background and typically takes 2-5 minutes.
              </p>
              <button onClick={handleRescan} disabled={rescanning} className="btn-primary text-xs inline-flex items-center gap-1.5">
                {rescanning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ScanSearch className="w-3.5 h-3.5" />}
                {rescanning ? 'Starting...' : 'Generate Context'}
              </button>
            </div>
          ) : context?.contextMarkdown ? (
            <div className="space-y-3">
              {/* Metadata bar */}
              <div className="flex items-center gap-4 text-[10px] text-theme-muted font-mono flex-wrap">
                {context.branch && <span>Branch: <span className="text-theme-secondary">{context.branch}</span></span>}
                {context.headSha && <span>SHA: <span className="text-theme-secondary">{context.headSha?.slice(0, 8)}</span></span>}
                {context.scannedAt && <span>Scanned: <span className="text-theme-secondary">{new Date(context.scannedAt).toLocaleString()}</span></span>}
                {context.scanDurationMs && <span>Duration: <span className="text-theme-secondary">{(context.scanDurationMs / 1000).toFixed(1)}s</span></span>}
                {context.scanCostUsd != null && <span>Cost: <span className="text-theme-secondary">${context.scanCostUsd.toFixed(4)}</span></span>}
              </div>
              {/* Rendered markdown */}
              <div className="prose-flowforge text-sm text-theme-secondary leading-relaxed">
                {renderMarkdown(context.contextMarkdown)}
              </div>
            </div>
          ) : (
            <div className="text-xs text-theme-muted">Context exists but is empty. Try rescanning.</div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-border/60 bg-surface-50/50 shrink-0">
          <button onClick={onClose} className="btn-ghost text-xs">Close</button>
        </div>
      </div>
    </div>
  );
}

function QuickWorkspaceDialog({ repo, onClose, onCreated }: { repo: Repo; onClose: () => void; onCreated: (id: string) => void }) {
  const [branch, setBranch] = useState('');
  const [baseBranch, setBaseBranch] = useState(repo.detected?.defaultBranch ?? 'main');
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState('');

  async function handleCreate() {
    if (!branch.trim() || !name.trim()) { setError('Branch and name required'); return; }
    setCreating(true); setError('');
    try {
      const ws = await wsApi.create({ repoId: repo._id, repoName: repo.name, repoPath: repo.path, branch: branch.trim(), baseBranch, name: name.trim() });
      setPendingId(ws._id);
    } catch (err: any) { setError(err.message); setCreating(false); }
  }

  if (pendingId) {
    return (
      <SetupProgressDialog
        workspaceId={pendingId}
        onComplete={(ws) => onCreated(ws._id)}
        onFailed={() => { setPendingId(null); setCreating(false); setError('Setup failed'); }}
      />
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-surface-100 border border-border/30 rounded-lg w-[440px] p-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-4">
          <Monitor className="w-4 h-4 text-emerald-400" />
          <span className="text-sm font-semibold text-theme-primary">New Workspace</span>
          <span className="text-[10px] font-mono text-theme-muted">{repo.name}</span>
        </div>
        {error && <div className="text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded px-3 py-1.5 mb-3">{error}</div>}
        <div className="space-y-3">
          <div>
            <label className="text-[10px] font-label uppercase tracking-wider text-theme-muted block mb-1">Workspace Name</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="feature/my-feature" className="input w-full text-xs" autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] font-label uppercase tracking-wider text-theme-muted block mb-1">Branch</label>
              <input value={branch} onChange={e => setBranch(e.target.value)} placeholder="feature/new-thing" className="input w-full text-xs" />
            </div>
            <div>
              <label className="text-[10px] font-label uppercase tracking-wider text-theme-muted block mb-1">Base Branch</label>
              <input value={baseBranch} onChange={e => setBaseBranch(e.target.value)} className="input w-full text-xs" />
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="btn-ghost text-xs">Cancel</button>
          <button onClick={handleCreate} disabled={creating} className="btn-primary text-xs disabled:opacity-50">
            {creating ? 'Creating...' : 'Create Workspace'}
          </button>
        </div>
      </div>
    </div>
  );
}
