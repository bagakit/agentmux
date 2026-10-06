import { fixtureEpoch as _tailRefreshFixtureEpoch } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { EventEmitter } from 'node:events'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LocalExecutionHost } from '@agentmux/core'
import { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import type { NotebookGraphSnapshot } from '../src/shared/notebook-observation'
import { createNotebookObservationServices } from '../src/main/notebook-observation-requests'
import { createPreloadNotebookObservation } from '../src/preload/notebook-observation'
import { createRendererNotebookObservation } from '../src/renderer/src/lib/notebook-observation-api'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { NoteCanvas } from '../src/renderer/src/components/NoteCanvas'
import { NoteLinksPanel } from '../src/renderer/src/components/NoteLinksPanel'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { noteCanvasScopeKey } from '../src/renderer/src/lib/note-canvas-state'
import { composerDOM } from './helpers/composer-dom-fixture'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'

const dom = composerDOM(), scope = { kind: 'note', noteId: 'target' } as const
let directory: string, store: AgentMuxNotebookStore
const body = (id: string, text: string, references = false) => JSON.stringify({ schema: 'agentmux.note.v1', noteId: id, content: { type: 'doc', content: [
  { type: 'paragraph', attrs: { blockId: id + '-block', provenance: { created: { actor: { kind: 'agent', id: 'ExactResearchSession' }, at: _tailRefreshFixtureEpoch(0, 1) }, lastEdited: { actor: { kind: 'agent', id: 'ExactResearchSession' }, at: _tailRefreshFixtureEpoch(0, 1) } } }, content: [{ type: 'text', text }] },
  ...references ? [
    ...[0, 1, 2].map(index => ({ type: 'blockReference', attrs: { blockId: 'source-reference-' + index, referenceId: 'original-reference-' + index, mode: index === 2 ? 'embed' : 'reference', target: { noteId: 'target', blockId: 'target-block' } } })),
    { type: 'paragraph', attrs: { blockId: 'source-inline' }, content: [
      { type: 'text', text: 'Original closed source links to ' },
      { type: 'noteLink', attrs: { referenceId: 'page-link', text: 'Original target', target: { noteId: 'target' } } },
      { type: 'text', text: ' and ' },
      { type: 'noteLink', attrs: { referenceId: 'heading-link', text: 'Original target #Heading', target: { noteId: 'target', blockId: 'target-block' } } },
      { type: 'text', text: ' plus [[Unconfirmed page]]' },
    ] },
  ] : []
] } })
beforeEach(async () => {
  installNoteCanvasGeometry()
  directory = await realpath(await mkdtemp(join(tmpdir(), 'amx-canvas-ui-')))
  const workspace = { id: 'notes', hostId: 'local', path: directory, name: 'Notes', kind: 'folder' as const }
  store = new AgentMuxNotebookStore(join(directory, 'notebooks.json'))
  for (const id of ['target', 'closed-source']) {
    await writeFile(join(directory, id + '.note.json'), body(id, 'Saved ' + id, id !== 'target'))
    await store.apply({ expectedRevision: (await store.read()).revision, operationId: 'register-' + id, change: { kind: 'register', noteId: id, title: 'Original ' + id, resource: { hostId: 'local', workspaceId: 'notes', workspacePath: directory, path: id + '.note.json' } } }, { kind: 'user', id: 'ui-test' })
  }
  const services = createNotebookObservationServices(store, { files: new WorkspaceFiles(() => new LocalExecutionHost()), workspace: () => workspace })
  const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false })
  const observation = createRendererNotebookObservation(createPreloadNotebookObservation(async (channel, input) => {
    if (channel === 'notebook:graph') return structuredClone(await services.requests.graph(sender, input))
    if (channel === 'notebook:content') return structuredClone(await services.requests.content(sender, input))
    if (channel === 'notebook:resolve') return structuredClone(await services.requests.resolve(sender, input))
    if (channel === 'notebook:cancelObservation') return services.requests.cancel(sender, input)
    throw new Error('Unexpected channel')
  }))
  vi.spyOn(api.notebooks, 'graph').mockImplementation(observation.graph)
  vi.spyOn(api.notebooks, 'content').mockImplementation(observation.content)
  vi.spyOn(api.notebooks, 'resolve').mockImplementation(observation.resolve)
  vi.spyOn(api.notebooks, 'onChange').mockImplementation(listener => store.subscribe(listener))
  useAppStore.setState({ noteCanvasLayouts: {}, noteCanvasSaveIssues: {}, documents: {}, dirtyDocuments: {} })
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })
async function ready() { await vi.waitFor(() => expect(dom.container.querySelectorAll('.note-canvas-title[data-note-id]')).toHaveLength(2)) }

