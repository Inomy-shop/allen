/**
 * Monaco theme registration to match the Linear v2 design system.
 * Two themes: 'allen-light' (D2 / Linear-clean) and 'allen-dark'
 * (Linear-night). Pick one based on the current resolved color mode
 * via `resolveColorMode` from ./theme.
 */
import type * as Monaco from 'monaco-editor';

let registered = false;

function defineThemes(monaco: typeof Monaco) {
  monaco.editor.defineTheme('allen-light', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#FFFFFF',
      'editor.foreground': '#18181A',
      'editor.lineHighlightBackground': '#F8F9FC',
      'editor.lineHighlightBorder': '#F8F9FC',
      'editorGutter.background': '#FBFBFA',
      'editorLineNumber.foreground': '#B8B8BC',
      'editorLineNumber.activeForeground': '#5E6AD2',
      'editor.selectionBackground': '#EEF0FB',
      'editor.inactiveSelectionBackground': '#F4F4F2',
      'editorCursor.foreground': '#5E6AD2',
      'editorIndentGuide.background': '#F4F4F2',
      'editorIndentGuide.activeBackground': '#E8E7E4',
      'editorWhitespace.foreground': '#E8E7E4',
      'diffEditor.insertedTextBackground': '#05966915',
      'diffEditor.removedTextBackground': '#DC262615',
      'diffEditor.insertedLineBackground': '#0596690D',
      'diffEditor.removedLineBackground': '#DC26260D',
    },
  });

  monaco.editor.defineTheme('allen-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#16171B',
      'editor.foreground': '#F4F4F5',
      'editor.lineHighlightBackground': '#1C1D22',
      'editor.lineHighlightBorder': '#1C1D22',
      'editorGutter.background': '#0F1014',
      'editorLineNumber.foreground': '#5C5D63',
      'editorLineNumber.activeForeground': '#7170FF',
      'editor.selectionBackground': '#7170FF33',
      'editor.inactiveSelectionBackground': '#23242A',
      'editorCursor.foreground': '#7170FF',
      'editorIndentGuide.background': '#1C1D22',
      'editorIndentGuide.activeBackground': '#34353C',
      'editorWhitespace.foreground': '#26272D',
      'diffEditor.insertedTextBackground': '#34C78225',
      'diffEditor.removedTextBackground': '#F8555525',
      'diffEditor.insertedLineBackground': '#34C78215',
      'diffEditor.removedLineBackground': '#F8555515',
    },
  });
}

/**
 * Returns the Monaco theme name to use right now. Call this from
 * `<Editor theme={...}>` and `<DiffEditor theme={...}>`.
 *
 * Reads the .dark class on <html> directly so it reflects whatever
 * the settings store last applied (light / dark / system-resolved).
 */
export function getMonacoTheme(): 'allen-light' | 'allen-dark' {
  if (typeof document === 'undefined') return 'allen-light';
  return document.documentElement.classList.contains('dark') ? 'allen-dark' : 'allen-light';
}

/**
 * Wires the monaco beforeMount hook — defines both themes once and
 * picks the right one for the current resolved color mode.
 */
export function setupMonaco(monaco: typeof Monaco) {
  if (!registered) {
    defineThemes(monaco);
    registered = true;
  }
  monaco.editor.setTheme(getMonacoTheme());
}
