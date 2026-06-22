import { useState, type FormEvent } from 'react';
import { Info, KeyRound, X } from 'lucide-react';
import { auth } from '../../services/api';

interface ForgotPasswordModalProps {
  /** Prefill the email already typed on the login form, if any. */
  initialEmail?: string;
  onClose: () => void;
  /** Called after a successful reset so the login screen can prompt sign-in. */
  onResetComplete: (email: string) => void;
}

function mapResetError(code: string): string {
  switch (code) {
    case 'account_not_found':
      return 'No local account matches that email on this machine.';
    case 'desktop_runtime_only':
      return 'Local password reset is only available in the Allen desktop app.';
    case 'email and newPassword required':
    case 'email is required':
      return 'Email and a new password are required.';
    default:
      // Server password-strength messages are human-readable; pass them through.
      return code || 'Password reset failed. Please try again.';
  }
}

export default function ForgotPasswordModal({
  initialEmail = '',
  onClose,
  onResetComplete,
}: ForgotPasswordModalProps) {
  const [email, setEmail] = useState(initialEmail);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const cleanEmail = email.trim();
    if (!cleanEmail || !newPassword || !confirmPassword) {
      setError('Email, new password, and confirmation are all required.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('The new password and confirmation do not match.');
      return;
    }

    setSubmitting(true);
    try {
      await auth.desktopResetPassword(cleanEmail, newPassword);
      onResetComplete(cleanEmail);
    } catch (err) {
      setError(mapResetError((err as Error).message));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[460px] max-w-[calc(100vw-32px)] overflow-hidden rounded-md border border-app bg-app-card shadow-[0_24px_80px_rgba(0,0,0,0.34)]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="forgot-password-title"
      >
        <div className="flex items-start justify-between gap-4 border-b border-app px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-accent/25 bg-accent-soft text-accent">
              <KeyRound className="h-4 w-4" />
            </div>
            <div>
              <h2 id="forgot-password-title" className="text-[15px] font-semibold text-theme-primary">
                Reset local desktop password
              </h2>
              <p className="mt-1 text-[12px] leading-5 text-theme-muted">
                Recover access to a local account on this machine.
              </p>
            </div>
          </div>
          <button
            type="button"
            className="rounded-md p-1.5 text-theme-muted transition-colors hover:bg-app-muted hover:text-theme-primary"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4">
          <div className="flex items-start gap-2.5 rounded-md border border-accent/20 bg-accent-soft/40 px-3 py-2.5 text-[12px] leading-5 text-theme-muted">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
            <div>
              This resets the password for a local Allen account on{' '}
              <span className="font-medium text-theme-primary">this desktop machine only</span>. No
              email or one-time code is sent. Browser/web deployments do not support this reset flow.
            </div>
          </div>

          <div className="mt-4 space-y-4">
            <div className="space-y-1.5">
              <label
                htmlFor="forgot-email"
                className="block font-mono text-[11px] font-medium lowercase text-theme-muted"
              >
                account email
              </label>
              <input
                id="forgot-email"
                type="email"
                autoFocus
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-10 w-full rounded-md border border-app bg-app-muted px-3 text-[13px] text-theme-primary outline-none transition-colors placeholder:text-theme-subtle focus:border-accent focus:shadow-[var(--focus-ring)]"
                placeholder="you@company.com"
              />
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="forgot-new-password"
                className="block font-mono text-[11px] font-medium lowercase text-theme-muted"
              >
                new password
              </label>
              <input
                id="forgot-new-password"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="h-10 w-full rounded-md border border-app bg-app-muted px-3 text-[13px] text-theme-primary outline-none transition-colors placeholder:text-theme-subtle focus:border-accent focus:shadow-[var(--focus-ring)]"
                placeholder="At least 8 chars, upper, lower, number, symbol"
              />
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="forgot-confirm-password"
                className="block font-mono text-[11px] font-medium lowercase text-theme-muted"
              >
                confirm new password
              </label>
              <input
                id="forgot-confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="h-10 w-full rounded-md border border-app bg-app-muted px-3 text-[13px] text-theme-primary outline-none transition-colors placeholder:text-theme-subtle focus:border-accent focus:shadow-[var(--focus-ring)]"
                placeholder="Re-enter the new password"
              />
            </div>
          </div>

          {error && (
            <div className="mt-4 rounded-md border border-accent-red/25 bg-accent-red/10 px-3 py-2 text-[12px] text-accent-red">
              {error}
            </div>
          )}

          <div className="mt-5 flex items-center justify-end gap-2">
            <button
              type="button"
              className="btn-secondary justify-center"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>
            <button type="submit" className="btn-primary justify-center" disabled={submitting}>
              {submitting ? 'Resetting...' : 'Reset password'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
