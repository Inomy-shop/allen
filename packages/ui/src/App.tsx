import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import ErrorBoundary from './components/common/ErrorBoundary';
import NotificationBell from './components/common/NotificationBell';
import {
  LayoutDashboard, GitBranch, Play, Users, Activity, Settings,
  FolderGit2, Brain, MessageSquare, BarChart3, Plus, Trash2,
  Server, Palette, Key, User, ChevronRight,
} from 'lucide-react';
import { useSettingsStore } from './stores/settingsStore';
import { useChat, type ChatSession } from './hooks/useChat';
import DeleteConfirmDialog from './components/common/DeleteConfirmDialog';

// ── Nav Groups ──

const NAV_GROUPS = [
  { label: null, items: [
    { to: '/chat', icon: MessageSquare, label: 'Chat', expandable: true },
    { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  ]},
  { label: 'Build', items: [
    { to: '/workflows', icon: GitBranch, label: 'Agent Workflows' },
    { to: '/agents', icon: Users, label: 'Agents' },
    { to: '/repos', icon: FolderGit2, label: 'Repos' },
  ]},
  { label: 'Monitor', items: [
    { to: '/executions', icon: Play, label: 'Executions' },
    { to: '/analytics', icon: BarChart3, label: 'Analytics' },
    { to: '/learnings', icon: Brain, label: 'Learnings' },
  ]},
];

const SETTINGS_TABS = [
  { id: 'mcp', label: 'MCP Servers', icon: Server },
  { id: 'theme', label: 'Appearance', icon: Palette },
  { id: 'secrets', label: 'Secrets', icon: Key },
  { id: 'profile', label: 'Profile', icon: User },
];

// Provider display
const PROV: Record<string, { label: string; color: string }> = {
  codex: { label: 'Codex', color: 'text-accent-green' },
  'claude-cli': { label: 'Claude', color: 'text-accent-blue' },
  gemini: { label: 'Gemini', color: 'text-accent-yellow' },
  'anthropic-api': { label: 'API', color: 'text-accent-purple' },
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
        <span className="text-[10px] font-label uppercase tracking-[0.15em] text-gray-600">Conversations</span>
        <button onClick={handleNew} className="w-7 h-7 flex items-center justify-center rounded-md bg-accent-blue/10 text-accent-blue hover:bg-accent-blue/20 transition-colors" title="New conversation">
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {loadingSessions && sessions.length === 0 && (
          <div className="px-4 py-4 text-center text-xs text-gray-700">Loading...</div>
        )}
        {!loadingSessions && sessions.length === 0 && (
          <div className="px-4 py-4 text-center text-xs text-gray-700">No conversations yet</div>
        )}
        {sessions.map(s => {
          const isActive = s._id === activeSessionId;
          const p = PROV[s.provider] ?? { label: s.provider, color: 'text-gray-500' };
          return (
            <div
              key={s._id}
              onClick={() => { switchSession(s._id); navigate(`/chat/${s._id}`, { replace: true }); }}
              className={`group flex items-center gap-2 px-3 py-2 mx-2 rounded-md cursor-pointer transition-all ${isActive ? 'bg-accent-blue/10 border-l-2 border-accent-blue' : 'border-l-2 border-transparent hover:bg-surface-200/40'}`}
            >
              <div className="flex-1 min-w-0">
                <div className="text-xs text-gray-300 font-body truncate">{s.title}</div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className={`text-[9px] font-mono ${p.color}`}>{p.label}</span>
                  <span className="text-[10px] text-gray-700 font-mono">{timeAgo(s.lastMessageAt)}</span>
                </div>
              </div>
              <button
                onClick={e => { e.stopPropagation(); setDeleting({ id: s._id, title: s.title }); }}
                className="opacity-0 group-hover:opacity-100 shrink-0 w-6 h-6 flex items-center justify-center rounded-md text-gray-700 hover:text-red-400 transition-all"
                title="Delete conversation"
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

function SettingsSidebarSection() {
  const location = useLocation();
  const activeTab = location.pathname.split('/settings/')[1] ?? 'mcp';

  return (
    <div className="py-2">
      <div className="px-5 py-1 mb-1">
        <span className="text-[10px] font-label uppercase tracking-[0.15em] text-gray-600">Settings</span>
      </div>
      {SETTINGS_TABS.map(({ id, label, icon: Icon }) => (
        <NavLink
          key={id}
          to={`/settings/${id}`}
          className={`flex items-center gap-3 px-4 py-1.5 mx-2 rounded-md text-sm font-body transition-all ${
            activeTab === id
              ? 'bg-accent-blue/10 text-accent-blue'
              : 'text-gray-500 hover:text-gray-300 hover:bg-surface-200/40'
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
  useEffect(() => { initSettings(); }, [initSettings]);

  const location = useLocation();
  const isChat = location.pathname.startsWith('/chat');
  const isSettings = location.pathname.startsWith('/settings');

  return (
    <div className="flex h-screen">
      <nav className="w-64 bg-surface-50 border-r border-border/50 flex flex-col shrink-0 relative">
        {/* Accent edge */}
        <div className="absolute right-0 top-0 bottom-0 w-px bg-gradient-to-b from-accent-blue/40 via-accent-blue/10 to-transparent" />

        {/* Logo */}
        <div className="px-5 py-4 border-b border-border/50">
          <NavLink to="/" className="flex items-center gap-2.5">
            <div className="relative">
              <Activity className="w-5 h-5 text-accent-blue" />
              <div className="absolute inset-0 blur-md bg-accent-blue/30 rounded-full" />
            </div>
            <span className="font-heading text-[15px] font-bold text-white tracking-widest uppercase">FlowForge</span>
          </NavLink>
        </div>

        {/* Nav groups + chat expansion */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className={`${isChat ? '' : 'flex-1'} overflow-y-auto py-2 shrink-0`}>
            {NAV_GROUPS.map((group, gi) => (
              <div key={gi} className={gi > 0 ? 'mt-3' : ''}>
                {group.label && (
                  <div className="px-5 py-1">
                    <span className="text-[10px] font-label uppercase tracking-[0.15em] text-gray-600">{group.label}</span>
                  </div>
                )}
                {group.items.map(item => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === '/'}
                    className={({ isActive }) =>
                      `flex items-center gap-3 px-4 py-2 mx-2 rounded-md text-sm font-body transition-all duration-200 ${
                        isActive
                          ? 'bg-accent-blue/10 text-accent-blue border-l-2 border-accent-blue'
                          : 'text-gray-500 hover:text-gray-300 hover:bg-surface-200/40 border-l-2 border-transparent'
                      }`
                    }
                  >
                    <item.icon className="w-[18px] h-[18px]" />
                    {item.label}
                  </NavLink>
                ))}
              </div>
            ))}
          </div>

          {/* Chat conversations — expands below nav, takes remaining space */}
          {isChat && (
            <div className="flex-1 flex flex-col overflow-hidden border-t border-border/30">
              <ChatSidebarSection />
            </div>
          )}
        </div>

        {/* Bottom — settings tabs expand upward above the settings link */}
        <div className="border-t border-border/50 shrink-0">
          {/* Settings sub-tabs — appears above the settings link */}
          {isSettings && (
            <div className="border-b border-border/30">
              <SettingsSidebarSection />
            </div>
          )}

          <NavLink
            to="/settings"
            className={({ isActive }) =>
              `flex items-center gap-3 px-4 py-2 mx-2 my-1 rounded-md text-sm font-body transition-all duration-200 ${
                isActive
                  ? 'bg-accent-blue/10 text-accent-blue border-l-2 border-accent-blue'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-surface-200/40 border-l-2 border-transparent'
              }`
            }
          >
            <Settings className="w-[18px] h-[18px]" />
            Settings
          </NavLink>

          <div className="flex items-center justify-between px-5 py-2">
            <span className="text-[10px] text-gray-700 font-mono">v0.1.0</span>
            <NotificationBell />
          </div>
        </div>
      </nav>

      <main className="flex-1 overflow-auto grid-bg relative">
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}
