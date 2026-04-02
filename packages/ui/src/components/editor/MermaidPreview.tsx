import { useMemo, useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';
import { generateMermaid } from '../../lib/mermaid-generator';

// Initialize mermaid with dark theme
mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  themeVariables: {
    primaryColor: '#3498db',
    primaryTextColor: '#e2e8f0',
    primaryBorderColor: '#2c3e50',
    lineColor: '#4b5563',
    secondaryColor: '#2ecc71',
    tertiaryColor: '#141620',
    mainBkg: '#1a1d2b',
    nodeBorder: '#4b5563',
    clusterBkg: '#222536',
    titleColor: '#e2e8f0',
    edgeLabelBackground: '#1a1d2b',
  },
  flowchart: {
    htmlLabels: true,
    curve: 'basis',
    padding: 12,
  },
});

interface Props {
  workflow: any;
}

export default function MermaidPreview({ workflow }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svgHtml, setSvgHtml] = useState('');
  const [error, setError] = useState('');

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

    (async () => {
      try {
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
  }, [mermaidCode]);

  if (!mermaidCode) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm">
        Write a valid workflow to see the diagram
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="px-3 py-2 border-b border-border bg-surface-50 shrink-0">
        <span className="text-xs font-semibold text-gray-400 uppercase">Mermaid Preview</span>
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
          <div className="text-xs text-gray-500">Rendering...</div>
        )}

        {/* Raw Mermaid code */}
        <details className="mt-4">
          <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-300">
            Raw Mermaid code
          </summary>
          <pre className="mt-2 p-3 bg-surface-200 rounded text-xs text-gray-400 font-mono whitespace-pre-wrap overflow-auto max-h-60">
            {mermaidCode}
          </pre>
        </details>
      </div>
    </div>
  );
}
