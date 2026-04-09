import { useEffect, useState } from 'react';
import { Crown } from 'lucide-react';
import RoleIcon from '../common/RoleIcon';
import { teams as teamsApi } from '../../services/api';

interface Agent {
  name: string;
  displayName?: string;
  icon?: string;
  color?: string;
  type?: string;
  teamName?: string;
  teamRole?: 'lead' | 'member';
  canDelegateTo?: string[];
  canTrigger?: string[];
}

interface Team {
  name: string;
  displayName: string;
  description?: string;
  mission?: string;
  leadAgentName: string;
  parentTeamName?: string;
  isBuiltIn: boolean;
}

interface DelegationGraphProps {
  agents: Agent[];
}

/**
 * Visual org chart grouped by team. Each team renders as a bordered box
 * containing its members; cross-team delegation edges are listed below the
 * boxes (since they always go through team leads, drawing them as lines
 * between boxes would be visually noisy with many teams).
 *
 * Falls back to a flat layout if the teams API isn't available (e.g. server
 * not yet migrated).
 */
export function DelegationGraph({ agents }: DelegationGraphProps) {
  const [allTeams, setAllTeams] = useState<Team[] | null>(null);

  useEffect(() => {
    teamsApi.list()
      .then((t: Team[]) => setAllTeams(t ?? []))
      .catch(() => setAllTeams([]));
  }, [agents]);

  if (agents.length === 0) return null;

  // Group agents by teamName. Agents without a teamName fall into "Unassigned".
  const byTeam = new Map<string, Agent[]>();
  const unassigned: Agent[] = [];
  for (const a of agents) {
    if (!a.teamName) { unassigned.push(a); continue; }
    const list = byTeam.get(a.teamName) ?? [];
    list.push(a);
    byTeam.set(a.teamName, list);
  }

  // Sort each team's members: lead first, then alphabetical
  for (const list of byTeam.values()) {
    list.sort((x, y) => {
      if (x.teamRole === 'lead' && y.teamRole !== 'lead') return -1;
      if (x.teamRole !== 'lead' && y.teamRole === 'lead') return 1;
      return ((x.displayName ?? x.name) as string).localeCompare((y.displayName ?? y.name) as string);
    });
  }

  // Build a quick lookup for the team a given agent belongs to
  const agentTeam = new Map<string, string | undefined>();
  for (const a of agents) agentTeam.set(a.name, a.teamName);

  // Categorize delegation edges:
  //   intra-team:  caller and target are in the same team
  //   cross-team:  different teams (always lead-to-lead per phase 2 rules)
  //   external:    caller is in a team but target isn't, or vice versa
  interface Edge { from: Agent; to: Agent; }
  const intraTeamEdges: Edge[] = [];
  const crossTeamEdges: Edge[] = [];
  const externalEdges: Edge[] = [];
  for (const a of agents) {
    for (const targetName of a.canDelegateTo ?? []) {
      const target = agents.find(x => x.name === targetName);
      if (!target) continue;
      const aTeam = agentTeam.get(a.name);
      const tTeam = agentTeam.get(target.name);
      if (aTeam && tTeam && aTeam === tTeam) intraTeamEdges.push({ from: a, to: target });
      else if (aTeam && tTeam) crossTeamEdges.push({ from: a, to: target });
      else externalEdges.push({ from: a, to: target });
    }
  }

  // Display order for teams: parent-first via topological sort approximation,
  // but for simplicity just sort by parent depth then name. Top-level (no parent) first.
  const orderedTeams: Team[] = (() => {
    if (!allTeams) return [];
    const depth = (t: Team): number => {
      let d = 0;
      let cur: Team | undefined = t;
      const seen = new Set<string>();
      while (cur?.parentTeamName) {
        if (seen.has(cur.name)) break;
        seen.add(cur.name);
        cur = allTeams.find(p => p.name === cur!.parentTeamName);
        d++;
        if (d > 10) break;
      }
      return d;
    };
    return [...allTeams].sort((a, b) => {
      const da = depth(a);
      const db = depth(b);
      if (da !== db) return da - db;
      return a.name.localeCompare(b.name);
    });
  })();

  // Teams that have at least one member
  const teamsToRender = orderedTeams.filter(t => (byTeam.get(t.name)?.length ?? 0) > 0);

  // Orphan teams: agents reference a team that doesn't exist in the teams collection
  const knownNames = new Set(orderedTeams.map(t => t.name));
  const orphanNames = Array.from(byTeam.keys()).filter(n => !knownNames.has(n));

  return (
    <div className="rounded-lg border border-border/20 bg-surface-100/30 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-label uppercase tracking-widest text-gray-500">Org Chart</h3>
        <span className="text-[10px] font-mono text-gray-600">
          {teamsToRender.length} teams · {agents.length} agents · {intraTeamEdges.length + crossTeamEdges.length} delegations
        </span>
      </div>

      {/* Team boxes */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {teamsToRender.map(team => (
          <TeamBox key={team.name} team={team} members={byTeam.get(team.name) ?? []} />
        ))}

        {orphanNames.map(name => (
          <TeamBox
            key={name}
            team={{ name, displayName: name, description: '(team document missing)', leadAgentName: '', isBuiltIn: false }}
            members={byTeam.get(name) ?? []}
            isOrphan
          />
        ))}

        {unassigned.length > 0 && (
          <TeamBox
            team={{ name: 'unassigned', displayName: 'Unassigned', description: 'No team membership', leadAgentName: '', isBuiltIn: false }}
            members={unassigned}
            isOrphan
          />
        )}
      </div>

      {/* Cross-team delegation edges */}
      {crossTeamEdges.length > 0 && (
        <div className="pt-3 border-t border-border/15">
          <span className="text-[10px] font-label uppercase tracking-widest text-gray-600 block mb-2">
            Cross-team delegations ({crossTeamEdges.length}) — lead-to-lead only
          </span>
          <div className="space-y-1">
            {crossTeamEdges.map((e, i) => (
              <EdgeRow key={`x${i}`} edge={e} />
            ))}
          </div>
        </div>
      )}

      {/* External / dangling edges */}
      {externalEdges.length > 0 && (
        <div className="pt-3 border-t border-border/15">
          <span className="text-[10px] font-label uppercase tracking-widest text-yellow-600 block mb-2">
            ⚠ External delegations ({externalEdges.length}) — one or both agents have no team
          </span>
          <div className="space-y-1">
            {externalEdges.map((e, i) => (
              <EdgeRow key={`e${i}`} edge={e} />
            ))}
          </div>
        </div>
      )}

      {/* Loading state for teams API */}
      {allTeams === null && (
        <div className="text-[10px] text-gray-600 font-mono italic">Loading team boundaries…</div>
      )}
    </div>
  );
}

// ── Team Box ──────────────────────────────────────────────────────────────────

function TeamBox({
  team, members, isOrphan,
}: {
  team: Team;
  members: Agent[];
  isOrphan?: boolean;
}) {
  return (
    <div
      className={`rounded-md border p-3 ${
        isOrphan
          ? 'border-yellow-500/30 bg-yellow-500/5'
          : 'border-accent-blue/20 bg-surface-200/20'
      }`}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-heading font-semibold text-white tracking-wide truncate">
              {team.displayName}
            </span>
            {isOrphan && (
              <span className="text-[8px] font-mono text-yellow-500">orphan</span>
            )}
          </div>
          {team.parentTeamName && (
            <div className="text-[9px] text-gray-600 font-mono">↳ {team.parentTeamName}</div>
          )}
        </div>
        <span className="text-[9px] font-mono text-gray-600 shrink-0">{members.length}</span>
      </div>

      <div className="space-y-1">
        {members.map(agent => (
          <div key={agent.name} className="flex items-center gap-1.5 px-1.5 py-0.5 rounded">
            <div
              className="w-4 h-4 rounded flex items-center justify-center shrink-0"
              style={{ backgroundColor: (agent.color ?? '#666') + '20' }}
            >
              <RoleIcon icon={agent.icon} color={agent.color} size={10} />
            </div>
            <span
              className="text-[10px] font-mono truncate flex-1"
              style={{ color: agent.color }}
            >
              {agent.displayName ?? agent.name}
            </span>
            {agent.teamRole === 'lead' && (
              <Crown className="w-2.5 h-2.5 text-accent-yellow shrink-0" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Edge Row (used for cross-team & external delegation lists) ───────────────

function EdgeRow({ edge }: { edge: { from: Agent; to: Agent } }) {
  return (
    <div className="flex items-center gap-2 px-2 py-0.5 rounded hover:bg-surface-200/20">
      <div
        className="w-3.5 h-3.5 rounded flex items-center justify-center shrink-0"
        style={{ backgroundColor: (edge.from.color ?? '#666') + '20' }}
      >
        <RoleIcon icon={edge.from.icon} color={edge.from.color} size={9} />
      </div>
      <span className="text-[10px] font-mono" style={{ color: edge.from.color }}>
        {edge.from.displayName ?? edge.from.name}
      </span>
      <span className="text-[10px] text-gray-600">→</span>
      <div
        className="w-3.5 h-3.5 rounded flex items-center justify-center shrink-0"
        style={{ backgroundColor: (edge.to.color ?? '#666') + '20' }}
      >
        <RoleIcon icon={edge.to.icon} color={edge.to.color} size={9} />
      </div>
      <span className="text-[10px] font-mono" style={{ color: edge.to.color }}>
        {edge.to.displayName ?? edge.to.name}
      </span>
      <span className="text-[9px] text-gray-600 ml-auto font-mono">
        {edge.from.teamName ?? '?'} → {edge.to.teamName ?? '?'}
      </span>
    </div>
  );
}
