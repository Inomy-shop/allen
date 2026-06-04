export type ColorMode = 'dark' | 'light' | 'system';

export const DEFAULT_COLOR_MODE: ColorMode = 'system';

export const COLOR_MODE_TOKENS = {
  dark: {
    surface: '#0f0d0c',
    surface100: '#171413',
    surface200: '#201b19',
    surface300: '#28221f',
    border: '#342c28',
    borderStrong: '#4a4039',
    textPrimary: '#f0e8df',
    textSecondary: '#c8bdb1',
    textMuted: '#94887d',
    textSubtle: '#685e55',
    terminalChrome: '#94887d',
    accent: '#7d9cba',
    accentSoft: '#161f27',
    accentHover: '#91afcb',
    flowEdgeDefault: '#685e55',
    flowEdgeConditional: '#7d9cba',
    flowEdgeRetry: '#c86f32',
    editorBackground: '#171413',
    editorLineHighlight: '#201b19',
    editorGutter: '#0f0d0c',
    mermaidLine: '#685e55',
    mermaidNodeBorder: '#4a4039',
    mermaidClusterBg: '#201b19',
    mermaidMainBg: '#171413',
    mermaidEdgeLabelBg: '#171413',
  },
  light: {
    surface: '#fcfdff',
    surface100: '#ffffff',
    surface200: '#f4f6fb',
    surface300: '#f8fafe',
    border: '#e2e5ed',
    borderStrong: '#cdd3e0',
    textPrimary: '#0b1730',
    textSecondary: '#354158',
    textMuted: '#6e778a',
    textSubtle: '#9ca5b8',
    terminalChrome: '#6e778a',
    accent: '#4763cf',
    accentSoft: '#dfe2f7',
    accentHover: '#5c74d4',
    flowEdgeDefault: '#9ca5b8',
    flowEdgeConditional: '#4763cf',
    flowEdgeRetry: '#de9300',
    editorBackground: '#ffffff',
    editorLineHighlight: '#f8fafe',
    editorGutter: '#fcfdff',
    mermaidLine: '#9ca5b8',
    mermaidNodeBorder: '#e2e5ed',
    mermaidClusterBg: '#f4f6fb',
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
