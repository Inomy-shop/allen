interface DesignRepoSelectorProps {
  designRepos: any[];
  selectedDesignRepoId: string | null;
  onDesignRepoChange: (id: string) => void;
  sourceRepos?: any[];
  selectedSourceRepoId?: string | null;
  onSourceRepoChange?: (id: string | null) => void;
}

export default function DesignRepoSelector({
  designRepos,
  selectedDesignRepoId,
  onDesignRepoChange,
  sourceRepos,
  selectedSourceRepoId,
  onSourceRepoChange,
}: DesignRepoSelectorProps) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      <div className="flex items-center gap-2">
        <label className="text-[11.5px] font-medium text-theme-muted whitespace-nowrap">
          Design repo
        </label>
        {designRepos.length === 0 ? (
          <span className="text-[12px] text-theme-subtle">
            No design repos.{' '}
            <a href="/settings/general" className="text-accent hover:underline">
              Set up a design repo
            </a>
          </span>
        ) : (
          <select
            value={selectedDesignRepoId ?? ''}
            onChange={(e) => onDesignRepoChange(e.target.value)}
            className="h-7 rounded-md border border-app bg-app-card px-2 text-[12px] text-theme-primary outline-none transition-colors hover:border-app-strong focus:border-accent"
          >
            {!selectedDesignRepoId && (
              <option value="" disabled>
                Select design repo
              </option>
            )}
            {designRepos.map((repo) => (
              <option key={repo._id} value={repo._id}>
                {repo.name ?? repo._id}
              </option>
            ))}
          </select>
        )}
      </div>

      {sourceRepos !== undefined && onSourceRepoChange && (
        <div className="flex items-center gap-2">
          <label className="text-[11.5px] font-medium text-theme-muted whitespace-nowrap">
            Source repo
          </label>
          <select
            value={selectedSourceRepoId ?? ''}
            onChange={(e) => onSourceRepoChange(e.target.value || null)}
            className="h-7 rounded-md border border-app bg-app-card px-2 text-[12px] text-theme-primary outline-none transition-colors hover:border-app-strong focus:border-accent"
          >
            <option value="">None</option>
            {sourceRepos.map((repo) => (
              <option key={repo._id} value={repo._id}>
                {repo.name ?? repo._id}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
