import { useState, useEffect } from 'react';
import { X, Sparkles } from 'lucide-react';
import Select from './Select';
import RoleIcon from './RoleIcon';

const CLAUDE_MODELS = ['sonnet', 'opus', 'haiku'];
const CODEX_MODELS = ['gpt-5.3-codex', 'gpt-5.4', 'gpt-5.2-codex', 'gpt-5.1-codex-max', 'gpt-5.2', 'gpt-5.1-codex-mini'];
const PROVIDERS = ['claude', 'codex'];
const TOOLS = ['filesystem', 'terminal', 'git', 'web-search', 'web-fetch', 'database'];
const ICONS = ['clipboard', 'code', 'eye', 'search', 'flask', 'pen', 'git-branch', 'bar-chart', 'magnifying-glass', 'layout', 'bot'];
const AGENT_TYPES = [
  { value: 'team', label: 'Team Agent — coordinates and delegates' },
  { value: 'technical', label: 'Technical Agent — executes specific tasks' },
];

function getModelsForProvider(provider: string): string[] {
  return provider === 'codex' ? CODEX_MODELS : CLAUDE_MODELS;
}

interface RoleDialogProps {
  open: boolean;
  onClose: () => void;
  onSave: (data: Record<string, unknown>) => Promise<void>;
  role?: Record<string, unknown> | null;
}

