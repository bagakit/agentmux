import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxNotebookStore, AgentMuxNotesStorage } from '@agentmux/core/notebook-store'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import type { NotebookActor } from '@agentmux/core/notebook-catalog'
import { noteHistoryRevision } from '@agentmux/core/note-history'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner'
import { NotebookObservationOwner } from '@agentmux/host/notebook-observation-owner'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { NoteFileWriter } from '@agentmux/host/note-file-writer'
import { FileReadOwner } from '@agentmux/host/file-read-owner'
import { NotesStorageOwner } from '../src/main/notes-storage-owner'
import { ConfigOwner } from '../src/main/config-owner'
import { newNoteDocument, serializeNoteDocument, readNoteDocument } from '../src/shared/note-document'
import type { AppConfig, WorkspaceFileWriteInput, WorkspaceRecord } from '../src/shared/contracts'
const close: Array<() => Promise<unknown> | unknown> = []
const person = { kind: 'user' as const, id: 'original-person' }, agent = { kind: 'agent' as const, id: 'original-agent' }
afterEach(async () => { vi.restoreAllMocks(); for (const dispose of close.splice(0).reverse()) await dispose() })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'note-submit-'))), directory = join(root, 'notes')
  close.push(() => rm(root, { recursive: true, force: true })); await mkdir(directory)
  const workspace: WorkspaceRecord = { id: '__notes__', hostId: 'local', path: directory, name: 'Notes', kind: 'folder' }
  const storage = new AgentMuxNotesStorage(join(root, 'state', 'notes-location.json'), directory), metadata = new AgentMuxNotebookStore(undefined, storage)
  const path = 'original.note.md', resource = { hostId: 'local', workspaceId: workspace.id, workspacePath: directory, path }
  await metadata.apply({ operationId: 'register-original', expectedRevision: 0, change: { kind: 'register', noteId: 'original-note', title: 'Original', resource } }, person)
  let config = { hosts: [], workspaces: [workspace], executors: {} } as unknown as AppConfig
  const configOwner = new ConfigOwner({ read: () => config, save: async value => value, publish: value => { config = value } })
  const spatial = new AgentMuxSpatialStateStore(join(root, 'state', 'spatial.json')), notes = new NotesStorageOwner(configOwner, spatial, () => {}, storage)
  const files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' }) as never); close.push(() => files.dispose())
  const writer = new NoteFileWriter(files, undefined, metadata)
  const save = (input: WorkspaceFileWriteInput, actor: NotebookActor = person) => notes.write(workspace, input, actual => writer.write(actual, input, { actor }))
  const body = newNoteDocument('Alpha', 'original-note', 'first')
  body.content.content!.push(...([['second', 'Bravo'], ['third', 'Charlie']] as const).map(([blockId, text]) => ({ type: 'paragraph', attrs: { blockId }, content: [{ type: 'text', text }] })))
  const original = await save({ path, content: serializeNoteDocument(body), expectedRevision: null })
  expect(original.status).toBe('written'); if (original.status !== 'written') throw Error('Original Note must be saved')
  const base = original.content ?? serializeNoteDocument(body), request = (operationId: string, content: string): WorkspaceFileWriteInput => ({ path, content, baseContent: base, expectedRevision: original.revision, operationId })
  return { root, directory, workspace, storage, metadata, path, resource, notes, files, writer, save, base, request, original }
}
it('merges two actual CLI clients from one exact baseline under the original storage lock', async () => {
  const f = await fixture(), catalog = { zones: [{ zoneId: 'original-zone', workspaceId: f.workspace.id, kind: 'directory', hostId: 'local', directoryPath: f.directory }], bindings: [] }
  const port = new FileReadOwner({ catalog: async () => catalog as never, workspace: () => f.workspace,
    files: { read: f.writer.read.bind(f.writer), listFiles: f.files.listFiles.bind(f.files), history: f.writer.history.bind(f.writer),
      write: (workspace, input, context) => f.notes.write(workspace, input, actual => f.writer.write(actual, input, context)) } })
  const socketPath = join(f.root, 'control.sock'), server = new AgentMuxControlServer({ socketPath, files: port, coreClients: () => [] })
  await server.start(); close.push(() => server.stop())
  const basePath = join(f.root, 'common-base.md'); await writeFile(basePath, f.base)
  const resource = { ...f.resource, zoneId: 'original-zone', zonePath: f.directory }, environment = objectCliEnvironment(f.root, { AGENTMUX_CONTROL_SOCKET: socketPath })
  const args = ['file', 'write', '--zone', 'original-zone', '--path', f.path, '--resource', JSON.stringify(resource), '--expected-revision', f.original.revision, '--base', basePath]
  const [first, second] = await Promise.all([
    runCompiledObjectCli([...args, '--operation-id', 'first-public-edit'], environment, f.base.replace('Alpha', 'Alpha from first client')),
    runCompiledObjectCli([...args, '--operation-id', 'second-public-edit'], environment, f.base.replace('Charlie', 'Charlie from second client'))
  ])
  expect(first.code, first.stderr).toBe(0); expect(second.code, second.stderr).toBe(0)
  for (const reply of [first, second]) expect(JSON.parse(reply.stdout).result.result).toMatchObject({ status: 'written', content: expect.any(String), noteHistory: { status: 'committed' } })
  const saved = await readFile(join(f.directory, f.path), 'utf8')
  expect(saved).toContain('Alpha from first client'); expect(saved).toContain('Charlie from second client')
  const history = await f.metadata.readHistory({ noteId: 'original-note', resource: f.resource })
  expect(history.entries).toHaveLength(3); expect(history.entries.slice(0, 2).map(e => e.eventId).sort()).toEqual(['first-public-edit', 'second-public-edit'])
  const repeated = await runCompiledObjectCli([...args, '--operation-id', 'first-public-edit'], environment, f.base.replace('Alpha', 'Alpha from first client'))
  expect(repeated.code, repeated.stderr).toBe(0); expect(JSON.parse(repeated.stdout).result.result.noteHistory).toMatchObject({ eventId: 'first-public-edit', replayed: true })
  expect(await readFile(join(f.directory, f.path), 'utf8')).toBe(saved)
})
it('keeps all three originals on overlap and never applies a rejected operation after the file changes again', async () => {
  const f = await fixture(), next = await f.save(f.request('agent-change', f.base.replace('Bravo', 'Agent changed Bravo')), agent)
  expect(next.status).toBe('written')
  const submitted = f.request('human-overlap', f.base.replace('Bravo', 'Human changed Bravo'))
  const result = await f.save(submitted)
  expect(result).toMatchObject({ status: 'conflict', noteConflict: { reason: 'overlap', baseContent: f.base, proposedContent: submitted.content, currentContent: expect.stringContaining('Agent changed Bravo') }, noteHistory: { status: 'not-applied', eventId: 'human-overlap' } })
  expect(await readFile(join(f.directory, f.path), 'utf8')).toContain('Agent changed Bravo')
  await writeFile(join(f.directory, f.path), f.base)
  expect(await f.save(submitted)).toMatchObject({ status: 'error', code: 'NOTE_OPERATION_NOT_APPLIED' })
  expect(await readFile(join(f.directory, f.path), 'utf8')).toBe(f.base)
})
it('preserves delete/edit and Note or block identity conflicts without writing a guessed merge', async () => {
  const f = await fixture(), request = f.request('agent-delete', f.base.replace(/Bravo\n\n\^second\n/gu, ''))
  expect(request.content).not.toBe(f.base)
  expect((await f.save(request, agent)).status).toBe('written')
  const edit = await f.save(f.request('human-edit-deleted', f.base.replace('Bravo', 'Changed deleted block')))
  expect(edit).toMatchObject({ status: 'conflict', noteConflict: { reason: 'identity' } })
  expect(await f.save(f.request('other-note-identity', f.base.replace('original-note', 'other-note')))).toMatchObject({ status: 'conflict', noteConflict: { reason: 'identity' } })
  expect(await f.save(f.request('duplicate-block-identity', f.base.replace('^third', '^first')))).toMatchObject({ status: 'conflict', noteConflict: { reason: 'invalid-structure' } })
})
it('pins request bytes, base digest, actor and resource to one durable operation', async () => {
  const f = await fixture(), input = f.request('original-operation', f.base.replace('Alpha', 'Agent Alpha'))
  const first = await f.save(input, agent)
  expect(first).toMatchObject({ status: 'written', noteHistory: { eventId: input.operationId, status: 'committed' } })
  const before = await readFile(join(f.directory, f.path), 'utf8')
  expect(await f.save({ ...input, content: f.base.replace('Alpha', 'Different request') }, agent)).toMatchObject({ status: 'error', code: 'NOTE_OPERATION_CONFLICT' })
  expect(await f.save(input, person)).toMatchObject({ status: 'error', code: 'NOTE_OPERATION_CONFLICT' })
  expect(await f.save({ ...input, expectedRevision: noteHistoryRevision('wrong base') }, agent)).toMatchObject({ status: 'error', code: 'NOTE_SUBMISSION_INVALID' })
  const other = 'other.note.md'; await writeFile(join(f.directory, other), f.base)
  expect(await f.save({ ...input, path: other }, agent)).toMatchObject({ status: 'error', code: 'NOTE_OPERATION_CONFLICT' })
  expect(await readFile(join(f.directory, f.path), 'utf8')).toBe(before); expect(await readFile(join(f.directory, other), 'utf8')).toBe(f.base)
  expect((await f.writer.read(f.workspace, f.path))).toMatchObject({ status: 'read', document: { noteProvenance: { blocks: { first: { created: { actor: person }, lastEdited: { actor: agent } }, third: { created: { actor: person }, lastEdited: { actor: person } } } } } })
})
it('preserves a later external write when the original Files CAS races after merge', async () => {
  const f = await fixture(), write = f.files.write.bind(f.files), outside = f.base.replace('Charlie', 'Later external content')
  vi.spyOn(f.files, 'write').mockImplementationOnce(async (workspace, input) => { await writeFile(join(f.directory, f.path), outside); return write(workspace, input) })
  const result = await f.save(f.request('raced-operation', f.base.replace('Alpha', 'Proposed Alpha')), agent)
  expect(result).toMatchObject({ status: 'conflict', observedRevision: noteHistoryRevision(outside), noteHistory: { status: 'not-applied' } })
  expect(await readFile(join(f.directory, f.path), 'utf8')).toBe(outside)
})
it('does not infer completion or replay an unknown write after reopening the original owner', async () => {
  const f = await fixture(), write = f.files.write.bind(f.files), input = f.request('lost-original-reply', f.base.replace('Alpha', 'Original attempted Alpha'))
  const writes = vi.spyOn(f.files, 'write').mockImplementationOnce(async (workspace, request) => { await write(workspace, request); throw Error('Reply lost after original body write') })
  const result = await f.save(input, agent)
  expect(result).toMatchObject({ status: 'unknown', noteHistory: { status: 'unconfirmed', eventId: input.operationId } })
  const reopened = new NoteFileWriter(f.files, undefined, new AgentMuxNotebookStore(undefined, new AgentMuxNotesStorage(f.storage.locatorPath, f.directory)))
  const saved = await readFile(join(f.directory, f.path), 'utf8'); writes.mockClear()
  expect(await f.notes.write(f.workspace, input, workspace => reopened.write(workspace, input, { actor: agent }))).toMatchObject({ status: 'unknown', code: 'NOTE_OPERATION_UNCONFIRMED', noteHistory: { eventId: input.operationId } })
  expect(writes).not.toHaveBeenCalled(); expect(await readFile(join(f.directory, f.path), 'utf8')).toBe(saved)
  expect((await f.metadata.readHistory({ noteId: 'original-note', resource: f.resource, eventId: input.operationId })).entries).toEqual([expect.objectContaining({ status: 'unconfirmed' })])
})
it('requires preparation only for opt-in durable submissions while ordinary legal saves still work', async () => {
  const f = await fixture(), record = vi.spyOn(f.metadata, 'recordHistory').mockRejectedValue(Error('Original journal unavailable'))
  const input = f.request('unprepared-operation', f.base.replace('Alpha', 'Enhanced Alpha'))
  expect(await f.save(input)).toMatchObject({ status: 'unknown', noteHistory: { status: 'unconfirmed', eventId: input.operationId } })
  expect(await readFile(join(f.directory, f.path), 'utf8')).toBe(f.base)
  expect(await f.save({ path: f.path, content: f.base.replace('Alpha', 'Ordinary Alpha'), expectedRevision: f.original.revision })).toMatchObject({ status: 'written', noteHistory: { status: 'unconfirmed' } })
  expect(await readFile(join(f.directory, f.path), 'utf8')).toContain('Ordinary Alpha'); expect(record).toHaveBeenCalled()
})
it('retains a real written CLI receipt when both original metadata diagnostics contain multiple lines', async () => {
  const f = await fixture(), reason = 'Original database write failed\nRetry observation on this same original\n' + '中文'.repeat(9000)
  vi.spyOn(f.metadata, 'recordHistory').mockRejectedValue(Error(reason)); vi.spyOn(f.metadata, 'recordProvenance').mockRejectedValue(Error(reason))
  const port = new FileReadOwner({ catalog: async () => ({ zones: [{ zoneId: 'original-zone', workspaceId: f.workspace.id, kind: 'directory', hostId: 'local', directoryPath: f.directory }], bindings: [] }) as never,
    workspace: () => f.workspace, files: { read: f.writer.read.bind(f.writer), listFiles: f.files.listFiles.bind(f.files), history: f.writer.history.bind(f.writer),
      write: (workspace, input, context) => f.notes.write(workspace, input, actual => f.writer.write(actual, input, context)) } })
  const socketPath = join(f.root, 'control.sock'), server = new AgentMuxControlServer({ socketPath, files: port, coreClients: () => [] })
  await server.start(); close.push(() => server.stop())
  const reply = await runCompiledObjectCli(['file', 'write', '--zone', 'original-zone', '--path', f.path, '--resource', JSON.stringify({ ...f.resource, zoneId: 'original-zone', zonePath: f.directory }),
    '--expected-revision', f.original.revision], objectCliEnvironment(f.root, { AGENTMUX_CONTROL_SOCKET: socketPath }), f.base.replace('Alpha', 'Saved despite metadata failure'))
  expect(reply.code, reply.stderr).toBe(0)
  const result = JSON.parse(reply.stdout).result.result
  expect(result).toMatchObject({ status: 'written', noteHistory: { status: 'unconfirmed', reason }, noteProvenance: { status: 'unconfirmed', reason: expect.stringContaining(reason) } })
  expect(await readFile(join(f.directory, f.path), 'utf8')).toContain('Saved despite metadata failure')
})
it('does not transplant edits across replaced block identities in either submission order', async () => {
  for (const savedSide of ['replacement', 'edit'] as const) {
    const f = await fixture(), replacement = f.base.replace('^first', '^replacement-first'), edit = f.base.replace('Alpha', 'Edited original first block')
    expect((await f.save(f.request('saved-' + savedSide, savedSide === 'replacement' ? replacement : edit), agent)).status).toBe('written')
    const proposed = savedSide === 'replacement' ? edit : replacement, result = await f.save(f.request('opposite-' + savedSide, proposed))
    expect(result).toMatchObject({ status: 'conflict', noteConflict: { reason: 'identity', baseContent: f.base, proposedContent: proposed } })
    const current = await readFile(join(f.directory, f.path), 'utf8')
    const parsed = readNoteDocument(current)
    expect(parsed.status).toBe('valid')
    if (parsed.status !== 'valid') throw Error('Original saved Note must remain readable')
    expect(parsed.note.content.content![0]!.attrs?.blockId).toBe(savedSide === 'replacement' ? 'replacement-first' : 'first')
    expect(current.includes('Edited original first block')).toBe(savedSide === 'edit')
  }
})

