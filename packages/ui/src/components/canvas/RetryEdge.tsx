import { BaseEdge, type EdgeProps } from '@xyflow/react';

export default function RetryEdge(props: EdgeProps) {
  const { sourceX, sourceY, targetX, targetY, data, markerEnd } = props;

  const maxRetries = (data as any)?.max_retries;

  // Custom path: right → out → up → back → in
  // Source exits from right side, target enters from right side
  const offset = 60; // how far right the loop goes
  const cornerRadius = 15;

  // Build the path:
  // 1. Go right from source
  // 2. Curve up
  // 3. Go straight up to target height
  // 4. Curve left
  // 5. Connect to target

  const midX = Math.max(sourceX, targetX) + offset;

  const edgePath = [
    `M ${sourceX} ${sourceY}`,                                         // start at source (right handle)
    `L ${midX - cornerRadius} ${sourceY}`,                             // go right
    `Q ${midX} ${sourceY} ${midX} ${sourceY - cornerRadius}`,         // curve up
    `L ${midX} ${targetY + cornerRadius}`,                             // go straight up
    `Q ${midX} ${targetY} ${midX - cornerRadius} ${targetY}`,         // curve left
    `L ${targetX} ${targetY}`,                                         // go to target
  ].join(' ');

  // Label position: middle of the vertical segment
  const labelX = midX + 8;
  const labelY = (sourceY + targetY) / 2;

  return (
    <>
      <defs>
        <marker
          id="ff-arrow-yellow"
          markerWidth="16"
          markerHeight="16"
          viewBox="-5 -5 10 10"
          refX="0"
          refY="0"
          orient="auto-start-reverse"
          markerUnits="strokeWidth"
        >
          <path d="M-3,-3 L3,0 L-3,3 Z" fill="#ffaa00" />
        </marker>
      </defs>
      <BaseEdge
        path={edgePath}
        style={{
          stroke: '#ffaa00',
          strokeWidth: 2,
          strokeDasharray: '6 3',
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
