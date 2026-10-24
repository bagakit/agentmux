// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import { readNoteMarkdownHeader } from '@agentmux/core/note-format'
import { noteHistoryRevision } from '@agentmux/core/note-history'
import { parseFileShareResult, fileShareUndoStageOperation, type FileShareParams, type FileWriteParams } from '@agentmux/core/files'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { NoteFileWriter } from '@agentmux/host/note-file-writer'
import { FileReadOwner } from '@agentmux/host/file-read-owner'
import { NoteSharedUndoOwner } from '@agentmux/host/note-shared-undo-owner'
import { NoteSharedFileDeleteOwner } from '@agentmux/host/note-shared-file-delete-owner'
import { noteShareRange, noteShareSiblingRange } from '@agentmux/client-ui/note/note-share-range'
import { NoteSharedBlockOwner } from '@agentmux/host/note-shared-block-owner'
import { noteKnowledge, resolveNoteBlock } from '@agentmux/client-ui/note/note-knowledge'
import { newNoteDocument, readNoteDocument, serializeNoteDocument } from '../src/shared/note-document'
import type { WorkspaceRecord } from '../src/shared/contracts'
const dispose: (() => Promise<unknown>)[] = []
const author = { kind: 'agent' as const, id: 'original-research-agent' }, person = { kind: 'user' as const, id: 'local-person' }
afterEach(async () => { vi.restoreAllMocks(); for (const close of dispose.splice(0).reverse()) await close() })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'note-shared-'))), directory = join(root, 'notes'); await mkdir(directory)
  dispose.push(() => rm(root, { recursive: true, force: true }))
  const workspace: WorkspaceRecord = { id: 'notes', hostId: 'local', name: 'Notes', kind: 'folder', path: directory }
  const files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' }) as never); dispose.push(() => files.dispose())
  const metadata = new AgentMuxNotebookStore(join(root, 'state', 'notebooks.sqlite')), writer = new NoteFileWriter(files, undefined, metadata)
  const sourceNote = newNoteDocument('One original knowledge source', 'source-note', 'source-block')
  sourceNote.content.content!.push({ type: 'paragraph', attrs: { blockId: 'untouched' }, content: [{ type: 'text', text: 'Keep this outside' }] })
  const destinationNote = newNoteDocument('Destination before paste', 'destination-note', 'destination-body')
  for (const [path, note] of [['source.note.md', sourceNote], ['destination.note.md', destinationNote]] as const) expect((await writer.write(workspace, { path, content: serializeNoteDocument(note), expectedRevision: null }, { actor: author })).status).toBe('written')
  const workspaces = [workspace]
  let shared!: NoteSharedBlockOwner
  const port = new FileReadOwner({ share: { share: (input, context) => shared.share(input, context), undoShare: (input, context) => shared.undoShare(input, context), inspectShare: (input, context) => shared.inspectShare(input, context) },
    catalog: async () => ({ zones: workspaces.map(item => ({ zoneId: item.id === workspace.id ? 'zone' : 'zone-' + item.id, workspaceId: item.id, kind: 'directory', hostId: 'local', directoryPath: item.path })), bindings: [] }) as never,
    workspace: id => workspaces.find(item => item.id === id),
    files: { writeSharedUndo: writer.writeSharedUndo.bind(writer), read: writer.read.bind(writer), listFiles: files.listFiles.bind(files), history: writer.history.bind(writer), write: writer.write.bind(writer), createShared: writer.createShared.bind(writer) } })
  const deletion = new NoteSharedFileDeleteOwner(files, metadata)
  const makeUndo = (afterStage?: ConstructorParameters<typeof NoteSharedUndoOwner>[0]['afterStage']) => new NoteSharedUndoOwner({ files, workspaces: async () => ({ workspaces, complete: true }), target: port.targetForNote.bind(port), read: port.read.bind(port), write: port.write.bind(port), writeInverse: port.writeSharedInverse.bind(port), history: query => metadata.readHistory(query), operation: id => metadata.readHistoryOperation(id), lease: metadata.runWithWriteLease.bind(metadata), delete: (resource, input, context) => deletion.delete(workspaces.find(w => w.id === resource.workspaceId)!, input, context), ...(afterStage ? { afterStage } : {}) })
  const undo = makeUndo()
  const makeOwner = (afterStage?: ConstructorParameters<typeof NoteSharedBlockOwner>[0]['afterStage'], undoOwner = undo) => new NoteSharedBlockOwner({ undo: undoOwner, files: {read:port.read.bind(port),write:port.write.bind(port),createShared:port.createShared.bind(port),writeInverse:port.writeSharedInverse.bind(port)}, historyOperation: metadata.readHistoryOperation.bind(metadata), withWriteLease: metadata.runWithWriteLease.bind(metadata), ...(afterStage ? { afterStage } : {}) })
  shared = makeOwner()
  const request = async (path: string, operationId: string): Promise<FileWriteParams> => {
    const content = await readFile(join(directory, path), 'utf8')
    return { zoneId: 'zone', path, expectedResource: { hostId: 'local', workspaceId: workspace.id, workspacePath: directory, zoneId: 'zone', zonePath: directory, path }, content, baseContent: content, expectedRevision: noteHistoryRevision(content), operationId }
  }
  const source = await request('source.note.md', 'source-draft'), destination = await request('destination.note.md', 'destination-save')
  const include = (referenceId = 'paste-reference', blockId = 'destination-include') => ({ type: 'noteInclude', attrs: { blockId, referenceId, noteId: 'shared-note', path: 'block-shared.note.md' } })
  const draft = readNoteDocument(destination.content); if (draft.status !== 'valid') throw Error('Fixture Note must parse')
  draft.note.content.content!.push(include())
  const params: FileShareParams = { operationId: 'shared-save', destination: { ...destination, content: serializeNoteDocument(draft.note) }, promotions: [{ operationId: 'promote-original', source, sourceNoteId: 'source-note', sourceBlockId: 'source-block', referenceId: 'paste-reference', shared: { zoneId: 'zone', path: 'block-shared.note.md', expectedResource: { ...source.expectedResource, path: 'block-shared.note.md' }, noteId: 'shared-note', title: 'Shared knowledge' } }] }
  return { root, directory, workspace, workspaces, files, writer, metadata, port, makeOwner, params, source, destination, include, undo, makeUndo, deletion }
}
it('uses the real public CLI to create only Markdown, replace the original block and save multiple occurrences against one shared identity', async () => {
  const f = await fixture(), note = readNoteDocument(f.params.destination.content); if (note.status !== 'valid') throw Error('Destination must parse')
  note.note.content.content!.push(f.include('second-use', 'second-include')); f.params.destination.content = serializeNoteDocument(note.note)
  const socketPath = join(f.root, 'control.sock'), server = new AgentMuxControlServer({ socketPath, files: f.port, coreClients: () => [] }); await server.start(); dispose.push(() => server.stop())
  const environment = objectCliEnvironment(f.root, { AGENTMUX_RPC_ENDPOINT: 'unix:' + server.path })
  const result = await runCompiledObjectCli(['file', 'share', '--input', '-'], environment, JSON.stringify(f.params))
  expect(result.code, result.stderr + result.stdout).toBe(0)
  const receipt = JSON.parse(result.stdout).result
  expect(parseFileShareResult(receipt, f.params)).toMatchObject({ status: 'committed', destination: { result: { status: 'written' } }, promotions: [{ shared: { result: { status: 'written', noteHistory: { status: 'committed', eventId: 'promote-original:create' } } }, source: { result: { status: 'written' } } }] })
  expect((await readdir(f.directory)).sort()).toEqual(['block-shared.note.md', 'destination.note.md', 'source.note.md'])
  const shared = await readFile(join(f.directory, 'block-shared.note.md'), 'utf8'), source = await readFile(join(f.directory, 'source.note.md'), 'utf8'), destination = await readFile(join(f.directory, 'destination.note.md'), 'utf8')
  expect(shared).toContain('kind: shared-block'); expect(readNoteMarkdownHeader(shared)).toMatchObject({ status: 'valid', origin: { requestFingerprint: expect.stringMatching(/^sha256:/u) } }); expect(shared).toContain('One original knowledge source'); expect(shared).not.toContain('Keep this outside')
  expect(readNoteDocument(source)).toMatchObject({ status: 'valid', note: { content: { content: [{ type: 'noteInclude', attrs: { blockId: 'source-block', noteId: 'shared-note' } }, { type: 'paragraph' }] } } }); expect(source).not.toContain('One original knowledge source'); expect(source).toContain('Keep this outside')
  expect(readNoteDocument(destination)).toMatchObject({ status: 'valid', note: { content: { content: [{ type: 'paragraph' }, { type: 'noteInclude', attrs: { noteId: 'shared-note' } }, { type: 'noteInclude', attrs: { noteId: 'shared-note' } }] } } })
  const inspect = await runCompiledObjectCli(['file', 'share', 'inspect', '--input', '-'], environment, JSON.stringify({ mode: 'request', request: f.params }))
  expect(inspect.code, inspect.stderr + inspect.stdout).toBe(0)
  expect(JSON.parse(inspect.stdout).result).toMatchObject({ mode: 'request', result: { status: 'committed', promotions: [{ shared: { result: { noteHistory: { replayed: true } } }, currentShared: { result: { status: 'read' } } }] } })
})
it('keeps original Agent authorship when a person shares saved content and records real dirty edits under the person', async () => {
  const f = await fixture(), result = await f.port.share(f.params, { actor: person })
  expect(result.status, JSON.stringify(result)).toBe('committed')
  const body = await f.writer.read(f.workspace, 'block-shared.note.md')
  expect(body).toMatchObject({ status: 'read', document: { noteProvenance: { blocks: { 'source-block': { created: { actor: author }, lastEdited: { actor: author } } } } } })
  const g = await fixture(); g.params.promotions[0]!.source.content = g.source.content.replace('One original knowledge source', 'Actual unsaved correction')
  expect((await g.port.share(g.params, { actor: person })).status).toBe('committed')
  expect(await g.writer.read(g.workspace, 'block-shared.note.md')).toMatchObject({ status: 'read', document: { noteProvenance: { blocks: { 'source-block': { created: { actor: author }, lastEdited: { actor: person } } } } } })
})
it('same-page first reuse has one final file write and preserves both the original include and its pasted use', async () => {
  const f = await fixture(), note = readNoteDocument(f.source.content); if (note.status !== 'valid') throw Error('Source must parse')
  note.note.content.content!.push(f.include())
  f.params.destination = { ...f.source, operationId: 'same-page-save', content: serializeNoteDocument(note.note) }
  const write = vi.spyOn(f.files, 'write'), result = await f.port.share(f.params, { actor: person })
  expect(result.status, JSON.stringify(result)).toBe('committed')
  expect(parseFileShareResult(result, f.params)).toMatchObject({ promotions: [{ source: { result: { noteHistory: { eventId: 'same-page-save' } } } }] })
  expect(write.mock.calls.filter(([, request]) => request.path === f.source.path)).toHaveLength(1)
  const saved = await readFile(join(f.directory, f.source.path), 'utf8')
  expect(saved.match(/::note-include/gu)).toHaveLength(2); expect(saved).not.toContain('One original knowledge source'); expect(saved).toContain('Keep this outside')
})
it.each(['shared', 'source'] as const)('reopens after the %s phase and separately inspects original receipts before an explicit continuation', async phase => {
  const f = await fixture(), interrupted = f.makeOwner(async stage => { if (stage === phase) throw Error('Simulated owner exit after confirmed phase') })
  const first = await interrupted.share(f.params, { actor: person })
  expect(first.status).toBe('unknown'); expect(first.promotions[0]!.shared?.result.status).toBe('written'); expect(first.destination).toBeNull()
  const reopened = f.makeOwner(), inspection = await reopened.inspectShare({ mode: 'request', request: f.params }, { actor: person }); if (inspection.mode !== 'request') throw Error('Expected request inspection'); const inspect = inspection.result
  expect(inspect.status).toBe('unknown'); expect(inspect.promotions[0]!.shared?.result).toMatchObject({ status: 'written', noteHistory: { replayed: true } }); expect(inspect.promotions[0]!.currentShared?.result.status).toBe('read')
  const writes = vi.spyOn(f.files, 'write'), resumed = await reopened.share(f.params, { actor: person })
  expect(resumed.status, JSON.stringify(resumed)).toBe('committed')
  expect(writes.mock.calls.some(([, input]) => input.path === 'block-shared.note.md')).toBe(false)
  if (phase === 'source') expect(writes.mock.calls.some(([, input]) => input.path === 'source.note.md')).toBe(false)
})
it('does not convert a matching current file into an original receipt or replay an unknown create', async () => {
  const f = await fixture(), actual = f.files.write.bind(f.files)
  const writes = vi.spyOn(f.files, 'write').mockImplementationOnce(async (workspace, input) => { await actual(workspace, input); throw Error('Original shared-create receipt lost') })
  const first = await f.port.share(f.params, { actor: person })
  expect(first.status).toBe('unknown'); expect(first.promotions[0]!.shared?.result.status).toBe('unknown')
  const calls = writes.mock.calls.length, reopened = f.makeOwner(), inspection = await reopened.inspectShare({ mode: 'request', request: f.params }, { actor: person }); if (inspection.mode !== 'request') throw Error('Expected request inspection'); const inspect = inspection.result
  expect(inspect).toMatchObject({ status: 'unknown', promotions: [{ shared: { result: { status: 'unknown' } }, currentShared: { result: { status: 'read' } } }] })
  expect((await reopened.share(f.params, { actor: person })).status).toBe('unknown'); expect(writes.mock.calls).toHaveLength(calls)
  expect(await readFile(join(f.directory, f.source.path), 'utf8')).toBe(f.source.content)
})
it('never creates an entity for an undone occurrence or overwrites an occupied shared target', async () => {
  const f = await fixture(); f.params.destination.content = f.destination.content
  expect(await f.port.share(f.params, { actor: person })).toMatchObject({ status: 'error', code: 'NOTE_SHARE_OCCURRENCE_REMOVED' })
  expect(await readdir(f.directory)).not.toContain('block-shared.note.md')
  const g = await fixture(); await writeFile(join(g.directory, 'block-shared.note.md'), 'Unrelated original bytes')
  expect((await g.port.share(g.params, { actor: person })).status).toBe('conflict')
  expect(await readFile(join(g.directory, 'block-shared.note.md'), 'utf8')).toBe('Unrelated original bytes')
  expect(await readFile(join(g.directory, g.source.path), 'utf8')).toBe(g.source.content)
})
it('accepts a newly written source block before its first disk save and keeps other unsaved source edits', async () => {
  const f = await fixture(), source = readNoteDocument(f.source.content); if (source.status !== 'valid') throw Error('Source must parse')
  source.note.content.content![1]!.content![0]!.text = 'Another unsaved source correction'
  source.note.content.content!.push({ type: 'paragraph', attrs: { blockId: 'new-transient-block' }, content: [{ type: 'text', text: 'New content has never been saved' }] })
  f.params.promotions[0]!.source.content = serializeNoteDocument(source.note); f.params.promotions[0]!.sourceBlockId = 'new-transient-block'
  expect((await f.port.share(f.params, { actor: person })).status).toBe('committed')
  expect(await readFile(join(f.directory, 'block-shared.note.md'), 'utf8')).toContain('New content has never been saved')
  const current = await readFile(join(f.directory, f.source.path), 'utf8')
  expect(current).toContain('Another unsaved source correction'); expect(current).toContain('One original knowledge source'); expect(current).not.toContain('New content has never been saved')
  expect(await f.writer.read(f.workspace, 'block-shared.note.md')).toMatchObject({ status: 'read', document: { noteProvenance: { blocks: { 'new-transient-block': { created: { actor: person } } } } } })
})
it('extracts an ordered list item with its original number and leaves valid Markdown before and after the include', async () => {
  const f = await fixture(), source = newNoteDocument('', 'source-note', 'unused')
  source.content.content = [{ type: 'orderedList', attrs: { start: 7 }, content: ['first', 'middle', 'last'].map((text, index) => ({ type: 'listItem', attrs: { blockId: 'item-' + index }, content: [{ type: 'paragraph', attrs: { blockId: 'paragraph-' + index }, content: [{ type: 'text', text }] }] })) }]
  const create = await f.writer.write(f.workspace, { path: f.source.path, content: serializeNoteDocument(source), expectedRevision: f.source.expectedRevision }, { actor: author })
  if (create.status !== 'written') throw Error('Source list must save')
  const saved = await readFile(join(f.directory, f.source.path), 'utf8')
  f.params.promotions[0]!.source = { ...f.source, content: saved, baseContent: saved, expectedRevision: create.revision }; f.params.promotions[0]!.sourceBlockId = 'item-1'
  const result = await f.port.share(f.params, { actor: person })
  expect(result.status, JSON.stringify(result)).toBe('committed')
  expect(readNoteDocument(await readFile(join(f.directory, 'block-shared.note.md'), 'utf8'))).toMatchObject({ status: 'valid', note: { content: { content: [{ type: 'orderedList', attrs: { start: 8 }, content: [{ type: 'listItem', attrs: { blockId: 'item-1' } }] }] } } })
  expect(readNoteDocument(await readFile(join(f.directory, f.source.path), 'utf8'))).toMatchObject({ status: 'valid', note: { content: { content: [{ type: 'orderedList', attrs: { start: 7 } }, { type: 'noteInclude', attrs: { blockId: 'item-1' } }, { type: 'orderedList', attrs: { start: 9 } }] } } })
  const originalSource = await f.writer.read(f.workspace, f.source.path), sharedSource = await f.writer.read(f.workspace, 'block-shared.note.md')
  if (originalSource.status !== 'read' || sharedSource.status !== 'read') throw Error('Both original and shared Markdown must read')
  const knowledge = noteKnowledge([{ location: { workspaceId: f.workspace.id, path: f.source.path }, document: originalSource.document }, { location: { workspaceId: f.workspace.id, path: 'block-shared.note.md' }, document: sharedSource.document }], 'complete')
  expect(resolveNoteBlock(knowledge, { noteId: 'source-note', blockId: 'paragraph-1' })).toMatchObject({ status: 'resolved', source: { note: { noteId: 'shared-note' } }, block: { blockId: 'paragraph-1', text: 'middle' } })
  expect(await f.port.undoShare(await removal(f),{actor:person})).toMatchObject({status:'committed',collections:[{deletion:{result:{status:'deleted'}}}]})
  const restored=readNoteDocument(await readFile(join(f.directory,f.source.path),'utf8'));expect(restored).toMatchObject({status:'valid',note:{content:{content:[{type:'orderedList',attrs:{start:7},content:[{type:'listItem'},{type:'listItem'},{type:'listItem'}]}]}}})
  if(restored.status==='valid'){const document=await f.writer.read(f.workspace,f.source.path);if(document.status!=='read')throw Error('fixture');const current=noteKnowledge([{location:{workspaceId:f.workspace.id,path:f.source.path},document:document.document}],'complete');expect(resolveNoteBlock(current,{noteId:'source-note',blockId:'paragraph-1'})).toMatchObject({status:'resolved',source:{note:{noteId:'source-note'}},block:{text:'middle'}})}

})
async function richSharingFixture(kind: 'taskList' | 'bulletList' | 'orderedList' | 'table') {
  const f = await fixture(), note = newNoteDocument('', 'source-note', 'unused')
  note.content.content = kind === 'table' ? [{ type: 'table', attrs: { blockId: 'whole-table' }, content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [{ type: 'paragraph', attrs: { blockId: 'cell-body' }, content: [{ type: 'text', text: 'Original table evidence' }] }] }] }] }]
    : [{ type: kind, ...(kind === 'orderedList' ? { attrs: { start: 7 } } : {}), content: ['before', 'selected', 'after'].map((text, index) => ({ type: kind === 'taskList' || index === 1 ? 'taskItem' : 'listItem', attrs: { blockId: 'item-' + index, ...(kind === 'taskList' || index === 1 ? { checked: index === 1 } : {}) }, content: [{ type: 'paragraph', attrs: { blockId: 'item-body-' + index }, content: [{ type: 'text', text }] }] })) }]
  const saved = await f.writer.write(f.workspace, { path: f.source.path, content: serializeNoteDocument(note), expectedRevision: f.source.expectedRevision }, { actor: author })
  if (saved.status !== 'written') throw Error('The actual rich original must save')
  const original = await readFile(join(f.directory, f.source.path), 'utf8')
  f.params.promotions[0]!.source = { ...f.source, content: original, baseContent: original, expectedRevision: saved.revision }
  f.params.promotions[0]!.sourceBlockId = kind === 'table' ? 'whole-table' : 'item-1'
  return { ...f, original }
}
it.each(['taskList', 'bulletList', 'orderedList', 'table'] as const)('shares and undoes a real %s range with original checked state, identities and authors', async kind => {
  const f = await richSharingFixture(kind), result = await f.port.share(f.params, { actor: person })
  expect(result.status, JSON.stringify(result)).toBe('committed')
  const shared = await f.writer.read(f.workspace, 'block-shared.note.md')
  if (shared.status !== 'read') throw Error('Shared original must read')
  const parsed = readNoteDocument(shared.document.content)
  expect(parsed.status).toBe('valid'); if (parsed.status !== 'valid') throw Error(parsed.message)
  const root = parsed.note.content.content![0]!
  expect(root.type).toBe(kind === 'bulletList' ? 'taskList' : kind)
  if (kind !== 'table') expect(root.content![0]).toMatchObject({ type: 'taskItem', attrs: { blockId: 'item-1', checked: true }, content: [{ attrs: { blockId: 'item-body-1' } }] })
  const movedId = kind === 'table' ? 'cell-body' : 'item-body-1'
  expect(shared.document.noteProvenance?.blocks[movedId]).toMatchObject({ created: { actor: author }, lastEdited: { actor: author } })
  expect(await f.port.undoShare(await removal(f), { actor: person })).toMatchObject({ status: 'committed', collections: [{ deletion: { result: { status: 'deleted' } } }] })
  expect(await readFile(join(f.directory, f.source.path), 'utf8')).toBe(f.original)
  expect(await readdir(f.directory)).not.toContain('block-shared.note.md')
  const restored = await f.writer.read(f.workspace, f.source.path)
  if (restored.status !== 'read') throw Error('Restored original must read')
  expect(restored.document.noteProvenance?.blocks[movedId]?.created?.actor).toEqual(author)
})
it.each(['taskList', 'table'] as const)('rejects an explicit inner %s paragraph without widening its public target or certifying old unknown effects', async kind => {
  const f = await richSharingFixture(kind), sourceBlockId = kind === 'table' ? 'cell-body' : 'item-body-1'
  f.params.promotions[0]!.sourceBlockId = sourceBlockId
  const write = vi.spyOn(f.files, 'write'), result = await f.port.share(f.params, { actor: person })
  expect(result).toMatchObject({ status: 'error', code: 'NOTE_SHARE_RANGE_UNSUPPORTED', destination: null, promotions: [{ shared: null, source: null }] })
  expect(write).not.toHaveBeenCalled(); expect(await readFile(join(f.directory, f.source.path), 'utf8')).toBe(f.original)
  expect(await readdir(f.directory)).not.toContain('block-shared.note.md')
  expect(f.params.promotions[0]!.sourceBlockId).toBe(sourceBlockId)
  expect(await f.port.inspectShare({ mode: 'request', request: f.params })).toMatchObject({ mode: 'request', result: { status: 'unknown', code: 'NOTE_SHARE_INSPECTION' } })
  expect(write).not.toHaveBeenCalled()
})
it.each(['taskList', 'table'] as const)('uses the executable shared CLI for a checked task or whole table (%s), including inspect, undo and exact invalid target rejection', async kind => {
  const f = await richSharingFixture(kind), server = new AgentMuxControlServer({ socketPath: join(f.root, 'rich-control.sock'), files: f.port, coreClients: () => [] })
  await server.start(); dispose.push(() => server.stop())
  const environment = objectCliEnvironment(f.root, { AGENTMUX_RPC_ENDPOINT: 'unix:' + server.path })
  const cli = async (args: string[], input: unknown) => runCompiledObjectCli(args, environment, JSON.stringify(input))
  const bad = structuredClone(f.params); bad.promotions[0]!.sourceBlockId = kind === 'table' ? 'cell-body' : 'item-body-1'
  const rejected = await cli(['file', 'share', '--input', '-'], bad)
  expect(rejected.code).not.toBe(0); expect(rejected.stdout + rejected.stderr).toContain('NOTE_SHARE_RANGE_UNSUPPORTED')
  expect(await readFile(join(f.directory, f.source.path), 'utf8')).toBe(f.original)
  const saved = await cli(['file', 'share', '--input', '-'], f.params)
  expect(saved.code, saved.stderr + saved.stdout).toBe(0); expect(parseFileShareResult(JSON.parse(saved.stdout).result, f.params).status).toBe('committed')
  const inspected = await cli(['file', 'share', 'inspect', '--input', '-'], { mode: 'request', request: f.params })
  expect(inspected.code, inspected.stderr + inspected.stdout).toBe(0); expect(JSON.parse(inspected.stdout).result.result.status).toBe('committed')
  const undone = await cli(['file', 'share', 'undo', '--input', '-'], await removal(f))
  expect(undone.code, undone.stderr + undone.stdout).toBe(0); expect(JSON.parse(undone.stdout).result.status).toBe('committed')
  expect(await readFile(join(f.directory, f.source.path), 'utf8')).toBe(f.original)
}, 15_000)
it('groups different staged blocks from one source into one source write without creating duplicate entities for their repeated uses', async () => {
  const f = await fixture(), note = readNoteDocument(f.params.destination.content); if (note.status !== 'valid') throw Error('Destination must parse')
  note.note.content.content!.push({ type: 'noteInclude', attrs: { blockId: 'second-source-use', referenceId: 'other-source-ref', noteId: 'other-shared', path: 'other-block.note.md' } })
  f.params.destination.content = serializeNoteDocument(note.note)
  f.params.promotions.push({ ...f.params.promotions[0]!, operationId: 'promote-other', sourceBlockId: 'untouched', referenceId: 'other-source-ref', shared: { ...f.params.promotions[0]!.shared, noteId: 'other-shared', path: 'other-block.note.md', expectedResource: { ...f.source.expectedResource, path: 'other-block.note.md' } } })
  const writes = vi.spyOn(f.files, 'write'), result = await f.port.share(f.params, { actor: person })
  expect(result.status, JSON.stringify(result)).toBe('committed'); expect(parseFileShareResult(result, f.params)).toBe(result)
  expect(writes.mock.calls.filter(([, input]) => input.path === f.source.path)).toHaveLength(1)
  expect(result.promotions[0]!.source).toEqual(result.promotions[1]!.source)
  expect(readNoteDocument(await readFile(join(f.directory, f.source.path), 'utf8'))).toMatchObject({ status: 'valid', note: { content: { content: [{ type: 'noteInclude', attrs: { noteId: 'shared-note' } }, { type: 'noteInclude', attrs: { noteId: 'other-shared' } }] } } })
})