it('keeps an unavailable baseline unknown while ordinary CAS remains usable', async () => {
  const f = await fixture(), read = vi.spyOn(f.files, 'read'), write = vi.spyOn(f.files, 'write')
  for (const mode of ['error', 'throw'] as const) {
    if (mode === 'error') read.mockResolvedValueOnce({ status: 'error', code: 'READ_OBSERVATION_FAILED', message: 'Original file observation unavailable' })
    else read.mockRejectedValueOnce(Error('Original reader unavailable'))
    const input = f.request('unknown-baseline-' + mode, f.base.replace('Alpha', 'Submitted while baseline unavailable'))
    expect(await f.save(input)).toMatchObject({ status: 'unknown', code: 'NOTE_BASELINE_UNAVAILABLE', noteHistory: { status: 'unconfirmed', eventId: input.operationId } })
    expect(write).not.toHaveBeenCalled()
    expect(await f.metadata.readHistoryOperation(input.operationId!)).toBeUndefined()
    expect(await readFile(join(f.directory, f.path), 'utf8')).toBe(f.base)
  }
  read.mockResolvedValueOnce({ status: 'error', code: 'READ_OBSERVATION_FAILED', message: 'Original file observation unavailable' })
  expect(await f.save({ path: f.path, content: f.base.replace('Alpha', 'Ordinary CAS still works'), expectedRevision: f.original.revision })).toMatchObject({ status: 'written' })
  expect(await readFile(join(f.directory, f.path), 'utf8')).toContain('Ordinary CAS still works')
})

