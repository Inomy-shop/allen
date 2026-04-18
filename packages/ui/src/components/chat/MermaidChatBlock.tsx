import { useEffect, useMemo, useRef, useState } from 'react';
import mermaid from 'mermaid';
import { Copy, Check, Code2, Image as ImageIcon, AlertCircle, Maximize2, Minimize2, X } from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore';
import { resolveColorMode, getCssVarHex } from '../../lib/theme';

function getMermaidTheme(colorMode: 'light' | 'dark') {
  if (colorMode === 'light') {
    return {
      theme: 'base',
      themeVariables: {
        primaryColor: getCssVarHex('--color-accent', '#3b82f6'),
        primaryTextColor: getCssVarHex('--color-text-primary', '#0f172a'),
        primaryBorderColor: getCssVarHex('--color-mermaid-node-border', '#94a3b8'),
        lineColor: getCssVarHex('--color-mermaid-line', '#64748b'),
        secondaryColor: getCssVarHex('--color-accent-green', '#10b981'),
        tertiaryColor: getCssVarHex('--color-surface', '#ffffff'),
        mainBkg: getCssVarHex('--color-mermaid-main-bg', '#ffffff'),
        nodeBorder: getCssVarHex('--color-mermaid-node-border', '#94a3b8'),
        clusterBkg: getCssVarHex('--color-mermaid-cluster-bg', '#e2e8f0'),
        titleColor: getCssVarHex('--color-text-primary', '#0f172a'),
        edgeLabelBackground: getCssVarHex('--color-mermaid-edge-label-bg', '#ffffff'),
      },
    };
  }
  return {
    theme: 'dark',
    themeVariables: {
      primaryColor: getCssVarHex('--color-accent', '#00d4ff'),
      primaryTextColor: getCssVarHex('--color-text-primary', '#e2e8f0'),
      primaryBorderColor: getCssVarHex('--color-mermaid-node-border', '#4b5563'),
      lineColor: getCssVarHex('--color-mermaid-line', '#4b5563'),
      secondaryColor: getCssVarHex('--color-accent-green', '#2ecc71'),
      tertiaryColor: getCssVarHex('--color-surface', '#141620'),
      mainBkg: getCssVarHex('--color-mermaid-main-bg', '#1a1d2b'),
      nodeBorder: getCssVarHex('--color-mermaid-node-border', '#4b5563'),
      clusterBkg: getCssVarHex('--color-mermaid-cluster-bg', '#222536'),
      titleColor: getCssVarHex('--color-text-primary', '#e2e8f0'),
      edgeLabelBackground: getCssVarHex('--color-mermaid-edge-label-bg', '#1a1d2b'),
    },
  };
}

let idCounter = 0;
const nextId = () => `chat-mermaid-${++idCounter}`;

interface Props {
  code: string;
}

