import { useMemo } from 'react';
import dagre from '@dagrejs/dagre';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';

export type ContextGraph = {
  source?: string;
  provider?: string;
  accessMode?: string;
  nodeCount?: number;
  edgeCount?: number;
  previewNodeCount?: number;
  previewEdgeCount?: number;
  limited?: boolean;
  nodes?: Array<Record<string, any>>;
  edges?: Array<Record<string, any>>;
  nodeTypeCounts?: Array<Record<string, any>>;
  relationshipCounts?: Array<Record<string, any>>;
  selection?: Record<string, any>;
  error?: string;
};

export type GraphHighlight = 'selected' | 'linked' | 'dimmed' | 'normal';
export type GraphLayout = 'auto' | 'dagre' | 'radial';

export function ContextReactFlow({
  graph,
  layout = 'auto',
  selectedNodeId,
  selectedEdge,
  fitPadding = 0.08,
  fitMaxZoom = 1.15,
  onSelectNode,
  onSelectEdge,
  onExpand,
}: {
  graph?: ContextGraph;
  layout?: GraphLayout;
  selectedNodeId: string | null;
  selectedEdge?: Record<string, any> | null;
  fitPadding?: number;
  fitMaxZoom?: number;
  onSelectNode: (value: Record<string, any>) => void;
  onSelectEdge: (value: Record<string, any>) => void;
  onExpand: (id: string) => void;
}) {
  const { nodes, edges } = useMemo(() => toFlowGraph(graph, selectedNodeId, selectedEdge, layout), [graph, selectedNodeId, selectedEdge, layout]);
  return (
    <ReactFlow
      className="context-graph-flow"
      nodes={nodes}
      edges={edges}
      nodeTypes={{ contextNode: ContextFlowNode }}
      fitView
      fitViewOptions={{ padding: fitPadding, maxZoom: fitMaxZoom }}
      minZoom={0.2}
      maxZoom={Math.max(2.4, fitMaxZoom)}
      panOnDrag
      panOnScroll
      selectionOnDrag={false}
      onNodeClick={(_, node) => onSelectNode(node.data.raw as Record<string, any>)}
      onNodeDoubleClick={(_, node) => onExpand(String(node.id))}
      onEdgeClick={(_, edge) => onSelectEdge(edge.data?.raw as Record<string, any>)}
    >
      <Background />
      <Controls className="context-graph-controls" />
    </ReactFlow>
  );
}

