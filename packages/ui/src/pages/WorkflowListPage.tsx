import { useState, useCallback } from 'react';
import { useWorkflows } from '../hooks/useWorkflows';
import { workflows as wfApi, executions as execApi } from '../services/api';
import { useNavigate } from 'react-router-dom';
import {
  GitBranch, Plus, Play, Trash2, CheckCircle, XCircle, RefreshCw, X,
} from 'lucide-react';
import StatusBadge from '../components/common/StatusBadge';
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

  const openRunDialog = useCallback((wf: any) => {
    // Pre-populate input fields from workflow input schema
    const defaults: Record<string, string> = {};
    if (wf.parsed?.input) {
      for (const key of Object.keys(wf.parsed.input)) {
        defaults[key] = '';
      }
    } else {
      // Fallback: common fields
      defaults['task'] = '';
      defaults['repo_path'] = '';
    }
    setRunInput(defaults);
    setRunDialog({ open: true, workflow: wf });
  }, []);

  const handleRun = useCallback(async () => {
    const wf = runDialog.workflow;
    if (!wf) return;
    const id = wf._id;
    setRunningId(id);
    setRunDialog({ open: false, workflow: null });
    try {
      // Filter out empty values
      const input: Record<string, string> = {};
      for (const [k, v] of Object.entries(runInput)) {
        if (v.trim()) input[k] = v.trim();
      }
      const exec = await execApi.start(id, input);
      navigate(`/executions/${exec.id}`);
    } catch (e: any) {
      alert(e.message);
    }
    setRunningId(null);
  }, [navigate, runDialog.workflow, runInput]);

  const handleDelete = useCallback(async (id: string) => {
    if (!confirm('Delete this workflow?')) return;
    await wfApi.delete(id);
    refresh();
  }, [refresh]);

  if (loading) {
    return (
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-bold text-white">Workflows</h1>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => <CardSkeleton key={i} />)}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-white">Workflows</h1>
        <div className="flex items-center gap-2">
          <button onClick={refresh} className="btn-ghost text-xs">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {workflows.length === 0 ? (
        <div className="card p-8 text-center">
          <GitBranch className="w-8 h-8 text-gray-600 mx-auto mb-3" />
          <p className="text-gray-400 text-sm">No workflows yet</p>
          <p className="text-gray-500 text-xs mt-1">Import a YAML workflow or create one via the API</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {workflows.map((wf: any) => (
            <div key={wf._id} className="card p-4 hover:border-border-light transition-colors">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                  <GitBranch className="w-4 h-4 text-accent-blue" />
                  <h3 className="text-sm font-semibold text-white">{wf.name}</h3>
                </div>
                <span className="text-xs text-gray-500">v{wf.version}</span>
              </div>

              {wf.description && (
                <p className="text-xs text-gray-400 mt-2 line-clamp-2">{wf.description}</p>
              )}

              <div className="flex items-center gap-2 mt-3">
                {wf.tags?.map((tag: string) => (
                  <span key={tag} className="badge bg-surface-200 text-gray-400">{tag}</span>
                ))}
              </div>

              <div className="flex items-center gap-1 mt-3">
                {wf.validation?.valid ? (
                  <span className="flex items-center gap-1 text-xs text-green-400">
                    <CheckCircle className="w-3 h-3" /> Valid
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-xs text-red-400">
                    <XCircle className="w-3 h-3" /> {wf.validation?.errors?.length ?? 0} errors
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2 mt-4 pt-3 border-t border-border">
                <button
                  onClick={() => openRunDialog(wf)}
                  disabled={runningId === wf._id || !wf.validation?.valid}
                  className="btn-primary text-xs flex-1"
                >
                  <Play className="w-3 h-3 mr-1" />
                  {runningId === wf._id ? 'Starting...' : 'Run'}
                </button>
                <button
                  onClick={() => handleDelete(wf._id)}
                  className="btn-ghost text-xs text-red-400 hover:text-red-300"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Run Workflow Dialog */}
      {runDialog.open && runDialog.workflow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-surface-100 border border-border rounded-lg w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-white">
                Run: {runDialog.workflow.name}
              </h2>
              <button
                onClick={() => setRunDialog({ open: false, workflow: null })}
                className="text-gray-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {runDialog.workflow.description && (
              <p className="text-xs text-gray-400 mb-4">{runDialog.workflow.description}</p>
            )}

            <div className="space-y-3">
              {Object.entries(runInput).map(([key, value]) => {
                const schema = runDialog.workflow.parsed?.input?.[key];
                const isRequired = schema?.required !== false;
                return (
                  <div key={key}>
                    <label className="block text-xs font-medium text-gray-300 mb-1">
                      {key.replace(/_/g, ' ')}
                      {isRequired && <span className="text-red-400 ml-0.5">*</span>}
                    </label>
                    {key.includes('path') || key.includes('repo') ? (
                      <input
                        type="text"
                        value={value}
                        onChange={e => setRunInput(prev => ({ ...prev, [key]: e.target.value }))}
                        placeholder={`e.g., /Users/you/your-project`}
                        className="input w-full text-xs"
                      />
                    ) : (
                      <textarea
                        value={value}
                        onChange={e => setRunInput(prev => ({ ...prev, [key]: e.target.value }))}
                        placeholder={`Enter ${key.replace(/_/g, ' ')}...`}
                        rows={key === 'task' || key === 'topic' || key === 'question' || key === 'problem' ? 3 : 1}
                        className="input w-full text-xs resize-none"
                      />
                    )}
                    {schema?.type && (
                      <p className="text-[10px] text-gray-500 mt-0.5">Type: {schema.type}</p>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="flex items-center gap-2 mt-5">
              <button
                onClick={() => setRunDialog({ open: false, workflow: null })}
                className="btn-ghost text-xs flex-1"
              >
                Cancel
              </button>
              <button
                onClick={handleRun}
                className="btn-primary text-xs flex-1"
              >
                <Play className="w-3 h-3 mr-1" />
                Run Workflow
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
