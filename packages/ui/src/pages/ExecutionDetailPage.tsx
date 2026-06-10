import { useState, useCallback, useEffect, useLayoutEffect, useRef, useMemo, type MouseEvent } from 'react';
import { useParams, Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, ArrowDown, X, XCircle, Pause, Play, RefreshCw, Wifi, WifiOff,
  RotateCcw, Brain, Bot, Clock, DollarSign, Terminal,
  CheckCircle, AlertCircle, Wrench, ChevronDown, ChevronRight,
  ArrowRight, AlertTriangle, Save, Activity,
  MessageSquare, FileText, FolderGit2, GitPullRequest, ExternalLink, Cpu,
  BookOpen,
  Copy, Check, Loader2,
} from 'lucide-react';
import { useExecution, type TimelineEvent, type NodeState } from '../hooks/useExecution';
import { useResizable } from '../hooks/useResizable';
import { executions as api, authHeaders, interventions as interventionsApi, repos as reposApi, system as systemApi, type RunStatus } from '../services/api';
import StatusBadge from '../components/common/StatusBadge';
import CostDisplay from '../components/common/CostDisplay';
import TokenUsageDisplay from '../components/common/TokenUsageDisplay';
import { renderMarkdown } from '../components/chat/ChatMessageList';
import LiveGraph from '../components/execution/LiveGraph';
import Timeline from '../components/execution/Timeline';
import NodeDetail from '../components/execution/NodeDetail';
import { RepoContextInjectionPanel, groupContextRefs } from '../components/execution/NodeInspector';
import ArtifactsPanel from '../components/artifacts/ArtifactsPanel';
import ArtifactViewer from '../components/artifacts/ArtifactViewer';
import { artifacts as artifactsApi, type ArtifactDoc } from '../services/api';
import GanttTimeline from '../components/execution/GanttTimeline';
import HumanInputDialog from '../components/execution/HumanInputDialog';
import CheckpointsPanel from '../components/execution/CheckpointsPanel';
import { WorkflowInterventionDialog, type WorkflowInterventionSubmit } from '../components/execution/WorkflowInterventionAction';
import { ToolCallRow, type ToolCall } from '../components/common/ToolCallLog';
import { buildTracesForTimeline } from '../utils/executionState';
import { workspaceChatPath } from '../lib/workspace-routes';

type ExecutionRightPanelView = 'node' | 'rerun' | 'artifacts';

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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function workflowContextEvaluationInFlight(summary: unknown): boolean {
  const status = String((summary as { status?: unknown } | null | undefined)?.status ?? '');
  return status === 'queued' || status === 'running';
}

