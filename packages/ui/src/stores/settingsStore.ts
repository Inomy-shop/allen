import { create } from 'zustand';
import {
  applyColorModeClass,
  COLOR_MODE_TOKENS,
  DEFAULT_COLOR_MODE,
  hexToRgbChannels,
  normalizeColorMode,
  resolveColorMode,
  detectSystemThemePreference,
  type ColorMode,
} from '../lib/theme';

/* ─── Theme Presets ─── */

export interface ThemePreset {
  name: string;
  label: string;
  /** When set, selecting this theme auto-switches the color mode. */
  preferredColorMode?: 'dark' | 'light' | 'system';
  colors: {
    surface: string;
    surface100: string;
    surface200: string;
    border: string;
    accent: string;
    accentGreen: string;
    accentRed: string;
    accentYellow: string;
    accentPurple: string;
    accentOrange?: string;
  };
  /**
   * Optional dark-mode override for surface/border/accent. Used by themes
   * that ship a calibrated dark variant (e.g. Linear-night) rather than
   * just inverting their light palette. When omitted, the light `colors`
   * are used in both modes (preserved v1 behavior).
   */
  colorsDark?: {
    surface?: string;
    surface100?: string;
    surface200?: string;
    border?: string;
    accent?: string;
    accentGreen?: string;
    accentRed?: string;
    accentYellow?: string;
    accentPurple?: string;
    accentOrange?: string;
  };
}

export const THEME_PRESETS: ThemePreset[] = [
  {
    name: 'linear',
    label: 'Linear',
    preferredColorMode: 'system',
    colors: {
      // Light prototype tokens.
      surface: '#fbfaf8',
      surface100: '#ffffff',
      surface200: '#f6f5f2',
      border: '#e3e1de',
      accent: '#2a76e2',
      accentGreen: '#269e5f',
      accentRed: '#de3b3d',
      accentYellow: '#de9300',
      accentPurple: '#9763cc',
      accentOrange: '#de9300',
    },
    colorsDark: {
      // Dark prototype tokens.
      surface: '#06080c',
      surface100: '#0d1116',
      surface200: '#0b0f13',
      border: '#1f2329',
      accent: '#5ca4ff',
      accentGreen: '#43c07a',
      accentRed: '#fa6863',
      accentYellow: '#f2a618',
      accentPurple: '#bc88f4',
      accentOrange: '#f2a618',
    },
  },
];

/* ─── Font Presets ─── */

export interface FontPreset {
  name: string;
  label: string;
  heading: string;
  body: string;
  mono: string;
  labelFont: string;
  googleFontsUrl: string;
}

