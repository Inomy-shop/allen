import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import ErrorBoundary from './components/common/ErrorBoundary';
import NotificationBell from './components/common/NotificationBell';
import ShortcutKey from './components/common/ShortcutKey';
import {
  CirclePlay, GitBranch, GitPullRequest, History, LayoutDashboard, Settings,
  FolderGit2, TicketCheck, Workflow,
  ChevronRight, Plus, Palette, PenTool,
  Sun, Moon, Search, PanelLeft, Command, ArrowRight, UsersRound, ArrowLeft,
  SlidersHorizontal, CircleUserRound, HardDrive, Server, CalendarClock, Brain, Cpu,
  Trash2, AlertTriangle, Copy, Check, BarChart3, X, Lightbulb, Loader2,
} from 'lucide-react';
import { useSettingsStore } from './stores/settingsStore';
import { resolveColorMode } from './lib/theme';
import { useAuthStore } from './stores/authStore';
import { BRAND_NAME } from './lib/brand';
import {
  chat as chatApi,
  executions as executionsApi,
  interventions as interventionsApi,
  repos as reposApi,
} from './services/api';
import { workspaces as workspacesApi } from './services/workspaceService';
import { usePanelLayout } from './hooks/usePanelLayout';
import { WorkspaceCreateDialog, type WorkspaceCreateRepo } from './components/workspace/WorkspaceCreateDialog';
import { workspaceChatPath } from './lib/workspace-routes';
import { workspaceCreateBaseBranch } from './lib/workspace-create';
import DesignNavPanel from './components/design/DesignNavPanel';
import DesignStudioCreateDialog from './components/design/DesignStudioCreateDialog';
import { designStudio, type Workspace as DesignStudioWorkspace } from './services/designStudioService';

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

type SidebarPanelId = 'design-studio' | 'workspaces' | 'navigation';

interface SidebarWorkspace {
  _id: string;
  name: string;
  repoId?: string;
  repoName?: string;
  repoPath?: string;
  repoDefaultBranch?: string;
  branch?: string;
  baseBranch?: string;
  status?: string;
  source?: string;
  prNumber?: number;
  updatedAt?: string;
  createdAt?: string;
  latestMessageAt?: string;
}

interface SidebarRepo {
  _id: string;
  name: string;
  path?: string;
  branch?: string;
  defaultBranch?: string;
  detected?: {
    defaultBranch?: string;
  };
}

function workspaceCreateRepoDebug(repo?: WorkspaceCreateRepo | SidebarRepo | null) {
  if (!repo) return null;
  return {
    id: repo._id,
    name: repo.name,
    path: repo.path,
    branch: repo.branch,
    defaultBranch: repo.defaultBranch,
    detectedDefaultBranch: repo.detected?.defaultBranch,
    resolvedBaseBranch: workspaceCreateBaseBranch(repo),
  };
}

