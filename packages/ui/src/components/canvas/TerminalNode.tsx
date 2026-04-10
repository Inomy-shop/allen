import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Play, Square } from 'lucide-react';

export default function TerminalNode({ data, id }: NodeProps) {
  const isStart = id === 'START';
  const Icon = isStart ? Play : Square;

  return (
    <div className="px-5 py-2 rounded-full border-2 border-border/30 bg-surface-200/60 backdrop-blur-sm
      flex items-center gap-2 select-none"
    >
      <Icon className="w-3.5 h-3.5 text-theme-muted" />
      <span className="text-xs font-heading font-semibold text-theme-muted uppercase tracking-wider">
        {id}
      </span>

      {isStart ? (
        <Handle type="source" position={Position.Bottom} id="bottom" className="!bg-theme-muted !w-2.5 !h-2.5 !border-surface" />
      ) : (
        <Handle type="target" position={Position.Top} id="top" className="!bg-theme-muted !w-2.5 !h-2.5 !border-surface" />
      )}
    </div>
  );
}
