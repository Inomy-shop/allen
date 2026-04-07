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
  };
}

export const THEME_PRESETS: ThemePreset[] = [
  {
    name: 'cyberpunk',
    label: 'Cyberpunk',
    colors: {
      surface: '#0a0e1a',
      surface100: '#111730',
      surface200: '#181e38',
      border: '#1e2740',
      accent: '#00d4ff',
      accentGreen: '#00ff88',
      accentRed: '#ff3366',
      accentYellow: '#ffaa00',
      accentPurple: '#a855f7',
    },
  },
  {
    name: 'terminal',
    label: 'Terminal',
    colors: {
      surface: '#000000',
      surface100: '#0a0f0a',
      surface200: '#111a11',
      border: '#1a2e1a',
      accent: '#00ff41',
      accentGreen: '#00ff41',
      accentRed: '#ff3333',
      accentYellow: '#ffcc00',
      accentPurple: '#cc66ff',
    },
  },
  {
    name: 'midnight',
    label: 'Midnight',
    colors: {
      surface: '#0d0a1a',
      surface100: '#15112b',
      surface200: '#1d1838',
      border: '#2a2250',
      accent: '#a855f7',
      accentGreen: '#34d399',
      accentRed: '#f87171',
      accentYellow: '#fbbf24',
      accentPurple: '#c084fc',
    },
  },
  {
    name: 'arctic',
    label: 'Arctic',
    colors: {
      surface: '#0f1520',
      surface100: '#151d2e',
      surface200: '#1b2538',
      border: '#243048',
      accent: '#60a5fa',
      accentGreen: '#4ade80',
      accentRed: '#fb7185',
      accentYellow: '#facc15',
      accentPurple: '#a78bfa',
    },
  },
  {
    name: 'ember',
    label: 'Ember',
    colors: {
      surface: '#120a0a',
      surface100: '#1c1010',
      surface200: '#261616',
      border: '#3d2020',
      accent: '#f97316',
      accentGreen: '#84cc16',
      accentRed: '#ef4444',
      accentYellow: '#eab308',
      accentPurple: '#d946ef',
    },
  },
  {
    name: 'deep-ocean',
    label: 'Deep Ocean',
    colors: {
      surface: '#020c1b',
      surface100: '#0a192f',
      surface200: '#112240',
      border: '#1d3461',
      accent: '#64ffda',
      accentGreen: '#64ffda',
      accentRed: '#ff6b6b',
      accentYellow: '#ffd93d',
      accentPurple: '#bd93f9',
    },
  },
  {
    name: 'light-modern',
    label: 'Light Modern',
    colors: {
      surface: '#ffffff',
      surface100: '#f8fafc',
      surface200: '#f1f5f9',
      border: '#cbd5e1',
      accent: '#3b82f6',
      accentGreen: '#10b981',
      accentRed: '#ef4444',
      accentYellow: '#f59e0b',
      accentPurple: '#8b5cf6',
    },
  },
  {
    name: 'light-minimal',
    label: 'Light Minimal',
    colors: {
      surface: '#fefefe',
      surface100: '#f9fafb',
      surface200: '#f3f4f6',
      border: '#d1d5db',
      accent: '#6366f1',
      accentGreen: '#059669',
      accentRed: '#dc2626',
      accentYellow: '#d97706',
      accentPurple: '#7c3aed',
    },
  },
  {
    name: 'light-warm',
    label: 'Light Warm',
    colors: {
      surface: '#fffbf7',
      surface100: '#fef7f0',
      surface200: '#fed7aa',
      border: '#e5b887',
      accent: '#ea580c',
      accentGreen: '#16a34a',
      accentRed: '#dc2626',
      accentYellow: '#ca8a04',
      accentPurple: '#9333ea',
    },
  },
  {
    name: 'clean-light',
    label: 'Clean Light',
    colors: {
      surface: '#ffffff',
      surface100: '#f8fafc',
      surface200: '#f1f5f9',
      border: '#e2e8f0',
      accent: '#3b82f6',
      accentGreen: '#059669',
      accentRed: '#dc2626',
      accentYellow: '#d97706',
      accentPurple: '#7c3aed',
    },
  },
  {
    name: 'minimal-light',
    label: 'Minimal Light',
    colors: {
      surface: '#fefefe',
      surface100: '#f9fafb',
      surface200: '#f3f4f6',
      border: '#d1d5db',
      accent: '#1f2937',
      accentGreen: '#047857',
      accentRed: '#b91c1c',
      accentYellow: '#b45309',
      accentPurple: '#6b21a8',
    },
  },
  {
    name: 'warm-light',
    label: 'Warm Light',
    colors: {
      surface: '#fefdf9',
      surface100: '#fffbeb',
      surface200: '#fef3c7',
      border: '#f3e8b6',
      accent: '#d97706',
      accentGreen: '#15803d',
      accentRed: '#dc2626',
      accentYellow: '#ca8a04',
      accentPurple: '#9333ea',
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

export const ACCENT_OPTIONS: AccentOption[] = [
  { name: 'cyan', label: 'Cyan', color: '#00d4ff' },
  { name: 'blue', label: 'Blue', color: '#3b82f6' },
  { name: 'green', label: 'Green', color: '#22c55e' },
  { name: 'purple', label: 'Purple', color: '#a855f7' },
  { name: 'orange', label: 'Orange', color: '#f97316' },
  { name: 'red', label: 'Red', color: '#ef4444' },
  { name: 'pink', label: 'Pink', color: '#ec4899' },
  { name: 'yellow', label: 'Yellow', color: '#eab308' },
];

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

const STORAGE_KEY = 'flowforge-settings';

interface PersistedSettings {
  colorMode: ColorMode;
  themeName: string;
  fontName: string;
  customAccent: string | null;
  agentIcon: string;
}

function loadFromStorage(): PersistedSettings {
  // Choose default theme based on system preference
  const systemPreference = detectSystemThemePreference();
  const defaultTheme = systemPreference === 'light' ? 'light-modern' : 'cyberpunk';

  const defaults: PersistedSettings = {
    colorMode: DEFAULT_COLOR_MODE,
    themeName: defaultTheme,
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

  root.setProperty('--color-surface', hexToRgbChannels(modeTokens.surface ?? theme.colors.surface));
  root.setProperty('--color-surface-100', hexToRgbChannels(modeTokens.surface100 ?? theme.colors.surface100));
  root.setProperty('--color-surface-200', hexToRgbChannels(modeTokens.surface200 ?? theme.colors.surface200));
  root.setProperty('--color-border', hexToRgbChannels(modeTokens.border ?? theme.colors.border));
  const accentHex = customAccent ?? theme.colors.accent;
  root.setProperty('--color-accent', hexToRgbChannels(accentHex));
  root.setProperty('--accent-hex', accentHex);
  root.setProperty('--color-accent-green', hexToRgbChannels(theme.colors.accentGreen));
  root.setProperty('--color-accent-red', hexToRgbChannels(theme.colors.accentRed));
  root.setProperty('--accent-red-hex', theme.colors.accentRed);
  root.setProperty('--color-accent-yellow', hexToRgbChannels(theme.colors.accentYellow));
  root.setProperty('--color-accent-purple', hexToRgbChannels(theme.colors.accentPurple));
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
  let link = document.getElementById('flowforge-fonts') as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement('link');
    link.id = 'flowforge-fonts';
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
  themeName: 'cyberpunk',
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
    const { customAccent, colorMode } = get();
    applyThemeColors(theme, customAccent, colorMode);
    set({ themeName: name });
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
    const theme = getTheme('cyberpunk');
    const font = getFont('clean');
    applyThemeColors(theme, null, colorMode);
    applyFontPreset(font);
    set({ colorMode, themeName: 'cyberpunk', fontName: 'clean', customAccent: null, agentIcon: 'bot' });
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
