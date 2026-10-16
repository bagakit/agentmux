// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Editor } from '@tiptap/core'
import { createWorkspaceLayout } from '@agentmux/layout'
import { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import { computeNoteLiveMerge } from '@agentmux/client-ui/note/note-live-merge.worker'
import { noteHistoryRevision } from '@agentmux/core/note-history'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { NoteFileWriter } from '../src/main/note-file-writer'
import { FileReadOwner } from '../src/main/file-read-owner'
import { NoteSharedBlockOwner } from '../src/main/note-shared-block-owner'
import { NotebookObservationOwner } from '../src/main/notebook-observation-owner'
import { NoteFileSurfaceView } from '../src/renderer/src/components/NoteFileSurfaceView'
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { afterNoteComposition } from '../src/renderer/src/lib/note-live-merge'
import { useNotebookLibrary } from '../src/renderer/src/lib/notebook-library'
import { createWorkbenchTab, documentKey, type FileWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'
import { directoryIdentity, homeZoneId } from '../src/shared/space-addresses'
import { newNoteDocument, readNoteDocument, serializeNoteDocument } from '../src/shared/note-document'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { NoteSnapshotTestWorker } from './note-snapshot-test-worker'
const dom = composerDOM(), cleanups: Array<() => Promise<unknown>> = []
class NoteWorker extends NoteSnapshotTestWorker {
  onmessageerror = null
  override postMessage(input: Parameters<NoteSnapshotTestWorker['postMessage']>[0] | { base: string; current: string; proposed: string }) {
    if ('base' in input) queueMicrotask(() => this.onmessage?.({ data: computeNoteLiveMerge(input) } as never))
    else super.postMessage(input)
  }
}
beforeEach(() => vi.stubGlobal('Worker', NoteWorker))
afterEach(async () => { await dom.render(null); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllGlobals(); useNotebookLibrary.setState({ state: null, issue: null }) })
async function fixture(count = 2) {
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
  const publicFiles = new FileReadOwner({ share: { share: (params, context) => sharing.share(params, context), inspectShare: (params, context) => sharing.inspectShare(params, context) }, catalog: async () => ({ zones: [{ zoneId, workspaceId: workspace.id, hostId: 'local', kind: 'directory', directoryPath: root }], bindings: [{ zoneId, spaceId: birth }] }) as never,
    workspace: id => id === workspace.id ? workspace : undefined, files: { read: writer.read.bind(writer), listFiles: files.listFiles.bind(files), history: writer.history.bind(writer), write: writer.write.bind(writer), createShared: writer.createShared.bind(writer) } })
  sharing = new NoteSharedBlockOwner({ files: publicFiles, historyOperation: metadata.readHistoryOperation.bind(metadata), withWriteLease: metadata.runWithWriteLease.bind(metadata) })
  const inFlight = new Set<Promise<unknown>>()
  const track = <T,>(promise: Promise<T>) => { inFlight.add(promise); void promise.then(() => inFlight.delete(promise), () => inFlight.delete(promise)); return promise }
  cleanups.push(async () => { while (inFlight.size) await Promise.allSettled([...inFlight]) })
  vi.spyOn(api.files, 'readPublic').mockImplementation(input => publicFiles.read(input))
  vi.spyOn(api.files, 'sharePublic').mockImplementation(input => publicFiles.share(input, { actor: { kind: 'user', id: 'person' } }))
  vi.spyOn(api.files, 'inspectSharePublic').mockImplementation(input => publicFiles.inspectShare(input))
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
    const selector = embedded ? '.note-shared-block .note-block-content' : '.note-original-editor > div .note-block-content'
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
  await vi.waitFor(() => expect(dom.container.querySelectorAll('.note-shared-block .note-block-content'), dom.container.textContent ?? '').toHaveLength(2), { timeout: 3000 })
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

it('routes host formatting and undo to the focused shared editor, preserves IME input and keeps normal prose outside', async () => {
  const f = await fixture(); await f.mount(); await f.paste(await f.copy()); await act(async () => { await f.save() })
  await vi.waitFor(() => expect(dom.container.querySelectorAll('.note-shared-block .note-block-content')).toHaveLength(2), { timeout: 3000 })
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
  await vi.waitFor(() => expect(dom.container.querySelectorAll('.note-shared-block .note-block-content'), dom.container.textContent ?? '').toHaveLength(2), { timeout: 3000 })
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
  await vi.waitFor(() => expect(dom.container.querySelectorAll('.note-shared-block .note-block-content'), JSON.stringify({ text: dom.container.textContent, source: useAppStore.getState().documents[originalKey] })).toHaveLength(2), { timeout: 3000 })
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
  await vi.waitFor(() => expect(dom.container.querySelectorAll('.note-shared-block .note-block-content')).toHaveLength(2), { timeout: 3000 })
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
  await vi.waitFor(() => expect(dom.container.querySelector('.note-shared-block .ProseMirror')?.textContent).toContain('Original knowledge'))
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
  await vi.waitFor(() => expect(dom.container.querySelectorAll('.note-shared-block .note-block-content')).toHaveLength(2), { timeout: 3000 })
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
  expect(dom.container.querySelector('.note-shared-block')?.textContent).not.toContain('Cancel this use')
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
  await vi.waitFor(() => expect(dom.container.querySelectorAll('.note-shared-block .note-block-content')).toHaveLength(2), { timeout: 3000 })
  const source = f.rich(0, true)
  await act(async () => { source.view.focus(); source.commands.setTextSelection(2) })
  const button = dom.container.querySelector<HTMLButtonElement>('[data-test-note="source-region"] .note-shared-block .note-block-action')!
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
  await vi.waitFor(() => expect(dom.container.querySelectorAll('.note-shared-block .note-block-content')).toHaveLength(2), { timeout: 3000 })
  const editor = (copy: string) => (dom.container.querySelector(`[data-copy="${copy}"] .note-shared-block .note-block-content`) as HTMLElement & { editor: Editor }).editor
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
