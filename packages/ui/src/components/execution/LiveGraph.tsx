import type { NodeState } from '../../hooks/useExecution';
import RoleIcon from '../common/RoleIcon';

const statusColors: Record<string, string> = {
  pending: 'border-gray-600/50 bg-surface-200',
  running: 'border-accent-blue bg-accent-blue/10 ring-1 ring-accent-blue/30 shadow-glow-blue',
  completed: 'border-accent-green bg-accent-green/10',
  failed: 'border-accent-red bg-accent-red/10 shadow-glow-red/30',
};

interface Props {
  workflow: any;
  nodeStates: Map<string, NodeState>;
  selectedNode: string | null;
  onSelectNode: (name: string) => void;
}

export default function LiveGraph({ workflow, nodeStates, selectedNode, onSelectNode }: Props) {
  // Build nodes from workflow definition if available, otherwise from nodeStates
  const workflowNodes = workflow?.parsed?.nodes;
  const nodeEntries: [string, any][] = workflowNodes
    ? Object.entries(workflowNodes)
    : Array.from(nodeStates.entries()).map(([name, state]) => [name, { type: 'agent', role: name }]);

  if (nodeEntries.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm font-mono">
        WAITING FOR NODES...
      </div>
    );
  }

  // Build edges from workflow if available
  const edges: any[] = workflow?.parsed?.edges ?? [];

  return (
    <div className="p-4 overflow-auto h-full">
      {/* Node graph */}
      <div className="flex flex-wrap gap-3 mb-4">
        {nodeEntries.map(([name, nodeDef]) => {
          const state = nodeStates.get(name);
          const status = state?.status ?? 'pending';
          const isSelected = selectedNode === name;
          const type = nodeDef?.type ?? 'agent';

          return (
            <button
              key={name}
              onClick={() => onSelectNode(name)}
              className={`relative flex items-center gap-2 px-4 py-3 rounded-sm border-2 transition-all cursor-pointer min-w-[140px]
                ${statusColors[status] ?? statusColors.pending}
                ${isSelected ? 'ring-2 ring-accent-blue' : ''}
              `}
            >
              <RoleIcon icon={nodeDef?.icon} color={nodeDef?.color} size={18} />
              <div className="text-left">
                <div className="text-sm font-label font-medium text-gray-100">{name}</div>
                <div className="text-xs text-gray-400 font-mono">
                  {type === 'agent' ? nodeDef?.role ?? 'agent' : type}
                </div>
              </div>
              {state?.attempt != null && state.attempt > 1 && (
                <span className="absolute -top-2 -right-2 bg-accent-yellow text-black text-[10px] font-bold rounded-sm w-5 h-5 flex items-center justify-center font-mono">
                  {state.attempt}
                </span>
              )}
              {status === 'running' && (
                <span className="absolute -top-1 -right-1 w-3 h-3 bg-accent-blue rounded-full animate-ping" />
              )}
            </button>
          );
        })}
      </div>

      {/* Edge flow indicators */}
      {edges.length > 0 && (
        <div className="flex flex-wrap gap-2 text-[10px] text-gray-500">
          {edges.map((edge: any, i: number) => {
            const from = Array.isArray(edge.from) ? edge.from.join(', ') : edge.from;
            const to = Array.isArray(edge.to) ? edge.to.join(', ') : edge.to;
            return (
              <span key={i} className="bg-surface-200 border border-border/40 px-2 py-0.5 rounded-sm font-mono">
                {from} {to}
                {edge.condition && <span className="text-accent-yellow ml-1">({edge.condition})</span>}
                {edge.parallel && <span className="text-accent-purple ml-1">||</span>}
                {edge.max_retries != null && <span className="text-accent-orange ml-1">{edge.max_retries}</span>}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
