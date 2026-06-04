import mermaid, { type MermaidConfig } from 'mermaid';

export function initializeMermaid(config: MermaidConfig) {
  mermaid.initialize({
    ...config,
    startOnLoad: false,
    suppressErrorRendering: true,
  });
}

export { mermaid };
