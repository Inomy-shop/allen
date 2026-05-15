import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Activity, Loader2, ShieldCheck } from 'lucide-react';
import { auth, system } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { BRAND_NAME, BRAND_TAGLINE } from '../lib/brand';

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

  return (
    <div className="min-h-screen bg-surface-50 p-4">
      <div className="mx-auto flex min-h-screen w-full max-w-5xl items-center justify-center">
        <div className="grid w-full gap-5 md:grid-cols-[minmax(0,0.9fr)_minmax(360px,440px)] md:items-center">
          <section className="space-y-5">
            <div className="flex items-center gap-2.5">
              <div className="relative">
                <Activity className="h-7 w-7 text-accent-blue" />
                <div className="absolute inset-0 rounded-full bg-accent-blue/30 blur-md" />
              </div>
              <span className="font-heading text-xl font-bold uppercase tracking-widest text-theme-primary">
                {BRAND_NAME}
              </span>
            </div>

            <div className="space-y-3">
              <p className="overline text-theme-muted">First launch</p>
              <h1 className="max-w-xl font-heading text-3xl text-theme-primary md:text-4xl">
                Create the first admin account
              </h1>
              <p className="max-w-xl text-sm leading-6 text-theme-secondary">
                This local Allen instance does not have users yet. Create the first admin here, then continue into the app.
              </p>
            </div>

            <div className="grid max-w-xl gap-3 sm:grid-cols-2">
              <div className="rounded-md border border-app bg-surface-100 p-4">
                <ShieldCheck className="mb-3 h-5 w-5 text-accent-blue" />
                <p className="text-sm font-medium text-theme-primary">First-user guarded</p>
                <p className="mt-1 text-xs leading-5 text-theme-muted">
                  Bootstrap closes automatically after the first user exists.
                </p>
              </div>
              <div className="rounded-md border border-app bg-surface-100 p-4">
                <ShieldCheck className="mb-3 h-5 w-5 text-accent-blue" />
                <p className="text-sm font-medium text-theme-primary">Local admin credentials</p>
                <p className="mt-1 text-xs leading-5 text-theme-muted">
                  Use this account to sign in and manage this Allen instance.
                </p>
              </div>
            </div>
          </section>

          <form onSubmit={handleSubmit} className="card space-y-4 p-6">
            <div>
              <h2 className="font-heading text-base text-theme-primary">Admin setup</h2>
              <p className="mt-1 text-xs text-theme-muted">{BRAND_TAGLINE}</p>
            </div>

            {checking && (
              <div className="flex items-center gap-2 rounded-md border border-app bg-surface-50 px-3 py-2 text-xs text-theme-muted">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Checking first-run status
              </div>
            )}

            <div className="space-y-2">
              <label className="block overline text-theme-muted">Name</label>
              <input
                required
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="input w-full"
                autoComplete="name"
                disabled={checking || submitting}
              />
            </div>

            <div className="space-y-2">
              <label className="block overline text-theme-muted">Email</label>
              <input
                required
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="input w-full"
                autoComplete="email"
                disabled={checking || submitting}
              />
            </div>

            <div className="space-y-2">
              <label className="block overline text-theme-muted">Password</label>
              <input
                required
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="input w-full"
                autoComplete="new-password"
                disabled={checking || submitting}
              />
              <p className="text-[11px] leading-4 text-theme-subtle">
                Minimum 8 characters with uppercase, lowercase, number, and symbol.
              </p>
            </div>

            <div className="space-y-2">
              <label className="block overline text-theme-muted">Confirm password</label>
              <input
                required
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                className="input w-full"
                autoComplete="new-password"
                disabled={checking || submitting}
              />
            </div>

            {error && (
              <div className="rounded-md border border-accent-red/30 bg-accent-red/10 px-3 py-2 text-xs text-accent-red">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={checking || submitting}
              className="btn-primary inline-flex w-full items-center justify-center gap-2"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {submitting ? 'Creating admin...' : 'Create admin account'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
