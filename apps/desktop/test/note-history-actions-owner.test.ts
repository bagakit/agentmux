import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import { noteHistoryRevision } from '@agentmux/core/note-history'
import { mergeNoteText } from '@agentmux/core/note-merge'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'
import { FileReadOwner } from '@agentmux/host/file-read-owner'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { NoteTitleFileWriter } from '@agentmux/host/note-title-file-writer'
import { NoteFileWriter } from '@agentmux/host/note-file-writer'
import { newNoteDocument, serializeNoteDocument, readNoteDocument } from '../src/shared/note-document'
import type { WorkspaceFileWriteResult, WorkspaceRecord } from '../src/shared/contracts'
const clean: Array<() => unknown | Promise<unknown>> = []
const person = { kind: 'user' as const, id: 'original-person' }, agent = { kind: 'agent' as const, id: 'original-agent' }
afterEach(async () => { vi.restoreAllMocks(); for (const dispose of clean.splice(0).reverse()) await dispose() })
async function fixture(creator: typeof person | typeof agent = person) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'note-history-action-'))); clean.push(() => rm(root, { recursive: true, force: true }))
  const workspace: WorkspaceRecord = { id: 'original-workspace', hostId: 'local', path: root, name: 'Notes', kind: 'folder' }
  const path = 'original.note.md', resource = { hostId: 'local', workspaceId: workspace.id, workspacePath: root, path }
  const metadata = new AgentMuxNotebookStore(join(root, 'notebooks.sqlite')), files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' }) as never)
  clean.push(() => files.dispose()); const writer = new NoteFileWriter(files, undefined, metadata)
  const note = newNoteDocument('Alpha', 'original-note', 'first', 'Original')
  note.content.content!.push({ type: 'paragraph', attrs: { blockId: 'second' }, content: [{ type: 'text', text: 'Bravo' }] }, { type: 'paragraph', attrs: { blockId: 'third' }, content: [{ type: 'text', text: 'Charlie' }] })
  const written = (result: WorkspaceFileWriteResult) => { expect(result.status).toBe('written'); if (result.status !== 'written') throw Error('The original file write must be confirmed'); return result }
  let current = written(await writer.write(workspace, { path, expectedRevision: null, content: serializeNoteDocument(note) }, { actor: creator }))
  const initial = { ...current }, save = async (content: string, actor: typeof person | typeof agent = person) => current = written(await writer.write(workspace, { path, expectedRevision: current.revision, content }, { actor }))
  const query = { noteId: note.noteId, resource }, target = () => ({ path, noteId: note.noteId, expectedRevision: current.revision })
  return { root, path, workspace, resource, metadata, files, writer, initial, save, target, written, query, disk: () => readFile(join(root, path), 'utf8') }
}
it('restores exact historical bytes as a new event and never replays over later edits', async () => {
  const f = await fixture(), old = await f.disk(), eventId = f.initial.noteHistory!.eventId!
  await f.save(old.replace('Alpha', 'Later Alpha').replace('Charlie', 'Later Charlie'), agent)
  const input = { ...f.target(), operationId: 'restore-original', eventId }
  const restored = f.written(await f.writer.restore(f.workspace, input, { actor: person }))
  expect(restored.content).toBe(old); expect(await f.disk()).toBe(old)
  const history = await f.metadata.readHistory({ ...f.query, eventId: input.operationId, includeContent: true })
  expect(history.entries[0]).toMatchObject({ operation: 'restore', source: { eventId }, content: old, actor: person })
  const later = f.written(await f.writer.write(f.workspace, { path: f.path, expectedRevision: restored.revision, content: old.replace('Bravo', 'Newer Bravo') }, { actor: agent }))
  const writes = vi.spyOn(f.files, 'write')
  expect(await f.writer.restore(f.workspace, input, { actor: person })).toMatchObject({ status: 'written', revision: restored.revision, noteHistory: { replayed: true } })
  expect(writes).not.toHaveBeenCalled(); expect(noteHistoryRevision(await f.disk())).toBe(later.revision)
  expect(await f.writer.restore(f.workspace, input, { actor: agent })).toMatchObject({ status: 'error', code: 'NOTE_OPERATION_CONFLICT' })
})
it('undoes a complete agent batch while preserving later nonconflicting human edits', async () => {
  const f = await fixture(), original = await f.disk()
  await f.save(original.replace('Alpha', 'Agent Alpha'), agent)
  await f.save((await f.disk()).replace('Bravo', 'Agent Bravo'), agent)
  const entries = (await f.metadata.readHistory(f.query)).entries, tail = entries[0]!
  expect(tail.batchId).toBe(entries[1]!.batchId)
  await f.save((await f.disk()).replace('Charlie', 'Human Charlie'))
  const result = f.written(await f.writer.undo(f.workspace, { ...f.target(), operationId: 'undo-agent', batchId: tail.batchId, batchLastEventId: tail.eventId }, { actor: person }))
  expect(result.content).toBe(original.replace('Charlie', 'Human Charlie')); expect(await f.disk()).toBe(result.content)
  const event = (await f.metadata.readHistory({ ...f.query, eventId: 'undo-agent' })).entries[0]!
  expect(event).toMatchObject({ operation: 'undo', source: { batchId: tail.batchId, lastEventId: tail.eventId }, actor: person })
})
it('retains overlapping edits and the terminal rejection of that original undo', async () => {
  const f = await fixture(), original = await f.disk()
  await f.save(original.replace('Alpha', 'Agent Alpha'), agent)
  const selected = (await f.metadata.readHistory(f.query)).entries[0]!
  await f.save((await f.disk()).replace('Agent Alpha', 'Human Alpha'))
  const input = { ...f.target(), operationId: 'overlapping-undo', batchId: selected.batchId, batchLastEventId: selected.eventId }, current = await f.disk()
  expect(await f.writer.undo(f.workspace, input, { actor: person })).toMatchObject({ status: 'conflict', noteConflict: { baseContent: expect.stringContaining('Agent Alpha'), currentContent: current, proposedContent: original }, noteHistory: { status: 'not-applied' } })
  expect(await f.disk()).toBe(current)
  await writeFile(join(f.root, f.path), original)
  expect(await f.writer.undo(f.workspace, input, { actor: person })).toMatchObject({ status: 'error', code: 'NOTE_OPERATION_NOT_APPLIED' })
  expect(await f.disk()).toBe(original)
})
it('fences a growing batch and an outdated current file without applying an expanded undo', async () => {
  const f = await fixture(); await f.save((await f.disk()).replace('Alpha', 'Agent Alpha'), agent)
  const selected = (await f.metadata.readHistory(f.query)).entries[0]!, oldTarget = f.target()
  await f.save((await f.disk()).replace('Bravo', 'Agent Bravo'), agent)
  const current = await f.disk()
  expect(await f.writer.undo(f.workspace, { ...f.target(), operationId: 'stale-tail', batchId: selected.batchId, batchLastEventId: selected.eventId }, { actor: person })).toMatchObject({ status: 'error', code: 'NOTE_HISTORY_BATCH_CHANGED' })
  expect(await f.writer.restore(f.workspace, { ...oldTarget, operationId: 'stale-current', eventId: f.initial.noteHistory!.eventId! }, { actor: person })).toMatchObject({ status: 'conflict', observedRevision: noteHistoryRevision(current), noteHistory: { status: 'not-applied' } })
  expect(await f.disk()).toBe(current)
})
it('keeps an unknown restored write unconfirmed after reopening instead of inferring its completion', async () => {
  const f = await fixture(); await f.save((await f.disk()).replace('Alpha', 'Later Alpha'), agent)
  const input = { ...f.target(), operationId: 'lost-restore-reply', eventId: f.initial.noteHistory!.eventId! }, actualWrite = f.files.write.bind(f.files)
  const writes = vi.spyOn(f.files, 'write').mockImplementationOnce(async (workspace, request) => { await actualWrite(workspace, request); throw Error('The original write reply was lost') })
  expect(await f.writer.restore(f.workspace, input, { actor: person })).toMatchObject({ status: 'unknown', noteHistory: { status: 'unconfirmed', eventId: input.operationId } })
  const disk = await f.disk(); writes.mockClear()
  const reopened = new NoteFileWriter(f.files, undefined, new AgentMuxNotebookStore(f.metadata.path))
  expect(await reopened.restore(f.workspace, input, { actor: person })).toMatchObject({ status: 'unknown', noteHistory: { eventId: input.operationId } })
  expect(writes).not.toHaveBeenCalled(); expect(await f.disk()).toBe(disk)
})

