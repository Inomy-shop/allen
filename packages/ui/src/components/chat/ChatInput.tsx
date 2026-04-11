import { useState, useRef, useCallback, useEffect, forwardRef, useImperativeHandle } from 'react';
import { Send, Square, ChevronDown, Paperclip, Loader2, X } from 'lucide-react';
import MentionAutocomplete, { type MentionOption } from './MentionAutocomplete';

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
}

const PROVIDER_COLORS: Record<string, string> = {
  codex: 'text-accent-green',
  'claude-cli': 'text-accent-blue',
};

const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(
  { onSend, onCancel, streaming, disabled, disabledReason, providers, selectedProvider, selectedModel, modelLocked, onProviderChange },
  ref,
) {
  const [value, setValue] = useState('');
  const [mentionVisible, setMentionVisible] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [attachments, setAttachments] = useState<{ name: string; url: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
        const res = await fetch('/api/files', { method: 'POST', body: form });
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
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }, [value]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value;
    setValue(text);
    const cursorPos = e.target.selectionStart;
    const textBeforeCursor = text.slice(0, cursorPos);
    const lastAt = textBeforeCursor.lastIndexOf('@');
    if (lastAt !== -1) {
      const afterAt = textBeforeCursor.slice(lastAt + 1);
      const charBefore = lastAt > 0 ? textBeforeCursor[lastAt - 1] : ' ';
      if ((charBefore === ' ' || charBefore === '\n' || lastAt === 0) && !afterAt.includes(' ')) {
        setMentionVisible(true); setMentionQuery(afterAt); return;
      }
    }
    setMentionVisible(false); setMentionQuery('');
  }, []);

  const handleMentionSelect = useCallback((option: MentionOption) => {
    const el = textareaRef.current;
    if (!el) return;
    const cursorPos = el.selectionStart;
    const textBeforeCursor = value.slice(0, cursorPos);
    const lastAt = textBeforeCursor.lastIndexOf('@');
    const textAfterCursor = value.slice(cursorPos);
    const newValue = value.slice(0, lastAt) + '@' + option.name + ' ' + textAfterCursor;
    setValue(newValue); setMentionVisible(false); setMentionQuery('');
    setTimeout(() => { if (el) { const np = lastAt + option.name.length + 2; el.focus(); el.selectionStart = np; el.selectionEnd = np; } }, 0);
  }, [value]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionVisible && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }, [mentionVisible, value, streaming, disabled]);

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if ((!trimmed && attachments.length === 0) || streaming || disabled) return;
    // Append file URLs to message so the agent sees them
    let message = trimmed;
    if (attachments.length > 0) {
      const fileLinks = attachments.map(a => `[${a.name}](${a.url})`).join('\n');
      message = message ? `${message}\n\nAttached files:\n${fileLinks}` : `Attached files:\n${fileLinks}`;
    }
    onSend(message); setValue(''); setAttachments([]); setMentionVisible(false);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }, [value, attachments, streaming, disabled, onSend]);

  const currentProvider = providers?.find(p => p.provider === selectedProvider);

  return (
    <div className="relative border-t border-border/50 bg-surface-50 p-3">
      <MentionAutocomplete query={mentionQuery} visible={mentionVisible} onSelect={handleMentionSelect} onDismiss={() => setMentionVisible(false)} />

      {disabled && disabledReason && (
        <div className="mb-2 px-3 py-2 rounded-md border border-border/30 bg-surface-100/50 text-[11px] font-mono text-theme-secondary">
          {disabledReason}
        </div>
      )}

      {/* Hidden file input */}
      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={e => { if (e.target.files?.length) uploadFiles(e.target.files); e.target.value = ''; }} />

      {/* Attachment preview */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {attachments.map((a, i) => (
            <div key={i} className="flex items-center gap-1 bg-surface-200/50 border border-border/30 rounded px-2 py-0.5 text-[10px] font-mono text-theme-secondary">
              <Paperclip className="w-2.5 h-2.5 text-theme-muted" />
              <span className="truncate max-w-[150px]">{a.name}</span>
              <button onClick={() => setAttachments(prev => prev.filter((_, j) => j !== i))} className="text-theme-subtle hover:text-red-400"><X className="w-2.5 h-2.5" /></button>
            </div>
          ))}
        </div>
      )}

      {/* Input container with model selector inside */}
      <div
        className={`relative bg-surface-200/50 border rounded-lg focus-within:border-accent-blue/50 transition-colors ${dragOver ? 'border-accent-blue border-dashed bg-accent-blue/5' : 'border-border/30'}`}
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
          placeholder="Message FlowForge..."
          disabled={streaming || disabled}
          rows={1}
          className="w-full resize-none bg-transparent px-3 pt-2.5 pb-10 text-sm text-theme-primary placeholder-gray-600 font-body focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ minHeight: '44px', maxHeight: '160px' }}
        />

        {/* Bottom bar inside the input — model selector + send button */}
        <div className="absolute bottom-0 left-0 right-0 flex items-center justify-between px-2 py-1.5">
          {/* Model selector (left side) */}
          <div className="relative" ref={pickerRef}>
            {providers && providers.length > 0 && (
              <button
                onClick={() => !modelLocked && setShowModelPicker(!showModelPicker)}
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
              <div className="absolute bottom-full left-0 mb-1 z-30 bg-surface-100 border border-border/50 rounded-lg shadow-2xl overflow-hidden min-w-[220px]">
                {providers?.map(p => (
                  <div key={p.provider}>
                    <div className="px-3 py-1 bg-surface-200/30 border-b border-border/20">
                      <span className={`text-[10px] font-label uppercase tracking-widest ${PROVIDER_COLORS[p.provider] ?? 'text-theme-muted'}`}>{p.label}</span>
                    </div>
                    {p.models.map(m => (
                      <button
                        key={`${p.provider}-${m}`}
                        onClick={() => { onProviderChange?.(p.provider, m); setShowModelPicker(false); }}
                        className={`w-full text-left px-3 py-1.5 text-xs font-mono hover:bg-surface-200/50 transition-colors ${
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

          {/* Attach button */}
          <button onClick={() => fileInputRef.current?.click()} disabled={uploading || disabled}
            className="p-1 text-theme-muted hover:text-theme-secondary rounded transition-colors disabled:opacity-30" title="Attach file">
            {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Paperclip className="w-3.5 h-3.5" />}
          </button>

          {/* Hint */}
          <span className="text-[10px] text-theme-subtle font-mono hidden sm:inline">shift+enter for new line</span>

          {/* Send / Stop button (right side) */}
          {streaming ? (
            <button onClick={onCancel} className="shrink-0 w-8 h-8 flex items-center justify-center rounded-md bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors" title="Stop">
              <Square className="w-3.5 h-3.5" />
            </button>
          ) : (
            <button onClick={handleSend} disabled={!value.trim() || disabled}
              className="shrink-0 w-8 h-8 flex items-center justify-center rounded-md bg-accent-blue/20 text-accent-blue hover:bg-accent-blue/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed" title="Send">
              <Send className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

export default ChatInput;
