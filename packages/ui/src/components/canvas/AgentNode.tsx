import { Handle, Position, type NodeProps } from '@xyflow/react';
import RoleIcon from '../common/RoleIcon';
import { outputsAsKeys } from '../../utils/outputs';

export default function AgentNode({ data, selected }: NodeProps) {
  return (
    <div className={`px-4 py-3 rounded-lg border-2 bg-accent-blue/10 dark:bg-accent-blue/15 backdrop-blur-sm shadow-sm w-[280px] transition-all
      ${selected ? 'border-accent-blue ring-2 ring-accent-blue/30' : 'border-accent-blue/60 hover:border-accent-blue'}
    `}>
      <Handle type="target" position={Position.Top} id="top" className="!bg-accent-blue !w-2.5 !h-2.5 !border-surface" />
      <Handle type="target" position={Position.Right} id="right" className="!bg-accent-yellow !w-2 !h-2 !border-surface" />
      <Handle type="target" position={Position.Left} id="left" className="!bg-accent-yellow !w-2 !h-2 !border-surface" />
      <Handle type="target" position={Position.Bottom} id="bottom" className="!bg-accent-blue !w-2.5 !h-2.5 !border-surface" />
      <div className="flex items-center gap-2 min-w-0">
        <RoleIcon icon={(data as any).icon} color={(data as any).color ?? '#00d4ff'} size={16} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-label font-semibold text-theme-primary truncate">{(data as any).label}</div>
          <div className="text-[10px] text-accent-blue font-mono uppercase truncate">{(data as any).agent ?? 'agent'}</div>
        </div>
      </div>
      {(() => {
        const keys = outputsAsKeys((data as any).outputs);
        if (keys.length === 0) return null;
        const MAX_VISIBLE = 3;
        const visible = keys.slice(0, MAX_VISIBLE);
        const hidden = keys.length - visible.length;
        return (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {visible.map((o) => (
              <span key={o} className="text-[10px] bg-surface-100/80 border border-accent-blue/20 text-accent-blue px-1 rounded-sm font-mono">{o}</span>
            ))}
            {hidden > 0 && (
              <span
                className="text-[10px] bg-surface-100/80 border border-accent-blue/20 text-accent-blue px-1 rounded-sm font-mono"
                title={keys.slice(MAX_VISIBLE).join(', ')}
              >
                +{hidden}
              </span>
            )}
          </div>
        );
      })()}
      <Handle type="source" position={Position.Bottom} id="bottom" className="!bg-accent-blue !w-2.5 !h-2.5 !border-surface" />
      <Handle type="source" position={Position.Right} id="right" className="!bg-accent-yellow !w-2 !h-2 !border-surface" />
      <Handle type="source" position={Position.Left} id="left" className="!bg-accent-yellow !w-2 !h-2 !border-surface" />
      <Handle type="source" position={Position.Top} id="top" className="!bg-accent-blue !w-2.5 !h-2.5 !border-surface" />
    </div>
  );
}
