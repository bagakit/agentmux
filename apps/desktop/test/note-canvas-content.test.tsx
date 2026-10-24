import { recordMarkdownProvenance } from './helpers/note-markdown-provenance'
import { readNoteDocument } from '@agentmux/client-ui/note/note-document'
import { serializeNoteDocument } from '@agentmux/client-ui/note/note-document'
import { noteInlineLinkContent } from '@agentmux/client-ui/note/note-wikilinks'
import { fixtureEpoch as _tailRefreshFixtureEpoch } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act } from 'react'
import { ReactFlowProvider, useReactFlow, useViewport } from '@xyflow/react'
import { noteCanvasScopeKey } from '../src/renderer/src/lib/note-canvas-state'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab, documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { composerConfig } from './helpers/composer-dom-fixture'
import { directoryIdentity, homeZoneId } from '../src/shared/space-addresses'
import { LocalExecutionHost } from '@agentmux/core'
import { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import type { NotebookGraphSnapshot } from '../src/shared/notebook-observation'
import { createNotebookObservationServices } from '../src/main/notebook-observation-requests'
import { createPreloadNotebookObservation } from '../src/preload/notebook-observation'
import { createRendererNotebookObservation } from '../src/renderer/src/lib/notebook-observation-api'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { useNoteCanvasContent } from '../src/renderer/src/lib/use-note-canvas-content'
import { NoteCanvas } from '../src/renderer/src/components/NoteCanvas'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM } from './helpers/composer-dom-fixture'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'
import { noteSummaryCases, noteSummaryContent } from './helpers/note-summary-fixture'
import { noteBlockFingerprint } from '@agentmux/client-ui/note/note-share-range'
import { NoteSnapshotTestWorker } from './note-snapshot-test-worker'

