import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Play, Square } from 'lucide-react';

export default function TerminalNode({ data, id }: NodeProps) {
  const isStart = id === 'START';
  const Icon = isStart ? Play : Square;
  // `START` stays the reserved node id the engine/YAML use; only the label
  // shown on the canvas reads "INPUT" (the workflow's entry / input node).
  const label = isStart ? 'INPUT' : id;

  return (
    <div className="px-5 py-2 rounded-full border-2 border-app-strong bg-[#f4f5f7] dark:bg-[#202229] shadow-md
      flex items-center gap-2 select-none"
    >
      <Icon className="w-3.5 h-3.5 text-theme-secondary" />
      <span className="text-xs font-heading font-semibold text-theme-primary uppercase tracking-wider">
        {label}
      </span>

      {isStart ? (
        <>
          <Handle type="source" position={Position.Bottom} id="bottom" className="!bg-theme-muted !w-2.5 !h-2.5 !border-surface" />
          <Handle type="source" position={Position.Right} id="right" className="!bg-theme-muted !w-2 !h-2 !border-surface" />
          <Handle type="source" position={Position.Left} id="left" className="!bg-theme-muted !w-2 !h-2 !border-surface" />
          <Handle type="source" position={Position.Top} id="top" className="!bg-theme-muted !w-2.5 !h-2.5 !border-surface" />
        </>
      ) : (
        <>
          <Handle type="target" position={Position.Top} id="top" className="!bg-theme-muted !w-2.5 !h-2.5 !border-surface" />
          <Handle type="target" position={Position.Right} id="right" className="!bg-theme-muted !w-2 !h-2 !border-surface" />
          <Handle type="target" position={Position.Left} id="left" className="!bg-theme-muted !w-2 !h-2 !border-surface" />
          <Handle type="target" position={Position.Bottom} id="bottom" className="!bg-theme-muted !w-2.5 !h-2.5 !border-surface" />
        </>
      )}
    </div>
  );
}