it('undoes a confirmed creation batch as empty content while preserving the original page identity and current title', async () => {
  const f = await fixture(agent)
  await f.save((await f.disk()).replace('Alpha', 'Agent Alpha').replace('title: "Original"', 'title: "Current title"'), agent)
  const selected = (await f.metadata.readHistory(f.query)).entries[0]!
  expect(selected.batchId).toBe(f.initial.noteHistory!.batchId)
  const result = f.written(await f.writer.undo(f.workspace, { ...f.target(), operationId: 'undo-creation', batchId: selected.batchId, batchLastEventId: selected.eventId }, { actor: person }))
  const parsed = readNoteDocument(result.content!)
  expect(parsed.status).toBe('valid'); if (parsed.status !== 'valid') throw Error('The original Note remains a legal document')
  expect(parsed.note).toMatchObject({ noteId: 'original-note', title: 'Current title', content: { content: [{ type: 'paragraph', attrs: { blockId: 'first' } }] } })
  expect(result.content).not.toContain('Alpha'); expect(result.content).not.toContain('Bravo'); expect(result.content).not.toContain('Charlie')
  expect(await f.disk()).toBe(result.content)
})
it('does not transplant an inverse edit to a later replacement block identity', async () => {
  const f = await fixture(); await f.save((await f.disk()).replace('Alpha', 'Agent Alpha'), agent)
  const selected = (await f.metadata.readHistory(f.query)).entries[0]!
  await f.save((await f.disk()).replace('^first', '^replacement'))
  const current = await f.disk()
  expect(await f.writer.undo(f.workspace, { ...f.target(), operationId: 'undo-replaced', batchId: selected.batchId, batchLastEventId: selected.eventId }, { actor: person })).toMatchObject({ status: 'conflict', noteConflict: { reason: 'identity' }, noteHistory: { status: 'not-applied' } })
  expect(await f.disk()).toBe(current)
})

