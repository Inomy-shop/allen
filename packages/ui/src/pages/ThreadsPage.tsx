import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { chat as chatApi } from '../services/api';
import { useAuthStore } from '../stores/authStore';

// TASK-IMPL-001: added `source` field
interface ChatSessionItem {
  _id: string;
  title: string;
  status: 'active' | 'archived';
  messageCount: number;
  lastMessageAt?: string;
  provider?: string;
  model?: string;
  source?: 'ui' | 'slack' | 'automation';
}

type ThreadItem =
  { id: string; title: string; subtitle: string; status: string; href: string; startedAt?: string; provider?: string; source?: string };

type Tab = 'ongoing' | 'recent' | 'history';

// TASK-IMPL-002
export type UserFilterOption = 'all' | 'ui' | 'slack' | 'automation' | 'unknown';

// TASK-IMPL-003
/**
 * Derives the display label for a session source value.
 * Exported so it can be unit-tested independently.
 */
export function deriveUserLabel(
  source: string | undefined,
  currentUserName: string | null | undefined
): string {
  switch (source) {
    case 'ui':
      return currentUserName ?? 'UI';
    case 'slack':
      return 'Slack';
    case 'automation':
      return 'Automation';
    default:
      return 'Unknown';
  }
}

// TASK-IMPL-004
/**
 * Resolves a session's source to a UserFilterOption key.
 * Exported so it can be unit-tested independently.
 */
export function resolveFilterKey(source: string | undefined): UserFilterOption {
  if (source === 'ui' || source === 'slack' || source === 'automation') return source;
  return 'unknown';
}

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
  // TASK-IMPL-006
  const [userFilter, setUserFilter] = useState<UserFilterOption>('all');

  // TASK-IMPL-005
  const currentUser = useAuthStore((s) => s.user);

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

  // TASK-IMPL-008: extended with user-filter predicate; userFilter added to deps
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
      source: session.source,
    }));

    const q = query.trim().toLowerCase();
    const matched = chatItems.filter((item) => {
      // Free-text predicate
      if (q) {
        const textOk =
          item.id.toLowerCase().includes(q) ||
          item.title.toLowerCase().includes(q) ||
          item.subtitle.toLowerCase().includes(q) ||
          item.status.toLowerCase().includes(q);
        if (!textOk) return false;
      }
      // NEW: user-filter predicate — add after the existing q check
      if (userFilter !== 'all') {
        return resolveFilterKey(item.source) === userFilter;
      }
      return true;
    }).sort((a, b) => new Date(b.startedAt ?? 0).getTime() - new Date(a.startedAt ?? 0).getTime());

    const active = matched.filter((item) => item.status === 'active');
    const archived = matched.filter((item) => item.status === 'archived');

    return {
      ongoing: active,
      recent: matched.slice(0, 80),
      history: archived.length > 0 ? archived : matched.slice(80),
    };
  }, [chatSessions, query, userFilter]);

  // TASK-IMPL-007: derives present sources from raw chatSessions; stable order
  const userFilterOptions = useMemo<UserFilterOption[]>(() => {
    const present = new Set<UserFilterOption>();
    chatSessions.forEach((s) => present.add(resolveFilterKey(s.source)));
    // Stable display order: ui → slack → automation → unknown
    const order: UserFilterOption[] = ['ui', 'slack', 'automation', 'unknown'];
    return order.filter((opt) => present.has(opt));
  }, [chatSessions]);

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

      {/* TASK-IMPL-009: user-source filter control — between search bar and thread list */}
      {userFilterOptions.length > 0 && (
        <div className="flex items-center gap-2 px-3 pb-2">
          <select
            className="input py-1.5 text-[12px] w-auto"
            value={userFilter}
            onChange={(e) => setUserFilter(e.target.value as UserFilterOption)}
          >
            <option value="all">All Users</option>
            {userFilterOptions.map((opt) => (
              <option key={opt} value={opt}>
                {deriveUserLabel(opt, currentUser?.name)}
              </option>
            ))}
          </select>
        </div>
      )}

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
