import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { computeNoteLiveMerge } from '@agentmux/client-ui/note/note-live-merge.worker'
import { noteHistoryRevision } from '@agentmux/core/note-history'
import { newNoteDocument, serializeNoteDocument } from '../src/shared/note-document'
import { directoryIdentity, homeZoneId } from '../src/shared/space-addresses'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { setNoteComposition } from '../src/renderer/src/lib/note-live-merge'
import { createWorkbenchTab, documentKey } from '../src/renderer/src/lib/workbench-tabs'
import type { FileDocument, WorkspaceRecord } from '../src/shared/contracts'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const initial = useAppStore.getState()
const deferred: Array<() => void> = []
let deferWorker = false
// This only controls transport scheduling. The production merge algorithm and original Store run unchanged.
class MergeWorker {
  onmessage: ((event: { data: ReturnType<typeof computeNoteLiveMerge> }) => void) | null = null
  onerror = null
  onmessageerror = null
  terminate() {}
  postMessage(input: { base: string; current: string; proposed: string }) {
    const deliver = () => this.onmessage?.({ data: computeNoteLiveMerge(input) })
    if (deferWorker) deferred.push(deliver)
    else queueMicrotask(deliver)
  }
}
beforeEach(() => { vi.stubGlobal('Worker', MergeWorker) })
afterEach(() => {
  deferWorker = false; deferred.splice(0).forEach(deliver => deliver())
  useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

function body(a = 'Original first', b = 'Original last') {
  const note = newNoteDocument(a, 'session-note', 'first-block', 'Session title')
  note.content.content!.push({ type: 'paragraph', attrs: { blockId: 'last-block' }, content: [{ type: 'text', text: b }] })
  return serializeNoteDocument(note)
}
function fixture(initialContent = body()) {
  const workspace: WorkspaceRecord = { id: 'note-session', hostId: 'local', path: fixturePath('note-session'), name: 'Session', kind: 'folder' }
  const path = 'original.note.md', key = documentKey(workspace.id, path), spaceId = directoryIdentity('local', workspace.path), zoneId = homeZoneId(spaceId)
  const tab = { ...createWorkbenchTab('note-tab', { kind: 'file', regionId: 'note-region', workspaceId: workspace.id, path }), space: { spaceId, zoneId } }
  let disk = initialContent
  const document = (): FileDocument => ({ path, content: disk, revision: noteHistoryRevision(disk) })
  useAppStore.setState({ config: { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }], executors: {}, workspaces: [workspace], appearance: { terminalTheme: 'graphite' },
    browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } },
    tabs: { [tab.id]: tab }, layouts: { [workspace.id]: createWorkspaceLayout('note-group', [tab.id]) },
    spaceZoneBindings: { [zoneId]: { spaceId, workspaceId: workspace.id, directoryPath: workspace.path } },
    documents: { [key]: document() }, dirtyDocuments: {}, documentIssues: {}, documentGenerations: {}, documentObservationGenerations: {}, savingDocuments: {} })
  const resource = { hostId: 'local', workspaceId: workspace.id, workspacePath: workspace.path, zoneId, zonePath: workspace.path, path }
  vi.spyOn(api.files, 'read').mockImplementation(async () => ({ status: 'read', document: document() }))
  vi.spyOn(api.files, 'readPublic').mockImplementation(async () => ({ resource, result: { status: 'read', document: document() } }))
  vi.spyOn(api.files, 'historyPublic').mockImplementation(async () => ({ resource, result: { status: 'read', entries: [], hasMore: false } }))
  return { workspace, path, key, tab, resource, document, setDisk(value: string) { disk = value },
    edit(value: string) { useAppStore.getState().updateDocument(tab.id, value, 'note-region') },
    input(value: string, before: string) { useAppStore.getState().updateNoteDocument(tab.id, value, before, 'note-region') },
    refresh() { return useAppStore.getState().refreshDocument(workspace.id, path) },
    save() { return useAppStore.getState().saveDocument(tab.id, 'note-region') },
    current() { return useAppStore.getState().documents[key]! } }
}
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 0)) }
  throw Error('The original Note session did not reach the requested business state')
}

