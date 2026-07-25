import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowRight,
  Blocks,
  Bug,
  Loader2,
} from 'lucide-react';
import { executions, repos, system, workflows } from '../services/api';
import { useOnboardingGate } from '../hooks/useOnboardingGate';
import { OnboardingShell } from '../components/onboarding/OnboardingShell';
import { useAuthStore } from '../stores/authStore';
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
type ModelMode = 'mix' | 'one';
type Provider = 'claude' | 'codex';

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
  copy: string;
  inputLabel: string;
  hint: string;
  startLabel: string;
  defaultPrompt: string;
}> = {
  bug: {
    name: 'bug-fix-by-severity',
    label: 'Fix a bug',
    copy: 'Runs bug-fix-by-severity — classify, fix, test, open a PR.',
    inputLabel: 'bug description',
    hint: 'Describe observed behavior, expected behavior, and repro steps. A small, focused ask gives the best first run.',
    startLabel: 'Start bug fix',
    defaultPrompt: DEFAULT_ONBOARDING_BUG_REPORT,
  },
  feature: {
    name: 'feature-plan-and-implement',
    label: 'Build a feature',
    copy: 'Runs feature-plan-and-implement — plan, build, test, review.',
    inputLabel: 'feature request',
    hint: 'Describe what should be built, who it is for, and any constraints. Keep the first one small.',
    startLabel: 'Start feature build',
    defaultPrompt: DEFAULT_ONBOARDING_FEATURE_REQUEST,
  },
};