it('rejects an inverse merge that duplicates a block ID even when all three source Notes are valid', async () => {
  const f = await fixture(), original = await f.disk()
  await f.save(original.replace(/Bravo\n\n\^second\n/u, ''), agent)
  const selected = (await f.metadata.readHistory(f.query)).entries[0]!, base = await f.disk()
  expect(base).not.toContain('^second')
  await f.save(base.trimEnd() + '\n\nHuman appended second\n\n^second\n')
  const current = await f.disk(), source = await f.metadata.readHistoryOperation(selected.eventId)
  expect(source).toMatchObject({ status: 'committed', beforeContent: original, content: base })
  for (const content of [base, current, original]) expect(readNoteDocument(content).status).toBe('valid')
  // The real line merge succeeds, but restoring the old middle block alongside
  // the later appended block cannot produce a valid stable-identity document.
  const merged = mergeNoteText(base, current, original)
  expect(merged.status).toBe('merged')
  if (merged.status !== 'merged') throw Error('This regression requires a nonoverlapping textual inverse')
  expect(merged.content.match(/^\^second$/gmu)).toHaveLength(2)
  expect(readNoteDocument(merged.content).status).toBe('invalid')
  const input = { ...f.target(), operationId: 'undo-duplicate-block', batchId: selected.batchId, batchLastEventId: selected.eventId }
  const writes = vi.spyOn(f.files, 'write')
  expect(await f.writer.undo(f.workspace, input, { actor: person })).toMatchObject({
    status: 'conflict', observedRevision: noteHistoryRevision(current),
    noteConflict: { reason: 'invalid-structure', baseContent: base, currentContent: current, proposedContent: original },
    noteHistory: { status: 'not-applied', eventId: input.operationId }
  })
  expect(writes).not.toHaveBeenCalled(); expect(await f.disk()).toBe(current)
  const reopenedMetadata = new AgentMuxNotebookStore(f.metadata.path)
  const rejected = await reopenedMetadata.readHistoryOperation(input.operationId)
  expect(rejected).toMatchObject({
    status: 'not-applied', operation: 'undo', actor: person, noteId: f.query.noteId, resource: f.resource,
    source: { batchId: selected.batchId, lastEventId: selected.eventId },
    baseRevision: noteHistoryRevision(current), beforeContent: current, revision: noteHistoryRevision(original), content: original
  })
  const reopened = new NoteFileWriter(f.files, undefined, reopenedMetadata)
  expect(await reopened.undo(f.workspace, input, { actor: person })).toMatchObject({ status: 'error', code: 'NOTE_OPERATION_NOT_APPLIED', noteHistory: { status: 'not-applied', eventId: input.operationId } })
  expect(await reopenedMetadata.readHistoryOperation(input.operationId)).toEqual(rejected)
  expect(writes).not.toHaveBeenCalled(); expect(await f.disk()).toBe(current)
})

