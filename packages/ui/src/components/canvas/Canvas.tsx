import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useResizable } from '../../hooks/useResizable';
import {
  ReactFlow,
  Background,
  Controls,
  MarkerType,
  ReactFlowProvider,
  useReactFlow,
  type Node,
  type Edge,
  type OnNodesChange,
  type OnEdgesChange,
  type OnConnect,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  BackgroundVariant,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import AgentNode from './AgentNode';
import CodeNode from './CodeNode';
import HumanNode from './HumanNode';
import WorkflowNode from './WorkflowNode';
import ConditionNode from './ConditionNode';
import TerminalNode from './TerminalNode';
import ConditionalEdge from './ConditionalEdge';
import RetryEdge from './RetryEdge';
import AutoEdge from './AutoEdge';
import NodePalette from './NodePalette';
import NodeProperties from './NodeProperties';
import EdgeProperties from './EdgeProperties';
import { applyPositionHandles } from '../../lib/edge-handles';
import { decorateEdge, type EdgeSemantics } from '../../lib/edge-semantics';

const nodeTypes = {
  'al-agent': AgentNode,
  'al-code': CodeNode,
  'al-human': HumanNode,
  'al-workflow': WorkflowNode,
  'al-condition': ConditionNode,
  'al-terminal': TerminalNode,
};

const edgeTypes = {
  'al-conditional': ConditionalEdge,
  'al-retry': RetryEdge,
  // Auto-routed forward edges. Straight when near-vertical, smooth-step
  // (right-angled with rounded corners) when the geometry would otherwise
  // draw a shallow awkward diagonal. Used as the default for edges that
  // carry no condition / no max_retries.
  'al-auto': AutoEdge,
};

// ── Simple undo/redo stack ──────────────────────────────────────────────────
interface Snapshot {
  nodes: Node[];
  edges: Edge[];
}

type NodesChangeHandler = (nodes: Node[], markDirty?: boolean) => void;
type EdgesChangeHandler = (edges: Edge[], markDirty?: boolean) => void;

function useUndoRedo(
  nodes: Node[],
  edges: Edge[],
  setNodes: NodesChangeHandler,
  setEdges: EdgesChangeHandler,
) {
  const undoStack = useRef<Snapshot[]>([]);
  const redoStack = useRef<Snapshot[]>([]);
  const lastPush = useRef(0);

  const pushSnapshot = useCallback(() => {
    // Throttle: don't push more than once every 300ms
    const now = Date.now();
    if (now - lastPush.current < 300) return;
    lastPush.current = now;

    undoStack.current.push({ nodes: structuredClone(nodes), edges: structuredClone(edges) });
    if (undoStack.current.length > 50) undoStack.current.shift();
    redoStack.current = [];
  }, [nodes, edges]);

  const undo = useCallback(() => {
    const prev = undoStack.current.pop();
    if (!prev) return;
    redoStack.current.push({ nodes: structuredClone(nodes), edges: structuredClone(edges) });
    setNodes(prev.nodes, true);
    setEdges(prev.edges, true);
  }, [nodes, edges, setNodes, setEdges]);

  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push({ nodes: structuredClone(nodes), edges: structuredClone(edges) });
    setNodes(next.nodes, true);
    setEdges(next.edges, true);
  }, [nodes, edges, setNodes, setEdges]);

  return { pushSnapshot, undo, redo, canUndo: undoStack.current.length > 0, canRedo: redoStack.current.length > 0 };
}

// ── Canvas Component ────────────────────────────────────────────────────────

interface Props {
  nodes: Node[];
  edges: Edge[];
  onNodesChange: NodesChangeHandler;
  onEdgesChange: EdgesChangeHandler;
  workflowInput?: Record<string, any> | null;
  workflowContext?: Record<string, any> | null;
  onWorkflowMetaPatch?: (patch: { input?: any; context?: any }) => void;
}

