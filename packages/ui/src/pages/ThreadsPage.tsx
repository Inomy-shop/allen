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
}

type ThreadItem =
  { id: string; title: string; subtitle: string; status: string; href: string; startedAt?: string; provider?: string };

type Tab = 'all' | 'ongoing' | 'recent' | 'history';

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
  const [tab, setTab] = useState<Tab>('all');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);

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

  const buckets = useMemo(() => {
    const chatItems: ThreadItem[] = chatSessions.map((session) => ({
      id: session._id,
      title: session.title || 'Untitled conversation',
      subtitle: `${session.messageCount ?? 0} messages · ${session.provider ?? 'assistant'} · ${timeAgo(session.lastMessageAt)}`,
      status: session.status,
      progress: 100,
      href: `/chat/${session._id}`,
      startedAt: session.lastMessageAt,
      provider: session.provider,
    }));

    const q = query.trim().toLowerCase();
    const matched = chatItems.filter((item) => {
      if (!q) return true;
      return item.id.toLowerCase().includes(q)
        || item.title.toLowerCase().includes(q)
        || item.subtitle.toLowerCase().includes(q)
        || item.status.toLowerCase().includes(q);
    }).sort((a, b) => new Date(b.startedAt ?? 0).getTime() - new Date(a.startedAt ?? 0).getTime());

    const active = matched.filter((item) => item.status === 'active');
    const archived = matched.filter((item) => item.status === 'archived');

    return {
      all: matched,
      ongoing: active,
      recent: matched.slice(0, 80),
      history: archived.length > 0 ? archived : matched.slice(80),
    };
  }, [chatSessions, query]);

  const tabs: Array<{ key: Tab; label: string; count: number }> = [
    { key: 'all', label: 'all threads', count: buckets.all.length },
    { key: 'ongoing', label: 'active', count: buckets.ongoing.length },
    { key: 'recent', label: 'recent conversations', count: buckets.recent.length },
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
              onClick={() => setTab(item.key)}
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
      </div>

      <div className="th-list">
        {loading && items.length === 0 && <div className="task-empty">loading threads...</div>}
        {!loading && items.length === 0 && <div className="task-empty">no threads here</div>}
        {items.map((item) => (
          <Link key={`chat-${item.id}`} className="th-row" to={item.href}>
            <div className="r-refs">
              <span className="r-ref linear">chat</span>
              <span className="r-ref gh">{item.id.slice(0, 8)}</span>
            </div>
            <div className="th-body">
              <div className="th-title">{item.title}</div>
              <div className="th-sub">{item.subtitle}</div>
            </div>
            <span className="chip">conversation</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
