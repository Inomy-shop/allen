import { useEffect } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import ErrorBoundary from './components/common/ErrorBoundary';
import {
  LayoutDashboard,
  GitBranch,
  Play,
  Users,
  Activity,
  Settings,
  FolderGit2,
} from 'lucide-react';
import { useSettingsStore } from './stores/settingsStore';

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/workflows', icon: GitBranch, label: 'Workflows' },
  { to: '/repos', icon: FolderGit2, label: 'Repos' },
  { to: '/executions', icon: Play, label: 'Executions' },
  { to: '/roles', icon: Users, label: 'Roles' },
];

export default function App() {
  const initSettings = useSettingsStore((s) => s.initFromLocalStorage);
  useEffect(() => { initSettings(); }, [initSettings]);

  return (
    <div className="flex h-screen">
      {/* Sidebar — mission control panel */}
      <nav className="w-56 bg-surface-50 border-r border-border/50 flex flex-col shrink-0 relative">
        {/* Thin accent line on the right edge */}
        <div className="absolute right-0 top-0 bottom-0 w-px bg-gradient-to-b from-accent-blue/40 via-accent-blue/10 to-transparent" />

        <div className="p-4 border-b border-border/50">
          <div className="flex items-center gap-2.5">
            <div className="relative">
              <Activity className="w-6 h-6 text-accent-blue" />
              <div className="absolute inset-0 blur-md bg-accent-blue/30 rounded-full" />
            </div>
            <span className="font-heading text-base font-bold text-white tracking-widest uppercase">FlowForge</span>
          </div>
        </div>
        <div className="flex-1 py-3">
          {navItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 px-4 py-2.5 mx-2 rounded-sm text-sm font-label uppercase tracking-wider transition-all duration-200 ${
                  isActive
                    ? 'bg-accent-blue/10 text-accent-blue border-l-2 border-accent-blue shadow-glow-blue/20'
                    : 'text-gray-500 hover:text-gray-300 hover:bg-surface-200/50 border-l-2 border-transparent'
                }`
              }
            >
              <Icon className="w-4 h-4" />
              {label}
            </NavLink>
          ))}
        </div>
        <div className="border-t border-border/50">
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              `flex items-center gap-3 px-4 py-2.5 mx-2 my-1 rounded-sm text-sm font-label uppercase tracking-wider transition-all duration-200 ${
                isActive
                  ? 'bg-accent-blue/10 text-accent-blue border-l-2 border-accent-blue shadow-glow-blue/20'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-surface-200/50 border-l-2 border-transparent'
              }`
            }
          >
            <Settings className="w-4 h-4" />
            Settings
          </NavLink>
          <div className="px-4 pb-3 pt-1 text-xs text-gray-600 font-mono tracking-wider">
            FLOWFORGE v0.1.0
          </div>
        </div>
      </nav>

      {/* Main content with grid background */}
      <main className="flex-1 overflow-auto grid-bg relative">
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}
