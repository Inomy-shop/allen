import { useRef, useCallback, useEffect } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { registerYamlCompletions } from './yaml-schema';

interface Props {
  value: string;
  onChange: (value: string) => void;
  errors?: string[];
  warnings?: string[];
  readOnly?: boolean;
}

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

export default function YamlEditor({ value, onChange, errors, warnings, readOnly }: Props) {
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);

  const handleMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

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

  // Apply validation markers with line-aware positioning
  useEffect(() => {
    if (!editorRef.current || !monacoRef.current) return;
    const model = editorRef.current.getModel();
    if (!model) return;

    const markers: any[] = [];

    for (const err of errors ?? []) {
      const line = findLineForMessage(err, value);
      const lineContent = model.getLineContent(line) ?? '';
      markers.push({
        severity: monacoRef.current.MarkerSeverity.Error,
        message: err,
        startLineNumber: line,
        startColumn: 1,
        endLineNumber: line,
        endColumn: lineContent.length + 1,
      });
    }

    for (const warn of warnings ?? []) {
      const line = findLineForMessage(warn, value);
      const lineContent = model.getLineContent(line) ?? '';
      markers.push({
        severity: monacoRef.current.MarkerSeverity.Warning,
        message: warn,
        startLineNumber: line,
        startColumn: 1,
        endLineNumber: line,
        endColumn: lineContent.length + 1,
      });
    }

    monacoRef.current.editor.setModelMarkers(model, 'flowforge', markers);
  }, [errors, warnings, value]);

  return (
    <div className="h-full flex flex-col">
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
