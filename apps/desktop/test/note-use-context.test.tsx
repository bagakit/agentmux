// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { NotebookObservationOwner } from '@agentmux/host/notebook-observation-owner'
import { NoteSharedDetails } from '../src/renderer/src/components/NoteSharedDetails'
import { NoteLinksPanel } from '../src/renderer/src/components/NoteLinksPanel'
import { noteSharedRelations, noteUseContext } from '../src/renderer/src/lib/note-shared-relations'
import { noteKnowledge } from '@agentmux/client-ui/note/note-knowledge'
import { api } from '../src/renderer/src/lib/api'
import { newNoteDocument, serializeNoteDocument } from '../src/shared/note-document'
import { composerDOM } from './helpers/composer-dom-fixture'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'

const dom = composerDOM(), cleanups: Array<() => Promise<unknown>> = []
let visible = true
const observers = new Set<{ update(): void }>()
beforeEach(() => {
  installNoteCanvasGeometry(); visible = true
  vi.stubGlobal('IntersectionObserver', class {
    elements = new Set<Element>()
    constructor(private callback: IntersectionObserverCallback) { observers.add(this) }
    observe(element: Element) { this.elements.add(element); queueMicrotask(() => this.update()) }
    update() { this.callback([...this.elements].map(target => ({ target, isIntersecting: visible } as IntersectionObserverEntry)), this as never) }
    disconnect() { this.elements.clear(); observers.delete(this) }
    unobserve(element: Element) { this.elements.delete(element) }
  })
})
afterEach(async () => { await dom.render(null); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllGlobals() })

async function fixture(sharedHost = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amx-note-use-context-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const workspace = { id: 'notes', hostId: 'local', name: 'Notes', path: root, kind: 'folder' as const }
  const files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' }) as never); cleanups.push(() => files.dispose())
  const metadata = new AgentMuxNotebookStore(join(root, 'catalog.sqlite'))
  const owner = new NotebookObservationOwner({ files, workspace: id => id === workspace.id ? workspace : undefined, metadata })
  const resource = (id: string) => ({ hostId: 'local', workspaceId: workspace.id, workspacePath: root, path: `${id}.note.md` })
  const shared = newNoteDocument('The shared body is not a location excerpt.', 'shared', 'shared-body'); shared.kind = 'shared-block'; shared.title = 'Shared evidence'
  await writeFile(join(root, resource('shared').path), serializeNoteDocument(shared))
  const host = newNoteDocument('', 'reader', 'empty')
  if (sharedHost) { host.kind = 'shared-block'; host.title = 'Nested shared host' }
  host.content.content = ['First', 'Second'].flatMap((section, index) => [
    { type: 'heading', attrs: { blockId: `section-${index}`, level: 2 }, content: [{ type: 'text', text: `${section} section` }] },
    { type: 'paragraph', attrs: { blockId: `context-${index}` }, content: [{ type: 'text', text: `Local ${section.toLowerCase()} evidence belongs here.` }] },
    { type: 'noteInclude', attrs: { blockId: `use-${index}`, referenceId: `reader-${index}`, noteId: shared.noteId, path: resource('shared').path, workspaceId: workspace.id } }
  ])
  await writeFile(join(root, resource('reader').path), serializeNoteDocument(host))
  if (sharedHost) {
    const outer = newNoteDocument('', 'outer', 'outer-empty')
    outer.content.content = [{ type: 'noteInclude', attrs: { blockId: 'outer-use', referenceId: 'outer-reader', noteId: host.noteId, path: resource('reader').path, workspaceId: workspace.id } }]
    await writeFile(join(root, resource('outer').path), serializeNoteDocument(outer))
  }
  const registered = sharedHost ? 'outer' : 'reader'
  await metadata.apply({ expectedRevision: (await metadata.read()).revision, operationId: 'register-host', change: { kind: 'register', noteId: registered, title: 'Same host page', resource: resource(registered) } }, { kind: 'user', id: 'reader' })
  const catalog = await metadata.read(), snapshot = { catalog, graph: await owner.graph(catalog, {}) }
  vi.spyOn(api.notebooks, 'graph').mockImplementation(async () => snapshot)
  vi.spyOn(api.notebooks, 'content').mockImplementation(async (id, options) => owner.content(await metadata.read(), id, options))
  const onOpen = vi.fn(async (target, _block?: string, signal?: AbortSignal) => { signal?.throwIfAborted(); expect((await files.read(workspace, target.path)).status).toBe('read') })
  const graph = { snapshot, issue: null, stale: false, busy: false, refresh: vi.fn() }
  const mount = (active = true) => dom.render(<section data-workbench-region-id="context-reader"><NoteSharedDetails note={shared} target={{ ...resource('shared'), noteId: shared.noteId }} host={{ ...resource('reader'), noteId: host.noteId }} include={{ referenceId: 'reader-0', noteId: shared.noteId, path: resource('shared').path }} graph={graph} active={active} onOpen={onOpen} /></section>)
  return { root, host, shared, snapshot, graph, metadata, owner, resource, onOpen, mount }
}
const panel = () => document.querySelector('.note-shared-details')!
async function open() { await dom.click('.note-shared-block__marker'); await vi.waitFor(() => expect(panel()).not.toBeNull()) }
const row = (block: string, root: ParentNode = document) => root.querySelector(`[data-use-position="${block}"]`)!

