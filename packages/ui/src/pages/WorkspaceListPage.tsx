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
  // Inline-expand: only one workspace expanded at a time (matches v2 ref)
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Top tabs: All / Mine / With PRs
  type Tab = 'all' | 'mine' | 'prs';
  const [tab, setTab] = useState<Tab>('all');
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

  // Map workspace status → v2 .badge class (soft tints, mono font)
  const statusBadge: Record<string, string> = {
    creating: 'badge-warn',
    setting_up: 'badge-warn',
    active: 'badge-ok',
    running: 'badge-info',
    archiving: 'badge-muted',
    failed: 'badge-err',
  };

  return (
    <div className="px-6 pt-5 pb-8">
      <div className="flex items-center gap-2 mb-2 text-[12px] text-theme-muted">
        <span>Code</span>
        <span className="text-theme-subtle">/</span>
        <span>Sandboxes</span>
      </div>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <h1 className="text-[20px] font-semibold text-theme-primary tracking-tight">Sandboxes</h1>
          <span className="text-[12px] font-mono text-theme-muted">{list.length}</span>
        </div>
        <div className="flex items-center gap-2">
          {selected.size > 0 && (
            <button onClick={handleBulkArchive} disabled={bulkArchiving} className="btn btn-secondary btn-sm hover:text-accent-red flex items-center gap-1 disabled:opacity-50">
              <Trash2 className="w-3.5 h-3.5" /> Archive {selected.size}
            </button>
          )}
          <button onClick={load} className="btn btn-secondary btn-sm" title="Refresh"><RefreshCw className="w-3.5 h-3.5" /></button>
          <button onClick={() => setCreating(!creating)} className="btn btn-primary btn-sm">
            <Plus className="w-3.5 h-3.5" /> New sandbox
          </button>
        </div>
      </div>

      {/* Tab row (matches handoff/pages/remaining.jsx WorkspacesV2) */}
      <div className="flex items-center gap-1 mb-5 border-b border-app">
        {([
          { id: 'all', label: 'All', count: list.length },
          { id: 'mine', label: 'Mine' },
          { id: 'prs', label: 'With PRs', count: list.filter((w: any) => w.source === 'pr').length },
        ] as { id: Tab; label: string; count?: number }[]).map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-2.5 py-1.5 text-[13px] -mb-px transition-colors flex items-center gap-1.5 border-b-2 ${
              tab === t.id
                ? 'text-theme-primary font-medium border-accent'
                : 'text-theme-muted hover:text-theme-primary border-transparent'
            }`}
          >
            {t.label}
            {t.count != null && <span className="text-[11px] text-theme-muted font-mono">{t.count}</span>}
          </button>
        ))}
      </div>

      {/* Create form */}
      {creating && (
        <form onSubmit={handleCreate} className="mb-6 p-4 rounded-lg border border-app bg-app-muted/40 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="overline block mb-1">Repository</label>
              <select value={form.repoId} onChange={e => selectRepo(e.target.value)} className="input w-full text-xs">
                <option value="">Select repo...</option>
                {repos.map(r => <option key={r._id} value={r._id}>{r.name}</option>)}
              </select>
            </div>
            <div>
              <label className="overline block mb-1">Workspace Name</label>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="feature/light-theme" className="input w-full text-xs" />
            </div>
            <div>
              <label className="overline block mb-1">Branch Name</label>
              <input value={form.branch} onChange={e => setForm(f => ({ ...f, branch: e.target.value }))} placeholder="feature/my-feature" className="input w-full text-xs" />
            </div>
            <div>
              <label className="overline block mb-1">Base Branch</label>
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
        // Apply tab filter first
        const filtered = list.filter((ws: any) => {
          if (tab === 'prs') return ws.source === 'pr';
          // 'mine' is a no-op until we have current-user attribution
          return true;
        });

        // Group by repoId
        const grouped = new Map<string, { repoName: string; repoId: string; workspaces: any[] }>();
        for (const ws of filtered) {
          const key = ws.repoId ?? 'unknown';
          if (!grouped.has(key)) grouped.set(key, { repoName: ws.repoName || 'Unknown Repo', repoId: key, workspaces: [] });
          grouped.get(key)!.workspaces.push(ws);
        }
        return (
          <div className="space-y-5">
            {Array.from(grouped.values()).map(group => (
              <div key={group.repoId}>
                {/* Repo header — 13px/600 with accent icon, matches v2 reference */}
                <div className="flex items-center gap-2 mb-2.5 px-1">
                  <FolderGit2 className="w-4 h-4 text-accent" />
                  <span className="text-[13px] font-semibold text-theme-primary">{group.repoName}</span>
                  <span className="text-[11px] text-theme-muted font-body">· {group.workspaces.length} sandbox{group.workspaces.length !== 1 ? 'es' : ''}</span>
                  <span className="flex-1" />
                  <button onClick={() => setConfigRepoId(group.repoId)} className="text-[11px] text-theme-muted hover:text-theme-primary flex items-center gap-1">
                    <Settings className="w-3 h-3" /> Config
                  </button>
                </div>

                {/* Inline-expand single-column list (matches handoff/pages/remaining.jsx WorkspacesV2) */}
                <div className="flex flex-col gap-2">
                  {group.workspaces.map((ws: any) => {
                    const isOpen = expandedId === ws._id;
                    return (
                      <div
                        key={ws._id}
                        className={`card overflow-hidden transition-shadow ${isOpen ? 'shadow-sm' : ''}`}
                      >
                        {/* Row header — clickable to expand */}
                        <div
                          onClick={() => setExpandedId(isOpen ? null : ws._id)}
                          className="px-3.5 py-3 flex items-center gap-3 cursor-pointer hover:bg-app-muted/40 transition-colors"
                        >
                          <input
                            type="checkbox"
                            checked={selected.has(ws._id)}
                            onChange={() => toggleSelect(ws._id)}
                            onClick={e => e.stopPropagation()}
                            className="shrink-0"
                          />
                          <span className={`text-theme-muted text-[10px] transition-transform shrink-0 ${isOpen ? 'rotate-90' : ''}`}>▶</span>
                          <FolderGit2 className="w-3.5 h-3.5 text-accent shrink-0" />
                          <span className="flex-1 min-w-0 text-[12.5px] font-mono font-medium text-theme-primary truncate">{ws.name}</span>
                          {ws.changedFiles > 0 && (
                            <span className="font-mono text-[11px] text-accent shrink-0">+{ws.changedFiles} changed</span>
                          )}
                          {ws.basePort && (
                            <span className="font-mono text-[11px] text-theme-muted shrink-0">:{ws.basePort}</span>
                          )}
                          <span className={`badge ${statusBadge[ws.status] ?? 'badge-muted'} shrink-0`}>{ws.status}</span>
                          {ws.source === 'pr' && (
                            <span className="badge badge-human shrink-0">PR #{ws.prNumber}</span>
                          )}
                          {!isOpen && (
                            <Link
                              to={`/workspaces/${ws._id}`}
                              onClick={e => e.stopPropagation()}
                              className="btn btn-secondary btn-sm shrink-0"
                            >
                              Open
                            </Link>
                          )}
                        </div>

                        {/* Expanded panel — Files / Terminal / Preview / Env tab bar */}
                        {isOpen && (
                          <div className="border-t border-app bg-app-muted/30">
                            {/* Tab bar */}
                            <div className="px-3.5 py-2 border-b border-app bg-app-card flex items-center gap-1.5 flex-wrap">
                              {[
                                { id: '', label: 'Preview' },
                                { id: 'terminal', label: 'Terminal' },
                                { id: 'diff', label: 'Files' },
                                { id: 'env', label: 'Env' },
                              ].map(t => (
                                <Link
                                  key={t.id}
                                  to={`/workspaces/${ws._id}${t.id ? `?tab=${t.id}` : ''}`}
                                  className="btn btn-secondary btn-sm"
                                >
                                  {t.label}
                                </Link>
                              ))}
                              <span className="flex-1" />
                              <span className="font-mono text-[10.5px] text-theme-muted truncate">
                                {ws.branch} → {ws.baseBranch}
                              </span>
                              <Link
                                to={`/workspaces/${ws._id}`}
                                className="btn btn-primary btn-sm"
                              >
                                <Terminal className="w-3 h-3" /> Open in detail
                              </Link>
                              <button
                                onClick={() => setDeleting({ id: ws._id, name: ws.name })}
                                className="p-1 rounded text-theme-muted hover:text-accent-red hover:bg-accent-red/10 transition-colors"
                                title="Archive"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>

                            {/* Body — meta summary (real preview lives on the detail page) */}
                            <div className="px-3.5 py-3 grid grid-cols-1 md:grid-cols-3 gap-3 text-[12px]">
                              <div className="space-y-1">
                                <div className="overline">Path</div>
                                <div className="font-mono text-theme-secondary truncate" title={ws.path}>{ws.path ?? '—'}</div>
                              </div>
                              <div className="space-y-1">
                                <div className="overline">Services</div>
                                <div className="flex flex-col gap-0.5">
                                  {(ws.services ?? []).slice(0, 4).map((s: any, i: number) => (
                                    <div key={i} className="font-mono text-[11px] flex items-center gap-2">
                                      <span className={`w-1.5 h-1.5 rounded-full ${s.status === 'ready' ? 'bg-accent-green' : s.status === 'failed' ? 'bg-accent-red' : 'bg-accent-yellow'}`} />
                                      <span className="text-theme-primary">{s.name}</span>
                                      {s.port && <span className="text-theme-muted">:{s.port}</span>}
                                    </div>
                                  ))}
                                  {(!ws.services || ws.services.length === 0) && (
                                    <span className="text-theme-muted text-[11px]">No services configured.</span>
                                  )}
                                </div>
                              </div>
                              <div className="space-y-1">
                                <div className="overline">Created</div>
                                <div className="font-mono text-[11px] text-theme-secondary">
                                  {ws.createdAt ? new Date(ws.createdAt).toLocaleString() : '—'}
                                </div>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
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
