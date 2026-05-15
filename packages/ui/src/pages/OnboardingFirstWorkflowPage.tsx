import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bot,
  CheckCircle2,
  GitBranch,
  Loader2,
  Wrench,
} from 'lucide-react';
import { chat, executions, repos, system, workflows } from '../services/api';
import { BRAND_NAME } from '../lib/brand';
import { useOnboardingGate } from '../hooks/useOnboardingGate';

type ProviderId = 'claude-cli' | 'codex';

interface RepoRecord {
  _id?: string;
  id?: string;
  name?: string;
  path: string;
  detected?: {
    language?: string[];
    framework?: string[];
    packageManager?: string;
    defaultBranch?: string;
  };
}

interface WorkflowRecord {
  _id: string;
  name: string;
  description?: string;
}

interface ProviderRecord {
  provider: ProviderId;
  label: string;
  defaultModel?: string;
}

interface HealthCheck {
  id: string;
  status: 'pass' | 'warn' | 'fail';
}

const BUG_FIX_WORKFLOW = {
  name: 'bug-fix-by-severity',
  inputKey: 'bug_report',
  defaultPrompt: '',
};

function providerHealth(provider: ProviderId, checks: HealthCheck[]): 'pass' | 'warn' | 'fail' {
  const cliId = provider === 'claude-cli' ? 'claude_cli' : 'codex_cli';
  const authId = provider === 'claude-cli' ? 'claude_auth' : 'codex_auth';
  const relevant = checks.filter(check => check.id === cliId || check.id === authId);
  if (relevant.some(check => check.status === 'fail')) return 'fail';
  if (relevant.some(check => check.status === 'warn') || relevant.length < 2) return 'warn';
  return 'pass';
}

function statusBadge(status: 'pass' | 'warn' | 'fail'): string {
  if (status === 'pass') return 'badge badge-ok';
  if (status === 'warn') return 'badge badge-warn';
  return 'badge badge-err';
}