it('lets an authenticated Agent inspect a human shared-save operation without allowing it to replay the human write', async () => {
  const f = await fixture(), h = await rpcOwnerFixture(['observer-agent']); dispose.push(() => h.close())
  const service = new AgentMuxRpcService({ files: f.port, coreClients: h.coreClients }); dispose.push(async () => { service.dispose() })
  expect((await service.call('file.share', f.params, { principal: person })).status).toBe('committed')
  const writes = vi.spyOn(f.files, 'write'), inspected = await service.call('file.share.inspect', { mode: 'request', request: f.params }, { caller: h.credentials })
  expect(inspected).toMatchObject({ mode: 'request', result: { status: 'committed', promotions: [{ shared: { result: { noteHistory: { replayed: true } } }, currentShared: { result: { status: 'read' } } }] } })
  expect((await service.call('file.share', f.params, { caller: h.credentials }))).toMatchObject({ status: 'error', code: 'NOTE_SHARE_OPERATION_CONFLICT' })
  expect(writes).not.toHaveBeenCalled()
})

it('inspects shared Markdown stages from only a discovered File read target and rejects a forged origin without replaying', async () => {
  const f = await fixture(); expect((await f.port.share(f.params, { actor: person })).status).toBe('committed')
  const socketPath = join(f.root, 'inspect.sock'), server = new AgentMuxControlServer({ socketPath, files: f.port, coreClients: () => [] }); await server.start(); dispose.push(() => server.stop())
  const environment = objectCliEnvironment(f.root, { AGENTMUX_RPC_ENDPOINT: 'unix:' + server.path })
  const read = await runCompiledObjectCli(['file', 'read', '--zone', 'zone', '--path', 'block-shared.note.md', '--host', 'local', '--workspace', f.workspace.id, '--workspace-path', f.directory], environment)
  expect(read.code, read.stdout + read.stderr).toBe(0)
  const discovered = JSON.parse(read.stdout).result
  expect(discovered.result.status).toBe('read')
  // No original batch request, source snapshot or caller-supplied excerpt is available here.
  const target = { mode: 'shared', shared: { zoneId: 'zone', path: 'block-shared.note.md', expectedResource: { hostId: discovered.resource.hostId, workspaceId: discovered.resource.workspaceId, workspacePath: discovered.resource.workspacePath } } }
  const writes = vi.spyOn(f.files, 'write'), inspected = await runCompiledObjectCli(['file', 'share', 'inspect', '--input', '-'], environment, JSON.stringify(target))
  expect(inspected.code, inspected.stdout + inspected.stderr).toBe(0)
  expect(JSON.parse(inspected.stdout).result).toMatchObject({ mode: 'shared', declaration: { status: 'confirmed', noteId: 'shared-note' }, create: { status: 'read', event: { eventId: 'promote-original:create', status: 'committed' } }, source: { status: 'read', event: { noteId: 'source-note', status: 'committed' } }, destination: { status: 'read', event: { eventId: 'destination-save', status: 'committed' } }, batch: { status: 'unknown' } })
  const path = join(f.directory, 'block-shared.note.md'), original = await readFile(path, 'utf8')
  await writeFile(path, original.replace('sourceOperationId:', 'sourceOperationId: forged-event #'))
  const forged = await runCompiledObjectCli(['file', 'share', 'inspect', '--input', '-'], environment, JSON.stringify(target))
  expect(forged.code).toBe(1); expect(JSON.parse(forged.stdout).result).toMatchObject({ mode: 'shared', declaration: { status: 'unconfirmed' }, source: { status: 'unknown' }, current: { result: { status: 'read' } } })
  expect(writes).not.toHaveBeenCalled()
})

