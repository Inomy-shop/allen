import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bot, Check, ChevronDown, Crown, Search, User } from 'lucide-react';
import { V8ChevronDownIcon, V8ComposerUserIcon } from '../common/V8SidebarIcons';

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
  variant?: 'default' | 'composer';
  controlPresentation?: 'default' | 'v8-home';
  showAssistant?: boolean;
}

const panelClass = 'fixed z-[9999] flex min-w-[240px] max-w-[280px] flex-col overflow-hidden rounded-md border border-app bg-app-card p-2 shadow-2xl';
const sectionLabelClass = 'px-2 pb-1.5 pt-0.5 text-[12px] font-medium text-theme-muted';
const rowClass = 'flex min-h-9 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-app-muted';

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export default function AgentChatDropdown({
  value,
  onChange,
  agents,
  disabled = false,
  loading = false,
  variant = 'default',
  controlPresentation = 'default',
  showAssistant = true,
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
    : showAssistant
      ? 'Assistant'
      : 'Select agent';
  const isComposer = variant === 'composer';
  const isV8Home = controlPresentation === 'v8-home';

  const handleOpen = () => {
    if (disabled) return;
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const margin = 12;
      const panelWidth = 280;
      const spaceBelow = window.innerHeight - rect.bottom;
      const dropUp = spaceBelow < 340 && rect.top > spaceBelow;
      setPos({
        top: dropUp ? rect.top : rect.bottom + 4,
        left: clamp(rect.left, margin, window.innerWidth - panelWidth - margin),
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
  const showAssistantOption = showAssistant && (!query || 'assistant'.includes(query.toLowerCase()));

  return (
    <div className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={handleOpen}
        className={isComposer
          ? `flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-mono transition-all ${
              value
                ? 'text-accent-blue hover:bg-accent-blue/10'
                : 'text-theme-muted hover:text-theme-secondary hover:bg-surface-100/50'
            } ${disabled ? 'opacity-50 cursor-not-allowed pointer-events-none' : ''}`
          : `flex items-center gap-1.5 px-2.5 py-1 rounded-md text-sm border border-app bg-app-card text-theme-primary hover:bg-app-hover transition-colors ${
              disabled ? 'opacity-50 cursor-not-allowed pointer-events-none' : ''
            }`
        }
      >
        {value === null ? (
          isV8Home
            ? <V8ComposerUserIcon className="h-3.5 w-3.5 shrink-0 text-theme-secondary" />
            : <User className={`${isComposer ? 'w-3 h-3' : 'w-3.5 h-3.5'} text-theme-muted shrink-0`} />
        ) : (
          <Bot className={`${isComposer ? 'w-3 h-3' : 'w-3.5 h-3.5'} text-theme-muted shrink-0`} />
        )}
        <span className="truncate max-w-[140px]">{displayLabel}</span>
        {isV8Home ? (
          <V8ChevronDownIcon className={`h-2.5 w-2.5 shrink-0 text-theme-subtle transition-transform ${open ? 'rotate-180' : ''}`} />
        ) : (
          <ChevronDown
            className={`${isComposer ? 'w-2.5 h-2.5' : 'w-3.5 h-3.5'} shrink-0 transition-transform text-theme-subtle ${open ? 'rotate-180' : ''}`}
          />
        )}
      </button>

      {open &&
        createPortal(
          <div
            ref={dropdownRef}
            className={panelClass}
            style={{
              top: pos.dropUp ? undefined : pos.top,
              bottom: pos.dropUp ? window.innerHeight - pos.top + 4 : undefined,
              left: pos.left,
              maxHeight: 380,
            }}
          >
            {/* Search */}
            <div className="shrink-0 pb-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-theme-muted" />
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Search agents…"
                  className="h-8 w-full rounded-md border border-app bg-app px-8 pr-3 text-[12px] text-theme-primary placeholder:text-theme-muted focus:outline-none focus:ring-2 focus:ring-accent/15"
                />
              </div>
            </div>

            {/* Results */}
            <div className="min-h-0 overflow-y-auto" style={{ maxHeight: 304 }}>
              {loading ? (
                /* Loading skeleton */
                <div className="space-y-2 px-3 py-2">
                  {[1, 2, 3].map(i => (
                    <div key={i} className="flex items-center gap-2">
                      <div className="h-5 w-5 shrink-0 animate-pulse rounded bg-app-muted" />
                      <div className="h-3 flex-1 animate-pulse rounded bg-app-muted" />
                    </div>
                  ))}
                </div>
              ) : (
                <>
                  {/* Assistant option (always at top) */}
                  {showAssistantOption && (
                    <div>
                      <div className={sectionLabelClass}>Default</div>
                      <button
                        type="button"
                        onClick={() => pick(null, null)}
                        className={`${rowClass} ${value === null ? 'bg-app-muted text-theme-primary' : 'text-theme-secondary'}`}
                      >
                        <User className="h-3.5 w-3.5 shrink-0 text-theme-muted" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">Assistant</span>
                          <span className="block truncate text-[11px] text-theme-muted">General chat routing</span>
                        </span>
                        {value === null && (
                          <Check className="h-3.5 w-3.5 shrink-0 text-theme-secondary" />
                        )}
                      </button>
                    </div>
                  )}

                  {/* Agent groups */}
                  {grouped.map((group, groupIndex) => (
                    <div key={group.key} className={(showAssistantOption || groupIndex > 0) ? 'mt-2 border-t border-app pt-2' : ''}>
                      <div className={sectionLabelClass}>
                        {group.key === '__ungrouped__' ? 'Agents' : group.title}
                      </div>
                      {group.agents.map(agent => (
                        <button
                          key={agent.name}
                          type="button"
                          onClick={() => pick(agent.name, agent.sourceRepoPath ?? null)}
                          className={`${rowClass} ${
                            value === agent.name ? 'bg-app-muted text-theme-primary' : 'text-theme-secondary'
                          }`}
                        >
                          {agent.isBuiltIn ? (
                            <Crown className="h-3.5 w-3.5 shrink-0 text-accent" />
                          ) : (
                            <Bot className="h-3.5 w-3.5 shrink-0 text-theme-muted" />
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate">{agent.displayName ?? agent.name}</span>
                            {agent.teamName && (
                              <span className="block truncate text-[11px] text-theme-muted">{agent.teamName}</span>
                            )}
                          </span>
                          {value === agent.name && (
                            <Check className="h-3.5 w-3.5 shrink-0 text-theme-secondary" />
                          )}
                        </button>
                      ))}
                    </div>
                  ))}

                  {/* Empty state */}
                  {!showAssistantOption && totalVisible === 0 && (
                    <div className="px-3 py-6 text-center text-[13px] text-theme-muted">
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
