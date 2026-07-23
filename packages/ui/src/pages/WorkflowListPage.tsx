import { useState, useCallback, useMemo } from 'react';
import { useWorkflows } from '../hooks/useWorkflows';
import { useNavigate, Link } from 'react-router-dom';
import {
  Loader2,
} from 'lucide-react';
import WorkflowRunDialog from '../components/workflow/WorkflowRunDialog';
import { workflowEdges, workflowNodes } from '../utils/workflowShape';
import DeleteConfirmDialog from '../components/common/DeleteConfirmDialog';
import { workflows as workflowsApi } from '../services/api';
import { useToast } from '../components/common/Toast';
import TeamClassificationSelect from '../components/common/TeamClassificationSelect';
import {
  TEAM_CLASSIFICATION_META,
  teamClassificationKey,
  type TeamClassification,
  type TeamClassificationFilter,
} from '../types/teamClassification';

interface RunDialogState {
  open: boolean;
  workflow: any | null;
}

function workflowRunCount(workflow: any): number {
  const value = workflow.runCount ?? workflow.executionCount ?? workflow.runs;
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function downloadJsonFile(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function pickJsonFile(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) { reject(new Error('No file selected')); return; }
      try {
        resolve(JSON.parse(await file.text()));
      } catch (err) {
        reject(err instanceof Error ? err : new Error('Invalid JSON file'));
      }
    };
    input.click();
  });
}

function workflowRouteSummary(workflow: any): string {
  const names = Object.values(workflowNodes(workflow)).map((node: any) =>
    node.agent ?? node.agentName ?? node.config?.agent ?? (node.type === 'human' ? 'you' : node.name),
  ).filter(Boolean).map(String);
  if (names.length === 0) return 'Reusable Allen workflow';
  const compact = names.filter((name, index) => index === 0 || name !== names[index - 1]);
  const counts = new Map(compact.map(name => [name, names.filter(value => value === name).length]));
  const route = compact.slice(0, 8).map(name => `${name}${(counts.get(name) ?? 0) > 1 ? ` ×${counts.get(name)}` : ''}`);
  return `${route.join(' → ')}${compact.length > 8 ? ' → …' : ''}`;
}

