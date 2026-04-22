import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate, useBlocker } from 'react-router-dom';
import yaml from 'js-yaml';
import type { Node, Edge } from '@xyflow/react';
import {
  Save, CheckCircle, Play, Eye, Code2, ArrowLeft, AlertTriangle, XCircle, X, ChevronDown,
} from 'lucide-react';
import { workflows as wfApi } from '../services/api';
import Canvas from '../components/canvas/Canvas';
import YamlEditor from '../components/editor/YamlEditor';
import MermaidPreview from '../components/editor/MermaidPreview';
import WorkflowRunDialog from '../components/workflow/WorkflowRunDialog';
import { yamlToReactFlow } from '../lib/yaml-to-reactflow';
import { reactFlowToYaml } from '../lib/reactflow-to-yaml';

type Mode = 'visual' | 'yaml';

export default function WorkflowBuilderPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isNew = !id;

  const [mode, setMode] = useState<Mode>('visual');
  const [yamlContent, setYamlContent] = useState('');
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [workflowMeta, setWorkflowMeta] = useState<any>({});
  const [validation, setValidation] = useState<{ errors: string[]; warnings: string[] }>({ errors: [], warnings: [] });
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(!!id);
  const [dirty, setDirty] = useState(false);
  const [showValidation, setShowValidation] = useState(false);
  const savedYamlRef = useRef('');

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
      syncYamlToVisual(defaultYaml);
      setLoading(false);
      return;
    }

    wfApi.get(id).then(wf => {
      setYamlContent(wf.yaml ?? yaml.dump(wf.parsed));
      setWorkflowMeta({
        name: wf.name,
        description: wf.description,
        version: wf.version,
        context: wf.parsed?.context,
        input: wf.parsed?.input,
      });
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
      setWorkflowMeta({
        name: parsed.name,
        description: parsed.description,
        version: parsed.version,
        context: parsed.context,
        input: parsed.input,
      });
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
    } else if (newMode === 'visual' && mode === 'yaml') {
      syncYamlToVisual(yamlContent);
    }
    setMode(newMode);
  }, [mode, yamlContent, syncVisualToYaml, syncYamlToVisual]);

  // YAML change handler
  const handleYamlChange = useCallback((val: string) => {
    setYamlContent(val);
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
      }

      if (isNew) {
        const result = await wfApi.create({ yaml: finalYaml });
        setDirty(false);
        navigate(`/workflows/${result._id}/edit`, { replace: true });
      } else {
        await wfApi.update(id!, { yaml: finalYaml });
        setDirty(false);
      }
    } catch (e: any) {
      alert(e.message);
    }
    setSaving(false);
  }, [yamlContent, mode, nodes, edges, workflowMeta, isNew, id, navigate]);

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

  if (loading) {
    return <div className="flex items-center justify-center h-full text-theme-muted font-mono text-sm">LOADING...</div>;
  }

  return (
    <div className="flex flex-col h-full">
      {/* Top bar */}
      <header className="flex items-center justify-between px-4 py-2 border-b border-border/50 bg-surface-50 shrink-0">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/workflows')} className="text-theme-secondary hover:text-accent-blue transition-colors" title="Back to workflows">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <span className="font-heading text-sm font-semibold text-theme-primary tracking-wider uppercase">
            {workflowMeta.name ?? 'New Workflow'}
          </span>
          {workflowMeta.version && (
            <span className="text-xs text-theme-muted font-mono">v{workflowMeta.version}</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Mode toggle */}
          <div className="flex items-center bg-surface-200 rounded-sm p-0.5 border border-border/40">
            <button
              onClick={() => handleModeSwitch('visual')}
              title="Visual editor"
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-sm text-xs font-label uppercase tracking-wider transition-all ${
                mode === 'visual' ? 'bg-accent-blue/15 text-accent-blue border border-accent-blue/30' : 'text-theme-secondary hover:text-gray-200 border border-transparent'
              }`}
            >
              <Eye className="w-3.5 h-3.5" /> Visual
            </button>
            <button
              onClick={() => handleModeSwitch('yaml')}
              title="YAML editor"
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-sm text-xs font-label uppercase tracking-wider transition-all ${
                mode === 'yaml' ? 'bg-accent-blue/15 text-accent-blue border border-accent-blue/30' : 'text-theme-secondary hover:text-gray-200 border border-transparent'
              }`}
            >
              <Code2 className="w-3.5 h-3.5" /> YAML
            </button>
          </div>

          <div className="w-px h-6 bg-border/50 mx-1" />

          {/* Validation status — clickable to show details */}
          {(validation.errors.length > 0 || validation.warnings.length > 0) && (
            <div className="relative">
              <button
                onClick={() => setShowValidation(!showValidation)}
                title="View validation issues"
                className={`inline-flex items-center gap-1.5 text-xs font-label uppercase tracking-wider px-2 py-1 rounded-sm border transition-all cursor-pointer ${
                  validation.errors.length > 0
                    ? 'text-accent-red border-accent-red/30 bg-accent-red/5 hover:bg-accent-red/10'
                    : 'text-accent-yellow border-accent-yellow/30 bg-accent-yellow/5 hover:bg-accent-yellow/10'
                }`}
              >
                {validation.errors.length > 0 ? (
                  <><XCircle className="w-3.5 h-3.5" /> {validation.errors.length} error{validation.errors.length !== 1 ? 's' : ''}</>
                ) : (
                  <><AlertTriangle className="w-3.5 h-3.5" /> {validation.warnings.length} warning{validation.warnings.length !== 1 ? 's' : ''}</>
                )}
                <ChevronDown className={`w-3 h-3 transition-transform ${showValidation ? 'rotate-180' : ''}`} />
              </button>

              {/* Dropdown panel */}
              {showValidation && (
                <div className="absolute right-0 top-full mt-2 w-96 max-h-80 overflow-auto z-50 bg-surface-100 border border-border rounded-sm shadow-lg">
                  {/* Header */}
                  <div className="flex items-center justify-between px-3 py-2 border-b border-border/50 sticky top-0 bg-surface-100">
                    <span className="text-xs font-label uppercase tracking-wider text-theme-secondary">Validation Issues</span>
                    <button onClick={() => setShowValidation(false)} className="text-theme-muted hover:text-theme-primary" title="Close">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {/* Errors */}
                  {validation.errors.length > 0 && (
                    <div className="px-3 py-2">
                      <div className="text-[10px] font-label uppercase tracking-wider text-accent-red mb-1.5">Errors</div>
                      {validation.errors.map((err, i) => (
                        <div key={`err-${i}`} className="flex items-start gap-2 py-1.5 border-b border-border/20 last:border-0">
                          <XCircle className="w-3.5 h-3.5 text-accent-red shrink-0 mt-0.5" />
                          <span className="text-xs text-theme-secondary font-mono leading-relaxed">{err}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Warnings */}
                  {validation.warnings.length > 0 && (
                    <div className="px-3 py-2">
                      <div className="text-[10px] font-label uppercase tracking-wider text-accent-yellow mb-1.5">Warnings</div>
                      {validation.warnings.map((warn, i) => (
                        <div key={`warn-${i}`} className="flex items-start gap-2 py-1.5 border-b border-border/20 last:border-0">
                          <AlertTriangle className="w-3.5 h-3.5 text-accent-yellow shrink-0 mt-0.5" />
                          <span className="text-xs text-theme-secondary font-mono leading-relaxed">{warn}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <button title="Validate workflow" onClick={handleValidate} className="btn-ghost text-xs inline-flex items-center gap-1.5 whitespace-nowrap">
            <CheckCircle className="w-3.5 h-3.5" /> Validate
          </button>
          <button title="Save workflow" onClick={handleSave} disabled={saving} className="btn-ghost text-xs inline-flex items-center gap-1.5 whitespace-nowrap">
            <Save className="w-3.5 h-3.5" /> {saving ? 'Saving...' : 'Save'}
          </button>
          <button
            onClick={handleRun}
            disabled={!id || validation.errors.length > 0}
            title="Run workflow"
            className="btn-primary text-xs inline-flex items-center gap-1.5 whitespace-nowrap"
          >
            <Play className="w-3.5 h-3.5" /> Run
          </button>
        </div>
      </header>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {mode === 'visual' ? (
          <Canvas
            nodes={nodes}
            edges={edges}
            onNodesChange={(n) => { setNodes(n); setDirty(true); }}
            onEdgesChange={(e) => { setEdges(e); setDirty(true); }}
            workflowInput={parsedWorkflow?.input ?? null}
          />
        ) : (
          <div className="flex h-full">
            {/* YAML editor */}
            <div className="flex-1 border-r border-border/50">
              <YamlEditor
                value={yamlContent}
                onChange={handleYamlChange}
                errors={validation.errors}
                warnings={validation.warnings}
              />
            </div>
            {/* Mermaid preview */}
            <div className="w-80 shrink-0 bg-surface">
              <MermaidPreview workflow={parsedWorkflow} />
            </div>
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
    </div>
  );
}
