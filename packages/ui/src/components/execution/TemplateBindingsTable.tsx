import { useState } from 'react';
import { ChevronDown, ChevronRight, Info } from 'lucide-react';

interface Binding {
  placeholder: string;
  resolved: unknown;
  status?: string;
}

interface Props {
  bindings: Binding[];
  defaultOpen?: boolean;
}

/**
 * Collapsible bindings table shared between NodeInspector (Inspector tab)
 * and the Prompt tab in NodeDetail. Renders each template placeholder with
 * its resolved value + status flags (missing / redacted).
 */
export default function TemplateBindingsTable({ bindings, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  if (!bindings || bindings.length === 0) return null;

  const missing = bindings.filter((b) => b.status === 'missing').length;
  return (
    <div className="border border-border/30 rounded-md bg-surface-100/40 overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 hover:bg-surface-200/40 text-left"
      >
        {open ? <ChevronDown className="w-3 h-3 text-theme-muted" /> : <ChevronRight className="w-3 h-3 text-theme-muted" />}
        <Info className="w-3 h-3 text-accent-blue" />
        <span className="font-label text-[10px] uppercase tracking-[0.15em] text-theme-secondary">
          Template bindings ({bindings.length})
        </span>
        {missing > 0 && (
          <span className="text-[10px] font-mono text-amber-400 ml-auto">⚠ {missing} missing</span>
        )}
      </button>
      {open && (
        <div className="border-t border-border/20 bg-surface-200/20 p-2 overflow-x-auto">
          <table className="w-full text-[11px] font-mono">
            <thead>
              <tr className="text-theme-muted">
                <th className="text-left py-1 pr-3 font-label uppercase tracking-[0.15em] text-[10px]">Placeholder</th>
                <th className="text-left py-1 font-label uppercase tracking-[0.15em] text-[10px]">Resolved</th>
              </tr>
            </thead>
            <tbody>
              {bindings.map((b, i) => (
                <tr key={i} className="border-t border-border/10 align-top">
                  <td className="py-1 pr-3 text-theme-secondary whitespace-nowrap">
                    {'{{'}{b.placeholder}{'}}'}
                  </td>
                  <td className="py-1 break-all">
                    {b.status === 'missing' ? (
                      <span className="text-amber-400">⚠ missing</span>
                    ) : b.status === 'redacted' ? (
                      <span className="text-theme-subtle">🔒 redacted</span>
                    ) : (
                      <span className="text-theme-secondary">{previewValue(b.resolved)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function previewValue(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'string') return v.length > 200 ? `"${v.slice(0, 200)}…"` : `"${v}"`;
  if (typeof v === 'object') {
    const s = JSON.stringify(v);
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  }
  return String(v);
}
