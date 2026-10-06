const { fixtureEpoch: _newTailFixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { emptyNotebookState } from '@agentmux/core/notebook-catalog'
import { api } from '../src/renderer/src/lib/api'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'
import type { Notebook, NotebookPage } from '@agentmux/core/notebook-catalog'
import type { AgentMuxSpaceMutationReport } from '@agentmux/core/control'
import type { AppConfig } from '../src/shared/contracts'
import type { NoteAgentTalkInput } from '../src/renderer/src/lib/note-agent-context'

// This fixture owns only the UI boundary. Store, context construction and Core launch are separate tests.
const fixture = vi.hoisted(() => ({ state: {} as ReturnType<typeof import('../src/renderer/src/store').useAppStore.getState>,
  talk: vi.fn<(input: NoteAgentTalkInput) => Promise<AgentMuxSpaceMutationReport>>(), inspect: vi.fn() }))
vi.mock('../src/renderer/src/store', () => ({ useAppStore: Object.assign(
  (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state),
  { getState: () => fixture.state, getInitialState: () => fixture.state, subscribe: () => () => {} }) }))
vi.mock('../src/renderer/src/lib/note-agent-context', () => ({ talkWithNoteAgent: fixture.talk }))
vi.mock('../src/renderer/src/lib/notebook-library', () => ({ notebookPageResourceMatches: () => true, changeNotebook: vi.fn() }))

import { createClientUiRoot } from './helpers/client-ui-render'
import { NotebookNavigation, NotebookHome } from '../src/renderer/src/components/NotebookNavigation'
import { NoteTalkAgent } from '../src/renderer/src/components/NoteTalkAgent'
import { resolveOverlayContainer } from '../src/renderer/src/components/WindowOverlayHost'

const book: Notebook = { notebookId: 'quick-notes', name: 'Notes', createdAt: 1 }
const page = (id: string): NotebookPage => ({ noteId: id, notebookId: book.notebookId, parentNoteId: null,
  title: `Note ${id}`, resource: { hostId: 'local', workspaceId: '__notes__', workspacePath: _hygiene_fixturePath("notes"), path: `${id}.note.md` }, createdAt: _newTailFixtureEpoch(0, 0, 1), updatedAt: _newTailFixtureEpoch(0, 0, 2), sources: [], topics: [] })
const a = page('A'), b = page('B')
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }], executors: {
  one: { label: 'First Agent', providerId: 'codex', command: 'first-agent', args: [], env: {}, injectAgentMuxGuide: true },
  two: { label: 'Second Agent', providerId: 'claude', command: 'second-agent', args: [], env: {}, injectAgentMuxGuide: true }
}, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }, workspaces: [{ id: '__notes__', name: 'Recall', hostId: 'local', path: _hygiene_fixturePath("notes"), kind: 'folder' }], appearance: { terminalTheme: 'graphite' } }
function report(requestId: string, outcome: 'unknown' | 'opened' = 'unknown'): AgentMuxSpaceMutationReport {
  return { requestId, outcome, from: null, to: null, agent: null, resource: null, save: { layoutApplied: true,
    localStorageWritten: false, storageFlushRequested: false, diskDurability: 'unconfirmed', reason: null }, issues: [] }
}
let root: Root, container: HTMLDivElement
const restoredFocus = vi.fn()
const opened = vi.fn(), talked = vi.fn(), activated = vi.fn(), dismissed = vi.fn(), selectedReference = vi.fn()
let controls: { target(page: NotebookPage | null): void; visible(value: boolean): void; external(value: boolean): void }
type Directory = 'sidebar' | 'tree' | 'cards' | 'graph'
function Harness({ directory = 'sidebar', initial = null, pages = [a, b] }: { directory?: Directory; initial?: NotebookPage | null; pages?: NotebookPage[] }) {
  const [target, setTarget] = useState(initial), [visible, setVisible] = useState(true), [external, setExternal] = useState(false)
  controls = { target: setTarget, visible: setVisible, external: setExternal }
  const returnFocus = useRef<HTMLElement | null>(null)
  const onTalk = (value: NotebookPage, invoker?: HTMLElement | null) => { talked(value, invoker); returnFocus.current = invoker ?? null; setTarget(value) }
  return <><div data-open-note={fixture.state.recallNoteId}>
    {directory === 'sidebar' ? <NotebookNavigation notebooks={[book]} pages={pages} selectedId={book.notebookId} selectedNoteId={fixture.state.recallNoteId}
      onSelect={() => {}} onOpen={opened} onTalk={onTalk} onCreateChild={() => {}} query="" onQuery={() => {}} onCreate={() => {}}
      pending={false} actions={null} archived={false} onArchivedChange={() => {}} />
      : <NotebookHome notebook={book} pages={pages} pending={false} onCreate={() => {}} onOpen={opened} onTalk={onTalk} query="" view={directory} />}
    </div><NoteTalkAgent page={target} notebook={book} visible={visible} onDismiss={() => { dismissed(); setTarget(null) }}
      onActivate={value => { activated(value); fixture.state.recallNoteId = value.noteId }} onSelectReference={selectedReference} onRestoreFocus={() => { restoredFocus(); returnFocus.current?.focus() }} /><button data-right-agent-input>Right Agent input</button>
    <Dialog.Root open={external}><Dialog.Portal container={resolveOverlayContainer()}><Dialog.Content aria-describedby={undefined}>
      <Dialog.Title>Later external focus owner</Dialog.Title><button data-external-focus>External focused control</button>
    </Dialog.Content></Dialog.Portal></Dialog.Root></>
}
async function render(directory: Directory = 'sidebar', initial: NotebookPage | null = null) { await act(async () => root.render(<Harness directory={directory} initial={initial} />)) }
function button(text: string) { const node = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === text || node.querySelector('strong')?.textContent === text); expect(node, `button ${text}`).toBeDefined(); return node! }
async function click(node: HTMLElement) { await act(async () => node.click()) }
async function rightClickB() {
  await vi.waitFor(() => expect([...container.querySelectorAll('button')].some(node => node.textContent?.trim() === b.title || node.querySelector('strong')?.textContent?.trim() === b.title)).toBe(true))
  const current = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === b.title || node.querySelector('strong')?.textContent?.trim() === b.title)!
  expect(current).toBeDefined()
  await act(async () => current.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 60, clientY: 90 })))
  await vi.waitFor(() => expect(document.querySelector('[role="menuitem"]')?.textContent).toBe('Talk with Agent'))
  return current
}
async function chooseTalk(keyboard = false) {
  const item = document.querySelector<HTMLElement>('[role="menuitem"]')!
  if (keyboard) await act(async () => { item.focus(); item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
  else await click(item)
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull())
}
async function escape() { await act(async () => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))) }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  for (const spy of [opened, talked, activated, dismissed, selectedReference, restoredFocus, fixture.talk, fixture.inspect]) spy.mockReset()
  fixture.state = { config, documents: {}, sessions: [], executorDetections: {}, hostExecutorInventories: {}, spatialRequests: {},
    noteCanvasLayouts: {}, noteCanvasSaveIssues: {}, saveNoteCanvasPresentation: vi.fn(async () => undefined), mainSurface: 'recall', recallNotebookId: book.notebookId, recallNoteId: 'A', recallZoneSelection: null, executeControl: fixture.inspect } as unknown as typeof fixture.state
  installNoteCanvasGeometry()
  const catalog = emptyNotebookState(); catalog.pages = { A: a, B: b }
  vi.spyOn(api.notebooks, 'graph').mockResolvedValue({ catalog, graph: { catalogRevision: catalog.revision, scope: { kind: 'catalog' }, scannedScope: 'catalog', completeness: 'unknown', observations: [a,b].map(page => ({ status: 'unknown', noteId: page.noteId, resource: page.resource, message: 'Original not read in this UI fixture' })), duplicateNoteIds: [], references: [], hierarchy: [] } })
  vi.spyOn(api.notebooks, 'onChange').mockImplementation(() => () => {})
  fixture.talk.mockImplementation(async input => report(input.requestId))
  fixture.inspect.mockResolvedValue({ operation: 'space.inspect', catalog: { spaces: [], zones: [], bindings: [], tabs: [], regions: [], locations: [] }, request: { known: false, report: null } })
  container = document.createElement('div'); document.body.appendChild(container); root = createClientUiRoot(container)
})
afterEach(async () => { await act(async () => { root.unmount(); await new Promise(resolve => setTimeout(resolve, 20)) }); document.body.replaceChildren(); vi.restoreAllMocks() })

