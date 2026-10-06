import { fixtureEpoch as _tailRefreshFixtureEpoch } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { EventEmitter } from 'node:events'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act } from 'react'
import { ReactFlowProvider, useReactFlow, useViewport } from '@xyflow/react'
import { noteCanvasScopeKey } from '../src/renderer/src/lib/note-canvas-state'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LocalExecutionHost } from '@agentmux/core'
import { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import type { NotebookGraphSnapshot } from '../src/shared/notebook-observation'
import { createNotebookObservationServices } from '../src/main/notebook-observation-requests'
import { createPreloadNotebookObservation } from '../src/preload/notebook-observation'
import { createRendererNotebookObservation } from '../src/renderer/src/lib/notebook-observation-api'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { NoteCanvas } from '../src/renderer/src/components/NoteCanvas'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM } from './helpers/composer-dom-fixture'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'
import { installNoteCanvasBlockRows } from './helpers/note-canvas-block-dom'

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
it('shows late related original blocks and actual reference/embed content without Read body or a graph rescan', async () => {
  installNoteCanvasBlockRows()
  const file = JSON.parse(body('target', 'The late decision is searchable'))
  file.content.content.unshift(...Array.from({ length: 14 }, (_, i) => ({ type: 'paragraph', attrs: { blockId: 'unrelated-' + i }, content: [{ type: 'text', text: 'Unrelated context ' + i }] })))
  await writeFile(join(directory, 'target.note.json'), JSON.stringify(file))
  const open = vi.fn()
  await dom.render(<NoteCanvas scope={scope} onOpen={open} />); await ready()
  await vi.waitFor(() => { const reader = dom.container.querySelector('.react-flow__node[data-id="target"] .note-canvas-reader'); expect(reader).not.toBeNull(); expect(reader!.textContent).toContain('The late decision is searchable') })
  const target = dom.container.querySelector('.react-flow__node[data-id="target"]')!
  expect(target.textContent).not.toContain('Unrelated context')
  await vi.waitFor(() => expect(dom.container.querySelector('.react-flow__node[data-id="closed-source"] .mobile-note-reference')?.textContent).toContain('The late decision is searchable'))
  expect(api.notebooks.content).toHaveBeenCalledTimes(2)
  expect(api.notebooks.graph).toHaveBeenCalledTimes(1)
  expect(target.querySelector('[data-note-agent-author]')?.getAttribute('data-note-agent-author')).toBe('Agent ExactResearchSession')
  expect(dom.container.querySelector('.note-canvas-reader [contenteditable]')?.getAttribute('contenteditable')).toBe('false')
  expect((await store.read()).trail).toHaveLength(2)
  const more = dom.container.querySelector<HTMLButtonElement>('.note-canvas-more')!
  expect(more.textContent).toBe('More 1 related blocks')
  expect(more.closest('.note-canvas-body')).toBeNull()
  expect(more.closest('.note-canvas-reading-actions')).not.toBeNull()
  await act(async () => more.click())
  await vi.waitFor(() => expect(dom.container.querySelector('.react-flow__node[data-id="closed-source"] .note-canvas-reader')?.textContent).toContain('Original closed source links to'))
  await dom.click('[aria-label="Full note: Original target"]')
  await vi.waitFor(() => expect(target.textContent).toContain('Unrelated context 0'))
  await dom.click('[aria-label="Show related blocks: Original target"]')
  await vi.waitFor(() => expect(target.textContent).not.toContain('Unrelated context'))
  expect(api.notebooks.content).toHaveBeenCalledTimes(2)
})