export default function Canvas({ nodes, edges, onNodesChange, onEdgesChange, workflowInput, workflowContext, onWorkflowMetaPatch }: Props) {
  const selectedNode = nodes.find(n => n.selected) ?? null;
  const selectedEdge = edges.find(e => e.selected) ?? null;
  // Close hides the panel; selecting a node/edge brings it back.
  const [closed, setClosed] = useState(false);
  const selectionKey = selectedNode?.id ?? selectedEdge?.id ?? null;
  useEffect(() => {
    if (selectionKey) setClosed(false);
  }, [selectionKey]);
  const { size: propsWidth, handleMouseDown: propsResizeStart } = useResizable({ direction: 'horizontal', initialSize: 432, minSize: 260, maxSize: 640 });
  const { pushSnapshot, undo, redo } = useUndoRedo(nodes, edges, onNodesChange, onEdgesChange);

  // Keyboard shortcut for undo/redo
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [undo, redo]);

  const handleNodesChange: OnNodesChange = useCallback((changes) => {
    // Push snapshot before structural changes (add/remove), not position drags
    const isStructural = changes.some(c => c.type === 'remove' || c.type === 'add');
    if (isStructural) pushSnapshot();
    const updated = applyNodeChanges(changes, nodes);
    const isPersistent = changes.some(c =>
      c.type === 'remove'
      || c.type === 'add'
      || c.type === 'replace',
    );
    onNodesChange(updated, isPersistent);
  }, [nodes, onNodesChange, pushSnapshot]);

  const handleEdgesChange: OnEdgesChange = useCallback((changes) => {
    const isStructural = changes.some(c => c.type === 'remove' || c.type === 'add');
    if (isStructural) pushSnapshot();
    const updated = applyEdgeChanges(changes, edges);
    const isPersistent = changes.some(c =>
      c.type === 'remove'
      || c.type === 'add'
      || c.type === 'replace',
    );
    onEdgesChange(updated, isPersistent);
  }, [edges, onEdgesChange, pushSnapshot]);

  const handleConnect: OnConnect = useCallback((connection) => {
    pushSnapshot();
    const updated = addEdge(
      {
        ...connection,
        // Auto-routed edge — straight when geometry permits, smooth-step
        // otherwise. Previously used 'default' (bezier curve).
        type: 'al-auto',
        style: { stroke: 'rgb(var(--color-flow-edge-default))' },
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: 'rgb(var(--color-flow-edge-default))' },
      },
      edges,
    );
    onEdgesChange(updated, true);
  }, [edges, onEdgesChange, pushSnapshot]);

  const handleAddNode = useCallback((type: string, defaults: Record<string, any>) => {
    pushSnapshot();
    const id = `${type}_${Date.now().toString(36)}`;
    const newNode: Node = {
      id,
      type: `al-${type}`,
      position: { x: 250, y: 150 + nodes.length * 80 },
      data: { ...defaults, label: id },
    };
    onNodesChange([...nodes, newNode], true);
  }, [nodes, onNodesChange, pushSnapshot]);

  const handleUpdateNode = useCallback((id: string, data: Record<string, any>) => {
    pushSnapshot();
    const updated = nodes.map(n =>
      n.id === id ? { ...n, data: { ...data } } : n,
    );
    onNodesChange(updated, true);
  }, [nodes, onNodesChange, pushSnapshot]);

  const handleDeleteNode = useCallback((id: string) => {
    pushSnapshot();
    onNodesChange(nodes.filter(n => n.id !== id), true);
    onEdgesChange(edges.filter(e => e.source !== id && e.target !== id), true);
  }, [nodes, edges, onNodesChange, onEdgesChange, pushSnapshot]);

  // Edge control-flow editing. `data` carries the semantics (condition,
  // parallel, join, merge, max_retries, retry_context); decorateEdge derives
  // the matching edge type / style / handles so the canvas re-renders the
  // edge the same way a YAML-loaded edge would look. When an edge is toggled
  // parallel we propagate the flag to every sibling leaving the same source,
  // since the converter groups parallel branches by source.
  const handleUpdateEdge = useCallback((id: string, data: EdgeSemantics) => {
    pushSnapshot();
    const target = edges.find(e => e.id === id);
    const source = target?.source;
    const updated = edges.map((e) => {
      if (e.id === id) return decorateEdge({ ...e, data: data as Record<string, unknown> });
      if (data.parallel && source && e.source === source) {
        const nextData = { ...(e.data as EdgeSemantics), parallel: true };
        return decorateEdge({ ...e, data: nextData as Record<string, unknown> });
      }
      if (!data.parallel && source && e.source === source && (e.data as EdgeSemantics)?.parallel) {
        const { parallel: _drop, join: _join, merge: _merge, ...rest } = (e.data as EdgeSemantics) ?? {};
        return decorateEdge({ ...e, data: rest as Record<string, unknown> });
      }
      return e;
    });
    onEdgesChange(updated, true);
  }, [edges, onEdgesChange, pushSnapshot]);

  const handleDeleteEdge = useCallback((id: string) => {
    pushSnapshot();
    onEdgesChange(edges.filter(e => e.id !== id), true);
  }, [edges, onEdgesChange, pushSnapshot]);

  // Route each edge through the handle side that best matches the
  // current relative positions of its endpoints, then overlay a
  // selection-aware highlight so clicking a node brightens its direct
  // edges and fades the rest. Recomputed on every render so dragging a
  // node live-reroutes its edges instead of keeping them pinned to
  // whatever handle was chosen at creation.
  const selectedId = selectedNode?.id ?? null;

  // Set of nodes directly connected to the selected one (the selected
  // node itself plus every edge neighbour). Used to fade unrelated
  // nodes alongside unrelated edges, so a click fully isolates the
  // neighbourhood instead of leaving other nodes at full opacity.
  const connectedIds = useMemo(() => {
    if (!selectedId) return null;
    const set = new Set<string>([selectedId]);
    for (const e of edges) {
      if (e.source === selectedId) set.add(e.target);
      else if (e.target === selectedId) set.add(e.source);
    }
    return set;
  }, [edges, selectedId]);

  const displayNodes = useMemo(() => {
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

  const displayEdges = useMemo(() => {
    const routed = applyPositionHandles(nodes, edges).map((edge) => {
      if (edge.type === 'al-retry') return edge;
      const data = edge.data as Record<string, unknown> | undefined;
      if (!data || !('routePoints' in data)) return edge;
      const { routePoints: _routePoints, ...liveData } = data;
      return { ...edge, data: liveData };
    });
    if (!selectedId) {
      return routed.map(e => ({ ...e, zIndex: 2 }));
    }
    return routed.map((e) => {
      const isConnected = e.source === selectedId || e.target === selectedId;
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
          strokeWidth: isConnected ? 3.5 : baseStyle.strokeWidth,
        },
        zIndex: isConnected ? 8 : 1,
        animated: isConnected ? e.animated : false,
      };
    });
  }, [nodes, edges, selectedId]);

  return (
    <div className="flex h-full">
      {/* Canvas with floating palette */}
      <div className="flex-1 relative">
        {/* Floating node palette — top left on canvas */}
        <div className="absolute top-3 left-3 z-10">
          <NodePalette onAdd={handleAddNode} />
        </div>

        <ReactFlowProvider>
          <CanvasInner
            nodes={displayNodes}
            edges={displayEdges}
            onNodesChange={handleNodesChange}
            onEdgesChange={handleEdgesChange}
            onConnect={handleConnect}
          />
        </ReactFlowProvider>
      </div>

      {/* Right: Node properties — resizable, closable */}
      {!closed && (
        <div className="bg-surface shrink-0 overflow-auto border-l-2 border-app hover:border-accent-blue/50 transition-colors relative" style={{ width: propsWidth }}>
          <div className="absolute top-0 left-0 bottom-0 w-2 cursor-col-resize z-10" onMouseDown={propsResizeStart} />
          {selectedEdge && !selectedNode ? (
            <EdgeProperties
              edge={selectedEdge}
              onUpdate={handleUpdateEdge}
              onDelete={handleDeleteEdge}
              onClose={() => setClosed(true)}
            />
          ) : (
            <NodeProperties
              node={selectedNode}
              onUpdate={handleUpdateNode}
              onDelete={handleDeleteNode}
              workflowInput={workflowInput ?? null}
              workflowContext={workflowContext ?? null}
              onWorkflowMetaPatch={onWorkflowMetaPatch}
              nodeIds={nodes.map(n => n.id)}
              onClose={() => setClosed(true)}
            />
          )}
        </div>
      )}
    </div>
  );
}

