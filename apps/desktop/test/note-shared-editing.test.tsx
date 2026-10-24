// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Editor } from '@tiptap/core'
import { createWorkspaceLayout } from '@agentmux/layout'
import { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import { computeNoteLiveMerge } from '@agentmux/client-ui/note/note-live-merge.worker'
import { noteHistoryRevision } from '@agentmux/core/note-history'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { NoteFileWriter } from '@agentmux/host/note-file-writer'
import { FileReadOwner } from '@agentmux/host/file-read-owner'
import { NoteSharedBlockOwner } from '@agentmux/host/note-shared-block-owner'
import { NoteSharedUndoOwner } from '@agentmux/host/note-shared-undo-owner'
import { NoteSharedFileDeleteOwner } from '@agentmux/host/note-shared-file-delete-owner'
import { NotebookObservationOwner } from '@agentmux/host/notebook-observation-owner'
import { NoteFileSurfaceView } from '../src/renderer/src/components/NoteFileSurfaceView'
import { NoteVersionHistory } from '../src/renderer/src/components/NoteVersionHistory'
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { afterNoteComposition } from '../src/renderer/src/lib/note-live-merge'
import { useNotebookLibrary } from '../src/renderer/src/lib/notebook-library'
import { createWorkbenchTab, documentKey, type FileWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'
import { directoryIdentity, homeZoneId, workspaceZoneId } from '../src/shared/space-addresses'
import { newNoteDocument, readNoteDocument, serializeNoteDocument } from '../src/shared/note-document'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { NoteSnapshotTestWorker } from './note-snapshot-test-worker'
const dom = composerDOM(), cleanups: Array<() => Promise<unknown>> = []
// These mounted cases run the real multi-stage file helpers and journals, not a fake in-memory save.
vi.setConfig({ testTimeout: 20000 })
class NoteWorker extends NoteSnapshotTestWorker {
  onmessageerror = null
  override postMessage(input: Parameters<NoteSnapshotTestWorker['postMessage']>[0] | { base: string; current: string; proposed: string }) {
    if ('base' in input) queueMicrotask(() => this.onmessage?.({ data: computeNoteLiveMerge(input) } as never))
    else super.postMessage(input)
  }
}
beforeEach(() => vi.stubGlobal('Worker', NoteWorker))
afterEach(async () => { await dom.render(null); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllGlobals(); useNotebookLibrary.setState({ state: null, issue: null }) })
async function fixture(count = 2, undoAfterStage?: import('@agentmux/host/note-shared-undo-owner').NoteSharedUndoPorts['afterStage']) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amx-note-shared-ui-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const workspace = { id: 'notes', hostId: 'local', name: 'Notes', path: root, kind: 'folder' as const }, birth = directoryIdentity('local', root), zoneId = homeZoneId(birth)
  const files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' }) as never); cleanups.push(() => files.dispose())
  const metadata = new AgentMuxNotebookStore(join(root, 'state', 'notes.sqlite')), observation = new NotebookObservationOwner({ workspace: id => id === workspace.id ? workspace : undefined, files, metadata })
  const writer = new NoteFileWriter(files, { state: () => metadata.read(), owner: observation }, metadata)
  const notes = [newNoteDocument('Original knowledge', 'source', 'source-first'), newNoteDocument('Destination prose', 'destination', 'dest-first')]
  if (count === 3) notes.push(newNoteDocument('Another use', 'another', 'another-first'))
  const surfaces = notes.map(note => ({ kind: 'file' as const, workspaceId: workspace.id, path: note.noteId + '.note.md', regionId: note.noteId + '-region' }))
  const tabs = surfaces.map(surface => ({ ...createWorkbenchTab(surface.path, surface), space: { spaceId: birth, zoneId } }))
  for (const [index, note] of notes.entries()) {
    note.content.content!.push({ type: 'paragraph', attrs: { blockId: note.noteId + '-outside' }, content: [{ type: 'text', text: 'Outside ' + note.noteId }] })
    expect((await writer.write(workspace, { path: surfaces[index]!.path, content: serializeNoteDocument(note), expectedRevision: null })).status).toBe('written')
    await metadata.apply({ operationId: 'register-' + note.noteId, expectedRevision: (await metadata.read()).revision, change: { kind: 'register', noteId: note.noteId, title: note.noteId, resource: { hostId: 'local', workspaceId: workspace.id, workspacePath: root, path: surfaces[index]!.path } } }, { kind: 'user', id: 'person' })
  }
  const documents: Record<string, import('../src/shared/contracts').FileDocument> = {}
  for (const surface of surfaces) { const read = await writer.read(workspace, surface.path); if (read.status !== 'read') throw Error('Original must read'); documents[documentKey(workspace.id, surface.path)] = read.document }
  useAppStore.setState({ config: { ...composerConfig, workspaces: [workspace] }, activeWorkspaceId: workspace.id, tabs: Object.fromEntries(tabs.map(tab => [tab.id, tab])), layouts: { [workspace.id]: createWorkspaceLayout('group', tabs.map(tab => tab.id)) }, documents, dirtyDocuments: {}, savingDocuments: {}, documentIssues: {}, documentGenerations: {}, documentObservationGenerations: {}, workspaceFileRevisions: {}, documentRevealTargets: {}, noteBlockSelections: {}, noteDirectorySources: {}, spaceZoneBindings: { [zoneId]: { spaceId: birth, workspaceId: workspace.id, directoryPath: root } }, scratchTopicSnapshots: {}, retainedDocumentDrafts: {}, error: null })
  let sharing!: NoteSharedBlockOwner
  const publicFiles = new FileReadOwner({ share: { share: (params, context) => sharing.share(params, context), undoShare: (params, context) => sharing.undoShare(params, context), inspectShare: (params, context) => sharing.inspectShare(params, context) }, catalog: async () => ({ zones: [{ zoneId, workspaceId: workspace.id, hostId: 'local', kind: 'directory', directoryPath: root }], bindings: [{ zoneId, spaceId: birth }] }) as never,
    workspace: id => id === workspace.id ? workspace : undefined, files: { read: writer.read.bind(writer), listFiles: files.listFiles.bind(files), history: writer.history.bind(writer), write: writer.write.bind(writer), writeSharedUndo: writer.writeSharedUndo.bind(writer), createShared: writer.createShared.bind(writer) } })
  const deletion = new NoteSharedFileDeleteOwner(files, metadata)
  const undo = new NoteSharedUndoOwner({ files, workspaces: async () => ({ workspaces: [workspace], complete: true }), target: publicFiles.targetForNote.bind(publicFiles), read: publicFiles.read.bind(publicFiles), write: publicFiles.write.bind(publicFiles), writeInverse: publicFiles.writeSharedInverse.bind(publicFiles), history: metadata.readHistory.bind(metadata), operation: metadata.readHistoryOperation.bind(metadata), lease: metadata.runWithWriteLease.bind(metadata), delete: (resource, input, context) => deletion.delete(workspace, input, context), ...(undoAfterStage ? { afterStage: undoAfterStage } : {}) })
  sharing = new NoteSharedBlockOwner({ undo, files: { read: publicFiles.read.bind(publicFiles), write: publicFiles.write.bind(publicFiles), createShared: publicFiles.createShared.bind(publicFiles), writeInverse: publicFiles.writeSharedInverse.bind(publicFiles) }, historyOperation: metadata.readHistoryOperation.bind(metadata), withWriteLease: metadata.runWithWriteLease.bind(metadata) })
  const inFlight = new Set<Promise<unknown>>()
  const track = <T,>(promise: Promise<T>) => { inFlight.add(promise); void promise.then(() => inFlight.delete(promise), () => inFlight.delete(promise)); return promise }
  cleanups.push(async () => { while (inFlight.size) await Promise.allSettled([...inFlight]) })
  vi.spyOn(api.files, 'readPublic').mockImplementation(input => track(publicFiles.read(input)))
  vi.spyOn(api.files, 'sharePublic').mockImplementation(input => track(publicFiles.share(input, { actor: { kind: 'user', id: 'person' } })))
  vi.spyOn(api.files, 'shareUndoPublic').mockImplementation(input => track(publicFiles.undoShare(input, { actor: { kind: 'user', id: 'person' } })))
  vi.spyOn(api.files, 'inspectSharePublic').mockImplementation(input => track(publicFiles.inspectShare(input)))
  vi.spyOn(api.files, 'historyPublic').mockImplementation(input => track(publicFiles.history(input)))
  vi.spyOn(api.files, 'read').mockImplementation((_workspace, path) => track(writer.read(workspace, path)))
  vi.spyOn(api.files, 'write').mockImplementation((_workspace, input) => writer.write(workspace, input, { actor: { kind: 'user', id: 'person' } }))
  vi.spyOn(api.files, 'observe').mockResolvedValue(); vi.spyOn(api.files, 'unobserve').mockResolvedValue()
  vi.spyOn(api.notebooks, 'read').mockImplementation(() => metadata.read())
  vi.spyOn(api.notebooks, 'graph').mockImplementation((params, options) => track((async () => { const catalog = await metadata.read(); return { catalog, graph: await observation.graph(catalog, params, options) } })()))
  vi.spyOn(api.notebooks, 'content').mockImplementation((id, options) => track((async () => observation.content(await metadata.read(), id, options))()))
  useNotebookLibrary.setState({ state: await metadata.read() })
  const mount = (visible = surfaces.map((_, index) => index)) => dom.render(<>{surfaces.flatMap((surface, index) => visible.includes(index) ? [<section key={surface.regionId} data-test-note={surface.regionId}><WorkbenchPresentationContext.Provider value={{ active: true, retainedRegionId: null, tabHostId: 'primary', reference: { displayWorkspaceId: workspace.id, groupId: 'group', tabId: tabs[index]!.id, regionId: surface.regionId } }}><NoteFileSurfaceView tabId={tabs[index]!.id} surface={surface} /></WorkbenchPresentationContext.Provider></section>] : [])}</>)
  const rich = (index: number, embedded = false) => {
    const section = dom.container.querySelector(`[data-test-note="${surfaces[index]!.regionId}"]`)!
    const selector = embedded ? '.note-shared-content .note-block-content' : '.note-original-editor > div .note-block-content'
    const element = section.querySelector<HTMLElement>(selector) ?? section.querySelector<HTMLElement>('.note-block-content')
    return (element as HTMLElement & { editor: Editor }).editor
  }
  let copied!: DataTransfer
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn((command: string) => { if (command !== 'copy') return false; copied = new DataTransfer(); document.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: copied })); return true }) })
  const copy = async () => { const button = dom.container.querySelector<HTMLButtonElement>('[data-test-note="source-region"] .note-block-action')!; await act(async () => button.click()); if (!copied) throw Error(dom.container.textContent ?? 'Copy did not run'); return copied }
  const paste = async (data: DataTransfer, index = 1) => { const editor = rich(index); await act(async () => { editor.view.focus(); editor.commands.setTextSelection(editor.state.doc.content.size - 1); editor.view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })) }) }
  return { root, workspace, surfaces, tabs, files, writer, metadata, mount, rich, copy, paste, documents, clipboard: () => copied,
    save(index = 1) { return useAppStore.getState().saveDocument(tabs[index]!.id, surfaces[index]!.regionId) } }
}
it('copies without files, pastes into an actual undo transaction and creates no entity after undo and save', async () => {
  const f = await fixture(); await f.mount()
  expect(dom.container.querySelector('[aria-label="Reference block"]')).toBeNull()
  const copied = await f.copy(); expect(copied.getData('text/html')).toContain('data-note-share')
  expect((await readdir(f.root)).filter(name => name.endsWith('.note.md'))).toHaveLength(2)
  await f.paste(copied)
  const ticket = Object.values(useAppStore.getState().documents[documentKey(f.workspace.id, 'destination.note.md')]!.noteEditing!.shares!)[0]!
  expect(ticket.copy.block.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/)
  expect(JSON.stringify(ticket)).not.toContain('Original knowledge')
  expect(f.rich(1).getJSON().content!.some(node => node.type === 'noteInclude')).toBe(true)
  expect(api.files.sharePublic).not.toHaveBeenCalled()
  await act(async () => { f.rich(1).commands.undo() })
  await act(async () => { await f.save() })
  expect(api.files.sharePublic).not.toHaveBeenCalled()
  expect((await readdir(f.root)).filter(name => name.startsWith('block-'))).toEqual([])
  expect(await readFile(join(f.root, 'source.note.md'), 'utf8')).toContain('Original knowledge')
})
async function richCopyFixture(kind: 'task' | 'table') {
  const f = await fixture(), key = documentKey(f.workspace.id, 'source.note.md'), original = readNoteDocument(f.documents[key]!.content)
  if (original.status !== 'valid') throw Error('Original must parse')
  original.note.content.content!.unshift(kind === 'task'
    ? { type: 'taskList', content: [{ type: 'taskItem', attrs: { blockId: 'checked-item', checked: true }, content: [{ type: 'paragraph', attrs: { blockId: 'checked-body' }, content: [{ type: 'text', text: 'Original reusable task' }] }] }] }
    : { type: 'table', attrs: { blockId: 'whole-table' }, content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [{ type: 'paragraph', attrs: { blockId: 'cell-body' }, content: [{ type: 'text', text: 'Original reusable table' }] }] }] }] })
  const written = await f.writer.write(f.workspace, { path: 'source.note.md', content: serializeNoteDocument(original.note), expectedRevision: f.documents[key]!.revision })
  if (written.status !== 'written') throw Error('Rich original must save')
  const read = await f.writer.read(f.workspace, 'source.note.md'); if (read.status !== 'read') throw Error('Rich original must read')
  useAppStore.setState(state => ({ documents: { ...state.documents, [key]: read.document } }))
  await f.mount()
  await act(async () => {
    const editor = f.rich(0); let at = -1
    editor.state.doc.descendants((node, position) => { if (node.attrs.blockId === (kind === 'task' ? 'checked-body' : 'cell-body')) at = position })
    expect(at).toBeGreaterThanOrEqual(0); editor.view.focus(); editor.commands.setTextSelection(at + 1)
  })
  return f
}
it.each(['task', 'table'] as const)('copies a nearby %s body as its clearly identified legal range and saves the original shared file', async kind => {
  const f = await richCopyFixture(kind), copied = await f.copy(), ticket = JSON.parse(copied.getData('application/x-agentmux-note-share'))
  expect(ticket.block.blockId).toBe(kind === 'task' ? 'checked-item' : 'whole-table')
  expect(dom.container.querySelector('.note-block-copy-feedback')?.textContent).toBe(kind === 'task' ? 'Copied task item · paste to share' : 'Copied whole table · paste to share')
  await f.paste(copied); expect(api.files.sharePublic).not.toHaveBeenCalled()
  await act(async () => await f.save())
  const result = await vi.mocked(api.files.sharePublic).mock.results[0]!.value
  expect(result.status, JSON.stringify(result)).toBe('committed')
  const names = (await readdir(f.root)).filter(name => name.startsWith('block-')); expect(names).toHaveLength(1)
  const shared = readNoteDocument(await readFile(join(f.root, names[0]!), 'utf8'))
  expect(shared.status).toBe('valid'); if (shared.status !== 'valid') throw Error(shared.message)
  expect(shared.note.content.content![0]!.type).toBe(kind === 'task' ? 'taskList' : 'table')
  if (kind === 'task') expect(shared.note.content.content![0]!.content![0]!.attrs?.checked).toBe(true)
})
it('keeps a known rejected legacy inner range and complete draft without freezing later explicit saving or reclassifying an old unknown', async () => {
  const f = await richCopyFixture('task'); await f.paste(await f.copy())
  const key = documentKey(f.workspace.id, 'destination.note.md')
  // A pending draft from the earlier copier may still contain its exact inner paragraph target.
  useAppStore.setState(state => { const doc = state.documents[key]!, shares = structuredClone(doc.noteEditing!.shares!); for (const ticket of Object.values(shares)) ticket.copy.block.blockId = 'checked-body'; return { documents: { ...state.documents, [key]: { ...doc, noteEditing: { ...doc.noteEditing, shares } } } } })
  const before = useAppStore.getState().documents[key]!.content
  await act(async () => await f.save())
  const request = vi.mocked(api.files.sharePublic).mock.calls[0]![0]
  expect(useAppStore.getState().documents[key]!.noteEditing).toMatchObject({ shareRejection: { params: request, code: 'NOTE_SHARE_RANGE_UNSUPPORTED' } })
  expect(useAppStore.getState().documents[key]!.noteEditing?.share).toBeUndefined()
  expect(useAppStore.getState().documents[key]!.noteEditing?.attempt).toBeUndefined()
  expect(useAppStore.getState().documents[key]!.content).toBe(before)
  expect(useAppStore.getState().documentIssues[key]?.kind).toBe('write-error')
  expect((await readdir(f.root)).filter(name => name.startsWith('block-'))).toHaveLength(0)
  expect(dom.container.querySelector('.note-shared-content')?.textContent).toContain('Cancel this use')
  await act(async () => f.rich(1).commands.undo())
  await act(async () => f.rich(1).commands.insertContent(' Kept ordinary edit'))
  await act(async () => await f.save())
  expect(await readFile(join(f.root, 'destination.note.md'), 'utf8')).toContain('Kept ordinary edit')
  expect(api.files.sharePublic).toHaveBeenCalledTimes(1)
})
it('does not release an earlier unknown share from a later structural rejection or replay its original request', async () => {
  const f = await richCopyFixture('task'); await f.paste(await f.copy())
  vi.mocked(api.files.sharePublic).mockRejectedValueOnce(Error('Original share transport unavailable'))
  await act(async () => await f.save())
  const key = documentKey(f.workspace.id, 'destination.note.md'), before = useAppStore.getState().documents[key]!, request = before.noteEditing!.share!.params
  expect(before.noteEditing!.attempt?.phase).toBe('unknown')
  vi.mocked(api.files.inspectSharePublic).mockResolvedValueOnce({ mode: 'request', result: { operationId: request.operationId, status: 'error', code: 'NOTE_SHARE_RANGE_UNSUPPORTED', message: 'A later range check cannot certify the original effects.', promotions: request.promotions.map(p => ({ operationId: p.operationId, shared: null, source: null })), destination: null } })
  await act(async () => await useAppStore.getState().inspectNoteShare(f.workspace.id, 'destination.note.md'))
  const current = useAppStore.getState().documents[key]!
  expect(current.noteEditing?.share?.params).toEqual(request); expect(current.noteEditing?.attempt?.phase).toBe('unknown')
  expect(current.noteEditing?.shareRejection).toBeUndefined(); expect(current.content).toBe(before.content)
  expect(api.files.sharePublic).toHaveBeenCalledTimes(1)
  expect(dom.container.querySelector('.note-shared-content')?.textContent).not.toContain('Cancel this use')
})
it('saves dirty previously unanchored source through the real multi-file owner and edits one shared FileDocument in two Notes', async () => {
  const f = await fixture(), key = documentKey(f.workspace.id, 'source.note.md')
  // External ordinary Markdown has no paragraph anchor; copying must not require an initial manual save.
  const original = readNoteDocument(useAppStore.getState().documents[key]!.content); if (original.status !== 'valid') throw Error('Valid original required')
  delete original.note.content.content![0]!.attrs!.blockId
  const raw = serializeNoteDocument(original.note); await writeFile(join(f.root, 'source.note.md'), raw)
  useAppStore.setState(state => ({ documents: { ...state.documents, [key]: { path: 'source.note.md', content: raw, revision: noteHistoryRevision(raw) } } }))
  await f.mount()
  await act(async () => f.rich(0).commands.insertContentAt(1, 'Unsaved '))
  const copied = await f.copy(); await f.paste(copied)
  await act(async () => { await f.save() })
  expect(api.files.sharePublic).toHaveBeenCalledTimes(1)
  const receipt = await vi.mocked(api.files.sharePublic).mock.results[0]!.value
  expect(receipt, JSON.stringify(receipt)).toMatchObject({ status: 'committed' })
  await vi.waitFor(async () => { const results = await Promise.allSettled(vi.mocked(api.notebooks.graph).mock.results.map(call => call.value)); const snapshots = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []); expect(snapshots.some(value => value.graph.observations.some((item: { kind?: string }) => item.kind === 'shared-block')), JSON.stringify(snapshots.map(value => value.graph.observations))).toBe(true) })
  await vi.waitFor(() => expect(dom.container.querySelectorAll('.note-shared-content .note-block-content'), dom.container.textContent ?? '').toHaveLength(2), { timeout: 3000 })
  const names = (await readdir(f.root)).filter(name => name.startsWith('block-')); expect(names).toHaveLength(1)
  const sharedPath = names[0]!, sharedKey = documentKey(f.workspace.id, sharedPath)
  expect(await readFile(join(f.root, sharedPath), 'utf8')).toContain('Unsaved Original knowledge')
  expect(await readFile(join(f.root, 'source.note.md'), 'utf8')).not.toContain('Original knowledge')
  const left = f.rich(0, true), right = f.rich(1, true), rightSelection = right.state.selection.from
  const graphReads = vi.mocked(api.notebooks.graph).mock.calls.length
  expect(left).not.toBe(right)
  await act(async () => { left.view.focus(); left.commands.insertContentAt(1, 'Shared edit ') })
  await vi.waitFor(() => expect(right.getText()).toContain('Shared edit Unsaved Original knowledge'))
  expect(right.state.selection.from).toBeGreaterThanOrEqual(rightSelection)
  expect(useAppStore.getState().documents[sharedKey]!.content).toContain('Shared edit Unsaved Original knowledge')
  expect(useAppStore.getState().documents[key]!.content).not.toContain('Shared edit')
  expect(useAppStore.getState().dirtyDocuments[sharedKey]).toBe(true)
  expect(api.notebooks.graph).toHaveBeenCalledTimes(graphReads)
  await act(async () => left.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })))
  await vi.waitFor(() => expect(useAppStore.getState().dirtyDocuments[sharedKey]).toBe(false))
  expect(await readFile(join(f.root, sharedPath), 'utf8')).toContain('Shared edit Unsaved Original knowledge')
  expect(await readFile(join(f.root, 'destination.note.md'), 'utf8')).not.toContain('Shared edit')
})


