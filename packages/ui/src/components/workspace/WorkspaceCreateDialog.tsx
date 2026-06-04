import { useState } from 'react';
import type { FormEvent } from 'react';
import { Loader2, Monitor, X } from 'lucide-react';
import IconTooltipButton from '../common/IconTooltipButton';
import { workspaces as wsApi } from '../../services/workspaceService';
import { SetupProgressDialog } from './SetupProgressDialog';

export interface WorkspaceCreateRepo {
  _id: string;
  name: string;
  path?: string;
  detected?: {
    defaultBranch?: string;
  };
}

interface Props {
  repo: WorkspaceCreateRepo;
  onClose: () => void;
  onCreated: (workspace: any) => void;
  onCreatedPending?: (workspace: any) => void;
}

const FORM_INPUT_CLASS = 'h-9 w-full rounded-md border border-app bg-app px-3 text-[13px] text-theme-primary outline-none transition-colors placeholder:text-theme-subtle focus:border-accent focus:shadow-[var(--focus-ring)]';
const FORM_LABEL_CLASS = 'mb-2 block font-mono text-[11px] uppercase tracking-[0.12em] text-theme-muted';
const DIALOG_BACKDROP_CLASS = 'fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 backdrop-blur-sm';
const DIALOG_PANEL_CLASS = 'overflow-hidden rounded-md border border-app bg-app-card shadow-[0_24px_80px_rgba(0,0,0,0.34)] animate-in fade-in zoom-in-95 duration-200';
const SECONDARY_BUTTON_CLASS = 'inline-flex h-9 items-center justify-center rounded-md border border-app bg-app px-3 text-[13px] font-medium text-theme-secondary transition-colors hover:border-app-strong hover:bg-app-muted hover:text-theme-primary disabled:cursor-not-allowed disabled:opacity-50';
const PRIMARY_BUTTON_CLASS = 'inline-flex h-9 items-center justify-center gap-2 rounded-md bg-accent px-3 text-[13px] font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50';

export function WorkspaceCreateDialog({ repo, onClose, onCreated, onCreatedPending }: Props) {
  const [branch, setBranch] = useState('');
  const [baseBranch, setBaseBranch] = useState(repo.detected?.defaultBranch ?? 'main');
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState('');

  async function handleCreate(event?: FormEvent) {
    event?.preventDefault();
    if (!branch.trim() || !name.trim()) {
      setError('Branch and workspace name are required.');
      return;
    }

    setCreating(true);
    setError('');
    try {
      const workspace = await wsApi.create({
        repoId: repo._id,
        repoName: repo.name,
        repoPath: repo.path ?? '',
        branch: branch.trim(),
        baseBranch: baseBranch.trim() || 'main',
        name: name.trim(),
      });
      onCreatedPending?.(workspace);
      setPendingId(workspace._id);
    } catch (err: any) {
      setError(err.message);
      setCreating(false);
    }
  }

  if (pendingId) {
    return (
      <SetupProgressDialog
        workspaceId={pendingId}
        onComplete={(workspace) => onCreated(workspace)}
        onFailed={(message) => {
          setPendingId(null);
          setCreating(false);
          setError(message || 'Setup failed.');
        }}
      />
    );
  }

  return (
    <div className={DIALOG_BACKDROP_CLASS} onClick={onClose} role="dialog" aria-modal="true">
      <form className={`w-full max-w-[520px] ${DIALOG_PANEL_CLASS}`} onSubmit={handleCreate} onClick={event => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 border-b border-app px-6 py-5">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-app bg-app text-accent">
              <Monitor className="h-[18px] w-[18px]" />
            </span>
            <div className="min-w-0">
              <h2 className="text-[16px] font-semibold text-theme-primary">New workspace</h2>
              <p className="mt-1 truncate font-mono text-[12px] text-theme-muted">{repo.name}</p>
            </div>
          </div>
          <IconTooltipButton label="Close" onClick={onClose} className="h-9 w-9">
            <X className="h-4 w-4" />
          </IconTooltipButton>
        </div>

        <div className="space-y-4 px-6 py-5">
          {error && <div className="rounded-md border border-accent-red/30 bg-accent-red/10 px-3 py-2 text-[13px] text-accent-red">{error}</div>}
          <div>
            <label className={FORM_LABEL_CLASS}>Workspace name</label>
            <input value={name} onChange={event => setName(event.target.value)} placeholder="feature/my-feature" className={FORM_INPUT_CLASS} autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={FORM_LABEL_CLASS}>Branch</label>
              <input value={branch} onChange={event => setBranch(event.target.value)} placeholder="feature/new-thing" className={`${FORM_INPUT_CLASS} font-mono`} />
            </div>
            <div>
              <label className={FORM_LABEL_CLASS}>Base branch</label>
              <input value={baseBranch} onChange={event => setBaseBranch(event.target.value)} className={`${FORM_INPUT_CLASS} font-mono`} />
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-3 border-t border-app px-6 py-4">
          <button onClick={onClose} className={SECONDARY_BUTTON_CLASS} type="button" disabled={creating}>Cancel</button>
          <button disabled={creating} className={PRIMARY_BUTTON_CLASS} type="submit">
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Monitor className="h-4 w-4" />}
            {creating ? 'Creating...' : 'Create workspace'}
          </button>
        </div>
      </form>
    </div>
  );
}
