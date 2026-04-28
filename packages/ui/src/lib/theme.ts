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
    textPrimary: '#f4f4f5',
    textSecondary: '#c2c3c8',
    textMuted: '#8f8f95',
    textSubtle: '#5c5d63',
    terminalChrome: '#8f8f95',
    // Muted gray for all edges so unselected edges recede. On selection
    // the connected edges switch to the theme accent (Canvas / LiveGraph).
    flowEdgeDefault: '#5c5d63',
    flowEdgeConditional: '#5c5d63',
    flowEdgeRetry: '#5c5d63',
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
    textPrimary: '#18181a', // ink — high contrast on FBFBFA
    textSecondary: '#4a4a4f',
    textMuted: '#8a8a8f',
    textSubtle: '#b8b8bc',
    terminalChrome: '#8a8a8f',
    // Lighter gray for edges on a white surface so they recede by
    // default. Selection promotes connected edges to the accent.
    flowEdgeDefault: '#b8b8bc',
    flowEdgeConditional: '#b8b8bc',
    flowEdgeRetry: '#b8b8bc',
    editorBackground: '#ffffff',
    editorLineHighlight: '#f8f9fc',
    editorGutter: '#fbfbfa',
    mermaidLine: '#b8b8bc',
    mermaidNodeBorder: '#d8d6d2',
    mermaidClusterBg: '#f4f4f2',
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
