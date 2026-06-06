import { useEffect, useState } from 'react';

interface Props {
  value: Record<string, unknown> | undefined;
  onChange: (next: Record<string, unknown> | undefined) => void;
  placeholder?: string;
}

/**
 * Editor for an object-valued node field (`config`, `fallback_value`). Holds
 * the raw text locally so a user can type partial/invalid JSON without it
 * being clobbered; the parsed value is only pushed up when it parses to an
 * object. Empty text clears the field (emits undefined).
 */
export default function JsonField({ value, onChange, placeholder }: Props) {
  const [text, setText] = useState(() => (value ? JSON.stringify(value, null, 2) : ''));
  const [error, setError] = useState<string | null>(null);

  // Re-seed when a different node is selected (value identity changes).
  useEffect(() => {
    setText(value ? JSON.stringify(value, null, 2) : '');
    setError(null);
  }, [value]);

  const handle = (raw: string) => {
    setText(raw);
    if (raw.trim() === '') {
      setError(null);
      onChange(undefined);
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        setError(null);
        onChange(parsed as Record<string, unknown>);
      } else {
        setError('Must be a JSON object');
      }
    } catch {
      setError('Invalid JSON');
    }
  };

  return (
    <div>
      <textarea
        className={`input w-full text-xs h-20 resize-none font-mono ${error ? 'border-accent-red' : ''}`}
        value={text}
        onChange={e => handle(e.target.value)}
        placeholder={placeholder ?? '{ "key": "value" }'}
        spellCheck={false}
      />
      {error && <p className="text-[10px] text-accent-red font-mono mt-0.5">{error}</p>}
    </div>
  );
}
