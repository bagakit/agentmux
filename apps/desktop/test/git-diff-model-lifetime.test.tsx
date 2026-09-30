// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as monaco from 'monaco-editor/editor/editor.api.js'
import { GitDiffCanvas } from '../src/renderer/src/components/GitDiffCanvas'
import type { EditorRegionDiffState } from '../src/renderer/src/store'

vi.mock('../src/renderer/src/monaco', () => ({}))
vi.hoisted(() => { Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }) })

// The real Monaco registry owns model creation/disposal. This host adapts only the browser widget:
// disposal events mechanically record that the canvas detached and cancelled its own computation.
type Pair = monaco.editor.IDiffEditorModel
type ViewModel = monaco.editor.IDiffEditorViewModel & { cancelled: boolean }
type Canvas = { host: HTMLElement; disposed: boolean; pair: Pair | null; viewModel: ViewModel | null }
const canvases: Canvas[] = [], disposals: Array<{ disposedWidget: boolean; attached: boolean; cancelled: boolean; value: string }> = []
function createDiffCanvas(host: HTMLElement) {
  const canvas: Canvas = { host, disposed: false, pair: null, viewModel: null }; canvases.push(canvas)
  return {
    getModel: () => canvas.pair,
    createViewModel(pair: Pair) {
      const viewModel: ViewModel = { model: pair, cancelled: false,
        waitForDiff: () => Promise.resolve(), dispose() { viewModel.cancelled = true } }
      canvas.viewModel = viewModel; return viewModel
    },
    setModel(viewModel: ViewModel | null) {
      const pair = viewModel?.model ?? null
      canvas.pair = pair
      for (const model of pair ? [pair.original, pair.modified] : []) model.onWillDispose(() => {
        disposals.push({ disposedWidget: canvas.disposed, attached: canvas.pair !== null,
          cancelled: canvas.viewModel?.cancelled === true, value: model.getValue() })
      })
      host.textContent = pair ? pair.original.getValue() + '\n' + pair.modified.getValue() : ''
    },
    updateOptions() {},
    dispose() { canvas.disposed = true; canvas.pair = null }
  }
}
const diff = (original: string, modified: string): EditorRegionDiffState => ({ loading: false, error: null,
  diff: { path: 'same-file.md', old: { present: true, binary: false, text: original },
    new: { present: true, binary: false, text: modified }, binary: false, change: 'modified' } })
let root: Root, container: HTMLDivElement, baseline: number
beforeAll(() => {
  vi.spyOn(monaco.editor, 'createDiffEditor').mockImplementation(createDiffCanvas as unknown as typeof monaco.editor.createDiffEditor)
  vi.spyOn(monaco.editor, 'setTheme').mockImplementation(() => {})
})
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); canvases.length = 0; disposals.length = 0
  baseline = monaco.editor.getModels().length
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); await Promise.resolve()
  expect(monaco.editor.getModels()).toHaveLength(baseline)
  container.remove(); vi.unstubAllGlobals()
})
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
function live(view: string) {
  const host = container.querySelector(`[data-view="${view}"]`)!
  const canvas = [...canvases].reverse().find(canvas => !canvas.disposed && host.contains(canvas.host))
  expect(canvas).toBeDefined(); expect(canvas?.pair).not.toBeNull(); return canvas!
}
describe('actual DiffEditor model ownership', () => {
  it('releases only the removed canvas models after its widget and keeps the neighbor readable across Preview', async () => {
    const render = async (preview: boolean) => { await act(async () => root.render(<>
      <div data-view="first">{preview ? <p>Current TextDoc preview</p> : <GitDiffCanvas diff={diff('Original HEAD', 'Current dirty draft')} wordWrap={false} language="markdown" theme="vs-dark" />}</div>
      <div data-view="neighbor"><GitDiffCanvas diff={diff('Neighbor HEAD', 'Neighbor dirty draft')} wordWrap={false} language="markdown" theme="vs-dark" /></div>
    </>)); await settle() }
    await render(false); const first = live('first'), neighbor = live('neighbor'), firstPair = first.pair!, neighborPair = neighbor.pair!
    expect(monaco.editor.getModels()).toHaveLength(baseline + 4)
    expect(firstPair.original).not.toBe(neighborPair.original); expect(firstPair.modified).not.toBe(neighborPair.modified)
    await render(true)
    expect(disposals).toEqual([{ disposedWidget: true, attached: false, cancelled: true, value: 'Original HEAD' }, { disposedWidget: true, attached: false, cancelled: true, value: 'Current dirty draft' }])
    expect(firstPair.original.isDisposed()).toBe(true); expect(firstPair.modified.isDisposed()).toBe(true)
    expect(live('neighbor')).toBe(neighbor); expect(neighbor.pair).toBe(neighborPair)
    expect([neighborPair.original.getValue(), neighborPair.modified.getValue()]).toEqual(['Neighbor HEAD', 'Neighbor dirty draft'])
    expect(monaco.editor.getModels()).toHaveLength(baseline + 2)
    await render(false)
    expect([live('first').pair!.original.getValue(), live('first').pair!.modified.getValue()]).toEqual(['Original HEAD', 'Current dirty draft'])
    expect(monaco.editor.getModels()).toHaveLength(baseline + 4)
  })
  it('ends the mounted textual canvas at an error and creates fresh sides when the original diff data returns', async () => {
    const render = async (value: EditorRegionDiffState) => { await act(async () => root.render(<div data-view="first"><GitDiffCanvas diff={value} wordWrap theme="vs-dark" language="markdown" /></div>)); await settle() }
    await render(diff('First HEAD', 'First draft')); expect(monaco.editor.getModels()).toHaveLength(baseline + 2)
    await render({ loading: false, error: 'Private diff boundary unavailable', diff: null })
    expect(container.textContent).toContain('Could not load diff'); expect(monaco.editor.getModels()).toHaveLength(baseline)
    expect(disposals).toEqual([{ disposedWidget: true, attached: false, cancelled: true, value: 'First HEAD' }, { disposedWidget: true, attached: false, cancelled: true, value: 'First draft' }])
    await render(diff('Fresh HEAD', 'Fresh draft'))
    expect([live('first').pair!.original.getValue(), live('first').pair!.modified.getValue()]).toEqual(['Fresh HEAD', 'Fresh draft'])
    expect(monaco.editor.getModels()).toHaveLength(baseline + 2)
  })
})
