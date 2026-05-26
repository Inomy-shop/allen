import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type * as Monaco from 'monaco-editor';
import {
  Activity,
  AlertTriangle,
  Bot,
  BookOpen,
  Columns2,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Copy,
  ExternalLink,
  FileText,
  FolderOpen,
  HelpCircle,
  FolderGit2,
  GitBranch,
  Loader2,
  ListTree,
  PanelRightClose,
  PlayCircle,
  RefreshCw,
  Rows3,
  StopCircle,
  Terminal,
  Timer,
  Code2,
  X,
} from 'lucide-react';
import type { SpawnedAgent, WorkflowInterventionAnswer } from '../../hooks/useChat';
import { artifacts as artifactsApi, chat as chatApi, repos as reposApi, type ArtifactDoc, type RunStatus } from '../../services/api';
import { chatCodeDiffs, pullRequests as pullRequestsApi, workspaces as workspacesApi } from '../../services/workspaceService';
import ArtifactViewer from '../artifacts/ArtifactViewer';
import { RepoContextInjectionPanel } from '../execution/NodeInspector';
import { WorkflowInterventionAction, type WorkflowInterventionLike } from '../execution/WorkflowInterventionAction';
import { XTerminal } from '../workspace/XTerminal';
import { getMonacoTheme, setupMonaco } from '../../lib/monaco-theme';
import { renderMarkdown } from './ChatMessageList';

const FAILED_STATUSES = new Set(['failed', 'failure', 'error', 'errored']);
const CANCELLED_STATUSES = new Set(['cancelled', 'canceled']);
const TERMINAL_STATUSES = new Set(['completed', 'merged', 'failed', 'failure', 'error', 'errored', 'cancelled', 'canceled', 'closed']);
const CHAT_RUN_SIDEBAR_MIN_WIDTH = 388;

export type ChatRunPanelTab = 'tasks' | 'executions' | 'files' | 'changes' | 'context';
type FilePanelView = 'files' | 'changes';

type RepoBrowseSource = {
  id?: string | null;
  name?: string | null;
  path?: string | null;
};
type SidebarWorkflowStep = NonNullable<RunStatus['workflowSteps']>[number];

