import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, rename } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AgentMuxNotebookStore, AgentMuxNotesStorage, type NotebookChange } from '@agentmux/core/notebook-store'
import { AgentMuxSpatialStateStore, spatialCatalog } from '@agentmux/core/spatial-state'
import { AgentMuxControlServer } from '../../../../packages/core/src/public-rpc-server'
import type { FileShareParams, FileWriteParams } from '@agentmux/core/files'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../../packages/core/test/helpers/object-cli-rpc'
import { WorkspaceFiles } from '../../src/main/workspace-files'
import { NoteFileWriter } from '@agentmux/host/note-file-writer'
import { NoteSharedBlockOwner } from '@agentmux/host/note-shared-block-owner'
import { FileReadOwner } from '@agentmux/host/file-read-owner'
import { NotesStorageOwner } from '../../src/main/notes-storage-owner'
import { ConfigOwner } from '../../src/main/config-owner'
import { NotebookObservationOwner } from '@agentmux/host/notebook-observation-owner'
import { newNoteDocument, readNoteDocument, serializeNoteDocument } from '../../src/shared/note-document'
import type { AppConfig, WorkspaceFileWriteInput, WorkspaceRecord } from '../../src/shared/contracts'
import { CONFIG_VERSION } from '../../src/shared/contracts'