it('keeps shared dirty and failure status independent of a saved host and saves only the selected original', async () => {
  const f = await fixture(); await f.mount(); await f.paste(await f.copy()); await act(async () => { await f.save() })
  await vi.waitFor(() => expect(dom.container.querySelectorAll('.note-shared-content .note-block-content')).toHaveLength(2))
  const sharedPaths = (await readdir(f.root)).filter(name => name.startsWith('block-'))
  expect(sharedPaths).toHaveLength(1)
  const sharedPath = sharedPaths[0]!, sharedKey = documentKey(f.workspace.id, sharedPath), hostKey = documentKey(f.workspace.id, 'destination.note.md')
  const host = dom.container.querySelector('[data-test-note="destination-region"]')!
  await act(async () => f.rich(1, true).commands.insertContentAt(1, 'Shared draft '))
  await act(async () => f.rich(1).commands.insertContentAt(1, 'Host draft '))
  const writesBeforeHost = vi.mocked(api.files.write).mock.calls.length
  await act(async () => { await f.save() })
  expect(vi.mocked(api.files.write).mock.calls.slice(writesBeforeHost).map(([, input]) => input.path)).toEqual(['destination.note.md'])
  expect(useAppStore.getState().dirtyDocuments[hostKey]).toBe(false)
  expect(useAppStore.getState().dirtyDocuments[sharedKey]).toBe(true)
  expect(host.querySelector('.note-shared-content')?.textContent).toContain('Unsaved changes')
  expect(await readFile(join(f.root, 'destination.note.md'), 'utf8')).toContain('Host draft ')
  expect(await readFile(join(f.root, sharedPath), 'utf8')).not.toContain('Shared draft ')
  vi.mocked(api.files.write).mockResolvedValueOnce({ status: 'error', code: 'EIO', message: 'Shared original write unavailable' })
  const sharedSave = host.querySelector<HTMLButtonElement>('.note-shared-content .note-shared-block__header button')!
  expect(sharedSave).not.toBeNull()
  await act(async () => sharedSave.click())
  await vi.waitFor(() => expect(host.querySelector('.note-shared-content')?.textContent).toContain('Shared original write unavailable'))
  expect(useAppStore.getState().dirtyDocuments[hostKey]).toBe(false)
  expect(useAppStore.getState().dirtyDocuments[sharedKey]).toBe(true)
  expect(useAppStore.getState().documents[sharedKey]!.content).toContain('Shared draft ')
  const beforeRetry = vi.mocked(api.files.write).mock.calls.length
  await act(async () => sharedSave.click())
  await vi.waitFor(() => expect(useAppStore.getState().dirtyDocuments[sharedKey]).toBe(false))
  expect(vi.mocked(api.files.write).mock.calls.slice(beforeRetry).map(([, input]) => input.path)).toEqual([sharedPath])
  expect(await readFile(join(f.root, sharedPath), 'utf8')).toContain('Shared draft ')
  expect(await readFile(join(f.root, 'destination.note.md'), 'utf8')).not.toContain('Shared draft ')
})

