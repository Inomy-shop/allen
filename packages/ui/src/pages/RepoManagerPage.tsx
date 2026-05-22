import { useState, useEffect, useCallback } from 'react';
import { repos as repoApi, workflows as wfApi, system as systemApi } from '../services/api';
import DeleteConfirmDialog from '../components/common/DeleteConfirmDialog';
import {
  FolderGit2, Plus, RefreshCw, Trash2, Pencil, ScanSearch, X,
  GitBranch, Package, Code2, Sparkles, ExternalLink, Loader2, Settings, Monitor, FileText, Download, BookOpenCheck,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { renderMarkdown } from '../components/chat/ChatMessageList';
import { WorkspaceConfigEditor } from '../components/workspace/WorkspaceConfigEditor';
import { workspaces as wsApi } from '../services/workspaceService';
import { SetupProgressDialog } from '../components/workspace/SetupProgressDialog';
import { useToast } from '../components/common/Toast';

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

type ContextCurationProfile = {
  profileId?: string;
  status?: 'running' | 'completed' | 'failed' | 'stopped';
  message?: string;
  branch?: string;
  headSha?: string;
  curationVersion?: number;
  promptVersion?: number;
  stats?: Record<string, number>;
  diagnostics?: Array<Record<string, any>>;
  entries?: Array<Record<string, any>>;
  error?: string;
  executionId?: string;
  durationMs?: number;
  costUsd?: number;
  createdAt?: string;
  completedAt?: string;
  updatedAt?: string;
};

type ContextManagementState = {
  entries?: Array<Record<string, any>>;
  curationStats?: { active?: number; total?: number; excluded?: number; stale?: number };
  mandatoryMappings?: Array<Record<string, any>>;
  agents?: Array<Record<string, any>>;
  cogneeStatus?: CogneeStatus | null;
  graph?: {
    source?: string;
    nodes?: Array<Record<string, any>>;
    edges?: Array<Record<string, any>>;
    nodeCount?: number;
    edgeCount?: number;
    previewNodeCount?: number;
    previewEdgeCount?: number;
    nodeTypeCounts?: Array<Record<string, any>>;
    relationshipCounts?: Array<Record<string, any>>;
    limited?: boolean;
    error?: string;
  };
};

const CURRENT_COGNEE_INGEST_FORMAT = 'curated_context_entry_v1';

/* ── Add Dialog ─────────────────────────────────────────────────────────── */

function AddRepoDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [url, setUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    if (!url.trim()) { setError('Repository URL is required'); return; }
    setSaving(true);
    setError('');
    try {
      await repoApi.clone({
        url: url.trim(),
        branch: branch.trim() || 'main',
        name: name.trim() || undefined,
        description: description.trim() || undefined,
        tags: tags.trim() ? tags.split(',').map(t => t.trim()).filter(Boolean) : [],
      });
      setUrl(''); setBranch('main'); setName(''); setDescription(''); setTags('');
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
      <div className="card w-full max-w-lg overflow-hidden shadow-popover animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="px-6 py-5 border-b border-app">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-sm bg-accent-soft flex items-center justify-center">
                <Plus className="w-5 h-5 text-accent-blue" />
              </div>
              <div>
                <h2 className="text-[14px] font-semibold text-theme-primary tracking-tight">Add Repository</h2>
                <p className="text-[11px] text-theme-muted font-mono">Clone from GitHub &middot; auto-detects language, framework</p>
              </div>
            </div>
            <button onClick={onClose} className="p-2 rounded-sm hover:bg-surface-200 text-theme-muted hover:text-theme-secondary transition-colors" title="Close">
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
            <label className="flex items-center gap-1 text-xs font-label font-semibold text-theme-secondary mb-2 uppercase tracking-widest">
              Repository URL <span className="text-accent-red normal-case text-[10px]">*</span>
            </label>
            <input type="text" value={url} onChange={e => setUrl(e.target.value)}
              placeholder="https://github.com/owner/repo or git@github.com:owner/repo.git" className="input w-full font-mono text-sm" />
            <p className="text-[10px] text-theme-muted mt-1">HTTPS or SSH URL. Clones via SSH into the Allen repositories directory (default: ~/.allen/repositories/&lt;repo-name&gt;).</p>
          </div>
          <div>
            <label className="flex items-center gap-1 text-xs font-label font-semibold text-theme-secondary mb-2 uppercase tracking-widest">
              Branch <span className="text-accent-red normal-case text-[10px]">*</span>
            </label>
            <input type="text" value={branch} onChange={e => setBranch(e.target.value)}
              placeholder="main" className="input w-full font-mono text-sm" />
            <p className="text-[10px] text-theme-muted mt-1">Branch to checkout after cloning. Scanning runs on this branch.</p>
          </div>
          <div>
            <label className="text-xs font-label font-semibold text-theme-secondary mb-2 uppercase tracking-widest block">Name</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)}
              placeholder="Auto-derived from repo name" className="input w-full text-sm" />
          </div>
          <div>
            <label className="text-xs font-label font-semibold text-theme-secondary mb-2 uppercase tracking-widest block">Description</label>
            <input type="text" value={description} onChange={e => setDescription(e.target.value)}
              placeholder="Brief description" className="input w-full text-sm" />
          </div>
          <div>
            <label className="text-xs font-label font-semibold text-theme-secondary mb-2 uppercase tracking-widest block">Tags</label>
            <input type="text" value={tags} onChange={e => setTags(e.target.value)}
              placeholder="Comma-separated, e.g. backend, api" className="input w-full text-sm font-mono" />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center gap-3 px-6 py-5 border-t border-app bg-app-card/50">
          <button onClick={onClose} className="flex-1 btn-ghost">Cancel</button>
          <button onClick={handleSubmit} disabled={saving} className="flex-1 btn-primary inline-flex items-center justify-center gap-2">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <FolderGit2 className="w-4 h-4" />}
            {saving ? 'Cloning...' : 'Clone & Add'}
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
      <div className="card w-full max-w-lg overflow-hidden shadow-popover animate-in fade-in zoom-in-95 duration-200">
        <div className="px-6 py-5 border-b border-app">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-sm bg-accent-soft flex items-center justify-center">
                <Pencil className="w-5 h-5 text-accent-blue" />
              </div>
              <div>
                <h2 className="text-[14px] font-semibold text-theme-primary tracking-tight">Edit Repository</h2>
                <p className="text-[11px] text-theme-muted font-mono">{repo.path}</p>
              </div>
            </div>
            <button onClick={onClose} className="p-2 rounded-sm hover:bg-surface-200 text-theme-muted hover:text-theme-secondary transition-colors" title="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="px-6 py-5 space-y-4 max-h-[50vh] overflow-auto">
          {error && (
            <div className="text-xs text-accent-red bg-accent-red/10 border border-accent-red/20 rounded-sm px-3 py-2">{error}</div>
          )}
          <div>
            <label className="text-xs font-label font-semibold text-theme-secondary mb-2 uppercase tracking-widest block">Name</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)} className="input w-full text-sm" />
          </div>
          <div>
            <label className="text-xs font-label font-semibold text-theme-secondary mb-2 uppercase tracking-widest block">Description</label>
            <input type="text" value={description} onChange={e => setDescription(e.target.value)} className="input w-full text-sm" />
          </div>
          <div>
            <label className="text-xs font-label font-semibold text-theme-secondary mb-2 uppercase tracking-widest block">Tags</label>
            <input type="text" value={tags} onChange={e => setTags(e.target.value)}
              placeholder="Comma-separated" className="input w-full text-sm font-mono" />
          </div>
          <div>
            <label className="text-xs font-label font-semibold text-theme-secondary mb-2 uppercase tracking-widest block">Context</label>
            <textarea value={context} onChange={e => setContext(e.target.value)}
              rows={3} className="input w-full text-sm resize-none" placeholder="Brief context for chat agent" />
          </div>
          <div>
            <label className="text-xs font-label font-semibold text-theme-secondary mb-2 uppercase tracking-widest block">Default Workflow</label>
            <select value={defaultWorkflow} onChange={e => setDefaultWorkflow(e.target.value)} className="input w-full text-sm">
              <option value="">None</option>
              {workflows.map((wf: any) => (
                <option key={wf._id} value={wf.name}>{wf.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-label font-semibold text-theme-secondary mb-2 uppercase tracking-widest block">Status</label>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="status" value="active" checked={status === 'active'}
                  onChange={() => setStatus('active')} className="accent-accent-blue" />
                <span className="text-sm text-theme-secondary">Active</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="status" value="archived" checked={status === 'archived'}
                  onChange={() => setStatus('archived')} className="accent-gray-500" />
                <span className="text-sm text-theme-secondary">Archived</span>
              </label>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 px-6 py-5 border-t border-app bg-app-card/50">
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

// v2 single-accent rule: language/framework chips render as monochrome
// muted chips. Distinguishing color is reserved for run-state pills.
const langColors: Record<string, string> = {};
const fwColors: Record<string, string> = {};

function Badge({ label, colorClass }: { label: string; colorClass?: string }) {
  // colorClass arg kept for callers but the v2 chip is always neutral.
  void colorClass;
  return (
    <span className="text-[10.5px] px-1.5 py-0.5 rounded font-mono bg-app-muted text-theme-secondary">
      {label}
    </span>
  );
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
  const [pullingId, setPullingId] = useState<string | null>(null);
  const [cogneeStatusByRepo, setCogneeStatusByRepo] = useState<Record<string, CogneeStatus>>({});
  const [contextConfig, setContextConfig] = useState<ContextRuntimeConfig>({ enabled: false, provider: null, cogneeEnabled: false });
  const [deletingRepo, setDeletingRepo] = useState<{ id: string; name: string } | null>(null);
  const [configRepoId, setConfigRepoId] = useState<string | null>(null);
  const [wsCreateRepo, setWsCreateRepo] = useState<Repo | null>(null);
  const [contextRepo, setContextRepo] = useState<Repo | null>(null);
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
    <div className="px-6 pt-5 pb-8">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 mb-2 text-[12px] text-theme-muted">
        <span>Code</span>
        <span className="text-theme-subtle">/</span>
        <span>Repositories</span>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <h1 className="text-[20px] font-semibold text-theme-primary tracking-tight">Repositories</h1>
          <span className="text-[12px] font-mono text-theme-muted">{repoList.length}</span>
        </div>
        <div className="flex items-center gap-2">
          <button title="Refresh" onClick={refresh} className="btn btn-secondary btn-sm">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => setAddOpen(true)} className="btn btn-primary btn-sm">
            <Plus className="w-3.5 h-3.5" /> Add repo
          </button>
        </div>
      </div>

      {/* Loading */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="card p-4 animate-pulse">
              <div className="h-5 w-32 bg-app-muted rounded mb-3" />
              <div className="h-3 w-48 bg-app-muted rounded mb-4" />
              <div className="flex gap-2 mb-3">
                <div className="h-4 w-16 bg-app-muted rounded" />
                <div className="h-4 w-16 bg-app-muted rounded" />
              </div>
              <div className="h-3 w-full bg-app-muted rounded" />
            </div>
          ))}
        </div>
      ) : repoList.length === 0 ? (
        <div className="text-center py-16">
          <div className="w-14 h-14 rounded-xl bg-accent-soft flex items-center justify-center mx-auto mb-5">
            <FolderGit2 className="w-6 h-6 text-accent" />
          </div>
          <p className="text-[14px] text-theme-primary font-body mb-1">No repositories yet</p>
          <p className="text-[12px] text-theme-muted font-body mb-6">Add one to get started.</p>
          <button onClick={() => setAddOpen(true)} className="btn btn-primary">
            <Plus className="w-3.5 h-3.5" /> Add repository
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {repoList.map((repo) => {
            const isScanning = scanningId === repo._id;
            const isArchived = repo.status === 'archived';
            const cogneeStatus = contextConfig.cogneeEnabled ? cogneeStatusByRepo[repo._id] : undefined;
            return (
              <div key={repo._id} className={`card-hover p-4 group flex flex-col gap-2 ${isArchived ? 'opacity-50' : ''}`}>
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-md bg-app-muted flex items-center justify-center shrink-0">
                    <FolderGit2 className="w-4 h-4 text-accent" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[14px] font-medium text-theme-primary truncate">{repo.name}</span>
                      {isArchived && <span className="badge badge-muted">archived</span>}
                      {repo.executionCount > 0 && (
                        <span className="text-[11px] font-mono text-theme-muted">· {repo.executionCount} runs</span>
                      )}
                    </div>
                    {repo.description && (
                      <p className="text-[12px] text-theme-muted mt-0.5 truncate">{repo.description}</p>
                    )}
                  </div>
                  <span className="dot dot-ok shrink-0 mt-1" />
                </div>

                {/* Tags row */}
                {(repo.detected?.language?.length || repo.detected?.framework?.length) ? (
                  <div className="flex items-center gap-1.5 flex-wrap pl-11">
                    {repo.detected?.language?.filter(l => l !== 'unknown').map(lang => (
                      <Badge key={lang} label={lang} colorClass={langColors[lang]} />
                    ))}
                    {repo.detected?.framework?.map(fw => (
                      <Badge key={fw} label={fw} colorClass={fwColors[fw]} />
                    ))}
                  </div>
                ) : null}

                {/* Meta row */}
                <div className="flex items-center gap-3 text-[11px] text-theme-muted font-mono pl-11 flex-wrap">
                  <span className="flex items-center gap-1">
                    <GitBranch className="w-3 h-3" />{repo.detected?.defaultBranch ?? 'main'}
                  </span>
                  {contextConfig.cogneeEnabled && (
                    <span className="flex items-center gap-1" title={cogneeStatusTitle(cogneeStatus)}>
                      <Sparkles className="w-3 h-3" />
                      {contextStatusLabel(cogneeStatus)}
                    </span>
                  )}
                  {repo.detected?.remoteUrl && (() => {
                    const sshMatch = repo.detected.remoteUrl.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
                    const httpsUrl = sshMatch ? `https://${sshMatch[1]}/${sshMatch[2]}` : repo.detected.remoteUrl.replace(/\.git$/, '');
                    const display = repo.detected.remoteUrl.replace(/^git@([^:]+):/, '$1/').replace(/^https?:\/\//, '').replace(/\.git$/, '');
                    return (
                      <a href={httpsUrl} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} className="flex items-center gap-1 truncate max-w-[260px] hover:text-accent transition-colors">
                        <ExternalLink className="w-3 h-3 shrink-0" />
                        {display}
                      </a>
                    );
                  })()}
                </div>
                {contextConfig.cogneeEnabled && <CogneeProgress status={cogneeStatus} />}

                {/* Actions row — always visible, ghost icons */}
                <div className="flex items-center gap-0.5 pl-11 -ml-1 mt-auto">
                  {contextConfig.enabled && (
                    <button onClick={(e) => { e.stopPropagation(); navigate(`/repos/${repo._id}/context-management`); }} className="btn btn-ghost btn-sm ml-1" title="Open Context Management">
                      <FileText className="w-3.5 h-3.5" />
                      Context Management
                    </button>
                  )}
                  <button onClick={(e) => { e.stopPropagation(); setWsCreateRepo(repo); }} className="p-1.5 rounded text-theme-muted hover:text-accent-green hover:bg-app-muted transition-colors" title="New Workspace">
                    <Monitor className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={(e) => handlePull(e, repo._id)} disabled={pullingId === repo._id} className="p-1.5 rounded text-theme-muted hover:text-theme-primary hover:bg-app-muted transition-colors" title="Pull Latest">
                    {pullingId === repo._id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                  </button>
                  <button onClick={(e) => handleScan(e, repo._id)} disabled={isScanning} className="p-1.5 rounded text-theme-muted hover:text-theme-primary hover:bg-app-muted transition-colors" title="Scan">
                    {isScanning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ScanSearch className="w-3.5 h-3.5" />}
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); setConfigRepoId(repo._id); }} className="p-1.5 rounded text-theme-muted hover:text-theme-primary hover:bg-app-muted transition-colors" title="Workspace Config">
                    <Settings className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => setEditRepo(repo)} className="p-1.5 rounded text-theme-muted hover:text-theme-primary hover:bg-app-muted transition-colors" title="Edit">
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); setDeletingRepo({ id: repo._id, name: repo.name }); }} className="p-1.5 rounded text-theme-muted hover:text-accent-red hover:bg-accent-red/10 transition-colors ml-auto" title="Delete">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
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
      {configRepoId && <WorkspaceConfigEditor repoId={configRepoId} onClose={() => setConfigRepoId(null)} />}
      {wsCreateRepo && <QuickWorkspaceDialog repo={wsCreateRepo} onClose={() => setWsCreateRepo(null)} onCreated={(id) => { setWsCreateRepo(null); navigate(`/workspaces/${id}`); }} />}
      {contextRepo && contextConfig.enabled && (
        <RepoContextViewer
          repoId={contextRepo._id}
          repoName={contextRepo.name}
          contextProvider={contextConfig.provider}
          onClose={() => setContextRepo(null)}
        />
      )}
    </div>
  );
}

