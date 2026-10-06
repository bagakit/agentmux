import { readNoteDocument } from '@agentmux/client-ui/note/note-document'
import { serializeNoteDocument } from '@agentmux/client-ui/note/note-document'
import { fixtureEpoch as _tailRefreshFixtureEpoch } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { EventEmitter } from 'node:events'
import { mkdtemp, realpath, readFile, rm, writeFile } from 'node:fs/promises'
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
const body = (id: string, text: string, references = false) => serializeNoteDocument({ schema: 'agentmux.note.v1', noteId: id, content: { type: 'doc', content: [
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
    await writeFile(join(directory, id + '.note.md'), body(id, 'Saved ' + id, id !== 'target'))
    await store.apply({ expectedRevision: (await store.read()).revision, operationId: 'register-' + id, change: { kind: 'register', noteId: id, title: 'Original ' + id, resource: { hostId: 'local', workspaceId: 'notes', workspacePath: directory, path: id + '.note.md' } } }, { kind: 'user', id: 'ui-test' })
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
const link = (referenceId: string, noteId: string, blockId?: string) => ({ type: 'noteLink', attrs: { referenceId, text: noteId + (blockId ? ' #' + blockId : ''), target: { noteId, ...blockId ? { blockId } : {} } } })
const paragraph = (blockId: string, text: string) => ({ type: 'paragraph', attrs: { blockId }, content: [{ type: 'text', text }] })
async function selectedFixture() {
  await writeFile(join(directory, 'target.note.md'), serializeNoteDocument({ schema: 'agentmux.note.v1', noteId: 'target', content: { type: 'doc', content: Array.from({ length: 6 }, (_, i) => paragraph('target-' + i, 'Exact target content ' + i)) } }))
  await writeFile(join(directory, 'closed-source.note.md'), serializeNoteDocument({ schema: 'agentmux.note.v1', noteId: 'closed-source', content: { type: 'doc', content: [{ type: 'paragraph', attrs: { blockId: 'long-source' }, content: [
    { type: 'text', text: 'The original source includes every exact decision: ' },
    ...Array.from({ length: 6 }, (_, i) => link('selected-' + i, 'target', 'target-' + i)),
    { type: 'text', text: ' The final written source sentence remains visible in comparison.' },
    link('page-occurrence', 'target'),
  ] }] } }))
}
const targetCard = () => dom.container.querySelector('.react-flow__node[data-id="target"]')!
const sourceCard = () => dom.container.querySelector('.react-flow__node[data-id="closed-source"]')!

it('selects only the three original default-outside occurrences, compares each target with one shared source, and opens exact originals without more IO or layout changes', async () => {
  await selectedFixture()
  const geometry = installNoteCanvasBlockRows()
  Object.assign(geometry.rows, { 'long-source': 130, ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => ['target-' + i, 120 + i * 30])) })
  const open = vi.fn()
  const draft = { path: 'closed-source.note.md', revision: 'unsaved', content: body('closed-source', 'My unsaved editor must remain') }
  useAppStore.setState({ documents: { 'notes\0closed-source.note.md': draft }, dirtyDocuments: { 'notes\0closed-source.note.md': true } })
  await dom.render(<NoteCanvas scope={scope} onOpen={open} />); await ready()
  await vi.waitFor(() => expect(targetCard().querySelector('[data-block-id="target-2"]')).not.toBeNull())
  await vi.waitFor(() => expect(api.notebooks.content).toHaveBeenCalledTimes(2))
  expect(targetCard().querySelector('[data-block-id="target-5"]')).toBeNull()
  const summary = () => dom.container.querySelector<HTMLButtonElement>('.note-canvas-edge-label[data-target-kind="block"][data-target-attachment="summary"]')
  await vi.waitFor(() => { expect(summary()).not.toBeNull(); expect(summary()!.textContent).toContain('3 links') })
  const layout = structuredClone(useAppStore.getState().noteCanvasLayouts[noteCanvasScopeKey(scope)])
  await act(async () => summary()!.click())
  await vi.waitFor(() => expect(targetCard().querySelectorAll('[data-note-selected-block]')).toHaveLength(3))
  expect([...targetCard().querySelectorAll<HTMLElement>('[data-note-selected-block]')].map(node => node.dataset.noteSelectedBlock)).toEqual(['target-3', 'target-4', 'target-5'])
  expect(targetCard().querySelector('.mobile-note-body [data-block-id]')?.getAttribute('data-block-id')).toBe('target-3')
  await vi.waitFor(() => expect(sourceCard().querySelector('[data-note-selected-block="long-source"]')).not.toBeNull())
  const inspector = dom.container.querySelector('.note-canvas-inspector')!
  await vi.waitFor(() => expect(inspector.querySelectorAll('.note-canvas-comparison-to')).toHaveLength(3))
  expect(inspector.querySelectorAll('.note-canvas-comparison-from')).toHaveLength(1)
  expect(inspector.querySelector('.note-canvas-comparison-from')!.textContent).toContain('final written source sentence')
  expect(inspector.querySelector('.note-canvas-comparison-from .note-reader-excerpt-clip')).toBeNull()
  expect(inspector.querySelector('.note-canvas-location-details')?.hasAttribute('open')).toBe(false)
  const targetSections = [...inspector.querySelectorAll('.note-canvas-comparison-to')]
  expect(targetSections.every(section => !section.textContent?.includes('Exact target content 0'))).toBe(true)
  expect(targetSections.every(section => section.querySelector<HTMLElement>('.note-reader-excerpt-clip')?.style.maxHeight === '112px')).toBe(true)
  expect(targetSections.map(section => section.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('Exact target content 3'), expect.stringContaining('Exact target content 4'), expect.stringContaining('Exact target content 5')]))
  await act(async () => targetSections[2]!.querySelector<HTMLButtonElement>('.note-canvas-inspector-actions button')!.click())
  expect(open).toHaveBeenLastCalledWith((await store.read()).pages.target, 'target-5')
  await act(async () => inspector.querySelector<HTMLButtonElement>('.note-canvas-comparison-from .note-canvas-inspector-actions button')!.click())
  expect(open).toHaveBeenLastCalledWith((await store.read()).pages['closed-source'], 'long-source')
  expect(useAppStore.getState().documents['notes\0closed-source.note.md']).toEqual(draft)
  expect(useAppStore.getState().dirtyDocuments['notes\0closed-source.note.md']).toBe(true)
  expect(useAppStore.getState().noteCanvasLayouts[noteCanvasScopeKey(scope)]).toEqual(layout)
  expect(api.notebooks.graph).toHaveBeenCalledTimes(1); expect(api.notebooks.content).toHaveBeenCalledTimes(2)
})

it('keeps page targets whole and highlights their header without selecting an arbitrary original first block', async () => {
  await selectedFixture()
  await dom.render(<NoteCanvas scope={scope} onOpen={() => {}} />); await ready()
  await vi.waitFor(() => expect(targetCard().querySelector('.note-canvas-reader')).not.toBeNull())
  const page = dom.container.querySelector<HTMLButtonElement>('.note-canvas-edge-label[data-target-kind="page"]')!
  await act(async () => page.click())
  await vi.waitFor(() => expect(dom.container.querySelector('.note-canvas-whole-page')?.textContent).toContain('Whole page · no specific block'))
  expect(targetCard().querySelector('article')?.getAttribute('data-page-selected')).toBe('true')
  expect(targetCard().querySelector('[data-note-selected-block]')).toBeNull()
  expect(dom.container.querySelector('.note-canvas-comparison-to .note-canvas-reader')).toBeNull()
  expect(api.notebooks.content).toHaveBeenCalledTimes(2)
})

it('does not silently rebind a selected stored occurrence when its original reference ID is reused for a new target', async () => {
  await selectedFixture()
  const original = noteFromMarkdown(await readFile(join(directory, 'closed-source.note.md'), 'utf8'))
  original.content.content![0]!.content = [link('same-reference', 'target', 'target-3')]
  await writeFile(join(directory, 'closed-source.note.md'), serializeNoteDocument(original))
  await dom.render(<NoteCanvas scope={scope} onOpen={() => {}} />); await ready()
  await dom.click('.note-canvas-edge-label[data-target-kind="block"]')
  await vi.waitFor(() => expect(dom.container.querySelector('.note-canvas-comparison-to')?.textContent).toContain('Exact target content 3'))
  original.content.content![0]!.content = [link('same-reference', 'target', 'target-4')]
  await writeFile(join(directory, 'closed-source.note.md'), serializeNoteDocument(original))
  await dom.click('[aria-label="Refresh saved graph"]')
  await vi.waitFor(() => { const status = dom.container.querySelector('.note-canvas-inspector [role="status"]'); expect(status).not.toBeNull(); expect(status!.textContent).toContain('selected original occurrence is no longer') })
  expect(dom.container.querySelector('.note-canvas-inspector ol')).toBeNull()
  expect(targetCard().querySelector('[data-note-selected-block]')).toBeNull()
  await dom.click('.note-canvas-edge-label[data-target-kind="block"]')
  await vi.waitFor(() => expect(dom.container.querySelector('.note-canvas-comparison-to')?.textContent).toContain('Exact target content 4'))
})

it('reports partial expiry and keeps only unchanged original occurrences instead of selecting another aggregate candidate', async () => {
  await selectedFixture()
  const content = { schema: 'agentmux.note.v1', noteId: 'closed-source', content: { type: 'doc', content: [{ type: 'paragraph', attrs: { blockId: 'long-source' }, content: [link('kept', 'target', 'target-3'), link('changed', 'target', 'target-4')] }] } }
  await writeFile(join(directory, 'closed-source.note.md'), serializeNoteDocument(content as Parameters<typeof serializeNoteDocument>[0]))
  await dom.render(<NoteCanvas scope={scope} onOpen={() => {}} />); await ready()
  await dom.click('.note-canvas-edge-label[data-target-kind="block"]')
  await vi.waitFor(() => expect(dom.container.querySelectorAll('.note-canvas-comparison-to')).toHaveLength(2))
  content.content.content![0]!.content[1] = link('changed', 'target', 'target-5')
  await writeFile(join(directory, 'closed-source.note.md'), serializeNoteDocument(content as Parameters<typeof serializeNoteDocument>[0]))
  await dom.click('[aria-label="Refresh saved graph"]')
  await vi.waitFor(() => expect(dom.container.querySelector('.note-canvas-inspector [role="status"]')?.textContent).toContain('1 selected occurrence changed or disappeared. 1 unchanged occurrence remain selected.'))
  expect(dom.container.querySelectorAll('.note-canvas-comparison-to')).toHaveLength(1)
  await vi.waitFor(() => expect(dom.container.querySelector('.note-canvas-comparison-to')?.textContent).toContain('Exact target content 3'))
  expect(dom.container.querySelector('.note-canvas-comparison-to')?.textContent).not.toContain('Exact target content 5')
})

it('keeps More for uncovered original roots when selection is a descendant already covered by a displayed parent', async () => {
  const parent = { type: 'listItem', attrs: { blockId: 'parent-item' }, content: [paragraph('selected-child', 'An exact child inside its original item')] }
  await writeFile(join(directory, 'target.note.md'), serializeNoteDocument({ schema: 'agentmux.note.v1', noteId: 'target', content: { type: 'doc', content: [
    { type: 'orderedList', attrs: { start: 4 }, content: [parent] }, ...Array.from({ length: 3 }, (_, i) => paragraph('other-' + i, 'Other root ' + i)),
  ] } }))
  await writeFile(join(directory, 'closed-source.note.md'), serializeNoteDocument({ schema: 'agentmux.note.v1', noteId: 'closed-source', content: { type: 'doc', content: ['selected-child', 'parent-item', 'other-0', 'other-1', 'other-2'].map((id, i) => ({ type: 'paragraph', attrs: { blockId: 'source-' + i }, content: [link('link-' + i, 'target', id)] })) } }))
  const geometry = installNoteCanvasBlockRows()
  Object.assign(geometry.rows, { 'selected-child': 150, 'parent-item': 140, 'other-0': 200, 'other-1': 230, 'other-2': 260, 'source-0': 130, 'source-1': 180, 'source-2': 230 })
  await dom.render(<NoteCanvas scope={scope} onOpen={() => {}} />); await ready()
  await vi.waitFor(() => expect(targetCard().querySelector('.note-canvas-more')?.textContent).toBe('More 1 related blocks'))
  const exact = () => dom.container.querySelector<HTMLButtonElement>('.note-canvas-edge-label[data-target-block="selected-child"]')
  await vi.waitFor(() => expect(exact()).not.toBeNull())
  await act(async () => exact()!.click())
  await vi.waitFor(() => expect(targetCard().querySelector('[data-note-selected-block="selected-child"]')).not.toBeNull())
  expect(targetCard().querySelector('.note-canvas-more')?.textContent).toBe('More 1 related blocks')
  expect(targetCard().querySelector('[data-block-id="other-2"]')).toBeNull()
  await act(async () => targetCard().querySelector<HTMLButtonElement>('.note-canvas-more')!.click())
  await vi.waitFor(() => expect(targetCard().querySelector('[data-block-id="other-2"]')).not.toBeNull())
  expect(api.notebooks.content).toHaveBeenCalledTimes(2)
})

function noteFromMarkdown(content:string) { const read=readNoteDocument(content);expect(read.status).toBe('valid');if(read.status!=='valid')throw Error(read.message);return read.note }
