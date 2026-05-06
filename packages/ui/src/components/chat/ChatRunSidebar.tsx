import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  Bot,
  ChevronDown,
  ChevronRight,
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
import { artifacts as artifactsApi, type ArtifactDoc, type RunStatus } from '../../services/api';
import ArtifactViewer from '../artifacts/ArtifactViewer';

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

function formatCost(cost?: { actual?: number | null; estimated?: number | null } | null): string {
  if (!cost) return '$0.00';
  const value = Number(cost.actual ?? cost.estimated ?? 0);
  if (!Number.isFinite(value) || value <= 0) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function costValue(cost?: { actual?: number | null; estimated?: number | null } | null): number {
  const value = Number(cost?.actual ?? cost?.estimated ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function formatRunSequenceCost(runs: SpawnedAgent[]): string {
  const total = runs.reduce((sum, run) => sum + costValue(run.runContext?.execution.cost), 0);
  return formatCost({ actual: total, estimated: total });
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

function artifactTypeLabel(artifact: RunStatus['artifacts'][number]): string {
  const raw = artifact.contentType?.split('/').pop() ?? artifact.rootType ?? 'file';
  return humanLabel(raw).toLowerCase();
}

function artifactContentType(value?: string | null): ArtifactDoc['contentType'] {
  const normalized = (value ?? '').toLowerCase();
  if (normalized.includes('markdown') || normalized === 'md') return 'markdown';
  if (normalized.includes('json')) return 'json';
  if (normalized.includes('csv')) return 'csv';
  if (normalized.includes('javascript') || normalized.includes('typescript') || normalized.includes('python') || normalized.includes('code')) return 'code';
  if (normalized.includes('octet-stream') || normalized.includes('binary')) return 'binary';
  return 'text';
}

function fallbackArtifactDoc(artifact: RunStatus['artifacts'][number], run: SpawnedAgent): ArtifactDoc {
  const filename = artifact.filename ?? artifact.relativePath ?? 'artifact.md';
  return {
    artifactId: artifact.artifactId,
    rootType: artifact.rootType === 'chat' || artifact.rootType === 'workflow' || artifact.rootType === 'agent' ? artifact.rootType : 'agent',
    rootId: artifact.rootId ?? run.executionId,
    spawnContext: {
      originType: 'spawn_agent',
      parentId: artifact.spawnContext?.parentId ?? run.executionId,
      nodeName: artifact.spawnContext?.nodeName ?? undefined,
      agentName: artifact.spawnContext?.agentName ?? run.agent,
      agentExecutionId: artifact.spawnContext?.agentExecutionId ?? run.executionId,
    },
    filename,
    relativePath: artifact.relativePath ?? filename,
    contentType: artifactContentType(artifact.contentType),
    sizeBytes: 0,
    description: artifact.description ?? undefined,
    createdAt: artifact.createdAt ?? new Date().toISOString(),
    createdByAgent: artifact.spawnContext?.agentName ?? run.agent,
  };
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
    <section className="cr-section">
      <h6>
        {title}
        {count && <span className="cr-ct">{count}</span>}
      </h6>
      {children}
    </section>
  );
}

function WorkflowNodeStep({ step, isLast }: { step: NonNullable<RunStatus['workflowSteps']>[number]; isLast: boolean }) {
  const state = nodeStepState(step.status);
  const attempts = Math.max(0, step.attempts ?? 0);
  const meta = [
    step.agent || humanLabel(step.type ?? 'node'),
    formatDuration(step.durationMs),
    formatCost(step.cost),
  ].filter(Boolean).join(' · ');
  const sub = [
    attempts > 1 ? `${attempts} attempts` : null,
    step.model ? String(step.model).replace(/^claude-/, '') : null,
    step.error ? 'error' : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className={`step ${state}`}>
      <div className="step-dot">
        {state === 'ok' && '✓'}
        {state === 'run' && <span className="spin">●</span>}
        {state === 'wait' && '○'}
        {state === 'wait-you' && '?'}
        {state === 'fail' && '✕'}
      </div>
      <div className="step-body">
        <div className="step-name">{humanLabel(step.name)}</div>
        <div className="step-meta">{meta}</div>
        {sub && <div className="step-sub">{sub}</div>}
      </div>
    </div>
  );
}

function workflowAttemptFailureLabel(run: SpawnedAgent): string {
  const context = run.runContext;
  const failedStep = context?.execution.failedNode
    ?? context?.progress.currentStep
    ?? context?.workflowSteps.find(step => nodeStepState(step.status) === 'fail')?.name
    ?? null;
  if (failedStep) return `Failed at ${humanLabel(String(failedStep))}`;
  return 'Failed';
}

function AttemptRow({ run, index }: { run: SpawnedAgent; index: number }) {
  const context = run.runContext ?? null;
  const state = runState(context, run);
  const status = context?.status ?? run.status;
  const cost = formatCost(context?.execution.cost);
  const percent = Math.max(0, Math.min(100, context?.progress.percent ?? (state === 'ok' ? 100 : 0)));
  const kind = runKindLabel(context, run).replace(' Run', '');
  const workflowSteps = context?.runType === 'workflow' ? context.workflowSteps ?? [] : [];
  const summary =
    state === 'fail' ? workflowAttemptFailureLabel(run)
      : state === 'ok' ? 'Passed'
        : context?.progress.currentStep ? `Running ${humanLabel(context.progress.currentStep)}`
          : humanLabel(context?.progress.phase ?? status);
  return (
    <div className={`step ${state}`}>
      <div className="step-dot">
        {state === 'ok' && '✓'}
        {state === 'run' && <span className="spin">●</span>}
        {state === 'wait' && '○'}
        {state === 'wait-you' && '?'}
        {state === 'fail' && '✕'}
      </div>
      <div className="step-body">
        <div className="step-name-row">
          <div className="step-name">Attempt {index + 1}</div>
          <Link to={`/executions/${run.executionId}`} className="step-link-icon" title="Open execution">
            <ExternalLink className="h-3.5 w-3.5" />
          </Link>
        </div>
        <div className="step-meta">{kind} · {summary} · {cost}</div>
        <div className="attempt-bar" aria-label={`Attempt ${index + 1} progress ${percent}%`}>
          <span style={{ width: `${percent}%` }} />
        </div>
        {workflowSteps.length > 0 && (
          <div className="attempt-workflow-steps">
            {workflowSteps.map((step, stepIndex) => (
              <WorkflowNodeStep
                key={step.id}
                step={step}
                isLast={stepIndex === workflowSteps.length - 1}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ReferenceLinks({ run, context }: { run: SpawnedAgent; context: RunStatus | null }) {
  const pr = context?.pullRequest;
  const hasReferences = Boolean(context?.linear || context?.workspace || pr?.number || run.executionId);
  if (!hasReferences) return null;

  return (
    <>
      {context?.linear && (
        <a href={context.linear.url ?? '#'} target={context.linear.url ? '_blank' : undefined} rel="noreferrer" className="cr-ref">
          <span className="cr-ref-ic linear">L</span>
          <span className="cr-ref-body">
            <span className="cr-ref-id">{context.linear.identifier ?? context.linear.title ?? 'Linear Ticket'}</span>
            <span className="cr-ref-sub">linear · {humanLabel(String(context.linear.assignment?.status ?? context?.status ?? 'linked'))}</span>
          </span>
          {context.linear.url && <ExternalLink className="h-3.5 w-3.5 text-theme-subtle" />}
        </a>
      )}
      {pr?.number && (
        <a href={pr.url ?? '#'} target={pr.url ? '_blank' : undefined} rel="noreferrer" className="cr-ref">
          <span className="cr-ref-ic gh">⌥</span>
          <span className="cr-ref-body">
            <span className="cr-ref-id">#{pr.number} <span className={`cr-ref-tag ${pr.status === 'draft' ? 'draft' : pr.status === 'open' ? 'open' : ''}`}>{pr.status ?? 'open'}</span></span>
            <span className="cr-ref-sub">{pr.branch ?? 'pull request'} · {timeAgo(pr.mergedAt ?? pr.updatedAt ?? pr.createdAt)}</span>
          </span>
          {pr.url && <ExternalLink className="h-3.5 w-3.5 text-theme-subtle" />}
        </a>
      )}
      {context?.workspace && (
        <Link to={context.workspace.id ? `/workspaces/${context.workspace.id}` : `/executions/${run.executionId}`} className="cr-ref">
          <span className="cr-ref-ic repo">⎇</span>
          <span className="cr-ref-body">
            <span className="cr-ref-id">{context.workspace.branch ?? context.workspace.name ?? 'Workspace'}</span>
            <span className="cr-ref-sub">{context.workspace.repoName ?? 'workspace'}</span>
          </span>
          <ExternalLink className="h-3.5 w-3.5 text-theme-subtle" />
        </Link>
      )}
      <Link to={`/executions/${run.executionId}`} className="cr-ref" title={`Open ${runExecutionLabel(context).toLowerCase()}`}>
        <span className="cr-ref-ic repo">⎇</span>
        <span className="cr-ref-body">
          <span className="cr-ref-id">{run.executionId.slice(0, 8)}</span>
          <span className="cr-ref-sub">{runExecutionLabel(context)} · {humanLabel(context?.status ?? run.status)}</span>
        </span>
        <ExternalLink className="h-3.5 w-3.5 text-theme-subtle" />
      </Link>
    </>
  );
}

function ArtifactLinks({ run, context }: { run: SpawnedAgent; context: RunStatus | null }) {
  const artifacts = artifactsForRun(run, context);
  const [expanded, setExpanded] = useState(false);
  const [selectedArtifact, setSelectedArtifact] = useState<ArtifactDoc | null>(null);
  const [loadingArtifactId, setLoadingArtifactId] = useState<string | null>(null);

  async function openArtifact(artifact: RunStatus['artifacts'][number]) {
    setLoadingArtifactId(artifact.artifactId);
    try {
      setSelectedArtifact(await artifactsApi.get(artifact.artifactId));
    } catch {
      setSelectedArtifact(fallbackArtifactDoc(artifact, run));
    } finally {
      setLoadingArtifactId(null);
    }
  }

  if (artifacts.length === 0) return null;
  return (
    <section className="cr-section">
      <button type="button" className="cr-section-toggle" onClick={() => setExpanded(value => !value)}>
        <h6>
          artifacts
          <span className="cr-ct">{artifacts.length}</span>
        </h6>
        {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
      </button>
      {expanded && (
        <div className="cr-section-body">
          {artifacts.map((artifact) => {
            const isLoading = loadingArtifactId === artifact.artifactId;
            return (
              <button
                key={artifact.artifactId}
                type="button"
                onClick={() => openArtifact(artifact)}
                className={`cr-art ${isLoading ? 'loading' : ''}`}
              >
                <span className="cr-art-ic"><FileText className="h-3 w-3" /></span>
                <span className="cr-art-body">
                  <span className="cr-art-h">
                    <span className="cr-art-tag">{artifactTypeLabel(artifact)}</span>
                    <span className="cr-art-v">v1</span>
                  </span>
                  <span className="cr-art-title">{artifact.filename ?? artifact.relativePath ?? 'Artifact'}</span>
                  <span className="cr-art-sub">edited {timeAgo(artifact.createdAt)}</span>
                </span>
                {isLoading ? <Loader2 className="h-3 w-3 animate-spin text-theme-subtle" /> : <FileText className="h-3 w-3 text-theme-subtle" />}
              </button>
            );
          })}
        </div>
      )}
      {selectedArtifact && (
        <div className="artifact-modal-backdrop" role="dialog" aria-modal="true" aria-label="Artifact viewer">
          <div className="artifact-modal">
            <ArtifactViewer
              artifact={selectedArtifact}
              onClose={() => setSelectedArtifact(null)}
              showExternalLink={false}
            />
          </div>
        </div>
      )}
    </section>
  );
}

function ExecutionStep({ run, index, isLast }: { run: SpawnedAgent; index: number; isLast: boolean }) {
  const context = run.runContext ?? null;
  const state = runState(context, run);
  const percent = Math.max(0, Math.min(100, context?.progress.percent ?? 0));
  const title = context?.title ?? run.agent;
  const currentStep = context?.progress.currentStep ?? context?.progress.label ?? run.prompt ?? 'Waiting for activity';
  const childSteps = compactSteps(context).slice(-3);
  const cost = formatCost(context?.execution.cost);

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
            <div className="mt-1 font-mono text-[10.5px] text-theme-muted">{runKindLabel(context, run)} · {cost} · {expectedOutcome(context)}</div>
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
  const attemptRuns = sortedRuns;
  const showAttempts = attemptRuns.length > 1;
  const showWorkflowNodes = !showAttempts && activeContext?.runType === 'workflow' && (activeContext.workflowSteps?.length ?? 0) > 0;

  if (!activeRun) return null;

  const percent = Math.max(0, Math.min(100, activeContext?.progress.percent ?? 0));
  const activeCost = showAttempts ? formatRunSequenceCost(attemptRuns) : formatCost(activeContext?.execution.cost);

  return (
    <aside className="chat-rail hidden h-full w-[320px] shrink-0 xl:flex">
      <div className="cr-head">
        <h5>{sortedRuns.length > 1 ? 'task sequence' : 'this task'}</h5>
        <Link to={`/executions/${activeRun.executionId}`} className="cr-close" title="Open full execution trace">
          <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      </div>

      <section className="cr-progress">
        <div className="cr-prog-row">
          <span>progress</span>
          <span className="mono">{percent}%</span>
        </div>
        <div className="bar">
          <span style={{ width: `${percent}%` }} />
        </div>
        <div className="cr-prog-row sub">
          <span>status</span>
          <span className="mono">{humanLabel(activeContext?.status ?? activeRun.status)}</span>
        </div>
        <div className="cr-prog-row sub">
          <span>current</span>
          <span className="mono">{activeContext?.progress.currentStep ?? activeContext?.progress.label ?? 'done'}</span>
        </div>
        <div className="cr-prog-row sub">
          <span>cost</span>
          <span className="mono">{activeCost}</span>
        </div>
      </section>

      <ArtifactLinks run={activeRun} context={activeContext} />

      <RailSection title="references">
        <ReferenceLinks run={activeRun} context={activeContext} />
      </RailSection>

      {showAttempts && (
        <RailSection title="attempts" count={`${attemptRuns.length}`}>
          <div className="cr-steps">
            {attemptRuns.map((run, index) => (
              <AttemptRow key={run.executionId} run={run} index={index} />
            ))}
          </div>
        </RailSection>
      )}

      {showWorkflowNodes ? (
        <>
          <RailSection title="steps" count={`${activeContext?.progress.completed ?? 0}/${activeContext?.progress.total ?? activeContext?.workflowSteps.length}`}>
            <div className="cr-steps">
              {activeContext!.workflowSteps.map((step, index) => (
                <WorkflowNodeStep key={step.id} step={step} isLast={index === activeContext!.workflowSteps.length - 1} />
              ))}
            </div>
          </RailSection>
        </>
      ) : !showAttempts ? (
        <RailSection title="steps" count={`${sortedRuns.length}`}>
          <div className="cr-steps">
            {sortedRuns.map((run, index) => (
              <ExecutionStep key={run.executionId} run={run} index={index} isLast={index === sortedRuns.length - 1} />
            ))}
          </div>
        </RailSection>
      ) : null}

      {activeContext?.childAgents && activeContext.childAgents.length > 0 && (
        <RailSection title="agents">
          <div className="space-y-1">
            {activeContext.childAgents.map(child => (
              <Link
                key={child.executionId}
                to={`/executions/${child.executionId}`}
                className="flex items-center justify-between gap-2 rounded border border-app bg-app-card px-2 py-1.5 text-[10.5px] text-theme-muted transition-colors hover:bg-app-muted hover:text-accent"
              >
                <span className="truncate">{child.agentName}</span>
                <span className="inline-flex shrink-0 items-center gap-1">
                  <span className="font-mono text-[10px] text-theme-subtle">{formatCost(child.cost)}</span>
                  <StatusBadge status={child.status} />
                  <ExternalLink className="h-3.5 w-3.5 text-theme-subtle" />
                </span>
              </Link>
            ))}
          </div>
        </RailSection>
      )}

      {(activeContext?.humanInput.required || activeContext?.pullRequest?.url) && (
        <RailSection title="actions">
          <div className="cr-acts">
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