it('reads the original host once for two visible uses, showing distinct saved sections and exact navigation', async () => {
  const f = await fixture(); await f.mount()
  expect(api.notebooks.content).not.toHaveBeenCalled()
  await open()
  await vi.waitFor(() => expect(row('use-1', panel()).textContent).toContain('Second section'))
  expect(row('use-0', panel()).textContent).toContain('Local first evidence belongs here.')
  expect(row('use-1', panel()).textContent).toContain('Local second evidence belongs here.')
  expect(panel().textContent).not.toContain('The shared body is not a location excerpt.')
  expect(row('use-0', panel()).textContent).toContain('Current position')
  expect(api.notebooks.content).toHaveBeenCalledTimes(1)
  expect(api.notebooks.content).toHaveBeenCalledWith('reader', expect.objectContaining({ maxBytes: 256 * 1024, signal: expect.any(AbortSignal) }))
  await act(async () => row('use-1', panel()).querySelector<HTMLButtonElement>('button')!.click())
  expect(f.onOpen).toHaveBeenCalledExactlyOnceWith({ ...f.resource('reader'), noteId: 'reader' }, 'use-1', expect.any(AbortSignal))
})

it('keeps closed, hidden and offscreen locations out of content work, then reads the original on visibility', async () => {
  const f = await fixture(); visible = false; await f.mount(); await open()
  expect(api.notebooks.content).not.toHaveBeenCalled()
  await act(async () => { visible = true; observers.forEach(observer => observer.update()) })
  await vi.waitFor(() => expect(row('use-0', panel()).textContent).toContain('First section'))
  expect(api.notebooks.content).toHaveBeenCalledTimes(1)
  await f.mount(false)
  expect(document.querySelector('.note-shared-details')).toBeNull()
})

it('shows the same context from the original footer and retains its exact occurrence target', async () => {
  const f = await fixture(), onOpen = vi.fn()
  await dom.render(<NoteLinksPanel noteId="reader" onOpen={onOpen} onOpenFile={f.onOpen} />)
  await dom.click('.note-links-toggle')
  const button = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === 'Shared content')!
  await act(async () => button.click())
  await vi.waitFor(() => expect(row('use-1', dom.container).textContent).toContain('Second section'))
  expect(row('use-0', dom.container).textContent).toContain('Local first evidence')
  expect(dom.container.textContent).not.toContain('Go to use 1')
  expect(vi.mocked(api.notebooks.content).mock.calls.filter(([id]) => id === 'reader')).toHaveLength(1)
  await act(async () => row('use-1', dom.container).querySelector<HTMLButtonElement>('.note-links-target')!.click())
  expect(onOpen).toHaveBeenLastCalledWith(f.snapshot.catalog.pages.reader, 'use-1', expect.any(AbortSignal))
  await dom.click('.note-links-shared-use [aria-haspopup="dialog"]')
  await vi.waitFor(() => expect(row('use-1', panel()).textContent).toContain('Second section'))
  expect(vi.mocked(api.notebooks.content).mock.calls.filter(([id]) => id === 'reader')).toHaveLength(1)
})

