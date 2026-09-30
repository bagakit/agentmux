import * as monaco from 'monaco-editor/editor/editor.api.js'
import { vi } from 'vitest'

vi.hoisted(() => { Object.defineProperty(window, 'matchMedia', { configurable: true,
  value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }) })

// Preload the real model registry during fixture collection. Adapt only the mature public browser
// widget API; GitDiffCanvas still creates, attaches, cancels, and disposes its actual readonly models.
export const workfaceMonacoModelCount = () => monaco.editor.getModels().length
export function workfaceMonacoAdapter() {
  return { ...monaco, editor: { ...monaco.editor, setTheme() {}, createDiffEditor(host: HTMLElement) {
    const body = document.createElement('div'); body.className = 'monaco-diff-editor'; host.append(body)
    let listeners: monaco.IDisposable[] = []
    const detach = () => { listeners.forEach(listener => listener.dispose()); listeners = []; body.replaceChildren() }
    return {
      createViewModel(model: monaco.editor.IDiffEditorModel): monaco.editor.IDiffEditorViewModel {
        return { model, waitForDiff: async () => {}, dispose() {} }
      },
      setModel(viewModel: monaco.editor.IDiffEditorViewModel | null) {
        detach()
        if (!viewModel) return
        const { original, modified } = viewModel.model
        const draw = () => {
          body.replaceChildren(...(['original', 'modified'] as const).map(side => {
            const node = document.createElement('pre'); node.dataset.workfaceDiffSide = side
            node.textContent = viewModel.model[side].getValue(); return node
          }))
        }
        listeners = [original.onDidChangeContent(draw), modified.onDidChangeContent(draw)]; draw()
      },
      updateOptions() {}, dispose() { detach(); body.remove() }
    } as unknown as monaco.editor.IStandaloneDiffEditor
  } } }
}