it('merges disjoint watcher changes into the original dirty document and saves from the new exact baseline', async () => {
  const f = fixture(), base = f.document().content
  f.edit(body('Human first')); f.setDisk(body(undefined, 'Agent last'))
  await f.refresh()
  expect(f.current().content).toBe(body('Human first', 'Agent last'))
  expect(f.current().noteEditing?.baseline?.content).toBe(body(undefined, 'Agent last'))
  const write = vi.spyOn(api.files, 'write').mockImplementation(async (_, input) => {
    expect(input.baseContent).toBe(body(undefined, 'Agent last'))
    expect(input.expectedRevision).toBe(noteHistoryRevision(input.baseContent!))
    f.setDisk(input.content); return { status: 'written', revision: noteHistoryRevision(input.content), content: input.content }
  })
  await f.save()
  expect(write).toHaveBeenCalledTimes(1); expect(f.current().content).not.toBe(base)
  expect(useAppStore.getState().dirtyDocuments[f.key]).toBe(false)
})

it('retains all three original bodies on a real overlapping change', async () => {
  const f = fixture(), base = f.current().content
  f.edit(body('Human first')); f.setDisk(body('Agent first')); await f.refresh()
  expect(f.current().content).toBe(body('Human first'))
  expect(useAppStore.getState().documentIssues[f.key]).toMatchObject({ kind: 'changed', observed: { content: body('Agent first') }, noteMerge: { baseContent: base, proposedContent: body('Human first') } })
})

it('defers remote adoption through composition and maps against the final published Chinese input', async () => {
  const f = fixture()
  setNoteComposition(f.key, 'note-region', true); f.setDisk(body(undefined, 'Agent last'))
  const refreshed = f.refresh(); await new Promise(resolve => setTimeout(resolve, 0))
  expect(f.current().content).toBe(body())
  f.edit(body('人类输入')); setNoteComposition(f.key, 'note-region', false); await refreshed
  expect(f.current().content).toBe(body('人类输入', 'Agent last'))
})

it('maps an editor delta from its actual older display before allowing a save, including more typing during the worker', async () => {
  const f = fixture(), editorBefore = f.current().content
  f.setDisk(body(undefined, 'Agent last')); await f.refresh()
  deferWorker = true
  f.input(body('Human first'), editorBefore)
  await until(() => deferred.length > 0)
  f.input(body('Human first!'), body('Human first'))
  const write = vi.spyOn(api.files, 'write').mockImplementation(async (_, input) => {
    expect(input.content).toBe(body('Human first!', 'Agent last'))
    f.setDisk(input.content); return { status: 'written', revision: noteHistoryRevision(input.content), content: input.content }
  })
  const saving = f.save(); expect(write).not.toHaveBeenCalled()
  deferWorker = false; deferred.splice(0).forEach(deliver => deliver()); await saving
  expect(write).toHaveBeenCalledTimes(1)
  expect(f.current().content).toBe(body('Human first!', 'Agent last'))
  expect(f.current().noteEditing?.input).toBeUndefined()
})

it('keeps a known written result without inventing canonical bytes from its submitted draft', async () => {
  const f = fixture(), canonical = body('Canonical first', 'Agent last')
  f.edit(body('Human first'))
  vi.spyOn(api.files, 'write').mockImplementation(async () => ({ status: 'written', revision: noteHistoryRevision(canonical), contentUnavailable: true }))
  await f.save()
  expect(f.current().content).toBe(body('Human first'))
  expect(f.current().noteEditing?.attempt).toMatchObject({ phase: 'written', written: { revision: noteHistoryRevision(canonical) } })
  f.setDisk(canonical); await useAppStore.getState().reloadDocument(f.tab.id, 'note-region')
  expect(f.current().content).toBe(canonical); expect(f.current().noteEditing?.attempt).toBeUndefined()
})

