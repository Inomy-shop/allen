/**
 * Design Studio — workspaces home (R1/R2/R22).
 *
 * Lists the user's design workspaces (one per repo / per idea) and lets them
 * create a new one from a connected repository or a new idea.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Palette, Plus, FolderGit2, FolderOpen, Lightbulb, Trash2, Loader2, Download, Check, X, Search } from 'lucide-react';
import { designStudio, type ImportSource, type Workspace } from '../services/designStudioService';
import { repos as reposApi } from '../services/api';
import Select from '../components/common/Select';
import DesignStudioCreateDialog from '../components/design/DesignStudioCreateDialog';

function StatusChip({ status }: { status: Workspace['profileStatus'] }) {
  const map: Record<Workspace['profileStatus'], { label: string; cls: string }> = {
    pending: { label: 'Setup needed', cls: 'setup' },
    analyzing: { label: 'Analyzing…', cls: 'analyzing' },
    needs_review: { label: 'Review profile', cls: 'review' },
    needs_choice: { label: 'Action needed', cls: 'review' },
    confirmed: { label: 'Ready', cls: 'ready' },
  };
  const v = map[status];
  return <span className={`v8-design-status ${v.cls}`}>{v.label}</span>;
}

export default function DesignStudioPage() {
  const navigate = useNavigate();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [query, setQuery] = useState('');

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

  const normalizedQuery = query.trim().toLowerCase();
  const filteredWorkspaces = workspaces.filter((workspace) => {
    if (!normalizedQuery) return true;
    const path = workspace.kind === 'repo' ? workspace.sourceRepoPath ?? '' : 'Greenfield design workspace';
    return `${workspace.name} ${path} ${workspace.kind}`.toLowerCase().includes(normalizedQuery);
  });

  return (
    <div className="v8-page v8-design-home overflow-y-auto">
      <div className="v8-page__wrap v8-design-home__wrap">
      <header className="v8-design-head">
        <div>
          <div className="v8-design-head__title">
            <span className="v8-design-head__mark"><Palette /></span>
            <h1>Allen Design</h1>
          </div>
          <p>
            Create repo-aware design workspaces, analyze product design systems, run design chats, preview generated folders, and export static bundles.
          </p>
        </div>
        <div className="v8-design-actions">
          <button className="v8-btn v8-btn--ghost" onClick={() => setShowImport(true)} title="Create a new workspace from another workspace's designs or an exported folder">
            <Download /> Import designs
          </button>
          <button className="v8-btn v8-btn--ink" onClick={() => setShowNew(true)}>
            <Plus /> New design
          </button>
        </div>
      </header>

      <div className="v8-design-toolbar">
        <label className="v8-search">
          <Search />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search design workspaces"
            aria-label="Search design workspaces"
          />
        </label>
      </div>

      {loading ? (
        <div className="v8-design-loading"><Loader2 className="animate-spin" /> Loading…</div>
      ) : workspaces.length === 0 ? (
        <div className="v8-design-empty">
          <span><Palette /></span>
          <h2>No design workspaces yet</h2>
          <p>Create one to analyze a repository or develop a new product idea.</p>
          <button className="v8-btn v8-btn--ink" onClick={() => setShowNew(true)}><Plus /> New design</button>
        </div>
      ) : filteredWorkspaces.length === 0 ? (
        <div className="v8-design-empty compact">
          <span><Search /></span>
          <h2>No matching workspaces</h2>
          <p>Try another workspace name or repository path.</p>
        </div>
      ) : (
        <div className="v8-design-grid">
          {filteredWorkspaces.map((ws) => (
            <article
              key={ws._id}
              className="v8-design-workspace"
              onClick={() => navigate(`/studio/workspaces/${ws._id}`)}
            >
              <div className="v8-design-workspace__link">
              <div className="v8-design-workspace__top">
                <span className="v8-design-workspace__icon">{ws.kind === 'repo' ? <FolderGit2 /> : <Lightbulb />}</span>
                <span className="v8-design-workspace__name">{ws.name}</span>
              </div>
              <p className="v8-design-workspace__path" title={ws.sourceRepoPath}>
                {ws.kind === 'repo' ? ws.sourceRepoPath || 'Repository workspace' : 'Greenfield design workspace'}
              </p>
              <div className="v8-design-workspace__foot">
                <StatusChip status={ws.profileStatus} />
                <span>{ws.kind === 'repo' ? 'Repository' : 'New idea'}</span>
              </div>
              </div>
              <button
                className="v8-design-workspace__delete"
                onClick={(e) => { e.stopPropagation(); void remove(ws._id); }}
                aria-label="Delete workspace"
              >
                <Trash2 />
              </button>
            </article>
          ))}
        </div>
      )}

      {showNew && <DesignStudioCreateDialog onClose={() => setShowNew(false)} onCreated={(id) => navigate(`/studio/workspaces/${id}`)} />}
      {showImport && <ImportAsNewWorkspaceDialog onClose={() => setShowImport(false)} onCreated={(id) => navigate(`/studio/workspaces/${id}`)} />}
      </div>
    </div>
  );
}

// ── Import designs as a brand-new workspace ───────────────────────────────────

function ImportAsNewWorkspaceDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [sources, setSources] = useState<ImportSource[] | null>(null);
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [bundleDir, setBundleDir] = useState('');
  const [name, setName] = useState('');
  // Picking a source prefills the name so it is visible and editable before
  // importing; a name the user typed themselves is never overwritten.
  const [nameTouched, setNameTouched] = useState(false);
  const [repoList, setRepoList] = useState<{ _id: string; name?: string; path?: string }[]>([]);
  const [repoId, setRepoId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    designStudio.listAllImportSources().then(setSources).catch(() => setSources([]));
    reposApi.list().then((r) => setRepoList(Array.isArray(r) ? r : [])).catch(() => setRepoList([]));
  }, []);

  function suggestName(suggestion: string) {
    if (!nameTouched) setName(suggestion);
  }
  function folderSuggestion(path: string): string {
    const base = path.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? '';
    return base ? `${base} (imported)` : '';
  }

  const canImport = !busy && (Boolean(selectedSource) || bundleDir.trim().length > 0);

  async function runImport() {
    if (!canImport) return;
    setBusy(true);
    setError(null);
    try {
      const body = {
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(selectedSource ? { sourceWorkspaceId: selectedSource } : { sourceDir: bundleDir.trim() }),
        // Workspace sources pass their repo link on server-side; the explicit
        // pick applies to folder imports (and overrides when both are set).
        ...(repoId ? { repoId } : {}),
      };
      const { workspace } = await designStudio.importAsNewWorkspace(body);
      onCreated(workspace._id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 backdrop-blur-sm" onClick={busy ? undefined : onClose}>
      <div className="w-full max-w-md overflow-hidden rounded-md border border-app bg-app-card shadow-[0_24px_80px_rgba(0,0,0,0.34)] animate-in fade-in zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3 border-b border-app px-5 py-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-app bg-app text-accent">
            <Download className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-semibold tracking-tight text-theme-primary">Import designs as a new workspace</h2>
            <p className="mt-0.5 text-[12px] text-theme-muted">
              Creates a fresh workspace and adopts the source design system as-is — ready to iterate immediately.
            </p>
          </div>
          <button className="rounded-md p-1 text-theme-muted transition-colors hover:bg-app-muted hover:text-theme-primary" onClick={onClose} disabled={busy} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4">
          <label className="mb-4 block">
            <span className="mb-1.5 block text-[12px] font-medium text-theme-secondary">Workspace name</span>
            <input
              className="input h-9 w-full rounded-md text-[13px]"
              placeholder="Pick a source below, then adjust the name"
              value={name}
              onChange={(e) => { setName(e.target.value); setNameTouched(e.target.value.trim().length > 0); }}
            />
            <span className="mt-1 block text-[11px] text-theme-muted">
              Shown in your workspace list — change it to something easy to identify.
            </span>
          </label>

          <p className="mb-2 text-[12px] font-medium text-theme-secondary">Import from a workspace</p>
          {sources === null ? (
            <div className="flex items-center gap-2 py-3 text-[12px] text-theme-muted"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</div>
          ) : sources.length === 0 ? (
            <p className="rounded-md border border-app bg-app px-3 py-2 text-[12px] text-theme-muted">No workspaces with designs found.</p>
          ) : (
            <div className="max-h-52 space-y-1.5 overflow-y-auto">
              {sources.map((s) => (
                <button
                  key={s._id}
                  type="button"
                  role="radio"
                  aria-checked={selectedSource === s._id}
                  className={`flex w-full items-center justify-between gap-3 rounded-md border p-2 text-left transition-colors ${selectedSource === s._id ? 'border-accent bg-accent-soft' : 'border-app bg-app hover:border-app-strong'}`}
                  onClick={() => {
                    const next = selectedSource === s._id ? null : s._id;
                    setSelectedSource(next);
                    setBundleDir('');
                    suggestName(next ? `${s.name} (imported)` : '');
                  }}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {s.kind === 'repo' ? <FolderGit2 className="h-4 w-4 shrink-0 text-theme-muted" /> : <Lightbulb className="h-4 w-4 shrink-0 text-theme-muted" />}
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-medium text-theme-primary">{s.name}</span>
                      <span className="block font-mono text-[10.5px] text-theme-muted">
                        {s.designCount} design{s.designCount === 1 ? '' : 's'}{s.ownerUserId ? ' · another user' : ''}
                      </span>
                    </span>
                  </span>
                  <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${selectedSource === s._id ? 'border-accent bg-accent text-white' : 'border-app bg-app-card'}`}>
                    {selectedSource === s._id && <Check className="h-3 w-3" />}
                  </span>
                </button>
              ))}
            </div>
          )}

          <p className="mb-1.5 mt-4 text-[12px] font-medium text-theme-secondary">Or import an exported folder</p>
          <div className="flex items-center gap-2">
            <input
              className="input h-9 w-full min-w-0 flex-1 rounded-md font-mono text-[12px]"
              placeholder="/absolute/path/to/exported-design-folder"
              value={bundleDir}
              onChange={(e) => {
                setBundleDir(e.target.value);
                if (e.target.value.trim()) setSelectedSource(null);
                suggestName(folderSuggestion(e.target.value.trim()));
              }}
            />
            {typeof window !== 'undefined' && window.allenDesktop?.selectDirectory && (
              <button
                type="button"
                className="btn btn-secondary btn-sm h-9 shrink-0 gap-1.5 !rounded-md"
                onClick={async () => {
                  const selected = await window.allenDesktop?.selectDirectory();
                  if (selected) { setBundleDir(selected); setSelectedSource(null); suggestName(folderSuggestion(selected)); }
                }}
                disabled={busy}
                title="Choose the exported design folder"
              >
                <FolderOpen className="h-3.5 w-3.5" /> Browse…
              </button>
            )}
          </div>

          <label className="mt-4 block">
            <span className="mb-1.5 block text-[12px] font-medium text-theme-secondary">Link to repository (optional)</span>
            <Select
              value={repoId}
              onChange={setRepoId}
              placeholder={selectedSource ? 'Inherited from the source workspace' : 'No repository link'}
              searchPlaceholder="Search repositories..."
              options={[
                { value: '', label: selectedSource ? 'Inherit from source workspace' : 'No repository link' },
                ...repoList.map((r) => ({ value: r._id, label: r.name || r.path || r._id })),
              ]}
            />
            <span className="mt-1 block text-[11px] text-theme-muted">
              Gives design chats read-only access to the repo's pages and components.
            </span>
          </label>

          {error && <p className="mt-3 whitespace-pre-wrap rounded-md border border-accent-red/30 bg-accent-red/10 px-3 py-2 text-[12px] text-accent-red">{error}</p>}

          <div className="mt-4 flex justify-end gap-2">
            <button className="btn btn-secondary btn-sm !rounded-md" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="btn btn-primary btn-sm gap-1.5 !rounded-md" onClick={runImport} disabled={!canImport}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} Create workspace
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
