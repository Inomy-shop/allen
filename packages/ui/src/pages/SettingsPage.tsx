import { useEffect, useRef } from 'react';
import { useParams, useNavigate, NavLink } from 'react-router-dom';
import { RotateCcw, Check, Palette, Type, Sparkles, Server, User, Eye, Key,
  Bot, Brain, Zap, Cpu, Atom, Terminal, Code, Rocket, Shield, Hexagon, Flame,
} from 'lucide-react';
import McpServerManager from '../components/settings/McpServerManager';
import {
  useSettingsStore,
  THEME_PRESETS,
  FONT_PRESETS,
  ACCENT_OPTIONS,
  AGENT_ICON_PRESETS,
  type ThemePreset,
  type FontPreset,
} from '../stores/settingsStore';

// Icon name → component mapping
const ICON_MAP: Record<string, React.ElementType> = {
  Bot, Brain, Sparkles, Zap, Cpu, Atom, Terminal, Code, Rocket, Shield, Hexagon, Flame,
};

// ── Settings Tabs ──

const TABS = [
  { id: 'profile', label: 'Profile', icon: User },
  { id: 'theme', label: 'Theme & Fonts', icon: Palette },
  { id: 'mcp', label: 'MCP Servers', icon: Server },
  { id: 'secrets', label: 'Secrets', icon: Key },
] as const;

type TabId = (typeof TABS)[number]['id'];

// ── Reusable Section Header ──

function SectionHeader({ icon: Icon, title }: { icon: React.ElementType; title: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <Icon className="w-4 h-4 text-accent-blue" />
      <h2 className="font-label text-xs uppercase tracking-widest text-gray-400">{title}</h2>
    </div>
  );
}

// ── Profile Tab ──

