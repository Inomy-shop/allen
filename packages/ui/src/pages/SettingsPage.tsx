import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { RotateCcw, Check, Palette, Type, Sparkles, Server, User, Eye,
  Bot, Brain, Zap, Cpu, Atom, Terminal, Code, Rocket, Shield, Hexagon, Flame, Monitor, Moon, Sun,
  Bell, Keyboard, ShieldCheck,
} from 'lucide-react';
import McpServerManager from '../components/settings/McpServerManager';
import { useAuthStore } from '../stores/authStore';
import UsersAdminPage from './UsersAdminPage';
import {
  useSettingsStore,
  THEME_PRESETS,
  FONT_PRESETS,
  getAccentOptions,
  AGENT_ICON_PRESETS,
  type ThemePreset,
  type FontPreset,
} from '../stores/settingsStore';
import { type ColorMode } from '../lib/theme';

// Icon name → component mapping
const ICON_MAP: Record<string, React.ElementType> = {
  Bot, Brain, Sparkles, Zap, Cpu, Atom, Terminal, Code, Rocket, Shield, Hexagon, Flame,
};

// ── Settings Tabs ──

const TABS = [
  { id: 'account', label: 'account', icon: User, adminOnly: false },
  { id: 'appearance', label: 'appearance', icon: Palette, adminOnly: false },
  { id: 'shortcuts', label: 'shortcuts', icon: Keyboard, adminOnly: false },
  { id: 'notifications', label: 'notifications', icon: Bell, adminOnly: false },
  { id: 'users', label: 'users', icon: ShieldCheck, adminOnly: true },
  { id: 'mcp', label: 'mcp servers', icon: Server, adminOnly: false },
] as const;

type TabId = (typeof TABS)[number]['id'];

// ── Reusable Section Header ──

function SectionHeader({ icon: Icon, title }: { icon: React.ElementType; title: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <Icon className="w-4 h-4 text-accent-blue" />
      <h2 className="font-label text-xs uppercase tracking-widest text-theme-muted">{title}</h2>
    </div>
  );
}

// ── Profile Tab ──

function ProfileRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="pref-row">
      <span className="pref-k">{label}</span>
      <span className="pref-v">{value}</span>
    </div>
  );
}

function formatProfileDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function ProfileTab() {
  const user = useAuthStore((s) => s.user);

  if (!user) {
    return (
      <div className="settings-body">
        <div className="pref-list">
          <div className="pref-row">
            <span className="pref-k">account</span>
            <span className="pref-v">not signed in</span>
          </div>
        </div>
      </div>
    );
  }

  const initials = user.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join('');

  return (
    <div className="settings-body">
      <div className="settings-id">
        <div className="settings-avatar">{initials || '?'}</div>
        <div className="min-w-0">
          <div className="settings-name">{user.name}</div>
          <div className="settings-email">{user.email}</div>
        </div>
        <span className={`lib-pill ${user.role === 'admin' ? 'ok' : 'waiting'}`}>{user.role}</span>
      </div>

      <div className="pref-list">
        <ProfileRow label="name" value={user.name} />
        <ProfileRow label="email" value={user.email} />
        <ProfileRow label="role" value={user.role} />
        <ProfileRow label="user id" value={<span className="mono text-[11px]">{user.id}</span>} />
        <ProfileRow label="created" value={formatProfileDate(user.createdAt)} />
        <ProfileRow label="last login" value={formatProfileDate(user.lastLoginAt)} />
        {user.mustResetPassword && <ProfileRow label="password" value="reset required" />}
      </div>
    </div>
  );
}

// ── Users Tab ──

function UsersTab() {
  return (
    <div className="settings-body wide">
      <UsersAdminPage />
    </div>
  );
}

// ── Theme Tab (existing content extracted) ──