it('routes host formatting and undo to the focused shared editor, preserves IME input and keeps normal prose outside', async () => {
  const f = await fixture(); await f.mount(); await f.paste(await f.copy()); await act(async () => { await f.save() })
  await vi.waitFor(() => expect(dom.container.querySelectorAll('.note-shared-content .note-block-content')).toHaveLength(2), { timeout: 3000 })
  const left = f.rich(0, true), right = f.rich(1, true), rightDOM = right.view.dom
  await act(async () => { right.view.focus(); right.commands.setTextSelection(2) })
  const heading = dom.container.querySelector<HTMLButtonElement>('[data-test-note="destination-region"] .note-editor__tools [aria-label="Heading"]')!
  await act(async () => heading.click())
  expect(right.getJSON().content![0]!.type).toBe('heading')
  expect(f.rich(1).getJSON().content![0]!.type).toBe('paragraph')
  await act(async () => right.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })))
  expect(right.getJSON().content![0]!.type).toBe('paragraph')
  await vi.waitFor(() => expect(left.getJSON().content![0]!.type).toBe('paragraph'))
  // The existing text merge owner combines separate Markdown paragraphs; same-line
  // edits intentionally retain both drafts as a conflict rather than guessing intent.
  await act(async () => left.commands.insertContentAt(left.state.doc.content.size, { type: 'paragraph', attrs: { blockId: 'shared-tail' }, content: [{ type: 'text', text: 'Another paragraph' }] }))
  await vi.waitFor(() => expect(right.getText()).toContain('Another paragraph'))
  await act(async () => { right.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); right.view.dispatch(right.state.tr.insertText('知识', 1)) })
  const shared = (await readdir(f.root)).find(path => path.startsWith('block-'))!, sharedKey = documentKey(f.workspace.id, shared)
  expect(useAppStore.getState().documents[sharedKey]!.content).not.toContain('知识')
  await act(async () => left.commands.insertContentAt(left.state.doc.content.size - 1, ' Remote'))
  expect(right.view.dom).toBe(rightDOM); expect(right.getText()).toContain('知识')
  await act(async () => right.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '知识' })))
  await vi.waitFor(() => expect(useAppStore.getState().documents[sharedKey]!.content).toContain('知识'))
  await vi.waitFor(() => expect(left.getText()).toContain('知识'))
  await vi.waitFor(() => expect(right.getText()).toContain('Remote')); expect(right.view.dom).toBe(rightDOM)
  expect(useAppStore.getState().documents[documentKey(f.workspace.id, 'destination.note.md')]!.content).not.toContain('知识')
})

it('keeps both old reference modes readable and read-only after the source is promoted into a shared file', async () => {
  const f = await fixture(); await f.mount()
  await act(async () => f.rich(1).commands.insertContentAt(f.rich(1).state.doc.content.size - 1, ['reference', 'embed'].map(mode => ({ type: 'blockReference', attrs: { referenceId: 'old-' + mode, mode, target: { noteId: 'source', blockId: 'source-first' } } }))))
  await f.paste(await f.copy()); await act(async () => { await f.save() })
  await vi.waitFor(() => expect(dom.container.querySelectorAll('.note-shared-content .note-block-content'), dom.container.textContent ?? '').toHaveLength(2), { timeout: 3000 })
  // Leave only the old structural references in the destination; their original addresses stay intact.
  await act(async () => { const editor = f.rich(1); let from = -1, size = 0; editor.state.doc.descendants((node, pos) => { if (node.type.name === 'noteInclude') { from = pos; size = node.nodeSize } }); if (from >= 0) editor.view.dispatch(editor.state.tr.delete(from, from + size)) })
  await vi.waitFor(() => { const references = dom.container.querySelectorAll('[data-test-note="destination-region"] .note-reference'); expect(references).toHaveLength(2); for (const reference of references) { expect(reference.textContent).toContain('Original knowledge'); expect(reference.textContent).not.toContain('Empty block'); expect(reference.querySelector('[contenteditable="true"]')).toBeNull() } })
  const note = readNoteDocument(useAppStore.getState().documents[documentKey(f.workspace.id, 'destination.note.md')]!.content)
  expect(note).toMatchObject({ status: 'valid', note: { content: { content: expect.arrayContaining(['reference', 'embed'].map(mode => expect.objectContaining({ type: 'blockReference', attrs: expect.objectContaining({ mode, target: { noteId: 'source', blockId: 'source-first' } }) }))) } } })
})

it.each([false, true])('keeps the actual caret in a newly split paragraph through the original File Store echo (replace first: %s)', async replace => {
  const f = await fixture(); await f.mount()
  const editor = f.rich(0)
  if (replace) await act(async () => { editor.view.focus(); editor.commands.selectAll(); editor.commands.insertContent('Original knowledge') })
  await act(async () => { editor.view.focus(); editor.commands.setTextSelection('Original knowledge'.length + 1) })
  await act(async () => editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true })))
  await vi.waitFor(() => expect(editor.getJSON().content).toHaveLength(replace ? 2 : 3))
  await vi.waitFor(() => expect(editor.state.selection.$from.parent.textContent).toBe(''))
  await act(async () => editor.commands.insertContent('The next paragraph'))
  const paragraphs = editor.getJSON().content!
  expect(paragraphs[0]!.content).toEqual([{ type: 'text', text: 'Original knowledge' }])
  expect(paragraphs[1]!.content).toEqual([{ type: 'text', text: 'The next paragraph' }])
})

it('retains the whole original share request after a written destination loses its history receipt and through File draft recovery', async () => {
  const f = await fixture(), record = f.metadata.recordHistory.bind(f.metadata)
  vi.spyOn(f.metadata, 'recordHistory').mockImplementation(async input => {
    if (input.noteId === 'destination' && input.status === 'committed') throw Error('Original destination journal unavailable after body write')
    return record(input)
  })
  await f.mount(); await f.paste(await f.copy()); await act(async () => { await f.save() })
  const destinationKey = documentKey(f.workspace.id, 'destination.note.md'), original = useAppStore.getState().documents[destinationKey]!.noteEditing!.share!
  expect(original.params).toEqual(vi.mocked(api.files.sharePublic).mock.calls[0]![0])
  expect(await readFile(join(f.root, 'destination.note.md'), 'utf8')).toContain('::note-include')
  expect(useAppStore.getState().dirtyDocuments[destinationKey]).toBe(false)
  expect(useAppStore.getState().documents[destinationKey]!.noteEditing?.attempt).toBeUndefined()
  // Ordinary watch reconciliation can settle one file, never the entire first-use intent.
  await act(async () => { await useAppStore.getState().refreshDocument(f.workspace.id, 'destination.note.md') })
  expect(useAppStore.getState().documents[destinationKey]!.noteEditing?.share?.params.operationId).toBe(original.params.operationId)
  const persisted = useAppStore.persist.getOptions().partialize!(useAppStore.getState()) as { documents: Record<string, import('../src/shared/contracts').FileDocument> }
  const restored = JSON.parse(JSON.stringify(persisted.documents))
  expect(restored[destinationKey].noteEditing.share.params).toEqual(original.params)
  await act(async () => { useAppStore.setState({ documents: restored }); await useAppStore.getState().inspectNoteShare(f.workspace.id, 'destination.note.md') })
  expect(vi.mocked(api.files.inspectSharePublic).mock.calls.at(-1)![0]).toEqual({ mode: 'request', request: original.params })
  expect(api.files.sharePublic).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().documents[destinationKey]!.noteEditing?.share?.params).toEqual(original.params)
  expect(useAppStore.getState().documentIssues[destinationKey]?.kind).toBe('write-unknown')
})

it('reveals an old descendant address inside its actual shared editor after a list item is promoted', async () => {
  const f = await fixture(); await f.mount()
  await act(async () => { const editor = f.rich(0); editor.view.focus(); editor.commands.setTextSelection(2); editor.commands.toggleBulletList() })
  await f.paste(await f.copy()); await act(async () => { await f.save() })
  const originalKey = documentKey(f.workspace.id, 'source.note.md')
  await vi.waitFor(() => expect(dom.container.querySelectorAll('.note-shared-content .note-block-content'), JSON.stringify({ text: dom.container.textContent, source: useAppStore.getState().documents[originalKey] })).toHaveLength(2), { timeout: 3000 })
  const source = readNoteDocument(useAppStore.getState().documents[originalKey]!.content)
  expect(source).toMatchObject({ status: 'valid', note: { content: { content: expect.arrayContaining([expect.objectContaining({ type: 'noteInclude', attrs: expect.objectContaining({ forwardedBlockIds: ['source-first'] }) })]) } } })
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) { return this.closest('.note-editor') ? new DOMRect(0, 0, 500, 100) : originalRect.call(this) })
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
  await act(async () => useAppStore.setState(state => ({ documentRevealTargets: { ...state.documentRevealTargets, [originalKey]: { line: 1, noteBlock: { noteId: 'source', blockId: 'source-first' } } } })))
  await vi.waitFor(() => expect(useAppStore.getState().documentRevealTargets[originalKey]).toBeUndefined())
  expect(f.rich(0, true).state.selection.$from.parent.attrs.blockId).toBe('source-first')
  expect(useAppStore.getState().documents[originalKey]!.content).not.toContain('Original knowledge')
  const destinationKey = documentKey(f.workspace.id, 'destination.note.md'), hostInclude = f.rich(1).getJSON().content!.find(node => node.type === 'noteInclude')!
  expect(hostInclude.attrs!.blockId).not.toBe('source-first')
  await act(async () => useAppStore.setState(state => ({ documentRevealTargets: { ...state.documentRevealTargets, [destinationKey]: { line: 1, noteBlock: { noteId: 'destination', blockId: hostInclude.attrs!.blockId } } } })))
  await vi.waitFor(() => expect(useAppStore.getState().documentRevealTargets[destinationKey]).toBeUndefined())
  expect(f.rich(1).state.selection).toMatchObject({ node: { type: { name: 'noteInclude' }, attrs: { blockId: hostInclude.attrs!.blockId } } })
  // Two real host declarations are ambiguous even when both point to a healthy shared file.
  const attrs = f.rich(0).getJSON().content!.find(node => node.type === 'noteInclude')!.attrs!
  await act(async () => f.rich(0).commands.insertContentAt(f.rich(0).state.doc.content.size, { type: 'noteInclude', attrs: { ...attrs, blockId: 'duplicate-host', referenceId: 'duplicate-use' } }))
  await act(async () => useAppStore.setState(state => ({ documentRevealTargets: { ...state.documentRevealTargets, [originalKey]: { line: 1, noteBlock: { noteId: 'source', blockId: 'source-first' } } } })))
  await vi.waitFor(() => expect(dom.container.textContent).toContain('not confirmed'))
  expect(useAppStore.getState().documentRevealTargets[originalKey]?.noteBlock).toEqual({ noteId: 'source', blockId: 'source-first' })
})