it.each(['sidebar', 'tree', 'cards', 'graph'] as const)('keeps Note A open while the real %s context menu targets clicked Note B', async directory => {
  await render(directory); const invoker = await rightClickB()
  expect(opened).not.toHaveBeenCalled(); expect(talked).not.toHaveBeenCalled(); expect(fixture.state.recallNoteId).toBe('A')
  await chooseTalk(directory === 'tree')
  expect(talked).toHaveBeenCalledExactlyOnceWith(b, invoker)
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Discuss Note B')
  expect(opened).not.toHaveBeenCalled(); expect(activated).not.toHaveBeenCalled(); expect(fixture.talk).not.toHaveBeenCalled()
})

it.each(['ContextMenu', 'F10'] as const)('opens the exact Note menu with %s and cancels without a page click', async key => {
  await render()
  const invoker = [...container.querySelectorAll<HTMLButtonElement>('.survey-notebook-page')].find(node => node.title === b.title)!
  await act(async () => { invoker.focus(); invoker.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: key === 'F10', bubbles: true, cancelable: true })) })
  await vi.waitFor(() => expect(document.querySelector('[role="menuitem"]')?.textContent).toBe('Talk with Agent'))
  expect(opened).not.toHaveBeenCalled(); expect(talked).not.toHaveBeenCalled()
  await escape(); await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull())
  await vi.waitFor(() => expect(document.activeElement).toBe(invoker)); expect(fixture.talk).not.toHaveBeenCalled()
})

