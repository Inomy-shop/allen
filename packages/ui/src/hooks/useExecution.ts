import { useState, useEffect, useCallback, useRef } from 'react';
import { executions as api, workflows as wfApi, type SpawnedChild } from '../services/api';
import { useSSE, type SSEEvent } from './useSSE';

export interface TimelineEvent {
  id: string;
  timestamp: Date;
  event: string;
  node?: string;
  data: any;
}

export interface ExecutionLog {
  executionId: string;
  timestamp: Date;
  level: 'info' | 'debug' | 'warn' | 'error';
  category: 'agent' | 'tool' | 'condition' | 'routing' | 'system' | 'gate';
  node?: string;
  message: string;
  data?: any;
}

export interface ActivityEntry {
  timestamp: Date;
  type: 'text' | 'tool_start' | 'tool_complete';
  tool?: string;
  content: string;
}

export interface NodeState {
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  attempt: number;
  output?: any;
  durationMs?: number;
  cost?: any;
  streamText: string;
  activity: ActivityEntry[];
  /** Rendered prompt shipped with `node_started` so the UI can show it
   *  while the node is still executing (before the trace is saved). */
  renderedPrompt?: string;
  /** Shallow snapshot of state at the moment the node started. */
  inputState?: Record<string, unknown>;
}

