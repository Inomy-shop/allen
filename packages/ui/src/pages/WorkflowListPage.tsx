import { useState, useCallback, useMemo } from 'react';
import { useWorkflows } from '../hooks/useWorkflows';
import { useNavigate, Link } from 'react-router-dom';
import {
  GitBranch, Plus, Play, CheckCircle, XCircle,
  RefreshCw, Loader2, Layers, Sparkles,
  ChevronDown, ChevronRight, Tag, FileText, Shield,
  Search, Pencil, Trash2, Clock3,
} from 'lucide-react';
import WorkflowRunDialog from '../components/workflow/WorkflowRunDialog';
import { workflowEdges, workflowInput, workflowNodes } from '../utils/workflowShape';
import IconTooltipButton from '../components/common/IconTooltipButton';
import DeleteConfirmDialog from '../components/common/DeleteConfirmDialog';
import { workflows as workflowsApi } from '../services/api';
import { useToast } from '../components/common/Toast';

interface RunDialogState {
  open: boolean;
  workflow: any | null;
}

function shortDescription(description?: string): string {
  const value = description?.trim();
  if (!value) return 'No description';
  const compact = value.replace(/\s+/g, ' ');
  return compact.length > 72 ? `${compact.slice(0, 69).trim()}...` : compact;
}