it('cancels the real right-click menu and executor dialog with Escape without opening or launching another Note', async () => {
  await render(); await rightClickB(); await escape()
  await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull())
  expect(talked).not.toHaveBeenCalled(); expect(opened).not.toHaveBeenCalled()
  const invoker = await rightClickB(); await chooseTalk(); await escape()
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
  expect(fixture.talk).not.toHaveBeenCalled(); expect(activated).not.toHaveBeenCalled(); expect(fixture.state.recallNoteId).toBe('A')
  await vi.waitFor(() => expect(document.activeElement).toBe(invoker))
  expect(restoredFocus).toHaveBeenCalledOnce()
})

it('starts only after an explicit Executor choice and passes the exact clicked Note to the existing helper', async () => {
  await render('cards'); await rightClickB(); await chooseTalk()
  expect(fixture.talk).not.toHaveBeenCalled()
  await click(button('Second Agent'))
  expect(fixture.talk).toHaveBeenCalledOnce(); expect(activated).toHaveBeenCalledExactlyOnceWith(b)
  const input = fixture.talk.mock.calls[0]![0]
  expect(input).toMatchObject({ page: b, notebook: book, executorId: 'two', requestId: expect.stringMatching(/^note-talk:B:/), onSelectReference: selectedReference })
  expect(input.authorize!()).toBe(true); expect(opened).not.toHaveBeenCalled()
})