function ContextFlowNode({ data }: NodeProps<Node<{ label: string; type: string; raw: Record<string, any>; highlight: GraphHighlight }>>) {
  const color = graphNodeColor(data.type);
  const highlightClass = data.highlight === 'selected'
    ? 'ring-2 ring-accent shadow-lg'
    : data.highlight === 'linked'
      ? 'ring-1 ring-accent/60 shadow'
      : data.highlight === 'dimmed'
        ? 'opacity-35'
        : '';
  return (
    <div title={nodeTooltip(data.raw)} className={`relative flex flex-col items-center gap-1 transition-opacity ${highlightClass}`}>
      <Handle type="target" position={Position.Left} />
      <div
        className="w-20 h-20 rounded-full border-2 shadow-sm flex items-center justify-center text-center px-2"
        style={{ borderColor: color.border, backgroundColor: color.background }}
      >
        <span className="text-[9px] font-mono text-theme-primary leading-tight line-clamp-4 break-words">{compactNodeLabel(data.label)}</span>
      </div>
      <div className="w-28 text-center">
        <div className="text-[10px] text-theme-muted font-mono truncate">{data.type}</div>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function toFlowGraph(
  graph?: ContextGraph,
  selectedNodeId?: string | null,
  selectedEdge?: Record<string, any> | null,
  layout: GraphLayout = 'auto',
): { nodes: Node[]; edges: Edge[] } {
  const rawNodes = graph?.nodes ?? [];
  const rawEdges = graph?.edges ?? [];
  const linkedNodeIds = new Set<string>();
  const highlightedEdgeIds = new Set<string>();
  if (selectedEdge) {
    const source = String(selectedEdge.source ?? '');
    const target = String(selectedEdge.target ?? '');
    if (source) linkedNodeIds.add(source);
    if (target) linkedNodeIds.add(target);
    highlightedEdgeIds.add(String(selectedEdge.id ?? `${selectedEdge.source}-${selectedEdge.target}`));
  }
  if (selectedNodeId) {
    linkedNodeIds.add(selectedNodeId);
    for (const edge of rawEdges) {
      const source = String(edge.source);
      const target = String(edge.target);
      if (source === selectedNodeId || target === selectedNodeId) {
        linkedNodeIds.add(source);
        linkedNodeIds.add(target);
        highlightedEdgeIds.add(String(edge.id ?? `${edge.source}-${edge.target}`));
      }
    }
  }
  const useRadial = layout === 'radial'
    || (layout === 'auto' && (graph?.selection?.mode === 'node_neighborhood' || graph?.selection?.mode === 'expanded_neighborhood'));
  const positions = useRadial
    ? radialGraphPositions(rawNodes, rawEdges, String(graph?.selection?.seedNodeIds?.[0] ?? rawNodes[0]?.id ?? ''))
    : layout === 'dagre'
      ? dagreGraphPositions(rawNodes, rawEdges)
      : forceGraphPositions(rawNodes, rawEdges);
  const nodes = rawNodes.map((node) => {
    const pos = positions.get(String(node.id)) ?? { x: 0, y: 0 };
    return {
      id: String(node.id),
      type: 'contextNode',
      position: { x: pos.x, y: pos.y },
      data: {
        label: displayGraphNodeLabel(node),
        type: String(node.type ?? 'node'),
        raw: node,
        highlight: graphNodeHighlight(String(node.id), selectedNodeId, linkedNodeIds),
      },
    };
  });
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = rawEdges
    .filter((edge) => nodeIds.has(String(edge.source)) && nodeIds.has(String(edge.target)))
    .map((edge) => {
      const edgeId = String(edge.id ?? `${edge.source}-${edge.target}`);
      const highlighted = highlightedEdgeIds.has(edgeId);
      const dimmed = Boolean((selectedNodeId || selectedEdge) && !highlighted);
      const stroke = highlighted ? '#38bdf8' : '#64748b';
      return {
        id: edgeId,
        source: String(edge.source),
        target: String(edge.target),
        label: highlighted ? shortEdgeLabel(String(edge.label ?? edge.relationship ?? '')) : undefined,
        type: 'bezier',
        markerEnd: { type: MarkerType.ArrowClosed, width: highlighted ? 18 : 14, height: highlighted ? 18 : 14, color: stroke },
        style: { stroke, strokeWidth: highlighted ? 2.2 : 0.9, opacity: dimmed ? 0.12 : highlighted ? 0.95 : 0.34 },
        labelStyle: { fill: highlighted ? '#e0f2fe' : '#94a3b8', fontSize: 9, fontFamily: 'monospace', opacity: dimmed ? 0.25 : 1 },
        labelBgStyle: { fill: 'rgba(15, 23, 42, 0.82)', fillOpacity: highlighted ? 0.9 : 0.72 },
        data: { raw: edge },
        animated: highlighted,
        interactionWidth: highlighted ? 18 : 1,
      };
    });
  return { nodes, edges };
}

function dagreGraphPositions(rawNodes: Array<Record<string, any>>, rawEdges: Array<Record<string, any>>): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', nodesep: 38, ranksep: 96 });
  for (const node of rawNodes) {
    g.setNode(String(node.id), { width: 120, height: 116 });
  }
  for (const edge of rawEdges) {
    g.setEdge(String(edge.source), String(edge.target));
  }
  dagre.layout(g);
  const positions = new Map<string, { x: number; y: number }>();
  for (const node of rawNodes) {
    const pos = g.node(String(node.id)) ?? { x: 0, y: 0 };
    positions.set(String(node.id), { x: pos.x - 60, y: pos.y - 58 });
  }
  return positions;
}

function forceGraphPositions(rawNodes: Array<Record<string, any>>, rawEdges: Array<Record<string, any>>): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const ids = rawNodes.map((node) => String(node.id));
  if (!ids.length) return positions;
  const degree = new Map<string, number>();
  for (const id of ids) degree.set(id, 0);
  for (const edge of rawEdges) {
    const source = String(edge.source ?? '');
    const target = String(edge.target ?? '');
    if (degree.has(source)) degree.set(source, (degree.get(source) ?? 0) + 1);
    if (degree.has(target)) degree.set(target, (degree.get(target) ?? 0) + 1);
  }
  const ordered = [...ids].sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || a.localeCompare(b));
  const columns = Math.max(4, Math.ceil(Math.sqrt(ordered.length) * 1.8));
  const cellWidth = 270;
  const cellHeight = 230;
  const velocity = new Map<string, { x: number; y: number }>();
  const indexById = new Map(ordered.map((id, index) => [id, index]));
  for (const id of ordered) {
    const index = indexById.get(id) ?? 0;
    const hash = stableGraphHash(id);
    const column = index % columns;
    const row = Math.floor(index / columns);
    const stagger = row % 2 ? cellWidth * 0.45 : 0;
    positions.set(id, {
      x: (column - (columns - 1) / 2) * cellWidth + stagger + ((hash % 101) - 50),
      y: row * cellHeight + (((hash >> 5) % 101) - 50),
    });
    velocity.set(id, { x: 0, y: 0 });
  }
  const totalRows = Math.max(1, Math.ceil(ordered.length / columns));
  const yOffset = ((totalRows - 1) * cellHeight) / 2;
  for (const pos of positions.values()) pos.y -= yOffset;

  const nodeCount = Math.max(1, ordered.length);
  const idealDistance = Math.max(280, Math.min(460, 230 + Math.sqrt(nodeCount) * 18));
  const repulsion = 18000;
  const spring = 0.0045;
  const centerPull = 0.0015;
  const iterations = nodeCount > 120 ? 44 : 60;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (let i = 0; i < ordered.length; i += 1) {
      const a = ordered[i];
      const pa = positions.get(a)!;
      const va = velocity.get(a)!;
      for (let j = i + 1; j < ordered.length; j += 1) {
        const b = ordered[j];
        const pb = positions.get(b)!;
        const vb = velocity.get(b)!;
        const dx = pa.x - pb.x;
        const dy = pa.y - pb.y;
        const distanceSquared = Math.max(80, dx * dx + dy * dy);
        const distance = Math.sqrt(distanceSquared);
        const force = repulsion / distanceSquared;
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        va.x += fx;
        va.y += fy;
        vb.x -= fx;
        vb.y -= fy;
      }
    }
    for (const edge of rawEdges) {
      const source = String(edge.source ?? '');
      const target = String(edge.target ?? '');
      const sourcePosition = positions.get(source);
      const targetPosition = positions.get(target);
      const sourceVelocity = velocity.get(source);
      const targetVelocity = velocity.get(target);
      if (!sourcePosition || !targetPosition || !sourceVelocity || !targetVelocity) continue;
      const dx = targetPosition.x - sourcePosition.x;
      const dy = targetPosition.y - sourcePosition.y;
      const distance = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const force = (distance - idealDistance) * spring;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      sourceVelocity.x += fx;
      sourceVelocity.y += fy;
      targetVelocity.x -= fx;
      targetVelocity.y -= fy;
    }
    for (const id of ordered) {
      const pos = positions.get(id)!;
      const vel = velocity.get(id)!;
      const centrality = Math.min(1.8, 0.65 + (degree.get(id) ?? 0) / 10);
      vel.x -= pos.x * centerPull * centrality;
      vel.y -= pos.y * centerPull * centrality;
      pos.x += vel.x;
      pos.y += vel.y;
      vel.x *= 0.78;
      vel.y *= 0.78;
    }
  }
  const compacted = compactGraphPositions(positions);
  for (const [id, pos] of compacted) {
    positions.set(id, pos);
  }
  return positions;
}

