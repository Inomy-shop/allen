import { Handle, Position, type NodeProps } from '@xyflow/react';
import RoleIcon from '../common/RoleIcon';

export default function AgentNode({ data, selected }: NodeProps) {
  return (
    <div className={`px-4 py-3 rounded-lg border-2 bg-surface-100 min-w-[150px]
      ${selected ? 'border-accent-blue ring-2 ring-accent-blue/30' : 'border-blue-500/40'}
    `}>
      <Handle type="target" position={Position.Top} className="!bg-blue-500 !w-2.5 !h-2.5 !border-surface" />
      <div className="flex items-center gap-2">
        <RoleIcon icon={(data as any).icon} color={(data as any).color ?? '#3498db'} size={16} />
        <div>
          <div className="text-sm font-medium text-gray-100">{(data as any).label}</div>
          <div className="text-[10px] text-blue-300">{(data as any).role ?? 'agent'}</div>
        </div>
      </div>
      {(data as any).outputs?.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {(data as any).outputs.map((o: string) => (
            <span key={o} className="text-[9px] bg-blue-500/10 text-blue-300 px-1 rounded">{o}</span>
          ))}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-blue-500 !w-2.5 !h-2.5 !border-surface" />
    </div>
  );
}
