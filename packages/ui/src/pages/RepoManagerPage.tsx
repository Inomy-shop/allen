import { useState, useEffect, useCallback } from 'react';
import { repos as repoApi, workflows as wfApi } from '../services/api';
import DeleteConfirmDialog from '../components/common/DeleteConfirmDialog';
import {
  FolderGit2, Plus, RefreshCw, Trash2, Pencil, ScanSearch, X,
  GitBranch, Package, Code2, Sparkles, ExternalLink, Loader2,
} from 'lucide-react';

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
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    if (!path.trim()) { setError('Path is required'); return; }
    setSaving(true);
    setError('');
    try {
      await repoApi.create({
        path: path.trim(),
        name: name.trim() || undefined,
        description: description.trim() || undefined,
        tags: tags.trim() ? tags.split(',').map(t => t.trim()).filter(Boolean) : [],
      });
      setPath(''); setName(''); setDescription(''); setTags('');
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
                <h2 className="font-heading text-sm font-bold text-white tracking-wider uppercase">Add Repository</h2>
                <p className="text-[11px] text-gray-500 font-mono">Auto-detects language, framework, and more</p>
              </div>
            </div>
            <button onClick={onClose} className="p-2 rounded-sm hover:bg-surface-200 text-gray-500 hover:text-gray-300 transition-colors">
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
            <label className="flex items-center gap-1 text-xs font-label font-semibold text-gray-400 mb-2 uppercase tracking-widest">
              Path <span className="text-accent-red normal-case text-[10px]">*</span>
            </label>
            <input type="text" value={path} onChange={e => setPath(e.target.value)}
              placeholder="/path/to/your/project" className="input w-full font-mono text-sm" />
          </div>
          <div>
            <label className="text-xs font-label font-semibold text-gray-400 mb-2 uppercase tracking-widest block">Name</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)}
              placeholder="Auto-derived from directory name" className="input w-full text-sm" />
          </div>
          <div>
            <label className="text-xs font-label font-semibold text-gray-400 mb-2 uppercase tracking-widest block">Description</label>
            <input type="text" value={description} onChange={e => setDescription(e.target.value)}
              placeholder="Brief description" className="input w-full text-sm" />
          </div>
          <div>
            <label className="text-xs font-label font-semibold text-gray-400 mb-2 uppercase tracking-widest block">Tags</label>
            <input type="text" value={tags} onChange={e => setTags(e.target.value)}
              placeholder="Comma-separated, e.g. backend, api" className="input w-full text-sm font-mono" />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center gap-3 px-6 py-5 border-t border-border/60 bg-surface-50/50">
          <button onClick={onClose} className="flex-1 btn-ghost">Cancel</button>
          <button onClick={handleSubmit} disabled={saving} className="flex-1 btn-primary inline-flex items-center justify-center gap-2">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            {saving ? 'Adding...' : 'Add Repo'}
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
                <h2 className="font-heading text-sm font-bold text-white tracking-wider uppercase">Edit Repository</h2>
                <p className="text-[11px] text-gray-500 font-mono">{repo.path}</p>
              </div>
            </div>
            <button onClick={onClose} className="p-2 rounded-sm hover:bg-surface-200 text-gray-500 hover:text-gray-300 transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="px-6 py-5 space-y-4 max-h-[50vh] overflow-auto">
          {error && (
            <div className="text-xs text-accent-red bg-accent-red/10 border border-accent-red/20 rounded-sm px-3 py-2">{error}</div>
          )}
          <div>
            <label className="text-xs font-label font-semibold text-gray-400 mb-2 uppercase tracking-widest block">Name</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)} className="input w-full text-sm" />
          </div>
          <div>
            <label className="text-xs font-label font-semibold text-gray-400 mb-2 uppercase tracking-widest block">Description</label>
            <input type="text" value={description} onChange={e => setDescription(e.target.value)} className="input w-full text-sm" />
          </div>
          <div>
            <label className="text-xs font-label font-semibold text-gray-400 mb-2 uppercase tracking-widest block">Tags</label>
            <input type="text" value={tags} onChange={e => setTags(e.target.value)}
              placeholder="Comma-separated" className="input w-full text-sm font-mono" />
          </div>
          <div>
            <label className="text-xs font-label font-semibold text-gray-400 mb-2 uppercase tracking-widest block">Context</label>
            <textarea value={context} onChange={e => setContext(e.target.value)}
              rows={3} className="input w-full text-sm resize-none" placeholder="Brief context for chat agent" />
          </div>
          <div>
            <label className="text-xs font-label font-semibold text-gray-400 mb-2 uppercase tracking-widest block">Default Workflow</label>
            <select value={defaultWorkflow} onChange={e => setDefaultWorkflow(e.target.value)} className="input w-full text-sm">
              <option value="">None</option>
              {workflows.map((wf: any) => (
                <option key={wf._id} value={wf.name}>{wf.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-label font-semibold text-gray-400 mb-2 uppercase tracking-widest block">Status</label>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="status" value="active" checked={status === 'active'}
                  onChange={() => setStatus('active')} className="accent-accent-blue" />
                <span className="text-sm text-gray-300">Active</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="status" value="archived" checked={status === 'archived'}
                  onChange={() => setStatus('archived')} className="accent-gray-500" />
                <span className="text-sm text-gray-300">Archived</span>
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
  next: 'bg-white/10 text-white border-white/20',
  vite: 'bg-accent-purple/15 text-accent-purple border-accent-purple/30',
  vue: 'bg-accent-green/15 text-accent-green border-accent-green/30',
  tailwind: 'bg-accent-cyan/15 text-accent-cyan border-accent-cyan/30',
};

function Badge({ label, colorClass }: { label: string; colorClass?: string }) {
  const cls = colorClass ?? 'bg-surface-200/60 text-gray-500 border-border/30';
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

  const handleScan = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setScanningId(id);
    try {
      await repoApi.scan(id);
      refresh();
    } catch (err: any) {
      alert(err.message);
    }
    setScanningId(null);
  };

  return (
    <div className="p-8">
      {/* Header */}
      <div className="flex items-end justify-between mb-8">
        <div>
          <h1 className="font-heading text-2xl font-bold text-white tracking-widest uppercase">Repositories</h1>
          <p className="text-sm text-gray-500 mt-1 font-mono">
            {repoList.length} repo{repoList.length !== 1 ? 's' : ''} registered
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={refresh} className="p-2 rounded-sm text-gray-500 hover:text-accent-blue hover:bg-accent-blue/5 transition-all">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button onClick={() => setAddOpen(true)} className="btn-primary inline-flex items-center gap-2">
            <Plus className="w-4 h-4" /> Add Repo
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
        /* Empty state */
        <div className="flex flex-col items-center justify-center py-20">
          <div className="w-20 h-20 rounded-sm bg-surface-200 flex items-center justify-center mb-6 border border-accent-blue/20 shadow-glow-blue/20">
            <Sparkles className="w-9 h-9 text-accent-blue/50" />
          </div>
          <h2 className="font-heading text-lg font-semibold text-white mb-2 tracking-wider uppercase">No repos yet</h2>
          <p className="text-sm text-gray-500 mb-8 max-w-sm text-center font-body">
            Register your first repository to enable auto-detection of language, framework, and smart workflow defaults.
          </p>
          <button onClick={() => setAddOpen(true)} className="btn-primary inline-flex items-center gap-2 px-5 py-3">
            <Plus className="w-4 h-4" /> Add Your First Repo
          </button>
        </div>
      ) : (
        /* Card grid */
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {repoList.map((repo) => {
            const isScanning = scanningId === repo._id;
            const isArchived = repo.status === 'archived';

            return (
              <div
                key={repo._id}
                className={`group relative overflow-hidden card hover:shadow-glow-blue/10 hover:border-accent-blue/30 transition-all duration-300 ${isArchived ? 'opacity-60' : ''}`}
              >
                <div className="h-0.5 bg-gradient-to-r from-accent-blue via-accent-cyan to-accent-green" />

                <div className="p-4 flex gap-4">
                  {/* Icon */}
                  <div className="shrink-0 flex flex-col items-center gap-1.5">
                    <div className="w-10 h-10 rounded-sm flex items-center justify-center border bg-accent-blue/10 border-accent-blue/30">
                      <FolderGit2 className="w-5 h-5 text-accent-blue" />
                    </div>
                    {isArchived && (
                      <span className="text-[9px] text-gray-600 font-mono uppercase">archived</span>
                    )}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    {/* Name */}
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-heading font-semibold text-white truncate tracking-wider flex-1">{repo.name}</h3>
                      <button onClick={(e) => { e.stopPropagation(); setDeletingRepo({ id: repo._id, name: repo.name }); }}
                        className="opacity-0 group-hover:opacity-100 p-0.5 rounded-sm text-gray-600 hover:text-accent-red transition-all shrink-0">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    {/* Path */}
                    <p className="text-[11px] text-gray-500 font-mono truncate mt-0.5" title={repo.path}>{repo.path}</p>

                    {/* Description */}
                    {repo.description && (
                      <p className="text-xs text-gray-400 font-body truncate mt-1">{repo.description}</p>
                    )}

                    {/* Language + framework badges */}
                    <div className="flex flex-wrap gap-1.5 mt-2.5">
                      {repo.detected?.language?.filter(l => l !== 'unknown').map(lang => (
                        <Badge key={lang} label={lang} colorClass={langColors[lang]} />
                      ))}
                      {repo.detected?.framework?.map(fw => (
                        <Badge key={fw} label={fw} colorClass={fwColors[fw]} />
                      ))}
                      {repo.detected?.packageManager && repo.detected.packageManager !== 'unknown' && (
                        <Badge label={repo.detected.packageManager} />
                      )}
                    </div>

                    {/* Tags */}
                    {repo.tags?.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {repo.tags.map(tag => (
                          <span key={tag} className="text-[10px] px-1.5 py-0.5 bg-surface-200/60 text-gray-500 rounded-sm font-mono uppercase border border-border/30">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Branch + remote */}
                    <div className="flex items-center gap-4 mt-2.5 text-[11px] text-gray-600 font-mono">
                      <span className="inline-flex items-center gap-1">
                        <GitBranch className="w-3 h-3" /> {repo.detected?.defaultBranch ?? 'main'}
                      </span>
                      {repo.detected?.remoteUrl && (
                        <span className="inline-flex items-center gap-1 truncate" title={repo.detected.remoteUrl}>
                          <ExternalLink className="w-3 h-3 shrink-0" />
                          <span className="truncate max-w-[140px]">{repo.detected.remoteUrl.replace(/^https?:\/\//, '').replace(/\.git$/, '')}</span>
                        </span>
                      )}
                    </div>

                    {/* Stats row */}
                    <div className="flex items-center gap-4 mt-2.5 font-mono text-xs text-gray-400">
                      <span><Package className="w-3 h-3 inline mr-1 text-accent-blue/60" />{repo.executionCount} runs</span>
                      {repo.lastUsedAt && (
                        <span className="text-[10px] text-gray-600">
                          last used {new Date(repo.lastUsedAt).toLocaleDateString()}
                        </span>
                      )}
                    </div>

                    {/* Context preview */}
                    {repo.context && (
                      <p className="text-[11px] text-gray-600 mt-2 truncate italic" title={repo.context}>
                        {repo.context.slice(0, 100)}{repo.context.length > 100 ? '...' : ''}
                      </p>
                    )}

                    {/* Actions */}
                    <div className="flex items-center gap-2 mt-3">
                      <div className="flex-1" />
                      <button onClick={(e) => handleScan(e, repo._id)} disabled={isScanning}
                        className="btn-ghost inline-flex items-center gap-1 text-xs px-3 py-1">
                        {isScanning
                          ? <><Loader2 className="w-3 h-3 animate-spin" /> Scanning</>
                          : <><ScanSearch className="w-3 h-3" /> Scan</>
                        }
                      </button>
                      <button onClick={() => setEditRepo(repo)}
                        className="btn-ghost inline-flex items-center gap-1 text-xs px-3 py-1">
                        <Pencil className="w-3 h-3" /> Edit
                      </button>
                    </div>
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
    </div>
  );
}
