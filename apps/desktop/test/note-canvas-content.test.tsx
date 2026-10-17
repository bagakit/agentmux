import { recordMarkdownProvenance } from './helpers/note-markdown-provenance'
import { readNoteDocument } from '@agentmux/client-ui/note/note-document'
import { serializeNoteDocument } from '@agentmux/client-ui/note/note-document'
import { noteInlineLinkContent } from '@agentmux/client-ui/note/note-wikilinks'
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
import { NoteCanvas } from '../src/renderer/src/components/NoteCanvas'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM } from './helpers/composer-dom-fixture'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'
import { installNoteCanvasBlockRows } from './helpers/note-canvas-block-dom'

const dom = composerDOM(), scope = { kind: 'note', noteId: 'target' } as const
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
  installNoteCanvasBlockRows()
  const file = noteFromMarkdown(body('target', 'The late decision is searchable'))
  file.content.content!.unshift(...Array.from({ length: 14 }, (_, i) => ({ type: 'paragraph', attrs: { blockId: 'unrelated-' + i }, content: [{ type: 'text', text: 'Unrelated context ' + i }] })))
  const content = serializeNoteDocument(file)
  await writeFile(join(directory, 'target.note.md'), content)
  await recordMarkdownProvenance(store, { hostId: 'local', workspaceId: 'notes', workspacePath: directory, path: 'target.note.md' }, content, { kind: 'agent', id: 'ExactResearchSession' })
  const open = vi.fn()
  await dom.render(<NoteCanvas scope={scope} onOpen={open} />); await ready()
  await vi.waitFor(() => { const reader = dom.container.querySelector('.react-flow__node[data-id="target"] .note-canvas-reader'); expect(reader).not.toBeNull(); expect(reader!.textContent).toContain('The late decision is searchable') })
  const target = dom.container.querySelector('.react-flow__node[data-id="target"]')!
  expect(target.textContent).not.toContain('Unrelated context')
  await vi.waitFor(() => expect(dom.container.querySelector('.react-flow__node[data-id="closed-source"] .mobile-note-reference')?.textContent).toContain('The late decision is searchable'))
  expect(api.notebooks.content).toHaveBeenCalledTimes(2)
  expect(api.notebooks.graph).toHaveBeenCalledTimes(1)
  expect(target.querySelector('[data-author-block]')?.textContent).toBe('Agent · ExactRes…')
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
    await writeFile(join(directory, id + '.note.md'), body(id, 'Readable related ' + i + ' [[Original target]]'))
    await store.apply({ expectedRevision: (await store.read()).revision, operationId: 'register-' + id, change: { kind: 'register', noteId: id, title: id, resource: { hostId: 'local', workspaceId: 'notes', workspacePath: directory, path: id + '.note.md' } } }, { kind: 'user', id: 'ui-test' })
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
    if (id === 'target') await writeFile(join(directory, 'target.note.md'), body('target', 'Later revision is not the graph original'))
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
  await writeFile(join(directory, 'target.note.md'), body('target', 'Large original is readable. '.repeat(12000)))
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
    await writeFile(join(directory, id + '.note.md'), body(id, 'Related ' + i + ' [[Original target]]'))
    await store.apply({ expectedRevision: (await store.read()).revision, operationId: 'register-' + id, change: { kind: 'register', noteId: id, title: id, resource: { hostId: 'local', workspaceId: 'notes', workspacePath: directory, path: id + '.note.md' } } }, { kind: 'user', id: 'ui-test' })
  }
  await dom.render(<ReactFlowProvider><ViewportProbe /><NoteCanvas scope={scope} onOpen={() => {}} /></ReactFlowProvider>)
  const viewport = () => JSON.parse(dom.container.querySelector('.actual-flow-viewport')!.textContent!)
  await vi.waitFor(() => expect(dom.container.querySelectorAll('.note-canvas-title')).toHaveLength(9))
  await vi.waitFor(() => expect(viewport()).toEqual({ x: 24, y: 24, zoom: 1 }))
  await vi.waitFor(() => expect(dom.container.querySelector('.react-flow__node[data-id="target"] .note-canvas-reader')).not.toBeNull())
  await dom.click('[aria-label="Fit visible notes"]')
  await vi.waitFor(() => expect(viewport().zoom).toBeLessThan(.8))
  const saved = { x: 123, y: 84, zoom: .9 }
  await dom.render(null)
  useAppStore.setState({ noteCanvasLayouts: { [noteCanvasScopeKey(scope)]: { positions: { target: { x: 0, y: 0 }, 'closed-source': { x: 2000, y: 1000 } }, viewport: saved, expandedNoteIds: ['target'], previewNoteIds: [] } } })
  await dom.render(<ReactFlowProvider><ViewportProbe /><NoteCanvas scope={scope} onOpen={() => {}} /></ReactFlowProvider>)
  await vi.waitFor(() => expect(viewport()).toEqual(saved))
})

