import { useState, useEffect, useCallback } from 'react';
import { repos as repoApi, workflows as wfApi } from '../services/api';
import DeleteConfirmDialog from '../components/common/DeleteConfirmDialog';
import {
  FolderGit2, Plus, RefreshCw, Trash2, Pencil, ScanSearch, X,
  GitBranch, Package, Code2, Sparkles, ExternalLink, Loader2, Settings, Monitor, FileText, Download,
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
      <div className="card w-full max-w-lg overflow-hidden shadow-popover animate-in fade-in zoom-in-95 duration-200">
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
            <p className="text-[10px] text-theme-muted mt-1">HTTPS or SSH URL. Clones via SSH into the Allen repositories directory (default: ~/.allen/repositories/&lt;repo-name&gt;).</p>
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
      <div className="card w-full max-w-lg overflow-hidden shadow-popover animate-in fade-in zoom-in-95 duration-200">
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

// v2 single-accent rule: language/framework chips render as monochrome
// muted chips. Distinguishing color is reserved for run-state pills.
const langColors: Record<string, string> = {};
const fwColors: Record<string, string> = {};

function Badge({ label, colorClass }: { label: string; colorClass?: string }) {
  // colorClass arg kept for callers but the v2 chip is always neutral.
  void colorClass;
  return (
    <span className="text-[10.5px] px-1.5 py-0.5 rounded font-mono bg-app-muted text-theme-secondary">
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
  const [pullingId, setPullingId] = useState<string | null>(null);
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

  const handlePull = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setPullingId(id);
    try {
      const result = await repoApi.pull(id, true);
      if (result.updated) {
        toast.success(`Pulled ${result.commits.length} new commit${result.commits.length !== 1 ? 's' : ''} on ${result.branch}. Rescan started.`);
      } else {
        toast.info(`Already up to date on ${result.branch}.`);
      }
      refresh();
    } catch (err: any) {
      toast.error(err.message ?? 'Pull failed');
    }
    setPullingId(null);
  };

  return (
    <div className="px-6 pt-5 pb-8">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 mb-2 text-[12px] text-theme-muted">
        <span>Code</span>
        <span className="text-theme-subtle">/</span>
        <span>Repositories</span>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <h1 className="text-[20px] font-semibold text-theme-primary tracking-tight">Repositories</h1>
          <span className="text-[12px] font-mono text-theme-muted">{repoList.length}</span>
        </div>
        <div className="flex items-center gap-2">
          <button title="Refresh" onClick={refresh} className="btn btn-secondary btn-sm">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => setAddOpen(true)} className="btn btn-primary btn-sm">
            <Plus className="w-3.5 h-3.5" /> Add repo
          </button>
        </div>
      </div>

      {/* Loading */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="card p-4 animate-pulse">
              <div className="h-5 w-32 bg-app-muted rounded mb-3" />
              <div className="h-3 w-48 bg-app-muted rounded mb-4" />
              <div className="flex gap-2 mb-3">
                <div className="h-4 w-16 bg-app-muted rounded" />
                <div className="h-4 w-16 bg-app-muted rounded" />
              </div>
              <div className="h-3 w-full bg-app-muted rounded" />
            </div>
          ))}
        </div>
      ) : repoList.length === 0 ? (
        <div className="text-center py-16">
          <div className="w-14 h-14 rounded-xl bg-accent-soft flex items-center justify-center mx-auto mb-5">
            <FolderGit2 className="w-6 h-6 text-accent" />
          </div>
          <p className="text-[14px] text-theme-primary font-body mb-1">No repositories yet</p>
          <p className="text-[12px] text-theme-muted font-body mb-6">Add one to get started.</p>
          <button onClick={() => setAddOpen(true)} className="btn btn-primary">
            <Plus className="w-3.5 h-3.5" /> Add repository
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {repoList.map((repo) => {
            const isScanning = scanningId === repo._id;
            const isArchived = repo.status === 'archived';
            return (
              <div key={repo._id} className={`card-hover p-4 group flex flex-col gap-2 ${isArchived ? 'opacity-50' : ''}`}>
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-md bg-app-muted flex items-center justify-center shrink-0">
                    <FolderGit2 className="w-4 h-4 text-accent" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[14px] font-medium text-theme-primary truncate">{repo.name}</span>
                      {isArchived && <span className="badge badge-muted">archived</span>}
                      {repo.executionCount > 0 && (
                        <span className="text-[11px] font-mono text-theme-muted">· {repo.executionCount} runs</span>
                      )}
                    </div>
                    {repo.description && (
                      <p className="text-[12px] text-theme-muted mt-0.5 truncate">{repo.description}</p>
                    )}
                  </div>
                  <span className="dot dot-ok shrink-0 mt-1" />
                </div>

                {/* Tags row */}
                {(repo.detected?.language?.length || repo.detected?.framework?.length) ? (
                  <div className="flex items-center gap-1.5 flex-wrap pl-11">
                    {repo.detected?.language?.filter(l => l !== 'unknown').map(lang => (
                      <Badge key={lang} label={lang} colorClass={langColors[lang]} />
                    ))}
                    {repo.detected?.framework?.map(fw => (
                      <Badge key={fw} label={fw} colorClass={fwColors[fw]} />
                    ))}
                  </div>
                ) : null}

                {/* Meta row */}
                <div className="flex items-center gap-3 text-[11px] text-theme-muted font-mono pl-11 flex-wrap">
                  <span className="flex items-center gap-1">
                    <GitBranch className="w-3 h-3" />{repo.detected?.defaultBranch ?? 'main'}
                  </span>
                  {repo.detected?.remoteUrl && (() => {
                    const sshMatch = repo.detected.remoteUrl.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
                    const httpsUrl = sshMatch ? `https://${sshMatch[1]}/${sshMatch[2]}` : repo.detected.remoteUrl.replace(/\.git$/, '');
                    const display = repo.detected.remoteUrl.replace(/^git@([^:]+):/, '$1/').replace(/^https?:\/\//, '').replace(/\.git$/, '');
                    return (
                      <a href={httpsUrl} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} className="flex items-center gap-1 truncate max-w-[260px] hover:text-accent transition-colors">
                        <ExternalLink className="w-3 h-3 shrink-0" />
                        {display}
                      </a>
                    );
                  })()}
                </div>

                {/* Actions row — always visible, ghost icons */}
                <div className="flex items-center gap-0.5 pl-11 -ml-1 mt-auto">
                  <button onClick={(e) => { e.stopPropagation(); setContextRepo(repo); }} className="p-1.5 rounded text-theme-muted hover:text-accent hover:bg-app-muted transition-colors" title="View Context">
                    <FileText className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); setWsCreateRepo(repo); }} className="p-1.5 rounded text-theme-muted hover:text-accent-green hover:bg-app-muted transition-colors" title="New Workspace">
                    <Monitor className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={(e) => handlePull(e, repo._id)} disabled={pullingId === repo._id} className="p-1.5 rounded text-theme-muted hover:text-theme-primary hover:bg-app-muted transition-colors" title="Pull Latest">
                    {pullingId === repo._id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                  </button>
                  <button onClick={(e) => handleScan(e, repo._id)} disabled={isScanning} className="p-1.5 rounded text-theme-muted hover:text-theme-primary hover:bg-app-muted transition-colors" title="Scan">
                    {isScanning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ScanSearch className="w-3.5 h-3.5" />}
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); setConfigRepoId(repo._id); }} className="p-1.5 rounded text-theme-muted hover:text-theme-primary hover:bg-app-muted transition-colors" title="Workspace Config">
                    <Settings className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => setEditRepo(repo)} className="p-1.5 rounded text-theme-muted hover:text-theme-primary hover:bg-app-muted transition-colors" title="Edit">
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); setDeletingRepo({ id: repo._id, name: repo.name }); }} className="p-1.5 rounded text-theme-muted hover:text-accent-red hover:bg-accent-red/10 transition-colors ml-auto" title="Delete">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
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
      <div className="card w-full max-w-4xl max-h-[90vh] overflow-hidden shadow-popover animate-in fade-in zoom-in-95 duration-200 flex flex-col" onClick={e => e.stopPropagation()}>
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
              <div className="prose-allen text-sm text-theme-secondary leading-relaxed">
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