function compactGraphPositions(positions: Map<string, { x: number; y: number }>): Map<string, { x: number; y: number }> {
  const values = [...positions.values()];
  if (!values.length) return positions;
  const minX = Math.min(...values.map((pos) => pos.x));
  const maxX = Math.max(...values.map((pos) => pos.x));
  const minY = Math.min(...values.map((pos) => pos.y));
  const maxY = Math.max(...values.map((pos) => pos.y));
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const xScale = width < height * 1.35 ? (height * 1.35) / width : 1;
  const yScale = height > width * 0.72 ? (width * 0.72) / height : 1;
  const centerX = minX + width / 2;
  const centerY = minY + height / 2;
  const next = new Map<string, { x: number; y: number }>();
  for (const [id, pos] of positions) {
    next.set(id, {
      x: (pos.x - centerX) * xScale,
      y: (pos.y - centerY) * yScale,
    });
  }
  return next;
}

function stableGraphHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function radialGraphPositions(rawNodes: Array<Record<string, any>>, rawEdges: Array<Record<string, any>>, rootId: string): Map<string, { x: number; y: number }> {
  const ids = rawNodes.map((node) => String(node.id));
  const root = ids.includes(rootId) ? rootId : ids[0] ?? '';
  const positions = new Map<string, { x: number; y: number }>();
  if (!root) return positions;
  positions.set(root, { x: 0, y: 0 });
  const degree = new Map<string, number>();
  for (const edge of rawEdges) {
    for (const id of [String(edge.source ?? ''), String(edge.target ?? '')]) {
      if (id) degree.set(id, (degree.get(id) ?? 0) + 1);
    }
  }
  const others = ids.filter((id) => id !== root)
    .sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0));
  const radius = Math.max(210, Math.min(460, 130 + others.length * 10));
  others.forEach((id, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(1, others.length);
    positions.set(id, {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    });
  });
  return positions;
}