it('reads the exact saved source of an unbound query without inventing a destination or borrowing a first paragraph', async () => {
  await writeFile(join(directory, 'unbound.note.md'), serializeNoteDocument({ schema: 'agentmux.note.v1', noteId: 'unbound', content: { type: 'doc', content: [
    { type: 'paragraph', attrs: { blockId: 'unrelated' }, content: [{ type: 'text', text: 'Do not use this introduction' }] },
    { type: 'paragraph', attrs: { blockId: 'written-source' }, content: [{ type: 'text', text: 'The unanswered decision: [[Unregistered original]]' }] },
  ] } }))
  await store.apply({ expectedRevision: (await store.read()).revision, operationId: 'unbound-page', change: { kind: 'register', noteId: 'unbound', title: 'Unbound original', resource: { hostId: 'local', workspaceId: 'notes', workspacePath: directory, path: 'unbound.note.md' } } }, { kind: 'user', id: 'ui-test' })
  await dom.render(<NoteCanvas scope={{ kind: 'note', noteId: 'unbound' }} onOpen={() => {}} />)
  await vi.waitFor(() => expect(dom.container.querySelector('.note-canvas-reader')?.textContent).toContain('The unanswered decision'))
  expect(dom.container.querySelector('.note-canvas-reader')!.textContent).not.toContain('Do not use this introduction')
  expect(dom.container.querySelectorAll('.note-canvas-title')).toHaveLength(1)
  expect(dom.container.querySelector('.note-canvas-caption')?.textContent).toContain('1 visible unbound links')
  expect(api.notebooks.content).toHaveBeenCalledTimes(1)
})

it('keeps the direct incoming source beside its root readable on first entry without fitting or changing the original positions', async () => {
  class IncomingLayoutWorker {
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror = null
    postMessage(request: { id: string }) { queueMicrotask(() => this.onmessage?.({ data: { id: request.id, positions: { target: { x: 400, y: 0 }, 'closed-source': { x: 0, y: 0 } } } } as MessageEvent)) }
    terminate() {}
  }
  vi.stubGlobal('Worker', IncomingLayoutWorker)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
  await dom.render(<ReactFlowProvider><ViewportProbe /><NoteCanvas scope={scope} onOpen={() => {}} /></ReactFlowProvider>); await ready()
  await vi.waitFor(() => expect(JSON.parse(dom.container.querySelector('.actual-flow-viewport')!.textContent!)).toEqual({ x: 24, y: 24, zoom: 1 }))
  await vi.waitFor(() => expect(sourceCardContent()).toContain('Saved target'))
  expect(useAppStore.getState().noteCanvasLayouts[noteCanvasScopeKey(scope)]!.positions.target).toEqual({ x: 400, y: 0 })
  expect(api.notebooks.graph).toHaveBeenCalledTimes(1)
  function sourceCardContent() { return dom.container.querySelector('.react-flow__node[data-id="closed-source"] .note-canvas-reader')?.textContent ?? '' }
})

function noteFromMarkdown(content:string) { const read=readNoteDocument(content);expect(read.status).toBe('valid');if(read.status!=='valid')throw Error(read.message);return read.note }

it('automatically summarizes an unrelated unanchored page without creating paragraph entities', async () => {
  const note = noteFromMarkdown(body('target', 'Unused'))
  note.content.content = ['Opening context', 'Second useful paragraph', 'Third useful paragraph', 'Fourth kept in original'].map(text => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
  await writeFile(join(directory, 'target.note.md'), serializeNoteDocument(note))
  await writeFile(join(directory, 'closed-source.note.md'), body('closed-source', 'No links here'))
  await dom.render(<NoteCanvas scope={scope} onOpen={() => {}} />)
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
  const geometry = installNoteCanvasBlockRows()
  Object.assign(geometry.rows, { 'shared-child': 180, 'target-include': 120, 'closed-source-include': 120, 'specific-use': 230 })
  await sharedGraphFixture()
  await dom.render(<NoteCanvas scope={{ kind: 'notebook', notebookId: (await store.read()).pages.target!.notebookId }} onOpen={() => {}} />)
  await vi.waitFor(() => expect(dom.container.querySelector('.react-flow__node[data-id="shared-content"] .note-canvas-reader')?.textContent).toContain('Precise evidence inside shared content'))
  const shared = dom.container.querySelector('.react-flow__node[data-id="shared-content"]')!
  expect(shared.querySelector('.note-canvas-title')?.textContent).toContain('Research conclusion')
  expect(shared.querySelector('[data-kind="shared-block"]')).not.toBeNull()
  expect(shared.querySelector('[data-reading-mode="document"]')).not.toBeNull()
  const host = dom.container.querySelector('.react-flow__node[data-id="closed-source"]')!
  await vi.waitFor(() => expect(host.querySelector('.note-canvas-reader')?.textContent).toContain('Host ordinary paragraph'))
  expect(host.querySelector('.note-include-link')?.textContent).toContain('Research conclusion')
  expect(host.querySelector('.note-canvas-reader')?.textContent).not.toContain('Reusable research conclusion')
  expect(dom.container.querySelectorAll('.react-flow__node')).toHaveLength(3)
  expect(vi.mocked(api.notebooks.content).mock.calls.filter(([id]) => id === 'shared-content')).toHaveLength(1)
  await vi.waitFor(() => expect(dom.container.querySelector('[data-target-note="shared-content"][data-target-block="shared-child"]')).not.toBeNull())
  const includes = [...dom.container.querySelectorAll<HTMLButtonElement>('[data-target-note="shared-content"][data-relationship-kind="embed"]')]
  expect(includes).toHaveLength(2)
  expect(includes.every(edge => edge.dataset.targetKind === 'page' && edge.dataset.targetAttachment === 'page' && !edge.dataset.targetBlock)).toBe(true)
  expect(includes.every(edge => edge.textContent?.includes('shared block'))).toBe(true)
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
  await dom.render(<NoteCanvas scope={{ kind: 'note', noteId: 'shared-content' }} onOpen={openPage} />)
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
