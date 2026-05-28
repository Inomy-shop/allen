import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, FolderGit2, GitBranch, ListFilter, MessageSquare, Search, UserRound } from 'lucide-react';
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
  repoId?: string;
  repoPath?: string;
  repoName?: string;
  workspaceId?: string;
  workspaceName?: string;
  workspaceRepoName?: string;
  archivedWorkspace?: {
    id: string;
    name?: string;
    repoId?: string;
    repoName?: string;
    repoPath?: string;
    branch?: string;
    baseBranch?: string;
    prNumber?: number;
    prUrl?: string;
    archivedAt?: string;
  };
  ownerUserId?: string | null;
  ownerName?: string | null;
  ownerEmail?: string | null;
}

type ThreadItem =
  {
    id: string;
    title: string;
    runner: string;
    messageCount: number;
    href: string;
    lastMessageAt?: string;
    provider?: string;
    model?: string;
    context?: {
      kind: 'workspace' | 'repo';
      label: string;
      detail?: string;
    };
  };

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

function shortId(id?: string): string {
  return id ? id.slice(0, 8) : '';
}

function pathName(path?: string): string {
  if (!path) return '';
  return path.split('/').filter(Boolean).pop() ?? path;
}

function sessionContext(session: ChatSessionItem): ThreadItem['context'] {
  if (session.archivedWorkspace) {
    const ws = session.archivedWorkspace;
    return {
      kind: 'workspace',
      label: ws.name || ws.branch || `Workspace ${shortId(ws.id)}`,
      detail: ws.repoName,
    };
  }
  if (session.workspaceId) {
    return {
      kind: 'workspace',
      label: session.workspaceName || `Workspace ${shortId(session.workspaceId)}`,
      detail: session.workspaceRepoName,
    };
  }
  if (session.repoName || session.repoPath || session.repoId) {
    return {
      kind: 'repo',
      label: session.repoName || pathName(session.repoPath) || `Repository ${shortId(session.repoId)}`,
    };
  }
  return undefined;
}

function providerLabel(provider?: string, model?: string): string {
  const prettyProvider = provider === 'claude-cli'
    ? 'Claude'
    : provider === 'codex'
      ? 'Codex'
      : provider;
  return [prettyProvider, model].filter(Boolean).join(' / ');
}

