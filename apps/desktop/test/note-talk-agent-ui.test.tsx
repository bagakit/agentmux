const { fixtureEpoch: _newTailFixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { emptyNotebookState } from '@agentmux/core/notebook-catalog'
import { api } from '../src/renderer/src/lib/api'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'
import type { Notebook, NotebookPage } from '@agentmux/core/notebook-catalog'
import type { AppConfig } from '../src/shared/contracts'


// Menus remain a small UI boundary; the real Recall/Launcher consumer is covered by note-agent-context.test.ts.
const fixture = vi.hoisted(() => ({ state: {} as ReturnType<typeof import('../src/renderer/src/store').useAppStore.getState> }))
vi.mock('../src/renderer/src/store', () => ({ useAppStore: Object.assign(
  (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state),
  { getState: () => fixture.state, getInitialState: () => fixture.state, subscribe: () => () => {} }) }))
vi.mock('../src/renderer/src/lib/notebook-library', () => ({ notebookPageResourceMatches: () => true, changeNotebook: vi.fn() }))
import { createClientUiRoot } from './helpers/client-ui-render'
import { NotebookNavigation, NotebookHome } from '../src/renderer/src/components/NotebookNavigation'
const book: Notebook = { notebookId: 'quick-notes', name: 'Notes', createdAt: 1 }
const page = (id: string): NotebookPage => ({ noteId: id, notebookId: book.notebookId, parentNoteId: null,
  title: `Note ${id}`, resource: { hostId: 'local', workspaceId: '__notes__', workspacePath: _hygiene_fixturePath("notes"), path: `${id}.note.md` }, createdAt: _newTailFixtureEpoch(0, 0, 1), updatedAt: _newTailFixtureEpoch(0, 0, 2), sources: [], topics: [] })
const a = page('A'), b = page('B')
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }], executors: {
  one: { label: 'First Agent', providerId: 'codex', command: 'first-agent', args: [], env: {}, injectAgentMuxGuide: true },
  two: { label: 'Second Agent', providerId: 'claude', command: 'second-agent', args: [], env: {}, injectAgentMuxGuide: true }
}, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }, workspaces: [{ id: '__notes__', name: 'Recall', hostId: 'local', path: _hygiene_fixturePath("notes"), kind: 'folder' }], appearance: { terminalTheme: 'graphite' } }

let root: Root, container: HTMLDivElement
const opened = vi.fn(), talked = vi.fn()
type Directory = 'sidebar' | 'tree' | 'cards' | 'graph'
function Harness({ directory = 'sidebar', pages = [a,b] }: { directory?: Directory; pages?: NotebookPage[] }) {
  return directory === 'sidebar'
    ? <NotebookNavigation notebooks={[book]} pages={pages} selectedId={book.notebookId} selectedNoteId="A" onSelect={() => {}} onOpen={opened} onTalk={talked}
        onCreateChild={() => {}} query="" onQuery={() => {}} onCreate={() => {}} pending={false} actions={null} archived={false} onArchivedChange={() => {}} />
    : <NotebookHome notebook={book} pages={pages} pending={false} onCreate={() => {}} onOpen={opened} onTalk={talked} query="" view={directory} />
}
async function render(directory: Directory = 'sidebar') { await act(async () => root.render(<Harness directory={directory} />)) }
function button(text: string) { const node = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === text || node.querySelector('strong')?.textContent === text); expect(node).toBeDefined(); return node! }
async function rightClickB() {
  await vi.waitFor(() => expect([...container.querySelectorAll('button')].some(node => node.textContent?.trim() === b.title || node.querySelector('strong')?.textContent?.trim() === b.title)).toBe(true))
  const current = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === b.title || node.querySelector('strong')?.textContent?.trim() === b.title)!
  await act(async () => current.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 60, clientY: 90 })))
  await vi.waitFor(() => expect(document.querySelector('[role="menuitem"]')?.textContent).toBe('Talk with Agent'))
  return current
}
async function escape() { await act(async () => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))) }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); opened.mockReset(); talked.mockReset()
  fixture.state = { config, documents: {}, sessions: [], executorDetections: {}, hostExecutorInventories: {}, spatialRequests: {},
    noteCanvasLayouts: {}, noteCanvasSaveIssues: {}, saveNoteCanvasPresentation: vi.fn(async () => undefined), mainSurface: 'recall', recallNotebookId: book.notebookId, recallNoteId: 'A', recallZoneSelection: null } as unknown as typeof fixture.state
  installNoteCanvasGeometry()
  const catalog = emptyNotebookState(); catalog.pages = { A:a, B:b }
  vi.spyOn(api.notebooks, 'graph').mockResolvedValue({ catalog, graph: { catalogRevision: catalog.revision, scope: { kind: 'catalog' }, scannedScope: 'catalog', completeness: 'unknown', observations: [a,b].map(page => ({ status: 'unknown', noteId: page.noteId, resource: page.resource, message: 'Original not read in this UI fixture' })), duplicateNoteIds: [], references: [], hierarchy: [] } })
  vi.spyOn(api.notebooks, 'onChange').mockImplementation(() => () => {})
  container = document.createElement('div'); document.body.appendChild(container); root = createClientUiRoot(container)
})
afterEach(async () => { await act(async () => { root.unmount(); await new Promise(resolve => setTimeout(resolve, 20)) }); document.body.replaceChildren(); vi.restoreAllMocks() })

