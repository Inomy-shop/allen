import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  FolderGit2,
  GitBranch,
  Github,
  Loader2,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { repos, system } from '../services/api';
import { BRAND_NAME } from '../lib/brand';
import { useOnboardingGate } from '../hooks/useOnboardingGate';

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
  sshUrl?: string;
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

function StatusIcon({ status }: { status: CheckStatus }) {
  if (status === 'pass') return <CheckCircle2 className="h-4 w-4 text-accent-green" />;
  if (status === 'warn') return <AlertTriangle className="h-4 w-4 text-accent-yellow" />;
  return <XCircle className="h-4 w-4 text-accent-red" />;
}

function statusClass(status: CheckStatus): string {
  if (status === 'pass') return 'badge badge-ok';
  if (status === 'warn') return 'badge badge-warn';
  return 'badge badge-err';
}

function ValidationPanel({ result }: { result: ValidationResult | null }) {
  if (!result) {
    return (
      <div className="rounded-md border border-dashed border-app bg-surface-50 p-4 text-sm text-theme-muted">
        Validate a repository to see readiness checks.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-app bg-surface-100 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <FolderGit2 className="h-4 w-4 text-accent-blue" />
          <h3 className="text-sm font-semibold text-theme-primary">{result.name ?? 'Repository'}</h3>
          <span className={result.ok ? 'badge badge-ok' : 'badge badge-err'}>
            {result.ok ? 'ready' : 'needs attention'}
          </span>
        </div>
        <div className="mt-3 grid gap-2 text-xs text-theme-muted">
          {result.path && <p className="font-mono">{result.path}</p>}
          {result.clonePath && <p className="font-mono">{result.clonePath}</p>}
          {result.sshUrl && <p className="font-mono">{result.sshUrl}</p>}
          {result.branch && <p>Branch: <span className="font-mono">{result.branch}</span></p>}
          {result.detected && (
            <p>
              Detected: {[...result.detected.language, ...result.detected.framework]
                .filter(Boolean)
                .join(', ') || 'unknown'}
            </p>
          )}
        </div>
      </div>

      {result.checks.map(check => (
        <div key={check.id} className="rounded-md border border-app bg-surface-100 p-3">
          <div className="flex items-start gap-2">
            <StatusIcon status={check.status} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-theme-primary">{check.label}</span>
                <span className={statusClass(check.status)}>{check.status}</span>
              </div>
              <p className="mt-1 text-xs leading-5 text-theme-secondary">{check.detail}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function SshPanel({ result, loading, onVerify }: { result: SshResult | null; loading: boolean; onVerify: () => void }) {
  return (
    <div className="rounded-md border border-app bg-surface-50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-accent-blue" />
            <p className="text-sm font-semibold text-theme-primary">GitHub SSH</p>
            {result && (
              <span className={result.ok ? 'badge badge-ok' : 'badge badge-err'}>
                {result.ok ? 'ready' : 'failed'}
              </span>
            )}
          </div>
          <p className="mt-2 text-xs leading-5 text-theme-secondary">
            Allen clones GitHub repositories over SSH. Verify this before cloning.
          </p>
        </div>
        <button type="button" onClick={onVerify} disabled={loading} className="btn-ghost inline-flex items-center gap-2">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Test
        </button>
      </div>

      {result && (
        <div className="mt-3 rounded-md border border-app bg-surface-100 p-3">
          <p className="text-xs text-theme-secondary">{result.detail}</p>
          {result.fix && (
            <div className="mt-2">
              <p className="text-xs font-medium text-theme-primary">{result.fix.summary}</p>
              {result.fix.commands?.map(command => (
                <code key={command} className="mt-1 block rounded border border-app px-2 py-1 font-mono text-[11px] text-theme-muted">
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
  const [mode, setMode] = useState<Mode>('local');
  const [localPath, setLocalPath] = useState('');
  const [cloneUrl, setCloneUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [name, setName] = useState('');
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [sshResult, setSshResult] = useState<SshResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sshLoading, setSshLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValidation(null);
    setError(null);
  }, [branch, cloneUrl, localPath, mode, name]);

  const canConnect = useMemo(() => {
    if (!validation?.ok || saving) return false;
    if (mode === 'clone' && !sshResult?.ok) return false;
    return true;
  }, [mode, saving, sshResult, validation]);

  async function validate() {
    setChecking(true);
    setError(null);
    try {
      const result = mode === 'local'
        ? await repos.validateLocal(localPath)
        : await repos.validateClone({ url: cloneUrl, branch, name: name.trim() || undefined });
      setValidation(result);
    } catch (err) {
      setValidation(null);
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
          url: cloneUrl.trim(),
          branch: branch.trim() || 'main',
          name: name.trim() || undefined,
        });
      }
      await system.updateOnboardingProgress({ step: 'first_workflow' }).catch(() => {});
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
      <div className="mx-auto flex min-h-screen w-full max-w-5xl items-center py-8">
        <div className="grid w-full gap-5 lg:grid-cols-[minmax(0,0.95fr)_minmax(360px,440px)] lg:items-start">
          <section className="space-y-5">
            <div className="space-y-3">
              <div className="flex items-center gap-2.5">
                <div className="relative">
                  <Activity className="h-6 w-6 text-accent-blue" />
                </div>
                <span className="font-heading text-lg font-bold uppercase tracking-widest text-theme-primary">
                  {BRAND_NAME}
                </span>
              </div>
              <div>
                <p className="overline text-theme-muted">Repository</p>
                <h1 className="mt-2 font-heading text-3xl text-theme-primary">Connect your first repo</h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-theme-secondary">
                  Allen works against real repositories. Connect a local checkout or clone from GitHub over SSH.
                </p>
              </div>
            </div>

            <div className="card p-5">
              <div className="mb-5 grid grid-cols-2 gap-2 rounded-md bg-surface-50 p-1">
                <button
                  type="button"
                  onClick={() => setMode('local')}
                  className={`rounded px-3 py-2 text-sm ${mode === 'local' ? 'bg-surface-100 text-theme-primary shadow-sm' : 'text-theme-muted'}`}
                >
                  <span className="inline-flex items-center gap-2">
                    <FolderGit2 className="h-4 w-4" />
                    Local path
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setMode('clone')}
                  className={`rounded px-3 py-2 text-sm ${mode === 'clone' ? 'bg-surface-100 text-theme-primary shadow-sm' : 'text-theme-muted'}`}
                >
                  <span className="inline-flex items-center gap-2">
                    <Github className="h-4 w-4" />
                    GitHub SSH
                  </span>
                </button>
              </div>

              {mode === 'local' ? (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <label className="block overline text-theme-muted">Repository path</label>
                    <input
                      value={localPath}
                      onChange={event => setLocalPath(event.target.value)}
                      placeholder="/Users/you/projects/app"
                      className="input w-full font-mono"
                    />
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <SshPanel result={sshResult} loading={sshLoading} onVerify={verifySsh} />
                  <div className="space-y-2">
                    <label className="block overline text-theme-muted">GitHub repository URL</label>
                    <input
                      value={cloneUrl}
                      onChange={event => setCloneUrl(event.target.value)}
                      placeholder="git@github.com:owner/repo.git"
                      className="input w-full font-mono"
                    />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-2">
                      <label className="block overline text-theme-muted">Branch</label>
                      <input value={branch} onChange={event => setBranch(event.target.value)} className="input w-full font-mono" />
                    </div>
                    <div className="space-y-2">
                      <label className="block overline text-theme-muted">Name</label>
                      <input value={name} onChange={event => setName(event.target.value)} placeholder="Optional" className="input w-full" />
                    </div>
                  </div>
                </div>
              )}

              {error && (
                <div className="mt-4 rounded-md border border-accent-red/30 bg-accent-red/10 px-3 py-2 text-xs text-accent-red">
                  {error}
                </div>
              )}

              <div className="mt-5 flex flex-wrap gap-3">
                <button type="button" onClick={validate} disabled={checking} className="btn-ghost inline-flex items-center gap-2">
                  {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  Validate
                </button>
                <button type="button" onClick={connectRepo} disabled={!canConnect} className="btn-primary inline-flex items-center gap-2">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                  {saving ? 'Connecting...' : 'Connect repository'}
                </button>
              </div>
            </div>
          </section>

          <aside className="space-y-4">
            <ValidationPanel result={validation} />
            <div className="card p-5">
              <GitBranch className="mb-3 h-5 w-5 text-accent-blue" />
              <h2 className="font-heading text-base text-theme-primary">What Allen checks</h2>
              <p className="mt-2 text-xs leading-5 text-theme-secondary">
                Validation confirms git access, duplicate registration, branch state, and basic project metadata before Allen stores the repo.
              </p>
              <button type="button" onClick={skipOnboarding} className="btn-ghost mt-4 w-full">
                Skip for now
              </button>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