export default function OnboardingFirstWorkflowPage() {
  const navigate = useNavigate();
  const checkingOnboarding = useOnboardingGate('first_workflow');
  const [repoList, setRepoList] = useState<RepoRecord[]>([]);
  const [workflowList, setWorkflowList] = useState<WorkflowRecord[]>([]);
  const [providerList, setProviderList] = useState<ProviderRecord[]>([]);
  const [healthChecks, setHealthChecks] = useState<HealthCheck[]>([]);
  const [selectedRepoPath, setSelectedRepoPath] = useState('');
  const [selectedProvider, setSelectedProvider] = useState<ProviderId>('codex');
  const [prompt, setPrompt] = useState(BUG_FIX_WORKFLOW.defaultPrompt);
  const [loading, setLoading] = useState(true);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (checkingOnboarding) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([
      repos.list(),
      workflows.ensureDefaults([BUG_FIX_WORKFLOW.name])
        .then(() => workflows.list()),
      chat.providers(),
      system.health().catch(() => null),
    ])
      .then(([loadedRepos, loadedWorkflows, loadedProviders, health]) => {
        if (cancelled) return;
        const typedRepos = loadedRepos as RepoRecord[];
        const typedProviders = (loadedProviders as ProviderRecord[])
          .filter(provider => provider.provider === 'claude-cli' || provider.provider === 'codex');
        const checks = health?.checks ?? [];
        const preferredProvider = typedProviders.find(provider => providerHealth(provider.provider, checks) === 'pass')
          ?? typedProviders.find(provider => providerHealth(provider.provider, checks) !== 'fail')
          ?? typedProviders[0];
        setRepoList(typedRepos);
        setWorkflowList(loadedWorkflows as WorkflowRecord[]);
        setProviderList(typedProviders);
        setHealthChecks(checks);
        setSelectedRepoPath(current => current || typedRepos[0]?.path || '');
        setSelectedProvider(current => typedProviders.some(provider => provider.provider === current)
          && providerHealth(current, checks) !== 'fail'
          ? current
          : preferredProvider?.provider ?? current);
      })
      .catch(err => setError((err as Error).message || 'Could not load onboarding data'))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [checkingOnboarding]);

  const selectedRepo = useMemo(
    () => repoList.find(repo => repo.path === selectedRepoPath) ?? null,
    [repoList, selectedRepoPath],
  );

  const selectedWorkflow = useMemo(
    () => workflowList.find(workflow => workflow.name === BUG_FIX_WORKFLOW.name) ?? null,
    [workflowList],
  );

  const selectedProviderHealth = providerHealth(selectedProvider, healthChecks);
  const canLaunch = !!selectedRepo && !!selectedWorkflow && !!prompt.trim() && selectedProviderHealth !== 'fail' && !launching;

  async function launch() {
    if (!selectedRepo || !selectedWorkflow) return;
    setLaunching(true);
    setError(null);
    try {
      const input: Record<string, unknown> = {
        [BUG_FIX_WORKFLOW.inputKey]: prompt.trim(),
        repo_path: selectedRepo.path,
        related_pr: '',
      };

      const execution = await executions.start(selectedWorkflow._id, input, { agentProvider: selectedProvider });
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
                <h1 className="mt-2 font-heading text-3xl text-theme-primary">Ask Allen for a small bug fix</h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-theme-secondary">
                  Describe one small issue in the connected repo. Allen will create a workspace, investigate, and take you to the live execution trace.
                </p>
              </div>
            </div>

            {loading ? (
              <div className="card flex min-h-[22rem] items-center justify-center p-6 text-theme-muted">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading starter workflows...
              </div>
            ) : repoList.length === 0 ? (
              <div className="card p-6">
                <GitBranch className="h-6 w-6 text-accent-yellow" />
                <h2 className="mt-3 font-heading text-xl text-theme-primary">Connect a repository first</h2>
                <p className="mt-2 text-sm leading-6 text-theme-secondary">
                  A workflow needs a registered repo path before it can create workspaces or scan code.
                </p>
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
                        <h2 className="text-sm font-semibold text-theme-primary">Small bug fix</h2>
                        <p className="mt-1 text-xs leading-5 text-theme-secondary">
                          Use a focused issue that Allen can investigate and fix in one isolated workspace.
                        </p>
                      </div>
                    </div>
                    <span className={selectedWorkflow ? 'badge badge-ok' : 'badge badge-err'}>
                      {selectedWorkflow ? 'available' : 'missing'}
                    </span>
                  </div>
                </div>

                <div className="card p-5">
                  <div className="grid gap-4 md:grid-cols-2">
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
                    <div className="space-y-2">
                      <label className="block overline text-theme-muted">Runner</label>
                      <div className="grid grid-cols-2 gap-2">
                        {providerList.map(provider => {
                          const health = providerHealth(provider.provider, healthChecks);
                          const active = selectedProvider === provider.provider;
                          return (
                            <button
                              key={provider.provider}
                              type="button"
                              onClick={() => setSelectedProvider(provider.provider)}
                              disabled={health === 'fail'}
                              className={`rounded-md border px-3 py-2 text-left text-xs transition-colors ${active ? 'border-accent-blue bg-accent-blue/10 text-theme-primary' : 'border-app bg-surface-100 text-theme-secondary hover:bg-surface-200'} disabled:cursor-not-allowed disabled:opacity-60`}
                            >
                              <span className="flex items-center justify-between gap-2">
                                <span className="inline-flex items-center gap-2">
                                  <Bot className="h-4 w-4" />
                                  {provider.label}
                                </span>
                                <span className={statusBadge(health)}>{health}</span>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 space-y-2">
                    <label className="block overline text-theme-muted">Small bug fix</label>
                    <textarea
                      value={prompt}
                      onChange={event => setPrompt(event.target.value)}
                      placeholder="Example: The repo's test command is failing on a clean checkout. Please reproduce it, find the root cause, and make the smallest safe fix."
                      rows={7}
                      className="input w-full resize-y leading-6"
                    />
                  </div>

                  {error && (
                    <div className="mt-4 rounded-md border border-accent-red/30 bg-accent-red/10 px-3 py-2 text-xs text-accent-red">
                      {error}
                    </div>
                  )}

                  <div className="mt-5 flex flex-wrap items-center gap-3">
                    <button type="button" onClick={launch} disabled={!canLaunch} className="btn-primary inline-flex items-center gap-2">
                      {launching ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                      {launching ? 'Starting...' : 'Start bug fix'}
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
                Allen starts the bug-fix workflow, streams progress to the execution page, and stores artifacts from agent work under the run.
              </p>
            </div>

            <div className="card p-5">
              <AlertTriangle className="mb-3 h-5 w-5 text-accent-yellow" />
              <h2 className="font-heading text-base text-theme-primary">Keep it scoped</h2>
              <p className="mt-2 text-xs leading-5 text-theme-secondary">
                Pick a small, concrete bug with an observable symptom. Avoid broad rewrites or multi-feature requests during onboarding.
              </p>
            </div>

            {selectedRepo && (
              <div className="card p-5">
                <GitBranch className="mb-3 h-5 w-5 text-accent-blue" />
                <h2 className="font-heading text-base text-theme-primary">{selectedRepo.name ?? 'Repository'}</h2>
                <p className="mt-2 break-all font-mono text-xs leading-5 text-theme-muted">{selectedRepo.path}</p>
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
