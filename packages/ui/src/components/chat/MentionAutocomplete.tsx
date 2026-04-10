import { useState, useEffect, useCallback, useRef } from 'react';
import { workflows as wfApi, repos as repoApi, agents as agentsApi } from '../../services/api';
import { GitBranch, FolderGit2, Users } from 'lucide-react';

export interface MentionOption {
  type: 'workflow' | 'repo' | 'agent';
  id: string;
  name: string;
  description?: string;
}

interface MentionAutocompleteProps {
  query: string;
  visible: boolean;
  onSelect: (option: MentionOption) => void;
  onDismiss: () => void;
}

const ICON_MAP: Record<string, typeof GitBranch> = {
  workflow: GitBranch,
  repo: FolderGit2,
  agent: Users,
};

const COLOR_MAP: Record<string, string> = {
  workflow: 'text-accent-blue',
  repo: 'text-green-400',
  agent: 'text-purple-400',
};

const LABEL_MAP: Record<string, string> = {
  workflow: 'Workflows',
  repo: 'Repos',
  agent: 'Agents',
};

export default function MentionAutocomplete({
  query,
  visible,
  onSelect,
  onDismiss,
}: MentionAutocompleteProps) {
  const [options, setOptions] = useState<MentionOption[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // Load all mentionable resources once
  useEffect(() => {
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
          ...workflows.map((w: any) => ({
            type: 'workflow' as const,
            id: w._id,
            name: w.name,
            description: w.description,
          })),
          ...repos.map((r: any) => ({
            type: 'repo' as const,
            id: r._id,
            name: r.name,
            description: r.path,
          })),
          ...agentsList.map((a: any) => ({
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
  }, [visible, loaded]);

  // Filter options by query
  const q = query.toLowerCase();
  const filtered = q
    ? options.filter(o => o.name.toLowerCase().includes(q))
    : options;

  // Group by type
  const grouped: Record<string, MentionOption[]> = {};
  for (const opt of filtered) {
    if (!grouped[opt.type]) grouped[opt.type] = [];
    grouped[opt.type].push(opt);
  }

  // Flat list for keyboard navigation
  const flatList = Object.values(grouped).flat();

  // Reset selection when query changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Keyboard handler
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!visible || flatList.length === 0) return;

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
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onDismiss();
      }
    },
    [visible, flatList, selectedIndex, onSelect, onDismiss],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll('[data-mention-item]');
    const item = items[selectedIndex];
    if (item) {
      item.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  if (!visible || flatList.length === 0) return null;

  let flatIndex = 0;

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 right-0 mb-1 bg-surface-100 border border-border/50 rounded-sm shadow-xl max-h-64 overflow-y-auto z-50"
    >
      {Object.entries(grouped).map(([type, items]) => {
        const Icon = ICON_MAP[type] || Users;
        return (
          <div key={type}>
            <div className="px-3 py-1.5 text-[10px] font-label uppercase tracking-widest text-theme-muted border-b border-border/30">
              {LABEL_MAP[type] || type}
            </div>
            {items.map(item => {
              const idx = flatIndex++;
              const isSelected = idx === selectedIndex;
              return (
                <button
                  key={item.id}
                  data-mention-item
                  className={`w-full flex items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors ${
                    isSelected
                      ? 'bg-accent-blue/10 text-theme-primary'
                      : 'text-theme-secondary hover:bg-surface-200/50 hover:text-theme-primary'
                  }`}
                  onMouseDown={e => {
                    e.preventDefault(); // Prevent blur
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
      })}
    </div>
  );
}
