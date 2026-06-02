import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Circle,
  CircleDot,
  Loader2,
  RefreshCw,
  XCircle,
} from 'lucide-react';
import { system } from '../services/api';
import { useOnboardingGate } from '../hooks/useOnboardingGate';
import { OnboardingShell } from '../components/onboarding/OnboardingShell';

type HealthStatus = 'pass' | 'warn' | 'fail';

interface HealthCheck {
  id: string;
  label: string;
  required: boolean;
  status: HealthStatus;
  version?: string;
  detail: string;
  fix?: {
    summary: string;
    commands?: string[];
    docsPath?: string;
  };
}

interface HealthSummary {
  status: HealthStatus;
  generatedAt: string;
  requiredPassed: boolean;
  checks: HealthCheck[];
}

function StatusIcon({ status, className = 'h-5 w-5' }: { status: HealthStatus; className?: string }) {
  if (status === 'pass') return <CheckCircle2 className={`${className} text-accent-green`} />;
  if (status === 'warn') return <AlertTriangle className={`${className} text-accent-yellow`} />;
  return <XCircle className={`${className} text-accent-red`} />;
}

function statusLabel(status: HealthStatus): string {
  if (status === 'pass') return 'Pass';
  if (status === 'warn') return 'Warn';
  return 'Fail';
}

function statusSurfaceClass(status: HealthStatus): string {
  if (status === 'pass') return 'border-accent-green/20 bg-accent-green/10';
  if (status === 'warn') return 'border-accent-yellow/25 bg-accent-yellow/10';
  return 'border-accent-red/25 bg-accent-red/10';
}

function statusTextClass(status: HealthStatus): string {
  if (status === 'pass') return 'text-accent-green';
  if (status === 'warn') return 'text-accent-yellow';
  return 'text-accent-red';
}

