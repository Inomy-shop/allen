import { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import ErrorBoundary from './components/common/ErrorBoundary';
import NotificationBell from './components/common/NotificationBell';
import {
  GitBranch, Play, Users, Settings,
  FolderGit2, Brain, MessageSquare,
  ChevronRight, ChevronLeft,
  GitPullRequest, Ticket, LogOut,
  Sun, Moon, Search, PanelLeft, Command, Inbox, ArrowRight,
  Sparkles, BarChart3,
} from 'lucide-react';
import { useSettingsStore } from './stores/settingsStore';
import { resolveColorMode } from './lib/theme';
import { useAuthStore } from './stores/authStore';
import { BRAND_NAME } from './lib/brand';
import {
  auth as authApi,
  chat as chatApi,
  dashboard as dashboardApi,
  executions as executionsApi,
} from './services/api';
import { usePanelLayout } from './hooks/usePanelLayout';

interface NavItem {
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  badgeKey?: keyof NavCounts;
  activePrefixes?: string[];
  end?: boolean;
}

interface CommandItem {
  id: string;
  label: string;
  group: string;
  to: string;
  icon: React.ComponentType<{ className?: string }>;
}

interface NavCounts {
  mywork?: number;
  inbox?: number;
  threads?: number;
  tickets?: number;
  pulls?: number;
  workspaces?: number;
  activity?: number;
  learnings?: number;
}

// ── Nav Groups (prototype direction: personal work, sources, org) ──

const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  { label: '', items: [
    { to: '/', icon: Sparkles, label: 'my work', badgeKey: 'mywork', end: true },
    { to: '/interventions', icon: Inbox, label: 'inbox', badgeKey: 'inbox' },
    { to: '/threads', icon: MessageSquare, label: 'threads', badgeKey: 'threads' },
  ]},
  { label: 'Sources', items: [
    { to: '/tickets', icon: Ticket, label: 'tickets', badgeKey: 'tickets' },
    { to: '/pull-requests', icon: GitPullRequest, label: 'pull requests', badgeKey: 'pulls' },
    { to: '/workspaces', icon: FolderGit2, label: 'workspaces', badgeKey: 'workspaces' },
  ]},
  { label: 'Org', items: [
    { to: '/agents', icon: Users, label: 'library', activePrefixes: ['/agents', '/workflows', '/repos'] },
    { to: '/executions', icon: Play, label: 'activity', badgeKey: 'activity', activePrefixes: ['/executions'] },
    { to: '/monitoring', icon: BarChart3, label: 'analytics', activePrefixes: ['/monitoring'] },
    { to: '/learnings', icon: Brain, label: 'learnings', badgeKey: 'learnings' },
  ]},
  { label: 'Personal', items: [
    { to: '/settings', icon: Settings, label: 'settings', activePrefixes: ['/settings'] },
  ]},
];

const ROUTE_TITLES: Array<{ prefix: string; label: string }> = [
  { prefix: '/threads', label: 'Threads' },
  { prefix: '/chat', label: 'Chat' },
  { prefix: '/interventions', label: 'Inbox' },
  { prefix: '/tickets', label: 'Tickets' },
  { prefix: '/pull-requests', label: 'Pull requests' },
  { prefix: '/repos', label: 'Repositories' },
  { prefix: '/workspaces', label: 'Workspaces' },
  { prefix: '/agents', label: 'Library' },
  { prefix: '/workflows', label: 'Workflows' },
  { prefix: '/executions', label: 'Activity' },
  { prefix: '/crons', label: 'Schedules' },
  { prefix: '/monitoring', label: 'Analytics' },
  { prefix: '/learnings', label: 'Learnings' },
  { prefix: '/settings', label: 'Settings' },
];

const COMMANDS: CommandItem[] = [
  { id: 'my-work', label: 'Go to my work', group: 'Navigate', to: '/', icon: Sparkles },
  { id: 'inbox', label: 'Open inbox', group: 'Navigate', to: '/interventions', icon: Inbox },
  { id: 'threads', label: 'Open threads', group: 'Navigate', to: '/threads', icon: MessageSquare },
  { id: 'chat', label: 'Open assistant chat', group: 'Action', to: '/chat', icon: MessageSquare },
  { id: 'activity', label: 'View activity', group: 'Runs', to: '/executions', icon: Play },
  { id: 'running', label: 'View running executions', group: 'Runs', to: '/executions?status=running', icon: Play },
  { id: 'tickets', label: 'Open Linear tickets', group: 'Sources', to: '/tickets', icon: Ticket },
  { id: 'pulls', label: 'Open pull requests', group: 'Sources', to: '/pull-requests', icon: GitPullRequest },
  { id: 'workspaces', label: 'Open workspaces', group: 'Code', to: '/workspaces', icon: FolderGit2 },
  { id: 'analytics', label: 'Open analytics', group: 'Org', to: '/monitoring', icon: BarChart3 },
  { id: 'workflows', label: 'Open workflows', group: 'Library', to: '/workflows', icon: GitBranch },
  { id: 'agents', label: 'Open agents and teams', group: 'Library', to: '/agents', icon: Users },
];

