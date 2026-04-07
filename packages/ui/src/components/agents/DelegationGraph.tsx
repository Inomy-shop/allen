import RoleIcon from '../common/RoleIcon';

interface Agent {
  name: string;
  displayName?: string;
  icon?: string;
  color?: string;
  type?: string;
  canDelegateTo?: string[];
  canTrigger?: string[];
}

interface DelegationGraphProps {
  agents: Agent[];
}

export function DelegationGraph({ agents }: DelegationGraphProps) {
  const teamAgents = agents.filter(a => a.type === 'team');
  const techAgents = agents.filter(a => a.type !== 'team');

  if (teamAgents.length === 0) return null;

  // Build delegation pairs
  const pairs: { from: Agent; to: Agent }[] = [];
  for (const agent of teamAgents) {
    for (const targetName of agent.canDelegateTo ?? []) {
      const target = agents.find(a => a.name === targetName);
      if (target) pairs.push({ from: agent, to: target });
    }
  }

  // Build trigger pairs
  const triggers: { from: Agent; workflow: string }[] = [];
  for (const agent of teamAgents) {
    for (const wf of agent.canTrigger ?? []) {
      triggers.push({ from: agent, workflow: wf });
    }
  }

  return (
    <div className="rounded-lg border border-border/20 bg-surface-100/30 p-4">
      <h3 className="text-[11px] font-label uppercase tracking-widest text-gray-500 mb-4">Delegation Map</h3>

      {/* Agent nodes */}
      <div className="flex flex-wrap gap-6 mb-4 justify-center">
        {teamAgents.map(agent => (
          <div key={agent.name} className="flex flex-col items-center gap-1.5">
            <div className="w-10 h-10 rounded-lg flex items-center justify-center"
              style={{ backgroundColor: (agent.color ?? '#666') + '20', border: `2px solid ${(agent.color ?? '#666')}40` }}>
              <RoleIcon icon={agent.icon} color={agent.color} size={20} />
            </div>
            <span className="text-[10px] font-heading font-semibold tracking-wide text-center max-w-[70px]"
              style={{ color: agent.color }}>{agent.displayName ?? agent.name}</span>
          </div>
        ))}
      </div>

      {/* Delegation connections */}
      <div className="space-y-1.5">
        {pairs.map(({ from, to }, i) => (
          <div key={i} className="flex items-center gap-2 px-3 py-1 rounded hover:bg-surface-200/20 transition-colors">
            <div className="w-4 h-4 rounded flex items-center justify-center shrink-0"
              style={{ backgroundColor: (from.color ?? '#666') + '15' }}>
              <RoleIcon icon={from.icon} color={from.color} size={10} />
            </div>
            <span className="text-[10px] font-mono" style={{ color: from.color }}>{from.displayName ?? from.name}</span>
            <span className="text-[10px] text-gray-600">→</span>
            <div className="w-4 h-4 rounded flex items-center justify-center shrink-0"
              style={{ backgroundColor: (to.color ?? '#666') + '15' }}>
              <RoleIcon icon={to.icon} color={to.color} size={10} />
            </div>
            <span className="text-[10px] font-mono" style={{ color: to.color }}>{to.displayName ?? to.name}</span>
          </div>
        ))}
      </div>

      {/* Technical agents pool */}
      {techAgents.length > 0 && (
        <div className="mt-4 pt-3 border-t border-border/15">
          <span className="text-[10px] font-label uppercase tracking-widest text-gray-600">Technical Agent Pool</span>
          <div className="flex flex-wrap gap-2 mt-2">
            {techAgents.map(agent => (
              <div key={agent.name} className="flex items-center gap-1.5 px-2 py-1 rounded bg-surface-200/20 border border-border/10">
                <div className="w-3.5 h-3.5 rounded flex items-center justify-center"
                  style={{ backgroundColor: (agent.color ?? '#666') + '15' }}>
                  <RoleIcon icon={agent.icon} color={agent.color} size={9} />
                </div>
                <span className="text-[10px] font-mono text-gray-400">{agent.displayName ?? agent.name}</span>
              </div>
            ))}
          </div>
          <p className="text-[9px] text-gray-600 mt-2 font-body">Team agents spawn technical agents via <code className="text-accent-blue/60">spawn_agent</code> for hands-on work.</p>
        </div>
      )}
    </div>
  );
}
