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
import dagre from '@dagrejs/dagre';

import type { NodeState } from '../../hooks/useExecution';
import RoleIcon from '../common/RoleIcon';
import { Handle, Position, type NodeProps } from '@xyflow/react';

// ── Status-aware border/glow styles ──
const statusBorder: Record<string, string> = {
  pending: 'border-gray-600/40',
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
      className={`relative px-4 py-3 rounded-lg border-2 bg-surface-100/90 backdrop-blur-sm min-w-[160px] transition-all
        ${statusBorder[status] ?? statusBorder.pending}
        ${statusRing[status] ?? ''}
        ${selected ? 'ring-2 ring-white/40' : ''}
      `}
    >
      <Handle type="target" position={Position.Top} id="top" className="!opacity-0 !w-1 !h-1" />
      <Handle type="target" position={Position.Right} id="right" className="!opacity-0 !w-1 !h-1" />

      <div className="flex items-center gap-2">
        <RoleIcon icon={d.icon} color={d.color} size={16} />
        <div>
          <div className="text-xs font-label font-medium text-gray-100">{d.label}</div>
          <div className={`text-[10px] font-mono uppercase text-${accent}/70`}>
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
          'bg-gray-600'
        }`} />
        <span className="text-[9px] font-mono text-gray-400 uppercase">{status}</span>
        {d.__durationMs != null && (
          <span className="text-[9px] font-mono text-gray-500">{(d.__durationMs / 1000).toFixed(1)}s</span>
        )}
      </div>

      {/* Outputs pills */}
      {d.outputs?.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {d.outputs.map((o: string) => (
            <span key={o} className={`text-[8px] bg-${accent}/10 text-${accent}/60 px-1 rounded-sm font-mono`}>{o}</span>
          ))}
        </div>
      )}

      {/* Retry badge */}
      {attempt > 1 && (
        <span className="absolute -top-2 -right-2 bg-accent-yellow text-black text-[9px] font-bold rounded-sm w-5 h-5 flex items-center justify-center font-mono">
          {attempt}
        </span>
      )}

      {/* Running ping */}
      {status === 'running' && (
        <span className="absolute -top-1 -right-1 w-3 h-3 bg-accent-blue rounded-full animate-ping" />
      )}

      <Handle type="source" position={Position.Bottom} id="bottom" className="!opacity-0 !w-1 !h-1" />
      <Handle type="source" position={Position.Right} id="right" className="!opacity-0 !w-1 !h-1" />
    </div>
  );
}

import TerminalNode from '../canvas/TerminalNode';

const nodeTypes = { 'exec-node': ExecutionNode, 'ff-terminal': TerminalNode };

import ConditionalEdge from '../canvas/ConditionalEdge';
import RetryEdge from '../canvas/RetryEdge';

const edgeTypes = {
  'ff-conditional': ConditionalEdge,
  'ff-retry': RetryEdge,
};

// ── Dagre Layout ──
const NODE_WIDTH = 180;
const NODE_HEIGHT = 100;

function layoutGraph(nodes: Node[], edges: Edge[]): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'TB', nodesep: 120, ranksep: 130, marginx: 60, marginy: 60 });

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

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

// ── Props ──
interface Props {
  workflow: any;
  nodeStates: Map<string, NodeState>;
  selectedNode: string | null;
  onSelectNode: (name: string) => void;
}

export default function LiveGraph({ workflow, nodeStates, selectedNode, onSelectNode }: Props) {
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
            type: 'default',
            style: { stroke: '#9ca3af', strokeWidth: 2 },
          });
        }
        return rfEdges;
      }
      return [];
    }

    const rfEdges: Edge[] = [];
    for (const edge of workflowEdges) {
      const froms = Array.isArray(edge.from) ? edge.from : [edge.from];
      const tos = Array.isArray(edge.to) ? edge.to : [edge.to];
      for (const from of froms) {
        for (const to of tos) {
          const isRetry = edge.max_retries != null;
          rfEdges.push({
            id: `${from}-${to}`,
            source: from,
            sourceHandle: isRetry ? 'right' : 'bottom',
            target: to,
            targetHandle: isRetry ? 'right' : 'top',
            type: isRetry ? 'ff-retry' : edge.condition ? 'ff-conditional' : 'default',
            label: edge.condition ?? (edge.parallel ? '∥ parallel' : undefined),
            labelStyle: { fill: '#d1d5db', fontSize: 10, fontFamily: 'var(--font-mono)' },
            labelBgStyle: { fill: '#111730', fillOpacity: 0.95 },
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
              color: isRetry ? '#eab308' : edge.condition ? '#a855f7' : '#9ca3af',
            },
            style: isRetry
              ? { stroke: '#eab308', strokeDasharray: '8 5', strokeWidth: 2 }
              : edge.condition
                ? { stroke: '#a855f7', strokeWidth: 2 }
                : { stroke: '#9ca3af', strokeWidth: 2 },
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
      { id: 'START', type: 'ff-terminal', position: { x: 0, y: 0 }, data: { label: 'START' }, selectable: false, draggable: true },
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
    rfNodes.push({ id: 'END', type: 'ff-terminal', position: { x: 0, y: 0 }, data: { label: 'END' }, selectable: false, draggable: true });

    return layoutGraph(rfNodes, edges);
  }, [workflowNodes, edges]);

  // Maintain node state separately so dragging persists
  const [nodes, setNodes] = useState<Node[]>(initialNodes);

  // When initialNodes change (workflow loaded), reset
  useEffect(() => {
    setNodes(initialNodes);
  }, [initialNodes]);

  // When nodeStates change (live updates), update node data without resetting positions
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
        },
      };
    }));
  }, [nodeStates, selectedNode]);

  // Handle drag
  const onNodesChange: OnNodesChange = useCallback((changes) => {
    setNodes(prev => applyNodeChanges(changes, prev));
  }, []);

  const handleReset = useCallback(() => {
    setNodes(initialNodes);
  }, [initialNodes]);

  if (nodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm font-mono">
        WAITING FOR NODES...
      </div>
    );
  }

  return (
    <div className="h-full w-full relative">
      <ReactFlowProvider>
        <LiveGraphInner
          nodes={nodes}
          edges={edges}
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
        fitView
        fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
        colorMode="dark"
        nodesConnectable={false}
        panOnDrag
        zoomOnScroll
        defaultEdgeOptions={{ type: 'default', style: { stroke: '#9ca3af', strokeWidth: 2 } }}
      >
        <Background variant={BackgroundVariant.Lines} gap={30} size={1} color="rgb(var(--color-border) / 0.2)" />
        <Controls
          showInteractive={false}
          className="!bg-surface-100 !border-border/50 !shadow-lg [&>button]:!bg-surface-200 [&>button]:!border-border/50 [&>button]:!text-gray-400 [&>button:hover]:!bg-surface-300 [&>button:hover]:!text-accent-blue"
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
