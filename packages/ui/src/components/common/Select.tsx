import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search } from 'lucide-react';

interface Option {
  value: string;
  label: string;
  sublabel?: string;
  disabled?: boolean;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  placeholder?: string;
  searchPlaceholder?: string;
  searchable?: boolean;
  allowCustomValue?: boolean;
  customValueLabel?: (query: string) => string;
  createCustomValue?: (query: string) => string;
  disabled?: boolean;
  className?: string;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

export default function Select({
  value,
  onChange,
  options,
  placeholder = 'Select...',
  searchPlaceholder = 'Search...',
  searchable = true,
  allowCustomValue = false,
  customValueLabel,
  createCustomValue,
  disabled = false,
  className = '',
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [pos, setPos] = useState<{ top: number; left: number; width: number; dropUp: boolean }>({
    top: 0,
    left: 0,
    width: 0,
    dropUp: false,
  });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        triggerRef.current?.contains(e.target as Node) ||
        dropdownRef.current?.contains(e.target as Node)
      ) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close on escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  // Close on scroll from OUTSIDE the dropdown (not from scrolling inside it)
  useEffect(() => {
    if (!open) return;
    const handler = (e: Event) => {
      if (dropdownRef.current?.contains(e.target as Node)) return; // scrolling inside dropdown — ignore
      setOpen(false);
    };
    window.addEventListener('scroll', handler, true);
    return () => window.removeEventListener('scroll', handler, true);
  }, [open]);

  useEffect(() => {
    if (open) {
      if (searchable) setTimeout(() => searchRef.current?.focus(), 20);
    } else {
      setQuery('');
    }
  }, [open, searchable]);

  const selected = options.find(o => o.value === value)
    ?? (allowCustomValue && value ? { value, label: value } : undefined);
  const filteredOptions = options.filter(option => {
    if (!searchable) return true;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return `${option.label} ${option.sublabel ?? ''}`.toLowerCase().includes(q);
  });
  const customQuery = query.trim();
  const customValue = customQuery ? (createCustomValue ? createCustomValue(customQuery) : customQuery) : '';
  const showCustomOption = allowCustomValue
    && searchable
    && Boolean(customQuery)
    && !options.some(option => option.value === customValue || option.label.toLowerCase() === customQuery.toLowerCase());

  const handleOpen = () => {
    if (disabled) return;
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const margin = 12;
      const panelWidth = Math.max(rect.width, 240);
      const spaceBelow = window.innerHeight - rect.bottom;
      const dropUp = spaceBelow < 300 && rect.top > spaceBelow;
      setPos({
        top: dropUp ? rect.top : rect.bottom + 4,
        left: clamp(rect.left, margin, window.innerWidth - panelWidth - margin),
        width: panelWidth,
        dropUp,
      });
    }
    setOpen(!open);
  };

  return (
    <div className={`relative ${className}`}>
      {/* Trigger */}
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={handleOpen}
        className={`flex h-9 w-full cursor-pointer items-center justify-between gap-2 rounded-md border border-app bg-app-muted px-3 text-left text-[13px] outline-none transition-colors hover:border-app-strong disabled:cursor-not-allowed disabled:opacity-50 ${
          open ? 'border-accent shadow-[var(--focus-ring)]' : ''
        }`}
      >
        {selected ? (
          <span className="min-w-0 truncate text-theme-primary">{selected.label}</span>
        ) : (
          <span className="min-w-0 truncate text-theme-subtle">{placeholder}</span>
        )}
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-theme-muted transition-transform ${open ? 'rotate-180 text-accent' : ''}`} />
      </button>

      {/* Dropdown — portaled to body, positioned fixed relative to viewport */}
      {open && createPortal(
        <div
          ref={dropdownRef}
          className="fixed z-[9999] overflow-hidden rounded-md border border-app bg-app-card p-2 shadow-2xl"
          style={{
            top: pos.dropUp ? undefined : pos.top,
            bottom: pos.dropUp ? window.innerHeight - pos.top + 4 : undefined,
            left: pos.left,
            width: pos.width,
          }}
        >
          {searchable && (
            <div className="relative mb-2">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-theme-muted" />
              <input
                ref={searchRef}
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder={searchPlaceholder}
                className="h-9 w-full rounded-md border border-app bg-app px-8 text-[13px] text-theme-primary outline-none transition-colors placeholder:text-theme-subtle focus:border-accent focus:shadow-[var(--focus-ring)]"
              />
            </div>
          )}
          <div className="max-h-[260px] overflow-y-auto">
            {filteredOptions.map(opt => (
              <button
                key={opt.value}
                type="button"
                disabled={opt.disabled}
                onClick={() => {
                  if (opt.disabled) return;
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={`flex min-h-10 w-full items-center gap-2 rounded-md px-3 py-2 text-left text-[13px] transition-colors ${
                  opt.value === value
                    ? 'bg-app-muted text-theme-primary'
                    : 'text-theme-secondary hover:bg-app-muted hover:text-theme-primary'
                } disabled:cursor-not-allowed disabled:opacity-45`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{opt.label}</span>
                  {opt.sublabel && (
                    <span className="block truncate font-mono text-[10.5px] text-theme-muted">{opt.sublabel}</span>
                  )}
                </span>
                {opt.value === value && <Check className="h-3.5 w-3.5 shrink-0 text-accent" />}
              </button>
            ))}
            {showCustomOption && (
              <button
                type="button"
                onClick={() => {
                  onChange(customValue);
                  setOpen(false);
                }}
                className="flex min-h-10 w-full items-center gap-2 rounded-md px-3 py-2 text-left text-[13px] text-theme-secondary transition-colors hover:bg-app-muted hover:text-theme-primary"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{customValueLabel ? customValueLabel(customQuery) : `Use "${customQuery}"`}</span>
                  <span className="block truncate font-mono text-[10.5px] text-theme-muted">Custom model ID</span>
                </span>
              </button>
            )}
            {filteredOptions.length === 0 && !showCustomOption && (
              <div className="px-3 py-6 text-center font-mono text-[11px] text-theme-muted">
                {query ? `No matches for "${query}".` : 'No options'}
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