it('lets an authenticated Core Agent discover file relationships and submit a concurrent edit through the real compiled CLI', async () => {
  // Real registry/capability, server, CLI process, Files and SQLite; Runtime ports are deterministic, with no native Agent process started.
  const f = await fixture(), h = await rpcOwnerFixture(['knowledge-agent'])
  close.push(h.close)
  const evidence = serializeNoteDocument(newNoteDocument('Needle evidence', 'evidence-note', 'evidence-block', 'Evidence'))
  expect((await f.save({ path: 'evidence.note.md', expectedRevision: null, content: evidence })).status).toBe('written')
  const linked = await f.save({ path: f.path, expectedRevision: f.original.revision, content: f.base.replace('Alpha', 'Alpha [[Evidence]]') })
  expect(linked.status).toBe('written'); if (linked.status !== 'written' || !linked.content) throw Error('The exact linked baseline is required')
  const baseline = linked.content, basePath = join(f.root, 'agent-base.md'); await writeFile(basePath, baseline)
  const catalog = { zones: [{ zoneId: 'original-zone', workspaceId: f.workspace.id, kind: 'directory', hostId: 'local', directoryPath: f.directory }], bindings: [] }
  const port = new FileReadOwner({ catalog: async () => catalog as never, workspace: () => f.workspace,
    files: { read: f.writer.read.bind(f.writer), listFiles: f.files.listFiles.bind(f.files), history: f.writer.history.bind(f.writer),
      write: (workspace, input, context) => f.notes.write(workspace, input, actual => f.writer.write(actual, input, context)) } })
  const observation = new NotebookObservationOwner({ workspace: () => f.workspace, files: f.files })
  const socketPath = join(f.root, 'agent-control.sock'), server = new AgentMuxControlServer({ socketPath, files: port, notebookStore: f.metadata, notebookObservation: observation, coreClients: h.coreClients })
  await server.start(); close.push(() => server.stop())
  const environment = objectCliEnvironment(f.root, { AGENTMUX_RPC_ENDPOINT: 'unix:' + socketPath, AGENTMUX_AGENT_SESSION_ID: h.credentials.agentSessionId, AGENTMUX_AGENT_CAPABILITY: h.capability })
  const scanned = await runCompiledObjectCli(['notebook', 'scan', '--workspace', f.workspace.id, '--path', '.', '--query', 'Needle'], environment)
  expect(scanned.code, scanned.stderr).toBe(0)
  const graph = JSON.parse(scanned.stdout).result
  expect(graph.references).toEqual(expect.arrayContaining([expect.objectContaining({ source: { noteId: 'original-note', blockId: 'first' }, target: { kind: 'page', noteId: 'evidence-note' }, resolution: 'resolved' })]))
  expect(graph.search.hits).toEqual(expect.arrayContaining([expect.objectContaining({ noteId: 'evidence-note', blockId: 'evidence-block' })]))
  const denied = await runCompiledObjectCli(['notebook', 'scan', '--workspace', f.workspace.id, '--path', '.'], { ...environment, AGENTMUX_AGENT_CAPABILITY: 'not-an-issued-capability' })
  expect(denied.code).not.toBe(0)
  expect(JSON.parse(denied.stderr).error.code).toBe('AGENT_CAPABILITY_INVALID')
  expect((await f.save({ path: f.path, expectedRevision: linked.revision, content: baseline.replace('Alpha', 'Human Alpha') })).status).toBe('written')
  const resource = { ...f.resource, zoneId: 'original-zone', zonePath: f.directory }, operationId = 'authenticated-agent-edit'
  const args = ['file', 'write', '--zone', 'original-zone', '--path', f.path, '--resource', JSON.stringify(resource), '--expected-revision', linked.revision, '--base', basePath, '--operation-id', operationId]
  const edited = await runCompiledObjectCli(args, environment, baseline.replace('Charlie', 'Agent Charlie'))
  expect(edited.code, edited.stderr).toBe(0)
  const saved = await readFile(join(f.directory, f.path), 'utf8')
  expect(saved).toContain('Human Alpha'); expect(saved).toContain('Agent Charlie')
  const history = await f.metadata.readHistory({ noteId: 'original-note', resource: f.resource })
  expect(history.entries.filter(event => event.eventId === operationId)).toEqual([expect.objectContaining({ status: 'committed', actor: { kind: 'agent', id: h.credentials.agentSessionId } })])
  const retry = await runCompiledObjectCli(args, environment, baseline.replace('Charlie', 'Agent Charlie'))
  expect(retry.code, retry.stderr).toBe(0); expect(JSON.parse(retry.stdout).result.result.noteHistory.replayed).toBe(true)
  expect((await f.metadata.readHistory({ noteId: 'original-note', resource: f.resource })).entries).toHaveLength(history.entries.length)
  expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})