const [mode, library, environmentRoot, adapterPath] = process.argv.slice(2)
assert(mode === 'writer' || mode === 'reader'); assert(library && environmentRoot && adapterPath)
await mkdir(environmentRoot, { recursive: true })
assert.deepEqual(await readdir(environmentRoot), [], 'Each process starts with an empty environment, never a copied profile')
const workspace: WorkspaceRecord = { id: '__notes__', hostId: 'local', path: library, name: 'Private saved library', kind: 'folder' }
const user = { kind: 'user' as const, id: 'original-person' }, agent = { kind: 'agent' as const, id: 'original-research-agent' }
const storage = new AgentMuxNotesStorage(join(environmentRoot, 'state/notes-location.json'), library)
assert.equal(await storage.hasLocation(), false)
const metadata = new AgentMuxNotebookStore(undefined, storage)
let config: AppConfig = { version: CONFIG_VERSION, hosts: [{ id: 'local', kind: 'local', label: 'Private local host' }], workspaces: [workspace], executors: {}, appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
const configOwner = new ConfigOwner({ read: () => config, save: async next => next, publish: next => { config = next } })
const spatialState = new AgentMuxSpatialStateStore(join(environmentRoot, 'state/spatial.json'))
await spatialState.commit({ expectedRevision: 0, graph: { spaces: [], zones: [{ zoneId: 'library-zone', workspaceId: workspace.id, kind: 'directory', hostId: 'local', directoryPath: library, branch: null }], bindings: [], tabs: [], regions: [], layouts: {}, tabLayouts: {}, resources: {} } })
const notesStorageOwner = new NotesStorageOwner(configOwner, spatialState, () => {}, storage)
let loseReceipt = false
const files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' }) as never, { localWriteFault: () => loseReceipt ? 'receipt' : undefined })
const observation = new NotebookObservationOwner({ workspace: id => config.workspaces.find(item => item.id === id), files, metadata })
const noteFileWriter = new NoteFileWriter(files, { state: () => metadata.read(), owner: observation }, metadata)
let shared!: NoteSharedBlockOwner
const createPublicFiles = (await import(pathToFileURL(adapterPath).href)).default
const publicFiles: FileReadOwner = createPublicFiles({ FileReadOwner, noteFileWriter, files, notesStorageOwner, config, spatialState, spatialCatalog,
  noteSharedBlocks: { share: (...args: Parameters<NoteSharedBlockOwner['share']>) => shared.share(...args), inspectShare: (...args: Parameters<NoteSharedBlockOwner['inspectShare']>) => shared.inspectShare(...args), undoShare: (...args: Parameters<NoteSharedBlockOwner['undoShare']>) => shared.undoShare(...args) },
  args: { scratchTopics: { readForDirectory: () => { throw Error('This saved library is not a Scratch alias') } } } })
shared = new NoteSharedBlockOwner({ files: { read: publicFiles.read.bind(publicFiles), write: publicFiles.write.bind(publicFiles), createShared: publicFiles.createShared.bind(publicFiles), writeInverse: publicFiles.writeSharedInverse.bind(publicFiles) }, historyOperation: metadata.readHistoryOperation.bind(metadata), withWriteLease: metadata.runWithWriteLease.bind(metadata) })
const server = new AgentMuxControlServer({ socketPath: join(environmentRoot, 'control.sock'), files: publicFiles, notebookStore: metadata, notebookObservation: observation, coreClients: () => [] })
const commands: unknown[] = []
await server.start()
const cliEnvironment = objectCliEnvironment(environmentRoot, { AGENTMUX_RPC_ENDPOINT: 'unix:' + server.path })
async function cli(args: string[], input = '', expectedCode = 0, extraEnvironment: NodeJS.ProcessEnv = {}) {
  const result = await runCompiledObjectCli(args, { ...cliEnvironment, ...extraEnvironment }, input)
  commands.push({ args, code: result.code, stdout: result.stdout, stderr: result.stderr })
  assert.equal(result.code, expectedCode, JSON.stringify(args) + '\n' + result.stderr + result.stdout)
  if (result.stdout) return JSON.parse(result.stdout)
  // CLI business errors use stderr; partial operation receipts use stdout.
  assert.equal(expectedCode, 1, 'A successful CLI request must return its receipt on stdout')
  const failure = JSON.parse(result.stderr); assert.equal(failure.ok, false)
  return failure
}
const resource = (path: string) => ({ hostId: 'local', workspaceId: workspace.id, workspacePath: library, zoneId: 'library-zone', zonePath: library, path })
const target = (path: string) => ['--zone', 'library-zone', '--path', path, '--resource', JSON.stringify(resource(path))]
async function fileRead(path: string) {
  const reply = (await cli(['file', 'read', '--zone', 'library-zone', '--path', path, '--host', 'local', '--workspace', workspace.id, '--workspace-path', library])).result
  assert.equal(reply.result.status, 'read'); assert.deepEqual(reply.resource, resource(path))
  const parsed = readNoteDocument(reply.result.document.content); assert.equal(parsed.status, 'valid')
  return reply
}
async function catalogWrite(operationId: string, change: NotebookChange) {
  const state = (await cli(['notebook', 'ls'])).result.state
  return (await cli(['notebook', 'apply', '--revision', String(state.revision), '--operation-id', operationId, '--change-json', JSON.stringify(change)])).result.state
}
async function save(input: WorkspaceFileWriteInput, actor = user as typeof user | typeof agent) {
  return notesStorageOwner.write(workspace, input, actual => noteFileWriter.write(actual, input, { actor }))
}
async function snapshot() {
  const state = (await cli(['notebook', 'ls'])).result.state
  const originals: Record<string, unknown> = {}
  for (const [noteId, path] of [['source-note', 'source.note.md'], ['child-note', 'child.note.md'], ['shared-note', 'shared.note.md']]) {
    const read = await fileRead(path!)
    const history = (await cli(['file', 'history', ...target(path!), '--note', noteId!])).result.result
    assert.equal(history.status, 'read'); assert(history.entries.length > 0)
    const entries = []
    for (const entry of history.entries) {
      const detail = (await cli(['file', 'history', ...target(path!), '--note', noteId!, '--event-id', entry.eventId, '--content'])).result.result
      assert.equal(detail.status, 'read'); assert.equal(detail.entries.length, 1)
      entries.push(detail.entries[0])
    }
    originals[noteId!] = { read, history: entries, operations: await Promise.all(history.entries.map((entry: { eventId: string }) => metadata.readHistoryOperation(entry.eventId))) }
  }
  const inspect = (await cli(['file', 'share', 'inspect', '--input', '-'], JSON.stringify({ mode: 'shared', shared: { zoneId: 'library-zone', path: 'shared.note.md', expectedResource: { hostId: 'local', workspaceId: workspace.id, workspacePath: library } } }))).result
  const originalCatalogOperation = (await cli(['notebook', 'inspect', '--operation-id', 'register-child'])).result
  const child = (await cli(['notebook', 'inspect', '--note', 'child-note', '--content'])).result.content
  assert.equal(child.status, 'read')
  return { state, originals, inspect, originalCatalogOperation, child }
}

try {
  await notesStorageOwner.initialize()
  await metadata.read()
  assert.equal(basename((await storage.inspect()).catalogPath), 'notebooks.root.json', 'The original NotesStorage owner must select the file authority')
  assert.equal(metadata.path, join(library, 'notebooks.root.json'))
  let writerUnknown: unknown
  if (mode === 'writer') {
    const source = newNoteDocument('Knowledge from the original researcher', 'source-note', 'source-block', 'Original source')
    source.content.content!.push({ type: 'paragraph', attrs: { blockId: 'source-tail' }, content: [{ type: 'text', text: 'Tail before unknown' }] })
    const child = newNoteDocument('Destination before restart', 'child-note', 'child-block', 'Child page')
    for (const [path, note] of [['source.note.md', source], ['child.note.md', child]] as const) assert.equal((await save({ path, content: serializeNoteDocument(note), expectedRevision: null })).status, 'written')
    const sourceSaved = await fileRead('source.note.md')
    const corrected = await save({ path: 'source.note.md', content: sourceSaved.result.document.content.replace('Knowledge from the original researcher', 'Knowledge refined by the original researcher'), expectedRevision: sourceSaved.result.document.revision, baseContent: sourceSaved.result.document.content, operationId: 'researcher-edit' }, agent)
    assert.equal(corrected.status, 'written')
    await catalogWrite('create-book', { kind: 'create', notebookId: 'original-book', name: 'Recovered knowledge' })
    for (const [noteId, path, title, parentNoteId] of [['source-note', 'source.note.md', 'Original source', null], ['child-note', 'child.note.md', 'Child page', 'source-note']] as const) {
      await catalogWrite('register-' + (noteId === 'child-note' ? 'child' : 'source'), { kind: 'register', notebookId: 'original-book', noteId, title, parentNoteId, resource: { hostId: 'local', workspaceId: workspace.id, workspacePath: library, path } })
    }
    await catalogWrite('follow-child', { kind: 'follow', noteId: 'child-note' })
    const request = async (path: string, operationId: string): Promise<FileWriteParams> => {
      const read = await fileRead(path), content = read.result.document.content
      return { zoneId: 'library-zone', path, expectedResource: read.resource, content, baseContent: content, expectedRevision: read.result.document.revision, operationId }
    }
    const sourceRequest = await request('source.note.md', 'source-before-share'), destination = await request('child.note.md', 'destination-share')
    const parsed = readNoteDocument(destination.content); assert.equal(parsed.status, 'valid')
    if (parsed.status !== 'valid') throw Error('Original destination must parse')
    parsed.note.content.content!.push({ type: 'noteInclude', attrs: { blockId: 'include-block', referenceId: 'original-reference', noteId: 'shared-note', path: 'shared.note.md' } })
    const sharing: FileShareParams = { operationId: 'original-share', destination: { ...destination, content: serializeNoteDocument(parsed.note) }, promotions: [{ operationId: 'promote-original', source: sourceRequest, sourceNoteId: 'source-note', sourceBlockId: 'source-block', referenceId: 'original-reference', shared: { zoneId: 'library-zone', path: 'shared.note.md', expectedResource: resource('shared.note.md'), noteId: 'shared-note', title: 'Shared knowledge' } }] }
    assert.equal((await cli(['file', 'share', '--input', '-'], JSON.stringify(sharing))).result.status, 'committed')
    const beforeUnknown = await fileRead('source.note.md'), content = beforeUnknown.result.document.content
    loseReceipt = true
    writerUnknown = await save({ path: 'source.note.md', expectedRevision: beforeUnknown.result.document.revision, baseContent: content, content: content.replace('Tail before unknown', 'Tail written with missing receipt'), operationId: 'unknown-original' }, agent)
    loseReceipt = false
    assert.equal((writerUnknown as { status: string }).status, 'unknown')
  }
  const restored = await snapshot()
  let continued: unknown
  if (mode === 'reader') {
    // The reader obtains original operation bytes from the library, never an oracle file.
    const unknown = await metadata.readHistoryOperation('unknown-original'); assert(unknown && unknown.operation === 'edit' && unknown.beforeContent !== null)
    const before = await readFile(join(library, 'source.note.md'), 'utf8')
    const repeated = await save({ path: 'source.note.md', expectedRevision: unknown.baseRevision, baseContent: unknown.beforeContent!, content: unknown.content, operationId: unknown.eventId }, agent)
    assert.equal(repeated.status, 'unknown'); assert.equal(await readFile(join(library, 'source.note.md'), 'utf8'), before)
    const original = await fileRead('child.note.md'), content = original.result.document.content
    const changedContent = content.replace('Destination before restart', 'Destination edited after restart')
    const edited = (await cli(['file', 'write', ...target('child.note.md'), '--expected-revision', original.result.document.revision], changedContent)).result
    assert.equal(edited.result.status, 'written'); assert.equal(edited.result.noteHistory.status, 'committed')
    const editedRead = await fileRead('child.note.md')
    assert.equal(editedRead.result.document.content, changedContent); assert.equal(editedRead.result.document.revision, edited.result.revision)
    const stale = (await cli(['file', 'write', ...target('child.note.md'), '--expected-revision', original.result.document.revision], content, 1)).result
    assert.equal(stale.result.status, 'conflict')
    const wrong = await cli(['file', 'write', '--zone', 'library-zone', '--path', 'child.note.md', '--resource', JSON.stringify({ ...resource('child.note.md'), workspaceId: 'foreign-workspace' }), '--expected-revision', edited.result.revision], content, 1)
    assert.equal(wrong.error.code, 'FILE_RESOURCE_MISMATCH')
    const denied = await cli(['file', 'write', ...target('child.note.md'), '--expected-revision', edited.result.revision], content, 1, { AGENTMUX_AGENT_SESSION_ID: 'unissued-agent', AGENTMUX_AGENT_CAPABILITY: 'never-issued' })
    assert.equal(denied.error.code, 'UNKNOWN_AGENT_SESSION')
    assert.equal(await readFile(join(library, 'child.note.md'), 'utf8'), changedContent)
    const root = JSON.parse(await readFile(metadata.path, 'utf8'))
    const metadataOriginal = (Object.values(root.originals) as Array<{ noteId: string; metadata: string }>).find(value => value.noteId === 'source-note')
    assert(metadataOriginal)
    const metadataPath = join(metadata.path + '.files', 'metadata', metadataOriginal.metadata + '.json'), retained = join(environmentRoot, 'retained-metadata.json')
    let missing: unknown
    await rename(metadataPath, retained)
    try {
      const history = (await cli(['file', 'history', ...target('source.note.md'), '--note', 'source-note'], '', 1)).result
      assert.equal(history.result.status, 'unknown'); assert.equal(history.result.code, 'FILE_HISTORY_UNCONFIRMED')
      const readable = await fileRead('source.note.md')
      assert.equal(readable.result.document.content, before); assert.equal(readable.result.document.noteProvenance.status, 'unconfirmed')
      const catalog = (await cli(['notebook', 'ls'])).result.state
      assert.deepEqual(catalog, restored.state)
      missing = { history, readable, catalog }
    } finally { await rename(retained, metadataPath) }
    continued = { repeated, edited, editedRead, stale, wrong, denied, missing, history: (await cli(['file', 'history', ...target('child.note.md'), '--note', 'child-note'])).result }
  }
  console.log(JSON.stringify({ mode, pid: process.pid, environmentRoot, library, freshLocator: true, catalogPath: metadata.path, restored, writerUnknown, continued, commands }))
} finally { await server.stop(); await files.dispose() }
