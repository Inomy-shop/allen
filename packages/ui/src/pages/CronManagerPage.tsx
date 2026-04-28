import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  crons as cronApi, agents as agentApi, workflows as wfApi,
} from '../services/api';
import {
  Clock, Plus, Play, Trash2, Pencil, X, Loader2, RefreshCw,
  AlertCircle, History,
} from 'lucide-react';
import DeleteConfirmDialog from '../components/common/DeleteConfirmDialog';
import { useToast } from '../components/common/Toast';

// ── Types ──

interface CronJob {
  _id: string;
  name: string;
  displayName: string;
  description?: string;
  enabled: boolean;
  schedule: string;
  timezone: string;
  nextRunAt: string | null;
  target: any;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunError: string | null;
  lastRunExecutionId: string | null;
  runCount: number;
  runStatus: string;
  isBuiltIn: boolean;
  createdAt: string;
}

interface CronRun {
  _id: string;
  cronJobName: string;
  startedAt: string;
  completedAt: string | null;
  status: string;
  triggeredBy: string;
  executionId?: string;
  error?: string;
  notes?: string;
  durationMs?: number;
}

// ── Helpers ──

function timeAgo(d: string | null): string {
  if (!d) return 'never';
  const ms = Date.now() - new Date(d).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function timeUntil(d: string | null): string {
  if (!d) return '-';
  const ms = new Date(d).getTime() - Date.now();
  if (ms <= 0) return 'due';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `in ${hrs}h`;
  return `in ${Math.floor(hrs / 24)}d`;
}

const statusColors: Record<string, string> = {
  success: 'bg-accent-green/15 text-accent-green border-accent-green/30',
  failed: 'bg-accent-red/15 text-accent-red border-accent-red/30',
  skipped: 'bg-accent-yellow/15 text-accent-yellow border-accent-yellow/30',
  running: 'bg-accent-blue/15 text-accent-blue border-accent-blue/30',
};

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return null;
  const cls = statusColors[status] ?? 'bg-surface-200/60 text-theme-muted border-border/30';
  return <span className={`text-[10px] px-1.5 py-0.5 rounded-sm font-mono uppercase border ${cls}`}>{status}</span>;
}

function targetSummary(target: any): string {
  if (!target) return '-';
  if (target.type === 'agent') return `Agent: ${target.agentName}`;
  if (target.type === 'workflow') return `Workflow: ${target.workflowName}`;
  if (target.type === 'system') return `System: ${target.systemAction}`;
  return target.type ?? '-';
}

const targetTypeColors: Record<string, string> = {
  agent: 'bg-accent-purple/15 text-accent-purple border-accent-purple/30',
  workflow: 'bg-accent-cyan/15 text-accent-cyan border-accent-cyan/30',
  system: 'bg-accent-orange/15 text-accent-orange border-accent-orange/30',
};

