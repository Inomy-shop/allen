import { useRef, useCallback } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { registerYamlCompletions } from './yaml-schema';

interface Props {
  value: string;
  onChange: (value: string) => void;
  errors?: string[];
  warnings?: string[];
  readOnly?: boolean;
}

export default function YamlEditor({ value, onChange, errors, warnings, readOnly }: Props) {
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);

  const handleMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    // Dark theme
    monaco.editor.defineTheme('flowforge-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#141620',
        'editor.lineHighlightBackground': '#1a1d2b',
        'editorGutter.background': '#0f1117',
        'editor.selectionBackground': '#2a2e4280',
      },
    });
    monaco.editor.setTheme('flowforge-dark');

    registerYamlCompletions(monaco);
  }, []);

  const handleChange = useCallback((val: string | undefined) => {
    onChange(val ?? '');
  }, [onChange]);

  // Apply validation markers
  const updateMarkers = useCallback(() => {
    if (!editorRef.current || !monacoRef.current) return;
    const model = editorRef.current.getModel();
    if (!model) return;

    const markers: any[] = [];

    for (const err of errors ?? []) {
      markers.push({
        severity: monacoRef.current.MarkerSeverity.Error,
        message: err,
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 1,
      });
    }

    for (const warn of warnings ?? []) {
      markers.push({
        severity: monacoRef.current.MarkerSeverity.Warning,
        message: warn,
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 1,
      });
    }

    monacoRef.current.editor.setModelMarkers(model, 'flowforge', markers);
  }, [errors, warnings]);

  // Update markers when errors/warnings change
  if (editorRef.current) updateMarkers();

  return (
    <div className="h-full flex flex-col">
      {/* Validation badges */}
      {((errors?.length ?? 0) > 0 || (warnings?.length ?? 0) > 0) && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-50 border-b border-border text-xs shrink-0">
          {(errors?.length ?? 0) > 0 && (
            <span className="text-red-400">{errors!.length} error{errors!.length > 1 ? 's' : ''}</span>
          )}
          {(warnings?.length ?? 0) > 0 && (
            <span className="text-yellow-400">{warnings!.length} warning{warnings!.length > 1 ? 's' : ''}</span>
          )}
        </div>
      )}

      <div className="flex-1">
        <Editor
          language="yaml"
          value={value}
          onChange={handleChange}
          onMount={handleMount}
          options={{
            readOnly,
            minimap: { enabled: false },
            fontSize: 13,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            tabSize: 2,
            automaticLayout: true,
            folding: true,
            renderLineHighlight: 'line',
            padding: { top: 8 },
          }}
        />
      </div>
    </div>
  );
}
