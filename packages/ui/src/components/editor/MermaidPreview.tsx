import { useMemo } from 'react';
import { generateMermaid } from '../../lib/mermaid-generator';

interface Props {
  workflow: any;
}

/**
 * Live Mermaid preview that renders as styled text (no mermaid.js runtime).
 * Shows the Mermaid diagram source that can be pasted into any Mermaid renderer.
 */
export default function MermaidPreview({ workflow }: Props) {
  const mermaidCode = useMemo(() => {
    if (!workflow) return '';
    return generateMermaid(workflow);
  }, [workflow]);

  if (!mermaidCode) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm">
        Write a valid workflow to see the diagram
      </div>
    );
  }

  // Parse mermaid into a visual representation
  const lines = mermaidCode.split('\n').filter(l => l.trim() && !l.startsWith('  classDef') && l !== 'graph TD');

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="px-3 py-2 border-b border-border bg-surface-50 shrink-0">
        <span className="text-xs font-semibold text-gray-400 uppercase">Mermaid Preview</span>
      </div>

      <div className="flex-1 overflow-auto p-3">
        {/* Visual node/edge representation */}
        <div className="space-y-1">
          {lines.map((line, i) => {
            const trimmed = line.trim();

            // Node definitions
            if (trimmed.match(/^\w+[\[{(]/)) {
              const name = trimmed.match(/^(\w+)/)?.[1] ?? '';
              const isAgent = trimmed.includes(':::agent');
              const isCode = trimmed.includes(':::code');
              const isHuman = trimmed.includes(':::human');
              const isWorkflow = trimmed.includes(':::workflow');
              const isCondition = trimmed.includes(':::condition');

              const color = isAgent ? 'bg-blue-500/20 border-blue-500/40 text-blue-300'
                : isCode ? 'bg-green-500/20 border-green-500/40 text-green-300'
                : isHuman ? 'bg-orange-500/20 border-orange-500/40 text-orange-300'
                : isWorkflow ? 'bg-purple-500/20 border-purple-500/40 text-purple-300'
                : isCondition ? 'bg-yellow-500/20 border-yellow-500/40 text-yellow-300'
                : 'bg-gray-500/20 border-gray-500/40 text-gray-300';

              return (
                <div key={i} className={`inline-block px-3 py-1.5 rounded border text-xs font-mono mr-2 mb-1 ${color}`}>
                  {name}
                </div>
              );
            }

            // Edge definitions
            if (trimmed.includes('-->')) {
              const parts = trimmed.match(/(\w+)\s*-->(?:\|"(.+?)"\|)?\s*(\w+)/);
              if (parts) {
                return (
                  <div key={i} className="flex items-center gap-1.5 text-xs text-gray-400 py-0.5">
                    <span className="font-mono text-gray-300">{parts[1]}</span>
                    <span className="text-gray-600">→</span>
                    <span className="font-mono text-gray-300">{parts[3]}</span>
                    {parts[2] && (
                      <span className="text-yellow-500/70 text-[10px]">({parts[2]})</span>
                    )}
                  </div>
                );
              }
            }

            return null;
          })}
        </div>

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
