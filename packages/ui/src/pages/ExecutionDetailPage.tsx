import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useParams, Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, XCircle, Pause, Play, RefreshCw, Wifi, WifiOff,
  Download, RotateCcw, Brain, Bot, Clock, DollarSign, Terminal,
  CheckCircle, AlertCircle, Wrench, ChevronDown, ChevronRight,
  ArrowRight, AlertTriangle, Save, BarChart2, Activity,
  MessageSquare, FileText,
} from 'lucide-react';
import { useExecution, type TimelineEvent } from '../hooks/useExecution';
import { useResizable } from '../hooks/useResizable';
import { executions as api, authHeaders, interventions as interventionsApi } from '../services/api';
import StatusBadge from '../components/common/StatusBadge';
import CostDisplay from '../components/common/CostDisplay';
import { renderMarkdown } from '../components/chat/ChatMessageList';
import LiveGraph from '../components/execution/LiveGraph';
import Timeline from '../components/execution/Timeline';
import NodeDetail from '../components/execution/NodeDetail';
import CheckpointsDrawer from '../components/execution/CheckpointsDrawer';
import ArtifactsDrawer from '../components/artifacts/ArtifactsDrawer';
import { artifacts as artifactsApi } from '../services/api';
import TimelineDrawer from '../components/execution/TimelineDrawer';
import StateChangesDrawer from '../components/execution/StateChangesDrawer';
import HumanInputDialog from '../components/execution/HumanInputDialog';
import WorkflowFeedbackDrawer from '../components/execution/WorkflowFeedbackDrawer';
import { ToolCallLog, type ToolCall } from '../components/common/ToolCallLog';
import { buildTracesForTimeline } from '../utils/executionState';

/**
 * Human-friendly duration format:
 *   < 60s  → "12.3s"
 *   < 1h   → "5m 23s"
 *   ≥ 1h   → "1h 12m"
 */
function formatDuration(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return '—';
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const totalMin = Math.floor(totalSec / 60);
  const remainSec = Math.floor(totalSec % 60);
  if (totalMin < 60) return `${totalMin}m ${remainSec}s`;
  const hours = Math.floor(totalMin / 60);
  const remainMin = totalMin % 60;
  return `${hours}h ${remainMin}m`;
}


// ── Single log row in the Activity Log ──
// Tool entries are expandable — click to see full input/output pulled
// from the matching ToolCallRecord (matched by toolUseId, or by tool+ts
// proximity as a fallback).
function LogRow({ log, toolCall }: { log: any; toolCall?: ToolCall }) {
  const [open, setOpen] = useState(false);
  const isTool =
    log.type === 'tool_start' || log.type === 'tool_done' ||
    log.type === 'tool_call' || log.type === 'tool_complete';
  // Every tool row is expandable — even if args/result aren't persisted yet.
  // The expanded panel surfaces whatever's available (log content, matched
  // ToolCallRecord, or an explicit "no data captured" note).
  const canExpand = isTool;
  const ts = log.timestamp
    ? new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '--:--:--';

  const iconChar =
    log.type === 'tool_start' ? '⚡' :
    log.type === 'tool_done' ? '✓' :
    log.type === 'tool_call' ? '🔧' :
    log.type === 'tool_complete' ? '✓' :
    log.type === 'thinking' ? '💭' :
    log.type === 'text' ? '💬' :
    log.type === 'started' ? '▶' :
    log.type === 'completed' ? '✅' : '·';
  const iconColor =
    log.type === 'tool_start' || log.type === 'tool_call' ? 'text-accent-yellow shrink-0' :
    log.type === 'tool_done' || log.type === 'tool_complete' ? 'text-accent-green shrink-0' :
    log.type === 'thinking' ? 'text-accent-purple shrink-0' :
    log.type === 'text' ? 'text-accent shrink-0' :
    log.type === 'started' ? 'text-accent shrink-0' :
    log.type === 'completed' ? 'text-accent-green shrink-0' :
    'text-theme-muted shrink-0';

  // Build the one-line description to show next to the tool name.
  // Prefer the persisted ToolCallRecord's description (the "Bash: pwd",
  // "Read /path" form produced by describeTool on the server). Fall back
  // to log.content or log.command. Strip a leading duplicate of the tool
  // name so "Read Read /path" renders as just "Read /path".
  const toolName = log.tool ?? toolCall?.tool ?? '';
  const rawDesc = toolCall?.description ?? log.content ?? (log.command ? `$ ${log.command}` : '');
  const shortDesc = toolName && rawDesc.startsWith(toolName)
    ? rawDesc.slice(toolName.length).trimStart().replace(/^[:\-—]\s*/, '')
    : rawDesc;
  return (
    <div className={`py-1 text-[11px] font-mono ${canExpand && open ? 'bg-app-muted/40 -mx-2 px-2 rounded-sm' : ''}`}>
      <div
        className={`flex items-start gap-2 ${canExpand ? 'cursor-pointer hover:bg-app-muted/50 -mx-1 px-1 rounded-sm' : ''}`}
        onClick={canExpand ? () => setOpen(o => !o) : undefined}
      >
        {canExpand ? (
          open ? <ChevronDown className="w-3 h-3 mt-1 text-theme-muted shrink-0" />
               : <ChevronRight className="w-3 h-3 mt-1 text-theme-muted shrink-0" />
        ) : <span className="w-3 shrink-0" />}
        <span className="text-theme-subtle w-16 shrink-0">{ts}</span>
        <span className={iconColor}>{iconChar}</span>
        <div className="flex-1 min-w-0">
          {isTool ? (
            <>
              <span className="text-theme-muted">{toolName}</span>
              {shortDesc && <span className="text-theme-secondary ml-1.5">{shortDesc}</span>}
              {toolCall?.durationMs ? (
                <span className="text-[10px] text-theme-subtle ml-2">({toolCall.durationMs < 1000 ? toolCall.durationMs + 'ms' : (toolCall.durationMs / 1000).toFixed(2) + 's'})</span>
              ) : null}
            </>
          ) : log.type === 'thinking' ? (
            <span className="text-accent-purple/70">{log.content ?? 'thinking...'}</span>
          ) : log.type === 'text' ? (
            <span className="text-theme-secondary line-clamp-2">{log.content}</span>
          ) : (
            <span className="text-theme-secondary">{log.content ?? log.type}</span>
          )}
        </div>
      </div>
      {canExpand && open && (
        <div className="ml-[84px] mt-1 mb-1 space-y-1.5">
          {/* INPUT */}
          {(() => {
            // Prefer the full ToolCallRecord.args (persisted or live-streamed).
            // Fall back to whatever the log row itself carries: log.args
            // (engine path), log.command (Bash), log.content (preview from
            // chat-tools). Skip entirely if nothing useful is available.
            const argsObj = toolCall?.args ?? log.args;
            if (argsObj && Object.keys(argsObj).length > 0) {
              return (
                <div>
                  <div className="overline mb-0.5">
                    Input{toolCall?.truncated?.args && <span className="text-accent-yellow ml-1">(truncated)</span>}
                  </div>
                  <pre className="text-[10px] font-mono text-theme-secondary whitespace-pre-wrap bg-app-card/50 rounded-sm p-2 max-h-48 overflow-auto">
                    {JSON.stringify(argsObj, null, 2)}
                  </pre>
                </div>
              );
            }
            if (log.command) {
              return (
                <div>
                  <div className="overline mb-0.5">Command</div>
                  <pre className="text-[10px] font-mono text-theme-secondary whitespace-pre-wrap bg-app-card/50 rounded-sm p-2 max-h-48 overflow-auto">$ {log.command}</pre>
                </div>
              );
            }
            if (log.content && log.type !== 'tool_done' && log.type !== 'tool_complete') {
              return (
                <div>
                  <div className="overline mb-0.5">Input</div>
                  <pre className="text-[10px] font-mono text-theme-secondary whitespace-pre-wrap bg-app-card/50 rounded-sm p-2 max-h-48 overflow-auto">{log.content}</pre>
                </div>
              );
            }
            return null;
          })()}

          {/* OUTPUT */}
          {(() => {
            const recordResult = toolCall?.result;
            const logResult = (log.type === 'tool_done' || log.type === 'tool_complete')
              ? (log.content ?? undefined)
              : undefined;
            const hasRecord = recordResult !== undefined;
            const hasLog = logResult !== undefined && logResult !== '';
            if (hasRecord && toolCall) {
              const isError = toolCall.isError === true;
              return (
                <div>
                  <div className="overline mb-0.5">
                    {isError ? 'Error' : 'Output'}{toolCall.truncated?.result && <span className="text-accent-yellow ml-1">(truncated)</span>}
                  </div>
                  <pre className={`text-[10px] font-mono whitespace-pre-wrap rounded-sm p-2 max-h-64 overflow-auto ${isError ? 'text-accent-red bg-accent-red/5' : 'text-theme-secondary bg-app-card/50'}`}>
                    {typeof recordResult === 'string' ? recordResult : JSON.stringify(recordResult, null, 2)}
                  </pre>
                </div>
              );
            }
            if (hasLog) {
              return (
                <div>
                  <div className="overline mb-0.5">Output (preview)</div>
                  <pre className="text-[10px] font-mono text-theme-secondary whitespace-pre-wrap bg-app-card/50 rounded-sm p-2 max-h-48 overflow-auto">{logResult}</pre>
                </div>
              );
            }
            return null;
          })()}
        </div>
      )}
    </div>
  );
}

