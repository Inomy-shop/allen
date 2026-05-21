import { Handle, Position, type NodeProps } from '@xyflow/react';
import { User } from 'lucide-react';

export default function HumanNode({ data, selected }: NodeProps) {
  return (
    <div className={`px-4 py-3 rounded-lg border-2 bg-[#fff3d8] dark:bg-[#34250d] shadow-md w-[280px] transition-all
      ${selected ? 'border-accent-orange ring-2 ring-accent-orange' : 'border-accent-orange hover:shadow-lg'}
    `}>
      <Handle type="target" position={Position.Top} id="top" className="!bg-accent-orange !w-2.5 !h-2.5 !border-surface" />
      <Handle type="target" position={Position.Right} id="right" className="!bg-accent-yellow !w-2 !h-2 !border-surface" />
      <Handle type="target" position={Position.Left} id="left" className="!bg-accent-yellow !w-2 !h-2 !border-surface" />
      <Handle type="target" position={Position.Bottom} id="bottom" className="!bg-accent-orange !w-2.5 !h-2.5 !border-surface" />
      <div className="flex items-center gap-2 min-w-0">
        <User className="w-4 h-4 text-accent-orange shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-label font-semibold text-theme-primary truncate">{(data as any).label}</div>
          <div className="text-[10px] text-accent-orange font-mono uppercase truncate">human input</div>
        </div>
      </div>
      {(data as any).fields?.length > 0 && (
        <div className="mt-1.5 text-[10px] text-accent-orange font-mono">
          {(data as any).fields.length} field{(data as any).fields.length > 1 ? 's' : ''}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} id="bottom" className="!bg-accent-orange !w-2.5 !h-2.5 !border-surface" />
      <Handle type="source" position={Position.Right} id="right" className="!bg-accent-yellow !w-2 !h-2 !border-surface" />
      <Handle type="source" position={Position.Left} id="left" className="!bg-accent-yellow !w-2 !h-2 !border-surface" />
      <Handle type="source" position={Position.Top} id="top" className="!bg-accent-orange !w-2.5 !h-2.5 !border-surface" />
    </div>
  );
}
