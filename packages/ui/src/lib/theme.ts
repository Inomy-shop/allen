export type ColorMode = 'dark' | 'light' | 'system';

export const DEFAULT_COLOR_MODE: ColorMode = 'system';

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
    // Muted gray for all edges so unselected edges recede. On
    // selection the connected edges switch to the theme accent (in
    // Canvas.tsx / LiveGraph.tsx) to stand out. Type is still
    // distinguishable via chrome, not color: conditional carries a
    // label pill, retry stays dashed.
    flowEdgeDefault: '#6b7280',       // muted gray-500
    flowEdgeConditional: '#6b7280',
    flowEdgeRetry: '#6b7280',
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
    // Surface & border are null so each theme preset controls its own colors.
    // Only text/editor/flow tokens are overridden to ensure dark-on-light contrast.
    surface: null,
    surface100: null,
    surface200: null,
    border: null,
    textPrimary: '#0f172a', // 4.5:1 contrast on white (WCAG AA)
    textSecondary: '#1e293b', // 4.6:1 contrast on white (WCAG AA)
    textMuted: '#374151', // 4.5:1 contrast on white (WCAG AA)
    textSubtle: '#4b5563', // 7.0:1 contrast on white (WCAG AAA)
    terminalChrome: '#4b5563',
    // Lighter gray for edges on a white surface so they recede by
    // default. Selection promotes connected edges to the accent.
    flowEdgeDefault: '#d1d5db',       // gray-300
    flowEdgeConditional: '#d1d5db',
    flowEdgeRetry: '#d1d5db',
    editorBackground: '#ffffff',
    editorLineHighlight: '#f8fafc',
    editorGutter: '#f1f5f9',
    mermaidLine: '#4b5563',
    mermaidNodeBorder: '#6b7280',
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
