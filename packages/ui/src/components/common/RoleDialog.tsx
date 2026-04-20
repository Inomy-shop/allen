import { useState, useEffect } from 'react';
import { X, Sparkles, FileText, Eye, Columns, Pencil, AlertCircle } from 'lucide-react';
import Select from './Select';
import RoleIcon from './RoleIcon';
import { renderMarkdown } from '../chat/ChatMessageList';

const CLAUDE_MODELS = ['sonnet', 'opus', 'haiku'];
const CODEX_MODELS = ['gpt-5.3-codex', 'gpt-5.4', 'gpt-5.2-codex', 'gpt-5.1-codex-max', 'gpt-5.2', 'gpt-5.1-codex-mini'];
const PROVIDERS = ['claude', 'codex'];
const TOOLS = ['filesystem', 'terminal', 'git', 'web-search', 'web-fetch', 'database'];
const EFFORT_LEVELS = [
  { value: '', label: '(CLI default)' },
  { value: 'off', label: 'Off' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max — Opus only' },
];
const PLAN_MODE_OPTIONS = [
  { value: '', label: '(CLI default: off)' },
  { value: 'off', label: 'Off — may edit files' },
  { value: 'on', label: 'On — read & plan only' },
];
const ICONS = ['clipboard', 'code', 'eye', 'search', 'flask', 'pen', 'git-branch', 'bar-chart', 'magnifying-glass', 'layout', 'bot'];
const AGENT_TYPES = [
  { value: 'team', label: 'Team Agent — coordinates and delegates' },
  { value: 'technical', label: 'Technical Agent — executes specific tasks' },
];

function getModelsForProvider(provider: string): string[] {
  return provider === 'codex' ? CODEX_MODELS : CLAUDE_MODELS;
}

// Backend stores `provider` as 'claude-cli' (for Claude agents) or 'codex'.
// The dropdown offers 'claude' | 'codex'. Normalize on load so the Select matches.
function normalizeProviderForUi(p: unknown): string {
  if (p === 'codex') return 'codex';
  return 'claude';
}

interface RoleDialogProps {
  open: boolean;
  onClose: () => void;
  onSave: (data: Record<string, unknown>) => Promise<void>;
  role?: Record<string, unknown> | null;
}

type EditorMode = 'edit' | 'preview' | 'split';

export default function RoleDialog({ open, onClose, onSave, role }: RoleDialogProps) {
  const isEdit = !!role;

  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [system, setSystem] = useState('');
  const [provider, setProvider] = useState('claude');
  const [model, setModel] = useState('sonnet');
  const [reasoningEffort, setReasoningEffort] = useState('');
  const [planMode, setPlanMode] = useState('');
  const [tools, setTools] = useState<string[]>([]);
  const [icon, setIcon] = useState('clipboard');
  const [color, setColor] = useState('#3b82f6');
  const [agentType, setAgentType] = useState('technical');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showPreviousPrompt, setShowPreviousPrompt] = useState(false);
  const [editorMode, setEditorMode] = useState<EditorMode>('edit');

  useEffect(() => {
    if (open && role) {
      setName((role.name as string) ?? '');
      setDisplayName((role.displayName as string) ?? '');
      setSystem((role.system as string) ?? '');
      setProvider(normalizeProviderForUi(role.provider));
      setModel((role.model as string) ?? 'sonnet');
      setReasoningEffort((role.reasoningEffort as string) ?? '');
      setPlanMode(
        role.planMode === true ? 'on' : role.planMode === false ? 'off' : '',
      );
      setTools((role.tools as string[]) ?? []);
      setIcon((role.icon as string) ?? 'clipboard');
      setColor((role.color as string) ?? '#3b82f6');
      setAgentType((role.type as string) ?? 'technical');
      setShowPreviousPrompt(false);
      setEditorMode('edit');
    } else if (open) {
      setName('');
      setDisplayName('');
      setSystem('');
      setProvider('claude');
      setModel('sonnet');
      setReasoningEffort('');
      setPlanMode('');
      setTools([]);
      setIcon('clipboard');
      setColor('#3b82f6');
      setAgentType('technical');
      setShowPreviousPrompt(false);
      setEditorMode('edit');
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
        reasoningEffort: reasoningEffort || undefined,
        planMode: planMode === '' ? undefined : planMode === 'on',
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

  const wordCount = system.trim() ? system.trim().split(/\s+/).length : 0;
  const charCount = system.length;
  const lineCount = system ? system.split('\n').length : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-surface-100 border border-border rounded-lg w-full max-w-6xl max-h-[92vh] overflow-hidden shadow-glow-blue/20 flex flex-col animate-in fade-in zoom-in-95 duration-200"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border/60 shrink-0">
          <div className="flex items-center gap-3">
            <div
              className="w-9 h-9 rounded-lg flex items-center justify-center border border-border/30"
              style={{ backgroundColor: color + '18' }}
            >
              <RoleIcon icon={icon} color={color} size={20} />
            </div>
            <div>
              <h2 className="font-heading text-sm font-bold text-theme-primary tracking-widest uppercase">
                {isEdit ? 'Edit Agent' : 'Create Agent'}
              </h2>
              <div className="text-[10px] font-mono text-theme-subtle">
                {displayName || name || 'New agent'}
              </div>
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-md text-theme-muted hover:text-theme-primary hover:bg-surface-200/50 transition-colors" title="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 min-h-0 flex flex-col">
          <div className="flex-1 min-h-0 grid grid-cols-[22rem_1fr]">
            {/* ── Left column: metadata fields ───────────────────────────── */}
            <div className="border-r border-border/60 overflow-y-auto p-5 space-y-4 min-h-0">
              {error && (
                <div className="flex items-start gap-2 text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded-md px-3 py-2">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}

              <div>
                <label className="font-label text-[10px] font-semibold text-theme-secondary uppercase tracking-widest mb-1.5 block">Agent Type</label>
                <Select value={agentType} onChange={setAgentType} options={typeOptions} />
              </div>

              <div>
                <label className="font-label text-[10px] font-semibold text-theme-secondary uppercase tracking-widest mb-1.5 block">Name (kebab-case)</label>
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
                <label className="font-label text-[10px] font-semibold text-theme-secondary uppercase tracking-widest mb-1.5 block">Display Name</label>
                <input
                  type="text"
                  value={displayName}
                  onChange={e => setDisplayName(e.target.value)}
                  placeholder="My Agent"
                  className="input w-full"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-label text-[10px] font-semibold text-theme-secondary uppercase tracking-widest mb-1.5 block">Provider</label>
                  <Select value={provider} onChange={handleProviderChange} options={providerOptions} />
                </div>
                <div>
                  <label className="font-label text-[10px] font-semibold text-theme-secondary uppercase tracking-widest mb-1.5 block">Model</label>
                  <Select value={model} onChange={setModel} options={modelOptions} />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-label text-[10px] font-semibold text-theme-secondary uppercase tracking-widest mb-1.5 block">Reasoning</label>
                  <Select
                    value={reasoningEffort}
                    onChange={setReasoningEffort}
                    options={EFFORT_LEVELS.filter(l => l.value !== 'max' || /opus/i.test(model))}
                  />
                </div>
                <div>
                  <label className="font-label text-[10px] font-semibold text-theme-secondary uppercase tracking-widest mb-1.5 block">Plan Mode</label>
                  {provider === 'claude' ? (
                    <Select value={planMode} onChange={setPlanMode} options={PLAN_MODE_OPTIONS} />
                  ) : (
                    <div className="px-3 py-2 bg-surface-50 border border-border/30 rounded-sm text-[11px] text-theme-subtle">
                      Claude only
                    </div>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-label text-[10px] font-semibold text-theme-secondary uppercase tracking-widest mb-1.5 block">Icon</label>
                  <div className="flex items-center gap-2">
                    <Select value={icon} onChange={setIcon} options={iconOptions} className="flex-1" />
                    <div
                      className="w-9 h-9 rounded-md flex items-center justify-center border border-border/40 shrink-0"
                      style={{ backgroundColor: color + '15' }}
                    >
                      <RoleIcon icon={icon} color={color} size={18} />
                    </div>
                  </div>
                </div>
                <div>
                  <label className="font-label text-[10px] font-semibold text-theme-secondary uppercase tracking-widest mb-1.5 block">Color</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={color}
                      onChange={e => setColor(e.target.value)}
                      className="w-9 h-9 rounded-md border border-border/40 cursor-pointer bg-transparent"
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

              <div>
                <label className="font-label text-[10px] font-semibold text-theme-secondary uppercase tracking-widest mb-1.5 block">Tools</label>
                <div className="grid grid-cols-2 gap-1.5">
                  {TOOLS.map(tool => (
                    <label
                      key={tool}
                      className={`flex items-center gap-2 text-[11px] font-mono px-2 py-1.5 rounded-md cursor-pointer transition-colors border ${
                        tools.includes(tool)
                          ? 'bg-accent-blue/10 text-accent-blue border-accent-blue/30'
                          : 'bg-surface-200/30 text-theme-muted border-border/30 hover:bg-surface-200/50'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={tools.includes(tool)}
                        onChange={() => toggleTool(tool)}
                        className="accent-accent-blue"
                      />
                      <span>{tool}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Previous prompt */}
              {isEdit && !!role?.previousSystemPrompt && (
                <div className="pt-2 border-t border-border/30">
                  <button
                    type="button"
                    onClick={() => setShowPreviousPrompt(!showPreviousPrompt)}
                    className="btn-ghost text-[11px] flex items-center gap-1.5"
                  >
                    <Sparkles className="w-3 h-3 text-yellow-400" />
                    {showPreviousPrompt ? 'Hide Previous Prompt' : 'View Previous Prompt'}
                  </button>
                  {showPreviousPrompt && (
                    <div className="mt-2 space-y-2">
                      <pre className="text-[10px] text-theme-muted bg-surface-200 border border-border rounded-md p-3 max-h-40 overflow-y-auto whitespace-pre-wrap font-mono">
                        {role.previousSystemPrompt as string}
                      </pre>
                      <button
                        type="button"
                        onClick={handleRollback}
                        disabled={saving}
                        className="btn-ghost text-[11px] text-yellow-400 hover:text-yellow-300"
                      >
                        Rollback to Previous Prompt
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ── Right column: README-style editor ───────────────────────── */}
            <div className="flex flex-col min-h-0">
              {/* Editor tab bar */}
              <div className="px-5 py-2.5 border-b border-border/60 flex items-center justify-between gap-3 shrink-0 bg-surface-200/10">
                <div className="flex items-center gap-2">
                  <FileText className="w-3.5 h-3.5 text-accent-blue" />
                  <span className="text-[11px] font-label uppercase tracking-widest text-theme-secondary font-semibold">
                    Agent Instructions
                  </span>
                  <span className="text-[10px] font-mono text-theme-subtle">README.md</span>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-[9px] font-mono text-theme-subtle">
                    {lineCount} {lineCount === 1 ? 'line' : 'lines'} · {wordCount} {wordCount === 1 ? 'word' : 'words'} · {charCount} chars
                  </div>
                  <div className="flex items-center rounded-md border border-border/50 overflow-hidden bg-surface-200/30">
                    <button
                      type="button"
                      onClick={() => setEditorMode('edit')}
                      className={`inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-mono transition-colors ${
                        editorMode === 'edit'
                          ? 'bg-accent-blue/15 text-accent-blue'
                          : 'text-theme-muted hover:text-theme-primary hover:bg-surface-200/50'
                      }`}
                      title="Edit only"
                    >
                      <Pencil className="w-3 h-3" /> Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditorMode('split')}
                      className={`inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-mono transition-colors border-l border-border/50 ${
                        editorMode === 'split'
                          ? 'bg-accent-blue/15 text-accent-blue'
                          : 'text-theme-muted hover:text-theme-primary hover:bg-surface-200/50'
                      }`}
                      title="Split view"
                    >
                      <Columns className="w-3 h-3" /> Split
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditorMode('preview')}
                      className={`inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-mono transition-colors border-l border-border/50 ${
                        editorMode === 'preview'
                          ? 'bg-accent-blue/15 text-accent-blue'
                          : 'text-theme-muted hover:text-theme-primary hover:bg-surface-200/50'
                      }`}
                      title="Preview only"
                    >
                      <Eye className="w-3 h-3" /> Preview
                    </button>
                  </div>
                </div>
              </div>

              {/* Editor body */}
              <div className={`flex-1 min-h-0 ${editorMode === 'split' ? 'grid grid-cols-2' : 'flex flex-col'}`}>
                {(editorMode === 'edit' || editorMode === 'split') && (
                  <textarea
                    value={system}
                    onChange={e => setSystem(e.target.value)}
                    placeholder={`# Agent Role\n\nDescribe what this agent does, its responsibilities, and how it should behave.\n\n## Responsibilities\n\n- Responsibility 1\n- Responsibility 2\n\n## Examples\n\n\`\`\`\nExample interaction\n\`\`\`\n`}
                    spellCheck={false}
                    className={`flex-1 min-h-0 w-full px-5 py-4 bg-surface-50/40 border-0 outline-none resize-none text-[13px] text-theme-primary font-mono leading-relaxed placeholder:text-theme-subtle focus:bg-surface-50/70 transition-colors ${
                      editorMode === 'split' ? 'border-r border-border/60' : ''
                    }`}
                  />
                )}
                {(editorMode === 'preview' || editorMode === 'split') && (
                  <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 bg-surface-100/20">
                    {system.trim() ? (
                      <div className="text-sm text-theme-secondary leading-relaxed prose-allen">
                        {renderMarkdown(system)}
                      </div>
                    ) : (
                      <div className="text-[12px] text-theme-muted italic font-body">
                        Nothing to preview yet. Write some markdown on the left.
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Footer actions */}
          <div className="px-5 py-3.5 border-t border-border/60 flex items-center justify-between gap-2 shrink-0 bg-surface-200/10">
            <div className="text-[10px] font-mono text-theme-subtle">
              Tip: Markdown supported — headings, lists, links, code blocks.
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={onClose} className="btn-ghost text-xs">
                Cancel
              </button>
              <button type="submit" disabled={saving} className="btn-primary text-xs disabled:opacity-50">
                {saving ? 'Saving...' : isEdit ? 'Update Agent' : 'Create Agent'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
