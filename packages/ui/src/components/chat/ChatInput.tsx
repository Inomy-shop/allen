import { useState, useRef, useCallback, useEffect, forwardRef, useImperativeHandle } from 'react';
import { Send, Square } from 'lucide-react';
import MentionAutocomplete, { type MentionOption } from './MentionAutocomplete';

export interface ChatInputHandle {
  setValue: (v: string) => void;
  focus: () => void;
}

interface ChatInputProps {
  onSend: (content: string) => void;
  onCancel?: () => void;
  streaming: boolean;
  disabled?: boolean;
}

const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(
  { onSend, onCancel, streaming, disabled },
  ref,
) {
  const [value, setValue] = useState('');
  const [mentionVisible, setMentionVisible] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Expose setValue and focus to parent via ref
  useImperativeHandle(ref, () => ({
    setValue: (v: string) => {
      setValue(v);
      // Move cursor to end after setting
      setTimeout(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.selectionStart = v.length;
          el.selectionEnd = v.length;
        }
      }, 0);
    },
    focus: () => textareaRef.current?.focus(),
  }));

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }, [value]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value;
    setValue(text);

    // Detect @ mention
    const cursorPos = e.target.selectionStart;
    const textBeforeCursor = text.slice(0, cursorPos);
    const lastAt = textBeforeCursor.lastIndexOf('@');

    if (lastAt !== -1) {
      const afterAt = textBeforeCursor.slice(lastAt + 1);
      const charBefore = lastAt > 0 ? textBeforeCursor[lastAt - 1] : ' ';
      if ((charBefore === ' ' || charBefore === '\n' || lastAt === 0) && !afterAt.includes(' ')) {
        setMentionVisible(true);
        setMentionQuery(afterAt);
        return;
      }
    }
    setMentionVisible(false);
    setMentionQuery('');
  }, []);

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

    setTimeout(() => {
      if (el) {
        const newPos = lastAt + option.name.length + 2;
        el.focus();
        el.selectionStart = newPos;
        el.selectionEnd = newPos;
      }
    }, 0);
  }, [value]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (mentionVisible) {
        if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
          return;
        }
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [mentionVisible, value, streaming, disabled],
  );

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || streaming || disabled) return;
    onSend(trimmed);
    setValue('');
    setMentionVisible(false);

    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [value, streaming, disabled, onSend]);

  return (
    <div className="relative border-t border-border/50 bg-surface-50 p-3">
      <MentionAutocomplete
        query={mentionQuery}
        visible={mentionVisible}
        onSelect={handleMentionSelect}
        onDismiss={() => setMentionVisible(false)}
      />
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="Message FlowForge... (⌘K for commands, @ for mentions)"
          disabled={streaming || disabled}
          rows={1}
          className="flex-1 resize-none bg-surface-200/50 border border-border/30 rounded-sm px-3 py-2 text-sm text-white placeholder-gray-600 font-body focus:outline-none focus:border-accent-blue/50 disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ minHeight: '38px', maxHeight: '160px' }}
        />
        {streaming ? (
          <button
            onClick={onCancel}
            className="shrink-0 w-9 h-9 flex items-center justify-center rounded-sm bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
            title="Stop generating"
          >
            <Square className="w-4 h-4" />
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!value.trim() || disabled}
            className="shrink-0 w-9 h-9 flex items-center justify-center rounded-sm bg-accent-blue/20 text-accent-blue hover:bg-accent-blue/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            title="Send message"
          >
            <Send className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
});

export default ChatInput;
