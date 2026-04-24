import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  BackgroundVariant,
  MarkerType,
  useReactFlow,
  ReactFlowProvider,
  type Node,
  type Edge,
  type OnNodesChange,
  applyNodeChanges,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { outputsAsKeys } from '../../utils/outputs';
import dagre from '@dagrejs/dagre';

import type { NodeState } from '../../hooks/useExecution';
import RoleIcon from '../common/RoleIcon';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { applyPositionHandles } from '../../lib/edge-handles';
import { Code2, User, Workflow as WorkflowIcon, GitFork } from 'lucide-react';

// Type-specific icon for the execution graph. Falls back to `null` for
// agent rows so the role-driven RoleIcon keeps rendering. Keeps the
// execution view visually in sync with the editor where each node type
// carries its own distinct glyph.
const TYPE_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  code: Code2,
  human: User,
  workflow: WorkflowIcon,
  condition: GitFork,
};

// ── Status-aware border/glow styles ──
const statusBorder: Record<string, string> = {
  pending: 'border-theme-subtle/40',
  running: 'border-accent-blue shadow-glow-blue',
  completed: 'border-accent-green',
  failed: 'border-accent-red shadow-glow-red',
  waiting_for_input: 'border-accent-yellow shadow-glow-yellow animate-pulse',
};

const statusRing: Record<string, string> = {
  running: 'ring-2 ring-accent-blue/40',
  failed: 'ring-1 ring-accent-red/30',
  waiting_for_input: 'ring-2 ring-accent-yellow/50',
};

function formatDurationShort(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return '';
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const totalMin = Math.floor(totalSec / 60);
  const remainSec = Math.floor(totalSec % 60);
  if (totalMin < 60) return `${totalMin}m ${remainSec}s`;
  const hours = Math.floor(totalMin / 60);
  const remainMin = totalMin % 60;
  return `${hours}h ${remainMin}m`;
}

