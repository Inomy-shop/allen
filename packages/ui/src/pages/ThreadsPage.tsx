import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { chat as chatApi, users as usersApi } from '../services/api';
import { useAuthStore, type AuthUser } from '../stores/authStore';

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
  { id: string; title: string; runner: string; messageCount: number; href: string; lastMessageAt?: string };

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
  const currentUser = useAuthStore((s) => s.user);
  const [chatSessions, setChatSessions] = useState<ChatSessionItem[]>([]);
  const [allUsers, setAllUsers] = useState<AuthUser[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  // Sentinel values: 'all' = no filter, 'none' = unowned, otherwise userId.
  // Defaults to the current logged-in user so people land on their own chats.
  const [selectedOwner, setSelectedOwner] = useState<string>(() => currentUser?.id ?? 'all');

  useEffect(() => {
    // If the user hydrates from localStorage after mount, snap the filter to them.
    if (currentUser?.id && selectedOwner === 'all') setSelectedOwner(currentUser.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.id]);

  useEffect(() => {
    usersApi.list().then(setAllUsers).catch(() => setAllUsers([]));
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const params = selectedOwner === 'all' ? undefined : { ownerUserId: selectedOwner as 'none' | string };
        const sessions = await chatApi.listSessions(params).catch(() => []);
        if (!cancelled) setChatSessions(sessions ?? []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    const interval = setInterval(load, 10000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [selectedOwner]);

  const filteredSessions = useMemo(() => {
    // Owner filter is applied server-side; only do client-side text search here.
    return chatSessions.filter((s) => {
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
  }, [chatSessions, query]);

  const items = useMemo(() => {
    const chatItems: ThreadItem[] = filteredSessions.map((session) => ({
      id: session._id,
      title: session.title || 'Untitled conversation',
      runner: session.ownerEmail || session.ownerName || 'Automation / Unknown',
      messageCount: session.messageCount ?? 0,
      href: `/chat/${session._id}`,
      lastMessageAt: session.lastMessageAt,
    }));

    return chatItems.sort((a, b) => new Date(b.lastMessageAt ?? 0).getTime() - new Date(a.lastMessageAt ?? 0).getTime());
  }, [filteredSessions]);

  return (
    <div className="content scroll-hide" data-screen-label="chats">
      <div className="page-head">
        <div className="ph-row">
          <div>
            <h1>Chats</h1>
            <p className="sub">Pick up where conversations left off</p>
          </div>
        </div>
      </div>

      <div className="th-search flex items-center gap-2 flex-wrap">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search conversations..."
          className="!flex-1 !max-w-[480px]"
        />
        <select
          value={selectedOwner}
          onChange={(e) => setSelectedOwner(e.target.value)}
          className="input !w-auto !min-w-[200px] !flex-none"
          aria-label="Filter by owner"
        >
          <option value="all">All users</option>
          <option value="none">Automation / Unknown</option>
          {allUsers.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name || u.email}{currentUser?.id === u.id ? ' (me)' : ''}
            </option>
          ))}
        </select>
      </div>

      <div className="th-list">
        {loading && items.length === 0 && <div className="task-empty">loading chats...</div>}
        {!loading && items.length === 0 && <div className="task-empty">no chats here</div>}
        {items.map((item) => (
          <Link key={`chat-${item.id}`} className="thread-card-row" to={item.href}>
            <div className="thread-card-main">
              <div className="thread-card-title">{item.title}</div>
              <div className="thread-card-runner">{item.runner}</div>
            </div>
            <div className="thread-card-meta">
              <span>{item.messageCount} {item.messageCount === 1 ? 'message' : 'messages'}</span>
              <span>{timeAgo(item.lastMessageAt)}</span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
