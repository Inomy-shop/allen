import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
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
  PlayCircle,
  RefreshCw,
  Rows3,
  SkipForward,
  StopCircle,
  Terminal,
  Timer,
  Code2,
  X,
} from 'lucide-react';
import type { SpawnedAgent, WorkflowInterventionAnswer } from '../../hooks/useChat';
import { artifacts as artifactsApi, repos as reposApi, type ArtifactDoc, type RunStatus } from '../../services/api';
import { chatCodeDiffs, pullRequests as pullRequestsApi, workspaces as workspacesApi } from '../../services/workspaceService';
import { workspaceChatPath } from '../../lib/workspace-routes';
import { resourceScopeKey, useDocumentTabStore } from '../../stores/documentTabStore';
import { WorkflowInterventionAction, type WorkflowInterventionLike } from '../execution/WorkflowInterventionAction';
import { XTerminal } from '../workspace/XTerminal';
import { getMonacoTheme, setupMonaco } from '../../lib/monaco-theme';
import { renderMarkdown } from './ChatMessageList';
import ChatContextPanel from './ChatContextPanel';
import TokenUsageDisplay from '../common/TokenUsageDisplay';
import { humanLabel } from '../../lib/model-catalog';
import { getModelDisplay } from '../../hooks/useModelRegistry';

const FAILED_STATUSES = new Set(['failed', 'failure', 'error', 'errored']);
const CANCELLED_STATUSES = new Set(['cancelled', 'canceled']);
const TERMINAL_STATUSES = new Set(['completed', 'merged', 'failed', 'failure', 'error', 'errored', 'cancelled', 'canceled', 'closed']);
const SUCCESSFUL_TERMINAL_STATUSES = new Set(['completed', 'merged']);
const PROGRESS_COUNTED_STEP_STATUSES = new Set(['completed', 'skipped']);
const CHAT_RUN_SIDEBAR_MIN_WIDTH = 340;

export type ChatRunPanelTab = 'tasks' | 'executions' | 'documents' | 'files' | 'changes' | 'context';
export type FilePanelView = 'files' | 'changes';

type RepoBrowseSource = {
  id?: string | null;
  name?: string | null;
  path?: string | null;
};
type WorkspaceBrowseSource = {
  id?: string | null;
  name?: string | null;
  repoId?: string | null;
};
type SidebarWorkflowStep = NonNullable<RunStatus['workflowSteps']>[number];

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