// ── Execution Node (read-only, status-aware) ──
function ExecutionNode({ data, selected }: NodeProps) {
  const d = data as any;
  const status: string = d.__status ?? 'pending';
  const attempt: number = d.__attempt ?? 1;
  const type: string = d.type ?? 'agent';

  const typeColors: Record<string, string> = {
    agent: 'accent-blue',
    code: 'accent-green',
    human: 'accent-yellow',
    workflow: 'accent-purple',
    condition: 'accent-yellow',
  };
  const accent = typeColors[type] ?? 'accent-blue';

  return (
    <div
      className={`relative px-4 py-3 rounded-lg border-2 bg-surface-100/90 backdrop-blur-sm w-[280px] transition-all
        ${statusBorder[status] ?? statusBorder.pending}
        ${statusRing[status] ?? ''}
        ${selected ? 'ring-2 ring-white/40' : ''}
      `}
    >
      <Handle type="target" position={Position.Top} id="top" className="!opacity-0 !w-1 !h-1" />
      <Handle type="target" position={Position.Right} id="right" className="!opacity-0 !w-1 !h-1" />
      <Handle type="target" position={Position.Left} id="left" className="!opacity-0 !w-1 !h-1" />
      <Handle type="target" position={Position.Bottom} id="bottom" className="!opacity-0 !w-1 !h-1" />

      <div className="flex items-center gap-2 min-w-0">
        {(() => {
          const TypeIcon = TYPE_ICON[type];
          if (TypeIcon) return <TypeIcon className={`w-4 h-4 shrink-0 text-${accent}`} />;
          return <RoleIcon icon={d.icon} color={d.color} size={16} />;
        })()}
        <div className="min-w-0 flex-1">
          <div className="text-xs font-label font-medium text-theme-primary truncate">{d.label}</div>
          <div className={`text-[10px] font-mono uppercase text-${accent}/70 truncate`}>
            {type === 'agent' ? (d.role ?? 'agent') : type === 'code' ? (d.function ?? 'code') : type}
          </div>
        </div>
      </div>

      {/* Status indicator */}
      <div className="flex items-center gap-1.5 mt-1.5">
        <span className={`w-2 h-2 rounded-full ${
          status === 'running' ? 'bg-accent-blue animate-pulse' :
          status === 'completed' ? 'bg-accent-green' :
          status === 'failed' ? 'bg-accent-red' :
          status === 'waiting_for_input' ? 'bg-accent-yellow animate-pulse' :
          'bg-theme-subtle'
        }`} />
        <span className="text-[9px] font-mono text-theme-secondary uppercase">{status}</span>
        {d.__durationMs != null && (
          <span className="text-[9px] font-mono text-theme-muted">{formatDurationShort(d.__durationMs)}</span>
        )}
      </div>

      {/* Outputs pills — capped so a node with many outputs doesn't
          grow tall; overflow collapses into a +N pill tooltip. */}
      {(() => {
        const keys = outputsAsKeys(d.outputs);
        if (keys.length === 0) return null;
        const MAX_VISIBLE = 3;
        const visible = keys.slice(0, MAX_VISIBLE);
        const hidden = keys.length - visible.length;
        return (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {visible.map((o) => (
              <span key={o} className={`text-[8px] bg-${accent}/10 text-${accent}/60 px-1 rounded-sm font-mono`}>{o}</span>
            ))}
            {hidden > 0 && (
              <span
                className={`text-[8px] bg-${accent}/10 text-${accent}/60 px-1 rounded-sm font-mono`}
                title={keys.slice(MAX_VISIBLE).join(', ')}
              >
                +{hidden}
              </span>
            )}
          </div>
        );
      })()}

      {/* Retry badge */}
      {attempt > 1 && (
        <span className="absolute -top-2 -right-2 bg-accent-yellow text-black text-[9px] font-bold rounded-sm w-5 h-5 flex items-center justify-center font-mono">
          {attempt}
        </span>
      )}

      {/* Spawn-count badge — shown when this node called spawn_agent at
          least once. The number reflects direct children only (same scope
          the NodeDetail "Spawned Agents" panel uses by default). */}
      {d.__spawnCount > 0 && (
        <span
          className="absolute -top-2 -left-2 bg-accent-purple/90 text-white text-[9px] font-mono font-bold rounded-full h-5 px-1.5 flex items-center justify-center gap-0.5 border border-accent-purple shadow-sm"
          title={`${d.__spawnCount} spawned agent${d.__spawnCount === 1 ? '' : 's'}`}
        >
          ⚙ {d.__spawnCount}
        </span>
      )}

      {/* Running ping */}
      {status === 'running' && (
        <span className="absolute -top-1 -right-1 w-3 h-3 bg-accent-blue rounded-full animate-ping" />
      )}

      <Handle type="source" position={Position.Bottom} id="bottom" className="!opacity-0 !w-1 !h-1" />
      <Handle type="source" position={Position.Right} id="right" className="!opacity-0 !w-1 !h-1" />
      <Handle type="source" position={Position.Left} id="left" className="!opacity-0 !w-1 !h-1" />
      <Handle type="source" position={Position.Top} id="top" className="!opacity-0 !w-1 !h-1" />
    </div>
  );
}

import TerminalNode from '../canvas/TerminalNode';

const nodeTypes = { 'exec-node': ExecutionNode, 'al-terminal': TerminalNode };

import ConditionalEdge from '../canvas/ConditionalEdge';
import RetryEdge from '../canvas/RetryEdge';
import AutoEdge from '../canvas/AutoEdge';

const edgeTypes = {
  'al-conditional': ConditionalEdge,
  'al-retry': RetryEdge,
  // Auto-routed forward edges. Same component the editor uses, keeping
  // both surfaces visually consistent — straight when source/target are
  // near-vertical, smooth-step otherwise.
  'al-auto': AutoEdge,
};

// ── Dagre Layout ──
const NODE_WIDTH = 280;
const NODE_HEIGHT = 100;