it.each([false, true])('reuses the same system clipboard after its original source has already been promoted (original unanchored: %s)', async unanchored => {
  const f = await fixture(3)
  if (unanchored) {
    const key = documentKey(f.workspace.id, 'source.note.md'), parsed = readNoteDocument(useAppStore.getState().documents[key]!.content); if (parsed.status !== 'valid') throw Error('Original source required')
    delete parsed.note.content.content![0]!.attrs!.blockId
    const raw = serializeNoteDocument(parsed.note); await writeFile(join(f.root, 'source.note.md'), raw)
    useAppStore.setState(state => ({ documents: { ...state.documents, [key]: { path: 'source.note.md', content: raw, revision: noteHistoryRevision(raw) } } }))
  }
  await f.mount()
  const clipboard = await f.copy(); await f.paste(clipboard); await act(async () => { await f.save() })
  await vi.waitFor(() => expect(dom.container.querySelectorAll('.note-shared-content .note-block-content')).toHaveLength(2), { timeout: 3000 })
  const first = readNoteDocument(useAppStore.getState().documents[documentKey(f.workspace.id, 'destination.note.md')]!.content)
  if (first.status !== 'valid') throw Error('First destination required')
  const originalInclude = first.note.content.content!.find(node => node.type === 'noteInclude')!.attrs!
  await f.paste(clipboard, 2); await act(async () => { await f.save(2) })
  expect(api.files.sharePublic).toHaveBeenCalledTimes(1)
  expect((await readdir(f.root)).filter(name => name.startsWith('block-'))).toHaveLength(1)
  const next = readNoteDocument(await readFile(join(f.root, 'another.note.md'), 'utf8'))
  if (next.status !== 'valid') throw Error('Saved second destination required')
  const include = next.note.content.content!.find(node => node.type === 'noteInclude')!.attrs!
  expect(include.noteId).toBe(originalInclude.noteId); expect(include.referenceId).not.toBe(originalInclude.referenceId)
  expect(include.blockId).not.toBe('source-first'); expect(include.forwardedBlockIds).toBeUndefined()
  await vi.waitFor(() => expect(f.rich(2, true).getText()).toContain('Original knowledge'))
})

it('restores a pending source preview through the original FileDocument owner without opening a Tab or creating a file', async () => {
  const f = await fixture(); await f.mount(); await f.paste(await f.copy())
  const destinationKey = documentKey(f.workspace.id, 'destination.note.md')
  const restored = JSON.parse(JSON.stringify(useAppStore.getState().documents[destinationKey]))
  await dom.render(null)
  useAppStore.setState({ documents: { [destinationKey]: restored }, tabs: { [f.tabs[1]!.id]: f.tabs[1]! } })
  const reads = vi.mocked(api.notebooks.content).mock.calls.length
  await f.mount([1])
  await vi.waitFor(() => expect(dom.container.querySelector('.note-shared-content .ProseMirror')?.textContent).toContain('Original knowledge'))
  expect(vi.mocked(api.notebooks.content).mock.calls.slice(reads).some(([id]) => id === 'source')).toBe(true)
  expect(Object.keys(useAppStore.getState().tabs)).toEqual([f.tabs[1]!.id])
  expect(useAppStore.getState().documents[documentKey(f.workspace.id, 'source.note.md')]?.content).toContain('Original knowledge')
  expect(api.files.sharePublic).not.toHaveBeenCalled()
  expect((await readdir(f.root)).filter(name => name.endsWith('.note.md'))).toHaveLength(2)
})

it('keeps a new pending paste dirty when it arrives during the original sharing save observation', async () => {
  const f = await fixture(); await f.mount(); await f.paste(await f.copy())
  const read = vi.mocked(api.files.readPublic).getMockImplementation()!
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  vi.mocked(api.files.readPublic).mockImplementationOnce(async input => { entered(); await gate; return read(input) })
  let saving!: Promise<void>
  await act(async () => { saving = f.save(); await started })
  await act(async () => { const editor = f.rich(0); editor.view.focus(); editor.commands.setTextSelection(editor.state.doc.content.size - 1) })
  await f.paste(await f.copy())
  await act(async () => { release(); await saving })
  const key = documentKey(f.workspace.id, 'destination.note.md'), saved = await readFile(join(f.root, 'destination.note.md'), 'utf8')
  expect(saved.match(/::note-include/g)).toHaveLength(1)
  expect(useAppStore.getState().documents[key]!.content.match(/::note-include/g)).toHaveLength(2)
  expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
  expect(Object.keys(useAppStore.getState().documents[key]!.noteEditing!.shares!)).toHaveLength(1)
  await act(async () => { await f.save() })
  expect((await readFile(join(f.root, 'destination.note.md'), 'utf8')).match(/::note-include/g)).toHaveLength(2)
  expect((await readdir(f.root)).filter(name => name.startsWith('block-'))).toHaveLength(2)
})

it('releases the shared file observer when its final presentation unmounts during a save and then prunes the clean document', async () => {
  const f = await fixture(); await f.mount(); await f.paste(await f.copy()); await act(async () => { await f.save() })
  await vi.waitFor(() => expect(dom.container.querySelectorAll('.note-shared-content .note-block-content')).toHaveLength(2), { timeout: 3000 })
  const sharedPath = (await readdir(f.root)).find(name => name.startsWith('block-'))!, key = documentKey(f.workspace.id, sharedPath)
  await act(async () => f.rich(1, true).commands.insertContentAt(1, 'Later '))
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  const write = vi.mocked(api.files.write).getMockImplementation()!
  vi.mocked(api.files.write).mockImplementationOnce(async (...args) => { entered(); await gate; return write(...args) })
  let saving!: Promise<void>
  const parsed = readNoteDocument(useAppStore.getState().documents[key]!.content); if (parsed.status !== 'valid') throw Error('Shared source required')
  await act(async () => { saving = useAppStore.getState().saveNoteFile({ workspaceId: f.workspace.id, path: sharedPath, noteId: parsed.note.noteId, hostId: 'local', workspacePath: f.root }); await started })
  await dom.render(null)
  expect(vi.mocked(api.files.unobserve).mock.calls.some(([workspace, path]) => workspace === f.workspace.id && path === sharedPath)).toBe(true)
  expect(useAppStore.getState().documents[key]!.content).toContain('Later ')
  await act(async () => { release(); await saving })
  expect(await readFile(join(f.root, sharedPath), 'utf8')).toContain('Later ')
  expect(useAppStore.getState().documents[key]).toBeUndefined()
})

it('marks a lost whole share reply as unknown and checks the same request without replaying it', async () => {
  const f = await fixture(); await f.mount(); await f.paste(await f.copy())
  const share = vi.mocked(api.files.sharePublic).getMockImplementation()!
  vi.mocked(api.files.sharePublic).mockImplementationOnce(async params => { expect((await share(params)).status).toBe('committed'); throw Error('Transport dropped the original reply') })
  await act(async () => { await f.save() })
  const key = documentKey(f.workspace.id, 'destination.note.md'), pending = useAppStore.getState().documents[key]!.noteEditing!
  expect(pending.attempt?.phase).toBe('unknown'); expect(pending.share?.params.operationId).toBe(vi.mocked(api.files.sharePublic).mock.calls[0]![0].operationId)
  expect(useAppStore.getState().savingDocuments[key]).toBe(false)
  expect(dom.container.textContent).not.toContain('Original save in progress')
  // Issues are transient; the recovered original operation alone must expose recovery.
  await act(async () => useAppStore.setState({ documentIssues: {} }))
  expect(dom.container.textContent).toContain('Sharing needs confirmation')
  expect(dom.container.querySelector('.note-shared-content')?.textContent).not.toContain('Cancel this use')
  const check = Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Check this sharing operation')!
  expect(check).toBeDefined()
  vi.mocked(api.files.inspectSharePublic).mockRejectedValueOnce(Error('Original Host inspection unavailable'))
  await act(async () => { await useAppStore.getState().inspectNoteShare(f.workspace.id, 'destination.note.md') })
  expect(useAppStore.getState().documents[key]!.noteEditing?.share?.params.operationId).toBe(pending.share!.params.operationId)
  expect(dom.container.textContent).toContain('Original Host inspection unavailable')
  expect(api.files.sharePublic).toHaveBeenCalledTimes(1)
  await act(async () => check.click())
  await vi.waitFor(() => expect(useAppStore.getState().documents[key]!.noteEditing?.share).toBeUndefined())
  expect(api.files.sharePublic).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().documents[key]!.noteEditing?.share).toBeUndefined()
  expect(useAppStore.getState().documentIssues[key]).toBeUndefined()
})

it('copies an existing shared editor and pastes another editable use of that same file', async () => {
  const f = await fixture(3); await f.mount(); await f.paste(await f.copy()); await act(async () => { await f.save() })
  await vi.waitFor(() => expect(dom.container.querySelectorAll('.note-shared-content .note-block-content')).toHaveLength(2), { timeout: 3000 })
  const source = f.rich(0, true)
  await act(async () => { source.view.focus(); source.commands.setTextSelection(2) })
  const button = dom.container.querySelector<HTMLButtonElement>('[data-test-note="source-region"] .note-shared-content .note-block-action')!
  await act(async () => button.click())
  const data = f.clipboard()
  expect(JSON.parse(data.getData('application/x-agentmux-note-share')).include.noteId).toBe(f.rich(0).getJSON().content![0]!.attrs!.noteId)
  await f.paste(data, 2); await act(async () => { await f.save(2) })
  expect(api.files.sharePublic).toHaveBeenCalledTimes(1)
  expect((await readdir(f.root)).filter(name => name.startsWith('block-'))).toHaveLength(1)
  await vi.waitFor(() => expect(f.rich(2, true).getText()).toBe(source.getText()))
})

it('reads an unloaded original for an old clipboard while its immediate undoable paste retains the same target and later prose', async () => {
  const f = await fixture(3); await f.mount()
  const clipboard = await f.copy(); await f.paste(clipboard); await act(async () => { await f.save() })
  await f.mount([1, 2])
  const originalKey = documentKey(f.workspace.id, 'source.note.md')
  await act(async () => useAppStore.setState(state => { const documents = { ...state.documents }; delete documents[originalKey]; const tabs = { ...state.tabs }; delete tabs[f.tabs[0]!.id]; return { documents, tabs } }))
  const content = vi.mocked(api.notebooks.content).getMockImplementation()!
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  vi.mocked(api.notebooks.content).mockImplementationOnce(async (...args) => { entered(); await gate; return content(...args) })
  await f.paste(clipboard, 2); await started
  const destination = f.rich(2)
  await act(async () => destination.commands.insertContentAt(1, 'Later prose '))
  expect(destination.getJSON().content!.some(node => node.type === 'noteInclude')).toBe(true)
  await act(async () => { release() })
  await vi.waitFor(() => expect(Object.keys(useAppStore.getState().documents[documentKey(f.workspace.id, 'another.note.md')]!.noteEditing?.shares ?? {})).toHaveLength(0))
  expect(destination.getText()).toContain('Later prose Another use')
  expect(Object.keys(useAppStore.getState().tabs)).not.toContain(f.tabs[0]!.id)
  await act(async () => { await f.save(2) })
  expect(api.files.sharePublic).toHaveBeenCalledTimes(1)
  expect((await readdir(f.root)).filter(name => name.startsWith('block-'))).toHaveLength(1)
  expect(destination.getJSON().content!.find(node => node.type === 'noteInclude')!.attrs!.noteId).toBe(f.rich(1).getJSON().content!.find(node => node.type === 'noteInclude')!.attrs!.noteId)
  await act(async () => { destination.commands.undo(); destination.commands.undo() })
  expect(destination.getJSON().content!.some(node => node.type === 'noteInclude')).toBe(false)
  await act(async () => destination.commands.redo())
  expect(destination.getJSON().content!.find(node => node.type === 'noteInclude')!.attrs!.noteId).toBe(f.rich(1).getJSON().content!.find(node => node.type === 'noteInclude')!.attrs!.noteId)
})

