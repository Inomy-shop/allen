import { useEffect, useState, type FormEvent } from 'react';
import { Check, Copy, Trash2, RefreshCw, Plus, X, ShieldCheck, UserCircle2, KeyRound } from 'lucide-react';
import { users as usersApi } from '../services/api';
import type { AuthUser } from '../stores/authStore';
import { useAuthStore } from '../stores/authStore';

export default function UsersAdminPage() {
  const me = useAuthStore((s) => s.user);
  const [list, setList] = useState<AuthUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ type: 'reset' | 'delete'; user: AuthUser } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [tempModal, setTempModal] = useState<{ email: string; tempPassword: string } | null>(null);
  const [copiedEmail, setCopiedEmail] = useState<string | null>(null);
  const [copiedTempPassword, setCopiedTempPassword] = useState(false);

  // Create form
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');

  async function refresh() {
    setLoading(true);
    try {
      const data = await usersApi.list();
      setList(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await usersApi.create({ email: newEmail, name: newName });
      setTempModal({ email: res.user.email, tempPassword: res.tempPassword });
      setNewEmail('');
      setNewName('');
      setCreating(false);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleDelete(u: AuthUser) {
    await usersApi.delete(u.id);
    await refresh();
  }

  async function handleResetTemp(u: AuthUser) {
    const res = await usersApi.resetTempPassword(u.id);
    setTempModal({ email: u.email, tempPassword: res.tempPassword });
    await refresh();
  }

  async function handleConfirmAction() {
    if (!confirmAction) return;
    setConfirming(true);
    setError(null);
    try {
      if (confirmAction.type === 'delete') {
        await handleDelete(confirmAction.user);
      } else {
        await handleResetTemp(confirmAction.user);
      }
      setConfirmAction(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setConfirming(false);
    }
  }

  async function handleRoleToggle(u: AuthUser) {
    const next = u.role === 'admin' ? 'user' : 'admin';
    try {
      await usersApi.update(u.id, { role: next });
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleCopyEmail(email: string) {
    const copied = await copyText(email);
    if (!copied) return;
    setCopiedEmail(email);
    window.setTimeout(() => setCopiedEmail((current) => (current === email ? null : current)), 1200);
  }

  async function handleCopyTempPassword(password: string) {
    const copied = await copyText(password);
    if (!copied) return;
    setCopiedTempPassword(true);
    window.setTimeout(() => setCopiedTempPassword(false), 1200);
  }

  const adminCount = list.filter((u) => u.role === 'admin').length;
  const pendingCount = list.filter((u) => u.mustResetPassword).length;

  return (
    <div className="space-y-4">
      {/* ─── Header ─── */}
      <div className="rounded-lg border border-app bg-app-card px-4 py-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-[13px] font-semibold text-theme-primary">Access management</h2>
            <p className="mt-1 max-w-2xl text-[12px] leading-5 text-theme-muted">
              New users receive a temporary password and must change it on first login.
            </p>
          </div>
          <button
            onClick={() => setCreating(true)}
            className="inline-flex h-8 shrink-0 items-center gap-2 rounded-md border border-accent/40 bg-accent px-3 text-[12px] font-medium text-white transition-colors hover:bg-accent-hover"
          >
            <Plus className="h-3.5 w-3.5" />
            New user
          </button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-app pt-3">
          <StatPill label="Total users" value={list.length} Icon={UserCircle2} />
          <StatPill label="Admins" value={adminCount} Icon={ShieldCheck} />
          <StatPill
            label="Pending reset"
            value={pendingCount}
            Icon={KeyRound}
            tone={pendingCount > 0 ? 'warning' : 'default'}
          />
        </div>
      </div>

      {/* ─── Error banner ─── */}
      {error && (
        <div className="rounded-md border border-accent-red/30 bg-accent-red/10 px-3 py-2 text-[12px] text-accent-red">
          {error}
        </div>
      )}

      {/* ─── Users table ─── */}
      {loading ? (
        <div className="rounded-lg border border-app bg-app-card p-8 text-center font-mono text-[12px] text-theme-subtle">Loading...</div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-app bg-app-card [&_td:first-child]:!pl-5 [&_td:last-child]:!pr-5 [&_th:first-child]:!pl-5 [&_th:last-child]:!pr-5">
          <table className="w-full table-fixed text-sm">
            <colgroup>
              <col className="w-[30%]" />
              <col className="w-[20%]" />
              <col className="w-[9%]" />
              <col className="w-[11%]" />
              <col className="w-[20%]" />
              <col className="w-[10%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-app bg-app-muted/45">
                <th className="px-4 py-2.5 text-left text-[11px] font-medium text-theme-muted">
                  Email
                </th>
                <th className="px-4 py-2.5 text-left text-[11px] font-medium text-theme-muted">
                  Name
                </th>
                <th className="px-4 py-2.5 text-left text-[11px] font-medium text-theme-muted">
                  Role
                </th>
                <th className="px-4 py-2.5 text-left text-[11px] font-medium text-theme-muted">
                  Status
                </th>
                <th className="px-4 py-2.5 text-left text-[11px] font-medium text-theme-muted">
                  Created
                </th>
                <th className="px-4 py-2.5 text-right text-[11px] font-medium text-theme-muted">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((u) => (
                <tr key={u.id} className="border-t border-app transition-colors hover:bg-app-muted/35">
                  <td className="px-4 py-3.5 font-body text-theme-primary">
                    <div className="flex min-w-0 items-center gap-2">
                      <button
                        onClick={() => void handleCopyEmail(u.email)}
                        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-theme-muted transition-colors hover:bg-app-muted hover:text-accent-blue"
                        title={copiedEmail === u.email ? 'Copied' : `Copy ${u.email}`}
                        aria-label={`Copy email ${u.email}`}
                      >
                        {copiedEmail === u.email ? (
                          <Check className="h-3.5 w-3.5 text-accent-green" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </button>
                      <span className="truncate">{u.email}</span>
                      {u.id === me?.id && (
                        <span className="rounded-sm border border-accent-blue/30 bg-accent-blue/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-accent-blue">
                          you
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3.5 font-body text-theme-secondary">
                    <span className="block truncate">{u.name}</span>
                  </td>
                  <td className="px-4 py-3.5">
                    <button
                      onClick={() => handleRoleToggle(u)}
                      disabled={u.id === me?.id}
                      className={`rounded-sm border px-2 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                        u.role === 'admin'
                          ? 'bg-accent-blue/10 text-accent-blue border-accent-blue/40 hover:bg-accent-blue/20'
                          : 'bg-app-muted text-theme-muted border-app hover:bg-surface-200'
                      }`}
                      title={u.id === me?.id ? 'Cannot change your own role' : 'Click to toggle role'}
                    >
                      {u.role}
                    </button>
                  </td>
                  <td className="px-4 py-3.5 font-mono text-[11px]">
                    {u.mustResetPassword ? (
                      <span className="inline-flex items-center gap-1.5 text-accent-yellow">
                        <span className="h-1.5 w-1.5 rounded-full bg-accent-yellow" />
                        Reset
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-accent-green">
                        <span className="h-1.5 w-1.5 rounded-full bg-accent-green" />
                        Active
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3.5 font-mono text-[11px] text-theme-muted">
                    <span className="block truncate">{formatDateTime(u.createdAt)}</span>
                  </td>
                  <td className="px-4 py-3.5 text-right">
                    <div className="inline-flex items-center justify-end gap-1 rounded-md border border-app bg-app-muted/30 p-0.5">
                      <button
                        onClick={() => setConfirmAction({ type: 'reset', user: u })}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-sm text-theme-muted transition-colors hover:bg-app-card hover:text-accent-blue"
                        title="Reset to temp password"
                        aria-label={`Reset temporary password for ${u.email}`}
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => setConfirmAction({ type: 'delete', user: u })}
                        disabled={u.id === me?.id}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-sm text-theme-muted transition-colors hover:bg-accent-red/10 hover:text-accent-red disabled:cursor-not-allowed disabled:opacity-40"
                        title={u.id === me?.id ? 'Cannot delete yourself' : 'Delete user'}
                        aria-label={`Delete ${u.email}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {list.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-5 py-10 text-center font-mono text-[12px] text-theme-subtle">
                    No users yet. Click <span className="text-accent-blue">New user</span> to invite someone.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* ─── Create user modal ─── */}
      {creating && (
        <Modal onClose={() => setCreating(false)} title="Create user">
          <form onSubmit={handleCreate} className="space-y-4">
            <Field label="Email">
              <input
                type="email"
                required
                autoFocus
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                className="h-10 w-full rounded-md border border-app bg-app px-3 text-[13px] text-theme-primary outline-none transition-colors placeholder:text-theme-subtle focus:border-accent focus:ring-2 focus:ring-accent/15"
              />
            </Field>
            <Field label="Name">
              <input
                type="text"
                required
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="h-10 w-full rounded-md border border-app bg-app px-3 text-[13px] text-theme-primary outline-none transition-colors placeholder:text-theme-subtle focus:border-accent focus:ring-2 focus:ring-accent/15"
              />
            </Field>
            <div className="flex justify-end gap-2 border-t border-app pt-4">
              <button
                type="button"
                onClick={() => setCreating(false)}
                className="inline-flex h-9 items-center justify-center rounded-md border border-app bg-app-card px-3 text-[13px] font-medium text-theme-secondary transition-colors hover:bg-app-muted hover:text-theme-primary"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="inline-flex h-9 items-center justify-center rounded-md border border-accent/40 bg-accent px-3.5 text-[13px] font-medium text-white transition-colors hover:bg-accent-hover"
              >
                Create
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* ─── Temp password modal ─── */}
      {tempModal && (
        <Modal onClose={() => setTempModal(null)} title="Temporary password">
          <p className="mb-4 text-[12px] leading-5 text-theme-muted">
            Share this password with{' '}
            <span className="text-theme-primary font-mono">{tempModal.email}</span>. They will be
            forced to set a new password on first login. This password will{' '}
            <span className="text-accent-yellow">not be shown again</span>.
          </p>
          <div className="flex items-center gap-2 rounded-md border border-app bg-app px-3 py-2.5">
            <code className="flex-1 select-all font-mono text-[13px] text-theme-primary">
              {tempModal.tempPassword}
            </code>
            <button
              onClick={() => void handleCopyTempPassword(tempModal.tempPassword)}
              className="rounded-md p-1.5 text-theme-muted transition-colors hover:bg-app-muted hover:text-accent-blue"
              title={copiedTempPassword ? 'Copied' : 'Copy to clipboard'}
            >
              {copiedTempPassword ? (
                <Check className="h-4 w-4 text-accent-green" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </button>
          </div>
          <div className="flex justify-end border-t border-app pt-4">
            <button
              onClick={() => setTempModal(null)}
              className="inline-flex h-9 items-center justify-center rounded-md border border-accent/40 bg-accent px-3.5 text-[13px] font-medium text-white transition-colors hover:bg-accent-hover"
            >
              Done
            </button>
          </div>
        </Modal>
      )}

      {confirmAction && (
        <ConfirmActionModal
          action={confirmAction.type}
          busy={confirming}
          user={confirmAction.user}
          onCancel={() => {
            if (!confirming) setConfirmAction(null);
          }}
          onConfirm={() => void handleConfirmAction()}
        />
      )}
    </div>
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (window.allenDesktop?.writeClipboardText) {
      return await window.allenDesktop.writeClipboardText(text);
    }
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/* ── Small building blocks ─────────────────────────────────────────────── */

function StatPill({
  label,
  value,
  Icon,
  tone = 'default',
}: {
  label: string;
  value: number;
  Icon: React.ComponentType<{ className?: string }>;
  tone?: 'default' | 'warning';
}) {
  const toneClass = tone === 'warning'
    ? 'border-accent-yellow/25 bg-accent-yellow/10 text-accent-yellow'
    : 'border-app bg-app-muted/35 text-theme-secondary';
  return (
    <div className={`inline-flex h-7 items-center gap-2 rounded-md border px-2.5 ${toneClass}`}>
      <Icon className="h-3.5 w-3.5" />
      <span className="text-[12px] font-medium text-theme-primary">{value}</span>
      <span className="text-[11px] text-theme-muted">{label}</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-[12px] font-medium text-theme-secondary">
        {label}
      </label>
      {children}
    </div>
  );
}

function ConfirmActionModal({
  action,
  busy,
  user,
  onCancel,
  onConfirm,
}: {
  action: 'reset' | 'delete';
  busy: boolean;
  user: AuthUser;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const isDelete = action === 'delete';
  const title = isDelete ? 'Delete user' : 'Reset password';
  const message = isDelete
    ? 'This removes the account from Allen. The user will lose access immediately.'
    : 'Allen will generate a new temporary password. The user must change it on the next login.';
  const confirmLabel = busy
    ? (isDelete ? 'Deleting...' : 'Resetting...')
    : (isDelete ? 'Delete user' : 'Reset password');

  return (
    <Modal onClose={onCancel} title={title}>
      <div className="flex gap-3">
        <div
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md border ${
            isDelete
              ? 'border-accent-red/30 bg-accent-red/10 text-accent-red'
              : 'border-accent-blue/30 bg-accent-blue/10 text-accent-blue'
          }`}
        >
          {isDelete ? <Trash2 className="h-4 w-4" /> : <RefreshCw className="h-4 w-4" />}
        </div>
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-theme-primary">{user.email}</p>
          <p className="mt-1 text-[12px] leading-5 text-theme-muted">{message}</p>
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2 border-t border-app pt-4">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="inline-flex h-9 items-center justify-center rounded-md border border-app bg-app-card px-3 text-[13px] font-medium text-theme-secondary transition-colors hover:bg-app-muted hover:text-theme-primary disabled:cursor-not-allowed disabled:opacity-60"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className={`inline-flex h-9 items-center justify-center gap-2 rounded-md border px-3.5 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-70 ${
            isDelete
              ? 'border-accent-red/35 bg-accent-red px-3.5 text-white hover:bg-accent-red/90'
              : 'border-accent/40 bg-accent text-white hover:bg-accent-hover'
          }`}
        >
          {isDelete ? <Trash2 className="h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5" />}
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

function Modal({
  children,
  onClose,
  title,
}: {
  children: React.ReactNode;
  onClose: () => void;
  title: string;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-app bg-app-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-app px-5 py-4">
          <h2 className="text-[15px] font-semibold text-theme-primary">
            {title}
          </h2>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-theme-muted transition-colors hover:bg-app-muted hover:text-theme-primary"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}