it('does not borrow a later saved revision or a wrong resource, while original navigation stays available', async () => {
  const f = await fixture(), read = vi.mocked(api.notebooks.content).getMockImplementation()!
  vi.mocked(api.notebooks.content).mockImplementation(async (...args) => {
    const value = await read(...args)
    return value.status === 'read' ? { ...value, revision: 'later-unmatched-revision' } : value
  })
  await f.mount(); await open()
  await vi.waitFor(() => expect(row('use-0', panel()).textContent).toContain('Position context changed'))
  expect(panel().textContent).not.toContain('Local first evidence')
  await act(async () => row('use-0', panel()).querySelector<HTMLButtonElement>('button')!.click())
  expect(f.onOpen).toHaveBeenCalledOnce()
  vi.mocked(api.notebooks.content).mockImplementation(async (...args) => {
    const value = await read(...args)
    return { ...value, resource: { ...value.resource, path: 'another.note.md' } }
  })
  await open()
  await vi.waitFor(() => expect(row('use-1', panel()).textContent).toContain('Position context changed'))
  expect(panel().textContent).not.toContain('Local second evidence')
})

it('cancels hidden position reads and never installs their late bodies into a later opening', async () => {
  const f = await fixture(), read = vi.mocked(api.notebooks.content).getMockImplementation()!
  let signal: AbortSignal | undefined, finish!: () => Promise<void>
  vi.mocked(api.notebooks.content).mockImplementation((...args) => new Promise(resolve => {
    signal = args[1]?.signal; finish = async () => { resolve(await read(args[0], {})) }
  }))
  await f.mount(); await open(); await vi.waitFor(() => expect(signal).toBeDefined())
  await act(async () => panel().querySelector<HTMLButtonElement>('[aria-label="Close shared details"]')!.click()); expect(signal?.aborted).toBe(true)
  await act(async () => finish())
  expect(document.querySelector('.note-shared-details')).toBeNull()
  vi.mocked(api.notebooks.content).mockImplementation(read)
  await open(); await vi.waitFor(() => expect(row('use-1', panel()).textContent).toContain('Second section'))
})

it('keeps failed context navigation usable and does not guess another position or included body', async () => {
  const f = await fixture()
  vi.mocked(api.notebooks.content).mockRejectedValue(Error('Original host read unavailable'))
  await f.mount(); await open()
  await vi.waitFor(() => expect(row('use-1', panel()).textContent).toContain('Original host read unavailable'))
  await act(async () => row('use-1', panel()).querySelector<HTMLButtonElement>('button')!.click())
  expect(f.onOpen).toHaveBeenLastCalledWith({ ...f.resource('reader'), noteId: 'reader' }, 'use-1', expect.any(AbortSignal))
  const content = await f.owner.content(await f.metadata.read(), 'reader')
  if (content.status !== 'read') throw Error('Original fixture was not readable')
  const source = noteKnowledge([{ location: { workspaceId: content.resource.workspaceId, path: content.resource.path }, document: { path: content.resource.path, content: content.content, revision: content.revision } }]).sources[0]!
  const reference = noteSharedRelations(f.snapshot, 'shared', undefined, { target: { ...f.resource('reader'), noteId: 'reader' }, referenceId: 'reader-0' }).uses[0]!.reference
  expect(noteUseContext(source, { ...reference, source: { ...reference.source, blockId: 'unconfirmed-block' } }).status).toBe('unknown')
  expect(noteUseContext(source, { ...reference, occurrence: { kind: 'stored', referenceId: 'different-occurrence' } }).status).toBe('unknown')
})

it('reads exact use contexts from an uncatalogued shared host found through a real outer include', async () => {
  const f = await fixture(true)
  expect(f.snapshot.catalog.pages.reader).toBeUndefined()
  expect(f.snapshot.graph.observations.find(item => item.noteId === 'reader')).toMatchObject({ kind: 'shared-block', fileIdentity: 'confirmed' })
  await f.mount(); await open()
  await vi.waitFor(() => expect(row('use-1', panel()).textContent).toContain('Second section'))
  expect(row('use-0', panel()).textContent).toContain('Nested shared host')
  expect(row('use-0', panel()).textContent).toContain('Local first evidence belongs here.')
  expect(api.notebooks.content).toHaveBeenCalledTimes(1)
  await act(async () => row('use-1', panel()).querySelector<HTMLButtonElement>('button')!.click())
  expect(f.onOpen).toHaveBeenCalledExactlyOnceWith({ ...f.resource('reader'), noteId: 'reader' }, 'use-1', expect.any(AbortSignal))
})
