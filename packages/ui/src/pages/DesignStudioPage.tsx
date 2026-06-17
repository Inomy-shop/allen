/**
 * Design Studio — workspaces home (R1/R2/R22).
 *
 * Lists the user's design workspaces (one per repo / per idea) and lets them
 * create a new one from a connected repository or a new idea.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Palette, Plus, FolderGit2, Lightbulb, Trash2, Loader2, X } from 'lucide-react';
import { designStudio, type Workspace } from '../services/designStudioService';
import { repos as reposApi } from '../services/api';
import Select from '../components/common/Select';

function StatusChip({ status }: { status: Workspace['profileStatus'] }) {
  const map: Record<Workspace['profileStatus'], { label: string; cls: string }> = {
    pending: { label: 'Setup needed', cls: 'bg-amber-500/15 text-amber-500' },
    analyzing: { label: 'Analyzing…', cls: 'bg-blue-500/15 text-blue-400' },
    needs_review: { label: 'Review profile', cls: 'bg-amber-500/15 text-amber-500' },
    needs_choice: { label: 'Action needed', cls: 'bg-orange-500/15 text-orange-500' },
    confirmed: { label: 'Ready', cls: 'bg-emerald-500/15 text-emerald-500' },
  };
  const v = map[status];
  return <span className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${v.cls}`}>{v.label}</span>;
}

export default function DesignStudioPage() {
  const navigate = useNavigate();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      setWorkspaces(await designStudio.listWorkspaces());
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void refresh(); }, []);

  async function remove(id: string) {
    await designStudio.deleteWorkspace(id);
    void refresh();
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-6">
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Palette className="h-5 w-5 text-accent" />
          <h1 className="text-lg font-semibold text-theme-primary">Design Studio</h1>
        </div>
        <button className="btn btn-primary btn-sm inline-flex items-center gap-1.5" onClick={() => setShowNew(true)}>
          <Plus className="h-4 w-4" /> New design
        </button>
      </div>

      <p className="mb-6 max-w-2xl text-[13px] text-theme-muted">
        Create repo-aware design workspaces, analyze product design systems, run design chats, preview generated folders, and export static bundles.
      </p>

      {loading ? (
        <div className="flex items-center gap-2 text-theme-muted"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
      ) : workspaces.length === 0 ? (
        <div className="rounded-md border border-dashed border-app bg-app-card p-10 text-center text-theme-muted">
          No design workspaces yet. Create one to get started.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {workspaces.map((ws) => (
            <div
              key={ws._id}
              className="group relative cursor-pointer rounded-md border border-app bg-app-card p-4 transition-colors hover:border-app-strong hover:bg-app-muted/40"
              onClick={() => navigate(`/studio/workspaces/${ws._id}`)}
            >
              <div className="mb-2 flex items-center gap-2">
                {ws.kind === 'repo' ? <FolderGit2 className="h-4 w-4 text-theme-muted" /> : <Lightbulb className="h-4 w-4 text-theme-muted" />}
                <span className="truncate text-[14px] font-medium text-theme-primary">{ws.name}</span>
              </div>
              <div className="flex items-center justify-between">
                <StatusChip status={ws.profileStatus} />
                <span className="text-[11px] text-theme-muted">{ws.kind === 'repo' ? 'Repository' : 'New idea'}</span>
              </div>
              <button
                className="absolute right-2 top-2 hidden rounded-md p-1 text-theme-muted transition-colors hover:bg-app-muted hover:text-accent-red group-hover:block"
                onClick={(e) => { e.stopPropagation(); void remove(ws._id); }}
                aria-label="Delete workspace"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {showNew && <NewWorkspaceModal onClose={() => setShowNew(false)} onCreated={(id) => navigate(`/studio/workspaces/${id}`)} />}
    </div>
  );
}

function NewWorkspaceModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [mode, setMode] = useState<'repo' | 'greenfield'>('repo');
  const [repoList, setRepoList] = useState<{ _id: string; name: string; path?: string }[]>([]);
  const [repoId, setRepoId] = useState('');
  const [ideaName, setIdeaName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    reposApi.list().then((r) => {
      setRepoList(r);
      if (r[0]) setRepoId(r[0]._id);
    }).catch(() => setRepoList([]));
  }, []);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const ws = mode === 'repo'
        ? await designStudio.createWorkspace({ kind: 'repo', repoId })
        : await designStudio.createWorkspace({ kind: 'greenfield', name: ideaName.trim() || 'New idea' });
      onCreated(ws._id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/55 backdrop-blur-sm" onClick={onClose}>
      <div className="w-[520px] max-w-[calc(100vw-32px)] overflow-hidden rounded-md border border-app bg-app-card shadow-[0_24px_80px_rgba(0,0,0,0.34)]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 border-b border-app px-5 py-4">
          <div>
            <h2 className="text-[15px] font-semibold text-theme-primary">Start a new design workspace</h2>
            <p className="mt-1 text-[12px] text-theme-muted">Choose a repository to analyze or start from a clean brief.</p>
          </div>
          <button className="rounded-md p-1.5 text-theme-muted transition-colors hover:bg-app-muted hover:text-theme-primary" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
        <div className="grid grid-cols-2 gap-2">
          <button
            className={`flex flex-col items-start gap-1 rounded-md border p-3 text-left transition-colors ${mode === 'repo' ? 'border-accent bg-accent-soft' : 'border-app bg-app hover:border-app-strong'}`}
            onClick={() => setMode('repo')}
          >
            <FolderGit2 className="h-4 w-4 text-accent" />
            <span className="text-[13px] font-medium text-theme-primary">From a repository</span>
            <span className="text-[11px] text-theme-muted">Match an existing product's look</span>
          </button>
          <button
            className={`flex flex-col items-start gap-1 rounded-md border p-3 text-left transition-colors ${mode === 'greenfield' ? 'border-accent bg-accent-soft' : 'border-app bg-app hover:border-app-strong'}`}
            onClick={() => setMode('greenfield')}
          >
            <Lightbulb className="h-4 w-4 text-accent" />
            <span className="text-[13px] font-medium text-theme-primary">From a new idea</span>
            <span className="text-[11px] text-theme-muted">Design it together from scratch</span>
          </button>
        </div>

        {mode === 'repo' ? (
          <label className="block">
            <span className="mb-1 block text-[12px] text-theme-muted">Repository</span>
            <Select
              value={repoId}
              onChange={setRepoId}
              placeholder="Select repository"
              searchPlaceholder="Search repositories..."
              options={repoList.length === 0
                ? [{ value: '', label: 'No connected repositories', disabled: true }]
                : repoList.map((repo) => ({ value: repo._id, label: repo.name, sublabel: repo.path }))}
            />
          </label>
        ) : (
          <label className="block">
            <span className="mb-1 block text-[12px] text-theme-muted">Name your idea</span>
            <input className="input h-9 w-full rounded-md text-[13px]" placeholder="e.g. Habit-tracking app" value={ideaName} onChange={(e) => setIdeaName(e.target.value)} />
          </label>
        )}

        {error && <p className="mt-2 text-[12px] text-red-500">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-app px-5 py-4">
          <button className="btn btn-secondary btn-sm" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            className="btn btn-primary btn-sm inline-flex items-center gap-1.5"
            onClick={create}
            disabled={busy || (mode === 'repo' && !repoId)}
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Create
          </button>
        </div>
      </div>
    </div>
  );
}
