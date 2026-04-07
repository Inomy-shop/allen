import { BaseEdge, getBezierPath, type EdgeProps, MarkerType } from '@xyflow/react';

export default function ConditionalEdge(props: EdgeProps) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, label, markerEnd } = props;

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  });

  return (
    <>
      <BaseEdge
        path={edgePath}
        style={{ stroke: 'rgb(var(--color-flow-edge-conditional))', strokeWidth: 2 }}
        markerEnd={markerEnd ?? `url(#ff-arrow-purple)`}
      />
      {/* Custom arrow marker definition */}
      <defs>
        <marker
          id="ff-arrow-purple"
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
          x={labelX - 60} y={labelY - 12}
          width={120} height={24}
          className="pointer-events-none"
        >
          <div className="flex items-center justify-center">
            <span className="bg-surface-200 border border-accent-purple/30 text-accent-purple text-[9px] px-2 py-0.5 rounded-sm whitespace-nowrap max-w-[110px] truncate font-mono">
              {label as string}
            </span>
          </div>
        </foreignObject>
      )}
    </>
  );
}
