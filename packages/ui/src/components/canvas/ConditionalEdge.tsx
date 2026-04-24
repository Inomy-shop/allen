import { BaseEdge, getSmoothStepPath, type EdgeProps } from '@xyflow/react';

/**
 * Conditional edge — always orthogonal (right-angle with rounded corners).
 * Shares routing with AutoEdge; only the color and label chrome differ.
 *
 * Uses a fixed stub offset (20px) so edges from the same source overlap
 * on the shared leading segment before branching to their targets.
 */
const STUB_OFFSET = 20;

export default function ConditionalEdge(props: EdgeProps) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, label, markerEnd, style } = props;

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX, sourceY, targetX, targetY,
    sourcePosition, targetPosition,
    borderRadius: 12,
    offset: STUB_OFFSET,
  });

  return (
    <>
      <BaseEdge
        path={edgePath}
        // Base stroke + width come from the theme CSS var; anything
        // passed in `props.style` (like opacity / strokeWidth overrides
        // from the selected-node highlight logic in LiveGraph) wins via
        // the trailing spread.
        style={{
          stroke: 'rgb(var(--color-flow-edge-conditional))',
          strokeWidth: 2.5,
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
          x={labelX - 60} y={labelY - 12}
          width={120} height={24}
        >
          <div className="flex items-center justify-center">
            <span
              title={String(label)}
              className="bg-surface-200 border border-border/60 text-theme-secondary text-[9px] px-2 py-0.5 rounded-sm whitespace-nowrap max-w-[110px] truncate font-mono cursor-help hover:bg-surface-300 hover:border-border transition-colors"
            >
              {label as string}
            </span>
          </div>
        </foreignObject>
      )}
    </>
  );
}
