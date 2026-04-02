import type { Node, Edge } from '@xyflow/react';

/**
 * Convert a parsed workflow definition into React Flow nodes and edges.
 */
export function yamlToReactFlow(
  workflow: any,
): { nodes: Node[]; edges: Edge[] } {
  if (!workflow?.nodes) return { nodes: [], edges: [] };

  const nodeEntries = Object.entries(workflow.nodes) as [string, any][];
  const rfNodes: Node[] = [];
  const rfEdges: Edge[] = [];

  // Layout nodes in a grid
  const cols = Math.max(3, Math.ceil(Math.sqrt(nodeEntries.length)));
  nodeEntries.forEach(([name, nodeDef], i) => {
    const type = nodeDef.type ?? 'agent';
    const row = Math.floor(i / cols);
    const col = i % cols;

    rfNodes.push({
      id: name,
      type: `ff-${type}`,
      position: { x: 50 + col * 220, y: 80 + row * 140 },
      data: { ...nodeDef, label: name },
    });
  });

  // Convert edges
  if (workflow.edges) {
    let edgeIdx = 0;
    for (const edge of workflow.edges) {
      const froms = Array.isArray(edge.from) ? edge.from : [edge.from];
      const tos = Array.isArray(edge.to) ? edge.to : [edge.to];

      for (const from of froms) {
        for (const to of tos) {
          const isRetry = edge.max_retries != null;
          rfEdges.push({
            id: `e-${edgeIdx++}`,
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

  return { nodes: rfNodes, edges: rfEdges };
}
