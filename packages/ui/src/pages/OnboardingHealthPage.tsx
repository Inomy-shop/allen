import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Terminal,
  XCircle,
} from 'lucide-react';
import { system } from '../services/api';
import { BRAND_NAME } from '../lib/brand';

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

function StatusIcon({ status }: { status: HealthStatus }) {
  if (status === 'pass') return <CheckCircle2 className="h-5 w-5 text-accent-green" />;
  if (status === 'warn') return <AlertTriangle className="h-5 w-5 text-accent-yellow" />;
  return <XCircle className="h-5 w-5 text-accent-red" />;
}

function statusClass(status: HealthStatus): string {
  if (status === 'pass') return 'badge badge-ok';
  if (status === 'warn') return 'badge badge-warn';
  return 'badge badge-err';
}

function CheckRow({ check }: { check: HealthCheck }) {
  return (
    <div className="rounded-md border border-app bg-surface-100 p-4">
      <div className="flex items-start gap-3">
        <StatusIcon status={check.status} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-theme-primary">{check.label}</h3>
            <span className={statusClass(check.status)}>{check.status}</span>
            <span className="badge badge-muted">{check.required ? 'required' : 'optional'}</span>
            {check.version && <span className="badge badge-muted">{check.version}</span>}
          </div>
          <p className="mt-2 text-xs leading-5 text-theme-secondary">{check.detail}</p>

          {check.fix && (
            <div className="mt-3 rounded-md border border-app bg-surface-50 p-3">
              <p className="text-xs font-medium text-theme-primary">{check.fix.summary}</p>
              {check.fix.commands && check.fix.commands.length > 0 && (
                <div className="mt-2 space-y-1">
                  {check.fix.commands.map(command => (
                    <code
                      key={command}
                      className="block overflow-x-auto rounded border border-app bg-surface-100 px-2 py-1 font-mono text-[11px] text-theme-secondary"
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

export default function OnboardingHealthPage() {
  const navigate = useNavigate();
  const [summary, setSummary] = useState<HealthSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadHealth() {
    setLoading(true);
    setError(null);
    try {
      const status = await system.onboardingStatus();
      if (status.isFirstRun) {
        navigate('/onboarding/account', { replace: true });
        return;
      }
      const health = await system.health();
      setSummary(health);
    } catch (err) {
      setError((err as Error).message || 'Could not run health checks');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadHealth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const counts = useMemo(() => {
    const checks = summary?.checks ?? [];
    return {
      pass: checks.filter(check => check.status === 'pass').length,
      warn: checks.filter(check => check.status === 'warn').length,
      fail: checks.filter(check => check.status === 'fail').length,
    };
  }, [summary]);

  return (
    <div className="min-h-screen bg-surface-50 p-4">
      <div className="mx-auto flex min-h-screen w-full max-w-5xl items-center py-8">
        <div className="w-full space-y-5">
          <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div className="space-y-3">
              <div className="flex items-center gap-2.5">
                <div className="relative">
                  <Activity className="h-6 w-6 text-accent-blue" />
                  <div className="absolute inset-0 rounded-full bg-accent-blue/30 blur-md" />
                </div>
                <span className="font-heading text-lg font-bold uppercase tracking-widest text-theme-primary">
                  {BRAND_NAME}
                </span>
              </div>
              <div>
                <p className="overline text-theme-muted">System check</p>
                <h1 className="mt-2 font-heading text-3xl text-theme-primary">Verify this machine</h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-theme-secondary">
                  Allen checks the local runtime before starting workflows so setup failures are visible and fixable.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {summary && (
                <>
                  <span className="chip chip-ok">{counts.pass} pass</span>
                  <span className="chip chip-warn">{counts.warn} warn</span>
                  <span className={counts.fail > 0 ? 'chip chip-err' : 'chip'}>{counts.fail} fail</span>
                </>
              )}
              <button
                type="button"
                onClick={() => void loadHealth()}
                disabled={loading}
                className="btn-ghost inline-flex items-center gap-2"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Retry
              </button>
            </div>
          </header>

          <main className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
            <section className="space-y-3">
              {loading && !summary && (
                <div className="card flex items-center gap-3 p-5 text-sm text-theme-secondary">
                  <Loader2 className="h-4 w-4 animate-spin text-accent-blue" />
                  Running health checks
                </div>
              )}

              {error && (
                <div className="rounded-md border border-accent-red/30 bg-accent-red/10 p-4 text-sm text-accent-red">
                  {error}
                </div>
              )}

              {summary?.checks.map(check => (
                <CheckRow key={check.id} check={check} />
              ))}
            </section>

            <aside className="card h-fit p-5">
              <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-md bg-accent-soft text-accent-blue">
                <Terminal className="h-5 w-5" />
              </div>
              <h2 className="font-heading text-base text-theme-primary">Required to continue</h2>
              <p className="mt-2 text-xs leading-5 text-theme-secondary">
                Required checks must pass before onboarding continues. Optional checks can be fixed later from settings.
              </p>

              <div className="mt-4 rounded-md border border-app bg-surface-50 p-3">
                <p className="text-xs font-medium text-theme-primary">Terminal equivalent</p>
                <code className="mt-2 block rounded border border-app bg-surface-100 px-2 py-1 font-mono text-[11px] text-theme-secondary">
                  npm run health
                </code>
              </div>

              <button
                type="button"
                disabled={!summary?.requiredPassed}
                onClick={() => navigate('/onboarding/repository', { replace: true })}
                className="btn-primary mt-5 inline-flex w-full items-center justify-center gap-2"
              >
                Continue
                <ArrowRight className="h-4 w-4" />
              </button>

              {summary && !summary.requiredPassed && (
                <p className="mt-3 text-xs leading-5 text-theme-muted">
                  Fix the failed required checks, then retry.
                </p>
              )}
            </aside>
          </main>
        </div>
      </div>
    </div>
  );
}
