import { MarkerType, type Edge, type Node } from '@xyflow/react';
import dagre from '@dagrejs/dagre';
import { outputsAsKeys } from '../utils/outputs';

const NODE_WIDTH = 280;
const NODE_HEIGHT = 112;
const CONDITION_NODE_SIZE = 180;
const TERMINAL_WIDTH = 120;
const TERMINAL_HEIGHT = 44;
const RANK_GAP = 230;
const NODE_GAP = 190;
const RETRY_LANE_GAP = 120;
const BUS_PADDING = 72;
const BUS_STUB = 78;

type NodeSize = { width: number; height: number };
type RoutePoint = { x: number; y: number };
type NodeBox = {
  id: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
  centerX: number;
  centerY: number;
};

/**
 * Convert a parsed workflow definition into React Flow nodes and edges.
 *
 * Layout strategy: Sugiyama-style layered layout via Dagre. Dagre handles
 * rank assignment, same-rank ordering, and crossing minimization. We then
 * reuse Dagre's routed edge points instead of inventing post-hoc lanes that
 * can slice back through the graph.
 */
export function yamlToReactFlow(workflow: any): { nodes: Node[]; edges: Edge[] } {
  if (!workflow?.nodes) return { nodes: [], edges: [] };

  const nodeEntries = Object.entries(workflow.nodes) as [string, any][];
  const nodeSizes = new Map<string, NodeSize>();
  const rfEdges: Edge[] = [];
  const retryCountPerTarget: Record<string, number> = {};
  let edgeIndex = 0;

  if (workflow.edges) {
    for (const edge of workflow.edges) {
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
            id: `${from}-${to}-${edgeIndex++}`,
            source: from,
            sourceHandle: isRetry ? retrySide : 'bottom',
            target: to,
            targetHandle: isRetry ? retrySide : 'top',
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
              color: isRetry
                ? 'rgb(var(--color-flow-edge-retry))'
                : edge.condition
                  ? 'rgb(var(--color-flow-edge-conditional))'
                  : 'rgb(var(--color-flow-edge-default))',
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
  }

  nodeSizes.set('START', { width: TERMINAL_WIDTH, height: TERMINAL_HEIGHT });
  nodeSizes.set('END', { width: TERMINAL_WIDTH, height: TERMINAL_HEIGHT });
  for (const [name, nodeDef] of nodeEntries) {
    nodeSizes.set(name, estimateNodeSize(nodeDef));
  }

  const ids = ['START', ...nodeEntries.map(([name]) => name), 'END'];
  const layoutEdges = rfEdges.filter((edge) => {
    if (edge.type === 'al-retry') return false;
    if (edge.source === 'escalation_review') return false;
    return true;
  });
  const { positions, edgeRoutes } = layoutWithDagre(ids, layoutEdges, nodeSizes);

  const rfNodes: Node[] = [];
  const addNode = (id: string, type: string, data: Record<string, unknown>, deletable = true) => {
    const size = nodeSizes.get(id) ?? { width: NODE_WIDTH, height: NODE_HEIGHT };
    const point = positions.get(id) ?? { x: 0, y: 0 };
    rfNodes.push({
      id,
      type,
      position: { x: point.x - size.width / 2, y: point.y - size.height / 2 },
      width: size.width,
      height: size.height,
      data,
      deletable,
    });
  };

  addNode('START', 'al-terminal', { label: 'START' }, false);
  for (const [name, nodeDef] of nodeEntries) {
    addNode(name, `al-${nodeDef.type ?? 'agent'}`, { ...nodeDef, label: name });
  }
  addNode('END', 'al-terminal', { label: 'END' }, false);

  return { nodes: rfNodes, edges: routeEdges(rfNodes, rfEdges, edgeRoutes) };
}

function estimateNodeSize(nodeDef: any): NodeSize {
  const type = nodeDef?.type ?? 'agent';
  if (type === 'condition') return { width: CONDITION_NODE_SIZE, height: CONDITION_NODE_SIZE };

  const outputCount = outputsAsKeys(nodeDef?.outputs).length;
  const visibleOutputRows = outputCount > 0 ? 1 : 0;
  const fieldCount = Array.isArray(nodeDef?.fields) ? nodeDef.fields.length : 0;
  const fieldRows = fieldCount > 0 ? 1 : 0;
  const retryRows = nodeDef?.max_retries != null ? 1 : 0;
  const labelRows = String(nodeDef?.label ?? nodeDef?.name ?? '').length > 32 ? 1 : 0;

  return {
    width: NODE_WIDTH,
    height: NODE_HEIGHT + (visibleOutputRows + fieldRows + retryRows + labelRows) * 22,
  };
}

function layoutWithDagre(
  ids: string[],
  edges: Edge[],
  nodeSizes: Map<string, NodeSize>,
): { positions: Map<string, RoutePoint>; edgeRoutes: Map<string, RoutePoint[]> } {
  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: 'TB',
    ranker: 'network-simplex',
    acyclicer: 'greedy',
    ranksep: RANK_GAP,
    nodesep: NODE_GAP,
    edgesep: 80,
    marginx: 80,
    marginy: 80,
  });

  for (const id of ids) {
    const size = nodeSizes.get(id) ?? { width: NODE_WIDTH, height: NODE_HEIGHT };
    graph.setNode(id, { width: size.width, height: size.height });
  }

  for (const edge of edges) {
    graph.setEdge(
      edge.source,
      edge.target,
      { weight: edge.source === 'START' || edge.target === 'END' ? 3 : 1 },
      edge.id,
    );
  }

  dagre.layout(graph);

  const positions = new Map<string, RoutePoint>();
  for (const id of ids) {
    const node = graph.node(id);
    positions.set(id, { x: node?.x ?? 0, y: node?.y ?? 0 });
  }

  const edgeRoutes = new Map<string, RoutePoint[]>();
  for (const edge of edges) {
    const route = graph.edge({ v: edge.source, w: edge.target, name: edge.id }) as { points?: RoutePoint[] } | undefined;
    if (route?.points?.length) {
      edgeRoutes.set(edge.id, route.points.map(point => ({ x: point.x, y: point.y })));
    }
  }

  return { positions, edgeRoutes };
}

