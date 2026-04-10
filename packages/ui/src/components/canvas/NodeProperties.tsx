import { useState, useEffect } from 'react';
import type { Node } from '@xyflow/react';
import { Trash2, Plus, X } from 'lucide-react';
import { agents as agentsApi } from '../../services/api';

interface HumanField {
  name: string;
  type: string;
  label?: string;
  required?: boolean;
  options?: string[];
}

interface Props {
  node: Node | null;
  onUpdate: (id: string, data: Record<string, any>) => void;
  onDelete: (id: string) => void;
}

const builtIns = ['git-create-branch', 'git-commit', 'git-push', 'git-create-pr', 'git-cleanup-worktree', 'run-build', 'run-tests', 'classify-task'];
const fieldTypes = ['string', 'text', 'boolean', 'number', 'select'];

export default function NodeProperties({ node, onUpdate, onDelete }: Props) {
  const [localData, setLocalData] = useState<Record<string, any>>({});
  const [agentList, setAgentList] = useState<any[]>([]);

  // Fetch agents from backend
  useEffect(() => {
    agentsApi.list().then(setAgentList).catch(() => {});
  }, []);

  useEffect(() => {
    if (node) setLocalData({ ...node.data });
  }, [node?.id, node?.data]);

  if (!node || node.id === 'START' || node.id === 'END') {
    return (
      <div className="p-4 text-sm text-theme-muted font-mono">
        SELECT A NODE TO EDIT
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

  // ── Human field helpers ──
  const fields: HumanField[] = (localData.fields as HumanField[]) ?? [];

  const addField = () => {
    update('fields', [...fields, { name: '', type: 'string', label: '', required: false }]);
  };

  const updateField = (idx: number, key: keyof HumanField, value: any) => {
    const next = [...fields];
    next[idx] = { ...next[idx], [key]: value };
    update('fields', next);
  };

  const removeField = (idx: number) => {
    update('fields', fields.filter((_, i) => i !== idx));
  };

  return (
    <div className="p-4 space-y-4 overflow-auto h-full">
      <div className="flex items-center justify-between">
        <h3 className="font-heading text-sm font-semibold text-theme-primary tracking-wider">{(localData.label as string) ?? node.id}</h3>
        <button onClick={() => onDelete(node.id)} className="btn-ghost text-xs text-accent-red hover:text-accent-red/80 p-1">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Node name */}
      <div>
        <label className="block text-xs font-label font-medium text-theme-secondary mb-1 uppercase tracking-wider">Name</label>
        <input className="input w-full text-xs" value={(localData.label as string) ?? ''} onChange={e => update('label', e.target.value)} />
      </div>

      {/* Type selector */}
      <div>
        <label className="block text-xs font-label font-medium text-theme-secondary mb-1 uppercase tracking-wider">Type</label>
        <select className="input w-full text-xs" value={type} onChange={e => update('type', e.target.value)}>
          <option value="agent">Agent</option>
          <option value="code">Code</option>
          <option value="human">Human</option>
          <option value="workflow">Workflow</option>
          <option value="condition">Condition</option>
        </select>
      </div>

      {/* ── Agent-specific ── */}
      {type === 'agent' && (
        <>
          <div>
            <label className="block text-xs font-label font-medium text-theme-secondary mb-1 uppercase tracking-wider">Agent</label>
            <select className="input w-full text-xs" value={(localData.agent as string) ?? ''} onChange={e => update('agent', e.target.value)}>
              <option value="">Select agent...</option>
              {agentList.map((a: any) => <option key={a.name} value={a.name}>{a.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-label font-medium text-theme-secondary mb-1 uppercase tracking-wider">Prompt</label>
            <textarea
              className="input w-full text-xs h-28 resize-none font-mono"
              value={(localData.prompt as string) ?? ''}
              onChange={e => update('prompt', e.target.value)}
              placeholder="Enter prompt with {{variables}}..."
            />
          </div>
          <div className="flex items-center gap-2">
            <input type="checkbox" checked={!!localData.resume_on_retry} onChange={e => update('resume_on_retry', e.target.checked)} className="w-3.5 h-3.5 rounded-sm bg-surface-200 border-accent-blue/30 accent-accent-blue" />
            <label className="text-xs text-theme-secondary font-label">Resume on retry</label>
          </div>
        </>
      )}

      {/* ── Code-specific ── */}
      {type === 'code' && (
        <>
          <div>
            <label className="block text-xs font-label font-medium text-theme-secondary mb-1 uppercase tracking-wider">Function</label>
            <select className="input w-full text-xs" value={(localData.function as string) ?? ''} onChange={e => update('function', e.target.value)}>
              <option value="">Select function...</option>
              {builtIns.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-label font-medium text-theme-secondary mb-1 uppercase tracking-wider">Retries</label>
            <input type="number" min={0} max={10} className="input w-20 text-xs" value={(localData.retries as number) ?? 0} onChange={e => update('retries', parseInt(e.target.value) || 0)} />
          </div>
        </>
      )}

      {/* ── Human-specific ── */}
      {type === 'human' && (
        <>
          <div>
            <label className="block text-xs font-label font-medium text-theme-secondary mb-1 uppercase tracking-wider">Prompt</label>
            <textarea className="input w-full text-xs h-20 resize-none" value={(localData.prompt as string) ?? ''} onChange={e => update('prompt', e.target.value)} placeholder="What should the user see?" />
          </div>

          {/* Field editor */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-xs font-label font-medium text-theme-secondary uppercase tracking-wider">Fields</label>
              <button onClick={addField} className="btn-ghost text-xs p-1 text-accent-blue">
                <Plus className="w-3 h-3" />
              </button>
            </div>
            <div className="space-y-2">
              {fields.map((field, idx) => (
                <div key={idx} className="bg-surface-200/80 rounded-sm p-2 space-y-1.5 border border-border/30">
                  <div className="flex items-center gap-1">
                    <input className="input flex-1 text-xs" placeholder="name" value={field.name} onChange={e => updateField(idx, 'name', e.target.value)} />
                    <select className="input text-xs w-20" value={field.type} onChange={e => updateField(idx, 'type', e.target.value)}>
                      {fieldTypes.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                    <button onClick={() => removeField(idx)} className="text-theme-muted hover:text-accent-red p-0.5 transition-colors">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                  <input className="input w-full text-xs" placeholder="Label" value={field.label ?? ''} onChange={e => updateField(idx, 'label', e.target.value)} />
                  <div className="flex items-center gap-2">
                    <input type="checkbox" checked={!!field.required} onChange={e => updateField(idx, 'required', e.target.checked)} className="w-3 h-3 rounded-sm bg-surface border-border accent-accent-blue" />
                    <span className="text-[10px] text-theme-secondary font-label uppercase tracking-wider">Required</span>
                  </div>
                  {field.type === 'select' && (
                    <input className="input w-full text-xs" placeholder="Options (comma-separated)" value={(field.options ?? []).join(', ')} onChange={e => updateField(idx, 'options', e.target.value.split(',').map(s => s.trim()).filter(Boolean))} />
                  )}
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* ── Workflow-specific ── */}
      {type === 'workflow' && (
        <div>
          <label className="block text-xs font-label font-medium text-theme-secondary mb-1 uppercase tracking-wider">Sub-workflow name</label>
          <input className="input w-full text-xs" value={(localData.workflow as string) ?? ''} onChange={e => update('workflow', e.target.value)} placeholder="e.g., bugfix" />
        </div>
      )}

      {/* Outputs (all types except condition) */}
      {type !== 'condition' && (
        <div>
          <label className="block text-xs font-label font-medium text-theme-secondary mb-1 uppercase tracking-wider">Outputs (comma-separated)</label>
          <input className="input w-full text-xs" value={((localData.outputs as string[]) ?? []).join(', ')} onChange={e => updateOutputs(e.target.value)} placeholder="e.g., changed_files, summary" />
        </div>
      )}

      {/* Timeout */}
      <div>
        <label className="block text-xs font-label font-medium text-theme-secondary mb-1 uppercase tracking-wider">Timeout (seconds)</label>
        <input type="number" className="input w-20 text-xs" value={(localData.timeout as number) ?? ''} onChange={e => update('timeout', parseInt(e.target.value) || undefined)} placeholder="600" />
      </div>
    </div>
  );
}
