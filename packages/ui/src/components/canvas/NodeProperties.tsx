import { useState, useEffect } from 'react';
import type { Node } from '@xyflow/react';
import { Trash2 } from 'lucide-react';

const roles = ['planner', 'developer', 'tester', 'reviewer', 'researcher', 'writer', 'editor', 'analyst', 'investigator', 'git-ops', 'formatter'];
const builtIns = ['git-create-branch', 'git-commit', 'git-push', 'git-create-pr', 'git-cleanup-worktree', 'run-build', 'run-tests', 'classify-task'];

interface Props {
  node: Node | null;
  onUpdate: (id: string, data: Record<string, any>) => void;
  onDelete: (id: string) => void;
}

export default function NodeProperties({ node, onUpdate, onDelete }: Props) {
  const [localData, setLocalData] = useState<Record<string, any>>({});

  useEffect(() => {
    if (node) setLocalData({ ...node.data });
  }, [node?.id, node?.data]);

  if (!node) {
    return (
      <div className="p-4 text-sm text-gray-500">
        Select a node to edit its properties
      </div>
    );
  }

  const type = (localData.type as string) ?? 'agent';

  const update = (key: string, value: any) => {
    const next = { ...localData, [key]: value };
    setLocalData(next);
    onUpdate(node.id, next);
  };

  const updateOutputs = (val: string) => {
    const outputs = val.split(',').map(s => s.trim()).filter(Boolean);
    update('outputs', outputs);
  };

  return (
    <div className="p-4 space-y-4 overflow-auto h-full">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">{(localData.label as string) ?? node.id}</h3>
        <button
          onClick={() => onDelete(node.id)}
          className="btn-ghost text-xs text-red-400 hover:text-red-300 p-1"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Node name */}
      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1">Name</label>
        <input
          className="input w-full text-xs"
          value={(localData.label as string) ?? ''}
          onChange={e => update('label', e.target.value)}
        />
      </div>

      {/* Type selector */}
      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1">Type</label>
        <select className="input w-full text-xs" value={type} onChange={e => update('type', e.target.value)}>
          <option value="agent">Agent</option>
          <option value="code">Code</option>
          <option value="human">Human</option>
          <option value="workflow">Workflow</option>
          <option value="condition">Condition</option>
        </select>
      </div>

      {/* Agent-specific */}
      {type === 'agent' && (
        <>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Role</label>
            <select className="input w-full text-xs" value={(localData.role as string) ?? ''} onChange={e => update('role', e.target.value)}>
              <option value="">Select role...</option>
              {roles.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Prompt</label>
            <textarea
              className="input w-full text-xs h-28 resize-none font-mono"
              value={(localData.prompt as string) ?? ''}
              onChange={e => update('prompt', e.target.value)}
              placeholder="Enter prompt with {{variables}}..."
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={!!localData.resume_on_retry}
              onChange={e => update('resume_on_retry', e.target.checked)}
              className="w-3.5 h-3.5 rounded bg-surface-200 border-border"
            />
            <label className="text-xs text-gray-300">Resume on retry</label>
          </div>
        </>
      )}

      {/* Code-specific */}
      {type === 'code' && (
        <>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Function</label>
            <select className="input w-full text-xs" value={(localData.function as string) ?? ''} onChange={e => update('function', e.target.value)}>
              <option value="">Select function...</option>
              {builtIns.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Retries</label>
            <input
              type="number"
              min={0}
              max={10}
              className="input w-20 text-xs"
              value={(localData.retries as number) ?? 0}
              onChange={e => update('retries', parseInt(e.target.value) || 0)}
            />
          </div>
        </>
      )}

      {/* Human-specific */}
      {type === 'human' && (
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">Prompt</label>
          <textarea
            className="input w-full text-xs h-20 resize-none"
            value={(localData.prompt as string) ?? ''}
            onChange={e => update('prompt', e.target.value)}
            placeholder="What should the user see?"
          />
        </div>
      )}

      {/* Workflow-specific */}
      {type === 'workflow' && (
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">Sub-workflow name</label>
          <input
            className="input w-full text-xs"
            value={(localData.workflow as string) ?? ''}
            onChange={e => update('workflow', e.target.value)}
            placeholder="e.g., bugfix"
          />
        </div>
      )}

      {/* Outputs (all types except condition) */}
      {type !== 'condition' && (
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">Outputs (comma-separated)</label>
          <input
            className="input w-full text-xs"
            value={((localData.outputs as string[]) ?? []).join(', ')}
            onChange={e => updateOutputs(e.target.value)}
            placeholder="e.g., changed_files, summary"
          />
        </div>
      )}

      {/* Timeout */}
      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1">Timeout (seconds)</label>
        <input
          type="number"
          className="input w-20 text-xs"
          value={(localData.timeout as number) ?? ''}
          onChange={e => update('timeout', parseInt(e.target.value) || undefined)}
          placeholder="600"
        />
      </div>
    </div>
  );
}
