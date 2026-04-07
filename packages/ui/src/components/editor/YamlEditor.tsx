import { useRef, useCallback, useEffect } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { registerYamlCompletions } from './yaml-schema';
import { useSettingsStore } from '../../stores/settingsStore';
import { getCssVarHex, resolveColorMode } from '../../lib/theme';

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
  const colorMode = useSettingsStore((state) => state.colorMode);
  const themeName = useSettingsStore((state) => state.themeName);
  const customAccent = useSettingsStore((state) => state.customAccent);

  const applyEditorTheme = useCallback(() => {
    if (!monacoRef.current) return;

    const resolvedMode = resolveColorMode(colorMode);
    monacoRef.current.editor.defineTheme('flowforge-active', {
      base: resolvedMode === 'dark' ? 'vs-dark' : 'vs',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': getCssVarHex('--color-editor-background', resolvedMode === 'dark' ? '#141620' : '#ffffff'),
        'editor.foreground': getCssVarHex('--color-text-primary', resolvedMode === 'dark' ? '#f8fafc' : '#0f172a'),
        'editor.lineHighlightBackground': getCssVarHex('--color-editor-line-highlight', resolvedMode === 'dark' ? '#1a1d2b' : '#f8fafc'),
        'editorGutter.background': getCssVarHex('--color-editor-gutter', resolvedMode === 'dark' ? '#0f1117' : '#f1f5f9'),
        'editorLineNumber.foreground': getCssVarHex('--color-text-subtle', resolvedMode === 'dark' ? '#64748b' : '#64748b'),
        'editorLineNumber.activeForeground': getCssVarHex('--color-text-secondary', resolvedMode === 'dark' ? '#cbd5e1' : '#334155'),
        'editor.selectionBackground': resolvedMode === 'dark' ? '#2a2e4280' : '#bfdbfe66',
        'editorCursor.foreground': getCssVarHex('--color-accent', '#00d4ff'),
      },
    });
    monacoRef.current.editor.setTheme('flowforge-active');
  }, [colorMode]);

  const handleMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    registerYamlCompletions(monaco);
    applyEditorTheme();
  }, [applyEditorTheme]);

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

  useEffect(() => {
    applyEditorTheme();
  }, [applyEditorTheme, colorMode, themeName, customAccent]);

  return (
    <div className="h-full flex flex-col">
      {((errors?.length ?? 0) > 0 || (warnings?.length ?? 0) > 0) && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-50 border-b border-border text-xs shrink-0 text-theme-secondary">
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