function workflowFindingIdentity(finding: any): { executionId?: string; nodeName?: string; attempt: number } {
  const executionId = typeof finding?.executionId === 'string' && finding.executionId.trim()
    ? finding.executionId
    : undefined;
  let nodeName = typeof finding?.nodeName === 'string' ? finding.nodeName : undefined;
  let attempt = Number(finding?.attempt);
  if ((!Number.isFinite(attempt) || attempt <= 0) && nodeName) {
    const legacy = nodeName.match(/^(.*?)\s+(?:attempt\s*#?|#)(\d+)\s*$/i);
    if (legacy?.[1] && legacy[2]) {
      nodeName = legacy[1].trim();
      attempt = Number(legacy[2]);
    }
  }
  return {
    executionId,
    nodeName,
    attempt: Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 1,
  };
}

function workflowFindingStorageKeys(identity: { executionId?: string; nodeName?: string; attempt: number }): string[] {
  if (!identity.nodeName) return [];
  const weak = `:${identity.nodeName}:${identity.attempt}`;
  return identity.executionId ? [`${identity.executionId}:${identity.nodeName}:${identity.attempt}`] : [weak];
}

function workflowTraceLookupKeys(identity: { executionId?: string; nodeName?: string; attempt: number }): string[] {
  if (!identity.nodeName) return [];
  const weak = `:${identity.nodeName}:${identity.attempt}`;
  return identity.executionId ? [`${identity.executionId}:${identity.nodeName}:${identity.attempt}`, weak] : [weak];
}

function workflowFindingForTrace(findingsByIdentity: Map<string, any>, trace: any, fallbackExecutionId: string): any | undefined {
  const identity = {
    executionId: typeof trace?.executionId === 'string' && trace.executionId.trim() ? trace.executionId : fallbackExecutionId,
    nodeName: trace?.node,
    attempt: Number.isFinite(Number(trace?.attempt)) && Number(trace?.attempt) > 0 ? Math.floor(Number(trace.attempt)) : 1,
  };
  for (const key of workflowTraceLookupKeys(identity)) {
    const finding = findingsByIdentity.get(key);
    if (finding) return finding;
  }
  return undefined;
}

type ExecutionRepoSummary = {
  _id?: string;
  id?: string;
  name?: string;
  path?: string;
  detected?: {
    defaultBranch?: string;
    remoteUrl?: string;
  };
  status?: string;
};

function normalizeFsPath(path?: string | null): string {
  return (path ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
}

function repoForExecutionPath(path: string, repos: ExecutionRepoSummary[]): ExecutionRepoSummary | null {
  const normalizedPath = normalizeFsPath(path);
  if (!normalizedPath) return null;
  const matches = repos
    .filter((repo) => {
      const repoPath = normalizeFsPath(repo.path);
      return repoPath && (normalizedPath === repoPath || normalizedPath.startsWith(`${repoPath}/`));
    })
    .sort((a, b) => normalizeFsPath(b.path).length - normalizeFsPath(a.path).length);
  return matches[0] ?? null;
}

function ExecutionApprovalModal({
  executionId,
  intervention,
  onClose,
  onSubmitted,
}: {
  executionId: string;
  intervention: any;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  return (
    <WorkflowInterventionDialog
      run={{ executionId, runContext: { humanInput: { title: intervention.title, stage: intervention.stage, severity: intervention.severity } } }}
      intervention={intervention}
      onClose={onClose}
      onAnswer={async (answer: WorkflowInterventionSubmit) => {
        if (!answer.interventionId) throw new Error('Missing intervention id for execution approval.');
        await interventionsApi.respond(answer.interventionId, {
          decision: answer.decision,
          action_id: answer.actionId,
          field_values: answer.fieldValues,
          feedback: answer.feedback,
          answer: answer.answer,
          human_node_name: answer.humanNodeName,
          source: 'execution_page',
        });
        onSubmitted();
      }}
    />
  );
}

function looksLikeApprovalInput(
  node?: string,
  fields: Array<{ name?: string; type?: string; options?: unknown[] }> = [],
): boolean {
  const lowerNode = (node ?? '').toLowerCase();
  if (lowerNode.includes('approval') || lowerNode.endsWith('_gate') || lowerNode.includes('escalation')) {
    return true;
  }

  return fields.some((field) => {
    const name = (field.name ?? '').toLowerCase();
    const type = (field.type ?? '').toLowerCase();
    const optionValues = (field.options ?? []).map((option) => {
      if (typeof option === 'string') return option.toLowerCase();
      if (option && typeof option === 'object') {
        const record = option as { value?: unknown; label?: unknown };
        return String(record.value ?? record.label ?? '').toLowerCase();
      }
      return '';
    });
    return name.includes('approval')
      || name.includes('decision')
      || ((type === 'select' || type === 'radio') && optionValues.some(value => (
        value === 'approve'
        || value === 'request_changes'
        || value === 'reject'
        || value === 'cancel'
      )));
  });
}

function WorkflowTraceTable({
  nodeStates,
  traces,
  selectedNode,
  onSelectNode,
}: {
  nodeStates: Map<string, NodeState>;
  traces: any[];
  selectedNode: string | null;
  onSelectNode: (node: string) => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-app-card">
      <table className="w-full text-xs font-body">
        <thead className="sticky top-0 z-10">
          <tr className="bg-app-muted overline border-b border-[rgb(var(--color-border)/0.45)]">
            <th className="text-left px-4 py-2 font-medium">Node</th>
            <th className="text-left px-4 py-2 font-medium">Status</th>
            <th className="text-left px-4 py-2 font-medium">Attempt</th>
            <th className="text-left px-4 py-2 font-medium">Duration</th>
            <th className="text-left px-4 py-2 font-medium">Cost</th>
          </tr>
        </thead>
        <tbody>
          {Array.from(nodeStates.entries()).map(([name, state]) => {
            const nodeTraces = traces.filter((t: any) => t.node === name);
            const dedupMap = new Map<number, any>();
            for (const t of nodeTraces) dedupMap.set(t.attempt, t);
            const deduped = Array.from(dedupMap.values());

            let totalCost = state.cost;
            let totalDuration = state.durationMs;
            // Initialize from first trace; aggregate across all attempts below (mirrors cost/duration logic)
            let traceTokenUsage: import('../services/api').TokenUsageInfo | null =
              deduped.length > 0 ? (deduped[0]?.tokenUsage ?? null) : null;

            if (deduped.length > 1) {
              let est = 0; let act: number | null = null; let dur = 0;
              let cachedAcc: number | null = null;
              let nonCachedAcc: number | null = null;
              let outputAcc: number | null = null;
              const sumNullable = (a: number | null, b: number | null): number | null =>
                a === null && b === null ? null : (a ?? 0) + (b ?? 0);

              for (const t of deduped) {
                est += t.cost?.estimated ?? 0;
                if (t.cost?.actual != null) act = (act ?? 0) + t.cost.actual;
                dur += t.durationMs ?? 0;
                if (t.tokenUsage && typeof t.tokenUsage === 'object') {
                  cachedAcc = sumNullable(cachedAcc, t.tokenUsage.inputCachedTokens);
                  nonCachedAcc = sumNullable(nonCachedAcc, t.tokenUsage.inputNonCachedTokens);
                  outputAcc = sumNullable(outputAcc, t.tokenUsage.outputTokens);
                }
              }
              if ((state.status === 'running' || state.status === 'waiting_for_input') && state.durationMs != null) {
                dur += state.durationMs;
              }
              if (est > 0 || act != null) totalCost = { estimated: est, actual: act };
              if (dur > 0) totalDuration = dur;
              if (cachedAcc !== null || nonCachedAcc !== null || outputAcc !== null) {
                traceTokenUsage = {
                  inputCachedTokens: cachedAcc,
                  inputNonCachedTokens: nonCachedAcc,
                  outputTokens: outputAcc,
                };
              }
            }

            return (
              <tr
                key={name}
                onClick={() => onSelectNode(name)}
                className={`cursor-pointer border-b border-[rgb(var(--color-border)/0.35)] transition-colors hover:bg-accent-blue/5 ${
                  selectedNode === name ? 'bg-accent-blue/10' : ''
                }`}
              >
                <td className="px-4 py-2 font-mono text-theme-primary">{name}</td>
                <td className="px-4 py-2"><StatusBadge status={state.status} /></td>
                <td className="px-4 py-2 text-theme-secondary tabular-nums font-mono">{state.attempt}</td>
                <td className="px-4 py-2 text-theme-secondary tabular-nums font-mono">
                  {totalDuration != null ? formatDuration(totalDuration) : '-'}
                </td>
                <td className="px-4 py-2">
                  <CostDisplay cost={totalCost} />
                  {traceTokenUsage && (
                    <div className="mt-0.5">
                      <TokenUsageDisplay tokenUsage={traceTokenUsage} />
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const LOG_PAGE_SIZE = 250;

function normalizeLogTimestamp(log: any): any {
  return {
    ...log,
    timestamp: log.timestamp instanceof Date ? log.timestamp : new Date(log.timestamp ?? Date.now()),
  };
}

function logIdentity(log: any, fallbackExecutionId: string): string {
  const ts = log.timestamp instanceof Date ? log.timestamp.getTime() : new Date(log.timestamp ?? 0).getTime();
  const rowId = log._id ? String(log._id) : '';
  return rowId || [
    log.executionId ?? fallbackExecutionId,
    ts,
    log.category ?? log.type ?? '',
    log.node ?? '',
    log.tool ?? '',
    log.message ?? log.content ?? '',
  ].join('|');
}

function usePagedExecutionLogs({
  executionId,
  enabled,
  liveLogs,
  includeDescendants = true,
}: {
  executionId: string;
  enabled: boolean;
  liveLogs: any[];
  includeDescendants?: boolean;
}) {
  const [history, setHistory] = useState<any[]>([]);
  const [nextOffset, setNextOffset] = useState(0);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingInitial, setLoadingInitial] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadingRef = useRef(false);

  const loadPage = useCallback(async (offset: number, replace: boolean) => {
    if (!enabled || !executionId || loadingRef.current) return;
    loadingRef.current = true;
    if (replace) setLoadingInitial(true);
    else setLoadingOlder(true);
    setError(null);
    try {
      const result = await api.logsPage(executionId, {
        limit: LOG_PAGE_SIZE,
        offset,
        include_descendants: includeDescendants,
      });
      const items = (result.items ?? []).map(normalizeLogTimestamp);
      setHistory(prev => {
        const combined = replace ? items : [...items, ...prev];
        const seen = new Set<string>();
        const merged: any[] = [];
        for (const log of combined) {
          const k = logIdentity(log, executionId);
          if (seen.has(k)) continue;
          seen.add(k);
          merged.push(normalizeLogTimestamp(log));
        }
        merged.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
        return merged;
      });
      setNextOffset(offset + items.length);
      setHasOlder(Boolean(result.hasMore));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load logs');
    } finally {
      loadingRef.current = false;
      if (replace) setLoadingInitial(false);
      else setLoadingOlder(false);
    }
  }, [enabled, executionId, includeDescendants]);

  useEffect(() => {
    setHistory([]);
    setNextOffset(0);
    setHasOlder(false);
    setError(null);
    loadingRef.current = false;
    if (enabled && executionId) void loadPage(0, true);
  }, [enabled, executionId, includeDescendants, loadPage]);

  const loadOlder = useCallback(async () => {
    if (!hasOlder || loadingRef.current) return;
    await loadPage(nextOffset, false);
  }, [hasOlder, loadPage, nextOffset]);

  const visibleLogs = useMemo(() => {
    const latestHistoryTime = history.length > 0
      ? history[history.length - 1].timestamp.getTime()
      : Number.NEGATIVE_INFINITY;
    const liveTail = liveLogs
      .map(normalizeLogTimestamp)
      .filter(log => history.length === 0 || log.timestamp.getTime() >= latestHistoryTime);
    const seen = new Set<string>();
    const merged: any[] = [];
    for (const log of [...history, ...liveTail]) {
      const k = logIdentity(log, executionId);
      if (seen.has(k)) continue;
      seen.add(k);
      merged.push(normalizeLogTimestamp(log));
    }
    merged.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    return merged;
  }, [executionId, history, liveLogs]);

  return {
    visibleLogs,
    loadedCount: history.length,
    hasOlder,
    loadingInitial,
    loadingOlder,
    error,
    loadOlder,
  };
}

function ExecutionLogsOverlay({
  open,
  executionId,
  logs,
  logFilter,
  workflowNodes,
  traces,
  onClose,
  onNodeFilterChange,
}: {
  open: boolean;
  executionId: string;
  logs: any[];
  logFilter: string | null;
  workflowNodes: string[];
  traces: any[];
  onClose: () => void;
  onNodeFilterChange: (node: string | null) => void;
}) {
  const {
    visibleLogs,
    loadedCount,
    hasOlder,
    loadingInitial,
    loadingOlder,
    error,
    loadOlder,
  } = usePagedExecutionLogs({ executionId, enabled: open, liveLogs: logs, includeDescendants: true });

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/30 p-6" role="dialog" aria-modal="true" aria-label="Execution logs">
      <button className="absolute inset-0" type="button" onClick={onClose} aria-label="Close logs" />
      <div className="relative ml-auto flex h-full w-[min(860px,calc(100vw-48px))] flex-col overflow-hidden rounded-lg border border-app-strong bg-app-card shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-app px-4 py-3">
          <div>
            <div className="text-[13px] font-semibold text-theme-primary">Logs</div>
            <div className="font-mono text-[10px] text-theme-muted">
              {loadingInitial ? 'Loading latest logs...' : `${visibleLogs.length} shown · latest ${Math.min(loadedCount || LOG_PAGE_SIZE, LOG_PAGE_SIZE)} by default`}
              {logs.length > 0 ? ' · live tail merged' : ''}
            </div>
          </div>
          <div className="ml-auto font-mono text-[10px] text-theme-muted">
            {hasOlder ? 'Scroll up loads 250 older' : 'Full history loaded'}
          </div>
          <button type="button" onClick={onClose} className="rounded p-1.5 text-theme-muted hover:bg-app-muted hover:text-theme-primary" aria-label="Close logs">
            <X className="h-4 w-4" />
          </button>
        </div>
        {error && (
          <div className="border-b border-accent-red/30 bg-accent-red/10 px-4 py-2 font-mono text-[11px] text-accent-red">
            {error}
          </div>
        )}
        <div className="min-h-0 flex-1">
          <Timeline
            logs={visibleLogs}
            nodeFilter={logFilter}
            onNodeFilterChange={onNodeFilterChange}
            workflowNodes={workflowNodes}
            hasOlderLogs={hasOlder}
            loadingOlderLogs={loadingOlder}
            onLoadOlderLogs={loadOlder}
            traces={traces}
          />
        </div>
      </div>
    </div>
  );
}

function ExecutionLogsPanel({
  executionId,
  logs,
  logFilter,
  workflowNodes,
  traces,
  onNodeFilterChange,
}: {
  executionId: string;
  logs: any[];
  logFilter: string | null;
  workflowNodes: string[];
  traces: any[];
  onNodeFilterChange: (node: string | null) => void;
}) {
  const {
    visibleLogs,
    loadedCount,
    hasOlder,
    loadingInitial,
    loadingOlder,
    error,
    loadOlder,
  } = usePagedExecutionLogs({ executionId, enabled: Boolean(executionId), liveLogs: logs, includeDescendants: true });

  return (
    <div className="flex h-full min-h-0 flex-col bg-app-card">
      <div className="shrink-0 border-b border-app px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[12px] font-semibold text-theme-primary">Logs</div>
            <div className="truncate font-mono text-[10px] text-theme-muted">
              {loadingInitial ? 'Loading latest logs...' : `${visibleLogs.length} shown · latest ${Math.min(loadedCount || LOG_PAGE_SIZE, LOG_PAGE_SIZE)} by default`}
              {logs.length > 0 ? ' · live tail' : ''}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] text-theme-muted">
            {hasOlder ? 'Scroll up loads 250 older' : 'Full history loaded'}
          </div>
        </div>
      </div>
      {error && (
        <div className="shrink-0 border-b border-accent-red/30 bg-accent-red/10 px-3 py-2 font-mono text-[11px] text-accent-red">
          {error}
        </div>
      )}
      <div className="min-h-0 flex-1">
        <Timeline
          logs={visibleLogs}
          nodeFilter={logFilter}
          onNodeFilterChange={onNodeFilterChange}
          workflowNodes={workflowNodes}
          hasOlderLogs={hasOlder}
          loadingOlderLogs={loadingOlder}
          onLoadOlderLogs={loadOlder}
          traces={traces}
        />
      </div>
    </div>
  );
}

function WorkflowArtifactsPanel({
  rootId,
}: {
  rootId: string;
}) {
  const [selected, setSelected] = useState<ArtifactDoc | null>(null);
  const [panelKey, setPanelKey] = useState(0);
  const { size: listWidth, handleMouseDown: listResizeStart } = useResizable({
    direction: 'horizontal',
    initialSize: 260,
    minSize: 220,
    maxSize: 420,
    side: 'start',
  });

  function syncSelection(artifacts: ArtifactDoc[]) {
    if (artifacts.length === 0) {
      setSelected(null);
      return;
    }
    setSelected(current => {
      if (current && artifacts.some(item => item.artifactId === current.artifactId)) return current;
      return artifacts[0];
    });
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this artifact? The file is removed from disk.')) return;
    try {
      await artifactsApi.delete(id);
      setSelected(null);
      setPanelKey(value => value + 1);
    } catch (err) {
      alert(`Failed to delete: ${(err as Error).message}`);
    }
  }

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-app-card">
      <div className="relative flex h-full shrink-0 flex-col border-r border-app" style={{ width: listWidth }}>
        <ArtifactsPanel
          key={panelKey}
          rootType="workflow"
          rootId={rootId}
          selectedId={selected?.artifactId}
          onSelect={setSelected}
          onItemsChange={syncSelection}
        />
        <div
          className="group absolute bottom-0 right-0 top-0 z-20 w-2 cursor-col-resize"
          onMouseDown={listResizeStart}
          title="Drag to resize list"
        >
          <div className="absolute bottom-0 left-1/2 top-0 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-accent-blue/60" />
        </div>
      </div>
      <div className="min-w-0 flex-1 bg-app-card">
        {selected ? (
          <ArtifactViewer
            artifact={selected}
            onClose={() => setSelected(null)}
            onDelete={() => handleDelete(selected.artifactId)}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center">
            <div>
              <FileText className="mx-auto mb-2 h-5 w-5 text-theme-subtle" />
              <div className="text-xs font-semibold text-theme-primary">No artifact selected</div>
              <div className="mt-1 text-[11px] text-theme-muted">Select an artifact to preview it here.</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
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

function resolveToolCallForLog(log: any, toolCalls: ToolCall[]): ToolCall | undefined {
  const byUseId = new Map<string, ToolCall>();
  const byTool = new Map<string, ToolCall[]>();
  for (const tc of toolCalls) {
    if (tc.toolUseId) byUseId.set(tc.toolUseId, tc);
    const arr = byTool.get(tc.tool) ?? [];
    arr.push(tc);
    byTool.set(tc.tool, arr);
  }
  if (log.toolUseId && byUseId.has(log.toolUseId)) return byUseId.get(log.toolUseId);
  if (!log.tool) return undefined;
  const candidates = byTool.get(log.tool) ?? [];
  if (candidates.length === 0) return undefined;
  if (!log.timestamp) return candidates[0];
  const logTs = new Date(log.timestamp).getTime();
  let best: ToolCall | undefined;
  let bestDelta = Infinity;
  for (const candidate of candidates) {
    const delta = Math.abs(new Date(candidate.startedAt).getTime() - logTs);
    if (delta < bestDelta) {
      best = candidate;
      bestDelta = delta;
    }
  }
  return bestDelta <= 5000 ? best : undefined;
}

function AgentLogsDrawer({
  open,
  onClose,
  executionId,
  logs,
  toolCalls,
  executionStatus,
}: {
  open: boolean;
  onClose: () => void;
  executionId: string;
  logs: any[];
  toolCalls: ToolCall[];
  executionStatus: string;
}) {
  const {
    visibleLogs,
    loadedCount,
    hasOlder,
    loadingInitial,
    loadingOlder,
    error,
    loadOlder,
  } = usePagedExecutionLogs({ executionId, enabled: open, liveLogs: logs, includeDescendants: true });
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const loadOlderInFlight = useRef(false);
  const prependAnchor = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);

  useEffect(() => {
    if (!open) setAutoScroll(true);
  }, [open]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !autoScroll) return;
    el.scrollTop = el.scrollHeight;
  }, [autoScroll, visibleLogs.length]);

  useLayoutEffect(() => {
    const anchor = prependAnchor.current;
    const el = containerRef.current;
    if (!anchor || !el) return;
    el.scrollTop = anchor.scrollTop + Math.max(0, el.scrollHeight - anchor.scrollHeight);
    prependAnchor.current = null;
  }, [visibleLogs.length]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
    if (el.scrollTop < 80 && hasOlder && !loadingOlder && !loadOlderInFlight.current) {
      loadOlderInFlight.current = true;
      prependAnchor.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
      Promise.resolve(loadOlder()).finally(() => {
        loadOlderInFlight.current = false;
        requestAnimationFrame(() => {
          if (prependAnchor.current) prependAnchor.current = null;
        });
      });
    }
  };

  if (!open) return null;
  return (
      <aside className="fixed bottom-0 right-0 top-0 z-50 flex w-[34rem] max-w-[calc(100vw-2rem)] flex-col border-l border-app bg-app-card shadow-[-24px_0_60px_rgba(0,0,0,0.28)]" aria-label="Agent logs">
        <div className="flex items-center justify-between gap-3 border-b border-app px-4 py-3">
          <div>
            <div className="text-[13px] font-semibold text-theme-primary">Logs</div>
            <div className="font-mono text-[10px] text-theme-muted">
              {loadingInitial ? 'Loading latest logs...' : `${visibleLogs.length} shown · latest ${Math.min(loadedCount || LOG_PAGE_SIZE, LOG_PAGE_SIZE)} by default`}
              {executionStatus === 'running' ? ' · live tail' : ''}
            </div>
          </div>
          <div className="ml-auto font-mono text-[10px] text-theme-muted">
            {hasOlder ? 'Scroll up loads 250 older' : 'Full history loaded'}
          </div>
          <button type="button" onClick={onClose} className="rounded p-1.5 text-theme-muted hover:bg-app-muted hover:text-theme-primary" aria-label="Close logs">
            <X className="h-4 w-4" />
          </button>
        </div>
        {error && (
          <div className="border-b border-accent-red/30 bg-accent-red/10 px-4 py-2 font-mono text-[11px] text-accent-red">
            {error}
          </div>
        )}
        <div
          ref={containerRef}
          className="min-h-0 flex-1 overflow-y-auto bg-[rgb(var(--color-editor-background))] p-4"
          onScroll={handleScroll}
        >
          {(hasOlder || loadingOlder) && (
            <div className="px-2 pb-3 text-center font-mono text-[10px] text-theme-muted">
              {loadingOlder ? 'Loading older logs...' : 'Scroll up for older logs'}
            </div>
          )}
          {visibleLogs.length === 0 && executionStatus === 'running' && (
            <div className="text-xs text-theme-subtle font-mono py-3 animate-pulse">Waiting for activity...</div>
          )}
          {visibleLogs.length === 0 && executionStatus !== 'running' && (
            <div className="text-xs text-theme-muted font-mono">No logs captured for this run.</div>
          )}
          {visibleLogs.map((log: any, index: number) => (
            <LogRow key={logIdentity(log, executionId) || index} log={log} toolCall={resolveToolCallForLog(log, toolCalls)} />
          ))}
        </div>
        {!autoScroll && visibleLogs.length > 0 && (
          <button
            type="button"
            title="Scroll to latest"
            onClick={() => {
              setAutoScroll(true);
              if (containerRef.current) containerRef.current.scrollTop = containerRef.current.scrollHeight;
            }}
            className="absolute bottom-3 right-3 z-10 btn-primary inline-flex items-center gap-1 px-2 py-1 text-[10px] shadow-lg"
          >
            <ArrowDown className="h-3 w-3" /> Latest
          </button>
        )}
      </aside>
  );
}

function AgentResumeDrawer({
  open,
  onClose,
  agentName,
  prompt,
  busy,
  onPromptChange,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  agentName: string;
  prompt: string;
  busy: boolean;
  onPromptChange: (value: string) => void;
  onSubmit: () => void;
}) {
  if (!open) return null;

  const ready = prompt.trim().length > 0 && !busy;

  return (
      <aside className="fixed bottom-0 right-0 top-0 z-50 flex w-[34rem] max-w-[calc(100vw-2rem)] flex-col border-l border-app bg-app-card shadow-[-24px_0_60px_rgba(0,0,0,0.28)]" aria-label="Resume execution">
        <div className="flex items-start justify-between gap-4 border-b border-app px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-md border border-app bg-app text-accent">
                <Play className="h-4 w-4" />
              </span>
              <div>
                <div className="text-[14px] font-semibold text-theme-primary">Resume run</div>
                <div className="mt-0.5 text-[12px] text-theme-muted">
                  Continue <span className="font-medium text-theme-secondary">{agentName}</span> from the saved session.
                </div>
              </div>
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1.5 text-theme-muted hover:bg-app-muted hover:text-theme-primary" aria-label="Close resume panel">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <label className="block">
            <span className="text-[12px] font-semibold text-theme-primary">Follow-up prompt</span>
            <textarea
              autoFocus
              value={prompt}
              onChange={e => onPromptChange(e.target.value)}
              onKeyDown={e => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && ready) onSubmit();
              }}
              rows={8}
              placeholder="Tell Allen exactly what to continue, retry, or change in this execution."
              className="mt-2 min-h-[180px] w-full resize-none rounded-md border border-app bg-app px-3 py-2.5 text-[13px] leading-relaxed text-theme-primary outline-none transition-colors placeholder:text-theme-subtle focus:border-accent focus:shadow-[var(--focus-ring)]"
            />
          </label>

          <div className="mt-4 rounded-md border border-app bg-app px-3 py-3 text-[12px] leading-relaxed text-theme-muted">
            Allen keeps the prior agent session when available. Use this for a focused continuation, not a fresh unrelated task.
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-app bg-app-card px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 items-center rounded-md border border-app bg-app px-3 text-[12px] font-medium text-theme-secondary transition-colors hover:border-app-strong hover:text-theme-primary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={!ready}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-accent px-4 text-[12px] font-semibold text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Play className="h-3.5 w-3.5" />
            {busy ? 'Resuming...' : 'Resume execution'}
          </button>
        </div>
      </aside>
  );
}

export function agentTraceHasContext(trace: any): boolean {
  return Boolean(
    trace?.contextLifecycleAttempt
    || trace?.contextAttemptId
    || trace?.repoKnowledgeInjected
    || trace?.contextUsage,
  );
}

export function agentTraceContextCount(trace: any): number | null {
  if (!trace) return null;
  if (trace.contextLifecycleAttempt) {
    const groups = groupContextRefs(trace.contextLifecycleAttempt);
    if (groups.injected.length > 0) return groups.injected.length;
    if (groups.selected.length > 0) return groups.selected.length;
    if (groups.filtered.length > 0) return groups.filtered.length;
  }
  const legacyInjected = trace.repoKnowledgeInjected?.contextInjection?.injectedRefs?.length
    ?? trace.repoKnowledgeInjected?.contextInjection?.providerNativeRefs?.length
    ?? 0;
  if (legacyInjected > 0) return legacyInjected;
  if (trace.contextAttemptId) return 1;
  return null;
}

export function agentContextAttemptCount(contextAttempt: any): number | null {
  if (!contextAttempt) return null;
  const summaryCounts = [
    Number(contextAttempt.injectedCount ?? 0),
    Number(contextAttempt.selectedCount ?? contextAttempt.preselectedCount ?? 0),
    Number(contextAttempt.filteredCount ?? 0),
    Number(contextAttempt.candidateCount ?? 0),
  ].filter((value) => Number.isFinite(value) && value > 0);
  if (summaryCounts.length > 0) return summaryCounts[0];
  const groups = groupContextRefs(contextAttempt);
  if (groups.injected.length > 0) return groups.injected.length;
  if (groups.selected.length > 0) return groups.selected.length;
  if (groups.filtered.length > 0) return groups.filtered.length;
  return null;
}

export function findAgentContextAttempt(report: any, agentName: string, selectedAttempt: number): any | null {
  const attempts = Array.isArray(report?.nodeAttempts)
    ? report.nodeAttempts
    : Array.isArray(report?.packets)
      ? report.packets
      : Array.isArray(report?.nodeSummaries)
        ? report.nodeSummaries
        : [];
  const named = attempts.filter((attempt: any) => {
    const nodeName = String(attempt?.nodeName ?? attempt?.node ?? attempt?.agent ?? '');
    return nodeName === agentName;
  });
  if (named.length === 0) return null;
  const exact = named.find((attempt: any) => Number(attempt?.attempt ?? 1) === selectedAttempt);
  if (exact) return exact;
  return [...named].sort((a: any, b: any) => {
    const attemptDiff = Number(b?.attempt ?? 1) - Number(a?.attempt ?? 1);
    if (attemptDiff !== 0) return attemptDiff;
    return new Date(b?.startedAt ?? b?.createdAt ?? 0).getTime() - new Date(a?.startedAt ?? a?.createdAt ?? 0).getTime();
  })[0] ?? null;
}

export function agentHasContextEvidence(trace: any, contextAttempt?: any | null, contextExpected = false): boolean {
  return agentTraceHasContext(trace) || Boolean(contextAttempt?.contextAttemptId ?? contextAttempt?.packetId) || contextExpected;
}

function AgentContextDrawer({
  open,
  onClose,
  trace,
  contextAttempt,
  contextReportLoading,
  contextReportError,
  contextExpected,
  contextEngineEnabled,
}: {
  open: boolean;
  onClose: () => void;
  trace: any | null;
  contextAttempt?: any | null;
  contextReportLoading?: boolean;
  contextReportError?: string | null;
  contextExpected?: boolean;
  contextEngineEnabled: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  const hydratedAttempt = trace?.contextLifecycleAttempt ?? contextAttempt;
  const effectiveAttemptId = trace?.contextAttemptId ?? contextAttempt?.contextAttemptId ?? contextAttempt?.packetId;
  const hasPacketDetails = Boolean(hydratedAttempt || trace?.repoKnowledgeInjected);
  const hasContextAttemptId = Boolean(effectiveAttemptId);
  const effectiveContextEnabled = contextEngineEnabled || agentTraceHasContext(trace) || Boolean(contextAttempt);
  const usageMissing = Boolean(hasContextAttemptId && !trace?.contextUsageTraceId && trace?.status !== 'running' && contextAttempt?.status === 'ready');
  const contextStatus = String(contextAttempt?.status ?? '');

  return (
    <div className="fixed inset-0 z-50 bg-black/30 p-6" role="dialog" aria-modal="true" aria-label="Agent context injection">
      <button className="absolute inset-0" type="button" onClick={onClose} aria-label="Close context" />
      <aside
        className="relative ml-auto flex h-full w-[min(940px,calc(100vw-48px))] flex-col overflow-hidden rounded-lg border border-app-strong bg-app-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-app px-4 py-3">
          <div>
            <div className="text-[13px] font-semibold text-theme-primary">Context injection</div>
            <div className="font-mono text-[10px] text-theme-muted">
              {trace || contextAttempt ? `Attempt ${trace?.attempt ?? contextAttempt?.attempt ?? 1}` : 'No attempt selected'}
              {effectiveAttemptId ? ` · ${String(effectiveAttemptId).slice(0, 8)}` : ''}
              {contextStatus ? ` · ${contextStatus}` : ''}
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1.5 text-theme-muted hover:bg-app-muted hover:text-theme-primary" aria-label="Close context">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {!effectiveContextEnabled ? (
            <div className="text-xs text-theme-muted font-mono">Context injection is disabled and no context packet was captured for this attempt.</div>
          ) : hasPacketDetails ? (
            <div className="space-y-3">
              <RepoContextInjectionPanel
                contextAttempt={hydratedAttempt}
                repoKnowledgeInjected={trace?.repoKnowledgeInjected}
                contextEngineEnabled={effectiveContextEnabled}
                title="Repo context injection"
                emptyText="No repo context packet details were hydrated for this agent attempt."
              />
              {contextStatus && contextStatus !== 'ready' && (
                <div className="rounded-md border border-app bg-app-muted/40 px-3 py-2 text-[11px] font-mono text-theme-secondary">
                  Context attempt status: {contextStatus}
                  {contextAttempt?.error ? ` · ${contextAttempt.error}` : ''}
                </div>
              )}
              {usageMissing && (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] font-mono text-accent-yellow">
                  Context was injected, but no usage trace was recorded for this attempt. This can happen for older failed spawned-agent runs.
                </div>
              )}
            </div>
          ) : hasContextAttemptId ? (
            <div className="space-y-2">
              <div className="rounded-md border border-app bg-app-muted/40 px-3 py-2 text-[11px] font-mono text-theme-secondary">
                Context packet id exists, but packet details were not hydrated for this trace.
              </div>
              <div className="text-[10px] font-mono text-theme-muted">
                contextAttemptId: {effectiveAttemptId}
              </div>
            </div>
          ) : contextReportLoading ? (
            <div className="text-xs text-theme-muted font-mono animate-pulse">Checking context injection trace...</div>
          ) : contextReportError ? (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] font-mono text-accent-yellow">
              Context usage report could not be loaded: {contextReportError}
            </div>
          ) : contextExpected ? (
            <div className="text-xs text-theme-muted font-mono">No context packet has been captured yet for this agent attempt.</div>
          ) : (
            <div className="text-xs text-theme-muted font-mono">No repo context packet was captured for this agent attempt.</div>
          )}
        </div>
      </aside>
    </div>
  );
}

function phaseLabel(value: string | undefined): string {
  return (value ?? 'running').replace(/_/g, ' ');
}

function statusIcon(status: string | undefined) {
  if (status === 'completed') return <CheckCircle className="w-3.5 h-3.5 text-accent-green" />;
  if (status === 'failed') return <AlertCircle className="w-3.5 h-3.5 text-accent-red" />;
  if (status === 'waiting_for_input') return <AlertTriangle className="w-3.5 h-3.5 text-accent-yellow" />;
  if (status === 'running') return <RefreshCw className="w-3.5 h-3.5 text-accent animate-spin" />;
  return <span className="w-2 h-2 rounded-full bg-theme-subtle" />;
}

function TraceRail({
  workflowNodes,
  nodeStates,
  selectedNode,
  onSelectNode,
  children,
}: {
  workflowNodes: string[];
  nodeStates: Map<string, NodeState>;
  selectedNode: string | null;
  onSelectNode: (node: string | null) => void;
  children: any[];
}) {
  const names = workflowNodes.length > 0
    ? workflowNodes
    : Array.from(nodeStates.keys());
  return (
    <aside className="w-[280px] shrink-0 border-r border-app bg-surface overflow-y-auto">
      <div className="px-4 py-3 border-b border-app flex items-center justify-between">
        <div>
          <div className="text-[13px] font-semibold text-theme-primary">Trace</div>
          <div className="text-[10px] text-theme-subtle font-mono">{names.length} nodes · {children.length} child agents</div>
        </div>
      </div>
      <div className="p-3">
        {names.map((name, index) => {
          const state = nodeStates.get(name);
          const status = state?.status ?? 'pending';
          const active = selectedNode === name;
          const spawnCount = children.filter(c => c.parentCaller === name).length;
          return (
            <div key={name}>
              <button
                onClick={() => onSelectNode(name)}
                className={`w-full text-left rounded-md border px-3 py-2 transition-colors ${
                  active
                    ? 'border-accent bg-accent-soft'
                    : 'border-transparent hover:border-app hover:bg-app-muted/50'
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  {statusIcon(status)}
                  <div className="min-w-0 flex-1">
                    <div className="text-[12px] font-mono text-theme-primary truncate">{name}</div>
                    <div className="mt-0.5 flex items-center gap-2 text-[10px] text-theme-subtle font-mono">
                      <span>{status}</span>
                      {state?.durationMs != null && <span>{formatDuration(state.durationMs)}</span>}
                      {spawnCount > 0 && <span>{spawnCount} agents</span>}
                    </div>
                  </div>
                </div>
              </button>
              {index < names.length - 1 && <div className="ml-[18px] h-3 border-l border-app" />}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function ContextRow({
  icon,
  label,
  value,
  href,
  external,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  href?: string;
  external?: boolean;
}) {
  const content = (
    <div className="flex items-center gap-2 min-w-0 rounded-md px-2 py-1.5 hover:bg-app-muted/60 transition-colors">
      <span className="text-theme-muted shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[9px] uppercase tracking-wide text-theme-subtle font-mono">{label}</div>
        <div className="text-[11px] text-theme-primary truncate">{value}</div>
      </div>
      {href && <ExternalLink className="w-3 h-3 text-theme-subtle shrink-0" />}
    </div>
  );
  if (!href) return content;
  return (
    <a href={href} target={external ? '_blank' : undefined} rel={external ? 'noopener noreferrer' : undefined}>
      {content}
    </a>
  );
}

function RunContextPanel({
  runContext,
  execution,
  pendingIntervention,
  artifactCount,
  onRerunContextEvaluation,
  contextEvaluationBusy,
  contextEngineEnabled,
}: {
  runContext: RunStatus | null;
  execution: any;
  pendingIntervention?: any;
  artifactCount: number | null;
  onRerunContextEvaluation?: () => void;
  contextEvaluationBusy?: boolean;
  contextEngineEnabled?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const percent = runContext?.progress.percent ?? 0;
  const phase = runContext?.progress.phase ?? execution.status;
  const workflowContextEval = runContext?.execution.contextWorkflowEvaluation;
  const workflowContextScore = workflowContextEval?.result?.scores?.overall;
  const showWorkflowContextEval = Boolean(contextEngineEnabled && (workflowContextEval || ['completed', 'failed', 'cancelled'].includes(String(execution.status))));
  return (
    <section className="shrink-0 border-b border-app bg-surface">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="w-full px-4 py-2.5 border-b border-app flex items-center justify-between gap-3 text-left hover:bg-app-muted/40 transition-colors"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {expanded ? <ChevronDown className="w-3.5 h-3.5 text-theme-muted shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-theme-muted shrink-0" />}
            <div className="text-[13px] font-semibold text-theme-primary">Context</div>
            <StatusBadge status={execution.status} />
          </div>
          <div className="mt-1 flex items-center gap-2 min-w-0 text-[10px] text-theme-subtle font-mono">
            <span className="capitalize shrink-0">{phaseLabel(phase)}</span>
            <span className="text-theme-subtle">·</span>
            <span className="truncate">{runContext?.progress.currentStep ?? 'current run'}</span>
            <span className="shrink-0">{Math.round(Math.max(0, Math.min(100, percent)))}%</span>
          </div>
        </div>
      </button>
      {expanded && <div className="max-h-[48vh] overflow-y-auto p-3 space-y-3">
        <div>
          <div className="flex items-center justify-between text-[10px] font-mono text-theme-subtle mb-1">
            <span>{runContext?.progress.currentStep ?? 'current run'}</span>
            <span>{runContext?.progress.label ?? `${execution.completedNodes?.length ?? 0} nodes`}</span>
          </div>
          <div className="h-1.5 rounded-full bg-app-muted overflow-hidden">
            <div className="h-full bg-accent transition-all" style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
          </div>
        </div>

        <div className="space-y-1">
          {runContext?.linear && (
            <ContextRow
              icon={<ExternalLink className="w-3.5 h-3.5" />}
              label="Linear"
              value={runContext.linear.identifier ?? runContext.linear.title ?? 'Ticket'}
              href={runContext.linear.url}
              external
            />
          )}
          {runContext?.workspace && (
            <ContextRow
              icon={<FolderGit2 className="w-3.5 h-3.5" />}
              label="Workspace"
              value={`${runContext.workspace.repoName ?? runContext.workspace.name ?? 'workspace'} · ${runContext.workspace.branch ?? 'branch'}`}
              href={runContext.workspace.id ? workspaceChatPath(runContext.workspace.id) : undefined}
            />
          )}
          {runContext?.pullRequest && (
            <ContextRow
              icon={<GitPullRequest className="w-3.5 h-3.5" />}
              label="Pull request"
              value={runContext.pullRequest.number ? `#${runContext.pullRequest.number} · ${runContext.pullRequest.status ?? 'open'}` : runContext.pullRequest.title ?? 'PR'}
              href={runContext.pullRequest.url ?? undefined}
              external
            />
          )}
          <ContextRow
            icon={<FileText className="w-3.5 h-3.5" />}
            label="Artifacts"
            value={`${runContext?.artifacts.length ?? artifactCount ?? 0} saved`}
          />
          {showWorkflowContextEval && (
            <div className="rounded-md border border-app bg-app-muted/35 px-2 py-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex items-start gap-2">
                  <Brain className="w-3.5 h-3.5 text-theme-muted shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <div className="text-[9px] uppercase tracking-wide text-theme-subtle font-mono">Context eval</div>
                    <div className="text-[11px] text-theme-primary">
                      {[
                        workflowContextEval?.status ?? 'not queued',
                        workflowContextScore == null ? null : `overall ${Math.round(workflowContextScore * 100)}%`,
                        workflowContextEval?.stale ? 'stale' : null,
                      ].filter(Boolean).join(' · ')}
                    </div>
                    {workflowContextEval?.result?.summary && (
                      <div className="mt-1 max-h-[140px] overflow-y-auto rounded border border-app bg-surface/60 p-2 text-[10px] leading-relaxed text-theme-secondary whitespace-pre-wrap">
                        {workflowContextEval.result.summary}
                      </div>
                    )}
                    {workflowContextEval?.staleReason && (
                      <div className="mt-1 max-h-24 overflow-y-auto rounded border border-accent-yellow/30 bg-yellow-500/10 p-2 text-[10px] leading-relaxed text-accent-yellow whitespace-pre-wrap">
                        {workflowContextEval.staleReason}
                      </div>
                    )}
                    {workflowContextEval?.error && (
                      <div className="mt-1 max-h-24 overflow-y-auto rounded border border-accent-red/30 bg-red-500/10 p-2 text-[10px] leading-relaxed text-accent-red whitespace-pre-wrap">
                        {workflowContextEval.error}
                      </div>
                    )}
                    {workflowContextEval?.audit && (
                      <ContextEvalAuditDetails
                        audit={workflowContextEval.audit}
                        normalizedResult={workflowContextEval.result}
                      />
                    )}
                  </div>
                </div>
                {onRerunContextEvaluation && (
                  <button
                    type="button"
                    onClick={onRerunContextEvaluation}
                    disabled={contextEvaluationBusy}
                    className="btn-ghost text-[10px] px-2 py-1 shrink-0"
                    title="Rerun workflow context evaluation"
                  >
                    <RefreshCw className={`w-3 h-3 ${contextEvaluationBusy ? 'animate-spin' : ''}`} />
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {(pendingIntervention || runContext?.humanInput?.required) && (
          <div className="rounded-md border border-accent-yellow/35 bg-yellow-500/10 px-3 py-2">
            <div className="flex items-center gap-2 text-[11px] font-semibold text-accent-yellow">
              <AlertTriangle className="w-3.5 h-3.5" />
              Human input
            </div>
            <div className="mt-1 text-[11px] text-theme-secondary line-clamp-2">
              {pendingIntervention?.title ?? runContext?.humanInput?.title ?? 'Waiting for input'}
            </div>
          </div>
        )}

        {runContext?.childAgents && runContext.childAgents.length > 0 && (
          <div>
            <div className="overline mb-1">Child Agents</div>
            <div className="space-y-1">
              {runContext.childAgents.slice(0, 5).map(child => (
                <Link key={child.executionId} to={`/executions/${child.executionId}`} className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 bg-app-muted/50 hover:bg-app-muted">
                  <span className="text-[11px] font-mono text-theme-primary truncate">{child.agentName}</span>
                  <span className="text-[10px] font-mono text-theme-subtle shrink-0">{child.status}</span>
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>}
    </section>
  );
}

function ContextEvalAuditDetails({
  audit,
  normalizedResult,
}: {
  audit: Record<string, any>;
  normalizedResult?: Record<string, any>;
}) {
  const packedEvidenceJson = audit.packedEvidencePayload ? JSON.stringify(audit.packedEvidencePayload, null, 2) : '';
  const fullEvidenceJson = audit.evidencePayload ? JSON.stringify(audit.evidencePayload, null, 2) : '';
  const normalizedJson = normalizedResult ? JSON.stringify(normalizedResult, null, 2) : '';
  return (
    <div className="mt-2 space-y-1.5">
      <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-[10px] font-mono text-theme-subtle">
        <span>judge</span>
        <span className="text-theme-secondary truncate">{[audit.judgeProvider, audit.judgeModel].filter(Boolean).join(' / ') || '—'}</span>
        <span>duration</span>
        <span className="text-theme-secondary">{audit.judgeDurationMs == null ? '—' : `${Math.round(audit.judgeDurationMs)}ms`}</span>
        <span>prompt</span>
        <span className="text-theme-secondary">{audit.promptChars == null ? '—' : `${audit.promptChars} chars`}</span>
        <span>evidence</span>
        <span className="text-theme-secondary">
          {audit.evidenceStats?.packedChars == null
            ? '—'
            : `${audit.evidenceStats.packedChars} / ${audit.evidenceStats.originalChars ?? '?'} chars`}
        </span>
        <span>sha256</span>
        <span className="text-theme-secondary truncate">{audit.promptSha256 ?? '—'}</span>
      </div>
      {audit.evidenceTruncated && (
        <div className="rounded border border-accent-yellow/30 bg-yellow-500/10 p-1.5 text-[10px] text-accent-yellow">
          {audit.evidenceStats
            ? 'Evidence was packed and some per-node sections were shortened before the judge call.'
            : 'Evidence JSON was truncated before the judge call.'}
        </div>
      )}
      <AuditDisclosure title="Evaluator prompt" content={audit.promptPreview} />
      <AuditDisclosure title="Packing stats" content={audit.evidenceStats ? JSON.stringify(audit.evidenceStats, null, 2) : ''} />
      <AuditDisclosure title="Packed evidence sent to judge" content={packedEvidenceJson} />
      <AuditDisclosure title="Full stored evidence payload" content={fullEvidenceJson} />
      <AuditDisclosure title="Raw LLM response" content={audit.rawJudgeResponse} />
      <AuditDisclosure title="Normalized result" content={normalizedJson} />
    </div>
  );
}

function AuditDisclosure({ title, content }: { title: string; content?: string }) {
  if (!content) return null;
  return (
    <details className="rounded border border-app bg-surface/60">
      <summary className="cursor-pointer px-2 py-1 text-[10px] font-mono uppercase tracking-wide text-theme-subtle hover:text-theme-secondary">
        {title}
      </summary>
      <pre className="max-h-[220px] overflow-auto border-t border-app p-2 text-[10px] leading-relaxed text-theme-secondary whitespace-pre-wrap">
        {content}
      </pre>
    </details>
  );
}

// ── Agent Execution View (single-node) ──

function AgentResourceCard({
  icon,
  title,
  subtitle,
  href,
  external,
  copyText,
}: {
  icon: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  href?: string;
  external?: boolean;
  copyText?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copyValue = copyText?.trim();
  const handleCopy = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!copyValue) return;
    try {
      if (window.allenDesktop?.writeClipboardText) {
        await window.allenDesktop.writeClipboardText(copyValue);
      } else {
        await navigator.clipboard.writeText(copyValue);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  const content = (
    <div className="flex min-w-0 items-center gap-3 rounded-md px-2 py-2 text-theme-muted transition-colors hover:bg-app-muted/45 hover:text-theme-primary">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-app bg-app">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[12.5px] font-medium text-theme-primary">{title}</span>
        </div>
        {subtitle && <div className="truncate text-[11px] text-theme-muted">{subtitle}</div>}
      </div>
      {copyValue && (
        <button
          type="button"
          onClick={handleCopy}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-theme-muted transition-colors hover:bg-app-card hover:text-theme-primary"
          title={copied ? 'Copied' : 'Copy location'}
          aria-label={copied ? 'Copied' : 'Copy location'}
        >
          {copied ? <Check className="h-3.5 w-3.5 text-accent-green" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      )}
      {!copyValue && href && (
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-theme-subtle">
          <ExternalLink className="h-3.5 w-3.5" />
        </span>
      )}
    </div>
  );
  if (!href) return content;
  return (
    <a href={href} target={external ? '_blank' : undefined} rel={external ? 'noopener noreferrer' : undefined}>
      {content}
    </a>
  );
}

function AgentMetric({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border border-app bg-app-card/80 px-2.5 py-2">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-app text-theme-muted">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-theme-subtle">{label}</div>
        <div className="min-w-0 text-[11.5px] leading-tight text-theme-primary">{value}</div>
      </div>
    </div>
  );
}

function CopyValueRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      if (window.allenDesktop?.writeClipboardText) {
        await window.allenDesktop.writeClipboardText(value);
      } else {
        await navigator.clipboard.writeText(value);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border border-app bg-app-card px-3 py-2">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-app text-theme-muted">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-theme-subtle">{label}</div>
        <div className="truncate font-mono text-[12px] text-theme-primary">{value}</div>
      </div>
      <button
        type="button"
        onClick={handleCopy}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-theme-muted transition-colors hover:bg-app hover:text-theme-primary"
        title={copied ? 'Copied' : `Copy ${label.toLowerCase()}`}
        aria-label={copied ? 'Copied' : `Copy ${label.toLowerCase()}`}
      >
        {copied ? <Check className="h-3.5 w-3.5 text-accent-green" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

function compactArtifactSize(bytes?: number | null): string {
  if (bytes == null || !Number.isFinite(bytes)) return 'file';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function artifactContentType(value?: string | null): ArtifactDoc['contentType'] {
  const normalized = (value ?? '').toLowerCase();
  if (normalized.includes('markdown') || normalized === 'md') return 'markdown';
  if (normalized.includes('json')) return 'json';
  if (normalized.includes('csv')) return 'csv';
  if (normalized.includes('javascript') || normalized.includes('typescript') || normalized.includes('python') || normalized.includes('code')) return 'code';
  if (normalized.includes('octet-stream') || normalized.includes('binary')) return 'binary';
  return 'text';
}

function runtimeArtifactBelongsToAgent(
  artifact: RunStatus['artifacts'][number],
  executionId: string,
): boolean {
  if (artifact.rootId === executionId) return true;
  if (artifact.spawnContext?.agentExecutionId === executionId) return true;
  if (artifact.spawnContext?.parentId === executionId) return true;
  return false;
}

function runtimeArtifactDoc(
  artifact: RunStatus['artifacts'][number],
  executionId: string,
  agentName: string,
): ArtifactDoc {
  const filename = artifact.filename ?? artifact.relativePath ?? 'artifact';
  return {
    artifactId: artifact.artifactId,
    rootType: artifact.rootType === 'chat' || artifact.rootType === 'workflow' || artifact.rootType === 'agent'
      ? artifact.rootType
      : 'agent',
    rootId: artifact.rootId ?? executionId,
    spawnContext: {
      originType: 'spawn_agent',
      parentId: artifact.spawnContext?.parentId ?? executionId,
      nodeName: artifact.spawnContext?.nodeName ?? undefined,
      agentName: artifact.spawnContext?.agentName ?? agentName,
      agentExecutionId: artifact.spawnContext?.agentExecutionId ?? executionId,
    },
    filename,
    relativePath: artifact.relativePath ?? filename,
    contentType: artifactContentType(artifact.contentType),
    sizeBytes: 0,
    description: artifact.description ?? undefined,
    createdAt: artifact.createdAt ?? new Date().toISOString(),
    createdByAgent: artifact.spawnContext?.agentName ?? agentName,
  };
}

function AgentArtifactRow({
  artifact,
  onOpen,
}: {
  artifact: ArtifactDoc;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full min-w-0 items-center gap-2 rounded-md border border-app bg-app px-2.5 py-2 text-left transition-colors hover:border-app-strong hover:bg-app-muted/35"
      title={artifact.relativePath || artifact.filename}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-app-card text-theme-muted">
        <FileText className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] font-medium text-theme-primary">{artifact.filename}</span>
        <span className="block truncate font-mono text-[10px] text-theme-muted">
          {artifact.contentType} · {compactArtifactSize(artifact.sizeBytes)}
        </span>
      </span>
      <ChevronRight className="h-3 w-3 shrink-0 text-theme-subtle" />
    </button>
  );
}

function AgentPanel({
  title,
  icon,
  meta,
  open,
  onToggle,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  meta?: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-md border border-app bg-app-card">
      <button
        type="button"
        title={`Toggle ${title.toLowerCase()}`}
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-app-muted/35"
      >
        {open ? <ChevronDown className="h-4 w-4 text-theme-muted" /> : <ChevronRight className="h-4 w-4 text-theme-muted" />}
        <span className="text-theme-muted">{icon}</span>
        <span className="text-[13px] font-semibold text-theme-primary">{title}</span>
        {meta && <span className="ml-auto font-mono text-[10.5px] text-theme-subtle">{meta}</span>}
      </button>
      {open && <div className="border-t border-app px-4 py-3">{children}</div>}
    </section>
  );
}

function AgentExecutionView({ execution, agentName, traces, id, liveToolCalls, refresh, runContext, contextEngineEnabled }: {
  execution: any; agentName: string; traces: any[]; id: string; liveToolCalls?: any[]; refresh: () => void; runContext?: RunStatus | null; contextEngineEnabled: boolean;
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
  const [showToolCalls, setShowToolCalls] = useState(false);
  const [liveLogs, setLiveLogs] = useState<any[]>([]);
  const [logsOpen, setLogsOpen] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [resumePrompt, setResumePrompt] = useState('');
  const [resumeBusy, setResumeBusy] = useState(false);
  const [agentArtifacts, setAgentArtifacts] = useState<ArtifactDoc[]>([]);
  const [agentArtifactsLoading, setAgentArtifactsLoading] = useState(true);
  const [agentArtifactPreview, setAgentArtifactPreview] = useState<ArtifactDoc | null>(null);
  const [registeredRepos, setRegisteredRepos] = useState<ExecutionRepoSummary[]>([]);
  const [agentContextOpen, setAgentContextOpen] = useState(false);
  const [agentContextReport, setAgentContextReport] = useState<any | null>(null);
  const [agentContextLoading, setAgentContextLoading] = useState(false);
  const [agentContextError, setAgentContextError] = useState<string | null>(null);

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
  const [durationNowMs, setDurationNowMs] = useState(Date.now());
  const activeStartedAt = trace?.startedAt ?? execution.startedAt;
  useEffect(() => {
    if (execution.status !== 'running' && execution.status !== 'waiting_for_input') return;
    const interval = setInterval(() => setDurationNowMs(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [execution.status]);
  const activeStartedMs = activeStartedAt ? new Date(activeStartedAt).getTime() : NaN;
  const liveDurationMs = Number.isFinite(activeStartedMs) ? Math.max(0, durationNowMs - activeStartedMs) : 0;
  const isLiveAgentExecution = execution.status === 'running' || execution.status === 'waiting_for_input';
  const durationMs = isLiveAgentExecution ? liveDurationMs : (trace?.durationMs ?? execution.durationMs ?? liveDurationMs);
  const meta = execution.meta ?? {};
  const executionLocation = meta.cwd ?? execution.input?.repo_path ?? '/tmp';
  const matchedRepo = useMemo(
    () => repoForExecutionPath(executionLocation, registeredRepos),
    [executionLocation, registeredRepos],
  );

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
  const canShowLogsDrawer = ['completed', 'failed', 'cancelled', 'canceled'].includes(String(execution.status));

  const handleResume = async () => {
    const trimmed = resumePrompt.trim();
    // Don't gate on sessionId — the backend handles the missing-session
    // case by starting a fresh session re-run (see canResume comment above).
    if (!trimmed) return;
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

  useEffect(() => {
    let alive = true;
    reposApi.list()
      .then((repos) => {
        if (alive) setRegisteredRepos(repos ?? []);
      })
      .catch(() => {
        if (alive) setRegisteredRepos([]);
      });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    setAgentArtifactsLoading(true);
    const runtimeDocs = (runContext?.artifacts ?? [])
      .filter((artifact) => runtimeArtifactBelongsToAgent(artifact, id))
      .map((artifact) => runtimeArtifactDoc(artifact, id, agentName));
    artifactsApi.list({ rootType: 'agent', rootId: id, limit: 6 })
      .then((items) => {
        if (!alive) return;
        const byId = new Map<string, ArtifactDoc>();
        for (const artifact of runtimeDocs) byId.set(artifact.artifactId, artifact);
        for (const artifact of items ?? []) byId.set(artifact.artifactId, artifact);
        setAgentArtifacts([...byId.values()].sort((a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        ));
      })
      .catch(() => {
        if (alive) setAgentArtifacts(runtimeDocs);
      })
      .finally(() => {
        if (alive) setAgentArtifactsLoading(false);
      });
    return () => { alive = false; };
  }, [id, execution.status, runContext?.artifacts, agentName]);

  const openAgentArtifact = async (artifact: ArtifactDoc) => {
    setAgentArtifactPreview(artifact);
    try {
      const full = await artifactsApi.get(artifact.artifactId);
      setAgentArtifactPreview(full);
    } catch {
      // Runtime context already gives enough metadata for the viewer URL.
    }
  };

  useEffect(() => {
    if (!id || !contextEngineEnabled) return;
    let alive = true;
    const running = execution.status === 'running' || execution.status === 'waiting_for_input';
    const view = agentContextOpen ? 'full' : 'summary';
    const fetchContextReport = async (refresh = false) => {
      setAgentContextLoading(true);
      try {
        const report = await api.contextUsage(id, { view, refresh });
        if (!alive) return;
        setAgentContextReport(report);
        setAgentContextError(null);
      } catch (err) {
        if (!alive) return;
        setAgentContextError((err as Error).message);
      } finally {
        if (alive) setAgentContextLoading(false);
      }
    };
    const run = async () => {
      await fetchContextReport(false);
      if (!running) {
        await new Promise(r => setTimeout(r, 2500));
        if (alive) await fetchContextReport(true);
        return;
      }
      if (!agentContextOpen) return;
      while (alive) {
        await new Promise(r => setTimeout(r, 10000));
        if (alive) await fetchContextReport(false);
      }
    };
    run();
    return () => { alive = false; };
  }, [id, execution.status, contextEngineEnabled, agentContextOpen]);

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
  const showLogsInMain = execution.status === 'running';
  const primaryPanelTitle = showLogsInMain ? 'Logs' : 'Response';
  const primaryPanelCount = showLogsInMain ? `${allLogs.length} entries` : `${response.length} chars`;
  const modelLabel = [meta.provider ?? 'claude', meta.model ?? cost.model ?? 'sonnet'].filter(Boolean).join(' / ');
  const startedLabel = execution.startedAt ? new Date(execution.startedAt).toLocaleString() : 'n/a';
  const completedLabel = execution.completedAt ? new Date(execution.completedAt).toLocaleString() : 'n/a';
  const selectedContextAttempt = findAgentContextAttempt(agentContextReport, agentName, selectedAttempt);
  const contextExpected = contextEngineEnabled && Boolean(execution.input?.repo_path || execution.input?.repoPath || execution.worktreePath || meta.worktreePath);
  const hasAgentContext = agentHasContextEvidence(trace, selectedContextAttempt, contextExpected);
  const agentContextCount = agentTraceContextCount(trace) ?? agentContextAttemptCount(selectedContextAttempt);

  return (
    <div className="h-full overflow-y-auto bg-app">
      <header className="border-b border-app bg-app">
        <div className="flex w-full flex-wrap items-center gap-4 px-8 pb-4 pt-8">
          <div className="flex min-w-[320px] flex-1 items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-app bg-app-card text-accent-purple shadow-sm">
              <Cpu className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-[22px] font-semibold leading-tight text-theme-primary">{agentName}</h1>
                <StatusBadge status={execution.status} />
                {execution.status === 'running' && <span className="h-2 w-2 rounded-full bg-accent-green animate-pulse" />}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px] text-theme-muted">
                <span>Agent execution</span>
                {meta.spawnedBy && (
                  <>
                    <span className="text-theme-subtle">·</span>
                    <span>Spawned by <span className="font-mono text-theme-secondary">{meta.spawnedBy}</span></span>
                  </>
                )}
                {meta.chatSessionId && (
                  <>
                    <span className="text-theme-subtle">·</span>
                    <Link
                      to={`/chat/${meta.chatSessionId}`}
                      className="inline-flex items-center gap-1 rounded-sm text-accent transition-colors hover:text-accent-hover"
                    >
                      <MessageSquare className="h-3 w-3" />
                      Open chat
                    </Link>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="ml-auto flex items-center gap-2">
            {execution.status === 'running' && (
              <button
                type="button"
                onClick={async () => { await api.cancel(id); window.location.reload(); }}
                className="inline-flex h-9 items-center gap-2 rounded-md border border-accent-red/35 bg-accent-red/10 px-3 text-[12px] font-medium text-accent-red transition-colors hover:bg-accent-red/15"
              >
                <XCircle className="h-3.5 w-3.5" />
                Cancel
              </button>
            )}
            {canShowLogsDrawer && (
              <button
                type="button"
                onClick={() => {
                  setResumeOpen(false);
                  setLogsOpen(true);
                }}
                className="inline-flex h-9 items-center gap-2 rounded-md border border-app bg-app-card px-3 text-[12px] font-medium text-theme-secondary transition-colors hover:border-app-strong hover:bg-app-muted hover:text-theme-primary"
              >
                <Activity className="h-3.5 w-3.5" />
                Logs
                {allLogs.length > 0 && (
                  <span className="rounded-sm bg-app-muted px-1.5 py-0.5 font-mono text-[10px] text-theme-muted tabular-nums">
                    {allLogs.length}
                  </span>
                )}
              </button>
            )}
            {hasAgentContext && (
              <button
                type="button"
                onClick={() => setAgentContextOpen(true)}
                className="inline-flex h-9 items-center gap-2 rounded-md border border-app bg-app-card px-3 text-[12px] font-medium text-theme-secondary transition-colors hover:border-app-strong hover:bg-app-muted hover:text-theme-primary"
                title="Inspect injected context"
              >
                <BookOpen className="h-3.5 w-3.5" />
                Context
                {agentContextCount != null && (
                  <span className="rounded-sm bg-app-muted px-1.5 py-0.5 font-mono text-[10px] text-theme-muted tabular-nums">
                    {agentContextCount}
                  </span>
                )}
              </button>
            )}
            {canResume && (
              <button
                type="button"
                onClick={() => {
                  setLogsOpen(false);
                  setResumeOpen(true);
                }}
                className="inline-flex h-9 items-center gap-2 rounded-md bg-accent px-3.5 text-[12px] font-semibold text-white shadow-sm transition-colors hover:bg-accent-hover"
              >
                <Play className="h-3.5 w-3.5" />
                Resume
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="grid w-full grid-cols-1 gap-4 px-8 pb-8 pt-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4">
          <section className="grid gap-2 rounded-md border border-app bg-app-muted/25 p-2 sm:grid-cols-2 2xl:grid-cols-4">
            <AgentMetric icon={<Clock className="h-3.5 w-3.5" />} label="Duration" value={durationMs > 0 ? formatDuration(durationMs) : '—'} />
            <AgentMetric icon={<Terminal className="h-3.5 w-3.5" />} label="Model" value={modelLabel} />
            <AgentMetric icon={<DollarSign className="h-3.5 w-3.5" />} label="Cost" value={<CostDisplay cost={cost} />} />
            {execution.tokenUsage ? (
              <AgentMetric
                icon={<Cpu className="h-3.5 w-3.5" />}
                label="Tokens"
                value={<TokenUsageDisplay tokenUsage={execution.tokenUsage} />}
              />
            ) : (
              <AgentMetric icon={<Cpu className="h-3.5 w-3.5" />} label="Tokens" value="—" />
            )}
          </section>

          {sortedTraces.length > 1 && (
            <div className="overflow-x-auto rounded-md border border-app bg-app-card p-1">
              <div className="flex items-center gap-1">
                {sortedTraces.map(t => {
                  const n = t.attempt ?? 1;
                  const failed = t.status === 'failed';
                  const active = n === selectedAttempt;
                  return (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setSelectedAttempt(n)}
                      className={`inline-flex h-8 shrink-0 items-center gap-2 rounded-md px-3 text-[12px] font-medium transition-colors ${
                        active
                          ? 'bg-app-muted text-theme-primary'
                          : 'text-theme-muted hover:text-theme-primary'
                      }`}
                      title={`${failed ? 'Failed' : 'Completed'} · ${new Date(t.startedAt).toLocaleString()}`}
                    >
                      {failed ? <AlertCircle className="h-3.5 w-3.5 text-accent-red" /> : <CheckCircle className="h-3.5 w-3.5 text-accent-green" />}
                      Attempt {n}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <AgentPanel
            title="Prompt"
            icon={<Terminal className="h-4 w-4 text-accent-blue" />}
            meta={`${prompt.length} chars`}
            open={showPrompt}
            onToggle={() => setShowPrompt(!showPrompt)}
          >
            <pre className="max-h-[42vh] overflow-y-auto whitespace-pre-wrap rounded-md bg-[rgb(var(--color-editor-background))] p-3 font-mono text-[12px] leading-relaxed text-theme-secondary">{prompt}</pre>
          </AgentPanel>

          <AgentPanel
            title={primaryPanelTitle}
            icon={showLogsInMain ? <Activity className="h-4 w-4 text-accent-blue animate-pulse" /> : execution.status === 'completed' ? <CheckCircle className="h-4 w-4 text-accent-green" /> : <AlertCircle className="h-4 w-4 text-accent-red" />}
            meta={primaryPanelCount}
            open={showResponse}
            onToggle={() => setShowResponse(!showResponse)}
          >
            {showLogsInMain ? (
              <div className="max-h-[58vh] overflow-y-auto rounded-md bg-[rgb(var(--color-editor-background))] p-3">
                {allLogs.length === 0 ? (
                  <div className="px-2 py-3 font-mono text-xs text-theme-subtle animate-pulse">Waiting for activity...</div>
                ) : (
                  allLogs.map((log: any, index: number) => (
                    <LogRow key={index} log={log} toolCall={resolveToolCallForLog(log, toolCalls as ToolCall[])} />
                  ))
                )}
              </div>
            ) : (
              <div className="prose-allen max-h-[58vh] overflow-y-auto text-sm leading-relaxed text-theme-secondary">
                {response
                  ? renderMarkdown(response)
                  : <span className="text-theme-muted">{execution.errorMessage || '(no response)'}</span>
                }
              </div>
            )}
          </AgentPanel>

          {toolCalls.length > 0 && (
            <AgentPanel
              title="Tool calls"
              icon={<Wrench className="h-4 w-4 text-accent-yellow" />}
              meta={toolCalls.length}
              open={showToolCalls}
              onToggle={() => setShowToolCalls(v => !v)}
            >
              <div className="max-h-[54vh] overflow-y-auto">
                {(toolCalls as ToolCall[]).map((tc: ToolCall, i: number) => <ToolCallRow key={i} tc={tc} index={i} />)}
              </div>
            </AgentPanel>
          )}
        </div>

        <aside className="space-y-4">
          <section className="rounded-md border border-app bg-app-card">
            <div className="border-b border-app px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="inline-flex items-center gap-2 text-[13px] font-semibold text-theme-primary">
                  <FileText className="h-3.5 w-3.5 text-theme-muted" />
                  Artifacts
                </div>
                {agentArtifacts.length > 0 && (
                  <button
                    type="button"
                    onClick={() => void openAgentArtifact(agentArtifacts[0])}
                    className="text-[11px] font-medium text-accent transition-colors hover:text-accent-hover"
                  >
                    Open latest
                  </button>
                )}
              </div>
              <div className="mt-1 text-[12px] text-theme-muted">
                {agentArtifactsLoading ? 'Checking saved files' : `${agentArtifacts.length} saved ${agentArtifacts.length === 1 ? 'file' : 'files'}`}
              </div>
            </div>
            <div className="p-3">
              {agentArtifactsLoading ? (
                <div className="space-y-2">
                  {[0, 1, 2].map((index) => (
                    <div key={index} className="h-11 rounded-md bg-app-muted/45 animate-pulse" />
                  ))}
                </div>
              ) : agentArtifacts.length > 0 ? (
                <div className="max-h-[45vh] space-y-2 overflow-y-auto pr-1">
                  {agentArtifacts.slice(0, 6).map((artifact) => (
                    <AgentArtifactRow
                      key={artifact.artifactId}
                      artifact={artifact}
                      onOpen={() => void openAgentArtifact(artifact)}
                    />
                  ))}
                </div>
              ) : (
                <div className="rounded-md border border-dashed border-app bg-app px-3 py-3 text-[12px] text-theme-muted">
                  No files saved for this run yet.
                </div>
              )}
            </div>
          </section>

          <section className="rounded-md border border-app bg-app-card">
            <div className="border-b border-app px-4 py-3">
              <div className="text-[13px] font-semibold text-theme-primary">Run context</div>
              <div className="mt-1 text-[12px] text-theme-muted">
                {runContext?.progress?.currentStep ?? phaseLabel(runContext?.progress?.phase ?? execution.status)}
              </div>
            </div>
            <div className="space-y-1 p-2">
              {runContext?.humanInput?.required && (
                <div className="mb-2 flex items-center gap-2 rounded-md border border-accent-yellow/30 bg-accent-yellow/10 px-3 py-2 text-[12px] text-accent-yellow">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Input required
                </div>
              )}
              <CopyValueRow icon={<Cpu className="h-3.5 w-3.5" />} label="Execution id" value={id} />
              {sessionId && <CopyValueRow icon={<Terminal className="h-3.5 w-3.5" />} label="Session id" value={sessionId} />}
              {runContext?.pullRequest && (
                <AgentResourceCard
                  icon={<GitPullRequest className="h-3.5 w-3.5" />}
                  title={runContext.pullRequest.title ?? (runContext.pullRequest.number ? `#${runContext.pullRequest.number}` : 'Pull request')}
                  subtitle={[
                    runContext.pullRequest.number ? `#${runContext.pullRequest.number}` : null,
                    runContext.pullRequest.status ?? null,
                  ].filter(Boolean).join(' · ') || undefined}
                  href={runContext.pullRequest.url ?? undefined}
                  external
                />
              )}
              {runContext?.workspace && (
                <AgentResourceCard
                  icon={<FolderGit2 className="h-3.5 w-3.5" />}
                  title={runContext.workspace.name ?? runContext.workspace.branch ?? 'workspace'}
                  subtitle={runContext.workspace.repoName ?? undefined}
                  href={runContext.workspace.id ? workspaceChatPath(runContext.workspace.id) : undefined}
                />
              )}
              {matchedRepo ? (
                <AgentResourceCard
                  icon={<FolderGit2 className="h-3.5 w-3.5" />}
                  title={matchedRepo.name ?? 'Repository'}
                  subtitle={matchedRepo.detected?.defaultBranch ? `default ${matchedRepo.detected.defaultBranch}` : undefined}
                  href={(matchedRepo._id ?? matchedRepo.id) ? `/repos/${matchedRepo._id ?? matchedRepo.id}/context-management` : undefined}
                  copyText={matchedRepo.path}
                />
              ) : (
                <AgentResourceCard
                  icon={<Terminal className="h-3.5 w-3.5" />}
                  title={executionLocation}
                  copyText={executionLocation}
                />
              )}
              {meta.chatSessionId && (
                <AgentResourceCard
                  icon={<MessageSquare className="h-3.5 w-3.5" />}
                  title="Open conversation"
                  href={`/chat/${meta.chatSessionId}`}
                />
              )}
            </div>
          </section>

          <section className="rounded-md border border-app bg-app-card">
            <div className="border-b border-app px-4 py-3">
              <div className="text-[13px] font-semibold text-theme-primary">Activity</div>
              <div className="mt-1 font-mono text-[11px] text-theme-muted">{allLogs.length} logs · {toolCalls.length} tools</div>
            </div>
            <div className="grid grid-cols-2 gap-px bg-app-muted">
              <div className="bg-app-card px-4 py-3">
                <div className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-theme-subtle">Started</div>
                <div className="mt-1 text-[12px] text-theme-secondary">{startedLabel}</div>
              </div>
              <div className="bg-app-card px-4 py-3">
                <div className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-theme-subtle">Completed</div>
                <div className="mt-1 text-[12px] text-theme-secondary">{completedLabel}</div>
              </div>
            </div>
          </section>
        </aside>
      </main>

      {agentArtifactPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-6 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Artifact preview">
          <button
            type="button"
            className="absolute inset-0"
            onClick={() => setAgentArtifactPreview(null)}
            aria-label="Close artifact preview"
          />
          <div className="relative flex h-[min(760px,calc(100vh-48px))] w-[min(980px,calc(100vw-48px))] overflow-hidden rounded-md border border-app-strong bg-app-card shadow-2xl">
            <ArtifactViewer
              artifact={agentArtifactPreview}
              onClose={() => setAgentArtifactPreview(null)}
            />
          </div>
        </div>
      )}

      <AgentLogsDrawer
        open={logsOpen}
        onClose={() => setLogsOpen(false)}
        executionId={id ?? execution.id}
        logs={allLogs}
        toolCalls={toolCalls as ToolCall[]}
        executionStatus={execution.status}
      />

      <AgentContextDrawer
        open={agentContextOpen}
        onClose={() => setAgentContextOpen(false)}
        trace={trace}
        contextAttempt={selectedContextAttempt}
        contextReportLoading={agentContextLoading}
        contextReportError={agentContextError}
        contextExpected={contextExpected}
        contextEngineEnabled={contextEngineEnabled}
      />

      <AgentResumeDrawer
        open={resumeOpen && canResume}
        onClose={() => { setResumeOpen(false); setResumePrompt(''); }}
        agentName={agentName}
        prompt={resumePrompt}
        busy={resumeBusy}
        onPromptChange={setResumePrompt}
        onSubmit={handleResume}
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
    loading, connected, isLive, refresh, markExecutionRunning,
    children, descendantsMode, toggleDescendants,
    liveToolCallsByNode,
  } = useExecution(id);

  const [rightPanelView, setRightPanelView] = useState<ExecutionRightPanelView>('node');
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
  const inspectNode = (n: string | null) => {
    setSelectedNode(n);
    setRightPanelView('node');
  };
  // Interventions for this workflow run — drives the pending approval action
  // in the header while keeping the execution canvas focused.
  const [runInterventions, setRunInterventions] = useState<any[]>([]);
  const [mainView, setMainView] = useState<'graph' | 'trace' | 'logs'>('trace');
  const [traceTimelineOpen, setTraceTimelineOpen] = useState(false);
  const [checkpointCount, setCheckpointCount] = useState<number | null>(null);
  const [artifactCount, setArtifactCount] = useState<number | null>(null);
  const [workflowArtifacts, setWorkflowArtifacts] = useState<ArtifactDoc[]>([]);
  const [runContext, setRunContext] = useState<RunStatus | null>(null);
  const [contextEvaluationBusy, setContextEvaluationBusy] = useState(false);
  const [contextEngineEnabled, setContextEngineEnabled] = useState(false);
  const [feedbackEntries, setFeedbackEntries] = useState<Array<{ id: string; content: string; targetNodes?: string[]; createdAt: string; createdBy?: string }>>([]);
  const [approvalModalOpen, setApprovalModalOpen] = useState(false);

  // Input dialog is dismissible — user can close it to look at nodes/logs
  // and reopen via the header "Respond" button. The dismissed flag resets
  // whenever a new input request arrives or the execution resumes.
  const [inputDialogDismissed, setInputDialogDismissed] = useState(false);
  const lastInputNodeRef = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    systemApi.runtimeConfig()
      .then((config) => { if (!cancelled) setContextEngineEnabled(config.contextEngine.enabled); })
      .catch(() => { if (!cancelled) setContextEngineEnabled(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    api.checkpoints.list(id)
      .then((list) => { if (!cancelled) setCheckpointCount((list ?? []).length); })
      .catch(() => {});
    const loadArtifacts = () => {
      artifactsApi.list({ rootType: 'workflow', rootId: id, limit: 500 })
        .then((list) => {
          if (cancelled) return;
          const next = list ?? [];
          setWorkflowArtifacts(next);
          setArtifactCount(next.length);
        })
        .catch(() => {
          if (cancelled) return;
          setWorkflowArtifacts([]);
          setArtifactCount(0);
        });
    };
    loadArtifacts();
    if (rightPanelView === 'artifacts' && (execution?.status === 'running' || execution?.status === 'waiting_for_input' || execution?.status === 'queued')) {
      const timer = window.setInterval(loadArtifacts, 10000);
      return () => {
        cancelled = true;
        window.clearInterval(timer);
      };
    }
    return () => { cancelled = true; };
  }, [id, execution?.status, execution?.completedNodes?.length, rightPanelView]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const loadContext = () => {
      api.context(id)
        .then((context) => { if (!cancelled) setRunContext(context); })
        .catch(() => { if (!cancelled) setRunContext(null); });
    };
    loadContext();
    if (execution?.status === 'running' || execution?.status === 'waiting_for_input' || execution?.status === 'queued') {
      const timer = window.setInterval(loadContext, 10000);
      return () => {
        cancelled = true;
        window.clearInterval(timer);
      };
    }
    return () => { cancelled = true; };
  }, [id, execution?.status, execution?.completedNodes?.length, execution?.currentNodes?.join('|')]);

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
  const loadRunInterventions = useCallback(async () => {
    if (!id) return;
    try {
      const data = await interventionsApi.listForWorkflowRun(id);
      setRunInterventions(data ?? []);
    } catch {
      setRunInterventions([]);
    }
  }, [id]);

  useEffect(() => {
    void loadRunInterventions();
  }, [loadRunInterventions, execution?.status]);

  const pendingIntervention = runInterventions.find((i: any) => i.status === 'pending');
  const approvalPending = Boolean(pendingIntervention || runContext?.humanInput?.required);
  const latestInputNode = latestInputEvent?.data?.node as string | undefined;
  const latestInputFields = Array.isArray(latestInputEvent?.data?.fields)
    ? (latestInputEvent.data.fields as Array<{ name?: string; type?: string; options?: unknown[] }>)
    : [];
  const waitingInputLooksLikeApproval = looksLikeApprovalInput(latestInputNode, latestInputFields);

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

    // Waiting for input → select the waiting node only on first load.
    // Once the user clicks a previous node to inspect it, polling/SSE
    // refreshes must not yank the detail pane back to the approval/running
    // node every few seconds.
    if (status === 'waiting_for_input' && latestInputEvent?.data?.node) {
      if (!selectedNode) setSelectedNode(latestInputEvent.data.node);
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

    // Just transitioned to completed/failed → select the final node only
    // if the user hasn't already chosen a node to inspect.
    if (status === 'completed' && prevStatusRef.current !== 'completed') {
      if (!selectedNode && execution.completedNodes?.length > 0) {
        setSelectedNode(execution.completedNodes[execution.completedNodes.length - 1]);
      }
      prevStatusRef.current = status;
      return;
    }

    if (status === 'failed' && prevStatusRef.current !== 'failed') {
      if (!selectedNode && execution.failedNode) {
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
  }, [execution?.status, execution?.failedNode, execution?.completedNodes, execution?.currentNodes, latestInputEvent, nodeStates, selectedNode]);

  const { size: rightWidth, handleMouseDown: rightResizeStart } = useResizable({ direction: 'horizontal', initialSize: 40, minSize: 20, maxSize: 60, unit: 'percent' });
  const { size: artifactRightWidth, handleMouseDown: artifactRightResizeStart } = useResizable({ direction: 'horizontal', initialSize: 56, minSize: 28, maxSize: 78, unit: 'percent' });

  const handleCancel = useCallback(async () => {
    if (id) await api.cancel(id);
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
      markExecutionRunning(node);
      await api.retryFrom(id, node);
      window.setTimeout(() => { void refresh(); }, 750);
    } catch (err) {
      // Surface failures inline — the operator should see why resume didn't start.
      alert(`Failed to resume from ${node}: ${(err as Error).message}`);
      await refresh();
    } finally {
      setResumeBusy(false);
    }
  }, [id, refresh, markExecutionRunning]);

  const handleRerunContextEvaluation = useCallback(async () => {
    if (!id || !contextEngineEnabled) return;
    setContextEvaluationBusy(true);
    try {
      let summary = await api.rerunWorkflowContextEvaluation(id);
      setRunContext(prev => prev ? {
        ...prev,
        execution: {
          ...prev.execution,
          contextWorkflowEvaluation: summary,
        },
      } : prev);
      const deadline = Date.now() + 10 * 60_000;
      while (workflowContextEvaluationInFlight(summary) && Date.now() < deadline) {
        await sleep(2000);
        const context = await api.context(id);
        setRunContext(context);
        summary = context.execution.contextWorkflowEvaluation;
      }
    } catch (err) {
      alert(`Failed to rerun context evaluation: ${(err as Error).message}`);
    } finally {
      setContextEvaluationBusy(false);
    }
  }, [id, contextEngineEnabled]);

  const canAppendFeedback = ['completed', 'failed', 'cancelled'].includes(execution?.status);

  // Augment traces with synthetic 'running' entries for nodes currently
  // executing. Traces are only persisted after completion, so without this
  // running rerun nodes are invisible in the Gantt timeline.
  // Must be declared BEFORE any early-return below to keep hook order stable
  // across renders (loading → loaded transitions otherwise change hook count).
  const tracesForTimeline = useMemo(
    () => buildTracesForTimeline(traces ?? [], nodeStates),
    [traces, nodeStates],
  );

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
  // Two signals, either sufficient:
  //   1. workflowName contains ':spawn_agent/' — the naming convention from
  //      Phase 1 (caller-qualified, e.g. 'develop:spawn_agent/frontend-developer'
  //      or legacy 'chat:spawn_agent/frontend-developer').
  //   2. source === 'spawn' — workflow-initiated spawns after Phase 1.
  // Important: source === 'chat' is not enough. Real workflow executions can
  // be started from chat and must still render the workflow execution page.
  const wfName = execution.workflowName ?? '';
  const isAgentExecution = wfName.includes(':spawn_agent/') || execution.source === 'spawn';
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
      runContext={runContext}
      contextEngineEnabled={contextEngineEnabled}
    />;
  }

  const workflowContextFindingsByIdentity = new Map<string, any>();
  for (const finding of ((runContext?.execution.contextWorkflowEvaluation?.result?.nodeFindings ?? []) as any[])) {
    const identity = workflowFindingIdentity(finding);
    for (const key of workflowFindingStorageKeys(identity)) workflowContextFindingsByIdentity.set(key, finding);
  }
  const selectedTraces = traces
    .filter((t: any) => t.node === selectedNode)
    .map((trace: any) => ({
      ...trace,
      workflowContextFinding: workflowFindingForTrace(workflowContextFindingsByIdentity, trace, execution.id),
    }));
  const selectedTrace = selectedTraces.length > 0 ? selectedTraces[selectedTraces.length - 1] : undefined;
  const selectedTraceWithContextFinding = selectedTrace
    ? {
        ...selectedTrace,
        workflowContextFinding: selectedNode ? workflowFindingForTrace(workflowContextFindingsByIdentity, selectedTrace, execution.id) : undefined,
      }
    : undefined;
  const selectedState = selectedNode ? nodeStates.get(selectedNode) : undefined;
  const isPaused = execution.status === 'waiting_for_input' && !latestInputEvent;

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

  const agentNodeNames = Object.entries((workflow?.parsed?.nodes ?? workflow?.nodes ?? {}) as Record<string, any>)
    .filter(([, nodeDef]) => ((nodeDef as any)?.type ?? 'agent') === 'agent')
    .map(([name]) => name);
  const workflowNodeNames = workflow?.parsed?.nodes ? Object.keys(workflow.parsed.nodes) : [];

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
            {execution.status === 'waiting_for_input' && inputDialogDismissed && !pendingIntervention && (
              <button
                onClick={() => setInputDialogDismissed(false)}
                className={waitingInputLooksLikeApproval ? 'cr-approval-button' : 'badge badge-warn cursor-pointer'}
                title="Reopen the input dialog"
              >
                {waitingInputLooksLikeApproval ? (
                  <>
                    <span className="cr-approval-main">Approve</span>
                    <ChevronRight className="h-3.5 w-3.5" />
                  </>
                ) : (
                  <>
                    <MessageSquare className="w-3 h-3" />
                    Respond to input
                    <span className="w-1.5 h-1.5 rounded-full bg-accent-yellow animate-pulse" />
                  </>
                )}
              </button>
            )}
            {approvalPending && pendingIntervention && (
              <button
                type="button"
                onClick={() => setApprovalModalOpen(true)}
                className="cr-approval-button"
                title="Open approval dialog"
              >
                <span className="cr-approval-main">Approve</span>
                <ChevronRight className="h-3.5 w-3.5" />
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
          </div>

        <div className="flex items-center gap-2">
          {runContext?.pullRequest && (
            <a
              href={runContext.pullRequest.url ?? '#'}
              target={runContext.pullRequest.url ? '_blank' : undefined}
              rel={runContext.pullRequest.url ? 'noreferrer' : undefined}
              className="btn-ghost text-xs inline-flex max-w-[280px] items-center gap-1.5 text-accent-green"
              title={runContext.pullRequest.title ?? (runContext.pullRequest.number ? `PR #${runContext.pullRequest.number}` : 'Pull request')}
            >
              <GitPullRequest className="h-[1em] w-[1em] shrink-0" />
              <span className="shrink-0">
                {runContext.pullRequest.number ? `PR #${runContext.pullRequest.number}` : 'Pull request'}
              </span>
              {runContext.pullRequest.title && (
                <>
                  <span className="text-theme-subtle">·</span>
                  <span className="truncate text-theme-secondary">
                    {runContext.pullRequest.title}
                  </span>
                </>
              )}
              {runContext.pullRequest.status && (
                <span className="shrink-0 font-mono text-[10px] text-theme-muted">
                  {runContext.pullRequest.status}
                </span>
              )}
              {runContext.pullRequest.url && <ExternalLink className="h-[1em] w-[1em] shrink-0 text-theme-subtle" />}
            </a>
          )}
          <button onClick={refresh} className="btn-ghost text-xs" title="Refresh">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setRightPanelView('rerun')}
            className={`btn-ghost text-xs inline-flex items-center gap-1 ${rightPanelView === 'rerun' ? 'text-theme-primary bg-app-muted' : ''}`}
            title="Show saved states, rerun controls, and feedback"
          >
            <Save className="w-3.5 h-3.5" />
            <span>Rerun from State</span>
            {checkpointCount != null && checkpointCount > 0 && (
              <span className="ml-0.5 px-1 py-px rounded-sm bg-accent-soft text-accent text-[10px] font-mono tabular-nums">
                {checkpointCount}
              </span>
            )}
            {feedbackEntries.length > 0 && (
              <span className="ml-0.5 px-1 py-px rounded-sm bg-accent-soft text-accent text-[10px] font-mono tabular-nums">
                {feedbackEntries.length}f
              </span>
            )}
          </button>
          <button
            onClick={() => setRightPanelView('artifacts')}
            className={`btn-ghost text-xs inline-flex items-center gap-1 ${rightPanelView === 'artifacts' ? 'text-theme-primary bg-app-muted' : ''}`}
            title="Show artifacts saved by agents during this run"
          >
            <FileText className="w-3.5 h-3.5" />
            <span>Artifacts</span>
            {artifactCount != null && artifactCount > 0 && (
              <span className="ml-0.5 px-1 py-px rounded-sm bg-accent-soft text-accent text-[10px] font-mono tabular-nums">
                {artifactCount}
              </span>
            )}
          </button>
          {execution.status === 'failed' && execution.failedNode && (
            <button
              onClick={() => handleRetryFrom(execution.failedNode)}
              disabled={resumeBusy}
              className="btn-ghost text-xs text-accent-yellow disabled:cursor-not-allowed disabled:opacity-50"
              title="Retry from failed node"
            >
              {resumeBusy
                ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                : <RotateCcw className="w-3.5 h-3.5 mr-1" />}
              {resumeBusy ? 'Starting…' : 'Retry'}
            </button>
          )}
          {isLive && (
            <button onClick={handleCancel} className="btn-danger text-xs" title="Cancel execution">
              <XCircle className="w-3.5 h-3.5 mr-1" /> Cancel
            </button>
          )}
          </div>
        </div>
      </header>

      {/* Failure banner — prominent resume-from-node controls when the
          execution has failed. The compact `Retry` button in the top bar
          stays (muscle memory), but this banner is the obvious entry point
          with the error shown, the failing node called out, and a picker
          to rewind further back than the failure point if needed. */}
      {execution.status === 'failed' && execution.failedNode && (
        <div className={`flex items-start gap-4 px-6 py-4 border-b ${resumeBusy ? 'border-accent-blue/30 bg-accent-blue/10' : 'border-accent-red/30 bg-accent-red/10'}`}>
          <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border ${resumeBusy ? 'border-accent-blue/30 bg-accent-blue/10 text-accent-blue' : 'border-accent-red/30 bg-accent-red/10 text-accent-red'}`}>
            {resumeBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <AlertTriangle className="h-5 w-5" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs font-heading font-semibold text-theme-primary">
              <span className="tracking-wide">{resumeBusy ? 'STARTING RERUN FROM' : 'FAILED AT'}</span>
              <span className={`rounded-md border px-1.5 py-0.5 font-mono ${resumeBusy ? 'border-accent-blue/25 bg-accent-blue/10 text-accent-blue' : 'border-accent-red/25 bg-accent-red/10 text-accent-red'}`}>{execution.failedNode}</span>
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
                onClick={() => { inspectNode(execution.failedNode); }}
                className="text-[10px] font-mono underline text-theme-muted hover:text-theme-primary"
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
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] font-mono text-theme-subtle">
              <span className="rounded-full border border-app bg-app-card px-2 py-0.5">Checkpoint rewind</span>
              <span className="rounded-full border border-app bg-app-card px-2 py-0.5">Preserves upstream output</span>
              <span className="rounded-full border border-app bg-app-card px-2 py-0.5">Reuses agent sessions</span>
              {resumeBusy && <span className="text-accent-blue">Updating this run now…</span>}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0 relative">
            <button
              onClick={() => handleRetryFrom(execution.failedNode)}
              disabled={resumeBusy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-mono bg-accent-red text-white shadow-sm shadow-accent-red/20 hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
              title={`Resume execution from ${execution.failedNode}`}
            >
              {resumeBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
              {resumeBusy ? 'Starting…' : `Continue from ${execution.failedNode}`}
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

      {approvalModalOpen && pendingIntervention && (
        <ExecutionApprovalModal
          executionId={id ?? execution.id}
          intervention={pendingIntervention}
          onClose={() => setApprovalModalOpen(false)}
          onSubmitted={() => {
            void loadRunInterventions();
            refresh();
          }}
        />
      )}

      {/* Main content — single graph/trace workspace + context/inspector */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 flex overflow-hidden min-h-0">
          <div className="flex-1 min-w-0 overflow-hidden bg-[rgb(var(--color-app-background))] flex flex-col">
            <div className="flex items-center justify-between gap-3 border-b border-app bg-app-card px-4 py-2 shrink-0">
              <div className="inline-flex rounded-md border border-app bg-app-muted p-0.5">
                <button
                  type="button"
                  onClick={() => setMainView('graph')}
                  className={`rounded px-3 py-1.5 text-[11px] font-mono transition-colors ${mainView === 'graph' ? 'bg-app-card text-theme-primary shadow-sm' : 'text-theme-muted hover:text-theme-primary'}`}
	                >
	                  Graph
	                </button>
	                <button
	                  type="button"
	                  onClick={() => setMainView('trace')}
	                  className={`rounded px-3 py-1.5 text-[11px] font-mono transition-colors ${mainView === 'trace' ? 'bg-app-card text-theme-primary shadow-sm' : 'text-theme-muted hover:text-theme-primary'}`}
	                >
	                  Trace
	                </button>
	                <button
	                  type="button"
	                  onClick={() => setMainView('logs')}
	                  className={`inline-flex items-center gap-1 rounded px-3 py-1.5 text-[11px] font-mono transition-colors ${mainView === 'logs' ? 'bg-app-card text-theme-primary shadow-sm' : 'text-theme-muted hover:text-theme-primary'}`}
	                >
	                  Logs
	                </button>
	              </div>
              <div className="flex items-center gap-3">
                <div className="font-mono text-[10px] text-theme-muted">
                  {Array.from(nodeStates.values()).filter(state => state.status === 'completed').length}/{nodeStates.size} nodes
                </div>
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-hidden">
	              {mainView === 'graph' ? (
	                <LiveGraph
	                  workflow={workflow}
	                  nodeStates={nodeStates}
	                  selectedNode={selectedNode}
	                  onSelectNode={inspectNode}
	                  spawnCounts={(children ?? []).reduce((acc: Record<string, number>, c) => {
                    if (c.parentCaller) acc[c.parentCaller] = (acc[c.parentCaller] ?? 0) + 1;
                    return acc;
                  }, {})}
	                />
	              ) : mainView === 'logs' ? (
	                <ExecutionLogsPanel
	                  executionId={id!}
	                  logs={logs}
	                  logFilter={logFilter}
	                  onNodeFilterChange={setLogFilter}
	                  workflowNodes={workflowNodeNames}
	                  traces={traces}
	                />
	              ) : (
	                <div className="flex h-full min-h-0 flex-col overflow-hidden bg-app-card">
                  <div className="border-b border-app px-4 py-2 flex items-center justify-between gap-3 bg-surface-50">
                    <div>
                      <div className="text-[12px] font-semibold text-theme-primary">Trace</div>
                      <div className="text-[10px] font-mono text-theme-muted">
                        {tracesForTimeline.length} timeline {tracesForTimeline.length === 1 ? 'entry' : 'entries'}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setTraceTimelineOpen(open => !open)}
                      className={`btn-ghost text-xs ${traceTimelineOpen ? 'text-accent' : ''}`}
                      title="Toggle node execution timeline"
                    >
                      Timeline
                      {tracesForTimeline.length > 0 && (
                        <span className="ml-1 px-1 py-px rounded-sm bg-accent-soft text-accent text-[10px] font-mono tabular-nums">
                          {tracesForTimeline.length}
                        </span>
                      )}
                    </button>
                  </div>
                  {traceTimelineOpen && (
                    <div className="border-b border-app p-4">
                      <GanttTimeline
                        traces={tracesForTimeline as any}
                        onNodeClick={(node) => inspectNode(node)}
                      />
                    </div>
                  )}
                  <WorkflowTraceTable
                    nodeStates={nodeStates}
                    traces={traces}
                    selectedNode={selectedNode}
                    onSelectNode={inspectNode}
                  />
                </div>
              )}
            </div>
          </div>

          {/* Right: Run context + Node detail — resizable */}
          <div
            className="min-h-0 overflow-hidden shrink-0 bg-surface border-l-2 border-app hover:border-accent-blue/50 transition-colors relative flex flex-col"
            style={{ width: `${rightPanelView === 'artifacts' ? artifactRightWidth : rightWidth}%` }}
          >
            {/* Invisible resize grab zone on the left edge */}
            <div
              className="absolute top-0 left-0 bottom-0 w-2 cursor-col-resize z-10"
              onMouseDown={rightPanelView === 'artifacts' ? artifactRightResizeStart : rightResizeStart}
            />
            <div className="min-h-0 flex-1 overflow-hidden">
	              {rightPanelView === 'rerun' ? (
	                <div className="h-full overflow-auto bg-app-card p-4">
	                  <CheckpointsPanel
	                    executionId={id!}
	                    executionStatus={execution.status}
	                    feedbackEntries={feedbackEntries}
                    canAppendFeedback={canAppendFeedback}
                    agentNodeNames={agentNodeNames}
                    onFeedbackCreated={(entries) => setFeedbackEntries((prev) => [...prev, ...entries])}
                    onRefreshExecution={refresh}
                    onResumeStarted={(node) => markExecutionRunning(node)}
                  />
                </div>
              ) : rightPanelView === 'artifacts' ? (
                <WorkflowArtifactsPanel rootId={id!} />
              ) : (
                <div className="h-full overflow-y-auto">
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
                    trace={selectedTraceWithContextFinding}
                    allTraces={selectedTraces}
                    waitingInput={null}
                    onSubmitInput={handleSubmitInput}
                    spawnedChildren={(children ?? []).filter(c => c.parentCaller === selectedNode)}
                    allChildren={children ?? []}
                    descendantsMode={descendantsMode}
                    onToggleDescendants={toggleDescendants}
                    contextEngineEnabled={contextEngineEnabled}
                    artifacts={workflowArtifacts}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

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
      {execution.status === 'waiting_for_input' && !pendingIntervention && !inputDialogDismissed && (() => {
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
        const waitingFields = fields as Array<{ name?: string; type?: string; options?: unknown[] }>;
        if (looksLikeApprovalInput(waitingNode, waitingFields)) {
          return (
            <WorkflowInterventionDialog
              run={{
                executionId: id ?? execution.id,
                runContext: {
                  humanInput: {
                    title: 'Approval required',
                    stage: waitingNode,
                    severity: waitingNode.toLowerCase().includes('escalation') ? 'escalation' : 'approval',
                  },
                  progress: { currentStep: waitingNode },
                },
              }}
              intervention={{
                status: 'pending',
                stage: waitingNode,
                severity: waitingNode.toLowerCase().includes('escalation') ? 'escalation' : 'approval',
                title: 'Approval required',
                question: reason,
                fields: fields as any,
              }}
              onClose={() => setInputDialogDismissed(true)}
              onAnswer={async (answer: WorkflowInterventionSubmit) => {
                if (!answer.interventionId) {
                  throw new Error('Approval is still syncing. Please wait a moment and try again.');
                }
                if (answer.interventionId) {
                  await interventionsApi.respond(answer.interventionId, {
                    decision: answer.decision,
                    action_id: answer.actionId,
                    field_values: answer.fieldValues,
                    feedback: answer.feedback,
                    answer: answer.answer,
                    human_node_name: answer.humanNodeName,
                    source: 'execution_page',
                  });
                }
                void loadRunInterventions();
                refresh();
              }}
            />
          );
        }
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
