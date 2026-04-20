import { useState } from 'react';
import { ChevronDown, ChevronRight, CheckCircle, AlertCircle, Wrench } from 'lucide-react';

/** Matches packages/engine/src/tool-call.ts:ToolCallRecord shape. */
export interface ToolCall {
  tool: string;
  description?: string;
  args: Record<string, unknown>;
  result?: unknown;
  durationMs: number;
  startedAt: string | Date;
  isError?: boolean;
  truncated?: { args?: boolean; result?: boolean };
  toolUseId?: string;
}

function formatToolDuration(ms: number): string {
  if (!ms || ms <= 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

function previewJson(value: unknown, max = 1200): string {
  if (value === undefined) return '(no result)';
  if (value === null) return 'null';
  if (typeof value === 'string') return value.length > max ? value.slice(0, max) + '…' : value;
  try {
    const s = JSON.stringify(value, null, 2);
    return s.length > max ? s.slice(0, max) + '…' : s;
  } catch { return '[unserializable]'; }
}

export function ToolCallRow({ tc, index }: { tc: ToolCall; index: number }) {
  const [open, setOpen] = useState(false);
  const desc = tc.description || tc.tool;
  const ts = tc.startedAt ? new Date(tc.startedAt) : null;
  const tsLabel = ts
    ? ts.toLocaleTimeString([], { hour12: false }) + '.' + String(ts.getMilliseconds()).padStart(3, '0')
    : '';
  const hasArgs = tc.args && Object.keys(tc.args).length > 0;
  const hasResult = tc.result !== undefined;
  const isError = tc.isError === true;
  return (
    <div className={`px-4 py-2 border-b border-border/10 last:border-0 ${isError ? 'bg-accent-red/5' : ''}`}>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 text-left hover:bg-surface-200/30 -mx-1 px-1 py-0.5 rounded-sm transition-colors"
        title={open ? 'Collapse' : 'Expand'}
      >
        {open ? <ChevronDown className="w-3 h-3 shrink-0 text-theme-muted" /> : <ChevronRight className="w-3 h-3 shrink-0 text-theme-muted" />}
        <span className="text-[10px] font-mono text-theme-subtle w-6 shrink-0">#{index + 1}</span>
        {isError
          ? <AlertCircle className="w-3 h-3 shrink-0 text-accent-red" />
          : <CheckCircle className="w-3 h-3 shrink-0 text-accent-green/60" />}
        <span className="text-[11px] font-mono text-amber-400 shrink-0">{tc.tool}</span>
        <span className="text-[11px] text-theme-secondary truncate flex-1">{desc}</span>
        <span className="text-[10px] font-mono text-theme-subtle shrink-0">{formatToolDuration(tc.durationMs ?? 0)}</span>
        {tsLabel && <span className="text-[10px] font-mono text-theme-subtle shrink-0">{tsLabel}</span>}
      </button>
      {open && (
        <div className="mt-2 ml-6 space-y-2">
          {hasArgs && (
            <div>
              <div className="text-[9px] font-label uppercase tracking-wider text-theme-subtle mb-1">
                Input {tc.truncated?.args && <span className="text-accent-yellow">(truncated)</span>}
              </div>
              <pre className="text-[10px] font-mono text-theme-secondary whitespace-pre-wrap bg-surface-50/50 rounded-sm p-2 max-h-48 overflow-auto">{previewJson(tc.args)}</pre>
            </div>
          )}
          {hasResult && (
            <div>
              <div className="text-[9px] font-label uppercase tracking-wider text-theme-subtle mb-1">
                {isError ? 'Error' : 'Output'} {tc.truncated?.result && <span className="text-accent-yellow">(truncated)</span>}
              </div>
              <pre className={`text-[10px] font-mono whitespace-pre-wrap rounded-sm p-2 max-h-64 overflow-auto ${isError ? 'text-accent-red bg-accent-red/5' : 'text-theme-secondary bg-surface-50/50'}`}>{previewJson(tc.result)}</pre>
            </div>
          )}
          {!hasArgs && !hasResult && (
            <div className="text-[10px] text-theme-subtle italic">No input/output captured.</div>
          )}
        </div>
      )}
    </div>
  );
}

export function ToolCallLog({ calls, title = 'Tool Calls', emptyText = 'No tool calls yet.' }: {
  calls: ToolCall[];
  title?: string;
  emptyText?: string;
}) {
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border/20">
        <Wrench className="w-4 h-4 text-accent-yellow" />
        <span className="text-xs font-label uppercase tracking-widest text-theme-secondary">{title}</span>
        <span className="text-[10px] text-theme-subtle font-mono ml-auto">{calls.length}</span>
      </div>
      {calls.length === 0 ? (
        <div className="px-4 py-6 text-xs text-theme-subtle italic">{emptyText}</div>
      ) : (
        <div className="max-h-[60vh] overflow-y-auto">
          {calls.map((tc, i) => <ToolCallRow key={i} tc={tc} index={i} />)}
        </div>
      )}
    </div>
  );
}