function FontPreloader() {
  const preloadedRef = useRef(false);
  useEffect(() => {
    if (preloadedRef.current) return;
    preloadedRef.current = true;
    FONT_PRESETS.forEach((fp) => {
      const existing = document.querySelector(`link[data-font-preview="${fp.name}"]`);
      if (!existing) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = fp.googleFontsUrl;
        link.setAttribute('data-font-preview', fp.name);
        document.head.appendChild(link);
      }
    });
  }, []);
  return null;
}

function ThemeCard({ preset, isActive, onSelect }: { preset: ThemePreset; isActive: boolean; onSelect: () => void }) {
  const { surface, surface100, surface200, border, accent } = preset.colors;
  return (
    <button
      onClick={onSelect}
      title={preset.label}
      className={`relative group flex flex-col rounded-sm border p-3 transition-all duration-200 cursor-pointer ${isActive ? 'border-accent-blue' : 'border-app hover:border-border-light'}`}
      style={isActive ? { borderColor: accent, boxShadow: `0 0 12px ${accent}40` } : undefined}
    >
      <div className="flex gap-1 mb-2">
        {[surface, surface100, surface200, border, accent].map((c, i) => (
          <div key={i} className="w-6 h-6 rounded-sm" style={{ background: c }} />
        ))}
      </div>
      <span className="overline text-theme-secondary">{preset.label}</span>
      {isActive && (
        <div className="absolute top-2 right-2 w-5 h-5 rounded-full flex items-center justify-center" style={{ background: accent }}>
          <Check className="w-3 h-3 text-black" />
        </div>
      )}
    </button>
  );
}

function FontCard({ preset, isActive, onSelect }: { preset: FontPreset; isActive: boolean; onSelect: () => void }) {
  return (
    <button
      onClick={onSelect}
      className={`relative group flex flex-col rounded-sm border p-3 transition-all duration-200 cursor-pointer text-left ${isActive ? 'border-accent-blue bg-surface-100/80' : 'border-app hover:border-border-light bg-app-muted/50'}`}
    >
      <span className="overline text-theme-muted mb-1">{preset.label}</span>
      <span className="text-lg text-theme-primary leading-snug" style={{ fontFamily: `'${preset.heading}', sans-serif` }}>Heading Aa</span>
      <span className="text-sm text-theme-secondary mt-0.5" style={{ fontFamily: `'${preset.body}', sans-serif` }}>Body text Bb Cc 123</span>
      <span className="text-xs text-theme-muted mt-0.5" style={{ fontFamily: `'${preset.mono}', monospace` }}>mono: 0x1F4A9</span>
      {isActive && (
        <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-accent-blue flex items-center justify-center">
          <Check className="w-3 h-3 text-black" />
        </div>
      )}
    </button>
  );
}

function LivePreview() {
  const themeName = useSettingsStore((s) => s.themeName);
  const fontName = useSettingsStore((s) => s.fontName);
  const customAccent = useSettingsStore((s) => s.customAccent);
  return (
    <div className="card p-5 space-y-4" key={`${themeName}-${fontName}-${customAccent}`}>
      <h3 className="font-heading text-lg text-theme-primary tracking-wide">Live Preview</h3>
      <div className="space-y-3">
        <h4 className="font-heading text-base text-accent-blue">Heading Font Sample</h4>
        <p className="font-body text-sm text-theme-secondary">This is body text rendered in the currently selected body font with longer content for readability testing.</p>
        <pre className="font-mono text-xs text-accent-green bg-app-muted p-3 rounded-sm border border-app overflow-x-auto">
{`const pipeline = await Allen.execute({
  workflow: "data-enrichment",
  batchSize: 250,
});`}
        </pre>
        <div className="flex gap-2 flex-wrap">
          <button className="btn-primary">Primary</button>
          <button className="btn-danger">Danger</button>
          <button className="btn-ghost">Ghost</button>
        </div>
      </div>
    </div>
  );
}

// ── Color Mode Options ──

const COLOR_MODE_OPTIONS = [
  { value: 'system' as ColorMode, label: 'System', icon: Monitor },
  { value: 'light' as ColorMode, label: 'Light', icon: Sun },
  { value: 'dark' as ColorMode, label: 'Dark', icon: Moon },
];