export default function RoleDialog({ open, onClose, onSave, role }: RoleDialogProps) {
  const isEdit = !!role;

  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [system, setSystem] = useState('');
  const [provider, setProvider] = useState('claude');
  const [model, setModel] = useState('sonnet');
  const [tools, setTools] = useState<string[]>([]);
  const [icon, setIcon] = useState('clipboard');
  const [color, setColor] = useState('#3b82f6');
  const [agentType, setAgentType] = useState('technical');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showPreviousPrompt, setShowPreviousPrompt] = useState(false);

  useEffect(() => {
    if (open && role) {
      setName((role.name as string) ?? '');
      setDisplayName((role.displayName as string) ?? '');
      setSystem((role.system as string) ?? '');
      setProvider((role.provider as string) ?? 'claude');
      setModel((role.model as string) ?? 'sonnet');
      setTools((role.tools as string[]) ?? []);
      setIcon((role.icon as string) ?? 'clipboard');
      setColor((role.color as string) ?? '#3b82f6');
      setAgentType((role.type as string) ?? 'technical');
      setShowPreviousPrompt(false);
    } else if (open) {
      setName('');
      setDisplayName('');
      setSystem('');
      setProvider('claude');
      setModel('sonnet');
      setTools([]);
      setIcon('clipboard');
      setColor('#3b82f6');
      setAgentType('technical');
      setShowPreviousPrompt(false);
    }
    setError('');
  }, [open, role]);

  function handleProviderChange(val: string) {
    setProvider(val);
    const models = getModelsForProvider(val);
    setModel(models[0]);
  }

  function toggleTool(tool: string) {
    setTools(prev => prev.includes(tool) ? prev.filter(t => t !== tool) : [...prev, tool]);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError('Name is required'); return; }
    if (!system.trim()) { setError('System prompt is required'); return; }

    setSaving(true);
    setError('');
    try {
      await onSave({
        name: name.trim(),
        displayName: displayName.trim() || name.trim(),
        system: system.trim(),
        provider,
        model,
        tools,
        icon,
        color,
        type: agentType,
      });
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save agent');
    } finally {
      setSaving(false);
    }
  }

  async function handleRollback() {
    if (!role?.previousSystemPrompt) return;
    setSaving(true);
    setError('');
    try {
      await onSave({
        name: role.name as string,
        system: role.previousSystemPrompt as string,
        previousSystemPrompt: null,
        provider,
        model,
        tools,
        icon,
        color,
        type: agentType,
      });
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to rollback');
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  const modelOptions = getModelsForProvider(provider).map(m => ({ value: m, label: m }));
  const providerOptions = PROVIDERS.map(p => ({ value: p, label: p }));
  const iconOptions = ICONS.map(i => ({ value: i, label: i }));
  const typeOptions = AGENT_TYPES.map(t => ({ value: t.value, label: t.label }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-surface-100 border border-border rounded-sm w-full max-w-lg max-h-[90vh] overflow-y-auto shadow-lg"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="font-heading text-sm font-bold text-white tracking-widest uppercase">
            {isEdit ? 'Edit Agent' : 'Create Agent'}
          </h2>
          <button type="button" onClick={onClose} className="btn-ghost p-1" title="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {error && (
            <div className="text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded-sm px-3 py-2">
              {error}
            </div>
          )}

          {/* Agent Type */}
          <div>
            <label className="font-label text-xs text-gray-400 mb-1 block">Agent Type</label>
            <Select value={agentType} onChange={setAgentType} options={typeOptions} />
          </div>

          {/* Name & Display Name */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="font-label text-xs text-gray-400 mb-1 block">Name (kebab-case)</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                disabled={isEdit}
                placeholder="my-agent-name"
                className="input w-full disabled:opacity-50 disabled:cursor-not-allowed"
              />
            </div>
            <div>
              <label className="font-label text-xs text-gray-400 mb-1 block">Display Name</label>
              <input
                type="text"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                placeholder="My Agent"
                className="input w-full"
              />
            </div>
          </div>

          {/* System Prompt */}
          <div>
            <label className="font-label text-xs text-gray-400 mb-1 block">System Prompt</label>
            <textarea
              value={system}
              onChange={e => setSystem(e.target.value)}
              rows={8}
              placeholder="Enter the system prompt for this agent..."
              className="w-full bg-surface-200 border border-accent-blue/30 rounded-sm px-3 py-2 text-sm text-gray-100 font-body resize-y focus:outline-none focus:border-accent-blue focus:shadow-glow-blue"
            />
          </div>

          {/* Previous Prompt (evolution) */}
          {isEdit && !!role?.previousSystemPrompt && (
            <div>
              <button
                type="button"
                onClick={() => setShowPreviousPrompt(!showPreviousPrompt)}
                className="btn-ghost text-xs flex items-center gap-1.5"
              >
                <Sparkles className="w-3 h-3 text-yellow-400" />
                {showPreviousPrompt ? 'Hide Previous Prompt' : 'View Previous Prompt'}
              </button>
              {showPreviousPrompt && (
                <div className="mt-2 space-y-2">
                  <pre className="text-xs text-gray-500 bg-surface-200 border border-border rounded-sm p-3 max-h-40 overflow-y-auto whitespace-pre-wrap font-mono">
                    {role.previousSystemPrompt as string}
                  </pre>
                  <button
                    type="button"
                    onClick={handleRollback}
                    disabled={saving}
                    className="btn-ghost text-xs text-yellow-400 hover:text-yellow-300"
                  >
                    Rollback to Previous Prompt
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Provider & Model */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="font-label text-xs text-gray-400 mb-1 block">Provider</label>
              <Select value={provider} onChange={handleProviderChange} options={providerOptions} />
            </div>
            <div>
              <label className="font-label text-xs text-gray-400 mb-1 block">Model</label>
              <Select value={model} onChange={setModel} options={modelOptions} />
            </div>
          </div>

          {/* Icon & Color */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="font-label text-xs text-gray-400 mb-1 block">Icon</label>
              <div className="flex items-center gap-2">
                <Select value={icon} onChange={setIcon} options={iconOptions} className="flex-1" />
                <div
                  className="w-9 h-9 rounded-sm flex items-center justify-center border border-border/40 shrink-0"
                  style={{ backgroundColor: color + '15' }}
                >
                  <RoleIcon icon={icon} color={color} size={18} />
                </div>
              </div>
            </div>
            <div>
              <label className="font-label text-xs text-gray-400 mb-1 block">Color</label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={color}
                  onChange={e => setColor(e.target.value)}
                  className="w-9 h-9 rounded-sm border border-border/40 cursor-pointer bg-transparent"
                />
                <input
                  type="text"
                  value={color}
                  onChange={e => setColor(e.target.value)}
                  className="input flex-1 font-mono text-xs"
                  placeholder="#3b82f6"
                />
              </div>
            </div>
          </div>

          {/* Tools */}
          <div>
            <label className="font-label text-xs text-gray-400 mb-1 block">Tools</label>
            <div className="grid grid-cols-3 gap-2">
              {TOOLS.map(tool => (
                <label key={tool} className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={tools.includes(tool)}
                    onChange={() => toggleTool(tool)}
                    className="accent-accent-blue"
                  />
                  <span className="font-mono">{tool}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
            <button type="button" onClick={onClose} className="btn-ghost text-xs">
              Cancel
            </button>
            <button type="submit" disabled={saving} className="btn-primary text-xs disabled:opacity-50">
              {saving ? 'Saving...' : isEdit ? 'Update Agent' : 'Create Agent'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