const dom = composerDOM(), scope = { kind: 'notebook', notebookId: 'quick-notes' } as const
const noteReaderText = (noteId: string) => [...dom.container.querySelectorAll<HTMLElement>(`.note-canvas-block-node[data-note-id="${noteId}"] .note-canvas-reader, .react-flow__node[data-id="${noteId}"] .note-canvas-reader`)].map(el => el.textContent ?? '').join(' ')
const hasNoteReader = (noteId: string) => dom.container.querySelector(`.note-canvas-block-node[data-note-id="${noteId}"] .note-canvas-reader, .react-flow__node[data-id="${noteId}"] .note-canvas-reader`) !== null
let directory: string, store: AgentMuxNotebookStore, files: WorkspaceFiles
const body = (id: string, text: string, references = false) => serializeNoteDocument({ schema: 'agentmux.note.v1', noteId: id, content: { type: 'doc', content: [
  { type: 'paragraph', attrs: { blockId: id + '-block', provenance: { created: { actor: { kind: 'agent', id: 'ExactResearchSession' }, at: _tailRefreshFixtureEpoch(0, 1) }, lastEdited: { actor: { kind: 'agent', id: 'ExactResearchSession' }, at: _tailRefreshFixtureEpoch(0, 1) } } }, content: [{ type: 'text', text }] },
  ...references ? [
    ...[0, 1, 2].map(index => ({ type: 'blockReference', attrs: { blockId: 'source-reference-' + index, referenceId: 'original-reference-' + index, mode: index === 2 ? 'embed' : 'reference', target: { noteId: 'target', blockId: 'target-block' } } })),
    { type: 'paragraph', attrs: { blockId: 'source-inline' }, content: [
      { type: 'text', text: 'Original closed source links to ' },
      noteInlineLinkContent({ referenceId: 'page-link', text: 'Original target', target: { noteId: 'target' } }),
      { type: 'text', text: ' and ' },
      noteInlineLinkContent({ referenceId: 'heading-link', text: 'Original target #Heading', target: { noteId: 'target', blockId: 'target-block' } }),
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
    const content = body(id, 'Saved ' + id, id !== 'target')
    await writeFile(join(directory, id + '.note.md'), content)
    await recordMarkdownProvenance(store, { hostId: 'local', workspaceId: 'notes', workspacePath: directory, path: id + '.note.md' }, content, { kind: 'agent', id: 'ExactResearchSession' })
    await store.apply({ expectedRevision: (await store.read()).revision, operationId: 'register-' + id, change: { kind: 'register', noteId: id, title: 'Original ' + id, resource: { hostId: 'local', workspaceId: 'notes', workspacePath: directory, path: id + '.note.md' } } }, { kind: 'user', id: 'ui-test' })
  }
  const services = createNotebookObservationServices(store, { files: files = new WorkspaceFiles(() => new LocalExecutionHost()), workspace: () => workspace })
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
afterEach(async () => { await rm(directory, { recursive: true, force: true }); vi.unstubAllGlobals() })
async function ready() { await vi.waitFor(() => expect(dom.container.querySelectorAll('.note-canvas-title[data-note-id]')).toHaveLength(2)) }
it('shows late related original blocks and actual reference/embed content without Read body or a graph rescan', async () => {
  const file = noteFromMarkdown(body('target', 'The late decision is searchable'))
  file.content.content!.unshift(...Array.from({ length: 14 }, (_, i) => ({ type: 'paragraph', attrs: { blockId: 'unrelated-' + i }, content: [{ type: 'text', text: 'Unrelated context ' + i }] })))
  const content = serializeNoteDocument(file)
  await writeFile(join(directory, 'target.note.md'), content)
  await recordMarkdownProvenance(store, { hostId: 'local', workspaceId: 'notes', workspacePath: directory, path: 'target.note.md' }, content, { kind: 'agent', id: 'ExactResearchSession' })
  const open = vi.fn()
  await dom.render(<NoteCanvas scope={scope} seedNoteIds={['target']} onOpen={open} />); await ready()
  await vi.waitFor(() => expect(noteReaderText('target')).toContain('The late decision is searchable'))
  expect(noteReaderText('target')).not.toContain('Unrelated context')
  await vi.waitFor(() => expect(dom.container.querySelector('.note-canvas-block-node[data-note-id="closed-source"] .mobile-note-reference')?.textContent).toContain('The late decision is searchable'))
  expect(api.notebooks.content).toHaveBeenCalledTimes(2)
  expect(api.notebooks.graph).toHaveBeenCalledTimes(1)
  expect(dom.container.querySelector('.note-canvas-block-node[data-note-id="target"] [data-author-block]')?.textContent).toBe('')
  expect(dom.container.querySelector('.note-canvas-block-node[data-note-id="target"] [data-author-block]')?.getAttribute('aria-label')).toContain('Agent · ExactRes…')
  expect(dom.container.querySelector('.note-canvas-reader [contenteditable]')?.getAttribute('contenteditable')).toBe('false')
  expect((await store.read()).trail).toHaveLength(2)
  const more = dom.container.querySelector<HTMLButtonElement>('.note-canvas-more')!
  expect(more.textContent).toBe('More 1 related blocks')
  expect(more.closest('.note-canvas-body')).toBeNull()
  expect(more.closest('.note-canvas-reading-actions')).not.toBeNull()
  await act(async () => more.click())
  await vi.waitFor(() => expect(noteReaderText('closed-source')).toContain('Original closed source links to'))
  await dom.click('[aria-label="Full note: Original target"]')
  await vi.waitFor(() => expect(noteReaderText('target')).toContain('Unrelated context 0'))
  await dom.click('[aria-label="Show related blocks: Original target"]')
  await vi.waitFor(() => expect(noteReaderText('target')).not.toContain('Unrelated context'))
  expect(api.notebooks.content).toHaveBeenCalledTimes(2)
})

it('bounds default original reads and preserves an explicit continuation beyond the automatic budget', async () => {
  for (let i = 0; i < 6; i++) {
    const id = 'extra-' + i
    await writeFile(join(directory, id + '.note.md'), body(id, 'Readable related ' + i + ' [[Original target]]'))
    await store.apply({ expectedRevision: (await store.read()).revision, operationId: 'register-' + id, change: { kind: 'register', noteId: id, title: id, resource: { hostId: 'local', workspaceId: 'notes', workspacePath: directory, path: id + '.note.md' } } }, { kind: 'user', id: 'ui-test' })
  }
  const readOriginal = vi.mocked(api.notebooks.content).getMockImplementation()!
  let inFlight = 0, maximum = 0
  vi.mocked(api.notebooks.content).mockImplementation(async (...args) => { maximum = Math.max(maximum, ++inFlight); try { return await readOriginal(...args) } finally { inFlight-- } })
  await dom.render(<NoteCanvas scope={{ kind: 'notebook', notebookId: (await store.read()).pages.target!.notebookId }} onOpen={() => {}} />)
  await vi.waitFor(() => expect(api.notebooks.content).toHaveBeenCalledTimes(6))
  await vi.waitFor(() => expect(dom.container.querySelectorAll('.note-canvas-block-node .note-canvas-reader').length).toBeGreaterThanOrEqual(6))
  expect(maximum).toBe(2)
  expect(vi.mocked(api.notebooks.content).mock.calls.every(([, options]) => options?.maxBytes === 256 * 1024)).toBe(true)
  const continuation = [...dom.container.querySelectorAll<HTMLButtonElement>('.note-canvas-body-state button')].find(button => button.textContent === 'Read related blocks')!
  expect(continuation).toBeDefined()
  const card = continuation.closest<HTMLElement>('.note-canvas-card')!
  const noteId = card.querySelector<HTMLElement>('[data-note-id]')!.dataset.noteId!
  expect(card.textContent).toContain('current view')
  await act(async () => continuation.click())
  await vi.waitFor(() => expect(hasNoteReader(noteId)).toBe(true))
  expect(api.notebooks.content).toHaveBeenCalledTimes(7)
  expect(vi.mocked(api.notebooks.content).mock.calls[6]![1]?.maxBytes).toBeUndefined()
  expect(api.notebooks.graph).toHaveBeenCalledTimes(1)
})

it('keeps a changed original out of both excerpts and confirmed reference documents until an explicit graph refresh', async () => {
  const readOriginal = vi.mocked(api.notebooks.content).getMockImplementation()!
  vi.mocked(api.notebooks.content).mockImplementation(async (id, options) => {
    if (id === 'target') await writeFile(join(directory, 'target.note.md'), body('target', 'Later revision is not the graph original'))
    return readOriginal(id, options)
  })
  await dom.render(<NoteCanvas scope={scope} seedNoteIds={['target']} onOpen={() => {}} />); await ready()
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Saved snapshot changed.'))
  expect(hasNoteReader('target')).toBe(false)
  expect(dom.container.textContent).not.toContain('Later revision is not the graph original')
  expect(dom.container.querySelectorAll('.note-canvas-edge-label')).toHaveLength(5)
  vi.mocked(api.notebooks.content).mockImplementation(readOriginal)
  await dom.click('[aria-label="Refresh saved graph"]')
  await vi.waitFor(() => expect(noteReaderText('target')).toContain('Later revision is not the graph original'))
  expect(api.notebooks.graph).toHaveBeenCalledTimes(2)
})

it('cancels only default observations on hide and never installs a late receipt into the hidden surface', async () => {
  const pending: { signal: AbortSignal; resolve(value: any): void }[] = []
  const readOriginal = vi.mocked(api.notebooks.content).getMockImplementation()!
  vi.mocked(api.notebooks.content).mockImplementation((id, options) => new Promise(resolve => { pending.push({ signal: options!.signal!, resolve: () => { void readOriginal(id, {}).then(resolve) } }) }))
  await dom.render(<NoteCanvas scope={scope} seedNoteIds={['target']} onOpen={() => {}} />); await ready()
  await vi.waitFor(() => expect(pending).toHaveLength(2))
  expect(pending.every(value => !value.signal.aborted)).toBe(true)
  await dom.render(<NoteCanvas scope={scope} seedNoteIds={['target']} active={false} onOpen={() => {}} />)
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
  await dom.render(<ReactFlowProvider><PanControls /><NoteCanvas scope={scope} seedNoteIds={['target']} onOpen={() => {}} /></ReactFlowProvider>); await ready()
  await vi.waitFor(() => expect(hasNoteReader('target')).toBe(true))
  expect(vi.mocked(api.notebooks.content).mock.calls.map(([id]) => id)).toEqual(['target'])
  await dom.click('.pan-source')
  await vi.waitFor(() => expect(hasNoteReader('closed-source')).toBe(true))
  await dom.click('.pan-target')
  expect(api.notebooks.content).toHaveBeenCalledTimes(2)
  expect(api.notebooks.graph).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().noteCanvasLayouts[noteCanvasScopeKey(scope)]!.positions['closed-source']).toEqual({ x: 5000, y: 0 })
})

it('keeps an oversized original readable through an explicit full-budget continuation without pretending an automatic excerpt was empty', async () => {
  await writeFile(join(directory, 'target.note.md'), body('target', 'Large original is readable. '.repeat(12000)))
  await dom.render(<NoteCanvas scope={scope} seedNoteIds={['target']} onOpen={() => {}} />); await ready()
  const target = dom.container.querySelector('.react-flow__node[data-id="target"]')!
  await vi.waitFor(() => expect(target.querySelector('.note-canvas-body-state button')).not.toBeNull())
  expect(hasNoteReader('target')).toBe(false)
  expect(target.textContent).not.toContain('Empty block')
  expect(target.querySelector('.note-canvas-body-state')!.textContent!.length).toBeGreaterThan(30)
  await act(async () => target.querySelector<HTMLButtonElement>('.note-canvas-body-state button')!.click())
  await vi.waitFor(() => expect(noteReaderText('target')).toContain('Large original is readable.'))
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
    await writeFile(join(directory, id + '.note.md'), body(id, 'Related ' + i + ' [[Original target]]'))
    await store.apply({ expectedRevision: (await store.read()).revision, operationId: 'register-' + id, change: { kind: 'register', noteId: id, title: id, resource: { hostId: 'local', workspaceId: 'notes', workspacePath: directory, path: id + '.note.md' } } }, { kind: 'user', id: 'ui-test' })
  }
  await dom.render(<ReactFlowProvider><ViewportProbe /><NoteCanvas scope={scope} seedNoteIds={['target']} onOpen={() => {}} /></ReactFlowProvider>)
  const viewport = () => JSON.parse(dom.container.querySelector('.actual-flow-viewport')!.textContent!)
  await vi.waitFor(() => expect(dom.container.querySelectorAll('.note-canvas-title')).toHaveLength(9))
  await vi.waitFor(() => expect(viewport()).toEqual({ x: 24, y: 24, zoom: 1 }))
  await vi.waitFor(() => expect(hasNoteReader('target')).toBe(true))
  await dom.click('[aria-label="Fit visible notes"]')
  await vi.waitFor(() => expect(viewport().zoom).toBeLessThan(.8))
  const saved = { x: 123, y: 84, zoom: .9 }
  await dom.render(null)
  useAppStore.setState({ noteCanvasLayouts: { [noteCanvasScopeKey(scope)]: { positions: { target: { x: 0, y: 0 }, 'closed-source': { x: 2000, y: 1000 } }, viewport: saved, expandedNoteIds: ['target'], previewNoteIds: [] } } })
  await dom.render(<ReactFlowProvider><ViewportProbe /><NoteCanvas scope={scope} seedNoteIds={['target']} onOpen={() => {}} /></ReactFlowProvider>)
  await vi.waitFor(() => expect(viewport()).toEqual(saved))
  // A restored view can appear before the graph, layout reply and queued first frame.
  await vi.waitFor(() => expect(dom.container.querySelectorAll('.note-canvas-title')).toHaveLength(9))
  await vi.waitFor(() => expect(hasNoteReader('target')).toBe(true))
  await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))) })
  expect(viewport()).toEqual(saved)
})

