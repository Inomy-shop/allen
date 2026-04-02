import { useEffect, useRef } from 'react';
import { RotateCcw, Check, Palette, Type, Eye, Sparkles } from 'lucide-react';
import {
  useSettingsStore,
  THEME_PRESETS,
  FONT_PRESETS,
  ACCENT_OPTIONS,
  type ThemePreset,
  type FontPreset,
} from '../stores/settingsStore';

/* ─── Preload all font URLs so preview cards render correctly ─── */
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

/* ─── Theme Card ─── */
function ThemeCard({ preset, isActive, onSelect }: {
  preset: ThemePreset;
  isActive: boolean;
  onSelect: () => void;
}) {
  const { surface, surface100, surface200, border, accent } = preset.colors;
  return (
    <button
      onClick={onSelect}
      className={`relative group flex flex-col rounded-sm border p-3 transition-all duration-200 cursor-pointer
        ${isActive
          ? 'border-accent-blue shadow-glow-blue'
          : 'border-border/60 hover:border-border-light'
        }`}
      style={isActive ? { borderColor: accent, boxShadow: `0 0 12px ${accent}40` } : undefined}
    >
      {/* Color swatches */}
      <div className="flex gap-1 mb-2">
        <div className="w-6 h-6 rounded-sm" style={{ background: surface }} />
        <div className="w-6 h-6 rounded-sm" style={{ background: surface100 }} />
        <div className="w-6 h-6 rounded-sm" style={{ background: surface200 }} />
        <div className="w-6 h-6 rounded-sm" style={{ background: border }} />
        <div className="w-6 h-6 rounded-sm" style={{ background: accent }} />
      </div>
      <span className="text-xs font-label uppercase tracking-wider text-gray-300">
        {preset.label}
      </span>
      {isActive && (
        <div
          className="absolute top-2 right-2 w-5 h-5 rounded-full flex items-center justify-center"
          style={{ background: accent }}
        >
          <Check className="w-3 h-3 text-black" />
        </div>
      )}
    </button>
  );
}

/* ─── Font Card ─── */
function FontCard({ preset, isActive, onSelect }: {
  preset: FontPreset;
  isActive: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`relative group flex flex-col rounded-sm border p-3 transition-all duration-200 cursor-pointer text-left
        ${isActive
          ? 'border-accent-blue shadow-glow-blue bg-surface-100/80'
          : 'border-border/60 hover:border-border-light bg-surface-100/40'
        }`}
    >
      <span className="text-xs font-label uppercase tracking-wider text-gray-500 mb-1">
        {preset.label}
      </span>
      <span
        className="text-lg text-gray-100 leading-snug"
        style={{ fontFamily: `'${preset.heading}', sans-serif` }}
      >
        Heading Aa
      </span>
      <span
        className="text-sm text-gray-300 mt-0.5"
        style={{ fontFamily: `'${preset.body}', sans-serif` }}
      >
        Body text Bb Cc 123
      </span>
      <span
        className="text-xs text-gray-500 mt-0.5"
        style={{ fontFamily: `'${preset.mono}', monospace` }}
      >
        mono: 0x1F4A9
      </span>
      {isActive && (
        <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-accent-blue flex items-center justify-center">
          <Check className="w-3 h-3 text-black" />
        </div>
      )}
    </button>
  );
}

/* ─── Live Preview ─── */
function LivePreview() {
  // Subscribe to store so this component re-renders on every setting change
  const themeName = useSettingsStore((s) => s.themeName);
  const fontName = useSettingsStore((s) => s.fontName);
  const customAccent = useSettingsStore((s) => s.customAccent);

  return (
    <div className="card p-5 space-y-4" key={`${themeName}-${fontName}-${customAccent}`}>
      <h3 className="font-heading text-lg text-white tracking-wide">Live Preview</h3>
      <div className="space-y-3">
        <h4 className="font-heading text-base text-accent-blue">Heading Font Sample</h4>
        <p className="font-body text-sm text-gray-300">
          This is body text rendered in the currently selected body font. It includes longer
          sentences to give a feel for readability and line spacing across multiple lines of content.
        </p>
        <pre className="font-mono text-xs text-accent-green bg-surface-200/60 p-3 rounded-sm border border-border/40 overflow-x-auto">
{`const pipeline = await FlowForge.execute({
  workflow: "data-enrichment",
  batchSize: 250,
  retries: 3,
});`}
        </pre>
        <div className="flex gap-2 flex-wrap">
          <button className="btn-primary">Primary</button>
          <button className="btn-danger">Danger</button>
          <button className="btn-ghost">Ghost</button>
        </div>
        <div className="flex gap-2 flex-wrap">
          <span className="badge bg-accent-blue/15 text-accent-blue border border-accent-blue/30">
            RUNNING
          </span>
          <span className="badge bg-accent-green/15 text-accent-green border border-accent-green/30">
            COMPLETED
          </span>
          <span className="badge bg-accent-red/15 text-accent-red border border-accent-red/30">
            FAILED
          </span>
          <span className="badge bg-accent-yellow/15 text-accent-yellow border border-accent-yellow/30">
            PENDING
          </span>
        </div>
      </div>
    </div>
  );
}