function ProfileTab() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-xl text-white tracking-wider">Profile</h1>
        <p className="text-sm text-gray-500 font-body mt-1">Manage your FlowForge identity</p>
      </div>
      <div className="card p-6 space-y-4">
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 rounded-lg bg-accent-blue/10 border border-accent-blue/20 flex items-center justify-center">
            <User className="w-8 h-8 text-accent-blue/50" />
          </div>
          <div>
            <div className="text-lg font-heading text-white">FlowForge User</div>
            <div className="text-sm text-gray-500 font-body">Local development environment</div>
          </div>
        </div>
        <div className="border-t border-border/30 pt-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-500 font-label uppercase tracking-wider">Environment</span>
            <span className="text-sm text-gray-300 font-mono">development</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-500 font-label uppercase tracking-wider">Version</span>
            <span className="text-sm text-gray-300 font-mono">v0.1.0</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-500 font-label uppercase tracking-wider">Claude CLI</span>
            <span className="text-sm text-accent-green font-mono">Authenticated</span>
          </div>
        </div>
      </div>
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
      className={`relative group flex flex-col rounded-sm border p-3 transition-all duration-200 cursor-pointer ${isActive ? 'border-accent-blue shadow-glow-blue' : 'border-border/60 hover:border-border-light'}`}
      style={isActive ? { borderColor: accent, boxShadow: `0 0 12px ${accent}40` } : undefined}
    >
      <div className="flex gap-1 mb-2">
        {[surface, surface100, surface200, border, accent].map((c, i) => (
          <div key={i} className="w-6 h-6 rounded-sm" style={{ background: c }} />
        ))}
      </div>
      <span className="text-xs font-label uppercase tracking-wider text-gray-300">{preset.label}</span>
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
      className={`relative group flex flex-col rounded-sm border p-3 transition-all duration-200 cursor-pointer text-left ${isActive ? 'border-accent-blue shadow-glow-blue bg-surface-100/80' : 'border-border/60 hover:border-border-light bg-surface-100/40'}`}
    >
      <span className="text-xs font-label uppercase tracking-wider text-gray-500 mb-1">{preset.label}</span>
      <span className="text-lg text-gray-100 leading-snug" style={{ fontFamily: `'${preset.heading}', sans-serif` }}>Heading Aa</span>
      <span className="text-sm text-gray-300 mt-0.5" style={{ fontFamily: `'${preset.body}', sans-serif` }}>Body text Bb Cc 123</span>
      <span className="text-xs text-gray-500 mt-0.5" style={{ fontFamily: `'${preset.mono}', monospace` }}>mono: 0x1F4A9</span>
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
      <h3 className="font-heading text-lg text-white tracking-wide">Live Preview</h3>
      <div className="space-y-3">
        <h4 className="font-heading text-base text-accent-blue">Heading Font Sample</h4>
        <p className="font-body text-sm text-gray-300">This is body text rendered in the currently selected body font with longer content for readability testing.</p>
        <pre className="font-mono text-xs text-accent-green bg-surface-200/60 p-3 rounded-sm border border-border/40 overflow-x-auto">
{`const pipeline = await FlowForge.execute({
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

function ThemeTab() {
  const themeName = useSettingsStore((s) => s.themeName);
  const fontName = useSettingsStore((s) => s.fontName);
  const customAccent = useSettingsStore((s) => s.customAccent);
  const agentIcon = useSettingsStore((s) => s.agentIcon);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const setFont = useSettingsStore((s) => s.setFont);
  const setCustomAccent = useSettingsStore((s) => s.setCustomAccent);
  const setAgentIcon = useSettingsStore((s) => s.setAgentIcon);
  const resetToDefaults = useSettingsStore((s) => s.resetToDefaults);

  const activeTheme = THEME_PRESETS.find((t) => t.name === themeName) ?? THEME_PRESETS[0];
  const currentAccent = customAccent ?? activeTheme.colors.accent;

  return (
    <div className="space-y-8">
      <FontPreloader />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-xl text-white tracking-wider">Theme & Fonts</h1>
          <p className="text-sm text-gray-500 font-body mt-1">Customize the look and feel</p>
        </div>
        <button onClick={resetToDefaults} className="btn-ghost flex items-center gap-2">
          <RotateCcw className="w-3.5 h-3.5" /> Reset Defaults
        </button>
      </div>

      <section>
        <SectionHeader icon={Palette} title="Theme" />
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3">
          {THEME_PRESETS.map((preset) => (
            <ThemeCard key={preset.name} preset={preset} isActive={themeName === preset.name} onSelect={() => setTheme(preset.name)} />
          ))}
        </div>
      </section>

      <section>
        <SectionHeader icon={Sparkles} title="Accent Color" />
        <div className="flex flex-wrap items-center gap-3">
          {ACCENT_OPTIONS.map((opt) => (
            <button key={opt.name} onClick={() => setCustomAccent(opt.color)}
              className={`group relative w-8 h-8 rounded-full border-2 transition-all duration-150 cursor-pointer ${currentAccent === opt.color ? 'scale-110' : 'border-transparent hover:scale-105'}`}
              style={{ background: opt.color, borderColor: currentAccent === opt.color ? '#fff' : undefined, boxShadow: currentAccent === opt.color ? `0 0 10px ${opt.color}80` : undefined }}
              title={opt.label}
            >
              {currentAccent === opt.color && <Check className="w-3.5 h-3.5 text-black absolute inset-0 m-auto" />}
            </button>
          ))}
          <button onClick={() => setCustomAccent(null)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-sm border border-border/60 text-xs font-label uppercase tracking-wider text-gray-500 hover:text-gray-300 hover:border-border-light transition-colors cursor-pointer">
            <RotateCcw className="w-3 h-3" /> Theme Default
          </button>
        </div>
      </section>

      <section>
        <SectionHeader icon={Type} title="Font Style" />
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {FONT_PRESETS.map((preset) => (
            <FontCard key={preset.name} preset={preset} isActive={fontName === preset.name} onSelect={() => setFont(preset.name)} />
          ))}
        </div>
      </section>

      <section>
        <SectionHeader icon={Bot} title="Agent Icon" />
        <div className="grid grid-cols-4 sm:grid-cols-6 gap-3">
          {AGENT_ICON_PRESETS.map((preset) => {
            const IconComp = ICON_MAP[preset.icon] ?? Bot;
            const isActive = agentIcon === preset.name;
            return (
              <button
                key={preset.name}
                onClick={() => setAgentIcon(preset.name)}
                className={`flex flex-col items-center gap-1.5 p-3 rounded-sm border transition-all duration-200 cursor-pointer ${isActive ? 'border-accent-blue shadow-glow-blue bg-surface-100/80' : 'border-border/60 hover:border-border-light bg-surface-100/40'}`}
              >
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${isActive ? 'bg-accent-blue/15 text-accent-blue' : 'bg-surface-200/60 text-gray-400'}`}>
                  <IconComp className="w-5 h-5" />
                </div>
                <span className="text-[10px] font-label uppercase tracking-wider text-gray-500">{preset.label}</span>
                {isActive && (
                  <div className="absolute top-1 right-1 w-4 h-4 rounded-full bg-accent-blue flex items-center justify-center">
                    <Check className="w-2.5 h-2.5 text-black" />
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </section>

      <section>
        <SectionHeader icon={Eye} title="Preview" />
        <LivePreview />
      </section>
    </div>
  );
}

