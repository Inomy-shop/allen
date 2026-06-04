import { useMemo, useEffect, useRef, useState, useCallback } from 'react';
import { Maximize2, Minimize2, X, Download, Copy, Check, ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';
import { generateMermaid } from '../../lib/mermaid-generator';
import { useSettingsStore } from '../../stores/settingsStore';
import { resolveColorMode } from '../../lib/theme';
import { getCssVarHex } from '../../lib/theme';
import { initializeMermaid, mermaid } from '../../lib/mermaid';

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

interface Props {
  workflow: any;
}

export default function MermaidPreview({ workflow }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svgHtml, setSvgHtml] = useState('');
  const [error, setError] = useState('');
  const [fullscreen, setFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);
  const colorMode = useSettingsStore((s) => s.colorMode);

  const mermaidCode = useMemo(() => {
    if (!workflow) return '';
    return generateMermaid(workflow);
  }, [workflow]);

  // Render mermaid — produces the inline SVG
  useEffect(() => {
    if (!mermaidCode) { setSvgHtml(''); setError(''); return; }
    let cancelled = false;
    const resolvedMode = resolveColorMode(colorMode);
    (async () => {
      try {
        const themeConfig = getMermaidTheme(resolvedMode);
        initializeMermaid({ startOnLoad: false, theme: themeConfig.theme as any, themeVariables: themeConfig.themeVariables, flowchart: { htmlLabels: true, curve: 'basis', padding: 12 } });
        const id = `mermaid-${Date.now()}`;
        const { svg } = await mermaid.render(id, mermaidCode);
        if (!cancelled) { setSvgHtml(svg); setError(''); }
      } catch (e: any) {
        if (!cancelled) { setError(e.message ?? 'Failed to render diagram'); setSvgHtml(''); }
      }
    })();
    return () => { cancelled = true; };
  }, [mermaidCode, colorMode]);

  // Re-render at larger scale when entering fullscreen
  const [fullscreenSvg, setFullscreenSvg] = useState('');
  useEffect(() => {
    if (!fullscreen || !mermaidCode) { setFullscreenSvg(''); return; }
    let cancelled = false;
    const resolvedMode = resolveColorMode(colorMode);
    (async () => {
      try {
        const themeConfig = getMermaidTheme(resolvedMode);
        initializeMermaid({
          startOnLoad: false,
          theme: themeConfig.theme as any,
          themeVariables: { ...themeConfig.themeVariables, fontSize: '18px' },
          flowchart: { htmlLabels: true, curve: 'basis', padding: 30, nodeSpacing: 80, rankSpacing: 80, useMaxWidth: false },
        });
        const id = `mermaid-fs-${Date.now()}`;
        const { svg } = await mermaid.render(id, mermaidCode);
        if (!cancelled) {
          // Strip all size constraints and apply a CSS transform to scale up
          const unclampedSvg = svg
            .replace(/max-width:\s*[\d.]+px/g, '')
            .replace(/style="[^"]*"/, (match) => {
              const cleaned = match.replace(/max-width:\s*[\d.]+px;?/g, '').replace(/height:\s*[\d.]+px;?/g, '');
              return cleaned;
            });
          setFullscreenSvg(unclampedSvg);
        }
      } catch {
        if (!cancelled) setFullscreenSvg(svgHtml); // fallback to inline svg
      }
    })();
    return () => { cancelled = true; };
  }, [fullscreen, mermaidCode, colorMode]);

  // Close fullscreen on Escape
  useEffect(() => {
    if (!fullscreen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [fullscreen]);

  // ── Zoom ──
  const [zoom, setZoom] = useState(1);
  const zoomContainerRef = useRef<HTMLDivElement>(null);
  const ZOOM_MIN = 0.25;
  const ZOOM_MAX = 4;
  const ZOOM_STEP = 0.15;

  const zoomIn = useCallback(() => setZoom(z => Math.min(z + ZOOM_STEP, ZOOM_MAX)), []);
  const zoomOut = useCallback(() => setZoom(z => Math.max(z - ZOOM_STEP, ZOOM_MIN)), []);
  const zoomReset = useCallback(() => setZoom(1), []);

  // Mouse wheel zoom (Ctrl/Cmd + scroll)
  useEffect(() => {
    const el = zoomContainerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
        setZoom(z => Math.min(Math.max(z + delta, ZOOM_MIN), ZOOM_MAX));
      }
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [fullscreen]);

  // Reset zoom when toggling fullscreen
  useEffect(() => { setZoom(1); }, [fullscreen]);

  const handleCopyCode = () => {
    navigator.clipboard.writeText(mermaidCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadSvg = () => {
    if (!svgHtml) return;
    const blob = new Blob([svgHtml], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${workflow?.name ?? 'workflow'}-diagram.svg`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!mermaidCode) {
    return (
      <div className="flex items-center justify-center h-full text-theme-muted text-sm">
        Write a valid workflow to see the diagram
      </div>
    );
  }

  const diagramContent = error ? (
    <div className="text-xs text-accent-red bg-accent-red/10 rounded-lg p-4">{error}</div>
  ) : svgHtml ? (
    <div
      ref={containerRef}
      className="[&_svg]:max-w-full [&_svg]:h-auto"
      dangerouslySetInnerHTML={{ __html: svgHtml }}
    />
  ) : (
    <div className="text-xs text-theme-muted">Rendering...</div>
  );

  // Toolbar buttons
  const zoomControls = (
    <div className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-app-muted border border-app">
      <button onClick={zoomOut} className="p-1 rounded hover:bg-app-muted text-theme-muted hover:text-theme-secondary transition-colors" title="Zoom out (Ctrl+Scroll)">
        <ZoomOut className="w-3.5 h-3.5" />
      </button>
      <button onClick={zoomReset} className="px-1.5 py-0.5 rounded hover:bg-app-muted text-[10px] font-mono text-theme-muted hover:text-theme-secondary transition-colors min-w-[40px] text-center" title="Reset zoom">
        {Math.round(zoom * 100)}%
      </button>
      <button onClick={zoomIn} className="p-1 rounded hover:bg-app-muted text-theme-muted hover:text-theme-secondary transition-colors" title="Zoom in (Ctrl+Scroll)">
        <ZoomIn className="w-3.5 h-3.5" />
      </button>
    </div>
  );

  const actionButtons = (
    <div className="flex items-center gap-1">
      <button onClick={handleCopyCode} className="p-1.5 rounded hover:bg-app-muted text-theme-muted hover:text-theme-secondary transition-colors" title="Copy Mermaid code">
        {copied ? <Check className="w-3.5 h-3.5 text-accent-green" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
      {svgHtml && (
        <button onClick={handleDownloadSvg} className="p-1.5 rounded hover:bg-app-muted text-theme-muted hover:text-theme-secondary transition-colors" title="Download SVG">
          <Download className="w-3.5 h-3.5" />
        </button>
      )}
      <button onClick={() => setFullscreen(!fullscreen)} className="p-1.5 rounded hover:bg-app-muted text-theme-muted hover:text-theme-secondary transition-colors" title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
        {fullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
      </button>
    </div>
  );

  return (
    <>
      {/* Inline preview */}
      <div className="h-full flex flex-col overflow-hidden">
        <div className="px-3 py-2 border-b border-border bg-surface-50 shrink-0 flex items-center justify-between">
          <span className="text-xs font-semibold text-theme-secondary uppercase">Mermaid Preview</span>
          <div className="flex items-center gap-2">
            {zoomControls}
            {actionButtons}
          </div>
        </div>

        <div className="flex-1 overflow-auto p-3" ref={!fullscreen ? zoomContainerRef : undefined}>
          <div style={{ transform: `scale(${zoom})`, transformOrigin: 'top center', transition: 'transform 0.15s ease' }}>
            {diagramContent}
          </div>

          <details className="mt-4">
            <summary className="text-xs text-theme-muted cursor-pointer hover:text-theme-secondary">
              Raw Mermaid code
            </summary>
            <pre className="mt-2 p-3 bg-surface-200 rounded text-xs text-theme-secondary font-mono whitespace-pre-wrap overflow-auto max-h-60">
              {mermaidCode}
            </pre>
          </details>
        </div>
      </div>

      {/* Fullscreen overlay */}
      {fullscreen && (
        <div className="fixed inset-0 z-50 bg-surface-50 flex flex-col" onClick={() => setFullscreen(false)}>
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-3 border-b border-app bg-surface-100/80 backdrop-blur-sm shrink-0" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3">
              <span className="text-sm font-heading font-semibold text-theme-primary tracking-wider uppercase">
                {workflow?.name ?? 'Workflow'} — Diagram
              </span>
              <span className="text-[10px] font-mono text-theme-subtle">
                {Object.keys(workflow?.nodes ?? {}).length} nodes · {(workflow?.edges ?? []).length} edges
              </span>
            </div>
            <div className="flex items-center gap-2">
              {zoomControls}
              {actionButtons}
              <button onClick={() => setFullscreen(false)} className="p-2 rounded hover:bg-app-muted text-theme-muted hover:text-theme-secondary transition-colors" title="Close (Esc)">
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Diagram — full area, scrollable, zoomable */}
          <div className="flex-1 overflow-auto p-6" ref={fullscreen ? zoomContainerRef : undefined} onClick={e => e.stopPropagation()}>
            <div style={{ transform: `scale(${zoom})`, transformOrigin: 'top center', transition: 'transform 0.15s ease' }}>
              <div className="flex justify-center [&_svg]:h-auto [&_svg]:max-w-none">
                {error ? (
                  <div className="text-sm text-accent-red bg-accent-red/10 rounded-lg p-6">{error}</div>
                ) : fullscreenSvg ? (
                  <div dangerouslySetInnerHTML={{ __html: fullscreenSvg }} />
                ) : svgHtml ? (
                  <div dangerouslySetInnerHTML={{ __html: svgHtml }} />
                ) : (
                  <div className="text-sm text-theme-muted">Rendering...</div>
                )}
              </div>
            </div>
          </div>

          {/* Footer with raw code */}
          <div className="border-t border-app bg-surface-100/80 backdrop-blur-sm shrink-0" onClick={e => e.stopPropagation()}>
            <details className="px-6 py-2">
              <summary className="text-xs text-theme-muted cursor-pointer hover:text-theme-secondary">
                Raw Mermaid code
              </summary>
              <pre className="mt-2 mb-2 p-3 bg-[rgb(var(--color-editor-background))] rounded text-xs text-theme-secondary font-mono whitespace-pre-wrap overflow-auto max-h-48">
                {mermaidCode}
              </pre>
            </details>
          </div>
        </div>
      )}
    </>
  );
}
