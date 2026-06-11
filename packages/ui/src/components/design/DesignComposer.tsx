import { useState, useRef } from 'react';
import { Play } from 'lucide-react';
import type { DesignRoutingDecision } from '../../services/designService';
import DesignRoutingSelector from './DesignRoutingSelector';

interface DesignComposerProps {
  onSubmit: (prompt: string, routingOverride?: string) => Promise<void>;
  disabled?: boolean;
  routingDecision?: DesignRoutingDecision | null;
  onRoutingOverrideChange?: (key: string) => void;
}

export default function DesignComposer({
  onSubmit,
  disabled,
  routingDecision,
  onRoutingOverrideChange,
}: DesignComposerProps) {
  const [prompt, setPrompt] = useState('');
  const [routingOverride, setRoutingOverride] = useState<string | undefined>(undefined);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  async function handleSubmit() {
    const trimmed = prompt.trim();
    if (!trimmed || disabled) return;
    await onSubmit(trimmed, routingOverride);
    setPrompt('');
    // Auto-resize reset
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void handleSubmit();
    }
  }

  function handleRoutingChange(key: string) {
    setRoutingOverride(key === 'auto' ? undefined : key);
    onRoutingOverrideChange?.(key);
  }

  // Auto-grow textarea
  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setPrompt(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }

  const canSubmit = prompt.trim().length > 0 && !disabled;

  return (
    <div className="space-y-2">
      {/* Routing decision */}
      {routingDecision !== undefined && (
        <div className="rounded-md border border-app bg-app-muted/50 px-3 py-2">
          <DesignRoutingSelector
            decision={routingDecision ?? null}
            onChange={handleRoutingChange}
            disabled={disabled}
          />
        </div>
      )}

      {/* Prompt input + send */}
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder="Describe what you want to design or update…"
          rows={2}
          aria-label="Design prompt"
          className="flex-1 resize-none rounded-md border border-app bg-app px-3 py-2 text-[13px] text-theme-primary outline-none transition-colors placeholder:text-theme-subtle focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
          style={{ minHeight: 64 }}
        />
        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={!canSubmit}
          aria-label="Run design"
          title="Run (⌘↵)"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-accent/30 bg-accent-soft text-accent transition-colors hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Play className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
