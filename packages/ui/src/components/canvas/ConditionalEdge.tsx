import { BaseEdge, getSmoothStepPath, type EdgeProps } from '@xyflow/react';

export default function ConditionalEdge(props: EdgeProps) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, label } = props;

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  });

  return (
    <>
      <BaseEdge path={edgePath} style={{ stroke: '#a855f7', strokeWidth: 2 }} />
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
