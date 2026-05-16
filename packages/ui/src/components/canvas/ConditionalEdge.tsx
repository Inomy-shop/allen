import { BaseEdge, getSmoothStepPath, type EdgeProps } from '@xyflow/react';

/**
 * Conditional edge — always orthogonal (right-angle with rounded corners).
 * Shares routing with AutoEdge; only the color and label chrome differ.
 *
 * Uses a fixed stub offset (20px) so edges from the same source overlap
 * on the shared leading segment before branching to their targets.
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

function formatConditionLabel(value: unknown): string {
  return String(value)
    .replace(/\s+/g, ' ')
    .replace(/\b&&\b|&&/g, ' and ')
    .replace(/\b\|\|\b|\|\|/g, ' or ')
    .replace(/!==/g, ' is not ')
    .replace(/!=/g, ' is not ')
    .replace(/===/g, ' is ')
    .replace(/==/g, ' is ')
    .replace(/>=/g, ' >= ')
    .replace(/<=/g, ' <= ')
    .replace(/\s+/g, ' ')
    .replace(/["']/g, '')
    .trim();
}

function shortConditionLabel(value: unknown): string {
  const formatted = formatConditionLabel(value);
  if (formatted.length <= 46) return formatted;
  const parts = formatted.split(/\s+(and|or)\s+/i);
  if (parts[0] && parts[0].length <= 42) return `${parts[0]} + more`;
  return `${formatted.slice(0, 43).trim()}...`;
}

export default function ConditionalEdge(props: EdgeProps) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, label, markerEnd, style, data } = props;
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
  const labelText = label ? shortConditionLabel(label) : '';
  const fullLabelText = label ? formatConditionLabel(label) : '';

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
        // Base stroke + width come from the theme CSS var; anything
        // passed in `props.style` (like opacity / strokeWidth overrides
        // from the selected-node highlight logic in LiveGraph) wins via
        // the trailing spread.
        style={{
          stroke: 'rgb(var(--color-flow-edge-conditional))',
          strokeWidth: 2.75,
          ...(style as any),
        }}
        markerEnd={markerEnd ?? `url(#ff-arrow-purple)`}
      />
      {/* Custom arrow marker definition */}
      <defs>
        <marker
          id="al-arrow-purple"
          markerWidth="16"
          markerHeight="16"
          viewBox="-5 -5 10 10"
          refX="0"
          refY="0"
          orient="auto-start-reverse"
          markerUnits="strokeWidth"
        >
          <path d="M-3,-3 L3,0 L-3,3 Z" fill="rgb(var(--color-flow-edge-conditional))" />
        </marker>
      </defs>
      {label && (
        <foreignObject
          x={labelX - 120} y={labelY - 18}
          width={240} height={38}
          className="overflow-visible"
        >
          <div className="flex items-center justify-center">
            <span
              title={fullLabelText}
              className="max-w-[220px] rounded-md border border-accent-blue/35 bg-app-card/95 px-2.5 py-1 text-center font-mono text-[10.5px] leading-snug text-theme-primary shadow-popover ring-1 ring-black/20 backdrop-blur-sm transition-all hover:max-w-[360px] hover:border-accent-blue hover:bg-app-card hover:text-theme-primary"
            >
              {labelText}
            </span>
          </div>
        </foreignObject>
      )}
    </>
  );
}
