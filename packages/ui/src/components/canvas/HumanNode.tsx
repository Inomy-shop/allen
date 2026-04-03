import { Handle, Position, type NodeProps } from '@xyflow/react';
import { MessageSquare } from 'lucide-react';

export default function HumanNode({ data, selected }: NodeProps) {
  return (
    <div className={`px-4 py-3 rounded-lg border-2 bg-surface-100/90 backdrop-blur-sm min-w-[150px] transition-all
      ${selected ? 'border-accent-orange ring-2 ring-accent-orange/30' : 'border-accent-orange/30 hover:border-accent-orange/50'}
    `}>
      <Handle type="target" position={Position.Top} id="top" className="!bg-accent-orange !w-2.5 !h-2.5 !border-surface" />
      <Handle type="target" position={Position.Right} id="right" className="!bg-accent-yellow !w-2 !h-2 !border-surface" />
      <div className="flex items-center gap-2">
        <MessageSquare className="w-4 h-4 text-accent-orange" />
        <div>
          <div className="text-sm font-label font-medium text-gray-100">{(data as any).label}</div>
          <div className="text-[10px] text-accent-orange/70 font-mono uppercase">human input</div>
        </div>
      </div>
      {(data as any).fields?.length > 0 && (
        <div className="mt-1.5 text-[9px] text-accent-orange/50 font-mono">
          {(data as any).fields.length} field{(data as any).fields.length > 1 ? 's' : ''}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} id="bottom" className="!bg-accent-orange !w-2.5 !h-2.5 !border-surface" />
      <Handle type="source" position={Position.Right} id="right" className="!bg-accent-yellow !w-2 !h-2 !border-surface" />
    </div>
  );
}