function ToggleSwitch({ enabled, onChange }: { enabled: boolean; onChange: () => void }) {
  return (
    <button
      onClick={onChange}
      title={enabled ? 'Disable' : 'Enable'}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors duration-200 ease-in-out focus:outline-none ${
        enabled ? 'bg-accent-blue' : 'bg-surface-200/40'
      }`}
    >
      <span
        className={`pointer-events-none inline-block rounded-full shadow transition-transform duration-200 ease-in-out ${
          enabled ? 'translate-x-[18px] bg-surface-100' : 'translate-x-[2px] bg-gray-400'
        }`}
        style={{ width: '16px', height: '16px', marginTop: '2px' }}
      />
    </button>
  );
}

/* ── History Modal ────────────────────────────────────────────────────────── */

function HistoryDialog({ job, onClose }: { job: CronJob; onClose: () => void }) {
  const [runs, setRuns] = useState<CronRun[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    cronApi.runs(job._id, 100).then(setRuns).finally(() => setLoading(false));
  }, [job._id]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md">
      <div className="card w-full max-w-2xl overflow-hidden shadow-glow-blue/20 animate-in fade-in zoom-in-95 duration-200 max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="px-6 py-5 border-b border-border/60">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-sm bg-accent-blue/10 border border-accent-blue/30 flex items-center justify-center">
                <History className="w-5 h-5 text-accent-blue" />
              </div>
              <div>
                <h2 className="text-[14px] font-semibold text-theme-primary tracking-tight">Run History</h2>
                <p className="text-[11px] text-theme-muted font-mono">{job.displayName}</p>
              </div>
            </div>
            <button onClick={onClose} className="p-2 rounded-sm hover:bg-surface-200 text-theme-muted hover:text-theme-secondary transition-colors" title="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {loading && (
            <div className="text-center py-12">
              <Loader2 className="w-5 h-5 animate-spin text-theme-subtle mx-auto" />
            </div>
          )}
          {!loading && runs.length === 0 && (
            <div className="text-center py-12">
              <Clock className="w-8 h-8 text-theme-subtle mx-auto mb-2" />
              <p className="text-sm text-theme-muted font-body">No runs yet</p>
            </div>
          )}
          {runs.map(r => (
            <div key={r._id} className="flex items-start gap-3 py-3 border-b border-border/20 last:border-0">
              <div className="w-16 shrink-0 pt-0.5"><StatusBadge status={r.status} /></div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 text-[11px]">
                  <span className="text-theme-secondary font-mono">{new Date(r.startedAt).toLocaleString()}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-sm font-mono uppercase border ${
                    r.triggeredBy === 'manual' ? 'bg-accent-yellow/10 text-accent-yellow border-accent-yellow/20' : 'bg-surface-200/40 text-theme-subtle border-border/20'
                  }`}>{r.triggeredBy}</span>
                  {r.durationMs != null && <span className="text-theme-subtle font-mono">{(r.durationMs / 1000).toFixed(1)}s</span>}
                </div>
                {r.notes && <p className="text-[11px] text-theme-muted mt-1 truncate">{r.notes}</p>}
                {r.error && <p className="text-[11px] text-accent-red mt-1 truncate">{r.error}</p>}
                {r.executionId && (
                  <Link
                    to={`/executions/${r.executionId}`}
                    className="inline-flex items-center gap-1 text-[10px] text-accent-blue font-mono mt-1 hover:text-accent-blue/80 hover:underline transition-colors"
                    onClick={e => e.stopPropagation()}
                  >
                    View Execution &rarr; {r.executionId.slice(0, 12)}...
                  </Link>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-3 px-6 py-4 border-t border-border/60 bg-surface-50/50">
          <span className="text-[11px] text-theme-subtle font-mono">{runs.length} run{runs.length !== 1 ? 's' : ''}</span>
          <div className="flex-1" />
          <button onClick={onClose} className="btn-ghost text-xs">Close</button>
        </div>
      </div>
    </div>
  );
}

/* ── Create / Edit Dialog ─────────────────────────────────────────────────── */

function CronFormDialog({ job, open, onClose, onSaved }: { job: CronJob | null; open: boolean; onClose: () => void; onSaved: () => void }) {
  const isEdit = !!job;
  const [name, setName] = useState(job?.name ?? '');
  const [displayName, setDisplayName] = useState(job?.displayName ?? '');
  const [description, setDescription] = useState(job?.description ?? '');
  const [schedule, setSchedule] = useState(job?.schedule ?? '0 5 * * *');
  const [targetType, setTargetType] = useState<'agent' | 'workflow' | 'system'>(job?.target?.type ?? 'agent');
  const [agentName, setAgentName] = useState(job?.target?.agentName ?? '');
  const [prompt, setPrompt] = useState(job?.target?.prompt ?? '');
  const [repoPath, setRepoPath] = useState(job?.target?.repoPath ?? '');
  const [workflowName, setWorkflowName] = useState(job?.target?.workflowName ?? '');
  const [workflowInput, setWorkflowInput] = useState<Record<string, any>>({});
  const [systemAction, setSystemAction] = useState(job?.target?.systemAction ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<string[]>([]);

  const [agentList, setAgentList] = useState<any[]>([]);
  const [workflowList, setWorkflowList] = useState<any[]>([]);
  const [systemActions, setSystemActions] = useState<any[]>([]);
  const [selectedWfInputSchema, setSelectedWfInputSchema] = useState<Record<string, any> | null>(null);

  useEffect(() => {
    if (!open) return;
    agentApi.list().then(setAgentList).catch(() => {});
    wfApi.list().then(setWorkflowList).catch(() => {});
    cronApi.systemActions().then(setSystemActions).catch(() => {});
  }, [open]);

  // Load workflow input schema when workflow changes
  useEffect(() => {
    if (!workflowName) { setSelectedWfInputSchema(null); return; }
    const wf = workflowList.find((w: any) => (w.parsed?.name ?? w.name) === workflowName);
    if (wf?.parsed?.input) {
      setSelectedWfInputSchema(wf.parsed.input);
      const defaults: Record<string, any> = {};
      for (const [key, def] of Object.entries(wf.parsed.input as Record<string, any>)) {
        defaults[key] = job?.target?.workflowInput?.[key] ?? def.default ?? '';
      }
      setWorkflowInput(defaults);
    } else {
      setSelectedWfInputSchema(null);
    }
  }, [workflowName, workflowList]);

  // Schedule preview
  useEffect(() => {
    if (!schedule.trim()) return;
    cronApi.previewSchedule(schedule).then(r => setPreview(r.next ?? [])).catch(() => setPreview([]));
  }, [schedule]);

  const handleSubmit = async () => {
    if (!name.trim() || !displayName.trim() || !schedule.trim()) { setError('Name, display name, and schedule are required'); return; }

    let target: any;
    if (targetType === 'agent') {
      if (!agentName || !prompt.trim()) { setError('Agent and prompt are required'); return; }
      target = { type: 'agent', agentName, prompt, repoPath: repoPath || undefined };
    } else if (targetType === 'workflow') {
      if (!workflowName) { setError('Workflow is required'); return; }
      target = { type: 'workflow', workflowName, workflowInput };
    } else {
      if (!systemAction) { setError('System action is required'); return; }
      target = { type: 'system', systemAction };
    }

    setSaving(true);
    setError('');
    try {
      if (isEdit) {
        await cronApi.update(job!._id, { displayName, description, schedule, target });
      } else {
        await cronApi.create({ name, displayName, description, schedule, target });
      }
      onSaved();
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
      <div className="card w-full max-w-lg overflow-hidden shadow-glow-blue/20 animate-in fade-in zoom-in-95 duration-200 max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="px-6 py-5 border-b border-border/60">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-sm bg-accent-blue/10 border border-accent-blue/30 flex items-center justify-center">
                {isEdit ? <Pencil className="w-5 h-5 text-accent-blue" /> : <Plus className="w-5 h-5 text-accent-blue" />}
              </div>
              <div>
                <h2 className="text-[14px] font-semibold text-theme-primary tracking-tight">{isEdit ? 'Edit' : 'New'} Scheduled Job</h2>
                <p className="text-[11px] text-theme-muted font-mono">{isEdit ? job!.name : 'Configure schedule + target'}</p>
              </div>
            </div>
            <button onClick={onClose} className="p-2 rounded-sm hover:bg-surface-200 text-theme-muted hover:text-theme-secondary transition-colors" title="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Fields */}
        <div className="px-6 py-5 space-y-4 flex-1 overflow-y-auto">
          {error && (
            <div className="text-xs text-accent-red bg-accent-red/10 border border-accent-red/20 rounded-sm px-3 py-2 flex items-center gap-2">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />{error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="flex items-center gap-1 text-xs font-label font-semibold text-theme-secondary mb-2 uppercase tracking-widest">
                Name <span className="text-accent-red normal-case text-[10px]">*</span>
              </label>
              <input type="text" value={name} onChange={e => setName(e.target.value)} disabled={isEdit}
                placeholder="my-cron-job" className="input w-full text-sm font-mono" />
            </div>
            <div>
              <label className="flex items-center gap-1 text-xs font-label font-semibold text-theme-secondary mb-2 uppercase tracking-widest">
                Display Name <span className="text-accent-red normal-case text-[10px]">*</span>
              </label>
              <input type="text" value={displayName} onChange={e => setDisplayName(e.target.value)}
                placeholder="My Cron Job" className="input w-full text-sm" />
            </div>
          </div>

          <div>
            <label className="text-xs font-label font-semibold text-theme-secondary mb-2 uppercase tracking-widest block">Description</label>
            <input type="text" value={description} onChange={e => setDescription(e.target.value)}
              placeholder="Optional description" className="input w-full text-sm" />
          </div>

          <div>
            <label className="flex items-center gap-1 text-xs font-label font-semibold text-theme-secondary mb-2 uppercase tracking-widest">
              Schedule (Cron) <span className="text-accent-red normal-case text-[10px]">*</span>
            </label>
            <input type="text" value={schedule} onChange={e => setSchedule(e.target.value)}
              placeholder="0 5 * * *" className="input w-full text-sm font-mono" />
            {preview.length > 0 && (
              <div className="mt-1.5 text-[10px] text-theme-subtle font-mono">
                Next: {preview.slice(0, 3).map(d => new Date(d).toLocaleString()).join('  |  ')}
              </div>
            )}
          </div>

          {/* Target Type */}
          <div>
            <label className="text-xs font-label font-semibold text-theme-secondary mb-2 uppercase tracking-widest block">Target Type</label>
            <div className="flex gap-2">
              {(['agent', 'workflow', 'system'] as const).map(t => (
                <button
                  key={t}
                  onClick={() => setTargetType(t)}
                  className={`px-3 py-1.5 rounded-sm text-[11px] font-mono uppercase border transition-colors ${
                    targetType === t
                      ? targetTypeColors[t]
                      : 'bg-surface-200/40 text-theme-subtle border-border/20 hover:text-theme-secondary'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* Agent target */}
          {targetType === 'agent' && (
            <div className="space-y-4 pl-3 border-l-2 border-accent-purple/30">
              <div>
                <label className="text-xs font-label font-semibold text-theme-secondary mb-2 uppercase tracking-widest block">Agent</label>
                <select value={agentName} onChange={e => setAgentName(e.target.value)} className="input w-full text-sm">
                  <option value="">Select agent...</option>
                  {agentList.map((a: any) => <option key={a.name} value={a.name}>{a.displayName ?? a.name}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-label font-semibold text-theme-secondary mb-2 uppercase tracking-widest block">Prompt</label>
                <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={4}
                  placeholder="Task for the agent..." className="input w-full text-sm resize-none" />
              </div>
              <div>
                <label className="text-xs font-label font-semibold text-theme-secondary mb-2 uppercase tracking-widest block">Repo Path <span className="normal-case text-[10px] text-theme-subtle">(optional)</span></label>
                <input type="text" value={repoPath} onChange={e => setRepoPath(e.target.value)}
                  placeholder="/path/to/repo" className="input w-full text-sm font-mono" />
              </div>
            </div>
          )}

          {/* Workflow target */}
          {targetType === 'workflow' && (
            <div className="space-y-4 pl-3 border-l-2 border-accent-cyan/30">
              <div>
                <label className="text-xs font-label font-semibold text-theme-secondary mb-2 uppercase tracking-widest block">Workflow</label>
                <select value={workflowName} onChange={e => setWorkflowName(e.target.value)} className="input w-full text-sm">
                  <option value="">Select workflow...</option>
                  {workflowList.map((w: any) => <option key={w._id} value={w.parsed?.name ?? w.name}>{w.parsed?.name ?? w.name}</option>)}
                </select>
              </div>
              {selectedWfInputSchema && Object.keys(selectedWfInputSchema).length > 0 && (
                <div className="space-y-3">
                  <span className="text-[10px] font-label uppercase tracking-widest text-theme-subtle">Workflow Inputs</span>
                  {Object.entries(selectedWfInputSchema).map(([key, def]: [string, any]) => {
                    const val = workflowInput[key] ?? '';
                    const fieldType = (def.type ?? 'string').toLowerCase();
                    if (fieldType === 'boolean') {
                      return (
                        <label key={key} className="flex items-center gap-2 text-sm text-theme-secondary cursor-pointer">
                          <input type="checkbox" checked={!!val}
                            onChange={e => setWorkflowInput(p => ({ ...p, [key]: e.target.checked }))} className="accent-accent-blue" />
                          {key}{def.required && <span className="text-accent-red text-[10px]">*</span>}
                        </label>
                      );
                    }
                    if (fieldType === 'number' || fieldType === 'integer') {
                      return (
                        <div key={key}>
                          <label className="flex items-center gap-1 text-xs font-label font-semibold text-theme-secondary mb-2 uppercase tracking-widest">
                            {key}{def.required && <span className="text-accent-red normal-case text-[10px]">*</span>}
                          </label>
                          <input type="number" value={val}
                            onChange={e => setWorkflowInput(p => ({ ...p, [key]: Number(e.target.value) }))}
                            className="input w-full text-sm font-mono" />
                        </div>
                      );
                    }
                    if (fieldType === 'object' || fieldType === 'array') {
                      return (
                        <div key={key}>
                          <label className="flex items-center gap-1 text-xs font-label font-semibold text-theme-secondary mb-2 uppercase tracking-widest">
                            {key}{def.required && <span className="text-accent-red normal-case text-[10px]">*</span>}
                            <span className="normal-case text-[10px] text-theme-subtle ml-1">({fieldType} — JSON)</span>
                          </label>
                          <textarea value={typeof val === 'string' ? val : JSON.stringify(val, null, 2)}
                            onChange={e => { try { setWorkflowInput(p => ({ ...p, [key]: JSON.parse(e.target.value) })); } catch { setWorkflowInput(p => ({ ...p, [key]: e.target.value })); } }}
                            rows={3} className="input w-full text-sm font-mono resize-none" />
                        </div>
                      );
                    }
                    return (
                      <div key={key}>
                        <label className="flex items-center gap-1 text-xs font-label font-semibold text-theme-secondary mb-2 uppercase tracking-widest">
                          {key}{def.required && <span className="text-accent-red normal-case text-[10px]">*</span>}
                        </label>
                        <input type="text" value={val}
                          onChange={e => setWorkflowInput(p => ({ ...p, [key]: e.target.value }))}
                          placeholder={def.default != null ? String(def.default) : ''}
                          className="input w-full text-sm font-mono" />
                      </div>
                    );
                  })}
                </div>
              )}
              {selectedWfInputSchema && Object.keys(selectedWfInputSchema).length === 0 && (
                <p className="text-[11px] text-theme-subtle italic font-body">This workflow takes no inputs.</p>
              )}
            </div>
          )}

          {/* System target */}
          {targetType === 'system' && (
            <div className="space-y-4 pl-3 border-l-2 border-accent-orange/30">
              <div>
                <label className="text-xs font-label font-semibold text-theme-secondary mb-2 uppercase tracking-widest block">System Action</label>
                <select value={systemAction} onChange={e => setSystemAction(e.target.value)} className="input w-full text-sm">
                  <option value="">Select action...</option>
                  {systemActions.map((a: any) => <option key={a.name} value={a.name}>{a.name}</option>)}
                </select>
                {systemAction && systemActions.find(a => a.name === systemAction)?.description && (
                  <p className="text-[11px] text-theme-subtle mt-1.5">{systemActions.find(a => a.name === systemAction)?.description}</p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-3 px-6 py-5 border-t border-border/60 bg-surface-50/50">
          <button onClick={onClose} className="flex-1 btn-ghost">Cancel</button>
          <button onClick={handleSubmit} disabled={saving} className="flex-1 btn-primary inline-flex items-center justify-center gap-2">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : isEdit ? <Pencil className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
            {saving ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Job'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Main Page ──────────────────────────────────────────────────────────── */

export default function CronManagerPage() {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editJob, setEditJob] = useState<CronJob | null>(null);
  const [historyJob, setHistoryJob] = useState<CronJob | null>(null);
  const [deletingJob, setDeletingJob] = useState<{ id: string; name: string } | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try { setJobs(await cronApi.list()); } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Auto-refresh every 30 s
  useEffect(() => {
    const t = setInterval(refresh, 30000);
    return () => clearInterval(t);
  }, [refresh]);

  const toggle = async (job: CronJob) => {
    try {
      if (job.enabled) {
        await cronApi.disable(job._id);
        toast.info(`"${job.displayName}" disabled.`);
      } else {
        await cronApi.enable(job._id);
        toast.success(`"${job.displayName}" enabled.`);
      }
      refresh();
    } catch (err: any) {
      toast.error(err.message ?? 'Toggle failed');
    }
  };

  const toast = useToast();

  const runNow = async (job: CronJob) => {
    setRunningId(job._id);
    try {
      await cronApi.runNow(job._id);
      toast.success(`"${job.displayName}" triggered. Check run history for status.`);
    } catch (err: any) {
      toast.error(err.message ?? 'Failed to trigger job');
    } finally {
      setRunningId(null);
      setTimeout(refresh, 1000);
    }
  };

  const handleDelete = async () => {
    if (!deletingJob) return;
    await cronApi.delete(deletingJob.id);
    setDeletingJob(null);
    refresh();
  };

  return (
    <div className="px-6 pt-5 pb-8">
      {/* Header */}
      <div className="flex items-center gap-2 mb-2 text-[12px] text-theme-muted">
        <span>Build</span>
        <span className="text-theme-subtle">/</span>
        <span>Schedules</span>
      </div>
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <h1 className="text-[20px] font-semibold text-theme-primary tracking-tight">Schedules</h1>
          <span className="text-[12px] font-mono text-theme-muted">{jobs.length}</span>
        </div>
        <div className="flex items-center gap-2">
          <button title="Refresh" onClick={refresh} className="btn btn-secondary btn-sm"><RefreshCw className="w-3.5 h-3.5" /></button>
          <button onClick={() => { setEditJob(null); setFormOpen(true); }} className="btn btn-primary btn-sm">
            <Plus className="w-3.5 h-3.5" /> New schedule
          </button>
        </div>
      </div>

      {/* Loading */}
      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="card p-5 animate-pulse">
              <div className="flex items-center gap-4">
                <div className="h-6 w-6 bg-surface-200 rounded-sm" />
                <div className="flex-1">
                  <div className="h-4 w-40 bg-surface-200 rounded-sm mb-2" />
                  <div className="h-3 w-64 bg-surface-200 rounded-sm" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : jobs.length === 0 ? (
        <div className="text-center py-12">
          <Clock className="w-10 h-10 text-theme-subtle mx-auto mb-3" />
          <p className="text-sm text-theme-muted font-body">No scheduled jobs yet. Create one to get started.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {jobs.map(job => {
            const isRunning = runningId === job._id;
            return (
              <div key={job._id}
                className={`p-4 rounded-lg border border-border/20 bg-surface-100/20 hover:bg-surface-100/40 transition-colors group ${!job.enabled ? 'opacity-50' : ''}`}
              >
                <div className="flex items-center gap-4">
                  {/* Icon */}
                  <Clock className="w-5 h-5 text-blue-400 shrink-0" />

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-heading font-semibold text-theme-primary">{job.displayName}</span>
                      {job.isBuiltIn && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-sm font-mono uppercase border bg-accent-blue/10 text-accent-blue border-accent-blue/30">built-in</span>
                      )}
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-sm font-mono uppercase border ${
                        targetTypeColors[job.target?.type] ?? 'bg-surface-200/40 text-theme-subtle border-border/20'
                      }`}>{job.target?.type ?? '-'}</span>
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-[10px] text-theme-muted font-mono">
                      <span title="Cron schedule">{job.schedule}</span>
                      <span>{targetSummary(job.target)}</span>
                      {job.description && <span className="text-theme-subtle truncate max-w-[200px]">{job.description}</span>}
                    </div>
                  </div>

                  {/* Status columns */}
                  <div className="text-right shrink-0 w-28">
                    <div className="text-[10px] text-theme-subtle font-label uppercase tracking-wider">Last Run</div>
                    <div className="flex items-center gap-1 justify-end mt-0.5">
                      <StatusBadge status={job.lastRunStatus} />
                      <span className="text-[11px] text-theme-muted font-mono">{timeAgo(job.lastRunAt)}</span>
                    </div>
                  </div>

                  <div className="text-right shrink-0 w-24">
                    <div className="text-[10px] text-theme-subtle font-label uppercase tracking-wider">Next Run</div>
                    <div className="text-[11px] text-theme-secondary font-mono mt-0.5">{job.enabled ? timeUntil(job.nextRunAt) : 'disabled'}</div>
                  </div>

                  <div className="text-right shrink-0 w-14">
                    <div className="text-[10px] text-theme-subtle font-label uppercase tracking-wider">Runs</div>
                    <div className="text-[11px] text-theme-primary font-mono mt-0.5">{job.runCount}</div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    <button onClick={() => runNow(job)} disabled={isRunning} className="btn-ghost p-1.5 text-xs text-emerald-400" title="Run now">
                      {isRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                    </button>
                    <button onClick={() => setHistoryJob(job)} className="btn-ghost p-1.5 text-xs" title="Run history">
                      <History className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => { setEditJob(job); setFormOpen(true); }} className="btn-ghost p-1.5 text-xs" title="Edit">
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    {!job.isBuiltIn && (
                      <button onClick={() => setDeletingJob({ id: job._id, name: job.displayName })} className="btn-ghost p-1.5 text-xs text-red-400" title="Delete">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  {/* Toggle — far right, always visible */}
                  <div className="shrink-0 pl-2 border-l border-border/20">
                    <ToggleSwitch enabled={job.enabled} onChange={() => toggle(job)} />
                  </div>
                </div>

                {/* Error row */}
                {job.lastRunError && job.lastRunStatus === 'failed' && (
                  <div className="mt-2 ml-9 text-[11px] text-accent-red bg-accent-red/5 border border-accent-red/10 rounded-sm px-3 py-1.5 truncate">
                    {job.lastRunError}
                  </div>
                )}

                {/* Last execution link */}
                {job.lastRunExecutionId && (
                  <div className="mt-1.5 ml-9">
                    <Link
                      to={`/executions/${job.lastRunExecutionId}`}
                      className="inline-flex items-center gap-1 text-[10px] text-accent-blue font-mono hover:text-accent-blue/80 hover:underline transition-colors"
                    >
                      View last execution &rarr; {job.lastRunExecutionId.slice(0, 12)}...
                    </Link>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Dialogs */}
      {/* key forces React to remount the dialog whenever we switch between
          creating and editing, or between two different edit targets.
          Without the key, CronFormDialog's useState(job?.xxx ...) initializers
          only fire on first mount and stale-state the form for subsequent
          edits. */}
      <CronFormDialog
        key={editJob?._id ?? 'new'}
        job={editJob}
        open={formOpen}
        onClose={() => { setFormOpen(false); setEditJob(null); }}
        onSaved={refresh}
      />
      {historyJob && <HistoryDialog job={historyJob} onClose={() => setHistoryJob(null)} />}
      <DeleteConfirmDialog
        open={!!deletingJob}
        resourceType="cron job"
        resourceName={deletingJob?.name ?? ''}
        onConfirm={handleDelete}
        onCancel={() => setDeletingJob(null)}
      />
    </div>
  );
}
