import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  Bot,
  Columns2,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  ExternalLink,
  FileText,
  FolderOpen,
  HelpCircle,
  FolderGit2,
  GitBranch,
  Loader2,
  Maximize2,
  Minimize2,
  PanelRightClose,
  PlayCircle,
  Rows3,
  StopCircle,
  Timer,
  X,
} from 'lucide-react';
import type { SpawnedAgent } from '../../hooks/useChat';
import { artifacts as artifactsApi, type ArtifactDoc, type RunStatus } from '../../services/api';
import { workspaces as workspacesApi } from '../../services/workspaceService';
import ArtifactViewer from '../artifacts/ArtifactViewer';

const FAILED_STATUSES = new Set(['failed', 'failure', 'error', 'errored']);
const CANCELLED_STATUSES = new Set(['cancelled', 'canceled']);

export type ChatRunPanelTab = 'tasks' | 'artifacts' | 'executions' | 'files';

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

type PanelArtifactItem = {
  artifactId: string;
  filename?: string | null;
  relativePath?: string | null;
  contentType?: string | null;
  createdAt?: string | null;
  sourceRun?: SpawnedAgent;
  runtimeArtifact?: RunStatus['artifacts'][number];
};

type PanelDiffFile = {
  path: string;
  status?: string;
  additions?: number;
  deletions?: number;
  diff?: string;
  originalContent?: string;
  modifiedContent?: string;
  workspaceId: string;
  workspaceName?: string | null;
};

type WorkspaceFileEntry = {
  path: string;
  isDir?: boolean;
  status?: string;
};

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function dirname(path: string): string {
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

type FileTreeStatus = 'modified' | 'added';

type FileTreeNode = {
  name: string;
  path: string;
  isDir: boolean;
  children: FileTreeNode[];
  entry?: WorkspaceFileEntry;
  status?: FileTreeStatus;
};

function mergeTreeStatus(current: FileTreeStatus | undefined, next: FileTreeStatus | undefined): FileTreeStatus | undefined {
  if (!next) return current;
  if (current === 'modified' || next === 'modified') return 'modified';
  return 'added';
}

function normalizeFileStatus(status?: string | null): FileTreeStatus | undefined {
  const normalized = (status ?? '').toLowerCase();
  if (normalized.includes('new') || normalized.includes('add') || normalized === 'a') return 'added';
  if (normalized.includes('mod') || normalized.includes('change') || normalized === 'm') return 'modified';
  return undefined;
}

function changedFileStatus(file: PanelDiffFile): FileTreeStatus {
  return normalizeFileStatus(file.status) ?? (file.diff?.includes('new file mode') ? 'added' : 'modified');
}

function buildFileTree(files: WorkspaceFileEntry[], changedStatuses: ReadonlyMap<string, FileTreeStatus>): FileTreeNode[] {
  const root: FileTreeNode = { name: '', path: '', isDir: true, children: [] };
  const byPath = new Map<string, FileTreeNode>([['', root]]);
  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean);
    let parent = root;
    let currentPath = '';
    const fileStatus = changedStatuses.get(file.path) ?? normalizeFileStatus(file.status);
    parts.forEach((part, index) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isLeaf = index === parts.length - 1;
      const isDir = !isLeaf || Boolean(file.isDir);
      let node = byPath.get(currentPath);
      if (!node) {
        node = { name: part, path: currentPath, isDir, children: [] };
        byPath.set(currentPath, node);
        parent.children.push(node);
      }
      node.status = mergeTreeStatus(node.status, fileStatus);
      if (isLeaf) {
        node.entry = file;
        node.status = mergeTreeStatus(node.status, fileStatus);
      }
      parent = node;
    });
  }
  const sort = (nodes: FileTreeNode[]) => {
    nodes.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    nodes.forEach(node => sort(node.children));
  };
  sort(root.children);
  return root.children;
}

type DiffRow = {
  kind: 'context' | 'add' | 'del' | 'hunk';
  oldLine?: number;
  newLine?: number;
  oldText?: string;
  newText?: string;
  text?: string;
};

type SplitCellKind = 'context' | 'add' | 'del' | 'empty';
type SplitDisplayRow =
  | { kind: 'hunk'; text: string }
  | {
      kind: 'row';
      oldLine?: number;
      newLine?: number;
      oldText?: string;
      newText?: string;
      oldKind: SplitCellKind;
      newKind: SplitCellKind;
    };

