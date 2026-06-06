import { useRef, useCallback, useEffect, useState } from 'react';
import type * as Monaco from 'monaco-editor';
import { Loader2 } from 'lucide-react';
import { registerYamlCompletions } from './yaml-schema';
import { useSettingsStore } from '../../stores/settingsStore';
import { getMonacoTheme, setupMonaco } from '../../lib/monaco-theme';

interface Props {
  value: string;
  onChange: (value: string) => void;
  errors?: string[];
  warnings?: string[];
  readOnly?: boolean;
}

// The YAML completion provider is global to the monaco singleton, so register
// it once across all editor instances to avoid duplicate suggestions.
let completionsRegistered = false;

/**
 * Try to find the line number for an error/warning message by searching
 * for referenced node names, field names, or YAML keys in the source.
 */
function findLineForMessage(message: string, source: string): number {
  const lines = source.split('\n');

  // Extract node name references like: Node "plan" or node plan or `plan`
  const nodeMatch = message.match(/[Nn]ode\s+["'`]?(\w[\w-]*)["'`]?/);
  if (nodeMatch) {
    const name = nodeMatch[1];
    const idx = lines.findIndex(l => new RegExp(`^\\s*${name}\\s*:`).test(l));
    if (idx >= 0) return idx + 1;
  }

  // Extract condition references
  const condMatch = message.match(/[Cc]ondition\s+["'`]([^"'`]+)["'`]/);
  if (condMatch) {
    const idx = lines.findIndex(l => l.includes(condMatch[1]));
    if (idx >= 0) return idx + 1;
  }

  // Extract variable references like: uses '{{plan}}'
  const varMatch = message.match(/['"`]?\{\{(\w+)\}\}['"`]?/);
  if (varMatch) {
    const idx = lines.findIndex(l => l.includes(`{{${varMatch[1]}}}`));
    if (idx >= 0) return idx + 1;
  }

  // Extract field/key references like: 'test_passed' or "role"
  const fieldMatch = message.match(/['"`](\w[\w-]*)['"`]/);
  if (fieldMatch) {
    const idx = lines.findIndex(l => l.includes(fieldMatch[1]));
    if (idx >= 0) return idx + 1;
  }

  // YAML parse errors often include "at line N"
  const lineMatch = message.match(/line\s+(\d+)/i);
  if (lineMatch) return parseInt(lineMatch[1]);

  return 1;
}

/**
 * YAML editor backed by a directly-bundled monaco-editor instance (same path
 * as DirectMonacoEditor). The previous `@monaco-editor/react` wrapper relied
 * on a CDN loader that never resolves in the packaged desktop app, leaving the
 * pane stuck on "Loading…". Importing monaco directly avoids the network
 * dependency entirely.
 */
export default function YamlEditor({ value, onChange, errors, warnings, readOnly }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const changeDisposableRef = useRef<Monaco.IDisposable | null>(null);
  const onChangeRef = useRef(onChange);
  const colorMode = useSettingsStore((state) => state.colorMode);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  const applyMarkers = useCallback(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    const model = editor.getModel();
    if (!model) return;

    const source = model.getValue();
    const markers: Monaco.editor.IMarkerData[] = [];
    const push = (message: string, severity: Monaco.MarkerSeverity) => {
      const line = findLineForMessage(message, source);
      const lineContent = model.getLineContent(line) ?? '';
      markers.push({
        severity,
        message,
        startLineNumber: line,
        startColumn: 1,
        endLineNumber: line,
        endColumn: lineContent.length + 1,
      });
    };
    for (const err of errors ?? []) push(err, monaco.MarkerSeverity.Error);
    for (const warn of warnings ?? []) push(warn, monaco.MarkerSeverity.Warning);
    monaco.editor.setModelMarkers(model, 'allen', markers);
  }, [errors, warnings]);

  // Mount the editor once.
  useEffect(() => {
    let cancelled = false;
    let resizeObserver: ResizeObserver | null = null;

    (async () => {
      try {
        const monaco = await import('monaco-editor');
        if (cancelled || !containerRef.current) return;

        monacoRef.current = monaco;
        setupMonaco(monaco);
        if (!completionsRegistered) {
          registerYamlCompletions(monaco);
          completionsRegistered = true;
        }

        const editor = monaco.editor.create(containerRef.current, {
          value,
          language: 'yaml',
          readOnly,
          minimap: { enabled: false },
          fontSize: 13,
          fontFamily: "'JetBrains Mono', 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          lineNumbers: 'on',
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          tabSize: 2,
          automaticLayout: true,
          folding: true,
          renderLineHighlight: 'line',
          smoothScrolling: true,
          theme: getMonacoTheme(),
          padding: { top: 8 },
        });

        changeDisposableRef.current = editor.onDidChangeModelContent(() => {
          onChangeRef.current(editor.getValue());
        });
        editorRef.current = editor;
        resizeObserver = new ResizeObserver(() => editor.layout());
        resizeObserver.observe(containerRef.current);
        requestAnimationFrame(() => editor.layout());
        setReady(true);
      } catch (error) {
        console.warn('[yaml-editor] mount failed', error);
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      changeDisposableRef.current?.dispose();
      changeDisposableRef.current = null;
      editorRef.current?.dispose();
      editorRef.current = null;
      monacoRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync external value changes (e.g. switching from the visual editor) without
  // clobbering the cursor while the user types — only write when it differs.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const model = editor.getModel();
    if (model && model.getValue() !== value) model.setValue(value);
    editor.updateOptions({ readOnly });
  }, [value, readOnly]);

  // Re-theme on color-mode change.
  useEffect(() => {
    if (monacoRef.current) monacoRef.current.editor.setTheme(getMonacoTheme());
  }, [colorMode]);

  // Apply validation markers with line-aware positioning.
  useEffect(() => {
    if (ready) applyMarkers();
  }, [ready, applyMarkers, value]);

  return (
    <div className="h-full flex flex-col">
      {((errors?.length ?? 0) > 0 || (warnings?.length ?? 0) > 0) && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-50 border-b border-border text-xs shrink-0 text-theme-secondary">
          {(errors?.length ?? 0) > 0 && (
            <span className="text-accent-red">{errors!.length} error{errors!.length > 1 ? 's' : ''}</span>
          )}
          {(warnings?.length ?? 0) > 0 && (
            <span className="text-accent-yellow">{warnings!.length} warning{warnings!.length > 1 ? 's' : ''}</span>
          )}
        </div>
      )}

      <div className="relative flex-1 overflow-hidden bg-[rgb(var(--color-editor-background))]">
        {failed ? (
          <textarea
            value={value}
            onChange={event => onChange(event.target.value)}
            readOnly={readOnly}
            className="h-full w-full resize-none bg-[rgb(var(--color-editor-background))] p-3 text-[12px] font-mono leading-relaxed text-theme-primary outline-none"
            spellCheck={false}
          />
        ) : (
          <>
            <div ref={containerRef} className="h-full w-full" />
            {!ready && (
              <div className="absolute inset-0 flex items-center justify-center gap-2 bg-app-card text-[11px] font-mono text-theme-muted">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Loading editor...</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
