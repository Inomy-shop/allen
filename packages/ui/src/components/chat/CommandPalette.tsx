import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, Zap, GitBranch, Bot, BarChart3, AlertCircle, FolderOpen, Brain, Terminal } from 'lucide-react';

interface CommandItem {
  id: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  prompt: string;
  category: 'workflow' | 'query' | 'debug' | 'agent';
}

const COMMANDS: CommandItem[] = [
  // Workflows
  { id: 'list-wf', label: 'List workflows', description: 'Show all available workflows', icon: <GitBranch className="w-4 h-4" />, prompt: 'What workflows do I have?', category: 'workflow' },
  { id: 'run-wf', label: 'Run workflow', description: 'Start a workflow execution', icon: <Zap className="w-4 h-4" />, prompt: 'Run the ', category: 'workflow' },
  { id: 'recent-exec', label: 'Recent executions', description: 'Show recent workflow runs', icon: <Terminal className="w-4 h-4" />, prompt: 'Show my recent executions', category: 'workflow' },
  { id: 'failed-exec', label: 'Failed executions', description: 'Find failed runs in last 24h', icon: <AlertCircle className="w-4 h-4" />, prompt: 'Find all failed executions in the last 24 hours', category: 'workflow' },
  // Queries
  { id: 'dashboard', label: 'Dashboard stats', description: 'Aggregated platform metrics', icon: <BarChart3 className="w-4 h-4" />, prompt: 'Show me dashboard stats', category: 'query' },
  { id: 'list-repos', label: 'List repos', description: 'Registered repositories', icon: <FolderOpen className="w-4 h-4" />, prompt: 'List my registered repos', category: 'query' },
  { id: 'learnings', label: 'View learnings', description: 'System learnings and patterns', icon: <Brain className="w-4 h-4" />, prompt: 'Show me recent learnings', category: 'query' },
  // Agents
  { id: 'list-agents', label: 'List agents', description: 'Available agents', icon: <Bot className="w-4 h-4" />, prompt: 'What agents are available?', category: 'agent' },
  { id: 'spawn-reviewer', label: 'Code review', description: 'Spawn coding-reviewer', icon: <Bot className="w-4 h-4" />, prompt: 'Ask @coding-reviewer to review ', category: 'agent' },
  { id: 'spawn-planner', label: 'Plan feature', description: 'Spawn coding-planner', icon: <Bot className="w-4 h-4" />, prompt: 'Ask @coding-planner to design ', category: 'agent' },
  // Debug
  { id: 'debug-node', label: 'Debug node', description: 'Get node trace for an execution', icon: <AlertCircle className="w-4 h-4" />, prompt: 'Why did the ', category: 'debug' },
  { id: 'exec-logs', label: 'Execution logs', description: 'View logs for an execution', icon: <Terminal className="w-4 h-4" />, prompt: 'Show error logs for execution ', category: 'debug' },
];

const CATEGORY_LABELS: Record<string, string> = {
  workflow: 'Workflows',
  query: 'Queries',
  agent: 'Agents',
  debug: 'Debug',
};

const CATEGORY_ORDER = ['workflow', 'query', 'agent', 'debug'];

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onSelect: (prompt: string, partial?: boolean) => void;
}

export default function CommandPalette({ open, onClose, onSelect }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = query.trim()
    ? COMMANDS.filter(c =>
        c.label.toLowerCase().includes(query.toLowerCase()) ||
        c.description.toLowerCase().includes(query.toLowerCase()),
      )
    : COMMANDS;

  // Group by category
  const grouped = CATEGORY_ORDER
    .map(cat => ({ category: cat, items: filtered.filter(c => c.category === cat) }))
    .filter(g => g.items.length > 0);

  // Flatten for keyboard nav
  const flatItems = grouped.flatMap(g => g.items);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIdx(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    setSelectedIdx(0);
  }, [query]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx(prev => Math.min(prev + 1, flatItems.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx(prev => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' && flatItems[selectedIdx]) {
      e.preventDefault();
      const cmd = flatItems[selectedIdx];
      const isPartial = cmd.prompt.endsWith(' ');
      onSelect(cmd.prompt, isPartial);
      if (!isPartial) onClose();
    } else if (e.key === 'Escape') {
      onClose();
    }
  }, [flatItems, selectedIdx, onSelect, onClose]);

  if (!open) return null;

  let itemCounter = 0;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-lg bg-surface-100 border border-border/50 rounded-lg shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border/40">
          <Search className="w-4 h-4 text-theme-muted shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a command..."
            className="flex-1 bg-transparent text-sm text-theme-primary placeholder-gray-600 outline-none font-body"
          />
          <kbd className="text-[10px] text-theme-subtle font-mono bg-surface-200/60 px-1.5 py-0.5 rounded border border-border/30">ESC</kbd>
        </div>

        {/* Results */}
        <div className="max-h-80 overflow-y-auto py-2">
          {flatItems.length === 0 && (
            <div className="px-4 py-6 text-center text-xs text-theme-subtle">No matching commands</div>
          )}

          {grouped.map(group => (
            <div key={group.category}>
              <div className="px-4 py-1.5">
                <span className="overline">
                  {CATEGORY_LABELS[group.category]}
                </span>
              </div>
              {group.items.map(item => {
                const idx = itemCounter++;
                const isSelected = idx === selectedIdx;
                return (
                  <button
                    key={item.id}
                    className={`w-full flex items-center gap-3 px-4 py-2 text-left transition-colors ${
                      isSelected ? 'bg-accent-blue/10 text-theme-primary' : 'text-theme-secondary hover:bg-surface-200/50'
                    }`}
                    onClick={() => {
                      const isPartial = item.prompt.endsWith(' ');
                      onSelect(item.prompt, isPartial);
                      if (!isPartial) onClose();
                    }}
                    onMouseEnter={() => setSelectedIdx(idx)}
                  >
                    <span className={isSelected ? 'text-accent-blue' : 'text-theme-muted'}>{item.icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-body">{item.label}</div>
                      <div className="text-[11px] text-theme-subtle truncate">{item.description}</div>
                    </div>
                    {item.prompt.endsWith(' ') && (
                      <span className="text-[10px] text-theme-subtle font-mono bg-surface-200/40 px-1.5 py-0.5 rounded">fill in →</span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-border/30 flex items-center gap-4">
          <span className="text-[10px] text-theme-subtle flex items-center gap-1">
            <kbd className="font-mono bg-surface-200/60 px-1 py-0.5 rounded border border-border/30">↑↓</kbd> navigate
          </span>
          <span className="text-[10px] text-theme-subtle flex items-center gap-1">
            <kbd className="font-mono bg-surface-200/60 px-1 py-0.5 rounded border border-border/30">↵</kbd> select
          </span>
          <span className="text-[10px] text-theme-subtle flex items-center gap-1">
            <kbd className="font-mono bg-surface-200/60 px-1 py-0.5 rounded border border-border/30">esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
