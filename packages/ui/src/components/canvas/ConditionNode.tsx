import { Handle, Position, type NodeProps } from '@xyflow/react';
import { HelpCircle } from 'lucide-react';

export default function ConditionNode({ data, selected }: NodeProps) {
  return (
    <div className="relative flex items-center justify-center" style={{ width: 140, height: 140 }}>
      {/* Diamond shape */}
      <div
        className={`absolute inset-0 border-2 bg-surface-100/90 backdrop-blur-sm
          ${selected ? 'border-accent-yellow ring-2 ring-accent-yellow/30 shadow-glow-yellow' : 'border-accent-yellow/30'}
        `}
        style={{ transform: 'rotate(45deg)', borderRadius: 4, width: 100, height: 100, top: 20, left: 20 }}
      />

      <Handle type="target" position={Position.Top} className="!bg-accent-yellow !w-2.5 !h-2.5 !border-surface" />

      {/* Content (not rotated) */}
      <div className="relative z-10 flex flex-col items-center text-center pointer-events-none">
        <HelpCircle className="w-4 h-4 text-accent-yellow mb-1" />
        <div className="text-xs font-label font-medium text-gray-100">{(data as any).label}</div>
        <div className="text-[9px] text-accent-yellow/70 font-mono uppercase">condition</div>
      </div>

      <Handle type="source" position={Position.Bottom} className="!bg-accent-yellow !w-2.5 !h-2.5 !border-surface" />
    </div>
  );
}