it('never infers an unknown original operation from matching current bytes or repeats it', async () => {
  const f = fixture(), proposed = body('Human first')
  f.edit(proposed)
  const write = vi.spyOn(api.files, 'write').mockImplementation(async () => ({ status: 'unknown', code: 'RECEIPT_LOST', message: 'The original receipt is unavailable' }))
  await f.save(); const original = f.current().noteEditing!.attempt!.operationId
  f.setDisk(proposed); await f.refresh(); await f.save()
  expect(write).toHaveBeenCalledTimes(1)
  expect(f.current().noteEditing?.attempt).toMatchObject({ operationId: original, phase: 'unknown' })
  expect(useAppStore.getState().dirtyDocuments[f.key]).toBe(true)
})

it('rejects a watcher result after the original resource moved away and back while its worker ran', async () => {
  const f = fixture(); f.edit(body('Human first')); f.setDisk(body(undefined, 'Agent last')); deferWorker = true
  const refreshed = f.refresh(); await until(() => deferred.length > 0)
  const config = useAppStore.getState().config!
  useAppStore.setState({ config: { ...config, workspaces: [{ ...f.workspace, path: fixturePath('another-note-resource') }] } })
  useAppStore.setState({ config })
  deferWorker = false; deferred.splice(0).forEach(deliver => deliver()); await refreshed
  expect(f.current().content).toBe(body('Human first'))
  expect(f.current().revision).toBe(noteHistoryRevision(body()))
})

it('reconciles a written original history event before merging a later observed file and never issues another write', async () => {
  const f = fixture(), proposed = body('Human first'), later = body('Human first', 'Later agent')
  f.edit(proposed)
  const write = vi.spyOn(api.files, 'write').mockImplementation(async () => ({ status: 'unknown', code: 'LOST', message: 'Original result unknown' }))
  await f.save(); const operation = f.current().noteEditing!.attempt!
  f.edit(body('Human later')); f.setDisk(later)
  vi.mocked(api.files.historyPublic).mockImplementation(async () => ({ resource: f.resource, result: { status: 'read', noteId: operation.noteId, resource: operation.resource, batches: [], hasMore: false,
    entries: [{ eventId: operation.operationId, sequence: 1, batchId: 'human-batch', noteId: operation.noteId, resource: operation.resource, originalResource: operation.resource,
      status: 'committed', at: _historyFixtureEpoch(0, 0, 1), actor: { kind: 'user', id: 'person' }, parentEventId: null, operation: 'edit', baseRevision: operation.expectedRevision,
      revision: noteHistoryRevision(proposed), content: proposed, beforeContent: operation.baseContent! }] } }))
  await f.refresh()
  expect(write).toHaveBeenCalledTimes(1); expect(f.current().noteEditing?.attempt).toBeUndefined()
  expect(f.current().content).toBe(body('Human later', 'Later agent'))
  expect(f.current().noteEditing?.receipt?.noteHistory).toMatchObject({ eventId: operation.operationId, replayed: true })
})

it.each([true, false])('restores the saved version through the original queue while preserving current and later unsaved drafts (display binding: %s)', async bound => {
  const f = fixture(), saved = body(undefined, 'Restored last')
  if (!bound) useAppStore.setState(state => ({ spaceZoneBindings: { ...state.spaceZoneBindings,
    [f.tab.space.zoneId]: { ...state.spaceZoneBindings[f.tab.space.zoneId]!, relations: { [f.tab.space.spaceId]: false } } } }))
  const selected = await useAppStore.getState().inspectNoteHistory(f.tab.id, 'note-region', 'session-note')
  expect(selected.target.spaceId).toBe(bound ? f.tab.space.spaceId : undefined)
  f.edit(body('Unsaved human'))
  let release!: (value: unknown) => void
  const restore = vi.spyOn(api.files, 'restorePublic').mockImplementation(async params => {
    expect(params.spaceId).toBe(bound ? f.tab.space.spaceId : undefined)
    expect(params.expectedRevision).toBe(noteHistoryRevision(body()))
    return await new Promise(resolve => { release = resolve }) as never
  })
  const action = useAppStore.getState().applyNoteHistory(f.tab.id, 'note-region', { target: selected.target, eventId: 'original-event' })
  await until(() => restore.mock.calls.length === 1)
  f.edit(body('Unsaved human later')); f.setDisk(saved)
  release({ resource: f.resource, result: { status: 'written', content: saved, revision: noteHistoryRevision(saved), noteHistory: { status: 'committed', eventId: 'restore-event', batchId: 'restore-batch' } } })
  await action
  expect(f.current().content).toBe(body('Unsaved human later', 'Restored last'))
  expect(useAppStore.getState().dirtyDocuments[f.key]).toBe(true)
  expect(useAppStore.getState().retainedDocumentDrafts[f.key]?.[0]?.content).toBe(body('Unsaved human'))
  expect(useAppStore.getState().tabs[f.tab.id]).toBe(f.tab)
})

