export type ColorMode = 'dark' | 'light' | 'system';

export const DEFAULT_COLOR_MODE: ColorMode = 'system';

export const COLOR_MODE_TOKENS = {
  dark: {
    // Surface & border are null so each theme preset controls its own colors.
    // The Linear preset provides Linear-night near-black surfaces; legacy
    // presets keep their custom navy/black/etc.
    surface: null,
    surface100: null,
    surface200: null,
    border: null,
    textPrimary: '#dbdee2',
    textSecondary: '#a7abb1',
    textMuted: '#70757c',
    textSubtle: '#494e54',
    terminalChrome: '#70757c',
    // Muted gray for all edges so unselected edges recede. On selection
    // the connected edges switch to the theme accent (Canvas / LiveGraph).
    flowEdgeDefault: '#494e54',
    flowEdgeConditional: '#494e54',
    flowEdgeRetry: '#494e54',
    editorBackground: '#16171b',
    editorLineHighlight: '#1c1d22',
    editorGutter: '#0f1014',
    mermaidLine: '#5c5d63',
    mermaidNodeBorder: '#34353c',
    mermaidClusterBg: '#1c1d22',
    mermaidMainBg: '#16171b',
    mermaidEdgeLabelBg: '#16171b',
  },
  light: {
    // Surface & border are null so each theme preset controls its own colors.
    // Only text/editor/flow tokens are overridden to ensure dark-on-light contrast.
    surface: null,
    surface100: null,
    surface200: null,
    border: null,
    textPrimary: '#12171b',
    textSecondary: '#43484e',
    textMuted: '#767b80',
    textSubtle: '#a1a5a9',
    terminalChrome: '#767b80',
    // Lighter gray for edges on a white surface so they recede by
    // default. Selection promotes connected edges to the accent.
    flowEdgeDefault: '#a1a5a9',
    flowEdgeConditional: '#a1a5a9',
    flowEdgeRetry: '#a1a5a9',
    editorBackground: '#ffffff',
    editorLineHighlight: '#f8f9fc',
    editorGutter: '#fbfaf8',
    mermaidLine: '#a1a5a9',
    mermaidNodeBorder: '#e3e1de',
    mermaidClusterBg: '#f6f5f2',
    mermaidMainBg: '#ffffff',
    mermaidEdgeLabelBg: '#ffffff',
  },
} as const;

function normalizeHex(hex: string): string {
  const value = hex.trim().replace('#', '');
  if (value.length === 3) {
    return value.split('').map((char) => `${char}${char}`).join('');
  }
  return value.slice(0, 6);
}

export function normalizeColorMode(value?: string | null): ColorMode {
  if (value === 'light') return 'light';
  if (value === 'system') return 'system';
  return 'dark';
}

export function resolveColorMode(mode: ColorMode): 'light' | 'dark' {
  if (mode === 'system') {
    if (typeof window === 'undefined') return 'dark';
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return mode;
}

export function detectSystemThemePreference(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function hexToRgbChannels(hex: string): string {
  const normalized = normalizeHex(hex);
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  return `${r} ${g} ${b}`;
}

export function rgbChannelsToHex(channels: string): string {
  const [r = '0', g = '0', b = '0'] = channels.trim().split(/\s+/);
  const toHex = (value: string) => Number(value).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function getFallbackChannels(fallbackHex: string): string {
  return hexToRgbChannels(fallbackHex);
}

export function getCssVarChannels(variableName: string, fallbackHex: string): string {
  if (typeof window === 'undefined') {
    return getFallbackChannels(fallbackHex);
  }

  const value = window.getComputedStyle(document.documentElement).getPropertyValue(variableName).trim();
  return value || getFallbackChannels(fallbackHex);
}

export function getCssVarHex(variableName: string, fallbackHex: string): string {
  return rgbChannelsToHex(getCssVarChannels(variableName, fallbackHex));
}

export function applyColorModeClass(mode: ColorMode) {
  if (typeof document === 'undefined') return;
  const resolvedMode = resolveColorMode(mode);
  document.documentElement.classList.toggle('dark', resolvedMode === 'dark');
  document.documentElement.dataset.colorMode = resolvedMode;
  document.documentElement.style.colorScheme = resolvedMode;
}
