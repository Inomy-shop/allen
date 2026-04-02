import { useCallback, useEffect, useRef } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
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
import ConditionalEdge from './ConditionalEdge';
import RetryEdge from './RetryEdge';
import NodePalette from './NodePalette';
import NodeProperties from './NodeProperties';

const nodeTypes = {
  'ff-agent': AgentNode,
  'ff-code': CodeNode,
  'ff-human': HumanNode,
  'ff-workflow': WorkflowNode,
  'ff-condition': ConditionNode,
};

const edgeTypes = {
  'ff-conditional': ConditionalEdge,
  'ff-retry': RetryEdge,
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
}

export default function Canvas({ nodes, edges, onNodesChange, onEdgesChange }: Props) {
  const selectedNode = nodes.find(n => n.selected) ?? null;
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
      { ...connection, type: 'default', style: { stroke: '#1e2740' } },
      edges,
    );
    onEdgesChange(updated);
  }, [edges, onEdgesChange, pushSnapshot]);

  const handleAddNode = useCallback((type: string, defaults: Record<string, any>) => {
    pushSnapshot();
    const id = `${type}_${Date.now().toString(36)}`;
    const newNode: Node = {
      id,
      type: `ff-${type}`,
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
      {/* Left: Node palette */}
      <div className="w-48 border-r border-border/50 bg-surface shrink-0 overflow-auto">
        <NodePalette onAdd={handleAddNode} />
      </div>

      {/* Center: React Flow canvas */}
      <div className="flex-1 relative">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={handleNodesChange}
          onEdgesChange={handleEdgesChange}
          onConnect={handleConnect}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          colorMode="dark"
          defaultEdgeOptions={{ style: { stroke: '#1e2740', strokeWidth: 2 } }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#1e2740" />
          <Controls
            showInteractive={false}
            className="!bg-surface-100 !border-border/50 !shadow-lg [&>button]:!bg-surface-200 [&>button]:!border-border/50 [&>button]:!text-gray-400 [&>button:hover]:!bg-surface-300 [&>button:hover]:!text-accent-blue"
          />
        </ReactFlow>
      </div>

      {/* Right: Node properties */}
      <div className="w-72 border-l border-border/50 bg-surface shrink-0 overflow-auto">
        <NodeProperties
          node={selectedNode}
          onUpdate={handleUpdateNode}
          onDelete={handleDeleteNode}
        />
      </div>
    </div>
  );
}
