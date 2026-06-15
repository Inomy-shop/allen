import type { FC } from 'react';

type ActionBadgeProps = { action: string };
function ActionBadge({ action }: ActionBadgeProps) {
  const classes: Record<string, string> = {
    add: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
    skip_duplicate: 'bg-theme-muted/20 text-theme-muted',
    skip_clash: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
    skip_missing_agent: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
  };
  const labels: Record<string, string> = {
    add: 'add',
    skip_duplicate: 'duplicate',
    skip_clash: 'clash',
    skip_missing_agent: 'missing agent',
  };
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${classes[action] ?? 'bg-theme-muted/20 text-theme-muted'}`}>
      {labels[action] ?? action}
    </span>
  );
}

export type CuratedActionRow = {
  entryId?: string;
  title?: string;
  path?: string;
  action: string;
  reason?: string | null;
};

export type MandatoryActionRow = {
  mappingId?: string;
  agentName?: string;
  title?: string;
  sourcePath?: string | null;
  action: string;
  reason?: string | null;
};

export const CuratedActionsTable: FC<{ actions: CuratedActionRow[] }> = ({ actions }) => {
  if (actions.length === 0) return <p className="text-xs text-theme-muted">No curated entries in package.</p>;
  return (
    <div className="overflow-auto max-h-48 rounded border border-app">
      <table className="w-full text-xs">
        <thead className="bg-app-card sticky top-0">
          <tr>
            <th className="px-2 py-1 text-left text-theme-muted font-medium">Title</th>
            <th className="px-2 py-1 text-left text-theme-muted font-medium">Path</th>
            <th className="px-2 py-1 text-left text-theme-muted font-medium">Action</th>
          </tr>
        </thead>
        <tbody>
          {actions.map((row, i) => (
            <tr key={row.entryId ?? i} className="border-t border-app">
              <td className="px-2 py-1 truncate max-w-[120px]" title={row.title}>{row.title ?? '—'}</td>
              <td className="px-2 py-1 truncate max-w-[120px] text-theme-muted" title={row.path}>{row.path ?? '—'}</td>
              <td className="px-2 py-1"><ActionBadge action={row.action} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export const MandatoryActionsTable: FC<{ actions: MandatoryActionRow[] }> = ({ actions }) => {
  if (actions.length === 0) return <p className="text-xs text-theme-muted">No mandatory mappings in package.</p>;
  return (
    <div className="overflow-auto max-h-48 rounded border border-app">
      <table className="w-full text-xs">
        <thead className="bg-app-card sticky top-0">
          <tr>
            <th className="px-2 py-1 text-left text-theme-muted font-medium">Agent</th>
            <th className="px-2 py-1 text-left text-theme-muted font-medium">Title</th>
            <th className="px-2 py-1 text-left text-theme-muted font-medium">Action</th>
          </tr>
        </thead>
        <tbody>
          {actions.map((row, i) => (
            <tr key={row.mappingId ?? i} className="border-t border-app">
              <td className="px-2 py-1 truncate max-w-[100px] text-theme-muted" title={row.agentName}>{row.agentName ?? '—'}</td>
              <td className="px-2 py-1 truncate max-w-[120px]" title={row.title}>{row.title ?? '—'}</td>
              <td className="px-2 py-1"><ActionBadge action={row.action} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