function shortTimeAgo(dateStr?: string | null): string {
  const value = timeAgo(dateStr);
  if (value === 'just now' || value === 'recently') return 'now';
  return value.replace(/ ago$/, '');
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
  if (hydratedSteps.length > 0) return normalizeWorkflowStepStatuses(hydratedSteps, context?.status);
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

function workflowStepHasRunData(step: SidebarWorkflowStep): boolean {
  return (step.attempts ?? 0) > 0
    || Boolean(step.startedAt || step.completedAt || step.durationMs || step.io?.input || step.io?.output);
}

function normalizeWorkflowStepStatuses(steps: SidebarWorkflowStep[], runStatus?: string | null): SidebarWorkflowStep[] {
  const successfulTerminalRun = SUCCESSFUL_TERMINAL_STATUSES.has(String(runStatus ?? '').toLowerCase());
  const progressedIndexes = steps
    .map((step, index) => {
      const status = String(step.status ?? '').toLowerCase();
      const hasRunData = workflowStepHasRunData(step);
      return (status !== 'pending' && status !== 'not_started') || hasRunData ? index : -1;
    })
    .filter(index => index >= 0);
  const lastProgressedIndex = progressedIndexes.length > 0 ? Math.max(...progressedIndexes) : -1;

  return steps.map((step, index) => {
    const normalized = String(step.status ?? '').toLowerCase();
    const hasRunData = workflowStepHasRunData(step);
    if (
      (normalized === 'pending' || normalized === 'not_started' || normalized === 'queued')
      && !hasRunData
      && (successfulTerminalRun || index < lastProgressedIndex)
    ) {
      return { ...step, status: 'skipped' };
    }
    return step;
  });
}

function workflowProgressLabel(context: RunStatus | null, steps: SidebarWorkflowStep[]): string {
  const total = context?.progress.total ?? steps.length;
  if (SUCCESSFUL_TERMINAL_STATUSES.has(String(context?.status ?? '').toLowerCase()) && total > 0) {
    return `${total}/${total}`;
  }
  if (steps.length === 0) return `${context?.progress.completed ?? 0}/${total}`;
  const counted = steps.filter(step => PROGRESS_COUNTED_STEP_STATUSES.has(String(step.status ?? '').toLowerCase())).length;
  return `${counted}/${total}`;
}

function workflowProgressPercent(
  context: RunStatus | null,
  fallbackStatus?: string | null,
  fallbackPercent = 0,
): number {
  const status = String(context?.status ?? fallbackStatus ?? '').toLowerCase();
  if (SUCCESSFUL_TERMINAL_STATUSES.has(status)) return 100;
  return Math.max(0, Math.min(100, context?.progress.percent ?? fallbackPercent));
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

function nodeStepState(status?: string | null): 'ok' | 'skip' | 'run' | 'wait-you' | 'fail' | 'wait' {
  const normalized = (status ?? '').toLowerCase();
  if (normalized === 'completed') return 'ok';
  if (normalized === 'skipped') return 'skip';
  if (normalized === 'running') return 'run';
  if (normalized === 'waiting_for_input' || normalized === 'waiting') return 'wait-you';
  if (FAILED_STATUSES.has(normalized) || CANCELLED_STATUSES.has(normalized)) return 'fail';
  return 'wait';
}

function nodeDisplayMeta(step: NonNullable<RunStatus['workflowSteps']>[number]): string {
  const normalized = (step.status ?? '').toLowerCase();
  const actor = step.agent || humanLabel(step.type ?? 'node');
  if (normalized === 'skipped') return `${actor} · skipped`;
  if (normalized === 'pending' || normalized === 'not_started') return `${actor} · pending`;
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
    step.model ? getModelDisplay(step.agent ?? '', step.model).modelLabel : null,
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
        {state === 'skip' && <SkipForward className="h-3 w-3" aria-label="Skipped" />}
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
  const workflowSteps = workflowStepsForContext(context);
  const progress = `${workflowProgressLabel(context, workflowSteps)} steps`;
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
  const percent = workflowProgressPercent(context, run.status, state === 'ok' ? 100 : 0);
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
        <Link to={context.workspace.id ? workspaceChatPath(context.workspace.id) : `/executions/${run.executionId}`} className="cr-ref">
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
      <div className="cr-context-grid compact">
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
            <Link key={workspace.id} to={workspaceChatPath(workspace.id)} className="cr-context-card">
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
  const [loadingArtifactId, setLoadingArtifactId] = useState<string | null>(null);
  const openDocument = useDocumentTabStore(state => state.openDocument);

  async function openArtifact(artifact: RunStatus['artifacts'][number]) {
    const scopeKey = run.runContext?.chat?.sessionId
      ? resourceScopeKey('chat', run.runContext.chat.sessionId)
      : resourceScopeKey('execution', run.executionId);
    setLoadingArtifactId(artifact.artifactId);
    try {
      openDocument(await artifactsApi.get(artifact.artifactId), { sourceLabel: 'Chat', scopeKey });
    } catch {
      openDocument(fallbackArtifactDoc(artifact, run), { sourceLabel: 'Chat', scopeKey });
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
  const percent = workflowProgressPercent(context, run.status);
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
            {context?.execution.tokenUsage && (
              <div className="mt-0.5">
                <TokenUsageDisplay tokenUsage={context.execution.tokenUsage} />
              </div>
            )}
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

type ArtifactRootRef = {
  rootType: 'chat' | 'workflow' | 'agent';
  rootId: string;
};

function usePanelArtifactItems({
  rootType,
  rootId,
  runs,
  refreshKey,
}: {
  rootType?: 'chat' | 'workflow' | 'agent';
  rootId?: string | null;
  runs: SpawnedAgent[];
  refreshKey?: string | number;
}) {
  const [loadedItems, setLoadedItems] = useState<{ scopeKey: string; items: PanelArtifactItem[] }>({
    scopeKey: '',
    items: [],
  });

  // In a chat panel, execution artifacts are only valid when the run carries
  // explicit ownership for the active chat. Never infer ownership from stale
  // React state or from whichever conversation happened to be open before it.
  const scopedRuns = useMemo(() => {
    if (rootType === 'chat' && !rootId) return [];
    if (rootType !== 'chat') return runs;
    return runs.filter(run => run.chatSessionId === rootId);
  }, [rootType, rootId, runs]);

  const artifactRoots = useMemo(() => {
    const roots = new Map<string, ArtifactRootRef>();
    const addRoot = (type: ArtifactRootRef['rootType'] | undefined, id: string | null | undefined) => {
      if (!type || !id) return;
      roots.set(`${type}:${id}`, { rootType: type, rootId: id });
    };

    addRoot(rootType, rootId);
    for (const run of scopedRuns) {
      const runRootType = run.kind === 'workflow' || run.runContext?.runType === 'workflow' ? 'workflow' : 'agent';
      addRoot(runRootType, run.executionId);
    }
    return [...roots.values()];
  }, [rootType, rootId, scopedRuns]);

  const runtimeItems = useMemo(() => {
    const next: PanelArtifactItem[] = [];
    for (const run of scopedRuns) {
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
  }, [scopedRuns]);

  const scopeKey = useMemo(
    () => artifactRoots.map(root => `${root.rootType}:${root.rootId}`).join('|'),
    [artifactRoots],
  );
  const items = loadedItems.scopeKey === scopeKey ? loadedItems.items : [];

  useEffect(() => {
    if (artifactRoots.length === 0) {
      setLoadedItems({ scopeKey, items: [] });
      return;
    }
    let cancelled = false;
    // Do not render results retained from the previously selected chat while
    // the newly scoped artifact requests are in flight.
    setLoadedItems({ scopeKey, items: [] });
    Promise.all(artifactRoots.map(root => artifactsApi.list({ ...root, limit: 50 })))
      .then(lists => {
        if (cancelled) return;
        setLoadedItems({
          scopeKey,
          items: lists.flat().map(item => ({
            artifactId: item.artifactId,
            filename: item.filename,
            relativePath: item.relativePath,
            contentType: item.contentType,
            createdAt: item.createdAt,
          })),
        });
      })
      .catch(() => {
        if (!cancelled) setLoadedItems({ scopeKey, items: [] });
      });

    return () => {
      cancelled = true;
    };
  }, [artifactRoots, refreshKey, scopeKey]);

  return useMemo(() => {
    const seen = new Set<string>();
    return [...items, ...runtimeItems].filter(item => {
      if (seen.has(item.artifactId)) return false;
      seen.add(item.artifactId);
      return true;
    });
  }, [items, runtimeItems]);
}

function panelArtifactLabel(item: PanelArtifactItem): string {
  if (item.runtimeArtifact) return artifactTypeLabel(item.runtimeArtifact);
  return humanLabel(item.contentType ?? 'file').toLowerCase();
}

function ChatArtifactsSummarySection({
  rootType,
  rootId,
  runs,
  refreshKey,
}: {
  rootType?: 'chat' | 'workflow' | 'agent';
  rootId?: string | null;
  runs: SpawnedAgent[];
  refreshKey?: string | number;
}) {
  const artifacts = usePanelArtifactItems({ rootType, rootId, runs, refreshKey });
  const [expanded, setExpanded] = useState(false);
  const [loadingArtifactId, setLoadingArtifactId] = useState<string | null>(null);
  const openDocument = useDocumentTabStore(state => state.openDocument);

  async function openArtifact(item: PanelArtifactItem) {
    const scopeKey = rootType === 'chat' && rootId ? resourceScopeKey('chat', rootId) : undefined;
    setLoadingArtifactId(item.artifactId);
    try {
      openDocument(await artifactsApi.get(item.artifactId), { sourceLabel: 'Chat', scopeKey });
    } catch {
      if (item.runtimeArtifact && item.sourceRun) {
        openDocument(fallbackArtifactDoc(item.runtimeArtifact, item.sourceRun), { sourceLabel: 'Chat', scopeKey });
      }
    } finally {
      setLoadingArtifactId(null);
    }
  }

  if (artifacts.length === 0) return null;

  return (
    <section className="cr-section cr-artifacts-summary">
      <button type="button" className="cr-section-toggle" onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>
        <h6>
          artifacts
          <span className="cr-ct">{artifacts.length}</span>
        </h6>
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>
      {expanded && (
        <div className="cr-section-body cr-artifacts-summary-list">
          {artifacts.map(item => (
            <button
              key={item.artifactId}
              type="button"
              className={`cr-art compact ${loadingArtifactId === item.artifactId ? 'loading' : ''}`}
              onClick={() => openArtifact(item)}
            >
              <span className="cr-art-ic"><FileText className="h-3 w-3" /></span>
              <span className="cr-art-body">
                <span className="cr-art-h">
                  <span className="cr-art-title">{item.filename ?? item.relativePath ?? 'Artifact'}</span>
                </span>
                <span className="cr-art-sub">{panelArtifactLabel(item)} · {timeAgo(item.createdAt)}</span>
              </span>
              {loadingArtifactId === item.artifactId ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-theme-subtle" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 text-theme-subtle" />
              )}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

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
  sourceType?: 'workspace' | 'pull-request' | 'snapshot';
  sourceId?: string;
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

function hasDiffContent(file?: Pick<PanelDiffFile, 'diff' | 'originalContent' | 'modifiedContent'> | null): boolean {
  return Boolean(file?.diff?.trim() || file?.originalContent?.trim() || file?.modifiedContent?.trim());
}

function isChangedDiffFile(file: { path?: string; additions?: number; deletions?: number; status?: string; diff?: string; modifiedContent?: string }): boolean {
  return Boolean(file.path) && (
    Number(file.additions ?? 0) > 0 ||
    Number(file.deletions ?? 0) > 0 ||
    Boolean(file.status) ||
    hasDiffContent(file)
  );
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
}: {
  activeTab: ChatRunPanelTab;
  onTabChange: (tab: ChatRunPanelTab) => void;
}) {
  const tabs: Array<{ id: ChatRunPanelTab; label: string; icon: React.ElementType }> = [
    { id: 'tasks', label: 'Tasks', icon: ListTree },
    { id: 'documents', label: 'Docs', icon: FileText },
    { id: 'files', label: 'Files', icon: FileText },
    { id: 'changes', label: 'Changes', icon: Code2 },
    { id: 'context', label: 'Context', icon: BookOpen },
  ];
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden" role="tablist" aria-label="Chat resources">
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
  const merged = usePanelArtifactItems({ rootType, rootId, runs });
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(true);
  const openDocument = useDocumentTabStore(state => state.openDocument);

  async function openArtifact(item: PanelArtifactItem) {
    const scopeKey = rootType === 'chat' && rootId ? resourceScopeKey('chat', rootId) : undefined;
    setLoadingId(item.artifactId);
    try {
      openDocument(await artifactsApi.get(item.artifactId), { sourceLabel: 'Chat', scopeKey });
    } catch {
      if (item.runtimeArtifact && item.sourceRun) {
        openDocument(fallbackArtifactDoc(item.runtimeArtifact, item.sourceRun), { sourceLabel: 'Chat', scopeKey });
      }
    } finally {
      setLoadingId(null);
    }
  }

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
                className="cr-list-row"
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
        <div className="cr-inline-viewer"><div className="cr-empty">Select an artifact to open it as a document tab.</div></div>
      </div>
    </div>
  );
}

function ChatDocumentsPanel({
  rootType,
  rootId,
  runs,
  refreshKey,
  onClose,
  onDocumentOpened,
}: {
  rootType?: 'chat' | 'workflow' | 'agent';
  rootId?: string | null;
  runs: SpawnedAgent[];
  refreshKey?: string | number;
  onClose: () => void;
  onDocumentOpened?: () => void;
}) {
  const items = usePanelArtifactItems({ rootType, rootId, runs, refreshKey });
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const openDocument = useDocumentTabStore(state => state.openDocument);
  const documents = items.filter(item => /markdown|document|text|json|csv|html/i.test(item.contentType ?? '') || /\.(md|mdx|txt|json|csv|html?)$/i.test(item.filename ?? item.relativePath ?? ''));
  const other = items.filter(item => !documents.includes(item));

  async function openArtifact(item: PanelArtifactItem) {
    const scopeKey = rootType === 'chat' && rootId ? resourceScopeKey('chat', rootId) : undefined;
    setLoadingId(item.artifactId);
    let opened = false;
    try {
      openDocument(await artifactsApi.get(item.artifactId), { sourceLabel: 'Chat', scopeKey });
      opened = true;
    } catch {
      if (item.runtimeArtifact && item.sourceRun) {
        openDocument(fallbackArtifactDoc(item.runtimeArtifact, item.sourceRun), { sourceLabel: 'Chat', scopeKey });
        opened = true;
      }
    } finally {
      setLoadingId(null);
    }
    if (opened) onDocumentOpened?.();
  }

  const renderRows = (rows: PanelArtifactItem[]) => rows.map(item => (
    <button key={item.artifactId} type="button" className="chat-docs-row" onClick={() => openArtifact(item)}>
      <FileText aria-hidden="true" />
      <b>{item.filename ?? item.relativePath ?? 'Artifact'}</b>
      <em>v1</em>
      <time>{shortTimeAgo(item.createdAt)}</time>
      {loadingId === item.artifactId ? <Loader2 className="animate-spin" /> : <ChevronRight />}
    </button>
  ));

  return (
    <div className="chat-docs-panel">
      <header>
        <b>Docs</b><span>· {items.length}</span>
        <button type="button" onClick={onClose} title="Close panel" aria-label="Close panel"><X /></button>
      </header>
      <div className="chat-docs-scroll">
        <section>
          <h6>documents <span>· {documents.length}</span></h6>
          {documents.length ? renderRows(documents) : <p>No documents saved yet.</p>}
        </section>
        {other.length > 0 && <section><h6>read <span>· {other.length}</span></h6>{renderRows(other)}</section>}
      </div>
      <footer><Link to="/documents">All documents <span>→</span></Link></footer>
    </div>
  );
}

function CompactPanelShell({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="chat-compact-panel">
      <header>
        <b>{title}</b>
        <button type="button" onClick={onClose} title="Close panel" aria-label="Close panel"><X /></button>
      </header>
      <div className="chat-compact-panel__scroll">{children}</div>
    </div>
  );
}

function CompactTaskState({ status }: { status?: string | null }) {
  const state = nodeStepState(status);
  if (state === 'ok') return <CheckCircle2 className="ok" aria-hidden="true" />;
  if (state === 'skip') return <SkipForward className="skip" role="img" aria-label="Skipped" />;
  if (state === 'run') return <Loader2 className="run animate-spin" aria-hidden="true" />;
  if (state === 'fail') return <AlertTriangle className="fail" aria-hidden="true" />;
  if (state === 'wait-you') return <HelpCircle className="wait-you" aria-hidden="true" />;
  return <span className="todo" aria-hidden="true" />;
}

function compactTaskStatus(status?: string | null): string {
  const normalized = (status ?? '').toLowerCase();
  if (normalized === 'completed') return 'completed';
  if (normalized === 'running') return 'running';
  if (normalized === 'waiting_for_input' || normalized === 'waiting') return 'waiting for you';
  if (normalized === 'skipped') return 'skipped';
  if (FAILED_STATUSES.has(normalized)) return 'failed';
  if (CANCELLED_STATUSES.has(normalized)) return 'cancelled';
  return 'pending';
}

function CompactTasksPanel({ run }: { run: SpawnedAgent | null }) {
  const context = run?.runContext ?? null;
  const workflowSteps = workflowStepsForContext(context);
  const steps = workflowSteps.length > 0
    ? workflowSteps.map(step => ({ id: step.id, name: humanLabel(step.name), status: step.status }))
    : run
      ? [{ id: run.executionId, name: humanLabel(context?.progress.currentStep ?? context?.progress.label ?? run.prompt ?? run.agent), status: context?.status ?? run.status }]
      : [];
  return (
    <section className="chat-compact-section">
      <h6>tasks · {steps.length}</h6>
      {steps.length ? steps.map(step => {
        const state = nodeStepState(step.status);
        const status = compactTaskStatus(step.status);
        const isCurrent = state === 'run' || state === 'wait-you';
        return (
          <div
            className={`chat-compact-task ${state} ${status.replaceAll(' ', '-')}`}
            key={step.id}
            data-status={status}
            aria-current={isCurrent ? 'step' : undefined}
          >
            <CompactTaskState status={step.status} />
            <span className="chat-compact-task__name">{step.name}</span>
            <span className="chat-compact-task__status">{status}</span>
          </div>
        );
      }) : <p>No task sequence is linked to this chat yet.</p>}
    </section>
  );
}

function CompactExecutionsPanel({ runs }: { runs: SpawnedAgent[] }) {
  return (
    <section className="chat-compact-section">
      <h6>executions · {runs.length}</h6>
      {runs.length ? runs.map((run, index) => {
        const context = run.runContext ?? null;
        const steps = workflowStepsForContext(context);
        const progress = workflowProgressPercent(context, run.status, run.status === 'completed' ? 100 : 0);
        const model = context?.execution.costByModel?.[0];
        return (
          <div className="chat-compact-execution" key={run.executionId}>
            <div className="chat-compact-execution__head">
              <b>#{index + 1} · {runDisplayName(context, run)}</b>
              <span>{humanLabel(context?.status ?? run.status)} · {workflowProgressLabel(context, steps)}</span>
              <Link to={`/executions/${run.executionId}`} aria-label="Open execution"><ExternalLink /></Link>
            </div>
            <div className="chat-compact-progress"><i style={{ width: `${progress}%` }} /></div>
            <div className="chat-compact-execution__meta">
              {[model ? getModelDisplay(model.provider, model.model).modelLabel : null, formatCost(context?.execution.cost), formatDuration(context?.execution.durationMs ?? run.durationMs)].filter(Boolean).join(' · ')}
            </div>
            {steps.map(step => (
              <div className="chat-compact-execution__step" key={step.id}>
                <CompactTaskState status={step.status} />
                <span>{step.name}</span>
                <em>{formatDuration(step.durationMs)}</em>
              </div>
            ))}
          </div>
        );
      }) : <p>No executions are linked to this chat yet.</p>}
    </section>
  );
}

function CompactRunReferences({ runs }: { runs: SpawnedAgent[] }) {
  const items = new Map<string, { key: string; label: string; meta: string; url?: string | null; kind: 'linear' | 'pr' }>();
  for (const run of runs) {
    const linear = run.runContext?.linear;
    if (linear) {
      const key = linear.issueId ?? linear.identifier ?? linear.url ?? `linear-${items.size}`;
      items.set(key, {
        key,
        label: linear.identifier ?? linear.title ?? 'Linear issue',
        meta: humanLabel(String(linear.assignment?.status ?? 'linked')),
        url: linear.url,
        kind: 'linear',
      });
    }
    const pr = run.runContext?.pullRequest;
    if (pr) {
      const key = pr.id ?? pr.url ?? `pr-${pr.number ?? items.size}`;
      items.set(key, {
        key,
        label: `PR ${pr.number ? `#${pr.number}` : ''}`.trim(),
        meta: humanLabel(pr.status ?? 'open'),
        url: pr.url,
        kind: 'pr',
      });
    }
  }
  const references = [...items.values()];
  if (!references.length) return null;
  return (
    <section className="chat-compact-context chat-compact-references">
      <h6>references</h6>
      {references.map(item => {
        const content = (
          <>
            {item.kind === 'linear' ? <span className="linear-mark">L</span> : <GitBranch aria-hidden="true" />}
            <span>{item.label} · {item.meta}</span>
            <ChevronRight aria-hidden="true" />
          </>
        );
        return item.url
          ? <a key={item.key} className="chat-compact-context__row" href={item.url} target="_blank" rel="noreferrer">{content}</a>
          : <div key={item.key} className="chat-compact-context__row">{content}</div>;
      })}
    </section>
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
          {context?.execution.tokenUsage && (
            <span className="cr-list-sub">
              <TokenUsageDisplay tokenUsage={context.execution.tokenUsage} />
            </span>
          )}
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

export function FileChangesPanel({
  runs,
  rootType,
  rootId,
  workspaceBrowseSource,
  repoBrowseSource,
  activeView,
  viewRequest,
  presentation = 'sidebar',
}: {
  runs: SpawnedAgent[];
  rootType?: 'chat' | 'workflow' | 'agent';
  rootId?: string | null;
  workspaceBrowseSource?: WorkspaceBrowseSource | null;
  repoBrowseSource?: RepoBrowseSource | null;
  activeView: FilePanelView;
  viewRequest?: { view: FilePanelView; nonce: number };
  presentation?: 'sidebar' | 'tab';
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
  const [diffContentLoading, setDiffContentLoading] = useState(false);
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
      workspaceBrowseSource: workspaceBrowseSource?.id ? {
        id: workspaceBrowseSource.id,
        name: workspaceBrowseSource.name ?? null,
        repoId: workspaceBrowseSource.repoId ?? null,
      } : null,
    });
  }, [activeView, view, rootType, rootId, runs.length, repoBrowseSource?.id, repoBrowseSource?.name, repoBrowseSource?.path, workspaceBrowseSource?.id, workspaceBrowseSource?.name, workspaceBrowseSource?.repoId]);

  const workspaceRefs = useMemo(() => {
    const refs: Array<{ id: string; name?: string | null; repoId?: string | null; mode: 'workspace' }> = [];
    if (workspaceBrowseSource?.id) {
      refs.push({
        id: workspaceBrowseSource.id,
        name: workspaceBrowseSource.name ?? 'Workspace',
        repoId: workspaceBrowseSource.repoId ?? null,
        mode: 'workspace',
      });
    }
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
  }, [runs, workspaceBrowseSource?.id, workspaceBrowseSource?.name, workspaceBrowseSource?.repoId]);

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
        const existing = byKey.get(key);
        const next = {
          ...existing,
          ...file,
          additions: Math.max(existing?.additions ?? 0, file.additions ?? 0),
          deletions: Math.max(existing?.deletions ?? 0, file.deletions ?? 0),
          diff: hasDiffContent(file) ? file.diff : existing?.diff ?? file.diff,
          originalContent: hasDiffContent(file) ? file.originalContent : existing?.originalContent ?? file.originalContent,
          modifiedContent: hasDiffContent(file) ? file.modifiedContent : existing?.modifiedContent ?? file.modifiedContent,
        };
        byKey.set(key, next);
      }
    };
    const publishFiles = () => {
      if (!cancelled) setFiles(Array.from(byKey.values()));
    };

    (async () => {
      const workspaceGroups = await Promise.all(workspaceRefs.map(async ref => {
      try {
        const result = await workspacesApi.getDiff(ref.id, rootType === 'chat'
          ? { mode: ref.mode, anchor: 'creation' }
          : { mode: ref.mode });
        return ((result.files ?? []) as Array<Omit<PanelDiffFile, 'workspaceId' | 'workspaceName'>>)
          .filter(isChangedDiffFile)
          .map(file => ({ ...file, workspaceId: ref.id, workspaceName: ref.name, sourceType: 'workspace' as const, sourceId: ref.id }));
      } catch {
        return [];
      }
      }));
      addFiles(workspaceGroups.flat());
      publishFiles();
      if (workspaceRefs.length > 0 && !cancelled) setLoading(false);

      if (rootType === 'chat' && rootId) {
        try {
          const result = await chatCodeDiffs.listAll(rootId);
          addFiles((result.snapshots ?? []).flatMap((snapshot: any) => {
            const sourceId = String(snapshot.workspaceId ?? snapshot._id ?? 'snapshot');
            const sourceName = snapshot.workspaceName ?? snapshot.baseBranch ?? 'saved diff';
            return ((snapshot.files ?? []) as Array<Omit<PanelDiffFile, 'workspaceId' | 'workspaceName'>>)
              .filter(isChangedDiffFile)
              .map(file => ({
                ...file,
                workspaceId: sourceId,
                workspaceName: sourceName,
                sourceType: sourceId.startsWith('pr:') ? 'pull-request' : 'workspace',
                sourceId: sourceId.startsWith('pr:') ? sourceId.slice(3) : sourceId,
              }));
          }));
          publishFiles();
        } catch {}
      }

      const prGroups = await Promise.all(pullRequestRefs.map(async ref => {
        try {
          const result = await pullRequestsApi.getDiff(ref.id);
          return ((result.files ?? []) as Array<{ path: string; diff?: string; originalContent?: string; modifiedContent?: string }>)
            .filter(isChangedDiffFile)
            .map(file => {
              const counts = diffLineCounts(file.diff);
              return {
                ...file,
                status: (file as any).status ?? (file.diff?.includes('new file mode') ? 'added' : file.diff?.includes('deleted file mode') ? 'deleted' : 'modified'),
                additions: (file as any).additions ?? counts.additions,
                deletions: (file as any).deletions ?? counts.deletions,
                workspaceId: `pr:${ref.id}`,
                workspaceName: ref.name,
                sourceType: 'pull-request' as const,
                sourceId: ref.id,
              };
            });
        } catch {
          return [];
        }
      }));
      addFiles(prGroups.flat());

      publishFiles();
    })().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [signature, rootType, rootId]);

  const additions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  const activeWorkspace = workspaceRefs[0] ?? null;
  const terminalSource = activeWorkspace?.id
    ? { type: 'workspace' as const, id: activeWorkspace.id, name: activeWorkspace.name ?? 'Workspace terminal', href: workspaceChatPath(activeWorkspace.id) }
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
    if (!activeDiff || hasDiffContent(activeDiff)) return;
    const sourceType = activeDiff.sourceType;
    const sourceId = activeDiff.sourceId;
    if (!sourceType || !sourceId) return;
    let cancelled = false;
    setDiffContentLoading(true);
    (async () => {
      try {
        const hydrated = sourceType === 'pull-request'
          ? await withTimeout('pullRequests.getDiffFile', pullRequestsApi.getDiffFile(sourceId, activeDiff.path))
          : await withTimeout('workspaces.getDiffFile', workspacesApi.getDiffFile(sourceId, activeDiff.path, rootType === 'chat'
            ? { mode: 'workspace', anchor: 'creation' }
            : { mode: 'workspace' }));
        if (cancelled) return;
        setFiles(current => current.map(file => file.path === activeDiff.path && file.sourceId === sourceId
          ? { ...file, ...hydrated, sourceType, sourceId, workspaceId: file.workspaceId, workspaceName: file.workspaceName }
          : file));
      } catch {
        if (!cancelled) {
          setFiles(current => current.map(file => file.path === activeDiff.path && file.sourceId === sourceId
            ? { ...file, diff: 'Failed to load diff content.' }
            : file));
        }
      } finally {
        if (!cancelled) setDiffContentLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [activeDiff?.path, activeDiff?.sourceId, activeDiff?.sourceType, rootType]);

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
      <div className="sticky top-0 z-[2] flex min-h-[58px] shrink-0 items-center gap-3 border-b border-app bg-app-card px-4 py-3">
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-app bg-app-muted text-theme-muted">
          <FileText className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[13px] font-medium text-theme-primary">
            {file?.path ?? 'Code changes'}
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {file && (
            <div className="inline-flex items-center overflow-hidden rounded-md border border-app bg-app-muted font-mono text-[12px] leading-none">
              <span className="border-r border-app px-2.5 py-1.5 text-accent-green">+{file.additions ?? 0}</span>
              <span className="px-2.5 py-1.5 text-accent-red">-{file.deletions ?? 0}</span>
            </div>
          )}
          <div className="inline-flex items-center rounded-md border border-app bg-app-muted p-0.5" role="group" aria-label="Diff view mode">
            <button
              className={`rounded px-3 py-1.5 font-mono text-[11px] leading-none transition-colors ${diffMode === 'unified' ? 'bg-app-card text-theme-primary shadow-sm' : 'text-theme-muted hover:text-theme-primary'}`}
              onClick={() => setDiffMode('unified')}
              type="button"
            >
              unified
            </button>
            <button
              className={`rounded px-3 py-1.5 font-mono text-[11px] leading-none transition-colors ${diffMode === 'split' ? 'bg-app-card text-theme-primary shadow-sm' : 'text-theme-muted hover:text-theme-primary'}`}
              onClick={() => setDiffMode('split')}
              type="button"
            >
              split
            </button>
          </div>
          <button
            type="button"
            className="grid h-8 w-8 place-items-center rounded-md text-theme-muted transition-colors hover:bg-app-muted hover:text-theme-primary"
            onClick={() => setActiveDiffPath('')}
            title="Close preview"
            aria-label="Close preview"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="ws-diff-body">
        {file && diffContentLoading && !hasDiffContent(file) ? (
          <div className="cr-loading-state"><Loader2 className="h-4 w-4 animate-spin" /><span>Loading diff...</span></div>
        ) : file ? (
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
        <button
          type="button"
          className="ml-auto rounded-md p-1.5 text-theme-muted transition-colors hover:bg-app-muted hover:text-theme-primary"
          onClick={() => {
            setBrowserPath('');
            setBrowserContent('');
          }}
          title="Close preview"
          aria-label="Close preview"
        >
          <X className="h-3.5 w-3.5" />
        </button>
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
    <div className={`cr-files-panel ${presentation === 'tab' ? 'cr-files-panel--tab' : ''}`}>
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
        {(activeDiff || presentation === 'tab') && renderDiffPreview(activeDiff)}
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
        {(browserPath || presentation === 'tab') && renderFilePreview()}
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
  rootType,
  rootId,
  expanded,
  onOpenNode,
  onOpenExecution,
  onAnswerWorkflowIntervention,
  refreshKey,
}: {
  activeRun: SpawnedAgent;
  activeContext: RunStatus | null;
  sortedRuns: SpawnedAgent[];
  contextRuns: SpawnedAgent[];
  rootType?: 'chat' | 'workflow' | 'agent';
  rootId?: string | null;
  expanded: boolean;
  onOpenNode: (executionId: string, nodeId: string) => void;
  onOpenExecution: (executionId: string) => void;
  onAnswerWorkflowIntervention?: (input: WorkflowInterventionAnswer) => Promise<void> | void;
  refreshKey?: string | number;
}) {
  const attemptRuns = sortedRuns;
  const showAttempts = attemptRuns.length > 1;
  const activeWorkflowSteps = workflowStepsForContext(activeContext);
  const showWorkflowNodes = !showAttempts && activeContext?.runType === 'workflow' && activeWorkflowSteps.length > 0;

  return (
    <div className={`cr-task-panel ${expanded ? 'expanded' : 'compact'}`}>
      <WorkContextSection runs={contextRuns} />
      <ChatArtifactsSummarySection rootType={rootType} rootId={rootId} runs={contextRuns} refreshKey={refreshKey} />

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
            <RailSection title="workflow steps" count={workflowProgressLabel(activeContext, activeWorkflowSteps)}>
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
  workspaceBrowseSource,
  repoBrowseSource,
  open,
  activeTab,
  onTabChange,
  filesViewRequest,
  artifactRefreshKey,
  onDocumentOpened,
  onClose,
}: {
  runs: SpawnedAgent[];
  rootType?: 'chat' | 'workflow' | 'agent';
  rootId?: string | null;
  workspaceBrowseSource?: WorkspaceBrowseSource | null;
  repoBrowseSource?: RepoBrowseSource | null;
  open: boolean;
  activeTab: ChatRunPanelTab;
  onTabChange: (tab: ChatRunPanelTab) => void;
  filesViewRequest?: { view: FilePanelView; nonce: number };
  artifactRefreshKey?: string | number;
  onDocumentOpened?: () => void;
  onAnswerWorkflowIntervention?: (input: WorkflowInterventionAnswer) => Promise<void> | void;
  onClose: () => void;
}) {
  const allRuns = useMemo(() => [...runs], [runs]);
  const sortedRuns = useMemo(() => allRuns.filter(run => !isChildExecutionRun(run)), [allRuns]);
  const visibleTab = activeTab;
  const [width, setWidth] = useState(() => {
    return CHAT_RUN_SIDEBAR_MIN_WIDTH;
  });
  const fullScreen = false;
  const activeRun = sortedRuns.find(run => {
    const status = (run.runContext?.status ?? run.status ?? '').toLowerCase();
    return !['completed', 'failed', 'cancelled', 'canceled'].includes(status);
  }) ?? sortedRuns[sortedRuns.length - 1] ?? null;
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
      className={`chat-rail ${visibleTab !== 'files' ? 'chat-rail--compact' : ''} ${visibleTab === 'documents' ? 'chat-rail--documents' : ''} relative flex h-full flex-none flex-col gap-3 overflow-visible border-l border-app bg-app-muted px-3.5 pt-2.5 ${visibleTab === 'files' || visibleTab === 'changes' || visibleTab === 'documents' ? 'pb-0' : 'pb-8'} ${
        fullScreen ? 'fullscreen absolute inset-0 z-[80] h-full w-full max-w-none border-l-0 px-5' : ''
      }`}
      style={fullScreen ? undefined : ({ width, '--chat-run-sidebar-width': `${width}px` } as CSSProperties)}
    >
      {!fullScreen && visibleTab === 'files' && <div className="chat-rail-resize" onMouseDown={startResize} title="Drag to resize" />}
      {visibleTab === 'files' && <div className="sticky top-0 z-20 flex shrink-0 items-center justify-between gap-2 border-b border-app-strong bg-app-muted pb-2">
        <PanelTabs activeTab={visibleTab} onTabChange={onTabChange} />
        <div className="inline-flex shrink-0 items-center">
          <button type="button" className="rounded p-1.5 text-theme-muted transition-colors hover:bg-app-card hover:text-theme-primary" onClick={onClose} title="Close side panel" aria-label="Close side panel">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>}

      <div className="relative min-h-0 w-full flex-1 overflow-visible">
        <div className={`h-full w-full min-h-0 ${visibleTab === 'files' || visibleTab === 'changes' || visibleTab === 'documents' ? 'flex flex-col overflow-visible' : 'scroll-hide overflow-y-auto overflow-x-hidden pr-1'} ${visibleTab}`}>
        {visibleTab === 'documents' && <ChatDocumentsPanel rootType={rootType} rootId={rootId} runs={allRuns} refreshKey={artifactRefreshKey} onClose={onClose} onDocumentOpened={onDocumentOpened} />}
        {visibleTab === 'tasks' && <CompactPanelShell title="Tasks" onClose={onClose}><CompactTasksPanel run={activeRun} /></CompactPanelShell>}
        {visibleTab === 'executions' && <CompactPanelShell title="Executions" onClose={onClose}><CompactExecutionsPanel runs={sortedRuns} /></CompactPanelShell>}
        {visibleTab === 'files' && (
          <FileChangesPanel
            runs={allRuns}
            rootType={rootType}
            rootId={rootId}
            workspaceBrowseSource={workspaceBrowseSource}
            repoBrowseSource={repoBrowseSource}
            activeView="files"
            viewRequest={filesViewRequest}
          />
        )}
        {visibleTab === 'changes' && (
          <CompactPanelShell title="Changes" onClose={onClose}>
            <FileChangesPanel
              runs={allRuns}
              rootType={rootType}
              rootId={rootId}
              workspaceBrowseSource={workspaceBrowseSource}
              repoBrowseSource={repoBrowseSource}
              activeView="changes"
              viewRequest={filesViewRequest}
            />
          </CompactPanelShell>
        )}
        {visibleTab === 'context' && (
          <CompactPanelShell title="Context" onClose={onClose}>
            <ChatContextPanel sessionId={rootType === 'chat' ? rootId : null} compact />
            <CompactRunReferences runs={allRuns} />
          </CompactPanelShell>
        )}
        </div>
      </div>
    </aside>
  );
}