it('retains unknown creation and only checks the same original operation after dismiss and reopen', async () => {
  await render(); await rightClickB(); await chooseTalk(); await click(button('First Agent'))
  const id = fixture.talk.mock.calls[0]![0].requestId
  await vi.waitFor(() => expect(button('Check Agent operation')).toBeDefined())
  expect(document.querySelector('[data-executor-id]')).toBeNull()
  await click(button('Check Agent operation')); await click(button('Check Agent operation'))
  expect(fixture.inspect).toHaveBeenCalledTimes(2)
  for (const [request] of fixture.inspect.mock.calls) expect(request).toMatchObject({ operation: 'space.inspect', target: { requestId: id } })
  await click(document.querySelector('[aria-label="Close Agent selection"]')!); await rightClickB(); await chooseTalk()
  expect(document.querySelector('[data-executor-id]')).toBeNull(); expect(button('Check Agent operation')).toBeDefined()
  expect(fixture.talk).toHaveBeenCalledOnce()
})

it('restores a retained spatial operation as Check instead of launching again', async () => {
  const id = 'note-talk:B:retained-original'
  fixture.state.spatialRequests = { [id]: { requestId: id, operation: 'agent.open', createAgent: true } as never }
  await render('tree', b)
  expect(document.querySelector('[data-executor-id]')).toBeNull()
  await click(button('Check Agent operation'))
  expect(fixture.inspect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operation: 'space.inspect', target: { requestId: id } }))
  expect(fixture.talk).not.toHaveBeenCalled(); expect(activated).not.toHaveBeenCalled()
})

it.each(['hidden', 'different Note'] as const)('keeps later %s navigation when the original Note helper resolves late', async mode => {
  let finish!: (value: AgentMuxSpaceMutationReport) => void
  fixture.talk.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  await render('graph'); await rightClickB(); await chooseTalk(); await click(button('First Agent'))
  const input = fixture.talk.mock.calls[0]![0]
  expect(input.authorize!()).toBe(true)
  await act(async () => {
    fixture.state.recallNoteId = 'A'
    if (mode === 'hidden') { fixture.state.mainSurface = 'workbench'; controls.visible(false) }
    else controls.target(a)
  })
  expect(input.authorize!()).toBe(false)
  const before = activated.mock.calls.length
  await act(async () => finish(report(input.requestId, 'opened')))
  expect(fixture.state.recallNoteId).toBe('A'); expect(activated).toHaveBeenCalledTimes(before)
  expect(selectedReference).not.toHaveBeenCalled(); expect(fixture.talk).toHaveBeenCalledOnce()
  if (mode === 'different Note') { expect(dismissed).not.toHaveBeenCalled(); expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Discuss Note A') }
})

it('preserves the right Agent focus after confirmed creation instead of restoring the old Note row', async () => {
  fixture.talk.mockImplementation(async input => report(input.requestId, 'opened'))
  await render('tree', b); await click(button('First Agent'))
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
  const right = button('Right Agent input'); await act(async () => right.focus())
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(restoredFocus).not.toHaveBeenCalled(); expect(document.activeElement).toBe(right)
  expect(fixture.talk).toHaveBeenCalledOnce()
})

it('requires a confirmed original receipt and an explicit Start another Agent before enabling another choice', async () => {
  await render('tree', b); await click(button('First Agent'))
  const id = fixture.talk.mock.calls[0]![0].requestId
  expect(document.querySelector('[data-executor-id]')).toBeNull()
  expect(document.body.textContent).not.toContain('Start another Agent')
  fixture.inspect.mockResolvedValue({ operation: 'space.inspect', request: { known: true, report: report(id, 'opened') } })
  await click(button('Check Agent operation'))
  expect(fixture.talk).toHaveBeenCalledOnce(); expect(document.querySelector('[data-executor-id]')).toBeNull()
  await click(button('Start another Agent'))
  expect(fixture.talk).toHaveBeenCalledOnce()
  await click(button('Second Agent'))
  expect(fixture.talk).toHaveBeenCalledTimes(2)
  expect(fixture.talk.mock.calls[1]![0]).toMatchObject({ page: b, executorId: 'two' })
  expect(fixture.talk.mock.calls[1]![0].requestId).not.toBe(id)
})

it('keeps a late Check result on its original Note without dismissing or activating the newer Note', async () => {
  await render('tree', b); await click(button('First Agent'))
  const id = fixture.talk.mock.calls[0]![0].requestId
  let finish!: (value: unknown) => void
  fixture.inspect.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  await click(button('Check Agent operation'))
  await act(async () => { fixture.state.recallNoteId = 'A'; controls.target(a) })
  const before = activated.mock.calls.length
  await act(async () => finish({ operation: 'space.inspect', request: { known: true, report: report(id, 'opened') } }))
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Discuss Note A')
  expect(dismissed).not.toHaveBeenCalled(); expect(activated).toHaveBeenCalledTimes(before)
  expect(fixture.talk).toHaveBeenCalledOnce(); expect(fixture.state.recallNoteId).toBe('A')
  await act(async () => controls.target(b))
  expect(button('Start another Agent')).toBeDefined()
  expect(fixture.inspect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operation: 'space.inspect', target: { requestId: id } }))
})


