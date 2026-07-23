import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate, useBlocker } from 'react-router-dom';
import yaml from 'js-yaml';
import type { Node, Edge } from '@xyflow/react';
import {
  Save, CheckCircle, Play, Eye, Code2, ArrowLeft, AlertTriangle, XCircle, X, ChevronDown, Trash2, Info, Pencil,
} from 'lucide-react';
import { workflows as wfApi } from '../services/api';
import Canvas from '../components/canvas/Canvas';
import YamlEditor from '../components/editor/YamlEditor';
import MermaidPreview from '../components/editor/MermaidPreview';
import WorkflowRunDialog from '../components/workflow/WorkflowRunDialog';
import WorkflowBuilderGuide from '../components/workflow/WorkflowBuilderGuide';
import DeleteConfirmDialog from '../components/common/DeleteConfirmDialog';
import { useToast } from '../components/common/Toast';
import { yamlToReactFlow } from '../lib/yaml-to-reactflow';
import { reactFlowToYaml } from '../lib/reactflow-to-yaml';
import { useResizable } from '../hooks/useResizable';
import TeamClassificationSelect from '../components/common/TeamClassificationSelect';
import type { TeamClassification } from '../types/teamClassification';

type Mode = 'visual' | 'yaml';

type WorkflowBuilderPageProps = {
  embedded?: boolean;
  onBack?: () => void;
};

type WorkflowMeta = {
  name?: string;
  description?: string;
  version?: number;
  context?: any;
  input?: any;
};

function metaFromWorkflow(parsed: any): WorkflowMeta {
  return {
    name: parsed?.name,
    description: parsed?.description,
    version: parsed?.version,
    context: parsed?.context,
    input: parsed?.input,
  };
}

function applyMetaToYaml(yamlStr: string, meta: WorkflowMeta): string {
  const parsed = (yaml.load(yamlStr) as any) ?? {};
  return yaml.dump({
    ...parsed,
    name: meta.name ?? parsed.name ?? 'untitled',
    description: meta.description ?? parsed.description ?? '',
    version: meta.version ?? parsed.version ?? 1,
  }, { lineWidth: 120, noRefs: true, sortKeys: false });
}

