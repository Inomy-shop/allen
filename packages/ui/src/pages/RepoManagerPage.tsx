import { useState, useEffect, useCallback } from 'react';
import { repos as repoApi, workflows as wfApi, system as systemApi } from '../services/api';
import DeleteConfirmDialog from '../components/common/DeleteConfirmDialog';
import Select from '../components/common/Select';
import {
  Check, Copy, FolderGit2, Plus, RefreshCw, Trash2, Pencil, ScanSearch, X,
  GitBranch, Sparkles, ExternalLink, Loader2, Settings, Monitor, FileText, Download,
  Github, HardDrive, FolderOpen, CheckCircle2, AlertTriangle, XCircle,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { WorkspaceConfigEditor } from '../components/workspace/WorkspaceConfigEditor';
import { workspaces as wsApi } from '../services/workspaceService';
import { SetupProgressDialog } from '../components/workspace/SetupProgressDialog';
import { workspaceCreateBaseBranch } from '../lib/workspace-create';
import { useToast } from '../components/common/Toast';
import IconTooltipButton from '../components/common/IconTooltipButton';
import { workspaceChatPath } from '../lib/workspace-routes';

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
  contextScan?: {
    status?: 'pending' | 'scanning' | 'ready' | 'error' | 'cancelled';
    executionId?: string;
    error?: string;
    startedAt?: string;
    scannedAt?: string;
  };
  lastUsedAt?: string;
  executionCount: number;
  createdAt: string;
  updatedAt: string;
}

type CogneeStatus = {
  status?: 'pending' | 'running' | 'completed' | 'partial' | 'failed' | 'stopped';
  stage?: 'pulling' | 'collecting_curated_context' | 'collecting_markdown' | 'ingesting' | 'cognifying' | 'completed' | 'failed';
  ingestFormat?: string;
  message?: string;
  documentCount?: number;
  candidateCount?: number;
  processedDocumentCount?: number;
  ingestedDocumentCount?: number;
  cognifiedDocumentCount?: number;
  documentsToIngestCount?: number;
  addedDocumentCount?: number;
  changedDocumentCount?: number;
  deletedDocumentCount?: number;
  unchangedDocumentCount?: number;
  uncognifiedRetryCount?: number;
  storageRoot?: string;
  systemRoot?: string;
  databasePath?: string;
  storageExisting?: boolean;
  datasetExisting?: boolean;
  workerActive?: boolean;
  buildMode?: 'resume' | 'clean_rebuild';
  previousDatasetName?: string;
  uncognifiedDocuments?: Array<{ path?: string; title?: string; fileHash?: string; dataId?: string; cogneeDataId?: string; status?: string }>;
  error?: string;
  stopRequestedAt?: string;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  updatedAt?: string;
};

type ContextRuntimeConfig = {
  enabled: boolean;
  provider: 'allen' | 'cognee' | 'cognee_memory' | null;
  cogneeEnabled: boolean;
};

const FORM_INPUT_CLASS = 'h-9 w-full rounded-md border border-app bg-app px-3 text-[13px] text-theme-primary outline-none transition-colors placeholder:text-theme-subtle focus:border-accent focus:shadow-[var(--focus-ring)]';
const FORM_LABEL_CLASS = 'mb-2 block font-mono text-[11px] uppercase tracking-[0.12em] text-theme-muted';
const DIALOG_BACKDROP_CLASS = 'fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 backdrop-blur-sm';
const DIALOG_PANEL_CLASS = 'overflow-hidden rounded-md border border-app bg-app-card shadow-[0_24px_80px_rgba(0,0,0,0.34)] animate-in fade-in zoom-in-95 duration-200';
const SECONDARY_BUTTON_CLASS = 'inline-flex h-9 items-center justify-center rounded-md border border-app bg-app px-3 text-[13px] font-medium text-theme-secondary transition-colors hover:border-app-strong hover:bg-app-muted hover:text-theme-primary disabled:cursor-not-allowed disabled:opacity-50';
const PRIMARY_BUTTON_CLASS = 'inline-flex h-9 items-center justify-center gap-2 rounded-md bg-accent px-3 text-[13px] font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50';
const TERTIARY_BUTTON_CLASS = 'inline-flex h-9 items-center justify-center gap-2 rounded-md border border-app bg-app px-3 text-[13px] font-medium text-theme-secondary transition-colors hover:border-app-strong hover:bg-app-muted hover:text-theme-primary disabled:cursor-not-allowed disabled:opacity-50';
const SEGMENTED_GROUP_CLASS = 'inline-flex h-9 items-center rounded-md border border-app bg-app-card p-1';
const SEGMENTED_BUTTON_CLASS = 'inline-flex h-7 items-center justify-center gap-2 rounded-md px-2.5 text-[12px] font-medium transition-colors';
const ROW_ICON_BUTTON_CLASS = 'h-8 w-8 border border-app bg-app hover:border-app-strong';
const ROW_DANGER_ICON_BUTTON_CLASS = 'h-8 w-8 border border-app bg-app hover:border-accent-red/50';

