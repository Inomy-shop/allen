import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
  FileText,
  FolderGit2,
  GitPullRequest,
  Loader2,
  Users,
} from 'lucide-react';
import type { RunPhase, RunStatus } from '../../services/api';

function phaseLabel(phase: RunPhase): string {
  return phase
    .split('_')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function statusTheme(status: string, humanInputRequired: boolean): string {
  const normalized = status.toLowerCase();
  if (humanInputRequired) return 'border-accent-yellow/35 bg-accent-yellow/5';
  if (normalized === 'completed') return 'border-accent-green/30 bg-accent-green/5';
  if (normalized === 'failed' || normalized === 'cancelled' || normalized === 'canceled') return 'border-accent-red/30 bg-accent-red/5';
  return 'border-accent/25 bg-accent/5';
}

function StatusIcon({ context }: { context: RunStatus }) {
  const status = context.execution.status.toLowerCase();
  if (context.humanInput.required) return <AlertTriangle className="h-4 w-4 text-accent-yellow" />;
  if (status === 'completed') return <CheckCircle2 className="h-4 w-4 text-accent-green" />;
  if (status === 'failed' || status === 'cancelled' || status === 'canceled') return <AlertTriangle className="h-4 w-4 text-accent-red" />;
  return <Loader2 className="h-4 w-4 animate-spin text-accent" />;
}

function empty(value?: string | number | null): string {
  if (value === null || value === undefined || value === '') return 'pending';
  return String(value);
}

export default function RunStatusCard({
  context,
  loading,
  error,
  title = 'Run status',
  compact = false,
  showEmptyMeta = true,
}: {
  context: RunStatus | null;
  loading?: boolean;
  error?: string | null;
  title?: string;
  compact?: boolean;
  showEmptyMeta?: boolean;
}) {
  if (loading && !context) {
    return (
      <div className="rounded-lg border border-app bg-surface-50 px-3 py-2 text-[11px] font-mono text-theme-muted">
        <Loader2 className="mr-1.5 inline h-3.5 w-3.5 animate-spin" />
        Loading run context...
      </div>
    );
  }

  if (!context) {
    return error ? (
      <div className="rounded-lg border border-accent-red/25 bg-accent-red/5 px-3 py-2 text-[11px] font-mono text-accent-red">
        {error}
      </div>
    ) : null;
  }

  const percent = Math.max(0, Math.min(100, context.progress.percent ?? 0));
  const theme = statusTheme(context.execution.status, context.humanInput.required);
  const currentStep = context.progress.currentStep ?? context.progress.label;

  return (
    <div className={`rounded-lg border ${theme} ${compact ? 'p-3' : 'p-4'} space-y-3`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="overline mb-1">{title}</div>
          <div className="flex items-center gap-2 text-[13px] font-mono font-semibold text-theme-primary">
            <StatusIcon context={context} />
            <span className="truncate">{context.title || context.execution.workflowName}</span>
          </div>
          <div className="mt-1 text-[10px] font-mono text-theme-muted">
            {phaseLabel(context.progress.phase)} / {context.execution.status}
          </div>
        </div>
        <Link
          to={`/executions/${context.execution.id}`}
          className="shrink-0 inline-flex items-center gap-1 rounded-full border border-app bg-app-muted px-2 py-1 text-[10px] font-mono text-theme-muted transition-colors hover:text-theme-primary"
        >
          <Activity className="h-3 w-3" />
          Open
        </Link>
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between gap-2 text-[10px] font-mono text-theme-muted">
          <span className="truncate">{currentStep || 'Waiting for activity'}</span>
          <span>{context.progress.completed}/{context.progress.total || 1}</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-app-muted">
          <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${percent}%` }} />
        </div>
      </div>

      {context.humanInput.required && (
        <Link
          to={context.humanInput.interventionId ? `/interventions/${context.humanInput.interventionId}` : '/interventions'}
          className="flex items-start gap-2 rounded-md border border-accent-yellow/30 bg-accent-yellow/10 px-2.5 py-2 text-accent-yellow transition-colors hover:bg-accent-yellow/15"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0">
            <span className="block text-[11px] font-mono font-semibold">Human input required</span>
            <span className="block truncate text-[10px] font-mono opacity-85">
              {context.humanInput.title ?? context.humanInput.stage ?? 'Waiting for review'}
            </span>
          </span>
        </Link>
      )}

      <div className="grid grid-cols-2 gap-2 text-[10px] font-mono text-theme-muted">
        {(showEmptyMeta || context.workspace) && (
          <MetaCell
            icon={<FolderGit2 className="h-3.5 w-3.5" />}
            label="Workspace"
            value={context.workspace?.name ?? context.workspace?.id ?? context.workspace?.status}
            href={context.workspace?.id ? `/workspaces/${context.workspace.id}` : undefined}
          />
        )}
        {(showEmptyMeta || context.pullRequest || context.workspace?.prUrl) && (
          <MetaCell
            icon={<GitPullRequest className="h-3.5 w-3.5" />}
            label="PR"
            value={context.pullRequest?.number ? `#${context.pullRequest.number}` : context.workspace?.prUrl ? 'Open PR' : context.pullRequest?.status}
            href={context.pullRequest?.url ?? context.workspace?.prUrl ?? undefined}
            external
          />
        )}
        {(showEmptyMeta || context.linear) && (
          <MetaCell
            icon={<FileText className="h-3.5 w-3.5" />}
            label="Linear"
            value={context.linear?.identifier ?? context.linear?.title}
            href={context.linear?.url}
            external
          />
        )}
        {(showEmptyMeta || context.childAgents.length > 0 || context.runType) && (
          <MetaCell
            icon={<Users className="h-3.5 w-3.5" />}
            label={context.childAgents.length > 0 ? 'Agents' : 'Run'}
            value={context.childAgents.length > 0 ? `${context.childAgents.length} child` : context.runType}
          />
        )}
      </div>

      {context.recentActivity.length > 0 && (
        <div className="space-y-1 border-t border-current/10 pt-2">
          {context.recentActivity.slice(0, compact ? 2 : 3).map((activity, index) => (
            <div key={`${activity.type}-${activity.at ?? index}`} className="flex items-center gap-2 text-[10px] font-mono text-theme-subtle">
              <Clock className="h-3 w-3 shrink-0" />
              <span className="truncate">{activity.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MetaCell({
  icon,
  label,
  value,
  href,
  external,
}: {
  icon: ReactNode;
  label: string;
  value?: string | number | null;
  href?: string;
  external?: boolean;
}) {
  const body = (
    <>
      <span className="text-theme-subtle">{icon}</span>
      <span className="min-w-0">
        <span className="block text-[9px] uppercase tracking-wider text-theme-subtle">{label}</span>
        <span className="block truncate text-theme-secondary">{empty(value)}</span>
      </span>
      {href && external && <ExternalLink className="ml-auto h-3 w-3 shrink-0 text-theme-subtle" />}
    </>
  );

  const className = "flex min-w-0 items-center gap-2 rounded-md border border-app/70 bg-surface-50/60 px-2 py-1.5";

  if (!href) return <div className={className}>{body}</div>;
  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={`${className} transition-colors hover:border-accent/35`}>
        {body}
      </a>
    );
  }
  return (
    <Link to={href} className={`${className} transition-colors hover:border-accent/35`}>
      {body}
    </Link>
  );
}
