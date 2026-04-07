import { useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { RotateCcw, Check, Palette, Type, Sparkles, Server, User, Eye, Key,
  Bot, Brain, Zap, Cpu, Atom, Terminal, Code, Rocket, Shield, Hexagon, Flame, Monitor, Moon, Sun,
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
import { type ColorMode } from '../lib/theme';

// Icon name → component mapping
const ICON_MAP: Record<string, React.ElementType> = {
  Bot, Brain, Sparkles, Zap, Cpu, Atom, Terminal, Code, Rocket, Shield, Hexagon, Flame,
};

// ── Settings Tabs ──

const TABS = [
  { id: 'mcp', label: 'MCP Servers', icon: Server, description: 'External tool integrations' },
  { id: 'theme', label: 'Appearance', icon: Palette, description: 'Theme, fonts & agent icon' },
  { id: 'secrets', label: 'Secrets', icon: Key, description: 'API keys & credentials' },
  { id: 'profile', label: 'Profile', icon: User, description: 'Account & environment' },
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

function ProfileTab() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-xl text-white tracking-wider">Profile</h1>
        <p className="text-sm text-theme-muted font-body mt-1">Manage your FlowForge identity</p>
      </div>
      <div className="card p-6 space-y-4">
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 rounded-lg bg-accent-blue/10 border border-accent-blue/20 flex items-center justify-center">
            <User className="w-8 h-8 text-accent-blue/50" />
          </div>
          <div>
            <div className="text-lg font-heading text-white">FlowForge User</div>
            <div className="text-sm text-theme-muted font-body">Local development environment</div>
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
      title={preset.label}
      className={`relative group flex flex-col rounded-sm border p-3 transition-all duration-200 cursor-pointer ${isActive ? 'border-accent-blue shadow-glow-blue' : 'border-border/60 hover:border-border-light'}`}
      style={isActive ? { borderColor: accent, boxShadow: `0 0 12px ${accent}40` } : undefined}
    >
      <div className="flex gap-1 mb-2">
        {[surface, surface100, surface200, border, accent].map((c, i) => (
          <div key={i} className="w-6 h-6 rounded-sm" style={{ background: c }} />
        ))}
      </div>
      <span className="text-xs font-label uppercase tracking-wider text-theme-secondary">{preset.label}</span>
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
      <span className="text-xs font-label uppercase tracking-wider text-theme-muted mb-1">{preset.label}</span>
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
          <h1 className="font-heading text-xl text-white tracking-wider">Appearance</h1>
          <p className="text-sm text-gray-500 font-body mt-1">Personalize your workspace</p>
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
                    : 'border-border/50 text-gray-400 hover:border-border hover:text-gray-300'
                }`}
              >
                <Icon className="w-4 h-4" />
                <span className="text-xs font-label uppercase tracking-wider">{option.label}</span>
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
              {ACCENT_OPTIONS.map((opt) => (
                <button key={opt.name} onClick={() => setCustomAccent(opt.color)}
                  className={`w-8 h-8 rounded-lg border-2 transition-all duration-150 cursor-pointer flex items-center justify-center ${currentAccent === opt.color ? 'scale-110' : 'border-transparent hover:scale-105'}`}
                  style={{ background: opt.color, borderColor: currentAccent === opt.color ? '#fff' : undefined, boxShadow: currentAccent === opt.color ? `0 0 8px ${opt.color}60` : undefined }}
                  title={opt.label}
                >
                  {currentAccent === opt.color && <Check className="w-3 h-3 text-black" />}
                </button>
              ))}
              <button onClick={() => setCustomAccent(null)} className="w-8 h-8 rounded-lg border border-dashed border-border/50 flex items-center justify-center text-gray-600 hover:text-gray-400 hover:border-border transition-colors cursor-pointer" title="Reset to theme default">
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
                    className={`w-9 h-9 rounded-lg flex items-center justify-center transition-all duration-200 cursor-pointer ${isActive ? 'bg-accent-blue/15 text-accent-blue border border-accent-blue/30' : 'bg-surface-200/30 text-gray-500 border border-transparent hover:border-border/50 hover:text-gray-300'}`}
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
  const activeTab = (TABS.some(t => t.id === tab) ? tab : 'mcp') as TabId;

  useEffect(() => {
    if (!tab) navigate('/settings/mcp', { replace: true });
  }, [tab]);

  const TabContent = TAB_COMPONENTS[activeTab];

  return (
    <div className="flex-1 overflow-auto p-6">
      <TabContent />
    </div>
  );
}
