import { useState, useEffect, useRef } from 'react';
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

const SEVERITY_STYLE: Record<string, { icon: React.ElementType; color: string }> = {
  error: { icon: AlertCircle, color: 'text-accent-red' },
  warning: { icon: AlertTriangle, color: 'text-accent-yellow' },
  info: { icon: Info, color: 'text-accent-blue' },
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [alertsList, setAlerts] = useState<Alert[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);

  const loadAlerts = async () => {
    try {
      const [list, { count }] = await Promise.all([api.list(), api.count()]);
      setAlerts(list);
      setUnreadCount(count);
    } catch {}
  };

  useEffect(() => {
    loadAlerts();
    const interval = setInterval(loadAlerts, 30000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleMarkAllRead = async () => {
    await api.markAllRead();
    loadAlerts();
  };

  const handleDismiss = async (id: string) => {
    await api.dismiss(id);
    setAlerts(prev => prev.filter(a => a._id !== id));
    setUnreadCount(prev => Math.max(0, prev - 1));
  };

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => { setOpen(!open); if (!open) loadAlerts(); }}
        className="relative p-2 rounded-sm text-gray-500 hover:text-gray-300 hover:bg-surface-200/50 transition-colors"
        title="Notifications"
      >
        <Bell className="w-4 h-4" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-accent-red text-[9px] text-white font-bold flex items-center justify-center">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 bg-surface-100 border border-border/50 rounded-lg shadow-2xl overflow-hidden z-50">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border/30">
            <span className="text-xs font-label uppercase tracking-widest text-gray-400">Notifications</span>
            {unreadCount > 0 && (
              <button onClick={handleMarkAllRead} className="text-[10px] text-gray-500 hover:text-accent-blue flex items-center gap-1 transition-colors">
                <CheckCheck className="w-3 h-3" /> Mark all read
              </button>
            )}
          </div>

          <div className="max-h-80 overflow-y-auto">
            {alertsList.length === 0 && (
              <div className="px-3 py-6 text-center text-xs text-gray-600">No notifications</div>
            )}
            {alertsList.map(alert => {
              const s = SEVERITY_STYLE[alert.severity] ?? SEVERITY_STYLE.info;
              const Icon = s.icon;
              return (
                <div
                  key={alert._id}
                  className={`flex gap-2.5 px-3 py-2.5 border-b border-border/20 last:border-0 transition-colors ${alert.read ? 'opacity-60' : 'bg-surface-200/20'}`}
                >
                  <Icon className={`w-4 h-4 shrink-0 mt-0.5 ${s.color}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-white font-body truncate">{alert.title}</span>
                      <span className="text-[9px] text-gray-600 font-mono shrink-0">{timeAgo(alert.createdAt)}</span>
                    </div>
                    <div className="text-[11px] text-gray-500 font-body mt-0.5 line-clamp-2">{alert.message}</div>
                    {alert.link && (
                      <a href={alert.link} className="text-[10px] text-accent-blue hover:text-accent-blue/80 flex items-center gap-0.5 mt-1">
                        <ExternalLink className="w-2.5 h-2.5" /> View
                      </a>
                    )}
                  </div>
                  <button onClick={() => handleDismiss(alert._id)} className="shrink-0 text-gray-600 hover:text-gray-400 transition-colors">
                    <X className="w-3 h-3" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