it.each(['sidebar','tree','cards','graph'] as const)('the real %s menu targets clicked Note B without first activating Note A or showing another chooser', async directory => {
  await render(directory); const invoker = await rightClickB()
  expect(opened).not.toHaveBeenCalled(); expect(talked).not.toHaveBeenCalled()
  await act(async () => document.querySelector<HTMLElement>('[role="menuitem"]')!.click())
  expect(talked).toHaveBeenCalledExactlyOnceWith(b, invoker)
  expect(opened).not.toHaveBeenCalled(); expect(fixture.state.recallNoteId).toBe('A')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it.each(['ContextMenu','F10'] as const)('opens the exact Note menu with %s and Escape cancels without a page action', async key => {
  await render()
  const invoker = [...container.querySelectorAll<HTMLButtonElement>('.survey-notebook-page')].find(node => node.title === b.title)!
  await act(async () => { invoker.focus(); invoker.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: key === 'F10', bubbles: true, cancelable: true })) })
  await vi.waitFor(() => expect(document.querySelector('[role="menuitem"]')?.textContent).toBe('Talk with Agent'))
  await escape(); await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull())
  await vi.waitFor(() => expect(document.activeElement).toBe(invoker))
  expect(opened).not.toHaveBeenCalled(); expect(talked).not.toHaveBeenCalled()
})

it.each(['sidebar', 'tree', 'cards', 'graph'] as const)('keeps closed %s menu input cost independent of 1/10/100 Note rows', async directory => {
  const add = document.addEventListener.bind(document), remove = document.removeEventListener.bind(document)
  const listeners = new Map<EventListenerOrEventListenerObject, EventListener>()
  let calls = 0
  vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
    const capture = typeof options === 'boolean' ? options : options?.capture
    if (type === 'keydown' && capture && listener) {
      const observed: EventListener = event => { calls++; if (typeof listener === 'function') listener.call(document, event); else listener.handleEvent(event) }
      listeners.set(listener, observed); add(type, observed, options)
    } else add(type, listener, options)
  })
  vi.spyOn(document, 'removeEventListener').mockImplementation((type, listener, options) => {
    const observed = listener && listeners.get(listener)
    if (type === 'keydown' && observed) { listeners.delete(listener!); remove(type, observed, options) }
    else remove(type, listener, options)
  })
  const input = document.createElement('input'); document.body.append(input)
  try {
    for (const count of [1, 10, 100]) {
      await act(async () => root.render(<Harness directory={directory} pages={Array.from({ length: count }, (_, index) => page(`row-${index}`))} />))
      expect(document.querySelector('[role="menu"]')).toBeNull()
      expect(listeners.size, `${count} rows share one menu listener`).toBe(1)
      await act(async () => { input.focus(); calls = 0; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true })) })
      expect(calls, `${count} rows must not amplify unrelated input`).toBe(1)
      expect(document.activeElement).toBe(input)
      await act(async () => root.render(null)); expect(listeners.size).toBe(0)
    }
  } finally { input.remove() }
})

it('shares the menu without replacing row DOM or confusing a later clicked Note', async () => {
  await render('cards')
  const originalA = button('Note A'), originalB = button('Note B')
  await rightClickB(); await escape()
  await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull())
  expect(button('Note A')).toBe(originalA); expect(button('Note B')).toBe(originalB)
  await act(async () => originalA.querySelector('strong')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 })))
  await act(async () => document.querySelector<HTMLElement>('[role="menuitem"]')!.click())
  expect(talked).toHaveBeenCalledExactlyOnceWith(a, originalA)
  expect(originalA.isConnected).toBe(true); expect(originalB.isConnected).toBe(true)
  expect(opened).not.toHaveBeenCalled()
})