// ── Agent Execution View (single-node) ──

function AgentExecutionView({ execution, agentName, traces, id, liveToolCalls, refresh }: {
  execution: any; agentName: string; traces: any[]; id: string; liveToolCalls?: any[]; refresh: () => void;
}) {
  // Attempt selector — when the user has resumed the agent at least once,
  // traces has multiple rows (one per attempt). The latest attempt is
  // selected by default; earlier attempts are viewable via tabs.
  const sortedTraces = [...traces].sort((a, b) => (a.attempt ?? 1) - (b.attempt ?? 1));
  const [selectedAttempt, setSelectedAttempt] = useState<number>(() =>
    sortedTraces.length > 0 ? (sortedTraces[sortedTraces.length - 1].attempt ?? 1) : 1,
  );
  // Keep the selection on the latest attempt when new ones stream in.
  useEffect(() => {
    if (sortedTraces.length === 0) return;
    const latest = sortedTraces[sortedTraces.length - 1].attempt ?? 1;
    setSelectedAttempt(prev => (prev === (sortedTraces[sortedTraces.length - 2]?.attempt ?? latest) ? latest : prev));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortedTraces.length]);
  const trace = sortedTraces.find(t => (t.attempt ?? 1) === selectedAttempt) ?? sortedTraces[sortedTraces.length - 1] ?? null;
  const navigate = useNavigate();
  const [showPrompt, setShowPrompt] = useState(false);
  const [showResponse, setShowResponse] = useState(true);
  const [showLogs, setShowLogs] = useState(true);
  const [liveLogs, setLiveLogs] = useState<any[]>([]);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [resumePrompt, setResumePrompt] = useState('');
  const [resumeBusy, setResumeBusy] = useState(false);
  const [agentArtifactsOpen, setAgentArtifactsOpen] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const prompt = trace?.renderedPrompt ?? execution.input?.prompt ?? '';
  const response = trace?.rawResponse ?? '';
  const cost = trace?.cost ?? execution.cost ?? {};
  // Merge persisted tool calls (from trace) with live-streaming ones (SSE),
  // deduping by toolUseId so we don't double-count once the trace lands.
  const toolCalls = (() => {
    const persisted = trace?.toolCalls ?? [];
    const live = liveToolCalls ?? [];
    if (live.length === 0) return persisted;
    const seen = new Set<string>();
    for (const tc of persisted) if (tc.toolUseId) seen.add(tc.toolUseId);
    const merged = [...persisted];
    for (const tc of live) {
      if (tc.toolUseId && seen.has(tc.toolUseId)) continue;
      merged.push(tc);
    }
    merged.sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());
    return merged;
  })();
  const durationMs = trace?.durationMs ?? execution.durationMs ?? 0;
  const meta = execution.meta ?? {};

  // Session ID for resume — stored on the execution row at sessions.<agentName>
  // and also in trace.output.session_id. Either source works.
  const sessionId: string | undefined =
    execution.sessions?.[agentName]
    ?? trace?.output?.session_id
    ?? undefined;
  // Resume gating:
  //   - completed: requires sessionId (continuing a successful run only makes
  //     sense if we have the session to thread the new prompt onto).
  //   - failed / cancelled: always resumable. If sessionId is missing
  //     (e.g. SIGTERM before the SDK emitted its session marker), the
  //     backend silently starts a fresh session re-run.
  const canResume =
    (execution.status === 'failed' || execution.status === 'cancelled')
    || (!!sessionId && execution.status === 'completed');

  const handleResume = async () => {
    const trimmed = resumePrompt.trim();
    if (!trimmed || !sessionId) return;
    setResumeBusy(true);
    try {
      // Append a new attempt to this same execution — preserves the
      // execution page and accumulates attempt rows rather than creating
      // sibling executions the user has to tab between.
      const result = await api.resumeAgent(id, trimmed);
      if ((result as any).error) {
        alert(`Resume failed: ${(result as any).error}`);
        setResumeBusy(false);
        return;
      }
      setResumePrompt('');
      setResumeOpen(false);
      setResumeBusy(false);
      // Wait briefly for the backend to flip status → running, then refresh.
      setTimeout(() => refresh(), 400);
    } catch (err) {
      alert(`Resume failed: ${(err as Error).message}`);
      setResumeBusy(false);
    }
  };

  // Poll live logs for running executions, merge with trace activity for completed.
  //
  // RACE FIX: on a fast agent run, the final few log lines are emitted to
  // `execution_logs` via fire-and-forget inserts that can lag behind the
  // status transition by 500-1500ms. Without care, the poll loop's `break`
  // on non-running status leaves behind a stale snapshot with the tail
  // missing. We do a FINAL fetch AFTER the break plus a short delayed
  // catch-up fetch, so any rows that landed post-transition are picked up.
  useEffect(() => {
    if (!id) return;
    let alive = true;
    const fetchLogs = async () => {
      try {
        const res = await fetch(`/api/executions/${id}/logs?limit=500`, { headers: authHeaders() });
        const logs = await res.json();
        if (alive && Array.isArray(logs)) setLiveLogs(logs);
      } catch { /* ignore */ }
    };
    const poll = async () => {
      while (alive) {
        await fetchLogs();
        if (execution.status !== 'running') break;
        await new Promise(r => setTimeout(r, 2000));
      }
      // Terminal-state catch-up: one more fetch now and one after a short
      // delay to pick up tail rows whose Mongo insert was still pending.
      if (alive) {
        await fetchLogs();
        setTimeout(() => { if (alive) fetchLogs(); }, 1500);
      }
    };
    poll();
    return () => { alive = false; };
  }, [id, execution.status]);

  // Build the Activity Log stream. Order of precedence:
  //   1. persisted execution_logs rows (liveLogs)
  //   2. live SSE tool-call records (liveToolCalls) — injected as
  //      synthetic log rows so tool events + their full input/output
  //      show up INLINE during live execution, not only after the trace
  //      persists.
  //   3. trace activity/toolCalls — the completed-execution backstop.
  //
  // Dedup by toolUseId: if a persisted log row already carries the same
  // toolUseId, the live injection is skipped to avoid double entries.
  const allLogs = (() => {
    const logs: any[] = [...liveLogs];
    const live = liveToolCalls ?? [];

    const seenUseIds = new Set<string>();
    for (const l of logs) if (l.toolUseId) seenUseIds.add(l.toolUseId);

    // Inject each live tool-call record as a synthetic log row so the
    // Activity Log reflects tool activity as it happens.
    for (const tc of live) {
      if (tc.toolUseId && seenUseIds.has(tc.toolUseId)) continue;
      logs.push({
        type: 'tool_complete',
        tool: tc.tool,
        toolUseId: tc.toolUseId,
        content: tc.description,
        args: tc.args,
        timestamp: tc.startedAt,
      });
      if (tc.toolUseId) seenUseIds.add(tc.toolUseId);
    }

    // Legacy backstop: if persisted logs are sparse, fall back to the
    // saved trace's tool/activity arrays (post-completion view).
    const traceActivity = trace?.activity ?? [];
    const traceTools = trace?.toolCalls ?? [];
    if (logs.length < 3 && (traceActivity.length > 0 || traceTools.length > 0)) {
      const traceLogs: any[] = [];
      for (const tc of traceTools) {
        if (tc.toolUseId && seenUseIds.has(tc.toolUseId)) continue;
        traceLogs.push({
          type: 'tool_complete', tool: tc.tool, toolUseId: tc.toolUseId,
          content: tc.description, args: tc.args,
          timestamp: tc.startedAt ?? tc.timestamp ?? trace?.startedAt,
        });
      }
      for (const a of traceActivity) {
        traceLogs.push({ type: a.type, tool: a.tool ?? a.content, content: a.content, timestamp: a.timestamp ?? trace?.startedAt });
      }
      if (logs.length < traceLogs.length + 2) {
        const persistedStartEnd = logs.filter(l => l.type === 'started' || l.type === 'completed');
        return [...persistedStartEnd, ...traceLogs].sort((a, b) => new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime());
      }
    }
    return logs.sort((a, b) => new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime());
  })();

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [allLogs.length]);

  return (
    <div className="flex flex-col h-full">
      {/* Header — agent execution variant */}
      <header className="px-6 pt-4 pb-3 border-b border-app shrink-0">
        <div className="flex items-center gap-2 mb-2 text-[12px] text-theme-muted">
          <Link to="/executions" className="hover:text-theme-primary transition-colors flex items-center gap-1">
            <ArrowLeft className="w-3 h-3" /> Activity
          </Link>
          <span className="text-theme-subtle">/</span>
          <span className="font-mono">{id?.slice(0, 8)}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 rounded-md bg-accent-purple/10 flex items-center justify-center shrink-0">
              <Bot className="w-4 h-4 text-accent-purple" />
            </div>
            <h1 className="text-[20px] font-semibold text-theme-primary tracking-tight truncate">{agentName}</h1>
            <StatusBadge status={execution.status} />
            {meta.spawnedBy && <span className="text-[11px] text-theme-muted font-mono">by {meta.spawnedBy}</span>}
            {execution.status === 'running' && <span className="w-2 h-2 rounded-full bg-accent animate-pulse" />}
            {durationMs > 0 && (
              <span className="flex items-center gap-1 text-[12px] text-theme-muted font-mono">
                <Clock className="w-3 h-3" /> {formatDuration(durationMs)}
              </span>
            )}
            <CostDisplay cost={cost} />
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setAgentArtifactsOpen(true)}
              className="btn btn-secondary btn-sm"
              title="View artifacts saved by this agent run"
            >
              <FileText className="w-3.5 h-3.5" />
              Artifacts
            </button>
            {execution.status === 'running' && (
              <button
                onClick={async () => { await api.cancel(id); window.location.reload(); }}
                className="btn btn-danger btn-sm"
              >
                <XCircle className="w-3.5 h-3.5" /> Cancel
              </button>
            )}
            {canResume && (
              <button
                onClick={() => setResumeOpen(v => !v)}
                className="btn btn-primary btn-sm"
              >
                <Play className="w-3.5 h-3.5" /> Resume
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Resume prompt bar — shown below header when the user clicks Resume.
          Sends a follow-up prompt to the same agent, resuming the prior
          claude-cli session so the agent has full context from this run. */}
      {resumeOpen && canResume && (
        <div className="flex items-center gap-3 px-6 py-3 border-b border-accent/30 bg-accent-soft shrink-0">
          <div className="flex-1 min-w-0">
            <textarea
              autoFocus
              value={resumePrompt}
              onChange={e => setResumePrompt(e.target.value)}
              onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') handleResume(); }}
              rows={2}
              placeholder="Follow-up prompt — the agent will resume its prior session with full context from this run…"
              className="w-full px-3 py-2 rounded-lg bg-app-muted border border-app text-sm text-theme-primary placeholder:text-theme-subtle focus:outline-none focus:border-accent font-mono resize-none"
            />
          </div>
          <div className="flex flex-col gap-1.5 shrink-0">
            <button
              onClick={handleResume}
              disabled={resumeBusy || !resumePrompt.trim()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-mono btn btn-primary btn-sm disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
            >
              <Play className="w-3 h-3" />
              {resumeBusy ? 'Resuming…' : 'Send'}
            </button>
            <button
              onClick={() => { setResumeOpen(false); setResumePrompt(''); }}
              className="text-[10px] font-mono text-theme-muted hover:text-theme-primary transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {/* Metadata cards — 2 rows */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="card p-3">
            <span className="overline">Status</span>
            <div className="mt-1"><StatusBadge status={execution.status} /></div>
          </div>
          <div className="card p-3">
            <span className="overline">Duration</span>
            <div className="mt-1 text-sm text-theme-primary font-mono">{durationMs > 0 ? `${formatDuration(durationMs)}` : execution.status === 'running' ? '...' : '—'}</div>
          </div>
          <div className="card p-3">
            <span className="overline">Cost</span>
            <div className="mt-1 text-sm text-theme-primary font-mono">${(cost.actual ?? cost.estimated ?? 0).toFixed(4)}</div>
          </div>
          <div className="card p-3">
            <span className="overline">Model</span>
            <div className="mt-1 text-sm text-theme-primary font-mono">{meta.model ?? cost.model ?? 'sonnet'}</div>
          </div>
          <div className="card p-3">
            <span className="overline">Provider</span>
            <div className="mt-1 text-sm text-theme-primary font-mono">{meta.provider ?? 'claude'}</div>
          </div>
          <div className="card p-3">
            <span className="overline">Spawned By</span>
            <div className="mt-1 text-sm text-theme-primary font-mono">{meta.spawnedBy ?? 'user'}</div>
          </div>
          <div className="card p-3 col-span-2">
            <span className="overline">Working Directory</span>
            <div className="mt-1 text-xs text-accent font-mono truncate" title={meta.cwd ?? execution.input?.repo_path}>{meta.cwd ?? execution.input?.repo_path ?? '/tmp'}</div>
          </div>
        </div>

        {/* Attempt tabs — shown when the agent has been resumed at least once.
            Each tab switches which trace (rawResponse / toolCalls / cost /
            duration) the rest of the page reflects. */}
        {sortedTraces.length > 1 && (
          <div className="flex items-center gap-1 border-b border-app -mx-1 px-1 overflow-x-auto">
            {sortedTraces.map(t => {
              const n = t.attempt ?? 1;
              const failed = t.status === 'failed';
              const active = n === selectedAttempt;
              return (
                <button
                  key={n}
                  onClick={() => setSelectedAttempt(n)}
                  className={`flex items-center gap-1.5 px-3 py-2 text-[12px] border-b-2 transition-colors shrink-0 ${
                    active
                      ? 'border-accent-blue text-theme-primary'
                      : 'border-transparent text-theme-muted hover:text-theme-secondary'
                  }`}
                  title={`${failed ? 'Failed' : 'Completed'} · ${new Date(t.startedAt).toLocaleString()}`}
                >
                  {failed ? <AlertCircle className="w-3 h-3 text-accent-red" /> : <CheckCircle className="w-3 h-3 text-accent-green/70" />}
                  Attempt {n}
                </button>
              );
            })}
          </div>
        )}

        {/* Live Logs — shown by default for running, togglable for completed */}
        <div className="card overflow-hidden">
          <button title="Toggle logs" onClick={() => setShowLogs(!showLogs)} className="w-full flex items-center gap-2 px-4 py-3 hover:bg-app-muted/50 transition-colors text-left">
            {showLogs ? <ChevronDown className="w-4 h-4 text-theme-muted" /> : <ChevronRight className="w-4 h-4 text-theme-muted" />}
            <Terminal className="w-4 h-4 text-accent-cyan" />
            <span className="overline text-[12px]">Live Logs</span>
            <span className="text-[10px] text-theme-subtle font-mono ml-auto">{allLogs.length} entries</span>
            {execution.status === 'running' && <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />}
          </button>
          {showLogs && (
            <div className="px-4 pb-4 border-t border-app max-h-[50vh] overflow-y-auto bg-[rgb(var(--color-editor-background))] rounded-b">
              {allLogs.length === 0 && execution.status === 'running' && (
                <div className="text-xs text-theme-subtle font-mono py-3 animate-pulse">Waiting for activity...</div>
              )}
              {(() => {
                // Build two lookups so tool log rows can resolve to their
                // full ToolCallRecord (with args + result):
                //   - byUseId: exact match (the common case — both the log
                //     emitter and the trace store carry toolUseId).
                //   - byToolNearestTs: fallback — match by tool name and
                //     the closest startedAt within ±5s.
                const byUseId = new Map<string, ToolCall>();
                const byTool = new Map<string, ToolCall[]>();
                for (const tc of toolCalls as ToolCall[]) {
                  if (tc.toolUseId) byUseId.set(tc.toolUseId, tc);
                  const arr = byTool.get(tc.tool) ?? [];
                  arr.push(tc);
                  byTool.set(tc.tool, arr);
                }
                const resolve = (log: any): ToolCall | undefined => {
                  if (log.toolUseId && byUseId.has(log.toolUseId)) return byUseId.get(log.toolUseId);
                  if (log.tool) {
                    const candidates = byTool.get(log.tool) ?? [];
                    if (candidates.length === 0) return undefined;
                    if (!log.timestamp) return candidates[0];
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
                return allLogs.map((log: any, i: number) => (
                  <LogRow key={i} log={log} toolCall={resolve(log)} />
                ));
              })()}
              <div ref={logsEndRef} />
            </div>
          )}
        </div>

        {/* Prompt */}
        <div className="card overflow-hidden">
          <button title="Toggle prompt" onClick={() => setShowPrompt(!showPrompt)} className="w-full flex items-center gap-2 px-4 py-3 hover:bg-app-muted/50 transition-colors text-left">
            {showPrompt ? <ChevronDown className="w-4 h-4 text-theme-muted" /> : <ChevronRight className="w-4 h-4 text-theme-muted" />}
            <Terminal className="w-4 h-4 text-accent-blue" />
            <span className="overline text-[12px]">Prompt</span>
            <span className="text-[10px] text-theme-subtle font-mono ml-auto">{prompt.length} chars</span>
          </button>
          {showPrompt && (
            <div className="px-4 pb-4 border-t border-app">
              <pre className="text-xs text-theme-secondary font-mono whitespace-pre-wrap mt-2 max-h-[40vh] overflow-y-auto">{prompt}</pre>
            </div>
          )}
        </div>

        {/* Response */}
        <div className="card overflow-hidden">
          <button title="Toggle response" onClick={() => setShowResponse(!showResponse)} className="w-full flex items-center gap-2 px-4 py-3 hover:bg-app-muted/50 transition-colors text-left">
            {showResponse ? <ChevronDown className="w-4 h-4 text-theme-muted" /> : <ChevronRight className="w-4 h-4 text-theme-muted" />}
            {execution.status === 'completed' ? <CheckCircle className="w-4 h-4 text-accent-green" /> : execution.status === 'running' ? <Brain className="w-4 h-4 text-accent-blue animate-pulse" /> : <AlertCircle className="w-4 h-4 text-accent-red" />}
            <span className="overline text-[12px]">Response</span>
            <span className="text-[10px] text-theme-subtle font-mono ml-auto">{response.length} chars</span>
          </button>
          {showResponse && (
            <div className="px-4 pb-4 border-t border-app">
              <div className="text-sm text-theme-secondary font-body mt-2 leading-relaxed max-h-[60vh] overflow-y-auto prose-allen">
                {response
                  ? renderMarkdown(response)
                  : <span className="text-theme-muted">{execution.status === 'running' ? 'Agent is working...' : execution.errorMessage || '(no response)'}</span>
                }
              </div>
            </div>
          )}
        </div>

        {/* Tool Calls */}
        {toolCalls.length > 0 && <ToolCallLog calls={toolCalls} />}

        {/* Timestamps */}
        <div className="text-[10px] text-theme-subtle font-mono flex gap-4 flex-wrap">
          <span>Started: {execution.startedAt ? new Date(execution.startedAt).toLocaleString() : 'n/a'}</span>
          <span>Completed: {execution.completedAt ? new Date(execution.completedAt).toLocaleString() : 'n/a'}</span>
          {meta.chatSessionId && <a href={`/chat/${meta.chatSessionId}`} className="text-accent hover:underline">Open Chat →</a>}
        </div>
      </div>

      {/* Artifacts drawer — standalone agent runs are their OWN root. If
          this run was spawned by a chat or workflow, its artifacts are
          filed under that parent instead and would show up empty here. */}
      <ArtifactsDrawer
        rootType="agent"
        rootId={id}
        open={agentArtifactsOpen}
        onClose={() => setAgentArtifactsOpen(false)}
      />
    </div>
  );
}

// ── Main Execution Detail Page ──

export default function ExecutionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const {
    execution, workflow, traces, timeline, nodeStates,
    logs, logFilter, setLogFilter,
    loading, connected, isLive, refresh,
    children, descendantsMode, toggleDescendants,
    liveToolCallsByNode,
  } = useExecution(id);

  // Deep-link node selection via ?node=X query param. Keeps the URL as the
  // source of truth so selections survive reload + can be shared.
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedNode = searchParams.get('node');
  const setSelectedNode = (n: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (n) next.set('node', n);
    else next.delete('node');
    setSearchParams(next, { replace: true });
  };
  // Interventions for this workflow run — drives the pending-intervention
  // banner and the interventions sidebar. The dedicated InterventionsPage
  // is where users actually take action; this page just shows awareness.
  const [runInterventions, setRunInterventions] = useState<any[]>([]);
  // Checkpoints drawer — opens from a button in the top toolbar. Badge
  // shows the count so users know whether there's anything to look at
  // before clicking.
  const [checkpointsOpen, setCheckpointsOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [stateChangesOpen, setStateChangesOpen] = useState(false);
  const [checkpointCount, setCheckpointCount] = useState<number | null>(null);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [artifactCount, setArtifactCount] = useState<number | null>(null);
  const [feedbackEntries, setFeedbackEntries] = useState<Array<{ id: string; content: string; targetNodes?: string[]; createdAt: string; createdBy?: string }>>([]);
  const [feedbackText, setFeedbackText] = useState('');
  const [feedbackTargetNodes, setFeedbackTargetNodes] = useState<string[]>([]);
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);

  // Input dialog is dismissible — user can close it to look at nodes/logs
  // and reopen via the header "Respond" button. The dismissed flag resets
  // whenever a new input request arrives or the execution resumes.
  const [inputDialogDismissed, setInputDialogDismissed] = useState(false);
  const lastInputNodeRef = useRef<string | null>(null);
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    api.checkpoints.list(id)
      .then((list) => { if (!cancelled) setCheckpointCount((list ?? []).length); })
      .catch(() => {});
    artifactsApi.list({ rootType: 'workflow', rootId: id, limit: 500 })
      .then((list) => { if (!cancelled) setArtifactCount((list ?? []).length); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [id, execution?.status, execution?.completedNodes?.length]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    api.feedback.list(id)
      .then((list) => { if (!cancelled) setFeedbackEntries(list ?? []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [id, execution?.status]);

  const latestInputEvent = [...timeline].reverse().find((e: TimelineEvent) => e.event === 'input_required');

  // Load interventions for this workflow run when the execution loads,
  // and refresh on every status change so the banner updates in real time.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    interventionsApi.listForWorkflowRun(id)
      .then(data => { if (!cancelled) setRunInterventions(data ?? []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [id, execution?.status]);

  const pendingIntervention = runInterventions.find((i: any) => i.status === 'pending');

  // Auto-select node based on execution state.
  // IMPORTANT: the right-side detail pane should NOT auto-follow the running
  // node — doing so overrides the user's manual selection whenever execution
  // moves to a new node. Instead we only auto-select when `selectedNode` is
  // null (first load) OR when the execution hits a state that requires the
  // user's attention (waiting_for_input, just-completed, just-failed).
  // When a NEW input request arrives (different node than last time, or the
  // execution was not in waiting_for_input before), re-open the dialog. Also
  // re-open when the status moves back to running (so next pause starts fresh).
  useEffect(() => {
    if (!execution) return;
    const waitingNode =
      execution.status === 'waiting_for_input'
        ? (latestInputEvent?.data?.node
          ?? ((Array.isArray(execution.currentNodes) && execution.currentNodes[0]) || null))
        : null;
    if (execution.status !== 'waiting_for_input') {
      if (inputDialogDismissed) setInputDialogDismissed(false);
      lastInputNodeRef.current = null;
      return;
    }
    if (waitingNode && waitingNode !== lastInputNodeRef.current) {
      lastInputNodeRef.current = waitingNode;
      setInputDialogDismissed(false);
    }
  }, [execution?.status, execution?.currentNodes, latestInputEvent?.data?.node]);

  const prevStatusRef = useRef<string | null>(null);
  useEffect(() => {
    if (!execution) return;
    const status = execution.status;

    // Waiting for input → always pin the pane to the waiting node so the
    // user sees the form (regardless of prior selection).
    if (status === 'waiting_for_input' && latestInputEvent?.data?.node) {
      setSelectedNode(latestInputEvent.data.node);
      prevStatusRef.current = status;
      return;
    }

    // Running → only auto-select the running node on first load (nothing
    // selected yet). Once the user picks a node, their selection is
    // preserved even as execution moves to other nodes.
    if (status === 'running') {
      if (!selectedNode) {
        let picked: string | null = null;
        for (const [name, state] of nodeStates) {
          if (state.status === 'running') { picked = name; break; }
        }
        // Belt-and-suspenders fallback: if nodeStates doesn't carry a
        // running entry yet (e.g., between-nodes routing gap, or the
        // useExecution backfill from currentNodes hasn't landed because
        // of load order), pin the pane to whatever the engine says is
        // current. Better than leaving the right pane blank.
        if (!picked && Array.isArray(execution.currentNodes) && execution.currentNodes.length > 0) {
          picked = execution.currentNodes.find((n: string) => n !== 'END') ?? null;
        }
        if (picked) setSelectedNode(picked);
      }
      prevStatusRef.current = status;
      return;
    }

    // Just transitioned to completed/failed → select the final node
    if (status === 'completed' && prevStatusRef.current !== 'completed') {
      if (execution.completedNodes?.length > 0) {
        setSelectedNode(execution.completedNodes[execution.completedNodes.length - 1]);
      }
      prevStatusRef.current = status;
      return;
    }

    if (status === 'failed' && prevStatusRef.current !== 'failed') {
      if (execution.failedNode) {
        setSelectedNode(execution.failedNode);
      }
      prevStatusRef.current = status;
      return;
    }

    // Initial load for already-terminal executions
    if ((status === 'completed' || status === 'failed') && !selectedNode) {
      if (execution.failedNode) {
        setSelectedNode(execution.failedNode);
      } else if (execution.completedNodes?.length > 0) {
        setSelectedNode(execution.completedNodes[execution.completedNodes.length - 1]);
      }
    }

    prevStatusRef.current = status;
  }, [execution?.status, execution?.failedNode, execution?.completedNodes, execution?.currentNodes, latestInputEvent, nodeStates]);

  const { size: rightWidth, handleMouseDown: rightResizeStart } = useResizable({ direction: 'horizontal', initialSize: 40, minSize: 20, maxSize: 60, unit: 'percent' });
  const { size: bottomHeight, handleMouseDown: bottomResizeStart } = useResizable({ direction: 'vertical', initialSize: 200, minSize: 120, maxSize: 500 });
  const { size: logsPct, handleMouseDown: logsResizeStart } = useResizable({ direction: 'horizontal', initialSize: 60, minSize: 25, maxSize: 85, side: 'start', unit: 'percent' });

  const handleCancel = useCallback(async () => {
    if (id) await api.cancel(id);
    refresh();
  }, [id, refresh]);

  const handlePause = useCallback(async () => {
    if (id) await api.pause(id);
    refresh();
  }, [id, refresh]);

  const handleResume = useCallback(async () => {
    if (id) await api.resume(id);
    refresh();
  }, [id, refresh]);

  const handleSubmitInput = useCallback(async (data: Record<string, unknown>) => {
    if (!id || !latestInputEvent) return;
    try {
      await api.submitInput(id, latestInputEvent.data.node, data);
    } catch (err) {
      alert(`Failed to submit input: ${(err as Error).message}`);
      return;
    }
    // Re-fetch so the execution page reflects the submitted value, the
    // new state keys, and the next status (running / next waiting node).
    // SSE would deliver these eventually on live runs, but refresh()
    // makes non-live / replay views update immediately too.
    refresh();
  }, [id, latestInputEvent, refresh]);

  const [resumeBusy, setResumeBusy] = useState(false);
  const [resumePickerOpen, setResumePickerOpen] = useState(false);
  const handleRetryFrom = useCallback(async (node: string) => {
    if (!id) return;
    setResumeBusy(true);
    setResumePickerOpen(false);
    try {
      await api.retryFrom(id, node);
      refresh();
    } catch (err) {
      // Surface failures inline — the operator should see why resume didn't start.
      alert(`Failed to resume from ${node}: ${(err as Error).message}`);
    } finally {
      setResumeBusy(false);
    }
  }, [id, refresh]);

  const canAppendFeedback = ['completed', 'failed', 'cancelled'].includes(execution?.status);
  const handleAppendFeedback = useCallback(async () => {
    if (!id) return;
    const trimmed = feedbackText.trim();
    if (!trimmed) return;
    setFeedbackBusy(true);
    setFeedbackError(null);
    try {
      const targets = feedbackTargetNodes.length > 0 ? feedbackTargetNodes : undefined;
      const entry = await api.feedback.create(id, trimmed, targets);
      setFeedbackEntries((prev) => [...prev, entry]);
      setFeedbackText('');
      setFeedbackTargetNodes([]);
      refresh();
    } catch (err) {
      setFeedbackError((err as Error).message);
    } finally {
      setFeedbackBusy(false);
    }
  }, [id, feedbackText, feedbackTargetNodes, refresh]);

  const handleExportTraces = useCallback(async () => {
    if (!id) return;
    const data = await api.traces(id);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `execution-${id}-traces.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [id]);

  if (loading) {
    return <div className="flex items-center justify-center h-full text-theme-muted font-mono text-sm">LOADING...</div>;
  }

  if (!execution) {
    return <div className="flex items-center justify-center h-full text-theme-muted font-mono text-sm">EXECUTION NOT FOUND</div>;
  }

  // Role execution — simplified single-node view
  // Detect single-agent executions (spawned via spawn_agent — either from
  // chat or from a workflow orchestrator node). These render the simplified
  // AgentExecutionView instead of the full workflow graph.
  //
  // Three signals, any one sufficient:
  //   1. workflowName contains ':spawn_agent/' — the naming convention from
  //      Phase 1 (caller-qualified, e.g. 'develop:spawn_agent/frontend-developer'
  //      or legacy 'chat:spawn_agent/frontend-developer').
  //   2. source === 'chat' — legacy chat-initiated spawns before Phase 1.
  //   3. source === 'spawn' — workflow-initiated spawns after Phase 1.
  const wfName = execution.workflowName ?? '';
  const isAgentExecution = wfName.includes(':spawn_agent/') || execution.source === 'chat' || execution.source === 'spawn';
  if (isAgentExecution) {
    // Parse the agent name from the caller-qualified workflowName.
    // Pattern: '<caller>:spawn_agent/<agentName>' — split on ':spawn_agent/'
    // and take the second part. Falls back gracefully for legacy or malformed names.
    const agentName = wfName.includes(':spawn_agent/')
      ? wfName.split(':spawn_agent/')[1]
      : wfName.replace('chat:spawn_agent/', '') || 'unknown';
    return <AgentExecutionView
      execution={execution}
      agentName={agentName}
      traces={traces}
      id={id!}
      liveToolCalls={liveToolCallsByNode.get(agentName)}
      refresh={refresh}
    />;
  }

  const selectedTraces = traces.filter((t: any) => t.node === selectedNode);
  const selectedTrace = selectedTraces.length > 0 ? selectedTraces[selectedTraces.length - 1] : undefined;
  const selectedState = selectedNode ? nodeStates.get(selectedNode) : undefined;
  const isPaused = execution.status === 'waiting_for_input' && !latestInputEvent;

  // Count learnings from logs
  const learningCounts = (() => {
    let injected = 0;
    let extracted = 0;
    for (const log of logs) {
      const msg = typeof log.message === 'string' ? log.message : '';
      if (msg.includes('[learning] Injected')) {
        const m = msg.match(/Injected (\d+)/);
        if (m) injected += parseInt(m[1], 10);
      }
      if (msg.includes('[learning] Post-execution review extracted')) {
        const m = msg.match(/extracted (\d+)/);
        if (m) extracted += parseInt(m[1], 10);
      }
    }
    return { injected, extracted };
  })();

  // Compute total cost from node states (more accurate for live executions)
  const liveCost = (() => {
    let estimated = 0;
    let actual: number | null = null;
    for (const state of nodeStates.values()) {
      if (state.cost) {
        estimated += state.cost.estimated ?? 0;
        if (state.cost.actual != null) {
          actual = (actual ?? 0) + state.cost.actual;
        }
      }
    }
    // Use live sum if available, fallback to execution record
    if (estimated > 0 || actual != null) return { estimated, actual };
    return execution.cost;
  })();

  // Augment traces with synthetic 'running' entries for nodes currently
  // executing. Traces are only persisted after completion, so without this
  // running rerun nodes are invisible in the Gantt timeline.
  const tracesForTimeline = useMemo(
    () => buildTracesForTimeline(traces ?? [], nodeStates),
    [traces, nodeStates],
  );

  const agentNodeNames = Object.entries((workflow?.parsed?.nodes ?? workflow?.nodes ?? {}) as Record<string, any>)
    .filter(([, nodeDef]) => ((nodeDef as any)?.type ?? 'agent') === 'agent')
    .map(([name]) => name);

  return (
    <div className="flex flex-col h-full">
      {/* Top bar — matches handoff/pages/detail-views.jsx ExecutionDetailV2 */}
      <header className="px-6 pt-4 pb-3 border-b border-app shrink-0">
        <div className="flex items-center gap-2 mb-2 text-[12px] text-theme-muted">
          <Link to="/executions" className="hover:text-theme-primary transition-colors flex items-center gap-1">
            <ArrowLeft className="w-3 h-3" /> Activity
          </Link>
          <span className="text-theme-subtle">/</span>
          <span className="font-mono">{id?.slice(0, 8)}</span>
        </div>

        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <h1 className="text-[20px] font-semibold text-theme-primary tracking-tight truncate">
              {execution.workflowName}
            </h1>
            <StatusBadge status={execution.status} />
            {isPaused && (
              <span className="badge bg-accent-orange/10 text-accent-orange gap-1">
                <Pause className="w-3 h-3" /> paused
              </span>
            )}
            {execution.status === 'waiting_for_input' && inputDialogDismissed && (
              <button
                onClick={() => setInputDialogDismissed(false)}
                className="badge badge-warn cursor-pointer"
                title="Reopen the input dialog"
              >
                <MessageSquare className="w-3 h-3" />
                Respond to input
                <span className="w-1.5 h-1.5 rounded-full bg-accent-yellow animate-pulse" />
              </button>
            )}
            {isLive && (
              <span title={connected ? 'Live' : 'Disconnected'}>
                {connected
                  ? <Wifi className="w-3 h-3 text-accent-green" />
                  : <WifiOff className="w-3 h-3 text-accent-red" />}
              </span>
            )}
            {execution.durationMs != null && (
              <span className="text-[12px] text-theme-muted font-mono">{formatDuration(execution.durationMs)}</span>
            )}
            <CostDisplay cost={liveCost} />
            {(learningCounts.injected > 0 || learningCounts.extracted > 0) && (
              <Link
                to={`/learnings?search=${encodeURIComponent(id ?? '')}`}
                className="flex items-center gap-1 text-[11px] font-mono text-accent-purple hover:opacity-80 transition-opacity"
                title="Learnings"
              >
                <Brain className="w-3 h-3" />
                {learningCounts.injected > 0 && <span>{learningCounts.injected} in</span>}
                {learningCounts.extracted > 0 && <span>{learningCounts.extracted} out</span>}
              </Link>
            )}
          </div>

        <div className="flex items-center gap-2">
          {execution.durationMs != null && (
            <span className="text-xs text-theme-secondary font-mono">{formatDuration(execution.durationMs)}</span>
          )}
          <CostDisplay cost={liveCost} />
          {(learningCounts.injected > 0 || learningCounts.extracted > 0) && (
            <Link
              to={`/learnings?search=${encodeURIComponent(id ?? '')}`}
              className="flex items-center gap-1 text-[10px] font-mono text-accent-purple hover:text-purple-300 transition-colors"
              title="Learnings"
            >
              <Brain className="w-3 h-3" />
              {learningCounts.injected > 0 && <span>{learningCounts.injected} in</span>}
              {learningCounts.extracted > 0 && <span>{learningCounts.extracted} out</span>}
            </Link>
          )}
          <button
            onClick={() => setTimelineOpen(true)}
            className="btn-ghost text-xs inline-flex items-center gap-1"
            title="View node execution timeline (Gantt view)"
          >
            <BarChart2 className="w-3.5 h-3.5" />
            <span>Timeline</span>
            {traces && traces.length > 0 && (
              <span className="ml-0.5 px-1 py-px rounded-sm bg-accent-soft text-accent text-[10px] font-mono tabular-nums">
                {traces.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setStateChangesOpen(true)}
            className="btn-ghost text-xs inline-flex items-center gap-1"
            title="View chronological state changes across checkpoints"
          >
            <Activity className="w-3.5 h-3.5" />
            <span>State Changes</span>
          </button>
          <button
            onClick={() => setCheckpointsOpen(true)}
            className="btn-ghost text-xs inline-flex items-center gap-1"
            title="View checkpoints (edit state, run from, fork)"
          >
            <Save className="w-3.5 h-3.5" />
            <span>Checkpoints</span>
            {checkpointCount != null && checkpointCount > 0 && (
              <span className="ml-0.5 px-1 py-px rounded-sm bg-accent-soft text-accent text-[10px] font-mono tabular-nums">
                {checkpointCount}
              </span>
            )}
          </button>
          <button
            onClick={() => setFeedbackOpen(true)}
            className="btn-ghost text-xs inline-flex items-center gap-1"
            title="View and add workflow feedback"
          >
            <MessageSquare className="w-3.5 h-3.5" />
            <span>Feedback</span>
            {feedbackEntries.length > 0 && (
              <span className="ml-0.5 px-1 py-px rounded-sm bg-accent-soft text-accent text-[10px] font-mono tabular-nums">
                {feedbackEntries.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setArtifactsOpen(true)}
            className="btn-ghost text-xs inline-flex items-center gap-1"
            title="View artifacts saved by agents during this run"
          >
            <FileText className="w-3.5 h-3.5" />
            <span>Artifacts</span>
            {artifactCount != null && artifactCount > 0 && (
              <span className="ml-0.5 px-1 py-px rounded-sm bg-accent-soft text-accent text-[10px] font-mono tabular-nums">
                {artifactCount}
              </span>
            )}
          </button>
          <button onClick={handleExportTraces} className="btn-ghost text-xs" title="Export traces">
            <Download className="w-3.5 h-3.5" />
          </button>
          {execution.status === 'failed' && execution.failedNode && (
            <button
              onClick={() => handleRetryFrom(execution.failedNode)}
              className="btn-ghost text-xs text-accent-yellow"
              title="Retry from failed node"
            >
              <RotateCcw className="w-3.5 h-3.5 mr-1" /> Retry
            </button>
          )}
          {isLive && (
            <>
              {isPaused ? (
                <button onClick={handleResume} className="btn-primary text-xs" title="Resume execution">
                  <Play className="w-3.5 h-3.5 mr-1" /> Resume
                </button>
              ) : (
                <button onClick={handlePause} className="btn-ghost text-xs" title="Pause execution">
                  <Pause className="w-3.5 h-3.5" />
                </button>
              )}
              <button onClick={handleCancel} className="btn-danger text-xs" title="Cancel execution">
                <XCircle className="w-3.5 h-3.5 mr-1" /> Cancel
              </button>
            </>
          )}
          <button onClick={refresh} className="btn-ghost text-xs" title="Refresh">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          </div>
        </div>
      </header>

      {/* Failure banner — prominent resume-from-node controls when the
          execution has failed. The compact `Retry` button in the top bar
          stays (muscle memory), but this banner is the obvious entry point
          with the error shown, the failing node called out, and a picker
          to rewind further back than the failure point if needed. */}
      {execution.status === 'failed' && execution.failedNode && (
        <div className="flex items-start gap-4 px-6 py-3 border-b border-accent-red/30 bg-accent-red/10">
          <AlertTriangle className="w-5 h-5 text-accent-red shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="text-xs font-heading font-semibold text-theme-primary">
              FAILED AT <span className="font-mono text-accent-red">{execution.failedNode}</span>
              {(() => {
                // Surface the failing tool call from the failed node's trace.
                const failedTrace = (traces ?? []).find(
                  (t: any) => t.node === execution.failedNode && t.status === 'failed',
                );
                const failingTool = failedTrace?.toolCalls?.find((tc: any) => tc.isError);
                if (!failingTool) return null;
                return (
                  <span className="ml-2 text-[11px] font-mono text-theme-muted">
                    · tool <span className="text-accent-red">{failingTool.tool}</span>
                  </span>
                );
              })()}
              <button
                onClick={() => { setSelectedNode(execution.failedNode); }}
                className="ml-3 text-[10px] font-mono underline text-theme-muted hover:text-theme-primary"
                title="Jump to failed node + Inspector tab for state-at-failure"
              >
                Inspect →
              </button>
            </div>
            {execution.errorMessage && (
              <details className="mt-1">
                <summary className="text-[11px] font-mono text-theme-muted cursor-pointer hover:text-theme-primary list-none">
                  <span className="text-[10px] uppercase tracking-widest mr-1">Error</span>
                  {execution.errorMessage.split('\n')[0].slice(0, 180)}
                  {execution.errorMessage.length > 180 && ' …'}
                </summary>
                <pre className="mt-1.5 text-[10px] font-mono text-theme-muted whitespace-pre-wrap break-words max-w-3xl bg-black/20 rounded p-2">
                  {execution.errorMessage}
                </pre>
              </details>
            )}
            <div className="text-[10px] font-mono text-theme-subtle mt-1">
              Resume rewinds state to the checkpoint taken before the selected node and re-enters the graph from there. Upstream outputs and agent sessions are preserved.
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0 relative">
            <button
              onClick={() => handleRetryFrom(execution.failedNode)}
              disabled={resumeBusy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-mono bg-accent-red text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
              title={`Resume execution from ${execution.failedNode}`}
            >
              <RotateCcw className="w-3 h-3" />
              {resumeBusy ? 'Resuming…' : `Continue from ${execution.failedNode}`}
            </button>
            {execution.completedNodes && execution.completedNodes.length > 0 && (
              <>
                <button
                  onClick={() => setResumePickerOpen(v => !v)}
                  disabled={resumeBusy}
                  className="inline-flex items-center gap-1 px-2 py-1.5 rounded-full text-[11px] font-mono bg-app-muted text-theme-primary hover:bg-surface-200 disabled:opacity-40 transition-colors"
                  title="Resume from an earlier node"
                >
                  Other node <ChevronDown className="w-3 h-3" />
                </button>
                {resumePickerOpen && (
                  <div
                    className="absolute right-0 top-full mt-1 w-56 rounded-lg border border-app bg-surface shadow-lg py-1 z-50"
                    onMouseLeave={() => setResumePickerOpen(false)}
                  >
                    <div className="px-3 py-1.5 overline border-b border-app">
                      Rewind to before…
                    </div>
                    {[...execution.completedNodes].reverse().map((n: string) => (
                      <button
                        key={n}
                        onClick={() => handleRetryFrom(n)}
                        className="w-full text-left px-3 py-1.5 text-[11px] font-mono text-theme-primary hover:bg-app-muted transition-colors"
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Intervention banner — shown when the run is paused awaiting a
          human intervention. Action happens on the dedicated
          /interventions/:id page, not inline here. */}
      {pendingIntervention && (
        <div
          className={`flex items-center gap-4 px-6 py-3 border-b border-app ${
            pendingIntervention.severity === 'escalation'
              ? 'bg-accent-red/10 border-accent-red/30'
              : pendingIntervention.severity === 'approval'
                ? 'bg-accent-green/10 border-accent-green/30'
                : 'bg-accent-yellow/10 border-accent-yellow/30'
          }`}
        >
          <span className="text-xl shrink-0">
            {pendingIntervention.severity === 'escalation' ? '🔴'
              : pendingIntervention.severity === 'approval' ? '🟢' : '🟡'}
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-heading font-semibold text-theme-primary">
              PAUSED — {pendingIntervention.title}
            </div>
            <div className="text-[10px] font-mono text-theme-muted mt-0.5 truncate">
              {pendingIntervention.context_summary}
              {pendingIntervention.round_info &&
                <> · round {pendingIntervention.round_info.current}/{pendingIntervention.round_info.max}</>}
            </div>
          </div>
          <Link
            to={`/interventions/${pendingIntervention.intervention_id}`}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-mono bg-theme-primary text-surface-100 hover:opacity-80 transition-opacity shrink-0"
          >
            Respond <ArrowRight className="w-3 h-3" />
          </Link>
        </div>
      )}

      {/* Interventions sidebar — quick chronological list of every
          intervention fired on this run so the operator can see the
          decision history at a glance. */}
      {runInterventions.length > 0 && (
        <div className="px-6 py-2 border-b border-app bg-surface-50 flex items-center gap-3 overflow-x-auto">
          <span className="overline shrink-0">
            Interventions ({runInterventions.length})
          </span>
          {runInterventions.map((i: any) => (
            <Link
              key={i.intervention_id}
              to={`/interventions/${i.intervention_id}`}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-mono bg-app-muted text-theme-muted hover:bg-app-muted transition-colors shrink-0"
              title={`${i.title} — ${i.status}`}
            >
              <span>{i.severity === 'escalation' ? '🔴' : i.severity === 'approval' ? '🟢' : '🟡'}</span>
              <span className="truncate max-w-[200px]">{i.title}</span>
              <span className="text-theme-subtle">
                {i.status === 'pending' ? '·' : `· ${i.response?.decision ?? i.status}`}
              </span>
            </Link>
          ))}
        </div>
      )}

      {/* Main content — graph + detail top, timeline bottom */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top: Graph + Node detail side by side */}
        <div className="flex-1 flex overflow-hidden min-h-0">
          {/* Left: Live graph (takes most space) */}
          <div className="flex-1 overflow-hidden">
            <LiveGraph
              workflow={workflow}
              nodeStates={nodeStates}
              selectedNode={selectedNode}
              onSelectNode={setSelectedNode}
              spawnCounts={(children ?? []).reduce((acc: Record<string, number>, c) => {
                if (c.parentCaller) acc[c.parentCaller] = (acc[c.parentCaller] ?? 0) + 1;
                return acc;
              }, {})}
            />
          </div>

          {/* Right: Node detail + inline human input — resizable */}
          <div
            className="overflow-hidden shrink-0 bg-surface border-l-2 border-app hover:border-accent-blue/50 transition-colors relative"
            style={{ width: `${rightWidth}%` }}
          >
            {/* Invisible resize grab zone on the left edge */}
            <div
              className="absolute top-0 left-0 bottom-0 w-2 cursor-col-resize z-10"
              onMouseDown={rightResizeStart}
            />
            {/*
              The inline human-input form is intentionally DISABLED here.
              Human interventions now surface on the dedicated Interventions
              page (/interventions/:id) — we pass `waitingInput={null}` so
              NodeDetail never renders its inline form. The pending-intervention
              banner at the top of this page is the awareness surface; the
              Interventions page is the action surface. See §9.7 of
              docs/plans/feature-and-bug-workflows.md.
            */}
            <NodeDetail
              nodeName={selectedNode ?? ''}
              nodeState={selectedState}
              trace={selectedTrace}
              allTraces={selectedTraces}
              waitingInput={null}
              onSubmitInput={handleSubmitInput}
              spawnedChildren={(children ?? []).filter(c => c.parentCaller === selectedNode)}
              allChildren={children ?? []}
              descendantsMode={descendantsMode}
              onToggleDescendants={toggleDescendants}
            />
          </div>
        </div>

        {/* Bottom: Timeline (horizontal) + Execution log table — resizable */}
        <div
          className="shrink-0 bg-surface overflow-hidden flex flex-col border-t-2 border-app group/bottom"
          style={{ minHeight: 120, height: bottomHeight, maxHeight: '60%' }}
        >
          {/* Resize grab zone — full width strip at top, overlapping border */}
          <div
            className="shrink-0 h-1 cursor-row-resize relative z-20 hover:[&]:border-t-2 hover:[&]:border-accent-blue"
            onMouseDown={bottomResizeStart}
            style={{ marginTop: -2 }}
            onMouseEnter={e => { (e.currentTarget.parentElement as HTMLElement).style.borderTopColor = 'rgb(var(--color-accent))'; }}
            onMouseLeave={e => { (e.currentTarget.parentElement as HTMLElement).style.borderTopColor = ''; }}
          />
          <div className="flex flex-1 overflow-hidden">
          {/* Logs — resizable */}
          <div
            className="shrink-0 overflow-hidden border-r-2 border-app hover:border-accent-blue/50 transition-colors relative"
            style={{ width: `${logsPct}%` }}
          >
            <div className="absolute top-0 right-0 bottom-0 w-2 cursor-col-resize z-10" onMouseDown={logsResizeStart} />
            <Timeline
              logs={logs}
              nodeFilter={logFilter}
              onNodeFilterChange={setLogFilter}
              workflowNodes={workflow?.parsed?.nodes ? Object.keys(workflow.parsed.nodes) : []}
              traces={traces}
            />
          </div>

          {/* Execution log table */}
          <div className="flex-1 overflow-auto">
            <table className="w-full text-xs font-body">
              <thead className="sticky top-0 z-10">
                <tr className="bg-app-muted overline border-b border-app">
                  <th className="text-left px-4 py-1.5 font-medium">Node</th>
                  <th className="text-left px-4 py-1.5 font-medium">Status</th>
                  <th className="text-left px-4 py-1.5 font-medium">Attempt</th>
                  <th className="text-left px-4 py-1.5 font-medium">Duration</th>
                  <th className="text-left px-4 py-1.5 font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {Array.from(nodeStates.entries()).map(([name, state]) => {
                  // Sum cost and duration across all attempts from traces
                  const nodeTraces = traces.filter((t: any) => t.node === name);
                  const dedupMap = new Map<number, any>();
                  for (const t of nodeTraces) dedupMap.set(t.attempt, t);
                  const deduped = Array.from(dedupMap.values());

                  let totalCost = state.cost;
                  let totalDuration = state.durationMs;

                  if (deduped.length > 1) {
                    let est = 0; let act: number | null = null; let dur = 0;
                    for (const t of deduped) {
                      est += t.cost?.estimated ?? 0;
                      if (t.cost?.actual != null) act = (act ?? 0) + t.cost.actual;
                      dur += t.durationMs ?? 0;
                    }
                    if (est > 0 || act != null) totalCost = { estimated: est, actual: act };
                    if (dur > 0) totalDuration = dur;
                  }

                  return (
                    <tr
                      key={name}
                      onClick={() => setSelectedNode(name)}
                      className={`cursor-pointer hover:bg-accent-blue/5 transition-colors
                        ${selectedNode === name ? 'bg-accent-blue/10' : ''}`}
                    >
                      <td className="px-4 py-1.5 font-mono text-theme-primary">{name}</td>
                      <td className="px-4 py-1.5"><StatusBadge status={state.status} /></td>
                      <td className="px-4 py-1.5 text-theme-secondary tabular-nums font-mono">{state.attempt}</td>
                      <td className="px-4 py-1.5 text-theme-secondary tabular-nums font-mono">
                        {totalDuration != null ? formatDuration(totalDuration) : '-'}
                      </td>
                      <td className="px-4 py-1.5"><CostDisplay cost={totalCost} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* ── Checkpoints ──────────────────────────────────────────
              View, edit, and resume/fork from any checkpoint saved
              during this run. Actions gate on execution status:
              edits blocked while running/waiting; run-from blocked
              unless failed/cancelled; fork always allowed. */}
          {/* Timeline, State Changes, and Checkpoints are all accessed via
              the matching buttons in the header, which open right-side
              drawers. Kept off the main flow to reduce scroll and put them
              one click away at any time. */}
          </div>
        </div>
      </div>

      {/* Right-side drawers — mounted at page root, portal to body so
          ancestor backdrop-filter can't trap them. */}
      <CheckpointsDrawer
        executionId={id!}
        executionStatus={execution.status}
        open={checkpointsOpen}
        onClose={() => setCheckpointsOpen(false)}
      />
      <WorkflowFeedbackDrawer
        open={feedbackOpen}
        onClose={() => setFeedbackOpen(false)}
        entries={feedbackEntries}
        canAppend={canAppendFeedback}
        agentNodeNames={agentNodeNames}
        feedbackText={feedbackText}
        targetNodes={feedbackTargetNodes}
        busy={feedbackBusy}
        error={feedbackError}
        onTextChange={setFeedbackText}
        onTargetNodesChange={setFeedbackTargetNodes}
        onSubmit={handleAppendFeedback}
      />
      <ArtifactsDrawer
        rootType="workflow"
        rootId={id!}
        open={artifactsOpen}
        onClose={() => setArtifactsOpen(false)}
      />
      <TimelineDrawer
        traces={tracesForTimeline as any}
        open={timelineOpen}
        onClose={() => setTimelineOpen(false)}
        onNodeClick={(n) => setSelectedNode(n)}
      />
      <StateChangesDrawer
        executionId={id!}
        open={stateChangesOpen}
        onClose={() => setStateChangesOpen(false)}
      />

      {/* Inline human-input dialog — brought back for clarification flows
          that carry reviewable content. The legacy /interventions/:id page
          still exists for interventions that need richer workflow; this
          dialog handles in-place clarify-with-content patterns:
          - `__clarify_fields` in exec state → form fields
          - `__clarify_content` in exec state → content to review (markdown/json/code)
          - `__clarify_content_type` → how to render the content
          - `__reason` → the question prompt
          Mounted only when status is waiting_for_input AND we have the
          clarify payload; otherwise we defer to the pending-intervention
          banner higher up. */}
      {execution.status === 'waiting_for_input' && !inputDialogDismissed && (() => {
        const st = (execution.state ?? {}) as Record<string, unknown>;
        // Field source priority:
        //   1. __clarify_fields   — agent-provided clarify fields (auto-gate)
        //   2. latestInputEvent   — human node's declared fields (from workflow YAML)
        //   3. fallback single `response` field
        // Using the declared fields ensures submitted keys match what
        // downstream nodes template against (e.g. {{user_question}}).
        const clarifyFields = Array.isArray(st.__clarify_fields) && (st.__clarify_fields as unknown[]).length > 0
          ? (st.__clarify_fields as any[])
          : undefined;
        const nodeFields = Array.isArray(latestInputEvent?.data?.fields) && latestInputEvent!.data!.fields!.length > 0
          ? (latestInputEvent!.data!.fields as any[])
          : undefined;
        const fields = clarifyFields ?? nodeFields ?? [
          { name: 'response', type: 'text', label: 'Your response', required: true },
        ];

        // Find the agent's actual response text — ONLY when there's an
        // active clarify gate whose target node is the currently-waiting
        // node. For plain human-node pauses (no gate) we must NOT read
        // the node's own declared outputs as "agent text" — those outputs
        // are filled BY the user on this same pause, so their current
        // values are leftover from a previous loop iteration.
        let agentText: string | undefined;
        const waitingNode = latestInputEvent?.data?.node
          ?? (Array.isArray(execution.currentNodes) && execution.currentNodes[0])
          ?? undefined;
        const gateNode = st.__gate_node as string | undefined;
        const gateAction = st.__gate_action as string | undefined;
        const gateIsForWaitingNode = !!gateNode && gateNode === waitingNode && gateAction === 'clarify';
        if (gateIsForWaitingNode && gateNode) {
          const gateNodeDef = workflow?.parsed?.nodes?.[gateNode];
          const outputsSpec = (gateNodeDef as { outputs?: Record<string, unknown> } | undefined)?.outputs;
          if (outputsSpec && typeof outputsSpec === 'object') {
            let best: string | undefined;
            for (const key of Object.keys(outputsSpec)) {
              if (key.startsWith('__')) continue;
              const v = st[key];
              if (typeof v === 'string' && v.length > (best?.length ?? 0)) best = v;
            }
            agentText = best;
          }
        }

        // Prompt resolution: agent-supplied > agent's actual text > generic.
        // __reason is only trusted when the gate applies to this node —
        // same staleness rule as agentText above.
        const explicitReason = gateIsForWaitingNode
          && typeof st.__reason === 'string' && st.__reason.length > 0
          ? (st.__reason as string)
          : undefined;
        const reason = explicitReason
          ?? (agentText && agentText.length < 280 ? agentText : undefined)
          ?? (latestInputEvent?.data?.prompt as string | undefined)
          ?? 'The agent is asking for input.';

        // Review content: explicit clarify_content first (only if gate is
        // for this node), else the agent's full response text when long
        // enough to warrant a dedicated viewer.
        let reviewContent: string | undefined;
        if (gateIsForWaitingNode && typeof st.__clarify_content === 'string') {
          reviewContent = st.__clarify_content;
        } else if (gateIsForWaitingNode && st.__clarify_content != null) {
          reviewContent = JSON.stringify(st.__clarify_content, null, 2);
        } else if (agentText && agentText.length >= 280) {
          reviewContent = agentText;
        }
        const reviewContentType = (st.__clarify_content_type as 'markdown' | 'json' | 'code' | 'text' | undefined) ?? 'markdown';
        // Only render if we have a waiting-node context. If not, fall back
        // to the intervention banner flow.
        if (!waitingNode) return null;
        return (
          <HumanInputDialog
            node={waitingNode}
            prompt={reason}
            fields={fields}
            reviewContent={reviewContent}
            reviewContentType={reviewContentType}
            onSubmit={(data) => handleSubmitInput(data)}
            onCancel={() => setInputDialogDismissed(true)}
          />
        );
      })()}
    </div>
  );
}
