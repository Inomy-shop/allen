import { useState, useCallback, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import yaml from 'js-yaml';
import type { Node, Edge } from '@xyflow/react';
import {
  Save, CheckCircle, Play, Eye, Code2, ArrowLeft, AlertTriangle,
} from 'lucide-react';
import { workflows as wfApi, executions as execApi } from '../services/api';
import Canvas from '../components/canvas/Canvas';
import YamlEditor from '../components/editor/YamlEditor';
import MermaidPreview from '../components/editor/MermaidPreview';
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

  // Load existing workflow
  useEffect(() => {
    if (!id) {
      const defaultYaml = `name: new-workflow\ndescription: \nversion: 1\n\ncontext:\n  requires: []\n  tools: []\n\ninput:\n  task: { type: string, required: true }\n\nnodes:\n  plan:\n    role: planner\n    prompt: "Break down: {{task}}"\n    outputs: [plan]\n\nedges:\n  - { from: START, to: plan }\n  - { from: plan, to: END }\n`;
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
        navigate(`/workflows/${result._id}/edit`, { replace: true });
      } else {
        await wfApi.update(id!, { yaml: finalYaml });
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

  // Run
  const handleRun = useCallback(async () => {
    if (!id) { alert('Save the workflow first'); return; }
    try {
      const exec = await execApi.start(id, {});
      navigate(`/executions/${exec.id}`);
    } catch (e: any) {
      alert(e.message);
    }
  }, [id, navigate]);

  if (loading) {
    return <div className="flex items-center justify-center h-full text-gray-500">Loading...</div>;
  }

  return (
    <div className="flex flex-col h-full">
      {/* Top bar */}
      <header className="flex items-center justify-between px-4 py-2 border-b border-border bg-surface-50 shrink-0">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/workflows')} className="text-gray-400 hover:text-gray-200">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <span className="text-sm font-semibold text-white">
            {workflowMeta.name ?? 'New Workflow'}
          </span>
          {workflowMeta.version && (
            <span className="text-xs text-gray-500">v{workflowMeta.version}</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Mode toggle */}
          <div className="flex items-center bg-surface-200 rounded-md p-0.5">
            <button
              onClick={() => handleModeSwitch('visual')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs transition-colors ${
                mode === 'visual' ? 'bg-surface-300 text-white' : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              <Eye className="w-3.5 h-3.5" /> Visual
            </button>
            <button
              onClick={() => handleModeSwitch('yaml')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs transition-colors ${
                mode === 'yaml' ? 'bg-surface-300 text-white' : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              <Code2 className="w-3.5 h-3.5" /> YAML
            </button>
          </div>

          <div className="w-px h-6 bg-border mx-1" />

          {/* Validation status */}
          {validation.errors.length > 0 ? (
            <span className="flex items-center gap-1 text-xs text-red-400">
              <AlertTriangle className="w-3.5 h-3.5" /> {validation.errors.length} errors
            </span>
          ) : validation.warnings.length > 0 ? (
            <span className="flex items-center gap-1 text-xs text-yellow-400">
              <AlertTriangle className="w-3.5 h-3.5" /> {validation.warnings.length} warnings
            </span>
          ) : null}

          <button onClick={handleValidate} className="btn-ghost text-xs">
            <CheckCircle className="w-3.5 h-3.5 mr-1" /> Validate
          </button>
          <button onClick={handleSave} disabled={saving} className="btn-ghost text-xs">
            <Save className="w-3.5 h-3.5 mr-1" /> {saving ? 'Saving...' : 'Save'}
          </button>
          <button
            onClick={handleRun}
            disabled={!id || validation.errors.length > 0}
            className="btn-primary text-xs"
          >
            <Play className="w-3.5 h-3.5 mr-1" /> Run
          </button>
        </div>
      </header>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {mode === 'visual' ? (
          <Canvas
            nodes={nodes}
            edges={edges}
            onNodesChange={setNodes}
            onEdgesChange={setEdges}
          />
        ) : (
          <div className="flex h-full">
            {/* YAML editor */}
            <div className="flex-1 border-r border-border">
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
    </div>
  );
}
