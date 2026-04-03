import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Cog } from 'lucide-react';

export default function CodeNode({ data, selected }: NodeProps) {
  return (
    <div className={`px-4 py-3 rounded-lg border-2 bg-surface-100/90 backdrop-blur-sm min-w-[150px] transition-all
      ${selected ? 'border-accent-green ring-2 ring-accent-green/30 shadow-glow-green' : 'border-accent-green/30 hover:border-accent-green/50'}
    `}>
      <Handle type="target" position={Position.Top} id="top" className="!bg-accent-green !w-2.5 !h-2.5 !border-surface" />
      <Handle type="target" position={Position.Right} id="right" className="!bg-accent-yellow !w-2 !h-2 !border-surface" />
      <Handle type="target" position={Position.Left} id="left" className="!bg-accent-yellow !w-2 !h-2 !border-surface" />
      <div className="flex items-center gap-2">
        <Cog className="w-4 h-4 text-accent-green" />
        <div>
          <div className="text-sm font-label font-medium text-gray-100">{(data as any).label}</div>
          <div className="text-[10px] text-accent-green/70 font-mono uppercase">{(data as any).function ?? 'code'}</div>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} id="bottom" className="!bg-accent-green !w-2.5 !h-2.5 !border-surface" />
      <Handle type="source" position={Position.Right} id="right" className="!bg-accent-yellow !w-2 !h-2 !border-surface" />
      <Handle type="source" position={Position.Left} id="left" className="!bg-accent-yellow !w-2 !h-2 !border-surface" />
    </div>
  );
}
