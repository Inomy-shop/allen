import { Handle, Position, type NodeProps } from '@xyflow/react';
import { MessageSquare } from 'lucide-react';

export default function HumanNode({ data, selected }: NodeProps) {
  return (
    <div className={`px-4 py-3 rounded-lg border-2 bg-surface-100 min-w-[150px]
      ${selected ? 'border-accent-orange ring-2 ring-orange-500/30' : 'border-orange-500/40'}
    `}>
      <Handle type="target" position={Position.Top} className="!bg-orange-500 !w-2.5 !h-2.5 !border-surface" />
      <div className="flex items-center gap-2">
        <MessageSquare className="w-4 h-4 text-orange-400" />
        <div>
          <div className="text-sm font-medium text-gray-100">{(data as any).label}</div>
          <div className="text-[10px] text-orange-300">human input</div>
        </div>
      </div>
      {(data as any).fields?.length > 0 && (
        <div className="mt-1.5 text-[9px] text-orange-300/70">
          {(data as any).fields.length} field{(data as any).fields.length > 1 ? 's' : ''}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-orange-500 !w-2.5 !h-2.5 !border-surface" />
    </div>
  );
}