/* ── Repo Context Viewer ──────────────────────────────────────────────── */

function RepoContextViewer({
  repoId,
  repoName,
  contextProvider,
  onClose,
}: {
  repoId: string;
  repoName: string;
  contextProvider: ContextRuntimeConfig['provider'];
  onClose: () => void;
}) {
  const [context, setContext] = useState<any>(null);
  const [curation, setCuration] = useState<ContextCurationProfile | null>(null);
  const [management, setManagement] = useState<ContextManagementState | null>(null);
  const [activeTab, setActiveTab] = useState<'summary' | 'curation' | 'management'>('curation');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [rescanning, setRescanning] = useState(false);
  const [curating, setCurating] = useState(false);
  const toast = useToast();
  const graphContextEnabled = contextProvider === 'allen';

  const loadContext = useCallback(() => {
    setLoading(true);
    setError('');
    Promise.all([
      graphContextEnabled ? repoApi.context(repoId).catch((err) => ({ __error: err.message ?? 'Failed to load context' })) : Promise.resolve(null),
      repoApi.getContextCuration(repoId).catch(() => null),
      repoApi.getContextManagement(repoId).catch(() => null),
    ])
      .then(([ctx, curationProfile, managementState]) => {
        if ((ctx as any)?.__error) setError((ctx as any).__error);
        else setContext(ctx);
        setCuration(curationProfile);
        setManagement(managementState);
      })
      .finally(() => setLoading(false));
  }, [repoId, graphContextEnabled]);

  useEffect(() => {
    loadContext();
  }, [loadContext]);

  useEffect(() => {
    if (curation?.status !== 'running') return;
    const timer = window.setInterval(() => {
      repoApi.getContextCuration(repoId).then(setCuration).catch(() => {});
    }, 2000);
    return () => window.clearInterval(timer);
  }, [repoId, curation?.status]);

  const handleRescan = async () => {
    setRescanning(true);
    try {
      await repoApi.rescanContext(repoId);
      toast.success('Deep scan started — this runs in the background and may take a few minutes.');
    } catch (err: any) {
      toast.error(err.message ?? 'Failed to start rescan');
    } finally {
      setRescanning(false);
    }
  };

  const handleCurate = async () => {
    setCurating(true);
    try {
      const profile = await repoApi.refreshContextCuration(repoId);
      setCuration(profile);
      setActiveTab('curation');
      if (profile.status === 'completed') toast.success(profile.message ?? 'Context curation is up to date.');
      else toast.info(profile.message ?? 'Context curation started.');
    } catch (err: any) {
      toast.error(err.message ?? 'Failed to start context curation');
    } finally {
      setCurating(false);
    }
  };

  const handleStopCuration = async () => {
    setCurating(true);
    try {
      const profile = await repoApi.stopContextCuration(repoId);
      setCuration(profile);
      toast.info(profile.message ?? 'Context curation stopped.');
    } catch (err: any) {
      toast.error(err.message ?? 'Failed to stop context curation');
    } finally {
      setCurating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md" onClick={onClose}>
      <div className="card w-full max-w-4xl max-h-[90vh] overflow-hidden shadow-popover animate-in fade-in zoom-in-95 duration-200 flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="px-6 py-4 border-b border-app shrink-0 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <FileText className="w-5 h-5 text-accent-blue" />
            <div>
              <h2 className="text-[14px] font-semibold text-theme-primary tracking-tight">Repo Context</h2>
              <p className="text-[10px] text-theme-muted font-mono">{repoName} — agent-generated codebase analysis</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {graphContextEnabled && (
              <button onClick={handleRescan} disabled={rescanning} className="btn-ghost text-xs inline-flex items-center gap-1" title="Trigger a fresh deep scan">
                {rescanning ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                Rescan
              </button>
            )}
            {curation?.status === 'running' ? (
              <button onClick={handleStopCuration} disabled={curating} className="btn-ghost text-xs inline-flex items-center gap-1" title="Stop active curation">
                {curating ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
                Stop curation
              </button>
            ) : (
              <button onClick={handleCurate} disabled={curating} className="btn-ghost text-xs inline-flex items-center gap-1" title="Incrementally curate context metadata">
                {curating ? <Loader2 className="w-3 h-3 animate-spin" /> : <BookOpenCheck className="w-3 h-3" />}
                Curate
              </button>
            )}
            <button onClick={onClose} className="p-2 rounded-sm hover:bg-surface-200 text-theme-muted hover:text-theme-secondary transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="px-6 pt-3 border-b border-app flex gap-1 shrink-0">
          <button onClick={() => setActiveTab('curation')} className={`px-3 py-2 text-xs rounded-t ${activeTab === 'curation' ? 'bg-app-muted text-theme-primary' : 'text-theme-muted hover:text-theme-primary'}`}>
            Curation
          </button>
          <button onClick={() => setActiveTab('management')} className={`px-3 py-2 text-xs rounded-t ${activeTab === 'management' ? 'bg-app-muted text-theme-primary' : 'text-theme-muted hover:text-theme-primary'}`}>
            Management
          </button>
          {graphContextEnabled && (
            <button onClick={() => setActiveTab('summary')} className={`px-3 py-2 text-xs rounded-t ${activeTab === 'summary' ? 'bg-app-muted text-theme-primary' : 'text-theme-muted hover:text-theme-primary'}`}>
              Repo Summary
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {loading ? (
            <div className="text-xs text-theme-muted animate-pulse">Loading context...</div>
          ) : activeTab === 'curation' ? (
            <CurationPanel profile={curation} onCurate={handleCurate} curating={curating} />
          ) : activeTab === 'management' ? (
            <ContextManagementPanel repoId={repoId} state={management} onReload={loadContext} />
          ) : error ? (
            <div className="space-y-3">
              <div className="text-xs text-theme-muted">{error}</div>
              <p className="text-[11px] text-theme-subtle">
                No repo summary is available yet. Click "Rescan" to trigger a deep scan — the repo-scanner agent will explore the codebase and generate a comprehensive analysis. This runs in the background and typically takes 2-5 minutes.
              </p>
              <button onClick={handleRescan} disabled={rescanning} className="btn-primary text-xs inline-flex items-center gap-1.5">
                {rescanning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ScanSearch className="w-3.5 h-3.5" />}
                {rescanning ? 'Starting...' : 'Generate Context'}
              </button>
            </div>
          ) : context?.contextMarkdown ? (
            <div className="space-y-3">
              {/* Metadata bar */}
              <div className="flex items-center gap-4 text-[10px] text-theme-muted font-mono flex-wrap">
                {context.branch && <span>Branch: <span className="text-theme-secondary">{context.branch}</span></span>}
                {context.headSha && <span>SHA: <span className="text-theme-secondary">{context.headSha?.slice(0, 8)}</span></span>}
                {context.scannedAt && <span>Scanned: <span className="text-theme-secondary">{new Date(context.scannedAt).toLocaleString()}</span></span>}
                {context.scanDurationMs && <span>Duration: <span className="text-theme-secondary">{(context.scanDurationMs / 1000).toFixed(1)}s</span></span>}
                {context.scanCostUsd != null && <span>Cost: <span className="text-theme-secondary">${context.scanCostUsd.toFixed(4)}</span></span>}
              </div>
              {/* Rendered markdown */}
              <div className="prose-allen text-sm text-theme-secondary leading-relaxed">
                {renderMarkdown(context.contextMarkdown)}
              </div>
            </div>
          ) : (
            <div className="text-xs text-theme-muted">Context exists but is empty. Try rescanning.</div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-app bg-app-card/50 shrink-0">
          <button onClick={onClose} className="btn-ghost text-xs">Close</button>
        </div>
      </div>
    </div>
  );
}

function CurationPanel({ profile, onCurate, curating }: { profile: ContextCurationProfile | null; onCurate: () => void; curating: boolean }) {
  if (!profile) {
    return (
      <div className="space-y-3">
        <div className="text-xs text-theme-muted">No context curation profile exists yet.</div>
        <button onClick={onCurate} disabled={curating} className="btn-primary text-xs inline-flex items-center gap-1.5">
          {curating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BookOpenCheck className="w-3.5 h-3.5" />}
          {curating ? 'Starting...' : 'Curate context'}
        </button>
      </div>
    );
  }
  const stats = profile.stats ?? {};
  const entries = profile.entries ?? [];
  const excluded = entries.filter(e => e.inclusion === 'exclude' || e.inclusion === 'stale' || e.injectionPolicy === 'never_full_auto');
  const visibleEntries = entries.filter(e => e.inclusion === 'include').slice(0, 80);
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 text-[10px] text-theme-muted font-mono flex-wrap">
        <span>Status: <span className="text-theme-secondary">{profile.status}</span></span>
        {profile.branch && <span>Branch: <span className="text-theme-secondary">{profile.branch}</span></span>}
        {profile.headSha && <span>SHA: <span className="text-theme-secondary">{profile.headSha.slice(0, 8)}</span></span>}
        {profile.curationVersion != null && <span>Version: <span className="text-theme-secondary">{profile.curationVersion}.{profile.promptVersion}</span></span>}
        {profile.durationMs != null && <span>Duration: <span className="text-theme-secondary">{(profile.durationMs / 1000).toFixed(1)}s</span></span>}
      </div>
      {profile.message && <div className="text-xs text-theme-muted">{profile.message}</div>}
      {profile.error && <div className="text-xs text-accent-red">{profile.error}</div>}
      {profile.status === 'running' && <div className="text-xs text-theme-muted animate-pulse">Curator is processing changed context files...</div>}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {[
          ['Candidates', stats.candidateFiles],
          ['Reused', stats.reusedFiles],
          ['Changed', stats.newOrChangedFiles],
          ['Chunks', stats.generatedChunks],
          ['Included', stats.includedEntries],
          ['Excluded', stats.excludedEntries],
          ['Stale', stats.staleEntries],
          ['Entries', stats.totalEntries],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded border border-app bg-app-card/60 p-2">
            <div className="text-[10px] text-theme-muted uppercase tracking-wide">{label}</div>
            <div className="text-sm text-theme-primary font-mono">{Number(value ?? 0)}</div>
          </div>
        ))}
      </div>

      <CurationSection title="Curated Retrieval References" entries={visibleEntries} empty="No included entries." />
      <CurationSection title="Excluded / Stale / Never Auto Inject" entries={excluded.slice(0, 80)} empty="No excluded entries." />

      {profile.diagnostics?.length ? (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold text-theme-primary">Diagnostics</h3>
          <div className="space-y-1">
            {profile.diagnostics.slice(0, 50).map((d, i) => (
              <div key={i} className="text-[11px] text-theme-muted border border-app rounded p-2">
                <span className="font-mono text-theme-secondary">{String(d.code ?? 'diagnostic')}</span>
                <span className="mx-1">·</span>
                <span>{String(d.message ?? '')}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CurationSection({ title, entries, empty }: { title: string; entries: Array<Record<string, any>>; empty: string }) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold text-theme-primary">{title}</h3>
      {entries.length ? (
        <div className="space-y-1.5">
          {entries.map((entry, i) => (
            <div key={`${entry.entryId ?? entry.path ?? i}`} className="border border-app rounded p-2 bg-app-card/40">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-xs text-theme-primary truncate">{entry.title ?? entry.path}</span>
                <span className="text-[10px] text-theme-subtle font-mono shrink-0">{entry.category ?? 'doc'}</span>
                <span className="text-[10px] text-theme-subtle font-mono shrink-0">{entry.injectionPolicy ?? 'manifest_only'}</span>
                {entry.reused && <span className="text-[10px] text-accent-green font-mono shrink-0">reused</span>}
              </div>
              <div className="text-[10px] text-theme-muted font-mono truncate">{entry.path}</div>
              {entry.summary && <div className="text-[11px] text-theme-muted mt-1">{entry.summary}</div>}
              {entry.curatedContext && (
                <pre className="text-[11px] text-theme-primary whitespace-pre-wrap max-h-48 overflow-auto border border-app rounded bg-app-muted/30 p-2 mt-2">
                  {entry.curatedContext}
                </pre>
              )}
              {entry.chunks?.length ? (
                <div className="space-y-1 mt-2">
                  {entry.chunks.slice(0, 5).map((chunk: Record<string, any>, idx: number) => (
                    <div key={`${chunk.chunkId ?? idx}`} className="border border-app rounded p-2">
                      <div className="text-[10px] text-theme-secondary font-mono">{chunk.heading ?? chunk.chunkId ?? `chunk-${idx + 1}`}</div>
                      <div className="text-[11px] text-theme-muted whitespace-pre-wrap mt-1">{chunk.text}</div>
                    </div>
                  ))}
                </div>
              ) : null}
              {entry.reasoning && <div className="text-[10px] text-theme-subtle mt-1">{entry.reasoning}</div>}
            </div>
          ))}
        </div>
      ) : (
        <div className="text-xs text-theme-muted">{empty}</div>
      )}
    </div>
  );
}

function ContextManagementPanel({ repoId, state, onReload }: { repoId: string; state: ContextManagementState | null; onReload: () => void }) {
  const agents = state?.agents ?? [];
  const entries = state?.entries ?? [];
  const mappings = state?.mandatoryMappings ?? [];
  const curationStats = state?.curationStats ?? {};
  const activeCuratedCount = Number(curationStats.active ?? entries.length);
  const cogneeStatus = state?.cogneeStatus;
  const cogneeStatusValue = cogneeStatus?.status
    ? cogneeStatus.status
    : 'none';
  const [selectedAgent, setSelectedAgent] = useState('');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [query, setQuery] = useState('');
  const [searchResult, setSearchResult] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [searching, setSearching] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const toast = useToast();
  const activeAgent = selectedAgent || String(agents[0]?.name ?? '');
  const visibleMappings = activeAgent ? mappings.filter(m => m.agentName === activeAgent) : mappings;

  const handleSaveNew = async () => {
    if (!activeAgent || !content.trim()) return;
    setSaving(true);
    try {
      await repoApi.saveMandatoryContext(repoId, { agentName: activeAgent, title: title.trim() || 'Manual mandatory context', content, sourceType: 'user_added', enabled: true });
      setTitle('');
      setContent('');
      await onReload();
      toast.success('Mandatory context saved.');
    } catch (err: any) {
      toast.error(err.message ?? 'Failed to save mandatory context');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveExisting = async (mapping: Record<string, any>) => {
    const mappingId = String(mapping.mappingId ?? '');
    if (!mappingId) return;
    setSaving(true);
    try {
      await repoApi.updateMandatoryContext(repoId, mappingId, { content: drafts[mappingId] ?? mapping.content ?? '', enabled: mapping.enabled !== false });
      await onReload();
      toast.success('Mandatory context updated.');
    } catch (err: any) {
      toast.error(err.message ?? 'Failed to update mandatory context');
    } finally {
      setSaving(false);
    }
  };

  const handleSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    try {
      setSearchResult(await repoApi.searchContextManagement(repoId, query, activeAgent));
    } catch (err: any) {
      toast.error(err.message ?? 'Context search failed');
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Metric label="Curated" value={activeCuratedCount} />
        <Metric label="Mandatory" value={mappings.length} />
        <Metric label="Agents" value={agents.length} />
        <Metric label="Cognee" value={cogneeStatusValue} />
      </div>
      {curationStats.total != null && (
        <div className="text-[11px] text-theme-muted font-mono">
          curation rows: {Number(curationStats.total ?? 0)} total · {Number(curationStats.excluded ?? 0)} excluded · {Number(curationStats.stale ?? 0)} stale
        </div>
      )}

      <div className="space-y-2">
        <h3 className="text-xs font-semibold text-theme-primary">Context Graph</h3>
        <div className="text-xs text-theme-muted space-y-1">
          <div>
            {Number(state?.graph?.nodeCount ?? 0)} nodes · {Number(state?.graph?.edgeCount ?? 0)} edges
            {state?.graph?.source ? <span> · {String(state.graph.source)}</span> : null}
          </div>
          {state?.graph?.limited && (
            <div className="text-[11px]">
              previewing {Number(state.graph.previewNodeCount ?? state.graph.nodes?.length ?? 0)} nodes and {Number(state.graph.previewEdgeCount ?? state.graph.edges?.length ?? 0)} edges
            </div>
          )}
          {state?.graph?.error && <div className="text-[11px] text-accent-red">{state.graph.error}</div>}
          {state?.graph?.nodeTypeCounts?.length ? (
            <div className="text-[10px] font-mono">
              {state.graph.nodeTypeCounts.slice(0, 6).map(item => `${String(item.type ?? 'unknown')}:${Number(item.count ?? 0)}`).join(' · ')}
            </div>
          ) : null}
          {state?.graph?.relationshipCounts?.length ? (
            <div className="text-[10px] font-mono">
              {state.graph.relationshipCounts.slice(0, 6).map(item => `${String(item.relationship ?? 'related')}:${Number(item.count ?? 0)}`).join(' · ')}
            </div>
          ) : null}
        </div>
        {state?.graph?.edges?.length ? (
          <div className="space-y-1 max-h-40 overflow-auto border border-app rounded p-2 bg-app-card/30">
            {state.graph.edges.slice(0, 40).map((edge, i) => (
              <div key={String(edge.id ?? i)} className="text-[10px] font-mono text-theme-muted truncate">
                {String(edge.source)} --{String(edge.label ?? 'related_to')}--&gt; {String(edge.target)}
              </div>
            ))}
          </div>
        ) : <div className="text-xs text-theme-muted">No context graph mappings are available yet.</div>}
      </div>

      <div className="space-y-2">
        <h3 className="text-xs font-semibold text-theme-primary">Search Debugger</h3>
        <div className="flex gap-2">
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search context as an agent would..." className="input flex-1 text-xs" />
          <button onClick={handleSearch} disabled={searching || !query.trim()} className="btn-primary text-xs inline-flex items-center gap-1">
            {searching ? <Loader2 className="w-3 h-3 animate-spin" /> : <ScanSearch className="w-3 h-3" />}
            Search
          </button>
        </div>
        {searchResult?.refs?.length ? (
          <div className="space-y-1.5">
            {searchResult.refs.slice(0, 10).map((ref: Record<string, any>, i: number) => (
              <div key={`${ref.refId ?? i}`} className="border border-app rounded p-2 bg-app-card/40">
                <div className="flex gap-2 min-w-0">
                  <span className="text-xs text-theme-primary truncate">{ref.title ?? ref.path ?? ref.refId}</span>
                  <span className="text-[10px] text-theme-subtle font-mono shrink-0">{ref.providerId ?? ref.source}</span>
                </div>
                <div className="text-[10px] text-theme-muted font-mono truncate">{ref.path}</div>
                <div className="text-[11px] text-theme-muted mt-1">{ref.why ?? ref.reason ?? ref.summary}</div>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="space-y-2">
        <h3 className="text-xs font-semibold text-theme-primary">Mandatory Context</h3>
        <select value={activeAgent} onChange={e => setSelectedAgent(e.target.value)} className="input text-xs max-w-sm">
          {agents.map(agent => <option key={String(agent.name)} value={String(agent.name)}>{String(agent.name)}</option>)}
        </select>
        <div className="grid gap-2">
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Title" className="input text-xs" />
          <textarea value={content} onChange={e => setContent(e.target.value)} placeholder="Mandatory context to inject for the selected agent" className="input text-xs min-h-28 font-mono" />
          <button onClick={handleSaveNew} disabled={saving || !activeAgent || !content.trim()} className="btn-primary text-xs w-fit">Add mandatory context</button>
        </div>
        {visibleMappings.length ? (
          <div className="space-y-2">
            {visibleMappings.map((mapping, i) => {
              const mappingId = String(mapping.mappingId ?? i);
              const draft = drafts[mappingId] ?? String(mapping.content ?? '');
              return (
                <div key={mappingId} className="border border-app rounded p-2 bg-app-card/40 space-y-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs text-theme-primary truncate">{mapping.title ?? mapping.sourcePath ?? mapping.agentName}</span>
                    <span className="text-[10px] text-theme-subtle font-mono shrink-0">{mapping.enabled === false ? 'disabled' : 'enabled'}</span>
                  </div>
                  <div className="text-[10px] text-theme-muted font-mono truncate">{mapping.sourcePath}</div>
                  <textarea value={draft} onChange={e => setDrafts(prev => ({ ...prev, [mappingId]: e.target.value }))} className="input text-xs min-h-32 font-mono" />
                  <button onClick={() => handleSaveExisting(mapping)} disabled={saving} className="btn-ghost text-xs">Save changes</button>
                </div>
              );
            })}
          </div>
        ) : <div className="text-xs text-theme-muted">No mandatory context mapped for this agent.</div>}
      </div>

      <CurationSection title="Curated Context Entries" entries={entries.slice(0, 80)} empty="No curated entries." />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded border border-app bg-app-card/60 p-2">
      <div className="text-[10px] text-theme-muted uppercase tracking-wide">{label}</div>
      <div className="text-sm text-theme-primary font-mono">{value}</div>
    </div>
  );
}

function QuickWorkspaceDialog({ repo, onClose, onCreated }: { repo: Repo; onClose: () => void; onCreated: (id: string) => void }) {
  const [branch, setBranch] = useState('');
  const [baseBranch, setBaseBranch] = useState(repo.detected?.defaultBranch ?? 'main');
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState('');

  async function handleCreate() {
    if (!branch.trim() || !name.trim()) { setError('Branch and name required'); return; }
    setCreating(true); setError('');
    try {
      const ws = await wsApi.create({ repoId: repo._id, repoName: repo.name, repoPath: repo.path, branch: branch.trim(), baseBranch, name: name.trim() });
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
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-surface-100 border border-app rounded-lg w-[440px] p-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-4">
          <Monitor className="w-4 h-4 text-accent-green" />
          <span className="text-sm font-semibold text-theme-primary">New Workspace</span>
          <span className="text-[10px] font-mono text-theme-muted">{repo.name}</span>
        </div>
        {error && <div className="text-xs text-accent-red bg-accent-red/10 border border-accent-red/30 rounded px-3 py-1.5 mb-3">{error}</div>}
        <div className="space-y-3">
          <div>
            <label className="overline block mb-1">Workspace Name</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="feature/my-feature" className="input w-full text-xs" autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="overline block mb-1">Branch</label>
              <input value={branch} onChange={e => setBranch(e.target.value)} placeholder="feature/new-thing" className="input w-full text-xs" />
            </div>
            <div>
              <label className="overline block mb-1">Base Branch</label>
              <input value={baseBranch} onChange={e => setBaseBranch(e.target.value)} className="input w-full text-xs" />
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="btn-ghost text-xs">Cancel</button>
          <button onClick={handleCreate} disabled={creating} className="btn-primary text-xs disabled:opacity-50">
            {creating ? 'Creating...' : 'Create Workspace'}
          </button>
        </div>
      </div>
    </div>
  );
}