it('renders incoming closed-file relationships through the original Main/preload/Renderer owner and opens exact bundled blocks', async () => {
  const open = vi.fn(), talk = vi.fn()
  await dom.render(<NoteCanvas scope={scope} onOpen={open} onTalk={talk} />); await ready()
  expect(dom.container.querySelector('.note-canvas-caption')!.textContent).toContain('2/2 originals read')
  expect(api.notebooks.graph).toHaveBeenCalledTimes(1); expect(api.notebooks.content).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(dom.container.querySelector('[aria-label="Inspect 2 block references"]')).not.toBeNull())
  await dom.click('[aria-label="Inspect 2 block references"]')
  const occurrences = dom.container.querySelectorAll('.note-canvas-inspector li')
  expect(occurrences).toHaveLength(2); expect(occurrences[1]!.textContent).toContain('Block reference'); expect(dom.container.querySelector('[aria-label="Inspect 1 block embed"]')).not.toBeNull()
  await act(async () => occurrences[1]!.querySelector<HTMLButtonElement>('.note-canvas-inspector-actions button')!.click())
  expect(open).toHaveBeenLastCalledWith((await store.read()).pages['closed-source'], 'source-reference-1')
  await act(async () => occurrences[0]!.querySelectorAll<HTMLButtonElement>('.note-canvas-inspector-actions button')[1]!.click())
  expect(open).toHaveBeenLastCalledWith((await store.read()).pages.target, 'target-block')
  const target = dom.container.querySelector<HTMLButtonElement>('[data-note-id="target"]')!
  await act(async () => { target.focus(); target.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })) })
  await vi.waitFor(() => expect(document.querySelector('[role="menuitem"]')?.textContent).toContain('Talk with Agent'))
  await act(async () => document.querySelector<HTMLElement>('[role="menuitem"]')!.click())
  await vi.waitFor(() => expect(talk).toHaveBeenCalledWith((expect.objectContaining({ noteId: 'target' })), target))
})

it('reads original blocks and authors only on explicit expansion, and opens a selected original block', async () => {
  const open = vi.fn()
  await dom.render(<NoteCanvas scope={scope} onOpen={open} />); await ready()
  await dom.click('[aria-label="Read saved body: Original target"]')
  await vi.waitFor(() => expect(dom.container.querySelector('.note-canvas-reader')?.textContent).toContain('Saved target'))
  const block = dom.container.querySelector<HTMLElement>('.note-canvas-reader [data-block-id="target-block"]')!
  expect(block.getAttribute('data-note-agent-author')).toBe('Agent ExactResearchSession')
  expect(block.title).toContain('Created: Agent ExactResearchSession')
  expect(dom.container.querySelector('.note-canvas-reader [contenteditable]')?.getAttribute('contenteditable')).toBe('false')
  await act(async () => block.click()); await dom.click('.note-canvas-open-block')
  expect(open).toHaveBeenLastCalledWith((await store.read()).pages.target, 'target-block')
  expect(api.notebooks.content).toHaveBeenCalledTimes(1); expect(api.notebooks.graph).toHaveBeenCalledTimes(1)
  await dom.click('[aria-label="Collapse saved body: Original target"]')
  expect(dom.container.querySelector('.note-canvas-reader')).toBeNull()
  expect((await store.read()).trail).toHaveLength(2)
})