function humanLabel(value?: string | null): string {
  if (!value) return '';
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function shortExecutionId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}...${id.slice(-4)}` : id;
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

function isChildExecutionRun(run: SpawnedAgent): boolean {
  if (run.parentExecutionId ?? run.runContext?.execution.parentExecutionId) return true;
  return (run.spawnDepth ?? run.runContext?.execution.spawnDepth ?? 0) > 0;
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

function approvalActionLabel(context?: RunStatus | null): string {
  const severity = context?.humanInput.severity?.toLowerCase();
  if (severity === 'approval') return 'Approval required';
  if (severity === 'escalation') return 'Review required';
  return 'Input required';
}

type SidebarWorkflowIntervention = WorkflowInterventionLike;

function interventionForRun(run: SpawnedAgent): SidebarWorkflowIntervention | null {
  const context = run.runContext;
  const status = (context?.status ?? run.status ?? '').toLowerCase();
  if (!context?.humanInput.required && status !== 'waiting_for_input' && status !== 'waiting') return null;
  if (!context) return null;
  const interventions = (context.interventions ?? []) as SidebarWorkflowIntervention[];
  const pending =
    interventions.find(item => item.status === 'pending' && item.intervention_id === context.humanInput.interventionId)
    ?? interventions.find(item => item.status === 'pending');
  if (pending?.intervention_id) return pending;
  if (context.humanInput.interventionId) {
    return {
      intervention_id: context.humanInput.interventionId,
      status: 'pending',
      stage: context.humanInput.stage,
      severity: context.humanInput.severity,
      title: context.humanInput.title ?? approvalActionLabel(context),
    };
  }
  const stage = context.humanInput.stage
    ?? context.progress.currentStep
    ?? context.execution.currentNodes?.[0]
    ?? undefined;
  if (stage && looksLikeApprovalInput(stage, context.humanInput.severity)) {
    return {
      status: 'pending',
      stage,
      severity: context.humanInput.severity ?? (stage.toLowerCase().includes('escalation') ? 'escalation' : 'approval'),
      title: context.humanInput.title ?? 'Approval required',
      question: `Review the pause at ${humanLabel(stage)} and choose how the workflow should continue.`,
    };
  }
  return null;
}

function looksLikeApprovalInput(stage?: string | null, severity?: string | null): boolean {
  const lower = `${stage ?? ''} ${severity ?? ''}`.toLowerCase();
  return lower.includes('approval') || lower.includes('escalation') || lower.includes('_gate') || lower.endsWith(' gate');
}

function SidebarApprovalButton({
  run,
  onAnswer,
  className = 'cr-approval-button',
}: {
  run: SpawnedAgent;
  onAnswer?: (input: WorkflowInterventionAnswer) => Promise<void> | void;
  className?: string;
}) {
  const intervention = interventionForRun(run);
  if (!intervention || !onAnswer) return null;

  return (
    <WorkflowInterventionAction
      run={run}
      intervention={intervention}
      onAnswer={onAnswer}
      className={className}
    />
  );
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

function workflowStepStatusFromState(state: ReturnType<typeof compactSteps>[number]['state']): string {
  if (state === 'ok') return 'completed';
  if (state === 'run') return 'running';
  if (state === 'wait-you') return 'waiting_for_input';
  if (state === 'fail') return 'failed';
  return 'pending';
}

function workflowStepsForContext(context: RunStatus | null): SidebarWorkflowStep[] {
  const hydratedSteps = context?.workflowSteps ?? [];
  if (hydratedSteps.length > 0) return hydratedSteps;
  if (context?.runType !== 'workflow') return [];
  return compactSteps(context).map((step, index): SidebarWorkflowStep => ({
    id: step.id,
    name: step.name,
    index,
    status: workflowStepStatusFromState(step.state),
    attempts: step.state === 'wait' ? 0 : 1,
    type: step.meta || 'workflow',
  }));
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

function WorkflowExecutionHeader({ run, context }: { run: SpawnedAgent; context: RunStatus }) {
  const workflowName = safeRunName(context.execution.workflowName) ?? runDisplayName(context, run);
  const executionName = safeRunName(context.title);
  const status = humanLabel(context.status ?? run.status);
  const cost = formatCost(context.execution.cost);
  const progress = `${context.progress.completed ?? 0}/${context.progress.total ?? workflowStepsForContext(context).length} steps`;
  const subtitle = [
    executionName && executionName !== workflowName ? executionName : 'Workflow execution',
    progress,
    status,
    cost,
  ].filter(Boolean).join(' · ');

  return (
    <Link
      to={`/executions/${run.executionId}`}
      className="group flex items-center gap-3 rounded px-2 py-2 text-left transition-colors hover:bg-app"
      title="Open workflow execution"
    >
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded border border-app bg-app-muted text-theme-muted transition-colors group-hover:text-theme-secondary">
        <GitBranch className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-theme-muted">
          Workflow execution
        </span>
        <span className="mt-0.5 block truncate text-[13px] font-semibold text-theme-primary">
          {workflowName}
        </span>
        <span className="mt-0.5 block truncate font-mono text-[10.5px] text-theme-muted">
          {subtitle}
        </span>
      </span>
      <ExternalLink className="h-3.5 w-3.5 shrink-0 text-theme-subtle transition-colors group-hover:text-theme-secondary" />
    </Link>
  );
}

function AttemptRow({
  run,
  index,
  onOpenNode,
  onOpenExecution,
  onAnswerWorkflowIntervention,
}: {
  run: SpawnedAgent;
  index: number;
  onOpenNode: (executionId: string, nodeId: string) => void;
  onOpenExecution: (executionId: string) => void;
  onAnswerWorkflowIntervention?: (input: WorkflowInterventionAnswer) => Promise<void> | void;
}) {
  const [expanded, setExpanded] = useState(() => run.runContext?.runType === 'workflow');
  const context = run.runContext ?? null;
  const state = runState(context, run);
  const status = context?.status ?? run.status;
  const cost = formatCost(context?.execution.cost);
  const percent = Math.max(0, Math.min(100, context?.progress.percent ?? (state === 'ok' ? 100 : 0)));
  const kind = runDisplayName(context, run);
  const workflowSteps = workflowStepsForContext(context);
  const isWorkflow = context?.runType === 'workflow';
  const summary =
    !isWorkflow ? humanLabel(status)
      : state === 'wait-you' ? approvalActionLabel(context)
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
          <span className="step-name-row">
            <span className="step-name">Execution {index + 1}: {kind}</span>
          </span>
          <span className="step-meta">{executionKind} · {summary} · {cost}</span>
        </span>
        <span className="attempt-row-progress" aria-label={`Execution ${index + 1} progress ${percent}%`}>
          <span style={{ width: `${percent}%` }} />
        </span>
        {isWorkflow && expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
      </button>
      <div className="attempt-row-actions">
        <SidebarApprovalButton run={run} onAnswer={onAnswerWorkflowIntervention} className="cr-approval-button" />
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

function WorkContextSection({ runs }: { runs: SpawnedAgent[] }) {
  const pullRequests = useMemo(() => {
    const prs = new Map<string, NonNullable<RunStatus['pullRequest']>>();
    for (const run of runs) {
      const pr = run.runContext?.pullRequest;
      const key = pr?.id ?? pr?.url ?? (pr?.number != null ? String(pr.number) : '');
      if (pr && key) prs.set(key, pr);
    }
    return [...prs.values()];
  }, [runs]);

  const workspaces = useMemo(() => {
    const refs = new Map<string, NonNullable<RunStatus['workspace']>>();
    for (const run of runs) {
      const workspace = run.runContext?.workspace;
      const key = workspace?.id ?? workspace?.worktreePath ?? workspace?.branch ?? workspace?.name ?? '';
      if (workspace && key) refs.set(key, workspace);
    }
    return [...refs.values()];
  }, [runs]);

  const linearRefs = useMemo(() => {
    const refs = new Map<string, NonNullable<RunStatus['linear']>>();
    for (const run of runs) {
      const linear = run.runContext?.linear;
      const key = linear?.issueId ?? linear?.identifier ?? linear?.url ?? '';
      if (linear && key) refs.set(key, linear);
    }
    return [...refs.values()];
  }, [runs]);

  const count = pullRequests.length + workspaces.length + linearRefs.length;
  if (count === 0) return null;

  return (
    <RailSection title="references" count={`${count}`}>
      <div className="cr-context-grid">
        {pullRequests.map(pr => {
          const status = humanLabel(pr.status ?? 'open');
          const title = `PR ${pr.number ? `#${pr.number}` : ''} ${status}`.trim();
          const subtitle = [pr.title, pr.branch, pr.baseBranch ? `base ${pr.baseBranch}` : null].filter(Boolean).join(' · ');
          const content = (
            <>
              <span className="cr-context-ic pr"><GitBranch className="h-3.5 w-3.5" /></span>
              <span className="cr-context-body">
                <span className="cr-context-kicker">Pull request</span>
                <span className="cr-context-title">{title}</span>
                {subtitle && <span className="cr-context-sub">{subtitle}</span>}
              </span>
              <span className="cr-context-meta">{timeAgo(pr.mergedAt ?? pr.updatedAt ?? pr.createdAt)}</span>
              {pr.url && <ExternalLink className="h-3.5 w-3.5 text-theme-subtle" />}
            </>
          );
          return pr.url ? (
            <a key={pr.id ?? pr.url ?? pr.number ?? pr.title ?? 'pr'} href={pr.url} target="_blank" rel="noreferrer" className="cr-context-card">
              {content}
            </a>
          ) : (
            <div key={pr.id ?? pr.number ?? pr.title ?? 'pr'} className="cr-context-card">
              {content}
            </div>
          );
        })}

        {workspaces.map(workspace => {
          const title = workspace.name ?? workspace.branch ?? 'Workspace';
          const subtitle = [workspace.repoName, workspace.branch, workspace.baseBranch ? `base ${workspace.baseBranch}` : null].filter(Boolean).join(' · ');
          const content = (
            <>
              <span className="cr-context-ic workspace"><FolderGit2 className="h-3.5 w-3.5" /></span>
              <span className="cr-context-body">
                <span className="cr-context-kicker">Workspace</span>
                <span className="cr-context-title">{title}</span>
                {subtitle && <span className="cr-context-sub">{subtitle}</span>}
              </span>
              {workspace.status && <span className="cr-context-meta">{humanLabel(workspace.status)}</span>}
              <ExternalLink className="h-3.5 w-3.5 text-theme-subtle" />
            </>
          );
          return workspace.id ? (
            <Link key={workspace.id} to={`/workspaces/${workspace.id}`} className="cr-context-card">
              {content}
            </Link>
          ) : (
            <div key={workspace.worktreePath ?? workspace.branch ?? workspace.name ?? 'workspace'} className="cr-context-card">
              {content}
            </div>
          );
        })}

        {linearRefs.map(linear => {
          const title = linear.identifier ?? linear.title ?? 'Linear issue';
          const subtitle = [linear.title && linear.title !== title ? linear.title : null, humanLabel(String(linear.assignment?.status ?? 'linked'))].filter(Boolean).join(' · ');
          const content = (
            <>
              <span className="cr-context-ic linear">L</span>
              <span className="cr-context-body">
                <span className="cr-context-kicker">Reference</span>
                <span className="cr-context-title">{title}</span>
                {subtitle && <span className="cr-context-sub">{subtitle}</span>}
              </span>
              {linear.url && <ExternalLink className="h-3.5 w-3.5 text-theme-subtle" />}
            </>
          );
          return linear.url ? (
            <a key={linear.issueId ?? linear.identifier ?? linear.url ?? 'linear'} href={linear.url} target="_blank" rel="noreferrer" className="cr-context-card">
              {content}
            </a>
          ) : (
            <div key={linear.issueId ?? linear.identifier ?? linear.title ?? 'linear'} className="cr-context-card">
              {content}
            </div>
          );
        })}
      </div>
    </RailSection>
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

function ExecutionStep({
  run,
  index,
  isLast,
  onAnswerWorkflowIntervention,
}: {
  run: SpawnedAgent;
  index: number;
  isLast: boolean;
  onAnswerWorkflowIntervention?: (input: WorkflowInterventionAnswer) => Promise<void> | void;
}) {
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
            <div className="step-name-row">
              <div className="truncate text-[13px] font-semibold text-theme-primary">{title}</div>
              <SidebarApprovalButton run={run} onAnswer={onAnswerWorkflowIntervention} className="cr-approval-button" />
            </div>
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
            {context.humanInput.title ?? approvalActionLabel(context)}
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

function getLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    bash: 'shell',
    c: 'c',
    cjs: 'javascript',
    cpp: 'cpp',
    css: 'css',
    dockerfile: 'dockerfile',
    env: 'ini',
    go: 'go',
    graphql: 'graphql',
    h: 'c',
    html: 'html',
    java: 'java',
    js: 'javascript',
    json: 'json',
    jsx: 'javascript',
    kt: 'kotlin',
    less: 'less',
    log: 'plaintext',
    md: 'markdown',
    mdx: 'markdown',
    mjs: 'javascript',
    prisma: 'graphql',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    scss: 'scss',
    sh: 'shell',
    sql: 'sql',
    swift: 'swift',
    tf: 'hcl',
    toml: 'ini',
    ts: 'typescript',
    tsx: 'typescript',
    txt: 'plaintext',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
    zsh: 'shell',
  };
  if (filePath.toLowerCase().endsWith('dockerfile')) return 'dockerfile';
  return map[ext] ?? 'plaintext';
}

function CodePreviewEditor({ filePath, value }: { filePath: string; value: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let resizeObserver: ResizeObserver | null = null;

    async function mountEditor() {
      try {
        const monaco = await import('monaco-editor');
        if (cancelled || !containerRef.current) return;

        monacoRef.current = monaco;
        setupMonaco(monaco);
        const editor = monaco.editor.create(containerRef.current, {
          automaticLayout: true,
          bracketPairColorization: { enabled: true },
          cursorBlinking: 'smooth',
          fontFamily: "'JetBrains Mono', 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          fontLigatures: true,
          fontSize: 12,
          folding: true,
          glyphMargin: false,
          language: getLanguage(filePath),
          lineDecorationsWidth: 8,
          lineNumbers: 'on',
          minimap: { enabled: true, scale: 1 },
          padding: { top: 12, bottom: 24 },
          readOnly: true,
          renderLineHighlight: 'line',
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          theme: getMonacoTheme(),
          value,
          wordWrap: 'off',
        });

        editorRef.current = editor;
        resizeObserver = new ResizeObserver(() => editor.layout());
        resizeObserver.observe(containerRef.current);
        requestAnimationFrame(() => editor.layout());
        setReady(true);
      } catch (error) {
        console.warn('[chat-files] monaco direct mount failed', error);
        if (!cancelled) setFailed(true);
      }
    }

    mountEditor();

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      editorRef.current?.dispose();
      editorRef.current = null;
      monacoRef.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    const model = editor.getModel();
    if (model && model.getValue() !== value) model.setValue(value);
    if (model) monaco.editor.setModelLanguage(model, getLanguage(filePath));
    requestAnimationFrame(() => editor.layout());
  }, [filePath, value]);

  if (failed) {
    return <pre>{value}</pre>;
  }

  return (
    <div className="ws-code-monaco" ref={containerRef}>
      {!ready && (
        <div className="cr-loading-state">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Loading editor...</span>
        </div>
      )}
    </div>
  );
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
    { id: 'files', label: 'Files', icon: FileText },
    { id: 'changes', label: 'Changes', icon: Code2 },
    { id: 'context', label: 'Context', icon: BookOpen },
  ];
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="tablist" aria-label="Chat resources">
      {tabs.map(tab => {
        const Icon = tab.icon;
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            className={`inline-flex min-w-max items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] leading-none transition-colors ${
              isActive
                ? 'border border-app-strong bg-app-card text-theme-primary shadow-sm'
                : 'border border-transparent text-theme-muted hover:bg-app-card/60 hover:text-theme-secondary'
            }`}
            onClick={() => onTabChange(tab.id)}
          >
            <Icon className={`h-3.5 w-3.5 ${isActive ? 'text-theme-primary' : 'text-theme-subtle'}`} aria-hidden="true" />
            <span>{tab.label}</span>
            {counts[tab.id] != null && counts[tab.id]! > 0 && (
              <span className={`font-mono text-[10.5px] ${isActive ? 'text-theme-secondary' : 'text-theme-subtle'}`}>
                {counts[tab.id]}
              </span>
            )}
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

function ChatContextPanel({ sessionId }: { sessionId?: string | null }) {
  const [report, setReport] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openAttemptId, setOpenAttemptId] = useState<string | null>(null);
  const attempts = (report?.attempts ?? []) as any[];

  useEffect(() => {
    if (!sessionId) {
      setReport(null);
      setOpenAttemptId(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    chatApi.getContextUsage(sessionId)
      .then((payload) => {
        if (!cancelled) setReport(payload);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load chat context');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [sessionId]);

  if (!sessionId) return <div className="cr-empty">Open a chat session to inspect context.</div>;
  if (loading && !report) return <div className="cr-empty">Loading chat context...</div>;
  if (error) return <div className="cr-empty">Failed to load chat context: {error}</div>;
  if (!attempts.length) return <div className="cr-empty">No chat context has been captured for this session yet.</div>;

  return (
    <div className="space-y-3 pb-6">
      <div className="cr-files-summary">
        <div>
          <span>chat context attempts</span>
          <strong>{attempts.length}</strong>
        </div>
      </div>
      {attempts.map((attempt, index) => {
        const attemptId = String(attempt.contextAttemptId ?? index);
        const open = openAttemptId === attemptId;
        const counts = chatContextAttemptCounts(attempt);
        return (
          <div key={attempt.contextAttemptId ?? index} className="rounded-lg border border-app bg-app-card">
            <button
              type="button"
              onClick={() => setOpenAttemptId(open ? null : attemptId)}
              className="w-full p-2 text-left"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex items-start gap-2">
                  {open ? <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-theme-subtle" /> : <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-theme-subtle" />}
                  <div className="min-w-0">
                    <div className="text-[12px] font-medium text-theme-primary line-clamp-2">
                      {attempt.turnPreview ?? attempt.turnText ?? `Chat turn ${index + 1}`}
                    </div>
                    <div className="mt-0.5 text-[10px] font-mono text-theme-subtle break-all">
                      {[attempt.repoName ?? attempt.indexId, attempt.messageId ? `message ${attempt.messageId}` : undefined].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                </div>
                <span className="shrink-0 rounded border border-app px-1.5 py-0.5 text-[10px] font-mono text-theme-subtle">
                  {counts.injected} injected · {counts.selected} selected · {counts.filtered} filtered
                </span>
              </div>
            </button>
            {open ? (
              <div className="border-t border-app p-2">
                <RepoContextInjectionPanel
                  contextAttempt={attempt}
                  title={attempt.contextInjection?.targetLayer === 'user_prompt' ? 'User-turn context injection' : 'Repo context injection'}
                  emptyText="No context refs captured for this chat turn."
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function chatContextAttemptCounts(attempt: any): { injected: number; selected: number; filtered: number } {
  const refs = Array.isArray(attempt?.refs) ? attempt.refs : [];
  const previouslyInjected = (ref: any) => ref?.providerMetadata?.previouslyInjected === true || ref?.filterReason === 'previously_injected';
  return {
    injected: refs.filter((ref: any) => ref?.isInjected || ['injected', 'loaded', 'applied', 'provider_native'].includes(String(ref?.lifecycleStatus ?? ''))).length,
    selected: refs.filter((ref: any) => previouslyInjected(ref) || String(ref?.lifecycleStatus ?? '') === 'selected' || String(ref?.injectionMode ?? '') === 'manifest').length,
    filtered: refs.filter((ref: any) => !previouslyInjected(ref) && (ref?.isFiltered || ['filtered', 'rejected', 'skipped'].includes(String(ref?.lifecycleStatus ?? '')))).length,
  };
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
  renderHeaderAction,
  renderFooter,
}: {
  run: SpawnedAgent;
  index: number;
  selectedExecutionId?: string | null;
  selectedNodeId?: string | null;
  renderHeaderAction?: (run: SpawnedAgent) => ReactNode;
  renderFooter?: (run: SpawnedAgent) => ReactNode;
}) {
  const context = run.runContext ?? null;
  const status = context?.status ?? run.status;
  const normalizedStatus = String(status).toLowerCase();
  const isActive = !TERMINAL_STATUSES.has(normalizedStatus);
  const isCancelled = CANCELLED_STATUSES.has(normalizedStatus);
  const isFailed = FAILED_STATUSES.has(normalizedStatus) || normalizedStatus === 'closed';
  const statusTone = isCancelled ? 'cancelled' : isFailed ? 'failed' : isActive ? 'running' : 'complete';
  const childAgents = context?.childAgents ?? [];
  const executionName = runDisplayName(context, run);
  const selected = selectedExecutionId === run.executionId;

  return (
    <details className={`cr-exec-detail ${statusTone}`} open={selected || undefined}>
      <summary>
        <ChevronRight className="cr-disclosure-icon h-3.5 w-3.5" />
        <span className="cr-ref-ic repo"><RunExecutionIcon context={context} /></span>
        <span className="cr-list-body">
          <span className="cr-list-title">
            <span>Execution {index + 1}: {executionName}</span>
            {(isActive || isCancelled || isFailed) && (
              <span className={`cr-run-state ${statusTone}`}>
                {isActive ? <Loader2 className="h-3 w-3 animate-spin" /> : statusIcon(status)}
                {humanLabel(status)}
              </span>
            )}
            {renderHeaderAction?.(run)}
          </span>
          <span className="cr-list-sub">{runTypeName(context, run)} · {isActive ? 'Active' : humanLabel(status)} · {formatCost(context?.execution.cost)}</span>
          <button
            type="button"
            className="cr-exec-id"
            title={`Copy execution id: ${run.executionId}`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void navigator.clipboard?.writeText(run.executionId);
            }}
          >
            <Copy className="h-3 w-3" />
            <span>{shortExecutionId(run.executionId)}</span>
          </button>
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
      {renderFooter?.(run)}
    </details>
  );
}

export function ExecutionsPanel({
  runs,
  selectedExecutionId,
  selectedNodeId,
  renderExecutionHeaderAction,
  renderExecutionFooter,
}: {
  runs: SpawnedAgent[];
  selectedExecutionId?: string | null;
  selectedNodeId?: string | null;
  renderExecutionHeaderAction?: (run: SpawnedAgent) => ReactNode;
  renderExecutionFooter?: (run: SpawnedAgent) => ReactNode;
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
          renderHeaderAction={renderExecutionHeaderAction}
          renderFooter={renderExecutionFooter}
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
      <details className={`cr-tree-dir ${node.status ?? ''}`} open={depth < 1 || Boolean(node.status)}>
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
  activeView,
  viewRequest,
}: {
  runs: SpawnedAgent[];
  rootType?: 'chat' | 'workflow' | 'agent';
  rootId?: string | null;
  repoBrowseSource?: RepoBrowseSource | null;
  activeView: FilePanelView;
  viewRequest?: { view: FilePanelView; nonce: number };
}) {
  const withTimeout = async <T,>(label: string, promise: Promise<T>, ms = 15_000): Promise<T> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
  const [files, setFiles] = useState<PanelDiffFile[]>([]);
  const [activeDiffPath, setActiveDiffPath] = useState('');
  const [diffMode, setDiffMode] = useState<'split' | 'unified'>('unified');
  const [view, setView] = useState<FilePanelView>('changes');
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFileEntry[]>([]);
  const [browserPath, setBrowserPath] = useState('');
  const [browserContent, setBrowserContent] = useState('');
  const [browserSource, setBrowserSource] = useState<{ kind: 'workspace' | 'repo'; id: string; name?: string | null } | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [fileReloadNonce, setFileReloadNonce] = useState(0);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminals, setTerminals] = useState<Array<{ id: string; label: string }>>([{ id: 'default', label: 'Terminal 1' }]);
  const [activeTerminalId, setActiveTerminalId] = useState('default');
  const [terminalHeight, setTerminalHeight] = useState(260);

  useEffect(() => {
    if (viewRequest) setView(viewRequest.view);
  }, [viewRequest]);

  useEffect(() => {
    setView(activeView);
  }, [activeView]);

  useEffect(() => {
    console.log('[chat-files] panel view state', {
      activeView,
      view,
      rootType,
      rootId,
      runCount: runs.length,
      repoBrowseSource: repoBrowseSource?.id ? {
        id: repoBrowseSource.id,
        name: repoBrowseSource.name ?? null,
        path: repoBrowseSource.path ?? null,
      } : null,
    });
  }, [activeView, view, rootType, rootId, runs.length, repoBrowseSource?.id, repoBrowseSource?.name, repoBrowseSource?.path]);

  const workspaceRefs = useMemo(() => {
    const refs: Array<{ id: string; name?: string | null; repoId?: string | null; mode: 'workspace' }> = [];
    for (const run of runs) {
      const id = run.runContext?.workspace?.id;
      if (!id) continue;
      refs.push({
        id,
        name: run.runContext?.workspace?.name ?? run.runContext?.workspace?.repoName,
        repoId: run.runContext?.workspace?.repoId ?? null,
        mode: 'workspace',
      });
    }
    return refs.reduce<Array<{ id: string; name?: string | null; repoId?: string | null; mode: 'workspace' }>>((acc, ref) => {
      const existing = acc.find(item => item.id === ref.id);
      if (!existing) acc.push(ref);
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
        const result = await workspacesApi.getDiff(ref.id, rootType === 'chat'
          ? { mode: ref.mode, anchor: 'creation' }
          : { mode: ref.mode });
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
  }, [signature, rootType, rootId]);

  const additions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  const activeWorkspace = workspaceRefs[0] ?? null;
  const terminalSource = activeWorkspace?.id
    ? { type: 'workspace' as const, id: activeWorkspace.id, name: activeWorkspace.name ?? 'Workspace terminal', href: `/workspaces/${activeWorkspace.id}` }
    : repoBrowseSource?.id
      ? { type: 'repo' as const, id: repoBrowseSource.id, name: repoBrowseSource.name ?? repoBrowseSource.path ?? 'Repository terminal', href: null }
      : null;
  const terminalId = rootId ? `chat-${rootId.replace(/[^a-zA-Z0-9_-]/g, '-')}` : 'chat-files';
  const activeDiff = files.find(file => file.path === activeDiffPath) ?? null;
  const changedStatuses = useMemo(() => new Map(files.map(file => [file.path, changedFileStatus(file)])), [files]);
  const fileTree = useMemo(() => buildFileTree(workspaceFiles, changedStatuses), [workspaceFiles, changedStatuses]);
  const diffFileTree = useMemo(() => buildFileTree(files.map(file => ({
    path: file.path,
    isDir: false,
    status: file.status,
  })), changedStatuses), [files, changedStatuses]);

  useEffect(() => {
    if (files.length === 0) {
      setActiveDiffPath('');
      return;
    }
    if (activeDiffPath && !files.some(file => file.path === activeDiffPath)) {
      setActiveDiffPath('');
    }
  }, [files, activeDiffPath]);

  useEffect(() => {
    if (view !== 'files') return;
    let cancelled = false;
    const nextRepoId = repoBrowseSource?.id ?? null;
    console.log('[chat-files] load file tree:start', {
      activeWorkspaceId: activeWorkspace?.id ?? null,
      activeWorkspaceName: activeWorkspace?.name ?? null,
      repoId: nextRepoId,
      repoName: repoBrowseSource?.name ?? repoBrowseSource?.path ?? null,
    });
    setBrowserLoading(true);
    (async () => {
      let result: WorkspaceFileEntry[] = [];
      let source: { kind: 'workspace' | 'repo'; id: string; name?: string | null } | null = null;

      if (activeWorkspace?.id) {
        try {
          console.log('[chat-files] request:start', { endpoint: 'workspaces.getAllFiles', workspaceId: activeWorkspace.id });
          result = (await withTimeout('workspaces.getAllFiles', workspacesApi.getAllFiles(activeWorkspace.id)) ?? []) as WorkspaceFileEntry[];
          source = { kind: 'workspace', id: activeWorkspace.id, name: activeWorkspace.name };
          console.log('[chat-files] load file tree:workspace success', {
            workspaceId: activeWorkspace.id,
            count: result.length,
          });
        } catch (err) {
          console.log('[chat-files] load file tree:workspace failed', {
            workspaceId: activeWorkspace.id,
            error: (err as Error).message,
          });
        }
      }

      if (!source && nextRepoId) {
        try {
          console.log('[chat-files] request:start', { endpoint: 'repos.getAllFiles', repoId: nextRepoId });
          result = (await withTimeout('repos.getAllFiles', reposApi.getAllFiles(nextRepoId)) ?? []) as WorkspaceFileEntry[];
          source = { kind: 'repo', id: nextRepoId, name: repoBrowseSource?.name ?? repoBrowseSource?.path ?? 'repository' };
          console.log('[chat-files] load file tree:repo success', {
            repoId: nextRepoId,
            count: result.length,
          });
        } catch (err) {
          console.log('[chat-files] load file tree:repo failed', {
            repoId: nextRepoId,
            error: (err as Error).message,
          });
        }
      }

      if (!cancelled) {
        console.log('[chat-files] load file tree:complete', {
          source,
          count: result.length,
        });
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
      if (!cancelled) {
        setBrowserLoading(false);
        console.log('[chat-files] load file tree:loading false');
      }
    });
    return () => {
      cancelled = true;
      setBrowserLoading(false);
      console.log('[chat-files] load file tree:cancelled');
    };
  }, [activeWorkspace?.id, activeWorkspace?.name, repoBrowseSource?.id, repoBrowseSource?.name, repoBrowseSource?.path, view, fileReloadNonce]);

  function addTerminal() {
    const nextIndex = terminals.length + 1;
    const id = `${Date.now().toString(36)}-${nextIndex}`;
    setTerminals(current => [...current, { id, label: `Terminal ${nextIndex}` }]);
    setActiveTerminalId(id);
    setTerminalOpen(true);
  }

  function closeTerminal(id: string) {
    setTerminals(current => {
      if (current.length === 1) return current;
      const next = current.filter(item => item.id !== id);
      if (activeTerminalId === id) setActiveTerminalId(next[0]?.id ?? 'default');
      return next;
    });
  }

  function startTerminalResize(event: ReactMouseEvent<HTMLDivElement>) {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = terminalHeight;
    const onMove = (moveEvent: MouseEvent) => {
      const delta = startY - moveEvent.clientY;
      setTerminalHeight(Math.max(170, Math.min(520, startHeight + delta)));
      window.dispatchEvent(new Event('resize'));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.dispatchEvent(new Event('resize'));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  async function openBrowserFile(path: string) {
    const source = browserSource ?? (activeWorkspace?.id
      ? { kind: 'workspace' as const, id: activeWorkspace.id, name: activeWorkspace.name }
      : repoBrowseSource?.id
        ? { kind: 'repo' as const, id: repoBrowseSource.id, name: repoBrowseSource.name }
        : null);
    if (!source) {
      console.log('[chat-files] open file:missing source', { path, activeWorkspaceId: activeWorkspace?.id ?? null, repoId: repoBrowseSource?.id ?? null });
      return;
    }
    console.log('[chat-files] open file:start', { path, source });
    setBrowserPath(path);
    setFileLoading(true);
    try {
      console.log('[chat-files] request:start', {
        endpoint: source.kind === 'workspace' ? 'workspaces.getFile' : 'repos.getFile',
        sourceId: source.id,
        path,
      });
      const file = source.kind === 'workspace'
        ? await withTimeout('workspaces.getFile', workspacesApi.getFile(source.id, path))
        : await withTimeout('repos.getFile', reposApi.getFile(source.id, path));
      console.log('[chat-files] open file:success', {
        path,
        source,
        isImage: Boolean(file.isImage),
        contentLength: typeof file.content === 'string' ? file.content.length : null,
      });
      setBrowserContent(file.isImage ? '[binary image preview is available in the dedicated editor]' : file.content ?? '');
    } catch (err) {
      const diffBackedContent = files.find(file => file.path === path)?.modifiedContent;
      console.log('[chat-files] open file:failed', {
        path,
        source,
        error: (err as Error).message,
        fallbackContentLength: diffBackedContent?.length ?? null,
      });
      setBrowserContent(diffBackedContent ?? `Failed to load ${path}: ${(err as Error).message}`);
    } finally {
      setFileLoading(false);
      console.log('[chat-files] open file:loading false', { path });
    }
  }

  if (files.length === 0 && workspaceRefs.length === 0 && pullRequestRefs.length === 0 && !repoBrowseSource?.id) {
    return <div className="cr-empty">No file changes are linked to this chat yet.</div>;
  }

  const renderDiffPreview = (file: PanelDiffFile | null) => (
    <section className="cr-adjacent-preview">
      <div className="ws-diff-h">
        <FileText className="h-3.5 w-3.5 text-theme-muted" />
        <span className="mono truncate">{file?.path ?? 'Code changes'}</span>
        <div className="ws-diff-h-r">
          {file && (
            <>
              <span className="add">+{file.additions ?? 0}</span>
              <span className="del">-{file.deletions ?? 0}</span>
            </>
          )}
          <div className="ws-diff-mode" role="group" aria-label="Diff view mode">
            <button className={diffMode === 'unified' ? 'active' : ''} onClick={() => setDiffMode('unified')} type="button">unified</button>
            <button className={diffMode === 'split' ? 'active' : ''} onClick={() => setDiffMode('split')} type="button">split</button>
          </div>
        </div>
      </div>
      <div className="ws-diff-body">
        {file ? (
          <div className="cr-file-detail-diff browse-diff">
            {diffMode === 'split'
              ? <SplitDiffView key={`${file.path}:split`} file={file} />
              : <UnifiedDiffView key={`${file.path}:unified`} file={file} />}
          </div>
        ) : (
          <div className="ws-diff-empty">Select a changed file to preview the diff.</div>
        )}
      </div>
    </section>
  );

  const renderFilePreview = () => (
    <section className="cr-adjacent-preview">
      <div className="ws-diff-h">
        <FileText className="h-3.5 w-3.5 text-theme-muted" />
        <span className="truncate">{browserPath || browserSource?.name || activeWorkspace?.name || repoBrowseSource?.name || 'Repository files'}</span>
      </div>
      {browserLoading ? (
        <div className="cr-loading-state"><Loader2 className="h-4 w-4 animate-spin" /><span>Loading workspace files...</span></div>
      ) : fileLoading ? (
        <div className="cr-loading-state"><Loader2 className="h-4 w-4 animate-spin" /><span>Loading file...</span></div>
      ) : browserPath ? (
        <div className="ws-code-preview">
          <CodePreviewEditor key={browserPath} filePath={browserPath} value={browserContent} />
        </div>
      ) : (
        <div className="ws-diff-empty">Select a file to preview it here.</div>
      )}
    </section>
  );

  const renderTerminalDock = () => {
    if (!terminalSource || !terminalOpen) return null;
    const activeTerminal = terminals.find(item => item.id === activeTerminalId) ?? terminals[0];
    return (
      <div className="cr-terminal-dock" style={{ height: terminalHeight }}>
        <div className="cr-terminal-resize" onMouseDown={startTerminalResize} title="Resize terminal" />
        <div className="cr-terminal-tabs">
          {terminals.map(item => (
            <button
              key={item.id}
              type="button"
              className={item.id === activeTerminal.id ? 'active' : ''}
              onClick={() => setActiveTerminalId(item.id)}
            >
              <Terminal className="h-3 w-3" />
              <span>{item.label}</span>
              {terminals.length > 1 && (
                <X
                  className="h-3 w-3"
                  onClick={(event) => {
                    event.stopPropagation();
                    closeTerminal(item.id);
                  }}
                />
              )}
            </button>
          ))}
          <button type="button" className="icon" onClick={addTerminal} title="Open another terminal">
            +
          </button>
        </div>
        <div className="cr-terminal-body">
          <XTerminal workspaceId={terminalSource.id} sourceType={terminalSource.type} terminalId={`${terminalId}-${activeTerminal.id}`} className="h-full" />
        </div>
      </div>
    );
  };

  return (
    <div className="cr-files-panel">
      {view === 'changes' && (
        <div className="cr-files-summary">
          <span className="inline-flex items-center gap-1.5"><Code2 className="h-3.5 w-3.5" />{files.length} changed</span>
          <span className="spacer" />
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
        </div>
      )}

      {view === 'changes' ? (
        loading ? (
          <div className="cr-empty">Checking workspace changes...</div>
        ) : (
        <>
        <div className="ws-main ws-panel cr-workspace-view cr-rail-list-only">
          <aside className="ws-tree scroll-hide">
            <div className="ws-tree-h">
              <span>files changed</span>
              <span className="mono ws-tree-ct">{files.length}</span>
            </div>
            <div className="ws-tree-list">
              {files.length === 0 ? (
                <div className="ws-tree-empty">No changed files were found in the linked workspaces.</div>
              ) : diffFileTree.map(node => (
                <FileTreeNodeView
                  key={node.path}
                  node={node}
                  activePath={activeDiffPath}
                  onOpenFile={setActiveDiffPath}
                />
              ))}
            </div>
          </aside>
        </div>
        {activeDiff && renderDiffPreview(activeDiff)}
        </>
        )
      ) : (
        <>
        <div className="ws-files-body ws-panel cr-workspace-view cr-rail-file-stack">
          <aside className="ws-files-list scroll-hide">
            <div className="ws-tree-h">
              <span>Explorer</span>
              <span className="ws-tree-actions">
                {terminalSource && (
                  <>
                    <button type="button" className={terminalOpen ? 'active' : ''} onClick={() => setTerminalOpen(value => !value)} title="Toggle terminal">
                      <Terminal className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
                <button type="button" onClick={() => setFileReloadNonce(value => value + 1)} title="Refresh files">
                  <RefreshCw className="h-3.5 w-3.5" />
                </button>
              </span>
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
          {renderTerminalDock()}
        </div>
        {browserPath && renderFilePreview()}
        </>
      )}
    </div>
  );
}

function TasksPanel({
  activeRun,
  activeContext,
  sortedRuns,
  contextRuns,
  expanded,
  onOpenNode,
  onOpenExecution,
  onAnswerWorkflowIntervention,
}: {
  activeRun: SpawnedAgent;
  activeContext: RunStatus | null;
  sortedRuns: SpawnedAgent[];
  contextRuns: SpawnedAgent[];
  expanded: boolean;
  onOpenNode: (executionId: string, nodeId: string) => void;
  onOpenExecution: (executionId: string) => void;
  onAnswerWorkflowIntervention?: (input: WorkflowInterventionAnswer) => Promise<void> | void;
}) {
  const attemptRuns = sortedRuns;
  const showAttempts = attemptRuns.length > 1;
  const activeWorkflowSteps = workflowStepsForContext(activeContext);
  const showWorkflowNodes = !showAttempts && activeContext?.runType === 'workflow' && activeWorkflowSteps.length > 0;

  return (
    <div className={`cr-task-panel ${expanded ? 'expanded' : 'compact'}`}>
      <WorkContextSection runs={contextRuns} />

      {showAttempts && (
        <RailSection title="runs" count={`${attemptRuns.length}`}>
          <div className="cr-steps">
            {attemptRuns.map((run, index) => (
              <AttemptRow
                key={run.executionId}
                run={run}
                index={index}
                onOpenNode={onOpenNode}
                onOpenExecution={onOpenExecution}
                onAnswerWorkflowIntervention={onAnswerWorkflowIntervention}
              />
            ))}
          </div>
        </RailSection>
      )}

      {showWorkflowNodes ? (
        <div className="rounded-md border border-app bg-app-card/30 p-2">
          <WorkflowExecutionHeader run={activeRun} context={activeContext!} />
          <div className="mt-2 border-t border-app pt-3">
            <RailSection title="workflow steps" count={`${activeContext?.progress.completed ?? 0}/${activeContext?.progress.total ?? activeWorkflowSteps.length}`}>
              <div className="cr-steps">
                {activeWorkflowSteps.map((step, index) => (
                  <WorkflowNodeStep
                    key={step.id}
                    step={step}
                    isLast={index === activeWorkflowSteps.length - 1}
                    onOpenDetails={(nodeId) => onOpenNode(activeRun.executionId, nodeId)}
                  />
                ))}
              </div>
            </RailSection>
          </div>
        </div>
      ) : !showAttempts ? (
        <RailSection title="steps" count={`${sortedRuns.length}`}>
          <div className="cr-steps">
            {sortedRuns.map((run, index) => (
              <ExecutionStep
                key={run.executionId}
                run={run}
                index={index}
                isLast={index === sortedRuns.length - 1}
                onAnswerWorkflowIntervention={onAnswerWorkflowIntervention}
              />
            ))}
          </div>
        </RailSection>
      ) : null}

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
  filesViewRequest,
  onAnswerWorkflowIntervention,
  onClose,
}: {
  runs: SpawnedAgent[];
  rootType?: 'chat' | 'workflow' | 'agent';
  rootId?: string | null;
  repoBrowseSource?: RepoBrowseSource | null;
  open: boolean;
  activeTab: ChatRunPanelTab;
  onTabChange: (tab: ChatRunPanelTab) => void;
  filesViewRequest?: { view: FilePanelView; nonce: number };
  onAnswerWorkflowIntervention?: (input: WorkflowInterventionAnswer) => Promise<void> | void;
  onClose: () => void;
}) {
  const allRuns = useMemo(() => [...runs], [runs]);
  const sortedRuns = useMemo(() => allRuns.filter(run => !isChildExecutionRun(run)), [allRuns]);
  const visibleTab: Exclude<ChatRunPanelTab, 'executions'> = activeTab === 'executions' ? 'tasks' : activeTab;
  const [width, setWidth] = useState(() => {
    return CHAT_RUN_SIDEBAR_MIN_WIDTH;
  });
  const fullScreen = false;
  const activeRun = sortedRuns.find(run => {
    const status = (run.runContext?.status ?? run.status ?? '').toLowerCase();
    return !['completed', 'failed', 'cancelled', 'canceled'].includes(status);
  }) ?? sortedRuns[sortedRuns.length - 1] ?? null;
  const activeContext = activeRun?.runContext ?? null;
  const workspaceCount = new Set(allRuns.map(run => run.runContext?.workspace?.id).filter(Boolean)).size;
  const pullRequestCount = new Set(allRuns.map(run => run.runContext?.pullRequest?.id).filter(Boolean)).size;
  const repoBrowseCount = repoBrowseSource?.id ? 1 : 0;
  const counts: Partial<Record<ChatRunPanelTab, number>> = {
    tasks: sortedRuns.length,
    files: Math.max(workspaceCount, pullRequestCount, repoBrowseCount),
    changes: Math.max(workspaceCount, pullRequestCount),
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
  }, [open, fullScreen, visibleTab]);

  if (!open) return null;

  function startResize(event: ReactMouseEvent<HTMLDivElement>) {
    if (fullScreen) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const onMove = (moveEvent: MouseEvent) => {
      const delta = startX - moveEvent.clientX;
      const max = Math.max(560, window.innerWidth - 360);
      setWidth(Math.max(CHAT_RUN_SIDEBAR_MIN_WIDTH, Math.min(max, startWidth + delta)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  return (
    <aside
      className={`chat-rail relative flex h-full flex-none flex-col gap-3 overflow-visible border-l border-app bg-app-muted px-3.5 pt-2.5 ${visibleTab === 'files' || visibleTab === 'changes' ? 'pb-0' : 'pb-8'} ${
        fullScreen ? 'fullscreen absolute inset-0 z-[80] h-full w-full max-w-none border-l-0 px-5' : ''
      }`}
      style={fullScreen ? undefined : { width }}
    >
      {!fullScreen && <div className="chat-rail-resize" onMouseDown={startResize} title="Drag to resize" />}
      <div className="sticky top-0 z-20 flex shrink-0 items-center justify-between gap-2 border-b border-app-strong bg-app-muted pb-2">
        <PanelTabs activeTab={visibleTab} onTabChange={onTabChange} counts={counts} />
        <div className="inline-flex shrink-0 items-center">
          <button type="button" className="rounded p-1.5 text-theme-muted transition-colors hover:bg-app-card hover:text-theme-primary" onClick={onClose} title="Close side panel" aria-label="Close side panel">
            <PanelRightClose className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="relative min-h-0 w-full flex-1 overflow-visible">
        <div className={`h-full w-full min-h-0 ${visibleTab === 'files' || visibleTab === 'changes' ? 'flex flex-col overflow-visible' : 'scroll-hide overflow-y-auto overflow-x-hidden pr-1'} ${visibleTab}`}>
        {visibleTab === 'tasks' && (
          activeRun
            ? (
              <TasksPanel
                activeRun={activeRun}
                activeContext={activeContext}
                sortedRuns={sortedRuns}
                contextRuns={allRuns}
                expanded={fullScreen}
                onOpenNode={() => undefined}
                onOpenExecution={() => undefined}
                onAnswerWorkflowIntervention={onAnswerWorkflowIntervention}
              />
            )
            : <div className="cr-empty">No task sequence is linked to this chat yet.</div>
        )}
        {(visibleTab === 'files' || visibleTab === 'changes') && (
          <FileChangesPanel
            runs={allRuns}
            rootType={rootType}
            rootId={rootId}
            repoBrowseSource={repoBrowseSource}
            activeView={visibleTab}
            viewRequest={filesViewRequest}
          />
        )}
        {visibleTab === 'context' && <ChatContextPanel sessionId={rootType === 'chat' ? rootId : null} />}
        </div>
      </div>
    </aside>
  );
}
