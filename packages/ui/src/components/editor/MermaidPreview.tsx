import { useMemo, useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';
import { generateMermaid } from '../../lib/mermaid-generator';
import { useSettingsStore } from '../../stores/settingsStore';
import { resolveColorMode } from '../../lib/theme';
import { getCssVarHex } from '../../lib/theme';

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
  const colorMode = useSettingsStore((s) => s.colorMode);

  const mermaidCode = useMemo(() => {
    if (!workflow) return '';
    return generateMermaid(workflow);
  }, [workflow]);

  useEffect(() => {
    if (!mermaidCode) {
      setSvgHtml('');
      setError('');
      return;
    }

    let cancelled = false;
    const resolvedMode = resolveColorMode(colorMode);

    (async () => {
      try {
        // Reinitialize mermaid with the current theme
        const themeConfig = getMermaidTheme(resolvedMode);
        mermaid.initialize({
          startOnLoad: false,
          theme: themeConfig.theme as any,
          themeVariables: themeConfig.themeVariables,
          flowchart: {
            htmlLabels: true,
            curve: 'basis',
            padding: 12,
          },
        });

        const id = `mermaid-${Date.now()}`;
        const { svg } = await mermaid.render(id, mermaidCode);
        if (!cancelled) {
          setSvgHtml(svg);
          setError('');
        }
      } catch (e: any) {
        if (!cancelled) {
          setError(e.message ?? 'Failed to render diagram');
          setSvgHtml('');
        }
      }
    })();

    return () => { cancelled = true; };
  }, [mermaidCode, colorMode]);

  if (!mermaidCode) {
    return (
      <div className="flex items-center justify-center h-full text-theme-muted text-sm">
        Write a valid workflow to see the diagram
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="px-3 py-2 border-b border-border bg-surface-50 shrink-0">
        <span className="text-xs font-semibold text-theme-secondary uppercase">Mermaid Preview</span>
      </div>

      <div className="flex-1 overflow-auto p-3">
        {error ? (
          <div className="text-xs text-red-400 bg-red-500/10 rounded p-3">
            {error}
          </div>
        ) : svgHtml ? (
          <div
            ref={containerRef}
            className="[&_svg]:max-w-full [&_svg]:h-auto"
            dangerouslySetInnerHTML={{ __html: svgHtml }}
          />
        ) : (
          <div className="text-xs text-theme-muted">Rendering...</div>
        )}

        {/* Raw Mermaid code */}
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
  );
}