function CanvasInner({
  nodes, edges, onNodesChange, onEdgesChange, onConnect,
}: {
  nodes: Node[];
  edges: Edge[];
  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;
}) {
  const { fitView } = useReactFlow();

  const handleReset = useCallback(() => {
    fitView({ padding: 0.3, maxZoom: 1 });
  }, [fitView]);

  return (
    <>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
        colorMode={document.documentElement.classList.contains('dark') ? 'dark' : 'light'}
        defaultEdgeOptions={{
          // Auto-routed: straight for near-vertical pairs, smooth-step
          // (right-angled) for shallow-diagonal pairs. Removes the curved
          // bezier look.
          type: 'al-auto',
          style: { stroke: 'rgb(var(--color-flow-edge-default))', strokeWidth: 2.25 },
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: 'rgb(var(--color-flow-edge-default))' },
        }}
      >
        <Background variant={BackgroundVariant.Lines} gap={30} size={1} color="rgb(var(--color-border) / 0.2)" />
        <Controls
          showInteractive={false}
          className="!bg-surface-100 !border-app !shadow-lg [&>button]:!bg-surface-200 [&>button]:!border-app [&>button]:!text-theme-secondary [&>button:hover]:!bg-surface-300 [&>button:hover]:!text-accent-blue"
        />
      </ReactFlow>

      <button
        onClick={handleReset}
        className="absolute top-3 right-3 z-10 btn-ghost text-[10px] px-2 py-1 inline-flex items-center gap-1 whitespace-nowrap"
        title="Reset view"
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
