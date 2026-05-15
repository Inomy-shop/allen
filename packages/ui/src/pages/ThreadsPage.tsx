import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { chat as chatApi } from '../services/api';

interface ChatSessionItem {
  _id: string;
  title: string;
  status: 'active' | 'archived';
  messageCount: number;
  lastMessageAt?: string;
  provider?: string;
  model?: string;
  ownerUserId?: string | null;
  ownerName?: string | null;
  ownerEmail?: string | null;
}

type ThreadItem =
  { id: string; title: string; subtitle: string; status: string; href: string; startedAt?: string; provider?: string };

type Tab = 'ongoing' | 'recent' | 'history';

function timeAgo(dateStr?: string): string {
  if (!dateStr) return 'recently';
  const ms = Date.now() - new Date(dateStr).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

export default function ThreadsPage() {
  const [chatSessions, setChatSessions] = useState<ChatSessionItem[]>([]);
  const [tab, setTab] = useState<Tab>('ongoing');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectedOwner, setSelectedOwner] = useState<string>('all');

  async function load() {
    setLoading(true);
    try {
      const sessions = await chatApi.listSessions().catch(() => []);
      setChatSessions(sessions ?? []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, []);

  const owners = useMemo(() => {
    const map = new Map<string, { label: string; email: string | null }>();
    chatSessions.forEach((s) => {
      const key = s.ownerUserId ?? '__none__';
      if (!map.has(key)) {
        const label = s.ownerName || s.ownerEmail || 'Automation / Unknown';
        map.set(key, { label, email: s.ownerEmail ?? null });
      }
    });
    return Array.from(map.entries()).map(([key, val]) => ({ key, ...val }));
  }, [chatSessions]);

  const filteredSessions = useMemo(() => {
    return chatSessions
      .filter((s) => {
        if (selectedOwner === 'all') return true;
        if (selectedOwner === '__none__') return !s.ownerUserId;
        return s.ownerUserId === selectedOwner;
      })
      .filter((s) => {
        if (!query.trim()) return true;
        const q = query.toLowerCase();
        return (
          s._id.toLowerCase().includes(q) ||
          (s.title?.toLowerCase().includes(q) ?? false) ||
          (s.status?.toLowerCase().includes(q) ?? false) ||
          (s.provider?.toLowerCase().includes(q) ?? false) ||
          (s.model?.toLowerCase().includes(q) ?? false) ||
          (s.ownerName?.toLowerCase().includes(q) ?? false) ||
          (s.ownerEmail?.toLowerCase().includes(q) ?? false)
        );
      });
  }, [chatSessions, query, selectedOwner]);

  const buckets = useMemo(() => {
    const chatItems: ThreadItem[] = filteredSessions.map((session) => ({
      id: session._id,
      title: session.title || 'Untitled conversation',
      subtitle: `${session.messageCount ?? 0} messages · ${session.provider ?? 'assistant'} · ${timeAgo(session.lastMessageAt)}`,
      status: session.status,
      progress: 100,
      href: `/chat/${session._id}`,
      startedAt: session.lastMessageAt,
      provider: session.provider,
    }));

    const sorted = chatItems.sort((a, b) => new Date(b.startedAt ?? 0).getTime() - new Date(a.startedAt ?? 0).getTime());

    const active = sorted.filter((item) => item.status === 'active');
    const archived = sorted.filter((item) => item.status === 'archived');

    return {
      ongoing: active,
      recent: sorted.slice(0, 80),
      history: archived.length > 0 ? archived : sorted.slice(80),
    };
  }, [filteredSessions]);

  const tabs: Array<{ key: Tab; label: string; count: number }> = [
    { key: 'ongoing', label: 'ongoing', count: buckets.ongoing.length },
    { key: 'recent', label: 'recently completed', count: buckets.recent.length },
    { key: 'history', label: 'history', count: buckets.history.length },
  ];
  const items = buckets[tab];

  return (
    <div className="content scroll-hide" data-screen-label="threads">
      <div className="page-head">
        <div className="ph-row">
          <div>
            <h1>threads</h1>
            <p className="sub">every conversation with allen, with what came of it</p>
          </div>
        </div>
        <nav className="topfilter-tabs mt-3">
          {tabs.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`tft ${tab === item.key ? 'active' : ''}`}
              onClick={() => { setTab(item.key); setSelectedOwner('all'); }}
            >
              {item.label} <span className="tft-ct">{item.count}</span>
            </button>
          ))}
        </nav>
      </div>

      <div className="th-search">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="search threads / tickets..."
        />
        {owners.length > 1 && (
          <select
            value={selectedOwner}
            onChange={(e) => setSelectedOwner(e.target.value)}
            className="owner-filter-select"
            aria-label="Filter by owner"
            style={{ marginLeft: '8px', padding: '4px 8px', borderRadius: '4px', border: '1px solid var(--border, #e2e8f0)', background: 'var(--surface, #fff)', color: 'var(--text, inherit)', fontSize: 'inherit', cursor: 'pointer' }}
          >
            <option value="all">All owners</option>
            {owners.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="th-list">
        {loading && items.length === 0 && <div className="task-empty">loading threads...</div>}
        {!loading && items.length === 0 && <div className="task-empty">no threads here</div>}
        {items.map((item) => (
          <Link key={`chat-${item.id}`} className="th-row th-row-chat" to={item.href}>
            <div className="r-refs">
              <span className="r-ref linear">chat</span>
              <span className="r-ref gh">{item.id.slice(0, 8)}</span>
            </div>
            <div className="th-body">
              <div className="th-title">{item.title}</div>
              <div className="th-sub">{item.subtitle}</div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
