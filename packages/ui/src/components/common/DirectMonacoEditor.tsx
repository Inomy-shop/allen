import { useEffect, useRef, useState } from 'react';
import type * as Monaco from 'monaco-editor';
import { Loader2 } from 'lucide-react';
import { getMonacoTheme, setupMonaco } from '../../lib/monaco-theme';

type DirectMonacoEditorProps = {
  value: string;
  language: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  height?: string;
  className?: string;
  options?: Monaco.editor.IStandaloneEditorConstructionOptions;
};

export default function DirectMonacoEditor({
  value,
  language,
  onChange,
  readOnly = false,
  height = '100%',
  className = '',
  options,
}: DirectMonacoEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const changeDisposableRef = useRef<Monaco.IDisposable | null>(null);
  const onChangeRef = useRef(onChange);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    let cancelled = false;
    let timedOut = false;
    let resizeObserver: ResizeObserver | null = null;
    const fallbackTimer = window.setTimeout(() => {
      timedOut = true;
      setFailed(true);
    }, 6_000);

    async function mountEditor() {
      try {
        const monaco = await import('monaco-editor');
        if (cancelled || timedOut || !containerRef.current) return;

        monacoRef.current = monaco;
        setupMonaco(monaco);
        const editor = monaco.editor.create(containerRef.current, {
          automaticLayout: true,
          bracketPairColorization: { enabled: true },
          cursorBlinking: 'smooth',
          fontFamily: "'JetBrains Mono', 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          fontLigatures: true,
          fontSize: 12,
          folding: true,
          glyphMargin: false,
          language,
          lineDecorationsWidth: 8,
          lineNumbers: 'on',
          minimap: { enabled: false },
          padding: { top: 6, bottom: 6 },
          readOnly,
          renderLineHighlight: 'line',
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          tabSize: 2,
          theme: getMonacoTheme(),
          value,
          wordWrap: 'on',
          ...options,
        });

        changeDisposableRef.current = editor.onDidChangeModelContent(() => {
          onChangeRef.current?.(editor.getValue());
        });
        editorRef.current = editor;
        resizeObserver = new ResizeObserver(() => editor.layout());
        resizeObserver.observe(containerRef.current);
        requestAnimationFrame(() => editor.layout());
        window.clearTimeout(fallbackTimer);
        setReady(true);
      } catch (error) {
        console.warn('[direct-monaco-editor] mount failed', error);
        window.clearTimeout(fallbackTimer);
        if (!cancelled && !timedOut) setFailed(true);
      }
    }

    mountEditor();

    return () => {
      cancelled = true;
      window.clearTimeout(fallbackTimer);
      resizeObserver?.disconnect();
      changeDisposableRef.current?.dispose();
      changeDisposableRef.current = null;
      editorRef.current?.dispose();
      editorRef.current = null;
      monacoRef.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    const model = editor.getModel();
    if (model && model.getValue() !== value) model.setValue(value);
    if (model) monaco.editor.setModelLanguage(model, language);
    editor.updateOptions({ readOnly, ...options });
    requestAnimationFrame(() => editor.layout());
  }, [language, options, readOnly, value]);

  if (failed) {
    if (readOnly) {
      return (
        <pre
          className={`m-0 overflow-auto bg-[rgb(var(--color-editor-background))] p-3 text-[12px] font-mono leading-relaxed text-theme-primary whitespace-pre-wrap break-words ${className}`}
          style={{ height }}
        >
          {value}
        </pre>
      );
    }

    return (
      <textarea
        value={value}
        onChange={event => onChange?.(event.target.value)}
        className={`w-full resize-none bg-[rgb(var(--color-editor-background))] p-3 text-[12px] font-mono leading-relaxed text-theme-primary outline-none ${className}`}
        style={{ height }}
        spellCheck={false}
      />
    );
  }

  return (
    <div className={`relative overflow-hidden bg-[rgb(var(--color-editor-background))] ${className}`} style={{ height }}>
      <div ref={containerRef} className="h-full w-full" />
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center gap-2 bg-app-card text-[11px] font-mono text-theme-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Loading editor...</span>
        </div>
      )}
    </div>
  );
}