it('does not resurrect an unloaded-source paste after Undo or create an entity on the following save', async () => {
  const f = await fixture(); await f.mount(); const clipboard = await f.copy(); await f.mount([1])
  const originalKey = documentKey(f.workspace.id, 'source.note.md')
  await act(async () => useAppStore.setState(state => { const documents = { ...state.documents }; delete documents[originalKey]; const tabs = { ...state.tabs }; delete tabs[f.tabs[0]!.id]; return { documents, tabs } }))
  const content = vi.mocked(api.notebooks.content).getMockImplementation()!
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  vi.mocked(api.notebooks.content).mockImplementationOnce(async (...args) => { entered(); await gate; return content(...args) })
  await f.paste(clipboard); await started
  expect(f.rich(1).getJSON().content!.some(node => node.type === 'noteInclude')).toBe(true)
  await act(async () => f.rich(1).commands.undo())
  await act(async () => { release(); await f.save() })
  expect(f.rich(1).getJSON().content!.some(node => node.type === 'noteInclude')).toBe(false)
  expect(api.files.sharePublic).not.toHaveBeenCalled()
  expect((await readdir(f.root)).filter(name => name.startsWith('block-'))).toHaveLength(0)
  expect(await readFile(join(f.root, 'destination.note.md'), 'utf8')).not.toContain('::note-include')
})

it('groups a fresh copy nonce for the same precise pending source into one proposal and promotion', async () => {
  const f = await fixture(); await f.mount()
  const first = await f.copy(); await f.paste(first)
  const second = await f.copy(); await f.paste(second)
  expect(JSON.parse(first.getData('application/x-agentmux-note-share')).proposalId).toBe(JSON.parse(second.getData('application/x-agentmux-note-share')).proposalId)
  await act(async () => { await f.save() })
  expect(vi.mocked(api.files.sharePublic).mock.calls[0]![0].promotions).toHaveLength(1)
  expect((await readdir(f.root)).filter(name => name.startsWith('block-'))).toHaveLength(1)
  const uses = f.rich(1).getJSON().content!.filter(node => node.type === 'noteInclude')
  expect(uses).toHaveLength(2); expect(uses[0]!.attrs!.noteId).toBe(uses[1]!.attrs!.noteId)
})

it('ignores a malformed shared-reference clipboard and leaves ordinary prose editable and saveable', async () => {
  const f = await fixture(); await f.mount()
  const original = await f.copy(), data = JSON.parse(original.getData('application/x-agentmux-note-share'))
  const corrupt = new DataTransfer(); corrupt.setData('application/x-agentmux-note-share', JSON.stringify({ ...data, include: { noteId: 'broken', path: '../outside.note.md' } })); corrupt.setData('text/plain', 'Ordinary clipboard text')
  await f.paste(corrupt)
  expect(f.rich(1).getJSON().content!.some(node => node.type === 'noteInclude')).toBe(false)
  await act(async () => { f.rich(1).commands.insertContent('More prose'); await f.save() })
  expect(await readFile(join(f.root, 'destination.note.md'), 'utf8')).toContain('More prose')
  expect(api.files.sharePublic).not.toHaveBeenCalled()
})

it('keeps IME ownership independent when the same durable Region is presented twice', async () => {
  const f = await fixture(); await f.mount(); await f.paste(await f.copy()); await act(async () => { await f.save() })
  await dom.render(<>{['one', 'two'].map(copy => <section key={copy} data-copy={copy}><WorkbenchPresentationContext.Provider value={{ active: true, retainedRegionId: null, tabHostId: copy, reference: { displayWorkspaceId: f.workspace.id, groupId: 'group', tabId: f.tabs[0]!.id, regionId: f.surfaces[0]!.regionId } }}><NoteFileSurfaceView tabId={f.tabs[0]!.id} surface={f.surfaces[0]!} /></WorkbenchPresentationContext.Provider></section>)}</>)
  await vi.waitFor(() => expect(dom.container.querySelectorAll('.note-shared-content .note-block-content')).toHaveLength(2), { timeout: 3000 })
  const editor = (copy: string) => (dom.container.querySelector(`[data-copy="${copy}"] .note-shared-content .note-block-content`) as HTMLElement & { editor: Editor }).editor
  const left = editor('one'), right = editor('two'), sharedPath = (await readdir(f.root)).find(name => name.startsWith('block-'))!
  expect(left).not.toBe(right)
  await act(async () => { left.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); right.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })) })
  let completed = false
  const pending = afterNoteComposition(documentKey(f.workspace.id, sharedPath)).then(() => { completed = true })
  await act(async () => right.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
  expect(completed).toBe(false)
  await act(async () => left.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
  await pending
  expect(completed).toBe(true)
})

it('saves a naturally undone saved use without losing ordinary prose and restores the original when it is the last use', async () => {
  const f = await fixture(); await f.mount()
  await act(async () => f.rich(1).commands.insertContentAt(1, 'Before sharing '))
  await f.paste(await f.copy()); await act(async () => { await f.save() })
  const shared = (await readdir(f.root)).find(name => name.startsWith('block-'))!
  await act(async () => f.rich(1).view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })))
  expect(f.rich(1).getJSON().content!.some(node => node.type === 'noteInclude')).toBe(false)
  await act(async () => f.rich(1).commands.insertContentAt(1, 'After undo '))
  await act(async () => { await f.save() })
  const destination = await readFile(join(f.root, 'destination.note.md'), 'utf8'), source = await readFile(join(f.root, 'source.note.md'), 'utf8')
  expect(destination).toContain('After undo Before sharing Destination prose')
  expect(destination).not.toContain('::note-include')
  expect(source).toContain('Original knowledge'); expect(source).toContain('Outside source'); expect(source).not.toContain('::note-include')
  expect((await readdir(f.root)).includes(shared)).toBe(false)
  await vi.waitFor(() => expect(f.rich(0).getText()).toContain('Original knowledge'))
  const restored = readNoteDocument(source)
  expect(restored).toMatchObject({ status: 'valid', note: { content: { content: expect.arrayContaining([expect.objectContaining({ attrs: expect.objectContaining({ blockId: 'source-first' }) })]) } } })
})

it('saves one naturally undone saved use while another Note keeps the same editable shared file', async () => {
  const f = await fixture(3); await f.mount(); const clipboard = await f.copy(); await f.paste(clipboard); await act(async () => { await f.save() })
  await f.paste(clipboard, 2); await act(async () => { await f.save(2) })
  const shared = (await readdir(f.root)).find(name => name.startsWith('block-'))!
  await act(async () => f.rich(1).commands.undo()); await act(async () => { await f.save() })
  expect(await readFile(join(f.root, 'destination.note.md'), 'utf8')).not.toContain('::note-include')
  expect(await readFile(join(f.root, 'another.note.md'), 'utf8')).toContain('::note-include')
  expect(await readFile(join(f.root, 'source.note.md'), 'utf8')).toContain('::note-include')
  expect(await readFile(join(f.root, shared), 'utf8')).toContain('Original knowledge')
  await vi.waitFor(() => expect(f.rich(2, true).getText()).toContain('Original knowledge'))
})

it('saves a naturally undone saved use while preserving a known dirty shared draft and its original file', async () => {
  const f = await fixture(); await f.mount(); await f.paste(await f.copy()); await act(async () => { await f.save() })
  await vi.waitFor(() => expect(dom.container.querySelectorAll('.note-shared-content .note-block-content')).toHaveLength(2), { timeout: 3000 })
  const shared = (await readdir(f.root)).find(name => name.startsWith('block-'))!, sharedKey = documentKey(f.workspace.id, shared)
  await act(async () => f.rich(0, true).commands.insertContentAt(1, 'Later unsaved knowledge '))
  await act(async () => f.rich(1).commands.undo()); await act(async () => { await f.save() })
  expect(await readFile(join(f.root, 'destination.note.md'), 'utf8')).not.toContain('::note-include')
  expect(await readFile(join(f.root, 'source.note.md'), 'utf8')).toContain('::note-include')
  expect(await readFile(join(f.root, shared), 'utf8')).toContain('Original knowledge')
  expect(useAppStore.getState().documents[sharedKey]!.content).toContain('Later unsaved knowledge ')
  expect(useAppStore.getState().dirtyDocuments[sharedKey]).toBe(true)
})

it('saves a naturally undone saved use together with a later pending paste through one final destination save', async () => {
  const f = await fixture(); await f.mount(); await f.paste(await f.copy()); await act(async () => { await f.save() })
  const oldShared = (await readdir(f.root)).find(name => name.startsWith('block-'))!
  await act(async () => f.rich(1).commands.undo())
  await act(async () => { const source = f.rich(0); source.view.focus(); source.commands.setTextSelection(source.state.doc.content.size - 1) })
  const outside = f.rich(0).view.dom.querySelector<HTMLElement>('[data-block-id="source-outside"]')
  expect(outside).toBeDefined()
  await act(async () => outside!.dispatchEvent(new PointerEvent('pointermove', { bubbles: true })))
  const nextClipboard = await f.copy()
  expect(nextClipboard.getData('text/plain')).toBe('Outside source')
  await f.paste(nextClipboard)
  await act(async () => f.rich(1).commands.insertContentAt(1, 'Kept alongside new use '))
  await act(async () => { await f.save() })
  const files = (await readdir(f.root)).filter(name => name.startsWith('block-'))
  const actual = await vi.mocked(api.files.sharePublic).mock.results.at(-1)?.value
  const detail = JSON.stringify({ params: vi.mocked(api.files.sharePublic).mock.calls.at(-1)?.[0], actual, error: useAppStore.getState().error, issue: useAppStore.getState().documentIssues[documentKey(f.workspace.id, 'destination.note.md')] })
  expect(files, detail).toHaveLength(1); expect(files, detail).not.toContain(oldShared)
  const saved = await readFile(join(f.root, 'destination.note.md'), 'utf8')
  expect(saved).toContain('Kept alongside new use Destination prose')
  expect(saved.match(/::note-include/g)).toHaveLength(1)
  expect(await readFile(join(f.root, files[0]!), 'utf8')).toContain('Outside source')
  expect(await readFile(join(f.root, 'source.note.md'), 'utf8')).toContain('Original knowledge')
  expect(api.files.shareUndoPublic).not.toHaveBeenCalled()
  expect(vi.mocked(api.files.sharePublic).mock.calls.at(-1)![0]).toMatchObject({ undoReferenceIds: [expect.any(String)], promotions: [expect.any(Object)] })
})

it('keeps the same saved-use removal request through a lost real owner reply, watch and draft recovery until explicit inspection', async () => {
  const f = await fixture(); await f.mount(); await f.paste(await f.copy()); await act(async () => { await f.save() })
  const actualUndo = vi.mocked(api.files.shareUndoPublic).getMockImplementation()!
  vi.mocked(api.files.shareUndoPublic).mockImplementationOnce(async params => { await actualUndo(params); throw Error('The original removal reply was lost') })
  await act(async () => f.rich(1).commands.undo()); await act(async () => { await f.save() })
  const key = documentKey(f.workspace.id, 'destination.note.md'), params = useAppStore.getState().documents[key]!.noteEditing!.shareUndo!.params
  expect(params).toEqual(vi.mocked(api.files.shareUndoPublic).mock.calls[0]![0])
  expect(await readFile(join(f.root, 'destination.note.md'), 'utf8')).not.toContain('::note-include')
  expect((await readdir(f.root)).filter(name => name.startsWith('block-'))).toEqual([])
  await act(async () => { await useAppStore.getState().refreshDocument(f.workspace.id, 'destination.note.md') })
  expect(useAppStore.getState().documents[key]!.noteEditing?.shareUndo?.params).toEqual(params)
  const persisted = useAppStore.persist.getOptions().partialize!(useAppStore.getState()) as { documents: Record<string, import('../src/shared/contracts').FileDocument> }
  await dom.render(null)
  await act(async () => useAppStore.setState({ documents: JSON.parse(JSON.stringify(persisted.documents)), documentIssues: {} }))
  await f.mount([1])
  const check = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Check this removal')
  expect(check).toBeDefined()
  expect(dom.container.textContent).toContain('needs confirmation')
  expect(api.files.shareUndoPublic).toHaveBeenCalledTimes(1)
  await act(async () => check!.click())
  expect(vi.mocked(api.files.inspectSharePublic).mock.calls.at(-1)![0]).toEqual({ mode: 'undo', request: params })
  expect(api.files.shareUndoPublic).toHaveBeenCalledTimes(1)
  await vi.waitFor(() => expect(useAppStore.getState().documents[key]!.noteEditing?.shareUndo).toBeUndefined())
})

