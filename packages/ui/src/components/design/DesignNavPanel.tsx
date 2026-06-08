import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, Search, Palette } from 'lucide-react';
import { chat as chatApi } from '../../services/api';

interface DesignNavPanelProps {
  activeSessionId?: string | null;
  onBack: () => void;
}

export default function DesignNavPanel({ activeSessionId, onBack }: DesignNavPanelProps) {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const all = await chatApi.listSessions();
        if (!cancelled) {
          setSessions((all ?? []).filter((s: any) => s.activeAgent === 'design-assistant'));
        }
      } catch {}
      finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    const interval = setInterval(() => { void load(); }, 15000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const filtered = query.trim()
    ? sessions.filter(s => (s.title ?? '').toLowerCase().includes(query.toLowerCase()))
    : sessions;

  function timeAgo(dateStr: string): string {
    if (!dateStr) return '';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'now';
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    return `${Math.floor(hrs / 24)}d`;
  }

  return (
    <div className="sidebar-inner scroll-hide flex flex-col">
      {/* Header with back button */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-app">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 text-[12px] text-theme-muted hover:text-theme-primary transition-colors"
          title="Back to main navigation"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <span>Back</span>
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => navigate('/design')}
          className="flex h-6 w-6 items-center justify-center rounded text-theme-muted hover:text-accent hover:bg-app-muted transition-colors"
          title="New design"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Title */}
      <div className="flex items-center gap-2 px-3 py-2">
        <Palette className="h-3.5 w-3.5 text-theme-muted" />
        <span className="text-[12.5px] font-medium text-theme-secondary">Design history</span>
      </div>

      {/* Search */}
      <div className="px-2 pb-1">
        <div className="relative">
          <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-theme-muted pointer-events-none" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search designs…"
            className="input pl-8 pr-3 py-1.5 w-full text-[12px]"
          />
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-1.5 py-1 space-y-0.5">
        {loading && (
          <div className="px-3 py-4 text-center text-[12px] text-theme-subtle animate-pulse">Loading…</div>
        )}
        {!loading && sessions.length === 0 && (
          <div className="px-3 py-4 text-center text-[12px] text-theme-subtle">No design conversations yet.</div>
        )}
        {!loading && sessions.length > 0 && filtered.length === 0 && (
          <div className="px-3 py-4 text-center text-[12px] text-theme-subtle">No matches.</div>
        )}
        {filtered.map((s) => {
          const isActive = s._id === activeSessionId;
          return (
            <button
              key={s._id}
              type="button"
              onClick={() => navigate(`/design/${s._id}`)}
              className={`nav-item w-full text-left flex flex-col gap-0 items-start ${isActive ? 'active' : ''}`}
              title={s.title}
            >
              <span className="lbl truncate">{s.title || 'Untitled design'}</span>
              <span className="text-[10px] text-theme-subtle font-normal">{timeAgo(s.lastMessageAt)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
