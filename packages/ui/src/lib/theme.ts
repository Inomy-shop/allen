export type ColorMode = 'dark' | 'light' | 'system';

export const DEFAULT_COLOR_MODE: ColorMode = 'system';

export const COLOR_MODE_TOKENS = {
  dark: {
    surface: '#131418',
    surface100: '#1a1c21',
    surface200: '#1d2026',
    surface300: '#0c0d10',
    border: '#232429',
    borderStrong: '#37393f',
    textPrimary: '#e8eaed',
    textSecondary: '#b9bdc6',
    textMuted: '#8a8f98',
    textSubtle: '#5e646e',
    terminalChrome: '#8a8f98',
    accent: '#828be0',
    accentSoft: '#23264a',
    accentHover: '#939be8',
    flowEdgeDefault: '#5e646e',
    flowEdgeConditional: '#828be0',
    flowEdgeRetry: '#e8a93b',
    editorBackground: '#1a1c21',
    editorLineHighlight: '#1d2026',
    editorGutter: '#131418',
    mermaidLine: '#5e646e',
    mermaidNodeBorder: '#37393f',
    mermaidClusterBg: '#1d2026',
    mermaidMainBg: '#1a1c21',
    mermaidEdgeLabelBg: '#1a1c21',
  },
  light: {
    surface: '#fbfcfe',
    surface100: '#ffffff',
    surface200: '#eef2f7',
    surface300: '#f7fafd',
    border: '#f2f3f4',
    borderStrong: '#dbdde0',
    textPrimary: '#16181d',
    textSecondary: '#3c4654',
    textMuted: '#64748b',
    textSubtle: '#98a4b3',
    terminalChrome: '#64748b',
    accent: '#5e6ad2',
    accentSoft: '#edeffb',
    accentHover: '#4e59be',
    flowEdgeDefault: '#98a4b3',
    flowEdgeConditional: '#5e6ad2',
    flowEdgeRetry: '#d9930d',
    editorBackground: '#ffffff',
    editorLineHighlight: '#eef2f7',
    editorGutter: '#fbfcfe',
    mermaidLine: '#98a4b3',
    mermaidNodeBorder: '#dbdde0',
    mermaidClusterBg: '#eef2f7',
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
  if (value === 'system') return 'system';
  if (value === 'dark') return 'dark';
  return 'light';
}

export function resolveColorMode(mode: ColorMode): 'light' | 'dark' {
  if (mode === 'system') {
    if (typeof window === 'undefined') return 'light';
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return mode;
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
  document.documentElement.dataset.colorModePreference = mode;
  document.documentElement.style.colorScheme = resolvedMode;
}