export const FONT_PRESETS: FontPreset[] = [
  {
    name: 'cyberdeck',
    label: 'Cyberdeck',
    heading: 'Audiowide',
    body: 'Chakra Petch',
    mono: 'Space Mono',
    labelFont: 'Michroma',
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Audiowide&family=Chakra+Petch:wght@300;400;500;600;700&family=Space+Mono:wght@400;700&family=Michroma&display=swap',
  },
  {
    name: 'neo-tokyo',
    label: 'Neo Tokyo',
    heading: 'Orbitron',
    body: 'Rajdhani',
    mono: 'Share Tech Mono',
    labelFont: 'Exo 2',
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Orbitron:wght@400;500;600;700&family=Rajdhani:wght@300;400;500;600;700&family=Share+Tech+Mono&family=Exo+2:wght@400;500;600;700&display=swap',
  },
  {
    name: 'mainframe',
    label: 'Mainframe',
    heading: 'IBM Plex Mono',
    body: 'IBM Plex Sans',
    mono: 'IBM Plex Mono',
    labelFont: 'IBM Plex Sans',
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=IBM+Plex+Sans:wght@300;400;500;600;700&display=swap',
  },
  {
    name: 'synth',
    label: 'Synth Wave',
    heading: 'Monoton',
    body: 'Quicksand',
    mono: 'Fira Code',
    labelFont: 'Quicksand',
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Monoton&family=Quicksand:wght@300;400;500;600;700&family=Fira+Code:wght@400;500;600;700&display=swap',
  },
  {
    name: 'military',
    label: 'Military',
    heading: 'Black Ops One',
    body: 'Saira',
    mono: 'Source Code Pro',
    labelFont: 'Saira Condensed',
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Black+Ops+One&family=Saira:wght@300;400;500;600;700&family=Source+Code+Pro:wght@400;500;600;700&family=Saira+Condensed:wght@400;500;600;700&display=swap',
  },
  {
    name: 'clean',
    label: 'Clean',
    heading: 'Inter',
    body: 'Inter',
    mono: 'JetBrains Mono',
    labelFont: 'Inter',
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap',
  },
  // ── Non-robotic / Classic / Elegant fonts ──
  {
    name: 'editorial',
    label: 'Editorial',
    heading: 'Playfair Display',
    body: 'Lora',
    mono: 'Inconsolata',
    labelFont: 'Lora',
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;500;600;700&family=Lora:wght@400;500;600;700&family=Inconsolata:wght@400;500;600;700&display=swap',
  },
  {
    name: 'minimal',
    label: 'Minimal',
    heading: 'DM Sans',
    body: 'DM Sans',
    mono: 'DM Mono',
    labelFont: 'DM Sans',
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=DM+Mono:wght@400;500&display=swap',
  },
  {
    name: 'geometric',
    label: 'Geometric',
    heading: 'Poppins',
    body: 'Nunito',
    mono: 'Roboto Mono',
    labelFont: 'Poppins',
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&family=Nunito:wght@300;400;500;600;700&family=Roboto+Mono:wght@400;500;600;700&display=swap',
  },
  {
    name: 'handcraft',
    label: 'Handcraft',
    heading: 'Caveat',
    body: 'Comic Neue',
    mono: 'Victor Mono',
    labelFont: 'Comic Neue',
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Caveat:wght@400;500;600;700&family=Comic+Neue:wght@300;400;700&family=Victor+Mono:wght@400;500;600;700&display=swap',
  },
  {
    name: 'swiss',
    label: 'Swiss',
    heading: 'Space Grotesk',
    body: 'Outfit',
    mono: 'Fira Code',
    labelFont: 'Space Grotesk',
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=Outfit:wght@300;400;500;600;700&family=Fira+Code:wght@400;500;600;700&display=swap',
  },
  {
    name: 'newsroom',
    label: 'Newsroom',
    heading: 'Merriweather',
    body: 'Source Sans 3',
    mono: 'Source Code Pro',
    labelFont: 'Source Sans 3',
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Merriweather:wght@400;700;900&family=Source+Sans+3:wght@300;400;500;600;700&family=Source+Code+Pro:wght@400;500;600;700&display=swap',
  },
  {
    name: 'default',
    label: 'System Default',
    heading: 'system-ui',
    body: 'system-ui',
    mono: 'ui-monospace',
    labelFont: 'system-ui',
    googleFontsUrl: '',
  },
  {
    name: 'roboto',
    label: 'Roboto',
    heading: 'Roboto',
    body: 'Roboto',
    mono: 'Roboto Mono',
    labelFont: 'Roboto',
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&family=Roboto+Mono:wght@400;500;700&display=swap',
  },
  {
    name: 'open-sans',
    label: 'Open Sans',
    heading: 'Montserrat',
    body: 'Open Sans',
    mono: 'Fira Code',
    labelFont: 'Montserrat',
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&family=Open+Sans:wght@300;400;500;600;700&family=Fira+Code:wght@400;500;600;700&display=swap',
  },
  {
    name: 'lato',
    label: 'Lato',
    heading: 'Raleway',
    body: 'Lato',
    mono: 'Inconsolata',
    labelFont: 'Raleway',
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Raleway:wght@400;500;600;700&family=Lato:wght@300;400;700&family=Inconsolata:wght@400;500;600;700&display=swap',
  },
  {
    name: 'ubuntu',
    label: 'Ubuntu',
    heading: 'Ubuntu',
    body: 'Ubuntu',
    mono: 'Ubuntu Mono',
    labelFont: 'Ubuntu',
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Ubuntu:wght@300;400;500;700&family=Ubuntu+Mono:wght@400;700&display=swap',
  },
  {
    name: 'noto',
    label: 'Noto',
    heading: 'Noto Sans',
    body: 'Noto Sans',
    mono: 'Noto Sans Mono',
    labelFont: 'Noto Sans',
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Noto+Sans:wght@300;400;500;600;700&family=Noto+Sans+Mono:wght@400;500;600;700&display=swap',
  },
  {
    name: 'work-sans',
    label: 'Work Sans',
    heading: 'Josefin Sans',
    body: 'Work Sans',
    mono: 'JetBrains Mono',
    labelFont: 'Josefin Sans',
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Josefin+Sans:wght@300;400;500;600;700&family=Work+Sans:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap',
  },
];