it('keeps newer bytes out of an older card and refreshes explicitly without replacing graph truth with drafts', async () => {
  await dom.render(<NoteCanvas scope={scope} onOpen={() => {}} />); await ready()
  await writeFile(join(directory, 'target.note.json'), body('target', 'Later saved bytes'))
  await dom.click('[aria-label="Read saved body: Original target"]')
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Saved snapshot changed.'))
  expect(dom.container.querySelector('.note-canvas-reader')).toBeNull()
  await dom.click('.note-canvas-body-state button')
  await vi.waitFor(() => expect(dom.container.querySelector('.note-canvas-reader')?.textContent).toContain('Later saved bytes'))
  expect(api.notebooks.graph).toHaveBeenCalledTimes(2)
  const readCount = vi.mocked(api.notebooks.content).mock.calls.length
  await act(async () => useAppStore.setState({ documents: { 'notes\0target.note.json': { path: 'target.note.json', content: body('target', 'Unsaved draft is kept'), revision: 'draft' } }, dirtyDocuments: { 'notes\0target.note.json': true }, sessions: [...useAppStore.getState().sessions] }))
  expect(api.notebooks.graph).toHaveBeenCalledTimes(2); expect(api.notebooks.content).toHaveBeenCalledTimes(readCount)
  expect(dom.container.querySelector('.note-canvas-reader')?.textContent).toContain('Later saved bytes')
})

it('retains the last usable graph on failed refresh and aborts a hidden pending original observation', async () => {
  await dom.render(<NoteCanvas scope={scope} onOpen={() => {}} />); await ready()
  vi.mocked(api.notebooks.graph).mockRejectedValueOnce(new Error('Original reader unavailable'))
  await dom.click('[aria-label="Refresh saved graph"]')
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Original reader unavailable'))
  expect(dom.container.querySelectorAll('.note-canvas-title[data-note-id]')).toHaveLength(2)
  let pendingSignal: AbortSignal | undefined
  vi.mocked(api.notebooks.graph).mockImplementationOnce((_params, options) => new Promise<NotebookGraphSnapshot>((_resolve, reject) => { pendingSignal = options!.signal; pendingSignal!.addEventListener('abort', () => reject(pendingSignal!.reason), { once: true }) }))
  await dom.click('[aria-label="Refresh saved graph"]')
  expect(pendingSignal?.aborted).toBe(false)
  await dom.render(<NoteCanvas scope={scope} active={false} onOpen={() => {}} />)
  expect(pendingSignal?.aborted).toBe(true)
  expect(dom.container.querySelectorAll('.note-canvas-title[data-note-id]')).toHaveLength(2)
})

it('persists completed keyboard moves through the same presentation owner and restores the original coordinates on remount', async () => {
  await dom.render(<NoteCanvas scope={scope} onOpen={() => {}} />); await ready()
  const node = dom.container.querySelector<HTMLElement>('.react-flow__node[data-id="target"]')!
  await act(async () => { node.focus(); node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
  await act(async () => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })))
  const position = useAppStore.getState().noteCanvasLayouts[noteCanvasScopeKey(scope)]?.positions.target
  expect(position).toBeDefined(); expect(position!.x).toBeGreaterThan(0)
  const transform = node.style.transform
  await dom.render(null); await dom.render(<NoteCanvas scope={scope} onOpen={() => {}} />); await ready()
  expect(dom.container.querySelector<HTMLElement>('.react-flow__node[data-id="target"]')!.style.transform).toBe(transform)
  expect(useAppStore.getState().noteCanvasLayouts[noteCanvasScopeKey(scope)]!.positions.target).toEqual(position)
})

it('keeps a missing target explicit and inspects its registered original without guessing an exact block', async () => {
  await writeFile(join(directory, 'target.note.json'), body('target', 'Original target').replaceAll('target-block', 'another-original-block'))
  const open = vi.fn()
  await dom.render(<NoteCanvas scope={scope} onOpen={open} />); await ready()
  await vi.waitFor(() => expect(dom.container.querySelector('[aria-label="Inspect 2 block references"]')).not.toBeNull())
  await dom.click('[aria-label="Inspect 2 block references"]')
  expect(dom.container.querySelector('.note-canvas-inspector')?.textContent).toContain('Target missing.')
  expect(dom.container.querySelector('.note-canvas-inspector')?.textContent).not.toContain('Open target block')
  const original = [...dom.container.querySelectorAll<HTMLButtonElement>('.note-canvas-inspector-actions button')].find(button => button.textContent === 'Inspect registered original')!
  await act(async () => original.click())
  expect(open).toHaveBeenLastCalledWith((await store.read()).pages.target, undefined)
})