it('runs the compiled restore and undo CLI through the real original file writer and durable journal', async () => {
  const f = await fixture(), original = await f.disk()
  await f.save(original.replace('Alpha', 'Agent Alpha'), agent)
  const selected = (await f.metadata.readHistory(f.query)).entries[0]!
  await f.save((await f.disk()).replace('Charlie', 'Human Charlie'))
  const owner = new FileReadOwner({ catalog: async () => ({ zones: [{ zoneId: 'original-zone', workspaceId: f.workspace.id, kind: 'directory', hostId: 'local', directoryPath: f.root }], bindings: [] }) as never,
    workspace: () => f.workspace, files: { read: f.writer.read.bind(f.writer), listFiles: f.files.listFiles.bind(f.files), history: f.writer.history.bind(f.writer), write: f.writer.write.bind(f.writer), restore: f.writer.restore.bind(f.writer), undo: f.writer.undo.bind(f.writer) } })
  const socketPath = join(f.root, 'control.sock'), server = new AgentMuxControlServer({ socketPath, files: owner, coreClients: () => [] })
  await server.start(); clean.push(() => server.stop())
  const common = ['--zone', 'original-zone', '--path', f.path, '--resource', JSON.stringify({ ...f.resource, zoneId: 'original-zone', zonePath: f.root }), '--note', f.query.noteId]
  const environment = objectCliEnvironment(f.root, { AGENTMUX_CONTROL_SOCKET: socketPath })
  const undone = await runCompiledObjectCli(['file', 'undo', ...common, '--expected-revision', f.target().expectedRevision, '--batch', selected.batchId, '--batch-last-event', selected.eventId, '--operation-id', 'cli-undo'], environment)
  expect(undone.code, undone.stderr).toBe(0)
  const receipt = JSON.parse(undone.stdout).result.result
  expect(receipt).toMatchObject({ status: 'written', content: original.replace('Charlie', 'Human Charlie'), noteHistory: { status: 'committed', eventId: 'cli-undo' } })
  expect(await f.disk()).toBe(receipt.content)
  const restored = await runCompiledObjectCli(['file', 'restore', ...common, '--expected-revision', receipt.revision, '--event-id', f.initial.noteHistory!.eventId!, '--operation-id', 'cli-restore'], environment)
  expect(restored.code, restored.stderr).toBe(0)
  expect(JSON.parse(restored.stdout).result.result).toMatchObject({ status: 'written', content: original, noteHistory: { status: 'committed', eventId: 'cli-restore' } })
  expect(await f.disk()).toBe(original)
  expect((await f.metadata.readHistory({ ...f.query, eventId: 'cli-restore' })).entries[0]).toMatchObject({ operation: 'restore', source: { eventId: f.initial.noteHistory!.eventId! } })
})

it('preserves the historical creator of a restored stable block and records the current restorer separately', async () => {
  const f = await fixture(), original = await f.disk()
  await f.save(original.replace(/Bravo\n\n\^second\n/u, ''), agent)
  expect(await f.disk()).not.toContain('Bravo')
  f.written(await f.writer.restore(f.workspace, { ...f.target(), operationId: 'restore-deleted-block', eventId: f.initial.noteHistory!.eventId! }, { actor: agent }))
  expect(await f.writer.read(f.workspace, f.path)).toMatchObject({ status: 'read', document: { noteProvenance: { blocks: { second: { created: { actor: person }, lastEdited: { actor: agent } } } } } })
})