function sidebarRepoForWorkspace(repos: SidebarRepo[], workspace?: SidebarWorkspace | null, label?: string): SidebarRepo | null {
  if (!workspace) return null;
  return repos.find(repo => {
    if (workspace.repoId && repo._id === workspace.repoId) return true;
    if (workspace.repoPath && repo.path === workspace.repoPath) return true;
    if (workspace.repoName && repo.name === workspace.repoName) return true;
    if (label && repo.name === label) return true;
    return false;
  }) ?? null;
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
  { id: 'design', dividerBefore: true, items: [
    { to: '/design', icon: Palette, label: 'Design', activePrefixes: ['/design'] },
    { to: '/studio', icon: PenTool, label: 'Design Studio', activePrefixes: ['/studio'] },
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
    { to: '/settings/models', icon: Cpu, label: 'Models', activePrefixes: ['/settings/models'] },
    { to: '/settings/usage', icon: BarChart3, label: 'Usage', activePrefixes: ['/settings/usage'] },
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
  { prefix: '/studio', label: 'Design Studio' },
  { prefix: '/design', label: 'Design' },
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
  { id: 'design', label: 'Open design', group: 'Navigate', to: '/design', icon: Palette },
  { id: 'studio', label: 'Open Design Studio', group: 'Navigate', to: '/studio', icon: PenTool },
  { id: 'chat', label: 'Open assistant chat', group: 'Action', to: '/chat', icon: History },
  { id: 'activity', label: 'View execution log', group: 'Executions', to: '/executions', icon: CirclePlay },
  { id: 'running', label: 'View running executions', group: 'Executions', to: '/executions?status=running', icon: CirclePlay },
  { id: 'tickets', label: 'Open Linear', group: 'Sources', to: '/tickets', icon: TicketCheck },
  { id: 'pulls', label: 'Open pull requests', group: 'Sources', to: '/pull-requests', icon: GitPullRequest },
  { id: 'repos', label: 'Open repositories', group: 'Sources', to: '/agents?section=repos', icon: GitBranch },
  { id: 'workspaces', label: 'Open workspaces', group: 'Sources', to: '/workspaces', icon: FolderGit2 },
  { id: 'settings-general', label: 'Open settings', group: 'Settings', to: '/settings/general', icon: SlidersHorizontal },
  { id: 'settings-runtime', label: 'Open runtime settings', group: 'Settings', to: '/settings/runtime', icon: HardDrive },
  { id: 'settings-models', label: 'Open model settings', group: 'Settings', to: '/settings/models', icon: Cpu },
  { id: 'settings-mcp', label: 'Open MCP servers', group: 'Settings', to: '/settings/mcp', icon: Server },
  { id: 'settings-schedules', label: 'Open schedules', group: 'Settings', to: '/settings/schedules', icon: CalendarClock },
  { id: 'settings-learnings', label: 'Open learnings', group: 'Settings', to: '/settings/learnings', icon: Brain },
  { id: 'workflows', label: 'Open workflows', group: 'Studio', to: '/workflows', icon: Workflow },
  { id: 'agents', label: 'Open teams & agents', group: 'Studio', to: '/agents?section=teams-agents', icon: UsersRound },
];

const SIDEBAR_PANEL_ORDER: SidebarPanelId[] = ['design-studio', 'navigation', 'workspaces'];
const SIDEBAR_PANEL_LABELS: Record<SidebarPanelId, string> = {
  'design-studio': 'Design Studio',
  workspaces: 'Workspaces',
  navigation: 'App navigation',
};
const WORKSPACE_REPO_COLLAPSE_KEY = 'allen-app-sidebar-collapsed-workspace-repos';
const WORKSPACE_REPO_RECENT_LIMIT = 5;
const SETTINGS_ROUTE_DETAILS: Array<{ prefix: string; label: string }> = [
  { prefix: '/settings/runtime', label: 'Runtime' },
  { prefix: '/settings/models', label: 'Models' },
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
  // Order by the most recent linked chat message first, falling back to
  // workspace metadata timestamps when a workspace has no chat activity.
  const raw = workspace.latestMessageAt ?? workspace.updatedAt ?? workspace.createdAt ?? '';
  const time = raw ? new Date(raw).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

function workspaceRepoLabel(workspace: SidebarWorkspace): string {
  return workspace.repoName
    ?? workspace.repoPath?.split('/').filter(Boolean).at(-1)
    ?? 'Unknown repo';
}

function dsStatusInfo(status: DesignStudioWorkspace['profileStatus']): { label: string; cls: string } {
  switch (status) {
    case 'pending': return { label: 'Setup needed', cls: 'bg-amber-500/15 text-amber-500' };
    case 'analyzing': return { label: 'Analyzing…', cls: 'bg-blue-500/15 text-blue-400' };
    case 'needs_review': return { label: 'Review profile', cls: 'bg-amber-500/15 text-amber-500' };
    case 'needs_choice': return { label: 'Action needed', cls: 'bg-orange-500/15 text-orange-500' };
    case 'confirmed': return { label: 'Ready', cls: 'bg-emerald-500/15 text-emerald-500' };
    default: return { label: 'Unknown', cls: 'bg-theme-subtle/15 text-theme-subtle' };
  }
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
  chatConversationId,
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
  chatConversationId?: string | null;
}) {
  const [copiedChatId, setCopiedChatId] = useState(false);

  async function copyChatConversationId() {
    if (!chatConversationId) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(chatConversationId);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = chatConversationId;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopiedChatId(true);
      window.setTimeout(() => setCopiedChatId(false), 1600);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Failed to copy conversation id');
    }
  }

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

      {chatConversationId && (
        <button
          type="button"
          onClick={() => void copyChatConversationId()}
          className="foot-btn topbar-icon-btn"
          title={copiedChatId ? 'Copied conversation ID' : 'Copy conversation ID'}
          aria-label={copiedChatId ? 'Copied conversation ID' : 'Copy conversation ID'}
        >
          {copiedChatId ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        </button>
      )}

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


function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

type UpdatePromptPhase = 'prompt' | 'downloading' | 'complete' | 'error';

type UpdatePromptState = {
  requestId: string;
  currentVersion: string;
  latestVersion: string;
  phase: UpdatePromptPhase;
  releaseNotes: AllenReleaseNotesEntry | null;
  releaseNotesError: string | null;
  downloadPercent: number | null;
  downloadedBytes: number | null;
  totalBytes: number | null;
  downloadError: string | null;
  downloadRetryable: boolean;
  completeMessage: string | null;
};

function UpdatePromptModal({
  prompt,
  onAction,
  onRetry,
  onClose,
  onCancelDownload,
}: {
  prompt: UpdatePromptState;
  onAction: (action: 'update-now' | 'update-later') => void;
  onRetry: () => void;
  onClose: () => void;
  onCancelDownload: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 px-4 py-6 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="allen-update-title">
      <div className="flex max-h-[min(720px,calc(100vh-3rem))] w-full max-w-3xl flex-col overflow-hidden rounded-md border border-app bg-app-card shadow-2xl">

        {/* ── Prompt phase ── */}
        {prompt.phase === 'prompt' && (
          <>
            <div className="flex-none border-b border-app px-6 py-5">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent">Update available</div>
              <h2 id="allen-update-title" className="mt-2 text-[18px] font-semibold tracking-tight text-theme-primary">
                Allen {prompt.latestVersion} is available
              </h2>
              <p className="mt-2 text-[13px] leading-5 text-theme-muted">
                You are currently using Allen {prompt.currentVersion}. Download and open the latest installer now, or update later.
              </p>
            </div>

            {prompt.releaseNotes ? (
              <div className="min-h-0 overflow-y-auto px-6 py-4">
                <div className="rounded-md border border-app bg-app-muted p-3">
                  {prompt.releaseNotes.summary && (
                    <p className="mb-2 text-[13px] leading-5 text-theme-secondary">{prompt.releaseNotes.summary}</p>
                  )}
                  {prompt.releaseNotes.sections?.map((section, idx) => (
                    <div key={idx} className={idx > 0 ? 'mt-3' : ''}>
                      <h4 className="mb-1 text-[12px] font-semibold text-theme-primary">{section.title}</h4>
                      <ul className="list-inside list-disc space-y-0.5">
                        {section.items.map((item, iidx) => (
                          <li key={iidx} className="text-[12px] leading-5 text-theme-secondary">{item}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="min-h-0 overflow-y-auto px-6 py-4">
                <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-[13px] text-theme-primary">
                  Release notes could not be loaded. You can still update to Allen {prompt.latestVersion}.
                </div>
              </div>
            )}

            <div className="flex flex-none items-center justify-end gap-2 border-t border-app px-6 py-4">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => onAction('update-later')}>
                Update later
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => onAction('update-now')}>
                Update now
              </button>
            </div>
          </>
        )}

        {/* ── Downloading phase ── */}
        {prompt.phase === 'downloading' && (
          <>
            <div className="flex items-start justify-between gap-4 border-b border-app px-6 py-5">
              <h2 id="allen-update-title" className="text-[18px] font-semibold tracking-tight text-theme-primary">
                Downloading Allen {prompt.latestVersion}…
              </h2>
              <button
                type="button"
                aria-label="Cancel download"
                title="Cancel download"
                className="inline-flex h-8 w-8 flex-none items-center justify-center rounded-md text-theme-muted transition hover:bg-app-muted hover:text-theme-primary focus:outline-none focus:ring-2 focus:ring-accent/40"
                onClick={onCancelDownload}
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <div className="space-y-3 px-6 py-5">
              <div className="h-2 w-full overflow-hidden rounded-full bg-app-muted">
                <div
                  className={`h-full rounded-full bg-accent transition-all duration-300 ${
                    prompt.downloadPercent !== null ? '' : 'w-1/2 animate-pulse'
                  }`}
                  style={prompt.downloadPercent !== null ? { width: `${prompt.downloadPercent}%` } : undefined}
                />
              </div>
              <div className="space-y-1">
                <p className="text-[13px] text-theme-muted">Downloading update…</p>
                {prompt.downloadedBytes !== null && (
                  <p className="font-mono text-[12px] text-theme-subtle">
                    {prompt.totalBytes !== null
                      ? `${formatBytes(prompt.downloadedBytes)} / ${formatBytes(prompt.totalBytes)} (${prompt.downloadPercent ?? 0}%)`
                      : `${formatBytes(prompt.downloadedBytes)} downloaded`}
                  </p>
                )}
              </div>
            </div>
          </>
        )}

        {/* ── Complete phase ── */}
        {prompt.phase === 'complete' && (
          <>
            <div className="border-b border-app px-6 py-5">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent">Update ready</div>
              <h2 id="allen-update-title" className="mt-2 text-[18px] font-semibold tracking-tight text-theme-primary">
                Update ready
              </h2>
            </div>
            <div className="space-y-3 px-6 py-5">
              <p className="text-[13px] leading-5 text-theme-muted">
                Allen {prompt.latestVersion} has been downloaded. The installer will open now. Drag Allen into your Applications folder to finish installing.
              </p>
              <div className="h-2 w-full overflow-hidden rounded-full bg-app-muted">
                <div className="h-full w-full rounded-full bg-accent" />
              </div>
            </div>
          </>
        )}

        {/* ── Error phase ── */}
        {prompt.phase === 'error' && (
          <>
            <div className="border-b border-app px-6 py-5">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent-red">Update failed</div>
              <h2 id="allen-update-title" className="mt-2 text-[18px] font-semibold tracking-tight text-theme-primary">
                Update failed
              </h2>
            </div>
            <div className="space-y-4 px-6 py-5">
              {prompt.downloadError && (
                <div className="rounded-md border border-accent-red/25 bg-accent-red/5 p-3 text-[13px] text-theme-primary">
                  {prompt.downloadError}
                </div>
              )}
              <div className="flex items-center justify-end gap-2">
                {prompt.downloadRetryable && (
                  <button type="button" className="btn btn-primary btn-sm" onClick={onRetry}>
                    Retry
                  </button>
                )}
                <button
                  type="button"
                  className={prompt.downloadRetryable ? 'btn btn-secondary btn-sm' : 'btn btn-primary btn-sm'}
                  onClick={onClose}
                >
                  Close
                </button>
              </div>
            </div>
          </>
        )}

      </div>
    </div>
  );
}

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const routeBaseTitle = routeTitle(location.pathname, location.search);
  const [chatTopbarTitle, setChatTopbarTitle] = useState<string | null>(null);
  const [chatSessionWorkspaceId, setChatSessionWorkspaceId] = useState<string | null>(null);
  const [activeChatConversationId, setActiveChatConversationId] = useState<string | null>(null);
  const [activeWorkspaceName, setActiveWorkspaceName] = useState<string | null>(null);
  const routeBaseDetail = routeDetail(location.pathname, chatTopbarTitle);
  const [commandOpen, setCommandOpen] = useState(false);
  const [updatePrompt, setUpdatePrompt] = useState<UpdatePromptState | null>(null);
  const [liveCount, setLiveCount] = useState(0);
  const [approvalCount, setApprovalCount] = useState(0);
  const [canGoBack, setCanGoBack] = useState(false);
  const [sidebarPanel, setSidebarPanel] = useState<SidebarPanelId>('navigation');
  const [workspaceSearch, setWorkspaceSearch] = useState('');
  const [sidebarWorkspaces, setSidebarWorkspaces] = useState<SidebarWorkspace[]>([]);
  const [sidebarRepos, setSidebarRepos] = useState<SidebarRepo[]>([]);
  const [sidebarWorkspacesLoading, setSidebarWorkspacesLoading] = useState(false);
  const [deletingWorkspaceId, setDeletingWorkspaceId] = useState<string | null>(null);
  const [confirmDeleteWorkspace, setConfirmDeleteWorkspace] = useState<SidebarWorkspace | null>(null);
  const [workspaceCreateRepo, setWorkspaceCreateRepo] = useState<WorkspaceCreateRepo | null>(null);
  const [collapsedWorkspaceRepos, setCollapsedWorkspaceRepos] = useState<Set<string>>(() => loadCollapsedWorkspaceRepos());
  const [expandedWorkspaceRepos, setExpandedWorkspaceRepos] = useState<Set<string>>(() => new Set());
  const [appVersion, setAppVersion] = useState(__ALLEN_APP_VERSION__);
  const [dsWorkspaces, setDsWorkspaces] = useState<DesignStudioWorkspace[]>([]);
  const [dsWorkspacesLoading, setDsWorkspacesLoading] = useState(false);
  const [dsWorkspaceSearch, setDsWorkspaceSearch] = useState('');
  const [dsCreateOpen, setDsCreateOpen] = useState(false);
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
  // Matches: /workspaces/:id route (legacy), /chat?workspaceId=X query, /chat/:sid where session has workspaceId
  const workspaceIdFromPath = location.pathname.match(/^\/workspaces\/([^/]+)/)?.[1] ?? null;
  const workspaceIdFromSearch = new URLSearchParams(location.search).get('workspaceId');
  const activeWorkspaceId = workspaceIdFromPath ?? workspaceIdFromSearch ?? chatSessionWorkspaceId;
  const dsWorkspaceIdFromPath = location.pathname.match(/^\/studio\/workspaces\/([^/]+)/)?.[1] ?? null;
  const routeChatConversationId = location.pathname.match(/^\/chat\/([^/]+)/)?.[1] ?? null;
  const copyableChatConversationId = location.pathname.startsWith('/chat') ? routeChatConversationId ?? activeChatConversationId : null;
  const isWorkspaceChatRoute = location.pathname.startsWith('/chat') && Boolean(activeWorkspaceId);
  const title = isWorkspaceChatRoute ? 'workspace' : routeBaseTitle;
  const detail = isWorkspaceChatRoute ? activeWorkspaceName ?? 'Workspace' : routeBaseDetail;
  const workspaceGroups = useMemo(() => {
    const query = workspaceSearch.trim().toLowerCase();
    const repoById = new Map(sidebarRepos.map(repo => [repo._id, repo]));
    const groups = new Map<string, { key: string; label: string; repo?: SidebarRepo; items: SidebarWorkspace[]; latest: number }>();
    for (const repo of sidebarRepos) {
      if (query && !repo.name.toLowerCase().includes(query) && !(repo.path ?? '').toLowerCase().includes(query)) continue;
      groups.set(repo._id, { key: repo._id, label: repo.name, repo, items: [], latest: 0 });
    }

    for (const workspace of sidebarWorkspaces) {
      const repo = workspace.repoId ? repoById.get(workspace.repoId) ?? sidebarRepoForWorkspace(sidebarRepos, workspace) : sidebarRepoForWorkspace(sidebarRepos, workspace);
      const label = repo?.name ?? workspaceRepoLabel(workspace);
      const key = repo?._id ?? workspace.repoId ?? `repo:${label.toLowerCase()}`;
      if (query && !workspace.name.toLowerCase().includes(query) && !label.toLowerCase().includes(query) && !(workspace.branch ?? '').toLowerCase().includes(query)) continue;
      const latest = sidebarWorkspaceTime(workspace);
      const existing = groups.get(key);
      if (existing) {
        existing.items.push(workspace);
        existing.latest = Math.max(existing.latest, latest);
      } else {
        groups.set(key, { key, label, repo: repo ?? undefined, items: [workspace], latest });
      }
    }

    const ordered = Array.from(groups.values());
    for (const group of ordered) {
      group.items.sort((a, b) => sidebarWorkspaceTime(b) - sidebarWorkspaceTime(a));
    }
    return ordered.sort((a, b) => b.latest - a.latest);
  }, [sidebarRepos, sidebarWorkspaces, workspaceSearch]);

  const filteredDsWorkspaces = useMemo(() => {
    const q = dsWorkspaceSearch.trim().toLowerCase();
    if (!q) return dsWorkspaces;
    return dsWorkspaces.filter((ws) => ws.name.toLowerCase().includes(q));
  }, [dsWorkspaces, dsWorkspaceSearch]);

  async function openCreateWorkspaceForRepo(repo?: WorkspaceCreateRepo | null) {
    if (!repo) return;
    console.info('[workspace-create-debug] app-sidebar plus clicked', {
      candidateRepo: workspaceCreateRepoDebug(repo),
    });
    const savedRepo = await reposApi.get(repo._id).catch((error) => {
      console.warn('[workspace-create-debug] app-sidebar repo fetch failed', {
        repoId: repo._id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    const modalRepo = {
      ...repo,
      name: savedRepo?.name ?? repo.name,
      path: savedRepo?.path ?? repo.path,
      branch: savedRepo?.branch ?? repo.branch,
      defaultBranch: savedRepo?.defaultBranch ?? repo.defaultBranch,
      detected: savedRepo?.detected ?? repo.detected,
    };
    console.info('[workspace-create-debug] app-sidebar modal repo prepared', {
      fetchedRepo: workspaceCreateRepoDebug(savedRepo),
      modalRepo: workspaceCreateRepoDebug(modalRepo),
    });
    setWorkspaceCreateRepo(modalRepo);
  }

  function prependSidebarWorkspace(workspace: SidebarWorkspace) {
    setSidebarWorkspaces(prev => [workspace, ...prev.filter(item => item._id !== workspace._id)]);
  }

  async function deleteSidebarWorkspace(workspace: SidebarWorkspace) {
    setDeletingWorkspaceId(workspace._id);
    try {
      window.dispatchEvent(new CustomEvent('allen:workspace-servers-stop', { detail: { workspaceId: workspace._id } }));
      await workspacesApi.archive(workspace._id);
      setSidebarWorkspaces(prev => prev.filter(item => item._id !== workspace._id));
      try {
        localStorage.removeItem(`allen-ws-chat-tabs:${workspace._id}`);
      } catch {}
      if (activeWorkspaceId === workspace._id) {
        setChatSessionWorkspaceId(null);
        setActiveWorkspaceName(null);
        navigate('/chat');
      }
      setConfirmDeleteWorkspace(null);
    } catch (err: any) {
      window.alert(err?.message ?? 'Failed to delete workspace');
    } finally {
      setDeletingWorkspaceId(null);
    }
  }

  useEffect(() => {
    let cancelled = false;
    window.allenDesktop?.getRuntimeInfo?.()
      .then((info) => {
        if (!cancelled && info?.appVersion) setAppVersion(info.appVersion);
      })
      .catch(() => {
        // Web/dev mode uses the build-time fallback.
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
    function onActiveChatConversation(event: Event) {
      const sessionId = (event as CustomEvent<{ sessionId?: string | null }>).detail?.sessionId ?? null;
      setActiveChatConversationId(sessionId);
    }
    window.addEventListener('allen:active-chat-conversation', onActiveChatConversation);
    return () => window.removeEventListener('allen:active-chat-conversation', onActiveChatConversation);
  }, []);

  useEffect(() => {
    if (!window.allenDesktop?.onUpdatePrompt) return undefined;
    return window.allenDesktop.onUpdatePrompt((payload) => setUpdatePrompt({
      requestId: payload.requestId,
      currentVersion: payload.currentVersion,
      latestVersion: payload.latestVersion,
      phase: 'prompt',
      releaseNotes: payload.releaseNotes ?? null,
      releaseNotesError: payload.releaseNotesError ?? null,
      downloadPercent: null,
      downloadedBytes: null,
      totalBytes: null,
      downloadError: null,
      downloadRetryable: false,
      completeMessage: null,
    }));
  }, []);

  // Listen for download progress
  useEffect(() => {
    if (!window.allenDesktop?.onUpdateDownloadProgress) return;
    return window.allenDesktop.onUpdateDownloadProgress((payload) => {
      setUpdatePrompt(prev => prev && prev.requestId === payload.requestId
        ? { ...prev, phase: 'downloading', downloadPercent: payload.percent,
            downloadedBytes: payload.downloadedBytes, totalBytes: payload.totalBytes }
        : prev);
    });
  }, []);

  // Listen for download error
  useEffect(() => {
    if (!window.allenDesktop?.onUpdateDownloadError) return;
    return window.allenDesktop.onUpdateDownloadError((payload) => {
      setUpdatePrompt(prev => prev && prev.requestId === payload.requestId
        ? { ...prev, phase: 'error', downloadError: payload.error, downloadRetryable: payload.retryable }
        : prev);
    });
  }, []);

  // Listen for download complete
  useEffect(() => {
    if (!window.allenDesktop?.onUpdateDownloadComplete) return;
    return window.allenDesktop.onUpdateDownloadComplete((payload) => {
      setUpdatePrompt(prev => prev && prev.requestId === payload.requestId
        ? { ...prev, phase: 'complete', downloadPercent: 100,
            completeMessage: 'Update ready. Allen will now quit.' }
        : prev);
    });
  }, []);

  function respondToUpdatePrompt(action: 'update-now' | 'update-later') {
    if (!updatePrompt) return;
    if (action === 'update-now') {
      setUpdatePrompt(prev => prev ? {
        ...prev, phase: 'downloading', downloadError: null,
        downloadPercent: null, downloadedBytes: null, totalBytes: null,
      } : null);
    } else {
      setUpdatePrompt(null);
    }
    window.allenDesktop?.respondToUpdatePrompt?.(updatePrompt.requestId, action);
  }

  function retryUpdateDownload() {
    if (!updatePrompt) return;
    setUpdatePrompt(prev => prev ? { ...prev, phase: 'downloading', downloadError: null, downloadPercent: null, downloadedBytes: null, totalBytes: null } : null);
    window.allenDesktop?.retryUpdateDownload?.(updatePrompt.requestId);
  }

  function closeUpdatePrompt() { setUpdatePrompt(null); }

  function cancelUpdateDownload() {
    if (!updatePrompt) return;
    window.allenDesktop?.cancelUpdateDownload?.(updatePrompt.requestId);
    setUpdatePrompt(null);
  }

  useEffect(() => {
    const match = location.pathname.match(/^\/chat\/([^/]+)/);
    if (!match) {
      setChatTopbarTitle(null);
      setChatSessionWorkspaceId(null);
      if (!location.pathname.startsWith('/chat')) setActiveChatConversationId(null);
      return;
    }
    let cancelled = false;
    const sessionId = match[1];
    setActiveChatConversationId(sessionId);
    const loadTitle = () => {
      chatApi.getSession(sessionId)
        .then((session) => {
          if (!cancelled) {
            setChatTopbarTitle(session?.title ?? null);
            setChatSessionWorkspaceId(session?.workspaceId ?? null);
          }
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

  // Fetch the sidebar workspaces + repos. When quiet=true (live refresh) the
  // loading state is left untouched and a transient failure keeps the existing
  // list instead of clearing it, so the sidebar never flickers.
  const loadSidebarWorkspaces = useCallback(async (quiet = false) => {
    if (!quiet) setSidebarWorkspacesLoading(true);
    const [items, repoItems] = await Promise.all([
      workspacesApi.list().catch(() => null),
      reposApi.list().catch(() => null),
    ]);
    if (items) setSidebarWorkspaces(items as SidebarWorkspace[]);
    else if (!quiet) setSidebarWorkspaces([]);
    if (repoItems) setSidebarRepos(repoItems as SidebarRepo[]);
    else if (!quiet) setSidebarRepos([]);
    if (!quiet) setSidebarWorkspacesLoading(false);
  }, []);

  const loadDsWorkspaces = useCallback(async (quiet = false) => {
    if (!quiet) setDsWorkspacesLoading(true);
    try {
      const items = await designStudio.listWorkspaces();
      setDsWorkspaces(items ?? []);
    } catch (err) {
      console.error('[design-studio-sidebar] failed to load workspaces', err);
      if (!quiet) setDsWorkspaces([]);
    } finally {
      if (!quiet) setDsWorkspacesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (sidebarPanel !== 'workspaces') return;
    void loadSidebarWorkspaces(false);
  }, [sidebarPanel, loadSidebarWorkspaces]);

  useEffect(() => {
    if (sidebarPanel !== 'design-studio') return;
    void loadDsWorkspaces(false);
  }, [sidebarPanel, loadDsWorkspaces]);

  // Keep the sidebar ordered by recent chat activity in real time while it is
  // open: refresh on the workspace-activity event (fired when a chat message is
  // sent/completed) and on window focus. Both are action-driven — no polling.
  useEffect(() => {
    if (sidebarPanel !== 'workspaces') return;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const onActivity = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void loadSidebarWorkspaces(true), 300);
    };
    const onFocus = () => void loadSidebarWorkspaces(true);
    window.addEventListener('allen:workspace-activity', onActivity);
    window.addEventListener('focus', onFocus);
    return () => {
      if (debounce) clearTimeout(debounce);
      window.removeEventListener('allen:workspace-activity', onActivity);
      window.removeEventListener('focus', onFocus);
    };
  }, [sidebarPanel, loadSidebarWorkspaces]);

  useEffect(() => {
    if (!isWorkspaceChatRoute || !activeWorkspaceId) {
      setActiveWorkspaceName(null);
      return;
    }

    const cached = sidebarWorkspaces.find(workspace => workspace._id === activeWorkspaceId)?.name;
    if (cached) {
      setActiveWorkspaceName(cached);
      return;
    }

    let cancelled = false;
    setActiveWorkspaceName(null);
    workspacesApi.get(activeWorkspaceId)
      .then((workspace) => {
        if (!cancelled) setActiveWorkspaceName(workspace?.name ?? null);
      })
      .catch(() => {
        if (!cancelled) setActiveWorkspaceName(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, isWorkspaceChatRoute, sidebarWorkspaces]);

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
  const isDesignRoute = location.pathname.startsWith('/design');
  const designActiveSessionId = isDesignRoute
    ? location.pathname.match(/^\/design\/([^/]+)/)?.[1] ?? null
    : null;
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

  function toggleWorkspaceRepoMore(repoKey: string) {
    setExpandedWorkspaceRepos((current) => {
      const next = new Set(current);
      next.has(repoKey) ? next.delete(repoKey) : next.add(repoKey);
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
      ) : isDesignRoute && !navPanel.collapsed ? (
        /* Design route: custom design history sidebar */
        <nav className="sidebar !w-[290px] !min-w-[290px] [animation:none]">
          <div className="brand">
            <NavLink to="/" className="brand-link">
              <div className="brand-mark">[a]</div>
              <span className="brand-name">{BRAND_NAME}</span>
            </NavLink>
            <span className="brand-sub">v{appVersion}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <DesignNavPanel
              activeSessionId={designActiveSessionId}
              onBack={() => {
                setSidebarPanel('navigation');
                // Navigate away from Design mode. Using navigate('/') rather than
                // navigate(-1) so the user reliably lands on a non-design route —
                // history -1 might still be another /design/* entry.
                navigate('/');
              }}
              onDelete={async (id) => {
                try {
                  await chatApi.deleteSession(id);
                  // If we deleted the active session, navigate to /design root
                  if (designActiveSessionId === id) navigate('/design');
                } catch (err) {
                  console.error('[design] failed to delete session', err);
                }
              }}
            />
          </div>
          <div className="sidebar-foot-wrap">
            {currentUser && (
              <div className="sidebar-foot">
                <div className="avatar">{userInitial}</div>
                <div className="user-meta">
                  <div className="nm">{currentUser.name}</div>
                  <div className="em">{currentUser.email}</div>
                </div>
                <NavLink to="/settings/general" className="foot-btn" title="Settings">
                  <Settings className="w-3.5 h-3.5" />
                </NavLink>
              </div>
            )}
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
            <span className="brand-sub">v{appVersion}</span>
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
              <div className="order-3 min-w-0 w-full shrink-0">
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
                      const searchingWorkspaces = Boolean(workspaceSearch.trim());
                      const moreExpanded = expandedWorkspaceRepos.has(group.key) || searchingWorkspaces;
                      const hiddenWorkspaceCount = Math.max(0, group.items.length - WORKSPACE_REPO_RECENT_LIMIT);
                      const visibleWorkspaces = moreExpanded
                        ? group.items
                        : group.items.slice(0, WORKSPACE_REPO_RECENT_LIMIT);
                      const showMoreControl = hiddenWorkspaceCount > 0 && !searchingWorkspaces;
                      const repoWorkspace = group.items.find((workspace) => workspace.repoId) ?? group.items[0] ?? null;
                      const savedRepo = group.repo ?? sidebarRepoForWorkspace(sidebarRepos, repoWorkspace, group.label);
                      const repo = savedRepo
                        ? {
                            _id: savedRepo._id,
                            name: savedRepo.name,
                            path: savedRepo.path ?? repoWorkspace?.repoPath,
                            branch: savedRepo.branch,
                            defaultBranch: savedRepo.defaultBranch,
                            detected: savedRepo.detected,
                          }
                        : repoWorkspace?.repoId
                        ? {
                            _id: repoWorkspace.repoId,
                            name: group.label,
                            path: repoWorkspace.repoPath,
                            detected: { defaultBranch: repoWorkspace.repoDefaultBranch ?? repoWorkspace.baseBranch },
                          }
                        : null;
                      const handleCreateClick = () => {
                        console.info('[workspace-create-debug] app-sidebar group plus source', {
                          groupKey: group.key,
                          groupLabel: group.label,
                          repoWorkspace: repoWorkspace
                            ? {
                                id: repoWorkspace._id,
                                repoId: repoWorkspace.repoId,
                                repoName: repoWorkspace.repoName,
                                repoPath: repoWorkspace.repoPath,
                                repoDefaultBranch: repoWorkspace.repoDefaultBranch,
                                baseBranch: repoWorkspace.baseBranch,
                                branch: repoWorkspace.branch,
                              }
                            : null,
                          savedRepo: workspaceCreateRepoDebug(savedRepo),
                          clickRepo: workspaceCreateRepoDebug(repo),
                        });
                        void openCreateWorkspaceForRepo(repo);
                      };
                      return (
                        <div key={group.key}>
                          <div className="group mb-1 flex items-center gap-1 rounded-md transition-colors hover:bg-app-muted">
                            <button
                              type="button"
                              onClick={() => toggleWorkspaceRepo(group.key)}
                              className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-theme-secondary transition-colors group-hover:text-theme-primary"
                            >
                              <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-theme-muted" />
                              <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{group.label}</span>
                              <ChevronRight className={`h-3 w-3 shrink-0 text-theme-subtle transition-transform ${showItems ? 'rotate-90' : ''}`} />
                            </button>
                            <button
                              type="button"
                              onClick={handleCreateClick}
                              disabled={!repo}
                              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-theme-muted transition-colors hover:text-accent group-hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
                              title={`New workspace in ${group.label}`}
                              aria-label={`New workspace in ${group.label}`}
                            >
                              <Plus className="h-3.5 w-3.5" />
                            </button>
                          </div>
                          {showItems && (
                            <div className="mt-1 space-y-1 pl-4">
                              {visibleWorkspaces.map((workspace) => {
                                const active = workspace._id === activeWorkspaceId;
                                const deleting = deletingWorkspaceId === workspace._id;
                                return (
                                  <div
                                    key={workspace._id}
                                    className={`group flex w-full items-center rounded-md border py-1.5 pl-2.5 pr-1 transition-colors ${
                                      active
                                        ? 'border-transparent bg-transparent text-accent'
                                        : 'border-transparent text-theme-muted hover:bg-app-muted hover:text-theme-secondary'
                                    }`}
                                  >
                                    <button
                                      type="button"
                                      onClick={() => navigate(workspaceChatPath(workspace._id))}
                                      className="min-w-0 flex-1 truncate text-left text-[12.5px] font-medium leading-5"
                                      disabled={deleting}
                                    >
                                      {workspace.name}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        setConfirmDeleteWorkspace(workspace);
                                      }}
                                      disabled={deleting}
                                      className="ml-1 grid h-6 w-6 shrink-0 place-items-center rounded-sm text-theme-subtle opacity-0 transition-colors hover:bg-accent-red/10 hover:text-accent-red focus:opacity-100 group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
                                      title={`Delete ${workspace.name}`}
                                      aria-label={`Delete ${workspace.name}`}
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                  </div>
                                );
                              })}
                              {showMoreControl && (
                                <button
                                  type="button"
                                  onClick={() => toggleWorkspaceRepoMore(group.key)}
                                  className="mt-[3px] flex w-full items-center gap-1.5 rounded-[7px] border-0 bg-transparent px-2 py-1.5 text-left font-mono text-[11px] font-medium text-accent transition-colors hover:bg-accent/10"
                                  aria-expanded={moreExpanded}
                                >
                                  <span className="grid place-items-center">
                                    <ChevronRight className={`h-3 w-3 transition-transform ${moreExpanded ? '-rotate-90' : 'rotate-90'}`} />
                                  </span>
                                  <span>{moreExpanded ? 'Show less' : `Show ${hiddenWorkspaceCount} more`}</span>
                                  <span className="ml-0.5 h-px flex-1 bg-border" />
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="order-1 min-w-0 w-full shrink-0">
                <div className="flex min-h-0 h-full flex-col">
                  {/* ── Design Studio sidebar panel ── */}
                  <div className="flex items-center justify-between px-4 pb-2 pt-2">
                    <div className="flex items-center gap-1.5">
                      <Palette className="h-3.5 w-3.5 text-theme-muted" />
                      <span className="text-[12.5px] font-medium text-theme-secondary">Design Studio</span>
                    </div>
                    <button
                      type="button"
                      className="flex h-6 w-6 items-center justify-center rounded-md text-theme-muted transition-colors hover:bg-app-muted hover:text-accent"
                      title="New design"
                      aria-label="New design"
                      onClick={() => setDsCreateOpen(true)}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  {/* Search */}
                  <div className="px-4 pb-3 pt-1">
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-theme-muted" />
                      <input
                        value={dsWorkspaceSearch}
                        onChange={(e) => setDsWorkspaceSearch(e.target.value)}
                        placeholder="Search design workspaces"
                        className="input h-9 w-full pl-8 pr-3 text-[12px]"
                        aria-label="Search design workspaces"
                      />
                    </div>
                  </div>
                  {/* List */}
                  <div className="scroll-hide flex-1 space-y-1 overflow-y-auto px-2 pb-3">
                    {dsWorkspacesLoading && (
                      <div className="px-3 py-4 text-center text-[12px] text-theme-subtle">Loading design workspaces…</div>
                    )}
                    {!dsWorkspacesLoading && dsWorkspaces.length === 0 && (
                      <div className="px-3 py-4 text-center text-[12px] text-theme-subtle">
                        No design workspaces yet.
                        <button
                          type="button"
                          className="ml-1 text-accent hover:underline"
                          onClick={() => setDsCreateOpen(true)}
                        >
                          Create one
                        </button>
                        .
                      </div>
                    )}
                    {!dsWorkspacesLoading && dsWorkspaces.length > 0 && filteredDsWorkspaces.length === 0 && (
                      <div className="px-3 py-4 text-center text-[12px] text-theme-subtle">No matching workspaces.</div>
                    )}
                    {filteredDsWorkspaces.map((ws) => {
                      const active = ws._id === dsWorkspaceIdFromPath;
                      const statusInfo = dsStatusInfo(ws.profileStatus);
                      return (
                        <button
                          key={ws._id}
                          type="button"
                          tabIndex={0}
                          onClick={() => navigate(`/studio/workspaces/${ws._id}`)}
                          className={`flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors ${
                            active
                              ? 'border-transparent bg-transparent text-accent'
                              : 'border-transparent text-theme-muted hover:bg-app-muted hover:text-theme-secondary'
                          }`}
                          aria-current={active ? 'true' : undefined}
                        >
                          {ws.kind === 'repo'
                            ? <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-theme-muted" />
                            : <Lightbulb className="h-3.5 w-3.5 shrink-0 text-theme-muted" />}
                          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium leading-5">{ws.name}</span>
                          <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium ${statusInfo.cls}`}>
                            {statusInfo.label}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="order-2 min-w-0 w-full shrink-0">
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

          {dsCreateOpen && (
            <DesignStudioCreateDialog
              onClose={() => setDsCreateOpen(false)}
              onCreated={(id) => {
                setDsCreateOpen(false);
                void loadDsWorkspaces(true);
                navigate(`/studio/workspaces/${id}`);
              }}
            />
          )}
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
          chatConversationId={copyableChatConversationId}
        />
        <div className="flex-1 min-h-0 overflow-auto">
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
        </div>
      </main>
      {updatePrompt && (
        <UpdatePromptModal
          prompt={updatePrompt}
          onAction={respondToUpdatePrompt}
          onRetry={retryUpdateDownload}
          onClose={closeUpdatePrompt}
          onCancelDownload={cancelUpdateDownload}
        />
      )}

      <ShellCommandPalette
        open={commandOpen}
        onClose={() => setCommandOpen(false)}
        onNavigate={(to) => navigate(to)}
      />
      {confirmDeleteWorkspace && (
        <WorkspaceDeleteConfirmDialog
          workspace={confirmDeleteWorkspace}
          deleting={deletingWorkspaceId === confirmDeleteWorkspace._id}
          onCancel={() => {
            if (!deletingWorkspaceId) setConfirmDeleteWorkspace(null);
          }}
          onConfirm={() => void deleteSidebarWorkspace(confirmDeleteWorkspace)}
        />
      )}
      {workspaceCreateRepo && (
        <WorkspaceCreateDialog
          repo={workspaceCreateRepo}
          onClose={() => setWorkspaceCreateRepo(null)}
          onCreatedPending={(workspace) => prependSidebarWorkspace(workspace as SidebarWorkspace)}
          onCancelledPending={(workspaceId) => setSidebarWorkspaces(prev => prev.filter(item => item._id !== workspaceId))}
          onCreated={(workspace) => {
            prependSidebarWorkspace(workspace as SidebarWorkspace);
            setWorkspaceCreateRepo(null);
            setActiveWorkspaceName(workspace.name ?? null);
            navigate(workspaceChatPath(workspace._id));
          }}
        />
      )}
    </div>
  );
}

function WorkspaceDeleteConfirmDialog({
  workspace,
  deleting,
  onCancel,
  onConfirm,
}: {
  workspace: SidebarWorkspace;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Delete workspace"
      onClick={() => {
        if (!deleting) onCancel();
      }}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-lg border border-app bg-app-card shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-app px-5 py-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-accent-red/25 bg-accent-red/10">
            <AlertTriangle className="h-4 w-4 text-accent-red" />
          </div>
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-theme-primary">Delete workspace</h2>
            <p className="mt-1 text-[12px] leading-5 text-theme-muted">
              This will delete <span className="font-medium text-theme-primary">{workspace.name}</span> from your workspace list.
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2 px-5 py-4">
          <button
            type="button"
            onClick={onCancel}
            disabled={deleting}
            className="btn btn-secondary btn-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={deleting}
            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-sm border border-accent-red/35 bg-accent-red px-3 text-[12px] font-medium text-white transition-colors hover:bg-accent-red/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {deleting ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}
