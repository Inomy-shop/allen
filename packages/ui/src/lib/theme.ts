export type ColorMode = 'dark' | 'light';

export const DEFAULT_COLOR_MODE: ColorMode = 'dark';

export const COLOR_MODE_TOKENS = {
  dark: {
    surface: null,
    surface100: null,
    surface200: null,
    border: null,
    textPrimary: '#f8fafc',
    textSecondary: '#cbd5e1',
    textMuted: '#94a3b8',
    textSubtle: '#64748b',
    terminalChrome: '#6b7280',
    flowEdgeDefault: '#4b5563',
    flowEdgeConditional: '#a855f7',
    flowEdgeRetry: '#eab308',
    editorBackground: '#141620',
    editorLineHighlight: '#1a1d2b',
    editorGutter: '#0f1117',
    mermaidLine: '#4b5563',
    mermaidNodeBorder: '#4b5563',
    mermaidClusterBg: '#222536',
    mermaidMainBg: '#1a1d2b',
    mermaidEdgeLabelBg: '#1a1d2b',
  },
  light: {
    surface: '#f8fafc',
    surface100: '#ffffff',
    surface200: '#eef2ff',
    border: '#cbd5e1',
    textPrimary: '#0f172a',
    textSecondary: '#334155',
    textMuted: '#475569',
    textSubtle: '#64748b',
    terminalChrome: '#64748b',
    flowEdgeDefault: '#64748b',
    flowEdgeConditional: '#7c3aed',
    flowEdgeRetry: '#ca8a04',
    editorBackground: '#ffffff',
    editorLineHighlight: '#f8fafc',
    editorGutter: '#f1f5f9',
    mermaidLine: '#64748b',
    mermaidNodeBorder: '#94a3b8',
    mermaidClusterBg: '#e2e8f0',
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
  return value === 'light' ? 'light' : 'dark';
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
  document.documentElement.classList.toggle('dark', mode === 'dark');
  document.documentElement.dataset.colorMode = mode;
  document.documentElement.style.colorScheme = mode;
}