function layoutGraph(nodes: Node[], edges: Edge[]): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  // `acyclicer: 'greedy'` tells dagre to internally flip back edges when
  // building its topological order. Combined with edge filtering below,
  // it prevents retry / escalation-return edges from distorting the
  // layout.
  //
  // ranksep/nodesep bumped so orthogonal smooth-step routing has vertical
  // room for horizontal lanes between ranks — prevents fan-out edges
  // from piling onto the same y-coordinate.
  g.setGraph({
    rankdir: 'TB',
    nodesep: 140,
    ranksep: 200,
    marginx: 60,
    marginy: 60,
    acyclicer: 'greedy',
    ranker: 'network-simplex',
  });

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  // Only feed layout-influencing edges into dagre:
  //   - retry edges (`al-retry`) loop back to an ancestor; they render
  //     as side-loop curves via RetryEdge.tsx and shouldn't pull their
  //     target upward in the layout.
  //   - escalation-return edges from `escalation_review` to ancestors
  //     (clarify / produce_prd / produce_hla / …) are explicit "go back
  //     to a previous stage" routes. Including them in layout would
  //     force escalation_review to rank BEFORE those producers, which
  //     is the opposite of the desired visual (escalation at the
  //     bottom of the flow, producers at the top).
  // Filtering these out leaves dagre with a clean DAG and dramatically
  // reduces edge crossings.
  const layoutEdges = edges.filter((e) => {
    if (e.type === 'al-retry') return false;
    if (e.source === 'escalation_review') return false;
    return true;
  });
  for (const edge of layoutEdges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  // ── Spine column alignment ──
  //
  // Dagre produces reasonable y-coordinates (ranks / stages) but
  // spreads x-coordinates so edges can avoid each other. That's good
  // for general DAGs but bad for workflows — the user wants the main
  // forward path (the "happy trunk") to be a single clean column with
  // all its vertical edges stacking on top of each other.
  //
  // Fix: compute the LONGEST forward path from START to END, force
  // every node on that path onto a common x-coordinate. Branches
  // (escalation_review, clarify_human, …) keep whatever x dagre
  // assigned them and visually sit off to the sides.
  //
  // Result for feature-plan-and-implement.yml: ~15-node spine collapses
  // into one column; ~14 forward edges along the spine overlap into a
  // single vertical trunk; escalation_review and clarify_human appear
  // as side branches.
  const spine = findLongestForwardPath('START', 'END', layoutEdges);
  if (spine.length > 2) {
    // Use the median x of the spine as the shared column — keeps the
    // trunk near the center of the graph's natural bounds.
    const xs = spine.map(id => g.node(id)?.x ?? 0).sort((a, b) => a - b);
    const columnX = xs[Math.floor(xs.length / 2)];
    for (const id of spine) {
      const n = g.node(id);
      if (n) n.x = columnX;
    }
  }

  return nodes.map(node => {
    const pos = g.node(node.id);
    return {
      ...node,
      position: {
        x: (pos?.x ?? 0) - NODE_WIDTH / 2,
        y: (pos?.y ?? 0) - NODE_HEIGHT / 2,
      },
    };
  });
}

/**
 * Longest path from `start` to `end` through the given forward edges.
 * DFS with memoization — O(V + E). Returns an empty array when no path
 * connects them (e.g. during partial loading).
 */
function findLongestForwardPath(start: string, end: string, edges: Edge[]): string[] {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    let list = adj.get(e.source);
    if (!list) { list = []; adj.set(e.source, list); }
    list.push(e.target);
  }
  const memo = new Map<string, string[]>();
  const visiting = new Set<string>();
  function dfs(node: string): string[] {
    if (node === end) return [end];
    if (memo.has(node)) return memo.get(node)!;
    if (visiting.has(node)) return []; // cycle guard (shouldn't trigger on filtered DAG)
    visiting.add(node);
    const next = adj.get(node) ?? [];
    let best: string[] = [];
    for (const n of next) {
      const path = dfs(n);
      if (path.length > best.length) best = path;
    }
    visiting.delete(node);
    const result = best.length ? [node, ...best] : [];
    memo.set(node, result);
    return result;
  }
  return dfs(start);
}

// ── Props ──
interface Props {
  workflow: any;
  nodeStates: Map<string, NodeState>;
  selectedNode: string | null;
  onSelectNode: (name: string) => void;
  /** Count of spawn_agent children per node name. Surfaces as a `⚙ N`
   *  badge on the node so the operator can see at a glance which nodes
   *  kicked off sub-agents. */
  spawnCounts?: Record<string, number>;
}