it('shares an unregistered project Note into another Workspace through two original Zone resources', async () => {
  const f = await fixture(), recallDirectory = join(f.root, 'recall'); await mkdir(recallDirectory)
  const recall: WorkspaceRecord = { id: 'recall', hostId: 'local', name: 'Recall', kind: 'folder', path: recallDirectory }; f.workspaces.push(recall)
  expect((await f.metadata.read()).pages['source-note']).toBeUndefined()
  const base = serializeNoteDocument(newNoteDocument('Recall consumer', 'recall-note', 'recall-body'))
  const created = await f.writer.write(recall, { path: 'recall.note.md', content: base, expectedRevision: null }, { actor: person }); if (created.status !== 'written') throw Error('Recall original must save')
  const canonical = await readFile(join(recallDirectory, 'recall.note.md'), 'utf8'), note = readNoteDocument(canonical); if (note.status !== 'valid') throw Error('Recall must parse')
  note.note.content.content!.push({ ...f.include(), attrs: { ...f.include().attrs, workspaceId: f.workspace.id } })
  f.params.destination = { zoneId: 'zone-recall', path: 'recall.note.md', expectedResource: { hostId: 'local', workspaceId: recall.id, workspacePath: recallDirectory, zoneId: 'zone-recall', zonePath: recallDirectory, path: 'recall.note.md' }, content: serializeNoteDocument(note.note), baseContent: canonical, expectedRevision: created.revision, operationId: 'recall-save' }
  const result = await f.port.share(f.params, { actor: person })
  expect(result.status, JSON.stringify(result)).toBe('committed')
  expect(parseFileShareResult(result, f.params)).toBe(result)
  expect(result.destination!.resource!.workspaceId).toBe(recall.id)
  expect(result.promotions[0]!.shared!.resource!.workspaceId).toBe(f.workspace.id)
  expect(readNoteDocument(await readFile(join(recallDirectory, 'recall.note.md'), 'utf8'))).toMatchObject({ status: 'valid', note: { content: { content: [{ type: 'paragraph' }, { type: 'noteInclude', attrs: { noteId: 'shared-note', workspaceId: f.workspace.id } }] } } })
  expect(await readdir(recallDirectory)).toEqual(['recall.note.md'])
})
it('shared-only CLI inspection reports the confirmed entity and missing later stages as partial after owner interruption', async () => {
  const f = await fixture(), interrupted = f.makeOwner(async stage => { if (stage === 'shared') throw Error('Exit after created Markdown') })
  expect((await interrupted.share(f.params, { actor: person })).status).toBe('unknown')
  const socketPath = join(f.root, 'partial.sock'), server = new AgentMuxControlServer({ socketPath, files: f.port, coreClients: () => [] }); await server.start(); dispose.push(() => server.stop())
  const inspected = await runCompiledObjectCli(['file', 'share', 'inspect', '--input', '-'], objectCliEnvironment(f.root, { AGENTMUX_RPC_ENDPOINT: 'unix:' + server.path }), JSON.stringify({ mode: 'shared', shared: { zoneId: 'zone', path: 'block-shared.note.md', expectedResource: { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.directory } } }))
  expect(inspected.code, inspected.stdout + inspected.stderr).toBe(1)
  expect(inspected.stdout, inspected.stderr).not.toBe('')
  expect(JSON.parse(inspected.stdout).result).toMatchObject({ mode: 'shared', declaration: { status: 'confirmed' }, create: { status: 'read', event: { status: 'committed' } }, source: { status: 'missing' }, destination: { status: 'missing' }, batch: { status: 'unknown' } })
  expect(await readFile(join(f.directory, f.source.path), 'utf8')).toBe(f.source.content)
})
it('continues an explicitly requested interrupted save through compiled CLI while unknown inspection never replays a phase', async () => {
  const f = await fixture(), interrupted = f.makeOwner(async stage => { if (stage === 'shared') throw Error('Interrupted after created-file receipt') })
  vi.spyOn(f.port, 'share').mockImplementationOnce((params, context) => interrupted.share(params, context))
  const socketPath = join(f.root, 'continue.sock'), server = new AgentMuxControlServer({ socketPath, files: f.port, coreClients: () => [] }); await server.start(); dispose.push(() => server.stop())
  const environment = objectCliEnvironment(f.root, { AGENTMUX_RPC_ENDPOINT: 'unix:' + server.path }), original = JSON.stringify(f.params)
  const first = await runCompiledObjectCli(['file', 'share', '--input', '-'], environment, original)
  expect(first.code, first.stdout + first.stderr).toBe(1); expect(first.stdout, first.stderr).not.toBe(''); expect(JSON.parse(first.stdout).result).toMatchObject({ status: 'unknown', destination: null, promotions: [{ shared: { result: { status: 'written' } }, source: null }] })
  const writes = vi.spyOn(f.files, 'write')
  const inspected = await runCompiledObjectCli(['file', 'share', 'inspect', '--input', '-'], environment, JSON.stringify({ mode: 'request', request: f.params }))
  expect(inspected.code).toBe(1); expect(JSON.parse(inspected.stdout).result).toMatchObject({ mode: 'request', result: { status: 'unknown' } }); expect(writes).not.toHaveBeenCalled()
  // This new invocation is the explicit Continue action, with the same payload and business IDs.
  const continued = await runCompiledObjectCli(['file', 'share', '--input', '-'], environment, original)
  expect(continued.code, continued.stdout + continued.stderr).toBe(0); expect(JSON.parse(continued.stdout).result).toMatchObject({ status: 'committed', promotions: [{ shared: { result: { noteHistory: { replayed: true } } } }] })
  expect(writes.mock.calls.some(([, input]) => input.path === 'block-shared.note.md')).toBe(false)
  expect(writes.mock.calls.map(([, input]) => input.path).sort()).toEqual(['destination.note.md', 'source.note.md'])
})

