import { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import ErrorBoundary from './components/common/ErrorBoundary';
import NotificationBell from './components/common/NotificationBell';
import ShortcutKey from './components/common/ShortcutKey';
import {
  CirclePlay, GitBranch, GitPullRequest, History, LayoutDashboard, Settings,
  FolderGit2, TicketCheck, Workflow,
  ChevronRight,
  Sun, Moon, Search, PanelLeft, Command, ArrowRight, UsersRound, ArrowLeft,
  SlidersHorizontal, CircleUserRound, HardDrive, Server, CalendarClock, Brain,
} from 'lucide-react';
import { useSettingsStore } from './stores/settingsStore';
import { resolveColorMode } from './lib/theme';
import { useAuthStore } from './stores/authStore';
import { BRAND_NAME } from './lib/brand';
import {
  chat as chatApi,
  dashboard as dashboardApi,
  executions as executionsApi,
  interventions as interventionsApi,
  linear as linearApi,
} from './services/api';
import { pullRequests as pullRequestsApi, workspaces as workspacesApi } from './services/workspaceService';
import { usePanelLayout } from './hooks/usePanelLayout';

interface NavItem {
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  badgeKey?: keyof NavCounts;
  activePrefixes?: string[];
  end?: boolean;
}

interface NavGroup {
  id: string;
  label?: string;
  collapsible?: boolean;
  items: NavItem[];
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
  chats?: number;
  tickets?: number;
  pulls?: number;
  workspaces?: number;
  activity?: number;
}

// ── Nav Groups (Allen design system: primary actions, sources, studio) ──

const NAV_GROUPS: NavGroup[] = [
  { id: 'primary', items: [
    { to: '/', icon: LayoutDashboard, label: 'Dashboard', badgeKey: 'mywork', end: true },
    { to: '/executions', icon: CirclePlay, label: 'Executions', badgeKey: 'activity', activePrefixes: ['/executions'] },
    { to: '/chats', icon: History, label: 'History', badgeKey: 'chats', activePrefixes: ['/chats', '/chat'] },
  ]},
  { id: 'sources', label: 'Sources', collapsible: true, items: [
    { to: '/tickets', icon: TicketCheck, label: 'Linear', badgeKey: 'tickets' },
    { to: '/pull-requests', icon: GitPullRequest, label: 'Pull requests', badgeKey: 'pulls' },
    { to: '/agents?section=repos', icon: GitBranch, label: 'Repositories' },
    { to: '/workspaces', icon: FolderGit2, label: 'Workspaces', badgeKey: 'workspaces' },
  ]},
  { id: 'studio', label: 'Studio', collapsible: true, items: [
    { to: '/agents?section=teams-agents', icon: UsersRound, label: 'Teams & Agents' },
    { to: '/workflows', icon: Workflow, label: 'Workflows', activePrefixes: ['/workflows'] },
  ]},
];

const SETTINGS_NAV_GROUPS: NavGroup[] = [
  { id: 'settings-primary', items: [
    { to: '/settings/general', icon: SlidersHorizontal, label: 'General', activePrefixes: ['/settings/general'], end: true },
    { to: '/settings/runtime', icon: HardDrive, label: 'Runtime', activePrefixes: ['/settings/runtime'] },
    { to: '/settings/mcp', icon: Server, label: 'MCP Servers', activePrefixes: ['/settings/mcp'] },
  ]},
  { id: 'settings-allen', label: 'Allen', items: [
    { to: '/settings/schedules', icon: CalendarClock, label: 'Schedules', activePrefixes: ['/settings/schedules'] },
    { to: '/settings/learnings', icon: Brain, label: 'Learnings', activePrefixes: ['/settings/learnings'] },
    { to: '/settings/team', icon: UsersRound, label: 'Team', activePrefixes: ['/settings/team'] },
  ]},
  { id: 'settings-account', label: 'User', items: [
    { to: '/settings/account', icon: CircleUserRound, label: 'Account', activePrefixes: ['/settings/account'] },
  ]},
];

const ROUTE_TITLES: Array<{ prefix: string; label: string }> = [
  { prefix: '/chats', label: 'History' },
  { prefix: '/threads', label: 'History' },
  { prefix: '/chat', label: 'Chat' },
  { prefix: '/interventions', label: 'Interventions' },
  { prefix: '/tickets', label: 'Linear' },
  { prefix: '/pull-requests', label: 'Pull requests' },
  { prefix: '/repos', label: 'Repositories' },
  { prefix: '/workspaces', label: 'Workspaces' },
  { prefix: '/agents', label: 'Studio' },
  { prefix: '/workflows', label: 'Workflows' },
  { prefix: '/executions', label: 'Executions' },
  { prefix: '/crons', label: 'Schedules' },
  { prefix: '/monitoring', label: 'Settings' },
  { prefix: '/learnings', label: 'Settings' },
  { prefix: '/settings', label: 'Settings' },
];

const COMMANDS: CommandItem[] = [
  { id: 'dashboard', label: 'Open dashboard', group: 'Navigate', to: '/', icon: LayoutDashboard },
  { id: 'executions', label: 'Open executions', group: 'Navigate', to: '/executions', icon: CirclePlay },
  { id: 'chats', label: 'Open history', group: 'Navigate', to: '/chats', icon: History },
  { id: 'chat', label: 'Open assistant chat', group: 'Action', to: '/chat', icon: History },
  { id: 'activity', label: 'View execution log', group: 'Executions', to: '/executions', icon: CirclePlay },
  { id: 'running', label: 'View running executions', group: 'Executions', to: '/executions?status=running', icon: CirclePlay },
  { id: 'tickets', label: 'Open Linear', group: 'Sources', to: '/tickets', icon: TicketCheck },
  { id: 'pulls', label: 'Open pull requests', group: 'Sources', to: '/pull-requests', icon: GitPullRequest },
  { id: 'repos', label: 'Open repositories', group: 'Sources', to: '/agents?section=repos', icon: GitBranch },
  { id: 'workspaces', label: 'Open workspaces', group: 'Sources', to: '/workspaces', icon: FolderGit2 },
  { id: 'settings-general', label: 'Open settings', group: 'Settings', to: '/settings/general', icon: SlidersHorizontal },
  { id: 'settings-runtime', label: 'Open runtime settings', group: 'Settings', to: '/settings/runtime', icon: HardDrive },
  { id: 'settings-mcp', label: 'Open MCP servers', group: 'Settings', to: '/settings/mcp', icon: Server },
  { id: 'settings-schedules', label: 'Open schedules', group: 'Settings', to: '/settings/schedules', icon: CalendarClock },
  { id: 'settings-learnings', label: 'Open learnings', group: 'Settings', to: '/settings/learnings', icon: Brain },
  { id: 'workflows', label: 'Open workflows', group: 'Studio', to: '/workflows', icon: Workflow },
  { id: 'agents', label: 'Open teams & agents', group: 'Studio', to: '/agents?section=teams-agents', icon: UsersRound },
];

function routeTitle(pathname: string): string {
  if (pathname === '/') return 'Dashboard';
  const match = ROUTE_TITLES.find(route => pathname.startsWith(route.prefix));
  return match?.label ?? 'Allen';
}

function routeDetail(pathname: string, chatTopbarTitle: string | null): string | null {
  if (/^\/repos\/[^/]+\/context-management/.test(pathname)) return 'Context Management';
  if (/^\/chat\/[^/]+/.test(pathname)) return chatTopbarTitle;
  return null;
}

function AppTopbar({
  title,
  detail,
  liveCount,
  approvalCount,
  healthy,
  commandOpen,
  onCommandOpen,
  onRunningOpen,
  onApprovalsOpen,
  onSidebarToggle,
  onBack,
  canGoBack,
  colorMode,
  onColorModeToggle,
}: {
  title: string;
  detail?: string | null;
  liveCount: number;
  approvalCount: number;
  healthy: boolean;
  commandOpen: boolean;
  onCommandOpen: () => void;
  onRunningOpen: () => void;
  onApprovalsOpen: () => void;
  onSidebarToggle: () => void;
  onBack: () => void;
  canGoBack: boolean;
  colorMode: 'light' | 'dark';
  onColorModeToggle: () => void;
}) {
  return (
    <header className="topbar">
      <button
        type="button"
        onClick={onSidebarToggle}
        className="foot-btn topbar-icon-btn"
        title="Toggle sidebar"
        aria-label="Toggle sidebar"
      >
        <PanelLeft className="h-4 w-4" />
      </button>

      <button
        type="button"
        onClick={onBack}
        disabled={!canGoBack}
        className="foot-btn topbar-icon-btn disabled:cursor-not-allowed disabled:opacity-40"
        title="Go back"
        aria-label="Go back"
      >
        <ArrowLeft className="h-4 w-4" />
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

      <div className="topbar-status hidden md:flex">
        <button
          type="button"
          onClick={onRunningOpen}
          className="chip topbar-chip"
          title="Active runs across all workspaces"
        >
          <span className={`dot ${liveCount > 0 ? 'dot-run' : 'dot-idle'} ${liveCount > 0 ? 'animate-pulse' : ''}`} />
          {liveCount} running
        </button>
        <button
          type="button"
          onClick={onApprovalsOpen}
          className="chip topbar-chip"
          title="Pending approvals and questions"
        >
          <span className={`dot ${approvalCount > 0 ? 'dot-warn' : 'dot-idle'}`} />
          {approvalCount} approvals
        </button>
        <span className={healthy ? 'chip topbar-chip chip-ok' : 'chip topbar-chip chip-warn'}>
          <span className={healthy ? 'dot dot-ok' : 'dot dot-warn'} />
          {healthy ? 'Connected' : 'Reconnecting'}
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
        <ShortcutKey value="⌘K" />
      </button>

      <button
        type="button"
        onClick={onColorModeToggle}
        className="foot-btn topbar-icon-btn"
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
          <ShortcutKey value="esc" className="h-5 min-w-[30px]" />
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

function navTargetMatches(to: string, location: ReturnType<typeof useLocation>): boolean {
  const [path, query = ''] = to.split('?');
  if (location.pathname !== path) return false;
  if (!query) return true;
  const expected = new URLSearchParams(query);
  const current = new URLSearchParams(location.search);
  for (const [key, value] of expected.entries()) {
    if (key === 'section' && value === 'teams-agents' && !current.get(key)) continue;
    if ((current.get(key) ?? '') !== value) return false;
  }
  return true;
}

function isNavItemActive(
  item: NavItem,
  location: ReturnType<typeof useLocation>,
  isActive = false,
): boolean {
  if (navTargetMatches(item.to, location)) return true;
  if (item.end) return location.pathname === item.to;
  if (item.activePrefixes?.some(prefix => location.pathname.startsWith(prefix))) return true;
  if (item.to.includes('?')) return false;
  return isActive;
}

function isNavGroupActive(group: NavGroup, location: ReturnType<typeof useLocation>): boolean {
  return group.items.some(item => isNavItemActive(item, location));
}

// ── Main App ──

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const title = routeTitle(location.pathname);
  const [expandedNav, setExpandedNav] = useState<Record<string, boolean>>({});
  const [chatTopbarTitle, setChatTopbarTitle] = useState<string | null>(null);
  const detail = routeDetail(location.pathname, chatTopbarTitle);
  const [commandOpen, setCommandOpen] = useState(false);
  const [liveCount, setLiveCount] = useState(0);
  const [approvalCount, setApprovalCount] = useState(0);
  const [healthKnown, setHealthKnown] = useState(false);
  const [navCounts, setNavCounts] = useState<NavCounts>({});
  const [canGoBack, setCanGoBack] = useState(false);

  const currentUser = useAuthStore((s) => s.user);

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
    const index = window.history.state?.idx;
    setCanGoBack(typeof index === 'number' ? index > 0 : window.history.length > 1);
  }, [location.key]);

  useEffect(() => {
    let cancelled = false;
    async function loadLiveCount() {
      try {
        const [{ count }, pending] = await Promise.all([
          executionsApi.count({ status: ['running', 'queued'] }),
          interventionsApi.list({ status: 'pending', limit: 100 }),
        ]);
        if (cancelled) return;
        setLiveCount(count ?? 0);
        setApprovalCount(pending.length ?? 0);
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
      const sessionParams = currentUser?.id ? { ownerUserId: currentUser.id } : undefined;
      const [
        pending,
        sessions,
        tickets,
        prs,
        spaces,
        recentRuns,
        activeRuns,
      ] = await Promise.allSettled([
        interventionsApi.list({ status: 'pending', limit: 100 }),
        chatApi.listSessions(sessionParams),
        linearApi.issues({ limit: 200 }),
        pullRequestsApi.list(),
        workspacesApi.list(),
        executionsApi.listPaged({ limit: 1, offset: 0 }),
        executionsApi.listPaged({ status: 'running', limit: 100, offset: 0 }),
      ]);
      if (cancelled) return;

      const pendingCount = pending.status === 'fulfilled' ? (pending.value ?? []).length : undefined;
      const activeCount = activeRuns.status === 'fulfilled'
        ? (activeRuns.value.items ?? []).filter((run: any) => Boolean(run?.meta?.chatSessionId)).length
        : undefined;
      const userSessions = sessions.status === 'fulfilled' ? (sessions.value ?? []) : [];
      setNavCounts({
        mywork: (pendingCount ?? 0) + (activeCount ?? 0),
        chats: sessions.status === 'fulfilled' ? userSessions.length : undefined,
        tickets: tickets.status === 'fulfilled' ? (tickets.value ?? []).length : undefined,
        pulls: prs.status === 'fulfilled' ? (prs.value ?? []).length : undefined,
        workspaces: spaces.status === 'fulfilled' ? (spaces.value ?? []).length : undefined,
        activity: recentRuns.status === 'fulfilled' ? recentRuns.value.total ?? 0 : undefined,
      });
    }
    void loadNavCounts();
    const interval = setInterval(loadNavCounts, 30000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [currentUser?.id]);

  useEffect(() => {
    const activeGroup = NAV_GROUPS.find(group => group.collapsible && isNavGroupActive(group, location));
    if (!activeGroup) return;
    setExpandedNav(prev => prev[activeGroup.id] ? prev : { ...prev, [activeGroup.id]: true });
  }, [location.pathname, location.search]);

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
    defaultSize: 264,
    minSize: 236,
    maxSize: 360,
  });

  const toggleNavGroup = (groupId: string) => {
    setExpandedNav(prev => ({ ...prev, [groupId]: !prev[groupId] }));
  };

  const isSettingsRoute = location.pathname.startsWith('/settings');
  const shellNavState = navPanel.collapsed && !isSettingsRoute ? 'nav-collapsed' : 'nav-expanded';

  return (
    <div className={`app-shell ${shellNavState} ${isSettingsRoute ? 'settings-shell' : ''}`}>
      {/* Navigation sidebar — collapsible and resizable */}
      {isSettingsRoute ? (
        <nav className="sidebar settings-mode-sidebar">
          <div className="settings-mode-head">
            <button
              type="button"
              className="settings-back-button"
              onClick={() => navigate('/')}
            >
              <ArrowLeft className="h-4 w-4" />
              <span>Back to app</span>
            </button>
          </div>

          <div className="sidebar-inner settings-mode-inner scroll-hide">
            {SETTINGS_NAV_GROUPS.map(group => (
              <div key={group.id} className="settings-mode-group">
                {group.label && <div className="settings-mode-label">{group.label}</div>}
                <div className="settings-mode-items">
                  {group.items
                    .filter(item => item.to !== '/settings/team' || currentUser?.role === 'admin')
                    .map(item => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.end}
                      className={({ isActive }) =>
                        `settings-mode-item ${
                          isNavItemActive(item, location, isActive)
                          || (item.to === '/settings/general' && location.pathname === '/settings')
                            ? 'active'
                            : ''
                        }`
                      }
                    >
                      <item.icon className="ico" />
                      <span>{item.label}</span>
                    </NavLink>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </nav>
      ) : navPanel.collapsed ? (
        <div className="sidebar sidebar-icon">
          <div className="brand brand-collapsed">
            <button
              onClick={navPanel.toggle}
              className="brand-mark"
              title="Expand navigation"
              aria-label="Expand navigation"
            >
              [a]
            </button>
          </div>
          <div className="sidebar-inner scroll-hide">
            {NAV_GROUPS.map(group => {
              const groupOpen = !group.collapsible || Boolean(expandedNav[group.id]);
              const groupActive = group.collapsible && isNavGroupActive(group, location);

              return (
                <div key={group.id} className="nav-group">
                  {group.label && group.collapsible && (
                    <button
                      type="button"
                      className={`nav-group-toggle nav-group-toggle-icon ${groupActive ? 'active' : ''}`}
                      aria-expanded={groupOpen}
                      onClick={() => toggleNavGroup(group.id)}
                      aria-label={group.label}
                      data-sidebar-tooltip={group.label}
                    >
                      <ChevronRight className={`nav-caret ${groupOpen ? 'open' : ''}`} />
                    </button>
                  )}

                  {groupOpen && (
                    <div className="nav-group-items">
                      {group.items.map(item => (
                        <NavLink
                          key={item.to}
                          to={item.to}
                          end={item.end ?? item.to === '/'}
                          className={({ isActive }) =>
                            `nav-item ${isNavItemActive(item, location, isActive) ? 'active' : ''}`
                          }
                          aria-label={item.label}
                          data-sidebar-tooltip={item.label}
                        >
                          <item.icon className="ico" />
                          <span className="lbl">{item.label}</span>
                        </NavLink>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="sidebar-foot-wrap sidebar-foot-icon">
            <NavLink
              to="/settings/general"
              className="foot-btn"
              aria-label="Settings"
              data-sidebar-tooltip="Settings"
            >
              <Settings className="w-4 h-4" />
            </NavLink>
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
            <span className="brand-sub">v0.1.0</span>
          </div>

          {/* Nav groups */}
          <div className="sidebar-inner scroll-hide">
            {NAV_GROUPS.map(group => {
              const groupOpen = !group.collapsible || Boolean(expandedNav[group.id]);
              const groupActive = group.collapsible && isNavGroupActive(group, location);

              return (
                <div key={group.id} className="nav-group">
                  {group.label && group.collapsible && (
                    <button
                      type="button"
                      className={`nav-group-toggle ${groupActive ? 'active' : ''}`}
                      aria-expanded={groupOpen}
                      onClick={() => toggleNavGroup(group.id)}
                    >
                      <span>{group.label}</span>
                      <ChevronRight className={`nav-caret ${groupOpen ? 'open' : ''}`} />
                    </button>
                  )}

                  {groupOpen && (
                    <div className="nav-group-items">
                      {group.items.map(item => {
                        const badge = formatNavBadge(item.badgeKey ? navCounts[item.badgeKey] : undefined);
                        return (
                          <NavLink
                            key={item.to}
                            to={item.to}
                            end={item.end ?? item.to === '/'}
                            className={({ isActive }) =>
                              `nav-item ${isNavItemActive(item, location, isActive) ? 'active' : ''}`
                            }
                          >
                            <item.icon className="ico" />
                            <span className="lbl">{item.label}</span>
                            {badge && (
                              <span className="badge">
                                {badge}
                              </span>
                            )}
                          </NavLink>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
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
                <NavLink
                  to="/settings/general"
                  className="foot-btn"
                  title="Settings"
                >
                  <Settings className="w-3.5 h-3.5" />
                </NavLink>
              </div>
            )}
            {!currentUser && (
              <NavLink
                to="/settings/general"
                className={({ isActive }) => `nav-item sidebar-settings-link ${isActive ? 'active' : ''}`}
              >
                <Settings className="ico" />
                <span className="lbl">Settings</span>
              </NavLink>
            )}
          </div>
        </nav>
      )}

      <main className="flex-1 min-w-0 bg-app relative flex flex-col overflow-hidden">
        <AppTopbar
          title={title}
          detail={detail}
          liveCount={liveCount}
          approvalCount={approvalCount}
          healthy={healthKnown}
          commandOpen={commandOpen}
          onCommandOpen={() => setCommandOpen(true)}
          onRunningOpen={() => navigate('/executions?status=running')}
          onApprovalsOpen={() => navigate('/interventions')}
          onSidebarToggle={navPanel.toggle}
          onBack={() => navigate(-1)}
          canGoBack={canGoBack}
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
