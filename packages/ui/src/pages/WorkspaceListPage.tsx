import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { workspaces } from '../services/workspaceService';
import { repos as repoApi } from '../services/api';
import { Plus, FolderGit2, Loader2, Settings } from 'lucide-react';
import { WorkspaceConfigEditor } from '../components/workspace/WorkspaceConfigEditor';
import { SetupProgressDialog } from '../components/workspace/SetupProgressDialog';
import WorkspacesSidebar from '../components/workspace/WorkspacesSidebar';
import { useSidebarCollapsed } from '../hooks/useSidebarCollapsed';

/**
 * Landing page for /workspaces — same in-page layout as the chat page:
 * a left sidebar (WorkspacesSidebar) lists every workspace and clicking
 * one navigates to /workspaces/:id (which renders WorkspaceDetailPage
 * with the same sidebar still visible). With nothing selected we show
 * a welcome panel with a "New workspace" form.
 */
export default function WorkspaceListPage() {
  const [repos, setRepos] = useState<any[]>([]);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ repoId: '', repoPath: '', repoName: '', branch: '', baseBranch: 'main', name: '' });
  const [pendingWsId, setPendingWsId] = useState<string | null>(null);
  const [configRepoId, setConfigRepoId] = useState<string | null>(null);
  const [collapsed, toggleCollapsed] = useSidebarCollapsed('workspaces', false);
  const navigate = useNavigate();

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

  function selectRepo(repoId: string) {
    const repo = repos.find(r => r._id === repoId);
    setForm(f => ({ ...f, repoId, repoPath: repo?.path ?? '', repoName: repo?.name ?? '' }));
  }

  return (
    <div className="flex h-full overflow-hidden">
      <WorkspacesSidebar
        collapsed={collapsed}
        onToggle={toggleCollapsed}
        onNew={() => setCreating(true)}
      />

      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="px-6 pt-5 pb-8">
          <div className="flex items-center gap-2 mb-2 text-[12px] text-theme-muted">
            <span>Code</span>
            <span className="text-theme-subtle">/</span>
            <span>Workspaces</span>
          </div>
          <div className="flex items-center justify-between mb-5">
            <h1 className="text-[20px] font-semibold text-theme-primary tracking-tight">Workspaces</h1>
            {!creating && (
              <button onClick={() => setCreating(true)} className="btn btn-primary btn-sm">
                <Plus className="w-3.5 h-3.5" /> New workspace
              </button>
            )}
          </div>

          {creating ? (
            <form onSubmit={handleCreate} className="card p-5 space-y-4 max-w-2xl">
              <h2 className="text-[14px] font-semibold text-theme-primary tracking-tight">New workspace</h2>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="overline block mb-1">Repository</label>
                  <select value={form.repoId} onChange={e => selectRepo(e.target.value)} className="input w-full text-[12px]">
                    <option value="">Select repo…</option>
                    {repos.map(r => <option key={r._id} value={r._id}>{r.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="overline block mb-1">Workspace name</label>
                  <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="feature/light-theme" className="input w-full text-[12px]" />
                </div>
                <div>
                  <label className="overline block mb-1">Branch</label>
                  <input value={form.branch} onChange={e => setForm(f => ({ ...f, branch: e.target.value }))} placeholder="feature/my-feature" className="input w-full text-[12px]" />
                </div>
                <div>
                  <label className="overline block mb-1">Base branch</label>
                  <input value={form.baseBranch} onChange={e => setForm(f => ({ ...f, baseBranch: e.target.value }))} placeholder="main" className="input w-full text-[12px]" />
                </div>
              </div>
              <div className="flex justify-end gap-2">
                {form.repoId && (
                  <button type="button" onClick={() => setConfigRepoId(form.repoId)} className="btn btn-ghost btn-sm">
                    <Settings className="w-3 h-3" /> Configure
                  </button>
                )}
                <button type="button" onClick={() => setCreating(false)} className="btn btn-ghost btn-sm">Cancel</button>
                <button type="submit" className="btn btn-primary btn-sm">Create workspace</button>
              </div>
            </form>
          ) : (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <div className="w-14 h-14 rounded-xl bg-accent-soft flex items-center justify-center mb-5">
                <FolderGit2 className="w-6 h-6 text-accent" />
              </div>
              <p className="text-[14px] text-theme-primary font-medium">Pick a workspace from the sidebar</p>
              <p className="text-[12px] text-theme-muted mt-1 mb-6 max-w-md">
                Open any workspace on the left to view its files, terminal, and services. Clicking a different one switches inline — no page reload.
              </p>
              <button onClick={() => setCreating(true)} className="btn btn-primary btn-sm">
                <Plus className="w-3.5 h-3.5" /> New workspace
              </button>
            </div>
          )}
        </div>
      </div>

      {configRepoId && <WorkspaceConfigEditor repoId={configRepoId} onClose={() => setConfigRepoId(null)} />}
      {pendingWsId && (
        <SetupProgressDialog
          workspaceId={pendingWsId}
          onComplete={(ws) => { setPendingWsId(null); navigate(`/workspaces/${ws._id}`); }}
          onFailed={() => { setPendingWsId(null); }}
        />
      )}
    </div>
  );
}
