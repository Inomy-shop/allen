import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { agents as agentsApi, chat as chatApi, executions, interventions, repos as reposApi } from '../services/api';
import { pullRequests } from '../services/workspaceService';
import { useAuthStore } from '../stores/authStore';
import ChatInput, { type ReasoningEffortValue, type RepoOption } from '../components/chat/ChatInput';
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
  repoName?: string;
  status: 'open' | 'merged' | 'closed';
  createdAt?: string;
  updatedAt?: string;
  createdByAgent?: string;
  createdByWorkflow?: boolean;
  chatSessionId?: string;
  originatingExecutionId?: string;
  resolutionInProgress?: { startedAt?: string; executionId?: string } | null;
}

interface NeedsYouItem {
  id: string;
  kind: 'gate' | 'review' | 'question' | 'blocked';
  title: string;
  sub: string;
  href: string;
  external?: boolean;
  createdAt?: string;
}

const DASHBOARD_SKELETONS = Array.from({ length: 4 }, (_, index) => `dashboard-skeleton-${index}`);

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

function isActiveRun(run: ExecutionItem): boolean {
  return ['running', 'queued', 'waiting_for_input'].includes(run.status);
}

function progressForRun(run: ExecutionItem): number {
  if (run.pullRequest?.status === 'merged') return 100;
  if (run.pullRequest?.status === 'open') return 92;
  if (run.pullRequest?.status === 'closed') return 100;
  switch (run.status) {
    case 'completed': return 100;
    case 'failed': return 60;
    case 'cancelled': return 20;
    case 'waiting_for_input': return 35;
    case 'running': {
      const completed = Array.isArray(run.completedNodes) ? run.completedNodes.filter(Boolean).length : 0;
      const current = Array.isArray(run.currentNodes) ? run.currentNodes.filter(Boolean).length : 0;
      if (completed > 0 || current > 0) return Math.max(20, Math.min(88, Math.round((completed / (completed + current + 1)) * 100)));
      return 58;
    }
    case 'queued': return 12;
    default: return 25;
  }
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

function interventionKind(item: InterventionItem): 'gate' | 'review' | 'question' | 'blocked' {
  if (item.severity === 'escalation') return 'blocked';
  if (item.severity === 'approval') return 'review';
  if ((item.stage ?? '').toLowerCase().includes('gate')) return 'gate';
  return 'question';
}

function needsItemFromIntervention(item: InterventionItem): NeedsYouItem {
  return {
    id: `intervention-${item.intervention_id}`,
    kind: interventionKind(item),
    title: item.title,
    sub: item.context_summary || item.workflow_name || 'Manual intervention required',
    href: `/interventions/${item.intervention_id}`,
    createdAt: item.created_at,
  };
}

function isReviewNeededPr(pr: PullRequestReviewItem): boolean {
  return pr.status === 'open'
    && Boolean(pr.createdByWorkflow || pr.createdByAgent || pr.chatSessionId || pr.originatingExecutionId);
}

function needsItemFromPr(pr: PullRequestReviewItem): NeedsYouItem {
  const repo = pr.repoName || 'Repository';
  const agent = pr.createdByAgent ? ` · ${humanizeLabel(pr.createdByAgent)}` : '';
  return {
    id: `pr-${pr._id}`,
    kind: 'review',
    title: `Review PR #${pr.number}: ${pr.title}`,
    sub: `${repo}${agent}`,
    href: `/pull-requests/${pr._id}`,
    createdAt: pr.updatedAt || pr.createdAt,
  };
}

function needsItemFromRunPr(run: ExecutionItem): NeedsYouItem | null {
  const pr = run.pullRequest;
  if (!pr?.number || pr.status !== 'open') return null;
  return {
    id: `run-pr-${run.id}-${pr.number}`,
    kind: 'review',
    title: `Review PR #${pr.number}: ${compactTitle(pr.title) ?? runTitle(run)}`,
    sub: runTitle(run),
    href: pr.url ?? (pr.id ? `/pull-requests/${pr.id}` : '/pull-requests'),
    external: Boolean(pr.url),
    createdAt: pr.updatedAt ?? pr.createdAt ?? run.startedAt,
  };
}

function dedupeNeeds(items: NeedsYouItem[]): NeedsYouItem[] {
  const seen = new Set<string>();
  const result: NeedsYouItem[] = [];
  for (const item of items) {
    const prKey = item.title.match(/PR #\d+/i)?.[0]?.toLowerCase();
    const key = prKey ?? item.href ?? item.id;
    if (seen.has(key)) continue;
    seen.add(key);
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

function runPrimaryHref(run: ExecutionItem): string {
  return `/chat/${run.meta?.chatSessionId}`;
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

function TaskRefs({ run }: { run: ExecutionItem }) {
  return (
    <Link className="r-refs r-open-area" to={runPrimaryHref(run)} title="Open chat thread">
      <span className="r-ref linear">{runPrimaryRef(run)}</span>
      <span className="r-ref gh">{runSecondaryRef(run)}</span>
    </Link>
  );
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const [pendingInterventions, setPendingInterventions] = useState<InterventionItem[]>([]);
  const [reviewPrs, setReviewPrs] = useState<PullRequestReviewItem[]>([]);
  const [runs, setRuns] = useState<ExecutionItem[]>([]);
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
  const [agentOverrides, setAgentOverrides] = useState<{
    reasoningEffort?: ReasoningEffortValue | null;
    planMode?: boolean | null;
  }>({});

  async function load() {
    try {
      const [pending, execs, prs] = await Promise.all([
        interventions.list({ status: 'pending', limit: 20 }).catch(() => []),
        executions.listPaged({ limit: 40, offset: 0 }).catch(() => ({ items: [] })),
        pullRequests.list({ status: 'open' }).catch(() => []),
      ]);
      setPendingInterventions(pending ?? []);
      setReviewPrs((prs ?? []).filter((pr) => isReviewNeededPr(pr) && Boolean(pr.chatSessionId)));
      setRuns(collapseTaskRuns((execs.items ?? []).filter((run) => isAssignedTask(run) && hasChatReference(run))));
    } finally {
      setInitialLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, []);

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
  }, []);

  const inFlight = useMemo(
    () => runs.filter((run) => isActiveRun(run)).slice(0, 8),
    [runs],
  );
  const recent = useMemo(
    () => runs.filter((run) => !isActiveRun(run)).slice(0, 8),
    [runs],
  );
  const needsYou = useMemo(
    () => dedupeNeeds([
      ...runs
        .map(needsItemFromRunPr)
        .filter((item): item is NeedsYouItem => Boolean(item)),
      ...pendingInterventions
        .filter((item) => runs.some((run) => run.id === item.workflow_run_id && hasChatReference(run)))
        .map(needsItemFromIntervention),
      ...reviewPrs.map(needsItemFromPr),
    ]).sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime()),
    [pendingInterventions, reviewPrs, runs],
  );
  const firstName = (user?.name || user?.email?.split('@')[0] || 'there').split(/\s+/)[0];

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

  return (
    <div className="content scroll-hide" data-screen-label="my-work">
      <div className="mw-greet">
        <div className="mw-hello">
          <h1>good afternoon, {firstName}</h1>
          <p className="sub">
            {needsYou.length} need you · {inFlight.length} in flight · {recent.length} recent
          </p>
        </div>
      </div>

      <div className="mw-command">
        <div className="mw-command-composer">
          <ChatInput
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
      </div>

      <section className="mw-sec">
        <header className="mw-sec-h">
          <h3>Needs You</h3>
          <Link className="link" to="/interventions">Inbox <ArrowRight className="h-3 w-3" /></Link>
        </header>
        {initialLoading && pendingInterventions.length === 0 ? (
          <div className="mw-needs">
            {DASHBOARD_SKELETONS.map((key) => (
              <div key={key} className="mw-need skeleton-card">
                <span className="sk sk-chip" />
                <span className="sk sk-title" />
                <span className="sk sk-line" />
                <span className="sk sk-line short" />
              </div>
            ))}
          </div>
        ) : needsYou.length === 0 ? (
          <div className="task-empty">No workflow interventions or PR reviews need your input right now.</div>
        ) : (
          <div className="mw-needs">
            {needsYou.slice(0, 4).map((item) => (
              item.external ? (
                <a key={item.id} className="mw-need" href={item.href} target="_blank" rel="noreferrer">
                  <span className={`need-kind ${item.kind}`}>{humanizeLabel(item.kind)}</span>
                  <span className="need-title">{item.title}</span>
                  <span className="need-sub">{item.sub}</span>
                  <span className="need-age">{timeAgo(item.createdAt)}</span>
                </a>
              ) : (
              <Link key={item.id} className="mw-need" to={item.href}>
                <span className={`need-kind ${item.kind}`}>{humanizeLabel(item.kind)}</span>
                <span className="need-title">{item.title}</span>
                <span className="need-sub">{item.sub}</span>
                <span className="need-age">{timeAgo(item.createdAt)}</span>
              </Link>
              )
            ))}
          </div>
        )}
      </section>

      <section className="mw-sec">
        <header className="mw-sec-h">
          <h3>In Flight</h3>
          <span className="mw-sec-meta">{inFlight.length}</span>
        </header>
        {initialLoading && inFlight.length === 0 ? (
          <div className="mw-flight">
            {DASHBOARD_SKELETONS.slice(0, 3).map((key) => (
              <div key={key} className="mw-flight-row skeleton-row">
                <span className="sk sk-ref" />
                <span className="sk sk-title" />
                <span className="sk sk-bar" />
                <span className="sk sk-pill" />
              </div>
            ))}
          </div>
        ) : inFlight.length === 0 ? (
          <div className="task-empty">No tasks are currently running.</div>
        ) : (
          <div className="mw-flight">
            {inFlight.map((run) => (
              <div key={run.id} className="mw-flight-row">
                <TaskRefs run={run} />
                <Link className="r-ttl r-open-area" to={runPrimaryHref(run)} title="Open chat thread">
                  <div className="r-line">{runTitle(run)}</div>
                  <div className="r-sub">{runSubline(run)}</div>
                </Link>
                <Link className="r-prog r-open-area" to={runPrimaryHref(run)} title="Open chat thread">
                  <div className="bar"><span style={{ width: `${progressForRun(run)}%` }} /></div>
                  <span className="r-pct">{progressForRun(run)}%</span>
                </Link>
                <div className="r-actions">
                  <WorkStatusBadge run={run} />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mw-sec">
        <header className="mw-sec-h">
          <h3>Recent</h3>
          <Link className="link" to="/executions">All Activity <ArrowRight className="h-3 w-3" /></Link>
        </header>
        {initialLoading && recent.length === 0 ? (
          <div className="mw-recent">
            {DASHBOARD_SKELETONS.slice(0, 3).map((key) => (
              <div key={key} className="mw-recent-row skeleton-row">
                <span className="sk sk-ref" />
                <span className="sk sk-title" />
                <span className="sk sk-pill" />
              </div>
            ))}
          </div>
        ) : recent.length === 0 ? (
          <div className="task-empty">Completed work will appear here.</div>
        ) : (
          <div className="mw-recent">
            {recent.map((run) => (
              <div key={run.id} className="mw-recent-row">
                <TaskRefs run={run} />
                <Link className="r-ttl r-open-area" to={runPrimaryHref(run)} title="Open chat thread">
                  <div className="r-line">{runTitle(run)}</div>
                  <div className="r-sub">{runSubline(run)}</div>
                </Link>
                <div className="r-actions">
                  <WorkStatusBadge run={run} />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
