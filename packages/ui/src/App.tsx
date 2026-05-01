import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import ErrorBoundary from './components/common/ErrorBoundary';
import NotificationBell from './components/common/NotificationBell';
import {
  LayoutDashboard, GitBranch, Play, Users, Settings,
  FolderGit2, Brain, MessageSquare,
  Server, User, ChevronDown, ChevronRight, ChevronLeft,
  GitPullRequest, Clock, HelpCircle, Ticket, LogOut, ShieldCheck,
  Sun, Moon,
} from 'lucide-react';
import { useSettingsStore } from './stores/settingsStore';
import { resolveColorMode } from './lib/theme';
import { useAuthStore } from './stores/authStore';
import { BRAND_NAME } from './lib/brand';
import { auth as authApi } from './services/api';
import { usePanelLayout } from './hooks/usePanelLayout';

interface SettingsTab {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  adminOnly?: boolean;
}

// ── Nav Groups (Linear-style: WORKSPACE / BUILD / CODE / INSIGHT) ──

const NAV_GROUPS = [
  { label: 'Workspace', items: [
    { to: '/chat', icon: MessageSquare, label: 'Chat', expandable: true },
    { to: '/', icon: LayoutDashboard, label: 'Overview' },
    { to: '/executions', icon: Play, label: 'Activity' },
    { to: '/interventions', icon: HelpCircle, label: 'Needs review' },
  ]},
  { label: 'Build', items: [
    { to: '/workflows', icon: GitBranch, label: 'Workflows' },
    { to: '/agents', icon: Users, label: 'Agents' },
    { to: '/crons', icon: Clock, label: 'Schedules' },
  ]},
  { label: 'Code', items: [
    { to: '/repos', icon: FolderGit2, label: 'Repositories' },
    { to: '/workspaces', icon: FolderGit2, label: 'Workspaces' },
    { to: '/pull-requests', icon: GitPullRequest, label: 'Pull requests' },
    { to: '/tickets', icon: Ticket, label: 'Linear' },
  ]},
  { label: 'Insight', items: [
    { to: '/learnings', icon: Brain, label: 'Learnings' },
  ]},
];

const SETTINGS_TABS: SettingsTab[] = [
  { id: 'profile', label: 'Profile', icon: User },
  { id: 'users', label: 'Users', icon: ShieldCheck, adminOnly: true },
  { id: 'mcp', label: 'MCP Servers', icon: Server },
];

// ── Settings Sidebar Section ──

