import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Play, Square } from 'lucide-react';

export default function TerminalNode({ data, id }: NodeProps) {
  const isStart = id === 'START';
  const Icon = isStart ? Play : Square;

  return (
    <div className="px-5 py-2 rounded-full border-2 border-gray-600/40 bg-surface-200/60 backdrop-blur-sm
      flex items-center gap-2 select-none"
    >
      <Icon className="w-3.5 h-3.5 text-gray-500" />
      <span className="text-xs font-heading font-semibold text-gray-500 uppercase tracking-wider">
        {id}
      </span>

      {isStart ? (
        <Handle type="source" position={Position.Bottom} className="!bg-gray-500 !w-2.5 !h-2.5 !border-surface" />
      ) : (
        <Handle type="target" position={Position.Top} className="!bg-gray-500 !w-2.5 !h-2.5 !border-surface" />
      )}
    </div>
  );
}