function workflowRunCount(workflow: any): number {
  const value = workflow.runCount ?? workflow.executionCount ?? workflow.runs;
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

// ── Loading Row Skeleton ────────────────────────────────────────────────────

function RowSkeleton() {
  return (
    <div className="flex items-center gap-4 px-4 py-3 border-b border-border/10 animate-pulse">
      <div className="w-5" />
      <div className="w-48 space-y-1.5">
        <div className="h-3.5 w-32 bg-app-muted rounded" />
        <div className="h-2.5 w-20 bg-app-muted/50 rounded" />
      </div>
      <div className="flex-1">
        <div className="h-3 w-40 bg-app-muted/50 rounded" />
      </div>
      <div className="h-5 w-10 bg-app-muted/50 rounded-full" />
      <div className="flex gap-1.5">
        <div className="h-6 w-14 bg-app-muted/50 rounded-full" />
        <div className="h-6 w-14 bg-app-muted/50 rounded-full" />
        <div className="h-6 w-16 bg-app-muted/50 rounded-full" />
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
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [deletingWorkflow, setDeletingWorkflow] = useState<any | null>(null);

  const stats = useMemo(() => {
    const map: Record<string, { nodes: number; edges: number }> = {};
    for (const wf of workflows) {
      const nodes = Object.keys(workflowNodes(wf)).length;
      const edges = workflowEdges(wf).length;
      map[wf._id] = { nodes, edges };
    }
    return map;
  }, [workflows]);

  const filteredWorkflows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return workflows;
    return workflows.filter((wf: any) => {
      const tags = Array.isArray(wf.tags) ? wf.tags.join(' ') : '';
      return [
        wf.name,
        wf.description,
        wf.version ? `v${wf.version}` : '',
        tags,
      ].filter(Boolean).join(' ').toLowerCase().includes(q);
    });
  }, [query, workflows]);

  // Open dialog: we just pass the workflow `{_id, name}` — the shared
  // WorkflowRunDialog fetches the full record and loads repos internally.
  const openRunDialog = useCallback((wf: any) => {
    setRunDialog({ open: true, workflow: wf });
  }, []);

  const toggleExpand = useCallback((id: string) => {
    setExpandedId(prev => (prev === id ? null : id));
  }, []);

  const deleteWorkflow = useCallback(async () => {
    if (!deletingWorkflow?._id) return;
    try {
      await workflowsApi.delete(deletingWorkflow._id);
      toast.success(`Workflow "${deletingWorkflow.name}" deleted`);
      setDeletingWorkflow(null);
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete workflow');
    }
  }, [deletingWorkflow, refresh, toast]);

  /* ── Loading skeleton ── */
  if (loading) {
    return (
      <div className="w-full px-8 py-8">
        <div className="mb-6 flex items-center justify-between">
          <div className="h-8 w-52 rounded-md bg-app-muted animate-pulse" />
          <div className="h-9 w-36 rounded-md bg-app-muted animate-pulse" />
        </div>
        <div className="overflow-hidden rounded-md border border-app bg-app-card">{Array.from({ length: 5 }).map((_, i) => <RowSkeleton key={i} />)}</div>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-5 px-8 py-8">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md border border-app bg-app-card text-accent">
            <GitBranch className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h1 className="text-[24px] font-semibold tracking-tight text-theme-primary">Workflows</h1>
            <p className="mt-1 text-[13px] text-theme-muted">Reusable agent pipelines for repeatable Allen work.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <IconTooltipButton label="Refresh" onClick={refresh} className="h-9 w-9 rounded-md border border-app bg-app-card">
            <RefreshCw className="h-4 w-4" />
          </IconTooltipButton>
          <Link to="/workflows/new" className="btn btn-primary btn-sm h-9">
            <Plus className="h-3.5 w-3.5" /> New workflow
          </Link>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 rounded-md border border-app bg-app-card px-4 py-3">
        <div className="relative w-[360px] max-w-full">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-theme-muted" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search workflows..."
            className="h-10 w-full rounded-md border border-app bg-app-muted pl-9 pr-3 text-[13px] text-theme-primary outline-none transition-colors placeholder:text-theme-subtle focus:border-accent focus:shadow-[var(--focus-ring)]"
          />
        </div>
        <div className="flex items-center gap-2 text-[12px] font-mono text-theme-muted">
          <span>{filteredWorkflows.length} shown</span>
          <span className="text-theme-subtle">·</span>
          <span>{workflows.length} total</span>
        </div>
      </div>

      {/* ── Empty state ── */}
      {workflows.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-md border border-dashed border-app bg-app-card py-20">
          <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-md border border-app bg-accent-soft">
            <Sparkles className="h-6 w-6 text-accent" />
          </div>
          <h2 className="mb-2 text-[20px] font-semibold tracking-tight text-theme-primary">
            No workflows yet
          </h2>
          <p className="mb-8 max-w-sm text-center text-[13px] text-theme-muted">
            Create your first workflow to start orchestrating AI agents with visual pipelines.
          </p>
          <Link to="/workflows/new" className="btn btn-primary">
            <Plus className="h-3.5 w-3.5" /> Create workflow
          </Link>
        </div>
      ) : filteredWorkflows.length === 0 ? (
        <div className="rounded-md border border-dashed border-app bg-app-card px-4 py-16 text-center text-[13px] text-theme-muted">
          No workflows match "{query}".
        </div>
      ) : (
        /* ── Workflow list ── */
        <div className="overflow-hidden rounded-md border border-app bg-app-card">
          {/* Column headers */}
          <div className="grid grid-cols-[32px_minmax(0,1fr)_132px_88px_104px_184px] items-center gap-4 border-b border-app bg-app-muted/60 px-4 py-2">
            <span />
            <span className="overline">Workflow</span>
            <span className="overline">Shape</span>
            <span className="overline">Runs</span>
            <span className="overline">Status</span>
            <span className="text-right overline">Actions</span>
          </div>

          {filteredWorkflows.map((wf: any) => {
            const wfStats = stats[wf._id] ?? { nodes: 0, edges: 0 };
            const isValid = wf.validation?.valid;
            const isRunning = runningId === wf._id;
            const isExpanded = expandedId === wf._id;
            const input = workflowInput(wf);
            const inputKeys = Object.keys(input);
            const runCount = workflowRunCount(wf);

            return (
              <div key={wf._id} className="border-b border-app last:border-b-0">
                {/* ── Row ── */}
                <div
                  className="grid cursor-pointer select-none grid-cols-[32px_minmax(0,1fr)_132px_88px_104px_184px] items-center gap-4 px-4 py-3 transition-colors hover:bg-app-muted/35"
                  onClick={() => navigate(`/workflows/${wf._id}`)}
                >
                  {/* Expand chevron */}
                  <button
                    type="button"
                    className="flex h-8 w-8 items-center justify-center rounded-md text-theme-muted transition-colors hover:bg-app-muted hover:text-theme-primary"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleExpand(wf._id);
                    }}
                    title={isExpanded ? 'Collapse details' : 'Preview details'}
                  >
                    {isExpanded
                      ? <ChevronDown className="w-4 h-4" />
                      : <ChevronRight className="w-4 h-4" />
                    }
                  </button>

                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-[13.5px] font-semibold text-theme-primary">{wf.name}</span>
                      <span className="shrink-0 font-mono text-[10.5px] text-theme-subtle">v{wf.version}</span>
                    </div>
                    <p className="mt-1 truncate text-[12px] text-theme-muted">{shortDescription(wf.description)}</p>
                  </div>

                  <div className="flex items-center gap-3 font-mono text-[11px] text-theme-muted">
                    <span className="inline-flex items-center gap-1"><Layers className="h-3 w-3" />{wfStats.nodes}</span>
                    <span className="inline-flex items-center gap-1"><GitBranch className="h-3 w-3" />{wfStats.edges}</span>
                  </div>

                  <div className="font-mono text-[11px] text-theme-secondary">
                    {runCount}
                  </div>

                  <div className="flex items-center gap-1.5">
                      {isValid
                        ? <CheckCircle className="h-3.5 w-3.5 shrink-0 text-accent-green" />
                        : <XCircle className="h-3.5 w-3.5 shrink-0 text-accent-red" />
                      }
                    <span className={`font-mono text-[11px] ${isValid ? 'text-accent-green' : 'text-accent-red'}`}>{isValid ? 'valid' : 'invalid'}</span>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center justify-end gap-1.5" onClick={e => e.stopPropagation()}>
                    <IconTooltipButton
                      label={isRunning ? 'Starting workflow' : 'Run workflow'}
                      tone="accent"
                      onClick={() => openRunDialog(wf)}
                      disabled={isRunning || !isValid}
                      className="h-8 w-8 rounded-md border border-app bg-app-card"
                    >
                      {isRunning
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <Play className="h-3.5 w-3.5" />
                      }
                    </IconTooltipButton>
                    <IconTooltipButton
                      label="View workflow runs"
                      onClick={() => navigate(`/workflows/${wf._id}?tab=runs`)}
                      className="h-8 w-8 rounded-md border border-app"
                    >
                      <Clock3 className="h-3.5 w-3.5" />
                    </IconTooltipButton>
                    <IconTooltipButton
                      label="Edit workflow"
                      onClick={() => navigate(`/workflows/${wf._id}?tab=edit`)}
                      className="h-8 w-8 rounded-md border border-app"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </IconTooltipButton>
                    <IconTooltipButton label="Delete workflow" side="left" tone="danger" onClick={() => setDeletingWorkflow(wf)} className="h-8 w-8 rounded-md border border-app">
                      <Trash2 className="h-3.5 w-3.5" />
                    </IconTooltipButton>
                  </div>
                </div>

                {/* ── Expanded detail ── */}
                {isExpanded && (
                  <div className="space-y-4 border-t border-app bg-app-muted/30 px-16 py-4">
                    <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                      {/* Workflow shape */}
                      <div>
                        <p className="overline mb-2">Shape</p>
                        <div className="flex flex-wrap gap-2">
                          <span className="badge">
                            <Layers className="h-2.5 w-2.5" /> {wfStats.nodes} nodes
                          </span>
                          <span className="badge">
                            <GitBranch className="h-2.5 w-2.5" /> {wfStats.edges} edges
                          </span>
                          <span className="badge">v{wf.version}</span>
                        </div>
                      </div>

                      {/* Validation status */}
                      <div>
                        <p className="overline mb-2">Validation</p>
                        <div className="flex items-center gap-2">
                          <div className={`flex h-6 w-6 items-center justify-center rounded-md ${isValid ? 'bg-accent-green/10' : 'bg-accent-red/10'}`}>
                            <Shield className={`h-3.5 w-3.5 ${isValid ? 'text-accent-green' : 'text-accent-red'}`} />
                          </div>
                          <span className={`text-[13px] ${isValid ? 'text-accent-green' : 'text-accent-red'}`}>
                            {isValid ? 'Valid' : 'Invalid'}
                          </span>
                          <span className="ml-2 font-mono text-[11px] text-theme-muted">v{wf.version}</span>
                        </div>
                        {!isValid && wf.validation?.errors?.length > 0 && (
                          <ul className="mt-2 space-y-1">
                            {wf.validation.errors.map((err: string, i: number) => (
                              <li key={i} className="font-mono text-[11px] text-accent-red">
                                {err}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>

                    <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                      {/* Tags */}
                      <div>
                        <p className="overline mb-2">Tags</p>
                        {Array.isArray(wf.tags) && wf.tags.length > 0 ? (
                          <div className="flex flex-wrap gap-1.5">
                            {wf.tags.map((tag: string) => (
                              <span key={tag} className="badge badge-human">
                                <Tag className="h-2.5 w-2.5" /> {tag}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-[12px] text-theme-subtle">No tags</span>
                        )}
                      </div>

                      {/* Input schema */}
                      <div>
                        <p className="overline mb-2">Input schema</p>
                        {inputKeys.length > 0 ? (
                          <div className="flex flex-wrap gap-1.5">
                            {inputKeys.map((key: string) => {
                              const schema = input[key];
                              const required = schema?.required === true;
                              return (
                                <span key={key} className="badge" style={{ background: 'rgb(var(--color-accent-soft))', color: 'rgb(var(--color-accent))' }}>
                                  <FileText className="h-2.5 w-2.5" />
                                  {key}
                                  {required && <span className="text-accent-red">*</span>}
                                </span>
                              );
                            })}
                          </div>
                        ) : (
                          <span className="text-[12px] text-theme-subtle">No inputs defined</span>
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
        open={Boolean(deletingWorkflow)}
        resourceType="workflow"
        resourceName={deletingWorkflow?.name ?? ''}
        onConfirm={() => void deleteWorkflow()}
        onCancel={() => setDeletingWorkflow(null)}
      />

    </div>
  );
}
