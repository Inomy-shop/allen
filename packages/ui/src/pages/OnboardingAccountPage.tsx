import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Loader2 } from 'lucide-react';
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

function passwordScore(password: string): number {
  let score = 0;
  if (password.length >= 8) score += 1;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
  if (/\d/.test(password)) score += 1;
  if (/[^A-Za-z0-9]/.test(password)) score += 1;
  return score;
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
  const runtimeCopy = 'about 3 minutes to your first run';
  const strength = passwordScore(password);
  const passwordsMatch = confirmPassword.length > 0 && password === confirmPassword;

  return (
    <OnboardingShell
      step="account"
      eyebrow="allen setup"
      title="Your engineering org, run by agents."
      description="Allen coordinates AI agents that plan, code, review, test, and ship against your repositories. Create the first admin to begin."
      runtimeLabel={runtimeLabel}
      runtimeCopy={runtimeCopy}
    >
      <form onSubmit={handleSubmit} className="ob-card">
        <div className="ob-card__head">
          <div>
            <h2>Create the first admin account</h2>
            <p className="sub">This account manages users, repositories, and providers on this Allen instance.</p>
          </div>
        </div>

        {checking && (
          <div className="ob-notice">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Checking first-run status
          </div>
        )}

        <div className="ob-f">
            <label htmlFor="onboarding-name">name</label>
            <input
              id="onboarding-name"
              required
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="ob-in"
              autoComplete="name"
              disabled={checking || submitting}
              placeholder="Elena Jones"
            />
        </div>

        <div className="ob-f">
            <label htmlFor="onboarding-email">email</label>
            <input
              id="onboarding-email"
              required
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="ob-in"
              autoComplete="email"
              disabled={checking || submitting}
              placeholder="you@company.com"
            />
        </div>

        <div className="ob-2col">
          <div className="ob-f">
            <label htmlFor="onboarding-password">password</label>
            <input
              id="onboarding-password"
              required
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="ob-in"
              autoComplete="new-password"
              disabled={checking || submitting}
              placeholder="Create password"
            />
            <div className={`ob-meter s${strength}`} aria-hidden="true"><i /><i /><i /><i /></div>
            <p className="ob-hint">
              8+ characters with <b>upper</b>, <b>lower</b>, <b>number</b>, <b>symbol</b>.
            </p>
          </div>

          <div className="ob-f">
            <label htmlFor="onboarding-confirm-password">confirm password</label>
            <input
              id="onboarding-confirm-password"
              required
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              className="ob-in"
              autoComplete="new-password"
              disabled={checking || submitting}
              placeholder="Repeat password"
            />
            <p className={`ob-hint ${confirmPassword && !passwordsMatch ? 'err' : ''}`}>
              {confirmPassword ? (passwordsMatch ? 'Passwords match.' : 'Passwords do not match') : '\u00a0'}
            </p>
          </div>
        </div>

        {error && (
          <div className="ob-error">
            {error}
          </div>
        )}

        <div className="ob-actions">
          <span className="sp" />
          <button type="submit" disabled={checking || submitting} className="ob-action-primary">
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {submitting ? 'Creating admin...' : 'Create admin account'}
            {!submitting && <ArrowRight />}
          </button>
        </div>
      </form>
      <button type="button" onClick={() => navigate('/login')} className="ob-skip">
        An admin already exists? Sign in instead
      </button>
    </OnboardingShell>
  );
}
