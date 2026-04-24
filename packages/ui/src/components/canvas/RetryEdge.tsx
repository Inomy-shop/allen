import { BaseEdge, type EdgeProps } from '@xyflow/react';

export default function RetryEdge(props: EdgeProps) {
  const { sourceX, sourceY, targetX, targetY, data, markerEnd, style } = props;

  const maxRetries = (data as any)?.max_retries;
  const side = (data as any)?.retrySide ?? 'right';

  const offset = 60;
  const cornerRadius = 15;

  let edgePath: string;
  let labelX: number;
  let labelY: number;

  if (side === 'left') {
    // Left side: go left → up → right to target
    const midX = Math.min(sourceX, targetX) - offset;
    edgePath = [
      `M ${sourceX} ${sourceY}`,
      `L ${midX + cornerRadius} ${sourceY}`,
      `Q ${midX} ${sourceY} ${midX} ${sourceY - cornerRadius}`,
      `L ${midX} ${targetY + cornerRadius}`,
      `Q ${midX} ${targetY} ${midX + cornerRadius} ${targetY}`,
      `L ${targetX} ${targetY}`,
    ].join(' ');
    labelX = midX - 40;
    labelY = (sourceY + targetY) / 2;
  } else {
    // Right side: go right → up → left to target
    const midX = Math.max(sourceX, targetX) + offset;
    edgePath = [
      `M ${sourceX} ${sourceY}`,
      `L ${midX - cornerRadius} ${sourceY}`,
      `Q ${midX} ${sourceY} ${midX} ${sourceY - cornerRadius}`,
      `L ${midX} ${targetY + cornerRadius}`,
      `Q ${midX} ${targetY} ${midX - cornerRadius} ${targetY}`,
      `L ${targetX} ${targetY}`,
    ].join(' ');
    labelX = midX + 8;
    labelY = (sourceY + targetY) / 2;
  }

  return (
    <>
      <defs>
        <marker
          id="al-arrow-yellow"
          markerWidth="16"
          markerHeight="16"
          viewBox="-5 -5 10 10"
          refX="0"
          refY="0"
          orient="auto-start-reverse"
          markerUnits="strokeWidth"
        >
          <path d="M-3,-3 L3,0 L-3,3 Z" fill="rgb(var(--color-flow-edge-retry))" />
        </marker>
      </defs>
      <BaseEdge
        path={edgePath}
        // Theme CSS var supplies the base stroke color (amber in both
        // themes). Trailing `...style` spread lets the selected-node
        // highlight in LiveGraph override opacity + strokeWidth on this
        // edge too — previously those overrides were silently dropped
        // because retry edges hardcoded their full style inline.
        style={{
          stroke: 'rgb(var(--color-flow-edge-retry))',
          strokeWidth: 2.5,
          strokeDasharray: '6 3',
          ...(style as any),
        }}
        markerEnd={markerEnd ?? 'url(#ff-arrow-yellow)'}
      />
      {maxRetries != null && (
        <foreignObject
          x={labelX} y={labelY - 16}
          width={80} height={32}
          className="pointer-events-none"
        >
          <div className="flex items-center justify-center">
            <span className="bg-surface-200 border border-accent-yellow/30 text-accent-yellow text-base px-3 py-1 rounded-sm font-mono font-semibold">
              ↻ ≤{maxRetries}
            </span>
          </div>
        </foreignObject>
      )}
    </>
  );
}
