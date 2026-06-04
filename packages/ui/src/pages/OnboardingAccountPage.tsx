import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, CheckCircle2, Circle, CircleDot, Loader2 } from 'lucide-react';
import { auth, system } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { OnboardingShell } from '../components/onboarding/OnboardingShell';

function passwordLooksStrong(password: string): boolean {
  return password.length >= 8
    && /[a-z]/.test(password)
    && /[A-Z]/.test(password)
    && /\d/.test(password)
    && /[^A-Za-z0-9]/.test(password);
}

export default function OnboardingAccountPage() {
  const navigate = useNavigate();
  const setSession = useAuthStore((s) => s.setSession);
  const isDesktop = typeof window !== 'undefined' && Boolean(window.allenDesktop);

  const [checking, setChecking] = useState(true);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    system.onboardingStatus()
      .then((status) => {
        if (cancelled) return;
        if (!status.isFirstRun) navigate('/login', { replace: true });
      })
      .catch(() => {
        if (!cancelled) setError('Could not check first-run status. Confirm the Allen API is running.');
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => { cancelled = true; };
  }, [navigate]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    if (!email.trim().includes('@')) {
      setError('Enter a valid email address');
      return;
    }
    if (!passwordLooksStrong(password)) {
      setError('Use at least 8 characters with uppercase, lowercase, number, and symbol.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setSubmitting(true);
    try {
      const session = await auth.bootstrap({
        name: name.trim(),
        email: email.trim(),
        password,
      });
      setSession(session);
      await system.updateOnboardingProgress({ step: 'health' }).catch(() => {});
      navigate('/onboarding/health', { replace: true });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === 'bootstrap_closed') {
        setError('An admin account already exists. Sign in instead.');
      } else {
        setError(msg || 'Could not create the first admin account');
      }
    } finally {
      setSubmitting(false);
    }
  }

  const runtimeLabel = isDesktop ? 'desktop runtime' : 'web setup';
  const runtimeCopy = isDesktop
    ? 'Allen is preparing the local runtime that will host your repos, workspaces, and execution traces.'
    : 'Create the first admin for this Allen instance before continuing into setup.';
  const bootstrapSteps: Array<{
    number: string;
    title: string;
    copy: string;
    state: 'done' | 'active' | 'next';
  }> = isDesktop
    ? [
      { number: '01', title: 'Create admin', copy: 'Unlock this local Allen instance.', state: 'active' },
      { number: '02', title: 'Verify runtime', copy: 'Check CLIs, auth, ports, and local services.', state: 'next' },
      { number: '03', title: 'Choose models', copy: 'Set chat and seeded workflow defaults.', state: 'next' },
      { number: '04', title: 'Connect repo', copy: 'Register a checkout or clone a starter repository.', state: 'next' },
      { number: '05', title: 'Start workflow', copy: 'Launch a small bug fix or feature run.', state: 'next' },
    ]
    : [
      { number: '01', title: 'Create admin', copy: 'Unlock this local Allen instance.', state: 'active' },
      { number: '02', title: 'Verify runtime', copy: 'Check CLIs, auth, ports, and local services.', state: 'next' },
      { number: '03', title: 'Connect repo', copy: 'Register a checkout or clone a starter repository.', state: 'next' },
      { number: '04', title: 'Start workflow', copy: 'Launch a small bug fix or feature run.', state: 'next' },
    ];

  return (
    <OnboardingShell
      step="account"
      eyebrow="Allen setup"
      title="Create the first admin account"
      description="Allen is an agentic operating system for software development. It coordinates AI agents that plan, code, review, test, and ship against your repositories."
      runtimeLabel={runtimeLabel}
      runtimeCopy={runtimeCopy}
      side={(
        <div className="onboarding-card mt-8 rounded-md border border-app bg-app-card p-4">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <div className="font-mono text-[10.5px] text-theme-subtle">bootstrap path</div>
              <div className="mt-1 text-[13px] font-semibold text-theme-primary">From first admin to first run</div>
            </div>
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
      <form onSubmit={handleSubmit} className="onboarding-card onboarding-panel-enter rounded-md border border-app bg-app-card p-5 shadow-sm sm:p-6">
        <div className="mb-5">
          <h2 className="text-[22px] font-semibold text-theme-primary">First admin</h2>
          <p className="mt-1 text-[13px] leading-5 text-theme-muted">
            Create the account that will manage this Allen instance.
          </p>
        </div>

        {checking && (
          <div className="onboarding-soft-enter mb-4 flex items-center gap-2 rounded-md border border-app bg-app-muted px-3 py-2 text-[12px] text-theme-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Checking first-run status
          </div>
        )}

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="onboarding-name" className="block font-mono text-[11px] font-medium lowercase text-theme-muted">name</label>
            <input
              id="onboarding-name"
              required
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="onboarding-control h-10 w-full rounded-md border border-app bg-app-muted px-3 text-[13px] text-theme-primary outline-none placeholder:text-theme-subtle focus:border-accent focus:shadow-[var(--focus-ring)]"
              autoComplete="name"
              disabled={checking || submitting}
              placeholder="Elena Jones"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="onboarding-email" className="block font-mono text-[11px] font-medium lowercase text-theme-muted">email</label>
            <input
              id="onboarding-email"
              required
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="onboarding-control h-10 w-full rounded-md border border-app bg-app-muted px-3 text-[13px] text-theme-primary outline-none placeholder:text-theme-subtle focus:border-accent focus:shadow-[var(--focus-ring)]"
              autoComplete="email"
              disabled={checking || submitting}
              placeholder="you@company.com"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="onboarding-password" className="block font-mono text-[11px] font-medium lowercase text-theme-muted">password</label>
            <input
              id="onboarding-password"
              required
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="onboarding-control h-10 w-full rounded-md border border-app bg-app-muted px-3 text-[13px] text-theme-primary outline-none placeholder:text-theme-subtle focus:border-accent focus:shadow-[var(--focus-ring)]"
              autoComplete="new-password"
              disabled={checking || submitting}
              placeholder="Create password"
            />
            <p className="text-[11px] leading-4 text-theme-subtle">
              Minimum 8 characters with uppercase, lowercase, number, and symbol.
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="onboarding-confirm-password" className="block font-mono text-[11px] font-medium lowercase text-theme-muted">confirm password</label>
            <input
              id="onboarding-confirm-password"
              required
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              className="onboarding-control h-10 w-full rounded-md border border-app bg-app-muted px-3 text-[13px] text-theme-primary outline-none placeholder:text-theme-subtle focus:border-accent focus:shadow-[var(--focus-ring)]"
              autoComplete="new-password"
              disabled={checking || submitting}
              placeholder="Repeat password"
            />
          </div>
        </div>

        {error && (
          <div className="onboarding-soft-enter mt-4 rounded-md border border-accent-red/30 bg-accent-red/10 px-3 py-2 text-[12px] text-accent-red">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={checking || submitting}
          className="onboarding-control btn-primary mt-5 w-full justify-center"
        >
          {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
          {submitting ? 'Creating admin...' : 'Create admin account'}
          {!submitting && <ArrowRight className="h-4 w-4" />}
        </button>
      </form>
    </OnboardingShell>
  );
}
