import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Circle,
  Clock3,
} from 'lucide-react';
import { agents as agentsApi, chat as chatApi, executions, interventions, linear as linearApi, mcp as mcpApi, repos as reposApi, system as systemApi, workflows as workflowsApi } from '../services/api';
import { McpPresetConnectModal } from '../components/settings/McpServerManager';
import { chatCodeDiffs, pullRequests } from '../services/workspaceService';
import { useAuthStore } from '../stores/authStore';
import { useExecutionStore } from '../stores/executionStore';
import ChatInput, { type ChatInputHandle, type ReasoningEffortValue, type RepoOption } from '../components/chat/ChatInput';
import { useSkillSlashCommands } from '../hooks/useSkillSlashCommands';
import { useFileDropZone, FileDropOverlay } from '../hooks/useFileDropZone';
import AgentChatDropdown from '../components/chat/AgentChatDropdown';
import {
  V8SetupAgentsIcon,
  V8SetupGithubIcon,
  V8SetupLinearIcon,
  V8SetupMcpIcon,
  V8SetupModelsIcon,
  V8SetupTickIcon,
  V8SetupWorkflowIcon,
} from '../components/common/V8SidebarIcons';

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

function compactAge(dateStr?: string): string {
  if (!dateStr) return 'now';
  const ms = Math.max(0, Date.now() - new Date(dateStr).getTime());
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

function waitingAge(dateStr?: string): string {
  if (!dateStr) return 'now';
  const min = Math.floor(Math.max(0, Date.now() - new Date(dateStr).getTime()) / 60_000);
  if (min < 60) return min < 1 ? 'now' : `${min}m`;
  const hr = Math.floor(min / 60);
  const remainingMinutes = min % 60;
  return remainingMinutes ? `${hr}h ${remainingMinutes}m` : `${hr}h`;
}

function isActiveRun(run: ExecutionItem): boolean {
  return ['running', 'queued', 'waiting_for_input', 'waiting_for_human'].includes(run.status);
}

function canNeedHumanInput(run?: ExecutionItem): boolean {
  if (!run) return false;
  return !['completed', 'failed', 'cancelled', 'canceled'].includes(run.status);
}

function isWaitingForHumanInput(run: ExecutionItem): boolean {
  return run.status === 'waiting_for_input' || run.status === 'waiting_for_human';
}

function statusLabel(status: string): string {
  if (status === 'waiting_for_input' || status === 'waiting_for_human') return 'Waiting';
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
  if (isWaitingForHumanInput(run)) return 'waiting on you';
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
  const context = [
    run?.workflowName ?? item.workflow_name,
    item.stage ? humanizeLabel(item.stage) : null,
    compactTitle(item.context_summary),
  ].filter(Boolean).join(' · ');
  return {
    id: `approval-${item.intervention_id}`,
    kind: item.severity === 'escalation' ? 'blocked' : item.severity === 'question' ? 'question' : 'approval',
    title: item.title || (run ? runTitle(run) : 'Execution approval'),
    sub: context || 'Workflow execution',
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
    return [archived.repoName, archived.name].filter(Boolean).join(' · ');
  }
  if (session.workspaceName || session.workspaceRepoName) {
    return [session.workspaceRepoName, session.workspaceName].filter(Boolean).join(' · ');
  }
  if (session.repoName) return session.repoName;
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

function ConversationMeta({ item }: { item: ChatConversationItem }) {
  const pr = item.pullRequest;
  const diff = item.diffSummary ?? null;
  const changedFiles = pr?.changedFiles ?? diff?.files;
  const additions = pr?.additions ?? diff?.additions;
  const deletions = pr?.deletions ?? diff?.deletions;
  const hasDiff = Boolean(changedFiles != null || additions != null || deletions != null);
  if (!item.ownerLabel && !item.contextLabel && !item.sub && !pr && !hasDiff) return null;
  const sections = [
    item.ownerLabel ? <span key="owner">{item.ownerLabel}</span> : null,
    item.contextLabel ? <span key="context">{item.contextLabel}</span> : null,
    pr ? (
      pr.url ? (
        <a
          key="pr"
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          title="Open pull request"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          PR {pr.number ? `#${pr.number}` : ''}{pr.status ? ` · ${pr.status}` : ''}
        </a>
      ) : (
        <span key="pr">PR {pr.number ? `#${pr.number}` : ''}{pr.status ? ` · ${pr.status}` : ''}</span>
      )
    ) : null,
    hasDiff ? (
      <span key="diff">
        {changedFiles != null && `${changedFiles} file${changedFiles === 1 ? '' : 's'}`}
        {additions != null && <span className="home-v8-diff-add"> +{additions}</span>}
        {deletions != null && <span className="home-v8-diff-del"> -{deletions}</span>}
      </span>
    ) : null,
    item.sub ? <span key="sub">{item.sub}</span> : null,
  ].filter(Boolean);
  return (
    <div className="home-v8-row-meta">
      {sections.map((section, index) => (
        <span key={index}>
          {index > 0 && <span className="home-v8-meta-sep"> · </span>}
          {section}
        </span>
      ))}
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
  const skillSlashCommands = useSkillSlashCommands();
  const [pendingInterventions, setPendingInterventions] = useState<InterventionItem[]>([]);
  const [allPullRequests, setAllPullRequests] = useState<PullRequestReviewItem[]>([]);
  const [runs, setRuns] = useState<ExecutionItem[]>([]);
  const executionRevisionClock = useExecutionStore(state => state.changeVersion);
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
  const [mcpServerCount, setMcpServerCount] = useState(0);
  const [workflowCount, setWorkflowCount] = useState(0);
  const [connectPreset, setConnectPreset] = useState<'github' | 'linear' | null>(null);
  const [agentOverrides, setAgentOverrides] = useState<{
    reasoningEffort?: ReasoningEffortValue | null;
    planMode?: boolean | null;
  }>({});
  async function load() {
    try {
      const [pending, execs, sessions, prs] = await Promise.all([
        interventions.list({ status: 'pending', limit: 20 }).catch(() => []),
        executions.listPaged({ limit: 40, offset: 0 }).catch(() => ({ items: [] })),
        chatApi.listSessions(user?.id ? { ownerUserId: user.id } : undefined).catch(() => []),
        pullRequests.list().catch(() => []),
      ]);
      setPendingInterventions(pending ?? []);
      setAllPullRequests(prs ?? []);
      for (const execution of execs.items ?? []) {
        useExecutionStore.getState().ingestExecution(execution as unknown as Record<string, unknown>);
      }
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
  }, [user?.id, executionRevisionClock]);

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
    reposApi.list().then((list: RepoOption[]) => {
      const nextRepos = list ?? [];
      setRepos(nextRepos);
      setSelectedRepo((current) => current ?? nextRepos[0] ?? null);
    }).catch(() => {});
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
    Promise.all([
      mcpApi.list().catch(() => []),
      workflowsApi.list().catch(() => []),
    ]).then(([mcpServers, workflows]) => {
      setMcpServerCount(mcpServers.length);
      setWorkflowCount(workflows.length);
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
          sub: sessionSubline(session, run, { includeTimestamp: false }),
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
        const details = sessionSubline(session, undefined, { includeTimestamp: false });
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
    () => {
      const runById = new Map(runs.map((run) => [run.id, run]));
      return dedupeApprovals([
        ...pendingInterventions
          .map((item) => {
            const run = runById.get(item.workflow_run_id);
            return canNeedHumanInput(run) ? approvalItemFromIntervention(item, run) : null;
          })
          .filter((item): item is HumanApprovalItem => Boolean(item)),
        ...runs
          .filter(isWaitingForHumanInput)
          .map(approvalItemFromWaitingRun),
      ]).sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime());
    },
    [pendingInterventions, runs],
  );
  const homeMeta = useMemo(() => {
    const date = new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    }).format(new Date());
    const running = runningConversations.length;
    return `${date} · ${running} session${running === 1 ? '' : 's'} running`;
  }, [runningConversations.length]);

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
  const configuredProviderNames = new Set(
    providers.map((provider) => String(provider.provider ?? provider.name ?? provider.label ?? '').toLowerCase()),
  );
  const configuredTeamCount = new Set(allAgents.map((agent) => agent.teamName).filter(Boolean)).size;
  const setupCards = [
    {
      title: 'Connect GitHub',
      desc: githubConnected
        ? 'Agents can now open PRs, read review comments, and push branches.'
        : 'A personal access token lets agents open pull requests, read review comments, and push branches.',
      icon: V8SetupGithubIcon,
      done: githubConnected,
      action: githubConnected ? 'Manage' : 'Connect',
      why: githubConnected ? 'connected' : 'unlocks PRs',
      minis: [] as Array<{ label: string; ready?: boolean }>,
      href: githubConnected ? '/pull-requests' : null,
      onAction: githubConnected ? undefined : () => setConnectPreset('github' as const),
    },
    {
      title: 'Connect Linear',
      desc: linearConnected
        ? 'Browse tickets in Allen and dispatch issues to agents — they come back as PRs.'
        : 'Browse tickets inside Allen and dispatch an issue straight to an agent — it comes back as a PR.',
      icon: V8SetupLinearIcon,
      done: linearConnected,
      action: linearConnected ? 'Open tickets' : 'Connect',
      why: linearConnected ? 'connected' : 'unlocks tickets',
      minis: [] as Array<{ label: string; ready?: boolean }>,
      href: linearConnected ? '/tickets' : null,
      onAction: linearConnected ? undefined : () => setConnectPreset('linear' as const),
    },
    {
      title: 'Add model providers',
      desc: 'Two are ready from setup. Add more coding LLMs and mix them per agent or workflow node.',
      icon: V8SetupModelsIcon,
      done: providers.length > 0,
      action: providers.length ? 'Manage' : 'Add provider',
      why: `${providers.length || 0} ready`,
      minis: ['Claude', 'Codex', 'GLM', 'Kimi', 'DeepSeek', 'MiMo', 'OpenRouter'].map((label) => ({
        label,
        ready: configuredProviderNames.has(label.toLowerCase())
          || (label === 'Claude' && configuredProviderNames.has('claude-cli'))
          || (label === 'Codex' && configuredProviderNames.has('codex')),
      })),
      href: '/settings/models',
    },
    {
      title: 'Add MCP servers',
      desc: mcpServerCount
        ? `${mcpServerCount} MCP server${mcpServerCount === 1 ? '' : 's'} connected. Give agents more tools anytime.`
        : 'Give agents tools beyond the repo — docs, analytics, tickets, or any custom MCP server.',
      icon: V8SetupMcpIcon,
      done: mcpServerCount > 0,
      action: mcpServerCount ? 'Manage servers' : 'Add server',
      why: mcpServerCount ? `${mcpServerCount} connected` : 'unlocks tools',
      minis: ['Google Workspace', 'PostHog', 'Notion', 'Custom…'].map((label) => ({ label })),
      href: '/settings/mcp',
    },
    {
      title: 'Your agent org is ready',
      desc: allAgents.length
        ? `${configuredTeamCount} team${configuredTeamCount === 1 ? '' : 's'} · ${allAgents.length} agent${allAgents.length === 1 ? '' : 's'} seeded — engineering, product, QA, design, and more. Browse them, or create your own.`
        : 'Create or import agents with explicit roles, models, tools, and permissions.',
      icon: V8SetupAgentsIcon,
      done: allAgents.length > 0,
      action: allAgents.length ? 'Meet the team' : 'Set up',
      why: allAgents.length ? 'seeded' : 'required',
      minis: [] as Array<{ label: string; ready?: boolean }>,
      href: '/agents?section=teams-agents',
    },
    {
      title: 'Build a workflow',
      desc: workflowCount
        ? `${workflowCount} workflow${workflowCount === 1 ? '' : 's'} ready. Describe another repeatable process whenever you need one.`
        : <>Describe a repeatable process and <span className="home-v8-setup-mono">workflow-build-and-review</span> assembles it, review-gated, ready to run.</>,
      icon: V8SetupWorkflowIcon,
      done: workflowCount > 0,
      action: workflowCount ? 'Open' : 'Build',
      why: 'optional',
      minis: [] as Array<{ label: string; ready?: boolean }>,
      href: workflowCount ? '/workflows' : '/workflows/new',
    },
  ];
  const setupComplete = setupCards.filter((item) => item.done).length;
  const starterPrompts = [
    'Fix a small bug',
    'Add a dark mode toggle',
    'Explain this codebase to me',
    'Draft a launch announcement',
  ];
  const runningRows = runningConversations.slice(0, 3);
  const recentRows = recentConversations.slice(0, 3);
  const humanLoopRows = humanApprovals.slice(0, 4);
  const activityRows = [
    ...runningRows.map((item) => ({ ...item, activityState: 'running' as const })),
    ...recentRows.map((item) => ({ ...item, activityState: 'recent' as const })),
  ].slice(0, 8);

  const { dragActive, dropProps } = useFileDropZone(
    (files) => chatInputRef.current?.uploadFiles(files),
  );

  return (
    <div className="content scroll-hide bg-app home-v8" data-screen-label="home" data-design-version="v8" {...dropProps}>
      {dragActive && <FileDropOverlay />}
      <div className="home-v8-wrap">
        <section>
          <p className="home-v8-greet">{homeMeta}</p>
          <h1 className="home-v8-title">What should Allen take on?</h1>
          <div className="home-v8-composer">
            <ChatInput
              ref={chatInputRef}
              onSend={sendPrompt}
              streaming={false}
              slashCommands={skillSlashCommands}
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
              inheritedEffort={selectedAgentDoc?.reasoningEffort ?? 'high'}
              inheritedPlanMode={selectedAgentDoc?.planMode ?? null}
              onAgentOverridesChanged={setAgentOverrides}
              maxVisibleLines={2}
              controlPresentation="v8-home"
              placeholder="Ask Allen to fix a Linear ticket, update tests, or review a PR…"
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
                  controlPresentation="v8-home"
                />
              )}
            />
          </div>
        </section>

        {!initialLoading && !hasDashboardActivity ? (
          <section>
            <div className="home-v8-starters">
              {starterPrompts.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => chatInputRef.current?.setValue(prompt)}
                  className="home-v8-starter"
                >
                  {prompt}
                </button>
              ))}
            </div>
            <div className="home-v8-section-head">
              <div>
                <h2>Finish setting up</h2>
                <span>{setupComplete} of {setupCards.length} done</span>
              </div>
              <Link to="/settings/general">
                All settings →
              </Link>
            </div>
            <div className="home-v8-setup-grid">
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
                  className={`home-v8-setup-card ${item.done ? 'done' : ''}`}
                >
                  {item.done && <span className="home-v8-setup-tick"><V8SetupTickIcon /></span>}
                  <span className="home-v8-setup-icon">
                    <item.icon />
                  </span>
                  <span className="home-v8-setup-title">{item.title}</span>
                  <span className="home-v8-setup-description">{item.desc}</span>
                  {item.minis.length > 0 && (
                    <span className="home-v8-setup-minis">
                      {item.minis.map((mini) => (
                        <span
                          key={mini.label}
                          className={'ready' in mini && mini.ready ? 'ready' : ''}
                        >
                          {'ready' in mini && mini.ready ? '✓ ' : ''}{mini.label}
                        </span>
                      ))}
                    </span>
                  )}
                  <span className="home-v8-setup-footer">
                    <span className="home-v8-setup-why">{item.why}</span>
                    <span className="home-v8-setup-action">{item.action} →</span>
                  </span>
                </Link>
              ))}
            </div>
            <div className="home-v8-receipt">
              Setup: admin ✓ · machine ✓ · repository {repos.length ? '✓' : '—'} — from onboarding
            </div>
          </section>
        ) : (
          <section>
              <div className="home-v8-section">
                <div className="home-v8-section-head">
                  <div>
                    <h2>Needs you</h2>
                    <span>{humanApprovals.length}</span>
                  </div>
                  {humanApprovals.length > 0 ? (
                    <Link to="/chats">
                      All sessions →
                    </Link>
                  ) : (
                    <span className="home-v8-zero">0 waiting</span>
                  )}
                </div>
                {humanLoopRows.length === 0 ? (
                  <div className="home-v8-empty-row">
                    <Circle />
                    No execution needs you
                  </div>
                ) : (
                    <div className="home-v8-list">
                      {humanLoopRows.map((item) => (
                        <Link key={item.id} to={item.href} className="home-v8-row home-v8-row-attention">
                          <span className={`home-v8-dot ${item.kind === 'blocked' ? 'error' : 'human'}`} />
                          <span className="home-v8-row-main">
                            <span className="home-v8-row-title">{item.title}</span>
                            <span className="home-v8-row-meta">{item.sub}</span>
                          </span>
                          <span className={`home-v8-attention-status ${item.kind === 'blocked' ? 'error' : ''}`}>
                            {item.kind === 'blocked' ? 'paused' : `waiting ${waitingAge(item.createdAt)}`}
                          </span>
                          <span className={`home-v8-attention-action ${item.kind === 'blocked' ? 'secondary' : ''}`}>
                            {item.kind === 'blocked' ? 'Resolve' : 'Review'}
                          </span>
                        </Link>
                      ))}
                    </div>
                )}
              </div>

              <div className="home-v8-section">
                <div className="home-v8-section-head">
                  <div>
                    <h2>Recent</h2>
                    <span>{activityRows.length}</span>
                  </div>
                </div>
                {activityRows.length === 0 ? (
                  <div className="home-v8-empty-row">
                    <Clock3 />
                    No sessions yet
                  </div>
                ) : (
                    <div className="home-v8-list">
                      {activityRows.map((item) => (
                        <div
                          key={`${item.activityState}:${item.id}`}
                          role="link"
                          tabIndex={0}
                          onClick={() => navigate(item.href)}
                          onKeyDown={(event) => activateConversationRow(event, item.href, navigate)}
                          className="home-v8-row"
                        >
                          <span className={`home-v8-dot ${item.activityState === 'running' ? 'running' : 'complete'}`} />
                          <span className="home-v8-row-main">
                            <span className="home-v8-row-title">{item.title}</span>
                            <ConversationMeta item={item} />
                          </span>
                          <span className="home-v8-row-time">{compactAge(item.timestamp)}</span>
                        </div>
                      ))}
                    </div>
                )}
              </div>
          </section>
        )}
        <footer className="home-v8-footer">
          Allen · agentic operating system for software development
        </footer>
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
