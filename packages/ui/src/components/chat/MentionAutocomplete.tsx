import { useState, useEffect, useCallback, useRef } from 'react';
import { workflows as wfApi, repos as repoApi, agents as agentsApi } from '../../services/api';
import type { LinearIssueSummary } from '../../services/api';
import { GitBranch, FolderGit2, Users, ExternalLink } from 'lucide-react';

// ── Discriminated union option types ──────────────────────────────────────
export type BaseOption = {
  id: string;
  name: string;
  description?: string;
};

export type WorkflowOption = BaseOption & { type: 'workflow' };
export type RepoOption     = BaseOption & { type: 'repo' };
export type AgentOption    = BaseOption & { type: 'agent' };
export type LinearOption   = BaseOption & {
  type: 'linear';
  linearIdentifier: string;
  linearStateName?: string;    // flattened from state.name (intentional — component doesn't need state.id/type)
  linearPriority?: number;
  linearPriorityLabel?: string;
  linearUrl?: string;
  linearDescription?: string;
  linearStateColor?: string;   // flattened from state.color
};

export type MentionOption = WorkflowOption | RepoOption | AgentOption | LinearOption;

// ── Props ─────────────────────────────────────────────────────────────────
interface MentionAutocompleteProps {
  query: string;
  visible: boolean;
  onSelect: (option: MentionOption) => void;
  onDismiss: () => void;
  /** When 'linear', shows the linear issue list instead of workflow/repo/agent. */
  mode?: 'default' | 'linear';
  /** Raw API response items provided by ChatInput in linear mode. */
  linearIssues?: LinearIssueSummary[];
  linearLoading?: boolean;
  linearError?: 'empty' | 'unconfigured' | 'error' | null;
}

// ── Icon / colour / label maps ────────────────────────────────────────────
const ICON_MAP: Record<string, typeof GitBranch> = {
  workflow: GitBranch,
  repo: FolderGit2,
  agent: Users,
  linear: ExternalLink,
};

const COLOR_MAP: Record<string, string> = {
  workflow: 'text-accent-blue',
  repo: 'text-green-400',
  agent: 'text-accent-purple',
  linear: 'text-indigo-400',
};

const LABEL_MAP: Record<string, string> = {
  workflow: 'Workflows',
  repo: 'Repos',
  agent: 'Agents',
  linear: 'Linear Tickets',
};

// ── Priority dot colour helper ────────────────────────────────────────────
export function priorityDotClass(priority: number): string {
  switch (priority) {
    case 1:  return 'bg-red-500';
    case 2:  return 'bg-orange-500';
    case 3:  return 'bg-yellow-500';
    case 4:  return 'bg-blue-400';
    default: return 'bg-gray-300 dark:bg-gray-600';   // 0 = No priority
  }
}

