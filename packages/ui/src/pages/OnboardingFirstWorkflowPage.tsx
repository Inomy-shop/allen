import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  Blocks,
  Bug,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  CircleDot,
  ExternalLink,
  FolderGit2,
  GitBranch,
  Loader2,
} from 'lucide-react';
import { executions, repos, system, workflows } from '../services/api';
import { useOnboardingGate } from '../hooks/useOnboardingGate';
import { OnboardingShell } from '../components/onboarding/OnboardingShell';
import {
  DEFAULT_ONBOARDING_BUG_REPORT,
  DEFAULT_ONBOARDING_FEATURE_REQUEST,
  DEFAULT_ONBOARDING_REPO,
  isDefaultOnboardingRepo,
} from '../lib/onboarding-defaults';
import {
  buildOnboardingWorkflowInput,
  type OnboardingTaskType,
} from '../lib/onboarding-workflow-input';

type TaskType = OnboardingTaskType;

interface RepoRecord {
  _id?: string;
  id?: string;
  name?: string;
  path: string;
  url?: string;
  detected?: {
    language?: string[];
    framework?: string[];
    packageManager?: string;
    defaultBranch?: string;
    remoteUrl?: string;
  };
}

interface WorkflowRecord {
  _id: string;
  name: string;
  description?: string;
  parsed?: {
    input?: Record<string, { type?: string; required?: boolean }>;
  };
}

interface HealthCheck {
  id: string;
  status: 'pass' | 'warn' | 'fail';
}

const ONBOARDING_WORKFLOWS: Record<TaskType, {
  name: string;
  label: string;
  title: string;
  description: string;
  inputLabel: string;
  placeholder: string;
  startLabel: string;
  defaultPrompt: string;
}> = {
  bug: {
    name: 'bug-fix-by-severity',
    label: 'Fix a bug',
    title: 'Small bug fix',
    description: 'Describe a focused issue. Allen passes the selected repo internally and runs the bug-fix workflow.',
    inputLabel: 'Bug description',
    placeholder: 'Describe the observed behavior, expected behavior, and repro steps. Example: The readiness widget shows the wrong message when the score is exactly 50.',
    startLabel: 'Start bug fix',
    defaultPrompt: DEFAULT_ONBOARDING_BUG_REPORT,
  },
  feature: {
    name: 'feature-plan-and-implement',
    label: 'Build a feature',
    title: 'Small feature',
    description: 'Describe a focused product change. Allen passes the selected repo internally and runs the feature planning workflow.',
    inputLabel: 'Feature request',
    placeholder: 'Describe what should be built, who it is for, and any constraints. Example: Add a dark mode toggle to the test website.',
    startLabel: 'Start feature build',
    defaultPrompt: DEFAULT_ONBOARDING_FEATURE_REQUEST,
  },
};

let defaultOnboardingRepoPromise: Promise<RepoRecord> | null = null;

function createDefaultOnboardingRepo(): Promise<RepoRecord> {
  if (!defaultOnboardingRepoPromise) {
    defaultOnboardingRepoPromise = repos.clone({
      url: DEFAULT_ONBOARDING_REPO.url,
      branch: DEFAULT_ONBOARDING_REPO.branch,
      name: DEFAULT_ONBOARDING_REPO.name,
    }).finally(() => {
      defaultOnboardingRepoPromise = null;
    });
  }
  return defaultOnboardingRepoPromise;
}

/**
 * The provider used for each agent is decided at setup time
 * (ALLEN_DEFAULT_AGENT_PROVIDER) and persisted on each agent record, so the
 * onboarding page no longer asks the user to choose. The launch gate just
 * needs at least ONE provider to be fully operational — both its CLI and
 * its auth must be present and non-failing. Either claude OR codex working
 * is enough to continue.
 */
function anyProviderHealthy(checks: HealthCheck[]): boolean {
  const isOk = (id: string): boolean => {
    const c = checks.find(x => x.id === id);
    return c !== undefined && c.status !== 'fail';
  };
  const claudeOk = isOk('claude_cli') && isOk('claude_auth');
  const codexOk = isOk('codex_cli') && isOk('codex_auth');
  return claudeOk || codexOk;
}

