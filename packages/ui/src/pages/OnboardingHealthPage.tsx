import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  Loader2,
  RefreshCw,
  X,
} from 'lucide-react';
import { system } from '../services/api';
import { useOnboardingGate } from '../hooks/useOnboardingGate';
import { OnboardingShell } from '../components/onboarding/OnboardingShell';
import { useAuthStore } from '../stores/authStore';

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
    note?: string;
  };
}

interface HealthSummary {
  status: HealthStatus;
  generatedAt: string;
  requiredPassed: boolean;
  checks: HealthCheck[];
}

const CORE_CHECK_IDS = ['node', 'npm', 'mongodb', 'git'] as const;

function providerCheck(checks: HealthCheck[], provider: 'claude' | 'codex'): HealthCheck | null {
  const cli = checks.find(check => check.id === `${provider}_cli`);
  const auth = checks.find(check => check.id === `${provider}_auth`);
  if (!cli && !auth) return null;

  const required = Boolean(cli?.required || auth?.required);
  const cliReady = cli?.status === 'pass';
  const authReady = auth?.status === 'pass';
  const ready = cliReady && authReady;
  const label = provider === 'claude' ? 'Claude Code CLI' : 'Codex CLI';
  const providerName = provider === 'claude' ? 'Claude' : 'Codex';
  const otherProvider = provider === 'claude' ? 'Codex' : 'Claude';

  let status: HealthStatus = 'pass';
  if (!ready) {
    status = required && (cli?.status === 'fail' || auth?.status === 'fail') ? 'fail' : 'warn';
  }

  const authFix = auth?.fix;
  const fix = !cliReady
    ? cli?.fix
    : !authReady
      ? {
        summary: 'Sign in from any terminal, then recheck:',
        commands: authFix?.commands ?? [provider === 'codex' ? 'codex login' : 'claude'],
        docsPath: authFix?.docsPath,
        note: required
          ? `${providerName} is required for the selected provider setup.`
          : `You can also continue with ${otherProvider} only and add ${providerName} later in Settings.`,
      }
      : undefined;

  return {
    id: `${provider}_provider`,
    label,
    required,
    status,
    version: ready ? 'signed in' : cliReady ? 'installed · not signed in' : cli?.version ?? 'not installed',
    detail: ready
      ? `Runs ${providerName}-powered agents. Auth verified.`
      : required
        ? `${providerName} is required for this setup and must be authenticated before the first run.`
        : `Optional. Needed only if you want ${providerName}-powered agents alongside ${otherProvider}.`,
    fix,
  };
}

export function buildDisplayHealthChecks(checks: HealthCheck[]): HealthCheck[] {
  const core = CORE_CHECK_IDS
    .map(id => checks.find(check => check.id === id))
    .filter((check): check is HealthCheck => Boolean(check));
  const providers = [
    providerCheck(checks, 'claude'),
    providerCheck(checks, 'codex'),
  ].filter((check): check is HealthCheck => Boolean(check));
  return [...core, ...providers];
}

function CheckRow({
  check,
  index,
  onRecheck,
}: {
  check: HealthCheck;
  index: number;
  onRecheck: () => void;
}) {
  const Icon = check.status === 'pass' ? Check : check.status === 'warn' ? AlertTriangle : X;

  return (
    <div
      className={`ob-chk in is-${check.status}`}
      style={{ animationDelay: `${index * 65}ms` }}
    >
      <span className="ic"><Icon /></span>
      <span>
        <span className="tt">
          {check.label}
          {check.version && <span className="v">{check.version}</span>}
          {check.required && <span className="req">required</span>}
        </span>
        <span className="dt">{check.detail}</span>
        {check.fix && (
          <span className="ob-fix">
            <span className="fs">{check.fix.summary}</span>
            {check.fix.commands?.map(command => <code key={command}>{command}</code>)}
            <span className="fr">
              <button type="button" className="ob-action-ghost" onClick={onRecheck}>
                Recheck
              </button>
              <span className="note">
                {check.fix.note ?? 'Optional providers can also be added later in Settings.'}
              </span>
            </span>
          </span>
        )}
      </span>
      <span className="st">{check.status}</span>
    </div>
  );
}

export default function OnboardingHealthPage() {
  const navigate = useNavigate();
  const email = useAuthStore(state => state.user?.email);
  const checkingOnboarding = useOnboardingGate('health');
  const [summary, setSummary] = useState<HealthSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadHealth() {
    setLoading(true);
    setError(null);
    try {
      setSummary(await system.health());
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
    if (!checkingOnboarding) void loadHealth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkingOnboarding]);

  const counts = useMemo(() => {
    const checks = buildDisplayHealthChecks(summary?.checks ?? []);
    return {
      pass: checks.filter(check => check.status === 'pass').length,
      warn: checks.filter(check => check.status !== 'pass').length,
    };
  }, [summary]);
  const displayChecks = useMemo(
    () => buildDisplayHealthChecks(summary?.checks ?? []),
    [summary],
  );

  const isDesktop = typeof window !== 'undefined' && Boolean(window.allenDesktop);
  const coreChecksPassed = summary
    ? ['node', 'npm', 'mongodb', 'git'].every(id => summary.checks.some(check => check.id === id && check.status === 'pass'))
    : false;
  const canContinue = isDesktop ? coreChecksPassed : Boolean(summary?.requiredPassed);

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
      step="health"
      eyebrow="system check"
      title="Verify this machine once, up front."
      description="Allen checks the runtime and your model providers here, so nothing fails silently mid-workflow. Anything that needs a terminal gives you the exact command and a recheck button."
      runtimeLabel={isDesktop ? 'desktop runtime' : 'web setup'}
      stepCopy={{ account: email ?? 'elena@company.com' }}
    >
      <section className="ob-card">
        <div className="ob-card__head">
          <div>
            <h2>Machine &amp; provider checks</h2>
            <p className="sub">Core runtime must pass. Providers can be fixed right here — run the command, then recheck.</p>
          </div>
          <span className="sp" />
          <div className="ob-counts" aria-label="Check summary">
            <span className="ob-cnt is-pass"><i />{counts.pass} pass</span>
            <span className="ob-cnt is-warn"><i />{counts.warn} warn</span>
          </div>
        </div>

        <div className="ob-checks">
          {loading && !summary && (
            <div className="ob-check-loading">
              <Loader2 className="animate-spin" />
              Running machine and provider checks…
            </div>
          )}
          {displayChecks.map((check, index) => (
            <CheckRow key={check.id} check={check} index={index} onRecheck={() => void loadHealth()} />
          ))}
        </div>

        {error && <div className="ob-error">{error}</div>}
        {summary && !canContinue && (
          <p className="ob-error">Fix the failed required checks, then recheck.</p>
        )}

        <div className="ob-actions">
          <button type="button" className="ob-back" onClick={() => navigate('/onboarding/account')}>
            <ArrowLeft /> Back
          </button>
          <span className="sp" />
          <button type="button" className="ob-action-ghost" onClick={() => void loadHealth()} disabled={loading}>
            <RefreshCw className={loading ? 'animate-spin' : ''} /> Recheck
          </button>
          <button
            type="button"
            className="ob-action-primary"
            disabled={!canContinue}
            onClick={async () => {
              await system.updateOnboardingProgress({ step: 'repository' }).catch(() => {});
              navigate('/onboarding/repository', { replace: true });
            }}
          >
            Continue <ArrowRight />
          </button>
        </div>
      </section>
      <button type="button" onClick={skipOnboarding} className="ob-skip">
        Skip for now — finish setup later from Settings
      </button>
    </OnboardingShell>
  );
}
