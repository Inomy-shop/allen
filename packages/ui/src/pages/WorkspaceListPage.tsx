import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { workspaces } from '../services/workspaceService';
import { repos as repoApi } from '../services/api';
import { Plus, RefreshCw, GitBranch, Trash2, Terminal, FileCode, ExternalLink, Loader2, Settings, FolderGit2 } from 'lucide-react';
import DeleteConfirmDialog from '../components/common/DeleteConfirmDialog';
import { WorkspaceConfigEditor } from '../components/workspace/WorkspaceConfigEditor';
import { SetupProgressDialog } from '../components/workspace/SetupProgressDialog';

export default function WorkspaceListPage() {
  const [list, setList] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [repos, setRepos] = useState<any[]>([]);
  const [form, setForm] = useState({ repoId: '', repoPath: '', repoName: '', branch: '', baseBranch: 'main', name: '' });
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkArchiving, setBulkArchiving] = useState(false);
  const [configRepoId, setConfigRepoId] = useState<string | null>(null);
  const [pendingWsId, setPendingWsId] = useState<string | null>(null);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    setLoading(true);
    try { setList(await workspaces.list()); } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { repoApi.list().then(setRepos).catch(() => {}); }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!form.repoId || !form.branch || !form.name) return;
    try {
      const ws = await workspaces.create(form);
      setCreating(false);
      setPendingWsId(ws._id);
    } catch (err: any) { alert(err.message); }
  }

  async function handleDelete() {
    if (!deleting) return;
    try { await workspaces.archive(deleting.id); setDeleting(null); load(); } catch {}
  }

  async function handleBulkArchive() {
    if (selected.size === 0) return;
    setBulkArchiving(true);
    try { await workspaces.bulkArchive(Array.from(selected)); setSelected(new Set()); load(); } catch {}
    setBulkArchiving(false);
  }

  function toggleSelect(id: string) {
    setSelected(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  }

  function selectRepo(repoId: string) {
    const repo = repos.find(r => r._id === repoId);
    setForm(f => ({ ...f, repoId, repoPath: repo?.path ?? '', repoName: repo?.name ?? '' }));
  }

  const statusColors: Record<string, string> = {
    creating: 'text-accent-yellow bg-accent-yellow/10 border-accent-yellow/20',
    setting_up: 'text-accent-yellow bg-accent-yellow/10 border-accent-yellow/20',
    active: 'text-accent-green bg-accent-green/10 border-accent-green/20',
    running: 'text-accent-blue bg-accent-blue/10 border-accent-blue/20',
    archiving: 'text-theme-secondary bg-gray-400/10 border-gray-400/20',
    failed: 'text-red-400 bg-red-400/10 border-red-400/20',
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="font-heading text-xl font-bold text-theme-primary tracking-widest uppercase">Workspaces</h1>
          <p className="text-xs text-theme-muted mt-1 font-body">{list.length} active workspace{list.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="flex items-center gap-2">
          {selected.size > 0 && (
            <button onClick={handleBulkArchive} disabled={bulkArchiving} className="btn-ghost text-xs text-red-400 flex items-center gap-1 disabled:opacity-50">
              <Trash2 className="w-3.5 h-3.5" /> Archive {selected.size}
            </button>
          )}
          <button onClick={load} className="btn-ghost text-xs" title="Refresh"><RefreshCw className="w-3.5 h-3.5" /></button>
          <button onClick={() => setCreating(!creating)} className="btn-primary text-xs inline-flex items-center gap-1.5">
            <Plus className="w-3.5 h-3.5" /> New Workspace
          </button>
        </div>
      </div>

      {/* Create form */}
      {creating && (
        <form onSubmit={handleCreate} className="mb-6 p-4 rounded-lg border border-border/20 bg-surface-100/30 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] font-label uppercase tracking-wider text-theme-muted block mb-1">Repository</label>
              <select value={form.repoId} onChange={e => selectRepo(e.target.value)} className="input w-full text-xs">
                <option value="">Select repo...</option>
                {repos.map(r => <option key={r._id} value={r._id}>{r.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[10px] font-label uppercase tracking-wider text-theme-muted block mb-1">Workspace Name</label>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="feature/light-theme" className="input w-full text-xs" />
            </div>
            <div>
              <label className="text-[10px] font-label uppercase tracking-wider text-theme-muted block mb-1">Branch Name</label>
              <input value={form.branch} onChange={e => setForm(f => ({ ...f, branch: e.target.value }))} placeholder="feature/my-feature" className="input w-full text-xs" />
            </div>
            <div>
              <label className="text-[10px] font-label uppercase tracking-wider text-theme-muted block mb-1">Base Branch</label>
              <input value={form.baseBranch} onChange={e => setForm(f => ({ ...f, baseBranch: e.target.value }))} placeholder="main" className="input w-full text-xs" />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            {form.repoId && (
              <button type="button" onClick={() => setConfigRepoId(form.repoId)} className="btn-ghost text-xs flex items-center gap-1">
                <Settings className="w-3 h-3" /> Configure Workspace
              </button>
            )}
            <button type="button" onClick={() => setCreating(false)} className="btn-ghost text-xs">Cancel</button>
            <button type="submit" className="btn-primary text-xs">Create Workspace</button>
          </div>
        </form>
      )}

      {/* Workspace list — grouped by repo */}
      {loading ? (
        <div className="flex items-center justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-theme-muted" /></div>
      ) : list.length === 0 ? (
        <div className="text-center py-12">
          <GitBranch className="w-10 h-10 text-theme-subtle mx-auto mb-3" />
          <p className="text-sm text-theme-muted font-body">No workspaces yet. Create one to get started.</p>
        </div>
      ) : (() => {
        // Group workspaces by repoId
        const grouped = new Map<string, { repoName: string; repoId: string; workspaces: any[] }>();
        for (const ws of list) {
          const key = ws.repoId ?? 'unknown';
          if (!grouped.has(key)) grouped.set(key, { repoName: ws.repoName || 'Unknown Repo', repoId: key, workspaces: [] });
          grouped.get(key)!.workspaces.push(ws);
        }
        return (
          <div className="space-y-6">
            {Array.from(grouped.values()).map(group => (
              <div key={group.repoId}>
                {/* Repo header */}
                <div className="flex items-center gap-2 mb-2 px-1">
                  <FolderGit2 className="w-4 h-4 text-blue-400" />
                  <span className="text-xs font-heading font-semibold text-theme-secondary uppercase tracking-wider">{group.repoName}</span>
                  <span className="text-[10px] text-theme-subtle font-mono">{group.workspaces.length} workspace{group.workspaces.length !== 1 ? 's' : ''}</span>
                  <span className="flex-1" />
                  <button onClick={() => setConfigRepoId(group.repoId)} className="text-[10px] text-theme-subtle hover:text-theme-secondary flex items-center gap-1">
                    <Settings className="w-3 h-3" /> Config
                  </button>
                </div>

                {/* Workspace cards */}
                <div className="space-y-2 pl-6 border-l-2 border-blue-500/10 ml-2">
                  {group.workspaces.map((ws: any) => (
                    <div key={ws._id} className="p-3 rounded-lg border border-border/20 bg-surface-100/20 hover:bg-surface-100/40 transition-colors group">
                      <div className="flex items-center gap-3">
                        <input type="checkbox" checked={selected.has(ws._id)} onChange={() => toggleSelect(ws._id)} className="rounded border-border/30 bg-surface-50 shrink-0" onClick={e => e.stopPropagation()} />
                        <GitBranch className="w-4 h-4 text-emerald-400 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <Link to={`/workspaces/${ws._id}`} className="text-sm font-heading font-semibold text-theme-primary hover:text-blue-400 transition-colors">{ws.name}</Link>
                            <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${statusColors[ws.status] ?? 'text-theme-secondary'}`}>{ws.status}</span>
                            {ws.source === 'pr' && <span className="text-[10px] font-mono text-purple-400 bg-purple-400/10 px-1.5 py-0.5 rounded border border-purple-400/20">PR #{ws.prNumber}</span>}
                          </div>
                          <div className="flex items-center gap-3 mt-1 text-[10px] text-theme-muted font-mono">
                            <span>{ws.branch} → {ws.baseBranch}</span>
                            {ws.changedFiles > 0 && <span className="text-amber-400">{ws.changedFiles} changed</span>}
                            {ws.services?.some((s: any) => s.status === 'ready') && <span className="text-emerald-400">● services</span>}
                            {ws.basePort && <span className="text-theme-subtle">port {ws.basePort}</span>}
                          </div>
                        </div>
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <Link to={`/workspaces/${ws._id}`} className="btn-ghost p-1.5 text-xs" title="Open"><Terminal className="w-3.5 h-3.5" /></Link>
                          <Link to={`/workspaces/${ws._id}?tab=diff`} className="btn-ghost p-1.5 text-xs" title="Diff"><FileCode className="w-3.5 h-3.5" /></Link>
                          <button onClick={() => setDeleting({ id: ws._id, name: ws.name })} className="btn-ghost p-1.5 text-xs text-red-400" title="Archive"><Trash2 className="w-3.5 h-3.5" /></button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        );
      })()}

      <DeleteConfirmDialog open={!!deleting} resourceType="workspace" resourceName={deleting?.name ?? ''} onConfirm={handleDelete} onCancel={() => setDeleting(null)} />
      {configRepoId && <WorkspaceConfigEditor repoId={configRepoId} onClose={() => setConfigRepoId(null)} />}
      {pendingWsId && (
        <SetupProgressDialog
          workspaceId={pendingWsId}
          onComplete={(ws) => { setPendingWsId(null); navigate(`/workspaces/${ws._id}`); }}
          onFailed={() => { setPendingWsId(null); load(); }}
        />
      )}
    </div>
  );
}
