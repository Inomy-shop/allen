import { useState, useRef, useCallback, useEffect, forwardRef, useImperativeHandle, type ReactNode } from 'react';
import { ArrowUp, Square, ChevronDown, Paperclip, Loader2, X, Sparkles, ShieldCheck, Plus } from 'lucide-react';
import MentionAutocomplete, { type MentionOption } from './MentionAutocomplete';
import { authHeaders, linear, type LinearIssueSummary } from '../../services/api';
import { CHAT_PLACEHOLDER } from '../../lib/brand';

export type ReasoningEffortValue = 'off' | 'low' | 'medium' | 'high' | 'max';

export interface RepoOption { _id: string; name: string; path: string; }

export interface SlashCommandOption {
  name: string;
  description: string;
  provider: string;
  source: 'builtin' | 'project' | 'user';
  kind?: 'builtin' | 'skill' | 'command';
  path?: string;
  dispatchable: boolean;
  unavailableReason?: string;
}

interface SessionOverrides {
  reasoningEffort?: ReasoningEffortValue | null;
  planMode?: boolean | null;
}

export interface ChatInputHandle {
  setValue: (v: string) => void;
  focus: () => void;
}

interface ProviderInfo {
  provider: string;
  label: string;
  models: string[];
  defaultModel: string;
}

interface ChatInputProps {
  onSend: (content: string) => void;
  onCancel?: () => void;
  streaming: boolean;
  disabled?: boolean;
  /** When set, shows a banner above the input explaining why it's disabled (e.g. Slack-managed sessions). */
  disabledReason?: string;
  providers?: ProviderInfo[];
  selectedProvider?: string;
  selectedModel?: string;
  modelLocked?: boolean;
  onProviderChange?: (provider: string, model: string) => void;
  /** Current overrides (session or pending). */
  agentOverrides?: SessionOverrides;
  /** Agent defaults shown as the fallback when no override is set. */
  inheritedEffort?: ReasoningEffortValue | null;
  inheritedPlanMode?: boolean | null;
  /** Parent decides whether to persist via PATCH or keep in local state. */
  onAgentOverridesChanged?: (next: SessionOverrides) => void;
  repos?: RepoOption[];
  selectedRepoName?: string | null;
  repoLocked?: boolean;
  onRepoChange?: (repo: RepoOption | null) => void;
  onOpenQuickCommands?: (anchor: HTMLElement) => void;
  slashCommands?: SlashCommandOption[];
  onSlashCommand?: (command: SlashCommandOption, raw: string) => boolean | void;
  extraControls?: ReactNode;
}

const PROVIDER_COLORS: Record<string, string> = {
  codex: 'text-accent-green',
  'claude-cli': 'text-accent-blue',
};

const EFFORT_OPTIONS: Array<{ value: ReasoningEffortValue; label: string; description: string }> = [
  { value: 'off', label: 'Off', description: 'No extended thinking' },
  { value: 'low', label: 'Low', description: 'Quick' },
  { value: 'medium', label: 'Medium', description: 'Standard' },
  { value: 'high', label: 'High', description: 'Deliberate' },
  { value: 'max', label: 'Max', description: 'Opus only' },
];

const TEXTAREA_MIN_HEIGHT = 40;
const TEXTAREA_MAX_HEIGHT = 150;

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Render the effort button label.
 *   - No override, no inherited value → "Default"
 *   - No override, inherited value present → "<Value> (default)"
 *   - Override set → "<Value>"
 */
function effortLabel(
  override: ReasoningEffortValue | null | undefined,
  inherited: ReasoningEffortValue | null | undefined,
): string {
  if (override) return capitalize(override);
  if (inherited) return `${capitalize(inherited)} (default)`;
  return 'Default';
}