it('keeps ordinary exact-file saving when removal cleanup cannot confirm the public mapping', async () => {
  const f = await fixture(); await f.mount(); await f.paste(await f.copy()); await act(async () => { await f.save() })
  const shared = (await readdir(f.root)).find(name => name.startsWith('block-'))!
  vi.mocked(api.files.readPublic).mockRejectedValue(Error('The original public mapping is unavailable'))
  await act(async () => f.rich(1).commands.undo())
  await act(async () => f.rich(1).commands.insertContentAt(1, 'Ordinary saving remains available '))
  await act(async () => { await f.save() })
  const saved = await readFile(join(f.root, 'destination.note.md'), 'utf8')
  expect(saved).toContain('Ordinary saving remains available Destination prose'); expect(saved).not.toContain('::note-include')
  expect(await readFile(join(f.root, shared), 'utf8')).toContain('Original knowledge')
  expect(api.files.shareUndoPublic).not.toHaveBeenCalled()
  expect(api.files.write).toHaveBeenCalledWith(f.workspace.id, expect.objectContaining({ path: 'destination.note.md', content: expect.stringContaining('Ordinary saving remains available ') }))
  expect(dom.container.textContent).toContain('Shared-file cleanup was not checked: the original file mapping is unconfirmed.')
})

it.each(['noteInclude', 'blockReference', 'noteLink'])('preserves a shared file referenced only by another known unsaved %s draft', async type => {
  const f = await fixture(3); await f.mount(); const clipboard = await f.copy(); await f.paste(clipboard); await act(async () => { await f.save() })
  const shared = (await readdir(f.root)).find(name => name.startsWith('block-'))!, original = readNoteDocument(await readFile(join(f.root, shared), 'utf8'))
  if (original.status !== 'valid') throw Error('The real shared file is required')
  if (type === 'noteInclude') await f.paste(clipboard, 2)
  else await act(async () => f.rich(2).commands.insertContentAt(f.rich(2).state.doc.content.size - 1, { type, attrs: { referenceId: 'draft-only-reference', ...(type === 'blockReference' ? { mode: 'reference' } : { text: 'Shared draft link' }), target: { noteId: original.note.noteId, ...(type === 'blockReference' ? { blockId: 'source-first' } : {}) } }, ...(type === 'noteLink' ? { content: [{ type: 'text', text: '[[Shared draft link]]' }] } : {}) }))
  expect(await readFile(join(f.root, 'another.note.md'), 'utf8')).not.toContain(original.note.noteId)
  await act(async () => f.rich(1).commands.undo()); await act(async () => { await f.save() })
  expect(await readFile(join(f.root, 'destination.note.md'), 'utf8')).not.toContain('::note-include')
  expect(await readFile(join(f.root, shared), 'utf8')).toContain('Original knowledge')
  expect(vi.mocked(api.files.shareUndoPublic).mock.calls.at(-1)![0].preserveNoteIds).toEqual(expect.arrayContaining(['another', original.note.noteId]))
  expect(useAppStore.getState().dirtyDocuments[documentKey(f.workspace.id, 'another.note.md')]).toBe(true)
  const kept = readNoteDocument(useAppStore.getState().documents[documentKey(f.workspace.id, 'another.note.md')]!.content)
  if (kept.status !== 'valid') throw Error('The same readable draft must be kept')
  const targets: string[] = [], visit = (node: typeof kept.note.content) => { const id = node.type === 'noteInclude' ? node.attrs?.noteId : node.attrs?.target?.noteId; if (typeof id === 'string') targets.push(id); node.content?.forEach(visit) }; visit(kept.note.content)
  expect(targets).toContain(original.note.noteId)
})

it('undoes only the later saved occurrence when the same Note still contains another use', async () => {
  const f = await fixture(); await f.mount(); const clipboard = await f.copy(); await f.paste(clipboard); await act(async () => { await f.save() })
  const first = f.rich(1).getJSON().content!.find(node => node.type === 'noteInclude')!.attrs!.referenceId
  await f.paste(clipboard); await act(async () => { await f.save() })
  expect(f.rich(1).getJSON().content!.filter(node => node.type === 'noteInclude')).toHaveLength(2)
  await act(async () => f.rich(1).commands.undo())
  expect(f.rich(1).getJSON().content!.filter(node => node.type === 'noteInclude').map(node => node.attrs!.referenceId)).toEqual([first])
  await act(async () => { await f.save() })
  const saved = readNoteDocument(await readFile(join(f.root, 'destination.note.md'), 'utf8'))
  expect(saved).toMatchObject({ status: 'valid', note: { content: { content: expect.arrayContaining([expect.objectContaining({ type: 'noteInclude', attrs: expect.objectContaining({ referenceId: first }) })]) } } })
  expect((await readdir(f.root)).filter(name => name.startsWith('block-'))).toHaveLength(1)
})

it('restores a promoted list through the original source editor while keeping its descendant identities', async () => {
  const f = await fixture(); await f.mount()
  await act(async () => { f.rich(0).view.focus(); f.rich(0).commands.setTextSelection(2); f.rich(0).commands.toggleBulletList() })
  await f.paste(await f.copy()); await act(async () => { await f.save() })
  await act(async () => f.rich(1).commands.undo()); await act(async () => { await f.save() })
  const source = readNoteDocument(await readFile(join(f.root, 'source.note.md'), 'utf8'))
  expect(source).toMatchObject({ status: 'valid', note: { content: { content: expect.arrayContaining([expect.objectContaining({ type: 'bulletList', content: [expect.objectContaining({ type: 'listItem', content: [expect.objectContaining({ type: 'paragraph', attrs: expect.objectContaining({ blockId: 'source-first' }) })] })] })]) } } })
  await vi.waitFor(() => expect(f.rich(0).getJSON().content!.some(node => node.type === 'bulletList')).toBe(true))
  expect(dom.container.querySelector('[data-test-note="source-region"]')!.textContent).not.toContain('Incoming update recovery')
  expect((await readdir(f.root)).filter(name => name.startsWith('block-'))).toHaveLength(0)
})

it('uses one destination save when the restored original and removed saved use belong to the same Note', async () => {
  const f = await fixture(); await f.mount(); await f.paste(await f.copy(), 0); await act(async () => { await f.save(0) })
  expect(f.rich(0).getJSON().content!.filter(node => node.type === 'noteInclude')).toHaveLength(2)
  const beforeUndo = f.rich(0).getJSON()
  await act(async () => f.rich(0).commands.undo())
  expect(f.rich(0).getJSON().content!.filter(node => node.type === 'noteInclude'), JSON.stringify({ beforeUndo, afterUndo: f.rich(0).getJSON() })).toHaveLength(1)
  await act(async () => f.rich(0).commands.insertContentAt(f.rich(0).state.doc.content.size - 1, ' Same-note prose kept'))
  await act(async () => { await f.save(0) })
  const source = await readFile(join(f.root, 'source.note.md'), 'utf8')
  expect(source).toContain('Original knowledge'); expect(source).toContain('Same-note prose kept'); expect(source).not.toContain('::note-include')
  expect(api.files.shareUndoPublic).toHaveBeenCalledTimes(1)
  expect((await readdir(f.root)).filter(name => name.startsWith('block-'))).toHaveLength(0)
})

it('keeps a shared file needed by queued input inside an existing retained File draft', async () => {
  const f = await fixture(3); await f.mount(); const clipboard = await f.copy(); await f.paste(clipboard); await act(async () => { await f.save() }); await f.paste(clipboard, 2)
  const shared = (await readdir(f.root)).find(name => name.startsWith('block-'))!, key = documentKey(f.workspace.id, 'another.note.md')
  const proposed = useAppStore.getState().documents[key]!.content, clean = f.documents[key]!
  await f.mount([0, 1])
  await act(async () => useAppStore.setState(state => ({ documents: { ...state.documents, [key]: clean }, dirtyDocuments: { ...state.dirtyDocuments, [key]: false }, retainedDocumentDrafts: { ...state.retainedDocumentDrafts,
    [key]: [{ ...clean, noteEditing: { input: { baseContent: clean.content, observedContent: clean.content, proposedContent: clean.content, resource: { hostId: f.workspace.hostId, workspaceId: f.workspace.id, workspacePath: f.workspace.path, path: clean.path }, phase: 'mapping', queued: [{ baseContent: clean.content, proposedContent: proposed }] } } }] } })))
  await act(async () => f.rich(1).commands.undo()); await act(async () => { await f.save() })
  expect(await readFile(join(f.root, shared), 'utf8')).toContain('Original knowledge')
  expect(await readFile(join(f.root, 'destination.note.md'), 'utf8')).not.toContain('::note-include')
  expect(useAppStore.getState().retainedDocumentDrafts[key]![0]!.noteEditing!.input!.queued![0]!.proposedContent).toBe(proposed)
})

it('returns a definitively not-applied removal to the original conflict workflow and shares a later paste through exact overwrite', async () => {
  const f = await fixture(); await f.mount(); await f.paste(await f.copy()); await act(async () => { await f.save() })
  const external = readNoteDocument(await readFile(join(f.root, 'destination.note.md'), 'utf8'))
  if (external.status !== 'valid') throw Error('The original saved destination is required')
  external.note.content.content![0]!.content = [{ type: 'text', text: 'External overlapping destination' }]
  const native = f.files.write.bind(f.files); let injected = false
  vi.spyOn(f.files, 'write').mockImplementation(async (...args) => {
    const [, input] = args
    if (!injected && input.path === 'destination.note.md') { injected = true; await writeFile(join(f.root, input.path), serializeNoteDocument(external.note)) }
    return native(...args)
  })
  await act(async () => f.rich(1).commands.undo())
  await act(async () => f.rich(1).commands.insertContentAt(1, 'Local draft remains '))
  await act(async () => { await f.save() })
  const key = documentKey(f.workspace.id, 'destination.note.md'), state = useAppStore.getState()
  expect(state.documents[key]!.noteEditing?.shareUndo).toBeUndefined()
  expect(state.documents[key]!.noteEditing?.attempt).toBeUndefined()
  expect(state.documents[key]!.content).toContain('Local draft remains ')
  expect(state.documentIssues[key]?.kind).toBe('changed')
  expect(api.files.shareUndoPublic).toHaveBeenCalledTimes(1)
  const outside = f.rich(0).view.dom.querySelector<HTMLElement>('[data-block-id="source-outside"]')!
  await act(async () => outside.dispatchEvent(new PointerEvent('pointermove', { bubbles: true })))
  const clipboard = await f.copy(); expect(clipboard.getData('text/plain')).toBe('Outside source'); await f.paste(clipboard)
  await act(async () => { await useAppStore.getState().overwriteDocument(f.tabs[1]!.id, f.surfaces[1]!.regionId) })
  expect(await readFile(join(f.root, 'destination.note.md'), 'utf8')).toContain('Local draft remains ')
  expect((await readFile(join(f.root, 'destination.note.md'), 'utf8')).match(/::note-include/gu)).toHaveLength(1)
  const shared = (await readdir(f.root)).filter(name => name.startsWith('block-'))
  expect(shared).toHaveLength(1); expect(await readFile(join(f.root, shared[0]!), 'utf8')).toContain('Outside source')
  expect(await readFile(join(f.root, 'source.note.md'), 'utf8')).toContain('Original knowledge')
  expect(vi.mocked(api.files.sharePublic).mock.calls.at(-1)![0]).toMatchObject({ undoReferenceIds: [expect.any(String)], destination: { baseContent: serializeNoteDocument(external.note), expectedRevision: noteHistoryRevision(serializeNoteDocument(external.note)) } })
  expect(api.files.write).not.toHaveBeenCalled()
  expect(useAppStore.getState().documents[key]!.noteEditing?.shareUndo).toBeUndefined()
})

