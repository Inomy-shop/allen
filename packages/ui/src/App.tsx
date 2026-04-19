import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import ErrorBoundary from './components/common/ErrorBoundary';
import NotificationBell from './components/common/NotificationBell';
import {
  LayoutDashboard, GitBranch, Play, Users, Activity, Settings,
  FolderGit2, Brain, MessageSquare, BarChart3, Plus, Trash2,
  Server, Palette, Key, User, ChevronRight, ChevronUp, ChevronDown,
  GitPullRequest, Clock, HelpCircle,
} from 'lucide-react';
import { useSettingsStore } from './stores/settingsStore';
import { useAuthStore } from './stores/authStore';
import { useChat, type ChatSession } from './hooks/useChat';
import DeleteConfirmDialog from './components/common/DeleteConfirmDialog';
import { LogOut, ShieldCheck } from 'lucide-react';
import { BRAND_NAME } from './lib/brand';
import { auth as authApi } from './services/api';

interface SettingsTab {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  adminOnly?: boolean;
}

// ── Nav Groups ──

const NAV_GROUPS = [
  { label: null, items: [
    { to: '/chat', icon: MessageSquare, label: 'Chat', expandable: true },
    { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  ]},
  { label: 'Build', items: [
    { to: '/workflows', icon: GitBranch, label: 'Agent Workflows' },
    { to: '/teams', icon: Users, label: 'Teams' },
    { to: '/agents', icon: Users, label: 'Agents' },
    { to: '/repos', icon: FolderGit2, label: 'Repos' },
  ]},
  { label: 'Develop', items: [
    { to: '/workspaces', icon: FolderGit2, label: 'Workspaces' },
    { to: '/pull-requests', icon: GitPullRequest, label: 'Pull Requests' },
  ]},
  { label: 'Monitor', items: [
    { to: '/executions', icon: Play, label: 'Executions' },
    { to: '/interventions', icon: HelpCircle, label: 'Interventions' },
    { to: '/analytics', icon: BarChart3, label: 'Analytics' },
    { to: '/learnings', icon: Brain, label: 'Learnings' },
    { to: '/crons', icon: Clock, label: 'Scheduled Jobs' },
  ]},
];

const SETTINGS_TABS: SettingsTab[] = [
  { id: 'profile', label: 'Profile', icon: User },
  { id: 'users', label: 'Users', icon: ShieldCheck, adminOnly: true },
  { id: 'mcp', label: 'MCP Servers', icon: Server },
  { id: 'theme', label: 'Appearance', icon: Palette },
  { id: 'secrets', label: 'Secrets', icon: Key },
];

// Provider display
const PROV: Record<string, { label: string; color: string }> = {
  codex: { label: 'Codex', color: 'text-accent-green' },
  'claude-cli': { label: 'Claude', color: 'text-accent-blue' },
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

// ── Chat Sidebar Section ──

function ChatSidebarSection() {
  const navigate = useNavigate();
  const { sessions, activeSessionId, loadingSessions, switchSession, deleteSession } = useChat();
  const [deleting, setDeleting] = useState<{ id: string; title: string } | null>(null);

  function handleNew() {
    switchSession('');
    navigate('/chat', { replace: true });
  }

  async function handleDelete() {
    if (!deleting) return;
    await deleteSession(deleting.id);
    setDeleting(null);
    if (activeSessionId === deleting.id) navigate('/chat', { replace: true });
  }

  return (
    <>
      <div className="px-4 py-2 flex items-center justify-between">
        <span className="text-[10px] font-label uppercase tracking-[0.15em] text-theme-muted">Conversations</span>
        <button onClick={handleNew} className="w-7 h-7 flex items-center justify-center rounded-md bg-accent-blue/10 text-accent-blue hover:bg-accent-blue/20 transition-colors" title="New conversation">
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-1.5 py-1.5 space-y-1.5">
        {loadingSessions && sessions.length === 0 && (
          <div className="px-4 py-6 text-center text-xs text-theme-subtle animate-pulse">Loading conversations…</div>
        )}
        {!loadingSessions && sessions.length === 0 && (
          <div className="px-4 py-6 text-center text-xs text-theme-subtle">No conversations yet</div>
        )}
        {sessions.map(s => {
          const isActive = s._id === activeSessionId;
          const p = PROV[s.provider] ?? { label: s.provider, color: 'text-theme-muted' };
          // Map the provider text-* class to its matching bg-* for the dot.
          const dotBg = p.color.replace('text-', 'bg-');
          return (
            <div
              key={s._id}
              role="button"
              tabIndex={0}
              onClick={() => { switchSession(s._id); navigate(`/chat/${s._id}`, { replace: true }); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  switchSession(s._id);
                  navigate(`/chat/${s._id}`, { replace: true });
                }
              }}
              className={`group relative flex items-start gap-2.5 px-3 py-2.5 rounded-lg cursor-pointer transition-all duration-150 border ${
                isActive
                  ? 'bg-accent-blue/15 border-accent-blue/40 shadow-sm shadow-accent-blue/10'
                  : 'bg-surface-100/70 border-border/40 hover:bg-surface-200/70 hover:border-border/70'
              }`}
              title={s.title}
            >
              {/* Provider dot — tiny colored indicator on the left */}
              <span
                className={`mt-[7px] w-1.5 h-1.5 rounded-full shrink-0 ${dotBg} ${isActive ? 'ring-2 ring-accent-blue/20' : ''}`}
                aria-hidden="true"
              />

              {/* Title + meta line */}
              <div className="flex-1 min-w-0">
                <div className={`text-sm font-body truncate leading-snug ${
                  isActive ? 'text-theme-primary font-medium' : 'text-theme-secondary group-hover:text-theme-primary'
                }`}>
                  {s.title}
                </div>
                <div className="flex items-center gap-1.5 mt-0.5 text-[10px] font-mono">
                  <span className={p.color}>{p.label}</span>
                  <span className="text-theme-subtle/60">·</span>
                  <span className="text-theme-subtle">{timeAgo(s.lastMessageAt)}</span>
                  {s.messageCount > 0 && (
                    <>
                      <span className="text-theme-subtle/60">·</span>
                      <span className="text-theme-subtle">{s.messageCount} msg</span>
                    </>
                  )}
                </div>
              </div>

              {/* Delete button (hover-reveal) */}
              <button
                onClick={e => { e.stopPropagation(); setDeleting({ id: s._id, title: s.title }); }}
                className="opacity-0 group-hover:opacity-100 focus:opacity-100 shrink-0 w-6 h-6 -mr-0.5 flex items-center justify-center rounded-md text-theme-subtle hover:text-accent-red hover:bg-accent-red/10 transition-all"
                title="Delete conversation"
                aria-label="Delete conversation"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          );
        })}
      </div>
      <DeleteConfirmDialog open={!!deleting} resourceType="conversation" resourceName={deleting?.title ?? ''} onConfirm={handleDelete} onCancel={() => setDeleting(null)} />
    </>
  );
}

// ── Settings Sidebar Section ──

function SettingsSidebarSection({ onCollapse }: { onCollapse?: () => void }) {
  const location = useLocation();
  const activeTab = location.pathname.split('/settings/')[1] ?? 'profile';
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const visibleTabs = SETTINGS_TABS.filter((t) => !t.adminOnly || isAdmin);

  return (
    <div className="py-2">
      {/* Header with SETTINGS label on the left and collapse chevron on the right */}
      <div className="px-5 py-1 mb-1 flex items-center justify-between">
        <span className="text-[10px] font-label uppercase tracking-[0.15em] text-theme-muted">Settings</span>
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            className="p-0.5 rounded text-theme-muted hover:text-theme-secondary hover:bg-surface-200/40 transition-colors"
            title="Collapse Settings menu"
            aria-label="Collapse Settings menu"
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      {visibleTabs.map(({ id, label, icon: Icon }) => (
        <NavLink
          key={id}
          to={`/settings/${id}`}
          className={`flex items-center gap-3 px-4 py-1.5 mx-2 rounded-md text-sm font-body transition-all ${
            activeTab === id
              ? 'bg-accent-blue/10 text-accent-blue'
              : 'text-theme-muted hover:text-theme-secondary hover:bg-surface-200/40'
          }`}
        >
          <Icon className="w-[18px] h-[18px]" />
          {label}
        </NavLink>
      ))}
    </div>
  );
}

// ── Main App ──

export default function App() {
  const initSettings = useSettingsStore((s) => s.initFromLocalStorage);
  const addSystemThemeListener = useSettingsStore((s) => s.addSystemThemeListener);
  useEffect(() => { initSettings(); }, [initSettings]);

  // Add system theme listener
  useEffect(() => {
    const cleanup = addSystemThemeListener();
    return cleanup;
  }, [addSystemThemeListener]);

  const location = useLocation();
  const navigate = useNavigate();
  const isChat = location.pathname.startsWith('/chat');
  const isSettings = location.pathname.startsWith('/settings');

  // Sidebar Settings menu — expands/collapses independently of the URL.
  // Auto-opens when the user first lands on any /settings/* route (direct
  // link, refresh, or external nav), and can be toggled manually via the
  // Settings button / collapse chevron. The transition-only guard means the
  // user can still collapse the menu while staying on a settings page —
  // otherwise the effect would re-open it on every render.
  const [settingsOpen, setSettingsOpen] = useState(isSettings);
  const wasSettingsRef = useRef(isSettings);
  useEffect(() => {
    if (isSettings && !wasSettingsRef.current) {
      setSettingsOpen(true);
    }
    wasSettingsRef.current = isSettings;
  }, [isSettings]);

  const currentUser = useAuthStore((s) => s.user);
  const refreshToken = useAuthStore((s) => s.refreshToken);
  const clearAuth = useAuthStore((s) => s.clear);

  async function handleLogout() {
    try {
      if (refreshToken) await authApi.logout(refreshToken);
    } catch {
      // ignore — we clear locally regardless
    }
    clearAuth();
    navigate('/login', { replace: true });
  }

  return (
    <div className="flex h-screen">
      <nav className="w-72 bg-surface-50 border-r border-border/50 flex flex-col shrink-0 relative">
        {/* Accent edge */}
        <div className="absolute right-0 top-0 bottom-0 w-px bg-gradient-to-b from-accent-blue/40 via-accent-blue/10 to-transparent" />

        {/* Logo */}
        <div className="px-5 py-4 border-b border-border/50">
          <NavLink to="/" className="flex items-center gap-2.5">
            <div className="relative">
              <Activity className="w-5 h-5 text-accent-blue" />
              <div className="absolute inset-0 blur-md bg-accent-blue/30 rounded-full" />
            </div>
            <span className="font-heading text-[15px] font-bold text-theme-primary tracking-widest uppercase">{BRAND_NAME}</span>
          </NavLink>
        </div>

        {/* Nav groups — conversations list expands INLINE directly below
            the Chat link when the user is on /chat, capped at 50% of the
            viewport height so the rest of the nav stays reachable. */}
        <div className="flex-1 overflow-y-auto py-2">
          {NAV_GROUPS.map((group, gi) => (
            <div key={gi} className={gi > 0 ? 'mt-3' : ''}>
              {group.label && (
                <div className="px-5 py-1">
                  <span className="text-[10px] font-label uppercase tracking-[0.15em] text-theme-muted">{group.label}</span>
                </div>
              )}
              {group.items.map(item => (
                <div key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.to === '/'}
                    className={({ isActive }) =>
                      `flex items-center gap-3 px-4 py-2 mx-2 rounded-md text-sm font-body transition-all duration-200 ${
                        isActive
                          ? 'bg-accent-blue/10 text-accent-blue'
                          : 'text-theme-muted hover:text-theme-secondary hover:bg-surface-200/40'
                      }`
                    }
                  >
                    <item.icon className="w-[18px] h-[18px]" />
                    {item.label}
                  </NavLink>

                  {/* Inline conversations list directly under the Chat link */}
                  {item.to === '/chat' && isChat && (
                    <div className="mt-1 mb-2 mx-2 flex flex-col max-h-[50vh] min-h-[120px] overflow-hidden rounded-md border border-border/30 bg-surface-100/30">
                      <ChatSidebarSection />
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* Bottom — settings is either a single button (closed) OR the full
            submenu with its own top-right collapse chevron (open). Exactly
            one of the two is visible at a time — the "Settings" label goes
            away when expanded. No navigation happens on the button click;
            only sub-tab clicks route anywhere. */}
        <div className="border-t border-border/50 shrink-0">
          {settingsOpen ? (
            <SettingsSidebarSection onCollapse={() => setSettingsOpen(false)} />
          ) : (
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className={`w-full flex items-center gap-3 px-4 py-2 mx-2 my-1 rounded-md text-sm font-body transition-all duration-200 ${
                isSettings
                  ? 'bg-accent-blue/10 text-accent-blue'
                  : 'text-theme-muted hover:text-theme-secondary hover:bg-surface-200/40'
              }`}
              style={{ width: 'calc(100% - 1rem)' }}
            >
              <Settings className="w-[18px] h-[18px]" />
              <span className="flex-1 text-left">Settings</span>
              <ChevronUp className="w-4 h-4 opacity-70" />
            </button>
          )}

          {currentUser && (
            <div className="flex items-center justify-between px-4 py-2 mx-2 rounded-md hover:bg-surface-200/40 group">
              <div className="min-w-0">
                <div className="text-xs text-theme-secondary font-body truncate">{currentUser.name}</div>
                <div className="text-[10px] text-theme-subtle font-mono truncate">{currentUser.email}</div>
              </div>
              <button
                onClick={handleLogout}
                className="shrink-0 p-1.5 rounded text-theme-muted hover:text-accent-red"
                title="Sign out"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          )}

          <div className="flex items-center justify-between px-5 py-2">
            <span className="text-[10px] text-theme-subtle font-mono">v0.1.0</span>
            <NotificationBell />
          </div>
        </div>
      </nav>

      <main className="flex-1 overflow-auto bg-surface-50 relative">
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}
