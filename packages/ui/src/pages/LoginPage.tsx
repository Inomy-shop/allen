import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Activity } from 'lucide-react';
import { auth } from '../services/api';
import { useAuthStore } from '../stores/authStore';

export default function LoginPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const setSession = useAuthStore((s) => s.setSession);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const data = await auth.login(email, password);
      setSession(data);
      const from = params.get('from') ?? '/';
      if (data.user.mustResetPassword) {
        navigate(`/reset-password?from=${encodeURIComponent(from)}`, { replace: true });
      } else {
        navigate(from, { replace: true });
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === 'invalid_credentials') setError('Invalid email or password');
      else setError(msg || 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-50 p-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2.5 mb-8">
          <div className="relative">
            <Activity className="w-6 h-6 text-accent-blue" />
            <div className="absolute inset-0 blur-md bg-accent-blue/30 rounded-full" />
          </div>
          <span className="font-heading text-lg font-bold text-theme-primary tracking-widest uppercase">
            FlowForge
          </span>
        </div>
        <form
          onSubmit={handleSubmit}
          className="bg-surface-100 border border-border/50 rounded-lg p-6 space-y-4"
        >
          <h1 className="text-base font-heading text-theme-primary">Sign in</h1>
          <div className="space-y-2">
            <label className="block text-xs font-label uppercase tracking-wider text-theme-muted">
              Email
            </label>
            <input
              type="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 bg-surface-50 border border-border/50 rounded-md text-sm text-theme-primary focus:outline-none focus:border-accent-blue"
            />
          </div>
          <div className="space-y-2">
            <label className="block text-xs font-label uppercase tracking-wider text-theme-muted">
              Password
            </label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 bg-surface-50 border border-border/50 rounded-md text-sm text-theme-primary focus:outline-none focus:border-accent-blue"
            />
          </div>
          {error && <div className="text-xs text-accent-red">{error}</div>}
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2 rounded-md bg-accent-blue text-white text-sm font-body disabled:opacity-50"
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
          <p className="text-[11px] text-theme-subtle text-center pt-2">
            FlowForge is invite-only. Ask an admin for an account.
          </p>
        </form>
      </div>
    </div>
  );
}