type AddRepoMode = 'clone' | 'local';
type ValidationCheckStatus = 'pass' | 'warn' | 'fail';

interface RepoValidationCheck {
  id: string;
  label: string;
  status: ValidationCheckStatus;
  detail: string;
}

interface RepoValidationResult {
  ok: boolean;
  source: AddRepoMode;
  name?: string;
  path?: string;
  clonePath?: string;
  branch?: string;
  detected?: Repo['detected'];
  checks: RepoValidationCheck[];
}

function validationStatusClass(status: ValidationCheckStatus): string {
  if (status === 'pass') return 'border-accent-green/25 bg-accent-green/10 text-accent-green';
  if (status === 'warn') return 'border-accent-yellow/25 bg-accent-yellow/10 text-accent-yellow';
  return 'border-accent-red/25 bg-accent-red/10 text-accent-red';
}

function ValidationStatusIcon({ status }: { status: ValidationCheckStatus }) {
  if (status === 'pass') return <CheckCircle2 className="h-3.5 w-3.5" />;
  if (status === 'warn') return <AlertTriangle className="h-3.5 w-3.5" />;
  return <XCircle className="h-3.5 w-3.5" />;
}

function RepoValidationPreview({ result }: { result: RepoValidationResult | null }) {
  if (!result) return null;
  return (
    <div className="rounded-md border border-app bg-app-card">
      <div className="flex items-center justify-between gap-3 border-b border-app bg-app-muted/25 px-3 py-2">
        <div className="font-mono text-[10.5px] font-medium uppercase tracking-[0.14em] text-theme-muted">Validation</div>
        <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[10.5px] ${result.ok ? 'border-accent-green/25 bg-accent-green/10 text-accent-green' : 'border-accent-red/25 bg-accent-red/10 text-accent-red'}`}>
          {result.ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
          {result.ok ? 'ready' : 'blocked'}
        </span>
      </div>
      <div className="divide-y divide-app">
        {result.checks.map(check => (
          <div key={check.id} className="flex min-h-11 items-start gap-2 px-3 py-2">
            <span className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${validationStatusClass(check.status)}`}>
              <ValidationStatusIcon status={check.status} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[11.5px] font-medium text-theme-primary">{check.label}</div>
              <div className="mt-0.5 text-[11px] leading-4 text-theme-muted [overflow-wrap:anywhere]">{check.detail}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Add Dialog ─────────────────────────────────────────────────────────── */

function AddRepoDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [mode, setMode] = useState<AddRepoMode>('clone');
  const [url, setUrl] = useState('');
  const [localPath, setLocalPath] = useState('');
  const [branch, setBranch] = useState('main');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [validation, setValidation] = useState<RepoValidationResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const isDesktop = typeof window !== 'undefined' && Boolean(window.allenDesktop);

  useEffect(() => {
    if (!open) return;
    setError('');
    setValidation(null);
  }, [branch, localPath, mode, name, open, url]);

  const handleSubmit = async () => {
    if (mode === 'clone' && !url.trim()) { setError('Repository URL is required'); return; }
    if (mode === 'local' && !localPath.trim()) { setError('Local repository path is required'); return; }
    setSaving(true);
    setError('');
    try {
      const parsedTags = tags.trim() ? tags.split(',').map(t => t.trim()).filter(Boolean) : [];
      if (mode === 'local') {
        await repoApi.create({
          path: localPath.trim(),
          name: name.trim() || undefined,
          description: description.trim() || undefined,
          tags: parsedTags,
        });
      } else {
        await repoApi.clone({
          url: url.trim(),
          branch: branch.trim() || 'main',
          name: name.trim() || undefined,
          description: description.trim() || undefined,
          tags: parsedTags,
        });
      }
      setUrl(''); setLocalPath(''); setBranch('main'); setName(''); setDescription(''); setTags(''); setValidation(null);
      onCreated();
      onClose();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleValidate = async () => {
    setChecking(true);
    setError('');
    try {
      const result = mode === 'local'
        ? await repoApi.validateLocal(localPath.trim())
        : await repoApi.validateClone({
          url: url.trim(),
          branch: branch.trim() || 'main',
          name: name.trim() || undefined,
        });
      setValidation(result);
    } catch (e: any) {
      setValidation(null);
      setError(e.message);
    } finally {
      setChecking(false);
    }
  };

  const chooseLocalDirectory = async () => {
    const selected = await window.allenDesktop?.selectDirectory();
    if (selected) setLocalPath(selected);
  };

  if (!open) return null;
  const primaryLabel = mode === 'local' ? 'Onboard repository' : 'Clone repository';

  return (
    <div className={DIALOG_BACKDROP_CLASS} role="dialog" aria-modal="true">
      <div className={`w-full max-w-[640px] ${DIALOG_PANEL_CLASS}`}>
        <div className="flex items-start justify-between gap-4 border-b border-app px-6 py-5">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-md border border-app bg-app text-accent">
              <FolderGit2 className="h-[18px] w-[18px]" />
            </span>
            <div>
              <h2 className="text-[16px] font-semibold text-theme-primary">Add repository</h2>
              <p className="mt-1 text-[13px] text-theme-muted">Clone from GitHub or onboard a local checkout already on this machine.</p>
            </div>
          </div>
          <IconTooltipButton label="Close" onClick={onClose} className="h-9 w-9">
            <X className="h-4 w-4" />
          </IconTooltipButton>
        </div>

        <div className="max-h-[62vh] space-y-4 overflow-auto px-6 py-5">
          {error && (
            <div className="rounded-md border border-accent-red/30 bg-accent-red/10 px-3 py-2 text-[13px] text-accent-red">{error}</div>
          )}

          <div className={`${SEGMENTED_GROUP_CLASS} grid grid-cols-2`}>
            <button
              type="button"
              onClick={() => setMode('clone')}
              className={`${SEGMENTED_BUTTON_CLASS} ${mode === 'clone' ? 'bg-app-muted text-theme-primary' : 'text-theme-muted hover:text-theme-primary'}`}
            >
              <Github className="h-4 w-4" />
              Clone from GitHub
            </button>
            <button
              type="button"
              onClick={() => setMode('local')}
              className={`${SEGMENTED_BUTTON_CLASS} ${mode === 'local' ? 'bg-app-muted text-theme-primary' : 'text-theme-muted hover:text-theme-primary'}`}
            >
              <HardDrive className="h-4 w-4" />
              Existing local repo
            </button>
          </div>

          {mode === 'local' ? (
            <div>
              <label className={FORM_LABEL_CLASS}>Repository path</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={localPath}
                  onChange={e => setLocalPath(e.target.value)}
                  placeholder="/Users/you/projects/app"
                  className={`${FORM_INPUT_CLASS} min-w-0 flex-1 font-mono`}
                  autoFocus
                />
                {isDesktop && (
                  <button
                    type="button"
                    onClick={chooseLocalDirectory}
                    className={`${SECONDARY_BUTTON_CLASS} shrink-0`}
                  >
                    <FolderOpen className="h-4 w-4" />
                    Browse
                  </button>
                )}
              </div>
              <p className="mt-2 text-[12px] text-theme-muted">Allen registers this checkout in place. Your files are not moved into the managed repositories directory.</p>
            </div>
          ) : (
            <>
              <div>
                <label className={FORM_LABEL_CLASS}>Repository URL</label>
                <input type="text" value={url} onChange={e => setUrl(e.target.value)}
                  placeholder="https://github.com/owner/repo or git@github.com:owner/repo.git" className={`${FORM_INPUT_CLASS} font-mono`} autoFocus />
                <p className="mt-2 text-[12px] text-theme-muted">HTTPS or SSH URL. Allen clones it into the local repositories directory.</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={FORM_LABEL_CLASS}>Branch</label>
                  <input type="text" value={branch} onChange={e => setBranch(e.target.value)}
                    placeholder="main" className={`${FORM_INPUT_CLASS} font-mono`} />
                </div>
                <div>
                  <label className={FORM_LABEL_CLASS}>Name</label>
                  <input type="text" value={name} onChange={e => setName(e.target.value)}
                    placeholder="Auto-derived" className={FORM_INPUT_CLASS} />
                </div>
              </div>
            </>
          )}

          {mode === 'local' && (
            <div>
              <label className={FORM_LABEL_CLASS}>Name</label>
              <input type="text" value={name} onChange={e => setName(e.target.value)}
                placeholder="Auto-derived from folder" className={FORM_INPUT_CLASS} />
            </div>
          )}

          <div>
            <label className={FORM_LABEL_CLASS}>Description</label>
            <input type="text" value={description} onChange={e => setDescription(e.target.value)}
              placeholder="Brief description" className={FORM_INPUT_CLASS} />
          </div>
          <div>
            <label className={FORM_LABEL_CLASS}>Tags</label>
            <input type="text" value={tags} onChange={e => setTags(e.target.value)}
              placeholder="Comma-separated, e.g. backend, api" className={`${FORM_INPUT_CLASS} font-mono`} />
          </div>

          <RepoValidationPreview result={validation} />
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-app px-6 py-4">
          <button onClick={handleValidate} disabled={checking || saving || (mode === 'clone' ? !url.trim() : !localPath.trim())} className={TERTIARY_BUTTON_CLASS} type="button">
            {checking ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Validate
          </button>
          <div className="flex items-center gap-3">
            <button onClick={onClose} className={SECONDARY_BUTTON_CLASS} type="button">Cancel</button>
            <button onClick={handleSubmit} disabled={saving} className={PRIMARY_BUTTON_CLASS} type="button">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : mode === 'local' ? <HardDrive className="w-4 h-4" /> : <FolderGit2 className="w-4 h-4" />}
              {saving ? (mode === 'local' ? 'Onboarding...' : 'Cloning...') : primaryLabel}
            </button>
          </div>
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
    <div className={DIALOG_BACKDROP_CLASS} role="dialog" aria-modal="true">
      <div className={`w-full max-w-[620px] ${DIALOG_PANEL_CLASS}`}>
        <div className="flex items-start justify-between gap-4 border-b border-app px-6 py-5">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-app bg-app text-accent">
              <Pencil className="h-[18px] w-[18px]" />
            </span>
            <div className="min-w-0">
              <h2 className="text-[16px] font-semibold text-theme-primary">Edit repository</h2>
              <p className="mt-1 truncate font-mono text-[12px] text-theme-muted">{repo.path}</p>
            </div>
          </div>
          <IconTooltipButton label="Close" onClick={onClose} className="h-9 w-9">
            <X className="h-4 w-4" />
          </IconTooltipButton>
        </div>

        <div className="max-h-[60vh] space-y-4 overflow-auto px-6 py-5">
          {error && (
            <div className="rounded-md border border-accent-red/30 bg-accent-red/10 px-3 py-2 text-[13px] text-accent-red">{error}</div>
          )}
          <div>
            <label className={FORM_LABEL_CLASS}>Name</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)} className={FORM_INPUT_CLASS} />
          </div>
          <div>
            <label className={FORM_LABEL_CLASS}>Description</label>
            <input type="text" value={description} onChange={e => setDescription(e.target.value)} className={FORM_INPUT_CLASS} />
          </div>
          <div>
            <label className={FORM_LABEL_CLASS}>Tags</label>
            <input type="text" value={tags} onChange={e => setTags(e.target.value)}
              placeholder="Comma-separated" className={`${FORM_INPUT_CLASS} font-mono`} />
          </div>
          <div>
            <label className={FORM_LABEL_CLASS}>Context</label>
            <textarea value={context} onChange={e => setContext(e.target.value)}
              rows={3} className="w-full resize-none rounded-md border border-app bg-app px-3 py-2 text-[13px] text-theme-primary outline-none transition-colors placeholder:text-theme-subtle focus:border-accent focus:shadow-[var(--focus-ring)]" placeholder="Brief context for chat agent" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={FORM_LABEL_CLASS}>Default Workflow</label>
              <Select
                value={defaultWorkflow}
                onChange={setDefaultWorkflow}
                placeholder="None"
                searchPlaceholder="Search workflows..."
                options={[
                  { value: '', label: 'None' },
                  ...workflows.map((workflow: any) => ({
                    value: workflow.name,
                    label: workflow.name,
                  })),
                ]}
              />
            </div>
            <div>
              <label className={FORM_LABEL_CLASS}>Status</label>
              <div className={`${SEGMENTED_GROUP_CLASS} grid w-full grid-cols-2`}>
                {(['active', 'archived'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setStatus(value)}
                    className={`${SEGMENTED_BUTTON_CLASS} ${status === value ? 'bg-app-muted text-theme-primary' : 'text-theme-muted hover:text-theme-primary'}`}
                  >
                    {value}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-app px-6 py-4">
          <button onClick={onClose} className={SECONDARY_BUTTON_CLASS} type="button">Cancel</button>
          <button onClick={handleSubmit} disabled={saving} className={PRIMARY_BUTTON_CLASS} type="button">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Pencil className="w-4 h-4" />}
            {saving ? 'Saving...' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatRepoDate(value?: string): string {
  if (!value) return 'Never';
  return new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function compactPath(path?: string): string {
  if (!path) return '';
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 3) return normalized;
  return `.../${parts.slice(-3).join('/')}`;
}

function repoRemote(repo: Repo): { href: string; label: string } | null {
  const remote = repo.detected?.remoteUrl;
  if (!remote) return null;
  const sshMatch = remote.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  const href = sshMatch ? `https://${sshMatch[1]}/${sshMatch[2]}` : remote.replace(/\.git$/, '');
  const label = remote.replace(/^git@([^:]+):/, '$1/').replace(/^https?:\/\//, '').replace(/\.git$/, '');
  return { href, label };
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (window.allenDesktop?.writeClipboardText) {
      return await window.allenDesktop.writeClipboardText(text);
    }
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function contextStatusLabel(status?: CogneeStatus): string {
  if (!status || status.status === 'pending') return 'context pending';
  if (status.status === 'partial') return 'context partial';
  if (status.status === 'stopped') return 'context stopped';
  if (status.status === 'failed') return 'context failed';
  if (status.status === 'running') {
    if (status.workerActive === false) return 'context interrupted';
    if (status.stage === 'pulling') return 'running: pulling';
    if (status.stage === 'collecting_curated_context' || status.stage === 'collecting_markdown') return 'running: collecting';
    if (status.stage === 'ingesting') return 'running: ingesting';
    if (status.stage === 'cognifying') return 'running: cognifying';
    return 'context running';
  }
  const count = status.documentCount ?? 0;
  return `${count} context docs`;
}

function cogneeStatusTitle(status?: CogneeStatus): string {
  if (!status) return 'Cognee context status';
  const progress = cogneeProgressLines(status);
  const uncognified = (status.uncognifiedDocuments ?? [])
    .slice(0, 5)
    .map((doc) => doc.path ?? doc.title ?? doc.cogneeDataId)
    .filter(Boolean)
    .map((value) => `Uncognified: ${value}`);
  const parts = [
    status.message,
    ...progress,
    ...uncognified,
    status.uncognifiedDocuments && status.uncognifiedDocuments.length > uncognified.length
      ? `Uncognified: +${status.uncognifiedDocuments.length - uncognified.length} more`
      : '',
    status.error,
    status.buildMode ? `Build mode: ${status.buildMode}` : '',
    status.previousDatasetName ? `Previous dataset: ${status.previousDatasetName}` : '',
    status.workerActive === undefined ? '' : `Live worker: ${status.workerActive ? 'yes' : 'no'}`,
    status.storageExisting === undefined ? '' : `Existing storage: ${status.storageExisting ? 'yes' : 'no'}`,
    status.datasetExisting === undefined ? '' : `Existing dataset: ${status.datasetExisting ? 'yes' : 'no'}`,
    status.storageRoot ? `Storage root: ${status.storageRoot}` : '',
    status.databasePath ? `Database path: ${status.databasePath}` : '',
    status.lastStartedAt ? `Started: ${new Date(status.lastStartedAt).toLocaleString()}` : '',
    status.lastCompletedAt ? `Completed: ${new Date(status.lastCompletedAt).toLocaleString()}` : '',
    status.updatedAt ? `Updated: ${new Date(status.updatedAt).toLocaleString()}` : '',
  ].filter(Boolean);
  return parts.join('\n') || 'Cognee context status';
}

function cogneeProgressLines(status?: CogneeStatus): string[] {
  if (!status) return [];
  const total = status.documentCount ?? status.candidateCount;
  if (!total) return [];
  const ingested = status.ingestedDocumentCount ?? (status.stage === 'ingesting' ? status.processedDocumentCount : undefined);
  const cognified = status.cognifiedDocumentCount ?? (status.stage === 'cognifying' ? status.processedDocumentCount : undefined);
  const lines: string[] = [];
  if (status.stage === 'ingesting' && status.documentsToIngestCount !== undefined) {
    lines.push(`Adding new/changed files: ${ingested ?? 0}/${status.documentsToIngestCount}`);
  } else if (ingested !== undefined) {
    lines.push(`${status.stage === 'cognifying' ? 'Total ingested' : 'Ingested'}: ${ingested}/${total}`);
  }
  if (cognified !== undefined) lines.push(`Cognified: ${cognified}/${total}`);
  return lines;
}

function cogneeVisibleMessage(status?: CogneeStatus): string | undefined {
  if (!status?.message) return undefined;
  return status.status === 'running' || status.status === 'partial' || status.status === 'failed' || status.status === 'stopped'
    ? status.message
    : undefined;
}

function CogneeProgress({ status }: { status?: CogneeStatus }) {
  const lines = cogneeProgressLines(status);
  const message = cogneeVisibleMessage(status);
  if (!message && !lines.length) return null;
  return (
    <div className="pl-11 space-y-1 text-[10.5px] font-mono text-theme-muted">
      {message && <div className="text-theme-secondary">{message}</div>}
      {lines.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {lines.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function isCogneeRunning(status?: CogneeStatus): boolean {
  return status?.status === 'running';
}

/* ── Main Page ──────────────────────────────────────────────────────────── */

export default function RepoManagerPage() {
  const [repoList, setRepoList] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [editRepo, setEditRepo] = useState<Repo | null>(null);
  const [scanningId, setScanningId] = useState<string | null>(null);
  const [cancelingScanId, setCancelingScanId] = useState<string | null>(null);
  const [pullingId, setPullingId] = useState<string | null>(null);
  const [cogneeStatusByRepo, setCogneeStatusByRepo] = useState<Record<string, CogneeStatus>>({});
  const [contextConfig, setContextConfig] = useState<ContextRuntimeConfig>({ enabled: false, provider: null, cogneeEnabled: false });
  const [deletingRepo, setDeletingRepo] = useState<{ id: string; name: string } | null>(null);
  const [configRepoId, setConfigRepoId] = useState<string | null>(null);
  const [wsCreateRepo, setWsCreateRepo] = useState<Repo | null>(null);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const navigate = useNavigate();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await repoApi.list();
      const runtime = await systemApi.runtimeConfig().catch(() => ({
        contextEngine: { enabled: false, provider: null, cogneeEnabled: false } as ContextRuntimeConfig,
      }));
      setContextConfig(runtime.contextEngine);
      setRepoList(list);
      if (runtime.contextEngine.cogneeEnabled) {
        const statusEntries = await Promise.all(list.map(async (repo: Repo) => {
          const status = await repoApi.getCogneeStatus(repo._id).catch(() => ({ status: 'pending', documentCount: 0 }));
          return [repo._id, status] as const;
        }));
        setCogneeStatusByRepo(Object.fromEntries(statusEntries));
      } else {
        setCogneeStatusByRepo({});
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!contextConfig.cogneeEnabled) return;
    const runningIds = Object.entries(cogneeStatusByRepo)
      .filter(([, status]) => isCogneeRunning(status))
      .map(([id]) => id);
    if (!runningIds.length) return;
    const timer = window.setInterval(() => {
      void Promise.all(runningIds.map(async (id) => {
        const status = await repoApi.getCogneeStatus(id).catch(() => null);
        if (!status) return null;
        return [id, status] as const;
      })).then((entries) => {
        setCogneeStatusByRepo(prev => ({
          ...prev,
          ...Object.fromEntries(entries.filter(Boolean) as Array<readonly [string, CogneeStatus]>),
        }));
      });
    }, 2000);
    return () => window.clearInterval(timer);
  }, [cogneeStatusByRepo, contextConfig.cogneeEnabled]);

  const handleDelete = async () => {
    if (!deletingRepo) return;
    await repoApi.delete(deletingRepo.id);
    setDeletingRepo(null);
    refresh();
  };

  const toast = useToast();

  const copyRepoPath = async (path: string) => {
    const ok = await copyText(path);
    if (!ok) return;
    setCopiedPath(path);
    window.setTimeout(() => setCopiedPath(current => current === path ? null : current), 1400);
  };

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

  const handleCancelScan = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setCancelingScanId(id);
    try {
      await repoApi.cancelScan(id);
      toast.success('Scan cancelled. You can run it again.');
      refresh();
    } catch (err: any) {
      toast.error(err.message ?? 'Cancel scan failed');
    }
    setCancelingScanId(null);
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
    <div className="content scroll-hide !p-0 bg-app" data-screen-label="repositories">
      <div className="w-full px-8 py-8">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-md border border-app bg-app-card text-theme-muted">
              <FolderGit2 className="h-[18px] w-[18px]" />
            </span>
            <div>
              <h1 className="text-[24px] font-semibold leading-tight text-theme-primary">Repositories</h1>
              <p className="mt-1 text-[13px] text-theme-muted">Local codebases Allen can inspect, scan, and dispatch work against.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <IconTooltipButton
              label="Refresh repositories"
              onClick={refresh}
              className="h-9 w-9 border border-app bg-app-card hover:border-app-strong"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            </IconTooltipButton>
            <button
              onClick={() => setAddOpen(true)}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-accent px-3 text-[13px] font-medium text-white transition-colors hover:bg-accent-hover"
              type="button"
            >
              <Plus className="w-3.5 h-3.5" /> Add repository
            </button>
          </div>
        </div>

        <section className="overflow-hidden rounded-md border border-app bg-app-card">
          {repoList.length > 0 && (
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-app bg-app-muted/25 px-4 py-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-theme-muted">
              <span>Repository</span>
              <span>Actions</span>
            </div>
          )}

          {loading ? (
            <div>
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="border-t border-app px-4 py-3 first:border-t-0">
                  <div className="flex items-center gap-4">
                    <div className="h-9 w-9 animate-pulse rounded-md bg-app-muted" />
                    <div className="min-w-0 flex-1">
                      <div className="h-4 w-48 animate-pulse rounded-md bg-app-muted" />
                      <div className="mt-2 h-3 w-80 animate-pulse rounded-md bg-app-muted" />
                    </div>
                    <div className="h-8 w-36 animate-pulse rounded-md bg-app-muted" />
                  </div>
                </div>
              ))}
            </div>
          ) : repoList.length === 0 ? (
            <div className="px-5 py-12 text-center">
              <FolderGit2 className="mx-auto h-8 w-8 text-theme-subtle" />
              <div className="mt-4 text-[15px] font-semibold text-theme-primary">No repositories yet</div>
              <p className="mt-1 text-[13px] text-theme-muted">Add a repository before creating workspaces or dispatching code tasks.</p>
              <button
                onClick={() => setAddOpen(true)}
                className="mt-5 inline-flex h-9 items-center gap-2 rounded-md bg-accent px-3 text-[13px] font-medium text-white transition-colors hover:bg-accent-hover"
                type="button"
              >
                <Plus className="w-3.5 h-3.5" /> Add repository
              </button>
            </div>
          ) : (
            <div className="divide-y divide-app">
            {repoList.map((repo) => {
              const hasRunningScan = repo.contextScan?.status === 'scanning';
              const isScanning = scanningId === repo._id;
              const isCancelingScan = cancelingScanId === repo._id;
              const isArchived = repo.status === 'archived';
              const cogneeStatus = contextConfig.cogneeEnabled ? cogneeStatusByRepo[repo._id] : undefined;
              const remote = repoRemote(repo);
              return (
                <div key={repo._id} className={`px-4 py-3 transition-colors hover:bg-app-muted/30 ${isArchived ? 'opacity-60' : ''}`}>
                  <div className="grid min-h-[68px] grid-cols-[minmax(0,1fr)_auto] items-center gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="truncate text-[14px] font-semibold text-theme-primary">{repo.name}</span>
                        <span className="inline-flex items-center gap-1 font-mono text-[11px] text-theme-muted">
                          <GitBranch className="h-3 w-3" />{repo.detected?.defaultBranch ?? 'main'}
                        </span>
                        {remote && (
                          <a href={remote.href} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} className="inline-flex max-w-[260px] items-center gap-1 truncate font-mono text-[11px] text-theme-muted transition-colors hover:text-accent">
                            <ExternalLink className="h-3 w-3 shrink-0" />
                            <span className="truncate">{remote.label}</span>
                          </a>
                        )}
                        {isArchived && <span className="rounded-md border border-app bg-app px-2 py-0.5 font-mono text-[10.5px] text-theme-muted">archived</span>}
                      </div>
                      {repo.description && <p className="mt-0.5 text-[12px] text-theme-muted">{repo.description}</p>}
                      {contextConfig.cogneeEnabled && (
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          <span className="inline-flex items-center gap-1 rounded-md border border-app bg-app px-1.5 py-0.5 font-mono text-[10px] leading-4 text-theme-secondary" title={cogneeStatusTitle(cogneeStatus)}>
                            <Sparkles className="h-3 w-3" />{contextStatusLabel(cogneeStatus)}
                          </span>
                        </div>
                      )}
                      <div className="mt-1 flex max-w-full items-center gap-1 font-mono text-[10.5px] leading-4 text-theme-subtle">
                        <span className="uppercase tracking-[0.12em] text-theme-subtle">local</span>
                        <span className="truncate text-theme-muted" title={repo.path}>{compactPath(repo.path)}</span>
                        <IconTooltipButton
                          label={copiedPath === repo.path ? 'Copied' : 'Copy repository path'}
                          side="top"
                          onClick={(event) => {
                            event.stopPropagation();
                            void copyRepoPath(repo.path);
                          }}
                          className="h-[18px] w-[18px] shrink-0 text-theme-muted hover:text-theme-primary"
                        >
                          {copiedPath === repo.path ? <Check className="h-3 w-3 text-accent-green" /> : <Copy className="h-3 w-3" />}
                        </IconTooltipButton>
                      </div>
                      {contextConfig.cogneeEnabled && <CogneeProgress status={cogneeStatus} />}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-2">
                      <div className="flex items-center gap-1">
                        {contextConfig.enabled && (
                          <button onClick={(e) => { e.stopPropagation(); navigate(`/repos/${repo._id}/context-management`); }} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-app bg-app px-2 text-[12px] font-medium text-theme-secondary transition-colors hover:border-app-strong hover:bg-app-muted hover:text-theme-primary" title="Open context management" type="button">
                            <FileText className="w-3 h-3" />
                            Context
                          </button>
                        )}
                        <IconTooltipButton label="New workspace" onClick={(e) => { e.stopPropagation(); setWsCreateRepo(repo); }} className={ROW_ICON_BUTTON_CLASS}>
                          <Monitor className="w-3 h-3" />
                        </IconTooltipButton>
                        <IconTooltipButton label="Pull latest" onClick={(e) => handlePull(e, repo._id)} disabled={pullingId === repo._id} className={ROW_ICON_BUTTON_CLASS}>
                          {pullingId === repo._id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                        </IconTooltipButton>
                        {hasRunningScan ? (
                          <IconTooltipButton label="Cancel scan" tone="danger" onClick={(e) => handleCancelScan(e, repo._id)} disabled={isCancelingScan} className={ROW_DANGER_ICON_BUTTON_CLASS}>
                            {isCancelingScan ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
                          </IconTooltipButton>
                        ) : (
                          <IconTooltipButton label="Scan repository" onClick={(e) => handleScan(e, repo._id)} disabled={isScanning} className={ROW_ICON_BUTTON_CLASS}>
                            {isScanning ? <Loader2 className="w-3 h-3 animate-spin" /> : <ScanSearch className="w-3 h-3" />}
                          </IconTooltipButton>
                        )}
                        <IconTooltipButton label="Workspace config" onClick={(e) => { e.stopPropagation(); setConfigRepoId(repo._id); }} className={ROW_ICON_BUTTON_CLASS}>
                          <Settings className="w-3 h-3" />
                        </IconTooltipButton>
                        <IconTooltipButton label="Edit repository" onClick={(e) => { e.stopPropagation(); setEditRepo(repo); }} className={ROW_ICON_BUTTON_CLASS}>
                          <Pencil className="w-3 h-3" />
                        </IconTooltipButton>
                        <IconTooltipButton label="Delete repository" tone="danger" onClick={(e) => { e.stopPropagation(); setDeletingRepo({ id: repo._id, name: repo.name }); }} className={ROW_DANGER_ICON_BUTTON_CLASS}>
                          <Trash2 className="w-3 h-3" />
                        </IconTooltipButton>
                      </div>
                      <span className="font-mono text-[10px] leading-4 text-theme-subtle">updated {formatRepoDate(repo.updatedAt)}</span>
                    </div>
                  </div>
                </div>
              );
            })}
            </div>
          )}
        </section>

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
        {wsCreateRepo && <QuickWorkspaceDialog repo={wsCreateRepo} onClose={() => setWsCreateRepo(null)} onCreated={(id) => { setWsCreateRepo(null); navigate(workspaceChatPath(id)); }} />}
      </div>
    </div>
  );
}

function QuickWorkspaceDialog({ repo, onClose, onCreated }: { repo: Repo; onClose: () => void; onCreated: (id: string) => void }) {
  const [branch, setBranch] = useState('');
  const [baseBranch, setBaseBranch] = useState(workspaceCreateBaseBranch(repo));
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState('');

  async function handleCreate() {
    if (!branch.trim() || !name.trim()) { setError('Branch and name required'); return; }
    setCreating(true); setError('');
    try {
      const ws = await wsApi.create({ repoId: repo._id, repoName: repo.name, repoPath: repo.path, branch: branch.trim(), baseBranch: baseBranch.trim() || workspaceCreateBaseBranch(repo), name: name.trim() });
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
    <div className={DIALOG_BACKDROP_CLASS} onClick={onClose} role="dialog" aria-modal="true">
      <div className={`w-full max-w-[520px] ${DIALOG_PANEL_CLASS}`} onClick={e => e.stopPropagation()}>
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
            <label className={FORM_LABEL_CLASS}>Workspace Name</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="feature/my-feature" className={FORM_INPUT_CLASS} autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={FORM_LABEL_CLASS}>Branch</label>
              <input value={branch} onChange={e => setBranch(e.target.value)} placeholder="feature/new-thing" className={`${FORM_INPUT_CLASS} font-mono`} />
            </div>
            <div>
              <label className={FORM_LABEL_CLASS}>Base Branch</label>
              <input value={baseBranch} onChange={e => setBaseBranch(e.target.value)} className={`${FORM_INPUT_CLASS} font-mono`} />
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-3 border-t border-app px-6 py-4">
          <button onClick={onClose} className={SECONDARY_BUTTON_CLASS} type="button">Cancel</button>
          <button onClick={handleCreate} disabled={creating} className={PRIMARY_BUTTON_CLASS} type="button">
            {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Monitor className="w-4 h-4" />}
            {creating ? 'Creating...' : 'Create workspace'}
          </button>
        </div>
      </div>
    </div>
  );
}
