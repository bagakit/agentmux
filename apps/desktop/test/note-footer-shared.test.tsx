// @vitest-environment happy-dom
import { act } from 'react'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import { noteHistoryRevision } from '@agentmux/core/note-history'
import { noteInlineLinkContent } from '@agentmux/client-ui/note/note-wikilinks'
import { NoteLinksPanel } from '../src/renderer/src/components/NoteLinksPanel'
import { api } from '../src/renderer/src/lib/api'
import type { NoteFileTarget } from '../src/renderer/src/lib/file-document-consumers'
import { projectNoteLinks } from '../src/renderer/src/lib/note-graph-references'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { NotebookObservationOwner } from '@agentmux/host/notebook-observation-owner'
import { newNoteDocument, serializeNoteDocument } from '../src/shared/note-document'
import { composerDOM } from './helpers/composer-dom-fixture'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'
import { noteSummaryCases, noteSummaryContent } from './helpers/note-summary-fixture'
import { noteKnowledge } from '@agentmux/client-ui/note/note-knowledge'

const dom = composerDOM(), cleanups: Array<() => Promise<unknown>> = []
beforeEach(installNoteCanvasGeometry)
afterEach(async () => { await dom.render(null); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
afterAll(() => vi.unstubAllGlobals())
async function fixture(partial = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amx-note-footer-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const workspace = { id: 'notes', hostId: 'local', name: 'Notes', path: root, kind: 'folder' as const }
  const files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' }) as never); cleanups.push(() => files.dispose())
  const metadata = new AgentMuxNotebookStore(join(root, 'catalog.sqlite'))
  const owner = new NotebookObservationOwner({ files, workspace: id => id === workspace.id ? workspace : undefined, metadata })
  const resource = (id: string) => ({ hostId: 'local', workspaceId: workspace.id, workspacePath: root, path: `${id}.note.md` })
  const shared = newNoteDocument('One shared original', 'shared', 'shared-body'); shared.kind = 'shared-block'; shared.title = 'Shared decision'
  shared.origin = { operationId: 'extract', sourceNoteId: 'source', sourcePath: resource('source').path, sourceRevision: noteHistoryRevision('Before extraction'), sourceBlockId: 'source-use' }
  await writeFile(join(root, resource('shared').path), serializeNoteDocument(shared))
  for (const id of ['source', 'reader', 'other']) {
    const note = newNoteDocument(`Original ${id}`, id, `${id}-body`)
    const uses = id === 'reader' ? ['reader-first', 'reader-second'] : [id === 'source' ? 'extract:source' : 'other-use']
    uses.forEach((referenceId, index) => note.content.content!.push({ type: 'noteInclude', attrs: { blockId: id === 'source' ? 'source-use' : `${id}-use-${index}`, referenceId, noteId: shared.noteId, path: resource('shared').path, workspaceId: workspace.id } }))
    if (id === 'reader') note.content.content![0]!.content!.push(noteInlineLinkContent({ referenceId: 'page-link', text: 'Other page', target: { noteId: 'other' } }))
    await writeFile(join(root, resource(id).path), serializeNoteDocument(note))
    await metadata.apply({ expectedRevision: (await metadata.read()).revision, operationId: `register-${id}`, change: { kind: 'register', noteId: id, title: `Original ${id}`, resource: resource(id) } }, { kind: 'user', id: 'reader' })
  }
  if (partial) await metadata.apply({ expectedRevision: (await metadata.read()).revision, operationId: 'register-unread', change: { kind: 'register', noteId: 'unread', title: 'Unread page', resource: resource('unread') } }, { kind: 'user', id: 'reader' })
  vi.spyOn(api.notebooks, 'graph').mockImplementation(async (params, options) => { const catalog = await metadata.read(); return { catalog, graph: await owner.graph(catalog, params, options) } })
  vi.spyOn(api.notebooks, 'content').mockImplementation(async (id, options) => owner.content(await metadata.read(), id, options))
  const onOpen = vi.fn(), onOpenFile = vi.fn(async (target: NoteFileTarget, _block?: string, signal?: AbortSignal) => {
    signal?.throwIfAborted(); expect(target).toEqual({ ...resource('shared'), noteId: shared.noteId })
    const original = await files.read(workspace, target.path)
    expect(original.status).toBe('read')
    if (original.status === 'read') expect(original.document.content).toBe(serializeNoteDocument(shared))
  })
  const mount = (noteId = 'reader', active = true) => dom.render(<NoteLinksPanel noteId={noteId} active={active} onOpen={onOpen} onOpenFile={onOpenFile} />)
  return { root, metadata, resource, shared, onOpen, onOpenFile, mount }
}
async function clickText(text: string, owner: ParentNode = dom.container) {
  const button = [...owner.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent?.trim() === text)
  expect(button, `Expected button ${text}`).toBeDefined(); await act(async () => button!.click())
}
async function openShared() {
  await dom.click('.note-links-toggle')
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Links from this note (1)'))
  await clickText('Shared content')
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Shared decision'))
}

it('keeps page links separate from exact shared occurrences and opens an uncatalogued original through Files', async () => {
  const f = await fixture(); await f.mount()
  expect(api.notebooks.graph).not.toHaveBeenCalled(); expect(api.notebooks.content).not.toHaveBeenCalled()
  await openShared()
  expect((await f.metadata.read()).pages.shared).toBeUndefined()
  expect(dom.container.querySelectorAll('.note-links-shared-original')).toHaveLength(1)
  expect(dom.container.querySelectorAll('.note-links-shared-use')).toHaveLength(2)
  expect(dom.container.textContent).toContain('2 uses here')
  expect(api.notebooks.content).toHaveBeenCalledTimes(1)
  await dom.click('[data-use-position="reader-use-1"] > .note-links-target')
  expect(f.onOpen).toHaveBeenLastCalledWith((await f.metadata.read()).pages.reader, 'reader-use-1', expect.any(AbortSignal))
  await clickText('Shared decision')
  expect(f.onOpenFile).toHaveBeenCalledExactlyOnceWith({ ...f.resource('shared'), noteId: 'shared' }, undefined, expect.any(AbortSignal))
  await dom.click('.note-links-shared-use [aria-haspopup="dialog"]')
  await vi.waitFor(() => expect(document.querySelector('.note-shared-details')?.textContent).toContain('3 documents · 4 uses'))
  const details = document.querySelector('.note-shared-details')!
  expect(details.textContent).toContain('Originally extracted atOriginal source')
  expect(details.querySelectorAll('.note-shared-details__uses li')).toHaveLength(4)
  await clickText('Open shared content', details)
  expect(f.onOpenFile).toHaveBeenCalledTimes(2)
  const snapshot = await api.notebooks.graph({})
  expect(projectNoteLinks(snapshot, 'reader')).toMatchObject({ incoming: [], outgoing: [expect.objectContaining({ mode: 'link' })], sharedOutgoing: [expect.anything(), expect.anything()] })
  expect(projectNoteLinks(snapshot, 'other').incoming).toHaveLength(1)
  expect(projectNoteLinks(snapshot, 'source').incoming).toHaveLength(0)
})

it('keeps confirmed original navigation available when the details read fails and qualifies partial counts', async () => {
  const f = await fixture(true)
  vi.mocked(api.notebooks.content).mockRejectedValue(new Error('Original detail reader unavailable'))
  await f.mount(); await dom.click('.note-links-toggle')
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Links from this note (at least 1)'))
  expect(dom.container.querySelector('.note-links-toggle')!.textContent).toBe('Linked references')
  expect([...dom.container.querySelectorAll('.note-links-state')].some(node => node.textContent?.includes('Partial link coverage'))).toBe(false)
  const coverage = dom.container.querySelector<HTMLDetailsElement>('.note-links-coverage')!
  expect(coverage.open).toBe(false); expect(coverage.querySelector('summary')!.getAttribute('aria-description')).toBe('Partial link coverage')
  await act(async () => coverage.querySelector('summary')!.click())
  expect(coverage.open).toBe(true);expect(coverage.textContent).toContain('Saved partial catalog');expect(coverage.textContent).toContain('originals read')
  await dom.click('.note-links-toggle')
  expect(dom.container.querySelector('.note-links-toggle')!.textContent).toBe('Linked references')
  expect(dom.container.querySelector('.note-links-toggle')!.getAttribute('aria-description')).toBe('Partial link coverage')
  expect(dom.container.querySelector('.note-links-toggle [data-semantic-icon="status.unknown"]')).not.toBeNull()
  await dom.click('.note-links-toggle')
  await clickText('Shared content')
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Original detail reader unavailable'))
  const original = dom.container.querySelector<HTMLButtonElement>('.note-links-shared-original .note-links-target')!
  expect(original.textContent).toBe('Shared content'); await act(async () => original.click())
  expect(f.onOpenFile).toHaveBeenCalledOnce()
  expect(dom.container.querySelectorAll('.note-links-shared-use')).toHaveLength(2)
})

it('shows incoming shared uses in their own group when reading the uncatalogued original', async () => {
  const f = await fixture(); await f.mount('shared'); await dom.click('.note-links-toggle')
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Links to this note (0)'))
  expect(dom.container.querySelector('.note-links-source')).toBeNull()
  await clickText('Shared content')
  expect(dom.container.textContent).toContain('Uses of this content')
  expect(dom.container.querySelectorAll('.note-links-source')).toHaveLength(3)
  await dom.click('[aria-label="Open source note: Original other"]')
  expect(f.onOpen).toHaveBeenLastCalledWith((await f.metadata.read()).pages.other, undefined, expect.any(AbortSignal))
  expect(f.onOpenFile).not.toHaveBeenCalled()
})

it('retains navigation failure in the footer and aborts an unfinished original open when hidden', async () => {
  const f = await fixture(); await f.mount(); await openShared()
  f.onOpenFile.mockRejectedValueOnce(new Error('Original navigation unavailable'))
  await clickText('Shared decision')
  expect(dom.container.textContent).toContain('Original navigation unavailable')
  let pending: AbortSignal | undefined
  f.onOpenFile.mockImplementationOnce((_target, _block, signal) => new Promise((_resolve, reject) => { pending = signal; signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }) }))
  await clickText('Shared decision'); expect(pending?.aborted).toBe(false)
  await f.mount('reader', false); expect(pending?.aborted).toBe(true)
  expect(dom.container.querySelectorAll('.note-links-shared-use')).toHaveLength(2)
})

