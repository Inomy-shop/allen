import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  GitBranch,
  Loader2,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { executions, repos, system, workflows } from '../services/api';
import { BRAND_NAME } from '../lib/brand';
import { useOnboardingGate } from '../hooks/useOnboardingGate';
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
      <div className="flex min-h-screen items-center justify-center bg-surface-50 text-sm text-theme-muted">
        <Loader2 className="mr-2 h-4 w-4 animate-spin text-accent-blue" />
        Loading onboarding
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface-50 p-4">
      <div className="mx-auto flex min-h-screen w-full max-w-6xl items-center py-8">
        <div className="grid w-full gap-5 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
          <section className="space-y-5">
            <div className="space-y-3">
              <div className="flex items-center gap-2.5">
                <Activity className="h-6 w-6 text-accent-blue" />
                <span className="font-heading text-lg font-bold uppercase tracking-widest text-theme-primary">
                  {BRAND_NAME}
                </span>
              </div>
              <div>
                <p className="overline text-theme-muted">First workflow</p>
                <h1 className="mt-2 font-heading text-3xl text-theme-primary">Ask Allen to change a repo</h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-theme-secondary">
                  Pick a task type and describe the change. Allen will pass the selected repo internally, create a workspace, and take you to the live execution trace.
                </p>
              </div>
            </div>

            {loading ? (
              <div className="card flex min-h-[22rem] items-center justify-center p-6 text-theme-muted">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {defaultRepoLoading ? 'Preparing default test repository...' : 'Loading starter workflows...'}
              </div>
            ) : repoList.length === 0 ? (
              <div className="card p-6">
                <GitBranch className="h-6 w-6 text-accent-yellow" />
                <h2 className="mt-3 font-heading text-xl text-theme-primary">Connect a repository first</h2>
                <p className="mt-2 text-sm leading-6 text-theme-secondary">
                  A workflow needs a registered repo path before it can create workspaces or scan code.
                </p>
                {error && (
                  <div className="mt-4 rounded-md border border-accent-red/30 bg-accent-red/10 px-3 py-2 text-xs text-accent-red">
                    {error}
                  </div>
                )}
                <button type="button" onClick={() => navigate('/onboarding/repository', { replace: true })} className="btn-primary mt-5 inline-flex items-center gap-2">
                  <ArrowRight className="h-4 w-4" />
                  Connect repository
                </button>
              </div>
            ) : (
              <div className="space-y-5">
                <div className="rounded-md border border-accent-blue bg-accent-blue/10 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 gap-3">
                      <Wrench className="mt-0.5 h-5 w-5 text-accent-blue" />
                      <div>
                        <h2 className="text-sm font-semibold text-theme-primary">{taskConfig.title}</h2>
                        <p className="mt-1 text-xs leading-5 text-theme-secondary">
                          {taskConfig.description}
                        </p>
                      </div>
                    </div>
                    <span className={selectedWorkflow ? 'badge badge-ok' : 'badge badge-err'}>
                      {selectedWorkflow ? 'available' : 'missing'}
                    </span>
                  </div>
                </div>

                <div className="card p-5">
                  <div className="mb-4 grid grid-cols-2 gap-2 rounded-md bg-surface-50 p-1">
                    {(['bug', 'feature'] as TaskType[]).map(type => {
                      const active = taskType === type;
                      const Icon = type === 'bug' ? Wrench : Sparkles;
                      return (
                        <button
                          key={type}
                          type="button"
                          onClick={() => setTaskType(type)}
                          className={`rounded px-3 py-2 text-sm ${active ? 'bg-surface-100 text-theme-primary shadow-sm' : 'text-theme-muted'}`}
                        >
                          <span className="inline-flex items-center gap-2">
                            <Icon className="h-4 w-4" />
                            {ONBOARDING_WORKFLOWS[type].label}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  <div className="space-y-2">
                    <label className="block overline text-theme-muted">Repository</label>
                    <select value={selectedRepoPath} onChange={event => setSelectedRepoPath(event.target.value)} className="input w-full">
                      {repoList.map(repo => (
                        <option key={repo._id ?? repo.path} value={repo.path}>
                          {repo.name ?? repo.path}
                        </option>
                      ))}
                    </select>
                  </div>
                  {!providersHealthy && (
                    <div className="mt-4 rounded-md border border-accent-yellow/30 bg-accent-yellow/10 px-3 py-2 text-xs text-accent-yellow">
                      No LLM provider is ready. Authenticate Claude Code or Codex (whichever you picked at setup) and refresh.
                    </div>
                  )}

                  <div className="mt-4 space-y-2">
                    <label className="block overline text-theme-muted">{taskConfig.inputLabel}</label>
                    <textarea
                      value={prompt}
                      onChange={event => setPrompt(event.target.value)}
                      placeholder={taskConfig.placeholder}
                      rows={7}
                      className="input w-full resize-y leading-6"
                    />
                    {promptLooksLikeRepoPath && (
                      <p className="text-xs leading-5 text-accent-yellow">
                        Enter the {taskType === 'bug' ? 'bug description' : 'feature request'} here, not the repository path. The selected repo is already passed separately.
                      </p>
                    )}
                  </div>

                  {error && (
                    <div className="mt-4 rounded-md border border-accent-red/30 bg-accent-red/10 px-3 py-2 text-xs text-accent-red">
                      {error}
                    </div>
                  )}

                  <div className="mt-5 flex flex-wrap items-center gap-3">
                    <button type="button" onClick={launch} disabled={!canLaunch} className="btn-primary inline-flex items-center gap-2">
                      {launching ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                      {launching ? 'Starting...' : taskConfig.startLabel}
                    </button>
                    <button type="button" onClick={skipOnboarding} className="btn-ghost">
                      Skip for now
                    </button>
                  </div>
                </div>
              </div>
            )}
          </section>

          <aside className="space-y-4">
            <div className="card p-5">
              <CheckCircle2 className="mb-3 h-5 w-5 text-accent-green" />
              <h2 className="font-heading text-base text-theme-primary">What happens next</h2>
              <p className="mt-2 text-xs leading-5 text-theme-secondary">
                Allen starts the selected workflow, streams progress to the execution page, and stores artifacts from agent work under the run.
              </p>
            </div>

            <div className="card p-5">
              <AlertTriangle className="mb-3 h-5 w-5 text-accent-yellow" />
              <h2 className="font-heading text-base text-theme-primary">Keep it scoped</h2>
              <p className="mt-2 text-xs leading-5 text-theme-secondary">
                Pick a small, concrete {taskType === 'bug' ? 'bug with an observable symptom' : 'feature with clear expected behavior'}. Avoid broad rewrites or multi-feature requests during onboarding.
              </p>
            </div>

            {selectedRepo && (
              <div className="card p-5">
                <GitBranch className="mb-3 h-5 w-5 text-accent-blue" />
                <h2 className="font-heading text-base text-theme-primary">{selectedRepo.name ?? 'Repository'}</h2>
                <p className="mt-2 break-all font-mono text-xs leading-5 text-theme-muted">{selectedRepo.path}</p>
                {selectedRepoIsDefault && (
                  <div className="mt-4 rounded-md border border-accent-blue/30 bg-accent-blue/10 p-3">
                    <p className="text-xs leading-5 text-theme-secondary">
                      This is Allen's default test repo for users who do not want to connect their own code. It is a small static website with a readiness widget and fast tests.
                    </p>
                    <a
                      href={DEFAULT_ONBOARDING_REPO.url}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-accent-blue hover:underline"
                    >
                      View test repo
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  </div>
                )}
                {selectedRepo.detected && (
                  <p className="mt-3 text-xs leading-5 text-theme-secondary">
                    {[...(selectedRepo.detected.language ?? []), ...(selectedRepo.detected.framework ?? [])]
                      .filter(Boolean)
                      .join(', ') || selectedRepo.detected.packageManager || 'Metadata detected'}
                  </p>
                )}
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
