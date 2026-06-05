import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  CheckCircle2,
  Circle,
  Clock3,
  ExternalLink,
  FileDiff,
  FolderGit2,
  GitBranch,
  GitPullRequest,
  Github,
  MessageSquare,
  PlayCircle,
  TicketCheck,
  UserRound,
} from 'lucide-react';
import { agents as agentsApi, chat as chatApi, executions, interventions, linear as linearApi, repos as reposApi, system as systemApi } from '../services/api';
import { McpPresetConnectModal } from '../components/settings/McpServerManager';
import { chatCodeDiffs, pullRequests } from '../services/workspaceService';
import { useAuthStore } from '../stores/authStore';
import ChatInput, { type ChatInputHandle, type ReasoningEffortValue, type RepoOption } from '../components/chat/ChatInput';
import AgentChatDropdown from '../components/chat/AgentChatDropdown';

interface ExecutionItem {
  id: string;
  title?: string;
  workflowName?: string;
  status: string;
  startedAt?: string;
  durationMs?: number | null;
  currentNodes?: string[];
  completedNodes?: string[];
  failedNode?: string | null;
  parentExecutionId?: string | null;
  rootExecutionId?: string | null;
  type?: 'agent' | 'workflow';
  origin?: string;
  source?: string | null;
  meta?: {
    origin?: string;
    chatSessionId?: string;
    linearIssueId?: string;
    linearIdentifier?: string;
    linearTitle?: string;
    linearUrl?: string;
    requestText?: string;
    taskTitle?: string;
  };
  input?: {
    task?: string;
    prompt?: string;
    request?: string;
    linear_identifier?: string;
    linear_title?: string;
    ticket_id?: string;
    ticket_title?: string;
    task_title?: string;
  };
  linear?: {
    identifier?: string | null;
    title?: string | null;
    url?: string | null;
  } | null;
  pullRequest?: {
    id?: string;
    number?: number | null;
    title?: string | null;
    url?: string | null;
    status?: 'open' | 'merged' | 'closed' | string | null;
    createdAt?: string | null;
    updatedAt?: string | null;
    mergedAt?: string | null;
  } | null;
}

interface InterventionItem {
  intervention_id: string;
  workflow_run_id: string;
  workflow_name?: string;
  stage?: string;
  severity: 'question' | 'approval' | 'escalation';
  title: string;
  context_summary?: string;
  status: 'pending' | 'answered' | 'expired' | 'skipped';
  created_at?: string;
}

interface PullRequestReviewItem {
  _id: string;
  number: number;
  title: string;
  repoId?: string;
  repoName?: string;
  repoPath?: string;
  branch?: string;
  baseBranch?: string;
  workspaceId?: string;
  url?: string;
  status: 'open' | 'merged' | 'closed';
  createdAt?: string;
  updatedAt?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  createdByAgent?: string;
  createdByWorkflow?: boolean;
  chatSessionId?: string;
  originatingExecutionId?: string;
  resolutionInProgress?: { startedAt?: string; executionId?: string } | null;
}

interface ChatSessionItem {
  _id: string;
  title?: string;
  status?: 'active' | 'archived' | string;
  messageCount?: number;
  lastMessageAt?: string;
  provider?: string;
  model?: string;
  updatedAt?: string;
  createdAt?: string;
  repoId?: string;
  repoName?: string;
  workspaceId?: string;
  workspaceName?: string;
  workspaceRepoId?: string;
  workspaceRepoName?: string;
  workspaceBranch?: string;
  workspaceBaseBranch?: string;
  workspacePrNumber?: number;
  workspacePrUrl?: string;
  streaming?: boolean;
  archivedWorkspace?: {
    id: string;
    name?: string;
    repoId?: string;
    repoName?: string;
    repoPath?: string;
    branch?: string;
    baseBranch?: string;
    prNumber?: number;
    prUrl?: string;
    archivedAt?: string;
  };
  ownerName?: string | null;
  ownerEmail?: string | null;
}

interface HumanApprovalItem {
  id: string;
  title: string;
  sub: string;
  href: string;
  createdAt?: string;
  kind: 'approval' | 'question' | 'blocked' | 'waiting';
}

interface ChatConversationItem {
  id: string;
  title: string;
  sub: string;
  href: string;
  timestamp?: string;
  messageCount?: number;
  run?: ExecutionItem;
  ownerLabel?: string;
  contextLabel?: string;
  pullRequest?: {
    number?: number;
    status?: string;
    url?: string;
    additions?: number;
    deletions?: number;
    changedFiles?: number;
  } | null;
  diffSummary?: DiffSummary | null;
}

interface DiffSummary {
  files: number;
  additions: number;
  deletions: number;
}

function timeAgo(dateStr?: string): string {
  if (!dateStr) return 'recently';
  const ms = Date.now() - new Date(dateStr).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function localGreeting(date = new Date()): string {
  const hour = date.getHours();
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 17) return 'Good afternoon';
  if (hour >= 17 && hour < 22) return 'Good evening';
  return 'Good night';
}

function isActiveRun(run: ExecutionItem): boolean {
  return ['running', 'queued', 'waiting_for_input'].includes(run.status);
}

function statusLabel(status: string): string {
  if (status === 'waiting_for_input') return 'Waiting';
  if (status === 'completed') return 'Done';
  return humanizeLabel(status);
}

