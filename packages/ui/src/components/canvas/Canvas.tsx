import { useCallback, useEffect, useRef } from 'react';
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
import NodePalette from './NodePalette';
import NodeProperties from './NodeProperties';

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
};

// ── Simple undo/redo stack ──────────────────────────────────────────────────
interface Snapshot {
  nodes: Node[];
  edges: Edge[];
}

function useUndoRedo(
  nodes: Node[],
  edges: Edge[],
  setNodes: (n: Node[]) => void,
  setEdges: (e: Edge[]) => void,
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
    setNodes(prev.nodes);
    setEdges(prev.edges);
  }, [nodes, edges, setNodes, setEdges]);

  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push({ nodes: structuredClone(nodes), edges: structuredClone(edges) });
    setNodes(next.nodes);
    setEdges(next.edges);
  }, [nodes, edges, setNodes, setEdges]);

  return { pushSnapshot, undo, redo, canUndo: undoStack.current.length > 0, canRedo: redoStack.current.length > 0 };
}

// ── Canvas Component ────────────────────────────────────────────────────────

interface Props {
  nodes: Node[];
  edges: Edge[];
  onNodesChange: (nodes: Node[]) => void;
  onEdgesChange: (edges: Edge[]) => void;
  workflowInput?: Record<string, any> | null;
}

export default function Canvas({ nodes, edges, onNodesChange, onEdgesChange, workflowInput }: Props) {
  const selectedNode = nodes.find(n => n.selected) ?? null;
  const { size: propsWidth, handleMouseDown: propsResizeStart } = useResizable({ direction: 'horizontal', initialSize: 288, minSize: 220, maxSize: 500 });
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
    onNodesChange(updated);
  }, [nodes, onNodesChange, pushSnapshot]);

  const handleEdgesChange: OnEdgesChange = useCallback((changes) => {
    const isStructural = changes.some(c => c.type === 'remove' || c.type === 'add');
    if (isStructural) pushSnapshot();
    const updated = applyEdgeChanges(changes, edges);
    onEdgesChange(updated);
  }, [edges, onEdgesChange, pushSnapshot]);

  const handleConnect: OnConnect = useCallback((connection) => {
    pushSnapshot();
    const updated = addEdge(
      {
        ...connection,
        type: 'default',
        style: { stroke: 'rgb(var(--color-flow-edge-default))' },
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: 'rgb(var(--color-flow-edge-default))' },
      },
      edges,
    );
    onEdgesChange(updated);
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
    onNodesChange([...nodes, newNode]);
  }, [nodes, onNodesChange, pushSnapshot]);

  const handleUpdateNode = useCallback((id: string, data: Record<string, any>) => {
    pushSnapshot();
    const updated = nodes.map(n =>
      n.id === id ? { ...n, data: { ...data } } : n,
    );
    onNodesChange(updated);
  }, [nodes, onNodesChange, pushSnapshot]);

  const handleDeleteNode = useCallback((id: string) => {
    pushSnapshot();
    onNodesChange(nodes.filter(n => n.id !== id));
    onEdgesChange(edges.filter(e => e.source !== id && e.target !== id));
  }, [nodes, edges, onNodesChange, onEdgesChange, pushSnapshot]);

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
            nodes={nodes}
            edges={edges}
            onNodesChange={handleNodesChange}
            onEdgesChange={handleEdgesChange}
            onConnect={handleConnect}
          />
        </ReactFlowProvider>
      </div>

      {/* Right: Node properties — resizable */}
      <div className="bg-surface shrink-0 overflow-auto border-l-2 border-border/50 hover:border-accent-blue/50 transition-colors relative" style={{ width: propsWidth }}>
        <div className="absolute top-0 left-0 bottom-0 w-2 cursor-col-resize z-10" onMouseDown={propsResizeStart} />
        <NodeProperties
          node={selectedNode}
          onUpdate={handleUpdateNode}
          onDelete={handleDeleteNode}
          workflowInput={workflowInput ?? null}
        />
      </div>
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
          style: { stroke: 'rgb(var(--color-flow-edge-default))', strokeWidth: 2 },
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: 'rgb(var(--color-flow-edge-default))' },
        }}
      >
        <Background variant={BackgroundVariant.Lines} gap={30} size={1} color="rgb(var(--color-border) / 0.2)" />
        <Controls
          showInteractive={false}
          className="!bg-surface-100 !border-border/50 !shadow-lg [&>button]:!bg-surface-200 [&>button]:!border-border/50 [&>button]:!text-theme-secondary [&>button:hover]:!bg-surface-300 [&>button:hover]:!text-accent-blue"
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
