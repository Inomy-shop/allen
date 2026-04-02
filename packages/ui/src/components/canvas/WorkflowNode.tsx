import { Handle, Position, type NodeProps } from '@xyflow/react';
import { GitBranch } from 'lucide-react';

export default function WorkflowNode({ data, selected }: NodeProps) {
  return (
    <div className={`px-4 py-3 rounded-sm border-2 bg-surface-100/90 backdrop-blur-sm min-w-[150px] transition-all
      ${selected ? 'border-accent-purple ring-2 ring-accent-purple/30 shadow-glow-purple' : 'border-accent-purple/30 hover:border-accent-purple/50'}
    `}>
      <Handle type="target" position={Position.Top} className="!bg-accent-purple !w-2.5 !h-2.5 !border-surface" />
      <div className="flex items-center gap-2">
        <GitBranch className="w-4 h-4 text-accent-purple" />
        <div>
          <div className="text-sm font-label font-medium text-gray-100">{(data as any).label}</div>
          <div className="text-[10px] text-accent-purple/70 font-mono uppercase">{(data as any).workflow ?? 'sub-workflow'}</div>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-accent-purple !w-2.5 !h-2.5 !border-surface" />
    </div>
  );
}
