import { useState, useRef, useCallback, useEffect, forwardRef, useImperativeHandle } from 'react';
import { Send, Square, ChevronDown } from 'lucide-react';
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
  providers?: ProviderInfo[];
  selectedProvider?: string;
  selectedModel?: string;
  modelLocked?: boolean;
  onProviderChange?: (provider: string, model: string) => void;
}

const PROVIDER_COLORS: Record<string, string> = {
  codex: 'text-accent-green',
  'claude-cli': 'text-accent-blue',
  gemini: 'text-accent-yellow',
  'anthropic-api': 'text-accent-purple',
};

const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(
  { onSend, onCancel, streaming, disabled, providers, selectedProvider, selectedModel, modelLocked, onProviderChange },
  ref,
) {
  const [value, setValue] = useState('');
  const [mentionVisible, setMentionVisible] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [showModelPicker, setShowModelPicker] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

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
    if (!trimmed || streaming || disabled) return;
    onSend(trimmed); setValue(''); setMentionVisible(false);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }, [value, streaming, disabled, onSend]);

  const currentProvider = providers?.find(p => p.provider === selectedProvider);

  return (
    <div className="relative border-t border-border/50 bg-surface-50 p-3">
      <MentionAutocomplete query={mentionQuery} visible={mentionVisible} onSelect={handleMentionSelect} onDismiss={() => setMentionVisible(false)} />

      {/* Input container with model selector inside */}
      <div className="relative bg-surface-200/50 border border-border/30 rounded-lg focus-within:border-accent-blue/50 transition-colors">
        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="Message FlowForge..."
          disabled={streaming || disabled}
          rows={1}
          className="w-full resize-none bg-transparent px-3 pt-2.5 pb-10 text-sm text-white placeholder-gray-600 font-body focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
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
                    ? 'text-gray-700 cursor-default'
                    : 'text-gray-500 hover:text-gray-300 hover:bg-surface-100/50 cursor-pointer'
                }`}
              >
                <span className={PROVIDER_COLORS[selectedProvider ?? ''] ?? 'text-gray-500'}>
                  {currentProvider?.label ?? selectedProvider}
                </span>
                <span className="text-gray-700">/</span>
                <span>{selectedModel}</span>
                {!modelLocked && <ChevronDown className="w-2.5 h-2.5 text-gray-600 ml-0.5" />}
              </button>
            )}

            {/* Model picker dropdown — opens upward */}
            {showModelPicker && !modelLocked && (
              <div className="absolute bottom-full left-0 mb-1 z-30 bg-surface-100 border border-border/50 rounded-lg shadow-2xl overflow-hidden min-w-[220px]">
                {providers?.map(p => (
                  <div key={p.provider}>
                    <div className="px-3 py-1 bg-surface-200/30 border-b border-border/20">
                      <span className={`text-[10px] font-label uppercase tracking-widest ${PROVIDER_COLORS[p.provider] ?? 'text-gray-500'}`}>{p.label}</span>
                    </div>
                    {p.models.map(m => (
                      <button
                        key={`${p.provider}-${m}`}
                        onClick={() => { onProviderChange?.(p.provider, m); setShowModelPicker(false); }}
                        className={`w-full text-left px-3 py-1.5 text-xs font-mono hover:bg-surface-200/50 transition-colors ${
                          selectedProvider === p.provider && selectedModel === m ? 'text-accent-blue bg-accent-blue/5' : 'text-gray-400'
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

          {/* Hint */}
          <span className="text-[10px] text-gray-700 font-mono hidden sm:inline">shift+enter for new line</span>

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