export default function OnboardingFirstWorkflowPage() {
  const navigate = useNavigate();
  const checkingOnboarding = useOnboardingGate('first_workflow');
  const [repoList, setRepoList] = useState<RepoRecord[]>([]);
  const [workflowList, setWorkflowList] = useState<WorkflowRecord[]>([]);
  const [healthChecks, setHealthChecks] = useState<HealthCheck[]>([]);
  const [selectedRepoPath, setSelectedRepoPath] = useState('');
  const [taskType, setTaskType] = useState<TaskType>('bug');
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(true);
  const [defaultRepoLoading, setDefaultRepoLoading] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repoMenuOpen, setRepoMenuOpen] = useState(false);

  useEffect(() => {
    if (checkingOnboarding) return;
    let cancelled = false;
    setLoading(true);
    async function loadOnboardingData() {
      const [loadedRepos, loadedWorkflows, health] = await Promise.all([
        repos.list(),
        workflows.ensureDefaults(Object.values(ONBOARDING_WORKFLOWS).map(workflow => workflow.name))
          .then(() => workflows.list()),
        system.health().catch(() => null),
      ]);

      if ((loadedRepos as RepoRecord[]).length > 0) {
        return { loadedRepos, loadedWorkflows, health };
      }

      if (!cancelled) setDefaultRepoLoading(true);
      const defaultRepo = await createDefaultOnboardingRepo();
      return {
        loadedRepos: [defaultRepo],
        loadedWorkflows,
        health,
      };
    }

    loadOnboardingData()
      .then(({ loadedRepos, loadedWorkflows, health }) => {
        if (cancelled) return;
        const typedRepos = loadedRepos as RepoRecord[];
        const checks = health?.checks ?? [];
        setRepoList(typedRepos);
        setWorkflowList(loadedWorkflows as WorkflowRecord[]);
        setHealthChecks(checks);
        setSelectedRepoPath(current => current || typedRepos[0]?.path || '');
      })
      .catch(err => setError((err as Error).message || 'Could not load onboarding data'))
      .finally(() => {
        if (!cancelled) {
          setDefaultRepoLoading(false);
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [checkingOnboarding]);

  const selectedRepo = useMemo(
    () => repoList.find(repo => repo.path === selectedRepoPath) ?? null,
    [repoList, selectedRepoPath],
  );
  const selectedRepoIsDefault = isDefaultOnboardingRepo(selectedRepo);

  useEffect(() => {
    setPrompt(current => {
      const currentDefault = ONBOARDING_WORKFLOWS[taskType].defaultPrompt;
      const anyDefault = Object.values(ONBOARDING_WORKFLOWS).some(workflow => workflow.defaultPrompt === current);
      if (selectedRepoIsDefault && (!current.trim() || anyDefault)) return currentDefault;
      if (!selectedRepoIsDefault && anyDefault) return '';
      return current;
    });
  }, [selectedRepoIsDefault, taskType]);

  useEffect(() => {
    if (!repoMenuOpen) return undefined;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setRepoMenuOpen(false);
    }
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [repoMenuOpen]);

  const selectedWorkflow = useMemo(
    () => workflowList.find(workflow => workflow.name === ONBOARDING_WORKFLOWS[taskType].name) ?? null,
    [taskType, workflowList],
  );

  const taskConfig = ONBOARDING_WORKFLOWS[taskType];
  const providersHealthy = anyProviderHealthy(healthChecks);
  const promptLooksLikeRepoPath = !!selectedRepo && prompt.trim() === selectedRepo.path;
  const canLaunch = !!selectedRepo
    && !!selectedWorkflow
    && !!prompt.trim()
    && !promptLooksLikeRepoPath
    && providersHealthy
    && !launching;
  const isDesktop = typeof window !== 'undefined' && Boolean(window.allenDesktop);
  const runtimeLabel = isDesktop ? 'desktop runtime' : 'web setup';
  const runtimeCopy = 'Allen will create a managed workspace, stream execution progress, and preserve artifacts from the first run.';
  const bootstrapSteps: Array<{
    number: string;
    title: string;
    copy: string;
    state: 'done' | 'active' | 'next';
  }> = [
    { number: '01', title: 'Create admin', copy: 'Admin account is ready for this instance.', state: 'done' },
    { number: '02', title: 'Verify runtime', copy: 'Required machine checks passed.', state: 'done' },
    { number: '03', title: 'Connect repo', copy: 'Repository is available for workspaces.', state: 'done' },
    { number: '04', title: 'Start workflow', copy: 'Launch a small bug fix or feature run.', state: 'active' },
  ];

  async function launch() {
    if (!selectedRepo || !selectedWorkflow) return;
    setLaunching(true);
    setError(null);
    try {
      const input = buildOnboardingWorkflowInput(selectedWorkflow, {
        taskType,
        request: prompt,
        repoPath: selectedRepo.path,
      });

      // No agentProvider: let each agent use its own stored provider
      // (set at setup time based on which CLI is installed / chosen).
      const execution = await executions.start(selectedWorkflow._id, input);
      await system.updateOnboardingProgress({ action: 'complete' }).catch(() => {});
      navigate(`/executions/${execution.id}`, { replace: true });
    } catch (err) {
      setError((err as Error).message || 'Could not launch workflow');
    } finally {
      setLaunching(false);
    }
  }

  async function skipOnboarding() {
    await system.updateOnboardingProgress({ action: 'skip' }).catch(() => {});
    navigate('/', { replace: true });
  }

  if (checkingOnboarding) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-app text-[13px] text-theme-muted">
        <Loader2 className="mr-2 h-4 w-4 animate-spin text-accent" />
        Loading onboarding
      </div>
    );
  }

  return (
    <OnboardingShell
      step="first_workflow"
      eyebrow="First workflow"
      title="Start your first workflow"
      description="Pick a focused task and describe the change. Allen will create a workspace, run the workflow, and take you to the live execution trace."
      runtimeLabel={runtimeLabel}
      runtimeCopy={runtimeCopy}
      side={(
        <div className="mt-5 space-y-2.5">
          <div className="onboarding-card rounded-md border border-app bg-app-card p-3">
            <div className="mb-3">
              <div className="font-mono text-[10.5px] text-theme-subtle">bootstrap path</div>
              <div className="mt-1 text-[13px] font-semibold text-theme-primary">Ready to run</div>
            </div>
            <div className="space-y-0">
              {bootstrapSteps.map(({ number, title: stepTitle, copy, state }) => (
                <div
                  key={number}
                  className="onboarding-step grid grid-cols-[24px_minmax(0,1fr)] gap-3"
                  style={{ animationDelay: `${Number(number) * 45}ms` }}
                >
                  <div className="relative flex justify-center">
                    <div className={`onboarding-step-icon mt-0.5 grid h-5 w-5 place-items-center rounded-full ${
                      state === 'active'
                        ? 'text-accent'
                        : state === 'done'
                          ? 'text-accent-green'
                          : 'text-theme-subtle'
                    }`}>
                      {state === 'done'
                        ? <CheckCircle2 className="h-5 w-5" />
                        : state === 'active'
                          ? <CircleDot className="h-5 w-5" />
                          : <Circle className="h-5 w-5" />}
                    </div>
                    {number !== '04' && (
                      <div className={`onboarding-step-line absolute bottom-0 top-6 w-px ${
                        state === 'done' ? 'bg-accent-green/35' : 'bg-border'
                      }`} />
                    )}
                  </div>
                  <div className="pb-3">
                    <div className={`text-[13px] font-semibold ${
                      state === 'active' ? 'text-accent' : 'text-theme-primary'
                    }`}>
                      {stepTitle}
                    </div>
                    <p className="mt-0.5 text-[12px] leading-5 text-theme-muted">{copy}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="grid gap-2.5 sm:grid-cols-2">
            <div className="onboarding-card rounded-md border border-app bg-app-card p-3">
              <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-theme-primary">
                <CheckCircle2 className="h-4 w-4 text-accent-green" />
                What happens next
              </div>
              <p className="text-[12px] leading-5 text-theme-muted">
                Progress streams to the execution page with logs and artifacts.
              </p>
            </div>

            <div className="onboarding-card rounded-md border border-app bg-app-card p-3">
              <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-theme-primary">
                <AlertTriangle className="h-4 w-4 text-accent-yellow" />
                Keep it scoped
              </div>
              <p className="text-[12px] leading-5 text-theme-muted">
                Pick one concrete {taskType === 'bug' ? 'bug' : 'feature'} for the first run.
              </p>
            </div>
          </div>

          {selectedRepo && (
            <div className="onboarding-card onboarding-soft-enter rounded-md border border-app bg-app-card p-3">
              <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-theme-primary">
                <GitBranch className="h-4 w-4 text-accent" />
                {selectedRepo.name ?? 'Repository'}
              </div>
              <p className="line-clamp-2 font-mono text-[11.5px] leading-5 text-theme-muted [overflow-wrap:anywhere]">{selectedRepo.path}</p>
              {selectedRepoIsDefault && (
                <div className="mt-2 rounded-md border border-app bg-app-muted p-2.5">
                  <a
                    href={DEFAULT_ONBOARDING_REPO.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-accent hover:underline"
                  >
                    View test repo
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </div>
              )}
              {selectedRepo.detected && (
                <p className="mt-3 text-[12px] leading-5 text-theme-muted">
                  {[...(selectedRepo.detected.language ?? []), ...(selectedRepo.detected.framework ?? [])]
                    .filter(Boolean)
                    .join(', ') || selectedRepo.detected.packageManager || 'Metadata detected'}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    >
      <div className="space-y-4">
        {loading ? (
          <div className="onboarding-card onboarding-panel-enter rounded-md border border-app bg-app-card p-6 shadow-sm">
            <div className="flex min-h-[16rem] items-center justify-center text-[13px] text-theme-muted">
              <Loader2 className="mr-2 h-4 w-4 animate-spin text-accent" />
              {defaultRepoLoading ? 'Preparing default test repository...' : 'Loading starter workflows...'}
            </div>
          </div>
        ) : repoList.length === 0 ? (
          <div className="onboarding-card onboarding-panel-enter rounded-md border border-app bg-app-card p-4 shadow-sm sm:p-5">
            <div className="grid h-9 w-9 place-items-center rounded-full border border-accent-yellow/25 bg-accent-yellow/10 text-accent-yellow">
              <GitBranch className="h-4 w-4" />
            </div>
            <h2 className="mt-4 text-[22px] font-semibold text-theme-primary">Connect a repository first</h2>
            <p className="mt-1 text-[13px] leading-5 text-theme-muted">
              A workflow needs a registered repo before it can create workspaces or scan code.
            </p>
            {error && (
              <div className="mt-4 rounded-md border border-accent-red/30 bg-accent-red/10 px-3 py-2 text-[12px] text-accent-red">
                {error}
              </div>
            )}
            <button type="button" onClick={() => navigate('/onboarding/repository', { replace: true })} className="onboarding-control btn-primary mt-5 w-full justify-center sm:w-auto">
              <ArrowRight className="h-4 w-4" />
              Connect repository
            </button>
          </div>
        ) : (
          <div className="onboarding-card onboarding-panel-enter rounded-md border border-app bg-app-card p-4 shadow-sm sm:p-5">
            <div className="mb-4">
              <h2 className="text-[21px] font-semibold text-theme-primary">Launch workflow</h2>
              <p className="mt-1 text-[13px] leading-5 text-theme-muted">
                Choose a small task and tell Allen what to change.
              </p>
            </div>

            <div className="onboarding-card mb-4 rounded-md border border-app bg-app-muted p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 gap-3">
                  <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-accent/25 bg-accent-soft text-accent">
                    {taskType === 'bug' ? <Bug className="h-4 w-4" /> : <Blocks className="h-4 w-4" />}
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-[13px] font-semibold text-theme-primary">{taskConfig.title}</h3>
                    <p className="mt-1 text-[12px] leading-5 text-theme-muted">{taskConfig.description}</p>
                  </div>
                </div>
                <span className={selectedWorkflow ? 'badge badge-ok' : 'badge badge-err'}>
                  {selectedWorkflow ? 'available' : 'missing'}
                </span>
              </div>
            </div>

            <div className="mb-4">
              <div className="mb-1.5 font-mono text-[11px] font-medium lowercase text-theme-muted">task type</div>
              <div className="grid grid-cols-2 gap-2">
                {(['bug', 'feature'] as TaskType[]).map(type => {
                  const active = taskType === type;
                  const Icon = type === 'bug' ? Bug : Blocks;
                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => setTaskType(type)}
                      className={`onboarding-control flex h-[52px] items-center justify-between rounded-md border px-3 text-left ${
                        active
                          ? 'border-accent/30 bg-accent-soft text-theme-primary'
                          : 'border-app bg-app-muted text-theme-muted hover:border-accent/20 hover:text-theme-primary'
                      }`}
                    >
                      <span className="inline-flex min-w-0 items-center gap-2">
                        <Icon className={active ? 'h-4 w-4 text-accent' : 'h-4 w-4 text-theme-subtle'} />
                        <span className="truncate text-[13px] font-medium">{ONBOARDING_WORKFLOWS[type].label}</span>
                      </span>
                      {active && <Check className="h-3.5 w-3.5 shrink-0 text-accent" />}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-3">
              <div className="space-y-1.5">
                <label id="workflow-repo-label" className="block font-mono text-[11px] font-medium lowercase text-theme-muted">
                  repository
                </label>
                <div
                  className="relative"
                  onBlur={event => {
                    const nextTarget = event.relatedTarget;
                    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
                    setRepoMenuOpen(false);
                  }}
                >
                  <button
                    type="button"
                    aria-labelledby="workflow-repo-label"
                    aria-haspopup="listbox"
                    aria-expanded={repoMenuOpen}
                    onClick={() => setRepoMenuOpen(open => !open)}
                    className="onboarding-control flex min-h-12 w-full items-center justify-between gap-3 rounded-md border border-app bg-app-muted px-3 py-2 text-left text-theme-primary outline-none hover:border-accent/20 focus:border-accent focus:shadow-[var(--focus-ring)]"
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-app bg-app-card text-accent">
                        <FolderGit2 className="h-3.5 w-3.5" />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-medium text-theme-primary">
                          {selectedRepo?.name ?? 'Select repository'}
                        </span>
                        {selectedRepo && (
                          <span className="block truncate font-mono text-[10.5px] text-theme-subtle">
                            {selectedRepo.path}
                          </span>
                        )}
                      </span>
                    </span>
                    <ChevronDown className={`h-4 w-4 shrink-0 text-theme-subtle transition-transform ${repoMenuOpen ? 'rotate-180' : ''}`} />
                  </button>

                  {repoMenuOpen && (
                    <div
                      role="listbox"
                      aria-labelledby="workflow-repo-label"
                      className="onboarding-popover shadow-popover absolute left-0 right-0 top-[calc(100%+6px)] z-20 overflow-hidden rounded-md border border-app bg-app-card"
                    >
                      <div className="max-h-56 overflow-y-auto p-1.5">
                        {repoList.map(repo => {
                          const selected = repo.path === selectedRepoPath;
                          return (
                            <button
                              key={repo._id ?? repo.path}
                              type="button"
                              role="option"
                              aria-selected={selected}
                              onClick={() => {
                                setSelectedRepoPath(repo.path);
                                setRepoMenuOpen(false);
                              }}
                              className={`onboarding-control flex w-full items-center gap-3 rounded-md px-2 py-2 text-left ${
                                selected ? 'bg-accent-soft text-accent' : 'text-theme-secondary hover:bg-app-muted hover:text-theme-primary'
                              }`}
                            >
                              <FolderGit2 className="h-4 w-4 shrink-0" />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[12.5px] font-medium">{repo.name ?? repo.path}</span>
                                <span className="block truncate font-mono text-[10.5px] opacity-75">{repo.path}</span>
                              </span>
                              {selected && <Check className="h-4 w-4 shrink-0" />}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {!providersHealthy && (
                <div className="onboarding-soft-enter rounded-md border border-accent-yellow/30 bg-accent-yellow/10 px-3 py-2 text-[12px] leading-5 text-accent-yellow">
                  No LLM provider is ready. Authenticate Claude Code or Codex, then refresh.
                </div>
              )}

              <div className="space-y-1.5">
                <label htmlFor="workflow-prompt" className="block font-mono text-[11px] font-medium lowercase text-theme-muted">
                  {taskConfig.inputLabel.toLowerCase()}
                </label>
                <textarea
                  id="workflow-prompt"
                  value={prompt}
                  onChange={event => setPrompt(event.target.value)}
                  placeholder={taskConfig.placeholder}
                  rows={7}
                  className="onboarding-control min-h-[128px] w-full resize-y rounded-md border border-app bg-app-muted px-3 py-2 text-[13px] leading-5 text-theme-primary outline-none placeholder:text-theme-subtle focus:border-accent focus:shadow-[var(--focus-ring)]"
                />
                {promptLooksLikeRepoPath && (
                  <p className="onboarding-soft-enter text-[12px] leading-5 text-accent-yellow">
                    Enter the {taskType === 'bug' ? 'bug description' : 'feature request'} here, not the repository path.
                  </p>
                )}
              </div>

              {error && (
                <div className="onboarding-soft-enter rounded-md border border-accent-red/30 bg-accent-red/10 px-3 py-2 text-[12px] text-accent-red">
                  {error}
                </div>
              )}

              <div className="flex flex-col-reverse gap-3 border-t border-app pt-4 sm:flex-row sm:items-center sm:justify-end">
                <button type="button" onClick={launch} disabled={!canLaunch} className="onboarding-control btn-primary justify-center">
                  {launching ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                  {launching ? 'Starting...' : taskConfig.startLabel}
                </button>
              </div>
            </div>
          </div>
        )}

        {!loading && (
          <div className="onboarding-soft-enter border-t border-app pt-4">
            <button type="button" onClick={skipOnboarding} className="onboarding-control btn-ghost w-full justify-center">
              Skip for now
            </button>
          </div>
        )}
      </div>
    </OnboardingShell>
  );
}
