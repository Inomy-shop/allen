/**
 * DesignStudioCreateDialog — two-mode creation dialog for design workspaces.
 *
 * Extracted from the inline NewWorkspaceModal in DesignStudioPage.tsx.
 * Preserves all existing behavior identically: two-mode tabs, Select for repo,
 * input for idea name, inline error display, busy state.
 */
import { useEffect, useState } from 'react';
import { Loader2, X, FolderGit2, Lightbulb } from 'lucide-react';
import { designStudio } from '../../services/designStudioService';
import { repos as reposApi } from '../../services/api';
import Select from '../common/Select';

export default function DesignStudioCreateDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
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
