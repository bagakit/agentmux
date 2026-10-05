import { observeResolvedTheme, type ResolvedTheme } from '@agentmux/client-ui/theme'
import type { editor } from 'monaco-editor'

export const MONACO_THEME_ID = 'agentmux-workbench' as const
export type MonacoThemeId = typeof MONACO_THEME_ID

/** Source and diff use the same Root projection; syntax roles preserve status meaning. */
export function monacoTheme(theme: ResolvedTheme): editor.IStandaloneThemeData {
  const c = theme.variant.colors
  const wash = (color: string, alpha: string) => color + alpha
  return {
    base: theme.mode === 'light' ? 'vs' : 'vs-dark', inherit: true,
    rules: [
      { token: '', foreground: c.text.slice(1) }, { token: 'comment', foreground: c.textSubtle.slice(1) },
      { token: 'keyword', foreground: c.special.slice(1) }, { token: 'string', foreground: c.success.slice(1) },
      { token: 'number', foreground: c.warning.slice(1) }, { token: 'regexp', foreground: c.warning.slice(1) },
      { token: 'tag', foreground: c.info.slice(1) }, { token: 'attribute.name', foreground: c.special.slice(1) },
      { token: 'attribute.value', foreground: c.success.slice(1) }, { token: 'metatag', foreground: c.textMuted.slice(1) }, { token: 'type', foreground: c.info.slice(1) },
      { token: 'delimiter', foreground: c.textMuted.slice(1) }, { token: 'invalid', foreground: c.danger.slice(1) }
    ],
    colors: {
      'editor.background': c.surface0, 'editor.foreground': c.text,
      'editorGutter.background': c.surface0, 'editorLineNumber.foreground': c.textSubtle,
      'editorLineNumber.activeForeground': c.textMuted, 'editorCursor.foreground': c.action,
      'editor.selectionBackground': wash(c.info, '32'), 'editor.inactiveSelectionBackground': wash(c.info, '1c'),
      'editor.selectionHighlightBackground': wash(c.info, '18'), 'editor.selectionHighlightBorder': wash(c.info, '50'),
      'editor.lineHighlightBackground': c.surface1, 'editor.lineHighlightBorder': '#00000000',
      'editor.wordHighlightBackground': wash(c.info, '18'), 'editor.wordHighlightStrongBackground': wash(c.info, '28'),
      'editor.findMatchBackground': wash(c.warning, '36'), 'editor.findMatchBorder': c.warning,
      'editor.findMatchHighlightBackground': wash(c.warning, '1e'), 'editor.findMatchHighlightBorder': wash(c.warning, '50'),
      'editorBracketMatch.background': wash(c.action, '20'), 'editorBracketMatch.border': c.focus,
      'editorIndentGuide.background1': c.lineSoft, 'editorIndentGuide.activeBackground1': c.line,
      'editorWhitespace.foreground': c.line, 'editorError.foreground': c.danger,
      'editorWarning.foreground': c.warning, 'editorInfo.foreground': c.info,
      'editorWidget.background': c.surface1, 'editorWidget.foreground': c.text, 'editorWidget.border': c.line,
      'editorSuggestWidget.background': c.surface1, 'editorSuggestWidget.foreground': c.text,
      'editorSuggestWidget.border': c.line, 'editorSuggestWidget.selectedBackground': c.surface3,
      'editorSuggestWidget.highlightForeground': c.action,
      'editorHoverWidget.background': c.surface1, 'editorHoverWidget.foreground': c.text,
      'editorHoverWidget.border': c.line, 'editorHoverWidget.statusBarBackground': c.surface2,
      'input.background': c.surface0, 'input.foreground': c.text, 'input.border': c.line,
      'input.placeholderForeground': c.textSubtle, 'focusBorder': c.focus,
      'list.activeSelectionBackground': c.surface3, 'list.activeSelectionForeground': c.text,
      'list.hoverBackground': c.surface2, 'list.hoverForeground': c.text,
      'menu.background': c.surface1, 'menu.foreground': c.text, 'menu.selectionBackground': c.surface3,
      'menu.selectionForeground': c.text, 'menu.separatorBackground': c.lineSoft,
      'diffEditor.insertedLineBackground': wash(c.success, '12'), 'diffEditor.insertedTextBackground': wash(c.success, '25'),
      'diffEditor.removedLineBackground': wash(c.danger, '12'), 'diffEditor.removedTextBackground': wash(c.danger, '25'),
      'diffEditorGutter.insertedLineBackground': wash(c.success, '20'), 'diffEditorGutter.removedLineBackground': wash(c.danger, '20'),
      'diffEditor.diagonalFill': c.lineSoft, 'diffEditor.border': c.line,
      'scrollbarSlider.background': wash(c.textSubtle, '35'), 'scrollbarSlider.hoverBackground': wash(c.textSubtle, '60'),
      'scrollbarSlider.activeBackground': wash(c.textSubtle, '80'), 'widget.shadow': theme.variant.elevation === 'flat' ? '#00000000' : wash(theme.mode === 'light' ? c.text : c.background, '20')
    }
  }
}

/** One native theme ID per window. Defining it updates existing editor views in place. */
export function mountMonacoTheme(native: Pick<typeof editor, 'defineTheme' | 'setTheme'>, host: Window = window): () => void {
  // Native theme data owns colors; Root CSS roles own controlled popup geometry.
  const style = host.document.createElement('style')
  style.dataset.monacoSemanticSurfaces = ''
  style.textContent = `.monaco-editor .find-widget,.monaco-editor .suggest-widget,.monaco-editor .monaco-hover,.monaco-menu-container .monaco-menu{border-radius:var(--radius-sm);box-shadow:var(--elev-2)} .monaco-menu-container .monaco-menu{font-family:var(--font-sans)}`
  host.document.head.append(style)
  let previous = ''
  const unsubscribe = observeResolvedTheme(theme => {
    const signature = JSON.stringify([theme.mode, theme.variant.colors, theme.variant.elevation])
    if (signature === previous) return
    native.defineTheme(MONACO_THEME_ID, monacoTheme(theme))
    native.setTheme(MONACO_THEME_ID)
    previous = signature
  }, host)
  return () => { unsubscribe(); style.remove() }
}