function routeTitle(pathname: string): string {
  if (pathname === '/') return 'My work';
  const match = ROUTE_TITLES.find(route => pathname.startsWith(route.prefix));
  return match?.label ?? 'Allen';
}

function AppTopbar({
  title,
  detail,
  liveCount,
  healthy,
  commandOpen,
  onCommandOpen,
  onRunningOpen,
  onSidebarToggle,
  colorMode,
  onColorModeToggle,
}: {
  title: string;
  detail?: string | null;
  liveCount: number;
  healthy: boolean;
  commandOpen: boolean;
  onCommandOpen: () => void;
  onRunningOpen: () => void;
  onSidebarToggle: () => void;
  colorMode: 'light' | 'dark';
  onColorModeToggle: () => void;
}) {
  return (
    <header className="topbar">
      <button
        type="button"
        onClick={onSidebarToggle}
        className="btn ghost sm"
        title="Toggle sidebar"
        aria-label="Toggle sidebar"
      >
        <PanelLeft className="h-4 w-4" />
      </button>

      <div className="crumb">
        <span>allen</span>
        <span className="sep">/</span>
        <span className="now">{title}</span>
        {detail && (
          <>
            <span className="sep">/</span>
            <span className="detail" title={detail}>{detail}</span>
          </>
        )}
      </div>

      <div className="spacer" />

      <div className="hidden items-center gap-1.5 md:flex">
        <button
          type="button"
          onClick={onRunningOpen}
          className="chip"
          title="Active runs across all workspaces"
        >
          <span className={`dot ${liveCount > 0 ? 'dot-run' : 'dot-idle'} ${liveCount > 0 ? 'animate-pulse' : ''}`} />
          {liveCount} live
        </button>
        <span className={healthy ? 'chip chip-ok' : 'chip chip-warn'}>
          <span className={healthy ? 'dot dot-ok' : 'dot dot-warn'} />
          {healthy ? 'healthy' : 'checking'}
        </span>
      </div>

      <button
        type="button"
        onClick={onCommandOpen}
        className="topbar-search"
        aria-expanded={commandOpen}
      >
        <Search className="h-3.5 w-3.5" />
        <span className="flex-1">Search or run command</span>
        <kbd>⌘K</kbd>
      </button>

      <button
        type="button"
        onClick={onColorModeToggle}
        className="btn ghost sm"
        title={`Switch to ${colorMode === 'dark' ? 'light' : 'dark'} mode`}
        aria-label="Toggle theme"
      >
        {colorMode === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </button>
      <NotificationBell />
    </header>
  );
}

function ShellCommandPalette({
  open,
  onClose,
  onNavigate,
}: {
  open: boolean;
  onClose: () => void;
  onNavigate: (to: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return COMMANDS;
    return COMMANDS.filter(command =>
      command.label.toLowerCase().includes(q)
      || command.group.toLowerCase().includes(q)
      || command.to.toLowerCase().includes(q),
    );
  }, [query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelected(0);
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => { setSelected(0); }, [query]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelected(index => Math.min(index + 1, filtered.length - 1));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelected(index => Math.max(index - 1, 0));
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const command = filtered[selected];
        if (command) {
          onNavigate(command.to);
          onClose();
        }
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [filtered, onClose, onNavigate, open, selected]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[14vh]" onClick={onClose}>
      <div className="absolute inset-0 bg-black/35 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-xl overflow-hidden rounded-xl border border-app bg-app-card shadow-popover"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-app px-4 py-3">
          <Command className="h-4 w-4 text-theme-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Search navigation and actions..."
            className="flex-1 bg-transparent text-[14px] text-theme-primary outline-none placeholder:text-theme-subtle"
          />
          <kbd className="rounded border border-app bg-app-muted px-1.5 py-0.5 font-mono text-[10px] text-theme-subtle">esc</kbd>
        </div>
        <div className="max-h-[360px] overflow-y-auto py-2">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-[12px] text-theme-muted">No commands match.</div>
          ) : filtered.map((command, index) => {
            const Icon = command.icon;
            const active = index === selected;
            return (
              <button
                key={command.id}
                type="button"
                onMouseEnter={() => setSelected(index)}
                onClick={() => {
                  onNavigate(command.to);
                  onClose();
                }}
                className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                  active ? 'bg-accent-soft text-theme-primary' : 'text-theme-secondary hover:bg-app-muted'
                }`}
              >
                <Icon className={`h-4 w-4 ${active ? 'text-accent' : 'text-theme-muted'}`} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{command.label}</span>
                  <span className="block truncate font-mono text-[10px] text-theme-subtle">{command.to}</span>
                </span>
                <span className="rounded border border-app bg-app-muted px-1.5 py-0.5 font-mono text-[10px] text-theme-subtle">
                  {command.group}
                </span>
                <ArrowRight className="h-3.5 w-3.5 text-theme-subtle" />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function formatNavBadge(value?: number): string | null {
  if (!value || value <= 0) return null;
  if (value > 99) return '99+';
  return String(value);
}

function isNavItemActive(item: NavItem, pathname: string, isActive: boolean): boolean {
  if (item.end) return pathname === item.to;
  if (item.activePrefixes?.some(prefix => pathname.startsWith(prefix))) return true;
  return isActive;
}

// ── Main App ──

export default function App() {
  const initSettings = useSettingsStore((s) => s.initFromLocalStorage);
  const addSystemThemeListener = useSettingsStore((s) => s.addSystemThemeListener);
  useEffect(() => { initSettings(); }, [initSettings]);

  useEffect(() => {
    const cleanup = addSystemThemeListener();
    return cleanup;
  }, [addSystemThemeListener]);

  const location = useLocation();
  const navigate = useNavigate();
  const title = routeTitle(location.pathname);
  const [chatTopbarTitle, setChatTopbarTitle] = useState<string | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [liveCount, setLiveCount] = useState(0);
  const [healthKnown, setHealthKnown] = useState(false);
  const [navCounts, setNavCounts] = useState<NavCounts>({});

  const currentUser = useAuthStore((s) => s.user);
  const refreshToken = useAuthStore((s) => s.refreshToken);
  const clearAuth = useAuthStore((s) => s.clear);

  async function handleLogout() {
    try {
      if (refreshToken) await authApi.logout(refreshToken);
    } catch {
      // ignore — clear locally regardless
    }
    clearAuth();
    navigate('/login', { replace: true });
  }

  // Initials for the avatar tile
  const userInitial = currentUser?.name?.charAt(0)?.toUpperCase()
    || currentUser?.email?.charAt(0)?.toUpperCase()
    || '?';

  // Theme toggle — flips between light and dark, persists via the
  // existing settings store (which also handles the .dark class +
  // re-renders all CSS-variable-dependent surfaces).
  const colorMode = useSettingsStore((s) => s.colorMode);
  const setColorMode = useSettingsStore((s) => s.setColorMode);
  const resolvedMode = resolveColorMode(colorMode);
  const toggleColorMode = () => setColorMode(resolvedMode === 'dark' ? 'light' : 'dark');

  useEffect(() => {
    let cancelled = false;
    async function loadLiveCount() {
      try {
        const { count } = await executionsApi.count({ status: ['running', 'queued'] });
        if (cancelled) return;
        setLiveCount(count ?? 0);
        setHealthKnown(true);
      } catch {
        if (!cancelled) setHealthKnown(false);
      }
    }
    void loadLiveCount();
    const interval = setInterval(loadLiveCount, 10000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const match = location.pathname.match(/^\/chat\/([^/]+)/);
    if (!match) {
      setChatTopbarTitle(null);
      return;
    }
    let cancelled = false;
    const sessionId = match[1];
    const loadTitle = () => {
      chatApi.getSession(sessionId)
        .then((session) => {
          if (!cancelled) setChatTopbarTitle(session?.title ?? null);
        })
        .catch(() => {
          if (!cancelled) setChatTopbarTitle(null);
        });
    };
    loadTitle();
    const refreshSoon = window.setTimeout(loadTitle, 2000);
    const refreshLater = window.setTimeout(loadTitle, 6000);
    return () => {
      cancelled = true;
      window.clearTimeout(refreshSoon);
      window.clearTimeout(refreshLater);
    };
  }, [location.pathname]);

  useEffect(() => {
    let cancelled = false;
    async function loadNavCounts() {
      const counts = await dashboardApi.navCounts();
      if (cancelled) return;
      setNavCounts(counts);
    }
    void loadNavCounts();
    const interval = setInterval(loadNavCounts, 30000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandOpen(true);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const navPanel = usePanelLayout({
    storageKey: 'app-nav',
    direction: 'horizontal',
    defaultSize: 228,
    minSize: 180,
    maxSize: 320,
  });

  return (
    <div className="app-shell">
      {/* Navigation sidebar — collapsible and resizable */}
      {navPanel.collapsed ? (
        <div className="sidebar sidebar-icon">
          <button
            onClick={navPanel.toggle}
            className="brand-mark"
            title="Expand navigation"
            aria-label="Expand navigation"
          >
            [a]
          </button>
          {NAV_GROUPS.flatMap(g => g.items).map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }: { isActive: boolean }) =>
                `relative rounded-md p-2 transition-colors ${
                  isNavItemActive(item, location.pathname, isActive)
                    ? 'border border-accent/20 bg-accent-soft text-accent'
                    : 'border border-transparent text-theme-muted hover:bg-app-muted hover:text-theme-primary'
                }`
              }
              title={item.label}
              aria-label={item.label}
            >
              <item.icon className="w-4 h-4" />
              {formatNavBadge(item.badgeKey ? navCounts[item.badgeKey] : undefined) && (
                <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-accent" />
              )}
            </NavLink>
          ))}
          <div className="mt-auto">
            <button
              onClick={navPanel.toggle}
              className="foot-btn"
              title="Expand navigation"
              aria-label="Expand navigation"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      ) : (
        /* Expanded: full nav with dynamic width */
        <nav className="sidebar">
          {/* Workspace switcher pill — with collapse button */}
          <div className="brand">
            <NavLink to="/" className="brand-link">
              <div className="brand-mark">
                [a]
              </div>
              <span className="brand-name">{BRAND_NAME}</span>
            </NavLink>
            <span className="brand-sub">v0.2</span>
            <button
              onClick={navPanel.toggle}
              className="foot-btn"
              title="Collapse navigation"
              aria-label="Collapse navigation"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Nav groups */}
          <div className="sidebar-inner scroll-hide">
            {NAV_GROUPS.map((group, gi) => (
              <div key={gi} className="nav-group">
                {group.label && (
                  <div className="nav-group-title">{group.label}</div>
                )}
                {group.items.map(item => (
                  <div key={item.to}>
                    <NavLink
                      to={item.to}
                      end={item.end ?? item.to === '/'}
                      className={({ isActive }) =>
                        `nav-item ${
                          isNavItemActive(item, location.pathname, isActive)
                            ? 'active'
                            : ''
                        }`
                      }
                    >
                      {({ isActive }) => (
                        <>
                          <item.icon className="ico" />
                          <span className="lbl">{item.label}</span>
                          {formatNavBadge(item.badgeKey ? navCounts[item.badgeKey] : undefined) && (
                            <span className="badge">
                              {formatNavBadge(item.badgeKey ? navCounts[item.badgeKey] : undefined)}
                            </span>
                          )}
                        </>
                      )}
                    </NavLink>
                  </div>
                ))}
              </div>
            ))}
          </div>

          {/* Bottom — user chip + version */}
          <div className="sidebar-foot-wrap">
            {currentUser && (
              <div className="sidebar-foot">
                <div className="avatar">
                  {userInitial}
                </div>
                <div className="user-meta">
                  <div className="nm">{currentUser.name}</div>
                  <div className="em">{currentUser.email}</div>
                </div>
                <button
                  onClick={handleLogout}
                  className="foot-btn"
                  title="Sign out"
                >
                  <LogOut className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        </nav>
      )}

      <main className="flex-1 min-w-0 bg-app relative flex flex-col overflow-hidden">
        <AppTopbar
          title={title}
          detail={chatTopbarTitle}
          liveCount={liveCount}
          healthy={healthKnown}
          commandOpen={commandOpen}
          onCommandOpen={() => setCommandOpen(true)}
          onRunningOpen={() => navigate('/executions?status=running')}
          onSidebarToggle={navPanel.toggle}
          colorMode={resolvedMode}
          onColorModeToggle={toggleColorMode}
        />
        <div className="flex-1 min-h-0 overflow-auto">
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
        </div>
      </main>
      <ShellCommandPalette
        open={commandOpen}
        onClose={() => setCommandOpen(false)}
        onNavigate={(to) => navigate(to)}
      />
    </div>
  );
}
