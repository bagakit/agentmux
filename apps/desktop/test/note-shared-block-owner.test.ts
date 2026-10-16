// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import { readNoteMarkdownHeader } from '@agentmux/core/note-format'
import { noteHistoryRevision } from '@agentmux/core/note-history'
import { parseFileShareResult, type FileShareParams, type FileWriteParams } from '@agentmux/core/files'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { NoteFileWriter } from '../src/main/note-file-writer'
import { FileReadOwner } from '../src/main/file-read-owner'
import { NoteSharedBlockOwner } from '../src/main/note-shared-block-owner'
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
  const port = new FileReadOwner({ share: { share: (input, context) => shared.share(input, context), inspectShare: (input, context) => shared.inspectShare(input, context) },
    catalog: async () => ({ zones: workspaces.map(item => ({ zoneId: item.id === workspace.id ? 'zone' : 'zone-' + item.id, workspaceId: item.id, kind: 'directory', hostId: 'local', directoryPath: item.path })), bindings: [] }) as never,
    workspace: id => workspaces.find(item => item.id === id),
    files: { read: writer.read.bind(writer), listFiles: files.listFiles.bind(files), history: writer.history.bind(writer), write: writer.write.bind(writer), createShared: writer.createShared.bind(writer) } })
  const makeOwner = (afterStage?: ConstructorParameters<typeof NoteSharedBlockOwner>[0]['afterStage']) => new NoteSharedBlockOwner({ files: port, historyOperation: metadata.readHistoryOperation.bind(metadata), withWriteLease: metadata.runWithWriteLease.bind(metadata), ...(afterStage ? { afterStage } : {}) })
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
  return { root, directory, workspace, workspaces, files, writer, metadata, port, makeOwner, params, source, destination, include }
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

})
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