it('exposes exact page/block links and raw queries from the original saved graph without fabricating target nodes', async () => {
  const open = vi.fn()
  await dom.render(<NoteCanvas scope={scope} onOpen={open} />); await ready()
  await vi.waitFor(() => expect(dom.container.querySelector('[aria-label="Inspect 2 links"]')).not.toBeNull())
  await dom.click('[aria-label="Inspect 2 links"]')
  expect(dom.container.querySelectorAll('.note-canvas-edge-link')).toHaveLength(1)
  expect(dom.container.querySelector('.note-canvas-inspector')?.textContent).toContain('Page link')
  const targetPage = [...dom.container.querySelectorAll<HTMLButtonElement>('.note-canvas-inspector-actions button')].find(button => button.textContent === 'Open target page')!
  await act(async () => targetPage.click())
  expect(open).toHaveBeenLastCalledWith((await store.read()).pages.target, undefined)
  const targetBlock = [...dom.container.querySelectorAll<HTMLButtonElement>('.note-canvas-inspector-actions button')].find(button => button.textContent === 'Open target block')!
  await act(async () => targetBlock.click())
  expect(open).toHaveBeenLastCalledWith((await store.read()).pages.target, 'target-block')
  await dom.click('[aria-label="Inspect 1 unbound links in Original closed-source"]')
  expect(dom.container.querySelector('.note-canvas-inspector')?.textContent).toContain('[[Unconfirmed page]]')
  expect(dom.container.querySelectorAll('.note-canvas-title[data-note-id]')).toHaveLength(2)
  expect(dom.container.querySelector('.note-canvas-caption')?.textContent).toContain('1 visible unbound links')
  expect(api.notebooks.content).not.toHaveBeenCalled()
})

it('lazily discovers closed original backlinks and reads actual source text only after explicit source expansion', async () => {
  const open = vi.fn()
  await dom.render(<NoteLinksPanel noteId="target" selectedBlockId="target-block" onOpen={open} />)
  expect(api.notebooks.graph).not.toHaveBeenCalled(); expect(api.notebooks.content).not.toHaveBeenCalled()
  await dom.click('.note-links-toggle')
  await vi.waitFor(() => expect(dom.container.querySelector('.note-links-source-toggle')?.textContent).toContain('Original closed-source'))
  expect(dom.container.textContent).toContain('5 incoming · 0 outgoing')
  expect(dom.container.textContent).toContain('1 written link query elsewhere has no confirmed destination')
  expect(api.notebooks.content).not.toHaveBeenCalled()
  await dom.click('.note-links-source-toggle')
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Original closed source links to'))
  expect(dom.container.querySelectorAll('.note-links-occurrence')).toHaveLength(5)
  expect(dom.container.querySelectorAll('.note-links-block')).toHaveLength(4)
  expect([...dom.container.querySelectorAll('.note-links-excerpt')].filter(item => item.textContent?.includes('Original closed source links to'))).toHaveLength(1)
  const toPage = [...dom.container.querySelectorAll<HTMLButtonElement>('.note-links-actions button')].find(button => button.textContent === 'Open target page')!
  await act(async () => toPage.click())
  expect(open).toHaveBeenLastCalledWith((await store.read()).pages.target, undefined)
  const exactSource = [...dom.container.querySelectorAll<HTMLButtonElement>('.note-links-actions button')].filter(button => button.textContent === 'Open source block').at(-1)!
  await act(async () => exactSource.click())
  expect(open).toHaveBeenLastCalledWith((await store.read()).pages['closed-source'], 'source-inline')
  const only = [...dom.container.querySelectorAll<HTMLButtonElement>('.note-links-controls button')].find(button => button.textContent === 'Selected block only')!
  await act(async () => only.click())
  expect(dom.container.querySelectorAll('.note-links-occurrence')).toHaveLength(4)
  expect(dom.container.textContent).not.toContain('Page link')
  expect(api.notebooks.graph).toHaveBeenCalledTimes(1)
  expect(api.notebooks.content).toHaveBeenCalledTimes(1)
})

