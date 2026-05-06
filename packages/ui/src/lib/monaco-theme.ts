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
      'editor.foreground': '#12171B',
      'editor.lineHighlightBackground': '#F9F8F6',
      'editor.lineHighlightBorder': '#F9F8F6',
      'editorGutter.background': '#FBFAF8',
      'editorLineNumber.foreground': '#A1A5A9',
      'editorLineNumber.activeForeground': '#2A76E2',
      'editor.selectionBackground': '#DEF0FF',
      'editor.inactiveSelectionBackground': '#F6F5F2',
      'editorCursor.foreground': '#2A76E2',
      'editorIndentGuide.background': '#F6F5F2',
      'editorIndentGuide.activeBackground': '#E3E1DE',
      'editorWhitespace.foreground': '#E3E1DE',
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
      'editor.background': '#0D1116',
      'editor.foreground': '#DBDEE2',
      'editor.lineHighlightBackground': '#13181D',
      'editor.lineHighlightBorder': '#13181D',
      'editorGutter.background': '#06080C',
      'editorLineNumber.foreground': '#494E54',
      'editorLineNumber.activeForeground': '#5CA4FF',
      'editor.selectionBackground': '#5CA4FF33',
      'editor.inactiveSelectionBackground': '#13181D',
      'editorCursor.foreground': '#5CA4FF',
      'editorIndentGuide.background': '#13181D',
      'editorIndentGuide.activeBackground': '#181C22',
      'editorWhitespace.foreground': '#1F2329',
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
