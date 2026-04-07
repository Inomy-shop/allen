import { useState, useCallback, useEffect, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ArrowLeft, XCircle, Pause, Play, RefreshCw, Wifi, WifiOff,
  Download, RotateCcw, Brain, Bot, Clock, DollarSign, Terminal,
  CheckCircle, AlertCircle, Wrench, ChevronDown, ChevronRight,
} from 'lucide-react';
import { useExecution, type TimelineEvent } from '../hooks/useExecution';
import { useResizable } from '../hooks/useResizable';
import { executions as api } from '../services/api';
import StatusBadge from '../components/common/StatusBadge';
import CostDisplay from '../components/common/CostDisplay';
import LiveGraph from '../components/execution/LiveGraph';
import Timeline from '../components/execution/Timeline';
import NodeDetail from '../components/execution/NodeDetail';

// ── Agent Execution View (single-node) ──

function AgentExecutionView({ execution, agentName, trace, id }: {
  execution: any; agentName: string; trace: any; id: string;
}) {
  const [showPrompt, setShowPrompt] = useState(false);
  const [showResponse, setShowResponse] = useState(true);
  const [showActivity, setShowActivity] = useState(false);

  const prompt = trace?.renderedPrompt ?? execution.input?.prompt ?? '';
  const response = trace?.rawResponse ?? '';
  const cost = trace?.cost ?? execution.cost ?? {};
  const activity = trace?.activity ?? [];
  const durationMs = trace?.durationMs ?? execution.durationMs ?? 0;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-border/50 bg-surface-50 shrink-0">
        <div className="flex items-center gap-3">
          <Link to="/executions" className="text-gray-400 hover:text-accent-blue transition-colors">
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div className="w-9 h-9 rounded-lg bg-accent-purple/10 border border-accent-purple/20 flex items-center justify-center">
            <Bot className="w-5 h-5 text-accent-purple" />
          </div>
          <div>
            <h1 className="font-heading text-sm font-semibold text-white tracking-wider uppercase">{agentName}</h1>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[10px] text-gray-600 font-mono bg-surface-200/40 px-1.5 py-0.5 rounded">agent execution</span>
              <span className="text-xs text-gray-500 font-mono">{id?.slice(0, 8)}</span>
              <StatusBadge status={execution.status} />
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {durationMs > 0 && (
            <span className="flex items-center gap-1 text-xs text-gray-400 font-mono">
              <Clock className="w-3 h-3" /> {(durationMs / 1000).toFixed(1)}s
            </span>
          )}
          <CostDisplay cost={cost} />
        </div>
      </header>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {/* Metadata cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="card p-3">
            <span className="text-[10px] font-label uppercase tracking-widest text-gray-500">Status</span>
            <div className="mt-1"><StatusBadge status={execution.status} /></div>
          </div>
          <div className="card p-3">
            <span className="text-[10px] font-label uppercase tracking-widest text-gray-500">Duration</span>
            <div className="mt-1 text-sm text-white font-mono">{(durationMs / 1000).toFixed(1)}s</div>
          </div>
          <div className="card p-3">
            <span className="text-[10px] font-label uppercase tracking-widest text-gray-500">Cost</span>
            <div className="mt-1 text-sm text-white font-mono">${(cost.actual ?? cost.estimated ?? 0).toFixed(4)}</div>
          </div>
          <div className="card p-3">
            <span className="text-[10px] font-label uppercase tracking-widest text-gray-500">Model</span>
            <div className="mt-1 text-sm text-white font-mono">{cost.model ?? 'sonnet'}</div>
          </div>
        </div>

        {/* Prompt */}
        <div className="card overflow-hidden">
          <button title="Toggle prompt" onClick={() => setShowPrompt(!showPrompt)} className="w-full flex items-center gap-2 px-4 py-3 hover:bg-surface-200/30 transition-colors text-left">
            {showPrompt ? <ChevronDown className="w-4 h-4 text-gray-500" /> : <ChevronRight className="w-4 h-4 text-gray-500" />}
            <Terminal className="w-4 h-4 text-accent-blue" />
            <span className="text-xs font-label uppercase tracking-widest text-gray-400">Prompt</span>
            <span className="text-[10px] text-gray-600 font-mono ml-auto">{prompt.length} chars</span>
          </button>
          {showPrompt && (
            <div className="px-4 pb-4 border-t border-border/20">
              <pre className="text-xs text-gray-400 font-mono whitespace-pre-wrap mt-2 max-h-60 overflow-auto">{prompt}</pre>
            </div>
          )}
        </div>

        {/* Response */}
        <div className="card overflow-hidden">
          <button title="Toggle response" onClick={() => setShowResponse(!showResponse)} className="w-full flex items-center gap-2 px-4 py-3 hover:bg-surface-200/30 transition-colors text-left">
            {showResponse ? <ChevronDown className="w-4 h-4 text-gray-500" /> : <ChevronRight className="w-4 h-4 text-gray-500" />}
            {execution.status === 'completed' ? <CheckCircle className="w-4 h-4 text-accent-green" /> : <AlertCircle className="w-4 h-4 text-accent-red" />}
            <span className="text-xs font-label uppercase tracking-widest text-gray-400">Response</span>
            <span className="text-[10px] text-gray-600 font-mono ml-auto">{response.length} chars</span>
          </button>
          {showResponse && (
            <div className="px-4 pb-4 border-t border-border/20">
              <div className="text-sm text-gray-300 font-body whitespace-pre-wrap mt-2 max-h-96 overflow-auto leading-relaxed">{response || execution.errorMessage || '(no response)'}</div>
            </div>
          )}
        </div>

        {/* Activity / Tool Calls */}
        {activity.length > 0 && (
          <div className="card overflow-hidden">
            <button title="Toggle activity" onClick={() => setShowActivity(!showActivity)} className="w-full flex items-center gap-2 px-4 py-3 hover:bg-surface-200/30 transition-colors text-left">
              {showActivity ? <ChevronDown className="w-4 h-4 text-gray-500" /> : <ChevronRight className="w-4 h-4 text-gray-500" />}
              <Wrench className="w-4 h-4 text-accent-yellow" />
              <span className="text-xs font-label uppercase tracking-widest text-gray-400">Activity</span>
              <span className="text-[10px] text-gray-600 font-mono ml-auto">{activity.length} events</span>
            </button>
            {showActivity && (
              <div className="px-4 pb-4 border-t border-border/20 max-h-80 overflow-auto">
                {activity.map((a: any, i: number) => (
                  <div key={i} className="flex items-start gap-2 py-1.5 border-b border-border/10 last:border-0 text-xs">
                    <span className="text-gray-600 font-mono w-14 shrink-0">{new Date(a.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                    <span className={`shrink-0 ${a.type === 'tool_start' ? 'text-accent-yellow' : a.type === 'tool_error' ? 'text-accent-red' : 'text-gray-500'}`}>
                      {a.type === 'tool_start' ? '🔧' : a.type === 'tool_complete' ? '✅' : a.type === 'tool_error' ? '❌' : '📝'}
                    </span>
                    <span className="text-gray-400 font-body">{a.content?.slice(0, 200)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Timestamps */}
        <div className="text-[10px] text-gray-600 font-mono flex gap-4">
          <span>Started: {execution.startedAt ? new Date(execution.startedAt).toLocaleString() : 'n/a'}</span>
          <span>Completed: {execution.completedAt ? new Date(execution.completedAt).toLocaleString() : 'n/a'}</span>
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
  } = useExecution(id);

  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  const latestInputEvent = [...timeline].reverse().find((e: TimelineEvent) => e.event === 'input_required');

  // Auto-select node based on execution state
  const prevStatusRef = useRef<string | null>(null);
  useEffect(() => {
    if (!execution) return;
    const status = execution.status;

    // Waiting for input → select the waiting node
    if (status === 'waiting_for_input' && latestInputEvent?.data?.node) {
      setSelectedNode(latestInputEvent.data.node);
      prevStatusRef.current = status;
      return;
    }

    // Running → always follow the running node
    if (status === 'running') {
      for (const [name, state] of nodeStates) {
        if (state.status === 'running') {
          setSelectedNode(name);
          break;
        }
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
  }, [execution?.status, execution?.failedNode, execution?.completedNodes, latestInputEvent, nodeStates]);

  const { size: rightWidth, handleMouseDown: rightResizeStart } = useResizable({ direction: 'horizontal', initialSize: 384, minSize: 280, maxSize: 600 });
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

  const handleRetryFrom = useCallback(async (node: string) => {
    if (id) {
      await api.retryFrom(id, node);
      refresh();
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
    return <div className="flex items-center justify-center h-full text-gray-500 font-mono text-sm">LOADING...</div>;
  }

  if (!execution) {
    return <div className="flex items-center justify-center h-full text-gray-500 font-mono text-sm">EXECUTION NOT FOUND</div>;
  }

  // Role execution — simplified single-node view
  const isAgentExecution = execution.workflowName?.startsWith('chat:spawn_agent/') || execution.source === 'chat';
  if (isAgentExecution) {
    const agentName = execution.workflowName?.replace('chat:spawn_agent/', '') ?? 'unknown';
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
          <Link to="/executions" className="text-gray-400 hover:text-accent-blue transition-colors">
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div>
            <h1 className="font-heading text-sm font-semibold text-white tracking-wider uppercase">{execution.workflowName}</h1>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-xs text-gray-500 font-mono">{id?.slice(0, 8)}</span>
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
            <span className="text-xs text-gray-400 font-mono">{(execution.durationMs / 1000).toFixed(1)}s</span>
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
            />
          </div>

          {/* Right: Node detail + inline human input — resizable */}
          <div
            className="overflow-hidden shrink-0 bg-surface border-l-2 border-border/50 hover:border-accent-blue/50 transition-colors relative"
            style={{ width: rightWidth }}
          >
            {/* Invisible resize grab zone on the left edge */}
            <div
              className="absolute top-0 left-0 bottom-0 w-2 cursor-col-resize z-10"
              onMouseDown={rightResizeStart}
            />
            <NodeDetail
              nodeName={selectedNode ?? ''}
              nodeState={selectedState}
              trace={selectedTrace}
              allTraces={selectedTraces}
              waitingInput={
                latestInputEvent && execution.status === 'waiting_for_input'
                  ? { node: latestInputEvent.data.node, prompt: latestInputEvent.data.prompt, fields: latestInputEvent.data.fields ?? [] }
                  : null
              }
              onSubmitInput={handleSubmitInput}
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
                <tr className="text-gray-500 bg-surface-50 font-label uppercase tracking-wider">
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
                      <td className="px-4 py-1.5 text-gray-400 tabular-nums font-mono">{state.attempt}</td>
                      <td className="px-4 py-1.5 text-gray-400 tabular-nums font-mono">
                        {totalDuration != null ? `${(totalDuration / 1000).toFixed(1)}s` : '-'}
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
