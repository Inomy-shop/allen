/**
 * ContentViewer — fullscreen editor-style viewer.
 *
 * Uses Monaco Editor for JSON and raw text (read-only, with syntax highlighting,
 * minimap, line numbers, folding — same look as the Workspace editor).
 * Uses the existing renderMarkdown for markdown content.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import Editor from '@monaco-editor/react';
import { X, Copy, Check, FileJson, FileText, Code, Maximize2 } from 'lucide-react';
import { renderMarkdown } from '../chat/ChatMessageList';
import { useSettingsStore } from '../../stores/settingsStore';
import { resolveColorMode } from '../../lib/theme';

export type ViewerMode = 'json' | 'markdown' | 'raw';

export function detectMode(content: string): ViewerMode {
  const t = content.trim();
  if (t.startsWith('{') || t.startsWith('[')) return 'json';
  if (t.startsWith('#') || t.includes('\n## ') || t.includes('\n- ') || t.includes('```')) return 'markdown';
  return 'raw';
}

/** Small expand button — place next to section headers. */
export function ExpandButton({ onClick, className }: { onClick: () => void; className?: string }) {
  return (
    <button
      onClick={e => { e.stopPropagation(); onClick(); }}
      className={`p-1 rounded hover:bg-surface-200/50 text-theme-muted hover:text-accent-blue transition-colors shrink-0 ${className ?? ''}`}
      title="Open in fullscreen viewer"
    >
      <Maximize2 className="w-3.5 h-3.5" />
    </button>
  );
}

/** Fullscreen content viewer modal with Monaco editor. */
export function ContentViewer({ title, content, defaultMode, onClose }: {
  title: string;
  content: string;
  defaultMode?: ViewerMode;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<ViewerMode>(defaultMode ?? detectMode(content));
  const [copied, setCopied] = useState(false);
  const editorRef = useRef<any>(null);
  const colorMode = useSettingsStore(s => s.colorMode);
  const resolved = resolveColorMode(colorMode);
  const monacoTheme = resolved === 'light' ? 'vs' : 'vs-dark';

  // Format JSON for the editor
  const editorContent = mode === 'json' ? formatJson(content) : content;
  const editorLanguage = mode === 'json' ? 'json' : 'plaintext';

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [content]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  function handleEditorMount(editor: any) {
    editorRef.current = editor;
    // Auto-fold all after mount for JSON (nice default)
    if (mode === 'json') {
      setTimeout(() => {
        try { editor.getAction('editor.foldLevel2')?.run(); } catch {}
      }, 300);
    }
  }

  const modes = [
    { key: 'json' as const, icon: FileJson, label: 'JSON' },
    { key: 'markdown' as const, icon: FileText, label: 'Markdown' },
    { key: 'raw' as const, icon: Code, label: 'Raw' },
  ];

  return (
    <div className="fixed inset-0 z-[60] bg-surface-50 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-2.5 border-b border-border/30 bg-surface-100/80 backdrop-blur-sm shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-sm font-heading font-semibold text-theme-primary tracking-wider uppercase">{title}</span>
          <span className="text-[10px] font-mono text-theme-subtle bg-surface-200/50 px-2 py-0.5 rounded">{content.length.toLocaleString()} chars</span>
          {mode !== 'markdown' && (
            <span className="text-[10px] font-mono text-theme-subtle bg-surface-200/50 px-2 py-0.5 rounded">{content.split('\n').length} lines</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Mode toggle */}
          <div className="flex items-center rounded-lg bg-surface-200/40 border border-border/20 p-0.5">
            {modes.map(({ key, icon: Icon, label }) => (
              <button
                key={key}
                onClick={() => setMode(key)}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-mono transition-all ${
                  mode === key
                    ? 'bg-accent-blue/15 text-accent-blue shadow-sm'
                    : 'text-theme-muted hover:text-theme-secondary'
                }`}
              >
                <Icon className="w-3 h-3" />{label}
              </button>
            ))}
          </div>

          {/* Actions */}
          {mode !== 'markdown' && editorRef.current && (
            <button
              onClick={() => { try { editorRef.current?.getAction('editor.foldAll')?.run(); } catch {} }}
              className="px-2 py-1 rounded-md text-[10px] font-mono text-theme-muted hover:text-theme-secondary bg-surface-200/30 hover:bg-surface-200/50 transition-colors"
              title="Fold all"
            >
              Fold
            </button>
          )}
          {mode !== 'markdown' && editorRef.current && (
            <button
              onClick={() => { try { editorRef.current?.getAction('editor.unfoldAll')?.run(); } catch {} }}
              className="px-2 py-1 rounded-md text-[10px] font-mono text-theme-muted hover:text-theme-secondary bg-surface-200/30 hover:bg-surface-200/50 transition-colors"
              title="Unfold all"
            >
              Unfold
            </button>
          )}
          <button onClick={handleCopy} className="p-1.5 rounded-md hover:bg-surface-200/50 text-theme-muted hover:text-theme-secondary transition-colors" title="Copy to clipboard">
            {copied ? <Check className="w-4 h-4 text-accent-green" /> : <Copy className="w-4 h-4" />}
          </button>
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-surface-200/50 text-theme-muted hover:text-theme-secondary transition-colors" title="Close (Esc)">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Content */}
      {mode === 'markdown' ? (
        <div className="flex-1 overflow-auto p-8">
          <div className="max-w-4xl mx-auto text-sm text-theme-secondary leading-relaxed prose-allen">
            {renderMarkdown(content)}
          </div>
        </div>
      ) : (
        <div className="flex-1">
          <Editor
            height="100%"
            language={editorLanguage}
            value={editorContent}
            theme={monacoTheme}
            onMount={handleEditorMount}
            options={{
              readOnly: true,
              fontSize: 13,
              fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
              fontLigatures: true,
              minimap: { enabled: true, scale: 1 },
              scrollBeyondLastLine: false,
              smoothScrolling: true,
              cursorBlinking: 'smooth',
              cursorSmoothCaretAnimation: 'on',
              renderLineHighlight: 'all',
              lineNumbers: 'on',
              glyphMargin: false,
              folding: true,
              foldingStrategy: 'indentation',
              bracketPairColorization: { enabled: true },
              wordWrap: mode === 'raw' ? 'on' : 'off',
              padding: { top: 12, bottom: 12 },
              lineDecorationsWidth: 8,
              renderWhitespace: 'selection',
              guides: {
                indentation: true,
                bracketPairs: true,
              },
              scrollbar: {
                verticalScrollbarSize: 10,
                horizontalScrollbarSize: 10,
              },
            }}
          />
        </div>
      )}
    </div>
  );
}

/** Try to format JSON nicely for the editor. */
function formatJson(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}
