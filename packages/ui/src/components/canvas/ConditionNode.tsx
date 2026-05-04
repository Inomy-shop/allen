import { Handle, Position, type NodeProps } from '@xyflow/react';
import { GitFork } from 'lucide-react';

export default function ConditionNode({ data, selected }: NodeProps) {
  return (
    <div className="relative flex items-center justify-center" style={{ width: 180, height: 180 }}>
      {/* Diamond shape — scaled up so the node's bounding width matches
          the other node types (180px). */}
      <div
        className={`absolute border-2 bg-surface-100/90 backdrop-blur-sm
          ${selected ? 'border-accent-yellow ring-2 ring-accent-yellow/30' : 'border-accent-yellow/30'}
        `}
        style={{ transform: 'rotate(45deg)', borderRadius: 4, width: 130, height: 130, top: 25, left: 25 }}
      />

      <Handle type="target" position={Position.Top} id="top" className="!bg-accent-yellow !w-2.5 !h-2.5 !border-surface" />
      <Handle type="target" position={Position.Right} id="right" className="!bg-accent-yellow !w-2 !h-2 !border-surface" />
      <Handle type="target" position={Position.Left} id="left" className="!bg-accent-yellow !w-2 !h-2 !border-surface" />
      <Handle type="target" position={Position.Bottom} id="bottom" className="!bg-accent-yellow !w-2.5 !h-2.5 !border-surface" />

      {/* Content (not rotated) */}
      <div className="relative z-10 flex flex-col items-center text-center pointer-events-none">
        <GitFork className="w-5 h-5 text-accent-yellow mb-1" />
        <div className="text-xs font-label font-medium text-gray-100">{(data as any).label}</div>
        <div className="text-[9px] text-accent-yellow/70 font-mono uppercase">condition</div>
      </div>

      <Handle type="source" position={Position.Bottom} id="bottom" className="!bg-accent-yellow !w-2.5 !h-2.5 !border-surface" />
      <Handle type="source" position={Position.Right} id="right" className="!bg-accent-yellow !w-2 !h-2 !border-surface" />
      <Handle type="source" position={Position.Left} id="left" className="!bg-accent-yellow !w-2 !h-2 !border-surface" />
      <Handle type="source" position={Position.Top} id="top" className="!bg-accent-yellow !w-2.5 !h-2.5 !border-surface" />
    </div>
  );
}
