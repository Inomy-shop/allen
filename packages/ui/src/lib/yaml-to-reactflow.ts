import { MarkerType, type Node, type Edge } from '@xyflow/react';
import dagre from '@dagrejs/dagre';

const NODE_WIDTH = 180;
const NODE_HEIGHT = 80;

/**
 * Convert a parsed workflow definition into React Flow nodes and edges
 * with dagre-based topological layout.
 */
export function yamlToReactFlow(
  workflow: any,
): { nodes: Node[]; edges: Edge[] } {
  if (!workflow?.nodes) return { nodes: [], edges: [] };

  const nodeEntries = Object.entries(workflow.nodes) as [string, any][];
  const rfNodes: Node[] = [];
  const rfEdges: Edge[] = [];

  // Build edges first so dagre can compute layout
  if (workflow.edges) {
    for (const edge of workflow.edges) {
      const froms = Array.isArray(edge.from) ? edge.from : [edge.from];
      const tos = Array.isArray(edge.to) ? edge.to : [edge.to];

      for (const from of froms) {
        for (const to of tos) {
          const isRetry = edge.max_retries != null;
          rfEdges.push({
            id: `${from}-${to}`,
            source: from,
            target: to,
            type: isRetry ? 'ff-retry' : edge.condition ? 'ff-conditional' : 'default',
            label: edge.condition ?? (edge.parallel ? '∥' : undefined),
            data: {
              condition: edge.condition,
              parallel: edge.parallel,
              max_retries: edge.max_retries,
              retry_context: edge.retry_context,
              join: edge.join,
              merge: edge.merge,
            },
            animated: !!edge.parallel,
            markerEnd: {
              type: MarkerType.ArrowClosed,
              width: 16,
              height: 16,
              color: isRetry ? '#eab308' : edge.condition ? '#a855f7' : '#4b5563',
            },
            style: isRetry
              ? { stroke: '#eab308', strokeDasharray: '5 3' }
              : edge.condition
                ? { stroke: '#a855f7' }
                : { stroke: '#4b5563' },
          });
        }
      }
    }
  }

  // Dagre layout
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'TB', nodesep: 60, ranksep: 80, marginx: 40, marginy: 40 });

  // Add START and END as virtual nodes for layout
  g.setNode('START', { width: NODE_WIDTH, height: 40 });
  g.setNode('END', { width: NODE_WIDTH, height: 40 });

  for (const [name] of nodeEntries) {
    g.setNode(name, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }

  for (const edge of rfEdges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  // Add START node
  const startPos = g.node('START');
  rfNodes.push({
    id: 'START',
    type: 'ff-terminal',
    position: { x: (startPos?.x ?? 0) - 60, y: (startPos?.y ?? 0) - 20 },
    data: { label: 'START' },
    deletable: false,
  });

  // Create RF nodes with dagre positions
  for (const [name, nodeDef] of nodeEntries) {
    const dagreNode = g.node(name);
    const type = nodeDef.type ?? 'agent';

    rfNodes.push({
      id: name,
      type: `ff-${type}`,
      position: {
        x: (dagreNode?.x ?? 0) - NODE_WIDTH / 2,
        y: (dagreNode?.y ?? 0) - NODE_HEIGHT / 2,
      },
      data: { ...nodeDef, label: name },
    });
  }

  // Add END node
  const endPos = g.node('END');
  rfNodes.push({
    id: 'END',
    type: 'ff-terminal',
    position: { x: (endPos?.x ?? 0) - 60, y: (endPos?.y ?? 0) - 20 },
    data: { label: 'END' },
    deletable: false,
  });

  return { nodes: rfNodes, edges: rfEdges };
}