export default function MermaidChatBlock({ code }: Props) {
  const colorMode = useSettingsStore((s) => s.colorMode);
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  const [view, setView] = useState<'diagram' | 'code'>('diagram');
  const [copied, setCopied] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const domId = useRef(nextId()).current;

  const trimmed = useMemo(() => code.trim(), [code]);

  useEffect(() => {
    if (!trimmed) { setSvg(''); setError(''); return; }
    let cancelled = false;
    const resolved = resolveColorMode(colorMode);
    (async () => {
      try {
        const themeConfig = getMermaidTheme(resolved);
        mermaid.initialize({
          startOnLoad: false,
          theme: themeConfig.theme as any,
          themeVariables: themeConfig.themeVariables,
          flowchart: { htmlLabels: true, curve: 'basis', padding: 12 },
        });
        const { svg } = await mermaid.render(domId, trimmed);
        if (!cancelled) { setSvg(svg); setError(''); }
      } catch (e: any) {
        if (!cancelled) { setError(e?.message ?? 'Failed to render diagram'); setSvg(''); }
      }
    })();
    return () => { cancelled = true; };
  }, [trimmed, colorMode, domId]);

  const handleCopy = () => {
    navigator.clipboard.writeText(trimmed);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Close fullscreen on Escape
  useEffect(() => {
    if (!fullscreen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [fullscreen]);

  const header = (
    <div className="flex items-center justify-between px-3 py-1.5 bg-surface-200/60 border-b border-border/30">
      <span className="text-[10px] font-mono text-theme-muted uppercase tracking-wider flex items-center gap-1.5">
        mermaid
        {error && <AlertCircle className="w-3 h-3 text-accent-red" />}
      </span>
      <div className="flex items-center gap-1">
        <button
          onClick={() => setView(view === 'diagram' ? 'code' : 'diagram')}
          className="flex items-center gap-1 px-2 py-0.5 rounded-sm text-[10px] font-mono transition-all hover:bg-white/10 text-theme-muted hover:text-theme-secondary"
          title={view === 'diagram' ? 'Show source' : 'Show diagram'}
        >
          {view === 'diagram' ? <Code2 className="w-3 h-3" /> : <ImageIcon className="w-3 h-3" />}
          {view === 'diagram' ? 'source' : 'diagram'}
        </button>
        {svg && !error && (
          <button
            onClick={() => setFullscreen(true)}
            className="flex items-center gap-1 px-2 py-0.5 rounded-sm text-[10px] font-mono transition-all hover:bg-white/10 text-theme-muted hover:text-theme-secondary"
            title="Fullscreen"
          >
            <Maximize2 className="w-3 h-3" />
          </button>
        )}
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 px-2 py-0.5 rounded-sm text-[10px] font-mono transition-all hover:bg-white/10 text-theme-muted hover:text-theme-secondary"
          title="Copy source"
        >
          {copied ? <Check className="w-3 h-3 text-accent-green" /> : <Copy className="w-3 h-3" />}
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
    </div>
  );

  const body = view === 'code' || error ? (
    <div>
      {error && (
        <div className="px-4 py-2 text-[12px] text-accent-red bg-accent-red/10 border-b border-border/30">
          {error}
        </div>
      )}
      <pre className="px-4 py-3 overflow-x-auto text-[13px] leading-relaxed font-mono">
        <code className="text-theme-secondary whitespace-pre">{trimmed}</code>
      </pre>
    </div>
  ) : svg ? (
    <div
      className="px-4 py-3 overflow-x-auto flex justify-center [&_svg]:max-w-full [&_svg]:h-auto"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  ) : (
    <div className="px-4 py-4 text-[12px] text-theme-muted">Rendering diagram…</div>
  );

  return (
    <>
      <div className="group/code relative my-3 rounded-md overflow-hidden border border-border/40 bg-[rgb(var(--color-editor-background))]">
        {header}
        {body}
      </div>

      {fullscreen && svg && (
        <div className="fixed inset-0 z-50 bg-surface-50 flex flex-col" onClick={() => setFullscreen(false)}>
          <div className="flex items-center justify-between px-6 py-3 border-b border-border/30 bg-surface-100/80 backdrop-blur-sm shrink-0" onClick={(e) => e.stopPropagation()}>
            <span className="text-sm font-heading font-semibold text-theme-primary tracking-wider uppercase">Mermaid Diagram</span>
            <div className="flex items-center gap-2">
              <button
                onClick={handleCopy}
                className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-mono hover:bg-surface-200/50 text-theme-muted hover:text-theme-secondary transition-colors"
                title="Copy source"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-accent-green" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'copied' : 'copy'}
              </button>
              <button
                onClick={() => setFullscreen(false)}
                className="p-1.5 rounded hover:bg-surface-200/50 text-theme-muted hover:text-theme-secondary transition-colors"
                title="Close (Esc)"
              >
                <Minimize2 className="w-4 h-4" />
              </button>
              <button
                onClick={() => setFullscreen(false)}
                className="p-1.5 rounded hover:bg-surface-200/50 text-theme-muted hover:text-theme-secondary transition-colors"
                title="Close (Esc)"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-auto p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-center [&_svg]:h-auto [&_svg]:max-w-none" dangerouslySetInnerHTML={{ __html: svg }} />
          </div>
        </div>
      )}
    </>
  );
}
