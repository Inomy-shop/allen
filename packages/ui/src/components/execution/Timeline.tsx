import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ExecutionLog } from '../../hooks/useExecution';
import Select from '../common/Select';
import { Search, ArrowDown, ExternalLink } from 'lucide-react';

const categoryColors: Record<string, string> = {
  system: 'text-theme-secondary bg-surface-200/40',
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

interface TimelineProps {
  logs: ExecutionLog[];
  nodeFilter: string | null;
  onNodeFilterChange: (node: string | null) => void;
  workflowNodes: string[];
}

export default function Timeline({ logs, nodeFilter, onNodeFilterChange, workflowNodes }: TimelineProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [showSpawnLogs, setShowSpawnLogs] = useState(true);
  const isUserScrolling = useRef(false);

  // Detect whether a log row comes from a spawned agent (Phase 3 fan-out).
  // Both fields are populated by chat-tools.ts liveLog when fan-out is
  // enabled, and by the /logs endpoint's normalization pass for descendant
  // rows pulled via the union query.
  const isChildLog = (l: ExecutionLog): boolean =>
    !!(l.data && typeof l.data === 'object' && (l.data as any).childExecutionId);

  // Auto-scroll to bottom when new logs arrive — only if user hasn't scrolled up
  useEffect(() => {
    if (autoScroll && !isUserScrolling.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs.length, autoScroll]);

  // Detect if user scrolled away from bottom
  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (!atBottom) isUserScrolling.current = true;
    else isUserScrolling.current = false;
    setAutoScroll(atBottom);
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

  return (
    <div className="flex flex-col h-full relative">
      {/* Header with filter and search */}
      <div className="px-3 py-1.5 border-b border-border/50 sticky top-0 bg-surface-50 z-10 flex items-center gap-2">
        <h2 className="font-heading text-[10px] font-semibold text-theme-secondary uppercase tracking-widest shrink-0">Logs</h2>
        <Select
          value={nodeFilter ?? '__all__'}
          onChange={(v) => onNodeFilterChange(v === '__all__' ? null : v)}
          options={filterOptions}
          placeholder="Filter by node"
          className="w-36"
        />
        <div className="flex items-center gap-1 flex-1 min-w-0">
          <Search className="w-3 h-3 text-theme-muted shrink-0" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search logs..."
            className="bg-transparent text-xs text-theme-secondary placeholder-gray-600 outline-none w-full font-mono"
          />
        </div>
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

      {/* Log entries */}
      <div
        ref={containerRef}
        className="flex-1 overflow-auto"
        onScroll={handleScroll}
      >
        {filtered.length === 0 ? (
          <div className="p-4 text-sm text-theme-muted font-mono">
            {logs.length === 0 ? 'WAITING FOR LOGS...' : 'NO MATCHING LOGS'}
          </div>
        ) : (
          filtered.map((log, i) => {
            const isError = log.level === 'error';
            const catClass = isError ? 'text-accent-red bg-accent-red/10' : (categoryColors[log.category] ?? 'text-theme-secondary bg-surface-200/40');
            const child = isChildLog(log) ? (log.data as {
              childExecutionId: string;
              childAgentName: string;
              childParentCaller: string | null;
              childDepth: number;
            }) : null;
            // Indent child rows by depth so nested spawn trees render as
            // a visible hierarchy — grandchildren sit further to the right
            // than their direct parents.
            const indentPx = child ? Math.min(child.childDepth, 4) * 16 : 0;

            return (
              <div
                key={`${log.executionId}-${i}`}
                className={`flex items-start gap-1.5 px-3 py-0.5 hover:bg-accent-blue/5 text-xs transition-colors ${isError ? 'bg-accent-red/5' : ''} ${child ? 'bg-accent-purple/[0.03]' : ''}`}
                style={{ paddingLeft: 12 + indentPx }}
              >
                {/* Timestamp */}
                <span className="text-[10px] text-theme-muted font-mono mt-px shrink-0 w-28 tabular-nums">
                  {formatTime(new Date(log.timestamp))}
                </span>

                {/* Category badge */}
                <span className={`text-[9px] font-mono uppercase px-1 py-px rounded shrink-0 w-14 text-center ${catClass}`}>
                  {log.category}
                </span>

                {/* Node badge (optional) */}
                {log.node ? (
                  <span className="text-[10px] font-mono text-accent-blue/60 shrink-0 w-20 truncate">
                    {log.node}
                  </span>
                ) : (
                  <span className="shrink-0 w-20" />
                )}

                {/* Spawned-agent origin tag. Replaces the blank space of a
                    normal log row with a clickable [agent-name] chip that
                    opens the child's own execution detail page. */}
                {child && (
                  <Link
                    to={`/executions/${child.childExecutionId}`}
                    className="shrink-0 inline-flex items-center gap-0.5 text-[9px] font-mono px-1 py-px rounded bg-accent-purple/10 text-accent-purple hover:bg-accent-purple/20 transition-colors max-w-[120px] truncate"
                    title={`Spawned by ${child.childParentCaller ?? 'unknown'} — click to open child execution`}
                  >
                    <span className="truncate">{child.childAgentName}</span>
                    <ExternalLink className="w-2.5 h-2.5 shrink-0 opacity-60" />
                  </Link>
                )}

                {/* Message */}
                <span className={`font-mono text-theme-secondary min-w-0 break-words ${isError ? 'text-accent-red' : ''}`}>
                  {log.message}
                </span>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>

      {/* Scroll to bottom button — shown when user scrolled up */}
      {!autoScroll && logs.length > 0 && (
        <button
          title="Scroll to latest"
          onClick={() => {
            isUserScrolling.current = false;
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