it('retains the exact pending input and both drafts when its merge worker fails, without treating a missing result as applied', async () => {
  const f = fixture(), base = f.current().content
  f.setDisk(body(undefined, 'Agent last')); await f.refresh()
  vi.stubGlobal('Worker', class { constructor() { throw Error('Worker unavailable') } })
  f.input(body('Human first'), base)
  await until(() => f.current().noteEditing?.input?.phase === 'conflict')
  expect(f.current().content).toBe(body('Human first'))
  expect(f.current().noteEditing?.input).toMatchObject({ baseContent: base, observedContent: body(undefined, 'Agent last'), proposedContent: body('Human first') })
  const write = vi.spyOn(api.files, 'write')
  await f.save(); expect(write).not.toHaveBeenCalled()
  expect(useAppStore.getState().documentIssues[f.key]).toMatchObject({ kind: 'changed', noteMerge: { reason: 'Worker unavailable' } })
})

it('explicitly adopts the current original file while retaining the unresolved original operation and newest draft', async () => {
  const f = fixture(); f.edit(body('First attempt'))
  const write = vi.spyOn(api.files, 'write').mockImplementation(async () => ({ status: 'unknown', code: 'LOST', message: 'The original operation is unknown' }))
  await f.save(); const originalId = f.current().noteEditing!.attempt!.operationId
  f.edit(body('Newest unsaved draft')); f.setDisk(body(undefined, 'Current agent'))
  await useAppStore.getState().adoptNoteCurrentDocument(f.tab.id, 'note-region')
  expect(write).toHaveBeenCalledTimes(1)
  expect(f.current().content).toBe(body(undefined, 'Current agent')); expect(f.current().noteEditing?.attempt).toBeUndefined()
  const retained = useAppStore.getState().retainedDocumentDrafts[f.key]!.at(-1)!
  expect(retained.content).toBe(body('Newest unsaved draft'))
  expect(retained.noteEditing?.attempt).toMatchObject({ operationId: originalId, phase: 'unknown' })
  expect(useAppStore.getState().tabs[f.tab.id]).toBe(f.tab)
})

it('adopting a newer unsaved draft after an input conflict never marks that draft saved', async () => {
  const f = fixture(), original = f.current().content
  f.edit(body('Other view draft'))
  f.input(body('This view draft'), original)
  await until(() => f.current().noteEditing?.input?.phase === 'conflict')
  expect(useAppStore.getState().documentIssues[f.key]).toMatchObject({ kind: 'changed', noteMerge: { observedIsDraft: true } })
  await useAppStore.getState().reloadDocument(f.tab.id, 'note-region')
  expect(f.current().content).toBe(body('Other view draft'))
  expect(f.current().noteEditing?.baseline?.content).toBe(original)
  expect(useAppStore.getState().dirtyDocuments[f.key]).toBe(true)
  expect(useAppStore.getState().retainedDocumentDrafts[f.key]!.at(-1)!.content).toBe(body('This view draft'))
})