function CheckRow({ check, index }: { check: HealthCheck; index: number }) {
  return (
    <div
      className="onboarding-check-row rounded-md border border-app bg-app-card p-4 hover:border-accent/20"
      style={{
        animation: 'onboarding-rise 360ms cubic-bezier(0.16, 1, 0.3, 1) both',
        animationDelay: `${index * 70}ms`,
      }}
    >
      <div className="flex items-start gap-3">
        <div className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full border ${statusSurfaceClass(check.status)}`}>
          <StatusIcon status={check.status} className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <h3 className="truncate text-[13px] font-semibold text-theme-primary">{check.label}</h3>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10.5px] text-theme-subtle">
                <span>{check.required ? 'Required' : 'Optional'}</span>
                {check.version && (
                  <>
                    <span className="text-theme-subtle/60">/</span>
                    <span className="max-w-full [overflow-wrap:anywhere]">{check.version}</span>
                  </>
                )}
              </div>
            </div>
            <div className={`inline-flex h-6 shrink-0 items-center gap-1.5 self-start rounded-full border px-2 font-mono text-[11px] font-medium ${statusSurfaceClass(check.status)} ${statusTextClass(check.status)}`}>
              <StatusIcon status={check.status} className="h-3.5 w-3.5" />
              {statusLabel(check.status)}
            </div>
          </div>
          <p className="mt-2 text-[12px] leading-5 text-theme-muted [overflow-wrap:anywhere]">{check.detail}</p>

          {check.fix && (
            <div className="mt-3 rounded-md border border-app bg-app-muted p-3">
              <p className="text-[12px] font-medium text-theme-primary">{check.fix.summary}</p>
              {check.fix.commands && check.fix.commands.length > 0 && (
                <div className="mt-2 space-y-1">
                  {check.fix.commands.map(command => (
                    <code
                      key={command}
                      className="block overflow-x-auto rounded border border-app bg-app-card px-2 py-1 font-mono text-[11px] text-theme-secondary"
                    >
                      {command}
                    </code>
                  ))}
                </div>
              )}
              {check.fix.docsPath && (
                <p className="mt-2 font-mono text-[11px] text-theme-muted">{check.fix.docsPath}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CountChip({
  label,
  value,
  tone,
  icon: Icon,
}: {
  label: string;
  value: number;
  tone: 'ok' | 'warn' | 'err';
  icon: typeof CheckCircle2;
}) {
  const toneClass = value > 0
    ? tone === 'ok'
      ? 'chip-ok'
      : tone === 'warn'
        ? 'chip-warn'
        : 'chip-err'
    : 'chip muted';

  return (
    <span className={`chip ${toneClass} h-8 px-2.5`}>
      <Icon className="h-3.5 w-3.5" />
      <span className="font-semibold">{value}</span>
      <span>{label}</span>
    </span>
  );
}

export default function OnboardingHealthPage() {
  const navigate = useNavigate();
  const checkingOnboarding = useOnboardingGate('health');
  const [summary, setSummary] = useState<HealthSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadHealth() {
    setLoading(true);
    setError(null);
    try {
      const health = await system.health();
      setSummary(health);
    } catch (err) {
      setError((err as Error).message || 'Could not run health checks');
    } finally {
      setLoading(false);
    }
  }

  async function skipOnboarding() {
    await system.updateOnboardingProgress({ action: 'skip' }).catch(() => {});
    navigate('/', { replace: true });
  }

  useEffect(() => {
    if (checkingOnboarding) return;
    void loadHealth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkingOnboarding]);

  const counts = useMemo(() => {
    const checks = summary?.checks ?? [];
    return {
      pass: checks.filter(check => check.status === 'pass').length,
      warn: checks.filter(check => check.status === 'warn').length,
      fail: checks.filter(check => check.status === 'fail').length,
    };
  }, [summary]);

  const isDesktop = typeof window !== 'undefined' && Boolean(window.allenDesktop);
  const coreChecksPassed = summary
    ? ['node', 'npm', 'mongodb', 'git'].every(id => summary.checks.some(check => check.id === id && check.status === 'pass'))
    : false;
  const canContinue = isDesktop ? coreChecksPassed : Boolean(summary?.requiredPassed);
  const runtimeLabel = isDesktop ? 'desktop runtime' : 'web setup';
  const runtimeCopy = 'Allen checks local dependencies before agents create workspaces or run workflows.';
  const bootstrapSteps: Array<{
    number: string;
    title: string;
    copy: string;
    state: 'done' | 'active' | 'next';
  }> = isDesktop
    ? [
      { number: '01', title: 'Create admin', copy: 'Admin account is ready for this instance.', state: 'done' },
      { number: '02', title: 'Verify runtime', copy: 'Check CLIs, auth, ports, database, and local services.', state: 'active' },
      { number: '03', title: 'Choose models', copy: 'Set chat and inbuilt workflow defaults.', state: 'next' },
      { number: '04', title: 'Connect repo', copy: 'Register a checkout or clone a starter repository.', state: 'next' },
      { number: '05', title: 'Start workflow', copy: 'Launch a small bug fix or feature run.', state: 'next' },
    ]
    : [
      { number: '01', title: 'Create admin', copy: 'Admin account is ready for this instance.', state: 'done' },
      { number: '02', title: 'Verify runtime', copy: 'Check CLIs, auth, ports, database, and local services.', state: 'active' },
      { number: '03', title: 'Connect repo', copy: 'Register a checkout or clone a starter repository.', state: 'next' },
      { number: '04', title: 'Start workflow', copy: 'Launch a small bug fix or feature run.', state: 'next' },
    ];

  return (
    <OnboardingShell
      step="health"
      eyebrow="system check"
      title="Verify this machine"
      description="Allen checks the local runtime before starting workflows so setup failures are visible and fixable."
      runtimeLabel={runtimeLabel}
      runtimeCopy={runtimeCopy}
      side={(
        <div className="onboarding-card mt-8 rounded-md border border-app bg-app-card p-4">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <div className="font-mono text-[10.5px] text-theme-subtle">bootstrap path</div>
              <div className="mt-1 text-[13px] font-semibold text-theme-primary">Runtime verification</div>
            </div>
            {summary && (
              <span className={summary.requiredPassed ? 'badge badge-ok' : 'badge badge-warn'}>
                {summary.requiredPassed ? 'ready' : 'needs fixes'}
              </span>
            )}
          </div>
          <div className="space-y-0">
            {bootstrapSteps.map(({ number, title, copy, state }) => (
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
                    {title}
                  </div>
                  <p className="mt-0.5 text-[12px] leading-5 text-theme-muted">{copy}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    >
      <div className="space-y-4">
        <div className="onboarding-card onboarding-panel-enter rounded-md border border-app bg-app-card p-5 shadow-sm sm:p-6">
          <div className="mb-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-[22px] font-semibold text-theme-primary">Machine checks</h2>
                <p className="mt-1 text-[13px] leading-5 text-theme-muted">
                  Checks appear one by one as Allen receives the runtime report.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void loadHealth()}
                disabled={loading}
                className="onboarding-control btn-secondary shrink-0"
              >
                {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                Retry
              </button>
            </div>

            {summary && (
              <div className="onboarding-soft-enter mt-4 flex flex-wrap items-center gap-2">
                <CountChip label="Pass" value={counts.pass} tone="ok" icon={CheckCircle2} />
                <CountChip label="Warn" value={counts.warn} tone="warn" icon={AlertTriangle} />
                <CountChip label="Fail" value={counts.fail} tone="err" icon={XCircle} />
              </div>
            )}
          </div>

          {loading && !summary && (
            <div className="space-y-3">
              {[0, 1, 2, 3].map(index => (
                <div
                  key={index}
                  className="onboarding-card rounded-md border border-app bg-app-muted p-4"
                  style={{
                    animation: 'onboarding-rise 360ms cubic-bezier(0.16, 1, 0.3, 1) both',
                    animationDelay: `${index * 70}ms`,
                  }}
                >
                  <div className="flex items-center gap-3">
                    <Loader2 className="h-4 w-4 animate-spin text-accent" />
                    <div className="h-3 w-36 rounded bg-border" />
                  </div>
                  <div className="mt-3 h-2 w-full rounded bg-border/60" />
                </div>
              ))}
            </div>
          )}

          {error && (
            <div className="onboarding-soft-enter rounded-md border border-accent-red/30 bg-accent-red/10 p-4 text-[13px] text-accent-red">
              {error}
            </div>
          )}

          {summary && (
            <div className="onboarding-soft-enter max-h-[46vh] space-y-3 overflow-y-auto pr-1">
              {summary.checks.map((check, index) => (
                <CheckRow key={check.id} check={check} index={index} />
              ))}
            </div>
          )}

          <div className="mt-4 border-t border-app pt-4">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
              <div className="grid min-w-0 grid-cols-[32px_minmax(0,1fr)] gap-3">
                <div className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full border ${
                  canContinue ? 'border-accent-green/20 bg-accent-green/10' : 'border-accent-yellow/25 bg-accent-yellow/10'
                }`}>
                  {canContinue
                    ? <CheckCircle2 className="h-4 w-4 text-accent-green" />
                    : <AlertTriangle className="h-4 w-4 text-accent-yellow" />}
                </div>
                <div className="min-w-0 pb-0.5">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <div className="text-[13px] font-semibold text-theme-primary">Required to continue</div>
                    <code className="inline-flex max-w-full rounded border border-app bg-app-muted px-2 py-0.5 font-mono text-[11px] text-theme-secondary">
                      npm run health
                    </code>
                  </div>
                  <p className="mt-1 max-w-[560px] text-[12px] leading-5 text-theme-muted">
                    {isDesktop
                      ? 'Core checks must pass before setup continues. Provider checks are used on the next step.'
                      : 'Required checks must pass before setup continues. Optional warnings can be fixed later.'}
                  </p>
                </div>
              </div>

              <button
                type="button"
                disabled={!canContinue}
                onClick={async () => {
                  const nextStep = isDesktop ? 'model_defaults' : 'repository';
                  await system.updateOnboardingProgress({ step: nextStep }).catch(() => {});
                  navigate(isDesktop ? '/onboarding/model-defaults' : '/onboarding/repository', { replace: true });
                }}
                className="onboarding-control btn-primary w-full justify-center sm:w-auto"
              >
                Continue
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>

            {summary && !canContinue && (
              <p className="mt-3 text-[12px] leading-5 text-theme-muted">
                Fix the failed required checks, then retry.
              </p>
            )}
          </div>
        </div>

        <div className="onboarding-soft-enter border-t border-app pt-4">
          <button type="button" onClick={skipOnboarding} className="onboarding-control btn-ghost w-full justify-center">
            Skip for now
          </button>
        </div>
      </div>
    </OnboardingShell>
  );
}
