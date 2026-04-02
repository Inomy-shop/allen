import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react';

export default function RetryEdge(props: EdgeProps) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd } = props;

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  });

  const maxRetries = (data as any)?.max_retries;

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
        markerEnd={markerEnd ?? `url(#ff-arrow-yellow)`}
      />
      {maxRetries != null && (
        <foreignObject
          x={labelX - 30} y={labelY - 12}
          width={60} height={24}
          className="pointer-events-none"
        >
          <div className="flex items-center justify-center">
            <span className="bg-surface-200 border border-accent-yellow/30 text-accent-yellow text-[9px] px-2 py-0.5 rounded-sm font-mono">
              {maxRetries}
            </span>
          </div>
        </foreignObject>
      )}
    </>
  );
}