/* ─── Section Header ─── */
function SectionHeader({ icon: Icon, title }: { icon: React.ElementType; title: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <Icon className="w-4 h-4 text-accent-blue" />
      <h2 className="font-label text-xs uppercase tracking-widest text-gray-400">{title}</h2>
    </div>
  );
}

/* ─── Main Page ─── */
export default function SettingsPage() {
  const themeName = useSettingsStore((s) => s.themeName);
  const fontName = useSettingsStore((s) => s.fontName);
  const customAccent = useSettingsStore((s) => s.customAccent);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const setFont = useSettingsStore((s) => s.setFont);
  const setCustomAccent = useSettingsStore((s) => s.setCustomAccent);
  const resetToDefaults = useSettingsStore((s) => s.resetToDefaults);

  const activeTheme = THEME_PRESETS.find((t) => t.name === themeName) ?? THEME_PRESETS[0];
  const currentAccent = customAccent ?? activeTheme.colors.accent;

  return (
    <div className="p-6 space-y-8">
      <FontPreloader />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-2xl text-white tracking-wider">Settings</h1>
          <p className="text-sm text-gray-500 font-body mt-1">
            Customize theme, accent colors, and fonts
          </p>
        </div>
        <button onClick={resetToDefaults} className="btn-ghost flex items-center gap-2">
          <RotateCcw className="w-3.5 h-3.5" />
          Reset Defaults
        </button>
      </div>

      {/* Theme */}
      <section>
        <SectionHeader icon={Palette} title="Theme" />
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3">
          {THEME_PRESETS.map((preset) => (
            <ThemeCard
              key={preset.name}
              preset={preset}
              isActive={themeName === preset.name}
              onSelect={() => setTheme(preset.name)}
            />
          ))}
        </div>
      </section>

      {/* Accent Color Override */}
      <section>
        <SectionHeader icon={Sparkles} title="Accent Color" />
        <div className="flex flex-wrap items-center gap-3">
          {ACCENT_OPTIONS.map((opt) => (
            <button
              key={opt.name}
              onClick={() => setCustomAccent(opt.color)}
              className={`group relative w-8 h-8 rounded-full border-2 transition-all duration-150 cursor-pointer
                ${currentAccent === opt.color
                  ? 'scale-110'
                  : 'border-transparent hover:scale-105'
                }`}
              style={{
                background: opt.color,
                borderColor: currentAccent === opt.color ? '#fff' : undefined,
                boxShadow: currentAccent === opt.color ? `0 0 10px ${opt.color}80` : undefined,
              }}
              title={opt.label}
            >
              {currentAccent === opt.color && (
                <Check className="w-3.5 h-3.5 text-black absolute inset-0 m-auto" />
              )}
            </button>
          ))}
          <button
            onClick={() => setCustomAccent(null)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-sm border border-border/60 text-xs font-label uppercase tracking-wider text-gray-500 hover:text-gray-300 hover:border-border-light transition-colors cursor-pointer"
          >
            <RotateCcw className="w-3 h-3" />
            Theme Default
          </button>
        </div>
      </section>

      {/* Font Style */}
      <section>
        <SectionHeader icon={Type} title="Font Style" />
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {FONT_PRESETS.map((preset) => (
            <FontCard
              key={preset.name}
              preset={preset}
              isActive={fontName === preset.name}
              onSelect={() => setFont(preset.name)}
            />
          ))}
        </div>
      </section>

      {/* Live Preview */}
      <section>
        <SectionHeader icon={Eye} title="Preview" />
        <LivePreview />
      </section>
    </div>
  );
}