// ── Component ─────────────────────────────────────────────────────────────
export default function MentionAutocomplete({
  query,
  visible,
  onSelect,
  onDismiss,
  mode = 'default',
  linearIssues = [],
  linearLoading = false,
  linearError = null,
}: MentionAutocompleteProps) {
  const [options, setOptions] = useState<MentionOption[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // ── Load workflow / repo / agent resources once (skip in linear mode) ──
  useEffect(() => {
    if (mode === 'linear') return;
    if (!visible) return;
    if (loaded) return;

    (async () => {
      try {
        const [workflows, repos, agentsList] = await Promise.all([
          wfApi.list(),
          repoApi.list(),
          agentsApi.list(),
        ]);

        const all: MentionOption[] = [
          ...workflows.map((w: any) => ({          // eslint-disable-line @typescript-eslint/no-explicit-any
            type: 'workflow' as const,
            id: w._id,
            name: w.name,
            description: w.description,
          })),
          ...repos.map((r: any) => ({              // eslint-disable-line @typescript-eslint/no-explicit-any
            type: 'repo' as const,
            id: r._id,
            name: r.name,
            description: r.path,
          })),
          ...agentsList.map((a: any) => ({         // eslint-disable-line @typescript-eslint/no-explicit-any
            type: 'agent' as const,
            id: a._id ?? a.name,
            name: a.name,
            description: a.model,
          })),
        ];
        setOptions(all);
        setLoaded(true);
      } catch (e) {
        console.error('Failed to load mention options:', e);
      }
    })();
  }, [visible, loaded, mode]);

  // ── Map linear API response → LinearOption[] ─────────────────────────
  const linearOptions: LinearOption[] = linearIssues.map(issue => ({
    type: 'linear' as const,
    id: issue.id,
    // name = identifier so handleMentionSelect inserts @ENG-123 unchanged
    name: issue.identifier,
    description: issue.title,
    linearIdentifier: issue.identifier,
    linearStateName: issue.state.name,    // was: linearState
    linearPriority: issue.priority,
    linearPriorityLabel: issue.priorityLabel,
    linearUrl: issue.url,
    linearDescription: issue.description,
    linearStateColor: issue.state.color,
  }));

  // ── Filter default-mode options by query (linear mode uses API results) ─
  const q = query.toLowerCase();
  const filtered: MentionOption[] =
    mode === 'linear'
      ? linearOptions
      : q
        ? options.filter(o => o.name.toLowerCase().includes(q))
        : options;

  // ── Group by type (used in default mode only) ─────────────────────────
  const grouped: Record<string, MentionOption[]> = {};
  for (const opt of filtered) {
    if (!grouped[opt.type]) grouped[opt.type] = [];
    grouped[opt.type].push(opt);
  }

  // ── Flat list for keyboard navigation ─────────────────────────────────
  // In linear mode: only the mapped LinearOptions (terminal states NOT included)
  const flatList: MentionOption[] =
    mode === 'linear'
      ? linearOptions
      : Object.values(grouped).flat();

  // ── Decide whether to show the popup ──────────────────────────────────
  const showDropdown =
    visible &&
    (mode === 'linear'
      ? linearLoading || !!linearError || flatList.length > 0
      : flatList.length > 0);

  // ── Reset selection when query changes ────────────────────────────────
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // ── Keyboard handler ──────────────────────────────────────────────────
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!visible) return;

      // Escape always dismisses regardless of whether flatList is empty
      if (e.key === 'Escape') {
        e.preventDefault();
        onDismiss();
        return;
      }

      if (flatList.length === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(i => (i + 1) % flatList.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(i => (i - 1 + flatList.length) % flatList.length);
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        if (flatList[selectedIndex]) {
          onSelect(flatList[selectedIndex]);
        }
      }
    },
    [visible, flatList, selectedIndex, onSelect, onDismiss],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // ── Scroll selected item into view ────────────────────────────────────
  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll('[data-mention-item]');
    const item = items[selectedIndex];
    if (item) {
      item.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  if (!showDropdown) return null;

  let flatIndex = 0;

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 right-0 mb-1 bg-surface-100 border border-app rounded-sm shadow-xl max-h-64 overflow-y-auto z-50"
    >
      {mode === 'linear' ? (
        // ── Linear mode ─────────────────────────────────────────────────
        <div>
          {(!linearLoading && !linearError && linearOptions.length > 0) && (
            <div className="px-3 py-1.5 overline border-b border-app">
              Linear Tickets
            </div>
          )}

          {/* Terminal state: loading */}
          {linearLoading && (
            <div className="flex items-center gap-2 px-3 py-2 text-sm text-theme-muted select-none">
              <div className="w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin flex-shrink-0" />
              Loading Linear tickets…
            </div>
          )}

          {/* Terminal state: not configured */}
          {!linearLoading && linearError === 'unconfigured' && (
            <div className="px-3 py-2 text-sm text-theme-muted select-none">
              Linear is not configured
            </div>
          )}

          {/* Terminal state: no active tickets */}
          {!linearLoading && linearError === 'empty' && (
            <div className="px-3 py-2 text-sm text-theme-muted select-none">
              No active tickets assigned to you
            </div>
          )}

          {/* Terminal state: network/fetch error */}
          {!linearLoading && linearError === 'error' && (
            <div className="px-3 py-2 text-sm text-theme-muted select-none">
              Failed to load tickets
            </div>
          )}

          {/* Issue rows */}
          {!linearLoading && !linearError &&
            linearOptions.map(item => {
              const idx = flatIndex++;
              const isSelected = idx === selectedIndex;
              return (
                <button
                  key={item.id}
                  data-mention-item
                  type="button"
                  className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                    isSelected
                      ? 'bg-accent-blue/10 text-theme-primary'
                      : 'text-theme-secondary hover:bg-app-muted hover:text-theme-primary'
                  }`}
                  onMouseDown={e => {
                    e.preventDefault(); // prevent textarea blur
                    onSelect(item);
                  }}
                  onMouseEnter={() => setSelectedIndex(idx)}
                >
                  {/* Priority dot */}
                  <span
                    className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${priorityDotClass(item.linearPriority ?? 0)}`}
                  />
                  {/* Identifier */}
                  <span className="font-mono text-xs flex-shrink-0">{item.linearIdentifier}</span>
                  {/* Title (truncated) */}
                  <span className="truncate max-w-[300px] text-xs">{item.description}</span>
                  {/* Status badge */}
                  {item.linearStateName && (() => {
                    const safeColor = /^#[0-9A-Fa-f]{3,8}$/.test(item.linearStateColor ?? '')
                      ? item.linearStateColor
                      : undefined;
                    return (
                      <span
                        className="ml-auto flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded-full"
                        style={{
                          backgroundColor: safeColor ? `${safeColor}20` : undefined,
                          color: safeColor ?? undefined,
                        }}
                      >
                        {item.linearStateName}
                      </span>
                    );
                  })()}
                </button>
              );
            })}
        </div>
      ) : (
        // ── Default mode ─────────────────────────────────────────────────
        Object.entries(grouped).map(([type, items]) => {
          const Icon = ICON_MAP[type] || Users;
          return (
            <div key={type}>
              <div className="px-3 py-1.5 overline border-b border-app">
                {LABEL_MAP[type] || type}
              </div>
              {items.map(item => {
                const idx = flatIndex++;
                const isSelected = idx === selectedIndex;
                return (
                  <button
                    key={item.id}
                    data-mention-item
                    type="button"
                    className={`w-full flex items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors ${
                      isSelected
                        ? 'bg-accent-blue/10 text-theme-primary'
                        : 'text-theme-secondary hover:bg-app-muted hover:text-theme-primary'
                    }`}
                    onMouseDown={e => {
                      e.preventDefault(); // prevent textarea blur
                      onSelect(item);
                    }}
                    onMouseEnter={() => setSelectedIndex(idx)}
                  >
                    <Icon className={`w-3.5 h-3.5 ${COLOR_MAP[type] || 'text-theme-muted'}`} />
                    <span className="font-mono text-xs">{item.name}</span>
                    {item.description && (
                      <span className="text-[10px] text-theme-subtle truncate ml-auto">
                        {item.description}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          );
        })
      )}
    </div>
  );
}
