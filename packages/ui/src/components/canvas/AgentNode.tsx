import { Handle, Position, type NodeProps } from '@xyflow/react';
import RoleIcon from '../common/RoleIcon';

export default function AgentNode({ data, selected }: NodeProps) {
  return (
    <div className={`px-4 py-3 rounded-sm border-2 bg-surface-100/90 backdrop-blur-sm min-w-[150px] transition-all
      ${selected ? 'border-accent-blue ring-2 ring-accent-blue/30 shadow-glow-blue' : 'border-accent-blue/30 hover:border-accent-blue/50'}
    `}>
      <Handle type="target" position={Position.Top} className="!bg-accent-blue !w-2.5 !h-2.5 !border-surface" />
      <div className="flex items-center gap-2">
        <RoleIcon icon={(data as any).icon} color={(data as any).color ?? '#00d4ff'} size={16} />
        <div>
          <div className="text-sm font-label font-medium text-gray-100">{(data as any).label}</div>
          <div className="text-[10px] text-accent-blue/70 font-mono uppercase">{(data as any).role ?? 'agent'}</div>
        </div>
      </div>
      {(data as any).outputs?.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {(data as any).outputs.map((o: string) => (
            <span key={o} className="text-[9px] bg-accent-blue/10 text-accent-blue/70 px-1 rounded-sm font-mono">{o}</span>
          ))}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-accent-blue !w-2.5 !h-2.5 !border-surface" />
    </div>
  );
}
