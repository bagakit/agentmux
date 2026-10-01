import { loader } from '@monaco-editor/react'
import '../toolkit-custom-ui/entry'

// Read-only observation of the actual selected mature editor; no model writes.
;(window as any).toolkitScene.selection = async () => {
  const editors = (await loader.init()).editor.getEditors().filter(editor => editor.getDomNode()?.checkVisibility({ visibilityProperty: true }))
  if (editors.length !== 1) throw Error('Expected one actual visible script editor')
  const editor = editors[0]!, selection = editor.getSelection()!, model = editor.getModel()!
  return { uri: model.uri.toString(), selection, selectedText: model.getValueInRange(selection), hasTextFocus: editor.hasTextFocus() }
}
