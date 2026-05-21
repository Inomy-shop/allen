import { useState, useCallback, useMemo } from 'react';
import { useWorkflows } from '../hooks/useWorkflows';
import { useNavigate, Link } from 'react-router-dom';
import {
  GitBranch, Plus, Play, CheckCircle, XCircle,
  RefreshCw, Loader2, Layers, Sparkles,
  ChevronDown, ChevronRight, Tag, FileText, Shield,
  Eye,
} from 'lucide-react';
import WorkflowRunDialog from '../components/workflow/WorkflowRunDialog';
import { workflowEdges, workflowInput, workflowNodes } from '../utils/workflowShape';

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

// ── Loading Row Skeleton ────────────────────────────────────────────────────

function RowSkeleton() {
  return (
    <div className="flex items-center gap-4 px-4 py-3 border-b border-border/10 animate-pulse">
      <div className="w-5" />
      <div className="w-8 h-8 rounded-lg bg-app-muted" />
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

  const [runningId] = useState<string | null>(null);
  const [runDialog, setRunDialog] = useState<RunDialogState>({ open: false, workflow: null });
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const stats = useMemo(() => {
    const map: Record<string, { nodes: number; edges: number }> = {};
    for (const wf of workflows) {
      const nodes = Object.keys(workflowNodes(wf)).length;
      const edges = workflowEdges(wf).length;
      map[wf._id] = { nodes, edges };
    }
    return map;
  }, [workflows]);

  // Open dialog: we just pass the workflow `{_id, name}` — the shared
  // WorkflowRunDialog fetches the full record and loads repos internally.
  const openRunDialog = useCallback((wf: any) => {
    setRunDialog({ open: true, workflow: wf });
  }, []);

  const toggleExpand = useCallback((id: string) => {
    setExpandedId(prev => (prev === id ? null : id));
  }, []);

  /* ── Loading skeleton ── */
  if (loading) {
    return (
      <div className="px-6 pt-5">
        <div className="mb-6">
          <div className="h-7 w-48 bg-app-muted rounded animate-pulse" />
        </div>
        <div>{Array.from({ length: 5 }).map((_, i) => <RowSkeleton key={i} />)}</div>
      </div>
    );
  }

  return (
    <div className="page-shell">
      {/* ── Breadcrumb ── */}
      <div className="page-crumb">
        <span>Org</span>
        <span className="text-theme-subtle">/</span>
        <span>Workflows</span>
      </div>

      {/* ── Page header ── */}
      <div className="page-head">
        <div className="flex items-center gap-3">
          <h1 className="page-title">Workflows</h1>
          <span className="text-[12px] font-mono text-theme-muted">{workflows.length}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            title="Refresh"
            onClick={refresh}
            className="btn btn-secondary btn-sm"
          >
            <RefreshCw className="w-3 h-3" />
          </button>
          <Link to="/workflows/new" className="btn btn-primary btn-sm">
            <Plus className="w-3 h-3" /> New workflow
          </Link>
        </div>
      </div>

      {/* ── Empty state ── */}
      {workflows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24">
          <div className="w-14 h-14 rounded-xl bg-accent-soft flex items-center justify-center mb-5">
            <Sparkles className="w-6 h-6 text-accent" />
          </div>
          <h2 className="text-[20px] font-semibold text-theme-primary mb-2 tracking-tight">
            No workflows yet
          </h2>
          <p className="text-[13px] text-theme-muted mb-8 max-w-sm text-center font-body">
            Create your first workflow to start orchestrating AI agents with visual pipelines.
          </p>
          <Link to="/workflows/new" className="btn btn-primary">
            <Plus className="w-3.5 h-3.5" /> Create your first workflow
          </Link>
        </div>
      ) : (
        /* ── Workflow list ── */
        <div className="card overflow-hidden">
          {/* Column headers */}
          <div className="flex items-center gap-4 px-4 py-2 border-b border-app bg-app-muted">
            <span className="w-5" />
            <span className="w-8" />
            <span className="w-48 overline">Name</span>
            <span className="flex-1 overline">Description</span>
            <span className="w-16 text-center overline">Nodes</span>
            <span className="w-44 text-right overline">Actions</span>
          </div>

          {workflows.map((wf: any) => {
            const wfStats = stats[wf._id] ?? { nodes: 0, edges: 0 };
            const isValid = wf.validation?.valid;
            const isRunning = runningId === wf._id;
            const isExpanded = expandedId === wf._id;
            const input = workflowInput(wf);
            const inputKeys = Object.keys(input);

            return (
              <div key={wf._id} className="border-b border-app last:border-b-0">
                {/* ── Row ── */}
                <div
                  className="flex items-center gap-4 px-4 py-2.5 hover:bg-app-muted/55 transition-colors cursor-pointer select-none"
                  onClick={() => navigate(`/workflows/${wf._id}`)}
                >
                  {/* Expand chevron */}
                  <button
                    type="button"
                    className="w-5 shrink-0 text-theme-muted hover:text-theme-primary"
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

                  {/* Workflow icon */}
                  <div className={`w-8 h-8 rounded-md flex items-center justify-center shrink-0 ${isValid ? 'bg-accent-soft' : 'bg-accent-red/10'}`}>
                    <GitBranch className={`w-4 h-4 ${isValid ? 'text-accent' : 'text-accent-red'}`} />
                  </div>

                  {/* Name + validity */}
                  <div className="w-48 min-w-0 shrink-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[13px] font-medium text-theme-primary truncate">
                        {wf.name}
                      </span>
                      {isValid
                        ? <CheckCircle className="w-3 h-3 text-accent-green shrink-0" />
                        : <XCircle className="w-3 h-3 text-accent-red shrink-0" />
                      }
                    </div>
                    <span className="text-[10px] font-mono text-theme-subtle block">v{wf.version}</span>
                  </div>

                  {/* Description hint */}
                  <div className="flex-1 min-w-0">
                    <p className="text-[12px] text-theme-muted font-body truncate">
                      {shortDescription(wf.description)}
                    </p>
                  </div>

                  {/* Node count */}
                  <div className="w-16 flex justify-center">
                    <div className="flex items-center gap-1 text-[11px] font-mono text-theme-muted">
                      <Layers className="w-3 h-3" /> {wfStats.nodes}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="w-44 flex items-center justify-end gap-1.5 shrink-0" onClick={e => e.stopPropagation()}>
                    <button
                      onClick={() => openRunDialog(wf)}
                      disabled={isRunning || !isValid}
                      className="btn btn-primary btn-sm"
                    >
                      {isRunning
                        ? <><Loader2 className="w-3 h-3 animate-spin" /> Starting</>
                        : <><Play className="w-3 h-3" /> Run</>
                      }
                    </button>
                    <Link
                      to={`/workflows/${wf._id}`}
                      className="btn btn-secondary btn-sm"
                    >
                      <Eye className="w-3 h-3" /> View details
                    </Link>
                  </div>
                </div>

                {/* ── Expanded detail ── */}
                {isExpanded && (
                  <div className="bg-app-muted/40 px-8 py-4 space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      {/* Workflow shape */}
                      <div>
                        <p className="overline mb-2">Shape</p>
                        <div className="flex flex-wrap gap-2">
                          <span className="badge">
                            <Layers className="w-2.5 h-2.5" /> {wfStats.nodes} nodes
                          </span>
                          <span className="badge">
                            <GitBranch className="w-2.5 h-2.5" /> {wfStats.edges} edges
                          </span>
                          <span className="badge">v{wf.version}</span>
                        </div>
                      </div>

                      {/* Validation status */}
                      <div>
                        <p className="overline mb-2">Validation</p>
                        <div className="flex items-center gap-2">
                          <div className={`w-6 h-6 rounded-md flex items-center justify-center ${isValid ? 'bg-accent-green/10' : 'bg-accent-red/10'}`}>
                            <Shield className={`w-3.5 h-3.5 ${isValid ? 'text-accent-green' : 'text-accent-red'}`} />
                          </div>
                          <span className={`text-[13px] font-body ${isValid ? 'text-accent-green' : 'text-accent-red'}`}>
                            {isValid ? 'Valid' : 'Invalid'}
                          </span>
                          <span className="text-[11px] text-theme-muted font-mono ml-2">v{wf.version}</span>
                        </div>
                        {!isValid && wf.validation?.errors?.length > 0 && (
                          <ul className="mt-2 space-y-1">
                            {wf.validation.errors.map((err: string, i: number) => (
                              <li key={i} className="text-[11px] text-accent-red font-mono">
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
                        <p className="overline mb-2">Tags</p>
                        {Array.isArray(wf.tags) && wf.tags.length > 0 ? (
                          <div className="flex flex-wrap gap-1.5">
                            {wf.tags.map((tag: string) => (
                              <span key={tag} className="badge badge-human">
                                <Tag className="w-2.5 h-2.5" /> {tag}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-[12px] text-theme-subtle font-body">No tags</span>
                        )}
                      </div>

                      {/* Input schema */}
                      <div>
                        <p className="overline mb-2">Input schema</p>
                        {inputKeys.length > 0 ? (
                          <div className="flex flex-wrap gap-1.5">
                            {inputKeys.map((key: string) => {
                              const schema = input[key];
                              const required = schema?.required !== false;
                              return (
                                <span key={key} className="badge" style={{ background: 'rgb(var(--color-accent-soft))', color: 'rgb(var(--color-accent))' }}>
                                  <FileText className="w-2.5 h-2.5" />
                                  {key}
                                  {required && <span className="text-accent-red">*</span>}
                                </span>
                              );
                            })}
                          </div>
                        ) : (
                          <span className="text-[12px] text-theme-subtle font-body">No inputs defined</span>
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


    </div>
  );
}
