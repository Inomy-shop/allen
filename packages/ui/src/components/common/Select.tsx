import { useState, useRef, useEffect } from 'react';
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
  const [dropUp, setDropUp] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
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

  const selected = options.find(o => o.value === value);

  const handleOpen = () => {
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      setDropUp(spaceBelow < 250);
    }
    setOpen(!open);
  };

  return (
    <div ref={ref} className={`relative ${className}`}>
      {/* Trigger */}
      <button
        ref={triggerRef}
        type="button"
        onClick={handleOpen}
        className={`input w-full text-left flex items-center justify-between gap-2 cursor-pointer ${
          open ? 'border-accent-blue shadow-glow-blue' : ''
        }`}
      >
        {selected ? (
          <span className="truncate text-gray-100 text-sm">{selected.label}</span>
        ) : (
          <span className="truncate text-gray-500 text-sm">{placeholder}</span>
        )}
        <ChevronDown className={`w-3.5 h-3.5 text-gray-500 shrink-0 transition-transform ${open ? 'rotate-180 text-accent-blue' : ''}`} />
      </button>

      {/* Dropdown — auto-flips above if no space below */}
      {open && (
        <div className={`absolute z-50 left-0 right-0 bg-surface-100 border border-border rounded-sm shadow-lg max-h-60 overflow-auto ${
          dropUp ? 'bottom-full mb-1' : 'top-full mt-1'
        }`}>
          {options.map(opt => (
            <button
              key={opt.value}
              type="button"
              onClick={() => { onChange(opt.value); setOpen(false); }}
              className={`w-full text-left px-3 py-2 text-sm transition-colors cursor-pointer flex flex-col ${
                opt.value === value
                  ? 'bg-accent-blue/10 text-accent-blue'
                  : 'text-gray-300 hover:bg-surface-200 hover:text-white'
              }`}
            >
              <span className="font-body truncate">{opt.label}</span>
              {opt.sublabel && (
                <span className="text-[10px] font-mono text-gray-500 truncate">{opt.sublabel}</span>
              )}
            </button>
          ))}
          {options.length === 0 && (
            <div className="px-3 py-3 text-xs text-gray-500 text-center font-mono">No options</div>
          )}
        </div>
      )}
    </div>
  );
}