it('keeps confirmed source restoration visible through recovery when a later scope change prevents collection', async () => {
  let root = ''
  const f = await fixture(2, async stage => { if (stage === 'source') await writeFile(join(root, 'later.note.md'), serializeNoteDocument(newNoteDocument('A new managed Note', 'later', 'later-first'))) }); root = f.root
  await f.mount(); await f.paste(await f.copy()); await act(async () => { await f.save() })
  await act(async () => f.rich(1).commands.undo()); await act(async () => { await f.save() })
  const key = documentKey(f.workspace.id, 'destination.note.md')
  expect(await readFile(join(f.root, 'source.note.md'), 'utf8')).toContain('Original knowledge')
  expect(await readFile(join(f.root, 'destination.note.md'), 'utf8')).not.toContain('::note-include')
  expect((await readdir(f.root)).filter(name => name.startsWith('block-'))).toHaveLength(1)
  expect(useAppStore.getState().documents[key]!.noteEditing?.shareUndoReceipt?.status).toBe('partial')
  expect(useAppStore.getState().documents[key]!.noteEditing?.shareUndo).toBeUndefined()
  expect(dom.container.textContent).toContain('reference removal and original-source restoration were saved')
  await act(async () => f.rich(1).commands.insertContentAt(1, 'Ordinary edits continue '))
  const persisted = useAppStore.persist.getOptions().partialize!(useAppStore.getState()) as { documents: Record<string, import('../src/shared/contracts').FileDocument> }
  await dom.render(null); await act(async () => useAppStore.setState({ documents: JSON.parse(JSON.stringify(persisted.documents)), documentIssues: {} })); await f.mount([1])
  expect(dom.container.textContent).toContain('reference removal and original-source restoration were saved')
  expect(dom.container.textContent).not.toContain('Check this removal')
  await act(async () => { await f.save() })
  expect(await readFile(join(f.root, 'destination.note.md'), 'utf8')).toContain('Ordinary edits continue ')
  expect(api.files.shareUndoPublic).toHaveBeenCalledTimes(1)
})

it('reads actual collected-file history from its retained trusted File occurrence without offering deleted-file restoration', async () => {
  const f = await fixture(); await f.mount(); await f.paste(await f.copy()); await act(async () => { await f.save() })
  const path = (await readdir(f.root)).find(name => name.startsWith('block-'))!, read = await f.writer.read(f.workspace, path)
  if (read.status !== 'read') throw Error('The shared file must be observed before collection')
  const parsed = readNoteDocument(read.document.content); if (parsed.status !== 'valid') throw Error('The original shared identity is required')
  const sharedTab = { ...createWorkbenchTab('Original shared content', { kind: 'file', workspaceId: f.workspace.id, path, regionId: 'collected-shared' }), space: f.tabs[0]!.space }
  const key = documentKey(f.workspace.id, path)
  await act(async () => useAppStore.setState(state => ({ tabs: { ...state.tabs, [sharedTab.id]: sharedTab }, documents: { ...state.documents, [key]: read.document } })))
  await act(async () => f.rich(1).commands.undo()); await act(async () => { await f.save() })
  expect((await readdir(f.root)).includes(path)).toBe(false)
  await dom.render(<NoteVersionHistory tabId={sharedTab.id} regionId="collected-shared" noteId={parsed.note.noteId} active />)
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Shared file collected'), { timeout: 5000 })
  const response = await f.metadata.readHistory({ noteId: parsed.note.noteId, resource: { hostId: f.workspace.hostId, workspaceId: f.workspace.id, workspacePath: f.workspace.path, path } })
  const deletion = response.entries.find(value => value.operation === 'delete')!
  expect(deletion.status).toBe('committed')
  const preview = dom.container.querySelector<HTMLButtonElement>(`[aria-label="Preview version ${deletion.eventId}"]`)
  expect(preview).not.toBeNull(); await act(async () => preview!.click())
  await vi.waitFor(() => expect(dom.container.textContent).toContain('It has no saved document after the change.'))
  expect(dom.container.textContent).not.toContain('Restore this entire version…')
  expect(dom.container.textContent).not.toContain('Undo this activity…')
  expect(api.files.historyPublic).toHaveBeenCalledWith(expect.objectContaining({ noteId: parsed.note.noteId, expectedResource: expect.objectContaining({ path }) }))
})

it('keeps a shared file owned by another live IME composition before its text becomes a published dirty draft', async () => {
  const f = await fixture(); await f.mount(); await f.paste(await f.copy()); await act(async () => { await f.save() })
  await vi.waitFor(() => expect(dom.container.querySelectorAll('.note-shared-content .note-block-content')).toHaveLength(2))
  const shared = (await readdir(f.root)).find(name => name.startsWith('block-'))!, key = documentKey(f.workspace.id, shared), source = f.rich(0, true)
  const original = readNoteDocument(useAppStore.getState().documents[key]!.content)
  if (original.status !== 'valid') throw Error('The original shared file is required')
  expect(useAppStore.getState().dirtyDocuments[key]).not.toBe(true)
  await act(async () => source.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
  try {
    await act(async () => f.rich(1).commands.undo()); await act(async () => { await f.save() })
    expect(await readFile(join(f.root, shared), 'utf8')).toContain('Original knowledge')
    expect(await readFile(join(f.root, 'destination.note.md'), 'utf8')).not.toContain('::note-include')
    expect(vi.mocked(api.files.shareUndoPublic).mock.calls.at(-1)![0].preserveNoteIds).toContain(original.note.noteId)
  } finally { await act(async () => source.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))) }
})

it('previews and shares a whole heading section with distinct source and reference editors', async () => {
  const f = await fixture(), key = documentKey(f.workspace.id, 'source.note.md')
  const source = newNoteDocument('', 'source', 'unused')
  source.content.content = [
    { type: 'heading', attrs: { level: 2, blockId: 'section' }, content: [{ type: 'text', text: 'Shared chapter' }] },
    { type: 'paragraph', attrs: { blockId: 'chapter-body' }, content: [{ type: 'text', text: 'The complete chapter body' }] },
    { type: 'heading', attrs: { level: 3, blockId: 'subsection' }, content: [{ type: 'text', text: 'Nested heading' }] },
    { type: 'paragraph', attrs: { blockId: 'nested-body' }, content: [{ type: 'text', text: 'Nested chapter content' }] },
    { type: 'heading', attrs: { level: 2, blockId: 'next-section' }, content: [{ type: 'text', text: 'Next chapter stays outside' }] },
    { type: 'paragraph', attrs: { blockId: 'next-body' }, content: [{ type: 'text', text: 'Outside chapter prose' }] },
  ]
  const saved = await f.writer.write(f.workspace, { path: 'source.note.md', content: serializeNoteDocument(source), expectedRevision: f.documents[key]!.revision })
  expect(saved.status).toBe('written')
  const read = await f.writer.read(f.workspace, 'source.note.md'); if (read.status !== 'read') throw Error('Original must read')
  useAppStore.setState(state => ({ documents: { ...state.documents, [key]: read.document } }))
  await f.mount(); await f.paste(await f.copy())
  await vi.waitFor(() => {
    const pending = dom.container.querySelector('[data-test-note="destination-region"] .note-shared-content')!
    expect(pending.textContent).toContain('Nested chapter content')
    expect(pending.textContent).not.toContain('Next chapter stays outside')
  })
  await act(async () => { await f.save() })
  await vi.waitFor(() => expect(dom.container.querySelectorAll('.note-shared-content .note-block-content')).toHaveLength(2), { timeout: 4000 })
  expect(f.rich(0).getJSON().content!.map(node => node.type)).toEqual(['noteInclude', 'heading', 'paragraph'])
  const sourceFrame = dom.container.querySelector('[data-test-note="source-region"] [data-shared-role="source"]')
  const referenceFrame = dom.container.querySelector('[data-test-note="destination-region"] [data-shared-role="reference"]')
  expect(sourceFrame?.getAttribute('aria-label')).toBe('Shared source')
  expect(referenceFrame?.getAttribute('aria-label')).toBe('Shared reference')
  expect(sourceFrame?.querySelector('[aria-label="Shared source · show details"]')?.getAttribute('aria-haspopup')).toBe('dialog')
  expect(f.rich(0, true).getText()).toContain('Nested chapter content')
  expect(f.rich(1, true).getText()).toContain('The complete chapter body')
  expect(f.rich(1, true).getText()).not.toContain('Outside chapter prose')
  await act(async () => f.rich(0, true).commands.insertContentAt(1, 'Together '))
  await vi.waitFor(() => expect(f.rich(1, true).getText()).toContain('Together Shared chapter'))
  expect(f.rich(0).getText()).toContain('Outside chapter prose')
})

it('keeps a self-containing pending heading finite, undoable and editable', async () => {
  const f = await fixture(), key = documentKey(f.workspace.id, 'source.note.md')
  const source = newNoteDocument('', 'source', 'unused')
  source.content.content = [
    { type: 'heading', attrs: { level: 2, blockId: 'self-section' }, content: [{ type: 'text', text: 'A live chapter' }] },
    { type: 'paragraph', attrs: { blockId: 'self-body' }, content: [{ type: 'text', text: 'The same original body' }] }
  ]
  const written = await f.writer.write(f.workspace, { path: 'source.note.md', content: serializeNoteDocument(source), expectedRevision: f.documents[key]!.revision })
  expect(written.status).toBe('written')
  const read = await f.writer.read(f.workspace, 'source.note.md'); if (read.status !== 'read') throw Error('Source must read')
  useAppStore.setState(state => ({ documents: { ...state.documents, [key]: read.document } }))
  await f.mount(); await f.paste(await f.copy(), 0)
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Circular reference'))
  const original = f.rich(0)
  expect(original.getJSON().content!.filter(node => node.type === 'noteInclude')).toHaveLength(1)
  expect(dom.container.querySelectorAll('[data-test-note="source-region"] .note-shared-content').length).toBeLessThanOrEqual(2)
  await act(async () => { await f.save(0) })
  expect(useAppStore.getState().documentIssues[key]).toMatchObject({ code: 'NOTE_SHARE_DEPENDENCY_UNCONFIRMED' })
  expect((await readdir(f.root)).filter(path => path.startsWith('block-'))).toEqual([])
  await act(async () => original.commands.undo())
  expect(original.getJSON().content!.some(node => node.type === 'noteInclude')).toBe(false)
  await act(async () => original.commands.insertContentAt(1, 'Still editable '))
  expect(original.getText()).toContain('Still editable A live chapter')
  expect((await readdir(f.root)).filter(path => path.startsWith('block-'))).toEqual([])
})

it('previews nested pending shares in their source scope and marks their exact original range', async () => {
  const f = await fixture(3)
  await f.mount()
  const destination = f.rich(1)
  await act(async () => { destination.view.focus(); destination.commands.setTextSelection(1); destination.commands.setNode('heading', { level: 2 }) })
  await f.paste(await f.copy())
  const section = dom.container.querySelector('[data-test-note="destination-region"]')!
  await act(async () => { destination.view.focus(); destination.commands.setTextSelection(1) })
  await act(async () => section.querySelector<HTMLButtonElement>('.note-block-action')!.click())
  const nestedClipboard = f.clipboard()
  await f.paste(nestedClipboard, 2)
  await vi.waitFor(() => {
    const preview = dom.container.querySelector('[data-test-note="another-region"]')!
    expect(preview.textContent).toContain('Original knowledge')
    expect(preview.textContent).not.toContain('The original shared content is not confirmed')
  })
  await vi.waitFor(() => expect(dom.container.querySelector('[data-test-note="source-region"] [data-note-shared-source="pending"]')).not.toBeNull())
  await act(async () => destination.commands.undo())
  await vi.waitFor(() => expect(dom.container.querySelector('[data-test-note="source-region"] [data-note-shared-source="pending"]')).toBeNull())
})

it('shows copy success and clipboard failure beside the original block without saving it', async () => {
  const f = await fixture(); await f.mount(); await f.copy()
  const source = dom.container.querySelector('[data-test-note="source-region"]')!
  expect(source.querySelector('[aria-label="Reference copied"]')).not.toBeNull()
  expect(source.querySelector('.note-block-copy-feedback')?.textContent).toBe('Copied · paste to share')
  expect((await readdir(f.root)).filter(path => path.startsWith('block-'))).toEqual([])
  Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false })
  await act(async () => source.querySelector<HTMLButtonElement>('.note-block-action')!.click())
  expect(source.querySelector('.note-block-copy-feedback[data-failed]')?.textContent).toContain('Copy was not confirmed')
  expect(f.rich(0).getText()).toContain('Original knowledge')
})