it('reads the exact saved source of an unbound query without inventing a destination or borrowing a first paragraph', async () => {
  await writeFile(join(directory, 'unbound.note.md'), serializeNoteDocument({ schema: 'agentmux.note.v1', noteId: 'unbound', content: { type: 'doc', content: [
    { type: 'paragraph', attrs: { blockId: 'unrelated' }, content: [{ type: 'text', text: 'Do not use this introduction' }] },
    { type: 'paragraph', attrs: { blockId: 'written-source' }, content: [{ type: 'text', text: 'The unanswered decision: [[Unregistered original]]' }] },
  ] } }))
  await store.apply({ expectedRevision: (await store.read()).revision, operationId: 'unbound-page', change: { kind: 'register', noteId: 'unbound', title: 'Unbound original', resource: { hostId: 'local', workspaceId: 'notes', workspacePath: directory, path: 'unbound.note.md' } } }, { kind: 'user', id: 'ui-test' })
  await dom.render(<NoteCanvas scope={scope} seedNoteIds={['unbound']} onOpen={() => {}} />)
  await vi.waitFor(() => expect(dom.container.querySelector('.note-canvas-reader')?.textContent).toContain('The unanswered decision'))
  expect(dom.container.querySelector('.note-canvas-reader')!.textContent).not.toContain('Do not use this introduction')
  expect(dom.container.querySelectorAll('.note-canvas-title')).toHaveLength(1)
  expect(dom.container.querySelector('.note-canvas-caption')?.textContent).toContain('1 visible unbound links')
  expect(api.notebooks.content).toHaveBeenCalledTimes(1)
})

it.each([900, 640, 520])('keeps the direct incoming source and body visible on first entry at %ipx without Fit or changing positions', async width => {
  class IncomingLayoutWorker {
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror = null
    postMessage(request: { id: string }) { queueMicrotask(() => this.onmessage?.({ data: { id: request.id, positions: { target: { x: 400, y: 0 }, 'closed-source': { x: 0, y: 0 } } } } as MessageEvent)) }
    terminate() {}
  }
  vi.stubGlobal('Worker', IncomingLayoutWorker)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('react-flow__node') ? 288 : width })
  await dom.render(<ReactFlowProvider><ViewportProbe /><NoteCanvas scope={scope} seedNoteIds={['target']} onOpen={() => {}} /></ReactFlowProvider>); await ready()
  await vi.waitFor(() => {
    const viewport = JSON.parse(dom.container.querySelector('.actual-flow-viewport')!.textContent!)
    expect(viewport.zoom).toBeGreaterThanOrEqual(.85)
    expect(viewport.zoom).toBeLessThanOrEqual(1)
    // Actual original Flow viewport must expose readable width of the incoming card.
    expect(Math.min(width, 288 * viewport.zoom + viewport.x) - Math.max(0, viewport.x)).toBeGreaterThan(100)
    expect(400 * viewport.zoom + viewport.x).toBeGreaterThanOrEqual(24)
    expect((400 + 320) * viewport.zoom + viewport.x).toBeLessThanOrEqual(width + 8)
    if (width === 900) expect(viewport).toEqual({ x: 24, y: 24, zoom: 1 })
  })
  await vi.waitFor(() => expect(sourceCardContent()).toContain('Saved target'))
  expect(useAppStore.getState().noteCanvasLayouts[noteCanvasScopeKey(scope)]!.positions.target).toEqual({ x: 400, y: 0 })
  expect(api.notebooks.graph).toHaveBeenCalledTimes(1)
  function sourceCardContent() { return noteReaderText('closed-source') }
})

function noteFromMarkdown(content:string) { const read=readNoteDocument(content);expect(read.status).toBe('valid');if(read.status!=='valid')throw Error(read.message);return read.note }

