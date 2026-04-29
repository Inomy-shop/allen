import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Workflow } from 'lucide-react';

export default function WorkflowNode({ data, selected }: NodeProps) {
  return (
    <div className={`px-4 py-3 rounded-lg border-2 bg-surface-100/90 backdrop-blur-sm w-[280px] transition-all
      ${selected ? 'border-accent-purple ring-2 ring-accent-purple/30' : 'border-accent-purple/30 hover:border-accent-purple/50'}
    `}>
      <Handle type="target" position={Position.Top} id="top" className="!bg-accent-purple !w-2.5 !h-2.5 !border-surface" />
      <Handle type="target" position={Position.Right} id="right" className="!bg-accent-yellow !w-2 !h-2 !border-surface" />
      <Handle type="target" position={Position.Left} id="left" className="!bg-accent-yellow !w-2 !h-2 !border-surface" />
      <Handle type="target" position={Position.Bottom} id="bottom" className="!bg-accent-purple !w-2.5 !h-2.5 !border-surface" />
      <div className="flex items-center gap-2 min-w-0">
        <Workflow className="w-4 h-4 text-accent-purple shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-label font-medium text-gray-100 truncate">{(data as any).label}</div>
          <div className="text-[10px] text-accent-purple/70 font-mono uppercase truncate">{(data as any).workflow ?? 'sub-workflow'}</div>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} id="bottom" className="!bg-accent-purple !w-2.5 !h-2.5 !border-surface" />
      <Handle type="source" position={Position.Right} id="right" className="!bg-accent-yellow !w-2 !h-2 !border-surface" />
      <Handle type="source" position={Position.Left} id="left" className="!bg-accent-yellow !w-2 !h-2 !border-surface" />
      <Handle type="source" position={Position.Top} id="top" className="!bg-accent-purple !w-2.5 !h-2.5 !border-surface" />
    </div>
  );
}
