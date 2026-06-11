import { useState } from 'react';
import { ChevronDown, Database } from 'lucide-react';

interface DesignContextControlsProps {
  /** Currently selected design repo (for display) */
  designRepoName?: string | null;
  /** All available design repos */
  designRepos?: any[];
  selectedDesignRepoId?: string | null;
  onDesignRepoChange?: (id: string) => void;
  disabled?: boolean;
}

/**
 * Compact design-specific controls intended for ChatInput's extraControls slot.
 * Renders a single chip: design-repo selector.
 * Routing mode is determined automatically by the Design Router — no UI selector.
 */
export default function DesignContextControls({
  designRepoName,
  designRepos = [],
  selectedDesignRepoId,
  onDesignRepoChange,
  disabled,
}: DesignContextControlsProps) {
  const [showRepoPicker, setShowRepoPicker] = useState(false);

  const repoLabel = designRepoName ?? 'Design repo';

  function handleRepoSelect(id: string) {
    onDesignRepoChange?.(id);
    setShowRepoPicker(false);
  }

  return (
    <div className="flex items-center gap-1">
      {/* Design repo chip */}
      {designRepos.length > 0 && (
        <div className="relative">
          <button
            type="button"
            disabled={disabled}
            onClick={() => { setShowRepoPicker((v) => !v); }}
            className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-mono text-theme-muted transition-all hover:text-theme-secondary hover:bg-surface-100/50 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
            title="Design repository"
            aria-label={`Design repository: ${repoLabel}`}
          >
            <Database className="h-3 w-3 shrink-0" />
            <span className="max-w-[80px] truncate">{repoLabel}</span>
            <ChevronDown className="w-2.5 h-2.5 text-theme-subtle" />
          </button>

          {showRepoPicker && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setShowRepoPicker(false)} />
              <div className="absolute bottom-full left-0 z-20 mb-1 min-w-[160px] overflow-hidden rounded-md border border-app bg-app-card shadow-popover">
                <div className="px-3 py-1.5 text-[11px] font-medium text-theme-muted border-b border-app">
                  Design repo
                </div>
                {designRepos.map((repo) => (
                  <button
                    key={repo._id}
                    type="button"
                    onClick={() => handleRepoSelect(repo._id)}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] transition-colors hover:bg-app-muted ${
                      repo._id === selectedDesignRepoId
                        ? 'text-accent font-medium'
                        : 'text-theme-secondary hover:text-theme-primary'
                    }`}
                  >
                    {repo.name ?? repo._id}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