it('saves retained inner dependencies before an outer shared chapter without persisting missing files', async () => {
  const f = await fixture(3); await f.mount()
  const destination = f.rich(1)
  await act(async () => { destination.view.focus(); destination.commands.setTextSelection(1); destination.commands.setNode('heading', { level: 2 }) })
  await f.paste(await f.copy())
  await act(async () => { destination.view.focus(); destination.commands.setTextSelection(1) })
  await act(async () => dom.container.querySelector<HTMLButtonElement>('[data-test-note="destination-region"] .note-block-action')!.click())
  await f.paste(f.clipboard(), 2)
  await act(async () => { await f.save(2) })
  const names = (await readdir(f.root)).filter(path => path.startsWith('block-'))
  expect(names, JSON.stringify({ issues: useAppStore.getState().documentIssues, clipboard: f.clipboard().getData('application/x-agentmux-note-share'), nodes: destination.getJSON() })).toHaveLength(2)
  const shared = await Promise.all(names.map(async path => readNoteDocument(await readFile(join(f.root, path), 'utf8'))))
  const ids = new Set(shared.flatMap(value => value.status === 'valid' ? [value.note.noteId] : []))
  const embedded: string[] = []
  const visit = (node: import('@tiptap/core').JSONContent) => { if (node.type === 'noteInclude') embedded.push(String(node.attrs?.noteId)); node.content?.forEach(visit) }
  for (const read of shared) if (read.status === 'valid') visit(read.note.content)
  expect(embedded).toHaveLength(1)
  expect(embedded.every(id => ids.has(id))).toBe(true)
  await vi.waitFor(() => {
    const outer = dom.container.querySelector('[data-test-note="another-region"]')!
    expect(outer.textContent).toContain('Original knowledge')
    expect(outer.querySelector('.note-shared-notice')).toBeNull()
    expect(dom.container.querySelector('[data-test-note="destination-region"] [data-shared-role="source"]')).not.toBeNull()
  })
  const requests = vi.mocked(api.files.sharePublic).mock.calls.map(([request]) => request)
  expect(requests).toHaveLength(2)
  expect(requests[0]!.destination.expectedResource.path).toBe('destination.note.md')
  expect(requests[1]!.destination.expectedResource.path).toBe('another.note.md')
})

it('copies a pending include with its original proposal so another use can save it', async () => {
  const f = await fixture(3); await f.mount(); await f.paste(await f.copy())
  const destination = f.rich(1)
  await act(async () => { destination.view.focus(); destination.commands.setNodeSelection(destination.state.doc.content.size - 1) })
  const { copyNoteBlock, writeNoteShareClipboard } = await import('../src/renderer/src/lib/note-share-staging')
  const first = JSON.parse(f.clipboard().getData('application/x-agentmux-note-share'))
  const { zoneId, spaceId, expectedResource } = first.read
  writeNoteShareClipboard(document, copyNoteBlock(destination, destination.state.selection.from, { ...first.source, path: 'destination.note.md', noteId: 'destination' }, { zoneId, spaceId, expectedResource, path: 'destination.note.md' }), 'Original knowledge')
  const copied = f.clipboard(), payload = JSON.parse(copied.getData('application/x-agentmux-note-share'))
  expect(payload.source.noteId).toBe('source')
  expect(payload.include).toBeUndefined()
  await f.paste(copied, 2); await act(async () => { await f.save(2) })
  expect((await readdir(f.root)).filter(path => path.startsWith('block-'))).toHaveLength(1)
  await vi.waitFor(() => expect(dom.container.querySelector('[data-test-note="another-region"] .note-shared-content .note-block-content')?.textContent).toContain('Original knowledge'))
})

it.each([false, true])('saves a legitimate shared DAG including a hidden destination: %s', async (hidden) => {
 const f = await fixture(3); await f.mount()
 await act(async () => { const editor = f.rich(1); editor.view.focus(); editor.commands.setTextSelection(2); editor.commands.setHeading({ level: 2 }) })
 const original = await f.copy()
 await f.paste(original, 1)
 await f.paste(original, 2)
 await act(async () => { const editor = f.rich(1); editor.view.focus(); editor.commands.setTextSelection(2) })
 await act(async () => dom.container.querySelector<HTMLButtonElement>('[data-test-note="destination-region"] .note-block-action')!.click())
 await f.paste(f.clipboard(), 2)
 if (hidden) await f.mount([0, 1])
 await act(async () => { await f.save(2) })
 const names = (await readdir(f.root)).filter(name => name.startsWith('block-'))
 expect(names, JSON.stringify(useAppStore.getState().documentIssues)).toHaveLength(2)
 expect(vi.mocked(api.files.sharePublic).mock.calls).toHaveLength(2)
})

it.each([false, true])('keeps the original inner request after its reply is lost, applied: %s', async (applied) => {
 const f = await fixture(3); await f.mount()
 await act(async () => { const editor = f.rich(1); editor.view.focus(); editor.commands.setTextSelection(2); editor.commands.setHeading({ level: 2 }) })
 await f.paste(await f.copy(), 1)
 await act(async () => { const editor = f.rich(1); editor.view.focus(); editor.commands.setTextSelection(2) })
 await act(async () => dom.container.querySelector<HTMLButtonElement>('[data-test-note="destination-region"] .note-block-action')!.click())
 await f.paste(f.clipboard(), 2)
 await f.mount([0, 1])
 const share = vi.mocked(api.files.sharePublic), original = share.getMockImplementation()!
 share.mockImplementationOnce(async request => { if (applied) await original(request); throw Object.assign(Error('Reply transport lost'), { code: 'EPIPE' }) })
 const save = () => f.save(2)
 await act(async () => await save())
 const first = useAppStore.getState().documents[documentKey(f.workspace.id, 'destination.note.md')]!.noteEditing!.share!
 expect(first).toBeTruthy()
 expect(share.mock.calls).toHaveLength(1)
 expect(Object.keys(useAppStore.getState().documents[documentKey(f.workspace.id, 'another.note.md')]!.noteEditing!.shares!)).toHaveLength(1)
 await act(async () => await save())
 expect(vi.mocked(api.files.inspectSharePublic).mock.calls).toHaveLength(1)
 expect(vi.mocked(api.files.inspectSharePublic).mock.calls[0]![0]).toMatchObject({ mode: 'request', request: { operationId: first.params.operationId } })
 expect(share.mock.calls).toHaveLength(applied ? 2 : 1)
 if (applied) {
  expect((await readdir(f.root)).filter(name => name.startsWith('block-'))).toHaveLength(2)
 } else {
  expect((await readdir(f.root)).filter(name => name.startsWith('block-'))).toHaveLength(0)
  expect(useAppStore.getState().documents[documentKey(f.workspace.id, 'destination.note.md')]!.noteEditing!.share!.params.operationId).toBe(first.params.operationId)
 }
})

it('rejects an actual self-containing heading before writing and preserves ordinary Undo', async () => {
 const f = await fixture(); await f.mount()
 await act(async () => { const editor = f.rich(0); editor.commands.setTextSelection(2); editor.commands.setHeading({ level: 2 }) })
 await f.paste(await f.copy(), 0)
 await act(async () => await f.save(0))
 expect(api.files.sharePublic).not.toHaveBeenCalled()
 expect((await readdir(f.root)).filter(name => name.startsWith('block-'))).toHaveLength(0)
 expect(useAppStore.getState().documentIssues[documentKey(f.workspace.id, 'source.note.md')]).toMatchObject({ message: expect.stringContaining('contains its own shared use') })
 await act(async () => { f.rich(0).commands.undo(); f.rich(0).commands.insertContent(' ordinary input') })
 expect(f.rich(0).getText()).toContain('ordinary input')
})

it('does not save inner pending sources after the copied source identity changed', async () => {
 const f = await fixture(3); await f.mount()
 await act(async () => { const editor = f.rich(1); editor.commands.setTextSelection(2); editor.commands.setHeading({ level: 2 }) })
 await f.paste(await f.copy(), 1)
 await act(async () => f.rich(1).commands.setTextSelection(2))
 await act(async () => dom.container.querySelector<HTMLButtonElement>('[data-test-note="destination-region"] .note-block-action')!.click())
 await f.paste(f.clipboard(), 2)
 await f.mount([0, 1])
 const key = documentKey(f.workspace.id, 'destination.note.md'), state = useAppStore.getState(), parsed = readNoteDocument(state.documents[key]!.content)
 if (parsed.status !== 'valid') throw Error('Expected original note')
 const raw = serializeNoteDocument({ ...parsed.note, noteId: 'another-original' })
 await writeFile(join(f.root, 'destination.note.md'), raw)
 useAppStore.setState({ documents: { ...state.documents, [key]: { ...state.documents[key]!, content: raw, revision: noteHistoryRevision(raw) } } })
 await act(async () => await f.save(2))
 expect(api.files.sharePublic).not.toHaveBeenCalled()
 expect((await readdir(f.root)).filter(name => name.startsWith('block-'))).toHaveLength(0)
 expect(Object.keys(useAppStore.getState().documents[key]!.noteEditing!.shares!)).toHaveLength(1)
})

it('restores pending source boundaries for every source after remounting the retained drafts', async () => {
 const f = await fixture(3); await f.mount()
 await act(async () => { const editor = f.rich(1); editor.commands.setTextSelection(2); editor.commands.setHeading({ level: 2 }) })
 await f.paste(await f.copy(), 1)
 await act(async () => f.rich(1).commands.setTextSelection(2))
 await act(async () => dom.container.querySelector<HTMLButtonElement>('[data-test-note="destination-region"] .note-block-action')!.click())
 await f.paste(f.clipboard(), 2)
 await vi.waitFor(() => {
  expect(dom.container.querySelector('[data-test-note="source-region"] [data-note-shared-source="pending"]')).not.toBeNull()
  expect(dom.container.querySelector('[data-test-note="destination-region"] [data-note-shared-source="pending"]')).not.toBeNull()
 })
 await f.mount([])
 await f.mount()
 await vi.waitFor(() => {
  expect(dom.container.querySelector('[data-test-note="source-region"] [data-note-shared-source="pending"]')).not.toBeNull()
  expect(dom.container.querySelector('[data-test-note="destination-region"] [data-note-shared-source="pending"]')).not.toBeNull()
 })
})

it('does not submit a sharing write to another resource named by a mismatched clipboard read', async () => {
 const f = await fixture(); await f.mount()
 const copied = await f.copy(), payload = JSON.parse(copied.getData('application/x-agentmux-note-share'))
 const second = { ...f.workspace, id: 'other-notes', path: join(f.root, 'other-workspace') }
 await mkdir(second.path)
 await writeFile(join(second.path, 'source.note.md'), await readFile(join(f.root, 'source.note.md'), 'utf8'))
 const secondZone = workspaceZoneId(directoryIdentity(second.hostId, second.path), second.id)
 await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, workspaces: [...state.config!.workspaces, second] } })))
 payload.read = { ...payload.read, zoneId: secondZone, spaceId: directoryIdentity(second.hostId, second.path), expectedResource: { hostId: second.hostId, workspaceId: second.id, workspacePath: second.path } }
 const data = new DataTransfer(); data.setData('application/x-agentmux-note-share', JSON.stringify(payload))
 const read = vi.mocked(api.files.readPublic), original = read.getMockImplementation()!
 read.mockImplementation(async params => params.expectedResource.workspaceId === second.id ? {
  resource: { hostId: second.hostId, workspaceId: second.id, workspacePath: second.path, zoneId: secondZone, zonePath: second.path, path: params.path }, result: await f.writer.read(second, params.path)
 } : await original(params))
 await f.paste(data)
 await act(async () => await f.save())
 expect(vi.mocked(api.files.sharePublic).mock.calls, JSON.stringify(vi.mocked(api.files.sharePublic).mock.calls)).toHaveLength(0)
 expect(await readFile(join(second.path, 'source.note.md'), 'utf8')).toBe(await readFile(join(f.root, 'source.note.md'), 'utf8'))
})
