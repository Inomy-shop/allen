import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  ExternalLink,
  FileText,
  HelpCircle,
  FolderGit2,
  GitBranch,
  Loader2,
  PlayCircle,
  StopCircle,
  Timer,
  X,
} from 'lucide-react';
import type { SpawnedAgent } from '../../hooks/useChat';
import type { RunStatus } from '../../services/api';

const FAILED_STATUSES = new Set(['failed', 'failure', 'error', 'errored']);
const CANCELLED_STATUSES = new Set(['cancelled', 'canceled']);

function humanLabel(value?: string | null): string {
  if (!value) return '';
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function timeAgo(dateStr?: string | null): string {
  if (!dateStr) return 'recently';
  const ms = Date.now() - new Date(dateStr).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function formatClock(dateStr?: string | null): string {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDuration(ms?: number | null): string {
  if (ms == null || ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
  const min = Math.floor(sec / 60);
  const rem = Math.round(sec % 60);
  return rem ? `${min}m ${rem}s` : `${min}m`;
}

function runExecutionLabel(context: RunStatus | null): string {
  if (context?.runType === 'workflow') return 'Workflow Execution';
  if (context?.runType === 'agent') return 'Agent Execution';
  return 'Execution Trace';
}

function RunExecutionIcon({ context }: { context: RunStatus | null }) {
  if (context?.runType === 'workflow') return <GitBranch className="h-3 w-3" />;
  if (context?.runType === 'agent') return <Bot className="h-3 w-3" />;
  return <Activity className="h-3 w-3" />;
}

function statusIcon(status: string) {
  const normalized = status.toLowerCase();
  if (normalized === 'completed' || normalized === 'merged') return <CheckCircle2 className="h-3.5 w-3.5 text-accent-green" />;
  if (normalized === 'waiting_for_input' || normalized === 'waiting' || normalized === 'draft') return <AlertTriangle className="h-3.5 w-3.5 text-accent-yellow" />;
  if (FAILED_STATUSES.has(normalized) || CANCELLED_STATUSES.has(normalized) || normalized === 'closed') return <AlertTriangle className="h-3.5 w-3.5 text-accent-red" />;
  return <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />;
}

function statusBadgeClass(status?: string | null): string {
  const normalized = (status ?? '').toLowerCase();
  if (normalized === 'completed' || normalized === 'merged' || normalized === 'ready') {
    return 'bg-accent-green/10 text-accent-green';
  }
  if (normalized === 'waiting_for_input' || normalized === 'waiting' || normalized === 'draft' || normalized === 'queued') {
    return 'bg-accent-yellow/10 text-accent-yellow';
  }
  if (FAILED_STATUSES.has(normalized) || CANCELLED_STATUSES.has(normalized) || normalized === 'closed') {
    return 'bg-accent-red/10 text-accent-red';
  }
  if (normalized === 'running' || normalized === 'in_progress' || normalized === 'reviewing' || normalized === 'open') {
    return 'bg-accent/10 text-accent';
  }
  return 'bg-app-muted text-theme-muted';
}

function StatusBadge({ status }: { status?: string | null }) {
  const label = humanLabel(status ?? 'unknown');
  return <span className={`rounded px-1.5 py-0.5 font-mono text-[9px] uppercase ${statusBadgeClass(status)}`}>{label}</span>;
}

function runKindLabel(context: RunStatus | null, fallback?: SpawnedAgent | null): string {
  if (context?.runType === 'workflow') return 'Workflow Run';
  if (context?.childAgents.length) return 'Lead Agent Run';
  if (fallback?.kind === 'lead') return 'Lead Agent Run';
  return 'Agent Run';
}

function expectedOutcome(context: RunStatus | null): string {
  if (context?.pullRequest) return 'Code changes with pull request';
  if (context?.workspace) return 'Workspace-backed code work';
  if (context?.linear) return 'Ticket-linked task';
  if (context?.runType === 'workflow') return 'Workflow steps and outputs';
  return 'Agent analysis and response';
}

function stepMeta(context: RunStatus | null, node?: string): string {
  if (!context) return '';
  const runStatus = context.status.toLowerCase();
  if (!node) return humanLabel(context.progress.phase);
  if (context.humanInput.required && context.progress.currentStep === node) return 'waiting for you';
  if (context.execution.failedNode === node || FAILED_STATUSES.has(runStatus)) return 'failed';
  if (CANCELLED_STATUSES.has(runStatus)) return 'cancelled';
  if ((context.execution.currentNodes ?? []).includes(node)) return humanLabel(context.progress.phase || 'running');
  return 'done';
}

function compactSteps(context: RunStatus | null): Array<{ id: string; name: string; state: 'ok' | 'run' | 'wait-you' | 'fail' | 'wait'; meta: string }> {
  if (!context) return [];
  const runStatus = context.status.toLowerCase();
  const isFailedRun = FAILED_STATUSES.has(runStatus);
  const isCancelledRun = CANCELLED_STATUSES.has(runStatus);
  const completed = (context.execution.completedNodes ?? []).filter(Boolean);
  const current = (context.execution.currentNodes ?? []).filter(Boolean);

  const seen = new Set<string>();
  const items: Array<{ id: string; name: string; state: 'ok' | 'run' | 'wait-you' | 'fail' | 'wait'; meta: string }> = [];

  for (const node of completed.slice(-7)) {
    if (seen.has(node)) continue;
    seen.add(node);
    items.push({ id: `done-${node}`, name: humanLabel(node), state: 'ok', meta: stepMeta(context, node) });
  }

  for (const node of current) {
    if (seen.has(node)) continue;
    seen.add(node);
    const state = context.execution.failedNode === node || isFailedRun || isCancelledRun
      ? 'fail'
      : context.humanInput.required ? 'wait-you' : 'run';
    items.push({ id: `current-${node}`, name: humanLabel(node), state, meta: stepMeta(context, node) });
  }

  if (items.length === 0 && context.progress.currentStep) {
    const state = context.humanInput.required ? 'wait-you' : isFailedRun || isCancelledRun ? 'fail' : context.status === 'completed' ? 'ok' : 'run';
    items.push({ id: 'current-step', name: context.progress.currentStep, state, meta: humanLabel(context.progress.phase) });
  }

  return items;
}

function runState(context: RunStatus | null, run: SpawnedAgent): 'ok' | 'run' | 'wait-you' | 'fail' | 'wait' {
  const status = (context?.status ?? run.status ?? '').toLowerCase();
  if (context?.humanInput.required || status === 'waiting_for_input' || status === 'waiting') return 'wait-you';
  if (FAILED_STATUSES.has(status) || CANCELLED_STATUSES.has(status) || status === 'closed') return 'fail';
  if (status === 'completed' || status === 'merged') return 'ok';
  if (status === 'queued') return 'wait';
  return 'run';
}

function artifactsForRun(run: SpawnedAgent, context: RunStatus | null) {
  return (context?.artifacts ?? []).filter((artifact) => {
    if (!artifact.url) return false;
    if (artifact.rootId === run.executionId) return true;
    if (artifact.spawnContext?.agentExecutionId === run.executionId) return true;
    if (artifact.spawnContext?.parentId === run.executionId) return true;
    return false;
  });
}

function StepDot({ state }: { state: 'ok' | 'run' | 'wait-you' | 'fail' | 'wait' }) {
  const base = 'relative z-[1] flex h-5 w-5 items-center justify-center rounded-full border font-mono text-[10px]';
  if (state === 'ok') return <span className={`${base} border-accent-green/35 bg-accent-green/10 text-accent-green`}><CheckCircle2 className="h-3 w-3" /></span>;
  if (state === 'run') return <span className={`${base} border-accent/35 bg-accent-soft text-accent`}><Loader2 className="h-3 w-3 animate-spin" /></span>;
  if (state === 'wait-you') return <span className={`${base} border-accent-yellow/50 bg-accent-yellow/10 font-bold text-accent-yellow`}><HelpCircle className="h-3 w-3" /></span>;
  if (state === 'fail') return <span className={`${base} border-accent-red/35 bg-accent-red/10 text-accent-red`}><X className="h-3 w-3" /></span>;
  return <span className={`${base} border-app bg-app-muted text-theme-subtle`} />;
}

function nodeStepState(status?: string | null): 'ok' | 'run' | 'wait-you' | 'fail' | 'wait' {
  const normalized = (status ?? '').toLowerCase();
  if (normalized === 'completed' || normalized === 'skipped') return 'ok';
  if (normalized === 'running') return 'run';
  if (normalized === 'waiting_for_input' || normalized === 'waiting') return 'wait-you';
  if (FAILED_STATUSES.has(normalized) || CANCELLED_STATUSES.has(normalized)) return 'fail';
  return 'wait';
}

function RailSection({ title, count, children }: { title: string; count?: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2.5 flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-theme-muted">
        {title}
        {count && <span className="font-mono text-[11px] font-normal normal-case tracking-normal text-theme-subtle">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

function WorkflowNodeStep({ step, isLast }: { step: NonNullable<RunStatus['workflowSteps']>[number]; isLast: boolean }) {
  const state = nodeStepState(step.status);
  const attempts = Math.max(0, step.attempts ?? 0);
  const meta = [
    step.agent || humanLabel(step.type ?? 'node'),
    attempts > 1 ? `${attempts} attempts` : attempts === 1 ? '1 attempt' : 'pending',
    step.model ? String(step.model).replace(/^claude-/, '') : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="relative grid grid-cols-[26px_1fr] gap-3 py-1.5">
      {!isLast && <span className="absolute bottom-[-8px] left-[9.5px] top-[20px] w-[2px] rounded-full bg-[rgb(var(--color-border))]" />}
      <div className="relative z-[2]">
        <StepDot state={state} />
      </div>
      <div className="min-w-0">
        <div className={`truncate text-[13px] font-medium ${state === 'run' || state === 'wait-you' ? 'text-theme-primary' : 'text-theme-secondary'}`}>
          {humanLabel(step.name)}
        </div>
        <div className="mt-0.5 truncate font-mono text-[11px] text-theme-muted">{meta}</div>
        <div className="mt-1.5 grid grid-cols-3 gap-1.5 font-mono text-[10px] text-theme-subtle">
          <span className="flex min-w-0 items-center gap-1 truncate" title="Started at">
            <PlayCircle className="h-3 w-3 shrink-0 text-accent-green" />
            <span className="truncate">{formatClock(step.startedAt)}</span>
          </span>
          <span className="flex min-w-0 items-center gap-1 truncate" title="Ended at">
            <StopCircle className="h-3 w-3 shrink-0 text-accent-red" />
            <span className="truncate">{formatClock(step.completedAt)}</span>
          </span>
          <span className="flex min-w-0 items-center gap-1 truncate" title="Duration">
            <Timer className="h-3 w-3 shrink-0 text-accent" />
            <span className="truncate">{formatDuration(step.durationMs)}</span>
          </span>
        </div>
        {(attempts > 1 || Boolean(step.retryReasons?.length)) && (
          <div className="mt-1 inline-flex items-center rounded bg-accent-yellow/10 px-1.5 py-0.5 font-mono text-[10px] text-accent-yellow">
            retry {attempts}x{step.retryReasons?.[0] ? ` · ${humanLabel(step.retryReasons[0])}` : ''}
          </div>
        )}
        {step.error && (
          <div className="mt-1 rounded bg-accent-red/10 px-1.5 py-0.5 text-[11px] text-accent-red">{step.error}</div>
        )}
      </div>
    </div>
  );
}

function ReferenceLinks({ run, context }: { run: SpawnedAgent; context: RunStatus | null }) {
  const pr = context?.pullRequest;
  const artifacts = artifactsForRun(run, context);
  const hasReferences = Boolean(context?.linear || context?.workspace || pr?.number || artifacts.length || run.executionId);
  if (!hasReferences) return null;

  return (
    <div className="mt-3 space-y-1.5">
      {context?.linear && (
        <a href={context.linear.url ?? '#'} target={context.linear.url ? '_blank' : undefined} rel="noreferrer" className="grid grid-cols-[24px_1fr_14px] items-center gap-2.5 rounded-lg border border-app-strong bg-app-card px-2.5 py-2 text-inherit transition-colors hover:bg-app-muted">
          <span className="flex h-[22px] w-[22px] items-center justify-center rounded bg-accent-purple/10 font-mono text-[11px] font-bold text-accent-purple">L</span>
          <span className="min-w-0">
            <span className="block truncate font-mono text-[12px] text-theme-primary">{context.linear.identifier ?? context.linear.title ?? 'Linear Ticket'}</span>
            <span className="block truncate font-mono text-[11px] text-theme-muted">{context.linear.title ?? 'Linear'}</span>
          </span>
          {context.linear.url && <ExternalLink className="h-3.5 w-3.5 text-theme-subtle" />}
        </a>
      )}
      {pr?.number && (
        <a href={pr.url ?? '#'} target={pr.url ? '_blank' : undefined} rel="noreferrer" className="grid grid-cols-[24px_1fr_14px] items-center gap-2.5 rounded-lg border border-app-strong bg-app-card px-2.5 py-2 text-inherit transition-colors hover:bg-app-muted">
          <span className="flex h-[22px] w-[22px] items-center justify-center rounded bg-[rgb(var(--color-text-primary))] font-mono text-[10px] font-bold text-[rgb(var(--color-surface))]">GH</span>
          <span className="min-w-0">
            <span className="block truncate font-mono text-[12px] text-theme-primary">PR #{pr.number} <StatusBadge status={pr.status ?? 'open'} /></span>
            <span className="block truncate font-mono text-[11px] text-theme-muted">{timeAgo(pr.mergedAt ?? pr.updatedAt ?? pr.createdAt)}</span>
          </span>
          {pr.url && <ExternalLink className="h-3.5 w-3.5 text-theme-subtle" />}
        </a>
      )}
      {context?.workspace && (
        <Link to={context.workspace.id ? `/workspaces/${context.workspace.id}` : `/executions/${run.executionId}`} className="grid grid-cols-[24px_1fr_14px] items-center gap-2.5 rounded-lg border border-app-strong bg-app-card px-2.5 py-2 text-inherit transition-colors hover:bg-app-muted">
          <span className="flex h-[22px] w-[22px] items-center justify-center rounded border border-app bg-app-muted text-theme-muted"><FolderGit2 className="h-3 w-3" /></span>
          <span className="min-w-0">
            <span className="block truncate font-mono text-[12px] text-theme-primary">{context.workspace.branch ?? context.workspace.name ?? 'Workspace'}</span>
            <span className="block truncate font-mono text-[11px] text-theme-muted">{context.workspace.repoName ?? 'Workspace'} {context.workspace.status && <StatusBadge status={context.workspace.status} />}</span>
          </span>
          <ExternalLink className="h-3.5 w-3.5 text-theme-subtle" />
        </Link>
      )}
      {artifacts.slice(0, 2).map((artifact) => (
        <a key={artifact.artifactId} href={artifact.url ?? '#'} target="_blank" rel="noreferrer" className="grid grid-cols-[24px_1fr_14px] items-center gap-2.5 rounded-lg border border-app-strong bg-app-card px-2.5 py-2 text-inherit transition-colors hover:bg-app-muted">
          <span className="flex h-[22px] w-[22px] items-center justify-center rounded border border-app bg-app-muted text-theme-muted"><FileText className="h-3 w-3" /></span>
          <span className="min-w-0">
            <span className="block truncate font-mono text-[12px] text-theme-primary">{artifact.filename ?? 'Artifact'}</span>
            <span className="block truncate font-mono text-[11px] text-theme-muted">{artifact.contentType ?? 'output'}</span>
          </span>
          <ExternalLink className="h-3.5 w-3.5 text-theme-subtle" />
        </a>
      ))}
      <Link to={`/executions/${run.executionId}`} className="grid grid-cols-[24px_1fr_14px] items-center gap-2.5 rounded-lg border border-app-strong bg-app-card px-2.5 py-2 text-inherit transition-colors hover:bg-app-muted" title={`Open ${runExecutionLabel(context).toLowerCase()}`}>
        <span className="flex h-[22px] w-[22px] items-center justify-center rounded border border-app bg-app-muted text-theme-muted"><RunExecutionIcon context={context} /></span>
        <span className="min-w-0">
          <span className="block truncate font-mono text-[12px] text-theme-primary">{run.executionId.slice(0, 8)}</span>
          <span className="block truncate font-mono text-[11px] text-theme-muted">{runExecutionLabel(context)} <StatusBadge status={context?.status ?? run.status} /></span>
        </span>
        <ExternalLink className="h-3.5 w-3.5 text-theme-subtle" />
      </Link>
    </div>
  );
}

function ExecutionStep({ run, index, isLast }: { run: SpawnedAgent; index: number; isLast: boolean }) {
  const context = run.runContext ?? null;
  const state = runState(context, run);
  const percent = Math.max(0, Math.min(100, context?.progress.percent ?? 0));
  const title = context?.title ?? run.agent;
  const currentStep = context?.progress.currentStep ?? context?.progress.label ?? run.prompt ?? 'Waiting for activity';
  const childSteps = compactSteps(context).slice(-3);

  return (
    <div className="relative grid grid-cols-[26px_1fr] gap-3 pb-4">
      {!isLast && <span className="absolute bottom-[-12px] left-[9.5px] top-[20px] w-[2px] rounded-full bg-[rgb(var(--color-border))]" />}
      <div className="relative z-[2]">
        <StepDot state={state} />
      </div>
      <div className="min-w-0 rounded-lg border border-app bg-app-card p-3">
        <div className="mb-2 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="mb-1 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-theme-muted">Step {index + 1}</div>
            <div className="truncate text-[13px] font-semibold text-theme-primary">{title}</div>
            <div className="mt-1 font-mono text-[10.5px] text-theme-muted">{runKindLabel(context, run)} · {expectedOutcome(context)}</div>
          </div>
          <StatusBadge status={context?.status ?? run.status} />
        </div>

        <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-app-muted">
          <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${percent}%` }} />
        </div>
        <div className="flex justify-between font-mono text-[10.5px] text-theme-muted">
          <span className="truncate pr-2">{currentStep}</span>
          <span className="shrink-0 text-theme-primary">{percent}%</span>
        </div>

        {context?.humanInput.required && (
          <div className="mt-2 rounded border border-accent-yellow/20 bg-accent-yellow/10 px-2 py-1.5 text-[11px] text-accent-yellow">
            {context.humanInput.title ?? 'Needs your input'}
          </div>
        )}

        {childSteps.length > 0 && (
          <div className="mt-3 space-y-1.5 border-t border-app pt-2">
            {childSteps.map(step => (
              <div key={step.id} className="grid grid-cols-[18px_1fr] gap-2 text-[11px]">
                <StepDot state={step.state} />
                <div className="min-w-0">
                  <div className="truncate text-theme-secondary">{step.name}</div>
                  <div className="truncate font-mono text-[10px] text-theme-muted">{step.meta}</div>
                </div>
              </div>
            ))}
          </div>
        )}

        <ReferenceLinks run={run} context={context} />
      </div>
    </div>
  );
}

export default function ChatRunSidebar({ runs }: { runs: SpawnedAgent[] }) {
  const sortedRuns = useMemo(() => {
    return [...runs];
  }, [runs]);
  const activeRun = sortedRuns.find(run => {
    const status = (run.runContext?.status ?? run.status ?? '').toLowerCase();
    return !['completed', 'failed', 'cancelled', 'canceled'].includes(status);
  }) ?? sortedRuns[sortedRuns.length - 1] ?? null;
  const activeContext = activeRun?.runContext ?? null;
  const showWorkflowNodes = sortedRuns.length === 1 && activeContext?.runType === 'workflow' && (activeContext.workflowSteps?.length ?? 0) > 0;

  if (!activeRun) return null;

  return (
    <aside className="hidden h-full w-[320px] shrink-0 flex-col gap-5 overflow-y-auto border-l border-app bg-app-sunken px-[18px] py-5 xl:flex">
      <div className="flex items-center justify-between gap-3">
        <h2 className="m-0 font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-theme-muted">
          {sortedRuns.length > 1 ? 'Task Sequence' : 'This Task'}
        </h2>
        {sortedRuns.length === 1 && (
          <Link
            to={`/executions/${activeRun.executionId}`}
            className="inline-flex items-center gap-1 rounded border border-app bg-app-card px-2 py-1 font-mono text-[10px] text-theme-muted transition-colors hover:bg-app-muted hover:text-theme-primary"
            title="Open full execution trace"
          >
            {activeContext?.runType === 'workflow' ? 'workflow trace' : activeContext?.runType === 'agent' ? 'agent trace' : 'trace'}
            <ExternalLink className="h-3 w-3" />
          </Link>
        )}
      </div>

      <section className="border-b border-app-strong pb-4">
        <div className="mb-1.5 flex justify-between text-[12px]">
          <span className="text-theme-muted">progress</span>
          <span className="font-mono text-theme-primary">{Math.max(0, Math.min(100, activeContext?.progress.percent ?? 0))}%</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-app-muted">
          <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.max(0, Math.min(100, activeContext?.progress.percent ?? 0))}%` }} />
        </div>
        <div className="mt-2 flex justify-between text-[12px]">
          <span className="text-theme-muted">status</span>
          <StatusBadge status={activeContext?.status ?? activeRun.status} />
        </div>
      </section>

      {showWorkflowNodes ? (
        <>
          <RailSection title="Current Work">
            <div className="rounded-lg border border-app bg-app-card p-3">
              <div className="mb-1.5 flex items-start gap-2">
                {statusIcon(activeContext?.status ?? activeRun.status)}
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-semibold text-theme-primary">{activeContext?.title ?? activeRun.agent}</div>
                  <div className="mt-1 font-mono text-[10.5px] text-theme-muted">Workflow Run · {activeRun.executionId.slice(0, 8)}</div>
                </div>
              </div>
              <ReferenceLinks run={activeRun} context={activeContext} />
            </div>
          </RailSection>
          <RailSection title="Workflow Steps" count={`${activeContext?.progress.completed ?? 0}/${activeContext?.progress.total ?? activeContext?.workflowSteps.length}`}>
            <div className="flex flex-col">
              {activeContext!.workflowSteps.map((step, index) => (
                <WorkflowNodeStep key={step.id} step={step} isLast={index === activeContext!.workflowSteps.length - 1} />
              ))}
            </div>
          </RailSection>
        </>
      ) : (
        <RailSection title="Execution Steps" count={`${sortedRuns.length}`}>
          <div className="flex flex-col">
            {sortedRuns.map((run, index) => (
              <ExecutionStep key={run.executionId} run={run} index={index} isLast={index === sortedRuns.length - 1} />
            ))}
          </div>
        </RailSection>
      )}

      {activeContext?.childAgents && activeContext.childAgents.length > 0 && (
        <RailSection title="Agents">
          <div className="space-y-1">
            {activeContext.childAgents.map(child => (
              <Link
                key={child.executionId}
                to={`/executions/${child.executionId}`}
                className="flex items-center justify-between gap-2 rounded border border-app bg-app-card px-2 py-1.5 text-[10.5px] text-theme-muted transition-colors hover:bg-app-muted hover:text-accent"
              >
                <span className="truncate">{child.agentName}</span>
                <span className="inline-flex shrink-0 items-center gap-1">
                  <StatusBadge status={child.status} />
                  <ExternalLink className="h-3.5 w-3.5 text-theme-subtle" />
                </span>
              </Link>
            ))}
          </div>
        </RailSection>
      )}

      {(activeContext?.humanInput.required || activeContext?.pullRequest?.url) && (
        <RailSection title="Actions">
          <div className="flex flex-col gap-1.5">
            {activeContext?.humanInput.required && (
              <Link to={activeContext.humanInput.interventionId ? `/interventions/${activeContext.humanInput.interventionId}` : '/interventions'} className="btn-primary justify-center gap-1.5 text-[12px]">
                Resolve Input
                <ExternalLink className="h-3.5 w-3.5" />
              </Link>
            )}
            {activeContext?.pullRequest?.url && (
              <a href={activeContext.pullRequest.url} target="_blank" rel="noreferrer" className="btn-secondary justify-center gap-1.5 text-[12px]">
                Review PR
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        </RailSection>
      )}
    </aside>
  );
}