it('bounds default original reads and preserves an explicit continuation beyond the automatic budget', async () => {
  for (let i = 0; i < 6; i++) {
    const id = 'extra-' + i
    await writeFile(join(directory, id + '.note.json'), body(id, 'Readable related ' + i + ' [[Original target]]'))
    await store.apply({ expectedRevision: (await store.read()).revision, operationId: 'register-' + id, change: { kind: 'register', noteId: id, title: id, resource: { hostId: 'local', workspaceId: 'notes', workspacePath: directory, path: id + '.note.json' } } }, { kind: 'user', id: 'ui-test' })
  }
  const readOriginal = vi.mocked(api.notebooks.content).getMockImplementation()!
  let inFlight = 0, maximum = 0
  vi.mocked(api.notebooks.content).mockImplementation(async (...args) => { maximum = Math.max(maximum, ++inFlight); try { return await readOriginal(...args) } finally { inFlight-- } })
  await dom.render(<NoteCanvas scope={{ kind: 'notebook', notebookId: (await store.read()).pages.target!.notebookId }} onOpen={() => {}} />)
  await vi.waitFor(() => expect(api.notebooks.content).toHaveBeenCalledTimes(6))
  await vi.waitFor(() => expect(dom.container.querySelectorAll('.note-canvas-reader')).toHaveLength(6))
  expect(maximum).toBe(2)
  expect(vi.mocked(api.notebooks.content).mock.calls.every(([, options]) => options?.maxBytes === 256 * 1024)).toBe(true)
  const continuation = [...dom.container.querySelectorAll<HTMLButtonElement>('.note-canvas-body-state button')].find(button => button.textContent === 'Read related blocks')!
  expect(continuation).toBeDefined()
  const card = continuation.closest('.note-canvas-card')!
  expect(card.textContent).toContain('up to 6 notes')
  await act(async () => continuation.click())
  await vi.waitFor(() => expect(card.querySelector('.note-canvas-reader')).not.toBeNull())
  expect(api.notebooks.content).toHaveBeenCalledTimes(7)
  expect(vi.mocked(api.notebooks.content).mock.calls[6]![1]?.maxBytes).toBeUndefined()
  expect(api.notebooks.graph).toHaveBeenCalledTimes(1)
})

it('keeps a changed original out of both excerpts and confirmed reference documents until an explicit graph refresh', async () => {
  const readOriginal = vi.mocked(api.notebooks.content).getMockImplementation()!
  vi.mocked(api.notebooks.content).mockImplementation(async (id, options) => {
    if (id === 'target') await writeFile(join(directory, 'target.note.json'), body('target', 'Later revision is not the graph original'))
    return readOriginal(id, options)
  })
  await dom.render(<NoteCanvas scope={scope} onOpen={() => {}} />); await ready()
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Saved snapshot changed.'))
  expect(dom.container.querySelector('.react-flow__node[data-id="target"] .note-canvas-reader')).toBeNull()
  expect(dom.container.textContent).not.toContain('Later revision is not the graph original')
  expect(dom.container.querySelectorAll('.note-canvas-edge-label')).toHaveLength(4)
  vi.mocked(api.notebooks.content).mockImplementation(readOriginal)
  await dom.click('[aria-label="Refresh saved graph"]')
  await vi.waitFor(() => expect(dom.container.querySelector('.react-flow__node[data-id="target"] .note-canvas-reader')?.textContent).toContain('Later revision is not the graph original'))
  expect(api.notebooks.graph).toHaveBeenCalledTimes(2)
})

it('cancels only default observations on hide and never installs a late receipt into the hidden surface', async () => {
  const pending: { signal: AbortSignal; resolve(value: any): void }[] = []
  const readOriginal = vi.mocked(api.notebooks.content).getMockImplementation()!
  vi.mocked(api.notebooks.content).mockImplementation((id, options) => new Promise(resolve => { pending.push({ signal: options!.signal!, resolve: () => { void readOriginal(id, {}).then(resolve) } }) }))
  await dom.render(<NoteCanvas scope={scope} onOpen={() => {}} />); await ready()
  await vi.waitFor(() => expect(pending).toHaveLength(2))
  expect(pending.every(value => !value.signal.aborted)).toBe(true)
  await dom.render(<NoteCanvas scope={scope} active={false} onOpen={() => {}} />)
  expect(pending.every(value => value.signal.aborted)).toBe(true)
  await act(async () => { pending.forEach(value => value.resolve(null)); await new Promise(resolve => setTimeout(resolve, 25)) })
  expect(dom.container.querySelector('.note-canvas-reader')).toBeNull()
  expect(dom.container.querySelectorAll('.note-canvas-title')).toHaveLength(2)
  expect(api.notebooks.content).toHaveBeenCalledTimes(2)
})

