import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Crown, Search, X } from 'lucide-react';
import RoleIcon from '../common/RoleIcon';

/**
 * Reusable searchable agent picker grouped by team, with team leads
 * highlighted at the top of each group. Use anywhere an agent needs
 * to be chosen (ticket assignment, interventions, workflow builder).
 */

export interface AgentOption {
  name: string;
  displayName?: string;
  icon?: string;
  color?: string;
  teamName?: string;
  teamRole?: 'lead' | 'member';
}

export interface TeamOption {
  name: string;
  displayName: string;
}

interface Props {
  value: string | null;
  onChange: (agentName: string | null) => void;
  agents: AgentOption[];
  teams: TeamOption[];
  placeholder?: string;
  /** Show a "No assignee" entry at the top that clears the value. */
  allowClear?: boolean;
  /** Narrow trigger for inline pill use, or full width for form-field use. */
  size?: 'pill' | 'input';
  disabled?: boolean;
  className?: string;
}

export default function AgentAssignDropdown({
  value, onChange, agents, teams,
  placeholder = 'Assign to agent…',
  allowClear = true,
  size = 'input',
  disabled = false,
  className = '',
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [pos, setPos] = useState<{ top: number; left: number; width: number; dropUp: boolean }>({ top: 0, left: 0, width: 0, dropUp: false });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (triggerRef.current?.contains(e.target as Node)) return;
      if (dropdownRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close on escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  // Close on outside scroll
  useEffect(() => {
    if (!open) return;
    const handler = (e: Event) => {
      if (dropdownRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener('scroll', handler, true);
    return () => window.removeEventListener('scroll', handler, true);
  }, [open]);

  // Autofocus search when opened
  useEffect(() => {
    if (open) setTimeout(() => searchRef.current?.focus(), 20);
    else setQuery('');
  }, [open]);

  const selected = agents.find(a => a.name === value) ?? null;
  const selectedTeam = selected?.teamName
    ? (teams.find(t => t.name === selected.teamName)?.displayName ?? selected.teamName)
    : selected && !selected.teamName ? 'unassigned' : null;

  // Build groups — one per team, plus "Unassigned agents" for team-less
  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = (a: AgentOption, teamDisplay?: string) => {
      if (!q) return true;
      return (
        a.name.toLowerCase().includes(q)
        || (a.displayName ?? '').toLowerCase().includes(q)
        || (a.teamName ?? '').toLowerCase().includes(q)
        || (teamDisplay ?? '').toLowerCase().includes(q)
      );
    };

    type Group = { key: string; title: string; lead: AgentOption | null; members: AgentOption[] };
    const groups: Group[] = [];
    for (const team of teams) {
      const inTeam = agents.filter(a => a.teamName === team.name && matches(a, team.displayName));
      if (inTeam.length === 0 && q) continue; // hide empty groups while searching
      const lead = inTeam.find(a => a.teamRole === 'lead') ?? null;
      const members = inTeam.filter(a => a !== lead).sort((a, b) =>
        ((a.displayName ?? a.name)).localeCompare(b.displayName ?? b.name),
      );
      groups.push({ key: team.name, title: team.displayName, lead, members });
    }
    // Unassigned agents (no teamName)
    const unassigned = agents
      .filter(a => !a.teamName && matches(a, 'unassigned'))
      .sort((a, b) => ((a.displayName ?? a.name)).localeCompare(b.displayName ?? b.name));
    if (unassigned.length > 0 || !q) {
      groups.push({ key: '__unassigned__', title: 'Unassigned agents', lead: null, members: unassigned });
    }
    return groups;
  }, [agents, teams, query]);

  const totalVisible = grouped.reduce((acc, g) => acc + (g.lead ? 1 : 0) + g.members.length, 0);

  const handleOpen = () => {
    if (disabled) return;
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const dropUp = spaceBelow < 340;
      setPos({
        top: dropUp ? rect.top : rect.bottom + 4,
        left: rect.left,
        width: rect.width,
        dropUp,
      });
    }
    setOpen(v => !v);
  };

  const pick = (agentName: string | null) => {
    onChange(agentName);
    setOpen(false);
  };

  return (
    <div className={`relative ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={handleOpen}
        className={
          size === 'pill'
            ? `inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-mono transition-colors border ${
                selected
                  ? 'bg-accent-blue/10 text-accent-blue border-accent-blue/30 hover:bg-accent-blue/20'
                  : 'bg-surface-200/30 text-theme-muted border-border/40 hover:bg-surface-200/50'
              } disabled:opacity-50 disabled:cursor-not-allowed`
            : `input w-full text-left flex items-center justify-between gap-2 cursor-pointer ${open ? 'border-accent-blue shadow-glow-blue' : ''} disabled:opacity-50 disabled:cursor-not-allowed`
        }
      >
        {selected ? (
          <span className="flex items-center gap-1.5 min-w-0">
            {selected.teamRole === 'lead' && <Crown className="w-3 h-3 text-accent-yellow shrink-0" />}
            {size === 'input' && selected.icon && (
              <span
                className="w-5 h-5 rounded flex items-center justify-center shrink-0"
                style={{ backgroundColor: (selected.color ?? '#666') + '18' }}
              >
                <RoleIcon icon={selected.icon} color={selected.color} size={11} />
              </span>
            )}
            <span className="truncate">
              {selected.displayName ?? selected.name}
            </span>
            {size === 'input' && selectedTeam && (
              <span className="text-theme-subtle text-[10px] font-mono">· {selectedTeam}</span>
            )}
          </span>
        ) : (
          <span className="text-theme-muted truncate">{placeholder}</span>
        )}
        <ChevronDown className={`w-3.5 h-3.5 shrink-0 transition-transform ${open ? 'rotate-180 text-accent-blue' : 'text-theme-muted'}`} />
      </button>

      {open && createPortal(
        <div
          ref={dropdownRef}
          className="fixed z-[9999] bg-surface-100 border border-border rounded-lg shadow-lg overflow-hidden flex flex-col"
          style={{
            top: pos.dropUp ? undefined : pos.top,
            bottom: pos.dropUp ? window.innerHeight - pos.top + 4 : undefined,
            left: pos.left,
            width: Math.max(pos.width, 280),
            maxHeight: 380,
          }}
        >
          {/* Search */}
          <div className="p-2 border-b border-border/60 shrink-0">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-theme-subtle pointer-events-none" />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search agents or teams…"
                className="w-full text-xs pl-8 pr-7 py-1.5 rounded-md bg-surface-200/40 border border-border/50 text-theme-primary placeholder:text-theme-subtle focus:outline-none focus:border-accent-blue/50"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-theme-muted hover:text-theme-primary"
                  title="Clear search"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>

          {/* Results */}
          <div className="overflow-y-auto min-h-0 py-1">
            {allowClear && (
              <>
                <div className="px-3 pt-2 pb-1 overline">
                  No assignee
                </div>
                <button
                  type="button"
                  onClick={() => pick(null)}
                  className={`w-full text-left px-3 py-2 text-xs flex items-center gap-2 transition-colors ${
                    value === null ? 'bg-accent-blue/10 text-accent-blue' : 'text-theme-muted hover:bg-surface-200/40'
                  }`}
                >
                  <X className="w-3 h-3 shrink-0" /> Clear assignment
                </button>
              </>
            )}

            {totalVisible === 0 && query && (
              <div className="px-3 py-6 text-center text-[11px] text-theme-muted italic font-body">
                No agents match "{query}"
              </div>
            )}

            {grouped.map(group => {
              if (!group.lead && group.members.length === 0) {
                // Only show empty group if it's a real team (not the __unassigned__ bucket)
                if (group.key === '__unassigned__') return null;
                return (
                  <div key={group.key}>
                    <div className="px-3 pt-3 pb-1 overline">
                      {group.title}
                    </div>
                    <div className="px-3 py-1.5 text-[10px] text-accent-yellow/80 italic font-body">
                      No lead assigned
                    </div>
                  </div>
                );
              }
              return (
                <div key={group.key}>
                  <div className="px-3 pt-3 pb-1 overline">
                    {group.title}
                  </div>
                  {group.lead && (
                    <button
                      type="button"
                      onClick={() => pick(group.lead!.name)}
                      className={`w-full text-left px-3 py-2 text-xs flex items-center gap-2 transition-colors border-l-2 ${
                        value === group.lead.name
                          ? 'bg-accent-yellow/15 text-theme-primary border-accent-yellow'
                          : 'bg-accent-yellow/[0.06] hover:bg-accent-yellow/15 border-accent-yellow/40'
                      }`}
                    >
                      <div
                        className="w-5 h-5 rounded flex items-center justify-center shrink-0"
                        style={{ backgroundColor: (group.lead.color ?? '#666') + '18' }}
                      >
                        <RoleIcon icon={group.lead.icon} color={group.lead.color} size={11} />
                      </div>
                      <Crown className="w-3 h-3 text-accent-yellow shrink-0" />
                      <span className="flex-1 truncate">{group.lead.displayName ?? group.lead.name}</span>
                      <span className="text-[9px] font-mono text-theme-subtle">lead</span>
                    </button>
                  )}
                  {group.members.map(agent => (
                    <button
                      key={agent.name}
                      type="button"
                      onClick={() => pick(agent.name)}
                      className={`w-full text-left pl-6 pr-3 py-1.5 text-xs flex items-center gap-2 transition-colors ${
                        value === agent.name ? 'bg-accent-blue/10 text-accent-blue' : 'text-theme-secondary hover:bg-surface-200/40'
                      }`}
                    >
                      <div
                        className="w-5 h-5 rounded flex items-center justify-center shrink-0"
                        style={{ backgroundColor: (agent.color ?? '#666') + '18' }}
                      >
                        <RoleIcon icon={agent.icon} color={agent.color} size={11} />
                      </div>
                      <span className="flex-1 truncate">{agent.displayName ?? agent.name}</span>
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
