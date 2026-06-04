import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Circle,
  CircleDot,
  ExternalLink,
  FolderGit2,
  GitBranch,
  Github,
  Loader2,
  RefreshCw,
  ShieldCheck,
  X,
  XCircle,
} from 'lucide-react';
import { repos, system } from '../services/api';
import { useOnboardingGate } from '../hooks/useOnboardingGate';
import { DEFAULT_ONBOARDING_REPO, isDefaultOnboardingRepoUrl } from '../lib/onboarding-defaults';
import { OnboardingShell } from '../components/onboarding/OnboardingShell';

type Mode = 'local' | 'clone';
type CheckStatus = 'pass' | 'warn' | 'fail';

interface ValidationCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

interface ValidationResult {
  ok: boolean;
  source: Mode;
  name?: string;
  path?: string;
  clonePath?: string;
  cloneUrl?: string;
  sshUrl?: string;
  httpsUrl?: string;
  requiresSsh?: boolean;
  branch?: string;
  detected?: {
    language: string[];
    framework: string[];
    packageManager: string;
    defaultBranch: string;
    remoteUrl?: string;
  };
  checks: ValidationCheck[];
}

interface SshResult {
  ok: boolean;
  host: string;
  detail: string;
  fix?: { summary: string; commands?: string[]; docsPath?: string };
}

function StatusIcon({ status, className = 'h-4 w-4' }: { status: CheckStatus; className?: string }) {
  if (status === 'pass') return <CheckCircle2 className={`${className} text-accent-green`} />;
  if (status === 'warn') return <AlertTriangle className={`${className} text-accent-yellow`} />;
  return <XCircle className={`${className} text-accent-red`} />;
}

function statusLabel(status: CheckStatus): string {
  if (status === 'pass') return 'Pass';
  if (status === 'warn') return 'Warn';
  return 'Fail';
}

function statusSurfaceClass(status: CheckStatus): string {
  if (status === 'pass') return 'border-accent-green/20 bg-accent-green/10';
  if (status === 'warn') return 'border-accent-yellow/25 bg-accent-yellow/10';
  return 'border-accent-red/25 bg-accent-red/10';
}

function statusTextClass(status: CheckStatus): string {
  if (status === 'pass') return 'text-accent-green';
  if (status === 'warn') return 'text-accent-yellow';
  return 'text-accent-red';
}

function statusRowClass(status: CheckStatus): string {
  if (status === 'fail') return 'border-accent-red/25 bg-accent-red/5';
  if (status === 'warn') return 'border-accent-yellow/25 bg-accent-yellow/5';
  return 'border-app bg-app-muted';
}