/* ─── Accent Color Overrides ─── */

export interface AccentOption {
  name: string;
  label: string;
  color: string;
}

export const ACCENT_OPTIONS_DARK: AccentOption[] = [
  { name: 'cyan', label: 'Cyan', color: '#00d4ff' },
  { name: 'blue', label: 'Blue', color: '#3b82f6' },
  { name: 'green', label: 'Green', color: '#22c55e' },
  { name: 'purple', label: 'Purple', color: '#a855f7' },
  { name: 'orange', label: 'Orange', color: '#f97316' },
  { name: 'red', label: 'Red', color: '#ef4444' },
  { name: 'pink', label: 'Pink', color: '#ec4899' },
  { name: 'yellow', label: 'Yellow', color: '#eab308' },
];

export const ACCENT_OPTIONS_LIGHT: AccentOption[] = [
  { name: 'blue', label: 'Blue', color: '#2563eb' },
  { name: 'indigo', label: 'Indigo', color: '#4f46e5' },
  { name: 'green', label: 'Green', color: '#16a34a' },
  { name: 'purple', label: 'Purple', color: '#7c3aed' },
  { name: 'orange', label: 'Orange', color: '#c2410c' },
  { name: 'red', label: 'Red', color: '#dc2626' },
  { name: 'pink', label: 'Pink', color: '#db2777' },
  { name: 'teal', label: 'Teal', color: '#0d9488' },
  { name: 'terracotta', label: 'Terracotta', color: '#c15f3c' },
];

/** Get the accent options appropriate for the current resolved color mode. */
export function getAccentOptions(colorMode: ColorMode): AccentOption[] {
  const resolved = resolveColorMode(colorMode);
  return resolved === 'light' ? ACCENT_OPTIONS_LIGHT : ACCENT_OPTIONS_DARK;
}

/** @deprecated Use getAccentOptions(colorMode) instead. */
export const ACCENT_OPTIONS = ACCENT_OPTIONS_DARK;

/* ─── Agent Icon Presets ─── */

export interface AgentIconPreset {
  name: string;
  label: string;
  icon: string;  // lucide icon name
}

export const AGENT_ICON_PRESETS: AgentIconPreset[] = [
  { name: 'bot', label: 'Bot', icon: 'Bot' },
  { name: 'brain', label: 'Brain', icon: 'Brain' },
  { name: 'sparkles', label: 'Sparkles', icon: 'Sparkles' },
  { name: 'zap', label: 'Zap', icon: 'Zap' },
  { name: 'cpu', label: 'CPU', icon: 'Cpu' },
  { name: 'atom', label: 'Atom', icon: 'Atom' },
  { name: 'terminal', label: 'Terminal', icon: 'Terminal' },
  { name: 'code', label: 'Code', icon: 'Code' },
  { name: 'rocket', label: 'Rocket', icon: 'Rocket' },
  { name: 'shield', label: 'Shield', icon: 'Shield' },
  { name: 'hexagon', label: 'Hexagon', icon: 'Hexagon' },
  { name: 'flame', label: 'Flame', icon: 'Flame' },
];

/* ─── Store ─── */

const STORAGE_KEY = 'allen-settings';

interface PersistedSettings {
  colorMode: ColorMode;
  themeName: string;
  fontName: string;
  customAccent: string | null;
  agentIcon: string;
}

function loadFromStorage(): PersistedSettings {
  // Default theme is Linear (Linear-clean light + Linear-night dark).
  // The preset itself adapts to the resolved color mode.
  const defaults: PersistedSettings = {
    colorMode: DEFAULT_COLOR_MODE,
    themeName: 'linear',
    fontName: 'clean',
    customAccent: null,
    agentIcon: 'sparkles',
  };

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
      return {
        ...defaults,
        ...parsed,
        colorMode: normalizeColorMode(parsed.colorMode),
      };
    }
  } catch {
    // corrupted data — ignore
  }
  return defaults;
}