// ── MCP Tab ──

function McpTab() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-xl text-white tracking-wider">MCP Servers</h1>
        <p className="text-sm text-gray-500 font-body mt-1">
          Connect external tools to the FlowForge Chat agent via Model Context Protocol servers.
        </p>
      </div>
      <McpServerManager />
    </div>
  );
}

// ── Secrets Tab ──

function SecretsTab() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-xl text-white tracking-wider">Secrets</h1>
        <p className="text-sm text-gray-500 font-body mt-1">Manage API keys and credentials</p>
      </div>
      <div className="card p-6">
        <p className="text-xs text-gray-500 font-body">
          Secrets are stored securely in the database and used by workflows and chat tools.
          API keys for MCP servers are managed in the MCP Servers tab.
        </p>
      </div>
    </div>
  );
}

// ── Main Page ──

const TAB_COMPONENTS: Record<TabId, React.FC> = {
  profile: ProfileTab,
  theme: ThemeTab,
  mcp: McpTab,
  secrets: SecretsTab,
};

export default function SettingsPage() {
  const { tab } = useParams<{ tab?: string }>();
  const navigate = useNavigate();
  const activeTab = (TABS.some(t => t.id === tab) ? tab : 'profile') as TabId;

  // Redirect /settings to /settings/profile
  useEffect(() => {
    if (!tab) navigate('/settings/profile', { replace: true });
  }, [tab]);

  const TabContent = TAB_COMPONENTS[activeTab];

  return (
    <div className="flex h-full">
      {/* Settings sidebar */}
      <div className="w-56 shrink-0 bg-surface-50 border-r border-border/50 flex flex-col">
        <div className="p-4 border-b border-border/50">
          <h2 className="font-heading text-sm font-bold text-white tracking-widest uppercase">Settings</h2>
        </div>
        <div className="flex-1 py-2">
          {TABS.map(({ id, label, icon: Icon }) => (
            <NavLink
              key={id}
              to={`/settings/${id}`}
              className={`flex items-center gap-3 px-4 py-2.5 mx-2 rounded-sm text-sm font-body transition-all duration-150 ${
                activeTab === id
                  ? 'bg-accent-blue/10 text-accent-blue border-l-2 border-accent-blue'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-surface-200/50 border-l-2 border-transparent'
              }`}
            >
              <Icon className="w-4 h-4" />
              {label}
            </NavLink>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-auto p-6">
        <TabContent />
      </div>
    </div>
  );
}