function graphNodeHighlight(nodeId: string, selectedNodeId: string | null | undefined, linkedNodeIds: Set<string>): GraphHighlight {
  if (!selectedNodeId && !linkedNodeIds.size) return 'normal';
  if (nodeId === selectedNodeId) return 'selected';
  if (linkedNodeIds.has(nodeId)) return 'linked';
  return 'dimmed';
}

export function edgeEndpointNodes(graph: ContextGraph | undefined, edge: Record<string, any>): Record<string, any> {
  const sourceId = String(edge.source ?? '');
  const targetId = String(edge.target ?? '');
  return {
    __sourceNode: graph?.nodes?.find((node) => String(node.id ?? '') === sourceId),
    __targetNode: graph?.nodes?.find((node) => String(node.id ?? '') === targetId),
  };
}

export function hasUsableConnectionDetail(detail: Record<string, any> | null): boolean {
  if (!detail) return false;
  if (detail.node && typeof detail.node === 'object' && !Array.isArray(detail.node)) return true;
  return Boolean(
    (Array.isArray(detail.relatedNodes) && detail.relatedNodes.length)
    || (Array.isArray(detail.relatedEdges) && detail.relatedEdges.length),
  );
}

export function nodeDetailToContextGraph(detail: Record<string, any> | null): ContextGraph {
  const root = detail?.node && typeof detail.node === 'object' && !Array.isArray(detail.node)
    ? detail.node as Record<string, any>
    : null;
  const relatedNodes = Array.isArray(detail?.relatedNodes) ? detail.relatedNodes : [];
  const rawEdges = Array.isArray(detail?.relatedEdges) ? detail.relatedEdges : [];
  const nodes = uniqueGraphItems(root ? [root, ...relatedNodes] : relatedNodes);
  const nodeIds = new Set(nodes.map((node) => String(node.id ?? '')).filter(Boolean));
  for (const edge of rawEdges) {
    for (const endpoint of [edge.source, edge.target]) {
      const endpointId = String(endpoint ?? '');
      if (!endpointId || nodeIds.has(endpointId)) continue;
      nodeIds.add(endpointId);
      nodes.push({ id: endpointId, type: 'related_node', label: endpointId, __placeholder: true });
    }
  }
  const edges = rawEdges.filter((edge: Record<string, any>) => nodeIds.has(String(edge.source ?? '')) && nodeIds.has(String(edge.target ?? '')));
  return {
    source: 'node_neighborhood',
    provider: detail?.provider,
    accessMode: detail?.accessMode,
    nodeCount: Number(detail?.relatedNodeCount ?? Math.max(0, nodes.length - (root ? 1 : 0))),
    edgeCount: Number(detail?.relatedEdgeCount ?? edges.length),
    previewNodeCount: nodes.length,
    previewEdgeCount: edges.length,
    limited: Boolean(detail?.limited),
    nodes,
    edges,
    selection: {
      mode: 'node_neighborhood',
      seedNodeIds: root?.id ? [String(root.id)] : [],
    },
  };
}

