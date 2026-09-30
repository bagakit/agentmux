// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as monaco from 'monaco-editor/editor/editor.api.js'
import { loader } from '@monaco-editor/react'
import { EditorPane } from '../src/renderer/src/components/EditorPane'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab, documentKey, type FileWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'
import { composerConfig } from './helpers/composer-dom-fixture'

// Keep the installed React wrapper and real Monaco model registry/disposal events. Only the
// browser canvas is adapted: the DOM test host cannot paint Monaco, and the worker setup is Vite-only.
vi.mock('../src/renderer/src/monaco', () => ({}))
vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
})

type ViewState = { cursor: number; scrollTop: number }
type Canvas = Pick<monaco.editor.IStandaloneCodeEditor, 'getModel' | 'getValue' | 'setPosition' | 'getPosition' | 'setScrollTop' | 'dispose'> & {
  host: HTMLElement
  disposed: boolean
  saveViewState: () => ViewState
}
const canvases: Canvas[] = []
function createCanvas(host: HTMLElement, options: monaco.editor.IStandaloneEditorConstructionOptions): Canvas {
  let model: monaco.editor.ITextModel | null = null
  let change: monaco.IDisposable | undefined, disposing: monaco.IDisposable | undefined
  let viewState: ViewState = { cursor: 1, scrollTop: 0 }
  const disposed: Array<() => void> = []
  const contentListeners = new Set<(event: monaco.editor.IModelContentChangedEvent) => void>()
  const paint = () => { host.textContent = model?.getValue() ?? '' }
  const canvas = {
    host, disposed: false,
    getModel: () => model,
    getValue: () => model?.getValue() ?? '',
    setModel(next: monaco.editor.ITextModel | null) {
      change?.dispose(); disposing?.dispose(); model = next
      change = model?.onDidChangeContent(event => {
        paint()
        for (const listener of contentListeners) listener(event)
      })
      disposing = model?.onWillDispose(() => canvas.setModel(null))
      paint()
    },
    onDidChangeModelContent(listener: (event: monaco.editor.IModelContentChangedEvent) => void) {
      contentListeners.add(listener)
      return { dispose() { contentListeners.delete(listener) } }
    },
    executeEdits(_source: string, edits: monaco.editor.IIdentifiedSingleEditOperation[]) { model!.applyEdits(edits) },
    setValue(value: string) { model!.setValue(value) },
    pushUndoStop() {},
    getOption: () => false,
    updateOptions() {},
    saveViewState: () => ({ ...viewState }),
    restoreViewState(state: ViewState | null) { if (state) viewState = { ...state } },
    setPosition(position: monaco.IPosition) { viewState.cursor = position.lineNumber },
    getPosition: () => new monaco.Position(viewState.cursor, 1),
    setScrollTop(scrollTop: number) { viewState.scrollTop = scrollTop },
    revealLineInCenter() {},
    revealLine() {},
    getContainerDomNode: () => host,
    focus() { host.tabIndex = 0; host.focus() },
    addCommand: vi.fn(), addAction: vi.fn(),
    getAction: () => ({ run: vi.fn() }),
    createContextKey: () => ({ set() {} }),
    onDidChangeCursorSelection: () => ({ dispose() {} }),
    onDidDispose(listener: () => void) { disposed.push(listener); return { dispose() {} } },
    dispose() {
      canvas.disposed = true; change?.dispose(); disposing?.dispose()
      contentListeners.clear()
      for (const listener of disposed) listener()
    }
  }
  canvas.setModel(options.model ?? null); canvases.push(canvas)
  return canvas as unknown as Canvas
}

const initial = useAppStore.getState()
const content = '# Current unsaved Markdown\n\nA source that must stay visible.\n\nEnd of draft.'
const left: FileWorkbenchSurface = { kind: 'file', workspaceId: 'workspace', path: 'notes.md', regionId: 'left-region' }
const right: FileWorkbenchSurface = { ...left, regionId: 'right-region' }
let root: Root, container: HTMLDivElement, baseline: number

beforeAll(() => {
  loader.config({ monaco: {
    ...monaco,
    editor: { ...monaco.editor, create: ((host: HTMLElement, options: monaco.editor.IStandaloneEditorConstructionOptions) => createCanvas(host, options)) as unknown as typeof monaco.editor.create, setTheme() {} }
  } })
})
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  baseline = monaco.editor.getModels().length; canvases.length = 0
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  useAppStore.setState({ config: composerConfig, documents: { [documentKey('workspace', 'notes.md')]: { path: 'notes.md', content, revision: 'saved-revision' } },
    dirtyDocuments: { [documentKey('workspace', 'notes.md')]: true }, documentIssues: {}, savingDocuments: {}, documentRevealTargets: {},
    editorRegionModes: {}, editorRegionDiffs: {}, regionCaretFocus: null,
    tabs: { left: createWorkbenchTab('left', left), right: createWorkbenchTab('right', right) } })
})
afterEach(async () => {
  await act(async () => root.unmount())
  expect(monaco.editor.getModels()).toHaveLength(baseline)
  container.remove(); useAppStore.setState(initial, true); vi.unstubAllGlobals()
})