export default function WorkflowBuilderPage({ embedded = false, onBack }: WorkflowBuilderPageProps = {}) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const isNew = !id;

  const [mode, setMode] = useState<Mode>('visual');
  // Mermaid preview panel — same default width + resize behavior as the
  // node-properties panel in the visual canvas.
  const { size: previewWidth, handleMouseDown: previewResizeStart } = useResizable({ direction: 'horizontal', initialSize: 432, minSize: 260, maxSize: 640 });
  // Close hides the preview; it comes back when re-entering YAML mode.
  const [previewClosed, setPreviewClosed] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [yamlContent, setYamlContent] = useState('');
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [workflowMeta, setWorkflowMeta] = useState<WorkflowMeta>({});
  const [teamClassification, setTeamClassification] = useState<TeamClassification | null>(null);
  const [validation, setValidation] = useState<{ errors: string[]; warnings: string[] }>({ errors: [], warnings: [] });
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(!!id);
  const [dirty, setDirty] = useState(false);
  const [metaEditorOpen, setMetaEditorOpen] = useState(false);
  const [showValidation, setShowValidation] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const savedYamlRef = useRef('');
  const savedTeamClassificationRef = useRef<TeamClassification | null>(null);

  // Block navigation when there are unsaved changes
  const blocker = useBlocker(dirty);
  useEffect(() => {
    if (blocker.state === 'blocked') {
      const proceed = window.confirm('You have unsaved changes. Leave anyway?');
      if (proceed) blocker.proceed();
      else blocker.reset();
    }
  }, [blocker]);

  // Warn on browser close/refresh
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  // Load existing workflow
  useEffect(() => {
    if (!id) {
      const defaultYaml = `name: new-workflow\ndescription: \nversion: 1\n\ncontext:\n  requires: []\n  tools: []\n\ninput:\n  task: { type: string, required: true }\n\nnodes:\n  plan:\n    role: planner\n    prompt: "Break down: {{task}}"\n    outputs:\n      plan: "A structured breakdown of the task into concrete steps."\n\nedges:\n  - { from: START, to: plan }\n  - { from: plan, to: END }\n`;
      setYamlContent(defaultYaml);
      savedYamlRef.current = defaultYaml;
      syncYamlToVisual(defaultYaml);
      setLoading(false);
      return;
    }

    wfApi.get(id).then(wf => {
      const loadedYaml = wf.yaml ?? yaml.dump(wf.parsed);
      setYamlContent(loadedYaml);
      savedYamlRef.current = loadedYaml;
      setWorkflowMeta({
        ...metaFromWorkflow(wf.parsed),
        name: wf.name,
        description: wf.description,
        version: wf.version,
      });
      setTeamClassification(wf.teamClassification ?? null);
      savedTeamClassificationRef.current = wf.teamClassification ?? null;
      if (wf.parsed) {
        const { nodes: n, edges: e } = yamlToReactFlow(wf.parsed);
        setNodes(n);
        setEdges(e);
      }
      if (wf.validation) setValidation(wf.validation);
    }).finally(() => setLoading(false));
  }, [id]);

  // Parse workflow from current YAML
  const parsedWorkflow = useMemo(() => {
    try {
      return yaml.load(yamlContent) as any;
    } catch {
      return null;
    }
  }, [yamlContent]);

  // Sync YAML → Visual
  const syncYamlToVisual = useCallback((yamlStr: string) => {
    try {
      const parsed = yaml.load(yamlStr) as any;
      if (!parsed?.nodes) return;
      const { nodes: n, edges: e } = yamlToReactFlow(parsed);
      setNodes(n);
      setEdges(e);
      setWorkflowMeta(metaFromWorkflow(parsed));
    } catch { /* invalid yaml, ignore */ }
  }, []);

  // Sync Visual → YAML
  const syncVisualToYaml = useCallback(() => {
    const yamlStr = reactFlowToYaml(nodes, edges, workflowMeta);
    setYamlContent(yamlStr);
  }, [nodes, edges, workflowMeta]);

  // When switching modes, sync
  const handleModeSwitch = useCallback((newMode: Mode) => {
    if (newMode === 'yaml' && mode === 'visual') {
      syncVisualToYaml();
      setPreviewClosed(false); // re-show the preview each time YAML view opens
    } else if (newMode === 'visual' && mode === 'yaml') {
      syncYamlToVisual(yamlContent);
    }
    setMode(newMode);
  }, [mode, yamlContent, syncVisualToYaml, syncYamlToVisual]);

  // YAML change handler
  const handleYamlChange = useCallback((val: string) => {
    setYamlContent(val);
    setDirty(val !== savedYamlRef.current || teamClassification !== savedTeamClassificationRef.current);
    try {
      const parsed = yaml.load(val) as any;
      if (parsed && typeof parsed === 'object') setWorkflowMeta(metaFromWorkflow(parsed));
    } catch { /* keep current metadata while YAML is invalid */ }
  }, [teamClassification]);

  const handleTeamClassificationChange = useCallback((value: TeamClassification | null) => {
    setTeamClassification(value);
    setDirty(yamlContent !== savedYamlRef.current || value !== savedTeamClassificationRef.current);
  }, [yamlContent]);

  const handleMetaChange = useCallback((patch: Pick<WorkflowMeta, 'name' | 'description'>) => {
    setWorkflowMeta((current) => {
      const next = { ...current, ...patch };
      setYamlContent((currentYaml) => {
        try {
          return applyMetaToYaml(currentYaml, next);
        } catch {
          return currentYaml;
        }
      });
      return next;
    });
    setDirty(true);
  }, []);

  // Save
  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      // Sync visual to yaml first if in visual mode
      let finalYaml = yamlContent;
      if (mode === 'visual') {
        finalYaml = reactFlowToYaml(nodes, edges, workflowMeta);
        setYamlContent(finalYaml);
      } else {
        finalYaml = applyMetaToYaml(finalYaml, workflowMeta);
        setYamlContent(finalYaml);
      }

      if (isNew) {
        const result = await wfApi.create({ yaml: finalYaml, teamClassification });
        const isRestored = result?.restored === true;
        toast.success(isRestored
          ? `Workflow "${workflowMeta.name ?? 'Untitled'}" restored.`
          : `Workflow "${workflowMeta.name ?? 'Untitled'}" created.`);
        savedYamlRef.current = finalYaml;
        savedTeamClassificationRef.current = teamClassification;
        setDirty(false);
        navigate(`/workflows/${result._id}/edit`, { replace: true });
      } else {
        await wfApi.update(id!, { yaml: finalYaml, teamClassification });
        toast.success(`Workflow "${workflowMeta.name}" saved.`);
        savedYamlRef.current = finalYaml;
        savedTeamClassificationRef.current = teamClassification;
        setDirty(false);
      }
    } catch (e: any) {
      toast.error(e?.message ?? String(e));
    }
    setSaving(false);
  }, [yamlContent, mode, nodes, edges, workflowMeta, teamClassification, isNew, id, navigate, toast]);

  // Validate
  const handleValidate = useCallback(async () => {
    if (!id) {
      // Client-side parse check for new workflows
      try {
        yaml.load(yamlContent);
        setValidation({ errors: [], warnings: ['Save first to run full validation'] });
      } catch (e: any) {
        setValidation({ errors: [e.message], warnings: [] });
      }
      return;
    }
    try {
      const result = await wfApi.validate(id);
      setValidation(result);
    } catch (e: any) {
      setValidation({ errors: [e.message], warnings: [] });
    }
  }, [id, yamlContent]);

  // Run — opens the same schema-driven input dialog used on the workflow
  // list page. Input schema is read from the (parsed) workflow definition,
  // so users get the exact same prompts regardless of which page they run
  // from.
  const [runDialogOpen, setRunDialogOpen] = useState(false);
  const handleRun = useCallback(() => {
    if (!id) { alert('Save the workflow first'); return; }
    if (dirty) {
      const proceed = confirm('You have unsaved changes. Save first, or run the currently saved version?');
      if (!proceed) return;
    }
    setRunDialogOpen(true);
  }, [id, dirty]);

  const handleDelete = useCallback(async () => {
    if (!id) return;
    setDeleting(true);
    try {
      await wfApi.delete(id);
      toast.success(`Workflow "${workflowMeta.name ?? id}" deleted`);
      setDirty(false);
      setConfirmDelete(false);
      navigate('/workflows');
    } catch (e: any) {
      toast.error(e?.message || 'Failed to delete workflow');
    } finally {
      setDeleting(false);
    }
  }, [id, workflowMeta.name, navigate, toast]);

  if (loading) {
    return <div className="flex items-center justify-center h-full text-theme-muted font-mono text-sm">LOADING...</div>;
  }

  return (
    <div className="flex flex-col h-full">
      {/* Top bar */}
      <header className={`flex items-center justify-between border-b border-app shrink-0 ${embedded ? 'px-4 py-2.5' : 'px-8 pb-3 pt-8'}`}>
        <div className="flex items-center gap-3">
          {/* Standalone builder keeps a back affordance; embedded edit relies on
              the surrounding app/detail navigation, so no back button here. */}
          {!embedded && (
            <button
              onClick={() => navigate('/workflows')}
              className="text-theme-muted hover:text-theme-primary transition-colors"
              title="Back to workflows"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
          )}
          <span className="text-[14px] font-semibold text-theme-primary tracking-tight">
            {workflowMeta.name ?? 'New workflow'}
          </span>
          {workflowMeta.version && (
            <span className="text-[12px] text-theme-muted font-mono">v{workflowMeta.version}</span>
          )}
          <button
            onClick={() => setMetaEditorOpen((open) => !open)}
            title="Edit workflow details"
            className={`btn-ghost p-1 transition-colors ${metaEditorOpen ? 'text-accent-blue' : 'text-theme-muted hover:text-theme-primary'}`}
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setGuideOpen(true)}
            title="How to build a workflow"
            className="btn-ghost p-1 text-theme-muted hover:text-accent-blue"
          >
            <Info className="w-4 h-4" />
          </button>

          {/* Mode toggle */}
          <div className="flex items-center bg-app-muted rounded p-0.5">
            <button
              onClick={() => handleModeSwitch('visual')}
              title="Visual editor"
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-[12px] transition-colors ${
                mode === 'visual' ? 'bg-app-card text-theme-primary shadow-sm font-medium' : 'text-theme-muted hover:text-theme-primary'
              }`}
            >
              <Eye className="w-3.5 h-3.5" /> Visual
            </button>
            <button
              onClick={() => handleModeSwitch('yaml')}
              title="YAML editor"
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-[12px] transition-colors ${
                mode === 'yaml' ? 'bg-app-card text-theme-primary shadow-sm font-medium' : 'text-theme-muted hover:text-theme-primary'
              }`}
            >
              <Code2 className="w-3.5 h-3.5" /> YAML
            </button>
          </div>

          <div className="w-px h-6 bg-border mx-1" />

          {/* Validation status — clickable to show details */}
          {(validation.errors.length > 0 || validation.warnings.length > 0) && (
            <div className="relative">
              <button
                onClick={() => setShowValidation(!showValidation)}
                title="View validation issues"
                className={`badge ${validation.errors.length > 0 ? 'badge-err' : 'badge-warn'} cursor-pointer`}
              >
                {validation.errors.length > 0 ? (
                  <><XCircle className="w-3 h-3" /> {validation.errors.length} error{validation.errors.length !== 1 ? 's' : ''}</>
                ) : (
                  <><AlertTriangle className="w-3 h-3" /> {validation.warnings.length} warning{validation.warnings.length !== 1 ? 's' : ''}</>
                )}
                <ChevronDown className={`w-3 h-3 transition-transform ${showValidation ? 'rotate-180' : ''}`} />
              </button>

              {/* Dropdown panel */}
              {showValidation && (
                <div className="absolute right-0 top-full mt-2 w-96 max-h-80 overflow-auto z-50 bg-app-card border border-app rounded-lg shadow-popover">
                  {/* Header */}
                  <div className="flex items-center justify-between px-3 py-2 border-b border-app sticky top-0 bg-app-card">
                    <span className="overline">Validation issues</span>
                    <button onClick={() => setShowValidation(false)} className="text-theme-muted hover:text-theme-primary" title="Close">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {/* Errors */}
                  {validation.errors.length > 0 && (
                    <div className="px-3 py-2">
                      <div className="overline mb-1.5" style={{ color: 'rgb(var(--color-accent-red))' }}>Errors</div>
                      {validation.errors.map((err, i) => (
                        <div key={`err-${i}`} className="flex items-start gap-2 py-1.5 border-b border-app last:border-0">
                          <XCircle className="w-3.5 h-3.5 text-accent-red shrink-0 mt-0.5" />
                          <span className="text-[12px] text-theme-secondary font-mono leading-relaxed">{err}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Warnings */}
                  {validation.warnings.length > 0 && (
                    <div className="px-3 py-2">
                      <div className="overline mb-1.5" style={{ color: 'rgb(var(--color-accent-yellow))' }}>Warnings</div>
                      {validation.warnings.map((warn, i) => (
                        <div key={`warn-${i}`} className="flex items-start gap-2 py-1.5 border-b border-app last:border-0">
                          <AlertTriangle className="w-3.5 h-3.5 text-accent-yellow shrink-0 mt-0.5" />
                          <span className="text-[12px] text-theme-secondary font-mono leading-relaxed">{warn}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <button title="Validate workflow" onClick={handleValidate} className="btn btn-secondary btn-sm rounded-sm">
            <CheckCircle className="w-3.5 h-3.5" /> Validate
          </button>
          <button title="Save workflow" onClick={handleSave} disabled={saving} className="btn btn-primary btn-sm rounded-sm">
            <Save className="w-3.5 h-3.5" /> {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            onClick={handleRun}
            disabled={!id || validation.errors.length > 0}
            title="Run workflow"
            className="btn btn-primary btn-sm rounded-sm"
          >
            <Play className="w-3.5 h-3.5" /> Run
          </button>
          <button
            onClick={() => setConfirmDelete(true)}
            disabled={isNew || deleting}
            title={isNew ? 'Save the workflow before deleting' : 'Delete workflow'}
            className="btn btn-secondary btn-sm rounded-sm hover:text-accent-red"
          >
            <Trash2 className="w-3.5 h-3.5" /> Delete
          </button>
        </div>
      </header>

      {metaEditorOpen && (
        <section className={`grid shrink-0 grid-cols-[minmax(180px,320px)_minmax(260px,1fr)_minmax(140px,180px)] items-end gap-3 border-b border-app bg-app-muted/20 ${embedded ? 'px-4 py-2.5' : 'px-8 py-3'}`}>
          <label className="min-w-0">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.12em] text-theme-muted">Name</span>
            <input
              value={workflowMeta.name ?? ''}
              onChange={(event) => handleMetaChange({ name: event.target.value })}
              placeholder="workflow-name"
              className="h-8 w-full rounded border border-app bg-app px-2.5 text-[13px] font-medium text-theme-primary outline-none transition-colors placeholder:text-theme-subtle focus:border-accent-blue"
            />
          </label>
          <label className="min-w-0">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.12em] text-theme-muted">Description</span>
            <input
              value={workflowMeta.description ?? ''}
              onChange={(event) => handleMetaChange({ description: event.target.value })}
              placeholder="What this workflow does"
              className="h-8 w-full rounded border border-app bg-app px-2.5 text-[13px] text-theme-secondary outline-none transition-colors placeholder:text-theme-subtle focus:border-accent-blue"
            />
          </label>
          <label className="min-w-0">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.12em] text-theme-muted">Team</span>
            <TeamClassificationSelect
              value={teamClassification}
              onChange={handleTeamClassificationChange}
              ariaLabel="Workflow team"
            />
          </label>
        </section>
      )}

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {mode === 'visual' ? (
          <Canvas
            nodes={nodes}
            edges={edges}
            onNodesChange={(n, markDirty = false) => { setNodes(n); if (markDirty) setDirty(true); }}
            onEdgesChange={(e, markDirty = false) => { setEdges(e); if (markDirty) setDirty(true); }}
            workflowInput={workflowMeta?.input ?? parsedWorkflow?.input ?? null}
            workflowContext={workflowMeta?.context ?? parsedWorkflow?.context ?? null}
            onWorkflowMetaPatch={(patch) => { setWorkflowMeta((m: any) => ({ ...m, ...patch })); setDirty(true); }}
          />
        ) : (
          <div className="flex h-full">
            {/* YAML editor */}
            <div className="flex-1 border-r border-app">
              <YamlEditor
                value={yamlContent}
                onChange={handleYamlChange}
                errors={validation.errors}
                warnings={validation.warnings}
              />
            </div>
            {/* Mermaid preview — resizable + closable, matching the node-properties panel */}
            {!previewClosed && (
              <div
                className="bg-surface shrink-0 overflow-auto border-l-2 border-app hover:border-accent-blue/50 transition-colors relative"
                style={{ width: previewWidth }}
              >
                <div className="absolute top-0 left-0 bottom-0 w-2 cursor-col-resize z-10" onMouseDown={previewResizeStart} />
                <MermaidPreview workflow={parsedWorkflow} onClose={() => setPreviewClosed(true)} />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Run-with-input dialog — same component used on the workflow list
          page so users see identical input schema regardless of entry point.
          Fetches the saved workflow by id; uses `parsedWorkflow` as an
          optimistic hint so the dialog renders instantly even if the server
          round-trip is slow. */}
      {runDialogOpen && id && (
        <WorkflowRunDialog
          workflow={parsedWorkflow
            ? { _id: id, name: workflowMeta?.name, description: workflowMeta?.description, parsed: parsedWorkflow }
            : { _id: id, name: workflowMeta?.name, description: workflowMeta?.description }}
          onClose={() => setRunDialogOpen(false)}
          onStarted={(exec) => {
            setRunDialogOpen(false);
            navigate(`/executions/${exec.id}`);
          }}
        />
      )}

      {guideOpen && <WorkflowBuilderGuide onClose={() => setGuideOpen(false)} />}

      <DeleteConfirmDialog
        open={confirmDelete}
        resourceType="workflow"
        resourceName={workflowMeta?.name ?? ''}
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