it('automatically summarizes an unrelated unanchored page without creating paragraph entities', async () => {
  const note = noteFromMarkdown(body('target', 'Unused'))
  note.content.content = ['Opening context', 'Second useful paragraph', 'Third useful paragraph', 'Fourth kept in original'].map(text => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
  await writeFile(join(directory, 'target.note.md'), serializeNoteDocument(note))
  await writeFile(join(directory, 'closed-source.note.md'), body('closed-source', 'No links here'))
  await dom.render(<NoteCanvas scope={scope} seedNoteIds={['target']} onOpen={() => {}} />)
  await vi.waitFor(() => expect(dom.container.querySelector('.note-canvas-reader')?.textContent).toContain('Opening context'))
  const target = dom.container.querySelector('.react-flow__node[data-id="target"]')!
  expect(target.querySelector('[data-reading-mode="summary"]')).not.toBeNull()
  expect(target.textContent).toContain('Third useful paragraph')
  expect(target.textContent).not.toContain('Fourth kept in original')
  expect(dom.container.querySelectorAll('.react-flow__node')).toHaveLength(1)
  expect(api.notebooks.content).toHaveBeenCalledTimes(1)
  await dom.click('[aria-label="Full note: Original target"]')
  await vi.waitFor(() => expect(target.textContent).toContain('Fourth kept in original'))
  expect(api.notebooks.content).toHaveBeenCalledTimes(1)
})

async function sharedGraphFixture(duplicate = false) {
  const shared = noteFromMarkdown(body('shared-content', 'Reusable research conclusion'))
  shared.kind = 'shared-block'
  shared.title = 'Research conclusion'
  shared.content.content!.push({ type: 'paragraph', attrs: { blockId: 'shared-child' }, content: [{ type: 'text', text: 'Precise evidence inside shared content' }] })
  const sharedContent = serializeNoteDocument(shared)
  await writeFile(join(directory, 'block-shared.note.md'), sharedContent)
  if (duplicate) await writeFile(join(directory, 'duplicate-shared.note.md'), sharedContent)
  for (const id of ['target', 'closed-source']) {
    const note = noteFromMarkdown(body(id, 'Host ordinary paragraph'))
    note.content.content!.push({ type: 'noteInclude', attrs: { blockId: id + '-include', referenceId: id + '-use', noteId: shared.noteId, path: 'block-shared.note.md' } })
    if (id === 'target') note.content.content!.push({ type: 'blockReference', attrs: { blockId: 'specific-use', referenceId: 'specific-evidence', mode: 'reference', target: { noteId: shared.noteId, blockId: 'shared-child' } } })
    await writeFile(join(directory, id + '.note.md'), serializeNoteDocument(note))
  }
  return { shared, sharedContent }
}

it('reads one independent shared node for two hosts with whole-file include and exact child endpoints', async () => {
  await sharedGraphFixture()
  await dom.render(<NoteCanvas scope={{ kind: 'notebook', notebookId: (await store.read()).pages.target!.notebookId }} onOpen={() => {}} />)
  await vi.waitFor(() => expect(dom.container.querySelector('.react-flow__node[data-id="shared-content"] .note-canvas-reader')?.textContent).toContain('Precise evidence inside shared content'))
  const shared = dom.container.querySelector('.react-flow__node[data-id="shared-content"]')!
  expect(shared.querySelector('.note-canvas-title')?.textContent).toContain('Research conclusion')
  expect(shared.querySelector('[data-kind="shared-block"]')).not.toBeNull()
  expect(shared.querySelector('[data-reading-mode="document"]')).not.toBeNull()
  await vi.waitFor(() => expect(noteReaderText('closed-source')).toContain('Host ordinary paragraph'))
  expect(dom.container.querySelector('.note-canvas-block-node[data-note-id="closed-source"] .note-include-link')?.textContent).toContain('Research conclusion')
  expect(noteReaderText('closed-source')).not.toContain('Reusable research conclusion')
  expect(dom.container.querySelectorAll('.react-flow__node-note')).toHaveLength(3)
  expect(vi.mocked(api.notebooks.content).mock.calls.filter(([id]) => id === 'shared-content')).toHaveLength(1)
  expect(shared.querySelectorAll('.note-reader-metadata')).toHaveLength(1)
  expect(shared.querySelector('[data-author-block="shared-child"]')).not.toBeNull()
  const sharedReadIndex = vi.mocked(api.notebooks.content).mock.calls.findIndex(([id]) => id === 'shared-content')
  const sharedOriginal = await vi.mocked(api.notebooks.content).mock.results[sharedReadIndex]!.value
  if (sharedOriginal.status !== 'read' || sharedOriginal.noteProvenance?.status !== 'unconfirmed') throw Error('The independent shared original must retain its unconfirmed document provenance')
  expect(sharedOriginal.resource).toEqual({ hostId: 'local', workspaceId: 'notes', workspacePath: directory, path: 'block-shared.note.md' })
  const sharedMetadata = shared.querySelector<HTMLDetailsElement>('.note-reader-metadata')!
  expect(sharedMetadata.open).toBe(false)
  await act(async () => sharedMetadata.querySelector('summary')!.click())
  expect(sharedMetadata.open).toBe(true); expect(sharedMetadata.textContent).toContain(sharedOriginal.noteProvenance.reason)
  await act(async () => sharedMetadata.querySelector('summary')!.click())
  for (const id of ['target', 'closed-source']) {
    const area = dom.container.querySelector(`.react-flow__node[data-id="${id}"]`)!
    await act(async () => area.querySelector<HTMLButtonElement>('footer [aria-label^="Full note:"]')!.click())
    await vi.waitFor(() => expect(dom.container.querySelectorAll(`.note-canvas-block-node[data-note-id="${id}"]`).length).toBeGreaterThan(1))
    expect(dom.container.querySelectorAll(`.note-canvas-block-node[data-note-id="${id}"] .note-reader-metadata`)).toHaveLength(0)
    expect(dom.container.querySelector(`.note-canvas-block-node[data-note-id="${id}"] [data-author-block="${id}-block"]`)).not.toBeNull()
    const metadata = area.querySelector<HTMLDetailsElement>('footer > .note-reader-metadata')!
    expect(area.querySelectorAll('.note-reader-metadata')).toHaveLength(1)
    expect(metadata.open).toBe(false)
    const index = vi.mocked(api.notebooks.content).mock.calls.findIndex(([noteId]) => noteId === id)
    const original = await vi.mocked(api.notebooks.content).mock.results[index]!.value
    if (original.status !== 'read' || original.noteProvenance?.status !== 'unconfirmed') throw Error('The original external file change must have unconfirmed document provenance')
    await act(async () => metadata.querySelector('summary')!.click())
    expect(metadata.open).toBe(true); expect(metadata.textContent).toContain(original.noteProvenance.reason)
    await act(async () => metadata.querySelector('summary')!.click())
  }
  await vi.waitFor(() => expect(dom.container.querySelector('[data-target-note="shared-content"][data-target-block="shared-child"]')).not.toBeNull())
  const includes = [...dom.container.querySelectorAll<HTMLButtonElement>('[data-target-note="shared-content"][data-relationship-kind="embed"]')]
  expect(includes).toHaveLength(2)
  expect(includes.every(edge => edge.dataset.targetKind === 'page' && edge.dataset.targetAttachment === 'page' && !edge.dataset.targetBlock)).toBe(true)
  expect(includes.every(edge => edge.textContent?.includes('Uses shared content'))).toBe(true)
  await act(async () => includes[0]!.click())
  await vi.waitFor(() => expect(dom.container.querySelector('.note-canvas-comparison-to .note-canvas-reader')?.textContent).toContain('Reusable research conclusion'))
  expect(dom.container.querySelector('.note-canvas-comparison-to')?.textContent).toContain('Research conclusion')
  expect(dom.container.querySelector('.note-canvas-comparison-to')?.textContent).toContain('Open shared original')
  expect((await store.read()).pages['shared-content']).toBeUndefined()
  expect(api.notebooks.graph).toHaveBeenCalledTimes(1)
})

it('keeps duplicate unregistered shared identities unread and unopenable instead of choosing an observed file', async () => {
  await sharedGraphFixture(true)
  await dom.render(<NoteCanvas scope={{ kind: 'notebook', notebookId: (await store.read()).pages.target!.notebookId }} onOpen={() => {}} />)
  await vi.waitFor(() => expect(dom.container.querySelector('.react-flow__node[data-id="shared-content"]')).not.toBeNull())
  const shared = dom.container.querySelector('.react-flow__node[data-id="shared-content"]')!
  expect(shared.querySelector('button.note-canvas-title')).toBeNull()
  expect(shared.querySelector('.note-canvas-reader')).toBeNull()
  expect(vi.mocked(api.notebooks.content).mock.calls.some(([id]) => id === 'shared-content')).toBe(false)
  expect(shared.textContent).not.toContain('Reusable research conclusion')
})

it('opens the accurate unregistered shared Markdown after its body changes on disk without substituting a catalog page', async () => {
  await sharedGraphFixture()
  const workspace = { id: 'notes', hostId: 'local', path: directory, name: 'Notes', kind: 'folder' as const }
  const spaceId = directoryIdentity('local', directory)
  const tab = { ...createWorkbenchTab('shared-file-tab', { kind: 'file', regionId: 'shared-file-region', workspaceId: 'notes', path: 'block-shared.note.md' }), space: { spaceId, zoneId: homeZoneId(spaceId) } }
  useAppStore.setState({ config: { ...composerConfig, workspaces: [workspace] }, loading: false, mainSurface: 'recall', activeWorkspaceId: 'notes', tabs: { [tab.id]: tab }, layouts: { notes: createWorkspaceLayout('shared-file-group', [tab.id]) } })
  vi.spyOn(api.files, 'read').mockImplementation(async (_workspaceId, path) => files.read(workspace, path))
  vi.spyOn(api.files, 'observe').mockResolvedValue(undefined)
  const openPage = vi.fn()
  await dom.render(<NoteCanvas scope={scope} seedNoteIds={['shared-content']} onOpen={openPage} />)
  await vi.waitFor(() => expect(dom.container.querySelector('.note-canvas-reader')?.textContent).toContain('Reusable research conclusion'))
  const current = await files.read(workspace, 'block-shared.note.md')
  if (current.status !== 'read') throw new Error('Actual shared file was not read')
  const changed = noteFromMarkdown(current.document.content)
  changed.content.content![0]!.content = [{ type: 'text', text: 'Latest evidence remains a healthy original' }]
  await writeFile(join(directory, 'block-shared.note.md'), serializeNoteDocument(changed))
  await dom.click('button.note-canvas-title')
  const key = documentKey('notes', 'block-shared.note.md')
  await vi.waitFor(() => expect(useAppStore.getState().documents[key]?.content).toContain('Latest evidence remains a healthy original'))
  expect(useAppStore.getState().mainSurface).toBe('workbench')
  expect(openPage).not.toHaveBeenCalled()
  expect((await store.read()).pages['shared-content']).toBeUndefined()
  expect(Object.keys(useAppStore.getState().tabs)).toEqual(['shared-file-tab'])
  expect(dom.container.querySelector('.note-canvas-reader')?.textContent).not.toContain('Latest evidence remains a healthy original')
})

it('continues automatic original reading when panning past the first six notes', async () => {
  const positions: Record<string, {x:number;y:number}> = {target:{x:0,y:0},'closed-source':{x:5000,y:0}}
  for(let i=0;i<5;i++) {
    const id='window-extra-'+i
    await writeFile(join(directory,id+'.note.md'),body(id,'Window paragraph '+i+' [[Original target]]'))
    await store.apply({expectedRevision:(await store.read()).revision,operationId:'register-window-'+i,change:{kind:'register',noteId:id,title:id,resource:{hostId:'local',workspaceId:'notes',workspacePath:directory,path:id+'.note.md'}}},{kind:'user',id:'ui-test'})
    positions[id]={x:0,y:0}
  }
  useAppStore.setState({noteCanvasLayouts:{[noteCanvasScopeKey(scope)]:{positions,viewport:{x:0,y:0,zoom:1},expandedNoteIds:['target'],previewNoteIds:[]}}})
  await dom.render(<ReactFlowProvider><PanControls/><NoteCanvas scope={scope} seedNoteIds={['target']} onOpen={()=>{}}/></ReactFlowProvider>)
  await vi.waitFor(()=>expect(dom.container.querySelectorAll('.note-canvas-block-node .note-canvas-reader').length).toBeGreaterThanOrEqual(6))
  expect(api.notebooks.content).toHaveBeenCalledTimes(6)
  await dom.click('.pan-source')
  await vi.waitFor(()=>expect(hasNoteReader('closed-source')).toBe(true))
  expect(api.notebooks.graph).toHaveBeenCalledTimes(1)
})

function ReadingWindow({ snapshot, visible, active = true }: { snapshot: NotebookGraphSnapshot; visible: string[]; active?: boolean }) {
  const reading = useNoteCanvasContent(snapshot, active, visible, [])
  return <output className="reading-window">{JSON.stringify(Object.fromEntries(Object.entries(reading.results).map(([id, value]) => [id, value.pending ? 'pending' : value.value?.status ?? value.issue])))}</output>
}
it('bounds retained bodies across a long reading session and rereads evicted originals through the same owner', async () => {
  const ids = ['target', 'closed-source']
  for (let i = 0; i < 11; i++) {
    const id = 'cache-' + i; ids.push(id)
    await writeFile(join(directory, id + '.note.md'), body(id, 'Saved window ' + i))
    await store.apply({ expectedRevision: (await store.read()).revision, operationId: 'register-cache-' + i, change: { kind: 'register', noteId: id, title: id, resource: { hostId: 'local', workspaceId: 'notes', workspacePath: directory, path: id + '.note.md' } } }, { kind: 'user', id: 'ui-test' })
  }
  const snapshot = await api.notebooks.graph({})
  const state = () => JSON.parse(dom.container.querySelector('.reading-window')!.textContent!)
  for (const id of ids) {
    await dom.render(<ReadingWindow snapshot={snapshot} visible={[id]} />)
    await vi.waitFor(() => expect(state()[id]).toBe('read'))
    expect(Object.keys(state()).length).toBeLessThanOrEqual(12)
  }
  expect(state().target).toBeUndefined()
  expect(api.notebooks.content).toHaveBeenCalledTimes(13)
  await dom.render(<ReadingWindow snapshot={snapshot} visible={['cache-9']} />)
  expect(state()['cache-9']).toBe('read')
  expect(api.notebooks.content).toHaveBeenCalledTimes(13)
  await dom.render(<ReadingWindow snapshot={snapshot} visible={['target']} />)
  await vi.waitFor(() => expect(state().target).toBe('read'))
  expect(api.notebooks.content).toHaveBeenCalledTimes(14)
  expect(api.notebooks.graph).toHaveBeenCalledTimes(1)
})

it('cancels a pending original that leaves the reading window and ignores its late receipt', async () => {
  const snapshot = await api.notebooks.graph({}), original = vi.mocked(api.notebooks.content).getMockImplementation()!
  const pending: { id: string; signal: AbortSignal; resolve(): Promise<void> }[] = []
  vi.mocked(api.notebooks.content).mockImplementation((id, options) => new Promise(resolve => { pending.push({ id, signal: options!.signal!, resolve: async () => resolve(await original(id, {})) }) }))
  const state = () => JSON.parse(dom.container.querySelector('.reading-window')!.textContent!)
  await dom.render(<ReadingWindow snapshot={snapshot} visible={['target']} />)
  await vi.waitFor(() => expect(pending).toHaveLength(1))
  await dom.render(<ReadingWindow snapshot={snapshot} visible={['closed-source']} />)
  await vi.waitFor(() => expect(pending).toHaveLength(2))
  expect(pending[0]!.signal.aborted).toBe(true)
  expect(pending[1]!.signal.aborted).toBe(false)
  await act(async () => { await pending[0]!.resolve(); await pending[1]!.resolve() })
  await vi.waitFor(() => expect(state()['closed-source']).toBe('read'))
  expect(state().target).toBeUndefined()
  expect(api.notebooks.content).toHaveBeenCalledTimes(2)
})

async function currentCanvasDraft() {
  const saved = serializeNoteDocument({ schema: 'agentmux.note.v1', noteId: 'target', content: { type: 'doc', content: [{ type: 'paragraph', attrs: { blockId: 'saved-empty' } }] } })
  await writeFile(join(directory, 'target.note.md'), saved)
  const key = documentKey('notes', 'target.note.md'), draft = noteFromMarkdown(body('target', 'Private unsaved draft [[Only in draft]]'))
  draft.content.content!.push(...Array.from({ length: 7 }, (_, i) => ({ type: 'paragraph', attrs: { blockId: 'draft-middle-' + i }, content: [{ type: 'text', text: 'Current middle paragraph ' + i }] })),
    ...noteSummaryContent(noteSummaryCases.find(example => example.name === 'nested tasks')!).content!,
    ...noteSummaryContent(noteSummaryCases.find(example => example.name === 'table cells')!).content!,
    { type: 'paragraph', attrs: { blockId: 'draft-late' }, content: [{ type: 'text', text: 'Late current draft beyond the summary' }] })
  const current = { path: 'target.note.md', content: serializeNoteDocument(draft), revision: 'saved-original-base', noteEditing: { baseline: { content: saved, revision: 'saved-original-base' } } }
  const workspace = { id: 'notes', hostId: 'local', path: directory, name: 'Notes', kind: 'folder' as const }
  useAppStore.setState({ config: { ...composerConfig, workspaces: [workspace] }, dirtyDocuments: { [key]: true }, documents: { [key]: current } })
  return { saved, key, current, workspace }
}
const currentTargetCard = () => dom.container.querySelector('.react-flow__node[data-id="target"]')!
async function clickDraftVersion(name: 'Current draft' | 'Saved original') {
  const button = [...currentTargetCard().querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent?.trim() === name)
  expect(button, `Expected explicit ${name} comparison`).toBeDefined()
  await act(async () => button!.click())
}

it('reads the current exact-resource draft in notebook scope above a saved-empty original and explicitly compares saved without changing files or graph', async () => {
  const f = await currentCanvasDraft(), metadata = await store.read(), graph = await api.notebooks.graph({})
  vi.mocked(api.notebooks.graph).mockClear()
  const open = vi.fn()
  await dom.render(<NoteCanvas scope={{ kind: 'notebook', notebookId: metadata.pages.target!.notebookId }} onOpen={open} />); await ready()
  await vi.waitFor(() => expect(noteReaderText('target')).toContain('Private unsaved draft'))
  expect(currentTargetCard().textContent).toContain('Current draft')
  expect(currentTargetCard().textContent).toContain('Unsaved draft · links show saved relationships')
  expect(currentTargetCard().querySelectorAll('.note-canvas-draft')).toHaveLength(1)
  expect(currentTargetCard().querySelectorAll('.note-canvas-saved-heading > span')).toHaveLength(1)
  expect(currentTargetCard().textContent).not.toContain('Not saved')
  expect(currentTargetCard().querySelector('footer > .note-reader-metadata')).toBeNull()
  expect(currentTargetCard().querySelector('.note-canvas-empty-body')).toBeNull()
  expect(dom.container.querySelector('.note-canvas-block-node[data-note-id="target"] [data-block-id="target-block"]')?.textContent).toContain('Private unsaved draft')
  await dom.click('[aria-label="Full note: Original target"]')
  await vi.waitFor(() => expect(noteReaderText('target')).toContain('Late current draft beyond the summary'))
  expect(dom.container.querySelector<HTMLInputElement>('.note-canvas-block-node[data-note-id="target"] [data-block-id="summary-task"] [type="checkbox"]')?.checked).toBe(true)
  expect(dom.container.querySelector<HTMLInputElement>('.note-canvas-block-node[data-note-id="target"] [data-block-id="child-task"] [type="checkbox"]')?.checked).toBe(false)
  expect(dom.container.querySelector('.note-canvas-block-node[data-note-id="target"] table[data-block-id="summary-table"]')?.textContent).toContain('Evidence')
  const degrees = currentTargetCard().querySelector('.note-canvas-degrees')!.getAttribute('aria-label')
  expect(currentTargetCard().querySelector('.note-canvas-unbound')).toBeNull()
  await clickDraftVersion('Saved original')
  await vi.waitFor(() => expect(currentTargetCard().querySelector('.note-canvas-empty-body')?.textContent).toBe('No saved content yet.'))
  expect(currentTargetCard().querySelectorAll('footer > .note-reader-metadata')).toHaveLength(1)
  expect(noteReaderText('target')).not.toContain('Private unsaved draft')
  expect(currentTargetCard().querySelectorAll('.note-canvas-saved-heading > span')).toHaveLength(1)
  await clickDraftVersion('Current draft')
  await vi.waitFor(() => expect(noteReaderText('target')).toContain('Late current draft beyond the summary'))
  expect(currentTargetCard().querySelector('footer > .note-reader-metadata')).toBeNull()
  expect(currentTargetCard().querySelector('.note-canvas-degrees')!.getAttribute('aria-label')).toBe(degrees)
  expect(dom.container.querySelector<HTMLDetailsElement>('.note-canvas-source-details')!.open).toBe(false)
  expect(dom.container.querySelector('.note-canvas-source-details')!.textContent).toContain('2/2 originals read')
  await act(async () => currentTargetCard().querySelector<HTMLButtonElement>('.note-canvas-title')!.click())
  expect(open).toHaveBeenCalledWith((await store.read()).pages.target)
  expect(useAppStore.getState().documents[f.key]).toBe(f.current)
  expect(useAppStore.getState().dirtyDocuments[f.key]).toBe(true)
  expect(await readFile(join(directory, 'target.note.md'), 'utf8')).toBe(f.saved)
  expect(await store.read()).toEqual(metadata)
  expect(api.notebooks.graph).toHaveBeenCalledTimes(1)
  const observed = await vi.mocked(api.notebooks.graph).mock.results[0]!.value
  expect(observed.graph.references).toEqual(graph.graph.references)
  expect(observed.graph.hierarchy).toEqual(graph.graph.hierarchy)
  expect(dom.container.querySelectorAll('.react-flow__node-note')).toHaveLength(2)
})

it.each(['workspace remap', 'document path mismatch', 'different Note identity', 'invalid Note body'] as const)('refuses a %s draft on the original current Canvas without leaking or discarding its bytes', async fault => {
  const f = await currentCanvasDraft()
  await dom.render(<NoteCanvas scope={scope} seedNoteIds={['target']} onOpen={() => {}} />); await ready()
  await vi.waitFor(() => expect(noteReaderText('target')).toContain('Private unsaved draft'))
  const changed = fault === 'workspace remap' ? f.current : { ...f.current,
    ...fault === 'document path mismatch' ? { path: 'other.note.md' } : { content: fault === 'different Note identity' ? body('different-note', 'Wrong original draft must remain private') : '---\nschema: agentmux.note.md.v1\nnote-id: [invalid\n---\nWrong original draft must remain private' } }
  await act(async () => useAppStore.setState({
    config: { ...composerConfig, workspaces: [{ ...f.workspace, path: fault === 'workspace remap' ? join(directory, 'remapped') : directory }] },
    documents: { [f.key]: changed },
  }))
  await vi.waitFor(() => expect(noteReaderText('target')).not.toContain('Private unsaved draft'))
  expect(currentTargetCard().textContent).not.toContain('Wrong original draft must remain private')
  expect(currentTargetCard().textContent).toMatch(/draft.*(?:unavailable|invalid|different|unconfirmed|match|mapped)|(?:unavailable|invalid|different|unconfirmed|match|mapped).*draft/iu)
  expect(useAppStore.getState().documents[f.key]).toBe(changed)
  expect(useAppStore.getState().dirtyDocuments[f.key]).toBe(true)
  expect(await readFile(join(directory, 'target.note.md'), 'utf8')).toBe(f.saved)
  expect(api.notebooks.graph).toHaveBeenCalledTimes(1)
})

it.each(noteSummaryCases)('uses readable $name on the real shared Graph node without rewriting the original file', async example => {
  await sharedGraphFixture()
  const path = join(directory, 'block-shared.note.md')
  const shared = noteFromMarkdown(await readFile(path, 'utf8'))
  delete shared.title
  if (example.title) shared.title = example.title
  shared.content = noteSummaryContent(example)
  const original = serializeNoteDocument(shared)
  await writeFile(path, original)
  await dom.render(<NoteCanvas scope={{ kind: 'notebook', notebookId: (await store.read()).pages.target!.notebookId }} onOpen={() => {}} />)
  await vi.waitFor(() => expect(dom.container.querySelector('.react-flow__node[data-id="shared-content"] .note-canvas-title')?.textContent).toBe(example.expected))
  expect(dom.container.querySelector('.react-flow__node[data-id="shared-content"] .note-canvas-reader')).not.toBeNull()
  expect(await readFile(path, 'utf8')).toBe(original)
  expect((await store.read()).pages['shared-content']).toBeUndefined()
})

it.each(['pending', 'error'] as const)('keeps the current File draft readable while its saved original is %s and compares both states explicitly', async state => {
  const f = await currentCanvasDraft(), original = vi.mocked(api.notebooks.content).getMockImplementation()!
  let release: ((value: Awaited<ReturnType<typeof original>>) => void) | undefined
  vi.mocked(api.notebooks.content).mockImplementation((id, options) => id !== 'target' ? original(id, options) : state === 'pending'
    ? new Promise(resolve => { release = resolve }) : Promise.reject(new Error('Saved body transport failed')))
  await dom.render(<NoteCanvas scope={scope} seedNoteIds={['target']} onOpen={() => {}} />); await ready()
  await vi.waitFor(() => expect(noteReaderText('target')).toContain('Private unsaved draft'))
  await clickDraftVersion('Saved original')
  await vi.waitFor(() => expect(currentTargetCard().querySelector('.note-canvas-body-state')?.textContent).toContain(state === 'pending' ? 'Reading saved original' : 'Saved body transport failed'))
  expect(hasNoteReader('target')).toBe(false)
  await clickDraftVersion('Current draft')
  await vi.waitFor(() => expect(noteReaderText('target')).toContain('Private unsaved draft'))
  if (state === 'pending') await act(async () => release!(await original('target', {})))
  expect(currentTargetCard().querySelector('[aria-label="Current draft"]')?.getAttribute('aria-pressed')).toBe('true')
  expect(noteReaderText('target')).toContain('Private unsaved draft')
  expect(useAppStore.getState().documents[f.key]).toBe(f.current)
  expect(await readFile(join(directory, 'target.note.md'), 'utf8')).toBe(f.saved)
  expect(api.notebooks.graph).toHaveBeenCalledTimes(1)
})

it('reacts to accepted File draft edits, restored pre-edit content and undo to the saved empty state without saving', async () => {
  vi.stubGlobal('Worker', NoteSnapshotTestWorker)
  const f = await currentCanvasDraft()
  await dom.render(<NoteCanvas scope={scope} seedNoteIds={['target']} onOpen={() => {}} />); await ready()
  await vi.waitFor(() => expect(noteReaderText('target')).toContain('Private unsaved draft'))
  await vi.waitFor(() => expect(api.notebooks.content).toHaveBeenCalledTimes(2))
  const readCount = vi.mocked(api.notebooks.content).mock.calls.length
  const changed = { ...f.current, content: f.current.content.replace('Private unsaved draft', 'Changed accepted draft') }
  await act(async () => useAppStore.setState({ documents: { [f.key]: changed } }))
  await vi.waitFor(() => expect(noteReaderText('target')).toContain('Changed accepted draft'))
  expect(noteReaderText('target')).not.toContain('Private unsaved draft')
  await act(async () => useAppStore.setState({ documents: { [f.key]: f.current } }))
  await vi.waitFor(() => expect(noteReaderText('target')).toContain('Private unsaved draft'))
  await act(async () => useAppStore.setState({ documents: { [f.key]: { ...f.current, content: f.saved } }, dirtyDocuments: { [f.key]: false } }))
  await vi.waitFor(() => expect(currentTargetCard().querySelector('.note-canvas-empty-body')?.textContent).toBe('No saved content yet.'))
  expect(currentTargetCard().querySelector('.note-canvas-versions')).toBeNull()
  expect(currentTargetCard().textContent).not.toContain('Invalid content for node doc')
  await act(async () => useAppStore.setState({ documents: { [f.key]: f.current }, dirtyDocuments: { [f.key]: true } }))
  await vi.waitFor(() => expect(noteReaderText('target')).toContain('Private unsaved draft'))
  expect(vi.mocked(api.notebooks.content).mock.calls).toHaveLength(readCount)
  expect(api.notebooks.graph).toHaveBeenCalledTimes(1)
  expect(await readFile(join(directory, 'target.note.md'), 'utf8')).toBe(f.saved)
})

it('keeps saved relationship ports and inspection on the exact saved passage even when a current draft reuses its block ID', async () => {
  const f = await currentCanvasDraft(), saved = body('target', 'Exact saved relationship passage')
  await writeFile(join(directory, 'target.note.md'), saved)
  await dom.render(<NoteCanvas scope={scope} seedNoteIds={['target']} onOpen={() => {}} />); await ready()
  await vi.waitFor(() => expect(noteReaderText('target')).toContain('Private unsaved draft'))
  const relationship = () => dom.container.querySelector<HTMLButtonElement>('.note-canvas-edge-label[data-target-note="target"][data-relationship-kind="reference"]')!
  await vi.waitFor(() => expect(relationship()?.dataset.targetAttachment).toBe('summary'))
  expect(dom.container.querySelector('.note-canvas-block-node[data-note-id="target"] .note-canvas-row-endpoint[data-port-block-id="target-block"]')).toBeNull()
  await act(async () => relationship().click())
  await vi.waitFor(() => expect(dom.container.querySelector('.note-canvas-comparison-to .note-canvas-reader')?.textContent).toContain('Exact saved relationship passage'))
  expect(dom.container.querySelector('.note-canvas-comparison-to')?.textContent).not.toContain('Private unsaved draft')
  expect(noteReaderText('target')).toContain('Exact saved relationship passage')
  await vi.waitFor(() => expect(relationship()?.dataset.targetAttachment).toBe('block'))
  await clickDraftVersion('Current draft')
  await vi.waitFor(() => expect(noteReaderText('target')).toContain('Private unsaved draft'))
  await vi.waitFor(() => expect(relationship()?.dataset.targetAttachment).toBe('summary'))
  expect(dom.container.querySelector('.note-canvas-comparison-to .note-canvas-reader')?.textContent).toContain('Exact saved relationship passage')
  expect(useAppStore.getState().documents[f.key]).toBe(f.current)
  expect(await readFile(join(directory, 'target.note.md'), 'utf8')).toBe(saved)
  expect(api.notebooks.graph).toHaveBeenCalledTimes(1)
})

it.each(['matching', 'hostId', 'workspaceId', 'workspacePath', 'path'] as const)('keeps current draft content while using authorship only from %s original metadata', async field => {
  const f = await currentCanvasDraft(), resource = { hostId: 'local', workspaceId: 'notes', workspacePath: directory, path: 'target.note.md' }
  const noteProvenance = await recordMarkdownProvenance(store, resource, f.current.content, { kind: 'agent', id: 'ExactResearchSession' })
  if (field !== 'matching') noteProvenance.resource[field] += '-other-original'
  const current = { ...f.current, revision: noteProvenance.revision, noteProvenance }
  useAppStore.setState({ documents: { [f.key]: current }, agentNames: { ExactResearchSession: 'Trusted author' } })
  await dom.render(<NoteCanvas scope={scope} seedNoteIds={['target']} onOpen={() => {}} />); await ready()
  await vi.waitFor(() => expect(noteReaderText('target')).toContain('Private unsaved draft'))
  const author = dom.container.querySelector('.note-canvas-block-node[data-note-id="target"] [data-author-block="target-block"]')!
  expect(author).not.toBeNull()
  expect(author.textContent).toBe('')
  if (field === 'matching') expect(author.getAttribute('aria-label')).toContain('Agent · Trusted')
  else expect(author.getAttribute('aria-label')).toBe('Block authors: Author unconfirmed')
  expect(useAppStore.getState().documents[f.key]).toBe(current)
  expect(await readFile(join(directory, 'target.note.md'), 'utf8')).toBe(f.saved)
})

it('renders unanchored draft paragraphs and pending shared noteInclude blocks as separate Block cards inside the Note area', async () => {
  const saved = serializeNoteDocument({ schema: 'agentmux.note.v1', noteId: 'target', content: { type: 'doc', content: [{ type: 'paragraph', attrs: { blockId: 'initial-anchor' } }] } })
  await writeFile(join(directory, 'target.note.md'), saved)
  const sourceDoc = noteFromMarkdown(body('closed-source', 'Shared origin paragraph from source'))
  const sourceBytes = serializeNoteDocument(sourceDoc)
  await writeFile(join(directory, 'closed-source.note.md'), sourceBytes)
  const workspace = { id: 'notes', hostId: 'local', path: directory, name: 'Notes', kind: 'folder' as const }
  const sourceTarget = { noteId: 'closed-source', hostId: 'local', workspaceId: 'notes', workspacePath: directory, path: 'closed-source.note.md' }
  const include = { referenceId: 'pending-share-ref', noteId: 'pending-shared-id', path: 'block-pending-shared-id.note.md' }
  const draftNote = {
    schema: 'agentmux.note.v1' as const,
    noteId: 'target',
    content: {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { blockId: 'initial-anchor' }, content: [{ type: 'text', text: 'First anchored draft paragraph' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Second unanchored draft paragraph' }] },
        { type: 'noteInclude', attrs: include },
      ],
    },
  }
  const targetKey = documentKey('notes', 'target.note.md'), sourceKey = documentKey('notes', 'closed-source.note.md')
  useAppStore.setState({
    config: { ...composerConfig, workspaces: [workspace] },
    dirtyDocuments: { [targetKey]: true },
    documents: {
      [sourceKey]: { path: 'closed-source.note.md', content: sourceBytes, revision: 'source-rev' },
      [targetKey]: {
        path: 'target.note.md',
        content: serializeNoteDocument(draftNote),
        revision: 'saved-base',
        noteEditing: {
          baseline: { content: saved, revision: 'saved-base' },
          shares: {
            'pending-share-ref': {
              operationId: 'op-pending-share',
              include,
              copy: {
                version: 1,
                source: sourceTarget,
                read: { zoneId: 'z1', path: 'closed-source.note.md', expectedResource: { hostId: 'local', workspaceId: 'notes', workspacePath: directory } },
                block: { path: [0], blockId: 'closed-source-block', fingerprint: noteBlockFingerprint(sourceDoc.content.content![0]!) },
                proposalId: 'pending-shared-id',
              },
            },
          },
        },
      },
    },
  })
  await dom.render(<NoteCanvas scope={scope} seedNoteIds={['target']} onOpen={() => {}} />)
  await vi.waitFor(() => expect(dom.container.querySelectorAll('.note-canvas-block-node[data-note-id="target"]')).toHaveLength(3))
  const cards = [...dom.container.querySelectorAll<HTMLElement>('.note-canvas-block-node[data-note-id="target"]')]
  expect(cards[0]!.textContent).toContain('First anchored draft paragraph')
  expect(cards[1]!.textContent).toContain('Second unanchored draft paragraph')
  expect(cards[2]!.textContent).toContain('Pending shared content')
  expect(cards[2]!.textContent).toContain('Shared origin paragraph from source')
})
