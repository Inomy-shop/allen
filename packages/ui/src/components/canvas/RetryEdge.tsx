import { BaseEdge, getSmoothStepPath, type EdgeProps } from '@xyflow/react';

export default function RetryEdge(props: EdgeProps) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data } = props;

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  });

  const maxRetries = (data as any)?.max_retries;

  return (
    <>
      <BaseEdge
        path={edgePath}
        style={{
          stroke: '#eab308',
          strokeWidth: 2,
          strokeDasharray: '6 3',
        }}
      />
      {maxRetries != null && (
        <foreignObject
          x={labelX - 30} y={labelY - 12}
          width={60} height={24}
          className="pointer-events-none"
        >
          <div className="flex items-center justify-center">
            <span className="bg-surface-200 border border-yellow-500/30 text-yellow-300 text-[9px] px-2 py-0.5 rounded-full">
              ↻ ≤{maxRetries}
            </span>
          </div>
        </foreignObject>
      )}
    </>
  );
}