it('retries a failed input mapping against the same exact three sources', async () => {
  const f = fixture(), before = f.current().content
  f.setDisk(body(undefined, 'Agent last')); await f.refresh()
  vi.stubGlobal('Worker', class { constructor() { throw Error('Unavailable now') } })
  f.input(body('Human first'), before)
  await until(() => f.current().noteEditing?.input?.phase === 'conflict')
  vi.stubGlobal('Worker', MergeWorker)
  await useAppStore.getState().retryNoteInput(f.tab.id, 'note-region')
  expect(f.current().content).toBe(body('Human first', 'Agent last'))
  expect(f.current().noteEditing?.input).toBeUndefined()
  expect(useAppStore.getState().documentIssues[f.key]).toBeUndefined()
})

it('a normal baseline refresh cannot hide an unresolved newer-draft conflict or authorize its save', async () => {
  const f = fixture(), original = f.current().content
  f.edit(body('Other view draft')); f.input(body('This view draft'), original)
  await until(() => f.current().noteEditing?.input?.phase === 'conflict')
  await f.refresh()
  expect(useAppStore.getState().documentIssues[f.key]).toMatchObject({ kind: 'changed', observed: { content: body('Other view draft') } })
  const write = vi.spyOn(api.files, 'write')
  await f.save(); expect(write).not.toHaveBeenCalled()
  expect(f.current().noteEditing?.input?.observedContent).toBe(body('Other view draft'))
})

it.each(['source', 'retained', 'displayed'] as const)('a deliberate %s draft selection invalidates an older in-flight editor mapping', async mode => {
  const f = fixture(), before = f.current().content, selected = body('Deliberately selected')
  f.setDisk(body(undefined, 'Agent last')); await f.refresh(); deferWorker = true
  f.input(body('Older editor input'), before); await until(() => deferred.length > 0)
  if (mode === 'source') f.edit(selected)
  else if (mode === 'displayed') useAppStore.getState().retainNoteEditorDraft(f.tab.id, 'note-region', selected, f.current().content, { hostId: f.workspace.hostId, path: f.workspace.path }, 'keep-displayed')
  else {
    useAppStore.setState({ retainedDocumentDrafts: { [f.key]: [{ path: f.path, content: selected, revision: noteHistoryRevision(selected) }] } })
    useAppStore.getState().useRetainedDocumentDraft(f.tab.id, 'note-region')
  }
  deferWorker = false; deferred.splice(0).forEach(deliver => deliver())
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(f.current().content).toBe(selected); expect(f.current().noteEditing?.input).toBeUndefined()
  expect(useAppStore.getState().retainedDocumentDrafts[f.key]!.some(document => document.noteEditing?.input?.proposedContent === body('Older editor input'))).toBe(true)
  const write = vi.spyOn(api.files, 'write').mockImplementation(async (_, input) => {
    expect(input.content).toBe(selected); f.setDisk(selected)
    return { status: 'written', revision: noteHistoryRevision(selected), content: selected }
  })
  await f.save(); expect(write).toHaveBeenCalledTimes(1)
})

it('a written save waits for an unresolved input conflict without discarding its canonical receipt or any draft', async () => {
  const f = fixture(), original = f.current().content, submitted = body('Submitted'), canonical = body('Submitted', 'Canonical remote')
  f.edit(submitted)
  let release!: (value: unknown) => void
  const write = vi.spyOn(api.files, 'write').mockImplementation(async () => await new Promise(resolve => { release = resolve }) as never)
  const saving = f.save(); await until(() => write.mock.calls.length === 1)
  f.edit(body('Other view')); f.input(body('Old editor'), original)
  await until(() => f.current().noteEditing?.input?.phase === 'conflict')
  f.setDisk(canonical); release({ status: 'written', revision: noteHistoryRevision(canonical), content: canonical })
  await saving
  expect(f.current().content).toBe(body('Old editor'))
  expect(f.current().revision).toBe(noteHistoryRevision(original))
  expect(f.current().noteEditing?.attempt).toMatchObject({ phase: 'written', canonical })
  expect(f.current().noteEditing?.input?.observedContent).toBe(body('Other view'))
  expect(useAppStore.getState().documentIssues[f.key]?.kind).toBe('changed')
  await useAppStore.getState().reloadDocument(f.tab.id, 'note-region')
  expect(f.current().content).toBe(body('Other view', 'Canonical remote'))
  expect(f.current().noteEditing?.attempt).toBeUndefined()
  expect(f.current().noteEditing?.input).toBeUndefined()
  expect(useAppStore.getState().dirtyDocuments[f.key]).toBe(true)
  const retained = useAppStore.getState().retainedDocumentDrafts[f.key]!.at(-1)!
  expect(retained.content).toBe(body('Old editor'))
  expect(retained.noteEditing?.attempt).toMatchObject({ phase: 'written', canonical })
})

