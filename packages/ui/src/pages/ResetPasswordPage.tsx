import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { auth } from '../services/api';
import { useAuthStore } from '../stores/authStore';

function validate(pw: string): string | null {
  if (pw.length < 8) return 'At least 8 characters';
  if (!/[A-Z]/.test(pw)) return 'At least one uppercase letter';
  if (!/[a-z]/.test(pw)) return 'At least one lowercase letter';
  if (!/[0-9]/.test(pw)) return 'At least one number';
  if (!/[^A-Za-z0-9]/.test(pw)) return 'At least one symbol';
  return null;
}

export default function ResetPasswordPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const setSession = useAuthStore((s) => s.setSession);
  const user = useAuthStore((s) => s.user);
  const forced = user?.mustResetPassword ?? false;

  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirm) {
      setError('Passwords do not match');
      return;
    }
    const v = validate(newPassword);
    if (v) {
      setError(v);
      return;
    }
    if (currentPassword === newPassword) {
      setError('New password must differ from current');
      return;
    }
    setLoading(true);
    try {
      const data = await auth.resetPassword(currentPassword, newPassword);
      setSession(data);
      const from = params.get('from') ?? '/';
      navigate(from, { replace: true });
    } catch (err) {
      setError((err as Error).message || 'Reset failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-app p-4 text-theme-primary">
      <div className="w-full max-w-sm">
        <form
          onSubmit={handleSubmit}
          className="space-y-4 rounded-md border border-app bg-app-card p-6 shadow-sm"
        >
          <div>
            <h1 className="text-base font-heading text-theme-primary">
              {forced ? 'Set your password' : 'Change password'}
            </h1>
            {forced && (
              <p className="text-[11px] text-theme-muted mt-1">
                You must set a new password before continuing.
              </p>
            )}
          </div>
          <div className="space-y-2">
            <label className="block overline text-theme-muted">
              Current password
            </label>
            <input
              type="password"
              required
              autoFocus
              value={currentPassword}
              onChange={(e) => setCurrent(e.target.value)}
              className="w-full rounded-md border border-app bg-app-muted px-3 py-2 text-sm text-theme-primary outline-none transition-colors focus:border-accent focus:shadow-[var(--focus-ring)]"
            />
          </div>
          <div className="space-y-2">
            <label className="block overline text-theme-muted">
              New password
            </label>
            <input
              type="password"
              required
              value={newPassword}
              onChange={(e) => setNew(e.target.value)}
              className="w-full rounded-md border border-app bg-app-muted px-3 py-2 text-sm text-theme-primary outline-none transition-colors focus:border-accent focus:shadow-[var(--focus-ring)]"
            />
            <p className="text-[10px] text-theme-subtle">
              Min 8 chars, with uppercase, lowercase, number, and symbol.
            </p>
          </div>
          <div className="space-y-2">
            <label className="block overline text-theme-muted">
              Confirm new password
            </label>
            <input
              type="password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="w-full rounded-md border border-app bg-app-muted px-3 py-2 text-sm text-theme-primary outline-none transition-colors focus:border-accent focus:shadow-[var(--focus-ring)]"
            />
          </div>
          {error && <div className="text-xs text-accent-red">{error}</div>}
          <button
            type="submit"
            disabled={loading}
            className="btn-primary w-full justify-center"
          >
            {loading ? 'Saving...' : 'Save password'}
          </button>
        </form>
      </div>
    </div>
  );
}
