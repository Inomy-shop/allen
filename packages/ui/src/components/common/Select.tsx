import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';

interface Option {
  value: string;
  label: string;
  sublabel?: string;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  placeholder?: string;
  className?: string;
}

export default function Select({ value, onChange, options, placeholder = 'Select...', className = '' }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; dropUp: boolean }>({ top: 0, left: 0, width: 0, dropUp: false });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

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

  const selected = options.find(o => o.value === value);

  const handleOpen = () => {
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const dropUp = spaceBelow < 200;
      setPos({
        top: dropUp ? rect.top : rect.bottom + 4,
        left: rect.left,
        width: rect.width,
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
        onClick={handleOpen}
        className={`input w-full text-left flex items-center justify-between gap-2 cursor-pointer ${
          open ? 'border-accent-blue' : ''
        }`}
      >
        {selected ? (
          <span className="truncate text-theme-primary text-sm">{selected.label}</span>
        ) : (
          <span className="truncate text-theme-muted text-sm">{placeholder}</span>
        )}
        <ChevronDown className={`w-3.5 h-3.5 text-theme-muted shrink-0 transition-transform ${open ? 'rotate-180 text-accent-blue' : ''}`} />
      </button>

      {/* Dropdown — portaled to body, positioned fixed relative to viewport */}
      {open && createPortal(
        <div
          ref={dropdownRef}
          className="fixed z-[9999] bg-surface-100 border border-border rounded-sm shadow-lg max-h-60 overflow-auto"
          style={{
            top: pos.dropUp ? undefined : pos.top,
            bottom: pos.dropUp ? window.innerHeight - pos.top + 4 : undefined,
            left: pos.left,
            width: Math.max(pos.width, 200),
          }}
        >
          {options.map(opt => (
            <button
              key={opt.value}
              type="button"
              onClick={() => { onChange(opt.value); setOpen(false); }}
              className={`w-full text-left px-3 py-2 text-sm transition-colors cursor-pointer flex flex-col ${
                opt.value === value
                  ? 'bg-accent-blue/10 text-accent-blue'
                  : 'text-theme-secondary hover:bg-surface-200 hover:text-theme-primary'
              }`}
            >
              <span className="font-body truncate">{opt.label}</span>
              {opt.sublabel && (
                <span className="text-[10px] font-mono text-theme-muted truncate">{opt.sublabel}</span>
              )}
            </button>
          ))}
          {options.length === 0 && (
            <div className="px-3 py-3 text-xs text-theme-muted text-center font-mono">No options</div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
