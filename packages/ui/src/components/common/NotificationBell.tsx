import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Bell, X, CheckCheck, AlertCircle, AlertTriangle, Info, ExternalLink } from 'lucide-react';
import { alerts as api } from '../../services/api';

interface Alert {
  _id: string;
  title: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
  category: string;
  read: boolean;
  link?: string;
  createdAt: string;
}

const SEVERITY: Record<string, { icon: React.ElementType; color: string; bg: string }> = {
  error: { icon: AlertCircle, color: 'text-accent-red', bg: 'bg-accent-red/5 border-accent-red/20' },
  warning: { icon: AlertTriangle, color: 'text-accent-yellow', bg: 'bg-accent-yellow/5 border-accent-yellow/20' },
  info: { icon: Info, color: 'text-accent-blue', bg: 'bg-accent-blue/5 border-accent-blue/20' },
};

const DROPDOWN_WIDTH = 320;
const DROPDOWN_MAX_HEIGHT = 360;
const VIEWPORT_GAP = 12;

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [alertsList, setAlerts] = useState<Alert[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const loadCount = async () => {
    try {
      const { count } = await api.count();
      setUnreadCount(count);
    } catch {}
  };

  const loadAlerts = async () => {
    try {
      const [list, { count }] = await Promise.all([api.list(), api.count()]);
      setAlerts(list);
      setUnreadCount(count);
    } catch {}
  };

  useEffect(() => {
    loadCount();
    const interval = setInterval(loadCount, 30000);
    return () => clearInterval(interval);
  }, []);

  const handleMarkAllRead = async () => { await api.markAllRead(); loadAlerts(); };
  const handleDismiss = async (id: string) => {
    await api.dismiss(id);
    setAlerts(prev => prev.filter(a => a._id !== id));
    setUnreadCount(prev => Math.max(0, prev - 1));
  };

  // Get button position for portal dropdown
  const rect = buttonRef.current?.getBoundingClientRect();
  const dropdownStyle = rect
    ? {
        left: Math.min(
          Math.max(rect.right - DROPDOWN_WIDTH, VIEWPORT_GAP),
          window.innerWidth - DROPDOWN_WIDTH - VIEWPORT_GAP,
        ),
        top: Math.min(
          rect.bottom + 8,
          window.innerHeight - DROPDOWN_MAX_HEIGHT - VIEWPORT_GAP,
        ),
        maxHeight: DROPDOWN_MAX_HEIGHT,
      }
    : undefined;

  return (
    <>
      <button
        ref={buttonRef}
        onClick={() => { setOpen(!open); if (!open) loadAlerts(); }}
        className={`foot-btn topbar-icon-btn relative ${open ? 'is-active' : ''}`}
        title="Notifications"
        aria-label="Notifications"
        aria-expanded={open}
      >
        <Bell className="w-4 h-4" />
        {unreadCount > 0 && (
          <span className="topbar-notification-count">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && rect && dropdownStyle && createPortal(
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />

          {/* Dropdown */}
          <div
            className="fixed z-50 w-80 overflow-hidden rounded-md border border-app bg-app-card shadow-popover"
            style={dropdownStyle}
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-app bg-app-muted px-4 py-2.5">
              <div className="flex items-center gap-2">
                <Bell className="w-3.5 h-3.5 text-accent" />
                <span className="text-xs font-heading text-theme-primary">Notifications</span>
                {unreadCount > 0 && (
                  <span className="rounded-full bg-accent-soft px-1.5 py-0.5 font-mono text-[9px] text-accent">{unreadCount}</span>
                )}
              </div>
              {unreadCount > 0 && (
                <button onClick={handleMarkAllRead} className="flex items-center gap-1 text-[10px] text-theme-muted transition-colors hover:text-accent" title="Mark all as read">
                  <CheckCheck className="w-3 h-3" /> Read all
                </button>
              )}
            </div>

            {/* Alert list */}
            <div className="max-h-80 overflow-y-auto">
              {alertsList.length === 0 && (
                <div className="px-4 py-8 text-center">
                  <Bell className="w-6 h-6 text-theme-subtle mx-auto mb-2" />
                  <span className="text-xs text-theme-subtle font-body">No notifications</span>
                </div>
              )}
              {alertsList.map(alert => {
                const s = SEVERITY[alert.severity] ?? SEVERITY.info;
                const Icon = s.icon;
                return (
                  <div
                    key={alert._id}
                    className={`group flex gap-3 px-4 py-3 border-b border-border/10 last:border-0 transition-all ${
                      alert.read ? 'opacity-50 hover:opacity-80' : 'hover:bg-surface-200/20'
                    }`}
                  >
                    <div className={`shrink-0 w-7 h-7 rounded-md border flex items-center justify-center ${s.bg}`}>
                      <Icon className={`w-3.5 h-3.5 ${s.color}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-theme-primary font-body truncate flex-1">{alert.title}</span>
                        <span className="text-[9px] text-theme-subtle font-mono shrink-0">{timeAgo(alert.createdAt)}</span>
                      </div>
                      <div className="text-[11px] text-theme-muted font-body mt-0.5 line-clamp-2">{alert.message}</div>
                      {alert.link && (
                        <a href={alert.link} onClick={() => setOpen(false)} className="mt-1.5 inline-flex items-center gap-1 text-[10px] text-accent transition-colors hover:text-accent-hover">
                          <ExternalLink className="w-2.5 h-2.5" /> View details
                        </a>
                      )}
                    </div>
                    <button
                      onClick={() => handleDismiss(alert._id)}
                      className="shrink-0 opacity-0 group-hover:opacity-100 text-theme-subtle hover:text-theme-secondary transition-all p-0.5"
                      title="Dismiss"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
