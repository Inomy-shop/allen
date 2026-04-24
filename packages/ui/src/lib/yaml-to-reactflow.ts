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

  // Track retry edge count per target to alternate left/right sides
  const retryCountPerTarget: Record<string, number> = {};

  // Build edges first so dagre can compute layout
  if (workflow.edges) {
    for (const edge of workflow.edges) {
      const froms = Array.isArray(edge.from) ? edge.from : [edge.from];
      const tos = Array.isArray(edge.to) ? edge.to : [edge.to];

      for (const from of froms) {
        for (const to of tos) {
          const isRetry = edge.max_retries != null;

          // Alternate retry edges between right and left
          let retrySide: 'right' | 'left' = 'right';
          if (isRetry) {
            const key = to;
            retryCountPerTarget[key] = (retryCountPerTarget[key] ?? 0) + 1;
            retrySide = retryCountPerTarget[key] % 2 === 1 ? 'right' : 'left';
          }

          rfEdges.push({
            id: `${from}-${to}`,
            source: from,
            sourceHandle: isRetry ? retrySide : 'bottom',
            target: to,
            targetHandle: isRetry ? retrySide : 'top',
            // Use the auto-routed edge for plain forward edges (no condition,
            // no max_retries). Straight when geometry permits, smooth-step
            // right-angle when it would be a shallow awkward diagonal.
            type: isRetry ? 'al-retry' : edge.condition ? 'al-conditional' : 'al-auto',
            label: edge.condition ?? (edge.parallel ? '∥' : undefined),
            data: {
              condition: edge.condition,
              parallel: edge.parallel,
              max_retries: edge.max_retries,
              retry_context: edge.retry_context,
              join: edge.join,
              merge: edge.merge,
              retrySide: isRetry ? retrySide : undefined,
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

  // Dagre layout.
  //
  // `acyclicer: 'greedy'` + filtering back-edges (retry + escalation
  // returns) dramatically reduces edge crossings: dagre only gets the
  // DAG-shaped forward spine to layer, and the non-layout edges route
  // over the top without pulling their targets upward.
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: 'TB',
    nodesep: 120,
    ranksep: 160,
    marginx: 40,
    marginy: 40,
    acyclicer: 'greedy',
    ranker: 'network-simplex',
  });

  // Add START and END as virtual nodes for layout
  g.setNode('START', { width: NODE_WIDTH, height: 40 });
  g.setNode('END', { width: NODE_WIDTH, height: 40 });

  for (const [name] of nodeEntries) {
    g.setNode(name, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }

  // Only feed forward (DAG-shaped) edges into dagre. Retry and
  // escalation-return edges render on top afterwards without distorting
  // node ranks.
  const layoutEdges = rfEdges.filter((e) => {
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
  // Force the longest forward path (START → … → END) onto a single
  // x-coordinate so every spine edge becomes a vertical segment and
  // they all visually stack into one trunk. Side branches (retry /
  // escalation) keep dagre's x and render on the sides.
  const spine = findLongestForwardPath('START', 'END', layoutEdges);
  if (spine.length > 2) {
    const xs = spine.map(id => g.node(id)?.x ?? 0).sort((a, b) => a - b);
    const columnX = xs[Math.floor(xs.length / 2)];
    for (const id of spine) {
      const n = g.node(id);
      if (n) n.x = columnX;
    }
  }

  // Add START node
  const startPos = g.node('START');
  rfNodes.push({
    id: 'START',
    type: 'al-terminal',
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
      type: `al-${type}`,
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
    type: 'al-terminal',
    position: { x: (endPos?.x ?? 0) - 60, y: (endPos?.y ?? 0) - 20 },
    data: { label: 'END' },
    deletable: false,
  });

  return { nodes: rfNodes, edges: rfEdges };
}

/**
 * Longest path from `start` to `end` through the given forward edges.
 * Used to identify the main "spine" of a workflow so those nodes can
 * be column-aligned — every spine edge then draws as a vertical
 * segment and they all visually stack into one trunk.
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
    if (visiting.has(node)) return [];
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