async function removal(f: Awaited<ReturnType<typeof fixture>>, referenceIds = ['paste-reference'], extra?: (note: import('../src/shared/note-document').NoteDocument) => void) {
  const baseContent = await readFile(join(f.directory, f.destination.path), 'utf8'), parsed = readNoteDocument(baseContent)
  if (parsed.status !== 'valid') throw Error('Fixture destination must parse')
  const remove = (node: typeof parsed.note.content) => { if (node.content) node.content = node.content.filter(child => !(child.type === 'noteInclude' && referenceIds.includes(String(child.attrs?.referenceId)))); node.content?.forEach(remove) }
  remove(parsed.note.content); extra?.(parsed.note)
  return { destination: { ...f.destination, content: serializeNoteDocument(parsed.note), baseContent, expectedRevision: noteHistoryRevision(baseContent), operationId: 'saved-shared-undo' }, referenceIds }
}
it('saves an exact undo draft through compiled public CLI, restores trusted original content and collects only its unchanged unreferenced Markdown', async () => {
  const f = await fixture(); expect((await f.port.share(f.params, { actor: person })).status).toBe('committed')
  const params = await removal(f, undefined, note => { note.content.content!.push({type:'paragraph',attrs:{blockId:'ordinary-new'},content:[{type:'text',text:'Keep ordinary text in this same undo save'}]}) })
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'undo.sock'), files: f.port, coreClients: () => [] }); await server.start(); dispose.push(() => server.stop())
  const result = await runCompiledObjectCli(['file','share','undo','--input','-'], objectCliEnvironment(f.root,{AGENTMUX_RPC_ENDPOINT:'unix:'+server.path}),JSON.stringify(params))
  expect(result.code, result.stdout + result.stderr).toBe(0)
  expect(JSON.parse(result.stdout).result).toMatchObject({status:'committed',collections:[{noteId:'shared-note',deletion:{result:{status:'deleted',noteHistory:{status:'committed'}}}}]})
  const source = await f.writer.read(f.workspace,'source.note.md'); expect(source).toMatchObject({status:'read'}); if(source.status==='read'){ expect(source.document.content).toContain('One original knowledge source'); expect(source.document.content).not.toContain('::note-include'); expect(source.document.noteProvenance?.blocks['source-block']?.created?.actor).toEqual(author) }
  await expect(readFile(join(f.directory,'block-shared.note.md'),'utf8')).rejects.toMatchObject({code:'ENOENT'})
  expect(await readFile(join(f.directory,'destination.note.md'),'utf8')).toContain('Keep ordinary text in this same undo save')
  const inspected = await f.port.inspectShare({mode:'undo',request:params},{actor:{kind:'agent',id:'another-reader'}})
  expect(inspected).toMatchObject({mode:'undo',result:{status:'committed',collections:[{deletion:{result:{status:'deleted'}}}]}})
})
it('removes one saved occurrence while a second occurrence or a new bound link still retains the shared original', async () => {
  const f=await fixture(), draft=readNoteDocument(f.params.destination.content);if(draft.status!=='valid')throw Error('fixture')
  draft.note.content.content!.push(f.include('second-reference','second-block'));f.params.destination.content=serializeNoteDocument(draft.note)
  expect((await f.port.share(f.params,{actor:person})).status).toBe('committed')
  const result=await f.port.undoShare(await removal(f),{actor:person})
  expect(result).toMatchObject({status:'committed',collections:[{retainedReason:{code:'other-references'},deletion:null}]})
  expect(await readFile(join(f.directory,'block-shared.note.md'),'utf8')).toContain('One original knowledge source')
  const g=await fixture();await g.port.share(g.params,{actor:person})
  const linked=await removal(g,undefined,n=>n.content.content!.push({type:'blockReference',attrs:{blockId:'new-ref-block',referenceId:'new-link',target:{noteId:'shared-note',blockId:'source-block'},mode:'reference'}}))
  expect(await g.port.undoShare(linked,{actor:person})).toMatchObject({status:'committed',collections:[{retainedReason:{code:'other-references'}}]})
})
it('preserves shared Markdown after a later ABA body edit or a locally dirty shared draft', async () => {
  const f=await fixture();await f.port.share(f.params,{actor:person});const path=join(f.directory,'block-shared.note.md'), original=await readFile(path,'utf8')
  const saved=await f.writer.write(f.workspace,{path:'block-shared.note.md',expectedRevision:noteHistoryRevision(original),content:original.replace('One original knowledge source','Temporary edit')},{actor:person});if(saved.status!=='written')throw Error('fixture')
  await f.writer.write(f.workspace,{path:'block-shared.note.md',expectedRevision:saved.revision,content:original},{actor:person})
  expect(await f.port.undoShare(await removal(f),{actor:person})).toMatchObject({status:'committed',collections:[{retainedReason:{code:'later-edit'}}]})
  const g=await fixture();await g.port.share(g.params,{actor:person});expect(await g.port.undoShare({...await removal(g),preserveNoteIds:['shared-note']},{actor:person})).toMatchObject({status:'committed',collections:[{retainedReason:{code:'dirty-draft'}}]})
})