function ThemeTab() {
  const colorMode = useSettingsStore((s) => s.colorMode);
  const themeName = useSettingsStore((s) => s.themeName);
  const fontName = useSettingsStore((s) => s.fontName);
  const customAccent = useSettingsStore((s) => s.customAccent);
  const agentIcon = useSettingsStore((s) => s.agentIcon);
  const setColorMode = useSettingsStore((s) => s.setColorMode);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const setFont = useSettingsStore((s) => s.setFont);
  const setCustomAccent = useSettingsStore((s) => s.setCustomAccent);
  const setAgentIcon = useSettingsStore((s) => s.setAgentIcon);
  const resetToDefaults = useSettingsStore((s) => s.resetToDefaults);

  const activeTheme = THEME_PRESETS.find((t) => t.name === themeName) ?? THEME_PRESETS[0];
  const currentAccent = customAccent ?? activeTheme.colors.accent;

  return (
    <div className="space-y-6">
      <FontPreloader />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-xl text-theme-primary tracking-wider">Appearance</h1>
          <p className="text-sm text-theme-muted font-body mt-1">Personalize your workspace</p>
        </div>
        <button onClick={resetToDefaults} className="btn-ghost flex items-center gap-2 text-xs">
          <RotateCcw className="w-3 h-3" /> Reset All
        </button>
      </div>

      {/* Color Mode Selector */}
      <div>
        <SectionHeader icon={Monitor} title="Color Mode" />
        <div className="flex gap-2 mb-6">
          {COLOR_MODE_OPTIONS.map((option) => {
            const Icon = option.icon;
            const isActive = colorMode === option.value;
            return (
              <button
                key={option.value}
                onClick={() => setColorMode(option.value)}
                className={`flex items-center gap-2 px-3 py-2 rounded-sm border transition-all ${
                  isActive
                    ? 'border-accent-blue bg-accent-blue/15 text-accent-blue'
                    : 'border-app text-theme-secondary hover:border-border hover:text-theme-secondary'
                }`}
              >
                <Icon className="w-4 h-4" />
                <span className="overline">{option.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Top row: Theme + Accent + Icon */}
      <div className="grid grid-cols-1 xl:grid-cols-4 gap-4">
        {/* Themes — 3 cols on xl */}
        <div className="xl:col-span-3">
          <SectionHeader icon={Palette} title="Theme" />
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2.5">
            {THEME_PRESETS.map((preset) => (
              <ThemeCard key={preset.name} preset={preset} isActive={themeName === preset.name} onSelect={() => setTheme(preset.name)} />
            ))}
          </div>
        </div>

        {/* Accent + Icon — 1 col on xl */}
        <div className="space-y-4">
          <div>
            <SectionHeader icon={Sparkles} title="Accent" />
            <div className="flex flex-wrap gap-2">
              {getAccentOptions(colorMode).map((opt) => (
                <button key={opt.name} onClick={() => setCustomAccent(opt.color)}
                  className={`w-8 h-8 rounded-lg border-2 transition-all duration-150 cursor-pointer flex items-center justify-center ${currentAccent === opt.color ? 'scale-110' : 'border-transparent hover:scale-105'}`}
                  style={{ background: opt.color, borderColor: currentAccent === opt.color ? 'var(--color-text-primary)' : undefined, boxShadow: currentAccent === opt.color ? `0 0 8px ${opt.color}60` : undefined }}
                  title={opt.label}
                >
                  {currentAccent === opt.color && <Check className="w-3 h-3 text-theme-primary" />}
                </button>
              ))}
              <button onClick={() => setCustomAccent(null)} className="w-8 h-8 rounded-lg border border-dashed border-app flex items-center justify-center text-theme-subtle hover:text-theme-secondary hover:border-border transition-colors cursor-pointer" title="Reset to theme default">
                <RotateCcw className="w-3 h-3" />
              </button>
            </div>
          </div>

          <div>
            <SectionHeader icon={Bot} title="Agent Icon" />
            <div className="flex flex-wrap gap-1.5">
              {AGENT_ICON_PRESETS.map((preset) => {
                const IconComp = ICON_MAP[preset.icon] ?? Bot;
                const isActive = agentIcon === preset.name;
                return (
                  <button
                    key={preset.name}
                    onClick={() => setAgentIcon(preset.name)}
                    className={`w-9 h-9 rounded-lg flex items-center justify-center transition-all duration-200 cursor-pointer ${isActive ? 'bg-accent-blue/15 text-accent-blue border border-accent-blue/30' : 'bg-app-muted/50 text-theme-muted border border-transparent hover:border-app hover:text-theme-secondary'}`}
                    title={preset.label}
                  >
                    <IconComp className="w-4 h-4" />
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Fonts */}
      <div>
        <SectionHeader icon={Type} title="Font Style" />
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2.5">
          {FONT_PRESETS.map((preset) => (
            <FontCard key={preset.name} preset={preset} isActive={fontName === preset.name} onSelect={() => setFont(preset.name)} />
          ))}
        </div>
      </div>

      {/* Preview */}
      <div>
        <SectionHeader icon={Eye} title="Preview" />
        <LivePreview />
      </div>
    </div>
  );
}

function SettingsSegment({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button type="button" className={`pref-seg ${active ? 'active' : ''}`} onClick={onClick}>
      {children}
    </button>
  );
}

function AppearanceTab() {
  const colorMode = useSettingsStore((s) => s.colorMode);
  const themeName = useSettingsStore((s) => s.themeName);
  const fontName = useSettingsStore((s) => s.fontName);
  const customAccent = useSettingsStore((s) => s.customAccent);
  const agentIcon = useSettingsStore((s) => s.agentIcon);
  const setColorMode = useSettingsStore((s) => s.setColorMode);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const setFont = useSettingsStore((s) => s.setFont);
  const setCustomAccent = useSettingsStore((s) => s.setCustomAccent);
  const setAgentIcon = useSettingsStore((s) => s.setAgentIcon);
  const resetToDefaults = useSettingsStore((s) => s.resetToDefaults);
  const activeTheme = THEME_PRESETS.find((t) => t.name === themeName) ?? THEME_PRESETS[0];
  const currentAccent = customAccent ?? activeTheme.colors.accent;

  return (
    <div className="settings-body">
      <FontPreloader />
      <div className="pref-list">
        <div className="pref-row">
          <span className="pref-k">theme mode</span>
          <span className="pref-v">
            {COLOR_MODE_OPTIONS.map((option) => (
              <SettingsSegment key={option.value} active={colorMode === option.value} onClick={() => setColorMode(option.value)}>
                {option.label.toLowerCase()}
              </SettingsSegment>
            ))}
          </span>
        </div>
        <div className="pref-row">
          <span className="pref-k">theme</span>
          <span className="pref-v">
            <select className="pref-select" value={themeName} onChange={event => setTheme(event.target.value)}>
              {THEME_PRESETS.map((preset) => (
                <option key={preset.name} value={preset.name}>{preset.label}</option>
              ))}
            </select>
          </span>
        </div>
        <div className="pref-row">
          <span className="pref-k">accent</span>
          <span className="pref-v pref-swatches">
            {getAccentOptions(colorMode).map((opt) => (
              <button
                key={opt.name}
                type="button"
                className={`pref-swatch ${currentAccent === opt.color ? 'active' : ''}`}
                style={{ background: opt.color }}
                title={opt.label}
                onClick={() => setCustomAccent(opt.color)}
              />
            ))}
            <button type="button" className="pref-seg" onClick={() => setCustomAccent(null)}>default</button>
          </span>
        </div>
        <div className="pref-row">
          <span className="pref-k">font</span>
          <span className="pref-v">
            <select className="pref-select" value={fontName} onChange={event => setFont(event.target.value)}>
              {FONT_PRESETS.map((preset) => (
                <option key={preset.name} value={preset.name}>{preset.label}</option>
              ))}
            </select>
          </span>
        </div>
        <div className="pref-row">
          <span className="pref-k">agent icon</span>
          <span className="pref-v pref-icons">
            {AGENT_ICON_PRESETS.map((preset) => {
              const IconComp = ICON_MAP[preset.icon] ?? Bot;
              return (
                <button
                  key={preset.name}
                  type="button"
                  className={`pref-icon ${agentIcon === preset.name ? 'active' : ''}`}
                  title={preset.label}
                  onClick={() => setAgentIcon(preset.name)}
                >
                  <IconComp className="h-4 w-4" />
                </button>
              );
            })}
          </span>
        </div>
        <div className="pref-row">
          <span className="pref-k">reset</span>
          <span className="pref-v">
            <button type="button" className="pref-seg" onClick={resetToDefaults}>restore defaults</button>
          </span>
        </div>
      </div>
    </div>
  );
}

function ShortcutsTab() {
  return (
    <div className="settings-body">
      <div className="pref-list">
        <div className="pref-row"><span className="pref-k">⌘ K</span><span className="pref-v">command palette</span></div>
        <div className="pref-row"><span className="pref-k">⌘ N</span><span className="pref-v">new chat</span></div>
        <div className="pref-row"><span className="pref-k">⌘ /</span><span className="pref-v">focus composer</span></div>
        <div className="pref-row"><span className="pref-k">G then I</span><span className="pref-v">go to inbox</span></div>
        <div className="pref-row"><span className="pref-k">G then M</span><span className="pref-v">go to my work</span></div>
      </div>
    </div>
  );
}

function NotificationsTab() {
  return (
    <div className="settings-body">
      <div className="pref-list">
        <div className="pref-row"><span className="pref-k">when Allen needs me</span><span className="pref-v">in-app · slack · email</span></div>
        <div className="pref-row"><span className="pref-k">when a PR is ready to review</span><span className="pref-v">in-app · slack</span></div>
        <div className="pref-row"><span className="pref-k">when my run finishes</span><span className="pref-v">in-app</span></div>
        <div className="pref-row"><span className="pref-k">daily digest</span><span className="pref-v">9:00 am</span></div>
      </div>
    </div>
  );
}

// ── MCP Tab ──

function McpTab() {
  return (
    <div className="settings-body wide">
      <McpServerManager />
    </div>
  );
}


// ── Main Page ──

const TAB_COMPONENTS: Record<TabId, React.FC> = {
  account: ProfileTab,
  appearance: AppearanceTab,
  shortcuts: ShortcutsTab,
  notifications: NotificationsTab,
  users: UsersTab,
  mcp: McpTab,
};

export default function SettingsPage() {
  const { tab } = useParams<{ tab?: string }>();
  const navigate = useNavigate();
  const currentUser = useAuthStore((s) => s.user);
  const isAdmin = currentUser?.role === 'admin';

  const requested = tab === 'profile' ? 'account' : (tab ?? 'account');
  const tabDef = TABS.find((t) => t.id === requested);
  const allowed = tabDef && (!tabDef.adminOnly || isAdmin);
  const activeTab: TabId = requested && allowed ? (requested as TabId) : 'account';

  useEffect(() => {
    if (requested && !allowed) {
      navigate('/settings/account', { replace: true });
    }
  }, [requested, allowed, navigate]);

  const TabContent = TAB_COMPONENTS[activeTab];
  const visibleTabs = TABS.filter((item) => !item.adminOnly || isAdmin);

  return (
    <div className="content scroll-hide" data-screen-label="settings">
      <div className="page-head">
        <h1>settings</h1>
        <p className="sub">your preferences</p>
        <nav className="topfilter-tabs">
          {visibleTabs.map((item) => (
            <button
              key={item.id}
              className={`tft ${activeTab === item.id ? 'active' : ''}`}
              onClick={() => navigate(`/settings/${item.id}`)}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </nav>
      </div>
      <TabContent />
    </div>
  );
}