function SettingsSidebarSection({ onCollapse }: { onCollapse?: () => void }) {
  const location = useLocation();
  const activeTab = location.pathname.split('/settings/')[1] ?? 'profile';
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const visibleTabs = SETTINGS_TABS.filter((t) => !t.adminOnly || isAdmin);

  return (
    <div className="py-2">
      <div className="px-3 py-1 mb-1 flex items-center justify-between">
        <span className="overline">Settings</span>
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            className="p-0.5 rounded text-theme-muted hover:text-theme-secondary hover:bg-app-card transition-colors"
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
          className={`flex items-center gap-2.5 px-3 py-1.5 mx-1.5 rounded-md text-[13px] transition-colors ${
            activeTab === id
              ? 'bg-app-card text-theme-primary font-medium shadow-sm'
              : 'text-theme-secondary hover:text-theme-primary hover:bg-app-card'
          }`}
        >
          <Icon className={`w-4 h-4 ${activeTab === id ? 'text-accent' : 'text-theme-muted'}`} />
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

  useEffect(() => {
    const cleanup = addSystemThemeListener();
    return cleanup;
  }, [addSystemThemeListener]);

  const location = useLocation();
  const navigate = useNavigate();
  const isSettings = location.pathname.startsWith('/settings');

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

  const navPanel = usePanelLayout({
    storageKey: 'app-nav',
    direction: 'horizontal',
    defaultSize: 228,
    minSize: 180,
    maxSize: 320,
  });

  return (
    <div className="flex h-screen bg-app">
      {/* Navigation sidebar — collapsible and resizable */}
      {navPanel.collapsed ? (
        /* Collapsed nav: icon-only quick-nav. Settings, user profile, and sign-out
           are accessible after re-expanding the sidebar. */
        <div className="w-10 bg-app-muted flex flex-col shrink-0 border-r border-app items-center py-3 gap-1">
          <button
            onClick={navPanel.toggle}
            className="p-1.5 rounded text-theme-muted hover:text-theme-secondary hover:bg-app-card transition-colors mb-2"
            title="Expand navigation"
            aria-label="Expand navigation"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
          {NAV_GROUPS.flatMap(g => g.items).map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }: { isActive: boolean }) =>
                `p-1.5 rounded transition-colors ${isActive ? 'text-accent bg-app-card' : 'text-theme-muted hover:text-theme-secondary hover:bg-app-card'}`
              }
              title={item.label}
              aria-label={item.label}
            >
              <item.icon className="w-4 h-4" />
            </NavLink>
          ))}
        </div>
      ) : (
        /* Expanded: full nav with dynamic width */
        <nav style={{ width: navPanel.size }} className="bg-app-muted flex flex-col shrink-0 border-r border-app">
          {/* Workspace switcher pill — with collapse button */}
          <div className="flex items-center gap-2 mx-2 mt-3 mb-2 px-2 py-1.5 rounded-md hover:bg-app-card cursor-pointer transition-colors">
            <NavLink to="/" className="flex items-center gap-2 flex-1 min-w-0">
              <div className="w-6 h-6 rounded-md bg-gradient-to-br from-accent to-accent-purple flex items-center justify-center shrink-0">
                <span className="text-white text-[11px] font-semibold">{BRAND_NAME.charAt(0)}</span>
              </div>
              <span className="font-heading text-[13px] font-semibold text-theme-primary truncate">{BRAND_NAME}</span>
            </NavLink>
            <ChevronDown className="w-3 h-3 text-theme-muted shrink-0" />
            <button
              onClick={navPanel.toggle}
              className="p-0.5 rounded text-theme-muted hover:text-theme-secondary hover:bg-app-card transition-colors"
              title="Collapse navigation"
              aria-label="Collapse navigation"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Nav groups */}
          <div className="flex-1 overflow-y-auto pb-2">
            {NAV_GROUPS.map((group, gi) => (
              <div key={gi} className={gi > 0 ? 'mt-2' : ''}>
                {group.label && (
                  <div className="px-3 py-1">
                    <span className="overline">{group.label}</span>
                  </div>
                )}
                {group.items.map(item => (
                  <div key={item.to}>
                    <NavLink
                      to={item.to}
                      end={item.to === '/'}
                      className={({ isActive }) =>
                        `flex items-center gap-2.5 px-3 py-1.5 mx-1.5 rounded-md text-[13px] transition-colors ${
                          isActive
                            ? 'bg-app-card text-theme-primary font-medium shadow-sm'
                            : 'text-theme-secondary hover:text-theme-primary hover:bg-app-card'
                        }`
                      }
                    >
                      {({ isActive }) => (
                        <>
                          <item.icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-accent' : 'text-theme-muted'}`} />
                          <span className="flex-1 truncate">{item.label}</span>
                        </>
                      )}
                    </NavLink>
                  </div>
                ))}
              </div>
            ))}
          </div>

          {/* Bottom — Settings + user chip + version + notifications */}
          <div className="border-t border-app shrink-0">
            {settingsOpen ? (
              <SettingsSidebarSection onCollapse={() => setSettingsOpen(false)} />
            ) : (
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                className={`w-[calc(100%-12px)] flex items-center gap-2.5 px-3 py-1.5 mx-1.5 my-1 rounded-md text-[13px] transition-colors ${
                  isSettings
                    ? 'bg-app-card text-theme-primary font-medium shadow-sm'
                    : 'text-theme-secondary hover:text-theme-primary hover:bg-app-card'
                }`}
              >
                <Settings className={`w-4 h-4 ${isSettings ? 'text-accent' : 'text-theme-muted'}`} />
                <span className="flex-1 text-left">Settings</span>
                <ChevronRight className="w-3.5 h-3.5 opacity-70" />
              </button>
            )}

            {currentUser && (
              <div className="flex items-center gap-2 px-3 py-2 mx-1.5 rounded-md hover:bg-app-card group transition-colors">
                <div className="w-6 h-6 rounded-full bg-gradient-to-br from-accent to-accent-purple flex items-center justify-center shrink-0">
                  <span className="text-white text-[10px] font-semibold">{userInitial}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] text-theme-primary font-body truncate leading-tight">{currentUser.name}</div>
                  <div className="text-[10px] text-theme-subtle font-mono truncate">{currentUser.email}</div>
                </div>
                <button
                  onClick={handleLogout}
                  className="shrink-0 p-1 rounded text-theme-muted hover:text-accent-red hover:bg-accent-red/10 transition-colors"
                  title="Sign out"
                >
                  <LogOut className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            <div className="flex items-center justify-between px-3 py-1.5">
              <span className="text-[10px] text-theme-subtle font-mono">v0.1.0</span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={toggleColorMode}
                  className="p-1 rounded text-theme-muted hover:text-theme-primary hover:bg-app-card transition-colors"
                  title={`Switch to ${resolvedMode === 'dark' ? 'light' : 'dark'} mode`}
                  aria-label="Toggle theme"
                >
                  {resolvedMode === 'dark'
                    ? <Sun className="w-3.5 h-3.5" />
                    : <Moon className="w-3.5 h-3.5" />}
                </button>
                <NotificationBell />
              </div>
            </div>
          </div>
        </nav>
      )}
      {/* Resize handle — only when nav is expanded */}
      {!navPanel.collapsed && (
        <div
          onMouseDown={navPanel.onMouseDown}
          className="w-px shrink-0 cursor-col-resize bg-border hover:bg-accent active:bg-accent/70 transition-colors z-10"
        />
      )}

      <main className="flex-1 overflow-auto bg-app relative">
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}
