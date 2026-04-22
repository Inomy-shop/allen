import { useState, useCallback, useMemo, useEffect } from 'react';
import { useWorkflows } from '../hooks/useWorkflows';
import { workflows as wfApi, executions as execApi, repos as repoApi } from '../services/api';
import { useNavigate, Link } from 'react-router-dom';
import {
  GitBranch, Plus, Play, Trash2, CheckCircle, XCircle,
  RefreshCw, X, Pencil, Loader2, Layers, ArrowRight, Sparkles,
  ChevronDown, ChevronRight, Tag, FileText, Shield,
} from 'lucide-react';
import DeleteConfirmDialog from '../components/common/DeleteConfirmDialog';
import { useToast } from '../components/common/Toast';
import WorkflowRunDialog from '../components/workflow/WorkflowRunDialog';

interface RunDialogState {
  open: boolean;
  workflow: any | null;
}

interface WorkflowExecStats {
  total: number;
  completed: number;
  failed: number;
  running: number;
}

// ── Loading Row Skeleton ────────────────────────────────────────────────────

function RowSkeleton() {
  return (
    <div className="flex items-center gap-4 px-4 py-3 border-b border-border/10 animate-pulse">
      <div className="w-5" />
      <div className="w-8 h-8 rounded-lg bg-surface-200/50" />
      <div className="w-48 space-y-1.5">
        <div className="h-3.5 w-32 bg-surface-200/50 rounded" />
        <div className="h-2.5 w-20 bg-surface-200/30 rounded" />
      </div>
      <div className="flex-1">
        <div className="h-3 w-40 bg-surface-200/30 rounded" />
      </div>
      <div className="h-5 w-10 bg-surface-200/30 rounded-full" />
      <div className="flex gap-2">
        <div className="h-4 w-10 bg-surface-200/20 rounded" />
        <div className="h-4 w-10 bg-surface-200/20 rounded" />
        <div className="h-4 w-10 bg-surface-200/20 rounded" />
      </div>
      <div className="flex gap-1.5">
        <div className="h-6 w-14 bg-surface-200/30 rounded-full" />
        <div className="h-6 w-14 bg-surface-200/30 rounded-full" />
        <div className="h-6 w-16 bg-surface-200/30 rounded-full" />
      </div>
    </div>
  );
}