async function mount({ preview = false, neighbor = true, released = false, leftSurface = left }: { preview?: boolean; neighbor?: boolean; released?: boolean; leftSurface?: FileWorkbenchSurface } = {}) {
  await act(async () => root.render(<>
    <div data-view="left"><EditorPane tabId="left" surface={leftSurface} previewing={preview} preview={<p>Preview of current source</p>} released={released} /></div>
    {neighbor ? <div data-view="right"><EditorPane tabId="right" surface={right} /></div> : null}
  </>))
  // The actual loader resolves asynchronously, then the installed wrapper mounts its editor.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
function canvasAt(view: 'left' | 'right') {
  const target = container.querySelector(`[data-view="${view}"]`)!
  const canvas = [...canvases].reverse().find(item => !item.disposed && target.contains(item.host))
  expect(canvas, `A live actual-wrapper canvas in ${view}`).toBeDefined()
  return canvas!
}

describe('actual Monaco model lifetimes across File Regions', () => {
  it('switching one Region to Preview or closing it cannot dispose the same File in its neighbor; edits still share one TextDoc', async () => {
    await mount()
    const first = canvasAt('left'), second = canvasAt('right')
    expect([first.getValue(), second.getValue()]).toEqual([content, content])
    const firstModel = first.getModel()!, secondModel = second.getModel()!
    await mount({ preview: true })
    expect(second.getModel()?.isDisposed()).toBe(false); expect(second.getValue()).toBe(content)
    expect(firstModel).not.toBe(secondModel)
    expect(monaco.editor.getModels()).toHaveLength(baseline + 1)
    const next = content + '\nEdited from the neighbor.'
    await act(async () => second.getModel()!.setValue(next))
    expect(useAppStore.getState().documents[documentKey('workspace', 'notes.md')]).toEqual({ path: 'notes.md', content: next, revision: 'saved-revision' })
    expect(useAppStore.getState().dirtyDocuments[documentKey('workspace', 'notes.md')]).toBe(true)
    await mount(); expect(canvasAt('left').getValue()).toBe(next); expect(second.getValue()).toBe(next)
    await mount({ neighbor: false })
    expect(canvasAt('left').getValue()).toBe(next); expect(monaco.editor.getModels()).toHaveLength(baseline + 1)
    expect(Object.keys(useAppStore.getState().documents)).toEqual([documentKey('workspace', 'notes.md')])
  })

  it('each Region restores its own selection/reading position after Preview and release, with an explicit reveal taking precedence', async () => {
    await mount()
    canvasAt('left').setPosition({ lineNumber: 4, column: 1 }); canvasAt('left').setScrollTop(231)
    canvasAt('right').setPosition({ lineNumber: 2, column: 1 }); canvasAt('right').setScrollTop(49)
    await mount({ preview: true }); await mount()
    expect(canvasAt('left').saveViewState()).toEqual({ cursor: 4, scrollTop: 231 })
    expect(canvasAt('right').saveViewState()).toEqual({ cursor: 2, scrollTop: 49 })
    await mount({ released: true }); await mount()
    expect(canvasAt('left').saveViewState()).toEqual({ cursor: 4, scrollTop: 231 })
    await mount({ preview: true, neighbor: false })
    await act(async () => useAppStore.setState({ documentRevealTargets: { [documentKey('workspace', 'notes.md')]: { line: 3, column: 1 } } }))
    await mount({ neighbor: false })
    expect(canvasAt('left').getPosition()).toEqual({ lineNumber: 3, column: 1 })
    expect(useAppStore.getState().documentRevealTargets).toEqual({})
  })

  it('changing the same Region to another File disposes the old projection and does not restore the old selection into the new File', async () => {
    await mount({ neighbor: false })
    const old = canvasAt('left'), oldModel = old.getModel()!
    old.setPosition({ lineNumber: 4, column: 1 }); old.setScrollTop(231)
    const other: FileWorkbenchSurface = { ...left, path: 'another.md' }
    await act(async () => useAppStore.setState({ documents: { ...useAppStore.getState().documents, [documentKey('workspace', other.path)]: { path: other.path, content: '# Another file', revision: 'other-revision' } }, tabs: { left: createWorkbenchTab('left', other) } }))
    await mount({ neighbor: false, leftSurface: other })
    expect(old.disposed).toBe(true); expect(oldModel.isDisposed()).toBe(true)
    expect(canvasAt('left').getValue()).toBe('# Another file')
    expect(canvasAt('left').saveViewState()).toEqual({ cursor: 1, scrollTop: 0 })
    expect(monaco.editor.getModels()).toHaveLength(baseline + 1)
    expect(useAppStore.getState().documents[documentKey('workspace', 'notes.md')]?.content).toBe(content)
  })
})
