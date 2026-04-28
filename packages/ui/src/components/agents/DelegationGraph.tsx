import { useEffect, useState } from 'react';
import { Crown, ChevronDown, ChevronRight } from 'lucide-react';
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
  model?: string;
  provider?: string;
  capabilities?: string[];
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

interface Props {
  agents: Agent[];
}

/**
 * Organisation chart that mirrors a real company hierarchy.
 *
 * Structure:
 *   Executive (top)
 *     ├─ Product
 *     ├─ Engineering
 *     │    ├─ Quality
 *     │    ├─ Operations
 *     │    └─ Coding Specialists
 *     ├─ Data
 *     └─ Meta
 *
 * Each team shows a lead at the top (the "head") and specialists below.
 * Child teams are nested with indentation and tree lines.
 */
export function DelegationGraph({ agents }: Props) {
  const [allTeams, setAllTeams] = useState<Team[] | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    teamsApi.list().then((t: Team[]) => setAllTeams(t ?? [])).catch(() => setAllTeams([]));
  }, [agents]);

  if (!allTeams || agents.length === 0) return null;

  // Lookups
  const byTeam = new Map<string, Agent[]>();
  for (const a of agents) {
    if (!a.teamName) continue;
    (byTeam.get(a.teamName) ?? (byTeam.set(a.teamName, []), byTeam.get(a.teamName)!)).push(a);
  }
  const teamMap = new Map(allTeams.map(t => [t.name, t]));

  // Build tree: find root teams (no parent or parent not in list)
  const childrenOf = (parent: string) =>
    allTeams.filter(t => t.parentTeamName === parent && (byTeam.get(t.name)?.length ?? 0) > 0);
  const roots = allTeams.filter(t =>
    (!t.parentTeamName || !teamMap.has(t.parentTeamName)) && (byTeam.get(t.name)?.length ?? 0) > 0
  );

  const toggle = (name: string) => setCollapsed(prev => {
    const next = new Set(prev);
    next.has(name) ? next.delete(name) : next.add(name);
    return next;
  });

  return (
    <div className="rounded-lg border border-app bg-app-muted/40 overflow-hidden">
      {/* Title bar */}
      <div className="px-4 py-2.5 border-b border-border/10 bg-surface-200/15 flex items-center justify-between">
        <span className="overline">Organisation</span>
        <span className="text-[10px] font-mono text-theme-subtle">{allTeams.filter(t => (byTeam.get(t.name)?.length ?? 0) > 0).length} departments · {agents.length} people</span>
      </div>

      <div className="p-4">
        {roots.map((team, i) => (
          <OrgNode
            key={team.name}
            team={team}
            members={byTeam.get(team.name) ?? []}
            childrenOf={childrenOf}
            byTeam={byTeam}
            collapsed={collapsed}
            onToggle={toggle}
            depth={0}
            isLast={i === roots.length - 1}
          />
        ))}
      </div>
    </div>
  );
}

// ── Org Node (recursive) ─────────────────────────────────────────────────────

function OrgNode({
  team, members, childrenOf, byTeam, collapsed, onToggle, depth, isLast,
}: {
  team: Team;
  members: Agent[];
  childrenOf: (parent: string) => Team[];
  byTeam: Map<string, Agent[]>;
  collapsed: Set<string>;
  onToggle: (name: string) => void;
  depth: number;
  isLast: boolean;
}) {
  const isCollapsed = collapsed.has(team.name);
  const children = childrenOf(team.name);
  const lead = members.find(m => m.teamRole === 'lead');
  const specialists = members.filter(m => m.teamRole !== 'lead');
  const hasContent = specialists.length > 0 || children.length > 0;

  return (
    <div className={depth > 0 ? 'ml-6' : ''}>
      {/* Tree connector for nested teams */}
      {depth > 0 && (
        <div className="flex items-center gap-0 -ml-6 mb-0">
          <div className={`w-6 border-l-2 border-b-2 border-app h-4 rounded-bl-md ${isLast ? '' : ''}`} />
        </div>
      )}

      {/* Team card */}
      <div className={`rounded-lg border border-app bg-app-muted/50 overflow-hidden mb-3 ${depth === 0 ? '' : ''}`}>
        {/* Team header — clickable to collapse */}
        <button
          onClick={() => hasContent && onToggle(team.name)}
          className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-surface-200/15 transition-colors"
        >
          {/* Expand/collapse indicator */}
          {hasContent ? (
            <span className="shrink-0 text-theme-subtle">
              {isCollapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </span>
          ) : (
            <span className="w-3.5 shrink-0" />
          )}

          {/* Team name */}
          <div className="flex-1 min-w-0">
            <span className="text-[12px] font-heading font-semibold text-theme-primary tracking-wide">{team.displayName}</span>
            {team.description && (
              <span className="text-[10px] text-theme-subtle ml-2 hidden md:inline">{team.description}</span>
            )}
          </div>

          {/* Lead badge */}
          {lead && (
            <div className="flex items-center gap-1.5 shrink-0 px-2 py-1 rounded-md bg-accent-yellow/5 border border-accent-yellow/15">
              <div className="w-5 h-5 rounded flex items-center justify-center" style={{ backgroundColor: (lead.color ?? '#666') + '20' }}>
                <RoleIcon icon={lead.icon} color={lead.color} size={11} />
              </div>
              <span className="text-[10px] font-body text-theme-primary font-medium">{lead.displayName ?? lead.name}</span>
              <Crown className="w-3 h-3 text-accent-yellow" />
            </div>
          )}

          <span className="text-[9px] font-mono text-theme-subtle shrink-0">{members.length}</span>
        </button>

        {/* Specialists — the ground-level workers */}
        {!isCollapsed && specialists.length > 0 && (
          <div className="border-t border-border/10 px-3.5 py-2 bg-surface-200/8">
            <div className="flex flex-wrap gap-1.5">
              {specialists.map(agent => (
                <div
                  key={agent.name}
                  className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-app bg-surface-100/50 hover:bg-surface-100/80 transition-colors"
                >
                  <div className="w-4.5 h-4.5 rounded flex items-center justify-center shrink-0"
                    style={{ backgroundColor: (agent.color ?? '#666') + '18' }}>
                    <RoleIcon icon={agent.icon} color={agent.color} size={10} />
                  </div>
                  <span className="text-[10px] font-body text-theme-secondary">{agent.displayName ?? agent.name}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Child teams — nested recursively with tree lines */}
      {!isCollapsed && children.length > 0 && (
        <div className={`${depth > 0 ? 'border-l-2 border-app ml-1' : 'ml-1'}`}>
          {children.map((child, i) => (
            <OrgNode
              key={child.name}
              team={child}
              members={byTeam.get(child.name) ?? []}
              childrenOf={childrenOf}
              byTeam={byTeam}
              collapsed={collapsed}
              onToggle={onToggle}
              depth={depth + 1}
              isLast={i === children.length - 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}