function PanControls() {
  const flow = useReactFlow()
  return <><button className="pan-source" onClick={() => { void flow.setViewport({ x: -5000, y: 0, zoom: 1 }) }}>View source</button><button className="pan-target" onClick={() => { void flow.setViewport({ x: 0, y: 0, zoom: 1 }) }}>View target</button></>
}
it('reads only an on-screen needed original, admits a newly viewed note, and reuses already read originals when panning back', async () => {
  useAppStore.setState({ noteCanvasLayouts: { [noteCanvasScopeKey(scope)]: { positions: { target: { x: 0, y: 0 }, 'closed-source': { x: 5000, y: 0 } }, viewport: { x: 0, y: 0, zoom: 1 }, expandedNoteIds: ['target'], previewNoteIds: [] } } })
  await dom.render(<ReactFlowProvider><PanControls /><NoteCanvas scope={scope} onOpen={() => {}} /></ReactFlowProvider>); await ready()
  await vi.waitFor(() => expect(dom.container.querySelector('.react-flow__node[data-id="target"] .note-canvas-reader')).not.toBeNull())
  expect(vi.mocked(api.notebooks.content).mock.calls.map(([id]) => id)).toEqual(['target'])
  await dom.click('.pan-source')
  await vi.waitFor(() => expect(dom.container.querySelector('.react-flow__node[data-id="closed-source"] .note-canvas-reader')).not.toBeNull())
  await dom.click('.pan-target')
  expect(api.notebooks.content).toHaveBeenCalledTimes(2)
  expect(api.notebooks.graph).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().noteCanvasLayouts[noteCanvasScopeKey(scope)]!.positions['closed-source']).toEqual({ x: 5000, y: 0 })
})

it('keeps an oversized original readable through an explicit full-budget continuation without pretending an automatic excerpt was empty', async () => {
  await writeFile(join(directory, 'target.note.json'), body('target', 'Large original is readable. '.repeat(12000)))
  await dom.render(<NoteCanvas scope={scope} onOpen={() => {}} />); await ready()
  const target = dom.container.querySelector('.react-flow__node[data-id="target"]')!
  await vi.waitFor(() => expect(target.querySelector('.note-canvas-body-state button')).not.toBeNull())
  expect(target.querySelector('.note-canvas-reader')).toBeNull()
  expect(target.textContent).not.toContain('Empty block')
  expect(target.querySelector('.note-canvas-body-state')!.textContent!.length).toBeGreaterThan(30)
  await act(async () => target.querySelector<HTMLButtonElement>('.note-canvas-body-state button')!.click())
  await vi.waitFor(() => expect(target.querySelector('.note-canvas-reader')?.textContent).toContain('Large original is readable.'))
  const calls = vi.mocked(api.notebooks.content).mock.calls.filter(([id]) => id === 'target')
  expect(calls).toHaveLength(2)
  expect(calls[0]![1]?.maxBytes).toBe(256 * 1024)
  expect(calls[1]![1]?.maxBytes).toBeUndefined()
  expect(api.notebooks.graph).toHaveBeenCalledTimes(1)
})