it('cancels a registered use-location open and keeps its rejected result visible in the same footer', async () => {
  const f = await fixture(); await f.mount(); await openShared()
  f.onOpen.mockRejectedValueOnce(new Error('Original use position unavailable'))
  await dom.click('[data-use-position="reader-use-1"] > .note-links-target')
  expect(dom.container.textContent).toContain('Original use position unavailable')
  let pending: AbortSignal | undefined
  f.onOpen.mockImplementationOnce((_page, _block, signal) => new Promise((_resolve, reject) => { pending = signal; signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }) }))
  await dom.click('[data-use-position="reader-use-1"] > .note-links-target'); expect(pending?.aborted).toBe(false)
  await f.mount('reader', false); expect(pending?.aborted).toBe(true)
})

it('passes a closed shared-details navigation cancellation through the footer to the file owner', async () => {
  const f = await fixture(); await f.mount(); await openShared()
  let pending: AbortSignal | undefined
  f.onOpenFile.mockImplementationOnce((_target, _block, signal) => new Promise((_resolve, reject) => { pending = signal; signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }) }))
  await dom.click('.note-links-shared-use [aria-haspopup="dialog"]')
  await vi.waitFor(() => expect(document.querySelector('.note-shared-details')).not.toBeNull())
  await clickText('Open shared content', document.querySelector('.note-shared-details')!)
  expect(pending?.aborted).toBe(false)
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Close shared details"]')!.click())
  expect(pending?.aborted).toBe(true)
  expect(dom.container.querySelectorAll('.note-links-shared-use')).toHaveLength(2)
})