function routeEdges(nodes: Node[], edges: Edge[], edgeRoutes: Map<string, RoutePoint[]>): Edge[] {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const boxes = nodes.map(toNodeBox);
  const bounds = graphBox(boxes);
  const targetBusX = new Map<string, number>();

  for (const edge of edges) {
    if (edge.type === 'al-retry' || targetBusX.has(edge.target)) continue;
    const incoming = edges
      .filter(candidate => candidate.type !== 'al-retry' && candidate.target === edge.target)
      .map(candidate => ({
        edge: candidate,
        source: byId.get(candidate.source),
        target: byId.get(candidate.target),
      }))
      .filter((item): item is { edge: Edge; source: Node; target: Node } => Boolean(item.source && item.target));
    if (incoming.length <= 1) continue;
    targetBusX.set(edge.target, chooseTargetBusX(incoming, boxes, bounds));
  }

  return edges.map((edge) => {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) return edge;

    if (edge.type === 'al-retry') {
      return {
        ...edge,
        data: {
          ...(edge.data as any),
          retryLaneX: retryLaneX(edge, source, target, bounds),
        },
      };
    }

    const routePoints = bundledRoute(edge, source, target, targetBusX.get(edge.target), boxes, bounds, edgeRoutes);

    return {
      ...edge,
      sourceHandle: 'bottom',
      targetHandle: 'top',
      data: {
        ...(edge.data as any),
        routePoints,
      },
    };
  });
}

function chooseTargetBusX(
  incoming: Array<{ edge: Edge; source: Node; target: Node }>,
  boxes: NodeBox[],
  bounds: NodeBox,
): number {
  const targetBox = toNodeBox(incoming[0].target);
  const minY = Math.min(
    targetBox.top - BUS_STUB,
    ...incoming.map(item => toNodeBox(item.source).bottom + BUS_STUB),
  );
  const maxY = Math.max(
    targetBox.top - BUS_STUB,
    ...incoming.map(item => toNodeBox(item.source).bottom + BUS_STUB),
  );
  const candidates = uniqueNumbers([
    targetBox.centerX,
    targetBox.left - BUS_PADDING,
    targetBox.right + BUS_PADDING,
    bounds.left - RETRY_LANE_GAP,
    bounds.right + RETRY_LANE_GAP,
    ...boxes.flatMap(box => [box.left - BUS_PADDING, box.right + BUS_PADDING]),
  ]).sort((a, b) => Math.abs(a - targetBox.centerX) - Math.abs(b - targetBox.centerX));

  return candidates.find(x => !boxes.some(box => verticalIntersectsBox(x, minY, maxY, box, targetBox.id)))
    ?? targetBox.right + BUS_PADDING;
}