export default function WorkflowListPage() {
  const { workflows, loading, refresh } = useWorkflows();
  const navigate = useNavigate();
  const toast = useToast();

  const [runningId] = useState<string | null>(null);
  const [runDialog, setRunDialog] = useState<RunDialogState>({ open: false, workflow: null });
  const [deletingWf, setDeletingWf] = useState<{ id: string; name: string } | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const stats = useMemo(() => {
    const map: Record<string, { nodes: number; edges: number }> = {};
    for (const wf of workflows) {
      const nodes = wf.parsed?.nodes ? Object.keys(wf.parsed.nodes).length : 0;
      const edges = wf.parsed?.edges?.length ?? 0;
      map[wf._id] = { nodes, edges };
    }
    return map;
  }, [workflows]);

  const [execStats, setExecStats] = useState<Record<string, WorkflowExecStats>>({});
  useEffect(() => {
    execApi.list().then((execs: any[]) => {
      const map: Record<string, WorkflowExecStats> = {};
      for (const exec of execs) {
        const name = exec.workflowName;
        if (!map[name]) map[name] = { total: 0, completed: 0, failed: 0, running: 0 };
        map[name].total++;
        if (exec.status === 'completed') map[name].completed++;
        else if (exec.status === 'failed') map[name].failed++;
        else if (exec.status === 'running') map[name].running++;
      }
      setExecStats(map);
    }).catch(() => {});
  }, [workflows]);

  // Open dialog: we just pass the workflow `{_id, name}` — the shared
  // WorkflowRunDialog fetches the full record and loads repos internally.
  const openRunDialog = useCallback((wf: any) => {
    setRunDialog({ open: true, workflow: wf });
  }, []);

  const handleDelete = useCallback(async () => {
    if (!deletingWf) return;
    try {
      await wfApi.delete(deletingWf.id);
      toast.success(`Workflow "${deletingWf.name}" deleted`);
      refresh();
    } catch (e: any) {
      toast.error(e.message || 'Failed to delete workflow');
    }
    setDeletingWf(null);
  }, [deletingWf, refresh, toast]);

  const toggleExpand = useCallback((id: string) => {
    setExpandedId(prev => (prev === id ? null : id));
  }, []);

  /* ── Loading skeleton ── */
  if (loading) {
    return (
      <div className="p-6">
        <div className="mb-6">
          <div className="h-7 w-48 bg-surface-200 rounded-sm animate-pulse" />
        </div>
        <div>{Array.from({ length: 5 }).map((_, i) => <RowSkeleton key={i} />)}</div>
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* ── Page header ── */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-4">
          <h1 className="font-heading text-xl font-bold text-theme-primary tracking-widest uppercase">
            Agent Workflows
          </h1>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1 text-[10px] font-mono text-theme-muted">
              <GitBranch className="w-3 h-3 text-accent-blue" /> {workflows.length} workflows
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            title="Refresh"
            onClick={refresh}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-mono bg-surface-200/30 text-theme-muted hover:bg-surface-200/50 transition-colors"
          >
            <RefreshCw className="w-3 h-3" />
          </button>
          <Link
            to="/workflows/new"
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-[10px] font-mono bg-accent-blue/10 text-accent-blue hover:bg-accent-blue/20 transition-colors"
          >
            <Plus className="w-3 h-3" /> New Workflow
          </Link>
        </div>
      </div>

      {/* ── Empty state ── */}
      {workflows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24">
          <div className="w-16 h-16 rounded-lg bg-accent-blue/10 flex items-center justify-center mb-6">
            <Sparkles className="w-8 h-8 text-accent-blue/50" />
          </div>
          <h2 className="font-heading text-lg font-semibold text-theme-primary mb-2 tracking-wider uppercase">
            No workflows yet
          </h2>
          <p className="text-sm text-theme-muted mb-8 max-w-sm text-center font-body">
            Create your first workflow to start orchestrating AI agents with visual pipelines.
          </p>
          <Link
            to="/workflows/new"
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-mono bg-accent-blue/10 text-accent-blue hover:bg-accent-blue/20 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" /> Create Your First Workflow
          </Link>
        </div>
      ) : (
        /* ── Workflow list ── */
        <div>
          {/* Column headers */}
          <div className="flex items-center gap-4 px-4 py-2 border-b border-border/20 text-[10px] font-label uppercase tracking-widest text-theme-subtle">
            <span className="w-5" />
            <span className="w-8" />
            <span className="w-48">Name</span>
            <span className="flex-1">Description</span>
            <span className="w-16 text-center">Nodes</span>
            <span className="w-40 text-center">Run Stats</span>
            <span className="w-48 text-right">Actions</span>
          </div>

          {workflows.map((wf: any) => {
            const wfStats = stats[wf._id] ?? { nodes: 0, edges: 0 };
            const es = execStats[wf.name] ?? { total: 0, completed: 0, failed: 0, running: 0 };
            const isValid = wf.validation?.valid;
            const isRunning = runningId === wf._id;
            const isExpanded = expandedId === wf._id;
            const inputKeys = wf.parsed?.input ? Object.keys(wf.parsed.input) : [];

            return (
              <div key={wf._id}>
                {/* ── Row ── */}
                <div
                  className="flex items-center gap-4 px-4 py-3 border-b border-border/10 hover:bg-surface-200/10 transition-colors cursor-pointer select-none"
                  onClick={() => toggleExpand(wf._id)}
                >
                  {/* Expand chevron */}
                  <span className="w-5 shrink-0 text-theme-muted">
                    {isExpanded
                      ? <ChevronDown className="w-4 h-4" />
                      : <ChevronRight className="w-4 h-4" />
                    }
                  </span>

                  {/* Workflow icon with colored bg */}
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${isValid ? 'bg-accent-blue/10' : 'bg-accent-red/10'}`}>
                    <GitBranch className={`w-4 h-4 ${isValid ? 'text-accent-blue' : 'text-accent-red'}`} />
                  </div>

                  {/* Name + validity */}
                  <div className="w-48 min-w-0 shrink-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[13px] font-heading font-semibold text-theme-primary truncate tracking-wider">
                        {wf.name}
                      </span>
                      {isValid
                        ? <CheckCircle className="w-3 h-3 text-accent-green shrink-0" />
                        : <XCircle className="w-3 h-3 text-accent-red shrink-0" />
                      }
                    </div>
                    <span className="text-[10px] font-mono text-theme-subtle block">v{wf.version}</span>
                  </div>

                  {/* Description (truncated) */}
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] text-theme-muted font-body truncate">
                      {wf.description || 'No description'}
                    </p>
                  </div>

                  {/* Node count stat */}
                  <div className="w-16 flex justify-center">
                    <div className="flex items-center gap-1 text-[10px] font-mono text-theme-muted">
                      <Layers className="w-3 h-3 text-accent-blue" /> {wfStats.nodes}
                    </div>
                  </div>

                  {/* Run stats — green check, red X, blue play */}
                  <div className="w-40 flex items-center justify-center gap-3">
                    <div className="flex items-center gap-1 text-[10px] font-mono text-theme-muted">
                      <CheckCircle className="w-3 h-3 text-accent-green" /> {es.completed}
                    </div>
                    <div className="flex items-center gap-1 text-[10px] font-mono text-theme-muted">
                      <XCircle className="w-3 h-3 text-accent-red" /> {es.failed}
                    </div>
                    <div className="flex items-center gap-1 text-[10px] font-mono text-theme-muted">
                      <Play className="w-3 h-3 text-accent-blue" /> {es.total}
                    </div>
                  </div>

                  {/* Actions — always visible */}
                  <div className="w-48 flex items-center justify-end gap-1.5 shrink-0" onClick={e => e.stopPropagation()}>
                    <button
                      onClick={() => openRunDialog(wf)}
                      disabled={isRunning || !isValid}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-mono bg-accent-green/10 text-accent-green hover:bg-accent-green/20 transition-colors disabled:opacity-30"
                    >
                      {isRunning
                        ? <><Loader2 className="w-3 h-3 animate-spin" /> Starting</>
                        : <><Play className="w-3 h-3" /> Run</>
                      }
                    </button>
                    <Link
                      to={`/workflows/${wf._id}/edit`}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-mono bg-accent-yellow/10 text-accent-yellow hover:bg-accent-yellow/20 transition-colors"
                    >
                      <Pencil className="w-3 h-3" /> Edit
                    </Link>
                    <button
                      onClick={() => setDeletingWf({ id: wf._id, name: wf.name })}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-mono bg-accent-red/10 text-accent-red hover:bg-accent-red/20 transition-colors"
                      title="Delete workflow"
                    >
                      <Trash2 className="w-3 h-3" /> Delete
                    </button>
                  </div>
                </div>

                {/* ── Expanded detail ── */}
                {isExpanded && (
                  <div className="bg-surface-200/5 border-b border-border/15 px-8 py-4 space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      {/* Full description */}
                      <div>
                        <p className="text-[10px] font-label uppercase tracking-widest text-theme-subtle mb-2">
                          Description
                        </p>
                        <p className="text-sm text-theme-primary font-body leading-relaxed">
                          {wf.description || 'No description provided.'}
                        </p>
                      </div>

                      {/* Validation status */}
                      <div>
                        <p className="text-[10px] font-label uppercase tracking-widest text-theme-subtle mb-2">
                          Validation
                        </p>
                        <div className="flex items-center gap-2">
                          <div className={`w-6 h-6 rounded-lg flex items-center justify-center ${isValid ? 'bg-accent-green/10' : 'bg-accent-red/10'}`}>
                            <Shield className={`w-3.5 h-3.5 ${isValid ? 'text-accent-green' : 'text-accent-red'}`} />
                          </div>
                          <span className={`text-sm font-body ${isValid ? 'text-accent-green' : 'text-accent-red'}`}>
                            {isValid ? 'Valid' : 'Invalid'}
                          </span>
                          <span className="text-[10px] text-theme-muted font-mono ml-2">v{wf.version}</span>
                        </div>
                        {!isValid && wf.validation?.errors?.length > 0 && (
                          <ul className="mt-2 space-y-1">
                            {wf.validation.errors.map((err: string, i: number) => (
                              <li key={i} className="text-xs text-accent-red font-mono">
                                {err}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      {/* Tags */}
                      <div>
                        <p className="text-[10px] font-label uppercase tracking-widest text-theme-subtle mb-2">
                          Tags
                        </p>
                        {wf.tags?.length > 0 ? (
                          <div className="flex flex-wrap gap-1.5">
                            {wf.tags.map((tag: string) => (
                              <span
                                key={tag}
                                className="inline-flex items-center gap-1 text-[9px] px-2 py-0.5 rounded-full bg-accent-purple/10 text-accent-purple font-mono"
                              >
                                <Tag className="w-2.5 h-2.5" /> {tag}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-xs text-theme-subtle font-body">No tags</span>
                        )}
                      </div>

                      {/* Input schema */}
                      <div>
                        <p className="text-[10px] font-label uppercase tracking-widest text-theme-subtle mb-2">
                          Input Schema
                        </p>
                        {inputKeys.length > 0 ? (
                          <div className="flex flex-wrap gap-1.5">
                            {inputKeys.map((key: string) => {
                              const schema = wf.parsed.input[key];
                              const required = schema?.required !== false;
                              return (
                                <span
                                  key={key}
                                  className="inline-flex items-center gap-1 text-[9px] px-2 py-0.5 rounded-full bg-accent-blue/10 text-accent-blue font-mono"
                                >
                                  <FileText className="w-2.5 h-2.5" />
                                  {key}
                                  {required && <span className="text-accent-red">*</span>}
                                </span>
                              );
                            })}
                          </div>
                        ) : (
                          <span className="text-xs text-theme-subtle font-body">No inputs defined</span>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Run Dialog (extracted to shared component) ── */}
      {runDialog.open && runDialog.workflow && (
        <WorkflowRunDialog
          workflow={runDialog.workflow}
          onClose={() => setRunDialog({ open: false, workflow: null })}
          onStarted={(exec) => {
            setRunDialog({ open: false, workflow: null });
            navigate(`/executions/${exec.id}`);
          }}
        />
      )}


      <DeleteConfirmDialog
        open={!!deletingWf}
        resourceType="workflow"
        resourceName={deletingWf?.name ?? ''}
        onConfirm={handleDelete}
        onCancel={() => setDeletingWf(null)}
      />
    </div>
  );
}
