import { useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ArrowLeft, XCircle, Pause, Play, RefreshCw, Wifi, WifiOff,
  Download, RotateCcw,
} from 'lucide-react';
import { useExecution, type TimelineEvent } from '../hooks/useExecution';
import { executions as api } from '../services/api';
import StatusBadge from '../components/common/StatusBadge';
import CostDisplay from '../components/common/CostDisplay';
import LiveGraph from '../components/execution/LiveGraph';
import Timeline from '../components/execution/Timeline';
import NodeDetail from '../components/execution/NodeDetail';
import HumanInputDialog from '../components/execution/HumanInputDialog';

export default function ExecutionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const {
    execution, workflow, traces, timeline, nodeStates,
    loading, connected, isLive, refresh,
  } = useExecution(id);

  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  const latestInputEvent = [...timeline].reverse().find((e: TimelineEvent) => e.event === 'input_required');

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

  const selectedTrace = traces.find((t: any) => t.node === selectedNode);
  const selectedState = selectedNode ? nodeStates.get(selectedNode) : undefined;
  const isPaused = execution.status === 'waiting_for_input' && !latestInputEvent;

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
          <CostDisplay cost={execution.cost} />
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
                <button onClick={handleResume} className="btn-primary text-xs">
                  <Play className="w-3.5 h-3.5 mr-1" /> Resume
                </button>
              ) : (
                <button onClick={handlePause} className="btn-ghost text-xs">
                  <Pause className="w-3.5 h-3.5" />
                </button>
              )}
              <button onClick={handleCancel} className="btn-danger text-xs">
                <XCircle className="w-3.5 h-3.5 mr-1" /> Cancel
              </button>
            </>
          )}
          <button onClick={refresh} className="btn-ghost text-xs" title="Refresh">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      {/* Main content — 3 panel layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Timeline */}
        <div className="w-72 border-r border-border/50 overflow-auto shrink-0 bg-surface">
          <div className="px-3 py-2 border-b border-border/50">
            <h2 className="font-heading text-xs font-semibold text-gray-400 uppercase tracking-widest">Timeline</h2>
          </div>
          <Timeline events={timeline} />
        </div>

        {/* Center: Live graph + execution log table */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-auto">
            <LiveGraph
              workflow={workflow}
              nodeStates={nodeStates}
              selectedNode={selectedNode}
              onSelectNode={setSelectedNode}
            />
          </div>

          {/* Bottom: Execution log table */}
          <div className="border-t border-border/50 shrink-0 max-h-56 overflow-auto">
            <table className="w-full text-xs font-body">
              <thead className="sticky top-0">
                <tr className="text-gray-500 bg-surface-50 font-label uppercase tracking-wider">
                  <th className="text-left px-4 py-2 font-medium">Node</th>
                  <th className="text-left px-4 py-2 font-medium">Status</th>
                  <th className="text-left px-4 py-2 font-medium">Attempt</th>
                  <th className="text-left px-4 py-2 font-medium">Duration</th>
                  <th className="text-left px-4 py-2 font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {Array.from(nodeStates.entries()).map(([name, state]) => (
                  <tr
                    key={name}
                    onClick={() => setSelectedNode(name)}
                    className={`cursor-pointer hover:bg-accent-blue/5 transition-colors
                      ${selectedNode === name ? 'bg-accent-blue/10' : ''}`}
                  >
                    <td className="px-4 py-2 font-mono text-gray-200">{name}</td>
                    <td className="px-4 py-2"><StatusBadge status={state.status} /></td>
                    <td className="px-4 py-2 text-gray-400 tabular-nums font-mono">{state.attempt}</td>
                    <td className="px-4 py-2 text-gray-400 tabular-nums font-mono">
                      {state.durationMs != null ? `${(state.durationMs / 1000).toFixed(1)}s` : '-'}
                    </td>
                    <td className="px-4 py-2"><CostDisplay cost={state.cost} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right: Node detail */}
        <div className="w-96 border-l border-border/50 overflow-hidden shrink-0 bg-surface">
          <NodeDetail
            nodeName={selectedNode ?? ''}
            nodeState={selectedState}
            trace={selectedTrace}
          />
        </div>
      </div>

      {/* Human input dialog */}
      {latestInputEvent && execution.status === 'waiting_for_input' && (
        <HumanInputDialog
          node={latestInputEvent.data.node}
          prompt={latestInputEvent.data.prompt}
          fields={latestInputEvent.data.fields ?? []}
          onSubmit={handleSubmitInput}
          onCancel={() => {}}
        />
      )}
    </div>
  );
}