function PageIcon({ name }: { name: 'refresh' | 'search' | 'run' | 'edit' | 'trash' | 'check' | 'x' | 'tray' }) {
  const paths: Record<string, React.ReactNode> = {
    refresh: <><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></>,
    search: <><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></>,
    run: <path d="m7 5 12 7-12 7z" />,
    edit: <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />,
    trash: <><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></>,
    check: <path d="M20 6 9 17l-5-5" />,
    x: <><path d="m18 6-12 12" /><path d="m6 6 12 12" /></>,
    tray: <><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1z" /></>,
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={name === 'check' ? 2 : 1.8} aria-hidden="true">{paths[name]}</svg>;
}

// ── Loading Row Skeleton ────────────────────────────────────────────────────

function RowSkeleton() {
  return (
    <div className="v8-workflow-row v8-workflow-row--skeleton" aria-hidden="true">
      <span className="v8-skeleton v8-skeleton--tag" />
      <div className="v8-workflow-row__copy">
        <span className="v8-skeleton v8-skeleton--name" />
        <span className="v8-skeleton v8-skeleton--description" />
        <span className="v8-skeleton v8-skeleton--route" />
      </div>
      <span className="v8-skeleton v8-skeleton--meta" />
    </div>
  );
}

export default function WorkflowListPage() {
  const { workflows, loading, error, refresh } = useWorkflows();
  const navigate = useNavigate();
  const toast = useToast();

  const [runningId] = useState<string | null>(null);
  const [runDialog, setRunDialog] = useState<RunDialogState>({ open: false, workflow: null });
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<TeamClassificationFilter>('all');
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
    return workflows.filter((wf: any) => {
      if (category !== 'all' && teamClassificationKey(wf.teamClassification) !== category) return false;
      const tags = Array.isArray(wf.tags) ? wf.tags.join(' ') : '';
      return !q || [
        wf.name,
        wf.description,
        wf.version ? `v${wf.version}` : '',
        tags,
      ].filter(Boolean).join(' ').toLowerCase().includes(q);
    });
  }, [category, query, workflows]);

  // Open dialog: we just pass the workflow `{_id, name}` — the shared
  // WorkflowRunDialog fetches the full record and loads repos internally.
  const openRunDialog = useCallback((wf: any) => {
    setRunDialog({ open: true, workflow: wf });
  }, []);



  const exportWorkflows = useCallback(async () => {
    try {
      const ids = filteredWorkflows.map((wf: any) => String(wf._id)).filter(Boolean);
      const bundle = await workflowsApi.exportJson(ids);
      downloadJsonFile('allen-workflows-export.json', bundle);
      const count = Number(bundle.workflows?.length ?? 0);
      toast.success(`Exported ${count} workflow${count === 1 ? '' : 's'}.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to export workflows');
    }
  }, [filteredWorkflows, toast]);

  const importWorkflowJson = useCallback(async () => {
    try {
      const bundle = await pickJsonFile();
      const result: any = await workflowsApi.importJson(bundle);
      const parts: string[] = [];
      if (result.created?.length > 0) parts.push(`${result.created.length} created`);
      if (result.skipped?.length > 0) parts.push(`${result.skipped.length} skipped`);
      if (result.restored?.length > 0) parts.push(`${result.restored.length} restored`);
      toast.success(parts.join(', ') || 'Imported workflows.');
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to import workflows');
    }
  }, [refresh, toast]);

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

  const updateClassification = useCallback(async (workflow: any, value: TeamClassification | null) => {
    try {
      await workflowsApi.update(workflow._id, { teamClassification: value });
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update workflow team');
    }
  }, [refresh, toast]);

  /* ── Loading skeleton ── */
  if (loading) {
    return (
      <div className="v8-page v8-workflows" data-screen-label="workflows-loading">
        <div className="v8-page__wrap">
          <header className="v8-pagehead v8-workflows__head">
            <div><h1>Workflows</h1><p>Reusable agent pipelines for repeatable Allen work.</p></div>
          </header>
          <div className="v8-tabs v8-workflows__tabs" aria-hidden="true">
            <button className="on" type="button">All</button>
            <button type="button">Engineering</button>
            <button type="button">Product</button>
            <button type="button">Marketing</button>
            <button type="button">Design</button>
            <button type="button">Unknown</button>
          </div>
          <div className="v8-workflows__panel">
            {Array.from({ length: 4 }).map((_, i) => <RowSkeleton key={i} />)}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="v8-page v8-workflows" data-screen-label="workflows">
      <div className="v8-page__wrap">
        <header className="v8-pagehead v8-workflows__head">
          <div><h1>Workflows</h1><p>Reusable agent pipelines for repeatable Allen work.</p></div>
          <button className="v8-icon-chip" type="button" aria-label="Refresh" onClick={refresh}><PageIcon name="refresh" /></button>
          <button className="v8-btn v8-btn--ghost" type="button" onClick={() => void exportWorkflows()}>Export</button>
          <button className="v8-btn v8-btn--ghost" type="button" onClick={() => void importWorkflowJson()}>Import JSON</button>
          <Link to="/workflows/new" className="v8-btn v8-btn--ink">New workflow</Link>
        </header>

        <div className="v8-tabs v8-workflows__tabs">
          <button className={category === 'all' ? 'on' : ''} type="button" onClick={() => setCategory('all')}>All <span>{workflows.length}</span></button>
          {(['engineering', 'marketing', 'product', 'design', 'unknown'] as const).map(value => (
            <button key={value} className={category === value ? 'on' : ''} type="button" onClick={() => setCategory(value)}>
              {TEAM_CLASSIFICATION_META[value].label}
            </button>
          ))}
          <span className="v8-tabs__spacer" />
          <label className="v8-search"><PageIcon name="search" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search workflows…" aria-label="Search workflows" /></label>
        </div>

        {error ? (
          <div className="v8-workflows__error" role="alert"><b>Couldn’t load workflows</b><p>{error}</p><button className="v8-btn v8-btn--ghost" type="button" onClick={() => void refresh()}>Try again</button></div>
        ) : workflows.length === 0 ? (
          <div className="v8-empty">
            <span className="glyph"><PageIcon name="tray" /></span><h2>No workflows yet</h2>
            <p>Describe a process once and Allen turns it into a reusable, review-gated pipeline.</p>
            <Link to="/workflows/new" className="v8-btn v8-btn--ink">New workflow</Link>
          </div>
        ) : (
          <div className="v8-workflows__panel">
            {filteredWorkflows.map((workflow: any) => {
              const shape = stats[workflow._id] ?? { nodes: 0, edges: 0 };
              const valid = workflow.validation?.valid !== false;
              const cat = teamClassificationKey(workflow.teamClassification);
              const runCount = workflowRunCount(workflow);
              const humanGates = Object.values(workflowNodes(workflow)).filter((node: any) => node.type === 'human').length;
              return (
                <div className="v8-workflow-row" key={workflow._id} onClick={() => navigate(`/workflows/${workflow._id}`)}>
                  <span className={`v8-workflow-row__tag ${cat}`}><i />{TEAM_CLASSIFICATION_META[cat].short}</span>
                  <span className="v8-workflow-row__who">
                    <strong>{workflow.name}<small>v{workflow.version ?? 1}</small></strong>
                    <p>{workflow.description || 'No description'}</p>
                    <em><b>{workflowRouteSummary(workflow)}</b>{humanGates > 0 ? ` · ${humanGates} approval${humanGates === 1 ? '' : 's'}` : ''}</em>
                  </span>
                  <span className="v8-workflow-row__cols">
                    <span>{shape.nodes} nodes · {shape.edges} edges</span>
                    <span>{runCount} runs</span>
                    <span className={valid ? 'valid' : 'invalid'}><PageIcon name={valid ? 'check' : 'x'} />{valid ? 'valid' : 'invalid'}</span>
                    <span className="v8-workflow-row__actions" onClick={event => event.stopPropagation()}>
                      <TeamClassificationSelect
                        compact
                        value={workflow.teamClassification ?? null}
                        onChange={(value) => void updateClassification(workflow, value)}
                        ariaLabel={`Team for ${workflow.name}`}
                      />
                      <button type="button" aria-label="Run" disabled={runningId === workflow._id || !valid} onClick={() => openRunDialog(workflow)}>{runningId === workflow._id ? <Loader2 /> : <PageIcon name="run" />}</button>
                      <button type="button" aria-label="Edit" onClick={() => navigate(`/workflows/${workflow._id}?tab=edit`)}><PageIcon name="edit" /></button>
                      <button type="button" aria-label="Delete" onClick={() => setDeletingWorkflow(workflow)}><PageIcon name="trash" /></button>
                    </span>
                  </span>
                </div>
              );
            })}
            {filteredWorkflows.length === 0 && <div className="v8-filter-empty">No workflows match “{query}”.</div>}
          </div>
        )}
        <p className="v8-page-foot">{filteredWorkflows.length} of {workflows.length} shown · list view</p>
      </div>

      {runDialog.open && runDialog.workflow && (
        <WorkflowRunDialog workflow={runDialog.workflow} onClose={() => setRunDialog({ open: false, workflow: null })} onStarted={(execution) => { setRunDialog({ open: false, workflow: null }); navigate(`/executions/${execution.id}`); }} />
      )}
      <DeleteConfirmDialog open={Boolean(deletingWorkflow)} resourceType="workflow" resourceName={deletingWorkflow?.name ?? ''} onConfirm={() => void deleteWorkflow()} onCancel={() => setDeletingWorkflow(null)} />
    </div>
  );
}
