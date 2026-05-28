import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowRight,
  CheckCircle2,
  FolderGit2,
  HardDrive,
  LockKeyhole,
  ShieldCheck,
} from 'lucide-react';
import { auth, system } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { BRAND_SLUG } from '../lib/brand';

export default function LoginPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const hydrated = useAuthStore((s) => s.hydrated);
  const hydrate = useAuthStore((s) => s.hydrate);
  const user = useAuthStore((s) => s.user);
  const refreshToken = useAuthStore((s) => s.refreshToken);
  const setSession = useAuthStore((s) => s.setSession);
  const isDesktop = typeof window !== 'undefined' && Boolean(window.allenDesktop);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const requestedFrom = params.get('from') ?? '/';
  const from = requestedFrom.startsWith('/login') ? '/' : requestedFrom;

  useEffect(() => {
    if (!hydrated) hydrate();
  }, [hydrated, hydrate]);

  useEffect(() => {
    if (!hydrated || loading) return;
    let cancelled = false;

    async function routeInitialState() {
      if (user && refreshToken) {
        if (user.mustResetPassword) {
          navigate(`/reset-password?from=${encodeURIComponent(from)}`, { replace: true });
          return;
        }
        const progress = await system.onboardingProgress().catch(() => null);
        if (cancelled) return;
        if (progress && !progress.complete) {
          const path = progress.step === 'repository'
            ? '/onboarding/repository'
            : progress.step === 'first_workflow'
              ? '/onboarding/first-workflow'
              : '/onboarding/health';
          navigate(path, { replace: true });
        } else {
          navigate(from, { replace: true });
        }
        return;
      }

      system.onboardingStatus()
        .then((status) => {
          if (!cancelled && status.isFirstRun) {
            navigate('/onboarding/account', { replace: true });
          }
        })
        .catch(() => {});
    }

    void routeInitialState();
    return () => { cancelled = true; };
  }, [from, hydrated, loading, navigate, refreshToken, user]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const data = await auth.login(email, password);
      setSession(data);
      if (data.user.mustResetPassword) {
        navigate(`/reset-password?from=${encodeURIComponent(from)}`, { replace: true });
      } else {
        const progress = await system.onboardingProgress().catch(() => null);
        if (progress && !progress.complete) {
          const path = progress.step === 'repository'
            ? '/onboarding/repository'
            : progress.step === 'first_workflow'
              ? '/onboarding/first-workflow'
              : '/onboarding/health';
          navigate(path, { replace: true });
        } else {
          navigate(from, { replace: true });
        }
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === 'invalid_credentials') setError('Invalid email or password');
      else setError(msg || 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  const runtimeLabel = isDesktop ? 'desktop runtime' : 'web session';
  const runtimeCopy = isDesktop
    ? 'Local server, managed data, and agent workspaces start with this app.'
    : 'Connect to an Allen instance with your workspace account.';
  const signInSteps = [
    ['restore session', 'Load your account, role, and saved workspace state.'],
    ['sync work', 'Refresh active runs, pending checkpoints, chats, and repos.'],
    ['open control plane', 'Continue to the page you requested or the app home.'],
  ];

  return (
    <main className="min-h-screen bg-app text-theme-primary">
      <div className="mx-auto flex min-h-screen w-full max-w-[1180px] flex-col px-5 py-5 sm:px-7 lg:px-8">
        <header className="flex h-11 shrink-0 items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="inline-flex items-center justify-center rounded-md border border-accent/25 bg-accent-soft px-1.5 py-0.5 font-mono text-[13px] font-semibold text-accent">
              [a]
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-[14px] font-semibold lowercase text-theme-primary">{BRAND_SLUG}</span>
              <span className="font-mono text-[10px] text-theme-subtle">{runtimeLabel}</span>
            </div>
          </div>
        </header>

        <div className="grid flex-1 items-center gap-8 py-8 lg:grid-cols-[minmax(0,1fr)_420px] lg:gap-12">
          <section className="order-2 hidden min-w-0 lg:order-1 lg:block">
            <div className="max-w-[620px]">
              <span className="font-mono text-[10.5px] font-medium uppercase tracking-[0.08em] text-theme-subtle">
                agentic software work
              </span>
              <h1 className="mt-3 max-w-[580px] text-[34px] font-semibold leading-[1.08] text-theme-primary">
                Sign in to coordinate agents, workspaces, and checkpoints
              </h1>
              <p className="mt-4 max-w-[560px] text-[14px] leading-6 text-theme-muted">
                Allen routes engineering work through specialist agents, runs tasks in isolated git worktrees, and keeps every execution traceable for review.
              </p>

              <div className="mt-8 grid max-w-[620px] gap-3">
                <div className="rounded-md border border-app bg-app-card p-4">
                  <div className="flex items-start gap-3">
                    <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-accent/25 bg-accent-soft text-accent">
                      {isDesktop ? <HardDrive className="h-4 w-4" /> : <LockKeyhole className="h-4 w-4" />}
                    </div>
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold text-theme-primary">{runtimeLabel}</div>
                      <p className="mt-1 text-[12.5px] leading-5 text-theme-muted">{runtimeCopy}</p>
                    </div>
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-md border border-app bg-app-card p-4">
                    <div className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-theme-primary">
                      <FolderGit2 className="h-4 w-4 text-accent" />
                      isolated worktrees
                    </div>
                    <p className="text-[12.5px] leading-5 text-theme-muted">
                      Each task gets a workspace with terminal output, repo context, and reviewable changes.
                    </p>
                  </div>
                  <div className="rounded-md border border-app bg-app-card p-4">
                    <div className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-theme-primary">
                      <ShieldCheck className="h-4 w-4 text-accent-purple" />
                      approval points
                    </div>
                    <p className="text-[12.5px] leading-5 text-theme-muted">
                      Human checkpoints keep plans, risky actions, and shipped work under review.
                    </p>
                  </div>
                </div>
              </div>

              <div className="mt-8 rounded-md border border-app bg-app-card p-4">
                <div className="mb-4 flex items-start justify-between gap-3">
                  <div>
                    <div className="font-mono text-[10.5px] text-theme-subtle">after sign in</div>
                    <div className="mt-1 text-[13px] font-semibold text-theme-primary">
                      Open the control plane
                    </div>
                    <p className="mt-1 text-[12px] leading-5 text-theme-muted">
                      Allen restores your working context and takes you back to the task surface you were trying to reach.
                    </p>
                  </div>
                </div>
                <div className="space-y-3">
                  {signInSteps.map(([label, copy], index) => (
                    <div key={label} className="grid grid-cols-[20px_minmax(0,1fr)] gap-3">
                      <div className="relative flex justify-center">
                        <CheckCircle2 className="mt-0.5 h-4 w-4 text-accent-green" />
                        {index !== signInSteps.length - 1 && (
                          <div className="absolute bottom-0 top-5 w-px bg-accent-green/30" />
                        )}
                      </div>
                      <div className="pb-3 last:pb-0">
                        <div className="text-[13px] font-semibold text-theme-primary">{label}</div>
                        <p className="mt-0.5 text-[12px] leading-5 text-theme-muted">{copy}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section className="order-1 mx-auto w-full max-w-[420px] lg:order-2">
            <div className="mb-5 rounded-md border border-app bg-app-card p-4 lg:hidden">
              <div className="flex items-start gap-3">
                <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-accent/25 bg-accent-soft text-accent">
                  {isDesktop ? <HardDrive className="h-4 w-4" /> : <LockKeyhole className="h-4 w-4" />}
                </div>
                <div>
                  <div className="text-[13px] font-semibold text-theme-primary">{runtimeLabel}</div>
                  <p className="mt-1 text-[12.5px] leading-5 text-theme-muted">{runtimeCopy}</p>
                </div>
              </div>
            </div>

            <form
              onSubmit={handleSubmit}
              className="rounded-md border border-app bg-app-card p-5 shadow-sm sm:p-6"
            >
              <div className="mb-5">
                <h2 className="text-[22px] font-semibold text-theme-primary">Welcome back</h2>
                <p className="mt-1 text-[13px] leading-5 text-theme-muted">
                  Use your Allen account to continue to the control plane.
                </p>
              </div>

              <div className="space-y-4">
                <div className="space-y-1.5">
                  <label htmlFor="login-email" className="block font-mono text-[11px] font-medium lowercase text-theme-muted">
                    email
                  </label>
                  <input
                    id="login-email"
                    type="email"
                    required
                    autoFocus
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="h-10 w-full rounded-md border border-app bg-app-muted px-3 text-[13px] text-theme-primary outline-none transition-colors placeholder:text-theme-subtle focus:border-accent focus:shadow-[var(--focus-ring)]"
                    placeholder="you@company.com"
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="login-password" className="block font-mono text-[11px] font-medium lowercase text-theme-muted">
                    password
                  </label>
                  <input
                    id="login-password"
                    type="password"
                    required
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="h-10 w-full rounded-md border border-app bg-app-muted px-3 text-[13px] text-theme-primary outline-none transition-colors placeholder:text-theme-subtle focus:border-accent focus:shadow-[var(--focus-ring)]"
                    placeholder="Enter password"
                  />
                </div>
              </div>

              {error && (
                <div className="mt-4 rounded-md border border-accent-red/25 bg-accent-red/10 px-3 py-2 text-[12px] text-accent-red">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="btn-primary mt-5 w-full justify-center"
              >
                {loading ? 'Signing in...' : 'Sign in'}
                {!loading && <ArrowRight className="h-4 w-4" />}
              </button>

              <div className="mt-4 border-t border-app pt-4 text-[11.5px] leading-5 text-theme-subtle">
                Accounts are managed by your Allen admin.
              </div>
            </form>
          </section>
        </div>
      </div>
    </main>
  );
}