export default function ThreadsPage() {
  const currentUser = useAuthStore((s) => s.user);
  const [chatSessions, setChatSessions] = useState<ChatSessionItem[]>([]);
  const [allUsers, setAllUsers] = useState<AuthUser[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [ownerMenuOpen, setOwnerMenuOpen] = useState(false);
  const [ownerSearch, setOwnerSearch] = useState('');
  const ownerMenuRef = useRef<HTMLDivElement | null>(null);
  const ownerSearchRef = useRef<HTMLInputElement | null>(null);
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
    if (!ownerMenuOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (ownerMenuRef.current?.contains(event.target as Node)) return;
      setOwnerMenuOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [ownerMenuOpen]);

  useEffect(() => {
    if (!ownerMenuOpen) return;
    ownerSearchRef.current?.focus();
  }, [ownerMenuOpen]);

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
        (s.ownerEmail?.toLowerCase().includes(q) ?? false) ||
        (s.repoName?.toLowerCase().includes(q) ?? false) ||
        (s.repoPath?.toLowerCase().includes(q) ?? false) ||
        (s.archivedWorkspace?.name?.toLowerCase().includes(q) ?? false) ||
        (s.archivedWorkspace?.repoName?.toLowerCase().includes(q) ?? false)
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
      provider: session.provider,
      model: session.model,
      context: sessionContext(session),
    }));

    return chatItems.sort((a, b) => new Date(b.lastMessageAt ?? 0).getTime() - new Date(a.lastMessageAt ?? 0).getTime());
  }, [filteredSessions]);

  const ownerOptions = useMemo(() => [
    { value: 'all', label: 'All users' },
    { value: 'none', label: 'Automation / Unknown' },
    ...allUsers.map((u) => ({
      value: u.id,
      label: `${u.name || u.email}${currentUser?.id === u.id ? ' (me)' : ''}`,
    })),
  ], [allUsers, currentUser?.id]);

  const selectedOwnerLabel = ownerOptions.find((option) => option.value === selectedOwner)?.label ?? 'All users';
  const filteredOwnerOptions = useMemo(() => {
    const term = ownerSearch.trim().toLowerCase();
    if (!term) return ownerOptions;
    return ownerOptions.filter((option) => option.label.toLowerCase().includes(term));
  }, [ownerOptions, ownerSearch]);

  return (
    <div className="content scroll-hide bg-app" data-screen-label="chats">
      <div className="w-full px-8 py-8">
        <div className="mb-5">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-md border border-app bg-app-card text-theme-muted">
              <MessageSquare className="h-[18px] w-[18px]" />
            </span>
            <div>
              <h1 className="text-[24px] font-semibold leading-tight text-theme-primary">History</h1>
              <p className="mt-1 text-[13px] text-theme-muted">Pick up where conversations left off.</p>
            </div>
          </div>
        </div>

        <div className="mb-4 rounded-md border border-app bg-app-card px-4 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <label className="relative min-w-[300px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-theme-muted" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search conversations, repositories, workspaces"
                className="h-9 w-full rounded-md border border-app bg-app px-8 text-[13px] text-theme-primary outline-none transition-colors placeholder:text-theme-subtle focus:border-accent focus:shadow-[var(--focus-ring)]"
              />
            </label>
            <div ref={ownerMenuRef} className="relative w-[250px]">
              <button
                type="button"
                onClick={() => {
                  setOwnerSearch('');
                  setOwnerMenuOpen((open) => !open);
                }}
                className="flex h-9 w-full items-center rounded-md border border-app bg-app pl-8 pr-8 text-left text-[13px] text-theme-secondary outline-none transition-colors hover:border-app-strong focus:border-accent focus:shadow-[var(--focus-ring)]"
                aria-haspopup="listbox"
                aria-expanded={ownerMenuOpen}
                aria-label="Filter by owner"
              >
                <UserRound className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-theme-muted" />
                <span className="truncate">{selectedOwnerLabel}</span>
                <ChevronDown className={`pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-theme-subtle transition-transform ${ownerMenuOpen ? 'rotate-180' : ''}`} />
              </button>
              {ownerMenuOpen && (
                <div
                  role="listbox"
                  className="absolute right-0 z-50 mt-2 w-[300px] rounded-md border border-app bg-app-card p-2 shadow-[0_18px_48px_rgba(0,0,0,0.22)]"
                >
                  <div className="relative mb-2">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-theme-muted" />
                    <input
                      ref={ownerSearchRef}
                      value={ownerSearch}
                      onChange={(event) => setOwnerSearch(event.target.value)}
                      placeholder="Search users"
                      className="h-9 w-full rounded-md border border-app bg-app px-8 text-[13px] text-theme-primary outline-none transition-colors placeholder:text-theme-subtle focus:border-accent focus:shadow-[var(--focus-ring)]"
                    />
                  </div>
                  <div className="max-h-[252px] overflow-auto">
                  {filteredOwnerOptions.map((option) => {
                    const selected = option.value === selectedOwner;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        onClick={() => {
                          setSelectedOwner(option.value);
                          setOwnerMenuOpen(false);
                          setOwnerSearch('');
                        }}
                        className={`flex min-h-9 w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-[13px] transition-colors ${
                          selected
                            ? 'bg-app-muted text-theme-primary'
                            : 'text-theme-secondary hover:bg-app-muted'
                        }`}
                      >
                        <span className="truncate">{option.label}</span>
                        {selected && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
                      </button>
                    );
                  })}
                  {filteredOwnerOptions.length === 0 && (
                    <div className="px-3 py-3 text-[13px] text-theme-muted">No users found.</div>
                  )}
                  </div>
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2 font-mono text-[11px] text-theme-muted">
              <ListFilter className="h-3.5 w-3.5" />
              <span>{items.length} shown</span>
            </div>
          </div>
        </div>

        <div className="space-y-2">
          {loading && items.length === 0 && (
            <div className="rounded-md border border-app bg-app-card px-5 py-10 text-center text-[13px] text-theme-muted">Loading history...</div>
          )}
          {!loading && items.length === 0 && (
            <div className="rounded-md border border-dashed border-app bg-app-card px-5 py-10 text-center text-[13px] text-theme-muted">No conversations found.</div>
          )}
          {items.map((item) => {
            const ContextIcon = item.context?.kind === 'workspace' ? GitBranch : FolderGit2;
            const provider = providerLabel(item.provider, item.model);
            return (
              <Link
                key={`chat-${item.id}`}
                to={item.href}
                className="group block rounded-md border border-app bg-app-card px-4 py-3 transition-colors hover:border-app-strong hover:bg-app-muted/30"
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <h2 className="truncate text-[14.5px] font-semibold text-theme-primary">{item.title}</h2>
                      {provider && (
                        <span className="hidden shrink-0 rounded-md border border-app bg-app px-2 py-0.5 font-mono text-[10px] text-theme-muted sm:inline-flex">
                          {provider}
                        </span>
                      )}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-theme-muted">
                      <span className="truncate">{item.runner}</span>
                      {item.context && (
                        <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-theme-secondary">
                          <ContextIcon className="h-3 w-3 shrink-0 text-accent" />
                          <span className="truncate">
                            {item.context.kind === 'workspace' ? 'Workspace' : 'Repository'}: {item.context.label}
                            {item.context.kind === 'workspace' && item.context.detail ? ` · ${item.context.detail}` : ''}
                          </span>
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="ml-auto flex shrink-0 items-center gap-4 pt-0.5 font-mono text-[12px] text-theme-muted">
                    <span>{item.messageCount} {item.messageCount === 1 ? 'message' : 'messages'}</span>
                    <span>{timeAgo(item.lastMessageAt)}</span>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