it.each(['destination','source'] as const)('recovers the same original undo after the %s stage without hiding committed per-file receipts or repeating its save', async stage => {
  const f=await fixture();await f.port.share(f.params,{actor:person});const params=await removal(f)
  const owner=f.makeUndo(async current=>{if(current===stage)throw Error('interrupted exact undo stage')})
  const first=await owner.apply(params,{actor:person});expect(first.status).toBe('unknown');expect(first.destination?.result.noteHistory?.status).toBe('committed')
  if(stage==='source')expect(first.collections[0]?.source?.result.noteHistory?.status).toBe('committed')
  const inspected=await f.port.inspectShare({mode:'undo',request:params},{actor:{kind:'agent',id:'other-inspector'}});expect(inspected).toMatchObject({mode:'undo',result:{status:'unknown',destination:{result:{noteHistory:{replayed:true}}}}})
  const resumed=await f.port.undoShare(params,{actor:person});expect(resumed).toMatchObject({status:'committed',collections:[{deletion:{result:{status:'deleted'}}}]})
})
it('preserves a later nonconflicting source edit made after destination save and reports a later visible reference as a real partial restoration', async () => {
  const f=await fixture();await f.port.share(f.params,{actor:person});const params=await removal(f)
  const owner=f.makeUndo(async stage=>{if(stage==='destination'){const path=join(f.directory,'source.note.md');const content=await readFile(path,'utf8');await writeFile(path,content+'\nA later unrelated source paragraph.\n')}})
  expect(await owner.apply(params,{actor:person})).toMatchObject({status:'committed',collections:[{retainedReason:{code:'scope-changed'},source:null}]})
  expect(await readFile(join(f.directory,'source.note.md'),'utf8')).toContain('A later unrelated source paragraph.')
  const g=await fixture();await g.port.share(g.params,{actor:person});const input=await removal(g)
  const raced=g.makeUndo(async stage=>{if(stage==='source'){const path=join(g.directory,'destination.note.md'), parsed=readNoteDocument(await readFile(path,'utf8'));if(parsed.status!=='valid')throw Error('fixture');parsed.note.content.content!.push(g.include('visible-late-use','visible-late-block'));await writeFile(path,serializeNoteDocument(parsed.note))}})
  const result=await raced.apply(input,{actor:person});expect(result).toMatchObject({status:'partial',collections:[{source:{result:{noteHistory:{status:'committed'}}},retainedReason:{code:'scope-changed'}}]})
  const checked=await g.port.inspectShare({mode:'undo',request:input},{actor:person});expect(checked).toMatchObject({mode:'undo',result:{status:'partial',collections:[{source:{result:{noteHistory:{status:'committed',replayed:true}}},retainedReason:{code:'other-references'}}]}})
})
it('does not reissue a deletion after its real native effect loses the original receipt and exposes the prepared claim candidate', async () => {
  const f=await fixture();await f.port.share(f.params,{actor:person});const params=await removal(f), original=f.files.deleteExact.bind(f.files)
  const call=vi.spyOn(f.files,'deleteExact').mockImplementation(async(...args)=>{const outcome=await original(...args);expect(outcome.status).toBe('deleted');throw Error('lost exact deletion reply')})
  const first=await f.port.undoShare(params,{actor:person});expect(first).toMatchObject({status:'unknown',collections:[{deletion:{result:{status:'unknown',retainedPath:expect.stringContaining('.agentmux-reclaim-'),noteHistory:{status:'unconfirmed'}}}}]})
  const checked=await f.port.inspectShare({mode:'undo',request:params},{actor:person});expect(checked).toMatchObject({mode:'undo',result:{status:'unknown',collections:[{deletion:{result:{status:'unknown',retainedPath:expect.stringContaining('.agentmux-reclaim-'),noteHistory:{status:'prepared'}}}}]}})
  expect(await f.port.undoShare(params,{actor:person})).toMatchObject({status:'unknown'});expect(call).toHaveBeenCalledTimes(1)
  const server=new AgentMuxControlServer({socketPath:join(f.root,'unknown.sock'),files:f.port,coreClients:()=>[]});await server.start();dispose.push(()=>server.stop());const response=await runCompiledObjectCli(['file','share','inspect','--input','-'],objectCliEnvironment(f.root,{AGENTMUX_RPC_ENDPOINT:'unix:'+server.path}),JSON.stringify({mode:'undo',request:params}));expect(response.code).toBe(1);expect(JSON.parse(response.stdout)).toMatchObject({ok:true,result:{mode:'undo',result:{status:'unknown',collections:[{deletion:{result:{status:'unknown',noteHistory:{status:'prepared'}}}}]}}});expect(call).toHaveBeenCalledTimes(1)
})
it('retains current shared knowledge if another physical Note changes between its original read and scope stat', async () => {
  const f=await fixture();await f.port.share(f.params,{actor:person});const other=newNoteDocument('Before external link','other-note','other-block'),path=join(f.directory,'other.note.md');await writeFile(path,serializeNoteDocument(other))
  const real=f.files.read.bind(f.files);let injected=false
  vi.spyOn(f.files,'read').mockImplementation(async(owner,p,opts)=>{const read=await real(owner,p,opts);if(p==='other.note.md'&&!injected){injected=true;other.content.content!.push(f.include('external-use','external-block'));await writeFile(path,serializeNoteDocument(other))}return read})
  expect(await f.port.undoShare(await removal(f),{actor:person})).toMatchObject({status:'committed',collections:[{retainedReason:{code:'scope-unconfirmed'}}]})
  expect(await readFile(join(f.directory,'block-shared.note.md'),'utf8')).toContain('One original knowledge source')
})
it('uses the same whole-save owner when one draft removes an old shared use and pastes a different new block', async () => {
  const f=await fixture();await f.port.share(f.params,{actor:person});const removalRequest=await removal(f)
  const sourceBody=await readFile(join(f.directory,'source.note.md'),'utf8'),draft=readNoteDocument(removalRequest.destination.content);if(draft.status!=='valid')throw Error('fixture')
  draft.note.content.content!.push({type:'noteInclude',attrs:{blockId:'new-paste-block',referenceId:'new-paste-ref',noteId:'new-shared-note',path:'new-shared.note.md'}})
  const combined:FileShareParams={operationId:'combined-save',destination:{...removalRequest.destination,content:serializeNoteDocument(draft.note)},undoReferenceIds:removalRequest.referenceIds,promotions:[{...f.params.promotions[0]!,operationId:'promote-other-existing-block',source:{...f.source,baseContent:sourceBody,content:sourceBody,expectedRevision:noteHistoryRevision(sourceBody)},sourceBlockId:'untouched',referenceId:'new-paste-ref',shared:{...f.params.promotions[0]!.shared,noteId:'new-shared-note',path:'new-shared.note.md',expectedResource:{...f.source.expectedResource,path:'new-shared.note.md'}}}]}
  const result=await f.port.share(combined,{actor:person});expect(result).toMatchObject({status:'committed',undo:{status:'committed',collections:[{deletion:{result:{status:'deleted'}}}]}})
  expect(parseFileShareResult(result,combined).status).toBe('committed');expect(await readFile(join(f.directory,'destination.note.md'),'utf8')).toContain('new%2Dshared%2Dnote');await expect(readFile(join(f.directory,'block-shared.note.md'),'utf8')).rejects.toMatchObject({code:'ENOENT'})
})
it('keeps ordinary public text creation valid while its internal native creation witness stays private', async () => {
  const f=await fixture(), server=new AgentMuxControlServer({socketPath:join(f.root,'plain.sock'),files:f.port,coreClients:()=>[]});await server.start();dispose.push(()=>server.stop())
  const resource={...f.source.expectedResource,path:'ordinary.txt'},created=await runCompiledObjectCli(['file','create','--input','-'],objectCliEnvironment(f.root,{AGENTMUX_RPC_ENDPOINT:'unix:'+server.path}),JSON.stringify({zoneId:'zone',path:'ordinary.txt',expectedResource:resource,expectedRevision:null,content:'ordinary text'}))
  expect(created.code,created.stdout+created.stderr).toBe(0);expect(JSON.parse(created.stdout).result.result).toMatchObject({status:'written'});expect(created.stdout).not.toContain('fileWitness');expect(await readFile(join(f.directory,'ordinary.txt'),'utf8')).toBe('ordinary text')
})

it('restores multiple removed blocks from one source with one real source save and collects both original files', async () => {
  const f=await fixture(),draft=readNoteDocument(f.params.destination.content);if(draft.status!=='valid')throw Error('fixture')
  draft.note.content.content!.push({type:'noteInclude',attrs:{blockId:'second-source-use',referenceId:'other-source-ref',noteId:'other-shared',path:'other-shared.note.md'}});f.params.destination.content=serializeNoteDocument(draft.note)
  f.params.promotions.push({...f.params.promotions[0]!,operationId:'promote-other',sourceBlockId:'untouched',referenceId:'other-source-ref',shared:{...f.params.promotions[0]!.shared,noteId:'other-shared',path:'other-shared.note.md',expectedResource:{...f.source.expectedResource,path:'other-shared.note.md'}}})
  await f.port.share(f.params,{actor:person});const write=vi.spyOn(f.files,'write'),params=await removal(f,['paste-reference','other-source-ref'])
  expect(await f.port.undoShare(params,{actor:person})).toMatchObject({status:'committed',collections:[{deletion:{result:{status:'deleted'}}},{deletion:{result:{status:'deleted'}}}]})
  expect(write.mock.calls.filter(([,input])=>input.path==='source.note.md')).toHaveLength(1)
  const body=await readFile(join(f.directory,'source.note.md'),'utf8');expect(body).toContain('One original knowledge source');expect(body).toContain('Keep this outside');expect(body).not.toContain('::note-include')
})
it('uses one final host write for source equals destination and retains original block addresses', async () => {
  const f=await fixture(),draft=readNoteDocument(f.source.content);if(draft.status!=='valid')throw Error('fixture');draft.note.content.content!.push(f.include());f.params.destination={...f.source,content:serializeNoteDocument(draft.note),operationId:'same-page-share'}
  await f.port.share(f.params,{actor:person});f.destination=f.source
  const write=vi.spyOn(f.files,'write'),params=await removal(f),result=await f.port.undoShare(params,{actor:person})
  expect(result).toMatchObject({status:'committed',collections:[{deletion:{result:{status:'deleted'}}}]});expect(write.mock.calls.filter(([,input])=>input.path==='source.note.md')).toHaveLength(1)
  expect(await readFile(join(f.directory,'source.note.md'),'utf8')).toContain('One original knowledge source')
})
it.each(['hidden','cross-workspace','nested-shared'] as const)('retains an original with an unregistered %s physical reference', async kind => {
  const f=await fixture();await f.port.share(f.params,{actor:person});const other=newNoteDocument('An unregistered dependent','outside-catalog','outside-content');other.content.content!.push(f.include('outside-use','outside-include'))
  let path:string
  if(kind==='hidden'){await mkdir(join(f.directory,'.hidden'));path=join(f.directory,'.hidden','archived.note.md')}
  else if(kind==='cross-workspace'){const dir=join(f.root,'recall');await mkdir(dir);f.workspaces.push({...f.workspace,id:'recall',path:dir});path=join(dir,'uncatalogued.note.md')}
  else{other.kind='shared-block';path=join(f.directory,'another-shared.note.md')}
  await writeFile(path,serializeNoteDocument(other));expect(await f.port.undoShare(await removal(f),{actor:person})).toMatchObject({status:'committed',collections:[{retainedReason:{code:'other-references'}}]})
}, 20_000)
it('does not take away exact draft saving when optional collection history becomes unavailable', async () => {
  const f=await fixture();await f.port.share(f.params,{actor:person});const params=await removal(f,undefined,n=>n.content.content!.push({type:'paragraph',attrs:{blockId:'normal-save'},content:[{type:'text',text:'Ordinary edits stay available'}]}))
  const read=f.metadata.readHistory.bind(f.metadata);vi.spyOn(f.metadata,'readHistory').mockImplementation(async query=>{if(query.noteId==='shared-note')throw Error('optional shared history unavailable');return read(query)})
  const result=await f.port.undoShare(params,{actor:person});expect(result).toMatchObject({status:'committed',collections:[{retainedReason:{code:'collection-unconfirmed'}}]});expect(await readFile(join(f.directory,'destination.note.md'),'utf8')).toContain('Ordinary edits stay available')
})
it('refuses an occurrence still present in the proposed save without deleting or changing another selected target', async () => {
  const f=await fixture();await f.port.share(f.params,{actor:person});const params=await removal(f);params.destination.content=params.destination.baseContent!
  expect(await f.port.undoShare(params,{actor:person})).toMatchObject({status:'error',destination:null,code:'NOTE_SHARE_UNDO_OCCURRENCE'})
  expect(await readFile(join(f.directory,'destination.note.md'),'utf8')).toContain('paste%2Dreference')
})

it('retains an externally changed ABA generation and an old entity whose original creation never had a native witness', async () => {
  const f=await fixture();await f.port.share(f.params,{actor:person});const path=join(f.directory,'block-shared.note.md'),content=await readFile(path,'utf8');await writeFile(path,content+'\nChanged\n');await writeFile(path,content)
  expect(await f.port.undoShare(await removal(f),{actor:person})).toMatchObject({status:'committed',collections:[{retainedReason:{code:'later-edit'}}]})
  const g=await fixture(),raw=g.files.write.bind(g.files);vi.spyOn(g.files,'write').mockImplementation(async(owner,input)=>{const result=await raw(owner,input);if(input.path==='block-shared.note.md'&&result.status==='written'){const{fileWitness:_old,...legacy}=result;return legacy}return result})
  await g.port.share(g.params,{actor:person});expect(await g.port.undoShare(await removal(g),{actor:person})).toMatchObject({status:'committed',collections:[{retainedReason:{code:'later-edit'}}]})
})
it('returns the real destination not-applied conflict through CLI and inspect, then permits an explicit newly based save', async () => {
  const f=await fixture();await f.port.share(f.params,{actor:person});const params=await removal(f),raw=f.files.write.bind(f.files);let raced=false
  vi.spyOn(f.files,'write').mockImplementation(async(owner,input)=>{if(input.path==='destination.note.md'&&!raced){raced=true;const path=join(f.directory,input.path);await writeFile(path,(await readFile(path,'utf8'))+'\nPreserve this external change.\n')}return raw(owner,input)})
  const server=new AgentMuxControlServer({socketPath:join(f.root,'conflict.sock'),files:f.port,coreClients:()=>[]});await server.start();dispose.push(()=>server.stop());const environment=objectCliEnvironment(f.root,{AGENTMUX_RPC_ENDPOINT:'unix:'+server.path})
  const result=await runCompiledObjectCli(['file','share','undo','--input','-'],environment,JSON.stringify(params));expect(result.code).toBe(1);expect(JSON.parse(result.stdout)).toMatchObject({ok:true,result:{status:'conflict',destination:{result:{status:'conflict',noteHistory:{status:'not-applied'}}}}})
  const checked=await runCompiledObjectCli(['file','share','inspect','--input','-'],environment,JSON.stringify({mode:'undo',request:params}));expect(checked.code).toBe(1);expect(JSON.parse(checked.stdout)).toMatchObject({ok:true,result:{mode:'undo',result:{status:'conflict',destination:{result:{noteHistory:{status:'not-applied'}}}}}})
  const next=await removal(f);next.destination.operationId='explicit-conflict-resolution';expect(await f.port.undoShare(next,{actor:person})).toMatchObject({status:'committed'});expect(await readFile(join(f.directory,'destination.note.md'),'utf8')).toContain('Preserve this external change.')
},20_000)
it('keeps a later same-byte save hidden behind a not-applied tail from regaining collection eligibility',async()=>{
  const f=await fixture();await f.port.share(f.params,{actor:person});const path='block-shared.note.md',body=await readFile(join(f.directory,path),'utf8'),revision=noteHistoryRevision(body)
  await f.writer.write(f.workspace,{path,content:body,expectedRevision:revision},{actor:person})
  await f.metadata.recordHistory({eventId:'later-rejected',sequence:0,batchId:'later-rejected',noteId:'shared-note',resource:{hostId:'local',workspaceId:f.workspace.id,workspacePath:f.workspace.path,path},originalResource:{hostId:'local',workspaceId:f.workspace.id,workspacePath:f.workspace.path,path},status:'not-applied',at:Date.now(),actor:person,operation:'edit',requestFingerprint:'rejected-later-intent',parentEventId:null,baseRevision:revision,beforeContent:body,revision,content:body})
  expect(await f.port.undoShare(await removal(f),{actor:person})).toMatchObject({status:'committed',collections:[{retainedReason:{code:'later-edit'}}]})
})