function parseDiffRows(file: PanelDiffFile): DiffRow[] {
  if (!file.diff?.trim()) {
    const oldLines = (file.originalContent ?? '').split('\n');
    const newLines = (file.modifiedContent ?? '').split('\n');
    if (file.originalContent && file.modifiedContent) {
      return [
        ...oldLines.map((line, index) => ({ kind: 'del' as const, oldLine: index + 1, oldText: line })),
        ...newLines.map((line, index) => ({ kind: 'add' as const, newLine: index + 1, newText: line })),
      ];
    }
    return newLines.map((line, index) => ({ kind: 'context' as const, oldLine: index + 1, newLine: index + 1, oldText: line, newText: line }));
  }

  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const raw of file.diff.split('\n')) {
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('diff --git') || raw.startsWith('index ')) continue;
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ kind: 'hunk', text: raw });
      continue;
    }
    if (raw.startsWith('+')) {
      rows.push({ kind: 'add', newLine, newText: raw.slice(1) });
      newLine += 1;
      continue;
    }
    if (raw.startsWith('-')) {
      rows.push({ kind: 'del', oldLine, oldText: raw.slice(1) });
      oldLine += 1;
      continue;
    }
    const text = raw.startsWith(' ') ? raw.slice(1) : raw;
    rows.push({ kind: 'context', oldLine, newLine, oldText: text, newText: text });
    oldLine += 1;
    newLine += 1;
  }
  return rows;
}

function buildSplitRows(rows: DiffRow[]): SplitDisplayRow[] {
  const out: SplitDisplayRow[] = [];
  for (let i = 0; i < rows.length;) {
    const row = rows[i];
    if (row.kind === 'hunk') {
      out.push({ kind: 'hunk', text: row.text ?? '' });
      i += 1;
      continue;
    }
    if (row.kind === 'context') {
      out.push({
        kind: 'row',
        oldLine: row.oldLine,
        newLine: row.newLine,
        oldText: row.oldText ?? row.text ?? '',
        newText: row.newText ?? row.text ?? '',
        oldKind: 'context',
        newKind: 'context',
      });
      i += 1;
      continue;
    }

    const deleted: DiffRow[] = [];
    const added: DiffRow[] = [];
    while (i < rows.length && (rows[i].kind === 'del' || rows[i].kind === 'add')) {
      if (rows[i].kind === 'del') deleted.push(rows[i]);
      if (rows[i].kind === 'add') added.push(rows[i]);
      i += 1;
    }
    const length = Math.max(deleted.length, added.length);
    for (let j = 0; j < length; j += 1) {
      const oldRow = deleted[j];
      const newRow = added[j];
      out.push({
        kind: 'row',
        oldLine: oldRow?.oldLine,
        newLine: newRow?.newLine,
        oldText: oldRow?.oldText ?? '',
        newText: newRow?.newText ?? '',
        oldKind: oldRow ? 'del' : 'empty',
        newKind: newRow ? 'add' : 'empty',
      });
    }
  }
  return out;
}

function UnifiedDiffView({ file }: { file: PanelDiffFile }) {
  const rows = parseDiffRows(file);
  return (
    <div className="cr-diff-code unified">
      {rows.map((row, index) => (
        <div key={index} className={`cr-diff-row ${row.kind}`}>
          <span className="ln">{row.oldLine ?? row.newLine ?? ''}</span>
          <code>{row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : row.kind === 'hunk' ? '' : ' '}{row.text ?? row.newText ?? row.oldText ?? ''}</code>
        </div>
      ))}
    </div>
  );
}

function SplitDiffView({ file }: { file: PanelDiffFile }) {
  const rows = buildSplitRows(parseDiffRows(file));
  return (
    <div className="cr-diff-code split">
      {rows.map((row, index) => {
        if (row.kind === 'hunk') {
          return (
            <div key={index} className="cr-split-row hunk">
              <span className="cr-split-hunk">{row.text}</span>
            </div>
          );
        }
        return (
          <div key={index} className="cr-split-row">
            <span className={`ln old ${row.oldKind}`}>{row.oldLine ?? ''}</span>
            <code className={`old ${row.oldKind}`}>{row.oldText ?? ''}</code>
            <span className={`ln new ${row.newKind}`}>{row.newLine ?? ''}</span>
            <code className={`new ${row.newKind}`}>{row.newText ?? ''}</code>
          </div>
        );
      })}
    </div>
  );
}