it('does not return to the old row when the same Note has a newer Recall location on Cancel', async () => {
  fixture.state.recallNoteId = 'B'
  const originalReference = { tabId: 'original-tab', regionId: 'original-file' }
  fixture.state.recallZoneSelection = { zoneId: 'note-zone', selection: [originalReference], active: originalReference }
  await render(); const invoker = await rightClickB(); await chooseTalk()
  const laterReference = { tabId: 'later-tab', regionId: 'later-file' }
  const laterSelection = { zoneId: 'note-zone', selection: [laterReference], active: laterReference }
  fixture.state.recallZoneSelection = laterSelection
  const close = document.querySelector<HTMLButtonElement>('[aria-label="Close Agent selection"]')!
  await act(async () => { close.focus(); close.click() })
  await vi.waitFor(() => expect(document.querySelector('.note-talk-dialog')).toBeNull())
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(fixture.state.recallNoteId).toBe('B'); expect(fixture.state.recallZoneSelection).toBe(laterSelection)
  expect(document.activeElement).not.toBe(invoker); expect(restoredFocus).not.toHaveBeenCalled()
  expect(fixture.talk).not.toHaveBeenCalled(); expect(activated).not.toHaveBeenCalled()
})

it('does not reclaim an external DOM focus owner when the original dialog is programmatically closed', async () => {
  await render(); const invoker = await rightClickB(); await chooseTalk()
  const originalDialog = document.querySelector<HTMLElement>('.note-talk-dialog')!
  const close = originalDialog.querySelector<HTMLButtonElement>('[aria-label="Close Agent selection"]')!
  // A later real modal owns focus and pauses the earlier Radix trap. No focus API or activeElement is mocked.
  await act(async () => controls.external(true))
  const external = document.querySelector<HTMLButtonElement>('[data-external-focus]')!
  await act(async () => external.focus())
  expect(document.activeElement).toBe(external); expect(originalDialog.contains(document.activeElement)).toBe(false)
  // Programmatic click intentionally does not focus Close, matching an external close request.
  await click(close)
  await vi.waitFor(() => expect(originalDialog.isConnected).toBe(false))
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(document.activeElement).toBe(external); expect(document.activeElement).not.toBe(invoker)
  expect(restoredFocus).not.toHaveBeenCalled(); expect(fixture.talk).not.toHaveBeenCalled(); expect(activated).not.toHaveBeenCalled()
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
  await chooseTalk()
  expect(talked).toHaveBeenCalledExactlyOnceWith(a, originalA)
  expect(originalA.isConnected).toBe(true); expect(originalB.isConnected).toBe(true)
  expect(opened).not.toHaveBeenCalled()
})
