import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { RotateCcw, Check, Palette, Type, Sparkles, Server, User, Eye, Key,
  Bot, Brain, Zap, Cpu, Atom, Terminal, Code, Rocket, Shield, Hexagon, Flame, Monitor, Moon, Sun,
  Plus, Pencil, Trash2, X, Lock, AlertCircle,
} from 'lucide-react';
import McpServerManager from '../components/settings/McpServerManager';
import { secrets as secretsApi } from '../services/api';
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

type SecretDialogMode =
  | { type: 'closed' }
  | { type: 'create' }
  | { type: 'edit'; key: string }
  | { type: 'delete'; key: string };

function SecretDialog({
  mode,
  existingKeys,
  onClose,
  onSubmit,
}: {
  mode: SecretDialogMode;
  existingKeys: string[];
  onClose: () => void;
  onSubmit: (key: string, value: string) => Promise<void>;
}) {
  const [keyInput, setKeyInput] = useState('');
  const [valueInput, setValueInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valueInputRef = useRef<HTMLInputElement>(null);

  // Reset state when the dialog opens for a new operation
  useEffect(() => {
    if (mode.type === 'closed') return;
    setKeyInput(mode.type === 'edit' ? mode.key : '');
    setValueInput('');
    setError(null);
    setBusy(false);
    // Auto-focus the value field — both create and edit need a fresh value
    setTimeout(() => valueInputRef.current?.focus(), 50);
  }, [mode]);

  if (mode.type === 'closed' || mode.type === 'delete') return null;

  const isEdit = mode.type === 'edit';
  const title = isEdit ? `Replace value for ${mode.key}` : 'Add Secret';

  const handleSubmit = async () => {
    setError(null);
    const trimmedKey = keyInput.trim();
    const trimmedValue = valueInput; // don't trim — secrets may have leading/trailing whitespace
    if (!trimmedKey) {
      setError('Key is required');
      return;
    }
    if (!isEdit && !/^[A-Z0-9_]+$/.test(trimmedKey)) {
      setError('Key must contain only uppercase letters, digits, and underscores');
      return;
    }
    if (!isEdit && existingKeys.includes(trimmedKey)) {
      setError(`A secret named "${trimmedKey}" already exists`);
      return;
    }
    if (!trimmedValue) {
      setError('Value is required');
      return;
    }
    setBusy(true);
    try {
      await onSubmit(trimmedKey, trimmedValue);
      onClose();
    } catch (err) {
      setError((err as Error).message ?? String(err));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="card w-full max-w-md mx-4 p-6 space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="font-heading text-lg text-white tracking-wide">{title}</h3>
            <p className="text-xs text-theme-muted font-body mt-1">
              {isEdit
                ? 'For your safety the saved value is never shown. Enter the new value to replace it.'
                : 'Stored encrypted (AES-256-GCM) at rest. Only server-side code can read the plaintext.'}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-[10px] font-label uppercase tracking-widest text-theme-muted block mb-1">
              Key
            </label>
            <input
              type="text"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value.toUpperCase())}
              disabled={isEdit}
              placeholder="e.g. SLACK_BOT_TOKEN"
              className="w-full bg-surface-200/50 border border-border/30 rounded-md px-3 py-2 text-sm font-mono text-white placeholder-gray-600 focus:outline-none focus:border-accent-blue/50 disabled:opacity-60 disabled:cursor-not-allowed"
            />
          </div>

          <div>
            <label className="text-[10px] font-label uppercase tracking-widest text-theme-muted block mb-1">
              {isEdit ? 'New Value' : 'Value'}
            </label>
            <input
              ref={valueInputRef}
              type="password"
              value={valueInput}
              onChange={(e) => setValueInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }}
              placeholder={isEdit ? 'Enter new value to replace the saved one' : 'Paste the secret value'}
              autoComplete="new-password"
              className="w-full bg-surface-200/50 border border-border/30 rounded-md px-3 py-2 text-sm font-mono text-white placeholder-gray-600 focus:outline-none focus:border-accent-blue/50"
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-md border border-red-500/30 bg-red-500/10 text-xs text-red-400 font-body">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 pt-2">
          <button onClick={onClose} disabled={busy} className="btn-ghost text-xs">
            Cancel
          </button>
          <button onClick={handleSubmit} disabled={busy} className="btn-primary text-xs">
            {busy ? 'Saving…' : isEdit ? 'Replace' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteConfirmDialog({
  secretKey,
  onCancel,
  onConfirm,
}: {
  secretKey: string | null;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  if (!secretKey) return null;

  const handleConfirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="card w-full max-w-md mx-4 p-6 space-y-4">
        <div>
          <h3 className="font-heading text-lg text-white tracking-wide">Delete secret?</h3>
          <p className="text-xs text-theme-muted font-body mt-1">
            This will permanently remove <span className="font-mono text-accent-red">{secretKey}</span> from
            the database. Any code that depends on it will start failing immediately.
          </p>
        </div>
        <div className="flex items-center justify-end gap-2 pt-2">
          <button onClick={onCancel} disabled={busy} className="btn-ghost text-xs">
            Cancel
          </button>
          <button onClick={handleConfirm} disabled={busy} className="btn-danger text-xs">
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

function SecretsTab() {
  const [keys, setKeys] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<SecretDialogMode>({ type: 'closed' });

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const list = await secretsApi.list();
      setKeys((list ?? []).slice().sort((a, b) => a.localeCompare(b)));
    } catch (err) {
      setLoadError((err as Error).message ?? String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const handleSubmit = useCallback(async (key: string, value: string) => {
    if (dialog.type === 'edit') {
      await secretsApi.update(key, value);
    } else {
      await secretsApi.create(key, value);
    }
    await refresh();
  }, [dialog, refresh]);

  const handleDelete = useCallback(async () => {
    if (dialog.type !== 'delete') return;
    await secretsApi.delete(dialog.key);
    setDialog({ type: 'closed' });
    await refresh();
  }, [dialog, refresh]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-heading text-xl text-white tracking-wider">Secrets</h1>
          <p className="text-sm text-theme-muted font-body mt-1">
            API keys and credentials used by chat tools, workflows, and integrations.
          </p>
        </div>
        <button onClick={() => setDialog({ type: 'create' })} className="btn-primary flex items-center gap-2 text-xs shrink-0">
          <Plus className="w-3.5 h-3.5" />
          Add Secret
        </button>
      </div>

      <div className="card p-4 flex items-start gap-3 border border-accent-blue/20 bg-accent-blue/5">
        <Lock className="w-4 h-4 text-accent-blue mt-0.5 shrink-0" />
        <div className="text-xs text-theme-secondary font-body leading-relaxed">
          Secrets are encrypted at rest with AES-256-GCM. Saved values are never displayed in this UI or
          returned by the API — to update a secret, you must enter the new value. The master key lives
          outside the database (in <span className="font-mono text-theme-primary">FLOWFORGE_MASTER_KEY</span>),
          so even direct database access only reveals ciphertext.
        </div>
      </div>

      {loadError && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-md border border-red-500/30 bg-red-500/10 text-xs text-red-400 font-body">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>Failed to load secrets: {loadError}</span>
        </div>
      )}

      <div className="card overflow-hidden">
        {loading ? (
          <div className="p-6 text-xs text-theme-muted font-mono text-center">Loading…</div>
        ) : keys.length === 0 ? (
          <div className="p-8 text-center space-y-2">
            <Key className="w-8 h-8 text-theme-muted/50 mx-auto" />
            <p className="text-sm text-theme-muted font-body">No secrets stored yet</p>
            <p className="text-xs text-theme-muted/70 font-body">
              Click "Add Secret" to store an API key like <span className="font-mono">SLACK_BOT_TOKEN</span>.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border/30">
            {keys.map((key) => (
              <div key={key} className="flex items-center justify-between px-4 py-3 hover:bg-surface-100/30 transition-colors">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-8 h-8 rounded-md bg-accent-blue/10 border border-accent-blue/20 flex items-center justify-center shrink-0">
                    <Key className="w-3.5 h-3.5 text-accent-blue" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-mono text-white truncate">{key}</div>
                    <div className="text-[10px] font-mono text-theme-muted">••••••••••••••••</div>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => setDialog({ type: 'edit', key })}
                    title="Replace value"
                    className="w-7 h-7 flex items-center justify-center rounded-md text-gray-500 hover:text-accent-blue hover:bg-accent-blue/10 transition-colors"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => setDialog({ type: 'delete', key })}
                    title="Delete secret"
                    className="w-7 h-7 flex items-center justify-center rounded-md text-gray-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <SecretDialog
        mode={dialog}
        existingKeys={keys}
        onClose={() => setDialog({ type: 'closed' })}
        onSubmit={handleSubmit}
      />
      <DeleteConfirmDialog
        secretKey={dialog.type === 'delete' ? dialog.key : null}
        onCancel={() => setDialog({ type: 'closed' })}
        onConfirm={handleDelete}
      />
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
