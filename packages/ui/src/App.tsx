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
  executions as executionsApi,
  interventions as interventionsApi,
} from './services/api';
import { workspaces as workspacesApi } from './services/workspaceService';
import { usePanelLayout } from './hooks/usePanelLayout';

interface NavItem {
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  activePrefixes?: string[];
  end?: boolean;
}

interface NavGroup {
  id: string;
  label?: string;
  dividerBefore?: boolean;
  items: NavItem[];
}

interface CommandItem {
  id: string;
  label: string;
  group: string;
  to: string;
  icon: React.ComponentType<{ className?: string }>;
}

type SidebarPanelId = 'workspaces' | 'navigation';

interface SidebarWorkspace {
  _id: string;
  name: string;
  repoId?: string;
  repoName?: string;
  repoPath?: string;
  branch?: string;
  status?: string;
  source?: string;
  prNumber?: number;
  updatedAt?: string;
  createdAt?: string;
}

// ── Nav Groups (Allen design system: flat navigation with subtle dividers) ──

const NAV_GROUPS: NavGroup[] = [
  { id: 'primary', items: [
    { to: '/', icon: LayoutDashboard, label: 'Dashboard', end: true },
    { to: '/executions', icon: CirclePlay, label: 'Executions', activePrefixes: ['/executions'] },
    { to: '/chats', icon: History, label: 'History', activePrefixes: ['/chats', '/chat'] },
  ]},
  { id: 'sources', dividerBefore: true, items: [
    { to: '/tickets', icon: TicketCheck, label: 'Linear' },
    { to: '/pull-requests', icon: GitPullRequest, label: 'Pull requests' },
    { to: '/agents?section=repos', icon: GitBranch, label: 'Repositories' },
    { to: '/workspaces', icon: FolderGit2, label: 'Workspaces' },
  ]},
  { id: 'studio', dividerBefore: true, items: [
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

const SIDEBAR_PANEL_ORDER: SidebarPanelId[] = ['navigation', 'workspaces'];
const SIDEBAR_PANEL_LABELS: Record<SidebarPanelId, string> = {
  workspaces: 'Workspaces',
  navigation: 'App navigation',
};
const WORKSPACE_REPO_COLLAPSE_KEY = 'allen-app-sidebar-collapsed-workspace-repos';
const SETTINGS_ROUTE_DETAILS: Array<{ prefix: string; label: string }> = [
  { prefix: '/settings/runtime', label: 'Runtime' },
  { prefix: '/settings/mcp', label: 'MCP Servers' },
  { prefix: '/settings/schedules', label: 'Schedules' },
  { prefix: '/settings/learnings', label: 'Learnings' },
  { prefix: '/settings/team', label: 'Team' },
  { prefix: '/settings/account', label: 'Account' },
  { prefix: '/settings/general', label: 'General' },
  { prefix: '/settings', label: 'General' },
];

function loadCollapsedWorkspaceRepos(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(WORKSPACE_REPO_COLLAPSE_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

function saveCollapsedWorkspaceRepos(value: Set<string>) {
  try {
    window.localStorage.setItem(WORKSPACE_REPO_COLLAPSE_KEY, JSON.stringify(Array.from(value)));
  } catch {
    // Ignore storage failures; the sidebar still works without persistence.
  }
}

function sidebarWorkspaceTime(workspace: SidebarWorkspace): number {
  const raw = workspace.updatedAt ?? workspace.createdAt ?? '';
  const time = raw ? new Date(raw).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

function workspaceRepoLabel(workspace: SidebarWorkspace): string {
  return workspace.repoName
    ?? workspace.repoPath?.split('/').filter(Boolean).at(-1)
    ?? 'Unknown repo';
}

function routeTitle(pathname: string, search = ''): string {
  if (pathname === '/') return 'Dashboard';
  if (pathname.startsWith('/agents')) {
    const params = new URLSearchParams(search);
    const section = params.get('section') ?? params.get('tab') ?? 'teams-agents';
    if (section === 'repos') return 'Repositories';
    if (section === 'skills') return 'Skills';
    if (section === 'integrations') return 'Integrations';
    return 'Teams & Agents';
  }
  const match = ROUTE_TITLES.find(route => pathname.startsWith(route.prefix));
  return match?.label ?? 'Allen';
}

function routeDetail(pathname: string, chatTopbarTitle: string | null): string | null {
  if (/^\/repos\/[^/]+\/context-management/.test(pathname)) return 'Context Management';
  if (/^\/chat\/[^/]+/.test(pathname)) return chatTopbarTitle;
  const settingsDetail = SETTINGS_ROUTE_DETAILS.find(route => pathname.startsWith(route.prefix));
  if (settingsDetail) return settingsDetail.label;
  return null;
}

function AppTopbar({
  title,
  detail,
  liveCount,
  approvalCount,
  commandOpen,
  onCommandOpen,
  onRunningOpen,
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
  commandOpen: boolean;
  onCommandOpen: () => void;
  onRunningOpen: () => void;
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
        <span className={detail ? undefined : 'now'}>{title}</span>
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
        <span
          className="chip topbar-chip"
          title="Pending approvals and questions"
        >
          <span className={`dot ${approvalCount > 0 ? 'dot-warn' : 'dot-idle'}`} />
          {approvalCount} approvals
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

// ── Main App ──

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const title = routeTitle(location.pathname, location.search);
  const [chatTopbarTitle, setChatTopbarTitle] = useState<string | null>(null);
  const detail = routeDetail(location.pathname, chatTopbarTitle);
  const [commandOpen, setCommandOpen] = useState(false);
  const [liveCount, setLiveCount] = useState(0);
  const [approvalCount, setApprovalCount] = useState(0);
  const [canGoBack, setCanGoBack] = useState(false);
  const [sidebarPanel, setSidebarPanel] = useState<SidebarPanelId>('navigation');
  const [workspaceSearch, setWorkspaceSearch] = useState('');
  const [sidebarWorkspaces, setSidebarWorkspaces] = useState<SidebarWorkspace[]>([]);
  const [sidebarWorkspacesLoading, setSidebarWorkspacesLoading] = useState(false);
  const [collapsedWorkspaceRepos, setCollapsedWorkspaceRepos] = useState<Set<string>>(() => loadCollapsedWorkspaceRepos());
  const sidebarGestureLockRef = useRef(false);
  const sidebarWheelGestureActiveRef = useRef(false);
  const sidebarWheelCanRearmRef = useRef(true);
  const sidebarWheelDirectionRef = useRef<1 | -1 | null>(null);
  const sidebarWheelGestureTimerRef = useRef<number | null>(null);
  const sidebarPointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const sidebarCarouselRef = useRef<HTMLDivElement | null>(null);

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
  const activeWorkspaceId = location.pathname.match(/^\/workspaces\/([^/]+)/)?.[1] ?? null;
  const workspaceGroups = useMemo(() => {
    const query = workspaceSearch.trim().toLowerCase();
    const visible = sidebarWorkspaces
      .filter((workspace) => {
        if (!query) return true;
        return workspace.name.toLowerCase().includes(query)
          || workspaceRepoLabel(workspace).toLowerCase().includes(query)
          || (workspace.branch ?? '').toLowerCase().includes(query);
      })
      .sort((a, b) => sidebarWorkspaceTime(b) - sidebarWorkspaceTime(a));

    const groups = new Map<string, { key: string; label: string; items: SidebarWorkspace[]; latest: number }>();
    for (const workspace of visible) {
      const label = workspaceRepoLabel(workspace);
      const key = workspace.repoId ?? `repo:${label.toLowerCase()}`;
      const latest = sidebarWorkspaceTime(workspace);
      const existing = groups.get(key);
      if (existing) {
        existing.items.push(workspace);
        existing.latest = Math.max(existing.latest, latest);
      } else {
        groups.set(key, { key, label, items: [workspace], latest });
      }
    }

    return Array.from(groups.values()).sort((a, b) => b.latest - a.latest);
  }, [sidebarWorkspaces, workspaceSearch]);

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
      } catch {
        // Keep the last visible counts if the poll fails.
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
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return;

      const key = event.key.toLowerCase();
      if (key === 'k') {
        event.preventDefault();
        setCommandOpen(true);
        return;
      }

      if (key === 'l') {
        const isChatInputRoute = location.pathname === '/'
          || location.pathname === '/chat'
          || location.pathname.startsWith('/chat/');
        if (isChatInputRoute) return;

        event.preventDefault();
        navigate('/', { state: { focusDashboardChat: Date.now() } });
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [location.pathname, navigate]);

  useEffect(() => {
    if (sidebarPanel !== 'workspaces') return;
    let cancelled = false;
    setSidebarWorkspacesLoading(true);
    workspacesApi.list()
      .then((items) => {
        if (!cancelled) setSidebarWorkspaces((items ?? []) as SidebarWorkspace[]);
      })
      .catch(() => {
        if (!cancelled) setSidebarWorkspaces([]);
      })
      .finally(() => {
        if (!cancelled) setSidebarWorkspacesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sidebarPanel]);

  useEffect(() => {
    return () => {
      if (sidebarWheelGestureTimerRef.current !== null) {
        window.clearTimeout(sidebarWheelGestureTimerRef.current);
      }
    };
  }, []);

  const navPanel = usePanelLayout({
    storageKey: 'app-nav',
    direction: 'horizontal',
    defaultSize: 290,
    minSize: 260,
    maxSize: 396,
  });

  const isSettingsRoute = location.pathname.startsWith('/settings');
  const shellNavState = navPanel.collapsed && !isSettingsRoute ? 'nav-collapsed' : 'nav-expanded';
  const sidebarPanelIndex = Math.max(0, SIDEBAR_PANEL_ORDER.indexOf(sidebarPanel));

  function moveSidebarPanel(direction: -1 | 1, respectTransitionLock = true) {
    if (respectTransitionLock && sidebarGestureLockRef.current) return;

    let moved = false;
    setSidebarPanel((currentPanel) => {
      const currentIndex = SIDEBAR_PANEL_ORDER.indexOf(currentPanel);
      const nextIndex = Math.max(0, Math.min(SIDEBAR_PANEL_ORDER.length - 1, currentIndex + direction));
      const nextPanel = SIDEBAR_PANEL_ORDER[nextIndex];
      if (!nextPanel || nextPanel === currentPanel) return currentPanel;
      moved = true;
      return nextPanel;
    });

    if (moved && respectTransitionLock) {
      sidebarGestureLockRef.current = true;
      window.setTimeout(() => {
        sidebarGestureLockRef.current = false;
      }, 380);
    }
  }

  function handleSidebarCarouselWheel(event: WheelEvent) {
    if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
    event.preventDefault();
    const absDeltaX = Math.abs(event.deltaX);
    const direction = event.deltaX > 0 ? 1 : -1;

    if (sidebarWheelGestureTimerRef.current !== null) {
      window.clearTimeout(sidebarWheelGestureTimerRef.current);
    }
    sidebarWheelGestureTimerRef.current = window.setTimeout(() => {
      sidebarWheelGestureActiveRef.current = false;
      sidebarWheelCanRearmRef.current = true;
      sidebarWheelDirectionRef.current = null;
      sidebarWheelGestureTimerRef.current = null;
    }, 100);

    if (absDeltaX <= 4 || direction !== sidebarWheelDirectionRef.current) {
      sidebarWheelCanRearmRef.current = true;
    }
    if (sidebarWheelGestureActiveRef.current && !sidebarWheelCanRearmRef.current) return;
    if (absDeltaX < 16) return;

    sidebarWheelGestureActiveRef.current = true;
    sidebarWheelCanRearmRef.current = false;
    sidebarWheelDirectionRef.current = direction;
    moveSidebarPanel(direction, false);
  }

  useEffect(() => {
    const carousel = sidebarCarouselRef.current;
    if (!carousel) return;
    carousel.addEventListener('wheel', handleSidebarCarouselWheel, { passive: false });
    return () => {
      carousel.removeEventListener('wheel', handleSidebarCarouselWheel);
    };
  }, []);

  function handleSidebarPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'mouse') return;
    sidebarPointerStartRef.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handleSidebarPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'mouse') return;
    const start = sidebarPointerStartRef.current;
    sidebarPointerStartRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (!start) return;

    const deltaX = start.x - event.clientX;
    const deltaY = start.y - event.clientY;
    if (Math.abs(deltaX) > 44 && Math.abs(deltaX) > Math.abs(deltaY) * 1.2) {
      moveSidebarPanel(deltaX > 0 ? 1 : -1);
    }
  }

  function toggleWorkspaceRepo(repoKey: string) {
    setCollapsedWorkspaceRepos((current) => {
      const next = new Set(current);
      next.has(repoKey) ? next.delete(repoKey) : next.add(repoKey);
      saveCollapsedWorkspaceRepos(next);
      return next;
    });
  }

  return (
    <div className={`app-shell ${shellNavState} ${isSettingsRoute ? 'settings-shell' : ''}`}>
      {/* Navigation sidebar — collapsible and resizable */}
      {isSettingsRoute ? (
        <nav className="sidebar settings-mode-sidebar !w-[290px] !min-w-[290px] [animation:none]">
          <div className="settings-mode-head">
            <button
              type="button"
              className="settings-back-button"
              onClick={() => {
                setSidebarPanel('navigation');
                navigate('/');
              }}
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
            {NAV_GROUPS.map(group => (
              <div key={group.id} className={`nav-group ${group.dividerBefore ? 'mt-2 pt-2 before:mx-2 before:mb-2 before:block before:border-t before:border-app before:content-[""]' : ''}`}>
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
              </div>
            ))}
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
        <nav
          className="sidebar !w-[290px] !min-w-[290px] [animation:none]"
        >
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

          <div
            ref={sidebarCarouselRef}
            className="min-h-0 flex-1 overflow-hidden overscroll-contain touch-pan-y"
            onPointerDown={handleSidebarPointerDown}
            onPointerUp={handleSidebarPointerUp}
            onPointerCancel={() => {
              sidebarPointerStartRef.current = null;
            }}
          >
            <div
              className="flex h-full transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
              style={{ transform: `translate3d(-${sidebarPanelIndex * 100}%, 0, 0)` }}
            >
              <div className="order-2 min-w-0 w-full shrink-0">
                <div className="flex min-h-0 h-full flex-col">
                  <div className="px-4 pb-3 pt-2">
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-theme-muted" />
                      <input
                        value={workspaceSearch}
                        onChange={(event) => setWorkspaceSearch(event.target.value)}
                        placeholder="Search workspaces"
                        className="input h-9 w-full pl-8 pr-3 text-[12px]"
                      />
                    </div>
                  </div>
                  <div className="scroll-hide flex-1 space-y-3 overflow-y-auto px-2 pb-3">
                    {sidebarWorkspacesLoading && (
                      <div className="px-3 py-4 text-center text-[12px] text-theme-subtle">Loading workspaces...</div>
                    )}
                    {!sidebarWorkspacesLoading && workspaceGroups.length === 0 && (
                      <div className="px-3 py-4 text-center text-[12px] text-theme-subtle">
                        {workspaceSearch.trim() ? 'No matching workspaces.' : 'No recent workspaces.'}
                      </div>
                    )}
                    {workspaceGroups.map((group) => {
                      const collapsed = collapsedWorkspaceRepos.has(group.key);
                      const hasActive = group.items.some((workspace) => workspace._id === activeWorkspaceId);
                      const showItems = !collapsed || hasActive;
                      return (
                        <div key={group.key}>
                          <button
                            type="button"
                            onClick={() => toggleWorkspaceRepo(group.key)}
                            className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-theme-secondary transition-colors hover:bg-app-muted hover:text-theme-primary"
                          >
                            <ChevronRight className={`h-3 w-3 shrink-0 text-theme-subtle transition-transform ${showItems ? 'rotate-90' : ''}`} />
                            <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-theme-muted" />
                            <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{group.label}</span>
                            <span className="font-mono text-[10px] text-theme-subtle">{group.items.length}</span>
                          </button>
                          {showItems && (
                            <div className="mt-1 space-y-1">
                              {group.items.map((workspace) => {
                                const active = workspace._id === activeWorkspaceId;
                                return (
                                  <button
                                    key={workspace._id}
                                    type="button"
                                    onClick={() => navigate(`/workspaces/${workspace._id}`)}
                                    className={`group flex w-full items-start rounded-md border px-2.5 py-2 text-left transition-colors ${
                                      active
                                        ? 'border-app bg-app-card text-theme-primary'
                                        : 'border-transparent text-theme-secondary hover:bg-app-muted hover:text-theme-primary'
                                    }`}
                                  >
                                    <span className="min-w-0 flex-1">
                                      <span className="block truncate text-[12.5px] font-medium leading-tight">{workspace.name}</span>
                                      <span className="mt-1 flex min-w-0 items-center gap-1.5 font-mono text-[10px] text-theme-subtle">
                                        {workspace.branch && <span className="truncate">{workspace.branch}</span>}
                                        {workspace.source === 'pr' && workspace.prNumber && <span>PR #{workspace.prNumber}</span>}
                                        {workspace.status && <span>{workspace.status}</span>}
                                      </span>
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="order-1 min-w-0 w-full shrink-0">
                <div className="sidebar-inner scroll-hide">
                  {NAV_GROUPS.map(group => (
                    <div key={group.id} className={`nav-group ${group.dividerBefore ? 'mt-2 pt-2 before:mx-3 before:mb-2 before:block before:border-t before:border-app before:content-[""]' : ''}`}>
                      <div className="nav-group-items">
                        {group.items.map(item => (
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
                          </NavLink>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-center gap-2 px-3 py-2">
            {SIDEBAR_PANEL_ORDER.map((panel) => (
              <button
                key={panel}
                type="button"
                aria-label={SIDEBAR_PANEL_LABELS[panel]}
                aria-current={sidebarPanel === panel ? 'true' : undefined}
                title={SIDEBAR_PANEL_LABELS[panel]}
                onClick={() => setSidebarPanel(panel)}
                className={`h-2.5 w-2.5 rounded-full border transition-colors ${
                  sidebarPanel === panel
                    ? 'border-accent bg-accent'
                    : 'border-theme-subtle/40 bg-theme-subtle/35 hover:border-theme-subtle/60 hover:bg-theme-subtle/60'
                }`}
              />
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
          commandOpen={commandOpen}
          onCommandOpen={() => setCommandOpen(true)}
          onRunningOpen={() => navigate('/executions?status=running')}
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