it.each([person, agent])('restores the trusted creator with a $kind restorer after a rejected operation leaves the deletion parent unknown', async (restorer) => {
  const f = await fixture(), original = await f.disk(), parsed = readNoteDocument(original)
  expect(parsed.status).toBe('valid'); if (parsed.status !== 'valid') throw Error('The original Note must be valid')
  const refusedId = 'rejected-identity-before-delete'
  expect(await f.writer.write(f.workspace, {
    path: f.path, expectedRevision: f.initial.revision, baseContent: original, operationId: refusedId,
    content: serializeNoteDocument({ ...parsed.note, noteId: 'another-original-note' })
  }, { actor: agent })).toMatchObject({ status: 'conflict', noteConflict: { reason: 'identity' }, noteHistory: { status: 'not-applied', eventId: refusedId } })
  expect(await f.disk()).toBe(original)
  await f.save(original.replace(/Bravo\n\n\^second\n/u, ''), agent)
  expect(await f.disk()).not.toContain('^second')
  const selected = (await f.metadata.readHistory(f.query)).entries[0]!
  expect(selected).toMatchObject({ status: 'committed', actor: agent, parentEventId: null })
  expect(await f.metadata.readHistoryOperation(selected.eventId)).toMatchObject({ beforeContent: original, baseRevision: f.initial.revision })
  const operationId = 'undo-deletion-after-rejection'
  f.written(await f.writer.undo(f.workspace, { ...f.target(), operationId, batchId: selected.batchId, batchLastEventId: selected.eventId }, { actor: restorer }))
  expect(await f.disk()).toBe(original)
  const reopenedMetadata = new AgentMuxNotebookStore(f.metadata.path), reopened = new NoteFileWriter(f.files, undefined, reopenedMetadata)
  const authorship = { created: { actor: person }, lastEdited: { actor: restorer } }
  expect(await reopened.read(f.workspace, f.path)).toMatchObject({ status: 'read', document: { noteProvenance: { blocks: { second: authorship } } } })
  expect(await reopenedMetadata.readHistoryOperation(operationId)).toMatchObject({ status: 'committed', operation: 'undo', actor: restorer, provenance: { blocks: { second: authorship } } })
  expect(await reopenedMetadata.readHistoryOperation(refusedId)).toMatchObject({ status: 'not-applied' })
})

it('restores exact BOM and CRLF historical bytes without canonicalizing the selected body', async () => {
  const f = await fixture(), original = await f.disk(), raw = '\uFEFF' + original.replace(/\n/gu, '\r\n')
  await writeFile(join(f.root, f.path), raw)
  const titled = await new NoteTitleFileWriter(f.files, f.metadata).write(f.workspace, { operationId: 'record-raw-title', noteId: f.query.noteId, resource: f.resource, title: 'Raw original', actor: person })
  expect(titled.status).toBe('recorded'); if (titled.status !== 'recorded') throw Error('Original title event must exist')
  expect(titled.history.status).toBe('committed')
  const old = await f.disk(); expect(old.startsWith('\uFEFF')).toBe(true); expect(old).toContain('\r\n')
  const later = f.written(await f.writer.write(f.workspace, { path: f.path, expectedRevision: titled.revision, content: old.replace('Alpha', 'Later Alpha') }, { actor: agent }))
  const restored = f.written(await f.writer.restore(f.workspace, { path: f.path, noteId: f.query.noteId, expectedRevision: later.revision, operationId: 'restore-raw-source', eventId: titled.history.eventId! }, { actor: person }))
  expect(restored.content).toBe(old); expect(await f.disk()).toBe(old)
})
it('restores the selected saved after-body rather than the preceding before-body', async () => {
  const f = await fixture(); await f.save((await f.disk()).replace('Alpha', 'Selected Alpha'), agent)
  const selected = (await f.metadata.readHistory(f.query)).entries[0]!, saved = await f.disk()
  await f.save(saved.replace('Bravo', 'Later Bravo'))
  const result = f.written(await f.writer.restore(f.workspace, { ...f.target(), operationId: 'restore-after-body', eventId: selected.eventId }, { actor: person }))
  expect(result.content).toBe(saved); expect(await f.disk()).toContain('Selected Alpha'); expect(await f.disk()).not.toContain('Later Bravo')
})
