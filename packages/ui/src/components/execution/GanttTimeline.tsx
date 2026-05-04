import { useMemo } from 'react';

interface Trace {
  node: string;
  startedAt: string | Date;
  durationMs?: number;
  status: string;
  attempt?: number;
}

interface Props {
  traces: Trace[];
  onNodeClick?: (node: string) => void;
}

/**
 * Gantt-style timeline of node executions. Three-column layout:
 *   [ node name (truncated) ] [ bar area (fills) ] [ duration ]
 *
 * The bar area uses relative positioning — bars are scaled to durationMs
 * and offset from the earliest startedAt. This avoids horizontal scroll
 * regardless of node-name length or run duration.
 */
export default function GanttTimeline({ traces, onNodeClick }: Props) {
  const { rows, totalMs, tickPositions } = useMemo(() => {
    if (traces.length === 0) return { rows: [], totalMs: 0, tickPositions: [] as number[] };
    const starts = traces.map((t) => new Date(t.startedAt).getTime());
    const minStart = Math.min(...starts);
    const ends = traces.map((t, i) => starts[i] + (t.durationMs ?? 0));
    const maxEnd = Math.max(...ends);
    const total = Math.max(1, maxEnd - minStart);

    const rows = traces
      .map((t, i) => ({
        key: `${t.node}-${t.attempt ?? 1}-${i}`,
        node: t.node,
        status: t.status,
        attempt: t.attempt ?? 1,
        startOffset: ((starts[i] - minStart) / total) * 100,
        widthPct: Math.max(0.5, ((t.durationMs ?? 0) / total) * 100),
        durationMs: t.durationMs ?? 0,
      }))
      .sort((a, b) => a.startOffset - b.startOffset);

    // Tick positions: 5 evenly-spaced markers along the bar area.
    const tickPositions = [0, 25, 50, 75, 100];

    return { rows, totalMs: total, tickPositions };
  }, [traces]);

  if (traces.length === 0) {
    return (
      <div className="border border-dashed border-app rounded-md p-5 text-center">
        <div className="text-xs text-theme-muted font-body">No timeline data yet.</div>
        <div className="text-[11px] text-theme-subtle font-body mt-1">
          A bar appears per node attempt as the workflow runs.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Intro */}
      <div className="text-[11px] text-theme-muted font-body">
        Each bar is one node attempt, positioned by when it started and sized by how long it ran.
        Bars overlapping in time mean those nodes ran in parallel.
      </div>

      {/* Axis labels above the chart */}
      <div className="grid grid-cols-[140px_1fr_60px] gap-2 text-[10px] font-mono text-theme-subtle px-1">
        <div className="text-left">Node</div>
        <div className="relative">
          {tickPositions.map((p) => (
            <span
              key={p}
              className="absolute top-0 transform -translate-x-1/2"
              style={{ left: `${p}%` }}
            >
              {formatTick((p / 100) * totalMs)}
            </span>
          ))}
        </div>
        <div className="text-right">Duration</div>
      </div>

      {/* Rows */}
      <div className="space-y-1">
        {rows.map((r) => (
          <button
            key={r.key}
            onClick={() => onNodeClick?.(r.node)}
            className="w-full grid grid-cols-[140px_1fr_60px] gap-2 items-center py-1 px-1 rounded-sm hover:bg-app-muted transition-colors text-left"
            title={`${r.node} (attempt ${r.attempt}) — ${formatDuration(r.durationMs)}`}
          >
            {/* Node name, truncated */}
            <div className="flex items-center gap-1.5 min-w-0">
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDot(r.status)}`}
                aria-hidden
              />
              <span className="text-[11px] font-mono text-theme-primary truncate">
                {r.node}
              </span>
              {r.attempt > 1 && (
                <span className="text-[9px] font-mono text-accent-yellow shrink-0">#{r.attempt}</span>
              )}
            </div>

            {/* Bar lane — relative positioning within a fixed-width lane */}
            <div className="relative h-3 bg-app-muted/50 rounded-sm overflow-hidden">
              {/* vertical tick guides */}
              {tickPositions.map((p) => (
                <span
                  key={p}
                  className="absolute top-0 bottom-0 w-px bg-border/20"
                  style={{ left: `${p}%` }}
                  aria-hidden
                />
              ))}
              <div
                className={`absolute top-0 bottom-0 rounded-sm ${statusBg(r.status)}`}
                style={{
                  left: `${r.startOffset}%`,
                  width: `${r.widthPct}%`,
                  minWidth: '2px',
                }}
              />
            </div>

            {/* Duration */}
            <div className="text-[10px] font-mono text-theme-secondary tabular-nums text-right">
              {formatDuration(r.durationMs)}
            </div>
          </button>
        ))}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-3 pt-2 border-t border-app text-[10px] font-mono text-theme-subtle">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-sm bg-accent-green/60" /> completed
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-sm bg-red-500/60" /> failed
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-sm bg-accent-blue/60" /> running
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-sm bg-theme-subtle/40" /> skipped
        </span>
        <span className="ml-auto">total {formatDuration(totalMs)}</span>
      </div>
    </div>
  );
}

function statusDot(status: string): string {
  switch (status) {
    case 'completed': return 'bg-accent-green';
    case 'failed':    return 'bg-red-500';
    case 'skipped':   return 'bg-theme-subtle';
    case 'running':   return 'bg-accent-blue animate-pulse';
    default:          return 'bg-accent-blue';
  }
}

function statusBg(status: string): string {
  switch (status) {
    case 'completed': return 'bg-accent-green/60';
    case 'failed':    return 'bg-red-500/60';
    case 'skipped':   return 'bg-theme-subtle/40';
    case 'running':   return 'bg-accent-blue/60';
    default:          return 'bg-accent-blue/40';
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

function formatTick(ms: number): string {
  if (ms === 0) return '0s';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s ? s + 's' : ''}`;
}