function ValidationPanel({ result }: { result: ValidationResult | null }) {
  if (!result) {
    return (
      <div className="onboarding-card onboarding-soft-enter rounded-md border border-dashed border-app bg-app-card p-4 text-[13px] leading-5 text-theme-muted">
        Validate a repository to see readiness checks.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {result.checks.map((check, index) => (
          <div
            key={check.id}
            className={`onboarding-check-row rounded-md border p-3 ${statusRowClass(check.status)}`}
            style={{
              animation: 'onboarding-rise 320ms cubic-bezier(0.16, 1, 0.3, 1) both',
              animationDelay: `${index * 45}ms`,
            }}
          >
            <div className="flex items-start gap-3">
              <div className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border ${statusSurfaceClass(check.status)}`}>
                <StatusIcon status={check.status} className="h-3.5 w-3.5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-start justify-between gap-2">
                  <span className="truncate text-[12px] font-semibold text-theme-primary">{check.label}</span>
                  <span className={`font-mono text-[10.5px] font-medium ${statusTextClass(check.status)}`}>
                    {statusLabel(check.status)}
                  </span>
                </div>
                <p className="mt-1 text-[11.5px] leading-5 text-theme-muted [overflow-wrap:anywhere]">{check.detail}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SshPanel({ result, loading, onVerify }: { result: SshResult | null; loading: boolean; onVerify: () => void }) {
  return (
    <div className="onboarding-card onboarding-soft-enter rounded-md border border-app bg-app-muted p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-accent" />
            <p className="text-[13px] font-semibold text-theme-primary">GitHub SSH</p>
            {result && (
              <span className={result.ok ? 'badge badge-ok' : 'badge badge-err'}>
                {result.ok ? 'ready' : 'failed'}
              </span>
            )}
          </div>
          <p className="mt-2 text-[12px] leading-5 text-theme-muted">
            Private repositories need a working SSH key when HTTPS access is unavailable.
          </p>
        </div>
        <button type="button" onClick={onVerify} disabled={loading} className="onboarding-control btn-secondary shrink-0">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Test
        </button>
      </div>

      {result && (
        <div className="onboarding-soft-enter mt-3 rounded-md border border-app bg-app-card p-3">
          <p className="text-[12px] leading-5 text-theme-muted [overflow-wrap:anywhere]">{result.detail}</p>
          {result.fix && (
            <div className="mt-2">
              <p className="text-[12px] font-medium text-theme-primary">{result.fix.summary}</p>
              {result.fix.commands?.map(command => (
                <code key={command} className="mt-1 block overflow-x-auto rounded border border-app bg-app-muted px-2 py-1 font-mono text-[11px] text-theme-muted">
                  {command}
                </code>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function OnboardingRepositoryPage() {
  const navigate = useNavigate();
  const checkingOnboarding = useOnboardingGate('repository');
  const [mode, setMode] = useState<Mode>('clone');
  const [localPath, setLocalPath] = useState('');
  const [cloneUrl, setCloneUrl] = useState(DEFAULT_ONBOARDING_REPO.url);
  const [branch, setBranch] = useState(DEFAULT_ONBOARDING_REPO.branch);
  const [name, setName] = useState('');
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [sshResult, setSshResult] = useState<SshResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sshLoading, setSshLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationOpen, setValidationOpen] = useState(false);
  const [validationClosing, setValidationClosing] = useState(false);
  const validationCloseTimer = useRef<number | null>(null);

  useEffect(() => {
    setValidation(null);
    setError(null);
    setValidationOpen(false);
    setValidationClosing(false);
  }, [branch, cloneUrl, localPath, mode, name]);

  useEffect(() => {
    if (!validationOpen) return undefined;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') closeValidationModal();
    }
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [validationOpen, validationClosing]);

  useEffect(() => () => {
    if (validationCloseTimer.current !== null) window.clearTimeout(validationCloseTimer.current);
  }, []);

  const canConnect = useMemo(() => {
    if (!validation?.ok || saving) return false;
    if (mode === 'clone' && validation.requiresSsh !== false && !sshResult?.ok) return false;
    return true;
  }, [mode, saving, sshResult, validation]);
  const showDefaultRepoInfo = mode === 'clone' && isDefaultOnboardingRepoUrl(cloneUrl);
  const isDesktop = typeof window !== 'undefined' && Boolean(window.allenDesktop);
  const runtimeLabel = isDesktop ? 'desktop runtime' : 'web setup';
  const runtimeCopy = mode === 'clone'
    ? 'Allen can clone a starter repository or your GitHub repo into a managed workspace.'
    : 'Allen can register an existing local checkout without moving your files.';
  const bootstrapSteps: Array<{
    number: string;
    title: string;
    copy: string;
    state: 'done' | 'active' | 'next';
  }> = isDesktop
    ? [
      { number: '01', title: 'Create admin', copy: 'Admin account is ready for this instance.', state: 'done' },
      { number: '02', title: 'Verify runtime', copy: 'Required machine checks passed.', state: 'done' },
      { number: '03', title: 'Choose models', copy: 'Inbuilt workflow defaults are configured.', state: 'done' },
      { number: '04', title: 'Connect repo', copy: 'Register a checkout or clone a starter repository.', state: 'active' },
      { number: '05', title: 'Start workflow', copy: 'Launch a small bug fix or feature run.', state: 'next' },
    ]
    : [
      { number: '01', title: 'Create admin', copy: 'Admin account is ready for this instance.', state: 'done' },
      { number: '02', title: 'Verify runtime', copy: 'Required machine checks passed.', state: 'done' },
      { number: '03', title: 'Connect repo', copy: 'Register a checkout or clone a starter repository.', state: 'active' },
      { number: '04', title: 'Start workflow', copy: 'Launch a small bug fix or feature run.', state: 'next' },
    ];

  async function validate() {
    setChecking(true);
    setError(null);
    try {
      const result = mode === 'local'
        ? await repos.validateLocal(localPath)
        : await repos.validateClone({
          url: cloneUrl.trim() || DEFAULT_ONBOARDING_REPO.url,
          branch: branch.trim() || DEFAULT_ONBOARDING_REPO.branch,
          name: name.trim() || undefined,
        });
      setValidation(result);
      setValidationClosing(false);
      setValidationOpen(true);
    } catch (err) {
      setValidation(null);
      setValidationOpen(false);
      setError((err as Error).message || 'Validation failed');
    } finally {
      setChecking(false);
    }
  }

  async function verifySsh() {
    setSshLoading(true);
    setError(null);
    try {
      const result = await system.verifySsh('github.com');
      setSshResult(result);
    } catch (err) {
      setSshResult({
        ok: false,
        host: 'github.com',
        detail: (err as Error).message || 'SSH verification failed',
      });
    } finally {
      setSshLoading(false);
    }
  }

  async function connectRepo() {
    if (!validation?.ok) return;
    setSaving(true);
    setError(null);
    try {
      if (mode === 'local') {
        await repos.create({ path: localPath.trim() });
      } else {
        await repos.clone({
          url: cloneUrl.trim() || DEFAULT_ONBOARDING_REPO.url,
          branch: branch.trim() || DEFAULT_ONBOARDING_REPO.branch,
          name: name.trim() || undefined,
        });
      }
      await system.updateOnboardingProgress({ step: 'first_workflow' }).catch(() => {});
      setValidationOpen(false);
      setValidationClosing(false);
      navigate('/onboarding/first-workflow', { replace: true });
    } catch (err) {
      setError((err as Error).message || 'Could not connect repository');
    } finally {
      setSaving(false);
    }
  }

  async function skipOnboarding() {
    await system.updateOnboardingProgress({ action: 'skip' }).catch(() => {});
    navigate('/', { replace: true });
  }

  function closeValidationModal() {
    if (!validationOpen || validationClosing) return;
    setValidationClosing(true);
    if (validationCloseTimer.current !== null) window.clearTimeout(validationCloseTimer.current);
    validationCloseTimer.current = window.setTimeout(() => {
      setValidationOpen(false);
      setValidationClosing(false);
      validationCloseTimer.current = null;
    }, 190);
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
      step="repository"
      eyebrow="Repository setup"
      title="Connect your first repository"
      description="Allen works against real repositories. Connect a local checkout or clone a GitHub repository before starting the first workflow."
      runtimeLabel={runtimeLabel}
      runtimeCopy={runtimeCopy}
      side={(
        <div className="mt-8 space-y-3">
          <div className="onboarding-card rounded-md border border-app bg-app-card p-4">
            <div className="mb-4">
              <div className="font-mono text-[10.5px] text-theme-subtle">bootstrap path</div>
              <div className="mt-1 text-[13px] font-semibold text-theme-primary">Repository connection</div>
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
                    {number !== (isDesktop ? '05' : '04') && (
                      <div className={`onboarding-step-line absolute bottom-0 top-6 w-px ${
                        state === 'done' ? 'bg-accent-green/35' : 'bg-border'
                      }`} />
                    )}
                  </div>
                  <div className="pb-4">
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

          <div className="onboarding-card rounded-md border border-app bg-app-card p-4">
            <div className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-theme-primary">
              <GitBranch className="h-4 w-4 text-accent" />
              What Allen checks
            </div>
            <p className="text-[12.5px] leading-5 text-theme-muted">
              Validation confirms git access, duplicate registration, branch state, and basic project metadata before Allen stores the repo.
            </p>
          </div>
        </div>
      )}
    >
      <div className="space-y-4">
        <div className="onboarding-card onboarding-panel-enter rounded-md border border-app bg-app-card p-5 shadow-sm sm:p-6">
          <div className="mb-5">
            <h2 className="text-[22px] font-semibold text-theme-primary">Connect repository</h2>
            <p className="mt-1 text-[13px] leading-5 text-theme-muted">
              Choose a local checkout or clone from GitHub.
            </p>
          </div>

          <div className="mb-5 grid grid-cols-2 gap-1 rounded-md border border-app bg-app-muted p-1">
            <button
              type="button"
              onClick={() => setMode('local')}
              className={`onboarding-control inline-flex h-8 items-center justify-center gap-2 rounded-md px-2 text-[12px] font-medium ${
                mode === 'local' ? 'bg-app-card text-theme-primary shadow-sm' : 'text-theme-muted hover:text-theme-primary'
              }`}
            >
              <FolderGit2 className="h-4 w-4" />
              Local path
            </button>
            <button
              type="button"
              onClick={() => setMode('clone')}
              className={`onboarding-control inline-flex h-8 items-center justify-center gap-2 rounded-md px-2 text-[12px] font-medium ${
                mode === 'clone' ? 'bg-app-card text-theme-primary shadow-sm' : 'text-theme-muted hover:text-theme-primary'
              }`}
            >
              <Github className="h-4 w-4" />
              GitHub URL
            </button>
          </div>

          {mode === 'local' ? (
            <div className="onboarding-soft-enter space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="repo-local-path" className="block font-mono text-[11px] font-medium lowercase text-theme-muted">
                  repository path
                </label>
                <input
                  id="repo-local-path"
                  value={localPath}
                  onChange={event => setLocalPath(event.target.value)}
                  placeholder="/Users/you/projects/app"
                  className="onboarding-control h-10 w-full rounded-md border border-app bg-app-muted px-3 font-mono text-[13px] text-theme-primary outline-none placeholder:text-theme-subtle focus:border-accent focus:shadow-[var(--focus-ring)]"
                />
              </div>
            </div>
          ) : (
            <div className="onboarding-soft-enter space-y-4">
              {(!validation || validation.requiresSsh !== false) && (
                <SshPanel result={sshResult} loading={sshLoading} onVerify={verifySsh} />
              )}
              <div className="space-y-1.5">
                <label htmlFor="repo-clone-url" className="block font-mono text-[11px] font-medium lowercase text-theme-muted">
                  github repository url
                </label>
                <input
                  id="repo-clone-url"
                  value={cloneUrl}
                  onChange={event => setCloneUrl(event.target.value)}
                  placeholder="git@github.com:owner/repo.git"
                  className="onboarding-control h-10 w-full rounded-md border border-app bg-app-muted px-3 font-mono text-[13px] text-theme-primary outline-none placeholder:text-theme-subtle focus:border-accent focus:shadow-[var(--focus-ring)]"
                />
              </div>

              {showDefaultRepoInfo && (
                <div className="onboarding-card onboarding-soft-enter rounded-md border border-app bg-app-muted p-4">
                  <div className="flex items-start gap-3">
                    <Github className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                    <div className="min-w-0">
                      <h3 className="text-[13px] font-semibold text-theme-primary">Default test repository</h3>
                      <p className="mt-1 text-[12px] leading-5 text-theme-muted">
                        Use this small starter repo to test Allen without connecting private code.
                      </p>
                      <a
                        href={DEFAULT_ONBOARDING_REPO.url}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-3 inline-flex items-center gap-1.5 text-[12px] font-semibold text-accent hover:underline"
                      >
                        View test repo
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </div>
                  </div>
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label htmlFor="repo-branch" className="block font-mono text-[11px] font-medium lowercase text-theme-muted">
                    branch
                  </label>
                  <input
                    id="repo-branch"
                    value={branch}
                    onChange={event => setBranch(event.target.value)}
                    className="onboarding-control h-10 w-full rounded-md border border-app bg-app-muted px-3 font-mono text-[13px] text-theme-primary outline-none placeholder:text-theme-subtle focus:border-accent focus:shadow-[var(--focus-ring)]"
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="repo-name" className="block font-mono text-[11px] font-medium lowercase text-theme-muted">
                    name
                  </label>
                  <input
                    id="repo-name"
                    value={name}
                    onChange={event => setName(event.target.value)}
                    placeholder="Optional"
                    className="onboarding-control h-10 w-full rounded-md border border-app bg-app-muted px-3 text-[13px] text-theme-primary outline-none placeholder:text-theme-subtle focus:border-accent focus:shadow-[var(--focus-ring)]"
                  />
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="onboarding-soft-enter mt-4 rounded-md border border-accent-red/30 bg-accent-red/10 px-3 py-2 text-[12px] text-accent-red">
              {error}
            </div>
          )}

          <div className="mt-5 flex flex-col-reverse gap-3 border-t border-app pt-4 sm:flex-row sm:items-center sm:justify-end">
            <button type="button" onClick={validate} disabled={checking} className="onboarding-control btn-secondary justify-center">
              {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Validate
            </button>
            <button type="button" onClick={connectRepo} disabled={!canConnect} className="onboarding-control btn-primary justify-center">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
              {saving ? 'Connecting...' : 'Connect repository'}
            </button>
          </div>
        </div>

        <div className="onboarding-soft-enter border-t border-app pt-4">
          <button type="button" onClick={skipOnboarding} className="onboarding-control btn-ghost w-full justify-center">
            Skip for now
          </button>
        </div>

        {validationOpen && validation && createPortal(
          <div className={`fixed left-0 top-0 z-50 flex h-screen w-screen items-center justify-center bg-black/35 p-4 backdrop-blur-sm motion-reduce:animate-none ${validationClosing ? 'pointer-events-none animate-onboarding-fade-out' : 'animate-onboarding-fade-in'}`}>
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="repo-validation-title"
              className="absolute inset-0"
              onClick={closeValidationModal}
            />
            <div
              className={`relative z-10 flex max-h-[calc(100vh-32px)] w-full max-w-[560px] flex-col overflow-hidden rounded-md border border-app bg-app-card shadow-xl motion-reduce:animate-none ${validationClosing ? 'animate-onboarding-modal-exit' : 'animate-onboarding-modal-enter'}`}
            >
              <div className="flex items-start justify-between gap-4 border-b border-app p-4">
                <div className="min-w-0">
                  <h2 id="repo-validation-title" className="text-[18px] font-semibold text-theme-primary">
                    Repository validation
                  </h2>
                  <p className="mt-1 text-[12px] leading-5 text-theme-muted">
                    Review readiness checks before connecting this repo.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={closeValidationModal}
                  className="onboarding-control inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-app bg-app-muted text-theme-muted hover:text-theme-primary"
                  aria-label="Close validation"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="min-h-0 overflow-y-auto p-4">
                <ValidationPanel result={validation} />
              </div>

              <div className="flex flex-col-reverse gap-3 border-t border-app p-4 sm:flex-row sm:justify-between">
                <button type="button" onClick={closeValidationModal} className="onboarding-control btn-secondary justify-center">
                  Close
                </button>
                <button type="button" onClick={connectRepo} disabled={!canConnect} className="onboarding-control btn-primary justify-center">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                  {saving ? 'Connecting...' : 'Connect repository'}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
      </div>
    </OnboardingShell>
  );
}