export function useExecution(id: string | undefined) {
  const [execution, setExecution] = useState<any>(null);
  const [workflow, setWorkflow] = useState<any>(null);
  const [traces, setTraces] = useState<any[]>([]);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [nodeStates, setNodeStates] = useState<Map<string, NodeState>>(new Map());
  const [logs, setLogs] = useState<ExecutionLog[]>([]);
  const [logFilter, setLogFilter] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Spawn-tree children. Populated from GET /children on initial load and
  // refreshed whenever SSE tells us a spawn happened or a node transitioned
  // (node_completed / node_failed / node_retrying). Two maps:
  //   directChildren — parentExecutionId === this execution's id
  //   descendants    — rootExecutionId === this execution's id (includes
  //                    grandchildren + deeper). Only fetched on-demand when
  //                    the user toggles "Show all descendants".
  const [children, setChildren] = useState<SpawnedChild[]>([]);
  const [descendantsMode, setDescendantsMode] = useState(false);
  /** Live-streamed tool calls keyed by node name. Populated from SSE
   *  agent_tool_complete events so the tool log panel updates in real time
   *  while the node is still running (before the trace is persisted). */
  const [liveToolCallsByNode, setLiveToolCallsByNode] = useState<Map<string, any[]>>(new Map());
  const eventCounter = useRef(0);

  // Fetch initial data
  useEffect(() => {
    if (!id) return;
    setLoading(true);
    // Fire the children fetch in parallel — cheap projection query, no
    // reason to serialize it behind the main exec load.
    api.children(id, 'direct').then(setChildren).catch(() => setChildren([]));
    Promise.all([api.get(id), api.traces(id)])
      .then(async ([exec, tr]) => {
        setExecution(exec);
        setTraces(tr);

        // Fetch the workflow definition for the graph
        if (exec.workflowId) {
          try {
            const wf = await wfApi.get(exec.workflowId);
            setWorkflow(wf);
          } catch { /* workflow may have been deleted */ }
        }

        // Build initial node states from traces. Traces are written ONLY
        // after a node completes (engine.ts:764), so this map contains just
        // the completed attempts — the currently running node is missing.
        const map = new Map<string, NodeState>();
        for (const t of tr) {
          map.set(t.node, {
            name: t.node,
            status: t.status,
            attempt: t.attempt,
            output: t.output,
            durationMs: t.durationMs,
            cost: t.cost,
            streamText: t.rawResponse ?? '',
            activity: t.activity ?? [],
          });
        }
        // Fill in currently running nodes from the authoritative
        // `exec.currentNodes` field (written synchronously by
        // stateManager.updateExecution before the node runs). Without this,
        // opening the execution page mid-run after SSE has already broadcast
        // `node_started` leaves the running node invisible — SSE has no
        // replay, so events emitted before the subscriber connects are lost,
        // and the auto-select logic never finds a running-status entry to
        // pin the right pane to.
        if (Array.isArray(exec.currentNodes)) {
          for (const name of exec.currentNodes) {
            if (name === 'END' || map.has(name)) continue;
            // Attempt counter mirrors engine.ts:617-618 — count of prior
            // completed attempts + 1, so retries show the right number.
            const priorAttempts = (exec.completedNodes ?? []).filter((n: string) => n === name).length;
            map.set(name, {
              name,
              status: 'running',
              attempt: priorAttempts + 1,
              streamText: '',
              activity: [],
            });
          }
        }
        setNodeStates(map);

        // If waiting for input, synthesize the input_required event from execution state + workflow
        if (exec.status === 'waiting_for_input' && exec.currentNodes?.length > 0) {
          const waitingNode = exec.currentNodes[0];
          // Look up node definition from workflow to get prompt and fields
          let wfForInput = null;
          if (exec.workflowId) {
            try { wfForInput = await wfApi.get(exec.workflowId); } catch {}
          }
          const nodeDef = wfForInput?.parsed?.nodes?.[waitingNode];
          // Use gate-provided fields/reason if available, otherwise fall back to node definition
          const gateReason = exec.state?.__gate_reason;
          const gateFields = exec.state?.__clarify_fields;

          let prompt: string;
          let fields: any[];

          if (gateReason || gateFields) {
            // Auto-gate clarify — use agent-provided prompt and fields
            prompt = (gateReason as string) ?? `Input required for ${waitingNode}`;
            fields = Array.isArray(gateFields) && gateFields.length > 0
              ? gateFields
              : [{ name: 'clarification', type: 'text', label: 'Your response', required: true, placeholder: 'Type your answer here...' }];
          } else if (nodeDef) {
            // Human node — use workflow definition
            prompt = nodeDef.prompt ?? `Input required for ${waitingNode}`;
            for (const [key, val] of Object.entries(exec.state ?? {})) {
              prompt = prompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(val ?? ''));
            }
            fields = nodeDef.fields ?? [];
          } else {
            prompt = `Input required for ${waitingNode}`;
            fields = [{ name: 'clarification', type: 'text', label: prompt, required: true }];
          }

          {
            const inputEvent: TimelineEvent = {
              id: 'synth-input-required',
              timestamp: new Date(),
              event: 'input_required',
              node: waitingNode,
              data: {
                node: waitingNode,
                prompt,
                fields,
              },
            };
            setTimeline(prev => [...prev, inputEvent]);

            // Set the waiting node's status in nodeStates
            setNodeStates(prev => {
              const next = new Map(prev);
              const existing = next.get(waitingNode);
              if (existing) {
                next.set(waitingNode, { ...existing, status: 'waiting_for_input' as any });
              } else {
                next.set(waitingNode, {
                  name: waitingNode,
                  status: 'waiting_for_input' as any,
                  attempt: 1,
                  streamText: '',
                  activity: [],
                });
              }
              return next;
            });
          }
        }

        // Fetch persisted logs for non-live executions.
        //
        // RACE NOTE: `execution_log` events are broadcast over SSE AND written
        // to the `execution_logs` collection via a fire-and-forget insert in
        // `stream.service.ts:broadcastToExecution`. On a fast run, SSE can
        // deliver log events that are still in-flight toward Mongo when this
        // fetch fires — the fetch returns a snapshot missing the tail, and
        // if we REPLACED the logs state here, any SSE-delivered rows that
        // already landed in React state would be silently clobbered.
        //
        // Fix: merge instead of replace, deduping on (timestamp|category|node|
        // message). Also schedule a second fetch 1500ms later to catch rows
        // that the fire-and-forget insert completed just after transition.
        if (exec.status !== 'running' && exec.status !== 'waiting_for_input') {
          const mergeFetched = (fetched: any[]) => {
            const rehydrated: ExecutionLog[] = fetched.map((l: any) => ({
              ...l,
              timestamp: new Date(l.timestamp),
            }));
            setLogs(prev => {
              const seen = new Set<string>();
              const key = (l: ExecutionLog) =>
                `${l.timestamp instanceof Date ? l.timestamp.getTime() : new Date(l.timestamp as any).getTime()}|${l.category}|${l.node ?? ''}|${l.message}`;
              const merged: ExecutionLog[] = [];
              for (const l of [...rehydrated, ...prev]) {
                const k = key(l);
                if (seen.has(k)) continue;
                seen.add(k);
                merged.push(l);
              }
              merged.sort(
                (a, b) =>
                  (a.timestamp instanceof Date ? a.timestamp.getTime() : new Date(a.timestamp as any).getTime()) -
                  (b.timestamp instanceof Date ? b.timestamp.getTime() : new Date(b.timestamp as any).getTime()),
              );
              return merged.length > 2000 ? merged.slice(-2000) : merged;
            });
          };
          api.logs(exec.id).then(mergeFetched).catch(() => {});
          // Second pass — the fire-and-forget Mongo inserts from the tail
          // of the run may land in the ~1.5s after transition. Fetch once
          // more and merge so the operator sees the complete log.
          setTimeout(() => {
            api.logs(exec.id).then(mergeFetched).catch(() => {});
          }, 1500);
        }

        // Build timeline from traces for completed/failed executions
        // (SSE events are only available during live execution)
        if (exec.status !== 'running' && exec.status !== 'waiting_for_input' && tr.length > 0) {
          const events: TimelineEvent[] = [];
          let counter = 0;

          // Execution started event
          events.push({
            id: `hist-${++counter}`,
            timestamp: new Date(exec.startedAt),
            event: 'execution_started',
            data: { workflowName: exec.workflowName },
          });

          // Node events from traces
          for (const t of tr) {
            if (t.startedAt) {
              events.push({
                id: `hist-${++counter}`,
                timestamp: new Date(t.startedAt),
                event: 'node_started',
                node: t.node,
                data: {
                  node: t.node,
                  role: t.role,
                  attempt: t.attempt,
                  // Backfill from trace so historical executions also show
                  // the prompt and input state in the detail pane.
                  renderedPrompt: t.renderedPrompt,
                  inputState: t.inputState,
                },
              });
            }
            if (t.attempt > 1) {
              events.push({
                id: `hist-${++counter}`,
                timestamp: new Date(t.startedAt),
                event: 'node_retrying',
                node: t.node,
                data: { node: t.node, attempt: t.attempt },
              });
            }
            if (t.completedAt) {
              events.push({
                id: `hist-${++counter}`,
                timestamp: new Date(t.completedAt),
                event: t.status === 'failed' ? 'node_failed' : 'node_completed',
                node: t.node,
                data: {
                  node: t.node,
                  durationMs: t.durationMs,
                  cost: t.cost,
                  output: t.output,
                  error: t.status === 'failed' ? (t.output?.error ?? 'Node failed') : undefined,
                },
              });
            }
          }

          // Execution terminal event
          if (exec.completedAt) {
            events.push({
              id: `hist-${++counter}`,
              timestamp: new Date(exec.completedAt),
              event: exec.status === 'failed' ? 'execution_failed' : 'execution_completed',
              data: {
                durationMs: exec.durationMs,
                cost: exec.cost,
                error: exec.errorMessage,
                failedNode: exec.failedNode,
              },
            });
          }

          // Sort by timestamp
          events.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
          setTimeline(events);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [id]);

  // SSE for live updates
  const isLive = execution?.status === 'running' || execution?.status === 'waiting_for_input';
  const sseUrl = id && isLive ? api.streamUrl(id) : null;

  const handleEvent = useCallback((e: SSEEvent) => {
    const entry: TimelineEvent = {
      id: `evt-${++eventCounter.current}`,
      timestamp: new Date(),
      event: e.event,
      node: e.data.node,
      data: e.data,
    };

    // Append execution_log to logs state
    if (e.event === 'execution_log') {
      const logEntry: ExecutionLog = {
        ...(e.data as any),
        timestamp: new Date(e.data.timestamp ?? Date.now()),
      };
      setLogs(prev => {
        const next = [...prev, logEntry];
        return next.length > 2000 ? next.slice(-2000) : next;
      });
      // execution_log events don't go into the timeline
      return;
    }

    // Spawn-tree freshness. Two triggers:
    //   1. `agent_tool_start` for `mcp__allen__spawn_agent` — the orchestrator
    //      just called spawn_agent, so a new child row is landing in Mongo.
    //      Schedule a fetch ~400ms out to let the insert settle.
    //   2. `node_completed` / `node_failed` — catches terminal state for any
    //      spawn the orchestrator kicked off during this node.
    if (id) {
      const toolName = (e.data as any)?.tool as string | undefined;
      const isSpawnToolCall = e.event === 'agent_tool_start'
        && typeof toolName === 'string'
        && toolName.includes('spawn_agent');
      const isNodeTerminal = e.event === 'node_completed' || e.event === 'node_failed';
      if (isSpawnToolCall || isNodeTerminal) {
        // Fire-and-forget. descendantsMode is checked at call time so the
        // toggle state is respected.
        setTimeout(() => {
          api.children(id, descendantsMode ? 'descendants' : 'direct')
            .then(setChildren)
            .catch(() => { /* ignore transient errors */ });
        }, isSpawnToolCall ? 400 : 0);
      }
    }

    setTimeline(prev => {
      const next = [...prev, entry];
      // Cap at 1000 events to prevent memory leak on long-running executions
      return next.length > 1000 ? next.slice(-1000) : next;
    });

    setNodeStates(prev => {
      const next = new Map(prev);
      const node = e.data.node as string | undefined;

      switch (e.event) {
        case 'node_started': {
          if (!node) break;
          next.set(node, {
            name: node,
            status: 'running',
            attempt: e.data.attempt ?? 1,
            streamText: '',
            activity: [],
            renderedPrompt: e.data.renderedPrompt,
            inputState: e.data.inputState,
          });
          break;
        }

        case 'node_completed': {
          if (!node) break;
          const existing = next.get(node);
          next.set(node, {
            name: node,
            status: 'completed',
            attempt: existing?.attempt ?? e.data.attempt ?? 1,
            output: e.data.output,
            durationMs: e.data.durationMs,
            cost: e.data.cost,
            streamText: existing?.streamText ?? '',
            activity: existing?.activity ?? [],
            // Preserve renderedPrompt + inputState from the node_started event
            // so the pane still shows them after completion.
            renderedPrompt: existing?.renderedPrompt,
            inputState: existing?.inputState,
          });
          break;
        }

        case 'node_failed': {
          if (!node) break;
          const existing = next.get(node);
          next.set(node, {
            name: node,
            status: 'failed',
            attempt: existing?.attempt ?? 1,
            streamText: existing?.streamText ?? '',
            activity: existing?.activity ?? [],
            renderedPrompt: existing?.renderedPrompt,
            inputState: existing?.inputState,
          });
          break;
        }

        case 'node_retrying': {
          if (!node) break;
          const existing = next.get(node);
          if (existing) {
            next.set(node, {
              ...existing,
              status: 'running',
              attempt: e.data.attempt ?? (existing.attempt + 1),
              streamText: '',
              activity: [],
              // Clear prompt/inputState — a new node_started event will
              // arrive shortly with the fresh retry prompt.
              renderedPrompt: undefined,
              inputState: undefined,
            });
          }
          break;
        }

        case 'agent_text': {
          if (!node) break;
          const existing = next.get(node);
          if (existing) {
            next.set(node, {
              ...existing,
              streamText: existing.streamText + (e.data.text ?? ''),
            });
          }
          break;
        }

        case 'agent_tool_start': {
          if (!node) break;
          const existing = next.get(node);
          if (existing) {
            next.set(node, {
              ...existing,
              activity: [
                ...existing.activity,
                {
                  timestamp: new Date(),
                  type: 'tool_start',
                  tool: e.data.tool,
                  content: `Using tool: ${e.data.tool}`,
                },
              ],
            });
          }
          break;
        }

        case 'agent_tool_complete': {
          if (!node) break;
          const existing = next.get(node);
          if (existing) {
            next.set(node, {
              ...existing,
              activity: [
                ...existing.activity,
                {
                  timestamp: new Date(),
                  type: 'tool_complete',
                  tool: e.data.tool ?? e.data.record?.tool,
                  content: e.data.summary ?? `Tool completed: ${e.data.tool ?? e.data.record?.tool ?? ''}`,
                },
              ],
            });
          }
          // Append the full tool-call record to the per-node live log. The
          // server-persisted trace.toolCalls will include the same records
          // after the node completes; we de-dupe by toolUseId in the UI.
          if (e.data.record) {
            setLiveToolCallsByNode(prev => {
              const m = new Map(prev);
              const existing = m.get(node) ?? [];
              m.set(node, [...existing, e.data.record]);
              return m;
            });
          }
          break;
        }

        case 'parallel_started': {
          // Mark all parallel nodes as pending
          const nodes = e.data.nodes as string[] | undefined;
          if (nodes) {
            for (const n of nodes) {
              if (!next.has(n)) {
                next.set(n, {
                  name: n,
                  status: 'pending',
                  attempt: 1,
                  streamText: '',
                  activity: [],
                });
              }
            }
          }
          break;
        }

        case 'input_required': {
          if (!node) break;
          const existing = next.get(node);
          if (existing) {
            next.set(node, { ...existing, status: 'waiting_for_input' as any });
          }
          break;
        }

        case 'input_received': {
          if (!node) break;
          const existing = next.get(node);
          if (existing) {
            next.set(node, { ...existing, status: 'running' });
          }
          break;
        }

        // parallel_branch_done, parallel_joined
        // are already reflected in timeline — no additional node state changes needed
      }

      return next;
    });

    // Update execution status on terminal events
    if (e.event === 'execution_completed') {
      setExecution((prev: any) => ({
        ...prev,
        status: 'completed',
        durationMs: e.data.durationMs,
        cost: e.data.cost,
      }));
    } else if (e.event === 'execution_failed') {
      setExecution((prev: any) => ({
        ...prev,
        status: 'failed',
        failedNode: e.data.failedNode,
        errorMessage: e.data.error,
      }));
    } else if (e.event === 'input_required') {
      setExecution((prev: any) => ({ ...prev, status: 'waiting_for_input' }));
    } else if (e.event === 'input_received') {
      setExecution((prev: any) => ({ ...prev, status: 'running' }));
    }
  }, [id, descendantsMode]);

  const { connected } = useSSE(sseUrl, handleEvent);

  const refresh = useCallback(async () => {
    if (!id) return;
    const [exec, tr] = await Promise.all([api.get(id), api.traces(id)]);
    setExecution(exec);
    setTraces(tr);

    // Rebuild nodeStates from traces to fix any missed SSE events
    const map = new Map<string, NodeState>();
    for (const t of tr) {
      map.set(t.node, {
        name: t.node,
        status: t.status,
        attempt: t.attempt,
        output: t.output,
        durationMs: t.durationMs,
        cost: t.cost,
        streamText: t.rawResponse ?? '',
        activity: t.activity ?? [],
      });
    }
    // Merge: keep SSE-provided running states, but fill in any missing nodes from traces
    setNodeStates(prev => {
      const merged = new Map(map);
      // If a node is currently running via SSE but trace shows completed, trust SSE (more recent)
      for (const [name, state] of prev) {
        if (state.status === 'running' && (!merged.has(name) || merged.get(name)?.status !== 'completed')) {
          merged.set(name, state);
        }
      }
      return merged;
    });
    // Also refresh the spawn-tree children list when the user hits Refresh.
    api.children(id, descendantsMode ? 'descendants' : 'direct')
      .then(setChildren)
      .catch(() => { /* ignore */ });
  }, [id, descendantsMode]);

  // When the user toggles descendants mode, re-fetch children with the new scope.
  const toggleDescendants = useCallback((next: boolean) => {
    setDescendantsMode(next);
    if (id) {
      api.children(id, next ? 'descendants' : 'direct')
        .then(setChildren)
        .catch(() => { /* ignore */ });
    }
  }, [id]);

  // Auto-refresh every 5 seconds when execution is active
  useEffect(() => {
    if (!id) return;
    const status = execution?.status;
    if (status !== 'running' && status !== 'waiting_for_input' && status !== 'queued') return;

    const interval = setInterval(() => {
      refresh().catch(() => {});
    }, 5000);

    return () => clearInterval(interval);
  }, [id, execution?.status, refresh]);

  return {
    execution,
    workflow,
    traces,
    timeline,
    nodeStates,
    logs,
    logFilter,
    setLogFilter,
    loading,
    connected,
    isLive: !!isLive,
    refresh,
    // Spawn-tree children — workflow nodes that called `spawn_agent` appear
    // here. `descendantsMode=true` also pulls grandchildren and deeper.
    children,
    descendantsMode,
    toggleDescendants,
    liveToolCallsByNode,
  };
}
