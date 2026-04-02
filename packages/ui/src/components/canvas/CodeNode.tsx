import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Cog } from 'lucide-react';

export default function CodeNode({ data, selected }: NodeProps) {
  return (
    <div className={`px-4 py-3 rounded-lg border-2 bg-surface-100 min-w-[150px]
      ${selected ? 'border-accent-green ring-2 ring-green-500/30' : 'border-green-500/40'}
    `}>
      <Handle type="target" position={Position.Top} className="!bg-green-500 !w-2.5 !h-2.5 !border-surface" />
      <div className="flex items-center gap-2">
        <Cog className="w-4 h-4 text-green-400" />
        <div>
          <div className="text-sm font-medium text-gray-100">{(data as any).label}</div>
          <div className="text-[10px] text-green-300">{(data as any).function ?? 'code'}</div>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-green-500 !w-2.5 !h-2.5 !border-surface" />
    </div>
  );
}
