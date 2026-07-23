import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  crons as cronApi, agents as agentApi, workflows as wfApi,
} from '../services/api';
import {
  Clock, Plus, Play, Trash2, Pencil, X, Loader2, RefreshCw,
  AlertCircle, History, MoreHorizontal,
} from 'lucide-react';
import { useToast } from '../components/common/Toast';
import IconTooltipButton from '../components/common/IconTooltipButton';
import Select from '../components/common/Select';

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
  success: 'bg-accent-green/10 text-accent-green border-accent-green/25',
  failed: 'bg-accent-red/10 text-accent-red border-accent-red/25',
  skipped: 'bg-accent-yellow/10 text-accent-yellow border-accent-yellow/25',
  running: 'bg-accent-blue/10 text-accent-blue border-accent-blue/25',
};

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return null;
  const cls = statusColors[status] ?? 'bg-app-muted text-theme-muted border-app';
  return <span className={`inline-flex h-6 items-center rounded-md border px-2 text-[12px] font-medium capitalize ${cls}`}>{status}</span>;
}

function targetSummary(target: any): string {
  if (!target) return '-';
  if (target.type === 'agent') return target.agentName ?? 'Agent';
  if (target.type === 'workflow') return target.workflowName ?? 'Workflow';
  if (target.type === 'system') return target.systemAction ?? 'System';
  return target.type ?? '-';
}

const targetTypeLabels: Record<string, string> = {
  agent: 'Agent',
  workflow: 'Workflow',
  system: 'System',
};

const fieldLabelClass = 'mb-1.5 block text-[12px] font-medium text-theme-secondary';
const fieldClass = 'h-9 w-full rounded-md border border-app bg-app-card px-3 text-[13px] text-theme-primary outline-none transition-colors placeholder:text-theme-subtle focus:border-accent focus:ring-2 focus:ring-accent/15 disabled:cursor-not-allowed disabled:opacity-60';
const textareaClass = 'min-h-24 w-full resize-none rounded-md border border-app bg-app-card px-3 py-2 text-[13px] text-theme-primary outline-none transition-colors placeholder:text-theme-subtle focus:border-accent focus:ring-2 focus:ring-accent/15';
const secondaryButtonClass = 'inline-flex h-9 items-center justify-center rounded-md border border-app bg-app-card px-3.5 text-[13px] font-medium text-theme-secondary transition-colors hover:bg-app-muted hover:text-theme-primary';
const primaryButtonClass = 'inline-flex h-9 items-center justify-center gap-2 rounded-md border border-accent/40 bg-accent px-3.5 text-[13px] font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60';