function saveToStorage(s: PersistedSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

function applyThemeColors(theme: ThemePreset, customAccent: string | null, colorMode: ColorMode) {
  const root = document.documentElement.style;
  const resolvedMode = resolveColorMode(colorMode);
  const modeTokens = COLOR_MODE_TOKENS[resolvedMode];

  // Themes can ship a calibrated dark variant via `colorsDark`. When the
  // resolved mode is dark we prefer that, falling back to the (light)
  // `colors` for backwards-compat with presets that don't define one.
  const dark = resolvedMode === 'dark' ? (theme.colorsDark ?? {}) : {};
  const surface = dark.surface ?? theme.colors.surface;
  const surface100 = dark.surface100 ?? theme.colors.surface100;
  const surface200 = dark.surface200 ?? theme.colors.surface200;
  const border = dark.border ?? theme.colors.border;
  const accentBase = dark.accent ?? theme.colors.accent;
  const accentGreen = dark.accentGreen ?? theme.colors.accentGreen;
  const accentRed = dark.accentRed ?? theme.colors.accentRed;
  const accentYellow = dark.accentYellow ?? theme.colors.accentYellow;
  const accentPurple = dark.accentPurple ?? theme.colors.accentPurple;
  const accentOrange = dark.accentOrange ?? theme.colors.accentOrange ?? '#f97316';

  root.setProperty('--color-surface', hexToRgbChannels(modeTokens.surface ?? surface));
  root.setProperty('--color-surface-100', hexToRgbChannels(modeTokens.surface100 ?? surface100));
  root.setProperty('--color-surface-200', hexToRgbChannels(modeTokens.surface200 ?? surface200));
  root.setProperty('--color-border', hexToRgbChannels(modeTokens.border ?? border));
  const accentHex = customAccent ?? accentBase;
  root.setProperty('--color-accent', hexToRgbChannels(accentHex));
  root.setProperty('--accent-hex', accentHex);
  root.setProperty('--color-accent-green', hexToRgbChannels(accentGreen));
  root.setProperty('--color-accent-red', hexToRgbChannels(accentRed));
  root.setProperty('--accent-red-hex', accentRed);
  root.setProperty('--color-accent-yellow', hexToRgbChannels(accentYellow));
  root.setProperty('--color-accent-purple', hexToRgbChannels(accentPurple));
  root.setProperty('--color-accent-orange', hexToRgbChannels(accentOrange));
  root.setProperty('--color-text-primary', hexToRgbChannels(modeTokens.textPrimary));
  root.setProperty('--color-text-secondary', hexToRgbChannels(modeTokens.textSecondary));
  root.setProperty('--color-text-muted', hexToRgbChannels(modeTokens.textMuted));
  root.setProperty('--color-text-subtle', hexToRgbChannels(modeTokens.textSubtle));
  root.setProperty('--color-terminal-chrome', hexToRgbChannels(modeTokens.terminalChrome));
  root.setProperty('--color-flow-edge-default', hexToRgbChannels(modeTokens.flowEdgeDefault));
  root.setProperty('--color-flow-edge-conditional', hexToRgbChannels(modeTokens.flowEdgeConditional));
  root.setProperty('--color-flow-edge-retry', hexToRgbChannels(modeTokens.flowEdgeRetry));
  root.setProperty('--color-editor-background', hexToRgbChannels(modeTokens.editorBackground));
  root.setProperty('--color-editor-line-highlight', hexToRgbChannels(modeTokens.editorLineHighlight));
  root.setProperty('--color-editor-gutter', hexToRgbChannels(modeTokens.editorGutter));
  root.setProperty('--color-mermaid-line', hexToRgbChannels(modeTokens.mermaidLine));
  root.setProperty('--color-mermaid-node-border', hexToRgbChannels(modeTokens.mermaidNodeBorder));
  root.setProperty('--color-mermaid-cluster-bg', hexToRgbChannels(modeTokens.mermaidClusterBg));
  root.setProperty('--color-mermaid-main-bg', hexToRgbChannels(modeTokens.mermaidMainBg));
  root.setProperty('--color-mermaid-edge-label-bg', hexToRgbChannels(modeTokens.mermaidEdgeLabelBg));
  applyColorModeClass(colorMode);

  // Force repaint so all CSS-variable-dependent styles update immediately
  document.body.style.opacity = '0.99';
  requestAnimationFrame(() => {
    document.body.style.opacity = '1';
  });
}

function applyFontPreset(preset: FontPreset) {
  let link = document.getElementById('allen-fonts') as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement('link');
    link.id = 'allen-fonts';
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  }
  link.href = preset.googleFontsUrl;

  const root = document.documentElement.style;
  root.setProperty('--font-heading', `'${preset.heading}', sans-serif`);
  root.setProperty('--font-body', `'${preset.body}', sans-serif`);
  root.setProperty('--font-mono', `'${preset.mono}', monospace`);
  root.setProperty('--font-label', `'${preset.labelFont}', sans-serif`);

  // Force browser to re-evaluate font rendering after stylesheet loads
  if (document.fonts?.ready) {
    document.fonts.ready.then(() => {
      document.body.style.opacity = '0.99';
      requestAnimationFrame(() => {
        document.body.style.opacity = '1';
      });
    });
  }
}