it('retains source occurrence evidence on a newer original and on failed refresh, then cancels hidden source reads', async () => {
  await dom.render(<NoteLinksPanel noteId="target" onOpen={() => {}} />)
  await dom.click('.note-links-toggle')
  await vi.waitFor(() => expect(dom.container.querySelector('.note-links-source-toggle')).not.toBeNull())
  await writeFile(join(directory, 'closed-source.note.json'), body('closed-source', 'New unrelated revision'))
  await dom.click('.note-links-source-toggle')
  await vi.waitFor(() => expect(dom.container.textContent).toContain('The saved source changed after this graph'))
  expect(dom.container.querySelectorAll('.note-links-occurrence')).toHaveLength(5)
  expect(dom.container.querySelector('.note-links-excerpt')).toBeNull()
  vi.mocked(api.notebooks.graph).mockRejectedValueOnce(new Error('Original catalog reader unavailable'))
  await dom.click('[aria-label="Refresh saved links"]')
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Original catalog reader unavailable'))
  expect(dom.container.querySelectorAll('.note-links-occurrence')).toHaveLength(5)
  let pending: AbortSignal | undefined
  vi.mocked(api.notebooks.content).mockImplementationOnce((_id, options) => new Promise((_resolve, reject) => { pending = options!.signal; pending!.addEventListener('abort', () => reject(pending!.reason), { once: true }) }))
  await dom.click('.note-links-source-toggle'); await dom.click('.note-links-source-toggle')
  expect(pending?.aborted).toBe(false)
  await dom.render(<NoteLinksPanel noteId="target" active={false} onOpen={() => {}} />)
  expect(pending?.aborted).toBe(true)
  expect(dom.container.querySelectorAll('.note-links-occurrence')).toHaveLength(5)
})

it('does not revive a cancelled Arrange when a later original graph adds another related Note', async () => {
  const workers: DelayedWorker[] = []
  class DelayedWorker {
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: (() => void) | null = null
    request: { id: string } | undefined
    constructor() { workers.push(this) }
    postMessage(request: { id: string }) { this.request = request }
    terminate() {}
  }
  vi.stubGlobal('Worker', DelayedWorker)
  const key = noteCanvasScopeKey(scope)
  useAppStore.setState({ noteCanvasLayouts: { [key]: { positions: { target: { x: 120, y: 80 }, 'closed-source': { x: 500, y: 80 } }, viewport: { x: 0, y: 0, zoom: 1 }, expandedNoteIds: ['target'], previewNoteIds: [] } } })
  await dom.render(<NoteCanvas scope={scope} onOpen={() => {}} />); await ready()
  const node = dom.container.querySelector<HTMLElement>('.react-flow__node[data-id="target"]')!
  await act(async () => { node.focus(); node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
  await dom.click('.note-canvas-tool-text')
  expect(workers).toHaveLength(1)
  await act(async () => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })))
  const manual = useAppStore.getState().noteCanvasLayouts[key]!.positions.target
  await writeFile(join(directory, 'new-child.note.json'), body('new-child', 'New saved related Note'))
  await act(async () => { await store.apply({ expectedRevision: (await store.read()).revision, operationId: 'later-child', change: { kind: 'register', noteId: 'new-child', parentNoteId: 'target', title: 'Later related child', resource: { hostId: 'local', workspaceId: 'notes', workspacePath: directory, path: 'new-child.note.json' } } }, { kind: 'user', id: 'ui-test' }) })
  await dom.click('[aria-label="Refresh saved graph"]')
  await vi.waitFor(() => expect(workers).toHaveLength(2))
  const later = workers[1]!
  await act(async () => later.onmessage?.({ data: { id: later.request!.id, positions: { target: { x: -900, y: -900 }, 'closed-source': { x: -500, y: -500 }, 'new-child': { x: 900, y: 900 } } } } as MessageEvent))
  expect(useAppStore.getState().noteCanvasLayouts[key]!.positions.target).toEqual(manual)
  expect(useAppStore.getState().noteCanvasLayouts[key]!.positions['closed-source']).toEqual({ x: 500, y: 80 })
  expect(useAppStore.getState().noteCanvasLayouts[key]!.positions['new-child']).toBeDefined()
})
