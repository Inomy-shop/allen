import { useState, useCallback, useMemo } from 'react';
import { useWorkflows } from '../hooks/useWorkflows';
import { workflows as wfApi, executions as execApi } from '../services/api';
import { useNavigate, Link } from 'react-router-dom';
import {
  GitBranch, Plus, Play, Trash2, CheckCircle, XCircle, AlertTriangle,
  RefreshCw, X, Pencil, Loader2, Layers, ArrowRight, Sparkles,
} from 'lucide-react';
import { CardSkeleton } from '../components/common/Skeleton';

interface RunDialogState {
  open: boolean;
  workflow: any | null;
}

export default function WorkflowListPage() {
  const { workflows, loading, refresh } = useWorkflows();
  const navigate = useNavigate();
  const [runningId, setRunningId] = useState<string | null>(null);
  const [runDialog, setRunDialog] = useState<RunDialogState>({ open: false, workflow: null });
  const [runInput, setRunInput] = useState<Record<string, string>>({});

  const stats = useMemo(() => {
    const map: Record<string, { nodes: number; edges: number }> = {};
    for (const wf of workflows) {
      const nodes = wf.parsed?.nodes ? Object.keys(wf.parsed.nodes).length : 0;
      const edges = wf.parsed?.edges?.length ?? 0;
      map[wf._id] = { nodes, edges };
    }
    return map;
  }, [workflows]);

  const openRunDialog = useCallback((wf: any) => {
    const defaults: Record<string, string> = {};
    if (wf.parsed?.input) {
      for (const key of Object.keys(wf.parsed.input)) defaults[key] = '';
    } else {
      defaults['task'] = '';
      defaults['repo_path'] = '';
    }
    setRunInput(defaults);
    setRunDialog({ open: true, workflow: wf });
  }, []);

  const handleRun = useCallback(async () => {
    const wf = runDialog.workflow;
    if (!wf) return;
    setRunningId(wf._id);
    setRunDialog({ open: false, workflow: null });
    try {
      const input: Record<string, string> = {};
      for (const [k, v] of Object.entries(runInput)) {
        if (v.trim()) input[k] = v.trim();
      }
      const exec = await execApi.start(wf._id, input);
      navigate(`/executions/${exec.id}`);
    } catch (e: any) {
      alert(e.message);
    }
    setRunningId(null);
  }, [navigate, runDialog.workflow, runInput]);

  const handleDelete = useCallback(async (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm('Delete this workflow?')) return;
    await wfApi.delete(id);
    refresh();
  }, [refresh]);

  if (loading) {
    return (
      <div className="p-8">
        <div className="mb-8"><div className="h-7 w-40 bg-surface-200 rounded-sm animate-pulse" /></div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {Array.from({ length: 6 }).map((_, i) => <CardSkeleton key={i} />)}
        </div>
      </div>
    );
  }

  return (
    <div className="p-8">
      {/* Page header */}
      <div className="flex items-end justify-between mb-8">
        <div>
          <h1 className="font-heading text-2xl font-bold text-white tracking-widest uppercase">Workflows</h1>
          <p className="text-sm text-gray-500 mt-1 font-mono">
            {workflows.length} workflow{workflows.length !== 1 ? 's' : ''} available
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={refresh} className="p-2 rounded-sm text-gray-500 hover:text-accent-blue hover:bg-accent-blue/5 transition-all">
            <RefreshCw className="w-4 h-4" />
          </button>
          <Link
            to="/workflows/new"
            className="btn-primary inline-flex items-center gap-2"
          >
            <Plus className="w-4 h-4" /> New Workflow
          </Link>
        </div>
      </div>

      {/* Empty state */}
      {workflows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20">
          <div className="w-20 h-20 rounded-sm bg-surface-200 flex items-center justify-center mb-6 border border-accent-blue/20 shadow-glow-blue/20">
            <Sparkles className="w-9 h-9 text-accent-blue/50" />
          </div>
          <h2 className="font-heading text-lg font-semibold text-white mb-2 tracking-wider uppercase">No workflows yet</h2>
          <p className="text-sm text-gray-500 mb-8 max-w-sm text-center font-body">
            Create your first workflow to start orchestrating AI agents with visual pipelines.
          </p>
          <Link
            to="/workflows/new"
            className="btn-primary inline-flex items-center gap-2 px-5 py-3"
          >
            <Plus className="w-4 h-4" /> Create Your First Workflow
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {workflows.map((wf: any) => {
            const wfStats = stats[wf._id] ?? { nodes: 0, edges: 0 };
            const isValid = wf.validation?.valid;
            const hasWarnings = (wf.validation?.warnings?.length ?? 0) > 0;
            const isRunning = runningId === wf._id;

            return (
              <div
                key={wf._id}
                className="group relative overflow-hidden card
                  hover:shadow-glow-blue/10 hover:border-accent-blue/30
                  transition-all duration-300"
              >
                {/* Top accent — thin gradient line */}
                <div className={`h-0.5 ${
                  isValid
                    ? 'bg-gradient-to-r from-accent-blue via-accent-cyan to-accent-green'
                    : 'bg-gradient-to-r from-accent-red via-accent-orange to-accent-yellow'
                }`} />

                <div className="p-6">
                  {/* Header: icon + name + version + delete */}
                  <div className="flex items-start gap-3 mb-4">
                    <div className={`w-10 h-10 rounded-sm flex items-center justify-center shrink-0 border
                      ${isValid
                        ? 'bg-accent-blue/10 border-accent-blue/30'
                        : 'bg-accent-red/10 border-accent-red/30'
                      }`}>
                      <GitBranch className={`w-5 h-5 ${isValid ? 'text-accent-blue' : 'text-accent-red'}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="text-[15px] font-heading font-semibold text-white truncate leading-tight tracking-wider">{wf.name}</h3>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[11px] text-gray-500 font-mono">v{wf.version}</span>
                        <span className="text-gray-700">|</span>
                        <span className="text-[11px] text-gray-500 font-mono">{wfStats.nodes} nodes</span>
                        <span className="text-gray-700">|</span>
                        <span className="text-[11px] text-gray-500 font-mono">{wfStats.edges} edges</span>
                      </div>
                    </div>
                    <button
                      onClick={(e) => handleDelete(e, wf._id)}
                      className="opacity-0 group-hover:opacity-100 p-1.5 -mr-1 rounded-sm
                        text-gray-600 hover:text-accent-red hover:bg-accent-red/10
                        transition-all duration-200"
                      title="Delete"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>

                  {/* Description */}
                  <p className={`text-[13px] leading-relaxed mb-4 line-clamp-2 font-body ${
                    wf.description ? 'text-gray-400' : 'text-gray-600 italic'
                  }`}>
                    {wf.description || 'No description'}
                  </p>

                  {/* Tags */}
                  {wf.tags?.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-4">
                      {wf.tags.map((tag: string) => (
                        <span key={tag} className="text-[11px] px-2.5 py-1 rounded-sm bg-surface-200/80 text-gray-400 border border-border/40 font-mono uppercase tracking-wider">
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Validation status */}
                  <div className="flex items-center gap-2 mb-5">
                    {isValid ? (
                      <span className="inline-flex items-center gap-1.5 text-[11px] font-label font-semibold text-accent-green bg-accent-green/10 px-2.5 py-1 rounded-sm uppercase tracking-wider">
                        <CheckCircle className="w-3.5 h-3.5" /> Valid
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-[11px] font-label font-semibold text-accent-red bg-accent-red/10 px-2.5 py-1 rounded-sm uppercase tracking-wider">
                        <XCircle className="w-3.5 h-3.5" /> {wf.validation?.errors?.length ?? 0} error{(wf.validation?.errors?.length ?? 0) !== 1 ? 's' : ''}
                      </span>
                    )}
                    {hasWarnings && (
                      <span className="inline-flex items-center gap-1.5 text-[11px] font-label font-semibold text-accent-yellow bg-accent-yellow/10 px-2.5 py-1 rounded-sm uppercase tracking-wider">
                        <AlertTriangle className="w-3 h-3" /> {wf.validation.warnings.length}
                      </span>
                    )}
                  </div>

                  {/* Action buttons */}
                  <div className="flex items-center gap-2.5">
                    <Link
                      to={`/workflows/${wf._id}/edit`}
                      className="btn-ghost inline-flex items-center gap-1.5 text-xs"
                    >
                      <Pencil className="w-3.5 h-3.5" /> Edit
                    </Link>
                    <button
                      onClick={() => openRunDialog(wf)}
                      disabled={isRunning || !isValid}
                      className={`flex-1 btn inline-flex items-center justify-center gap-2
                        ${isValid
                          ? 'bg-accent-blue/15 border-accent-blue/50 text-accent-blue hover:bg-accent-blue/25 hover:shadow-glow-blue'
                          : 'bg-surface-200 border-border text-gray-500 cursor-not-allowed'
                        }
                        disabled:opacity-40 disabled:shadow-none disabled:cursor-not-allowed
                      `}
                    >
                      {isRunning ? (
                        <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Starting...</>
                      ) : (
                        <><Play className="w-3.5 h-3.5" /> Run</>
                      )}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Run Dialog ── */}
      {runDialog.open && runDialog.workflow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md">
          <div
            className="card w-full max-w-lg overflow-hidden
              shadow-glow-blue/20
              animate-in fade-in zoom-in-95 duration-200"
          >
            {/* Header */}
            <div className="px-6 py-5 border-b border-border/60">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-sm bg-accent-blue/10 border border-accent-blue/30 flex items-center justify-center">
                    <Play className="w-5 h-5 text-accent-blue" />
                  </div>
                  <div>
                    <h2 className="font-heading text-sm font-bold text-white tracking-wider uppercase">Run Workflow</h2>
                    <p className="text-[11px] text-gray-500 font-mono">{runDialog.workflow.name}</p>
                  </div>
                </div>
                <button
                  onClick={() => setRunDialog({ open: false, workflow: null })}
                  className="p-2 rounded-sm hover:bg-surface-200 text-gray-500 hover:text-gray-300 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              {runDialog.workflow.description && (
                <p className="text-xs text-gray-400 mt-3 leading-relaxed font-body">{runDialog.workflow.description}</p>
              )}
            </div>

            {/* Input fields */}
            <div className="px-6 py-5 space-y-4 max-h-[50vh] overflow-auto">
              {Object.entries(runInput).map(([key, value]) => {
                const schema = runDialog.workflow.parsed?.input?.[key];
                const isRequired = schema?.required !== false;
                const isPath = key.includes('path') || key.includes('repo');
                const isLong = ['task', 'topic', 'question', 'problem', 'description'].includes(key);

                return (
                  <div key={key}>
                    <label className="flex items-center gap-1 text-xs font-label font-semibold text-gray-400 mb-2 uppercase tracking-widest">
                      {key.replace(/_/g, ' ')}
                      {isRequired && <span className="text-accent-red normal-case text-[10px]">*</span>}
                    </label>
                    {isPath ? (
                      <input
                        type="text"
                        value={value}
                        onChange={e => setRunInput(prev => ({ ...prev, [key]: e.target.value }))}
                        placeholder="/path/to/your/project"
                        className="input w-full font-mono text-sm"
                      />
                    ) : (
                      <textarea
                        value={value}
                        onChange={e => setRunInput(prev => ({ ...prev, [key]: e.target.value }))}
                        placeholder={`Enter ${key.replace(/_/g, ' ')}...`}
                        rows={isLong ? 3 : 1}
                        className="input w-full text-sm resize-none"
                      />
                    )}
                  </div>
                );
              })}
            </div>

            {/* Footer */}
            <div className="flex items-center gap-3 px-6 py-5 border-t border-border/60 bg-surface-50/50">
              <button
                onClick={() => setRunDialog({ open: false, workflow: null })}
                className="flex-1 btn-ghost"
              >
                Cancel
              </button>
              <button
                onClick={handleRun}
                className="flex-1 btn-primary inline-flex items-center justify-center gap-2"
              >
                <Play className="w-4 h-4" /> Run Workflow
                <ArrowRight className="w-3.5 h-3.5 opacity-60" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
