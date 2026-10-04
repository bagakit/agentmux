import type { editor as Monaco } from 'monaco-editor'
import type { FileFormatAdapter, FileFormatSnapshot } from './format-file-region'

/** Monaco owns edits/undo; the document owner supplies only its current content and generation. */
export function monacoFormatAdapter(editor: Monaco.IStandaloneCodeEditor, owner: {
  path: string; isLive(): boolean; read(): { content: string; generation: number } | null; observe?(changed: () => void): () => void
}): FileFormatAdapter {
  const isCurrent = (snapshot: FileFormatSnapshot) => {
    const model = editor.getModel(), document = owner.read()
    return owner.isLive() && model === snapshot.model && !model.isDisposed() && model.getVersionId() === snapshot.version &&
      model.getValue() === snapshot.content && document?.content === snapshot.content && document.generation === snapshot.generation
  }
  return {
    snapshot() {
      const model = editor.getModel(), document = owner.read()
      if (!owner.isLive() || !model || model.isDisposed() || !document || model.getValue() !== document.content) return null
      return { path: owner.path, content: document.content, generation: document.generation, model, version: model.getVersionId() }
    },
    isCurrent,
    watch(snapshot, invalidate) {
      const changed = () => { try { if (!isCurrent(snapshot)) invalidate() } catch (error) { invalidate(error) } }
      const model = snapshot.model as Monaco.ITextModel
      const modelChange = model.onDidChangeContent(changed)
      const editorChange = editor.onDidChangeModel(changed)
      const unsubscribe = owner.observe?.(changed)
      changed()
      return () => { modelChange.dispose(); editorChange.dispose(); unsubscribe?.() }
    },
    apply(snapshot, content) {
      if (!isCurrent(snapshot)) return false
      const model = editor.getModel()!
      editor.pushUndoStop()
      const applied = editor.executeEdits('agentmux.formatDocument', [{ range: model.getFullModelRange(), text: content, forceMoveMarkers: true }])
      editor.pushUndoStop()
      return applied
    }
  }
}
