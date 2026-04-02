import { Routes, Route, NavLink } from 'react-router-dom';
import ErrorBoundary from './components/common/ErrorBoundary';
import {
  LayoutDashboard,
  GitBranch,
  Play,
  Users,
  Activity,
} from 'lucide-react';
import WorkflowListPage from './pages/WorkflowListPage';
import ExecutionListPage from './pages/ExecutionListPage';
import ExecutionDetailPage from './pages/ExecutionDetailPage';
import DashboardPage from './pages/DashboardPage';
import RoleManagerPage from './pages/RoleManagerPage';

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/workflows', icon: GitBranch, label: 'Workflows' },
  { to: '/executions', icon: Play, label: 'Executions' },
  { to: '/roles', icon: Users, label: 'Roles' },
];

export default function App() {
  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <nav className="w-56 bg-surface-50 border-r border-border flex flex-col shrink-0">
        <div className="p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Activity className="w-6 h-6 text-accent-blue" />
            <span className="text-lg font-bold text-white">FlowForge</span>
          </div>
        </div>
        <div className="flex-1 py-2">
          {navItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 px-4 py-2.5 mx-2 rounded-md text-sm transition-colors ${
                  isActive
                    ? 'bg-surface-200 text-white'
                    : 'text-gray-400 hover:text-gray-200 hover:bg-surface-100'
                }`
              }
            >
              <Icon className="w-4 h-4" />
              {label}
            </NavLink>
          ))}
        </div>
        <div className="p-4 border-t border-border text-xs text-gray-500">
          FlowForge v0.1.0
        </div>
      </nav>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <ErrorBoundary>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/workflows" element={<WorkflowListPage />} />
            <Route path="/executions" element={<ExecutionListPage />} />
            <Route path="/executions/:id" element={<ExecutionDetailPage />} />
            <Route path="/roles" element={<RoleManagerPage />} />
          </Routes>
        </ErrorBoundary>
      </main>
    </div>
  );
}