function bundledRoute(
  edge: Edge,
  source: Node,
  target: Node,
  targetBusX: number | undefined,
  boxes: NodeBox[],
  bounds: NodeBox,
  edgeRoutes: Map<string, RoutePoint[]>,
): RoutePoint[] {
  const sourceBox = toNodeBox(source);
  const targetBox = toNodeBox(target);
  const forward = sourceBox.centerY <= targetBox.centerY;

  if (!forward || edge.source === 'escalation_review') {
    return exteriorBackRoute(edge, sourceBox, targetBox, boxes, bounds);
  }

  const sourcePoint = handlePoint(source, 'bottom');
  const targetPoint = handlePoint(target, 'top');
  const straightRoute = compactPoints([sourcePoint, targetPoint]);
  if (isOrthogonalSegment(sourcePoint, targetPoint)
    && routeIntersections(straightRoute, boxes, sourceBox.id, targetBox.id).length === 0) {
    return straightRoute;
  }

  if (targetBusX == null) {
    const simpleRoute = simpleForwardRoute(sourcePoint, targetPoint, boxes, sourceBox.id, targetBox.id);
    if (routeIntersections(simpleRoute, boxes, sourceBox.id, targetBox.id).length === 0) {
      return simpleRoute;
    }

    const fallback = edgeRoutes.get(edge.id);
    if (fallback?.length) {
      const dagreRoute = orthogonalizeRoute(
        compactPoints([sourcePoint, ...fallback, targetPoint]),
        boxes,
        sourceBox.id,
        targetBox.id,
      );
      if (routeIntersections(dagreRoute, boxes, sourceBox.id, targetBox.id).length === 0) return dagreRoute;
    }

    return exteriorForwardRoute(sourceBox, targetBox, boxes, bounds);
  }

  const busX = targetBusX;
  const exitY = chooseClearY(sourceBox.bottom + BUS_STUB, sourcePoint.x, busX, boxes, sourceBox.id, targetBox.id);
  const mergeY = chooseClearY(targetBox.top - BUS_STUB, busX, targetPoint.x, boxes, sourceBox.id, targetBox.id);
  const route = compactPoints([
    sourcePoint,
    { x: sourcePoint.x, y: exitY },
    { x: busX, y: exitY },
    { x: busX, y: mergeY },
    { x: targetPoint.x, y: mergeY },
    targetPoint,
  ]);

  if (routeIntersections(route, boxes, sourceBox.id, targetBox.id).length === 0) return route;

  const fallback = edgeRoutes.get(edge.id);
  if (fallback?.length) {
    const dagreRoute = orthogonalizeRoute(
      compactPoints([sourcePoint, ...fallback, targetPoint]),
      boxes,
      sourceBox.id,
      targetBox.id,
    );
    if (routeIntersections(dagreRoute, boxes, sourceBox.id, targetBox.id).length === 0) return dagreRoute;
  }

  return exteriorForwardRoute(sourceBox, targetBox, boxes, bounds);
}