it('saves a combined new promotion and ordinary draft when old occurrence history is unavailable, then inspects the same original save', async () => {
  const f=await fixture();await f.port.share(f.params,{actor:person});const removalRequest=await removal(f,undefined,n=>n.content.content!.push({type:'paragraph',attrs:{blockId:'ordinary-combined'},content:[{type:'text',text:'Keep the complete ordinary combined draft'}]}))
  const sourceBody=await readFile(join(f.directory,'source.note.md'),'utf8'),draft=readNoteDocument(removalRequest.destination.content);if(draft.status!=='valid')throw Error('fixture')
  draft.note.content.content!.push({type:'noteInclude',attrs:{blockId:'new-paste-block',referenceId:'new-paste-ref',noteId:'new-shared-note',path:'new-shared.note.md'}})
  const combined:FileShareParams={operationId:'combined-save-without-old-history',destination:{...removalRequest.destination,content:serializeNoteDocument(draft.note)},undoReferenceIds:removalRequest.referenceIds,promotions:[{...f.params.promotions[0]!,operationId:'promote-without-old-history',source:{...f.source,baseContent:sourceBody,content:sourceBody,expectedRevision:noteHistoryRevision(sourceBody)},sourceBlockId:'untouched',referenceId:'new-paste-ref',shared:{...f.params.promotions[0]!.shared,noteId:'new-shared-note',path:'new-shared.note.md',expectedResource:{...f.source.expectedResource,path:'new-shared.note.md'}}}]}
  const read=f.metadata.readHistory.bind(f.metadata);vi.spyOn(f.metadata,'readHistory').mockImplementation(async q=>q.noteId==='destination-note'?{status:'read',noteId:q.noteId,resource:q.resource,entries:[],batches:[],hasMore:false}:read(q))
  const result=await f.port.share(combined,{actor:person});expect(result).toMatchObject({status:'committed',undo:{status:'committed',collections:[{retainedReason:{code:'history-unconfirmed'}}]}})
  expect(parseFileShareResult(result,combined).status).toBe('committed');expect(await readFile(join(f.directory,'destination.note.md'),'utf8')).toContain('Keep the complete ordinary combined draft');expect(await readFile(join(f.directory,'new-shared.note.md'),'utf8')).toContain('Keep this outside');expect(await readFile(join(f.directory,'block-shared.note.md'),'utf8')).toContain('One original knowledge source')
  const checked=await f.port.inspectShare({mode:'request',request:combined},{actor:{kind:'agent',id:'read-only-inspector'}});expect(checked).toMatchObject({mode:'request',result:{status:'committed',destination:{result:{noteHistory:{replayed:true}}}}})
})
it('keeps the original source include when a visible dependency is added after destination save and before source restoration',async()=>{
 const f=await fixture();await f.port.share(f.params,{actor:person});const params=await removal(f),owner=f.makeUndo(async stage=>{if(stage==='destination'){const path=join(f.directory,'destination.note.md'),parsed=readNoteDocument(await readFile(path,'utf8'));if(parsed.status!=='valid')throw Error('fixture');parsed.note.content.content!.push(f.include('new-late-dependency','new-late-block'));await writeFile(path,serializeNoteDocument(parsed.note))}})
 expect(await owner.apply(params,{actor:person})).toMatchObject({status:'committed',collections:[{source:null,retainedReason:{code:'scope-changed'}}]});expect(await readFile(join(f.directory,'source.note.md'),'utf8')).toContain('::note-include');expect(await readFile(join(f.directory,'block-shared.note.md'),'utf8')).toContain('One original knowledge source')
})

it.each(['source','delete'] as const)('retains shared knowledge when another intent preoccupies the derived %s stage ID',async stage=>{
 const f=await fixture();await f.port.share(f.params,{actor:person});const params=await removal(f),created=await f.metadata.readHistoryOperation('promote-original:create');if(!created||created.operation!=='edit')throw Error('fixture')
 const {provenance:_provenance,...record}=created;const identity=stage==='source'?JSON.stringify(['local',f.workspace.id,f.workspace.path,'source.note.md']):'shared-note',id=fileShareUndoStageOperation(params.destination.operationId!,stage,identity)
 if(stage==='source')await f.metadata.recordHistory({...record,eventId:id,batchId:id,sequence:0,noteId:'source-note',resource:{...created.resource,path:'source.note.md'},originalResource:{...created.resource,path:'source.note.md'},operation:'undo',source:{kind:'shared',eventIds:[created.eventId],referenceIds:['unrelated']},requestFingerprint:'another-original-intent'})
 else await f.metadata.recordHistory({...record,eventId:id,batchId:id,sequence:0,operation:'delete',source:{eventId:created.eventId},baseRevision:created.revision,beforeContent:created.content,revision:null,content:null,requestFingerprint:'another-original-intent'})
 const result=await f.port.undoShare(params,{actor:person});expect(result).toMatchObject({status:'committed',collections:[{source:null,deletion:null,retainedReason:{code:stage==='source'?'source-unconfirmed':'operation-conflict'}}]});expect(await readFile(join(f.directory,'source.note.md'),'utf8')).toContain('::note-include');expect(await readFile(join(f.directory,'block-shared.note.md'),'utf8')).toContain('One original knowledge source')
})
it('restores a quoted shared subtree with original descendant addresses and author after its final saved use is removed',async()=>{
 const f=await fixture(),source=newNoteDocument('','source-note','unused');source.content.content=[{type:'blockquote',attrs:{blockId:'quote-root'},content:[{type:'paragraph',attrs:{blockId:'quote-child'},content:[{type:'text',text:'Quoted original knowledge'}]}]}]
 const saved=await f.writer.write(f.workspace,{path:f.source.path,expectedRevision:f.source.expectedRevision,content:serializeNoteDocument(source)},{actor:author});if(saved.status!=='written')throw Error('fixture');const canonical=await readFile(join(f.directory,f.source.path),'utf8');f.params.promotions[0]!.source={...f.source,baseContent:canonical,content:canonical,expectedRevision:saved.revision};f.params.promotions[0]!.sourceBlockId='quote-root'
 expect(await f.port.share(f.params,{actor:person})).toMatchObject({status:'committed'});expect(await f.port.undoShare(await removal(f),{actor:person})).toMatchObject({status:'committed',collections:[{deletion:{result:{status:'deleted'}}}]})
 expect(readNoteDocument(await readFile(join(f.directory,'source.note.md'),'utf8'))).toMatchObject({status:'valid',note:{content:{content:[{type:'blockquote',attrs:{blockId:'quote-root'},content:[{type:'paragraph',attrs:{blockId:'quote-child'}}]}]}}});expect(await f.writer.read(f.workspace,'source.note.md')).toMatchObject({status:'read',document:{noteProvenance:{blocks:{'quote-child':{created:{actor:author}}}}}})
})

it.each(['preparation-conflict','history-unavailable'] as const)('preserves real %s deletion diagnostics through public CLI and same-request inspection',async mode=>{
 const f=await fixture();await f.port.share(f.params,{actor:person});const params=await removal(f),path=join(f.directory,'block-shared.note.md'),native=vi.spyOn(f.files,'deleteExact')
 if(mode==='preparation-conflict'){const original=f.deletion.delete.bind(f.deletion);vi.spyOn(f.deletion,'delete').mockImplementation(async(owner,input,context)=>{await writeFile(path,(await readFile(path,'utf8'))+'\nA visible newer edit.\n');return original(owner,input,context)})}
 else{const original=f.metadata.recordHistory.bind(f.metadata);vi.spyOn(f.metadata,'recordHistory').mockImplementation(async record=>{if(record.operation==='delete')throw Error('The existing history owner is temporarily unavailable');return original(record)})}
 const server=new AgentMuxControlServer({socketPath:join(f.root,'diagnostic.sock'),files:f.port,coreClients:()=>[]});await server.start();dispose.push(()=>server.stop());const environment=objectCliEnvironment(f.root,{AGENTMUX_RPC_ENDPOINT:'unix:'+server.path}),response=await runCompiledObjectCli(['file','share','undo','--input','-'],environment,JSON.stringify(params));expect(response.code).toBe(1);const value=JSON.parse(response.stdout);expect(value).toMatchObject({ok:true,result:{status:mode==='preparation-conflict'?'partial':'unknown',collections:[{source:{result:{noteHistory:{status:'committed'}}},deletion:{result:{status:mode==='preparation-conflict'?'conflict':'unknown'}}}]}})
 if(mode==='history-unavailable')expect(value.result.collections[0].deletion.result.noteHistory).toMatchObject({status:'unconfirmed',eventId:expect.any(String)});else expect(value.result.collections[0].deletion.result.noteHistory).toBeUndefined()
 const inspected=await runCompiledObjectCli(['file','share','inspect','--input','-'],environment,JSON.stringify({mode:'undo',request:params}));expect(inspected.code).toBe(1);expect(JSON.parse(inspected.stdout)).toMatchObject({ok:true,result:{mode:'undo',result:{status:mode==='preparation-conflict'?'partial':'unknown',collections:[{source:{result:{noteHistory:{status:'committed'}}}}]}}});expect(native).not.toHaveBeenCalled();expect(await readFile(path,'utf8')).toContain('One original knowledge source')
},20_000)

it('collects the original physical shared file when an earlier configured parent root aliases its trusted child Workspace resource',async()=>{
 const f=await fixture();f.workspaces.unshift({...f.workspace,id:'parent-alias',path:f.root});expect(await f.port.share(f.params,{actor:person})).toMatchObject({status:'committed'})
 const result=await f.port.undoShare(await removal(f),{actor:person});expect(result).toMatchObject({status:'committed',collections:[{resource:{workspaceId:'notes',path:'block-shared.note.md'},source:{resource:{workspaceId:'notes',path:'source.note.md'},result:{noteHistory:{status:'committed'}}},deletion:{result:{status:'deleted'}}}]});expect(await readFile(join(f.directory,'source.note.md'),'utf8')).toContain('One original knowledge source');await expect(readFile(join(f.directory,'block-shared.note.md'),'utf8')).rejects.toMatchObject({code:'ENOENT'})
})

