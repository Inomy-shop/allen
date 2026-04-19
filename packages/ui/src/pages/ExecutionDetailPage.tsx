import { useState, useCallback, useEffect, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, XCircle, Pause, Play, RefreshCw, Wifi, WifiOff,
  Download, RotateCcw, Brain, Bot, Clock, DollarSign, Terminal,
  CheckCircle, AlertCircle, Wrench, ChevronDown, ChevronRight,
  ArrowRight, AlertTriangle,
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

// ── Agent Execution View (single-node) ──

function AgentExecutionView({ execution, agentName, trace, id }: {
  execution: any; agentName: string; trace: any; id: string;
}) {
  const navigate = useNavigate();
  const [showPrompt, setShowPrompt] = useState(false);
  const [showResponse, setShowResponse] = useState(true);
  const [showLogs, setShowLogs] = useState(true);
  const [liveLogs, setLiveLogs] = useState<any[]>([]);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [resumePrompt, setResumePrompt] = useState('');
  const [resumeBusy, setResumeBusy] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const prompt = trace?.renderedPrompt ?? execution.input?.prompt ?? '';
  const response = trace?.rawResponse ?? '';
  const cost = trace?.cost ?? execution.cost ?? {};
  const toolCalls = trace?.toolCalls ?? [];
  const durationMs = trace?.durationMs ?? execution.durationMs ?? 0;
  const meta = execution.meta ?? {};

  // Session ID for resume — stored on the execution row at sessions.<agentName>
  // and also in trace.output.session_id. Either source works.
  const sessionId: string | undefined =
    execution.sessions?.[agentName]
    ?? trace?.output?.session_id
    ?? undefined;
  const canResume = !!sessionId && (execution.status === 'completed' || execution.status === 'failed');

  const handleResume = async () => {
    const trimmed = resumePrompt.trim();
    if (!trimmed || !sessionId) return;
    setResumeBusy(true);
    try {
      const { agents } = await import('../services/api');
      const result = await agents.run(agentName, {
        prompt: trimmed,
        session_id: sessionId,
        repo_path: meta.cwd || execution.input?.repo_path,
      });
      if (result.error) {
        alert(`Resume failed: ${result.error}`);
        setResumeBusy(false);
        return;
      }
      // Navigate to the new execution
      navigate(`/executions/${result.execution_id}`);
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

  // For completed executions: if live logs are sparse, merge in trace activity + tool calls
  const allLogs = (() => {
    // Start with persisted logs
    const logs = [...liveLogs];
    // If trace has activity not in logs, add them
    const traceActivity = trace?.activity ?? [];
    const traceTools = trace?.toolCalls ?? [];
    if (logs.length < 3 && (traceActivity.length > 0 || traceTools.length > 0)) {
      // Build from trace data
      const traceLogs: any[] = [];
      for (const tc of traceTools) {
        traceLogs.push({ type: 'tool_call', tool: tc.tool, args: tc.args, timestamp: tc.timestamp ?? trace?.startedAt });
      }
      for (const a of traceActivity) {
        traceLogs.push({ type: a.type, tool: a.tool ?? a.content, content: a.content, timestamp: a.timestamp ?? trace?.startedAt });
      }
      // Only add trace logs if persisted logs are sparse (less than tool call count)
      if (logs.length < traceLogs.length + 2) {
        // Replace with trace data since it's more complete
        const persistedStartEnd = logs.filter(l => l.type === 'started' || l.type === 'completed');
        return [...persistedStartEnd, ...traceLogs].sort((a, b) => new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime());
      }
    }
    return logs.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  })();

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [allLogs.length]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-border/50 bg-surface-50 shrink-0">
        <div className="flex items-center gap-3">
          <Link to="/executions" className="text-theme-secondary hover:text-accent-blue transition-colors">
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div className="w-9 h-9 rounded-lg bg-accent-purple/10 border border-accent-purple/20 flex items-center justify-center">
            <Bot className="w-5 h-5 text-accent-purple" />
          </div>
          <div>
            <h1 className="font-heading text-sm font-semibold text-theme-primary tracking-wider uppercase">{agentName}</h1>
            <div className="flex items-center gap-2 mt-0.5">
              <StatusBadge status={execution.status} />
              <span className="text-xs text-theme-muted font-mono">{id?.slice(0, 8)}</span>
              {meta.spawnedBy && <span className="text-[10px] text-theme-subtle font-mono">by {meta.spawnedBy}</span>}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {execution.status === 'running' && <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />}
          {durationMs > 0 && (
            <span className="flex items-center gap-1 text-xs text-theme-secondary font-mono">
              <Clock className="w-3 h-3" /> {formatDuration(durationMs)}
            </span>
          )}
          <CostDisplay cost={cost} />
          {execution.status === 'running' && (
            <button onClick={async () => { await api.cancel(id); window.location.reload(); }} className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300 bg-red-400/10 hover:bg-red-400/20 border border-red-400/20 rounded px-2.5 py-1 font-mono transition-colors">
              <XCircle className="w-3.5 h-3.5" /> Cancel
            </button>
          )}
          {canResume && (
            <button
              onClick={() => setResumeOpen(v => !v)}
              className="flex items-center gap-1 text-xs text-accent-blue hover:text-accent-blue/80 bg-accent-blue/10 hover:bg-accent-blue/20 border border-accent-blue/20 rounded px-2.5 py-1 font-mono transition-colors"
            >
              <Play className="w-3.5 h-3.5" /> Resume
            </button>
          )}
        </div>
      </header>

      {/* Resume prompt bar — shown below header when the user clicks Resume.
          Sends a follow-up prompt to the same agent, resuming the prior
          claude-cli session so the agent has full context from this run. */}
      {resumeOpen && canResume && (
        <div className="flex items-center gap-3 px-6 py-3 border-b border-accent-blue/30 bg-accent-blue/5 shrink-0">
          <div className="flex-1 min-w-0">
            <textarea
              autoFocus
              value={resumePrompt}
              onChange={e => setResumePrompt(e.target.value)}
              onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') handleResume(); }}
              rows={2}
              placeholder="Follow-up prompt — the agent will resume its prior session with full context from this run…"
              className="w-full px-3 py-2 rounded-lg bg-surface-200/40 border border-border/50 text-sm text-theme-primary placeholder:text-theme-subtle focus:outline-none focus:border-accent-blue/50 font-mono resize-none"
            />
          </div>
          <div className="flex flex-col gap-1.5 shrink-0">
            <button
              onClick={handleResume}
              disabled={resumeBusy || !resumePrompt.trim()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-mono bg-accent-blue text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
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
            <span className="text-[10px] font-label uppercase tracking-widest text-theme-muted">Status</span>
            <div className="mt-1"><StatusBadge status={execution.status} /></div>
          </div>
          <div className="card p-3">
            <span className="text-[10px] font-label uppercase tracking-widest text-theme-muted">Duration</span>
            <div className="mt-1 text-sm text-theme-primary font-mono">{durationMs > 0 ? `${formatDuration(durationMs)}` : execution.status === 'running' ? '...' : '—'}</div>
          </div>
          <div className="card p-3">
            <span className="text-[10px] font-label uppercase tracking-widest text-theme-muted">Cost</span>
            <div className="mt-1 text-sm text-theme-primary font-mono">${(cost.actual ?? cost.estimated ?? 0).toFixed(4)}</div>
          </div>
          <div className="card p-3">
            <span className="text-[10px] font-label uppercase tracking-widest text-theme-muted">Model</span>
            <div className="mt-1 text-sm text-theme-primary font-mono">{meta.model ?? cost.model ?? 'sonnet'}</div>
          </div>
          <div className="card p-3">
            <span className="text-[10px] font-label uppercase tracking-widest text-theme-muted">Provider</span>
            <div className="mt-1 text-sm text-theme-primary font-mono">{meta.provider ?? 'claude'}</div>
          </div>
          <div className="card p-3">
            <span className="text-[10px] font-label uppercase tracking-widest text-theme-muted">Spawned By</span>
            <div className="mt-1 text-sm text-theme-primary font-mono">{meta.spawnedBy ?? 'user'}</div>
          </div>
          <div className="card p-3 col-span-2">
            <span className="text-[10px] font-label uppercase tracking-widest text-theme-muted">Working Directory</span>
            <div className="mt-1 text-xs text-blue-400 font-mono truncate" title={meta.cwd ?? execution.input?.repo_path}>{meta.cwd ?? execution.input?.repo_path ?? '/tmp'}</div>
          </div>
        </div>

        {/* Live Logs — shown by default for running, togglable for completed */}
        <div className="card overflow-hidden">
          <button title="Toggle logs" onClick={() => setShowLogs(!showLogs)} className="w-full flex items-center gap-2 px-4 py-3 hover:bg-surface-200/30 transition-colors text-left">
            {showLogs ? <ChevronDown className="w-4 h-4 text-theme-muted" /> : <ChevronRight className="w-4 h-4 text-theme-muted" />}
            <Terminal className="w-4 h-4 text-accent-cyan" />
            <span className="text-xs font-label uppercase tracking-widest text-theme-secondary">Live Logs</span>
            <span className="text-[10px] text-theme-subtle font-mono ml-auto">{allLogs.length} entries</span>
            {execution.status === 'running' && <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />}
          </button>
          {showLogs && (
            <div className="px-4 pb-4 border-t border-border/20 max-h-[50vh] overflow-y-auto bg-[rgb(var(--color-editor-background))] rounded-b">
              {allLogs.length === 0 && execution.status === 'running' && (
                <div className="text-xs text-theme-subtle font-mono py-3 animate-pulse">Waiting for activity...</div>
              )}
              {allLogs.map((log: any, i: number) => (
                <div key={i} className="flex items-start gap-2 py-1 text-[11px] font-mono">
                  <span className="text-theme-subtle w-16 shrink-0">{log.timestamp ? new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '--:--:--'}</span>
                  <span className={
                    log.type === 'tool_start' ? 'text-amber-400 shrink-0' :
                    log.type === 'tool_done' ? 'text-emerald-400 shrink-0' :
                    log.type === 'tool_call' ? 'text-amber-400 shrink-0' :
                    log.type === 'thinking' ? 'text-purple-400 shrink-0' :
                    log.type === 'text' ? 'text-blue-400 shrink-0' :
                    log.type === 'started' ? 'text-blue-400 shrink-0' :
                    log.type === 'completed' ? 'text-emerald-400 shrink-0' :
                    'text-theme-muted shrink-0'
                  }>
                    {log.type === 'tool_start' ? '⚡' : log.type === 'tool_done' ? '✓' : log.type === 'tool_call' ? '🔧' : log.type === 'thinking' ? '💭' : log.type === 'text' ? '💬' : log.type === 'started' ? '▶' : log.type === 'completed' ? '✅' : '·'}
                  </span>
                  <div className="flex-1 min-w-0">
                    {(log.type === 'tool_start' || log.type === 'tool_done' || log.type === 'tool_call') ? (
                      <>
                        <span className="text-theme-muted">{log.tool}</span>
                        {log.content && <span className="text-theme-secondary ml-1.5">{log.content}</span>}
                        {!log.content && log.command && <span className="text-theme-secondary ml-1.5">$ {log.command}</span>}
                        {log.args && <pre className="text-theme-subtle text-[9px] mt-0.5 truncate">{JSON.stringify(log.args).slice(0, 150)}</pre>}
                      </>
                    ) : log.type === 'thinking' ? (
                      <span className="text-purple-400/70">{log.content ?? 'thinking...'}</span>
                    ) : log.type === 'text' ? (
                      <span className="text-theme-secondary line-clamp-2">{log.content}</span>
                    ) : (
                      <span className="text-theme-secondary">{log.content ?? log.type}</span>
                    )}
                  </div>
                </div>
              ))}
              <div ref={logsEndRef} />
            </div>
          )}
        </div>

        {/* Prompt */}
        <div className="card overflow-hidden">
          <button title="Toggle prompt" onClick={() => setShowPrompt(!showPrompt)} className="w-full flex items-center gap-2 px-4 py-3 hover:bg-surface-200/30 transition-colors text-left">
            {showPrompt ? <ChevronDown className="w-4 h-4 text-theme-muted" /> : <ChevronRight className="w-4 h-4 text-theme-muted" />}
            <Terminal className="w-4 h-4 text-accent-blue" />
            <span className="text-xs font-label uppercase tracking-widest text-theme-secondary">Prompt</span>
            <span className="text-[10px] text-theme-subtle font-mono ml-auto">{prompt.length} chars</span>
          </button>
          {showPrompt && (
            <div className="px-4 pb-4 border-t border-border/20">
              <pre className="text-xs text-theme-secondary font-mono whitespace-pre-wrap mt-2 max-h-[40vh] overflow-y-auto">{prompt}</pre>
            </div>
          )}
        </div>

        {/* Response */}
        <div className="card overflow-hidden">
          <button title="Toggle response" onClick={() => setShowResponse(!showResponse)} className="w-full flex items-center gap-2 px-4 py-3 hover:bg-surface-200/30 transition-colors text-left">
            {showResponse ? <ChevronDown className="w-4 h-4 text-theme-muted" /> : <ChevronRight className="w-4 h-4 text-theme-muted" />}
            {execution.status === 'completed' ? <CheckCircle className="w-4 h-4 text-accent-green" /> : execution.status === 'running' ? <Brain className="w-4 h-4 text-accent-blue animate-pulse" /> : <AlertCircle className="w-4 h-4 text-accent-red" />}
            <span className="text-xs font-label uppercase tracking-widest text-theme-secondary">Response</span>
            <span className="text-[10px] text-theme-subtle font-mono ml-auto">{response.length} chars</span>
          </button>
          {showResponse && (
            <div className="px-4 pb-4 border-t border-border/20">
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
        {toolCalls.length > 0 && (
          <div className="card overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border/20">
              <Wrench className="w-4 h-4 text-accent-yellow" />
              <span className="text-xs font-label uppercase tracking-widest text-theme-secondary">Tool Calls</span>
              <span className="text-[10px] text-theme-subtle font-mono ml-auto">{toolCalls.length}</span>
            </div>
            <div className="max-h-[50vh] overflow-y-auto">
              {toolCalls.map((tc: any, i: number) => (
                <div key={i} className="px-4 py-2 border-b border-border/10 last:border-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-mono text-amber-400">{tc.tool}</span>
                  </div>
                  {tc.args && Object.keys(tc.args).length > 0 && (
                    <pre className="text-[10px] font-mono text-theme-subtle mt-1 whitespace-pre-wrap max-h-24 overflow-y-auto">{JSON.stringify(tc.args, null, 2).slice(0, 500)}</pre>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Timestamps */}
        <div className="text-[10px] text-theme-subtle font-mono flex gap-4 flex-wrap">
          <span>Started: {execution.startedAt ? new Date(execution.startedAt).toLocaleString() : 'n/a'}</span>
          <span>Completed: {execution.completedAt ? new Date(execution.completedAt).toLocaleString() : 'n/a'}</span>
          {meta.chatSessionId && <a href={`/chat/${meta.chatSessionId}`} className="text-blue-400 hover:underline">Open Chat →</a>}
        </div>
      </div>
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
  } = useExecution(id);

  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  // Interventions for this workflow run — drives the pending-intervention
  // banner and the interventions sidebar. The dedicated InterventionsPage
  // is where users actually take action; this page just shows awareness.
  const [runInterventions, setRunInterventions] = useState<any[]>([]);

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
    if (id && latestInputEvent) {
      await api.submitInput(id, latestInputEvent.data.node, data);
    }
  }, [id, latestInputEvent]);

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
    const agentTrace = traces.length > 0 ? traces[traces.length - 1] : null;
    return <AgentExecutionView execution={execution} agentName={agentName} trace={agentTrace} id={id!} />;
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

  return (
    <div className="flex flex-col h-full">
      {/* Top bar */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-border/50 bg-surface-50 shrink-0">
        <div className="flex items-center gap-3">
          <Link to="/executions" className="text-theme-secondary hover:text-accent-blue transition-colors">
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div>
            <h1 className="font-heading text-sm font-semibold text-theme-primary tracking-wider uppercase">{execution.workflowName}</h1>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-xs text-theme-muted font-mono">{id?.slice(0, 8)}</span>
              <StatusBadge status={execution.status} />
              {isPaused && (
                <span className="badge bg-accent-orange/10 text-accent-orange gap-1">
                  <Pause className="w-3 h-3" /> paused
                </span>
              )}
              {isLive && (
                connected
                  ? <Wifi className="w-3 h-3 text-accent-green" />
                  : <WifiOff className="w-3 h-3 text-accent-red" />
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {execution.durationMs != null && (
            <span className="text-xs text-theme-secondary font-mono">{formatDuration(execution.durationMs)}</span>
          )}
          <CostDisplay cost={liveCost} />
          {(learningCounts.injected > 0 || learningCounts.extracted > 0) && (
            <Link
              to={`/learnings?search=${encodeURIComponent(id ?? '')}`}
              className="flex items-center gap-1 text-[10px] font-mono text-purple-400 hover:text-purple-300 transition-colors"
              title="Learnings"
            >
              <Brain className="w-3 h-3" />
              {learningCounts.injected > 0 && <span>{learningCounts.injected} in</span>}
              {learningCounts.extracted > 0 && <span>{learningCounts.extracted} out</span>}
            </Link>
          )}
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
            </div>
            {execution.errorMessage && (
              <div className="text-[11px] font-mono text-theme-muted mt-1 break-words max-w-3xl">
                {execution.errorMessage}
              </div>
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
                  className="inline-flex items-center gap-1 px-2 py-1.5 rounded-full text-[11px] font-mono bg-surface-200/60 text-theme-primary hover:bg-surface-200 disabled:opacity-40 transition-colors"
                  title="Resume from an earlier node"
                >
                  Other node <ChevronDown className="w-3 h-3" />
                </button>
                {resumePickerOpen && (
                  <div
                    className="absolute right-0 top-full mt-1 w-56 rounded-lg border border-border/60 bg-surface shadow-lg py-1 z-50"
                    onMouseLeave={() => setResumePickerOpen(false)}
                  >
                    <div className="px-3 py-1.5 text-[9px] font-label uppercase tracking-widest text-theme-subtle border-b border-border/30">
                      Rewind to before…
                    </div>
                    {[...execution.completedNodes].reverse().map((n: string) => (
                      <button
                        key={n}
                        onClick={() => handleRetryFrom(n)}
                        className="w-full text-left px-3 py-1.5 text-[11px] font-mono text-theme-primary hover:bg-surface-200/60 transition-colors"
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
          className={`flex items-center gap-4 px-6 py-3 border-b border-border/50 ${
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
        <div className="px-6 py-2 border-b border-border/30 bg-surface-50 flex items-center gap-3 overflow-x-auto">
          <span className="text-[10px] font-label uppercase tracking-widest text-theme-subtle shrink-0">
            Interventions ({runInterventions.length})
          </span>
          {runInterventions.map((i: any) => (
            <Link
              key={i.intervention_id}
              to={`/interventions/${i.intervention_id}`}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-mono bg-surface-200/40 text-theme-muted hover:bg-surface-200/60 transition-colors shrink-0"
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
            className="overflow-hidden shrink-0 bg-surface border-l-2 border-border/50 hover:border-accent-blue/50 transition-colors relative"
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
          className="shrink-0 bg-surface overflow-hidden flex flex-col border-t-2 border-border/50 group/bottom"
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
            className="shrink-0 overflow-hidden border-r-2 border-border/50 hover:border-accent-blue/50 transition-colors relative"
            style={{ width: `${logsPct}%` }}
          >
            <div className="absolute top-0 right-0 bottom-0 w-2 cursor-col-resize z-10" onMouseDown={logsResizeStart} />
            <Timeline
              logs={logs}
              nodeFilter={logFilter}
              onNodeFilterChange={setLogFilter}
              workflowNodes={workflow?.parsed?.nodes ? Object.keys(workflow.parsed.nodes) : []}
            />
          </div>

          {/* Execution log table */}
          <div className="flex-1 overflow-auto">
            <table className="w-full text-xs font-body">
              <thead className="sticky top-0 z-10">
                <tr className="text-theme-muted bg-surface-50 font-label uppercase tracking-wider">
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
                      <td className="px-4 py-1.5 font-mono text-gray-200">{name}</td>
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
          </div>
        </div>
      </div>
    </div>
  );
}