function exteriorBackRoute(edge: Edge, source: NodeBox, target: NodeBox, boxes: NodeBox[], bounds: NodeBox): RoutePoint[] {
  const side = source.centerX > target.centerX ? 'right' : 'left';
  const laneX = side === 'left' ? bounds.left - RETRY_LANE_GAP : bounds.right + RETRY_LANE_GAP;
  const sourcePoint = { x: source.centerX, y: source.top };
  const targetPoint = { x: target.centerX, y: target.bottom };
  const sourceY = chooseClearY(source.top - BUS_STUB, sourcePoint.x, laneX, boxes, source.id, target.id);
  const targetY = chooseClearY(target.bottom + BUS_STUB, laneX, targetPoint.x, boxes, source.id, target.id);
  const route = compactPoints([
    sourcePoint,
    { x: sourcePoint.x, y: sourceY },
    { x: laneX, y: sourceY },
    { x: laneX, y: targetY },
    { x: targetPoint.x, y: targetY },
    targetPoint,
  ]);
  if (routeIntersections(route, boxes, source.id, target.id).length === 0) return route;

  const altLaneX = edge.source.localeCompare(edge.target) % 2 === 0
    ? bounds.left - RETRY_LANE_GAP * 1.8
    : bounds.right + RETRY_LANE_GAP * 1.8;
  return compactPoints([
    sourcePoint,
    { x: sourcePoint.x, y: sourceY },
    { x: altLaneX, y: sourceY },
    { x: altLaneX, y: targetY },
    { x: targetPoint.x, y: targetY },
    targetPoint,
  ]);
}

function exteriorForwardRoute(source: NodeBox, target: NodeBox, boxes: NodeBox[], bounds: NodeBox): RoutePoint[] {
  const laneX = Math.abs(source.centerX - bounds.left) < Math.abs(bounds.right - source.centerX)
    ? bounds.left - RETRY_LANE_GAP
    : bounds.right + RETRY_LANE_GAP;
  const sourcePoint = { x: source.centerX, y: source.bottom };
  const targetPoint = { x: target.centerX, y: target.top };
  const sourceY = chooseClearY(source.bottom + BUS_STUB, sourcePoint.x, laneX, boxes, source.id, target.id);
  const targetY = chooseClearY(target.top - BUS_STUB, laneX, targetPoint.x, boxes, source.id, target.id);
  return compactPoints([
    sourcePoint,
    { x: sourcePoint.x, y: sourceY },
    { x: laneX, y: sourceY },
    { x: laneX, y: targetY },
    { x: targetPoint.x, y: targetY },
    targetPoint,
  ]);
}

function simpleForwardRoute(
  source: RoutePoint,
  target: RoutePoint,
  boxes: NodeBox[],
  sourceId: string,
  targetId: string,
): RoutePoint[] {
  const midY = chooseClearY((source.y + target.y) / 2, source.x, target.x, boxes, sourceId, targetId);
  return compactPoints([
    source,
    { x: source.x, y: midY },
    { x: target.x, y: midY },
    target,
  ]);
}

function graphBox(boxes: NodeBox[]): NodeBox {
  return {
    id: '__graph__',
    left: Math.min(...boxes.map(box => box.left)),
    right: Math.max(...boxes.map(box => box.right)),
    top: Math.min(...boxes.map(box => box.top)),
    bottom: Math.max(...boxes.map(box => box.bottom)),
    centerX: 0,
    centerY: 0,
  };
}

function retryLaneX(edge: Edge, source: Node, target: Node, bounds: NodeBox): number {
  const sourceBox = toNodeBox(source);
  const targetBox = toNodeBox(target);
  const side = (edge.data as any)?.retrySide ?? 'right';
  return side === 'left'
    ? Math.min(bounds.left, sourceBox.left, targetBox.left) - RETRY_LANE_GAP
    : Math.max(bounds.right, sourceBox.right, targetBox.right) + RETRY_LANE_GAP;
}

function chooseClearY(
  preferredY: number,
  x1: number,
  x2: number,
  boxes: NodeBox[],
  sourceId: string,
  targetId: string,
): number {
  const candidates = uniqueNumbers([
    preferredY,
    ...boxes.flatMap(box => [box.top - BUS_PADDING, box.bottom + BUS_PADDING]),
  ]).sort((a, b) => Math.abs(a - preferredY) - Math.abs(b - preferredY));
  return candidates.find(y => !boxes.some(box => horizontalIntersectsBox(y, x1, x2, box, sourceId, targetId)))
    ?? preferredY;
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values.map(value => Math.round(value)))];
}

function toNodeBox(node: Node): NodeBox {
  const width = (node as any).width ?? (node as any).measured?.width ?? NODE_WIDTH;
  const height = (node as any).height ?? (node as any).measured?.height ?? NODE_HEIGHT;

  return {
    id: node.id,
    left: node.position.x,
    right: node.position.x + width,
    top: node.position.y,
    bottom: node.position.y + height,
    centerX: node.position.x + width / 2,
    centerY: node.position.y + height / 2,
  };
}