it('uses one final physical destination save when its original source is addressed through a different managed Workspace alias',async()=>{
 const f=await fixture(),draft=readNoteDocument(f.source.content);if(draft.status!=='valid')throw Error('fixture');draft.note.content.content!.push(f.include());f.params.destination={...f.source,content:serializeNoteDocument(draft.note),operationId:'same-physical-first-save'};await f.port.share(f.params,{actor:person});f.destination=f.source
 const parent={...f.workspace,id:'parent-alias',path:f.root};f.workspaces.unshift(parent);const params=await removal(f),path='notes/source.note.md';params.destination={...params.destination,zoneId:'zone-parent-alias',path,expectedResource:{hostId:'local',workspaceId:parent.id,workspacePath:parent.path,zoneId:'zone-parent-alias',zonePath:parent.path,path}};const writes=vi.spyOn(f.files,'write'),result=await f.port.undoShare(params,{actor:person})
 expect(result).toMatchObject({status:'committed',destination:{resource:{workspaceId:'parent-alias'},result:{noteHistory:{eventId:'saved-shared-undo'}}},collections:[{source:{resource:{workspaceId:'parent-alias'},result:{noteHistory:{eventId:'saved-shared-undo'}}},deletion:{result:{status:'deleted'}}}]});expect(writes.mock.calls.filter(([,input])=>input.path.endsWith('source.note.md'))).toHaveLength(1)
 expect(await f.port.inspectShare({mode:'undo',request:params},{actor:{kind:'agent',id:'alias-inspector'}})).toMatchObject({mode:'undo',result:{status:'committed',collections:[{source:{result:{noteHistory:{replayed:true}}},deletion:{result:{status:'deleted'}}}]}});expect(await readFile(join(f.directory,'source.note.md'),'utf8')).toContain('One original knowledge source')
})

it('reports a combined saved draft as known partial when its source is restored before a visible new dependency retains the old shared file',async()=>{
 const f=await fixture();await f.port.share(f.params,{actor:person});const removalRequest=await removal(f),sourceBody=await readFile(join(f.directory,'source.note.md'),'utf8'),draft=readNoteDocument(removalRequest.destination.content);if(draft.status!=='valid')throw Error('fixture');draft.note.content.content!.push({type:'noteInclude',attrs:{blockId:'new-paste-block',referenceId:'new-paste-ref',noteId:'new-shared-note',path:'new-shared.note.md'}})
 const combined:FileShareParams={operationId:'combined-known-partial',destination:{...removalRequest.destination,content:serializeNoteDocument(draft.note)},undoReferenceIds:removalRequest.referenceIds,promotions:[{...f.params.promotions[0]!,operationId:'promote-before-known-partial',source:{...f.source,baseContent:sourceBody,content:sourceBody,expectedRevision:noteHistoryRevision(sourceBody)},sourceBlockId:'untouched',referenceId:'new-paste-ref',shared:{...f.params.promotions[0]!.shared,noteId:'new-shared-note',path:'new-shared.note.md',expectedResource:{...f.source.expectedResource,path:'new-shared.note.md'}}}]}
 const owner=f.makeOwner(undefined,f.makeUndo(async stage=>{if(stage==='source'){const path=join(f.directory,'destination.note.md'),current=readNoteDocument(await readFile(path,'utf8'));if(current.status!=='valid')throw Error('fixture');current.note.content.content!.push(f.include('new-retained-use','new-retained-block'));await writeFile(path,serializeNoteDocument(current.note))}})),result=await owner.share(combined,{actor:person});expect(result).toMatchObject({status:'partial',undo:{status:'partial',collections:[{source:{result:{noteHistory:{status:'committed'}}},retainedReason:{code:'scope-changed'}}]}});expect(parseFileShareResult(result,combined).status).toBe('partial')
 expect(await f.port.inspectShare({mode:'request',request:combined},{actor:{kind:'agent',id:'partial-inspector'}})).toMatchObject({mode:'request',result:{status:'partial',undo:{status:'partial',collections:[{source:{result:{noteHistory:{replayed:true}}}}]}}});expect(await readFile(join(f.directory,'block-shared.note.md'),'utf8')).toContain('One original knowledge source')
})

it('retains shared knowledge when an exact physical Workspace alias has a later unconfirmed write without changing the native generation',async()=>{
 const f=await fixture();await f.port.share(f.params,{actor:person});const parent={...f.workspace,id:'parent-alias',path:f.root};f.workspaces.unshift(parent);const created=await f.metadata.readHistoryOperation('promote-original:create');if(!created||created.operation!=='edit')throw Error('fixture');const{provenance:_provenance,fileWitness:_witness,...record}=created,resource={hostId:'local',workspaceId:parent.id,workspacePath:parent.path,path:'notes/block-shared.note.md'}
 await f.metadata.recordHistory({...record,eventId:'known-alias-unconfirmed',batchId:'known-alias-unconfirmed',sequence:0,resource,originalResource:resource,status:'prepared',at:Date.now(),parentEventId:null,baseRevision:created.revision,beforeContent:created.content,requestFingerprint:'later-known-alias-intent'})
 const native=vi.spyOn(f.files,'deleteExact'),params=await removal(f);expect(await f.port.undoShare(params,{actor:person})).toMatchObject({status:'committed',collections:[{source:null,deletion:null,retainedReason:{code:'later-edit'}}]});expect(native).not.toHaveBeenCalled();expect(await readFile(join(f.directory,'source.note.md'),'utf8')).toContain('::note-include');expect(await readFile(join(f.directory,'block-shared.note.md'),'utf8')).toBe(created.content)
})

it('retains the shared source when its original source host now declares a different Note identity',async()=>{
 const f=await fixture();await f.port.share(f.params,{actor:person});const path=join(f.directory,'source.note.md'),current=readNoteDocument(await readFile(path,'utf8'));if(current.status!=='valid')throw Error('fixture');current.note.noteId='different-current-note';await writeFile(path,serializeNoteDocument(current.note));const native=vi.spyOn(f.files,'deleteExact')
 expect(await f.port.undoShare(await removal(f),{actor:person})).toMatchObject({status:'committed',collections:[{source:null,deletion:null,retainedReason:{code:'source-changed'}}]});expect(native).not.toHaveBeenCalled();const observed=readNoteDocument(await readFile(path,'utf8'));expect(observed).toMatchObject({status:'valid',note:{noteId:'different-current-note'}});if(observed.status==='valid')expect(observed.note.content.content![0]).toMatchObject({type:'noteInclude',attrs:{noteId:'shared-note'}});expect(await readFile(join(f.directory,'block-shared.note.md'),'utf8')).toContain('One original knowledge source')
})

async function sectionFixture() {
  const f = await fixture(), source = readNoteDocument(f.source.content)
  if (source.status !== 'valid') throw Error('Source must parse')
  const paragraph = (blockId: string, text: string) => ({ type: 'paragraph', attrs: { blockId }, content: [{ type: 'text', text }] })
  const heading = (blockId: string, level: number, text: string) => ({ type: 'heading', attrs: { blockId, level }, content: [{ type: 'text', text }] })
  source.note.content.content = [paragraph('before-section', 'Keep the introduction'), heading('section-root', 2, 'Research section'), paragraph('section-body', 'Evidence under the section'),
    heading('subsection', 3, 'Supporting detail'), { type: 'bulletList', content: [{ type: 'listItem', attrs: { blockId: 'evidence-item' }, content: [paragraph('item-body', 'Nested evidence remains addressable')] }] },
    heading('next-section', 2, 'Next independent section'), paragraph('after-section', 'Keep the next section intact')]
  const written = await f.writer.write(f.workspace, { path: f.source.path, expectedRevision: f.source.expectedRevision, content: serializeNoteDocument(source.note) }, { actor: author })
  if (written.status !== 'written') throw Error('Section original must save')
  const canonical = await readFile(join(f.directory, f.source.path), 'utf8')
  Object.assign(f.source, { content: canonical, baseContent: canonical, expectedRevision: written.revision })
  f.params.promotions[0]!.source = f.source
  f.params.promotions[0]!.sourceBlockId = 'section-root'
  return { ...f, originalSectionNote: readNoteDocument(canonical) }
}

it('shares a complete heading section through public CLI, forwards every moved anchor and safely restores all roots on undo', async () => {
  const f = await sectionFixture()
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'section.sock'), files: f.port, coreClients: () => [] })
  await server.start(); dispose.push(() => server.stop())
  const response = await runCompiledObjectCli(['file', 'share', '--input', '-'], objectCliEnvironment(f.root, { AGENTMUX_RPC_ENDPOINT: 'unix:' + server.path }), JSON.stringify(f.params))
  expect(response.code, response.stderr + response.stdout).toBe(0)
  expect(parseFileShareResult(JSON.parse(response.stdout).result, f.params).status).toBe('committed')
  const source = await f.writer.read(f.workspace, f.source.path), shared = await f.writer.read(f.workspace, 'block-shared.note.md')
  if (source.status !== 'read' || shared.status !== 'read') throw Error('Both exact originals must read')
  const parsedSource = readNoteDocument(source.document.content), parsedShared = readNoteDocument(shared.document.content)
  expect(parsedShared).toMatchObject({ status: 'valid', note: { content: { content: [{ type: 'heading', attrs: { blockId: 'section-root', level: 2 } }, { type: 'paragraph' }, { type: 'heading', attrs: { level: 3 } }, { type: 'bulletList' }] } } })
  if (parsedSource.status !== 'valid') throw Error('Source must parse')
  expect(parsedSource.note.content.content!.map(node => node.attrs?.blockId)).toEqual(['before-section', 'section-root', 'next-section', 'after-section'])
  expect(parsedSource.note.content.content![1]).toMatchObject({ type: 'noteInclude', attrs: { forwardedBlockIds: ['section-body', 'subsection', 'evidence-item', 'item-body'] } })
  expect(shared.document.content).not.toContain('Keep the introduction')
  expect(shared.document.content).not.toContain('Next independent section')
  const knowledge = noteKnowledge([{ location: { workspaceId: f.workspace.id, path: f.source.path }, document: source.document }, { location: { workspaceId: f.workspace.id, path: 'block-shared.note.md' }, document: shared.document }], 'complete')
  for (const blockId of ['section-body', 'subsection', 'evidence-item', 'item-body']) expect(resolveNoteBlock(knowledge, { noteId: 'source-note', blockId })).toMatchObject({ status: 'resolved', source: { note: { noteId: 'shared-note' } }, block: { blockId } })
  const undone = await f.port.undoShare(await removal(f), { actor: person })
  expect(undone, JSON.stringify(undone)).toMatchObject({ status: 'committed', collections: [{ source: { result: { status: 'written' } }, deletion: { result: { status: 'deleted' } } }] })
  const restoredContent = await readFile(join(f.directory, f.source.path), 'utf8')
  expect(restoredContent).toBe(f.source.content)
  expect(readNoteDocument(restoredContent)).toEqual(f.originalSectionNote)
  expect(await readdir(f.directory)).not.toContain('block-shared.note.md')
})

