import { Handle, Position, type NodeProps } from '@xyflow/react';
import { GitBranch } from 'lucide-react';

export default function WorkflowNode({ data, selected }: NodeProps) {
  return (
    <div className={`px-4 py-3 rounded-lg border-2 bg-surface-100 min-w-[150px]
      ${selected ? 'border-accent-purple ring-2 ring-purple-500/30' : 'border-purple-500/40'}
    `}>
      <Handle type="target" position={Position.Top} className="!bg-purple-500 !w-2.5 !h-2.5 !border-surface" />
      <div className="flex items-center gap-2">
        <GitBranch className="w-4 h-4 text-purple-400" />
        <div>
          <div className="text-sm font-medium text-gray-100">{(data as any).label}</div>
          <div className="text-[10px] text-purple-300">→ {(data as any).workflow ?? 'sub-workflow'}</div>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-purple-500 !w-2.5 !h-2.5 !border-surface" />
    </div>
  );
}
