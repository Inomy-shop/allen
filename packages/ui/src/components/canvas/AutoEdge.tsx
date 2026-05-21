import { BaseEdge, getSmoothStepPath, type EdgeProps, MarkerType } from '@xyflow/react';

/**
 * Forward edge — always orthogonal (right-angle routing with rounded
 * corners). Matches the visual language of established workflow tools
 * (n8n, Mermaid, XState Viz, etc.) where every edge is a series of
 * straight horizontal + vertical segments.
 *
 * Edges from the same source share an IDENTICAL stub offset (20px) so
 * they visually overlap on the shared initial segment leaving the node
 * — then diverge only where they need to reach different targets. This
 * reduces the "fan-out" visual clutter when a single node has many
 * outgoing edges (e.g. escalation_review with ~10 outgoing edges, or
 * plan_approval_gate with its 5 decision branches).
 */
const STUB_OFFSET = 20;

type RoutePoint = { x: number; y: number };

function orthogonalPath(points: RoutePoint[]): string {
  if (points.length === 0) return '';
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
    .join(' ');
}

function routeMidpoint(points: RoutePoint[]): RoutePoint | null {
  if (points.length < 2) return null;
  const middle = Math.floor(points.length / 2);
  const a = points[middle - 1];
  const b = points[middle];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export default function AutoEdge(props: EdgeProps) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, label, data } = props;
  const routePoints = (data as any)?.routePoints as RoutePoint[] | undefined;
  const routeMid = routePoints ? routeMidpoint(routePoints) : null;

  const [fallbackPath, fallbackLabelX, fallbackLabelY] = getSmoothStepPath({
    sourceX, sourceY, targetX, targetY,
    sourcePosition, targetPosition,
    borderRadius: 12,
    offset: STUB_OFFSET,
  });
  const edgePath = routePoints ? orthogonalPath(routePoints) : fallbackPath;
  const labelX = routeMid?.x ?? fallbackLabelX;
  const labelY = routeMid?.y ?? fallbackLabelY;

  return (
    <>
      <BaseEdge
        path={edgePath}
        style={{
          stroke: 'rgb(var(--color-surface))',
          strokeWidth: 7,
          opacity: 0.92,
        }}
      />
      <BaseEdge
        path={edgePath}
        style={{
          stroke: 'rgb(var(--color-flow-edge-default))',
          strokeWidth: 2.75,
          ...style,
        }}
        markerEnd={markerEnd ?? ({ type: MarkerType.ArrowClosed, width: 16, height: 16, color: 'rgb(var(--color-flow-edge-default))' } as any)}
        labelX={labelX}
        labelY={labelY}
        label={label}
      />
    </>
  );
}
