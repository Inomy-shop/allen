import { useEffect, useState, type FormEvent } from 'react';
import { Copy, Trash2, RefreshCw, Plus, X, ShieldCheck, UserCircle2 } from 'lucide-react';
import { users as usersApi } from '../services/api';
import type { AuthUser } from '../stores/authStore';
import { useAuthStore } from '../stores/authStore';

export default function UsersAdminPage() {
  const me = useAuthStore((s) => s.user);
  const [list, setList] = useState<AuthUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [tempModal, setTempModal] = useState<{ email: string; tempPassword: string } | null>(null);

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
    if (!confirm(`Delete ${u.email}? This cannot be undone.`)) return;
    try {
      await usersApi.delete(u.id);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleResetTemp(u: AuthUser) {
    if (!confirm(`Reset ${u.email}'s password to a new temp password?`)) return;
    try {
      const res = await usersApi.resetTempPassword(u.id);
      setTempModal({ email: u.email, tempPassword: res.tempPassword });
      refresh();
    } catch (err) {
      setError((err as Error).message);
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

  const adminCount = list.filter((u) => u.role === 'admin').length;
  const pendingCount = list.filter((u) => u.mustResetPassword).length;

  return (
    <div className="space-y-6">
      {/* ─── Header ─── */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="font-heading text-xl text-theme-primary tracking-wider">Users</h1>
          <p className="text-sm text-theme-muted font-body mt-1">
            Admin-only. New users receive a temp password that must be changed on first login.
          </p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="btn btn-primary flex items-center gap-2"
        >
          <Plus className="w-4 h-4" />
          New User
        </button>
      </div>

      {/* ─── Stat cards ─── */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <StatCard label="Total Users" value={list.length} Icon={UserCircle2} accent="blue" />
        <StatCard label="Admins" value={adminCount} Icon={ShieldCheck} accent="blue" />
        <StatCard label="Pending Reset" value={pendingCount} Icon={RefreshCw} accent="yellow" />
      </div>

      {/* ─── Error banner ─── */}
      {error && (
        <div className="px-3 py-2 bg-accent-red/10 border border-accent-red/40 rounded-sm text-xs text-accent-red font-body">
          {error}
        </div>
      )}

      {/* ─── Users table ─── */}
      {loading ? (
        <div className="card p-8 text-center text-sm text-theme-subtle font-mono">Loading…</div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-app-muted/50 border-b border-app">
                <th className="text-left px-5 py-3 overline">
                  Email
                </th>
                <th className="text-left px-5 py-3 overline">
                  Name
                </th>
                <th className="text-left px-5 py-3 overline">
                  Role
                </th>
                <th className="text-left px-5 py-3 overline">
                  Status
                </th>
                <th className="text-left px-5 py-3 overline">
                  Created
                </th>
                <th className="text-left px-5 py-3 overline">
                  Last Login
                </th>
                <th className="text-right px-5 py-3 overline">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((u) => (
                <tr key={u.id} className="border-t border-app hover:bg-surface-200/20 transition-colors">
                  <td className="px-5 py-3 text-theme-primary font-body">
                    <div className="flex items-center gap-2">
                      {u.email}
                      {u.id === me?.id && (
                        <span className="text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded-sm bg-accent-blue/10 text-accent-blue border border-accent-blue/30">
                          you
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-5 py-3 text-theme-secondary font-body">{u.name}</td>
                  <td className="px-5 py-3">
                    <button
                      onClick={() => handleRoleToggle(u)}
                      disabled={u.id === me?.id}
                      className={`text-[10px] font-mono uppercase tracking-wider px-2 py-1 rounded-sm border transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
                        u.role === 'admin'
                          ? 'bg-accent-blue/10 text-accent-blue border-accent-blue/40 hover:bg-accent-blue/20'
                          : 'bg-app-muted text-theme-muted border-app hover:bg-surface-200'
                      }`}
                      title={u.id === me?.id ? 'Cannot change your own role' : 'Click to toggle role'}
                    >
                      {u.role}
                    </button>
                  </td>
                  <td className="px-5 py-3 text-xs font-mono">
                    {u.mustResetPassword ? (
                      <span className="text-accent-yellow">● must reset</span>
                    ) : (
                      <span className="text-accent-green">● active</span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-[11px] font-mono text-theme-muted">
                    {formatDate(u.createdAt)}
                  </td>
                  <td className="px-5 py-3 text-[11px] font-mono text-theme-muted">
                    {u.lastLoginAt ? formatDate(u.lastLoginAt) : '—'}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <div className="inline-flex items-center gap-1">
                      <button
                        onClick={() => handleResetTemp(u)}
                        className="p-2 rounded-sm hover:bg-app-muted text-theme-muted hover:text-accent-blue transition-colors"
                        title="Reset to temp password"
                      >
                        <RefreshCw className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(u)}
                        disabled={u.id === me?.id}
                        className="p-2 rounded-sm hover:bg-accent-red/10 text-theme-muted hover:text-accent-red transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        title={u.id === me?.id ? 'Cannot delete yourself' : 'Delete user'}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {list.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-5 py-10 text-center text-xs text-theme-subtle font-mono">
                    No users yet. Click <span className="text-accent-blue">New User</span> to invite someone.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* ─── Create user modal ─── */}
      {creating && (
        <Modal onClose={() => setCreating(false)} title="Create User">
          <form onSubmit={handleCreate} className="space-y-4">
            <Field label="Email">
              <input
                type="email"
                required
                autoFocus
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                className="w-full px-3 py-2 bg-surface-50 border border-app rounded-sm text-sm text-theme-primary font-body focus:outline-none focus:border-accent-blue"
              />
            </Field>
            <Field label="Name">
              <input
                type="text"
                required
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="w-full px-3 py-2 bg-surface-50 border border-app rounded-sm text-sm text-theme-primary font-body focus:outline-none focus:border-accent-blue"
              />
            </Field>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setCreating(false)}
                className="btn border-app text-theme-muted hover:text-theme-primary"
              >
                Cancel
              </button>
              <button type="submit" className="btn btn-primary">
                Create
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* ─── Temp password modal ─── */}
      {tempModal && (
        <Modal onClose={() => setTempModal(null)} title="Temporary Password">
          <p className="text-xs text-theme-muted mb-4 font-body leading-relaxed">
            Share this password with{' '}
            <span className="text-theme-primary font-mono">{tempModal.email}</span>. They will be
            forced to set a new password on first login. This password will{' '}
            <span className="text-accent-yellow">not be shown again</span>.
          </p>
          <div className="flex items-center gap-2 bg-surface-50 border border-app rounded-sm px-3 py-2.5">
            <code className="flex-1 text-sm font-mono text-theme-primary select-all">
              {tempModal.tempPassword}
            </code>
            <button
              onClick={() => navigator.clipboard.writeText(tempModal.tempPassword)}
              className="p-1.5 rounded-sm hover:bg-app-muted text-theme-muted hover:text-accent-blue transition-colors"
              title="Copy to clipboard"
            >
              <Copy className="w-4 h-4" />
            </button>
          </div>
          <div className="flex justify-end pt-5">
            <button onClick={() => setTempModal(null)} className="btn btn-primary">
              Done
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ── Small building blocks ─────────────────────────────────────────────── */

function StatCard({
  label,
  value,
  Icon,
  accent,
}: {
  label: string;
  value: number;
  Icon: React.ComponentType<{ className?: string }>;
  accent: 'blue' | 'yellow' | 'green';
}) {
  const accentClass = {
    blue: 'text-accent-blue bg-accent-blue/10',
    yellow: 'text-accent-yellow bg-accent-yellow/10',
    green: 'text-accent-green bg-accent-green/10',
  }[accent];
  return (
    <div className="card p-4">
      <div className="flex items-start justify-between">
        <div>
          <div className="overline">
            {label}
          </div>
          <div className="font-heading text-2xl font-bold text-theme-primary mt-2">{value}</div>
        </div>
        <div className={`w-8 h-8 rounded-sm flex items-center justify-center ${accentClass}`}>
          <Icon className="w-4 h-4" />
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block overline mb-1.5">
        {label}
      </label>
      {children}
    </div>
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
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="card p-5 w-full max-w-md bg-surface-100"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-heading text-sm font-bold text-theme-primary tracking-widest uppercase">
            {title}
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded-sm text-theme-muted hover:text-theme-primary hover:bg-app-muted transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const now = Date.now();
  const diff = now - d.getTime();
  const day = 24 * 60 * 60 * 1000;
  if (diff < day) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}
