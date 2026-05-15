import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import Editor from '@monaco-editor/react';
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
  ListTree,
  Maximize2,
  Minimize2,
  PanelRightClose,
  PlayCircle,
  Route,
  Rows3,
  StopCircle,
  Timer,
  Code2,
  X,
} from 'lucide-react';
import type { SpawnedAgent } from '../../hooks/useChat';
import { artifacts as artifactsApi, repos as reposApi, type ArtifactDoc, type RunStatus } from '../../services/api';
import { chatCodeDiffs, pullRequests as pullRequestsApi, workspaces as workspacesApi } from '../../services/workspaceService';
import { getMonacoTheme, setupMonaco } from '../../lib/monaco-theme';
import ArtifactViewer from '../artifacts/ArtifactViewer';
import { renderMarkdown } from './ChatMessageList';

const FAILED_STATUSES = new Set(['failed', 'failure', 'error', 'errored']);
const CANCELLED_STATUSES = new Set(['cancelled', 'canceled']);

export type ChatRunPanelTab = 'tasks' | 'artifacts' | 'executions' | 'files';

type RepoBrowseSource = {
  id?: string | null;
  name?: string | null;
  path?: string | null;
};

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

function safeRunName(value?: string | null): string | null {
  const text = value?.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (text.length > 72) return null;
  if (/^(you are|your task|task:|fix the|please|implement the)\b/i.test(text)) return null;
  if (/[{}]/.test(text)) return null;
  return text;
}

function runDisplayName(context: RunStatus | null, fallback?: SpawnedAgent | null): string {
  const safeTitle = safeRunName(context?.title);
  const safeAgent = safeRunName(fallback?.agent);
  const safeWorkflow = safeRunName(context?.execution.workflowName);
  const safeProgress = safeRunName(context?.progress.label);
  if (context?.runType === 'workflow') {
    return safeWorkflow || safeProgress || safeTitle || safeAgent || 'workflow';
  }
  if (context?.runType === 'agent') {
    return safeAgent || safeWorkflow || safeProgress || safeTitle || 'agent execution';
  }
  if (context?.childAgents.length || fallback?.kind === 'lead') {
    return safeAgent || safeTitle || 'lead agent';
  }
  return safeAgent || safeProgress || safeTitle || 'execution';
}

function runTypeName(context: RunStatus | null, fallback?: SpawnedAgent | null): string {
  const name = runDisplayName(context, fallback);
  if (context?.runType === 'workflow') return `Workflow · ${name}`;
  if (context?.runType === 'agent') return `Agent · ${name}`;
  if (context?.childAgents.length || fallback?.kind === 'lead') return `Lead agent · ${name}`;
  return `Execution · ${name}`;
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
  if (normalized === 'completed') return 'ok';
  if (normalized === 'running') return 'run';
  if (normalized === 'waiting_for_input' || normalized === 'waiting') return 'wait-you';
  if (FAILED_STATUSES.has(normalized) || CANCELLED_STATUSES.has(normalized)) return 'fail';
  return 'wait';
}