function getTheme(name: string): ThemePreset {
  return THEME_PRESETS.find((t) => t.name === name) ?? THEME_PRESETS[0];
}

function getFont(name: string): FontPreset {
  return FONT_PRESETS.find((f) => f.name === name) ?? FONT_PRESETS[0];
}

interface SettingsState {
  colorMode: ColorMode;
  themeName: string;
  fontName: string;
  customAccent: string | null;
  agentIcon: string;

  setColorMode: (mode: ColorMode) => void;
  setTheme: (name: string) => void;
  setFont: (name: string) => void;
  setCustomAccent: (color: string | null) => void;
  setAgentIcon: (icon: string) => void;
  resetToDefaults: () => void;
  initFromLocalStorage: () => void;
  addSystemThemeListener: () => (() => void) | void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  colorMode: DEFAULT_COLOR_MODE,
  themeName: 'linear',
  fontName: 'clean',
  customAccent: null,
  agentIcon: 'sparkles',

  setColorMode: (mode: ColorMode) => {
    const colorMode = normalizeColorMode(mode);
    const theme = getTheme(get().themeName);
    applyThemeColors(theme, get().customAccent, colorMode);
    set({ colorMode });
    saveToStorage({
      colorMode,
      themeName: get().themeName,
      fontName: get().fontName,
      customAccent: get().customAccent,
      agentIcon: get().agentIcon,
    });
  },

  setTheme: (name: string) => {
    const theme = getTheme(name);
    // Auto-switch color mode to match the theme's preferred mode (dark/light)
    const colorMode = theme.preferredColorMode ?? get().colorMode;
    // Reset custom accent so the theme's built-in accent takes effect.
    // Prevents a bright-on-dark accent from persisting onto a light theme.
    const customAccent = null;
    applyThemeColors(theme, customAccent, colorMode);
    set({ themeName: name, colorMode, customAccent });
    saveToStorage({ colorMode, themeName: name, fontName: get().fontName, customAccent, agentIcon: get().agentIcon });
  },

  setFont: (name: string) => {
    const font = getFont(name);
    applyFontPreset(font);
    set({ fontName: name });
    saveToStorage({ colorMode: get().colorMode, themeName: get().themeName, fontName: name, customAccent: get().customAccent, agentIcon: get().agentIcon });
  },

  setCustomAccent: (color: string | null) => {
    const { colorMode, themeName } = get();
    const theme = getTheme(themeName);
    applyThemeColors(theme, color, colorMode);
    set({ customAccent: color });
    saveToStorage({ colorMode, themeName, fontName: get().fontName, customAccent: color, agentIcon: get().agentIcon });
  },

  setAgentIcon: (icon: string) => {
    set({ agentIcon: icon });
    saveToStorage({ colorMode: get().colorMode, themeName: get().themeName, fontName: get().fontName, customAccent: get().customAccent, agentIcon: icon });
  },

  resetToDefaults: () => {
    localStorage.removeItem(STORAGE_KEY);
    const colorMode = DEFAULT_COLOR_MODE;
    const theme = getTheme('linear');
    const font = getFont('clean');
    applyThemeColors(theme, null, colorMode);
    applyFontPreset(font);
    set({ colorMode, themeName: 'linear', fontName: 'clean', customAccent: null, agentIcon: 'sparkles' });
  },

  initFromLocalStorage: () => {
    const saved = loadFromStorage();
    const theme = getTheme(saved.themeName);
    const font = getFont(saved.fontName);
    applyThemeColors(theme, saved.customAccent, saved.colorMode);
    applyFontPreset(font);
    set(saved);
  },

  addSystemThemeListener: () => {
    if (typeof window === 'undefined') return;

    const handleSystemThemeChange = (e: MediaQueryListEvent) => {
      const { colorMode, themeName, customAccent } = get();
      if (colorMode === 'system') {
        const theme = getTheme(themeName);
        applyThemeColors(theme, customAccent, 'system');
      }
    };

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    mediaQuery.addEventListener('change', handleSystemThemeChange);

    return () => {
      mediaQuery.removeEventListener('change', handleSystemThemeChange);
    };
  },
}));