function handlePoint(node: Node, handle: 'top' | 'bottom' | 'left' | 'right'): RoutePoint {
  const box = toNodeBox(node);
  switch (handle) {
    case 'left':
      return { x: box.left, y: box.centerY };
    case 'right':
      return { x: box.right, y: box.centerY };
    case 'top':
      return { x: box.centerX, y: box.top };
    case 'bottom':
      return { x: box.centerX, y: box.bottom };
  }
}

function compactPoints(points: RoutePoint[]): RoutePoint[] {
  const compacted = points.filter((point, index) => {
    const prev = points[index - 1];
    const next = points[index + 1];
    if (prev && close(point.x, prev.x) && close(point.y, prev.y)) return false;
    if (!prev || !next) return true;
    const sameX = close(prev.x, point.x) && close(point.x, next.x);
    const sameY = close(prev.y, point.y) && close(point.y, next.y);
    return !(sameX || sameY);
  });
  if (compacted.length >= 2 || points.length < 2) return compacted;
  return [points[0], points[points.length - 1]];
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.5;
}

function isOrthogonalSegment(a: RoutePoint, b: RoutePoint): boolean {
  return close(a.x, b.x) || close(a.y, b.y);
}

function orthogonalizeRoute(
  points: RoutePoint[],
  boxes: NodeBox[],
  sourceId: string,
  targetId: string,
): RoutePoint[] {
  const next: RoutePoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (i === 0) {
      next.push(point);
      continue;
    }

    const prev = next[next.length - 1];
    if (isOrthogonalSegment(prev, point)) {
      next.push(point);
      continue;
    }

    const elbowA = { x: prev.x, y: point.y };
    const elbowB = { x: point.x, y: prev.y };
    const routeA = [prev, elbowA, point];
    const routeB = [prev, elbowB, point];
    const aIntersections = routeIntersections(routeA, boxes, sourceId, targetId).length;
    const bIntersections = routeIntersections(routeB, boxes, sourceId, targetId).length;
    next.push(aIntersections <= bIntersections ? elbowA : elbowB, point);
  }
  return compactPoints(next);
}

export function routeSegmentsCrossNodeBoxes(nodes: Node[], edges: Edge[]): string[] {
  const boxes = nodes.map(toNodeBox);
  const failures: string[] = [];
  for (const edge of edges) {
    if (edge.type === 'al-retry') continue;
    const points = (edge.data as any)?.routePoints as RoutePoint[] | undefined;
    if (!points) continue;
    failures.push(...routeIntersections(points, boxes, edge.source, edge.target).map(boxId => `${edge.id} crosses ${boxId}`));
  }
  return failures;
}

function routeIntersections(points: RoutePoint[], boxes: NodeBox[], sourceId: string, targetId: string): string[] {
  const failures: string[] = [];
  for (let i = 1; i < points.length; i++) {
    for (const box of boxes) {
      if (box.id === sourceId || box.id === targetId) continue;
      if (segmentIntersectsBox(points[i - 1], points[i], box)) {
        failures.push(box.id);
      }
    }
  }
  return failures;
}

function segmentIntersectsBox(a: RoutePoint, b: RoutePoint, box: NodeBox): boolean {
  const samples = 16;
  for (let i = 1; i < samples; i++) {
    const t = i / samples;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    if (x > box.left && x < box.right && y > box.top && y < box.bottom) return true;
  }
  return false;
}

function verticalIntersectsBox(x: number, y1: number, y2: number, box: NodeBox, ...ignoredIds: string[]): boolean {
  if (ignoredIds.includes(box.id)) return false;
  const top = Math.min(y1, y2);
  const bottom = Math.max(y1, y2);
  return x > box.left && x < box.right && bottom > box.top && top < box.bottom;
}

function horizontalIntersectsBox(y: number, x1: number, x2: number, box: NodeBox, ...ignoredIds: string[]): boolean {
  if (ignoredIds.includes(box.id)) return false;
  const left = Math.min(x1, x2);
  const right = Math.max(x1, x2);
  return y > box.top && y < box.bottom && right > box.left && left < box.right;
}
