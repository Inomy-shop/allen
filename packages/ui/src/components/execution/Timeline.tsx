import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ExecutionLog } from '../../hooks/useExecution';
import Select from '../common/Select';
import { Search, ArrowDown, ExternalLink, ChevronDown, ChevronRight } from 'lucide-react';
import type { ToolCall } from '../common/ToolCallLog';

function formatToolDuration(ms?: number): string {
  if (!ms || ms <= 0) return '';
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

const categoryColors: Record<string, string> = {
  system: 'text-theme-secondary bg-app-muted',
  agent: 'text-accent-blue bg-accent-blue/10',
  tool: 'text-accent-cyan bg-accent-cyan/10',
  condition: 'text-accent-yellow bg-accent-yellow/10',
  routing: 'text-accent-purple bg-accent-purple/10',
  gate: 'text-accent-orange bg-accent-orange/10',
};

function formatTime(d: Date) {
  return d.toLocaleString('en-US', {
    month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
}

function truncateNodeLabel(value: string, maxLength = 15): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

interface TimelineProps {
  logs: ExecutionLog[];
  nodeFilter: string | null;
  onNodeFilterChange: (node: string | null) => void;
  workflowNodes: string[];
  hasOlderLogs?: boolean;
  loadingOlderLogs?: boolean;
  onLoadOlderLogs?: () => Promise<void> | void;
  /** Persisted per-node traces. When provided, tool rows in the log become
   *  expandable and show the full args + result from the matching
   *  ToolCallRecord. Matched by toolUseId (exact) or tool+timestamp (±5s
   *  fallback). */
  traces?: any[];
}

export default function Timeline({
  logs,
  nodeFilter,
  onNodeFilterChange,
  workflowNodes,
  hasOlderLogs = false,
  loadingOlderLogs = false,
  onLoadOlderLogs,
  traces = [],
}: TimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [showSpawnLogs, setShowSpawnLogs] = useState(true);
  const [openRows, setOpenRows] = useState<Set<string>>(() => new Set());
  const autoScrollRef = useRef(true);
  const isUserScrolling = useRef(false);
  const loadOlderInFlight = useRef(false);
  const prependAnchor = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);

  // Build a tool-call lookup from every trace's toolCalls array so log rows
  // can resolve to their full input/output record on expand.
  const toolCallIndex = useMemo(() => {
    const byUseId = new Map<string, ToolCall>();
    const byTool = new Map<string, ToolCall[]>();
    for (const t of traces) {
      const tcs = (t?.toolCalls ?? []) as ToolCall[];
      for (const tc of tcs) {
        if (tc.toolUseId) byUseId.set(tc.toolUseId, tc);
        const arr = byTool.get(tc.tool) ?? [];
        arr.push(tc);
        byTool.set(tc.tool, arr);
      }
    }
    return { byUseId, byTool };
  }, [traces]);

  const resolveTool = (log: ExecutionLog): ToolCall | undefined => {
    const data = (log.data as Record<string, unknown> | undefined) ?? {};
    const toolUseId = (data.toolUseId as string | undefined) ?? undefined;
    const toolName = (data.tool as string | undefined) ?? undefined;
    if (toolUseId && toolCallIndex.byUseId.has(toolUseId)) return toolCallIndex.byUseId.get(toolUseId);
    if (toolName) {
      const candidates = toolCallIndex.byTool.get(toolName) ?? [];
      if (candidates.length === 0) return undefined;
      const logTs = new Date(log.timestamp).getTime();
      let best: ToolCall | undefined; let bestDelta = Infinity;
      for (const c of candidates) {
        const d = Math.abs(new Date(c.startedAt).getTime() - logTs);
        if (d < bestDelta) { best = c; bestDelta = d; }
      }
      return bestDelta <= 5000 ? best : undefined;
    }
    return undefined;
  };

  // Detect whether a log row comes from a spawned agent (Phase 3 fan-out).
  // Both fields are populated by chat-tools.ts liveLog when fan-out is
  // enabled, and by the /logs endpoint's normalization pass for descendant
  // rows pulled via the union query.
  const isChildLog = (l: ExecutionLog): boolean =>
    !!(l.data && typeof l.data === 'object' && (l.data as any).childExecutionId);

  // Auto-scroll to bottom when new logs arrive — only if user hasn't scrolled up
  useEffect(() => {
    if (autoScrollRef.current && !isUserScrolling.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs.length]);

  useLayoutEffect(() => {
    const anchor = prependAnchor.current;
    const el = containerRef.current;
    if (!anchor || !el) return;
    const delta = el.scrollHeight - anchor.scrollHeight;
    el.scrollTop = anchor.scrollTop + Math.max(0, delta);
    prependAnchor.current = null;
  }, [logs.length]);

  // Detect if user scrolled away from bottom
  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    isUserScrolling.current = !atBottom;
    autoScrollRef.current = atBottom;
    setAutoScroll(atBottom);

    if (
      el.scrollTop < 80
      && hasOlderLogs
      && !loadingOlderLogs
      && !loadOlderInFlight.current
      && onLoadOlderLogs
    ) {
      loadOlderInFlight.current = true;
      prependAnchor.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
      Promise.resolve(onLoadOlderLogs()).finally(() => {
        loadOlderInFlight.current = false;
        requestAnimationFrame(() => {
          if (prependAnchor.current) prependAnchor.current = null;
        });
      });
    }
  };

  const filterOptions = [
    { value: '__all__', label: 'All nodes' },
    ...workflowNodes.map(n => ({ value: n, label: n })),
  ];

  const filtered = logs.filter(log => {
    if (nodeFilter && log.node !== nodeFilter) return false;
    if (search && !log.message.toLowerCase().includes(search.toLowerCase())) return false;
    if (!showSpawnLogs && isChildLog(log)) return false;
    return true;
  });

  const spawnLogCount = logs.filter(isChildLog).length;

  const logKey = (log: ExecutionLog): string => {
    if (log._id) return log._id;
    const timestamp = log.timestamp instanceof Date
      ? log.timestamp.getTime()
      : new Date(log.timestamp).getTime();
    const data = log.data && typeof log.data === 'object'
      ? log.data as Record<string, unknown>
      : {};
    return `${log.executionId}|${timestamp}|${log.category}|${log.node ?? ''}|${data.tool ?? ''}|${data.toolUseId ?? ''}|${log.message}`;
  };

  return (
    <div className="flex flex-col h-full relative">
      {/* Header with filter and search */}
      <div className="border-b border-app bg-surface-50 px-4 py-3 sticky top-0 z-10">
        <div className="flex flex-wrap items-center gap-3">
          <Select
            value={nodeFilter ?? '__all__'}
            onChange={(v) => onNodeFilterChange(v === '__all__' ? null : v)}
            options={filterOptions}
            placeholder="Filter by node"
            className="w-[288px]"
          />
          <label className="relative min-w-[300px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-theme-muted" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search logs..."
              className="h-9 w-full rounded-md border border-app bg-app px-8 text-[13px] text-theme-primary outline-none transition-colors placeholder:text-theme-subtle focus:border-accent focus:shadow-[var(--focus-ring)]"
            />
          </label>
          {/* Spawned-agent log toggle. Only shown when there's at least one
              child log in the current set so we don't clutter the header
              for non-spawn workflows. */}
          {spawnLogCount > 0 && (
            <label
              className="flex items-center gap-1 text-[10px] font-mono text-theme-muted hover:text-theme-primary cursor-pointer shrink-0"
              title={`${spawnLogCount} log line${spawnLogCount === 1 ? '' : 's'} from spawned agents`}
            >
              <input
                type="checkbox"
                checked={showSpawnLogs}
                onChange={e => setShowSpawnLogs(e.target.checked)}
                className="w-3 h-3 accent-accent-purple"
              />
              Spawn ({spawnLogCount})
            </label>
          )}
        </div>
      </div>

      {/* Log entries */}
      <div
        ref={containerRef}
        data-testid="execution-log-scroll"
        className="flex-1 overflow-auto"
        onScroll={handleScroll}
        onWheel={(event) => {
          if (event.deltaY >= 0) return;
          // Disable follow mode before the next log-render effect can run.
          // Waiting for the scroll event leaves a race where a live refresh
          // can move the viewport while the user is actively scrolling.
          isUserScrolling.current = true;
          autoScrollRef.current = false;
          setAutoScroll(false);
        }}
      >
        {filtered.length === 0 ? (
          <div className="p-4 text-sm text-theme-muted font-mono">
            {logs.length === 0 ? 'WAITING FOR LOGS...' : 'NO MATCHING LOGS'}
          </div>
        ) : (
          <>
          {(hasOlderLogs || loadingOlderLogs) && (
            <div className="px-3 py-1.5 text-center font-mono text-[10px] text-theme-muted">
              {loadingOlderLogs ? 'Loading older logs...' : 'Scroll up for older logs'}
            </div>
          )}
          {/* Rows can wrap and tool details can expand, so their heights are
              intentionally left to normal layout. The log API pages history
              in 250-row chunks; fixed-height virtualization made its spacer
              estimates diverge from the DOM and caused the viewport to jump. */}
          {filtered.map((log) => {
            const isError = log.level === 'error';
            const catClass = isError ? 'text-accent-red bg-accent-red/10' : (categoryColors[log.category] ?? 'text-theme-secondary bg-app-muted');
            const child = isChildLog(log) ? (log.data as {
              childExecutionId: string;
              childAgentName: string;
              childParentCaller: string | null;
              childDepth: number;
            }) : null;
            // Tool rows: expandable with full input/output panel.
            const isToolRow = log.category === 'tool';
            const rowKey = logKey(log);
            const isOpen = openRows.has(rowKey);
            const toolCall = isToolRow ? resolveTool(log) : undefined;
            const logData = (log.data as Record<string, unknown> | undefined) ?? {};
            const logArgs = (logData.args as Record<string, unknown> | undefined) ?? undefined;
            const logCmd = logData.command as string | undefined;
            const nodeLabel = child
              ? `${log.node ?? child.childParentCaller ?? 'node'}:${child.childAgentName}`
              : (log.node ?? '');

            const toggle = () => {
              setOpenRows(prev => {
                const next = new Set(prev);
                if (next.has(rowKey)) next.delete(rowKey); else next.add(rowKey);
                return next;
              });
            };

            return (
              <div key={rowKey} className={`${isError ? 'bg-accent-red/5' : ''} ${child ? 'bg-accent-purple/[0.03]' : ''}`}>
                <div
                  className={`grid grid-cols-[14px_112px_58px_126px_minmax(0,1fr)] items-start gap-x-2 gap-y-1 px-2 py-0.5 hover:bg-accent-blue/5 text-xs transition-colors ${isToolRow ? 'cursor-pointer' : ''}`}
                  onClick={isToolRow ? toggle : undefined}
                >
                  {/* Chevron column — only shown for expandable tool rows */}
                  {isToolRow ? (
                    isOpen
                      ? <ChevronDown className="w-3 h-3 mt-1 text-theme-muted shrink-0" />
                      : <ChevronRight className="w-3 h-3 mt-1 text-theme-muted shrink-0" />
                  ) : <span className="w-3 shrink-0" />}

                  {/* Timestamp */}
                  <span
                    className="text-[10px] text-theme-muted font-mono mt-px tabular-nums"
                    title={new Date(log.timestamp).toLocaleString()}
                  >
                    {formatTime(new Date(log.timestamp))}
                  </span>

                  {/* Category badge */}
                  <span className={`text-[9px] font-mono uppercase px-1 py-px rounded text-center ${catClass}`}>
                    {log.category}
                  </span>

                  {/* Node / spawned-agent badge */}
                  {child ? (
                    <Link
                      to={`/executions/${child.childExecutionId}`}
                      onClick={e => e.stopPropagation()}
                      className="inline-flex min-w-0 items-center gap-0.5 truncate text-[10px] font-mono text-accent-purple transition-colors hover:text-accent-purple/80"
                      title={`${log.node ?? child.childParentCaller ?? 'node'}:${child.childAgentName} — spawned by ${child.childParentCaller ?? 'unknown'}`}
                    >
                      <span className="truncate">{truncateNodeLabel(nodeLabel)}</span>
                      <ExternalLink className="w-2.5 h-2.5 shrink-0 opacity-60" />
                    </Link>
                  ) : log.node ? (
                    <span
                      className="truncate text-[10px] font-mono text-accent-blue/60"
                      title={log.node}
                    >
                      {truncateNodeLabel(nodeLabel)}
                    </span>
                  ) : (
                    <span />
                  )}

                  {/* Message */}
                  <span className={`font-mono text-theme-secondary min-w-0 break-words ${isError ? 'text-accent-red' : ''}`}>
                    {log.message}
                    {toolCall?.durationMs ? (
                      <span className="text-[10px] text-theme-subtle ml-2">({formatToolDuration(toolCall.durationMs)})</span>
                    ) : null}
                  </span>
                </div>

                {/* Expanded panel for tool rows — input + output from the
                    matching ToolCallRecord, falling back to what the log
                    itself carries. */}
                {isToolRow && isOpen && (
                  <div className="space-y-1.5 bg-app-muted/40 py-1.5 pl-[328px] pr-3">
                    {(() => {
                      const argsObj = toolCall?.args ?? logArgs;
                      if (argsObj && Object.keys(argsObj).length > 0) {
                        return (
                          <div>
                            <div className="overline mb-0.5">
                              Input{toolCall?.truncated?.args && <span className="text-accent-yellow ml-1">(truncated)</span>}
                            </div>
                            <pre className="text-[10px] font-mono text-theme-secondary whitespace-pre-wrap bg-app-card/50 rounded-sm p-2 max-h-48 overflow-auto">{previewJson(argsObj)}</pre>
                          </div>
                        );
                      }
                      if (logCmd) {
                        return (
                          <div>
                            <div className="overline mb-0.5">Command</div>
                            <pre className="text-[10px] font-mono text-theme-secondary whitespace-pre-wrap bg-app-card/50 rounded-sm p-2 max-h-48 overflow-auto">$ {logCmd}</pre>
                          </div>
                        );
                      }
                      return null;
                    })()}
                    {toolCall?.result !== undefined ? (
                      <div>
                        <div className="overline mb-0.5">
                          {toolCall.isError ? 'Error' : 'Output'}{toolCall.truncated?.result && <span className="text-accent-yellow ml-1">(truncated)</span>}
                        </div>
                        <pre className={`text-[10px] font-mono whitespace-pre-wrap rounded-sm p-2 max-h-64 overflow-auto ${toolCall.isError ? 'text-accent-red bg-accent-red/5' : 'text-theme-secondary bg-app-card/50'}`}>{previewJson(toolCall.result)}</pre>
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}
          </>
        )}
      </div>

      {/* Scroll to bottom button — shown when user scrolled up */}
      {!autoScroll && logs.length > 0 && (
        <button
          title="Scroll to latest"
          onClick={() => {
            isUserScrolling.current = false;
            autoScrollRef.current = true;
            setAutoScroll(true);
            if (containerRef.current) {
              containerRef.current.scrollTop = containerRef.current.scrollHeight;
            }
          }}
          className="absolute bottom-2 right-2 z-10 btn-primary text-[10px] px-2 py-1 inline-flex items-center gap-1 shadow-lg"
        >
          <ArrowDown className="w-3 h-3" /> Latest
        </button>
      )}
    </div>
  );
}
