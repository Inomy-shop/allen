/**
 * Design Studio — workspaces home (R1/R2/R22).
 *
 * Lists the user's design workspaces (one per repo / per idea) and lets them
 * create a new one from a connected repository or a new idea.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Palette, Plus, FolderGit2, Lightbulb, Trash2, Loader2 } from 'lucide-react';
import { designStudio, type Workspace } from '../services/designStudioService';
import DesignStudioCreateDialog from '../components/design/DesignStudioCreateDialog';

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

      {showNew && <DesignStudioCreateDialog onClose={() => setShowNew(false)} onCreated={(id) => navigate(`/studio/workspaces/${id}`)} />}
    </div>
  );
}