function nodeDisplayMeta(step: NonNullable<RunStatus['workflowSteps']>[number]): string {
  const normalized = (step.status ?? '').toLowerCase();
  const didNotRun = normalized === 'pending' || normalized === 'skipped' || normalized === 'not_started';
  const actor = step.agent || humanLabel(step.type ?? 'node');
  if (didNotRun) return `${actor} · cancelled`;
  return [
    actor,
    formatDuration(step.durationMs),
    formatCost(step.cost),
  ].filter(Boolean).join(' · ');
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

function WorkflowNodeStep({
  step,
  isLast,
  onOpenDetails,
}: {
  step: NonNullable<RunStatus['workflowSteps']>[number];
  isLast: boolean;
  onOpenDetails?: (nodeId: string) => void;
}) {
  const state = nodeStepState(step.status);
  const canOpenDetails = Boolean(onOpenDetails) && (step.status ?? '').toLowerCase() === 'completed';
  const attempts = Math.max(0, step.attempts ?? 0);
  const meta = nodeDisplayMeta(step);
  const sub = [
    attempts > 1 ? `${attempts} attempts` : null,
    step.model ? String(step.model).replace(/^claude-/, '') : null,
    step.error ? 'error' : null,
  ].filter(Boolean).join(' · ');
  const content = (
    <>
      <span className="step-copy">
        <span className="step-name">{humanLabel(step.name)}</span>
        <span className="step-meta">{meta}</span>
      </span>
      {sub && <span className="step-sub">{sub}</span>}
      {canOpenDetails && <ChevronRight className="step-open-chevron h-3.5 w-3.5" />}
    </>
  );

  return (
    <div className={`step ${state}`}>
      <div className="step-dot">
        {state === 'ok' && '✓'}
        {state === 'run' && <span className="spin">●</span>}
        {state === 'wait' && '○'}
        {state === 'wait-you' && '?'}
        {state === 'fail' && '✕'}
      </div>
      {canOpenDetails ? (
        <button
          type="button"
          className="step-body clickable"
          onClick={() => onOpenDetails?.(step.id)}
          title="Open node input and output"
        >
          {content}
        </button>
      ) : (
        <div className="step-body">{content}</div>
      )}
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

function AttemptRow({
  run,
  index,
  onOpenNode,
  onOpenExecution,
}: {
  run: SpawnedAgent;
  index: number;
  onOpenNode: (executionId: string, nodeId: string) => void;
  onOpenExecution: (executionId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const context = run.runContext ?? null;
  const state = runState(context, run);
  const status = context?.status ?? run.status;
  const cost = formatCost(context?.execution.cost);
  const percent = Math.max(0, Math.min(100, context?.progress.percent ?? (state === 'ok' ? 100 : 0)));
  const kind = runDisplayName(context, run);
  const workflowSteps = context?.runType === 'workflow' ? context.workflowSteps ?? [] : [];
  const isWorkflow = context?.runType === 'workflow';
  const summary =
    !isWorkflow ? humanLabel(status)
      : state === 'fail' ? workflowAttemptFailureLabel(run)
        : state === 'ok' ? 'Passed'
          : context?.progress.currentStep ? `Running ${humanLabel(context.progress.currentStep)}`
            : humanLabel(context?.progress.phase ?? status);
  const executionKind = isWorkflow ? 'Workflow' : context?.runType === 'agent' ? 'Agent' : 'Execution';
  return (
    <div className={`step attempt-step ${state}`}>
      <button
        type="button"
        className="attempt-row"
        onClick={() => {
          if (isWorkflow) setExpanded(value => !value);
          else onOpenExecution(run.executionId);
        }}
      >
        <span className="attempt-row-status">
          <span className="step-dot">
            {state === 'ok' && '✓'}
            {state === 'run' && <span className="spin">●</span>}
            {state === 'wait' && '○'}
            {state === 'wait-you' && '?'}
            {state === 'fail' && '✕'}
          </span>
        </span>
        <span className="attempt-row-main">
          <span className="step-name">Execution {index + 1}: {kind}</span>
          <span className="step-meta">{executionKind} · {summary} · {cost}</span>
        </span>
        <span className="attempt-row-progress" aria-label={`Execution ${index + 1} progress ${percent}%`}>
          <span style={{ width: `${percent}%` }} />
        </span>
        {isWorkflow && expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
      </button>
      <div className="attempt-row-actions">
        <Link to={`/executions/${run.executionId}`} className="step-link-icon" title="Open execution">
          <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      </div>
      {expanded && workflowSteps.length > 0 && (
        <div className="attempt-workflow-steps">
          {workflowSteps.map((step, stepIndex) => (
              <WorkflowNodeStep
                key={step.id}
                step={step}
                isLast={stepIndex === workflowSteps.length - 1}
                onOpenDetails={(nodeId) => onOpenNode(run.executionId, nodeId)}
              />
          ))}
        </div>
      )}
    </div>
  );
}

function ReferenceLinks({ run, context }: { run: SpawnedAgent; context: RunStatus | null }) {
  const pr = context?.pullRequest;
  const hasReferences = Boolean(context?.linear || context?.workspace);
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
    </>
  );
}

function PullRequestTaskCard({ pr }: { pr: NonNullable<RunStatus['pullRequest']> }) {
  const age = timeAgo(pr.mergedAt ?? pr.updatedAt ?? pr.createdAt);
  return (
    <div className="cr-pr-task-card">
      <div className="cr-pr-task-main">
        <span className="cr-pr-task-tag">Pull request</span>
        <span className="cr-pr-task-title">PR {pr.number ? `#${pr.number}` : ''} {humanLabel(pr.status ?? 'open')}</span>
        <span className="cr-pr-task-age">{age}</span>
        {pr.branch && <code className="cr-pr-task-branch">{pr.branch}</code>}
        <div className="cr-pr-task-actions">
          {pr.url && (
            <a href={pr.url} target="_blank" rel="noreferrer" title="Review on GitHub" aria-label="Review on GitHub">
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
          <Link to="/pull-requests" title="Open pull requests" aria-label="Open pull requests">
            <GitBranch className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>
    </div>
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

function diffLineCounts(diff?: string): { additions: number; deletions: number } {
  if (!diff) return { additions: 0, deletions: 0 };
  return diff.split('\n').reduce((acc, line) => {
    if (line.startsWith('+++') || line.startsWith('---')) return acc;
    if (line.startsWith('+')) acc.additions += 1;
    else if (line.startsWith('-')) acc.deletions += 1;
    return acc;
  }, { additions: 0, deletions: 0 });
}

function getLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    mjs: 'javascript', cjs: 'javascript', json: 'json', md: 'markdown', mdx: 'markdown',
    css: 'css', scss: 'scss', less: 'less', html: 'html', xml: 'xml',
    yml: 'yaml', yaml: 'yaml', toml: 'ini', py: 'python', rb: 'ruby',
    go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift',
    c: 'c', cpp: 'cpp', h: 'c', sh: 'shell', bash: 'shell', zsh: 'shell',
    sql: 'sql', graphql: 'graphql', tf: 'hcl', env: 'ini', txt: 'plaintext',
    log: 'plaintext', prisma: 'graphql', dockerfile: 'dockerfile',
  };
  return map[ext] ?? 'plaintext';
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
  kind: 'context' | 'add' | 'del' | 'hunk' | 'hidden';
  oldLine?: number;
  newLine?: number;
  oldText?: string;
  newText?: string;
  text?: string;
  hiddenKey?: string;
  hiddenCount?: number;
};

type SplitCellKind = 'context' | 'add' | 'del' | 'empty';
type SplitDisplayRow =
  | { kind: 'hunk'; text: string; hiddenKey?: string; hiddenCount?: number }
  | { kind: 'hidden'; hiddenKey?: string; hiddenCount?: number; oldLine?: number; newLine?: number }
  | {
      kind: 'row';
      oldLine?: number;
      newLine?: number;
      oldText?: string;
      newText?: string;
      oldKind: SplitCellKind;
      newKind: SplitCellKind;
    };

function parseDiffRows(file: PanelDiffFile, expandedHidden = new Set<string>()): DiffRow[] {
  const oldLines = (file.originalContent ?? '').split('\n');
  const newLines = (file.modifiedContent ?? '').split('\n');

  if (!file.diff?.trim()) {
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
  let sawHunk = false;

  const addContextRange = (oldStart: number, newStart: number, count: number) => {
    for (let i = 0; i < count; i += 1) {
      const oldNo = oldStart + i;
      const newNo = newStart + i;
      const text = newLines[newNo - 1] ?? oldLines[oldNo - 1] ?? '';
      rows.push({ kind: 'context', oldLine: oldNo, newLine: newNo, oldText: text, newText: text });
    }
  };

  const addHiddenRange = (oldStart: number, newStart: number, count: number, key: string) => {
    if (count <= 0) return;
    if (expandedHidden.has(key)) {
      addContextRange(oldStart, newStart, count);
    } else {
      rows.push({ kind: 'hidden', oldLine: oldStart, newLine: newStart, hiddenCount: count, hiddenKey: key });
    }
  };

  for (const raw of file.diff.split('\n')) {
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('diff --git') || raw.startsWith('index ')) continue;
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (hunk) {
      const nextOldLine = Number(hunk[1]);
      const nextNewLine = Number(hunk[2]);
      let hiddenKey: string | undefined;
      let hiddenCount = 0;
      if (!sawHunk) {
        const initialHidden = Math.min(Math.max(nextOldLine - 1, 0), Math.max(nextNewLine - 1, 0));
        const key = `head:${nextOldLine}:${nextNewLine}`;
        if (expandedHidden.has(key)) {
          addContextRange(1, 1, initialHidden);
        } else if (initialHidden > 0) {
          hiddenKey = key;
          hiddenCount = initialHidden;
        }
        sawHunk = true;
      } else {
        const hidden = Math.min(Math.max(nextOldLine - oldLine, 0), Math.max(nextNewLine - newLine, 0));
        const key = `gap:${oldLine}:${newLine}:${nextOldLine}:${nextNewLine}`;
        if (expandedHidden.has(key)) {
          addContextRange(oldLine, newLine, hidden);
        } else if (hidden > 0) {
          hiddenKey = key;
          hiddenCount = hidden;
        }
      }
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ kind: 'hunk', text: raw, hiddenKey, hiddenCount });
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
  if (sawHunk) {
    const remaining = Math.min(Math.max(oldLines.length - oldLine + 1, 0), Math.max(newLines.length - newLine + 1, 0));
    addHiddenRange(oldLine, newLine, remaining, `tail:${oldLine}:${newLine}`);
  }
  return rows;
}

function buildSplitRows(rows: DiffRow[]): SplitDisplayRow[] {
  const out: SplitDisplayRow[] = [];
  for (let i = 0; i < rows.length;) {
    const row = rows[i];
    if (row.kind === 'hunk') {
      out.push({ kind: 'hunk', text: row.text ?? '', hiddenKey: row.hiddenKey, hiddenCount: row.hiddenCount });
      i += 1;
      continue;
    }
    if (row.kind === 'hidden') {
      out.push({
        kind: 'hidden',
        hiddenKey: row.hiddenKey,
        hiddenCount: row.hiddenCount,
        oldLine: row.oldLine,
        newLine: row.newLine,
      });
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
  const [expandedHidden, setExpandedHidden] = useState<Set<string>>(() => new Set());
  const rows = parseDiffRows(file, expandedHidden);
  const toggleHidden = (key?: string) => {
    if (!key) return;
    setExpandedHidden(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  return (
    <div className="cr-diff-code unified">
      {rows.map((row, index) => {
        if (row.kind === 'hidden') {
          return (
            <button
              key={row.hiddenKey ?? index}
              type="button"
              className="cr-diff-row hidden"
              onClick={() => toggleHidden(row.hiddenKey)}
              title="Expand unchanged lines"
            >
              <span className="ln">⋯</span>
              <code>{row.hiddenCount ?? 0} unchanged lines</code>
            </button>
          );
        }
        if (row.kind === 'hunk' && row.hiddenKey && row.hiddenCount) {
          return (
            <button
              key={`${row.hiddenKey}:${index}`}
              type="button"
              className="cr-diff-row hunk expandable"
              onClick={() => toggleHidden(row.hiddenKey)}
              title="Expand hidden context"
            >
              <span className="ln">↕</span>
              <code>{row.hiddenCount} hidden lines | {row.text ?? ''}</code>
            </button>
          );
        }
        return (
          <div key={index} className={`cr-diff-row ${row.kind}`}>
            <span className="ln">{row.oldLine ?? row.newLine ?? ''}</span>
            <code>{row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : row.kind === 'hunk' ? '' : ' '}{row.text ?? row.newText ?? row.oldText ?? ''}</code>
          </div>
        );
      })}
    </div>
  );
}

function SplitDiffView({ file }: { file: PanelDiffFile }) {
  const [expandedHidden, setExpandedHidden] = useState<Set<string>>(() => new Set());
  const rows = buildSplitRows(parseDiffRows(file, expandedHidden));
  const toggleHidden = (key?: string) => {
    if (!key) return;
    setExpandedHidden(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  return (
    <div className="cr-diff-code split">
      {rows.map((row, index) => {
        if (row.kind === 'hunk') {
          if (row.hiddenKey && row.hiddenCount) {
            return (
              <button
                key={`${row.hiddenKey}:${index}`}
                type="button"
                className="cr-split-row hunk expandable"
                onClick={() => toggleHidden(row.hiddenKey)}
                title="Expand hidden context"
              >
                <span className="cr-split-hunk">{row.hiddenCount} hidden lines | {row.text}</span>
              </button>
            );
          }
          return (
            <div key={index} className="cr-split-row hunk">
              <span className="cr-split-hunk">{row.text}</span>
            </div>
          );
        }
        if (row.kind === 'hidden') {
          return (
            <button
              key={row.hiddenKey ?? index}
              type="button"
              className="cr-split-row hidden"
              onClick={() => toggleHidden(row.hiddenKey)}
              title="Expand unchanged lines"
            >
              <span className="ln old">{row.oldLine ?? ''}</span>
              <code>{row.hiddenCount ?? 0} unchanged lines</code>
              <span className="ln new">{row.newLine ?? ''}</span>
              <code>{row.hiddenCount ?? 0} unchanged lines</code>
            </button>
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
  const tabs: Array<{ id: ChatRunPanelTab; label: string; icon: React.ElementType }> = [
    { id: 'tasks', label: 'Tasks', icon: ListTree },
    { id: 'executions', label: 'Executions', icon: Route },
    { id: 'artifacts', label: 'Artifacts', icon: FileText },
    { id: 'files', label: 'Files', icon: Code2 },
  ];
  return (
    <div className="inline-flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="tablist" aria-label="Chat resources">
      {tabs.map(tab => {
        const Icon = tab.icon;
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            className={`inline-flex min-w-max items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] leading-none transition-colors ${
              isActive
                ? 'border border-app-strong bg-app-card text-theme-primary shadow-sm'
                : 'border border-transparent text-theme-secondary hover:bg-app-muted hover:text-theme-primary'
            }`}
            onClick={() => onTabChange(tab.id)}
          >
            <span className={`grid h-5 w-5 place-items-center rounded-md border transition-colors ${
              isActive
                ? 'border-app-strong bg-app-muted text-theme-primary'
                : 'border-app bg-app-muted text-theme-muted'
            }`}>
              <Icon className="h-3.5 w-3.5" />
            </span>
            <span>{tab.label}</span>
            {counts[tab.id] != null && counts[tab.id]! > 0 && <span className="font-mono text-[11px] opacity-70">{counts[tab.id]}</span>}
          </button>
        );
      })}
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

function tryParseJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function JsonScalar({ value }: { value: unknown }) {
  if (value === null) return <span className="cr-json-null">null</span>;
  if (typeof value === 'boolean') return <span className="cr-json-bool">{String(value)}</span>;
  if (typeof value === 'number') return <span className="cr-json-number">{value}</span>;
  if (typeof value === 'string') {
    const isLong = value.length > 140 || value.includes('\n');
    if (isLong) {
      return <div className="cr-json-markdown prose-allen">{renderMarkdown(value) as React.ReactNode}</div>;
    }
    return <span className="cr-json-string">{value}</span>;
  }
  return <span className="cr-json-string">{String(value)}</span>;
}

function JsonValueView({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="cr-json-empty">[]</span>;
    const complex = value.some(item => item && typeof item === 'object');
    return (
      <div className={`cr-json-array ${complex ? 'complex' : ''}`}>
        {value.map((item, index) => (
          <div key={index} className="cr-json-array-item">
            <span className="cr-json-index">{index}</span>
            <JsonValueView value={item} depth={depth + 1} />
          </div>
        ))}
      </div>
    );
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <span className="cr-json-empty">{'{}'}</span>;
    return (
      <div className={`cr-json-object depth-${Math.min(depth, 3)}`}>
        {entries.map(([key, item]) => {
          const complex = item !== null && typeof item === 'object';
          return (
            <div key={key} className={`cr-json-row ${complex ? 'complex' : ''}`}>
              <div className="cr-json-key">{key}</div>
              <div className="cr-json-value">
                <JsonValueView value={item} depth={depth + 1} />
              </div>
            </div>
          );
        })}
      </div>
    );
  }
  return <JsonScalar value={value} />;
}

function IoContent({ content }: { content: string }) {
  const parsed = tryParseJson(content);
  if (parsed !== null) {
    return (
      <div className="cr-json-view">
        <JsonValueView value={parsed} />
      </div>
    );
  }
  return <div className="cr-io-markdown prose-allen">{renderMarkdown(content) as React.ReactNode}</div>;
}

function IOTabs({ input, output }: { input?: string | null; output?: string | null }) {
  const inputContent = input?.trim() ?? '';
  const outputContent = output?.trim() ?? '';
  const [activeTab, setActiveTab] = useState<'input' | 'output'>(inputContent ? 'input' : 'output');
  const activeContent = activeTab === 'input' ? inputContent : outputContent;
  const label = activeTab === 'input' ? 'input' : 'output';
  return (
    <div className="cr-io-tabs">
      <div className="cr-io-tabbar" role="tablist" aria-label="Execution input and output">
        <button
          type="button"
          className={`cr-io-tab ${activeTab === 'input' ? 'active' : ''}`}
          onClick={() => setActiveTab('input')}
          role="tab"
          aria-selected={activeTab === 'input'}
        >
          Input
        </button>
        <button
          type="button"
          className={`cr-io-tab ${activeTab === 'output' ? 'active' : ''}`}
          onClick={() => setActiveTab('output')}
          role="tab"
          aria-selected={activeTab === 'output'}
        >
          Output
        </button>
      </div>
      <div className="cr-io-pane" role="tabpanel">
        {activeContent ? <IoContent content={activeContent} /> : <div className="cr-empty small">No {label} captured for this execution.</div>}
      </div>
    </div>
  );
}

function ExecutionIO({ run }: { run: SpawnedAgent }) {
  const context = run.runContext ?? null;
  const input = context?.io?.input ?? run.prompt;
  const output = context?.io?.output ?? run.response;
  return (
    <div className="cr-exec-io">
      <IOTabs input={input} output={output} />
    </div>
  );
}

function WorkflowNodeIOList({ context, selectedNodeId }: { context: RunStatus | null; selectedNodeId?: string | null }) {
  const steps = (context?.workflowSteps ?? []).filter(step => step.status !== 'pending' || step.io?.input || step.io?.output);
  if (context?.runType !== 'workflow' || steps.length === 0) return null;
  return (
    <div className="cr-workflow-node-ios">
      <div className="cr-inline-label">Node details</div>
      {steps.map((step) => {
        const selected = selectedNodeId === step.id;
        return (
          <details key={`${step.id}:${selectedNodeId ?? ''}`} className="cr-node-io" open={selected || undefined}>
            <summary>
              <ChevronRight className="cr-disclosure-icon h-3.5 w-3.5" />
              <span>{humanLabel(step.name)}</span>
              <StatusBadge status={step.status} />
              {step.agent && <em>{step.agent}</em>}
            </summary>
            <div className="cr-exec-io">
              <IOTabs input={step.io?.input} output={step.io?.output} />
            </div>
          </details>
        );
      })}
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

function ExecutionDetailInline({
  run,
  index,
  selectedExecutionId,
  selectedNodeId,
}: {
  run: SpawnedAgent;
  index: number;
  selectedExecutionId?: string | null;
  selectedNodeId?: string | null;
}) {
  const context = run.runContext ?? null;
  const status = context?.status ?? run.status;
  const childAgents = context?.childAgents ?? [];
  const executionName = runDisplayName(context, run);
  const selected = selectedExecutionId === run.executionId;

  return (
    <details className="cr-exec-detail" open={selected || undefined}>
      <summary>
        <ChevronRight className="cr-disclosure-icon h-3.5 w-3.5" />
        <span className="cr-ref-ic repo"><RunExecutionIcon context={context} /></span>
        <span className="cr-list-body">
          <span className="cr-list-title">Execution {index + 1}: {executionName}</span>
          <span className="cr-list-sub">{runTypeName(context, run)} · {humanLabel(status)} · {formatCost(context?.execution.cost)}</span>
          {context?.title && context.title !== executionName && <span className="cr-list-sub">{context.title}</span>}
        </span>
        <Link to={`/executions/${run.executionId}`} className="cr-detail-link" title="Open full execution page" onClick={(event) => event.stopPropagation()}>
          <span>See detailed execution</span>
          <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      </summary>
      {context?.runType === 'workflow' ? (
        <WorkflowNodeIOList context={context} selectedNodeId={selected ? selectedNodeId : null} />
      ) : (
        <ExecutionIO run={run} />
      )}
      {childAgents.length > 0 && (
        <div className="cr-child-list inline">
          {childAgents.map(child => <ChildExecutionRow key={child.executionId} child={child} />)}
        </div>
      )}
    </details>
  );
}

function ExecutionsPanel({
  runs,
  selectedExecutionId,
  selectedNodeId,
}: {
  runs: SpawnedAgent[];
  selectedExecutionId?: string | null;
  selectedNodeId?: string | null;
}) {
  if (runs.length === 0) return <div className="cr-empty">No agent executions are linked to this chat yet.</div>;
  return (
    <div className="cr-exec-list">
      {runs.map((run, index) => (
        <ExecutionDetailInline
          key={run.executionId}
          run={run}
          index={index}
          selectedExecutionId={selectedExecutionId}
          selectedNodeId={selectedNodeId}
        />
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
        <summary className="ws-tree-node" style={{ paddingLeft: 8 + depth * 12 }}>
          <ChevronRight className="h-3 w-3" />
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
      className={`ws-tree-node file ${node.status ?? ''} ${activePath === node.path ? 'active' : ''}`}
      style={{ paddingLeft: 20 + depth * 12 }}
      onClick={() => onOpenFile(node.path)}
    >
      <FileText className="h-3.5 w-3.5" />
      <span className="truncate">{node.name}</span>
      {node.entry?.status && <em>{node.entry.status}</em>}
    </button>
  );
}

function FileChangesPanel({
  runs,
  rootType,
  rootId,
  repoBrowseSource,
}: {
  runs: SpawnedAgent[];
  rootType?: 'chat' | 'workflow' | 'agent';
  rootId?: string | null;
  repoBrowseSource?: RepoBrowseSource | null;
}) {
  const [files, setFiles] = useState<PanelDiffFile[]>([]);
  const [activeDiffPath, setActiveDiffPath] = useState('');
  const [diffMode, setDiffMode] = useState<'split' | 'unified'>('unified');
  const [view, setView] = useState<'changes' | 'browser'>('changes');
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFileEntry[]>([]);
  const [browserPath, setBrowserPath] = useState('');
  const [browserContent, setBrowserContent] = useState('');
  const [browserSource, setBrowserSource] = useState<{ kind: 'workspace' | 'repo'; id: string; name?: string | null } | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [loading, setLoading] = useState(false);

  const workspaceRefs = useMemo(() => {
    const refs: Array<{ id: string; name?: string | null; repoId?: string | null; mode: 'auto' | 'branch' }> = [];
    for (const run of runs) {
      const id = run.runContext?.workspace?.id;
      if (!id) continue;
      refs.push({
        id,
        name: run.runContext?.workspace?.name ?? run.runContext?.workspace?.repoName,
        repoId: run.runContext?.workspace?.repoId ?? null,
        mode: run.runContext?.pullRequest ? 'branch' : 'auto',
      });
    }
    return refs.reduce<Array<{ id: string; name?: string | null; repoId?: string | null; mode: 'auto' | 'branch' }>>((acc, ref) => {
      const existing = acc.find(item => item.id === ref.id);
      if (!existing) acc.push(ref);
      else if (ref.mode === 'branch') existing.mode = 'branch';
      return acc;
    }, []);
  }, [runs]);

  const pullRequestRefs = useMemo(() => {
    const refs: Array<{ id: string; name?: string | null }> = [];
    for (const run of runs) {
      const id = run.runContext?.pullRequest?.id;
      if (!id) continue;
      refs.push({
        id,
        name: run.runContext?.pullRequest?.title ?? (run.runContext?.pullRequest?.number ? `PR #${run.runContext.pullRequest.number}` : 'pull request'),
      });
    }
    return refs.filter((ref, index, arr) => arr.findIndex(item => item.id === ref.id) === index);
  }, [runs]);

  const signature = [
    rootType === 'chat' && rootId ? `chat:${rootId}` : '',
    workspaceRefs.map(ref => `${ref.id}:${ref.mode}`).join('|'),
    pullRequestRefs.map(ref => ref.id).join('|'),
  ].filter(Boolean).join('::');

  useEffect(() => {
    if (!signature) {
      setFiles([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const byKey = new Map<string, PanelDiffFile>();
    const addFiles = (incoming: PanelDiffFile[]) => {
      for (const file of incoming) {
        const key = file.path;
        if (!byKey.has(key)) byKey.set(key, file);
      }
    };

    (async () => {
      if (rootType === 'chat' && rootId) {
        try {
          const result = await chatCodeDiffs.listAll(rootId);
          addFiles((result.snapshots ?? []).flatMap((snapshot: any) => {
            const sourceId = String(snapshot.workspaceId ?? snapshot._id ?? 'snapshot');
            const sourceName = snapshot.workspaceName ?? snapshot.baseBranch ?? 'saved diff';
            return ((snapshot.files ?? []) as Array<Omit<PanelDiffFile, 'workspaceId' | 'workspaceName'>>)
              .filter(file => file.diff?.trim() || file.modifiedContent?.trim())
              .map(file => ({ ...file, workspaceId: sourceId, workspaceName: sourceName }));
          }));
        } catch {}
      }

      const workspaceGroups = await Promise.all(workspaceRefs.map(async ref => {
      try {
        const result = await workspacesApi.getDiff(ref.id, { mode: ref.mode });
        return ((result.files ?? []) as Array<Omit<PanelDiffFile, 'workspaceId' | 'workspaceName'>>)
          .filter(file => file.diff?.trim() || file.modifiedContent?.trim())
          .map(file => ({ ...file, workspaceId: ref.id, workspaceName: ref.name }));
      } catch {
        return [];
      }
      }));
      addFiles(workspaceGroups.flat());

      const prGroups = await Promise.all(pullRequestRefs.map(async ref => {
        try {
          const result = await pullRequestsApi.getDiff(ref.id);
          return ((result.files ?? []) as Array<{ path: string; diff?: string; originalContent?: string; modifiedContent?: string }>)
            .filter(file => file.diff?.trim() || file.modifiedContent?.trim())
            .map(file => {
              const counts = diffLineCounts(file.diff);
              return {
                ...file,
                status: file.diff?.includes('new file mode') ? 'added' : file.diff?.includes('deleted file mode') ? 'deleted' : 'modified',
                additions: counts.additions,
                deletions: counts.deletions,
                workspaceId: `pr:${ref.id}`,
                workspaceName: ref.name,
              };
            });
        } catch {
          return [];
        }
      }));
      addFiles(prGroups.flat());

      if (!cancelled) setFiles(Array.from(byKey.values()));
    })().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [signature, workspaceRefs, pullRequestRefs, rootType, rootId]);

  const additions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  const activeWorkspace = workspaceRefs[0] ?? null;
  const activeDiff = files.find(file => file.path === activeDiffPath) ?? files[0] ?? null;
  const changedStatuses = useMemo(() => new Map(files.map(file => [file.path, changedFileStatus(file)])), [files]);
  const fileTree = useMemo(() => buildFileTree(workspaceFiles, changedStatuses), [workspaceFiles, changedStatuses]);
  const browserDiffFile = files.find(file => file.path === browserPath) ?? null;

  useEffect(() => {
    if (files.length === 0) {
      setActiveDiffPath('');
      return;
    }
    if (!files.some(file => file.path === activeDiffPath)) {
      setActiveDiffPath(files[0].path);
    }
  }, [files, activeDiffPath]);

  useEffect(() => {
    if (view !== 'browser') return;
    let cancelled = false;
    const nextRepoId = repoBrowseSource?.id ?? null;
    setBrowserLoading(true);
    (async () => {
      let result: WorkspaceFileEntry[] = [];
      let source: { kind: 'workspace' | 'repo'; id: string; name?: string | null } | null = null;

      if (activeWorkspace?.id) {
        try {
          result = (await workspacesApi.getAllFiles(activeWorkspace.id) ?? []) as WorkspaceFileEntry[];
          source = { kind: 'workspace', id: activeWorkspace.id, name: activeWorkspace.name };
        } catch {}
      }

      if (!source && nextRepoId) {
        try {
          result = (await reposApi.getAllFiles(nextRepoId) ?? []) as WorkspaceFileEntry[];
          source = { kind: 'repo', id: nextRepoId, name: repoBrowseSource?.name ?? repoBrowseSource?.path ?? 'repository' };
        } catch {}
      }

      if (!cancelled) {
        setWorkspaceFiles(result);
        setBrowserSource(source);
        setBrowserPath(current => {
          if (current && !result.some(file => file.path === current)) {
            setBrowserContent('');
            return '';
          }
          return current;
        });
        if (!source) {
          setBrowserContent('');
        }
      }
    })().finally(() => {
      if (!cancelled) setBrowserLoading(false);
    });
    return () => {
      cancelled = true;
      setBrowserLoading(false);
    };
  }, [activeWorkspace?.id, activeWorkspace?.name, repoBrowseSource?.id, repoBrowseSource?.name, repoBrowseSource?.path, view]);

  async function openBrowserFile(path: string) {
    const source = browserSource ?? (activeWorkspace?.id
      ? { kind: 'workspace' as const, id: activeWorkspace.id, name: activeWorkspace.name }
      : repoBrowseSource?.id
        ? { kind: 'repo' as const, id: repoBrowseSource.id, name: repoBrowseSource.name }
        : null);
    if (!source) return;
    setBrowserPath(path);
    if (changedStatuses.has(path)) {
      setBrowserContent('');
      return;
    }
    setFileLoading(true);
    try {
      const file = source.kind === 'workspace'
        ? await workspacesApi.getFile(source.id, path)
        : await reposApi.getFile(source.id, path);
      setBrowserContent(file.isImage ? '[binary image preview is available in the dedicated editor]' : file.content ?? '');
    } catch (err) {
      setBrowserContent(`Failed to load ${path}: ${(err as Error).message}`);
    } finally {
      setFileLoading(false);
    }
  }

  if (loading) return <div className="cr-empty">Checking workspace changes...</div>;
  if (files.length === 0 && workspaceRefs.length === 0 && pullRequestRefs.length === 0 && !repoBrowseSource?.id) {
    return <div className="cr-empty">No file changes are linked to this chat yet.</div>;
  }

  return (
    <div className="cr-files-panel">
      <div className="cr-files-summary">
        <button type="button" className={view === 'changes' ? 'active' : ''} onClick={() => setView('changes')}>
          <FileText className="h-3.5 w-3.5" />
          <span>{files.length} changed</span>
        </button>
        <button type="button" className={view === 'browser' ? 'active' : ''} onClick={() => setView('browser')} disabled={!activeWorkspace && !repoBrowseSource?.id}>
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
        <div className="ws-main ws-panel cr-workspace-view">
          <aside className="ws-tree scroll-hide">
            <div className="ws-tree-h">
              <span>files changed</span>
              <span className="mono ws-tree-ct">{files.length}</span>
            </div>
            <div className="ws-tree-list">
              {files.length === 0 ? (
                <div className="ws-tree-empty">No changed files were found in the linked workspaces.</div>
              ) : files.map(file => (
                <button
                  key={`${file.workspaceId}:${file.path}`}
                  className={`ws-file ${activeDiff?.path === file.path ? 'active' : ''}`}
                  onClick={() => setActiveDiffPath(file.path)}
                  type="button"
                >
                  <span className={`ws-file-tag ${file.status ?? 'modified'}`}>{file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : 'M'}</span>
                  <span className="ws-file-p">{file.path}</span>
                  <span className="ws-file-d mono">
                    {file.additions ? <span className="pos">+{file.additions}</span> : null}
                    {file.deletions ? <span className="neg">-{file.deletions}</span> : null}
                  </span>
                </button>
              ))}
            </div>
          </aside>

          <section className="ws-diff scroll-hide">
            <div className="ws-diff-h">
              <FileText className="h-3.5 w-3.5 text-theme-muted" />
              <span className="mono truncate">{activeDiff?.path ?? 'workspace preview'}</span>
              <div className="ws-diff-h-r">
                <div className="ws-diff-mode" role="group" aria-label="Diff view mode">
                  <button className={diffMode === 'unified' ? 'active' : ''} onClick={() => setDiffMode('unified')} type="button">
                    unified
                  </button>
                  <button className={diffMode === 'split' ? 'active' : ''} onClick={() => setDiffMode('split')} type="button">
                    split
                  </button>
                </div>
              </div>
            </div>
            <div className="ws-diff-body">
              {activeDiff ? (
                <div className="cr-file-detail-diff browse-diff">
                  {diffMode === 'split'
                    ? <SplitDiffView key={`${activeDiff.path}:split`} file={activeDiff} />
                    : <UnifiedDiffView key={`${activeDiff.path}:unified`} file={activeDiff} />}
                </div>
              ) : (
                <div className="ws-diff-empty">No changed file selected.</div>
              )}
            </div>
          </section>
        </div>
      ) : (
        <div className="ws-files-body ws-panel cr-workspace-view">
          <aside className="ws-files-list scroll-hide">
            <div className="ws-tree-h">
              <span>file explorer</span>
              <span className="mono ws-tree-ct">{workspaceFiles.length}</span>
            </div>
            <div className="ws-tree-list">
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
          </aside>
          <section className="ws-file-editor">
            <div className="ws-diff-h">
              <FileText className="h-3.5 w-3.5 text-theme-muted" />
              <span className="truncate">{browserPath || browserSource?.name || activeWorkspace?.name || repoBrowseSource?.name || 'Repository files'}</span>
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
                {diffMode === 'split'
                  ? <SplitDiffView key={`${browserDiffFile.path}:split`} file={browserDiffFile} />
                  : <UnifiedDiffView key={`${browserDiffFile.path}:unified`} file={browserDiffFile} />}
              </div>
            ) : browserPath ? (
              <div className="ws-monaco-wrap">
                <Editor
                  path={browserPath}
                  value={browserContent}
                  language={getLanguage(browserPath)}
                  theme={getMonacoTheme()}
                  beforeMount={setupMonaco}
                  options={{
                    readOnly: true,
                    minimap: { enabled: true },
                    fontSize: 12,
                    fontFamily: "'JetBrains Mono', 'Geist Mono', ui-monospace, monospace",
                    lineNumbers: 'on',
                    wordWrap: 'on',
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    tabSize: 2,
                    insertSpaces: true,
                  }}
                />
              </div>
            ) : (
              <div className="ws-diff-empty">Select a file to preview it here.</div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function TasksPanel({
  activeRun,
  activeContext,
  sortedRuns,
  expanded,
  onOpenNode,
  onOpenExecution,
}: {
  activeRun: SpawnedAgent;
  activeContext: RunStatus | null;
  sortedRuns: SpawnedAgent[];
  expanded: boolean;
  onOpenNode: (executionId: string, nodeId: string) => void;
  onOpenExecution: (executionId: string) => void;
}) {
  const attemptRuns = sortedRuns;
  const showAttempts = attemptRuns.length > 1;
  const showWorkflowNodes = !showAttempts && activeContext?.runType === 'workflow' && (activeContext.workflowSteps?.length ?? 0) > 0;
  const pullRequests = useMemo(() => {
    const prs = new Map<string, NonNullable<RunStatus['pullRequest']>>();
    for (const run of sortedRuns) {
      const pr = run.runContext?.pullRequest;
      const key = pr?.id ?? pr?.url ?? (pr?.number != null ? String(pr.number) : '');
      if (pr && key) prs.set(key, pr);
    }
    return [...prs.values()];
  }, [sortedRuns]);

  const percent = Math.max(0, Math.min(100, activeContext?.progress.percent ?? 0));
  const activeCost = showAttempts ? formatRunSequenceCost(attemptRuns) : formatCost(activeContext?.execution.cost);
  const statusText = humanLabel(activeContext?.status ?? activeRun.status);
  const currentText = activeContext?.progress.currentStep ?? activeContext?.progress.label ?? null;

  return (
    <div className={`cr-task-panel ${expanded ? 'expanded' : 'compact'}`}>
      <section className="cr-progress">
        <div className="bar">
          <span style={{ width: `${percent}%` }} />
        </div>
        <div className="cr-task-summary">
          <span>{statusText}</span>
          <span>{percent}%</span>
          <span>{activeCost}</span>
          {currentText && <span className="current">{humanLabel(currentText)}</span>}
        </div>
      </section>

      {pullRequests.length > 0 && (
        <RailSection title="pull requests" count={`${pullRequests.length}`}>
          <div className="space-y-2">
            {pullRequests.map(pr => (
              <PullRequestTaskCard key={pr.id ?? pr.url ?? pr.number ?? pr.title ?? 'pr'} pr={pr} />
            ))}
          </div>
        </RailSection>
      )}

      {showAttempts && (
        <RailSection title="executions" count={`${attemptRuns.length}`}>
          <div className="cr-steps">
            {attemptRuns.map((run, index) => (
              <AttemptRow
                key={run.executionId}
                run={run}
                index={index}
                onOpenNode={onOpenNode}
                onOpenExecution={onOpenExecution}
              />
            ))}
          </div>
        </RailSection>
      )}

      {showWorkflowNodes ? (
        <>
          <RailSection title="steps" count={`${activeContext?.progress.completed ?? 0}/${activeContext?.progress.total ?? activeContext?.workflowSteps.length}`}>
            <div className="cr-steps">
              {activeContext!.workflowSteps.map((step, index) => (
                <WorkflowNodeStep
                  key={step.id}
                  step={step}
                  isLast={index === activeContext!.workflowSteps.length - 1}
                  onOpenDetails={(nodeId) => onOpenNode(activeRun.executionId, nodeId)}
                />
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

      {activeContext?.humanInput.required && (
        <RailSection title="actions">
          <div className="cr-acts">
            <Link to={activeContext.humanInput.interventionId ? `/interventions/${activeContext.humanInput.interventionId}` : '/interventions'} className="btn-primary justify-center gap-1.5 text-[12px]">
              Resolve Input
              <ExternalLink className="h-3.5 w-3.5" />
            </Link>
          </div>
        </RailSection>
      )}
    </div>
  );
}

export default function ChatRunSidebar({
  runs,
  rootType,
  rootId,
  repoBrowseSource,
  open,
  activeTab,
  onTabChange,
  onClose,
}: {
  runs: SpawnedAgent[];
  rootType?: 'chat' | 'workflow' | 'agent';
  rootId?: string | null;
  repoBrowseSource?: RepoBrowseSource | null;
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
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(null);
  const [selectedWorkflowNodeId, setSelectedWorkflowNodeId] = useState<string | null>(null);
  const [tabSlide, setTabSlide] = useState<'tasks-to-executions' | null>(null);
  const activeRun = sortedRuns.find(run => {
    const status = (run.runContext?.status ?? run.status ?? '').toLowerCase();
    return !['completed', 'failed', 'cancelled', 'canceled'].includes(status);
  }) ?? sortedRuns[sortedRuns.length - 1] ?? null;
  const activeContext = activeRun?.runContext ?? null;
  const runtimeArtifactCount = sortedRuns.reduce((sum, run) => sum + artifactsForRun(run, run.runContext ?? null).length, 0);
  const visibleExecutionIds = new Set(sortedRuns.map(run => run.executionId));
  const childExecutionCount = sortedRuns.reduce(
    (sum, run) => sum + (run.runContext?.childAgents ?? []).filter(child => !visibleExecutionIds.has(child.executionId)).length,
    0,
  );
  const workspaceCount = new Set(sortedRuns.map(run => run.runContext?.workspace?.id).filter(Boolean)).size;
  const pullRequestCount = new Set(sortedRuns.map(run => run.runContext?.pullRequest?.id).filter(Boolean)).size;
  const repoBrowseCount = repoBrowseSource?.id ? 1 : 0;
  const counts: Partial<Record<ChatRunPanelTab, number>> = {
    tasks: sortedRuns.length,
    executions: sortedRuns.length + childExecutionCount,
    artifacts: runtimeArtifactCount,
    files: Math.max(workspaceCount, pullRequestCount, repoBrowseCount),
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'));
    });
    const timeout = window.setTimeout(() => {
      window.dispatchEvent(new Event('resize'));
    }, 120);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [open, fullScreen, activeTab]);

  useEffect(() => {
    if (!tabSlide) return;
    const timeout = window.setTimeout(() => setTabSlide(null), 520);
    return () => window.clearTimeout(timeout);
  }, [tabSlide]);

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

  function openExecutionNode(executionId: string, nodeId: string) {
    setSelectedExecutionId(executionId);
    setSelectedWorkflowNodeId(nodeId);
    setTabSlide('tasks-to-executions');
    onTabChange('executions');
  }

  function openExecution(executionId: string) {
    setSelectedExecutionId(executionId);
    setSelectedWorkflowNodeId(null);
    setTabSlide('tasks-to-executions');
    onTabChange('executions');
  }

  return (
    <aside
      className={`chat-rail relative flex h-full flex-none flex-col gap-3 overflow-hidden border-l border-app bg-app-muted px-3.5 pb-8 pt-2.5 ${
        fullScreen ? 'fullscreen absolute inset-0 z-[80] h-full w-full max-w-none border-l-0 px-5' : ''
      }`}
      style={fullScreen ? undefined : { width }}
    >
      {!fullScreen && <div className="chat-rail-resize" onMouseDown={startResize} title="Drag to resize" />}
      <div className="sticky top-0 z-20 flex shrink-0 items-center justify-between gap-2 border-b border-app-strong bg-app-muted pb-2">
        <PanelTabs activeTab={activeTab} onTabChange={onTabChange} counts={counts} />
        <div className="inline-flex shrink-0 items-center gap-1">
          <button type="button" className="rounded-md p-1.5 text-theme-muted transition-colors hover:bg-app-card hover:text-theme-primary" onClick={() => setFullScreen(value => !value)} title={fullScreen ? 'Exit full screen' : 'Expand side panel'} aria-label={fullScreen ? 'Exit full screen' : 'Expand side panel'}>
            {fullScreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
          <button type="button" className="rounded-md p-1.5 text-theme-muted transition-colors hover:bg-app-card hover:text-theme-primary" onClick={onClose} title="Close side panel" aria-label="Close side panel">
            <PanelRightClose className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="relative min-h-0 w-full flex-1 overflow-hidden">
        {tabSlide === 'tasks-to-executions' && activeTab === 'executions' && activeRun && (
          <div className="cr-tab-ghost cr-tab-exit-left" aria-hidden="true">
            <TasksPanel
              activeRun={activeRun}
              activeContext={activeContext}
              sortedRuns={sortedRuns}
              expanded={fullScreen}
              onOpenNode={() => undefined}
              onOpenExecution={() => undefined}
            />
          </div>
        )}
        <div className={`h-full w-full min-h-0 ${activeTab === 'files' || activeTab === 'artifacts' ? 'flex flex-col overflow-hidden' : 'overflow-y-auto overflow-x-hidden pr-1'} ${activeTab} ${tabSlide === 'tasks-to-executions' && activeTab === 'executions' ? 'cr-tab-enter-right' : ''}`}>
        {activeTab === 'tasks' && (
          activeRun
            ? (
              <TasksPanel
                activeRun={activeRun}
                activeContext={activeContext}
                sortedRuns={sortedRuns}
                expanded={fullScreen}
                onOpenNode={openExecutionNode}
                onOpenExecution={openExecution}
              />
            )
            : <div className="cr-empty">No task sequence is linked to this chat yet.</div>
        )}
        {activeTab === 'executions' && (
          <ExecutionsPanel
            runs={sortedRuns}
            selectedExecutionId={selectedExecutionId}
            selectedNodeId={selectedWorkflowNodeId}
          />
        )}
        {activeTab === 'artifacts' && <ChatArtifactsPanel rootType={rootType} rootId={rootId} runs={sortedRuns} />}
        {activeTab === 'files' && <FileChangesPanel runs={sortedRuns} rootType={rootType} rootId={rootId} repoBrowseSource={repoBrowseSource} />}
        </div>
      </div>
    </aside>
  );
}