it('an invalid Source header cannot turn matching bytes into a certificate for an unknown ordinary Note-file save', async () => {
  const f = fixture(), source = 'Temporarily editing the identity header by hand\n'
  f.edit(source)
  const write = vi.spyOn(api.files, 'write').mockImplementation(async () => ({ status: 'unknown', code: 'LOST', message: 'The original save outcome is unknown' }))
  await f.save(); const operationId = f.current().noteEditing?.attempt?.operationId
  expect(operationId).toBeTypeOf('string'); expect(f.current().noteEditing?.attempt?.noteId).toBeNull()
  f.setDisk(source); await f.refresh()
  expect(f.current().noteEditing?.attempt?.operationId).toBe(operationId)
  expect(useAppStore.getState().dirtyDocuments[f.key]).toBe(true)
  await useAppStore.getState().adoptNoteCurrentDocument(f.tab.id, 'note-region')
  expect(write).toHaveBeenCalledTimes(1)
  expect(f.current().content).toBe(source); expect(f.current().noteEditing?.attempt).toBeUndefined()
  expect(useAppStore.getState().retainedDocumentDrafts[f.key]!.at(-1)?.noteEditing?.attempt?.operationId).toBe(operationId)
})

it.each(['unknown', 'error'] as const)('a %s write result remains visible beside the unresolved three-way input conflict', async status => {
  const f = fixture(), before = f.current().content
  f.edit(body('Submitted first'))
  let release!: (value: unknown) => void
  const write = vi.spyOn(api.files, 'write').mockImplementation(async () => await new Promise(resolve => { release = resolve }) as never)
  const saving = f.save(); await until(() => write.mock.calls.length === 1)
  f.edit(body('Other view')); f.input(body('Old editor'), before)
  await until(() => f.current().noteEditing?.input?.phase === 'conflict')
  release({ status, code: 'ORIGINAL_RESULT', message: 'The exact original writer result' }); await saving
  expect(useAppStore.getState().documentIssues[f.key]).toMatchObject({ kind: 'changed', observed: { content: body('Other view') }, operationIssue: { kind: status === 'unknown' ? 'write-unknown' : 'write-error', message: 'The exact original writer result' } })
  await f.refresh(); await f.save()
  expect(write).toHaveBeenCalledTimes(1)
  expect(f.current().noteEditing?.input?.observedContent).toBe(body('Other view'))
  expect(f.current().noteEditing?.attempt?.phase).toBe(status === 'unknown' ? 'unknown' : undefined)
})

it('retains an unmapped editor without guessing a common baseline, and an explicit choice keeps its incoming version too', async () => {
  const f = fixture(), displayed = body('Still displayed input'), incoming = body(undefined, 'Incoming moved content')
  f.setDisk(incoming); await f.refresh()
  const originalResource = { hostId: f.workspace.hostId, path: f.workspace.path }
  useAppStore.getState().retainNoteEditorDraft(f.tab.id, 'note-region', displayed, incoming, originalResource, 'retain')
  useAppStore.getState().retainNoteEditorDraft(f.tab.id, 'note-region', displayed, incoming, originalResource, 'retain')
  expect(f.current().content).toBe(incoming)
  expect(useAppStore.getState().retainedDocumentDrafts[f.key]).toHaveLength(1)
  expect(useAppStore.getState().retainedDocumentDrafts[f.key]![0]?.content).toBe(displayed)
  useAppStore.getState().retainNoteEditorDraft(f.tab.id, 'note-region', displayed, incoming, originalResource, 'keep-displayed')
  expect(f.current().content).toBe(displayed)
  expect(f.current().noteEditing?.baseline?.content).toBe(incoming)
  expect(useAppStore.getState().dirtyDocuments[f.key]).toBe(true)
  expect(useAppStore.getState().retainedDocumentDrafts[f.key]!.some(draft => draft.content === incoming)).toBe(true)
})

