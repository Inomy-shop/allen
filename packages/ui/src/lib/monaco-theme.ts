/**
 * Monaco theme registration to match the Allen prototype design system.
 * Two themes: 'allen-light' and 'allen-dark'. Pick one based on the current resolved color mode
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
      'editor.foreground': '#0B1730',
      'editor.lineHighlightBackground': '#F8FAFE',
      'editor.lineHighlightBorder': '#F8FAFE',
      'editorGutter.background': '#FCFDFF',
      'editorLineNumber.foreground': '#9CA5B8',
      'editorLineNumber.activeForeground': '#4763CF',
      'editor.selectionBackground': '#DFE2F7',
      'editor.inactiveSelectionBackground': '#F4F6FB',
      'editorCursor.foreground': '#4763CF',
      'editorIndentGuide.background': '#F4F6FB',
      'editorIndentGuide.activeBackground': '#CDD3E0',
      'editorWhitespace.foreground': '#E2E5ED',
      'diffEditor.insertedTextBackground': '#269E5F15',
      'diffEditor.removedTextBackground': '#DE3B3D15',
      'diffEditor.insertedLineBackground': '#269E5F0D',
      'diffEditor.removedLineBackground': '#DE3B3D0D',
    },
  });

  monaco.editor.defineTheme('allen-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#171413',
      'editor.foreground': '#F0E8DF',
      'editor.lineHighlightBackground': '#201B19',
      'editor.lineHighlightBorder': '#201B19',
      'editorGutter.background': '#0F0D0C',
      'editorLineNumber.foreground': '#685E55',
      'editorLineNumber.activeForeground': '#C86F32',
      'editor.selectionBackground': '#C86F3233',
      'editor.inactiveSelectionBackground': '#201B19',
      'editorCursor.foreground': '#C86F32',
      'editorIndentGuide.background': '#201B19',
      'editorIndentGuide.activeBackground': '#4A4039',
      'editorWhitespace.foreground': '#342C28',
      'diffEditor.insertedTextBackground': '#43C07A25',
      'diffEditor.removedTextBackground': '#FA686325',
      'diffEditor.insertedLineBackground': '#43C07A15',
      'diffEditor.removedLineBackground': '#FA686315',
    },
  });
}

/**
 * Returns the Monaco theme name to use right now. Call this from
 * `<Editor theme={...}>` and `<DiffEditor theme={...}>`.
 *
 * Reads the .dark class on <html> directly so it reflects whatever
 * the settings store last applied (light or dark).
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