const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(
  {
    onSend,
    onCancel,
    streaming,
    disabled,
    disabledReason,
    providers,
    selectedProvider,
    selectedModel,
    modelLocked,
    onProviderChange,
    agentOverrides,
    inheritedEffort,
    inheritedPlanMode,
    onAgentOverridesChanged,
    repos,
    selectedRepoName,
    repoLocked,
    onRepoChange,
    onOpenQuickCommands,
    slashCommands = [],
    onSlashCommand,
    extraControls,
  },
  ref,
) {
  const [value, setValue] = useState('');
  const [mentionVisible, setMentionVisible] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [slashVisible, setSlashVisible] = useState(false);
  const [slashQuery, setSlashQuery] = useState('');
  const [slashSelectedIdx, setSlashSelectedIdx] = useState(0);

  // ── Linear mention mode ──────────────────────────────────────────────
  const [linearMode, setLinearMode]       = useState(false);
  const [linearLoading, setLinearLoading] = useState(false);
  const [linearIssues, setLinearIssues]   = useState<LinearIssueSummary[]>([]);
  const [linearError, setLinearError]     = useState<'empty' | 'unconfigured' | 'error' | null>(null);
  const controllerRef   = useRef<AbortController | null>(null);
  const linearStatusRef = useRef<{ configured: boolean } | null>(null);

  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showEffortPicker, setShowEffortPicker] = useState(false);
  const [showRepoPicker, setShowRepoPicker] = useState(false);
  const [modelPlacement, setModelPlacement] = useState<'up' | 'down'>('up');
  const [effortPlacement, setEffortPlacement] = useState<'up' | 'down'>('up');
  const [repoPlacement, setRepoPlacement] = useState<'up' | 'down'>('up');
  const effortPickerRef = useRef<HTMLDivElement>(null);
  const repoPickerRef = useRef<HTMLDivElement>(null);

  const filteredSlashCommands = slashVisible
    ? slashCommands
        .filter(command => command.name.toLowerCase().includes(slashQuery.toLowerCase()))
        .slice(0, 12)
    : [];

  // Effective values: override wins, else inherited agent default
  const effectiveEffort = (agentOverrides?.reasoningEffort ?? inheritedEffort) ?? null;
  const effectivePlanMode =
    agentOverrides?.planMode ?? inheritedPlanMode ?? false;

  // Close the effort picker when clicking outside
  useEffect(() => {
    if (!showEffortPicker) return;
    const onDoc = (e: MouseEvent) => {
      if (!effortPickerRef.current?.contains(e.target as Node)) setShowEffortPicker(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [showEffortPicker]);

  // Close the repo picker when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (repoPickerRef.current && !repoPickerRef.current.contains(e.target as Node)) {
        setShowRepoPicker(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  function setEffort(v: ReasoningEffortValue): void {
    onAgentOverridesChanged?.({ ...agentOverrides, reasoningEffort: v });
    setShowEffortPicker(false);
  }

  function togglePlanMode(): void {
    onAgentOverridesChanged?.({ ...agentOverrides, planMode: !effectivePlanMode });
  }

  // ── Linear issue fetch ─────────────────────────────────────────────────
  const fetchLinearIssues = useCallback(async () => {
    // Abort any in-flight request
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setLinearLoading(true);
    setLinearIssues([]);
    setLinearError(null);

    try {
      // Check linear status once per ChatInput instance
      if (!linearStatusRef.current) {
        const status = await linear.status(controller.signal);
        linearStatusRef.current = { configured: status.configured };
      }

      if (!linearStatusRef.current.configured) {
        setLinearError('unconfigured');
        setLinearLoading(false);
        return;
      }

      // Fetch assigned issues — signal is now wired so AbortError fires on cancel.
      // limit: 250 is the server-side max (linear.service.ts caps via Math.min(_, 250)).
      // Client-side filtering inside the dropdown handles narrowing the list.
      const issues = await linear.issues(
        { assignee: 'me', state: 'started,unstarted,backlog', limit: 250 },
        controller.signal,
      );

      if (!issues || issues.length === 0) {
        setLinearError('empty');
      } else {
        setLinearIssues(issues);
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      console.error('[mention:linear] fetch failed', err);
      setLinearError('error');
    } finally {
      if (!controller.signal.aborted) {
        setLinearLoading(false);
      }
    }
  }, []);

  function placementFor(ref: React.RefObject<HTMLElement | null>, estimatedHeight = 300): 'up' | 'down' {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return 'up';
    const spaceAbove = rect.top;
    const spaceBelow = window.innerHeight - rect.bottom;
    if (spaceAbove < estimatedHeight && spaceBelow > spaceAbove) return 'down';
    return 'up';
  }
  const [attachments, setAttachments] = useState<{ name: string; url: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function resizeTextarea(el: HTMLTextAreaElement): void {
    el.style.height = 'auto';
    const nextHeight = Math.min(Math.max(el.scrollHeight, TEXTAREA_MIN_HEIGHT), TEXTAREA_MAX_HEIGHT);
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = el.scrollHeight > TEXTAREA_MAX_HEIGHT ? 'auto' : 'hidden';
  }

  useImperativeHandle(ref, () => ({
    setValue: (v: string) => {
      setValue(v);
      setTimeout(() => {
        const el = textareaRef.current;
        if (el) { el.focus(); el.selectionStart = v.length; el.selectionEnd = v.length; }
      }, 0);
    },
    focus: () => textareaRef.current?.focus(),
  }));

  // ── File upload ──
  const uploadFiles = useCallback(async (files: FileList | File[]) => {
    setUploading(true);
    const newAttachments: { name: string; url: string }[] = [];
    for (const file of Array.from(files)) {
      try {
        const form = new FormData();
        form.append('file', file);
        const res = await fetch('/api/files', { method: 'POST', headers: authHeaders(), body: form });
        if (!res.ok) continue;
        const data = await res.json();
        const fullUrl = `${window.location.origin}${data.url}`;
        newAttachments.push({ name: data.originalName, url: fullUrl });
      } catch {}
    }
    setAttachments(prev => [...prev, ...newAttachments]);
    setUploading(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
  }, [uploadFiles]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.items)
      .filter(item => item.kind === 'file')
      .map(item => item.getAsFile())
      .filter(Boolean) as File[];
    if (files.length) {
      e.preventDefault();
      uploadFiles(files);
    }
  }, [uploadFiles]);

  // Close picker on outside click
  useEffect(() => {
    if (!showModelPicker) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setShowModelPicker(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showModelPicker]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    resizeTextarea(el);
  }, [value]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value;
    setValue(text);
    resizeTextarea(e.target);
    const cursorPos = e.target.selectionStart;
    const textBeforeCursor = text.slice(0, cursorPos);
    const slashMatch = textBeforeCursor.match(/^\/([A-Za-z0-9:_-]*)$/);
    if (slashMatch) {
      setSlashVisible(true);
      setSlashQuery(slashMatch[1]);
      setSlashSelectedIdx(0);
      setMentionVisible(false);
      return;
    }
    setSlashVisible(false);
    setSlashQuery('');
    const lastAt = textBeforeCursor.lastIndexOf('@');
    if (lastAt !== -1) {
      const afterAt = textBeforeCursor.slice(lastAt + 1);
      const charBefore = lastAt > 0 ? textBeforeCursor[lastAt - 1] : ' ';
      if ((charBefore === ' ' || charBefore === '\n' || lastAt === 0) && !afterAt.includes(' ')) {
        setMentionVisible(true);
        setMentionQuery(afterAt);

        // Enter Linear mode when afterAt exactly matches 'linear' (case-insensitive)
        if (afterAt.toLowerCase() === 'linear') {
          if (!linearMode) {
            setLinearMode(true);
            fetchLinearIssues();
          }
        } else if (linearMode) {
          // Leaving linear mode (typing a different mention)
          setLinearMode(false);
          controllerRef.current?.abort();
          setLinearLoading(false);
          setLinearIssues([]);
          setLinearError(null);
        }

        return;
      }
    }
    // No valid mention — dismiss + reset linear mode
    setMentionVisible(false);
    setMentionQuery('');
    if (linearMode) {
      setLinearMode(false);
      controllerRef.current?.abort();
      setLinearLoading(false);
      setLinearIssues([]);
      setLinearError(null);
    }
  }, [linearMode, fetchLinearIssues]);

  const handleMentionSelect = useCallback((option: MentionOption) => {
    const el = textareaRef.current;
    if (!el) return;
    const cursorPos = el.selectionStart;
    const textBeforeCursor = value.slice(0, cursorPos);
    const lastAt = textBeforeCursor.lastIndexOf('@');
    const textAfterCursor = value.slice(cursorPos);
    const newValue = value.slice(0, lastAt) + '@' + option.name + ' ' + textAfterCursor;
    setValue(newValue);
    setMentionVisible(false);
    setMentionQuery('');
    // Reset linear mode on selection
    setLinearMode(false);
    controllerRef.current?.abort();
    setLinearLoading(false);
    setLinearIssues([]);
    setLinearError(null);
    setTimeout(() => { if (el) { const np = lastAt + option.name.length + 2; el.focus(); el.selectionStart = np; el.selectionEnd = np; } }, 0);
  }, [value]);

  const handleSlashSelect = useCallback((command: SlashCommandOption) => {
    const next = command.name + (command.dispatchable ? ' ' : '');
    setValue(next);
    setSlashVisible(false);
    setSlashQuery('');
    setSlashSelectedIdx(0);
    setTimeout(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.selectionStart = next.length;
      el.selectionEnd = next.length;
      resizeTextarea(el);
    }, 0);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionVisible && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) return;
    if (slashVisible && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashSelectedIdx(prev => Math.min(prev + 1, filteredSlashCommands.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashSelectedIdx(prev => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        const command = filteredSlashCommands[slashSelectedIdx];
        if (command) {
          e.preventDefault();
          handleSlashSelect(command);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setSlashVisible(false);
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }, [mentionVisible, slashVisible, filteredSlashCommands, slashSelectedIdx, handleSlashSelect, value, streaming, disabled]);

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if ((!trimmed && attachments.length === 0) || disabled) return;
    const slashName = trimmed.match(/^\/[^\s]+/)?.[0];
    const slashCommand = slashName ? slashCommands.find(command => command.name === slashName) : undefined;
    if (slashCommand && onSlashCommand?.(slashCommand, trimmed)) {
      setValue('');
      setSlashVisible(false);
      setSlashQuery('');
      return;
    }
    if (slashCommand && !slashCommand.dispatchable) return;
    // Append file URLs to message so the agent sees them
    let message = trimmed;
    if (attachments.length > 0) {
      const fileLinks = attachments.map(a => `[${a.name}](${a.url})`).join('\n');
      message = message ? `${message}\n\nAttached files:\n${fileLinks}` : `Attached files:\n${fileLinks}`;
    }
    onSend(message);
    setValue('');
    setAttachments([]);
    setMentionVisible(false);
    setMentionQuery('');
    setSlashVisible(false);
    setSlashQuery('');
    setLinearMode(false);
    controllerRef.current?.abort();
    setLinearLoading(false);
    setLinearIssues([]);
    setLinearError(null);
    if (textareaRef.current) {
      textareaRef.current.style.height = `${TEXTAREA_MIN_HEIGHT}px`;
      textareaRef.current.style.overflowY = 'hidden';
    }
  }, [value, attachments, disabled, onSend, slashCommands, onSlashCommand]);

  const currentProvider = providers?.find(p => p.provider === selectedProvider);

  return (
    <div className="chat-composer relative">
      <MentionAutocomplete
        query={mentionQuery}
        visible={mentionVisible}
        onSelect={handleMentionSelect}
        onDismiss={() => {
          setMentionVisible(false);
          setMentionQuery('');
          setLinearMode(false);
          controllerRef.current?.abort();
          setLinearLoading(false);
          setLinearIssues([]);
          setLinearError(null);
        }}
        mode={linearMode ? 'linear' : 'default'}
        linearIssues={linearIssues}
        linearLoading={linearLoading}
        linearError={linearError}
      />

      {slashVisible && (
        <div className="absolute left-0 right-0 bottom-full z-50 mb-2 overflow-hidden rounded-lg border border-app bg-surface-100 shadow-xl">
          <div className="max-h-72 overflow-y-auto py-1">
            {filteredSlashCommands.length === 0 ? (
              <div className="px-3 py-3 text-xs text-theme-subtle">No slash commands found</div>
            ) : filteredSlashCommands.map((command, index) => {
              const selected = index === slashSelectedIdx;
              return (
                <button
                  key={`${command.provider}-${command.name}-${command.source}`}
                  type="button"
                  disabled={!command.dispatchable}
                  onMouseEnter={() => setSlashSelectedIdx(index)}
                  onClick={() => command.dispatchable && handleSlashSelect(command)}
                  className={`flex w-full items-start gap-3 px-3 py-2 text-left transition-colors ${
                    selected ? 'bg-app-muted text-theme-primary' : 'text-theme-secondary hover:bg-app-muted/70'
                  } ${!command.dispatchable ? 'cursor-not-allowed opacity-55' : ''}`}
                  title={command.unavailableReason}
                >
                  <span className="mt-0.5 font-mono text-xs text-accent-blue">{command.name}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs">{command.description}</span>
                    <span className="mt-0.5 block truncate font-mono text-[10px] text-theme-subtle">
                      {command.dispatchable ? `${command.source} · ${command.provider}` : command.unavailableReason}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {disabled && disabledReason && (
        <div className="mb-2 px-3 py-2 rounded-md border border-app bg-surface-100/50 text-[11px] font-mono text-theme-secondary">
          {disabledReason}
        </div>
      )}

      {/* Hidden file input */}
      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={e => { if (e.target.files?.length) uploadFiles(e.target.files); e.target.value = ''; }} />

      {/* Attachment preview */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {attachments.map((a, i) => (
            <div key={i} className="flex items-center gap-1 bg-app-muted border border-app rounded px-2 py-0.5 text-[10px] font-mono text-theme-secondary">
              <Paperclip className="w-2.5 h-2.5 text-theme-muted" />
              <span className="truncate max-w-[150px]">{a.name}</span>
              <button onClick={() => setAttachments(prev => prev.filter((_, j) => j !== i))} className="text-theme-subtle hover:text-accent-red"><X className="w-2.5 h-2.5" /></button>
            </div>
          ))}
        </div>
      )}

      {/* Input container with model selector inside */}
      <div
        className={`chat-composer-field relative transition-colors ${dragOver ? 'is-dragging' : ''}`}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        {dragOver && (
          <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
            <span className="text-xs text-accent-blue font-mono">Drop files to attach</span>
          </div>
        )}
        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={CHAT_PLACEHOLDER}
          disabled={disabled}
          rows={1}
          className="w-full resize-none bg-transparent px-2 py-1.5 text-sm text-theme-primary placeholder-gray-600 font-body focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ minHeight: `${TEXTAREA_MIN_HEIGHT}px`, maxHeight: `${TEXTAREA_MAX_HEIGHT}px`, overflowY: 'hidden' }}
        />

        {/* Bottom bar inside the input — model selector + send button */}
        <div className="chat-input-controls cc-foot">
          {/* ── Left cluster: model, effort, plan, attach ── */}
          <div className="flex flex-wrap items-center gap-1">
            {onOpenQuickCommands && (
              <button
                type="button"
                onClick={(event) => onOpenQuickCommands(event.currentTarget)}
                disabled={disabled}
                className="flex h-6 w-6 items-center justify-center rounded-md text-theme-muted transition-colors hover:bg-surface-100/50 hover:text-theme-secondary disabled:cursor-not-allowed disabled:opacity-30"
                title="Quick commands"
                aria-label="Quick commands"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            )}
            {extraControls}

          {/* Model selector */}
          <div className="relative" ref={pickerRef}>
            {providers && providers.length > 0 && (
              <button
                onClick={() => {
                  if (modelLocked) return;
                  setModelPlacement(placementFor(pickerRef, 320));
                  setShowModelPicker(!showModelPicker);
                }}
                disabled={modelLocked}
                title={modelLocked ? 'Model locked for this conversation' : 'Select model'}
                className={`flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-mono transition-all ${
                  modelLocked
                    ? 'text-theme-subtle cursor-default'
                    : 'text-theme-muted hover:text-theme-secondary hover:bg-surface-100/50 cursor-pointer'
                }`}
              >
                <span className={PROVIDER_COLORS[selectedProvider ?? ''] ?? 'text-theme-muted'}>
                  {currentProvider?.label ?? selectedProvider}
                </span>
                <span className="text-theme-subtle">/</span>
                <span>{selectedModel}</span>
                {!modelLocked && <ChevronDown className="w-2.5 h-2.5 text-theme-subtle ml-0.5" />}
              </button>
            )}

            {/* Model picker dropdown — opens upward */}
            {showModelPicker && !modelLocked && (
              <div className={`absolute left-0 z-30 bg-surface-100 border border-app rounded-lg shadow-2xl overflow-hidden min-w-[220px] ${
                modelPlacement === 'down' ? 'top-full mt-1' : 'bottom-full mb-1'
              }`}>
                {providers?.map(p => (
                  <div key={p.provider}>
                    <div className="px-3 py-1 bg-app-muted/50 border-b border-app">
                      <span className={`overline ${PROVIDER_COLORS[p.provider] ?? 'text-theme-muted'}`}>{p.label}</span>
                    </div>
                    {p.models.map(m => (
                      <button
                        key={`${p.provider}-${m}`}
                        onClick={() => { onProviderChange?.(p.provider, m); setShowModelPicker(false); }}
                        className={`w-full text-left px-3 py-1.5 text-xs font-mono hover:bg-app-muted transition-colors ${
                          selectedProvider === p.provider && selectedModel === m ? 'text-accent-blue bg-accent-blue/5' : 'text-theme-secondary'
                        }`}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Reasoning effort picker — same dropdown style as the model picker */}
          <div className="relative" ref={effortPickerRef}>
            <button
              type="button"
              onClick={() => {
                setEffortPlacement(placementFor(effortPickerRef, 280));
                setShowEffortPicker((v) => !v);
              }}
              title="Reasoning effort"
              className={`flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-mono transition-all ${
                agentOverrides?.reasoningEffort
                  ? 'text-accent-blue hover:bg-accent-blue/10'
                  : 'text-theme-muted hover:text-theme-secondary hover:bg-surface-100/50'
              }`}
            >
              <Sparkles className="w-3 h-3" />
              <span>{effortLabel(agentOverrides?.reasoningEffort, inheritedEffort)}</span>
              <ChevronDown className="w-2.5 h-2.5 text-theme-subtle" />
            </button>

            {showEffortPicker && (
              <div className={`absolute left-0 z-30 bg-surface-100 border border-app rounded-lg shadow-2xl overflow-hidden min-w-[220px] ${
                effortPlacement === 'down' ? 'top-full mt-1' : 'bottom-full mb-1'
              }`}>
                <div className="px-3 py-1 bg-app-muted/50 border-b border-app">
                  <span className="overline">
                    Reasoning Effort
                  </span>
                </div>
                {EFFORT_OPTIONS.map((opt) => {
                  const isActive = effectiveEffort === opt.value;
                  const isInheritedDefault =
                    !agentOverrides?.reasoningEffort && inheritedEffort === opt.value;
                  return (
                    <button
                      key={opt.value}
                      onClick={() => setEffort(opt.value)}
                      className={`w-full text-left px-3 py-1.5 text-xs font-mono transition-colors hover:bg-app-muted flex items-center justify-between gap-2 ${
                        isActive ? 'text-accent-blue bg-accent-blue/5' : 'text-theme-secondary'
                      }`}
                    >
                      <span className="flex items-center gap-1.5">
                        <span>{opt.label}</span>
                        <span className="text-[10px] text-theme-subtle">— {opt.description}</span>
                      </span>
                      {isInheritedDefault && (
                        <span className="text-[9px] text-theme-subtle uppercase tracking-wider">
                          default
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Plan mode — slider toggle (Claude only) */}
          {(selectedProvider === 'claude-cli' || selectedProvider === 'claude') && (
            <button
              type="button"
              onClick={togglePlanMode}
              title={
                effectivePlanMode
                  ? 'Plan mode ON — agent will read & plan only, no edits'
                  : 'Plan mode OFF — agent may edit files'
              }
              aria-pressed={effectivePlanMode}
              className="flex items-center gap-1.5 px-1.5 py-0.5 rounded-md hover:bg-surface-100/50 transition-colors"
            >
              <ShieldCheck
                className={`w-3 h-3 ${effectivePlanMode ? 'text-accent-blue' : 'text-theme-muted'}`}
              />
              <span
                className={`text-[11px] font-mono ${effectivePlanMode ? 'text-accent-blue' : 'text-theme-muted'}`}
              >
                Plan
              </span>
              {/* Slider track */}
              <span
                className={`relative inline-block w-6 h-3 rounded-full transition-colors ${
                  effectivePlanMode ? 'bg-accent-blue' : 'bg-surface-200/70 border border-app'
                }`}
              >
                {/* Knob */}
                <span
                  className={`absolute top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-white shadow-sm transition-all ${
                    effectivePlanMode ? 'left-[calc(100%-10px)]' : 'left-[2px]'
                  }`}
                />
              </span>
            </button>
          )}

          {/* Repo selector */}
          {(repos && repos.length > 0) && (
            <div className="relative" ref={repoPickerRef}>
              <button
                type="button"
                disabled={repoLocked}
                onClick={() => {
                  if (repoLocked) return;
                  setRepoPlacement(placementFor(repoPickerRef, 280));
                  setShowRepoPicker(v => !v);
                }}
                className={`flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-mono transition-all ${
                  repoLocked
                    ? 'text-theme-subtle cursor-default'
                    : selectedRepoName
                      ? 'text-accent-blue hover:bg-accent-blue/10 cursor-pointer'
                      : 'text-theme-muted hover:text-theme-secondary hover:bg-surface-100/50 cursor-pointer'
                }`}
                title={repoLocked ? `Repo: ${selectedRepoName ?? 'none'}` : 'Select repository'}
              >
                <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round"
                    d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
                </svg>
                <span className="max-w-[120px] truncate">
                  {selectedRepoName ?? 'Auto'}
                </span>
                {!repoLocked && <ChevronDown className="w-2.5 h-2.5 text-theme-subtle" />}
              </button>

              {showRepoPicker && !repoLocked && (
                <div className={`absolute left-0 bg-surface-100 border border-app
                                rounded-lg shadow-xl z-50 min-w-[240px] max-h-[260px] overflow-y-auto py-1 ${
                  repoPlacement === 'down' ? 'top-full mt-1' : 'bottom-full mb-1'
                }`}>
                  <button
                    className="w-full text-left px-3 py-1.5 text-xs font-mono text-accent hover:bg-app-muted"
                    onClick={() => { onRepoChange?.(null); setShowRepoPicker(false); }}
                  >
                    Auto
                  </button>
                  <div className="h-px bg-app my-1" />
                  {repos.map(repo => (
                    <button
                      key={repo._id}
                      className={`w-full text-left px-3 py-1.5 text-xs font-mono hover:bg-app-muted ${
                        selectedRepoName === repo.name ? 'text-accent-blue bg-accent-blue/5' : 'text-theme-secondary'
                      }`}
                      onClick={() => { onRepoChange?.(repo); setShowRepoPicker(false); }}
                    >
                      <span className="block truncate">{repo.name}</span>
                      <span className="block truncate text-[10px] text-theme-subtle">{repo.path}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {/* Attach button */}
          <button onClick={() => fileInputRef.current?.click()} disabled={uploading || disabled}
            className="p-1 text-theme-muted hover:text-theme-secondary rounded transition-colors disabled:opacity-30" title="Attach file">
            {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Paperclip className="w-3.5 h-3.5" />}
          </button>
          </div>
          {/* ── /Left cluster ── */}

          {/* ── Right cluster: send ── */}
          <div className="flex items-center gap-2">
            {/* Send / Stop button */}
            {streaming && (
              <button
                type="button"
                onClick={onCancel}
                className="shrink-0 w-8 h-8 flex items-center justify-center rounded-full bg-red-500/20 text-accent-red hover:bg-red-500/30 transition-colors"
                title="Stop"
              >
                <Square className="w-3.5 h-3.5" />
              </button>
            )}
            {(!streaming || value.trim()) && (
              <button
                type="button"
                onClick={handleSend}
                disabled={!value.trim() || disabled}
                className="shrink-0 w-8 h-8 flex items-center justify-center rounded-full bg-accent-blue text-white shadow-sm transition-colors hover:bg-accent-hover disabled:bg-surface-200 disabled:text-theme-subtle disabled:opacity-100 disabled:cursor-not-allowed"
                title="Send"
              >
                <ArrowUp className="w-4 h-4" />
              </button>
            )}
          </div>
          {/* ── /Right cluster ── */}
        </div>
      </div>
    </div>
  );
});

export default ChatInput;