it.each(['target', 'resource'] as const)('a late unmapped editor cannot replace a newer %s', async changed => {
  const f = fixture(), incoming = f.current().content, displayed = body('Late editor')
  const resource = { hostId: f.workspace.hostId, path: f.workspace.path }
  if (changed === 'target') f.edit(body('Newer draft'))
  else useAppStore.setState(state => ({ config: { ...state.config!, workspaces: [{ ...f.workspace, path: fixturePath('other-resource') }] } }))
  const before = f.current()
  useAppStore.getState().retainNoteEditorDraft(f.tab.id, 'note-region', displayed, incoming, resource, 'keep-displayed')
  expect(f.current()).toBe(before)
  expect(useAppStore.getState().retainedDocumentDrafts[f.key]).toBeUndefined()
})


function threeBody(first = 'Original first', middle = 'Original middle', last = 'Original last') {
  const note = newNoteDocument(first, 'session-note', 'first-block', 'Session title')
  note.content.content!.push({ type: 'paragraph', attrs: { blockId: 'middle-block' }, content: [{ type: 'text', text: middle }] }, { type: 'paragraph', attrs: { blockId: 'last-block' }, content: [{ type: 'text', text: last }] })
  return serializeNoteDocument(note)
}

it('serializes exact deltas from different editor baselines without losing the original observed draft', async () => {
  const base = threeBody(), observed = threeBody('Other view first'), local = threeBody(undefined, 'This view middle'), later = threeBody(undefined, undefined, 'Third view last')
  const f = fixture(base)
  f.edit(observed); deferWorker = true
  f.input(local, base); await until(() => deferred.length > 0)
  f.input(later, base)
  deferWorker = false; deferred.splice(0).forEach(deliver => deliver())
  await until(() => !f.current().noteEditing?.input)
  const expected = threeBody('Other view first', 'This view middle', 'Third view last')
  expect(f.current().content).toBe(expected)
  const write = vi.spyOn(api.files, 'write').mockImplementation(async (_, input) => {
    expect(input.content).toBe(expected); f.setDisk(expected)
    return { status: 'written', revision: noteHistoryRevision(expected), content: expected }
  })
  await f.save(); expect(write).toHaveBeenCalledTimes(1)
})

it('retains every readable version when an earlier input conflicts before a queued editor delta', async () => {
  const f = fixture(), base = f.current().content, observed = body('Other view'), local = body('Conflicting view'), later = body(undefined, 'Later view')
  f.edit(observed); deferWorker = true
  f.input(local, base); await until(() => deferred.length > 0)
  f.input(later, base)
  deferWorker = false; deferred.splice(0).forEach(deliver => deliver())
  await until(() => f.current().noteEditing?.input?.phase === 'conflict')
  expect(f.current().content).toBe(later)
  expect(useAppStore.getState().documentIssues[f.key]).toMatchObject({ kind: 'changed', observed: { content: observed }, noteMerge: { baseContent: base, proposedContent: local, earlierInput: true } })
  const drafts = useAppStore.getState().retainedDocumentDrafts[f.key]!
  expect(drafts.map(draft => draft.content)).toEqual(expect.arrayContaining([observed, local]))
  const chosen = drafts.find(draft => draft.content === observed)!
  useAppStore.getState().useRetainedDocumentDraft(f.tab.id, 'note-region', chosen)
  expect(f.current().content).toBe(observed)
  expect(useAppStore.getState().dirtyDocuments[f.key]).toBe(true)
  const retained = useAppStore.getState().retainedDocumentDrafts[f.key]!
  expect(retained.some(draft => draft.content === later && draft.noteEditing?.input?.queued?.[0]?.proposedContent === later)).toBe(true)
})
