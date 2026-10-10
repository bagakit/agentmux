import '../monaco'
import { useEffect, useId, useRef } from 'react'
import * as monaco from 'monaco-editor'
import type { MonacoThemeId } from '../lib/monaco-theme'
import { wordWrapOption } from '../lib/editor-diff'
import { useEditorTypography } from '../hooks/useEditorTypography'

/** One mounted canvas owns its widget, cancellable diff computation, and two readonly models. */
export function ReadonlyDiffEditor({ original, modified, wordWrap, language, theme }: {
  original: string; modified: string; wordWrap: boolean; language: string; theme: MonacoThemeId
}) {
  const typography = useEditorTypography()
  const instanceId = useId(), host = useRef<HTMLDivElement | null>(null)
  const widget = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const models = useRef<monaco.editor.IDiffEditorModel | null>(null)
  const initial = useRef({ original, modified, wordWrap, language, typography })
  const originalPath = `agentmux-diff:///${encodeURIComponent(instanceId)}/original`
  const modifiedPath = `agentmux-diff:///${encodeURIComponent(instanceId)}/modified`
  useEffect(() => {
    if (!host.current) return
    const value = initial.current
    const pair = {
      original: monaco.editor.createModel(value.original, value.language, monaco.Uri.parse(originalPath)),
      modified: monaco.editor.createModel(value.modified, value.language, monaco.Uri.parse(modifiedPath))
    }
    const editor = monaco.editor.createDiffEditor(host.current, {
      readOnly: true,
      // Monaco chooses the appropriate side-by-side/inline layout from the available width.
      minimap: { enabled: false },
      fontFamily: '"SFMono-Regular", "Cascadia Code", monospace',
      fontSize: value.typography.fontSize,
      lineHeight: value.typography.lineHeight,
      scrollBeyondLastLine: false,
      automaticLayout: true,
      wordWrap: wordWrapOption(value.wordWrap)
    })
    const viewModel = editor.createViewModel(pair)
    editor.setModel(viewModel)
    widget.current = editor; models.current = pair
    return () => {
      widget.current = null; models.current = null
      // Detach before releasing models, and explicitly cancel the owned computation. Widget
      // teardown alone can leave a deferred ViewModel reference while its worker is awaiting data.
      editor.setModel(null)
      viewModel.dispose()
      editor.dispose()
      pair.original.dispose()
      pair.modified.dispose()
    }
  }, [originalPath, modifiedPath])
  useEffect(() => {
    const pair = models.current
    if (!pair) return
    for (const [model, value] of [[pair.original, original], [pair.modified, modified]] as const) {
      if (model.getValue() !== value) model.setValue(value)
      if (model.getLanguageId() !== language) monaco.editor.setModelLanguage(model, language)
    }
  }, [original, modified, language])
  useEffect(() => { widget.current?.updateOptions({ wordWrap: wordWrapOption(wordWrap) }) }, [wordWrap])
  useEffect(() => { widget.current?.updateOptions({ fontSize: typography.fontSize, lineHeight: typography.lineHeight }) }, [typography.fontSize, typography.lineHeight])
  useEffect(() => { monaco.editor.setTheme(theme) }, [theme])
  return <div ref={host} style={{ width: '100%', height: '100%', minWidth: 0, minHeight: 0 }} />
}
