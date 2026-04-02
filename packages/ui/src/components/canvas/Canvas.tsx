import { useCallback } from 'react';
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
import ConditionalEdge from './ConditionalEdge';
import RetryEdge from './RetryEdge';
import NodePalette from './NodePalette';
import NodeProperties from './NodeProperties';

const nodeTypes = {
  'ff-agent': AgentNode,
  'ff-code': CodeNode,
  'ff-human': HumanNode,
  'ff-workflow': WorkflowNode,
  'ff-condition': AgentNode, // reuse agent shape for condition
};

const edgeTypes = {
  'ff-conditional': ConditionalEdge,
  'ff-retry': RetryEdge,
};

interface Props {
  nodes: Node[];
  edges: Edge[];
  onNodesChange: (nodes: Node[]) => void;
  onEdgesChange: (edges: Edge[]) => void;
}

export default function Canvas({ nodes, edges, onNodesChange, onEdgesChange }: Props) {
  const selectedNode = nodes.find(n => n.selected) ?? null;

  const handleNodesChange: OnNodesChange = useCallback((changes) => {
    const updated = applyNodeChanges(changes, nodes);
    onNodesChange(updated);
  }, [nodes, onNodesChange]);

  const handleEdgesChange: OnEdgesChange = useCallback((changes) => {
    const updated = applyEdgeChanges(changes, edges);
    onEdgesChange(updated);
  }, [edges, onEdgesChange]);

  const handleConnect: OnConnect = useCallback((connection) => {
    const updated = addEdge(
      { ...connection, type: 'default', style: { stroke: '#4b5563' } },
      edges,
    );
    onEdgesChange(updated);
  }, [edges, onEdgesChange]);

  const handleAddNode = useCallback((type: string, defaults: Record<string, any>) => {
    const id = `${type}_${Date.now().toString(36)}`;
    const newNode: Node = {
      id,
      type: `ff-${type}`,
      position: { x: 250, y: 150 + nodes.length * 80 },
      data: { ...defaults, label: id },
    };
    onNodesChange([...nodes, newNode]);
  }, [nodes, onNodesChange]);

  const handleUpdateNode = useCallback((id: string, data: Record<string, any>) => {
    const updated = nodes.map(n =>
      n.id === id ? { ...n, data: { ...data } } : n,
    );
    onNodesChange(updated);
  }, [nodes, onNodesChange]);

  const handleDeleteNode = useCallback((id: string) => {
    onNodesChange(nodes.filter(n => n.id !== id));
    onEdgesChange(edges.filter(e => e.source !== id && e.target !== id));
  }, [nodes, edges, onNodesChange, onEdgesChange]);

  return (
    <div className="flex h-full">
      {/* Left: Node palette */}
      <div className="w-48 border-r border-border bg-surface shrink-0 overflow-auto">
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
          defaultEdgeOptions={{ style: { stroke: '#4b5563', strokeWidth: 2 } }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#222536" />
          <Controls
            showInteractive={false}
            className="!bg-surface-100 !border-border !shadow-lg [&>button]:!bg-surface-200 [&>button]:!border-border [&>button]:!text-gray-300 [&>button:hover]:!bg-surface-300"
          />
        </ReactFlow>
      </div>

      {/* Bottom/Right: Node properties */}
      <div className="w-72 border-l border-border bg-surface shrink-0 overflow-auto">
        <NodeProperties
          node={selectedNode}
          onUpdate={handleUpdateNode}
          onDelete={handleDeleteNode}
        />
      </div>
    </div>
  );
}