function humanizeLabel(value?: string): string {
  if (!value) return '';
  return value
    .replace(/[_-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function stepLabel(run: ExecutionItem): string | null {
  if (run.status === 'waiting_for_input') return 'waiting on you';
  if (run.status === 'queued') return 'queued';
  if (run.status === 'failed') return run.failedNode ? `${humanizeLabel(run.failedNode)} failed` : 'failed';
  const current = Array.isArray(run.currentNodes)
    ? run.currentNodes.filter((node) => node && node !== 'END')
    : [];
  if (current.length > 0) return humanizeLabel(current.join(', '));
  return null;
}

function workStatus(run: ExecutionItem): { label: string; cls: string } {
  if (isActiveRun(run)) {
    const label = stepLabel(run) ?? statusLabel(run.status);
    return {
      label,
      cls: run.status === 'waiting_for_input' ? 'badge-human' : run.status === 'queued' ? 'badge-warn' : 'badge-info',
    };
  }

  const prStatus = run.pullRequest?.status;
  if (prStatus === 'open') return { label: 'review PR', cls: 'badge-human' };
  if (prStatus === 'merged') return { label: 'merged', cls: 'badge-ok' };
  if (prStatus === 'closed') return { label: 'PR closed', cls: 'badge-muted' };

  if (run.status === 'completed') return { label: 'completed', cls: 'badge-ok' };
  if (run.status === 'failed') return { label: stepLabel(run) ?? 'failed', cls: 'badge-err' };
  if (run.status === 'cancelled' || run.status === 'canceled') return { label: 'cancelled', cls: 'badge-muted' };
  return { label: statusLabel(run.status), cls: 'badge-muted' };
}

function WorkStatusBadge({ run }: { run: ExecutionItem }) {
  const status = workStatus(run);
  if (run.pullRequest?.status === 'open' && run.pullRequest.url) {
    return (
      <a className={`badge ${status.cls}`} href={run.pullRequest.url} target="_blank" rel="noreferrer" title="Review pull request">
        <span className="status-dot" />
        {status.label}
      </a>
    );
  }
  return (
    <span className={`badge ${status.cls}`}>
      <span className="status-dot" />
      {status.label}
    </span>
  );
}

function compactTitle(value?: string | null): string | null {
  const trimmed = value?.replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  return trimmed.length > 110 ? `${trimmed.slice(0, 110)}...` : trimmed;
}

function linearIdentifierForRun(run: ExecutionItem): string | null {
  const structured = run.linear?.identifier
    ?? run.meta?.linearIdentifier
    ?? run.input?.linear_identifier
    ?? run.input?.ticket_id;
  if (structured) return structured;
  const haystack = [
    run.title,
    run.input?.task,
    run.input?.prompt,
    run.input?.request,
  ].filter(Boolean).join(' ');
  return haystack.match(/\b[A-Z][A-Z0-9]+-\d+\b/)?.[0] ?? null;
}

function approvalItemFromIntervention(item: InterventionItem, run?: ExecutionItem): HumanApprovalItem {
  return {
    id: `approval-${item.intervention_id}`,
    kind: item.severity === 'escalation' ? 'blocked' : item.severity === 'question' ? 'question' : 'approval',
    title: item.title || (run ? runTitle(run) : 'Execution approval'),
    sub: run ? `${runTitle(run)} · ${humanizeLabel(item.stage ?? item.severity)}` : (item.workflow_name || 'Workflow execution'),
    href: `/executions/${item.workflow_run_id}`,
    createdAt: item.created_at,
  };
}

function approvalItemFromWaitingRun(run: ExecutionItem): HumanApprovalItem {
  return {
    id: `waiting-${run.id}`,
    kind: 'waiting',
    title: runTitle(run),
    sub: stepLabel(run) ?? 'Waiting for input',
    href: `/executions/${run.id}`,
    createdAt: run.startedAt,
  };
}

function dedupeApprovals(items: HumanApprovalItem[]): HumanApprovalItem[] {
  const seen = new Set<string>();
  const result: HumanApprovalItem[] = [];
  for (const item of items) {
    if (seen.has(item.href)) continue;
    seen.add(item.href);
    result.push(item);
  }
  return result;
}

function isReviewNeededPr(pr: PullRequestReviewItem): boolean {
  return pr.status === 'open'
    && Boolean(pr.createdByWorkflow || pr.createdByAgent || pr.chatSessionId || pr.originatingExecutionId);
}

function isAssignedTask(run: ExecutionItem): boolean {
  const origin = run.meta?.origin;
  const hasUserTaskInput = Boolean(
    compactTitle(run.input?.task)
    || compactTitle(run.input?.prompt)
    || compactTitle(run.input?.request),
  );
  return run.origin === 'chat'
    || origin === 'chat'
    || origin === 'linear'
    || run.origin === 'linear'
    || origin === 'direct_agent'
    || run.origin === 'direct_agent'
    || Boolean(run.meta?.chatSessionId)
    || Boolean(run.meta?.linearIssueId || run.meta?.linearIdentifier)
    || Boolean(run.linear?.identifier)
    || run.source === 'chat'
    || run.source === 'linear'
    || run.workflowName?.includes(':spawn_agent/') === true
    || (run.type === 'workflow' && hasUserTaskInput);
}

function hasChatReference(run: ExecutionItem): boolean {
  return Boolean(run.meta?.chatSessionId);
}

function runPrimaryRef(run: ExecutionItem): string {
  return linearIdentifierForRun(run) ?? 'Thread';
}

function runSecondaryRef(run: ExecutionItem): string {
  if (run.pullRequest?.number) return String(run.pullRequest.number);
  return run.meta?.chatSessionId?.slice(0, 8) ?? run.id.slice(0, 8);
}

function recentRunHref(run: ExecutionItem): string {
  return run.meta?.chatSessionId ? `/chat/${run.meta.chatSessionId}` : `/executions/${run.id}`;
}

function sessionTimestamp(session: ChatSessionItem): string | undefined {
  return session.lastMessageAt ?? session.updatedAt ?? session.createdAt;
}

function sessionTitle(session?: ChatSessionItem | null, run?: ExecutionItem): string {
  return compactTitle(session?.title) ?? (run ? runTitle(run) : 'Untitled conversation');
}

function sessionOwnerLabel(session?: ChatSessionItem | null): string | undefined {
  return compactTitle(session?.ownerName) ?? compactTitle(session?.ownerEmail) ?? undefined;
}

function isStreamingSession(session?: ChatSessionItem | null): boolean {
  return Boolean(session?.streaming || session?.status === 'streaming' || session?.status === 'running');
}

function sessionContextLabel(session?: ChatSessionItem | null): string | undefined {
  if (!session) return undefined;
  const archived = session.archivedWorkspace;
  if (archived?.name || archived?.repoName) {
    return ['Workspace', archived.name, archived.repoName].filter(Boolean).join(' · ');
  }
  if (session.workspaceName || session.workspaceRepoName) {
    return ['Workspace', session.workspaceName, session.workspaceRepoName].filter(Boolean).join(' · ');
  }
  if (session.repoName) return `Repository · ${session.repoName}`;
  return undefined;
}

function sameText(a?: string | null, b?: string | null): boolean {
  return Boolean(a && b && a === b);
}

function normalizedPrUrl(url?: string | null): string | null {
  return url ? url.replace(/\/+$/, '') : null;
}

function sessionPullRequest(session: ChatSessionItem | null | undefined, prs: PullRequestReviewItem[]): ChatConversationItem['pullRequest'] {
  const archived = session?.archivedWorkspace;
  const prUrl = archived?.prUrl ?? session?.workspacePrUrl;
  const prNumber = archived?.prNumber ?? session?.workspacePrNumber;
  const repoId = archived?.repoId ?? session?.workspaceRepoId ?? session?.repoId;
  const repoName = archived?.repoName ?? session?.workspaceRepoName ?? session?.repoName;
  const branch = archived?.branch ?? session?.workspaceBranch;
  const workspaceId = session?.workspaceId;
  const normalizedUrl = normalizedPrUrl(prUrl);
  const matched = prs.find((pr) =>
    (normalizedUrl && normalizedPrUrl(pr.url) === normalizedUrl)
    || (workspaceId && pr.workspaceId === workspaceId)
    || (repoId && branch && sameText(pr.repoId, repoId) && sameText(pr.branch, branch))
    || (repoName && branch && sameText(pr.repoName, repoName) && sameText(pr.branch, branch))
    || (repoId && prNumber && pr.repoId === repoId && pr.number === prNumber)
    || (prNumber && repoName && pr.repoName === repoName && pr.number === prNumber),
  );
  if (matched) return pullRequestFromReviewItem(matched, prUrl);
  if (!prUrl && !prNumber) return null;
  return {
    number: prNumber,
    status: 'open',
    url: prUrl,
  };
}

function pullRequestFromReviewItem(pr: PullRequestReviewItem, fallbackUrl?: string | null): ChatConversationItem['pullRequest'] {
  return {
    number: pr.number,
    status: pr.status,
    url: pr.url ?? fallbackUrl ?? undefined,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
  };
}

function pullRequestFromRun(run: ExecutionItem | null | undefined, prs: PullRequestReviewItem[]): ChatConversationItem['pullRequest'] {
  if (!run) return null;
  const runPr = run.pullRequest;
  const sessionId = run.meta?.chatSessionId;
  const matched = prs.find((pr) =>
    (runPr?.id && pr._id === runPr.id)
    || (runPr?.url && pr.url === runPr.url)
    || (runPr?.number != null && pr.number === runPr.number)
    || (sessionId && pr.chatSessionId === sessionId)
    || pr.originatingExecutionId === run.id,
  );
  if (matched) return pullRequestFromReviewItem(matched, runPr?.url);
  if (!runPr) return null;
  return {
    number: runPr.number ?? undefined,
    status: runPr.status ?? undefined,
    url: runPr.url ?? undefined,
  };
}

function conversationPullRequest(
  session: ChatSessionItem | null | undefined,
  prs: PullRequestReviewItem[],
  run?: ExecutionItem | null,
  summary?: DiffSummary,
): ChatConversationItem['pullRequest'] {
  return withDiffFallback(
    pullRequestFromRun(run, prs) ?? sessionPullRequest(session, prs),
    summary,
  );
}

function diffSummaryFromSnapshots(snapshots: any[]): DiffSummary | null {
  const latest = [...snapshots]
    .reverse()
    .find((snapshot) => Array.isArray(snapshot?.files) && snapshot.files.length > 0);
  if (!latest) return null;
  const files = latest.files as Array<{ additions?: number; deletions?: number; diff?: string }>;
  return files.reduce<DiffSummary>((acc, file) => {
    let additions = Number(file.additions ?? 0);
    let deletions = Number(file.deletions ?? 0);
    if ((!additions && !deletions) && file.diff) {
      for (const line of file.diff.split('\n')) {
        if (line.startsWith('+++') || line.startsWith('---')) continue;
        if (line.startsWith('+')) additions += 1;
        else if (line.startsWith('-')) deletions += 1;
      }
    }
    acc.files += 1;
    acc.additions += additions;
    acc.deletions += deletions;
    return acc;
  }, { files: 0, additions: 0, deletions: 0 });
}

function withDiffFallback(
  pullRequest: ChatConversationItem['pullRequest'],
  summary?: DiffSummary,
): ChatConversationItem['pullRequest'] {
  if (!pullRequest) return null;
  return {
    ...pullRequest,
    additions: pullRequest.additions ?? summary?.additions,
    deletions: pullRequest.deletions ?? summary?.deletions,
    changedFiles: pullRequest.changedFiles ?? summary?.files,
  };
}

function sessionSubline(
  session?: ChatSessionItem | null,
  run?: ExecutionItem,
  options: { includeTimestamp?: boolean; includeMessageCount?: boolean } = {},
): string {
  const parts: string[] = [];
  if (run) parts.push(workStatus(run).label);
  if (options.includeMessageCount !== false && session?.messageCount != null) {
    parts.push(`${session.messageCount} message${session.messageCount === 1 ? '' : 's'}`);
  }
  const at = session ? sessionTimestamp(session) : run?.startedAt;
  if (options.includeTimestamp !== false && at) parts.push(timeAgo(at));
  return parts.join(' · ');
}

function messageCountLabel(count?: number): string | null {
  if (count == null) return null;
  return `${count} message${count === 1 ? '' : 's'}`;
}

function runTitle(run: ExecutionItem): string {
  const directTitle = compactTitle(run.linear?.title)
    ?? compactTitle(run.meta?.linearTitle)
    ?? compactTitle(run.input?.linear_title)
    ?? compactTitle(run.input?.ticket_title)
    ?? compactTitle(run.meta?.taskTitle)
    ?? compactTitle(run.input?.task_title)
    ?? compactTitle(run.title)
    ?? compactTitle(run.meta?.requestText)
    ?? compactTitle(run.input?.task)
    ?? compactTitle(run.input?.prompt)
    ?? compactTitle(run.input?.request)
    ?? compactTitle(linearIdentifierForRun(run) ? `Work on ${linearIdentifierForRun(run)}` : undefined);
  if (directTitle && directTitle !== run.workflowName) return directTitle;
  if (run.workflowName) {
    const spawnName = run.workflowName.replace(/^.*:spawn_agent\//, '');
    return humanizeLabel(spawnName);
  }
  if (run.meta?.chatSessionId) return 'Thread Task';
  if (linearIdentifierForRun(run)) return `Linear Task ${linearIdentifierForRun(run)}`;
  return 'Direct Agent Task';
}

function runSubline(run: ExecutionItem): string {
  const parts = [workStatus(run).label];
  if (run.meta?.chatSessionId) parts.push(`Thread ${run.meta.chatSessionId.slice(0, 8)}`);
  const linearIdentifier = linearIdentifierForRun(run);
  if (linearIdentifier) parts.push(linearIdentifier);
  parts.push(timeAgo(run.startedAt));
  return parts.join(' · ');
}

function taskGroupKey(run: ExecutionItem): string {
  if (run.meta?.chatSessionId) return `chat:${run.meta.chatSessionId}`;
  const linearIdentifier = linearIdentifierForRun(run);
  if (linearIdentifier) return `linear:${linearIdentifier}`;
  if (run.rootExecutionId) return `root:${run.rootExecutionId}`;
  return `execution:${run.id}`;
}

function statusPriority(status: string): number {
  if (['running', 'queued', 'waiting_for_input'].includes(status)) return 5;
  if (status === 'completed') return 4;
  if (status === 'failed') return 3;
  if (status === 'cancelled' || status === 'canceled' || status === 'interrupted') return 2;
  return 1;
}

function representativeScore(run: ExecutionItem): number {
  const isTopLevel = !run.parentExecutionId;
  const isRootExecution = !run.rootExecutionId || run.rootExecutionId === run.id;
  const started = run.startedAt ? new Date(run.startedAt).getTime() : 0;
  return statusPriority(run.status) * 1_000_000_000_000_000
    + (isTopLevel ? 100_000_000_000_000 : 0)
    + (isRootExecution ? 10_000_000_000_000 : 0)
    + Math.min(started, 9_999_999_999_999);
}

function collapseTaskRuns(items: ExecutionItem[]): ExecutionItem[] {
  const byTask = new Map<string, ExecutionItem>();
  for (const run of items) {
    const key = taskGroupKey(run);
    const current = byTask.get(key);
    if (!current || representativeScore(run) > representativeScore(current)) {
      byTask.set(key, run);
    }
  }
  return [...byTask.values()].sort((a, b) => {
    const aTime = a.startedAt ? new Date(a.startedAt).getTime() : 0;
    const bTime = b.startedAt ? new Date(b.startedAt).getTime() : 0;
    return bTime - aTime;
  });
}

function prStatusClass(status?: string): string {
  if (status === 'merged') return 'border-accent-purple/30 bg-accent-purple/10 text-accent-purple';
  if (status === 'closed') return 'border-accent-red/30 bg-accent-red/10 text-accent-red';
  return 'border-accent-green/30 bg-accent-green/10 text-accent-green';
}

function conversationContextIcon(label?: string) {
  if (!label) return <MessageSquare className="h-3 w-3 shrink-0 text-theme-subtle" />;
  if (label.startsWith('Workspace')) return <FolderGit2 className="h-3 w-3 shrink-0 text-accent" />;
  if (label.startsWith('Repository')) return <GitBranch className="h-3 w-3 shrink-0 text-accent-blue" />;
  return <GitBranch className="h-3 w-3 shrink-0 text-theme-subtle" />;
}

function ConversationMeta({ item }: { item: ChatConversationItem }) {
  const pr = item.pullRequest;
  const diff = item.diffSummary ?? null;
  const changedFiles = pr?.changedFiles ?? diff?.files;
  const additions = pr?.additions ?? diff?.additions;
  const deletions = pr?.deletions ?? diff?.deletions;
  const hasDiff = Boolean(changedFiles != null || additions != null || deletions != null);
  if (!item.ownerLabel && !item.contextLabel && !pr && !hasDiff) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-theme-muted">
      {item.ownerLabel && (
        <span className="inline-flex min-w-0 max-w-[180px] items-center gap-1.5">
          <UserRound className="h-3 w-3 shrink-0 text-theme-subtle" />
          <span className="truncate">{item.ownerLabel}</span>
        </span>
      )}
      {item.contextLabel && (
        <span className="inline-flex min-w-0 max-w-[260px] items-center gap-1.5 text-theme-secondary">
          {conversationContextIcon(item.contextLabel)}
          <span className="truncate">{item.contextLabel}</span>
        </span>
      )}
      {pr?.url ? (
        <a
          className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-[10px] transition-colors hover:border-app-strong hover:bg-app-muted ${prStatusClass(pr.status)}`}
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          title="Open pull request"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <GitPullRequest className="h-3 w-3" />
          PR {pr.number ? `#${pr.number}` : ''}{pr.status ? ` · ${pr.status}` : ''}
          <ExternalLink className="h-2.5 w-2.5" />
        </a>
      ) : pr ? (
        <span className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-[10px] ${prStatusClass(pr.status)}`}>
          <GitPullRequest className="h-3 w-3" />
          PR {pr.number ? `#${pr.number}` : ''}{pr.status ? ` · ${pr.status}` : ''}
        </span>
      ) : null}
      {hasDiff && (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-app bg-app px-1.5 py-0.5 font-mono text-[10.5px] text-theme-muted">
          <FileDiff className="h-3 w-3 text-accent-blue" />
          {changedFiles != null && <span>{changedFiles} file{changedFiles === 1 ? '' : 's'}</span>}
          {additions != null && <span className="text-accent-green">+{additions}</span>}
          {deletions != null && <span className="text-accent-red">-{deletions}</span>}
        </span>
      )}
    </div>
  );
}

function activateConversationRow(
  event: ReactKeyboardEvent,
  href: string,
  navigate: (href: string) => void,
) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  navigate(href);
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const user = useAuthStore((s) => s.user);
  const chatInputRef = useRef<ChatInputHandle>(null);
  const [pendingInterventions, setPendingInterventions] = useState<InterventionItem[]>([]);
  const [reviewPrs, setReviewPrs] = useState<PullRequestReviewItem[]>([]);
  const [allPullRequests, setAllPullRequests] = useState<PullRequestReviewItem[]>([]);
  const [runs, setRuns] = useState<ExecutionItem[]>([]);
  const [chatSessions, setChatSessions] = useState<ChatSessionItem[]>([]);
  const [chatDiffSummaries, setChatDiffSummaries] = useState<Record<string, DiffSummary>>({});
  const [initialLoading, setInitialLoading] = useState(true);
  const [providers, setProviders] = useState<any[]>([]);
  const [selectedProvider, setSelectedProvider] = useState('codex');
  const [selectedModel, setSelectedModel] = useState('');
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [selectedAgentCwd, setSelectedAgentCwd] = useState<string | null>(null);
  const [allAgents, setAllAgents] = useState<any[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [repos, setRepos] = useState<RepoOption[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<RepoOption | null>(null);
  const [githubConnected, setGithubConnected] = useState(false);
  const [linearConnected, setLinearConnected] = useState(false);
  const [connectPreset, setConnectPreset] = useState<'github' | 'linear' | null>(null);
  const [agentOverrides, setAgentOverrides] = useState<{
    reasoningEffort?: ReasoningEffortValue | null;
    planMode?: boolean | null;
  }>({});
  async function load() {
    try {
      const [pending, execs, openPrs, sessions, prs] = await Promise.all([
        interventions.list({ status: 'pending', limit: 20 }).catch(() => []),
        executions.listPaged({ limit: 40, offset: 0 }).catch(() => ({ items: [] })),
        pullRequests.list({ status: 'open' }).catch(() => []),
        chatApi.listSessions(user?.id ? { ownerUserId: user.id } : undefined).catch(() => []),
        pullRequests.list().catch(() => []),
      ]);
      setPendingInterventions(pending ?? []);
      setReviewPrs((openPrs ?? []).filter((pr) => isReviewNeededPr(pr) && Boolean(pr.chatSessionId)));
      setAllPullRequests(prs ?? []);
      const assignedRuns = collapseTaskRuns((execs.items ?? []).filter((run) => isAssignedTask(run) && hasChatReference(run)));
      setRuns(assignedRuns);
      setChatSessions(sessions ?? []);
      const recentSessionIds = (sessions ?? []).slice(0, 20).map((session) => session._id);
      const runSessionIds = assignedRuns
        .map((run) => run.meta?.chatSessionId)
        .filter((sessionId): sessionId is string => Boolean(sessionId));
      const diffSessionIds = Array.from(new Set([...recentSessionIds, ...runSessionIds])).slice(0, 30);
      if (diffSessionIds.length > 0) {
        const summaries = await Promise.all(diffSessionIds.map(async (sessionId) => {
          const diff = await chatCodeDiffs.listAll(sessionId).catch(() => null);
          const summary = diff ? diffSummaryFromSnapshots(diff.snapshots ?? []) : null;
          return [sessionId, summary] as const;
        }));
        setChatDiffSummaries(summaries.reduce<Record<string, DiffSummary>>((acc, [sessionId, summary]) => {
          if (summary) acc[sessionId] = summary;
          return acc;
        }, {}));
      } else {
        setChatDiffSummaries({});
      }
    } finally {
      setInitialLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, [user?.id]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        chatInputRef.current?.focus();
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    const state = location.state as { focusDashboardChat?: number } | null;
    if (!state?.focusDashboardChat) return;

    const timer = window.setTimeout(() => {
      chatInputRef.current?.focus();
      navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
    }, 0);

    return () => window.clearTimeout(timer);
  }, [location.pathname, location.search, location.state, navigate]);


  useEffect(() => {
    chatApi.providers().then((list) => {
      setProviders(list ?? []);
      if (list?.length > 0) {
        setSelectedProvider(list[0].provider);
        setSelectedModel(list[0].defaultModel);
      }
    }).catch(() => {});
    agentsApi.list().then((list) => {
      setAllAgents(list ?? []);
      setAgentsLoading(false);
    }).catch(() => { setAgentsLoading(false); });
    reposApi.list().then((list: RepoOption[]) => setRepos(list ?? [])).catch(() => {});
    Promise.all([
      systemApi.desktopRuntime().catch(() => null),
      linearApi.status().catch(() => null),
    ]).then(([runtime, linearStatus]) => {
      const githubSecretReady = Boolean(runtime?.secrets?.some((secret) =>
        secret.key === 'ALLEN_GITHUB_PERSONAL_ACCESS_TOKEN' && secret.configured,
      ));
      const linearSecretReady = Boolean(runtime?.secrets?.some((secret) =>
        secret.key === 'ALLEN_LINEAR_ACCESS_TOKEN' && secret.configured,
      ));

      setGithubConnected(githubSecretReady);
      setLinearConnected(Boolean(linearStatus?.configured || linearSecretReady));
    }).catch(() => {});
  }, []);

  const chatSessionById = useMemo(
    () => new Map(chatSessions.map((session) => [session._id, session])),
    [chatSessions],
  );
  const runningConversations = useMemo<ChatConversationItem[]>(() => {
    const runItems = runs
      .filter((run) => ['running', 'queued'].includes(run.status))
      .map((run) => {
        const sessionId = run.meta?.chatSessionId;
        const session = sessionId ? chatSessionById.get(sessionId) : null;
        const pullRequest = conversationPullRequest(
          session,
          allPullRequests,
          run,
          sessionId ? chatDiffSummaries[sessionId] : undefined,
        );
        return {
          id: sessionId ?? run.id,
          title: sessionTitle(session, run),
          sub: sessionSubline(session, run),
          href: sessionId ? `/chat/${sessionId}` : `/executions/${run.id}`,
          timestamp: session ? sessionTimestamp(session) : run.startedAt,
          messageCount: session?.messageCount,
          run,
          ownerLabel: sessionOwnerLabel(session),
          contextLabel: sessionContextLabel(session),
          pullRequest,
          diffSummary: sessionId ? chatDiffSummaries[sessionId] : null,
        };
      });
    const runSessionIds = new Set(runItems.map((item) => item.id));
    const streamingSessionItems = chatSessions
      .filter((session) => isStreamingSession(session) && !runSessionIds.has(session._id))
      .map((session) => {
        const pullRequest = conversationPullRequest(
          session,
          allPullRequests,
          undefined,
          chatDiffSummaries[session._id],
        );
        const details = sessionSubline(session);
        return {
          id: session._id,
          title: sessionTitle(session),
          sub: ['streaming', details].filter(Boolean).join(' · '),
          href: `/chat/${session._id}`,
          timestamp: sessionTimestamp(session),
          messageCount: session.messageCount,
          ownerLabel: sessionOwnerLabel(session),
          contextLabel: sessionContextLabel(session),
          pullRequest,
          diffSummary: chatDiffSummaries[session._id] ?? null,
        };
      });
    return [...runItems, ...streamingSessionItems]
      .sort((a, b) => new Date(b.timestamp ?? 0).getTime() - new Date(a.timestamp ?? 0).getTime())
      .slice(0, 8);
  }, [allPullRequests, chatDiffSummaries, chatSessionById, chatSessions, runs]);
  const runningConversationIds = useMemo(
    () => new Set(runningConversations.map((item) => item.id)),
    [runningConversations],
  );
  const recentConversations = useMemo<ChatConversationItem[]>(() => {
    const fromSessions = chatSessions
      .filter((session) => !runningConversationIds.has(session._id) && !isStreamingSession(session))
      .sort((a, b) => new Date(sessionTimestamp(b) ?? 0).getTime() - new Date(sessionTimestamp(a) ?? 0).getTime())
      .map((session) => {
        const run = runs.find((candidate) => candidate.meta?.chatSessionId === session._id);
        const pullRequest = conversationPullRequest(
          session,
          allPullRequests,
          run,
          chatDiffSummaries[session._id],
        );
        return {
          id: session._id,
          title: sessionTitle(session),
          sub: sessionSubline(session, undefined, { includeTimestamp: false, includeMessageCount: false }),
          href: `/chat/${session._id}`,
          timestamp: sessionTimestamp(session),
          messageCount: session.messageCount,
          run,
          ownerLabel: sessionOwnerLabel(session),
          contextLabel: sessionContextLabel(session),
          pullRequest,
          diffSummary: chatDiffSummaries[session._id] ?? null,
        };
      });
    if (fromSessions.length > 0) return fromSessions.slice(0, 8);

    return runs
      .filter((run) => !isActiveRun(run))
      .map((run) => {
        const sessionId = run.meta?.chatSessionId;
        const session = sessionId ? chatSessionById.get(sessionId) : null;
        return {
          id: sessionId ?? run.id,
          title: sessionTitle(session, run),
          sub: sessionSubline(session, run, { includeTimestamp: false, includeMessageCount: false }),
          href: recentRunHref(run),
          timestamp: session ? sessionTimestamp(session) : run.startedAt,
          messageCount: session?.messageCount,
          run,
          ownerLabel: sessionOwnerLabel(session),
          contextLabel: sessionContextLabel(session),
          pullRequest: conversationPullRequest(
            session,
            allPullRequests,
            run,
            sessionId ? chatDiffSummaries[sessionId] : undefined,
          ),
          diffSummary: sessionId ? chatDiffSummaries[sessionId] : null,
        };
      })
      .slice(0, 8);
  }, [allPullRequests, chatDiffSummaries, chatSessionById, chatSessions, runningConversationIds, runs]);
  const humanApprovals = useMemo(
    () => dedupeApprovals([
      ...pendingInterventions.map((item) => approvalItemFromIntervention(
        item,
        runs.find((run) => run.id === item.workflow_run_id),
      )),
      ...runs
        .filter((run) => run.status === 'waiting_for_input')
        .map(approvalItemFromWaitingRun),
    ]).sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime()),
    [pendingInterventions, runs],
  );
  const firstName = (user?.name || user?.email?.split('@')[0] || 'there').split(/\s+/)[0];
  const greeting = localGreeting();

  const selectedAgentDoc = selectedAgent
    ? allAgents.find((agent) => agent.name === selectedAgent) ?? null
    : null;

  function sendPrompt(text: string) {
    const trimmed = text.trim();
    const params = new URLSearchParams({ prompt: trimmed, autosend: '1' });
    if (!trimmed) return;
    if (selectedAgent) params.set('agent', selectedAgent);
    if (selectedAgentCwd) params.set('agentCwd', selectedAgentCwd);
    if (selectedProvider) params.set('provider', selectedProvider);
    if (selectedModel) params.set('model', selectedModel);
    if (selectedRepo?._id) params.set('repoId', selectedRepo._id);
    if (agentOverrides.reasoningEffort) params.set('reasoningEffort', agentOverrides.reasoningEffort);
    if (agentOverrides.planMode != null) params.set('planMode', String(agentOverrides.planMode));
    navigate(`/chat?${params.toString()}`);
  }

  const hasDashboardActivity = humanApprovals.length > 0 || runningConversations.length > 0 || recentConversations.length > 0;
  const setupCards = [
    {
      title: 'GitHub',
      desc: githubConnected
        ? reviewPrs.length
          ? `${reviewPrs.length} pull request${reviewPrs.length === 1 ? '' : 's'} need review. Open the GitHub queue to inspect diffs and follow-up work.`
          : 'Open synced pull requests, repository activity, and GitHub-backed review loops from Allen.'
        : 'Connect GitHub so Allen can sync pull requests and use repository activity during review workflows.',
      icon: Github,
      done: githubConnected,
      action: githubConnected ? (reviewPrs.length ? 'Review' : 'Open') : 'Connect',
      href: githubConnected ? '/pull-requests' : null,
      onAction: githubConnected ? undefined : () => setConnectPreset('github'),
    },
    {
      title: 'Linear',
      desc: linearConnected
        ? 'Open assigned issues, read project context, and turn a ticket into a focused Allen task.'
        : 'Connect Linear so Allen can read tickets, project context, and dispatch issue work.',
      icon: TicketCheck,
      done: linearConnected,
      action: linearConnected ? 'Open' : 'Connect',
      href: linearConnected ? '/tickets' : null,
      onAction: linearConnected ? undefined : () => setConnectPreset('linear'),
    },
    {
      title: 'Add repository',
      desc: repos.length
        ? `${repos.length} repository${repos.length === 1 ? '' : 'ies'} available for Allen. Open repositories to update codebase context before dispatching work.`
        : 'Connect a repository so Allen can clone code, create isolated worktrees, and run checks against real project context.',
      icon: FolderGit2,
      done: repos.length > 0,
      action: repos.length ? 'Open' : 'Add repository',
      href: '/agents?section=repos',
    },
    {
      title: 'Dispatch work',
      desc: 'Use the composer above to start a bug fix, feature build, test update, PR review, or Linear ticket handoff.',
      icon: MessageSquare,
      done: false,
      action: 'Start',
      href: null,
    },
  ];
  const setupComplete = setupCards.filter((item) => item.done).length;
  const runningRows = runningConversations.slice(0, 4);
  const recentRows = recentConversations.slice(0, 4);
  const humanLoopRows = humanApprovals.slice(0, 4);

  return (
    <div className="content scroll-hide bg-app" data-screen-label="dashboard">
      <div className="mx-auto max-w-[1180px] px-8 py-14">
        <section>
          <div className="flex items-center gap-2 font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-theme-subtle">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            New chat
          </div>
          <h1 className="mt-3 text-[32px] font-semibold leading-[1.1] tracking-[-0.018em] text-theme-primary">{greeting}, <span className="text-accent">{firstName}</span></h1>
          <div className="mt-8 [&_.chat-composer]:max-w-none [&_.chat-composer]:rounded-md [&_.chat-composer]:px-5 [&_.chat-composer]:py-4 [&_.chat-composer]:shadow-none [&_.chat-composer-field]:relative [&_.chat-composer-field_textarea]:h-[103px] [&_.chat-composer-field_textarea]:p-0 [&_.chat-composer-field_textarea]:pr-48 [&_.chat-composer-field_textarea]:text-[16px] [&_.chat-composer-field_textarea]:leading-[1.6]">
            <ChatInput
              ref={chatInputRef}
              onSend={sendPrompt}
              streaming={false}
              providers={providers}
              selectedProvider={selectedProvider}
              selectedModel={selectedModel}
              onProviderChange={(provider, model) => {
                setSelectedProvider(provider);
                setSelectedModel(model);
              }}
              repos={repos}
              selectedRepoName={selectedRepo?.name ?? null}
              onRepoChange={setSelectedRepo}
              agentOverrides={agentOverrides}
              inheritedEffort={selectedAgentDoc?.reasoningEffort ?? (selectedProvider === 'codex' ? 'high' : 'medium')}
              inheritedPlanMode={selectedAgentDoc?.planMode ?? null}
              onAgentOverridesChanged={setAgentOverrides}
              maxVisibleLines={4}
              fixedVisibleLines
              extraControls={(
                <AgentChatDropdown
                  value={selectedAgent}
                  onChange={(name, cwd) => {
                    setSelectedAgent(name);
                    setSelectedAgentCwd(cwd);
                  }}
                  agents={allAgents}
                  loading={agentsLoading}
                  variant="composer"
                />
              )}
            />
          </div>
        </section>

        {!initialLoading && !hasDashboardActivity ? (
          <section className="mt-10">
            <div className="mb-3 flex items-center gap-2 font-mono text-[11px] font-medium uppercase tracking-[0.16em]">
              <span className="text-theme-subtle">Start work</span>
              <span className="text-theme-subtle">·</span>
              <span className="font-semibold text-theme-primary">{setupComplete} of 4</span>
              <span className="text-theme-subtle">complete</span>
            </div>
            <div className="grid w-full grid-cols-1 gap-5 md:grid-cols-2">
              {setupCards.map((item) => (
                <Link
                  key={item.title}
                  to={item.href ?? '#'}
                  onClick={(event) => {
                    if (item.onAction) {
                      event.preventDefault();
                      item.onAction();
                    } else if (!item.href) {
                      event.preventDefault();
                      chatInputRef.current?.focus();
                    }
                  }}
                  className="group flex min-h-[148px] items-start gap-5 rounded-md border border-app bg-app-card p-5 transition-colors hover:border-app-strong hover:bg-app-muted/30"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-app bg-app text-theme-muted transition-colors group-hover:text-theme-secondary">
                    <item.icon className="h-[18px] w-[18px]" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-[14.5px] font-semibold text-theme-primary">{item.title}</span>
                      {item.done && (
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-accent-green" />
                      )}
                    </div>
                    <p className="mt-2 max-w-[38rem] text-[13px] leading-5 text-theme-muted">{item.desc}</p>
                  </div>
                  <span className={`mt-0.5 inline-flex h-8 shrink-0 items-center rounded-md border px-3 text-[13px] font-medium transition-colors ${
                    item.done
                      ? 'border-app bg-app text-theme-secondary group-hover:bg-app-muted'
                      : 'border-accent/35 bg-accent-soft text-accent group-hover:border-accent/50'
                  }`}>
                    {item.action}
                  </span>
                </Link>
              ))}
            </div>
          </section>
        ) : (
          <>
            <section className="mt-10 space-y-6">
              <div>
                <div className="flex items-center justify-between gap-4 pb-3">
                  <div>
                    <div className="flex items-center gap-2 font-mono text-[10.5px] font-medium uppercase tracking-[0.16em] text-theme-subtle">
                      <CheckCircle2 className="h-3.5 w-3.5 text-accent-purple" />
                      Needs You
                    </div>
                    <div className="mt-1 text-[13px] text-theme-muted">Approvals, questions, or blocked checkpoints.</div>
                  </div>
                  {humanApprovals.length > 0 ? (
                    <Link to="/executions" className="inline-flex items-center gap-1 text-[12px] font-medium text-theme-muted hover:text-theme-primary">
                      Review all <ArrowRight className="h-3 w-3" />
                    </Link>
                  ) : (
                    <span className="font-mono text-[12px] text-theme-subtle">0 waiting</span>
                  )}
                </div>
                {humanLoopRows.length === 0 ? (
                  <div className="flex h-12 items-center justify-center gap-2 px-5 text-[13px] text-theme-muted">
                    <Circle className="h-2 w-2 fill-current" />
                    No execution needs you
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-md border border-app bg-app-card">
                    <div className="divide-y divide-app">
                      {humanLoopRows.map((item) => (
                        <Link key={item.id} to={item.href} className="group grid min-h-[72px] grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 transition-colors hover:bg-app-muted/40">
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13.5px] font-semibold text-theme-primary group-hover:text-accent">{item.title}</span>
                            <span className="mt-0.5 block truncate text-[12px] text-theme-muted">{item.sub}</span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            <span className="hidden rounded-full border border-app bg-app px-2 py-0.5 font-mono text-[10px] text-theme-muted sm:inline-flex">
                              {item.kind}
                            </span>
                            <span className="font-mono text-[10.5px] text-theme-subtle">{timeAgo(item.createdAt)}</span>
                          </span>
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-6">
                <section>
                  <div className="flex items-center justify-between gap-4 pb-3">
                    <div>
                      <div className="flex items-center gap-2 font-mono text-[10.5px] font-medium uppercase tracking-[0.16em] text-theme-subtle">
                        <PlayCircle className="h-3.5 w-3.5 text-accent-cyan" />
                        Running Conversation
                      </div>
                      <div className="mt-1 text-[13px] text-theme-muted">Chat conversations with active agent or workflow work.</div>
                    </div>
                    <span className="font-mono text-[12px] text-theme-subtle">{runningConversations.length} running</span>
                  </div>
                  <div>
                    {runningRows.length === 0 ? (
                      <div className="flex h-12 items-center justify-center gap-2 px-5 text-[13px] text-theme-muted">
                        <Circle className="h-2 w-2 fill-current" />
                        No running conversation
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {runningRows.map((item) => (
                          <div
                            key={item.id}
                            role="link"
                            tabIndex={0}
                            onClick={() => navigate(item.href)}
                            onKeyDown={(event) => activateConversationRow(event, item.href, navigate)}
                            className="group grid min-h-[68px] cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-app bg-app-card px-4 py-3 transition-colors hover:border-app-strong hover:bg-app-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                          >
                            <span className="min-w-0">
                              <span className="block truncate text-[14px] font-semibold text-theme-primary">{item.title}</span>
                              <ConversationMeta item={item} />
                              {item.sub && <span className="mt-1 block truncate font-mono text-[11px] text-theme-muted">{item.sub}</span>}
                            </span>
                            <span className="flex shrink-0 items-center gap-3">
                              {item.run ? (
                                <WorkStatusBadge run={item.run} />
                              ) : (
                                <span className="badge badge-info">
                                  <span className="status-dot" />
                                  running
                                </span>
                              )}
                              <ArrowRight className="h-3.5 w-3.5 text-theme-subtle opacity-0 transition-opacity group-hover:opacity-100" />
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </section>

                <section>
                  <div className="flex items-center justify-between gap-4 pb-3">
                    <div>
                      <div className="flex items-center gap-2 font-mono text-[10.5px] font-medium uppercase tracking-[0.16em] text-theme-subtle">
                        <Clock3 className="h-3.5 w-3.5 text-theme-muted" />
                        Recent Conversation
                      </div>
                      <div className="mt-1 text-[13px] text-theme-muted">Latest chat conversations.</div>
                    </div>
                    <Link to="/chats" className="inline-flex items-center gap-1 text-[12px] font-medium text-theme-muted hover:text-theme-primary">
                      View all <ArrowRight className="h-3 w-3" />
                    </Link>
                  </div>
                  <div>
                    {recentRows.length === 0 ? (
                      <div className="flex h-12 items-center justify-center gap-2 px-5 text-[13px] text-theme-muted">
                        <Clock3 className="h-3.5 w-3.5" />
                        No recent conversation yet
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {recentRows.map((item) => (
                          <div
                            key={item.id}
                            role="link"
                            tabIndex={0}
                            onClick={() => navigate(item.href)}
                            onKeyDown={(event) => activateConversationRow(event, item.href, navigate)}
                            className="group grid min-h-[68px] cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-app bg-app-card px-4 py-3 transition-colors hover:border-app-strong hover:bg-app-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                          >
                            <span className="min-w-0">
                              <span className="block truncate text-[14px] font-semibold text-theme-primary">{item.title}</span>
                              <ConversationMeta item={item} />
                              {item.sub && <span className="mt-1 block truncate font-mono text-[11px] text-theme-muted">{item.sub}</span>}
                            </span>
                            <span className="flex shrink-0 items-center gap-2">
                              {messageCountLabel(item.messageCount) && (
                                <span className="font-mono text-[11px] text-theme-muted">
                                  {messageCountLabel(item.messageCount)}
                                </span>
                              )}
                              <span className="font-mono text-[11px] text-theme-subtle">{timeAgo(item.timestamp)}</span>
                              <ArrowRight className="h-3.5 w-3.5 text-theme-subtle opacity-0 transition-opacity group-hover:opacity-100" />
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </section>
              </div>
            </section>
          </>
        )}
      </div>
      {connectPreset && (
        <McpPresetConnectModal
          presetName={connectPreset}
          onClose={() => setConnectPreset(null)}
          onConnected={() => {
            if (connectPreset === 'github') setGithubConnected(true);
            else if (connectPreset === 'linear') setLinearConnected(true);
            setConnectPreset(null);
          }}
        />
      )}
    </div>
  );
}
