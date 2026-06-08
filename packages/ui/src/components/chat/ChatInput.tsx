import { useState, useRef, useCallback, useEffect, forwardRef, useImperativeHandle, type ReactNode, type RefObject, type SVGProps } from 'react';
import { ArrowUp, Square, ChevronDown, Paperclip, Loader2, X, Sparkles, ShieldCheck, Plus, Check, FolderGit2, CornerDownLeft } from 'lucide-react';
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
  getValue: () => string;
  focus: () => void;
}

interface ProviderInfo {
  provider: string;
  label: string;
  models: string[];
  modelSuggestions?: string[];
  defaultModel: string;
  open?: boolean;
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
  maxVisibleLines?: number;
  fixedVisibleLines?: boolean;
}

const PROVIDER_COLORS: Record<string, string> = {
  codex: 'text-accent-green',
  claude: 'text-accent',
  'claude-cli': 'text-accent',
  deepseek: 'text-accent-blue',
  'xiaomi-mimo': 'text-accent-blue',
  kimi: 'text-accent-blue',
};

function OpenAIIcon({ className }: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <path
        d="M12 3.4a4.1 4.1 0 0 1 3.9 2.8 4.1 4.1 0 0 1 4.2 4.1 4.2 4.2 0 0 1-1.8 3.4 4.1 4.1 0 0 1-5.9 5.5 4.1 4.1 0 0 1-6.3-2.3 4.1 4.1 0 0 1-2.2-7.5A4.1 4.1 0 0 1 8.6 4a4.1 4.1 0 0 1 3.4-.6Z"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinejoin="round"
      />
      <path
        d="M8.7 4.1 15 7.7v7.2l-6.3 3.6M4 9.4l6.3 3.6 6.2-3.6M6.1 16.9V9.8l6.2-3.6M18.3 13.7l-6.2-3.6-6.2 3.6M12.3 19.2v-7.1l6.2-3.6"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ClaudeIcon({ className }: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="12" r="2.4" fill="currentColor" />
    </svg>
  );
}

function DeepSeekIcon({ className }: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <path
        d="M4.2 12.3c0-4.3 3.4-7.8 7.7-7.8 3.1 0 5.8 1.8 7 4.4.5 1.1.8 2.3.8 3.5 0 4.3-3.4 7.7-7.8 7.7-1.8 0-3.5-.6-4.8-1.6l-2.8.8.8-2.7a7.6 7.6 0 0 1-.9-4.3Z"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinejoin="round"
      />
      <path
        d="M7.7 11.5c1.7 1.5 3.4 2.1 5.3 1.8 1.3-.2 2.4-.8 3.3-1.8M8.3 9.2c1.9-.9 3.8-.8 5.7.2M8.8 14.9c1.5.7 3.2.8 5 .2"
        stroke="currentColor"
        strokeWidth="1.45"
        strokeLinecap="round"
      />
      <circle cx="8.4" cy="8.7" r="0.85" fill="currentColor" />
    </svg>
  );
}

