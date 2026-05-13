import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Code2 } from 'lucide-react';

export default function CodeNode({ data, selected }: NodeProps) {
  return (
    <div className={`px-4 py-3 rounded-lg border-2 bg-accent-green/10 dark:bg-accent-green/15 backdrop-blur-sm shadow-sm w-[280px] transition-all
      ${selected ? 'border-accent-green ring-2 ring-accent-green/30' : 'border-accent-green/60 hover:border-accent-green'}
    `}>
      <Handle type="target" position={Position.Top} id="top" className="!bg-accent-green !w-2.5 !h-2.5 !border-surface" />
      <Handle type="target" position={Position.Right} id="right" className="!bg-accent-yellow !w-2 !h-2 !border-surface" />
      <Handle type="target" position={Position.Left} id="left" className="!bg-accent-yellow !w-2 !h-2 !border-surface" />
      <Handle type="target" position={Position.Bottom} id="bottom" className="!bg-accent-green !w-2.5 !h-2.5 !border-surface" />
      <div className="flex items-center gap-2 min-w-0">
        <Code2 className="w-4 h-4 text-accent-green shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-label font-semibold text-theme-primary truncate">{(data as any).label}</div>
          <div className="text-[10px] text-accent-green font-mono uppercase truncate">{(data as any).function ?? 'code'}</div>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} id="bottom" className="!bg-accent-green !w-2.5 !h-2.5 !border-surface" />
      <Handle type="source" position={Position.Right} id="right" className="!bg-accent-yellow !w-2 !h-2 !border-surface" />
      <Handle type="source" position={Position.Left} id="left" className="!bg-accent-yellow !w-2 !h-2 !border-surface" />
      <Handle type="source" position={Position.Top} id="top" className="!bg-accent-green !w-2.5 !h-2.5 !border-surface" />
    </div>
  );
}
