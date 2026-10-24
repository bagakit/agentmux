import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import { noteHistoryRevision } from '@agentmux/core/note-history'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { NoteFileWriter } from '@agentmux/host/note-file-writer'
import { FileReadOwner } from '@agentmux/host/file-read-owner'
import { newNoteDocument, serializeNoteDocument } from '../src/shared/note-document'
import { buildNoteFileLibraryRecovery } from './helpers/note-file-library-recovery-build.mjs'
import type { WorkspaceRecord } from '../src/shared/contracts'

const close: Array<() => Promise<unknown> | unknown> = []
const agent = { kind: 'agent' as const, id: 'original-agent' }, person = { kind: 'user' as const, id: 'original-person' }
let compiled: Awaited<ReturnType<typeof buildNoteFileLibraryRecovery>>, compiledDirectory: string
const inheritedCli = process.env.AGENTMUX_TEST_OBJECT_CLI
beforeAll(async () => {
  compiledDirectory = await mkdtemp(join(tmpdir(), 'note-history-source-'))
  compiled = await buildNoteFileLibraryRecovery(compiledDirectory)
  if (process.env.AGENTMUX_NOTE_HISTORY_EVIDENCE) {
    await mkdir(process.env.AGENTMUX_NOTE_HISTORY_EVIDENCE, { recursive: true })
    await writeFile(join(process.env.AGENTMUX_NOTE_HISTORY_EVIDENCE, 'compiled-inputs.json'), JSON.stringify(compiled.manifest, null, 2) + '\n')
  }
  process.env.AGENTMUX_TEST_OBJECT_CLI = compiled.cli
}, 60000)
afterAll(async () => {
  if (inheritedCli === undefined) delete process.env.AGENTMUX_TEST_OBJECT_CLI
  else process.env.AGENTMUX_TEST_OBJECT_CLI = inheritedCli
  if (compiledDirectory) await rm(compiledDirectory, { recursive: true, force: true })
  if (process.env.AGENTMUX_NOTE_HISTORY_EVIDENCE) await writeFile(join(process.env.AGENTMUX_NOTE_HISTORY_EVIDENCE, 'cleanup.json'), JSON.stringify({ compiledDirectory, removed: true, perTestFixturesRemovedByAfterEach: true }) + '\n')
})
afterEach(async () => { vi.restoreAllMocks(); for (const dispose of close.splice(0).reverse()) await dispose() })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'note-history-')))
  close.push(() => rm(root, { recursive: true, force: true }))
  const workspace: WorkspaceRecord = { id: 'original-workspace', hostId: 'local', path: root, name: 'History', kind: 'folder' }
  const files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' }) as never)
  close.push(() => files.dispose())
  const metadata = new AgentMuxNotebookStore(join(root, 'notebooks.root.json'))
  const writer = new NoteFileWriter(files, undefined, metadata), path = 'original.note.md'
  const resource = { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: root, path }
  const query = { noteId: 'original-note', resource }
  const body = (text: string) => serializeNoteDocument(newNoteDocument(text, query.noteId, 'original-block'))
  return { root, workspace, path, files, writer, metadata, query, body }
}
async function storedMetadata(f: Awaited<ReturnType<typeof fixture>>) {
  const root = JSON.parse(await readFile(f.metadata.path, 'utf8'))
  expect(root.schema).toBe('agentmux.notebook.files.v1')
  const originals = Object.values(root.originals) as Array<{ noteId: string; resource: unknown; metadata: string }>
  expect(originals).toHaveLength(1)
  const original = originals[0]!
  expect(original).toMatchObject({ noteId: f.query.noteId, resource: f.query.resource })
  const path = join(f.metadata.path + '.files', 'metadata', original.metadata + '.json')
  return { root, original, path, value: JSON.parse(await readFile(path, 'utf8')) }
}
it('records distinct immutable ABA events and current trusted author even when old bytes return', async () => {
  const f = await fixture(), first = await f.writer.write(f.workspace, { path: f.path, content: f.body('Alpha'), expectedRevision: null }, { actor: person })
  expect(first.status).toBe('written'); if (first.status !== 'written') throw Error('Original create must publish')
  const second = await f.writer.write(f.workspace, { path: f.path, content: f.body('Bravo'), expectedRevision: first.revision }, { actor: agent })
  expect(second.status).toBe('written'); if (second.status !== 'written') throw Error('Second edit must publish')
  const third = await f.writer.write(f.workspace, { path: f.path, content: first.content ?? f.body('Alpha'), expectedRevision: second.revision }, { actor: agent })
  expect(third).toMatchObject({ status: 'written', revision: first.revision, noteHistory: { status: 'committed' }, noteAttribution: { status: 'recorded' } })
  const history = await f.metadata.readHistory(f.query)
  expect(history.entries).toHaveLength(3)
  expect(new Set(history.entries.map(e => e.eventId)).size).toBe(3)
  expect(history.entries.map(e => e.revision)).toEqual([first.revision, second.revision, first.revision])
  expect(history.entries.map(e => e.status)).toEqual(['committed', 'committed', 'committed'])
  const detail = await f.metadata.readHistory({ ...f.query, eventId: history.entries[0]!.eventId, includeContent: true })
  expect(detail.entries).toHaveLength(1); expect(detail.entries[0]!.beforeContent).toContain('Bravo')
  const current = await f.writer.read(f.workspace, f.path)
  expect(current).toMatchObject({ status: 'read', document: { noteProvenance: { status: 'recorded', blocks: { 'original-block': { created: { actor: person }, lastEdited: { actor: agent } } } } } })
  const conflict = await f.writer.write(f.workspace, { path: f.path, content: f.body('Stale client'), expectedRevision: second.revision }, { actor: person })
  expect(conflict).toMatchObject({ status: 'conflict', noteHistory: { status: 'not-applied' } })
  expect(await f.writer.read(f.workspace, f.path)).toMatchObject({ status: 'read', document: { noteProvenance: { status: 'recorded', blocks: { 'original-block': { lastEdited: { actor: agent } } } } } })
  // An external return to another historical digest is not a current trusted write.
  await writeFile(join(f.root, f.path), second.content ?? f.body('Bravo'))
  expect(await f.writer.read(f.workspace, f.path)).toMatchObject({ status: 'read', document: { noteProvenance: { status: 'unconfirmed', blocks: { 'original-block': { created: { actor: person }, lastEdited: null } } } } })
})
it('groups continuous same-author activity, paginates metadata and never returns private fingerprints', async () => {
  const f = await fixture(); let revision: string | null = null
  for (const [text, actor] of [['One', agent], ['Two', agent], ['Three', person]] as const) {
    const result = await f.writer.write(f.workspace, { path: f.path, content: f.body(text), expectedRevision: revision }, { actor })
    expect(result.status).toBe('written'); if (result.status !== 'written') throw Error('Write must publish'); revision = result.revision
  }
  const all = await f.metadata.readHistory(f.query)
  expect(all.entries).toHaveLength(3); expect(all.batches).toHaveLength(2)
  expect(all.entries[1]!.batchId).toBe(all.entries[2]!.batchId)
  expect(all.entries[0]!.batchId).not.toBe(all.entries[1]!.batchId)
  expect(all.entries.every(entry => !Object.hasOwn(entry, 'content') && !Object.hasOwn(entry, 'beforeContent') && !Object.hasOwn(entry, 'requestFingerprint'))).toBe(true)
  const page = await f.metadata.readHistory({ ...f.query, limit: 1 })
  expect(page.entries).toHaveLength(1); expect(page.hasMore).toBe(true)
  const next = await f.metadata.readHistory({ ...f.query, limit: 1, before: page.entries[0]!.sequence })
  expect(next.entries[0]!.eventId).toBe(all.entries[1]!.eventId)
  const bodies = await readdir(join(f.metadata.path + '.files', 'bodies'))
  expect(bodies.sort()).toEqual([...new Set(all.entries.map(entry => entry.revision!.slice(7) + '.md'))].sort())
  expect(bodies).toHaveLength(3)
})
it('keeps a successful body save usable when history preparation is unavailable', async () => {
  const f = await fixture(); vi.spyOn(f.metadata, 'recordHistory').mockRejectedValueOnce(new Error('History storage unavailable'))
  const result = await f.writer.write(f.workspace, { path: f.path, content: f.body('Saved original'), expectedRevision: null }, { actor: person })
  expect(result).toMatchObject({ status: 'written', noteHistory: { status: 'unconfirmed', reason: 'History storage unavailable' } })
  expect(await readFile(join(f.root, f.path), 'utf8')).toContain('Saved original')
})
it('retains a prepared event after body success and never certifies it from matching bytes', async () => {
  const f = await fixture(), record = f.metadata.recordHistory.bind(f.metadata); let writes = 0
  vi.spyOn(f.metadata, 'recordHistory').mockImplementation(async value => { if (++writes === 2) throw Error('History outcome fsync unavailable'); return record(value) })
  const result = await f.writer.write(f.workspace, { path: f.path, content: f.body('Durable body'), expectedRevision: null }, { actor: agent })
  expect(result).toMatchObject({ status: 'written', noteHistory: { status: 'unconfirmed', eventId: expect.any(String) } })
  const eventId = result.noteHistory?.eventId; expect(eventId).toBeTypeOf('string'); if (!eventId) throw Error('Prepared event must remain addressable')
  const history = await new AgentMuxNotebookStore(f.metadata.path).readHistory({ ...f.query, eventId, includeContent: true })
  expect(history.entries).toHaveLength(1); expect(history.entries[0]!.status).toBe('prepared')
  expect(noteHistoryRevision(await readFile(join(f.root, f.path), 'utf8'))).toBe(history.entries[0]!.revision)
  expect((await f.metadata.readHistory(f.query)).entries[0]!.status).toBe('prepared')
})
it('retains the exact prepared event address when its reply is lost after durable publication', async () => {
  const f = await fixture(), record = f.metadata.recordHistory.bind(f.metadata)
  vi.spyOn(f.metadata, 'recordHistory').mockImplementationOnce(async value => { await record(value); throw Error('Original prepare reply lost after commit') })
  const result = await f.writer.write(f.workspace, { path: f.path, content: f.body('Saved despite missing prepare reply'), expectedRevision: null }, { actor: agent })
  expect(result).toMatchObject({ status: 'written', noteHistory: { status: 'unconfirmed', eventId: expect.any(String), batchId: expect.any(String) } })
  const selected = await f.metadata.readHistory({ ...f.query, eventId: result.noteHistory!.eventId! })
  expect(selected.entries).toEqual([expect.objectContaining({ eventId: result.noteHistory!.eventId, status: 'prepared' })])
  expect(await readFile(join(f.root, f.path), 'utf8')).toContain('Saved despite missing prepare reply')
})
it('keeps acknowledged missing history unknown without resetting it or blocking ordinary body saves', async () => {
  const f = await fixture(), result = await f.writer.write(f.workspace, { path: f.path, content: f.body('Retain original'), expectedRevision: null }, { actor: person })
  expect(result.status).toBe('written'); if (result.status !== 'written') throw Error('Seed must publish')
  const before = await f.metadata.read(), stored = await storedMetadata(f), rootBefore = await readFile(f.metadata.path)
  await rm(stored.path)
  const reopened = new AgentMuxNotebookStore(f.metadata.path)
  await expect(reopened.readHistory(f.query)).rejects.toMatchObject({ code: 'NOTEBOOK_READ_UNCONFIRMED' })
  expect(await reopened.read()).toEqual(before)
  expect(await f.writer.read(f.workspace, f.path)).toMatchObject({ status: 'read', document: { content: expect.stringContaining('Retain original'), noteProvenance: { status: 'unconfirmed' } } })
  const edited = await f.writer.write(f.workspace, { path: f.path, content: f.body('Healthy body still saves'), expectedRevision: result.revision }, { actor: person })
  expect(edited).toMatchObject({ status: 'written', noteHistory: { status: 'unconfirmed' } })
  await expect(readFile(stored.path)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(f.metadata.path)).toEqual(rootBefore)
})
it('keeps foreign historical attribution out of an otherwise readable original Note', async () => {
  const f = await fixture(), result = await f.writer.write(f.workspace, { path: f.path, content: f.body('Original identity'), expectedRevision: null }, { actor: person })
  expect(result).toMatchObject({ status: 'written', noteHistory: { status: 'committed' } })
  const stored = await storedMetadata(f), entry = stored.value.history[0]
  entry.provenance.noteId = 'foreign-note'; entry.provenance.resource.path = 'foreign.note.md'
  entry.provenance.blocks['original-block'].lastEdited.actor = { kind: 'agent', id: 'foreign-forged-author' }
  // Publish a checksum-valid foreign history. A checksum rejection alone would
  // not prove the identity fence, nor preserve independent trusted creators.
  const bytes = JSON.stringify(stored.value) + '\n'
  stored.original.metadata = createHash('sha256').update(bytes).digest('hex')
  await writeFile(join(f.metadata.path + '.files', 'metadata', stored.original.metadata + '.json'), bytes)
  await writeFile(f.metadata.path, JSON.stringify(stored.root) + '\n')
  const read = await f.writer.read(f.workspace, f.path)
  expect(read).toMatchObject({ status: 'read', document: { content: expect.stringContaining('Original identity'), noteProvenance: { status: 'unconfirmed', blocks: { 'original-block': { created: { actor: person }, lastEdited: null } } } } })
  expect(JSON.stringify(read)).not.toContain('foreign-forged-author')
})
it('reads the same committed historical content in an independent process without seeding it again', async () => {
  const f = await fixture(), result = await f.writer.write(f.workspace, { path: f.path, content: f.body('Survives process exit'), expectedRevision: null }, { actor: agent })
  expect(result).toMatchObject({ status: 'written', noteHistory: { status: 'committed' } })
  const source = 'const {AgentMuxNotebookStore}=await import(process.argv[1]); const store=new AgentMuxNotebookStore(process.argv[2]); console.log(JSON.stringify(await store.readHistory(JSON.parse(process.argv[3]))));'
  const child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source, pathToFileURL(compiled.notebookStore).href, f.metadata.path, JSON.stringify({ ...f.query, eventId: result.noteHistory?.eventId, includeContent: true })])
  const restored = JSON.parse(child.stdout)
  expect(restored.entries).toHaveLength(1); expect(restored.entries[0]).toMatchObject({ eventId: result.noteHistory?.eventId, actor: agent, status: 'committed' })
  expect(restored.entries[0].content).toContain('Survives process exit')
})
it('runs executable CLI write and history query through the real service, exact Host owner and durable files', async () => {
  const f = await fixture(), catalog = { zones: [{ zoneId: 'original-zone', workspaceId: f.workspace.id, kind: 'directory', hostId: 'local', directoryPath: f.root }], bindings: [] }
  const port = new FileReadOwner({ catalog: async () => catalog as never, workspace: () => f.workspace,
    files: { read: f.writer.read.bind(f.writer), listFiles: f.files.listFiles.bind(f.files), write: f.writer.write.bind(f.writer), history: f.writer.history.bind(f.writer) } })
  const socketPath = join(f.root, 'control.sock'), server = new AgentMuxControlServer({ socketPath, files: port, coreClients: () => [] })
  await server.start(); close.push(() => server.stop())
  const environment = objectCliEnvironment(f.root, { AGENTMUX_CONTROL_SOCKET: socketPath })
  const original = await f.writer.write(f.workspace, { path: f.path, content: f.body('Before CLI'), expectedRevision: null }, { actor: person })
  expect(original.status).toBe('written'); if (original.status !== 'written') throw Error('Seed write must publish')
  const resource = { ...f.query.resource, zoneId: 'original-zone', zonePath: f.root }
  const target = ['--zone', 'original-zone', '--path', f.path, '--resource', JSON.stringify(resource)]
  const write = await runCompiledObjectCli(['file', 'write', ...target, '--expected-revision', original.revision], environment, f.body('Edited through real CLI'))
  expect(write.code, write.stderr).toBe(0)
  const history = await runCompiledObjectCli(['file', 'history', ...target, '--note', f.query.noteId], environment)
  expect(history.code, history.stderr).toBe(0)
  const response = JSON.parse(history.stdout)
  expect(response.result.result.entries).toHaveLength(2)
  const selected = response.result.result.entries[0]
  expect(selected).toMatchObject({ status: 'committed', actor: { kind: 'user' } })
  expect(selected).not.toHaveProperty('content')
  const detail = await runCompiledObjectCli(['file', 'history', ...target, '--note', f.query.noteId, '--event-id', selected.eventId, '--content'], environment)
  expect(detail.code, detail.stderr).toBe(0)
  expect(JSON.parse(detail.stdout).result.result.entries).toEqual([expect.objectContaining({ eventId: selected.eventId, content: expect.stringContaining('Edited through real CLI') })])
  expect(await readFile(join(f.root, f.path), 'utf8')).toContain('Edited through real CLI')
})