export default function LiveGraph({ workflow, nodeStates, selectedNode, onSelectNode, spawnCounts = {} }: Props) {
  const workflowNodes = workflow?.parsed?.nodes;
  const workflowEdges: any[] = workflow?.parsed?.edges ?? [];

  // Snapshot nodeStates keys once for fallback (avoids infinite loop from Map reference changes)
  const fallbackNodeNames = useRef<string[] | null>(null);
  if (!workflowNodes && nodeStates.size > 0 && !fallbackNodeNames.current) {
    fallbackNodeNames.current = Array.from(nodeStates.keys());
  }

  // Build edges once from workflow definition (they don't change)
  const edges = useMemo<Edge[]>(() => {
    if (!workflowNodes) {
      // Fallback: build simple sequential edges from snapshot
      const names = fallbackNodeNames.current;
      if (names && names.length > 0) {
        const rfEdges: Edge[] = [];
        for (let i = 0; i < names.length - 1; i++) {
          rfEdges.push({
            id: `${names[i]}-${names[i + 1]}`,
            source: names[i],
            sourceHandle: 'bottom',
            target: names[i + 1],
            targetHandle: 'top',
            // Orthogonal auto-routed edge (was 'default' = bezier curve).
            type: 'al-auto',
            style: { stroke: 'rgb(var(--color-flow-edge-default))', strokeWidth: 2.5 },
          });
        }
        return rfEdges;
      }
      return [];
    }

    const rfEdges: Edge[] = [];
    const retryCountPerTarget: Record<string, number> = {};
    for (const edge of workflowEdges) {
      const froms = Array.isArray(edge.from) ? edge.from : [edge.from];
      const tos = Array.isArray(edge.to) ? edge.to : [edge.to];
      for (const from of froms) {
        for (const to of tos) {
          const isRetry = edge.max_retries != null;

          let retrySide: 'right' | 'left' = 'right';
          if (isRetry) {
            retryCountPerTarget[to] = (retryCountPerTarget[to] ?? 0) + 1;
            retrySide = retryCountPerTarget[to] % 2 === 1 ? 'right' : 'left';
          }

          rfEdges.push({
            id: `${from}-${to}`,
            source: from,
            sourceHandle: isRetry ? retrySide : 'bottom',
            target: to,
            targetHandle: isRetry ? retrySide : 'top',
            // Orthogonal auto-routed edge for plain forward edges (was
            // 'default' = bezier curve).
            type: isRetry ? 'al-retry' : edge.condition ? 'al-conditional' : 'al-auto',
            label: edge.condition ?? (edge.parallel ? '∥ parallel' : undefined),
            labelStyle: { fill: 'rgb(var(--color-text-secondary))', fontSize: 10, fontFamily: 'var(--font-mono)' },
            labelBgStyle: { fill: 'rgb(var(--color-surface-100))', fillOpacity: 0.95 },
            labelBgPadding: [8, 4] as [number, number],
            labelBgBorderRadius: 3,
            data: {
              condition: edge.condition,
              parallel: edge.parallel,
              max_retries: edge.max_retries,
            },
            animated: !!edge.parallel,
            markerEnd: {
              type: MarkerType.ArrowClosed,
              width: 16,
              height: 16,
              color: isRetry ? 'rgb(var(--color-flow-edge-retry))' : edge.condition ? 'rgb(var(--color-flow-edge-conditional))' : 'rgb(var(--color-flow-edge-default))',
            },
            style: isRetry
              ? { stroke: 'rgb(var(--color-flow-edge-retry))', strokeDasharray: '8 5', strokeWidth: 2.5 }
              : edge.condition
                ? { stroke: 'rgb(var(--color-flow-edge-conditional))', strokeWidth: 2.5 }
                : { stroke: 'rgb(var(--color-flow-edge-default))', strokeWidth: 2.5 },
          });
        }
      }
    }
    return rfEdges;
  }, [workflowNodes, workflowEdges]);

  // Build initial node positions from dagre layout (once)
  const initialNodes = useMemo<Node[]>(() => {
    if (!workflowNodes) {
      // Fallback: build nodes from snapshot
      const names = fallbackNodeNames.current;
      if (names && names.length > 0) {
        const rfNodes: Node[] = names.map(name => ({
          id: name,
          type: 'exec-node',
          position: { x: 0, y: 0 },
          data: {
            label: name,
            type: 'agent',
            __status: 'pending',
            __attempt: 1,
            __durationMs: undefined,
          },
        }));
        return layoutGraph(rfNodes, edges);
      }
      return [];
    }
    const nodeEntries = Object.entries(workflowNodes) as [string, any][];

    const rfNodes: Node[] = [
      // START terminal
      { id: 'START', type: 'al-terminal', position: { x: 0, y: 0 }, data: { label: 'START' }, selectable: false, draggable: true },
    ];

    rfNodes.push(...nodeEntries.map(([name, nodeDef]) => ({
      id: name,
      type: 'exec-node',
      position: { x: 0, y: 0 },
      data: {
        ...nodeDef,
        label: name,
        type: nodeDef.type ?? 'agent',
        __status: 'pending',
        __attempt: 1,
        __durationMs: undefined,
      },
    })));

    // END terminal
    rfNodes.push({ id: 'END', type: 'al-terminal', position: { x: 0, y: 0 }, data: { label: 'END' }, selectable: false, draggable: true });

    return layoutGraph(rfNodes, edges);
  }, [workflowNodes, edges]);

  // Maintain node state separately so dragging persists
  const [nodes, setNodes] = useState<Node[]>(initialNodes);

  // When initialNodes change (workflow loaded), reset
  useEffect(() => {
    setNodes(initialNodes);
  }, [initialNodes]);

  // When nodeStates or spawnCounts change (live updates), update node data
  // without resetting positions
  useEffect(() => {
    setNodes(prev => prev.map(node => {
      const state = nodeStates.get(node.id);
      return {
        ...node,
        selected: selectedNode === node.id,
        data: {
          ...node.data,
          __status: state?.status ?? 'pending',
          __attempt: state?.attempt ?? 1,
          __durationMs: state?.durationMs,
          __spawnCount: spawnCounts[node.id] ?? 0,
        },
      };
    }));
  }, [nodeStates, selectedNode, spawnCounts]);

  // ── Direction-aware handle reassignment ──
  //
  // Pick the source/target handle for each non-retry edge based on the
  // relative geometry of its two nodes. The dominant axis (dx vs dy)
  // decides which face of each node the edge leaves/enters through, so
  // backward and same-rank edges don't funnel through top/bottom and
  // diagonal fan-outs don't pile into a single top handle.
  //
  // Retry edges (`al-retry`) already pick their own side in the main
  // edge builder, so they pass through unchanged.
  //
  // Tracks `nodes` (not just initialNodes) so dragging a node live-
  // reroutes its edges instead of pinning them to the initial layout.
  const positionedEdges = useMemo<Edge[]>(
    () => (nodes.length === 0 ? edges : applyPositionHandles(nodes, edges)),
    [edges, nodes],
  );

  // Derived edges that ReactFlow actually renders. Every edge is
  // always visible — edge overlap (shared stubs, spine-column
  // alignment, right-side routing for upward edges) is what keeps the
  // graph readable rather than hiding anything.
  //
  // Selection contrast: when a node is selected, edges touching it
  // switch to the accent color with a thicker stroke, and all other
  // edges fade to 0.15 opacity. Connected edges become visually
  // obvious without the user having to trace them.
  const displayEdges = useMemo<Edge[]>(() => {
    return positionedEdges.map((e) => {
      if (!selectedNode) return e;
      const isConnected = e.source === selectedNode || e.target === selectedNode;
      const baseStyle = (e.style as any) ?? {};
      return {
        ...e,
        // No zIndex override — React Flow renders zero-z edges in the
        // layer below nodes, so an edge never visually passes over a
        // node (even when highlighted). Non-highlighted edges fade to
        // 0.15, which keeps the accent edge readable despite the
        // shared layer.
        style: {
          ...baseStyle,
          opacity: isConnected ? 1 : 0.08,
          stroke: isConnected ? 'rgb(var(--color-accent))' : baseStyle.stroke,
        },
        animated: isConnected ? e.animated : false,
      };
    });
  }, [positionedEdges, selectedNode]);

  // Neighbourhood of the selected node — the node itself plus any
  // node sharing an edge with it. Drives the node-fade so a click
  // visually isolates the local area instead of leaving unrelated
  // nodes at full opacity.
  const connectedIds = useMemo(() => {
    if (!selectedNode) return null;
    const set = new Set<string>([selectedNode]);
    for (const e of positionedEdges) {
      if (e.source === selectedNode) set.add(e.target);
      else if (e.target === selectedNode) set.add(e.source);
    }
    return set;
  }, [positionedEdges, selectedNode]);

  const displayNodes = useMemo<Node[]>(() => {
    if (!connectedIds) return nodes;
    return nodes.map((n) => {
      const inNeighbourhood = connectedIds.has(n.id);
      return {
        ...n,
        style: {
          ...(n.style ?? {}),
          // Fade + desaturate nodes outside the neighbourhood so the
          // selected node and its immediate graph truly own the focus.
          opacity: inNeighbourhood ? 1 : 0.15,
          filter: inNeighbourhood ? undefined : 'grayscale(100%)',
        },
      };
    });
  }, [nodes, connectedIds]);

  // Handle drag
  const onNodesChange: OnNodesChange = useCallback((changes) => {
    setNodes(prev => applyNodeChanges(changes, prev));
  }, []);

  const handleReset = useCallback(() => {
    setNodes(initialNodes);
  }, [initialNodes]);

  if (nodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-theme-muted text-sm font-mono">
        WAITING FOR NODES...
      </div>
    );
  }

  return (
    <div className="h-full w-full relative">
      <ReactFlowProvider>
        <LiveGraphInner
          nodes={displayNodes}
          edges={displayEdges}
          onNodesChange={onNodesChange}
          onNodeClick={onSelectNode}
          onReset={handleReset}
        />
      </ReactFlowProvider>
    </div>
  );
}