function ViewportProbe() {
  const viewport = useViewport()
  return <output className="actual-flow-viewport">{JSON.stringify(viewport)}</output>
}
it('frames a fresh large graph at a readable zoom around the original focus and keeps saved viewpoints and explicit Fit authoritative', async () => {
  class LayoutWorker {
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror = null
    postMessage(request: { id: string; input: { nodes: { id: string }[] } }) {
      queueMicrotask(() => this.onmessage?.({ data: { id: request.id, positions: Object.fromEntries(request.input.nodes.map((node, index) => [node.id, { x: index * 2000, y: index * 1000 }])) } } as MessageEvent))
    }
    terminate() {}
  }
  vi.stubGlobal('Worker', LayoutWorker)
  for (let i = 0; i < 7; i++) {
    const id = 'wide-' + i
    await writeFile(join(directory, id + '.note.json'), body(id, 'Related ' + i + ' [[Original target]]'))
    await store.apply({ expectedRevision: (await store.read()).revision, operationId: 'register-' + id, change: { kind: 'register', noteId: id, title: id, resource: { hostId: 'local', workspaceId: 'notes', workspacePath: directory, path: id + '.note.json' } } }, { kind: 'user', id: 'ui-test' })
  }
  await dom.render(<ReactFlowProvider><ViewportProbe /><NoteCanvas scope={scope} onOpen={() => {}} /></ReactFlowProvider>)
  const viewport = () => JSON.parse(dom.container.querySelector('.actual-flow-viewport')!.textContent!)
  await vi.waitFor(() => expect(dom.container.querySelectorAll('.note-canvas-title')).toHaveLength(9))
  await vi.waitFor(() => expect(viewport()).toEqual({ x: 24, y: 24, zoom: 1 }))
  expect(dom.container.querySelector('.react-flow__node[data-id="target"] .note-canvas-reader')).not.toBeNull()
  await dom.click('[aria-label="Fit visible notes"]')
  await vi.waitFor(() => expect(viewport().zoom).toBeLessThan(.8))
  const saved = { x: 123, y: 84, zoom: .9 }
  await dom.render(null)
  useAppStore.setState({ noteCanvasLayouts: { [noteCanvasScopeKey(scope)]: { positions: { target: { x: 0, y: 0 }, 'closed-source': { x: 2000, y: 1000 } }, viewport: saved, expandedNoteIds: ['target'], previewNoteIds: [] } } })
  await dom.render(<ReactFlowProvider><ViewportProbe /><NoteCanvas scope={scope} onOpen={() => {}} /></ReactFlowProvider>)
  await vi.waitFor(() => expect(viewport()).toEqual(saved))
})

it('reads the exact saved source of an unbound query without inventing a destination or borrowing a first paragraph', async () => {
  await writeFile(join(directory, 'unbound.note.json'), JSON.stringify({ schema: 'agentmux.note.v1', noteId: 'unbound', content: { type: 'doc', content: [
    { type: 'paragraph', attrs: { blockId: 'unrelated' }, content: [{ type: 'text', text: 'Do not use this introduction' }] },
    { type: 'paragraph', attrs: { blockId: 'written-source' }, content: [{ type: 'text', text: 'The unanswered decision: [[Unregistered original]]' }] },
  ] } }))
  await store.apply({ expectedRevision: (await store.read()).revision, operationId: 'unbound-page', change: { kind: 'register', noteId: 'unbound', title: 'Unbound original', resource: { hostId: 'local', workspaceId: 'notes', workspacePath: directory, path: 'unbound.note.json' } } }, { kind: 'user', id: 'ui-test' })
  await dom.render(<NoteCanvas scope={{ kind: 'note', noteId: 'unbound' }} onOpen={() => {}} />)
  await vi.waitFor(() => expect(dom.container.querySelector('.note-canvas-reader')?.textContent).toContain('The unanswered decision'))
  expect(dom.container.querySelector('.note-canvas-reader')!.textContent).not.toContain('Do not use this introduction')
  expect(dom.container.querySelectorAll('.note-canvas-title')).toHaveLength(1)
  expect(dom.container.querySelector('.note-canvas-caption')?.textContent).toContain('1 visible unbound links')
  expect(api.notebooks.content).toHaveBeenCalledTimes(1)
})