function PanelTabs({
  activeTab,
  onTabChange,
  counts,
}: {
  activeTab: ChatRunPanelTab;
  onTabChange: (tab: ChatRunPanelTab) => void;
  counts: Partial<Record<ChatRunPanelTab, number>>;
}) {
  const tabs: Array<{ id: ChatRunPanelTab; label: string }> = [
    { id: 'tasks', label: 'Tasks' },
    { id: 'executions', label: 'Executions' },
    { id: 'artifacts', label: 'Artifacts' },
    { id: 'files', label: 'Files' },
  ];
  return (
    <div className="cr-tabs" role="tablist" aria-label="Chat resources">
      {tabs.map(tab => (
        <button
          key={tab.id}
          type="button"
          className={activeTab === tab.id ? 'active' : ''}
          onClick={() => onTabChange(tab.id)}
        >
          <span>{tab.label}</span>
          {counts[tab.id] != null && counts[tab.id]! > 0 && <span className="cr-ct">{counts[tab.id]}</span>}
        </button>
      ))}
    </div>
  );
}

function ChatArtifactsPanel({
  rootType,
  rootId,
  runs,
}: {
  rootType?: 'chat' | 'workflow' | 'agent';
  rootId?: string | null;
  runs: SpawnedAgent[];
}) {
  const [items, setItems] = useState<PanelArtifactItem[]>([]);
  const [selectedArtifact, setSelectedArtifact] = useState<ArtifactDoc | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);

  const runtimeItems = useMemo(() => {
    const next: PanelArtifactItem[] = [];
    for (const run of runs) {
      for (const artifact of artifactsForRun(run, run.runContext ?? null)) {
        next.push({
          artifactId: artifact.artifactId,
          filename: artifact.filename,
          relativePath: artifact.relativePath,
          contentType: artifact.contentType,
          createdAt: artifact.createdAt,
          sourceRun: run,
          runtimeArtifact: artifact,
        });
      }
    }
    return next;
  }, [runs]);

  useEffect(() => {
    if (!rootType || !rootId) {
      setItems([]);
      return;
    }
    let cancelled = false;
    artifactsApi.list({ rootType, rootId, limit: 50 })
      .then(list => {
        if (cancelled) return;
        setItems(list.map(item => ({
          artifactId: item.artifactId,
          filename: item.filename,
          relativePath: item.relativePath,
          contentType: item.contentType,
          createdAt: item.createdAt,
        })));
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => { cancelled = true; };
  }, [rootType, rootId]);

  const merged = useMemo(() => {
    const seen = new Set<string>();
    return [...items, ...runtimeItems].filter(item => {
      if (seen.has(item.artifactId)) return false;
      seen.add(item.artifactId);
      return true;
    });
  }, [items, runtimeItems]);

  async function openArtifact(item: PanelArtifactItem) {
    setLoadingId(item.artifactId);
    try {
      setSelectedArtifact(await artifactsApi.get(item.artifactId));
    } catch {
      if (item.runtimeArtifact && item.sourceRun) {
        setSelectedArtifact(fallbackArtifactDoc(item.runtimeArtifact, item.sourceRun));
      }
    } finally {
      setLoadingId(null);
    }
  }

  useEffect(() => {
    if (selectedArtifact || merged.length === 0) return;
    void openArtifact(merged[0]);
  }, [merged, selectedArtifact]);

  if (merged.length === 0) {
    return <div className="cr-empty">No artifacts have been saved for this chat yet.</div>;
  }

  return (
    <div className="cr-artifacts-panel">
      <div className="cr-files-summary">
        <button type="button" className={listOpen ? 'active' : ''} onClick={() => setListOpen(value => !value)}>
          <FileText className="h-3.5 w-3.5" />
          <span>{listOpen ? 'Hide list' : `${merged.length} artifacts`}</span>
        </button>
      </div>
      <div className={`cr-split-workspace artifacts ${listOpen ? '' : 'collapsed-list'}`}>
        {listOpen && (
          <div className="cr-list cr-side-list">
            {merged.map(item => (
              <button
                key={item.artifactId}
                type="button"
                className={`cr-list-row ${selectedArtifact?.artifactId === item.artifactId ? 'active' : ''}`}
                onClick={() => openArtifact(item)}
              >
                <span className="cr-ref-ic repo"><FileText className="h-3 w-3" /></span>
                <span className="cr-list-body">
                  <span className="cr-list-title">{item.filename ?? item.relativePath ?? 'Artifact'}</span>
                  <span className="cr-list-sub">{humanLabel(item.contentType ?? 'file')} · {timeAgo(item.createdAt)}</span>
                </span>
                {loadingId === item.artifactId ? <Loader2 className="h-3.5 w-3.5 animate-spin text-theme-subtle" /> : <ChevronRight className="h-3.5 w-3.5 text-theme-subtle" />}
              </button>
            ))}
          </div>
        )}
        <div className="cr-inline-viewer">
          {selectedArtifact ? (
            <ArtifactViewer
              artifact={selectedArtifact}
              onClose={() => setSelectedArtifact(null)}
              showExternalLink
            />
          ) : (
            <div className="cr-empty">Select an artifact to preview it here.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function CodeBlockPanel({ title, text }: { title: string; text?: string | null }) {
  const content = text?.trim();
  return (
    <details className="cr-io-block" open={Boolean(content)}>
      <summary>{title}</summary>
      {content ? <pre>{content}</pre> : <div className="cr-empty small">No {title.toLowerCase()} captured for this execution.</div>}
    </details>
  );
}

function ExecutionIO({ run }: { run: SpawnedAgent }) {
  const context = run.runContext ?? null;
  const input = context?.io?.input ?? run.prompt;
  const output = context?.io?.output ?? run.response;
  return (
    <div className="cr-exec-io">
      <CodeBlockPanel title="Input" text={input} />
      <CodeBlockPanel title="Output" text={output} />
    </div>
  );
}

function ChildExecutionRow({ child }: { child: NonNullable<RunStatus['childAgents']>[number] }) {
  return (
    <Link to={`/executions/${child.executionId}`} className="cr-child-row">
      <span className="truncate">{child.agentName}</span>
      <span>{humanLabel(child.status)} · {formatCost(child.cost)}</span>
    </Link>
  );
}

function ExecutionDetailInline({ run, index }: { run: SpawnedAgent; index: number }) {
  const context = run.runContext ?? null;
  const status = context?.status ?? run.status;
  const childAgents = context?.childAgents ?? [];
  const agentName = run.agent || context?.title || 'agent';

  return (
    <details className="cr-exec-detail" open={index === 0}>
      <summary>
        <ChevronRight className="cr-disclosure-icon h-3.5 w-3.5" />
        <span className="cr-ref-ic repo"><RunExecutionIcon context={context} /></span>
        <span className="cr-list-body">
          <span className="cr-list-title">Execution {index + 1}: {agentName}</span>
          <span className="cr-list-sub">{runExecutionLabel(context)} · {humanLabel(status)} · {formatCost(context?.execution.cost)}</span>
          {context?.title && context.title !== agentName && <span className="cr-list-sub">{context.title}</span>}
        </span>
        <Link to={`/executions/${run.executionId}`} className="cr-detail-link" title="Open full execution page" onClick={(event) => event.stopPropagation()}>
          <span>See detailed execution</span>
          <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      </summary>
      <ExecutionIO run={run} />
      {childAgents.length > 0 && (
        <div className="cr-child-list inline">
          {childAgents.map(child => <ChildExecutionRow key={child.executionId} child={child} />)}
        </div>
      )}
    </details>
  );
}

function ExecutionsPanel({ runs }: { runs: SpawnedAgent[] }) {
  if (runs.length === 0) return <div className="cr-empty">No agent executions are linked to this chat yet.</div>;
  return (
    <div className="cr-exec-list">
      {runs.map((run, index) => (
        <ExecutionDetailInline key={run.executionId} run={run} index={index} />
      ))}
    </div>
  );
}

function FileTreeNodeView({
  node,
  activePath,
  onOpenFile,
  depth = 0,
}: {
  node: FileTreeNode;
  activePath: string;
  onOpenFile: (path: string) => void;
  depth?: number;
}) {
  if (node.isDir) {
    return (
      <details className={`cr-tree-dir ${node.status ?? ''}`}>
        <summary style={{ paddingLeft: 8 + depth * 12 }}>
          <ChevronRight className="cr-disclosure-icon h-3.5 w-3.5" />
          <FolderOpen className="h-3.5 w-3.5" />
          <span>{node.name}</span>
        </summary>
        <div>
          {node.children.map(child => (
            <FileTreeNodeView
              key={child.path}
              node={child}
              activePath={activePath}
              onOpenFile={onOpenFile}
              depth={depth + 1}
            />
          ))}
        </div>
      </details>
    );
  }
  return (
    <button
      type="button"
      className={`cr-tree-file ${node.status ?? ''} ${activePath === node.path ? 'active' : ''}`}
      style={{ paddingLeft: 20 + depth * 12 }}
      onClick={() => onOpenFile(node.path)}
    >
      <FileText className="h-3.5 w-3.5" />
      <span className="truncate">{node.name}</span>
      {node.entry?.status && <span className="cr-tree-status">{node.entry.status}</span>}
    </button>
  );
}

function FileChangesPanel({ runs }: { runs: SpawnedAgent[] }) {
  const [files, setFiles] = useState<PanelDiffFile[]>([]);
  const [diffMode, setDiffMode] = useState<'split' | 'unified'>('unified');
  const [view, setView] = useState<'changes' | 'browser'>('changes');
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFileEntry[]>([]);
  const [browserPath, setBrowserPath] = useState('');
  const [browserContent, setBrowserContent] = useState('');
  const [fileLoading, setFileLoading] = useState(false);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [loading, setLoading] = useState(false);

  const workspaceRefs = useMemo(() => {
    const refs: Array<{ id: string; name?: string | null; mode: 'auto' | 'branch' }> = [];
    for (const run of runs) {
      const id = run.runContext?.workspace?.id;
      if (!id) continue;
      refs.push({
        id,
        name: run.runContext?.workspace?.name ?? run.runContext?.workspace?.repoName,
        mode: run.runContext?.pullRequest ? 'branch' : 'auto',
      });
    }
    return refs.reduce<Array<{ id: string; name?: string | null; mode: 'auto' | 'branch' }>>((acc, ref) => {
      const existing = acc.find(item => item.id === ref.id);
      if (!existing) acc.push(ref);
      else if (ref.mode === 'branch') existing.mode = 'branch';
      return acc;
    }, []);
  }, [runs]);

  const signature = workspaceRefs.map(ref => `${ref.id}:${ref.mode}`).join('|');

  useEffect(() => {
    if (!signature) {
      setFiles([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    Promise.all(workspaceRefs.map(async ref => {
      try {
        const result = await workspacesApi.getDiff(ref.id, { mode: ref.mode });
        return ((result.files ?? []) as Array<Omit<PanelDiffFile, 'workspaceId' | 'workspaceName'>>)
          .filter(file => file.diff?.trim() || file.modifiedContent?.trim())
          .map(file => ({ ...file, workspaceId: ref.id, workspaceName: ref.name }));
      } catch {
        return [];
      }
    })).then(groups => {
      if (!cancelled) setFiles(groups.flat());
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [signature, workspaceRefs]);

  const additions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  const activeWorkspace = workspaceRefs[0] ?? null;
  const changedStatuses = useMemo(() => new Map(files.map(file => [file.path, changedFileStatus(file)])), [files]);
  const fileTree = useMemo(() => buildFileTree(workspaceFiles, changedStatuses), [workspaceFiles, changedStatuses]);
  const browserDiffFile = files.find(file => file.path === browserPath) ?? null;

  useEffect(() => {
    if (!activeWorkspace?.id || view !== 'browser') return;
    let cancelled = false;
    setBrowserLoading(true);
    workspacesApi.getAllFiles(activeWorkspace.id)
      .then(result => {
        if (!cancelled) setWorkspaceFiles((result ?? []) as WorkspaceFileEntry[]);
      })
      .catch(() => {
        if (!cancelled) setWorkspaceFiles([]);
      })
      .finally(() => {
        if (!cancelled) setBrowserLoading(false);
      });
    return () => {
      cancelled = true;
      setBrowserLoading(false);
    };
  }, [activeWorkspace?.id, view]);

  async function openBrowserFile(path: string) {
    if (!activeWorkspace?.id) return;
    setBrowserPath(path);
    if (changedStatuses.has(path)) {
      setBrowserContent('');
      return;
    }
    setFileLoading(true);
    try {
      const file = await workspacesApi.getFile(activeWorkspace.id, path);
      setBrowserContent(file.isImage ? '[binary image preview is available in the workspace editor]' : file.content ?? '');
    } catch (err) {
      setBrowserContent(`Failed to load ${path}: ${(err as Error).message}`);
    } finally {
      setFileLoading(false);
    }
  }

  if (loading) return <div className="cr-empty">Checking workspace changes...</div>;
  if (files.length === 0 && workspaceRefs.length === 0) return <div className="cr-empty">No file changes are linked to this chat yet.</div>;

  return (
    <div className="cr-files-panel">
      <div className="cr-files-summary">
        <button type="button" className={view === 'changes' ? 'active' : ''} onClick={() => setView('changes')}>
          <FileText className="h-3.5 w-3.5" />
          <span>{files.length} changed</span>
        </button>
        <button type="button" className={view === 'browser' ? 'active' : ''} onClick={() => setView('browser')} disabled={!activeWorkspace}>
          <FolderOpen className="h-3.5 w-3.5" />
          <span>Browse</span>
        </button>
        <span className="spacer" />
        {view === 'changes' && (
          <>
            <span className="add">+{additions}</span>
            <span className="del">-{deletions}</span>
            <button type="button" className={diffMode === 'split' ? 'active icon' : 'icon'} onClick={() => setDiffMode('split')} title="Side-by-side diff">
              <Columns2 className="h-3.5 w-3.5" />
            </button>
            <button type="button" className={diffMode === 'unified' ? 'active icon' : 'icon'} onClick={() => setDiffMode('unified')} title="Unified diff">
              <Rows3 className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>

      {view === 'changes' ? (
        <div className="cr-file-stack">
          {files.map((file, index) => (
            <details key={`${file.workspaceId}:${file.path}:${index}`} className="cr-file-detail cr-diff-file" open={index === 0}>
              <summary>
                <ChevronRight className="cr-disclosure-icon h-3.5 w-3.5" />
                <span className="cr-file-main">
                  <span className="cr-file-name">{file.path}</span>
                  <span className="cr-file-dir">{dirname(file.path) || file.workspaceName || 'workspace'}</span>
                </span>
                <span className="cr-file-counts">
                  <span className="add">+{file.additions ?? 0}</span>
                  <span className="del">-{file.deletions ?? 0}</span>
                </span>
              </summary>
              <div className="cr-file-detail-diff">
                {diffMode === 'split' ? <SplitDiffView file={file} /> : <UnifiedDiffView file={file} />}
              </div>
            </details>
          ))}
          {files.length === 0 && (
            <div className="cr-empty">No changed files were found in the linked workspaces.</div>
          )}
        </div>
      ) : (
        <div className="cr-split-workspace files browse">
          <div className="cr-file-list cr-side-list">
            {browserLoading ? (
              <div className="cr-loading-state small">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>Loading files...</span>
              </div>
            ) : (
              <>
                {fileTree.map(node => (
                  <FileTreeNodeView
                    key={node.path}
                    node={node}
                    activePath={browserPath}
                    onOpenFile={openBrowserFile}
                  />
                ))}
                {workspaceFiles.length === 0 && <div className="cr-empty small">No files found for this workspace.</div>}
              </>
            )}
          </div>
          <div className="cr-file-viewer">
            <div className="cr-file-viewer-head">
              <span className="truncate">{browserPath || activeWorkspace?.name || 'Workspace files'}</span>
              {browserDiffFile && (
                <>
                  <span className="add">+{browserDiffFile.additions ?? 0}</span>
                  <span className="del">-{browserDiffFile.deletions ?? 0}</span>
                </>
              )}
            </div>
            {browserLoading ? (
              <div className="cr-loading-state">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Loading workspace files...</span>
              </div>
            ) : fileLoading ? (
              <div className="cr-loading-state">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Loading file...</span>
              </div>
            ) : browserDiffFile ? (
              <div className="cr-file-detail-diff browse-diff">
                {diffMode === 'split' ? <SplitDiffView file={browserDiffFile} /> : <UnifiedDiffView file={browserDiffFile} />}
              </div>
            ) : (
              <pre className="cr-file-content">{browserContent || 'Select a file to preview it here.'}</pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function TasksPanel({
  activeRun,
  activeContext,
  sortedRuns,
}: {
  activeRun: SpawnedAgent;
  activeContext: RunStatus | null;
  sortedRuns: SpawnedAgent[];
}) {
  const attemptRuns = sortedRuns;
  const showAttempts = attemptRuns.length > 1;
  const showWorkflowNodes = !showAttempts && activeContext?.runType === 'workflow' && (activeContext.workflowSteps?.length ?? 0) > 0;

  const percent = Math.max(0, Math.min(100, activeContext?.progress.percent ?? 0));
  const activeCost = showAttempts ? formatRunSequenceCost(attemptRuns) : formatCost(activeContext?.execution.cost);

  return (
    <>
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
    </>
  );
}

export default function ChatRunSidebar({
  runs,
  rootType,
  rootId,
  open,
  activeTab,
  onTabChange,
  onClose,
}: {
  runs: SpawnedAgent[];
  rootType?: 'chat' | 'workflow' | 'agent';
  rootId?: string | null;
  open: boolean;
  activeTab: ChatRunPanelTab;
  onTabChange: (tab: ChatRunPanelTab) => void;
  onClose: () => void;
}) {
  const sortedRuns = useMemo(() => [...runs], [runs]);
  const [width, setWidth] = useState(() => {
    if (typeof window === 'undefined') return 720;
    return Math.max(520, Math.min(760, Math.round(window.innerWidth * 0.42)));
  });
  const [fullScreen, setFullScreen] = useState(false);
  const activeRun = sortedRuns.find(run => {
    const status = (run.runContext?.status ?? run.status ?? '').toLowerCase();
    return !['completed', 'failed', 'cancelled', 'canceled'].includes(status);
  }) ?? sortedRuns[sortedRuns.length - 1] ?? null;
  const activeContext = activeRun?.runContext ?? null;
  const runtimeArtifactCount = sortedRuns.reduce((sum, run) => sum + artifactsForRun(run, run.runContext ?? null).length, 0);
  const childExecutionCount = sortedRuns.reduce((sum, run) => sum + (run.runContext?.childAgents.length ?? 0), 0);
  const workspaceCount = new Set(sortedRuns.map(run => run.runContext?.workspace?.id).filter(Boolean)).size;
  const counts: Partial<Record<ChatRunPanelTab, number>> = {
    tasks: sortedRuns.length,
    executions: sortedRuns.length + childExecutionCount,
    artifacts: runtimeArtifactCount,
    files: workspaceCount,
  };

  if (!open) return null;

  function startResize(event: ReactMouseEvent<HTMLDivElement>) {
    if (fullScreen) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const onMove = (moveEvent: MouseEvent) => {
      const delta = startX - moveEvent.clientX;
      const max = Math.max(560, window.innerWidth - 360);
      setWidth(Math.max(420, Math.min(max, startWidth + delta)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  return (
    <aside className={`chat-rail ${fullScreen ? 'fullscreen' : ''}`} style={fullScreen ? undefined : { width }}>
      {!fullScreen && <div className="chat-rail-resize" onMouseDown={startResize} title="Drag to resize" />}
      <div className="cr-head">
        <h5>Chat resources</h5>
        <div className="cr-head-actions">
          <button type="button" className="cr-close" onClick={() => setFullScreen(value => !value)} title={fullScreen ? 'Exit full screen' : 'Expand side panel'}>
            {fullScreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
          <button type="button" className="cr-close" onClick={onClose} title="Close side panel">
            <PanelRightClose className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <PanelTabs activeTab={activeTab} onTabChange={onTabChange} counts={counts} />

      <div className={`cr-panel-body ${activeTab}`}>
        {activeTab === 'tasks' && (
          activeRun
            ? <TasksPanel activeRun={activeRun} activeContext={activeContext} sortedRuns={sortedRuns} />
            : <div className="cr-empty">No task sequence is linked to this chat yet.</div>
        )}
        {activeTab === 'executions' && <ExecutionsPanel runs={sortedRuns} />}
        {activeTab === 'artifacts' && <ChatArtifactsPanel rootType={rootType} rootId={rootId} runs={sortedRuns} />}
        {activeTab === 'files' && <FileChangesPanel runs={sortedRuns} />}
      </div>
    </aside>
  );
}