// Inner component that can use useReactFlow (must be inside ReactFlowProvider)
function LiveGraphInner({
  nodes, edges, onNodesChange, onNodeClick, onReset,
}: {
  nodes: Node[];
  edges: Edge[];
  onNodesChange: OnNodesChange;
  onNodeClick: (name: string) => void;
  onReset: () => void;
}) {
  const { fitView } = useReactFlow();

  const handleReset = useCallback(() => {
    onReset();
    // Wait for state update then fit view
    setTimeout(() => fitView({ padding: 0.3, maxZoom: 1 }), 50);
  }, [onReset, fitView]);

  return (
    <>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={(_e, node) => onNodeClick(node.id)}
        // Click on empty canvas clears the selection so the edge
        // highlight fades and the full graph returns to normal opacity.
        onPaneClick={() => onNodeClick('')}
        fitView
        fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
        colorMode={document.documentElement.classList.contains('dark') ? 'dark' : 'light'}
        nodesConnectable={false}
        panOnDrag
        zoomOnScroll
        defaultEdgeOptions={{
          // Auto-routed: straight for near-vertical pairs, smooth-step for
          // shallow diagonals. Replaces the curved bezier default.
          type: 'al-auto',
          style: { stroke: 'rgb(var(--color-flow-edge-default))', strokeWidth: 2.25 },
        }}
      >
        <Background variant={BackgroundVariant.Lines} gap={30} size={1} color="rgb(var(--color-border) / 0.2)" />
        <Controls
          showInteractive={false}
          className="!bg-surface-100 !border-border/50 !shadow-lg [&>button]:!bg-surface-200 [&>button]:!border-border/50 [&>button]:!text-theme-secondary [&>button:hover]:!bg-surface-300 [&>button:hover]:!text-accent-blue"
        />
      </ReactFlow>

      {/* Reset button */}
      <button
        onClick={handleReset}
        className="absolute top-3 right-3 z-10 btn-ghost text-[10px] px-2 py-1 flex items-center gap-1"
        title="Reset layout"
      >
        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
          <path d="M3 3v5h5" />
        </svg>
        Reset
      </button>
    </>
  );
}