it('compares the complete same-page section before saving and preserves later edits outside its range', async () => {
  const f = await sectionFixture(), source = readNoteDocument(f.source.content)
  if (source.status !== 'valid') throw Error('Source must parse')
  source.note.content.content![2]!.content![0]!.text = 'A later changed section paragraph'
  source.note.content.content!.push(f.include())
  f.params.destination = { ...f.source, operationId: 'same-section-save', content: serializeNoteDocument(source.note) }
  expect(await f.port.share(f.params, { actor: person })).toMatchObject({ status: 'error', code: 'NOTE_SHARE_SOURCE_CHANGED' })
  expect(await readdir(f.directory)).not.toContain('block-shared.note.md')
  expect(await readFile(join(f.directory, f.source.path), 'utf8')).toBe(f.source.content)
  source.note.content.content![2]!.content![0]!.text = 'Evidence under the section'
  source.note.content.content![6]!.content![0]!.text = 'A later independent paragraph remains'
  f.params.destination.content = serializeNoteDocument(source.note)
  const writes = vi.spyOn(f.files, 'write'), saved = await f.port.share(f.params, { actor: person })
  expect(saved.status, JSON.stringify(saved)).toBe('committed')
  expect(writes.mock.calls.filter(([, request]) => request.path === f.source.path)).toHaveLength(1)
  const current = await readFile(join(f.directory, f.source.path), 'utf8')
  expect(current).toContain('A later independent paragraph remains')
  expect(current.match(/::note-include/gu)).toHaveLength(2)
  expect(current).not.toContain('Evidence under the section')
})

it('rejects self-inclusion anywhere inside the selected heading section before creating its Markdown', async () => {
  const f = await sectionFixture(), source = readNoteDocument(f.source.content)
  if (source.status !== 'valid') throw Error('Source must parse')
  source.note.content.content!.splice(4, 0, f.include('nested-cycle', 'nested-cycle-block'))
  f.params.promotions[0]!.source = { ...f.source, content: serializeNoteDocument(source.note) }
  expect(await f.port.share(f.params, { actor: person })).toMatchObject({ status: 'error', code: 'NOTE_SHARE_CYCLE' })
  expect(await readdir(f.directory)).not.toContain('block-shared.note.md')
  expect(await readFile(join(f.directory, f.source.path), 'utf8')).toBe(f.source.content)
})

it('limits heading ranges to their own sibling container and stops at equal or higher levels', () => {
  const heading = (blockId: string, level: number) => ({ type: 'heading', attrs: { blockId, level } })
  const parent = { type: 'blockquote', content: [heading('local-heading', 2), { type: 'paragraph' }, heading('lower-heading', 3), { type: 'paragraph' }, heading('higher-heading', 1), { type: 'paragraph' }] }
  const content: import('../src/shared/note-document').NoteDocument['content'] = { type: 'doc', content: [parent, { type: 'paragraph', attrs: { blockId: 'outside' } }] }
  expect(noteShareSiblingRange(parent, 0)).toEqual(parent.content.slice(0, 4))
  expect(noteShareRange(content, 'local-heading')).toMatchObject({ parent, index: 0, count: 4 })
  expect(noteShareSiblingRange(parent, 2)).toEqual(parent.content.slice(2, 4))
  expect(noteShareSiblingRange(parent, 4)).toEqual(parent.content.slice(4))
  expect(noteShareRange(content, 'outside')?.count).toBe(1)
  expect(noteShareSiblingRange(parent, 100)).toEqual([])
  content.content!.push({ type: 'paragraph', attrs: { blockId: 'local-heading' } })
  expect(noteShareRange(content, 'local-heading')).toBeNull()
})

it('extracts and restores a nested heading section without crossing its quote container or higher heading boundary', async () => {
  const f = await sectionFixture(), original = readNoteDocument(f.source.content)
  if (original.status !== 'valid') throw Error('Source must parse')
  original.note.content.content![5]!.attrs!.level = 1
  original.note.content.content = [{ type: 'blockquote', content: original.note.content.content! }, { type: 'paragraph', attrs: { blockId: 'outer-context' }, content: [{ type: 'text', text: 'Outside the quote container' }] }]
  const written = await f.writer.write(f.workspace, { path: f.source.path, content: serializeNoteDocument(original.note), expectedRevision: f.source.expectedRevision }, { actor: author })
  if (written.status !== 'written') throw Error('Nested source must save')
  const content = await readFile(join(f.directory, f.source.path), 'utf8')
  Object.assign(f.source, { content, baseContent: content, expectedRevision: written.revision })
  expect((await f.port.share(f.params, { actor: person })).status).toBe('committed')
  const source = readNoteDocument(await readFile(join(f.directory, f.source.path), 'utf8'))
  expect(source).toMatchObject({ status: 'valid', note: { content: { content: [{ type: 'blockquote', content: [{ type: 'paragraph' }, { type: 'noteInclude' }, { type: 'heading', attrs: { level: 1 } }, { type: 'paragraph' }] }, { type: 'paragraph', attrs: { blockId: 'outer-context' } }] } } })
  const shared = await readFile(join(f.directory, 'block-shared.note.md'), 'utf8')
  expect(shared).toContain('Nested evidence remains addressable')
  expect(shared).not.toContain('Outside the quote container')
  expect(shared).not.toContain('Next independent section')
  expect((await f.port.undoShare(await removal(f), { actor: person })).status).toBe('committed')
  expect(await readFile(join(f.directory, f.source.path), 'utf8')).toBe(content)
})

it.each([false, true])('preserves chained forwarding and original ambiguity when sharing an already shared subtree: duplicate=%s', async duplicate => {
  const f = await fixture(), source = readNoteDocument(f.source.content)
  if (source.status !== 'valid') throw Error('fixture')
  source.note.content.content = [
    { type: 'heading', attrs: { blockId: 'chapter', level: 2 }, content: [{ type: 'text', text: 'Chapter' }] },
    { type: 'bulletList', content: [{ type: 'listItem', attrs: { blockId: 'nested-item' }, content: [{ type: 'paragraph', attrs: { blockId: 'nested-child' }, content: [{ type: 'text', text: 'Original child' }] }] }] },
    { type: 'heading', attrs: { blockId: 'next', level: 2 }, content: [{ type: 'text', text: 'Next' }] }
  ]
  const saved = await f.writer.write(f.workspace, { path: f.source.path, content: serializeNoteDocument(source.note), expectedRevision: f.source.expectedRevision }, { actor: author })
  if (saved.status !== 'written') throw Error('source')
  const content = await readFile(join(f.directory, f.source.path), 'utf8')
  f.params.promotions[0]!.source = { ...f.source, content, baseContent: content, expectedRevision: saved.revision }
  f.params.promotions[0]!.sourceBlockId = 'nested-item'
  expect((await f.port.share(f.params, { actor: person })).status).toBe('committed')
  if (duplicate) {
    const current = readNoteDocument(await readFile(join(f.directory, f.source.path), 'utf8'))
    if (current.status !== 'valid') throw Error('Current source must parse')
    const included = current.note.content.content!.find(node => node.type === 'noteInclude')!
    included.attrs!.forwardedBlockIds = ['nested-child', 'nested-child']
    const updated = await f.writer.write(f.workspace, { path: f.source.path, content: serializeNoteDocument(current.note), expectedRevision: noteHistoryRevision(await readFile(join(f.directory, f.source.path), 'utf8')) }, { actor: person })
    if (updated.status !== 'written') throw Error('Duplicate declaration must remain readable')
  }
  const observedSource = await f.writer.read(f.workspace, f.source.path), nested = await f.writer.read(f.workspace, 'block-shared.note.md'), dest = await f.writer.read(f.workspace, f.destination.path)
  if (observedSource.status !== 'read' || nested.status !== 'read' || dest.status !== 'read') throw Error('read')
  const docs = [{ location: { workspaceId: f.workspace.id, path: f.source.path }, document: observedSource.document }, { location: { workspaceId: f.workspace.id, path: 'block-shared.note.md' }, document: nested.document }]
  expect(resolveNoteBlock(noteKnowledge(docs, 'complete'), { noteId: 'source-note', blockId: 'nested-child' }).status).toBe(duplicate ? 'ambiguous' : 'resolved')
  const destination = readNoteDocument(dest.document.content)
  if (destination.status !== 'valid') throw Error('dest')
  destination.note.content.content!.push({ type: 'noteInclude', attrs: { blockId: 'outer-use', referenceId: 'outer-use-ref', noteId: 'outer-shared', path: 'outer-shared.note.md' } })
  const params: FileShareParams = { operationId: 'outer-save', destination: { ...f.destination, content: serializeNoteDocument(destination.note), baseContent: dest.document.content, expectedRevision: dest.document.revision, operationId: 'outer-destination-save' }, promotions: [{ operationId: 'outer-promotion', sourceNoteId: 'source-note', sourceBlockId: 'chapter', source: { ...f.source, content: observedSource.document.content, baseContent: observedSource.document.content, expectedRevision: observedSource.document.revision, operationId: 'outer-source-save' }, referenceId: 'outer-use-ref', shared: { ...f.params.promotions[0]!.shared, path: 'outer-shared.note.md', noteId: 'outer-shared', expectedResource: { ...f.source.expectedResource, path: 'outer-shared.note.md' } } }] }
  expect((await f.port.share(params, { actor: person })).status).toBe('committed')
  const after = await f.writer.read(f.workspace, f.source.path), outer = await f.writer.read(f.workspace, 'outer-shared.note.md')
  if (after.status !== 'read' || outer.status !== 'read') throw Error('after')
  const knowledge = noteKnowledge([{ ...docs[0]!, document: after.document }, docs[1]!, { location: { workspaceId: f.workspace.id, path: 'outer-shared.note.md' }, document: outer.document }], 'complete')
  const parsedAfter = readNoteDocument(after.document.content), parsedOuter = readNoteDocument(outer.document.content)
  if (parsedAfter.status !== 'valid' || parsedOuter.status !== 'valid') throw Error('Moved source and section must parse')
  const forwarded = parsedAfter.note.content.content![0]!.attrs!.forwardedBlockIds as string[]
  expect(forwarded.filter(id => id === 'nested-child')).toHaveLength(1)
  const originalInclude = parsedOuter.note.content.content!.find(node => node.type === 'noteInclude')!
  expect(originalInclude.attrs!.forwardedBlockIds).toEqual(duplicate ? ['nested-child', 'nested-child'] : ['nested-child'])
  const resolution = resolveNoteBlock(knowledge, { noteId: 'source-note', blockId: 'nested-child' })
  if (duplicate) expect(resolution.status).toBe('ambiguous')
  else expect(resolution).toMatchObject({ status: 'resolved', source: { note: { noteId: 'shared-note' } }, block: { text: 'Original child' } })
})

it('keeps a section root with a conflicting nested forwarding declaration ambiguous instead of extracting a false unique address', async () => {
  const f = await sectionFixture(), source = readNoteDocument(f.source.content)
  if (source.status !== 'valid') throw Error('Source must parse')
  source.note.content.content!.splice(3, 0, { type: 'noteInclude', attrs: { blockId: 'earlier-include', referenceId: 'earlier-use', noteId: 'earlier-shared', path: 'earlier-shared.note.md', forwardedBlockIds: ['section-root'] } })
  const content = serializeNoteDocument(source.note)
  f.params.promotions[0]!.source = { ...f.source, content }
  const knowledge = noteKnowledge([{ location: { workspaceId: f.workspace.id, path: f.source.path }, document: { path: f.source.path, content, revision: noteHistoryRevision(content) } }], 'complete')
  expect(resolveNoteBlock(knowledge, { noteId: 'source-note', blockId: 'section-root' }).status).toBe('ambiguous')
  expect(await f.port.share(f.params, { actor: person })).toMatchObject({ status: 'error', code: 'NOTE_SHARE_SOURCE_CHANGED' })
  expect(await readdir(f.directory)).not.toContain('block-shared.note.md')
  expect(await readFile(join(f.directory, f.source.path), 'utf8')).toBe(f.source.content)
})
