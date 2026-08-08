// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { monacoKeybindingConstants, editorPaneStoreState } from './helpers/editor-pane-store.js'

const fixture = vi.hoisted(() => ({
  state: {} as Record<string, any>,
  mount: null as null | ((editor: any, monaco: any) => void)
}))
vi.mock('../src/renderer/src/monaco.js', () => ({}))
vi.mock('@monaco-editor/react', () => ({
  default: ({ onMount }: { onMount: typeof fixture.mount }) => { fixture.mount = onMount; return null }
}))
vi.mock('../src/renderer/src/store.js', () => ({
  useAppStore: Object.assign((selector: (state: typeof fixture.state) => unknown) => selector(fixture.state), {
    getState: () => fixture.state
  })
}))
vi.mock('../src/renderer/src/lib/api.js', () => ({ api: { files: { reveal: vi.fn() } } }))
import { EditorPane } from '../src/renderer/src/components/EditorPane.js'

let root: Root
let container: HTMLDivElement
async function render(visible = true) {
  await act(async () => root.render(createElement(EditorPane, {
    tabId: 'tab', visible,
    surface: { regionId: 'region', kind: 'file', workspaceId: 'workspace', path: 'app.ts' }
  })))
}
function mount() {
  const editor = {
    focus: vi.fn(), addCommand: vi.fn(), addAction: vi.fn(),
    createContextKey: vi.fn(() => ({ set: vi.fn() })),
    onDidChangeCursorSelection: vi.fn(), onDidDispose: vi.fn(),
    revealLineInCenter: vi.fn(), setPosition: vi.fn()
  }
  expect(fixture.mount).toBeTypeOf('function')
  fixture.mount!(editor, monacoKeybindingConstants())
  return editor
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  fixture.state = {
    ...editorPaneStoreState(),
    documents: { ['workspace\0app.ts']: { path: 'app.ts', content: 'hello', revision: 'r1' } },
    regionCaretFocus: { regionId: 'region', nonce: 1 },
    clearRegionCaretFocus: vi.fn((nonce: number) => {
      if (fixture.state.regionCaretFocus?.nonce === nonce) fixture.state.regionCaretFocus = null
    })
  }
  fixture.mount = null
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})
describe('EditorPane asynchronous keyboard focus', () => {
  it('keeps the intent while Monaco loads, then focuses exactly once on mount', async () => {
    await render()
    expect(fixture.state.clearRegionCaretFocus).not.toHaveBeenCalled()
    expect(mount().focus).toHaveBeenCalledOnce()
    expect(fixture.state.regionCaretFocus).toBeNull()
  })
  it('does not replay an old request after pointer navigation while Monaco loads', async () => {
    await render()
    fixture.state.regionCaretFocus = null
    expect(mount().focus).not.toHaveBeenCalled()
  })
  it('does not steal a newer request addressed to another Region', async () => {
    await render()
    const newer = { regionId: 'other', nonce: 2 }
    fixture.state.regionCaretFocus = newer
    expect(mount().focus).not.toHaveBeenCalled()
    expect(fixture.state.regionCaretFocus).toBe(newer)
  })
  it('discards a hidden surface request without focusing', async () => {
    await render(false)
    expect(mount().focus).not.toHaveBeenCalled()
    expect(fixture.state.regionCaretFocus).toBeNull()
  })
})