export function mergeContextGraphs(current: ContextGraph | undefined, next: ContextGraph): ContextGraph {
  if (!current?.nodes?.length && !current?.edges?.length) return next;
  const nodes = uniqueGraphItems([...(current.nodes ?? []), ...(next.nodes ?? [])]);
  const edgeMap = new Map<string, Record<string, any>>();
  for (const edge of [...(current.edges ?? []), ...(next.edges ?? [])]) {
    const key = String(edge.id ?? `${edge.source ?? ''}->${edge.target ?? ''}:${edge.relationship ?? edge.label ?? ''}`);
    edgeMap.set(key, edge);
  }
  const edges = Array.from(edgeMap.values());
  return {
    ...next,
    source: 'expanded_neighborhood',
    nodeCount: nodes.length,
    edgeCount: edges.length,
    previewNodeCount: nodes.length,
    previewEdgeCount: edges.length,
    limited: Boolean(current.limited || next.limited),
    nodes,
    edges,
    selection: {
      mode: 'expanded_neighborhood',
      seedNodeIds: next.selection?.seedNodeIds ?? current.selection?.seedNodeIds ?? [],
    },
  };
}

export function isDocumentGraphNode(node: Record<string, any>): boolean {
  return ['DocumentChunk', 'TextSummary', 'TextDocument'].includes(String(node.type ?? ''));
}

function uniqueGraphItems(items: Array<Record<string, any>>): Array<Record<string, any>> {
  const seen = new Set<string>();
  const unique: Array<Record<string, any>> = [];
  for (const item of items) {
    const id = String(item.id ?? item.dbId ?? item.label ?? '');
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    unique.push(item);
  }
  return unique;
}

function graphNodeColor(type: string): { border: string; background: string } {
  switch (type) {
    case 'Entity':
      return { border: '#22c55e', background: 'rgba(34, 197, 94, 0.12)' };
    case 'EntityType':
      return { border: '#a855f7', background: 'rgba(168, 85, 247, 0.12)' };
    case 'DocumentChunk':
      return { border: '#38bdf8', background: 'rgba(56, 189, 248, 0.12)' };
    case 'TextSummary':
      return { border: '#f59e0b', background: 'rgba(245, 158, 11, 0.14)' };
    case 'TextDocument':
      return { border: '#64748b', background: 'rgba(100, 116, 139, 0.12)' };
    default:
      return { border: '#94a3b8', background: 'rgba(148, 163, 184, 0.10)' };
  }
}

export function selectedTitle(value: Record<string, any>): string {
  if (value.__selectionType === 'edge') {
    return [value.relationship, value.entityName].filter(Boolean).map(String).join(' · ') || 'Graph edge';
  }
  return displayGraphNodeLabel(value);
}

export function displayGraphNodeLabel(node: Record<string, any>): string {
  const source = node.sourceMetadata && typeof node.sourceMetadata === 'object' && !Array.isArray(node.sourceMetadata)
    ? node.sourceMetadata as Record<string, any>
    : {};
  const value = node.name
    ?? source.title
    ?? node.sourcePath
    ?? source.path
    ?? node.label
    ?? node.id;
  return String(value ?? 'node');
}

function compactNodeLabel(value: string): string {
  return value.length > 48 ? `${value.slice(0, 45)}...` : value;
}

function shortEdgeLabel(value: string): string {
  if (!value || value === 'related_to') return '';
  return value.length > 26 ? `${value.slice(0, 23)}...` : value;
}

function nodeTooltip(raw: Record<string, any>): string {
  return [
    raw.type,
    raw.label ?? raw.name ?? raw.id,
    raw.description,
    raw.textPreview,
  ].filter(Boolean).map(String).join('\n\n');
}