const MODELS: Record<Provider, Array<{ value: string; label: string }>> = {
  claude: [
    { value: 'fable', label: 'Fable 5 — deep coding & long runs' },
    { value: 'opus', label: 'Opus 4.8 — strongest reviews' },
    { value: 'sonnet', label: 'Sonnet 4.6 — fast & balanced' },
    { value: 'haiku', label: 'Haiku 4.5 — quick, low cost' },
  ],
  codex: [
    { value: 'gpt-5.5', label: 'GPT-5.5 — deep coding & long runs' },
    { value: 'gpt-5.4', label: 'GPT-5.4 — strong general coding' },
    { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex — agent coding work' },
  ],
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

function providerReady(checks: HealthCheck[], provider: Provider): boolean {
  const checkOk = (id: string) => checks.some(check => check.id === id && check.status !== 'fail');
  return checkOk(`${provider}_cli`) && checkOk(`${provider}_auth`);
}

export default function OnboardingFirstWorkflowPage() {
  const navigate = useNavigate();
  const email = useAuthStore(state => state.user?.email);
  const checkingOnboarding = useOnboardingGate('first_workflow');
  const [repoList, setRepoList] = useState<RepoRecord[]>([]);
  const [workflowList, setWorkflowList] = useState<WorkflowRecord[]>([]);
  const [healthChecks, setHealthChecks] = useState<HealthCheck[]>([]);
  const [selectedRepoPath, setSelectedRepoPath] = useState('');
  const [taskType, setTaskType] = useState<TaskType>('bug');
  const [prompt, setPrompt] = useState('');
  const [modelMode, setModelMode] = useState<ModelMode>('mix');
  const [provider, setProvider] = useState<Provider>('claude');
  const [model, setModel] = useState(MODELS.claude[0].value);
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
      if ((loadedRepos as RepoRecord[]).length > 0) return { loadedRepos, loadedWorkflows, health };
      if (!cancelled) setDefaultRepoLoading(true);
      const defaultRepo = await createDefaultOnboardingRepo();
      return { loadedRepos: [defaultRepo], loadedWorkflows, health };
    }

    loadOnboardingData()
      .then(({ loadedRepos, loadedWorkflows, health }) => {
        if (cancelled) return;
        const typedRepos = loadedRepos as RepoRecord[];
        const checks = health?.checks ?? [];
        const claudeReady = providerReady(checks, 'claude');
        const codexReady = providerReady(checks, 'codex');
        setRepoList(typedRepos);
        setWorkflowList(loadedWorkflows as WorkflowRecord[]);
        setHealthChecks(checks);
        setSelectedRepoPath(typedRepos[0]?.path ?? '');
        if (!claudeReady && codexReady) {
          setProvider('codex');
          setModel(MODELS.codex[0].value);
          setModelMode('one');
        } else if (!(claudeReady && codexReady)) {
          setModelMode('one');
        }
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
    () => repoList.find(repo => repo.path === selectedRepoPath) ?? repoList[0] ?? null,
    [repoList, selectedRepoPath],
  );
  const selectedRepoIsDefault = isDefaultOnboardingRepo(selectedRepo);
  const selectedWorkflow = useMemo(
    () => workflowList.find(workflow => workflow.name === ONBOARDING_WORKFLOWS[taskType].name) ?? null,
    [taskType, workflowList],
  );
  const taskConfig = ONBOARDING_WORKFLOWS[taskType];
  const claudeReady = providerReady(healthChecks, 'claude');
  const codexReady = providerReady(healthChecks, 'codex');
  const providersHealthy = claudeReady || codexReady;
  const selectedProviderReady = provider === 'claude' ? claudeReady : codexReady;
  const promptLooksLikeRepoPath = Boolean(selectedRepo && prompt.trim() === selectedRepo.path);
  const canLaunch = Boolean(
    selectedRepo
    && selectedWorkflow
    && prompt.trim()
    && !promptLooksLikeRepoPath
    && providersHealthy
    && (modelMode === 'mix' || selectedProviderReady)
    && !launching,
  );
  const isDesktop = typeof window !== 'undefined' && Boolean(window.allenDesktop);

  useEffect(() => {
    setPrompt(current => {
      const anyDefault = Object.values(ONBOARDING_WORKFLOWS).some(workflow => workflow.defaultPrompt === current);
      if (selectedRepoIsDefault && (!current.trim() || anyDefault)) return taskConfig.defaultPrompt;
      if (!selectedRepoIsDefault && anyDefault) return '';
      return current;
    });
  }, [selectedRepoIsDefault, taskConfig.defaultPrompt]);

  async function launch() {
    if (!selectedRepo || !selectedWorkflow) return;
    setLaunching(true);
    setError(null);
    try {
      if (isDesktop) {
        const defaultProvider: Provider = codexReady ? 'codex' : 'claude';
        await system.saveDesktopOnboardingModelDefaults({
          chatProvider: modelMode === 'one' ? provider : defaultProvider,
          agentProvider: modelMode === 'one' ? provider : '',
          agentModel: modelMode === 'one' ? model : '',
        });
      }
      const input = buildOnboardingWorkflowInput(selectedWorkflow, {
        taskType,
        request: prompt,
        repoPath: selectedRepo.path,
      });
      const execution = await executions.start(selectedWorkflow._id, input);
      await system.updateOnboardingProgress({ action: 'complete' }).catch(() => {});
      const launchParams = new URLSearchParams({
        execution: execution.id,
        workflow: selectedWorkflow.name,
        repo: selectedRepo.name ?? 'test-website',
        source: selectedRepoIsDefault ? 'demo' : 'connected',
      });
      navigate(`/onboarding/launch?${launchParams.toString()}`, { replace: true });
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
      <div className="ob-loading">
        <Loader2 className="animate-spin" />
        Loading onboarding
      </div>
    );
  }

  return (
    <OnboardingShell
      step="first_workflow"
      eyebrow="first run"
      title="Describe a small change. Agents do the rest."
      description="Allen creates a workspace, runs the workflow, and takes you to the live execution trace. You approve anything before it merges."
      runtimeLabel={isDesktop ? 'desktop runtime' : 'web setup'}
      stepCopy={{
        account: email ?? 'elena@company.com',
        health: '6 checks passed',
        repository: selectedRepo ? `${selectedRepo.name ?? 'Repository'} · ${selectedRepoIsDefault ? 'demo' : 'connected'}` : 'Demo repo or your own',
      }}
    >
      {loading ? (
        <section className="ob-card ob-loading-card">
          <Loader2 className="animate-spin" />
          {defaultRepoLoading ? 'Preparing default test repository…' : 'Loading starter workflows…'}
        </section>
      ) : !selectedRepo ? (
        <section className="ob-card">
          <h2>Connect a repository first</h2>
          <p className="sub">A workflow needs a registered repository before it can create a workspace.</p>
          <div className="ob-actions">
            <span className="sp" />
            <button type="button" className="ob-action-primary" onClick={() => navigate('/onboarding/repository')}>
              Connect repository <ArrowRight />
            </button>
          </div>
        </section>
      ) : (
        <section className="ob-card">
          <div className="ob-card__head">
            <div>
              <h2>Start your first workflow</h2>
              <p className="sub">
                Pick a focused task and tell Allen what to change in <b>{selectedRepo.name ?? 'your repository'}</b>.
              </p>
            </div>
          </div>

          <div className="ob-tasks" role="radiogroup" aria-label="Task type">
            {(['bug', 'feature'] as TaskType[]).map(type => {
              const Icon = type === 'bug' ? Bug : Blocks;
              const config = ONBOARDING_WORKFLOWS[type];
              return (
                <button
                  key={type}
                  type="button"
                  role="radio"
                  aria-checked={taskType === type}
                  className={`ob-task ${taskType === type ? 'on' : ''}`}
                  onClick={() => setTaskType(type)}
                >
                  <span className="gl"><Icon /></span>
                  <span className="tt">{config.label}</span>{' '}
                  <span className="sb">
                    Runs <span className="mono-copy">{config.name}</span>
                    {type === 'bug' ? ' — classify, fix, test, open a PR.' : ' — plan, build, test, review.'}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="ob-f">
            <label htmlFor="workflow-prompt">{taskConfig.inputLabel}</label>
            <textarea
              id="workflow-prompt"
              className="ob-in"
              rows={5}
              value={prompt}
              onChange={event => setPrompt(event.target.value)}
            />
            <p className={`ob-hint ${promptLooksLikeRepoPath ? 'err' : ''}`}>
              {promptLooksLikeRepoPath ? `Enter the ${taskConfig.inputLabel}, not the repository path.` : taskConfig.hint}
            </p>
          </div>

          <div className="ob-f">
            <label>models for this instance</label>
            <div className="ob-provs">
              <span className={`ob-prov ${claudeReady ? 'is-pass' : 'is-warn'}`}>
                <i /> Claude <span className="m">{claudeReady ? 'ready' : 'needs login'}</span>
              </span>
              <span className={`ob-prov ${codexReady ? 'is-pass' : 'is-warn'}`}>
                <i /> Codex <span className="m">{codexReady ? 'ready' : 'needs login'}</span>
              </span>
            </div>
            <div className="ob-radio" role="radiogroup" aria-label="Model defaults">
              <button
                type="button"
                role="radio"
                aria-checked={modelMode === 'mix'}
                disabled={!(claudeReady && codexReady)}
                className={`ob-rrow ${modelMode === 'mix' ? 'on' : ''}`}
                onClick={() => setModelMode('mix')}
              >
                <span className="pick" />
                <span>
                  <span className="tt">Recommended mix</span>{' '}
                  <span className="sb">Each built-in agent uses the provider and model tuned for its role. Best results; you can change any of it later in Settings.</span>
                </span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={modelMode === 'one'}
                className={`ob-rrow ob-rrow--expandable ${modelMode === 'one' ? 'on' : ''}`}
                onClick={() => setModelMode('one')}
              >
                <span className="pick" />
                <span>
                  <span className="tt">One provider for everything</span>{' '}
                  <span className="sb">All chats, agents, and workflow templates use a single provider and model.</span>
                  <span className="ex">
                    <span className="ob-2col">
                      <select
                        className="ob-sel"
                        aria-label="Provider"
                        value={provider}
                        onChange={event => {
                          const next = event.target.value as Provider;
                          setProvider(next);
                          setModel(MODELS[next][0].value);
                        }}
                      >
                        <option value="claude" disabled={!claudeReady}>Claude</option>
                        <option value="codex" disabled={!codexReady}>Codex</option>
                      </select>
                      <select className="ob-sel" aria-label="Model" value={model} onChange={event => setModel(event.target.value)}>
                        {MODELS[provider].map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </span>
                  </span>
                </span>
              </button>
            </div>
          </div>

          {!providersHealthy && (
            <div className="ob-error">No model provider is ready. Authenticate Claude Code or Codex, then return to Environment and recheck.</div>
          )}
          {error && <div className="ob-error">{error}</div>}

          <div className="ob-actions">
            <button type="button" className="ob-back" onClick={() => navigate('/onboarding/repository')}>
              <ArrowLeft /> Back
            </button>
            <span className="sp" />
            <button type="button" className="ob-action-primary" disabled={!canLaunch} onClick={() => void launch()}>
              {launching && <Loader2 className="animate-spin" />}
              {launching ? 'Starting…' : taskConfig.startLabel}
              {!launching && <ArrowRight />}
            </button>
          </div>
        </section>
      )}

      {!loading && (
        <button type="button" onClick={skipOnboarding} className="ob-skip">
          Skip for now — start from an empty home instead
        </button>
      )}
    </OnboardingShell>
  );
}
