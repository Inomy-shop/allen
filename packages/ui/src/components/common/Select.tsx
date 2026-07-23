import { useState, useRef, useEffect, useId, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: string;
  sublabel?: string;
  disabled?: boolean;
  icon?: ReactNode;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  searchable?: boolean;
  allowCustomValue?: boolean;
  customValueLabel?: (query: string) => string;
  createCustomValue?: (query: string) => string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
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
  ariaLabel,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; dropUp: boolean }>({
    top: 0,
    left: 0,
    width: 0,
    dropUp: false,
  });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();

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
    window.addEventListener('resize', handler);
    return () => {
      window.removeEventListener('scroll', handler, true);
      window.removeEventListener('resize', handler);
    };
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

  const optionCount = filteredOptions.length + (showCustomOption ? 1 : 0);

  const moveActive = (direction: 1 | -1) => {
    if (optionCount === 0) return;
    setActiveIndex(current => {
      let next = current;
      for (let attempts = 0; attempts < optionCount; attempts += 1) {
        next = (next + direction + optionCount) % optionCount;
        if (next === filteredOptions.length || !filteredOptions[next]?.disabled) return next;
      }
      return current;
    });
  };

  const chooseActive = () => {
    if (activeIndex < 0) return;
    const option = filteredOptions[activeIndex];
    if (option && !option.disabled) {
      onChange(option.value);
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (showCustomOption && activeIndex === filteredOptions.length) {
      onChange(customValue);
      setOpen(false);
      triggerRef.current?.focus();
    }
  };

  const handleListKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      chooseActive();
    }
  };

  const handleOpen = () => {
    if (disabled) return;
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const margin = 8;
      const panelWidth = Math.min(rect.width, window.innerWidth - margin * 2);
      const spaceBelow = window.innerHeight - rect.bottom;
      const dropUp = spaceBelow < 300 && rect.top > spaceBelow;
      setPos({
        top: dropUp ? rect.top : rect.bottom + 6,
        left: clamp(rect.left, margin, window.innerWidth - panelWidth - margin),
        width: panelWidth,
        dropUp,
      });
    }
    if (!open) {
      const selectedIndex = filteredOptions.findIndex(option => option.value === value && !option.disabled);
      const firstEnabled = filteredOptions.findIndex(option => !option.disabled);
      setActiveIndex(selectedIndex >= 0 ? selectedIndex : firstEnabled);
    }
    setOpen(!open);
  };

  useEffect(() => {
    if (!open) return;
    setActiveIndex(filteredOptions.findIndex(option => !option.disabled));
  }, [query]);

  return (
    <div className={`select-control relative ${className}`}>
      {/* Trigger */}
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={handleOpen}
        onKeyDown={(event) => {
          if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            handleOpen();
          } else if (open) {
            handleListKeyDown(event);
          }
        }}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        className={`select-trigger flex h-[34px] w-full cursor-pointer items-center justify-between gap-2 rounded-[8px] border border-app-strong bg-app-card pl-3 pr-2.5 text-left text-[12.5px] outline-none transition-colors hover:border-app-strong disabled:cursor-not-allowed disabled:opacity-50 ${
          open ? 'border-accent shadow-[var(--focus-ring)]' : ''
        }`}
      >
        {selected ? (
          <span className="flex min-w-0 items-center gap-2 text-theme-primary">
            {selected.icon && (
              <span className="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
                {selected.icon}
              </span>
            )}
            <span className="min-w-0 truncate">{selected.label}</span>
          </span>
        ) : (
          <span className="min-w-0 truncate text-theme-subtle">{placeholder}</span>
        )}
        <ChevronDown aria-hidden="true" strokeWidth={1.8} className={`select-chevron h-3.5 w-3.5 shrink-0 text-theme-muted transition-transform ${open ? 'rotate-180 text-accent' : ''}`} />
      </button>

      {/* Dropdown — portaled to body, positioned fixed relative to viewport */}
      {open && createPortal(
        <div
          ref={dropdownRef}
          className="select-popover fixed z-[9999] overflow-hidden rounded-[8px] border border-app bg-app-card p-1 shadow-popover"
          style={{
            top: pos.dropUp ? undefined : pos.top,
            bottom: pos.dropUp ? window.innerHeight - pos.top + 6 : undefined,
            left: pos.left,
            width: pos.width,
          }}
        >
          {searchable && (
            <div className="select-search relative mb-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-theme-muted" />
              <input
                ref={searchRef}
                value={query}
                onChange={event => setQuery(event.target.value)}
                onKeyDown={handleListKeyDown}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                className="h-8 w-full rounded-[7px] border border-app-strong bg-app-card pl-8 pr-2.5 text-[12.5px] text-theme-primary outline-none transition-colors placeholder:text-theme-subtle focus:border-accent focus:shadow-[var(--focus-ring)]"
              />
            </div>
          )}
          <div id={listboxId} role="listbox" className="select-listbox max-h-[260px] overflow-y-auto">
            {filteredOptions.map((opt, index) => (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={opt.value === value}
                disabled={opt.disabled}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => {
                  if (opt.disabled) return;
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={`select-option flex min-h-8 w-full items-center gap-2 rounded-[6px] px-2.5 py-1.5 text-left text-[12.5px] transition-colors ${
                  opt.value === value
                    ? 'bg-accent-soft text-accent'
                    : activeIndex === index
                      ? 'bg-app-muted text-theme-primary'
                      : 'text-theme-secondary hover:bg-app-muted hover:text-theme-primary'
                } disabled:cursor-not-allowed disabled:opacity-45`}
              >
                {opt.icon && (
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
                    {opt.icon}
                  </span>
                )}
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
                role="option"
                aria-selected="false"
                onMouseEnter={() => setActiveIndex(filteredOptions.length)}
                onClick={() => {
                  onChange(customValue);
                  setOpen(false);
                }}
                className={`select-option flex min-h-8 w-full items-center gap-2 rounded-[6px] px-2.5 py-1.5 text-left text-[12.5px] transition-colors ${activeIndex === filteredOptions.length ? 'bg-app-muted text-theme-primary' : 'text-theme-secondary hover:bg-app-muted hover:text-theme-primary'}`}
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