function ToggleSwitch({ enabled, onChange }: { enabled: boolean; onChange: () => void }) {
  return (
    <button
      onClick={onChange}
      aria-label={enabled ? 'Disable schedule' : 'Enable schedule'}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border transition-colors duration-200 ease-in-out focus:outline-none ${
        enabled ? 'border-accent/35 bg-accent' : 'border-app bg-app-muted'
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-4 w-4 rounded-full shadow transition-transform duration-200 ease-in-out ${
          enabled ? 'translate-x-[18px] bg-white' : 'translate-x-[2px] bg-theme-subtle'
        }`}
        style={{ marginTop: '1px' }}
      />
    </button>
  );
}

function MetricPill({ label, value, tone = 'neutral' }: { label: string; value: number; tone?: 'neutral' | 'danger' }) {
  return (
    <span className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[12px] ${
      tone === 'danger'
        ? 'border-accent-red/25 bg-accent-red/10 text-accent-red'
        : 'border-app bg-app-muted text-theme-secondary'
    }`}>
      <span className="font-semibold text-theme-primary">{value}</span>
      {label}
    </span>
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
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm">
      <div className="flex max-h-[82vh] w-full max-w-2xl animate-in fade-in zoom-in-95 flex-col overflow-hidden rounded-lg border border-app bg-app-card shadow-2xl duration-200">
        <div className="border-b border-app px-5 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-md border border-app bg-app-muted text-theme-secondary">
                <History className="h-4 w-4" />
              </div>
              <div>
                <h2 className="text-[15px] font-semibold text-theme-primary">Run history</h2>
                <p className="mt-0.5 text-[12px] text-theme-muted">{job.displayName}</p>
              </div>
            </div>
            <IconTooltipButton label="Close" onClick={onClose}>
              <X className="h-3.5 w-3.5" />
            </IconTooltipButton>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading && (
            <div className="py-12 text-center">
              <Loader2 className="mx-auto h-5 w-5 animate-spin text-theme-subtle" />
            </div>
          )}
          {!loading && runs.length === 0 && (
            <div className="rounded-lg border border-dashed border-app bg-app px-4 py-10 text-center">
              <Clock className="mx-auto mb-2 h-7 w-7 text-theme-subtle" />
              <p className="text-[13px] text-theme-muted">No runs yet</p>
            </div>
          )}
          {!loading && runs.length > 0 && (
            <div className="overflow-hidden rounded-lg border border-app bg-app">
              {runs.map(r => (
                <div key={r._id} className="grid gap-3 border-b border-app px-4 py-3 last:border-b-0 md:grid-cols-[96px_minmax(0,1fr)_90px]">
                  <div className="pt-0.5"><StatusBadge status={r.status} /></div>
                  <div className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-2 text-[12px] text-theme-secondary">
                      <span>{new Date(r.startedAt).toLocaleString()}</span>
                      <span className="rounded-md border border-app bg-app-muted px-2 py-0.5 text-[11px] capitalize text-theme-muted">{r.triggeredBy}</span>
                    </div>
                    {r.notes && <p className="mt-1 truncate text-[12px] text-theme-muted">{r.notes}</p>}
                    {r.error && <p className="mt-1 truncate text-[12px] text-accent-red">{r.error}</p>}
                    {r.executionId && (
                      <Link
                        to={`/executions/${r.executionId}`}
                        className="mt-1 inline-flex items-center gap-1 rounded-md text-[12px] font-medium text-accent-blue transition-colors hover:text-accent-blue/80"
                        onClick={e => e.stopPropagation()}
                      >
                        View execution
                      </Link>
                    )}
                  </div>
                  <div className="text-right text-[12px] text-theme-muted">
                    {r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : '-'}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-app bg-app px-5 py-4">
          <span className="text-[12px] text-theme-muted">{runs.length} run{runs.length !== 1 ? 's' : ''}</span>
          <div className="flex-1" />
          <button onClick={onClose} className={secondaryButtonClass}>Close</button>
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
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-2xl animate-in fade-in zoom-in-95 flex-col overflow-hidden rounded-lg border border-app bg-app-card shadow-2xl duration-200">
        <div className="border-b border-app px-5 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-md border border-app bg-app-muted text-theme-secondary">
                {isEdit ? <Pencil className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
              </div>
              <div>
                <h2 className="text-[15px] font-semibold text-theme-primary">{isEdit ? 'Edit schedule' : 'New schedule'}</h2>
                <p className="mt-0.5 text-[12px] text-theme-muted">{isEdit ? job!.name : 'Choose when it runs and what it starts.'}</p>
              </div>
            </div>
            <IconTooltipButton label="Close" onClick={onClose}>
              <X className="h-3.5 w-3.5" />
            </IconTooltipButton>
          </div>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
          {error && (
            <div className="flex items-center gap-2 rounded-md border border-accent-red/20 bg-accent-red/10 px-3 py-2 text-[12px] text-accent-red">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />{error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={fieldLabelClass}>
                Name <span className="text-accent-red">*</span>
              </label>
              <input type="text" value={name} onChange={e => setName(e.target.value)} disabled={isEdit}
                placeholder="repo-refresh" className={`${fieldClass} font-mono`} />
            </div>
            <div>
              <label className={fieldLabelClass}>
                Display name <span className="text-accent-red">*</span>
              </label>
              <input type="text" value={displayName} onChange={e => setDisplayName(e.target.value)}
                placeholder="Repository refresh" className={fieldClass} />
            </div>
          </div>

          <div>
            <label className={fieldLabelClass}>Description</label>
            <input type="text" value={description} onChange={e => setDescription(e.target.value)}
              placeholder="Optional" className={fieldClass} />
          </div>

          <div>
            <label className={fieldLabelClass}>
              Cron schedule <span className="text-accent-red">*</span>
            </label>
            <input type="text" value={schedule} onChange={e => setSchedule(e.target.value)}
              placeholder="0 5 * * *" className={`${fieldClass} font-mono`} />
            {preview.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {preview.slice(0, 2).map(d => (
                  <span key={d} className="rounded-md border border-app bg-app-muted px-2 py-1 text-[11px] text-theme-muted">
                    {new Date(d).toLocaleString()}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Target Type */}
          <div>
            <label className={fieldLabelClass}>Target</label>
            <div className="grid grid-cols-3 gap-2 rounded-lg border border-app bg-app p-1">
              {(['agent', 'workflow', 'system'] as const).map(t => (
                <button
                  key={t}
                  onClick={() => setTargetType(t)}
                  className={`h-8 rounded-md text-[12px] font-medium capitalize transition-colors ${
                    targetType === t
                      ? 'bg-app-card text-theme-primary shadow-sm'
                      : 'text-theme-muted hover:bg-app-muted hover:text-theme-secondary'
                  }`}
                >
                  {targetTypeLabels[t]}
                </button>
              ))}
            </div>
          </div>

          {/* Agent target */}
          {targetType === 'agent' && (
            <div className="space-y-4 rounded-lg border border-app bg-app px-4 py-4">
              <div>
                <label className={fieldLabelClass}>Agent</label>
                <Select
                  value={agentName}
                  onChange={setAgentName}
                  placeholder="Select agent..."
                  searchPlaceholder="Search agents..."
                  options={agentList.map((agent: any) => ({
                    value: agent.name,
                    label: agent.displayName ?? agent.name,
                    sublabel: agent.name,
                  }))}
                />
              </div>
              <div>
                <label className={fieldLabelClass}>Prompt</label>
                <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={4}
                  placeholder="Task for the agent..." className={textareaClass} />
              </div>
              <div>
                <label className={fieldLabelClass}>Repo path <span className="text-theme-subtle">(optional)</span></label>
                <input type="text" value={repoPath} onChange={e => setRepoPath(e.target.value)}
                  placeholder="/path/to/repo" className={`${fieldClass} font-mono`} />
              </div>
            </div>
          )}

          {/* Workflow target */}
          {targetType === 'workflow' && (
            <div className="space-y-4 rounded-lg border border-app bg-app px-4 py-4">
              <div>
                <label className={fieldLabelClass}>Workflow</label>
                <Select
                  value={workflowName}
                  onChange={setWorkflowName}
                  placeholder="Select workflow..."
                  searchPlaceholder="Search workflows..."
                  options={workflowList.map((workflow: any) => {
                    const name = workflow.parsed?.name ?? workflow.name;
                    return { value: name, label: name };
                  })}
                />
              </div>
              {selectedWfInputSchema && Object.keys(selectedWfInputSchema).length > 0 && (
                <div className="space-y-3">
                  <span className="text-[12px] font-medium text-theme-secondary">Inputs</span>
                  {Object.entries(selectedWfInputSchema).map(([key, def]: [string, any]) => {
                    const val = workflowInput[key] ?? '';
                    const fieldType = (def.type ?? 'string').toLowerCase();
                    if (fieldType === 'boolean') {
                      return (
                        <label key={key} className="flex cursor-pointer items-center gap-2 text-[13px] text-theme-secondary">
                          <input type="checkbox" checked={!!val}
                            onChange={e => setWorkflowInput(p => ({ ...p, [key]: e.target.checked }))} className="accent-accent-blue" />
                          {key}{def.required && <span className="text-accent-red text-[10px]">*</span>}
                        </label>
                      );
                    }
                    if (fieldType === 'number' || fieldType === 'integer') {
                      return (
                        <div key={key}>
                          <label className={fieldLabelClass}>
                            {key}{def.required && <span className="text-accent-red normal-case text-[10px]">*</span>}
                          </label>
                          <input type="number" value={val}
                            onChange={e => setWorkflowInput(p => ({ ...p, [key]: Number(e.target.value) }))}
                            className={`${fieldClass} font-mono`} />
                        </div>
                      );
                    }
                    if (fieldType === 'object' || fieldType === 'array') {
                      return (
                        <div key={key}>
                          <label className={fieldLabelClass}>
                            {key}{def.required && <span className="text-accent-red normal-case text-[10px]">*</span>}
                            <span className="ml-1 text-[10px] text-theme-subtle">({fieldType} JSON)</span>
                          </label>
                          <textarea value={typeof val === 'string' ? val : JSON.stringify(val, null, 2)}
                            onChange={e => { try { setWorkflowInput(p => ({ ...p, [key]: JSON.parse(e.target.value) })); } catch { setWorkflowInput(p => ({ ...p, [key]: e.target.value })); } }}
                            rows={3} className={`${textareaClass} font-mono`} />
                        </div>
                      );
                    }
                    return (
                      <div key={key}>
                        <label className={fieldLabelClass}>
                          {key}{def.required && <span className="text-accent-red normal-case text-[10px]">*</span>}
                        </label>
                        <input type="text" value={val}
                          onChange={e => setWorkflowInput(p => ({ ...p, [key]: e.target.value }))}
                          placeholder={def.default != null ? String(def.default) : ''}
                          className={`${fieldClass} font-mono`} />
                      </div>
                    );
                  })}
                </div>
              )}
              {selectedWfInputSchema && Object.keys(selectedWfInputSchema).length === 0 && (
                <p className="text-[12px] text-theme-subtle">This workflow takes no inputs.</p>
              )}
            </div>
          )}

          {/* System target */}
          {targetType === 'system' && (
            <div className="space-y-4 rounded-lg border border-app bg-app px-4 py-4">
              <div>
                <label className={fieldLabelClass}>System action</label>
                <Select
                  value={systemAction}
                  onChange={setSystemAction}
                  placeholder="Select action..."
                  searchPlaceholder="Search actions..."
                  options={systemActions.map((action: any) => ({
                    value: action.name,
                    label: action.name,
                    sublabel: action.description,
                  }))}
                />
                {systemAction && systemActions.find(a => a.name === systemAction)?.description && (
                  <p className="mt-2 text-[12px] text-theme-muted">{systemActions.find(a => a.name === systemAction)?.description}</p>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-app bg-app px-5 py-4">
          <button onClick={onClose} className={secondaryButtonClass}>Cancel</button>
          <button onClick={handleSubmit} disabled={saving} className={primaryButtonClass}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : isEdit ? <Pencil className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            {saving ? 'Saving...' : isEdit ? 'Save changes' : 'Create schedule'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ScheduleDeleteDialog({
  job,
  onCancel,
  onConfirm,
}: {
  job: { id: string; name: string } | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!job) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md animate-in fade-in zoom-in-95 overflow-hidden rounded-lg border border-app bg-app-card shadow-2xl duration-200">
        <div className="border-b border-app px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-accent-red/20 bg-accent-red/10 text-accent-red">
                <Trash2 className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <h2 className="text-[15px] font-semibold text-theme-primary">Delete schedule</h2>
                <p className="mt-1 text-[12px] text-theme-muted">This removes the schedule and its future runs.</p>
              </div>
            </div>
            <IconTooltipButton label="Close" onClick={onCancel}>
              <X className="h-3.5 w-3.5" />
            </IconTooltipButton>
          </div>
        </div>
        <div className="px-5 py-4">
          <div className="rounded-lg border border-app bg-app px-3 py-3">
            <div className="text-[13px] font-medium text-theme-primary">{job.name}</div>
            <div className="mt-1 text-[12px] text-theme-muted">This action cannot be undone.</div>
          </div>
        </div>
        <div className="flex justify-end gap-3 border-t border-app bg-app px-5 py-4">
          <button onClick={onCancel} className={secondaryButtonClass}>Cancel</button>
          <button
            onClick={onConfirm}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-accent-red/35 bg-accent-red px-3.5 text-[13px] font-medium text-white transition-colors hover:bg-accent-red/90"
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Main Page ──────────────────────────────────────────────────────────── */

export default function CronManagerPage({ compact = false }: { compact?: boolean }) {
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

  const enabledCount = jobs.filter(job => job.enabled).length;
  const failedCount = jobs.filter(job => job.lastRunStatus === 'failed').length;

  return (
    <div className={`space-y-4 cron-manager-page ${compact ? 'cron-manager-page--compact' : ''}`}>
      <div className="rounded-lg border border-app bg-app-card">
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <MetricPill label="total" value={jobs.length} />
            <MetricPill label="enabled" value={enabledCount} />
            {failedCount > 0 && (
              <MetricPill label="failing" value={failedCount} tone="danger" />
            )}
          </div>
          <div className="flex items-center gap-2">
            <IconTooltipButton label="Refresh schedules" onClick={refresh}>
              <RefreshCw className="h-3.5 w-3.5" />
            </IconTooltipButton>
            <button
              onClick={() => { setEditJob(null); setFormOpen(true); }}
              className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-accent/40 bg-accent px-3.5 text-[13px] font-medium text-white transition-colors hover:bg-accent-hover"
            >
              <Plus className="h-3.5 w-3.5" />
              New schedule
            </button>
          </div>
        </div>
      </div>

      {/* Loading */}
      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-lg border border-app bg-app-card p-4 animate-pulse">
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
        <div className="mt-3 rounded-lg border border-dashed border-app-strong bg-app-card px-5 py-12 text-center">
          <Clock className="w-10 h-10 text-theme-subtle mx-auto mb-3" />
          <p className="text-sm text-theme-muted font-body">No scheduled jobs yet. Create one to get started.</p>
        </div>
      ) : (
        <div className="mt-3 overflow-hidden rounded-lg border border-app bg-app-card">
          <div className="hidden border-b border-app bg-app px-4 py-2 text-[11px] font-medium text-theme-subtle lg:grid lg:grid-cols-[minmax(340px,1fr)_150px_100px_64px_132px_52px] lg:gap-4">
            <div>Schedule</div>
            <div>Last run</div>
            <div>Next</div>
            <div>Runs</div>
            <div className="text-right">Actions</div>
            <div className="text-right">On</div>
          </div>
          {jobs.map(job => {
            const isRunning = runningId === job._id;
            return (
              <div
                key={job._id}
                className={`cron-job-row border-b border-app px-4 py-3 transition-colors last:border-b-0 hover:bg-app-muted/25 ${!job.enabled ? 'opacity-60' : ''}`}
              >
                <div className="cron-job-grid grid items-center gap-4 lg:grid-cols-[minmax(340px,1fr)_150px_100px_64px_132px_52px]">
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-start gap-3">
                      <div className="cron-job-icon mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-app bg-app-muted text-theme-muted">
                        <Clock className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-[14px] font-semibold text-theme-primary">{job.displayName}</span>
                          <span className="inline-flex h-6 shrink-0 items-center rounded-md border border-app bg-app px-2 text-[11px] font-medium text-theme-muted">
                            {targetTypeLabels[job.target?.type] ?? job.target?.type ?? '-'}
                          </span>
                        </div>
                        <div className="mt-1 flex min-w-0 items-center gap-2 text-[12px] text-theme-muted">
                          <span className="rounded-md border border-app bg-app px-2 py-0.5 font-mono text-[11px] text-theme-secondary" title="Cron schedule">
                            {job.schedule}
                          </span>
                          <span className="truncate">{targetSummary(job.target)}</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <StatusBadge status={job.lastRunStatus} />
                      <span className="text-[12px] text-theme-muted">{timeAgo(job.lastRunAt)}</span>
                    </div>
                  </div>

                  <div className="min-w-0">
                    <div className="text-[13px] text-theme-secondary">{job.enabled ? timeUntil(job.nextRunAt) : 'Disabled'}</div>
                  </div>

                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-theme-primary">{job.runCount}</div>
                  </div>

                  <div className="cron-full-actions flex items-center justify-end gap-1">
                    <IconTooltipButton label="Run now" tone="accent" onClick={() => runNow(job)} disabled={isRunning}>
                      {isRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                    </IconTooltipButton>
                    <IconTooltipButton label="Run history" onClick={() => setHistoryJob(job)}>
                      <History className="w-3.5 h-3.5" />
                    </IconTooltipButton>
                    <IconTooltipButton label="Edit schedule" onClick={() => { setEditJob(job); setFormOpen(true); }}>
                      <Pencil className="w-3.5 h-3.5" />
                    </IconTooltipButton>
                    {!job.isBuiltIn && (
                      <IconTooltipButton label="Delete schedule" tone="danger" onClick={() => setDeletingJob({ id: job._id, name: job.displayName })}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </IconTooltipButton>
                    )}
                  </div>

                  {compact && (
                    <div className="cron-compact-more flex justify-end">
                      <IconTooltipButton label="Edit schedule" onClick={() => { setEditJob(job); setFormOpen(true); }}>
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </IconTooltipButton>
                    </div>
                  )}

                  <div className="flex justify-end">
                    <ToggleSwitch enabled={job.enabled} onChange={() => toggle(job)} />
                  </div>
                </div>

                {/* Error row */}
                {job.lastRunError && job.lastRunStatus === 'failed' && (
                  <div className="mt-3 rounded-md border border-accent-red/20 bg-accent-red/10 px-3 py-2 text-[12px] text-accent-red">
                    {job.lastRunError}
                  </div>
                )}

                {job.lastRunExecutionId && (
                  <div className="mt-2">
                    <Link
                      to={`/executions/${job.lastRunExecutionId}`}
                      className="inline-flex items-center gap-1 rounded-md px-1 text-[11px] font-medium text-accent-blue transition-colors hover:bg-accent-blue/10 hover:text-accent-blue"
                    >
                      View last execution <span className="font-mono">{job.lastRunExecutionId.slice(0, 12)}</span>
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
      <ScheduleDeleteDialog
        job={deletingJob}
        onConfirm={handleDelete}
        onCancel={() => setDeletingJob(null)}
      />
    </div>
  );
}
