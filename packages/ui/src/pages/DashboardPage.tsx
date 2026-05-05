import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Bot, ExternalLink, GitBranch } from 'lucide-react';
import { agents as agentsApi, chat as chatApi, executions, interventions, repos as reposApi } from '../services/api';
import { pullRequests } from '../services/workspaceService';
import { useAuthStore } from '../stores/authStore';
import StatusBadge from '../components/common/StatusBadge';
import ChatInput, { type ReasoningEffortValue, type RepoOption } from '../components/chat/ChatInput';
import AgentChatDropdown from '../components/chat/AgentChatDropdown';

interface ExecutionItem {
  id: string;
  title?: string;
  workflowName?: string;
  status: string;
  startedAt?: string;
  durationMs?: number | null;
  type?: 'agent' | 'workflow';
  origin?: string;
  source?: string | null;
  meta?: {
    origin?: string;
    chatSessionId?: string;
    linearIssueId?: string;
    linearIdentifier?: string;
    linearUrl?: string;
  };
  input?: {
    task?: string;
    prompt?: string;
    request?: string;
    linear_identifier?: string;
    ticket_id?: string;
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

function progressFor(status: string): number {
  switch (status) {
    case 'completed': return 100;
    case 'failed': return 60;
    case 'cancelled': return 20;
    case 'waiting_for_input': return 35;
    case 'running': return 58;
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

function compactTitle(value?: string): string | null {
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

function runSourceLabel(run: ExecutionItem): string {
  if (linearIdentifierForRun(run) || run.meta?.linearIssueId || run.source === 'linear' || run.origin === 'linear') return 'Linear';
  if (run.meta?.chatSessionId || run.source === 'chat' || run.meta?.origin === 'chat' || run.origin === 'chat') return 'Thread';
  if (run.meta?.origin === 'direct_agent' || run.type === 'agent') return 'Agent';
  return 'Workflow';
}

function runContextRef(run: ExecutionItem): string {
  const linearIdentifier = linearIdentifierForRun(run);
  if (linearIdentifier) return linearIdentifier;
  if (run.meta?.chatSessionId) return run.meta.chatSessionId.slice(0, 8);
  return run.id.slice(0, 8);
}

function runTitle(run: ExecutionItem): string {
  const directTitle = compactTitle(run.title)
    ?? compactTitle(linearIdentifierForRun(run) ? `Work on ${linearIdentifierForRun(run)}` : undefined)
    ?? compactTitle(run.input?.task)
    ?? compactTitle(run.input?.prompt)
    ?? compactTitle(run.input?.request);
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
  const parts = [statusLabel(run.status)];
  if (run.meta?.chatSessionId) parts.push(`Thread ${run.meta.chatSessionId.slice(0, 8)}`);
  const linearIdentifier = linearIdentifierForRun(run);
  if (linearIdentifier) parts.push(linearIdentifier);
  parts.push(timeAgo(run.startedAt));
  return parts.join(' · ');
}

function runPrimaryHref(run: ExecutionItem): string {
  return run.meta?.chatSessionId ? `/chat/${run.meta.chatSessionId}` : `/executions/${run.id}`;
}

function runExecutionKind(run: ExecutionItem): 'agent' | 'workflow' {
  if (run.type === 'agent' || run.workflowName?.includes(':spawn_agent/')) return 'agent';
  return 'workflow';
}

function runExecutionLabel(run: ExecutionItem): string {
  return runExecutionKind(run) === 'workflow' ? 'Workflow Execution' : 'Agent Execution';
}

function RunExecutionLink({ run }: { run: ExecutionItem }) {
  const kind = runExecutionKind(run);
  const Icon = kind === 'workflow' ? GitBranch : Bot;
  return (
    <Link className="r-run-link" to={`/executions/${run.id}`} title={`Open ${runExecutionLabel(run).toLowerCase()}`}>
      <Icon className="h-3 w-3" />
      {kind === 'workflow' ? 'Workflow' : 'Agent'}
      <ExternalLink className="h-3 w-3" />
    </Link>
  );
}

function prAge(pr?: ExecutionItem['pullRequest']): string {
  if (!pr) return '';
  return timeAgo(pr.mergedAt ?? pr.updatedAt ?? pr.createdAt ?? undefined);
}

function prStatusLabel(pr?: ExecutionItem['pullRequest']): string {
  return humanizeLabel(pr?.status ?? '') || 'PR';
}

function TaskMetaLinks({ run }: { run: ExecutionItem }) {
  const linearIdentifier = linearIdentifierForRun(run);
  const linearUrl = run.linear?.url ?? run.meta?.linearUrl;
  const pr = run.pullRequest;

  if (!linearIdentifier && !pr?.number) return null;

  return (
    <div className="r-links">
      {linearIdentifier && (
        linearUrl ? (
          <a className="r-link-pill" href={linearUrl} target="_blank" rel="noreferrer">
            {linearIdentifier}
          </a>
        ) : (
          <span className="r-link-pill">{linearIdentifier}</span>
        )
      )}
      {pr?.number && (
        pr.url ? (
          <a className={`r-link-pill pr ${pr.status ?? 'open'}`} href={pr.url} target="_blank" rel="noreferrer">
            PR #{pr.number} · {prStatusLabel(pr)} · {prAge(pr)}
          </a>
        ) : (
          <Link className={`r-link-pill pr ${pr.status ?? 'open'}`} to={pr.id ? `/pull-requests/${pr.id}` : '/pull-requests'}>
            PR #{pr.number} · {prStatusLabel(pr)} · {prAge(pr)}
          </Link>
        )
      )}
    </div>
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
      setReviewPrs((prs ?? []).filter(isReviewNeededPr));
      setRuns((execs.items ?? []).filter(isAssignedTask));
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
    () => runs.filter((run) => ['running', 'queued', 'waiting_for_input'].includes(run.status)).slice(0, 8),
    [runs],
  );
  const recent = useMemo(
    () => runs.filter((run) => !['running', 'queued', 'waiting_for_input'].includes(run.status)).slice(0, 8),
    [runs],
  );
  const needsYou = useMemo(
    () => [
      ...pendingInterventions.map(needsItemFromIntervention),
      ...reviewPrs.map(needsItemFromPr),
    ].sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime()),
    [pendingInterventions, reviewPrs],
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
          <h1>Good Afternoon, {firstName}</h1>
          <p className="sub">
            {needsYou.length} Need You · {inFlight.length} In Flight · {recent.length} Recent
          </p>
        </div>
      </div>

      <div className="mw-command">
        <div className="mw-command-head">
          <div>
            <span className="mw-command-kicker">Command Center</span>
            <h2>Tell Allen What To Answer, Plan, Or Run</h2>
          </div>
          <div className="mw-command-metrics">
            <span>{needsYou.length} Waiting</span>
            <span>{inFlight.length} Active</span>
            <span>{recent.length} Recent</span>
          </div>
        </div>
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
        <div className="mw-command-note">Normal chat stays with Assistant; task intent can route to workflow, lead, or specialist.</div>
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
              <Link key={item.id} className="mw-need" to={item.href}>
                <span className={`need-kind ${item.kind}`}>{humanizeLabel(item.kind)}</span>
                <span className="need-title">{item.title}</span>
                <span className="need-sub">{item.sub}</span>
                <span className="need-age">{timeAgo(item.createdAt)}</span>
              </Link>
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
                <Link className="r-refs r-open-area" to={runPrimaryHref(run)} title={run.meta?.chatSessionId ? 'Open chat thread' : 'Open execution'}>
                  <span className="r-ref linear">{runSourceLabel(run)}</span>
                  <span className="r-ref gh">{runContextRef(run)}</span>
                </Link>
                <Link className="r-ttl r-open-area" to={runPrimaryHref(run)} title={run.meta?.chatSessionId ? 'Open chat thread' : 'Open execution'}>
                  <div className="r-line">{runTitle(run)}</div>
                  <div className="r-sub">{runSubline(run)}</div>
                </Link>
                <TaskMetaLinks run={run} />
                <Link className="r-prog r-open-area" to={runPrimaryHref(run)} title={run.meta?.chatSessionId ? 'Open chat thread' : 'Open execution'}>
                  <div className="bar"><span style={{ width: `${progressFor(run.status)}%` }} /></div>
                  <span className="r-pct">{progressFor(run.status)}%</span>
                </Link>
                <div className="r-actions">
                  <StatusBadge status={run.status} />
                  <RunExecutionLink run={run} />
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
                <Link className="r-refs r-open-area" to={runPrimaryHref(run)} title={run.meta?.chatSessionId ? 'Open chat thread' : 'Open execution'}>
                  <span className="r-ref linear">{runSourceLabel(run)}</span>
                  <span className="r-ref gh">{runContextRef(run)}</span>
                </Link>
                <Link className="r-ttl r-open-area" to={runPrimaryHref(run)} title={run.meta?.chatSessionId ? 'Open chat thread' : 'Open execution'}>
                  <div className="r-line">{runTitle(run)}</div>
                  <div className="r-sub">{runSubline(run)}</div>
                </Link>
                <TaskMetaLinks run={run} />
                <div className="r-actions">
                  <StatusBadge status={run.status} />
                  <RunExecutionLink run={run} />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