it.each(noteSummaryCases)('uses readable $name for the original shared footer without changing indexed text or source bytes', async example => {
  const f = await fixture()
  delete f.shared.title
  if (example.title) f.shared.title = example.title
  f.shared.content = noteSummaryContent(example)
  const path = join(f.root, f.resource('shared').path), original = serializeNoteDocument(f.shared)
  await writeFile(path, original)
  await f.mount(); await dom.click('.note-links-toggle')
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Links from this note (1)'))
  await clickText('Shared content')
  await vi.waitFor(() => expect(dom.container.querySelector('.note-links-shared-original .note-links-source-heading .note-links-target')?.textContent).toBe(example.expected))
  await clickText(example.expected)
  expect(f.onOpenFile).toHaveBeenCalledExactlyOnceWith({ ...f.resource('shared'), noteId: 'shared' }, undefined, expect.any(AbortSignal))
  expect(await readFile(path, 'utf8')).toBe(original)
  const observed = await api.notebooks.content('shared')
  if (observed.status !== 'read') throw new Error('Expected the original shared file')
  const source = noteKnowledge([{ location: { workspaceId: 'notes', path: observed.resource.path }, document: { path: observed.resource.path, content: observed.content, revision: observed.revision } }]).sources[0]!
  expect(source.blocks.get(example.indexedBlock)?.text).toBe(example.indexedText)
})
