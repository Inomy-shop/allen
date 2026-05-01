import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bot, Check, ChevronDown, Crown, Search, User } from 'lucide-react';

export interface AgentChatOption {
  name: string;
  displayName?: string;
  icon?: string;
  color?: string;
  teamName?: string;
  isBuiltIn?: boolean;
  sourceRepoPath?: string;
}

interface AgentChatDropdownProps {
  value: string | null;
  onChange: (name: string | null, sourceRepoPath: string | null) => void;
  agents: AgentChatOption[];
  disabled?: boolean;
  loading?: boolean;
}

export default function AgentChatDropdown({
  value,
  onChange,
  agents,
  disabled = false,
  loading = false,
}: AgentChatDropdownProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [pos, setPos] = useState<{ top: number; left: number; dropUp: boolean }>({
    top: 0,
    left: 0,
    dropUp: false,
  });

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

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
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
    if (open) {
      setTimeout(() => searchRef.current?.focus(), 20);
    } else {
      setQuery('');
    }
  }, [open]);

  const selectedAgent = agents.find(a => a.name === value) ?? null;
  const displayLabel = selectedAgent
    ? (selectedAgent.displayName ?? selectedAgent.name)
    : 'Assistant';

  const handleOpen = () => {
    if (disabled) return;
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const dropUp = spaceBelow < 340;
      setPos({
        top: dropUp ? rect.top : rect.bottom + 4,
        left: rect.left,
        dropUp,
      });
    }
    setOpen(v => !v);
  };

  const pick = (name: string | null, sourceRepoPath: string | null) => {
    onChange(name, sourceRepoPath);
    setOpen(false);
  };

  // Group agents by teamName
  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = agents.filter(a => {
      if (!q) return true;
      return (
        a.name.toLowerCase().includes(q) ||
        (a.displayName ?? '').toLowerCase().includes(q) ||
        (a.teamName ?? '').toLowerCase().includes(q)
      );
    });

    const teamMap = new Map<string, AgentChatOption[]>();
    const ungrouped: AgentChatOption[] = [];

    for (const agent of filtered) {
      if (agent.teamName) {
        const existing = teamMap.get(agent.teamName) ?? [];
        existing.push(agent);
        teamMap.set(agent.teamName, existing);
      } else {
        ungrouped.push(agent);
      }
    }

    const groups: Array<{ key: string; title: string; agents: AgentChatOption[] }> = [];
    for (const [teamName, teamAgents] of teamMap) {
      groups.push({ key: teamName, title: teamName, agents: teamAgents });
    }
    if (ungrouped.length > 0) {
      groups.push({ key: '__ungrouped__', title: 'Other Agents', agents: ungrouped });
    }

    return groups;
  }, [agents, query]);

  const totalVisible = grouped.reduce((acc, g) => acc + g.agents.length, 0);
  const showAssistant = !query || 'assistant'.includes(query.toLowerCase());

  return (
    <div className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={handleOpen}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-sm border border-app bg-app-card text-theme-primary hover:bg-app-hover transition-colors ${
          disabled ? 'opacity-50 cursor-not-allowed pointer-events-none' : ''
        }`}
      >
        {value === null ? (
          <User className="w-3.5 h-3.5 text-theme-muted shrink-0" />
        ) : (
          <Bot className="w-3.5 h-3.5 text-theme-muted shrink-0" />
        )}
        <span className="truncate max-w-[140px]">{displayLabel}</span>
        <ChevronDown
          className={`w-3.5 h-3.5 shrink-0 transition-transform text-theme-muted ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open &&
        createPortal(
          <div
            ref={dropdownRef}
            className="fixed z-[9999] bg-app-card border border-app rounded-lg shadow-lg min-w-[220px] max-w-[300px] flex flex-col overflow-hidden"
            style={{
              top: pos.dropUp ? undefined : pos.top,
              bottom: pos.dropUp ? window.innerHeight - pos.top + 4 : undefined,
              left: pos.left,
              maxHeight: 340,
            }}
          >
            {/* Search */}
            <div className="p-2 border-b border-app shrink-0">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-theme-muted pointer-events-none" />
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Search agents…"
                  className="w-full pl-7 pr-2 py-1.5 text-sm bg-app-muted rounded-md border border-app text-theme-primary placeholder:text-theme-muted focus:outline-none"
                />
              </div>
            </div>

            {/* Results */}
            <div className="overflow-y-auto min-h-0 py-1" style={{ maxHeight: 224 }}>
              {loading ? (
                /* Loading skeleton */
                <div className="px-3 py-2 space-y-2">
                  {[1, 2, 3].map(i => (
                    <div key={i} className="flex items-center gap-2">
                      <div className="w-5 h-5 rounded bg-app-muted animate-pulse shrink-0" />
                      <div className="h-3 rounded bg-app-muted animate-pulse flex-1" />
                    </div>
                  ))}
                </div>
              ) : (
                <>
                  {/* Assistant option (always at top) */}
                  {showAssistant && (
                    <button
                      type="button"
                      onClick={() => pick(null, null)}
                      className="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-app-hover text-theme-primary w-full text-left"
                    >
                      <User className="w-3.5 h-3.5 text-theme-muted shrink-0" />
                      <span className="flex-1">Assistant</span>
                      {value === null && (
                        <Check className="w-3.5 h-3.5 text-accent-amber shrink-0" />
                      )}
                    </button>
                  )}

                  {/* Agent groups */}
                  {grouped.map(group => (
                    <div key={group.key}>
                      {(grouped.length > 1 || group.key !== '__ungrouped__') && (
                        <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-theme-muted">
                          {group.title}
                        </div>
                      )}
                      {group.agents.map(agent => (
                        <button
                          key={agent.name}
                          type="button"
                          onClick={() => pick(agent.name, agent.sourceRepoPath ?? null)}
                          className="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-app-hover text-theme-primary w-full text-left"
                        >
                          {agent.isBuiltIn ? (
                            <Crown className="w-3.5 h-3.5 text-accent-amber shrink-0" />
                          ) : (
                            <Bot className="w-3.5 h-3.5 text-theme-muted shrink-0" />
                          )}
                          <span className="flex-1 truncate">
                            {agent.displayName ?? agent.name}
                          </span>
                          {value === agent.name && (
                            <Check className="w-3.5 h-3.5 text-accent-amber shrink-0" />
                          )}
                        </button>
                      ))}
                    </div>
                  ))}

                  {/* Empty state */}
                  {!showAssistant && totalVisible === 0 && (
                    <div className="px-3 py-6 text-center text-xs text-theme-muted italic">
                      No agents found
                    </div>
                  )}
                </>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