function XiaomiMimoIcon({ className }: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <rect x="3.8" y="4.6" width="16.4" height="14.8" rx="3.4" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M7.7 15.5V9.3h2.4l1.9 3.3 1.9-3.3h2.4v6.2M10.1 15.5v-3.2M13.9 15.5v-3.2"
        stroke="currentColor"
        strokeWidth="1.45"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function KimiIcon({ className }: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.1" stroke="currentColor" strokeWidth="1.65" />
      <path
        d="M8.7 7.8v8.4M15.6 8.1l-6.2 5 6.7 3.1M13.2 10.6l3.2-2.8M13.5 13.9l3.1 2.5"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M17.9 5.7 19.2 4.4M6.1 18.3l-1.3 1.3" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  );
}

export function ProviderIcon({ provider, className }: { provider?: string | null; className?: string }) {
  if (provider === 'codex') return <OpenAIIcon className={className} />;
  if (provider === 'claude' || provider === 'claude-cli') return <ClaudeIcon className={className} />;
  if (provider === 'deepseek') return <DeepSeekIcon className={className} />;
  if (provider === 'xiaomi-mimo') return <XiaomiMimoIcon className={className} />;
  if (provider === 'kimi') return <KimiIcon className={className} />;
  return <Sparkles className={className} />;
}

const EFFORT_OPTIONS: Array<{ value: ReasoningEffortValue; label: string; description: string }> = [
  { value: 'off', label: 'Off', description: 'No extended thinking' },
  { value: 'low', label: 'Low', description: 'Quick' },
  { value: 'medium', label: 'Medium', description: 'Standard' },
  { value: 'high', label: 'High', description: 'Deliberate' },
  { value: 'max', label: 'Max', description: 'Opus only' },
];

const pickerPanelClass = 'fixed z-50 min-w-[220px] overflow-hidden rounded-md border border-app bg-app-card p-2 shadow-2xl';
const pickerHeaderClass = 'px-3 pb-2 pt-1 text-[13px] font-medium text-theme-muted';
const pickerRowBaseClass = 'flex min-h-11 w-full items-center gap-3 rounded-md px-3 py-2 text-left text-[14px] transition-colors hover:bg-app-muted';
const modelPickerRowClass = 'flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-app-muted';
const effortPickerRowClass = 'flex min-h-9 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-app-muted';

const TEXTAREA_MIN_HEIGHT = 76;
const TEXTAREA_MAX_HEIGHT = 200;

export function modelOptionsForProvider(provider: ProviderInfo, currentModel?: string | null): string[] {
  const fixedModels = Array.isArray(provider.models) ? provider.models : [];
  const suggestions = Array.isArray(provider.modelSuggestions) ? provider.modelSuggestions : [];
  const candidates = provider.open
    ? [currentModel, provider.defaultModel, ...suggestions]
    : fixedModels;
  return [...new Set(candidates.filter((model): model is string => Boolean(model?.trim())))];
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function pickerPositionFor(
  ref: RefObject<HTMLElement | null>,
  panelWidth: number,
  estimatedHeight: number,
): { top: number; left: number; maxHeight: number; width: number } {
  const margin = 12;
  const gap = 6;
  const rect = ref.current?.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.min(panelWidth, viewportWidth - (margin * 2));

  if (!rect) {
    return { top: margin, left: margin, maxHeight: viewportHeight - (margin * 2), width };
  }

  const spaceAbove = rect.top - margin - gap;
  const spaceBelow = viewportHeight - rect.bottom - margin - gap;
  const dropDown = spaceBelow >= Math.min(estimatedHeight, spaceAbove);
  const maxHeight = Math.max(160, dropDown ? spaceBelow : spaceAbove);
  const top = dropDown
    ? rect.bottom + gap
    : Math.max(margin, rect.top - Math.min(estimatedHeight, maxHeight) - gap);
  const left = clamp(rect.left, margin, viewportWidth - width - margin);

  return { top, left, maxHeight, width };
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
    maxVisibleLines,
    fixedVisibleLines,
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
  const [modelPickerPos, setModelPickerPos] = useState<{ top: number; left: number; maxHeight: number; width: number } | null>(null);
  const [effortPickerPos, setEffortPickerPos] = useState<{ top: number; left: number; maxHeight: number; width: number } | null>(null);
  const [repoPickerPos, setRepoPickerPos] = useState<{ top: number; left: number; maxHeight: number; width: number } | null>(null);
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

  const [attachments, setAttachments] = useState<{ name: string; url: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function textareaMaxHeight(el: HTMLTextAreaElement): number {
    if (!maxVisibleLines || maxVisibleLines <= 0) return TEXTAREA_MAX_HEIGHT;
    const style = window.getComputedStyle(el);
    const lineHeight = Number.parseFloat(style.lineHeight) || 22;
    const paddingTop = Number.parseFloat(style.paddingTop) || 0;
    const paddingBottom = Number.parseFloat(style.paddingBottom) || 0;
    const borderTop = Number.parseFloat(style.borderTopWidth) || 0;
    const borderBottom = Number.parseFloat(style.borderBottomWidth) || 0;
    return Math.ceil((lineHeight * maxVisibleLines) + paddingTop + paddingBottom + borderTop + borderBottom);
  }

  function resizeTextarea(el: HTMLTextAreaElement): void {
    const maxHeight = textareaMaxHeight(el);
    el.style.height = 'auto';
    const nextHeight = fixedVisibleLines && maxVisibleLines
      ? maxHeight
      : Math.min(Math.max(el.scrollHeight, TEXTAREA_MIN_HEIGHT), maxHeight);
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
    if (el.scrollHeight > maxHeight) {
      el.scrollTop = el.scrollHeight;
    }
  }

  useImperativeHandle(ref, () => ({
    setValue: (v: string) => {
      setValue(v);
      setTimeout(() => {
        const el = textareaRef.current;
        if (el) { el.focus(); el.selectionStart = v.length; el.selectionEnd = v.length; }
      }, 0);
    },
    getValue: () => value,
    focus: () => textareaRef.current?.focus(),
  }), [value]);

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
      resizeTextarea(textareaRef.current);
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
        <div className="absolute bottom-full left-0 right-0 z-50 mb-2 overflow-hidden rounded-lg border border-app bg-app-card p-2 shadow-2xl">
          <div className="px-3 pb-2 pt-1 text-[13px] font-medium text-theme-muted">Commands</div>
          <div className="max-h-72 overflow-y-auto">
            {filteredSlashCommands.length === 0 ? (
              <div className="px-3 py-5 text-center text-[13px] text-theme-muted">No slash commands found</div>
            ) : filteredSlashCommands.map((command, index) => {
              const selected = index === slashSelectedIdx;
              return (
                <button
                  key={`${command.provider}-${command.name}-${command.source}`}
                  type="button"
                  disabled={!command.dispatchable}
                  onMouseEnter={() => setSlashSelectedIdx(index)}
                  onClick={() => command.dispatchable && handleSlashSelect(command)}
                  className={`flex min-h-11 w-full items-center gap-3 rounded-md px-3 py-2 text-left text-[14px] transition-colors ${
                    selected ? 'bg-app-muted text-theme-primary' : 'text-theme-secondary hover:bg-app-muted/70'
                  } ${!command.dispatchable ? 'cursor-not-allowed opacity-55' : ''}`}
                  title={command.unavailableReason}
                >
                  <span className="font-mono text-[13px] text-accent">{command.name}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{command.description}</span>
                    <span className="mt-0.5 block truncate font-mono text-[12px] text-theme-muted">
                      {command.dispatchable ? `${command.source} · ${command.provider}` : command.unavailableReason}
                    </span>
                  </span>
                  {selected && <Check className="h-4 w-4 shrink-0 text-theme-secondary" />}
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
        <div
          className="pointer-events-none absolute right-2 top-2 hidden items-center gap-1 font-mono text-[9px] text-theme-subtle sm:flex"
          aria-label="Shift Enter for new line"
          title="Shift + Enter for new line"
        >
          <span className="inline-flex h-5 items-center justify-center rounded-md border border-app bg-app-muted px-1.5 text-theme-subtle">
            Shift
          </span>
          <span>+</span>
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-md border border-app bg-app-muted text-theme-subtle">
            <CornerDownLeft className="h-3 w-3" />
          </span>
        </div>
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
        <div className="chat-input-controls cc-foot !mt-0 !pt-0">
          {/* ── Left cluster: model, effort, plan ── */}
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
                  setModelPickerPos(pickerPositionFor(pickerRef, 224, 360));
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
                <ProviderIcon provider={selectedProvider} className={`h-3 w-3 shrink-0 ${PROVIDER_COLORS[selectedProvider ?? ''] ?? 'text-theme-muted'}`} />
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
              <div
                className={`${pickerPanelClass} overflow-y-auto`}
                style={{
                  top: modelPickerPos?.top ?? 12,
                  left: modelPickerPos?.left ?? 12,
                  width: modelPickerPos?.width ?? 224,
                  maxHeight: Math.min(modelPickerPos?.maxHeight ?? 360, 360),
                }}
              >
                {providers?.map((p, providerIndex) => (
                  <div key={p.provider} className={providerIndex > 0 ? 'mt-2 border-t border-app pt-2' : ''}>
                    <div className="flex items-center gap-2 px-2 pb-1.5 pt-0.5 text-[12px] font-medium text-theme-muted">
                      <ProviderIcon provider={p.provider} className={`h-3.5 w-3.5 shrink-0 ${PROVIDER_COLORS[p.provider] ?? 'text-theme-muted'}`} />
                      <span>{p.label}</span>
                    </div>
                    {modelOptionsForProvider(p, selectedProvider === p.provider ? selectedModel : undefined).map((m) => {
                      const active = selectedProvider === p.provider && selectedModel === m;
                      return (
                      <button
                        key={`${p.provider}-${m}`}
                        onClick={() => { onProviderChange?.(p.provider, m); setShowModelPicker(false); }}
                        className={`${modelPickerRowClass} ${
                          active ? 'bg-app-muted text-theme-primary' : 'text-theme-secondary'
                        }`}
                      >
                        <span className="min-w-0 flex-1 truncate pl-6">{m}</span>
                        {active && <Check className="h-3.5 w-3.5 shrink-0 text-theme-secondary" />}
                      </button>
                      );
                    })}
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
                setEffortPickerPos(pickerPositionFor(effortPickerRef, 240, 260));
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
              <div
                className={pickerPanelClass}
                style={{
                  top: effortPickerPos?.top ?? 12,
                  left: effortPickerPos?.left ?? 12,
                  width: effortPickerPos?.width ?? 240,
                }}
              >
                <div className="px-2 pb-1.5 pt-0.5 text-[12px] font-medium text-theme-muted">Reasoning effort</div>
                {EFFORT_OPTIONS.map((opt) => {
                  const isActive = effectiveEffort === opt.value;
                  const isInheritedDefault =
                    !agentOverrides?.reasoningEffort && inheritedEffort === opt.value;
                  return (
                    <button
                      key={opt.value}
                      onClick={() => setEffort(opt.value)}
                      className={`${effortPickerRowClass} ${
                        isActive ? 'bg-app-muted text-theme-primary' : 'text-theme-secondary'
                      }`}
                    >
                      <Sparkles className="h-3.5 w-3.5 shrink-0 text-theme-muted" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{opt.label}</span>
                        <span className="block truncate text-[11px] text-theme-muted">{opt.description}</span>
                      </span>
                      {isActive && <Check className="h-3.5 w-3.5 shrink-0 text-theme-secondary" />}
                      {isInheritedDefault && (
                        <span className="rounded border border-app bg-app px-1.5 py-0.5 font-mono text-[9.5px] uppercase text-theme-muted">
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
                  setRepoPickerPos(pickerPositionFor(repoPickerRef, 360, 320));
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
                <FolderGit2 className="h-3 w-3 shrink-0" />
                <span className="max-w-[120px] truncate">
                  {selectedRepoName ?? 'Auto'}
                </span>
                {!repoLocked && <ChevronDown className="w-2.5 h-2.5 text-theme-subtle" />}
              </button>

              {showRepoPicker && !repoLocked && (
                <div
                  className={`${pickerPanelClass} overflow-y-auto`}
                  style={{
                    top: repoPickerPos?.top ?? 12,
                    left: repoPickerPos?.left ?? 12,
                    width: repoPickerPos?.width ?? 360,
                    maxHeight: Math.min(repoPickerPos?.maxHeight ?? 320, 320),
                  }}
                >
                  <div className={pickerHeaderClass}>Repository</div>
                  <button
                    className={`${pickerRowBaseClass} ${selectedRepoName == null ? 'bg-app-muted text-theme-primary' : 'text-theme-secondary'}`}
                    onClick={() => { onRepoChange?.(null); setShowRepoPicker(false); }}
                  >
                    <FolderGit2 className="h-4 w-4 shrink-0 text-theme-muted" />
                    <span className="min-w-0 flex-1 truncate">Auto</span>
                    {selectedRepoName == null && <Check className="h-4 w-4 shrink-0 text-theme-secondary" />}
                  </button>
                  {repos.map(repo => (
                    <button
                      key={repo._id}
                      className={`${pickerRowBaseClass} ${
                        selectedRepoName === repo.name ? 'bg-app-muted text-theme-primary' : 'text-theme-secondary'
                      }`}
                      onClick={() => { onRepoChange?.(repo); setShowRepoPicker(false); }}
                    >
                      <FolderGit2 className="h-4 w-4 shrink-0 text-theme-muted" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{repo.name}</span>
                        <span className="block truncate text-[12px] text-theme-muted">{repo.path}</span>
                      </span>
                      {selectedRepoName === repo.name && <Check className="h-4 w-4 shrink-0 text-theme-secondary" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          </div>
          {/* ── /Left cluster ── */}

          {/* ── Right cluster: send ── */}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading || disabled}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-theme-muted transition-colors hover:bg-surface-100/50 hover:text-theme-secondary disabled:cursor-not-allowed disabled:opacity-30"
              title="Attach file"
              aria-label="Attach file"
            >
              {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Paperclip className="h-3.5 w-3.5" />}
            </button>
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
