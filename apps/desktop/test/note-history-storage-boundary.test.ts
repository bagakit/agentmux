import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { AgentMuxNotebookStore, AgentMuxNotesStorage } from '@agentmux/core/notebook-store'
import { AgentMuxSpatialStateStore, spatialCatalog } from '@agentmux/core/spatial-state'
import { FileReadOwner } from '@agentmux/host/file-read-owner'
import { NotesStorageOwner } from '../src/main/notes-storage-owner'
import { ConfigOwner } from '../src/main/config-owner'
import { NoteFileWriter } from '@agentmux/host/note-file-writer'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { newNoteDocument, serializeNoteDocument } from '../src/shared/note-document'
import type { AppConfig, WorkspaceRecord, WorkspaceFileWriteResult } from '../src/shared/contracts'

const cleanup: Array<() => unknown | Promise<unknown>> = []
const person = { kind: 'user' as const, id: 'original-person' }, agent = { kind: 'agent' as const, id: 'original-agent' }
afterEach(async () => { vi.restoreAllMocks(); for (const dispose of cleanup.splice(0).reverse()) await dispose() })

// Execute the actual production injection expression, including its action
// wrappers. A parallel fixture-only wrapper would pass if ipc.ts bypassed it.
function originalPublicFiles(scope: Record<string, unknown>): FileReadOwner {
  const path = fileURLToPath(new URL('../src/main/ipc.ts', import.meta.url))
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const initializers: ts.Expression[] = []
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'publicFiles' && node.initializer) initializers.push(node.initializer)
    ts.forEachChild(node, visit)
  }
  visit(source); expect(initializers).toHaveLength(1)
  const expression = initializers[0]!
  expect(ts.isNewExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === 'FileReadOwner').toBe(true)
  const compiled = ts.transpileModule('const captured = ' + expression.getText(source) + ';', {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext }
  }).outputText
  return new Function(...Object.keys(scope), compiled + '\nreturn captured;')(...Object.values(scope)) as FileReadOwner
}

async function fixture(mode: 'normal' | 'pending' | 'relocated' | 'pinned') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'note-history-storage-')))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const original = join(root, 'original'), target = join(root, 'target'); await mkdir(original); await mkdir(target)
  const workspace: WorkspaceRecord = { id: '__notes__', hostId: 'local', path: original, name: 'Original Notes', kind: 'folder' }
  const path = 'original.note.md', noteId = 'original-note', zoneId = 'original-zone'
  const resource = { hostId: 'local', workspaceId: workspace.id, workspacePath: original, path }
  const storage = new AgentMuxNotesStorage(join(root, 'state', 'notes-location.json'), mode === 'pinned' ? target : original,
    mode === 'pending' ? { beforeSourceCleanup: async () => { throw Error('The original move acknowledgement is unavailable') } } : {})
  const metadata = new AgentMuxNotebookStore(undefined, storage), files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' }) as never)
  cleanup.push(() => files.dispose())
  const noteFileWriter = new NoteFileWriter(files, undefined, metadata)
  const written = (value: WorkspaceFileWriteResult) => { expect(value.status).toBe('written'); if (value.status !== 'written') throw Error('Private original setup must be written'); return value }
  const initialSave = written(await noteFileWriter.write(workspace, { path, expectedRevision: null, content: serializeNoteDocument(newNoteDocument('Original Alpha', noteId, 'first', 'Original')) }, { actor: person }))
  const initial = { ...initialSave, content: await readFile(join(original, path), 'utf8') }
  const currentSave = written(await noteFileWriter.write(workspace, { path, expectedRevision: initial.revision, content: initial.content.replace('Original Alpha', 'Agent Alpha') }, { actor: agent }))
  const current = { ...currentSave, content: await readFile(join(original, path), 'utf8') }
  await metadata.apply({ expectedRevision: 0, operationId: 'register-original', change: { kind: 'register', noteId, title: 'Original', resource } }, person)
  const selected = (await metadata.readHistory({ noteId, resource })).entries[0]!
  let config = { hosts: [], executors: {}, workspaces: [workspace] } as unknown as AppConfig
  const configOwner = new ConfigOwner({ read: () => config, save: async next => next, publish: next => { config = next } })
  const spatialState = new AgentMuxSpatialStateStore(join(root, 'state', 'spatial.json'))
  await spatialState.commit({ expectedRevision: 0, graph: {
    spaces: [{ spaceId: 'original-space', kind: 'folder', name: 'Original', hostId: 'local', directoryPath: original, projectId: null }],
    zones: [{ zoneId, workspaceId: workspace.id, kind: 'directory', hostId: 'local', directoryPath: original, branch: null }],
    bindings: [{ spaceId: 'original-space', zoneId }], tabs: [], regions: [], layouts: {}, tabLayouts: {}, resources: {}
  } })
  const notesStorageOwner = new NotesStorageOwner(configOwner, spatialState, () => {}, storage)
  if (mode === 'pending' || mode === 'relocated') {
    const move = storage.change({ operationId: 'original-move', expectedDirectory: original, directory: target })
    if (mode === 'pending') await expect(move).rejects.toThrow('The original move acknowledgement is unavailable')
    else {
      await move
      // A retained/queued old resource can still have readable original bytes.
      // Its existence is not permission to apply a history action there.
      await writeFile(join(original, path), current.content!)
    }
  }
  const publicFiles = originalPublicFiles({ FileReadOwner, noteFileWriter, files, notesStorageOwner, config, spatialState, spatialCatalog,
    args: { scratchTopics: { readForDirectory: () => { throw Error('This original Notes resource is not a Scratch alias') } } } })
  const common = { zoneId, spaceId: 'original-space', path, expectedResource: { ...resource, zoneId, zonePath: original }, noteId,
    expectedRevision: current.revision, operationId: 'original-action' }
  const run = (action: 'restore' | 'undo') => action === 'restore'
    ? publicFiles.restore({ ...common, eventId: initial.noteHistory!.eventId! }, { actor: person })
    : publicFiles.undo({ ...common, batchId: selected.batchId, batchLastEventId: selected.eventId }, { actor: person })
  const eventIds = [initial.noteHistory!.eventId!, selected.eventId]
  const journal = () => Promise.all(eventIds.map(eventId => metadata.readHistoryOperation(eventId)))
  return { original, target, path, metadata, files, noteFileWriter, storage, run, journal, initial, current }
}

it.each(['restore', 'undo'] as const)('runs healthy %s through the original IPC injection, reentrant Notes lease and durable writer', async action => {
  const f = await fixture('normal'), writes = vi.spyOn(f.files, 'write')
  expect(await f.run(action)).toMatchObject({ result: { status: 'written', content: f.initial.content, noteHistory: { status: 'committed', eventId: 'original-action' } } })
  expect(writes).toHaveBeenCalledTimes(1)
  expect(await readFile(join(f.original, f.path), 'utf8')).toBe(f.initial.content)
  expect(await f.metadata.readHistoryOperation('original-action')).toMatchObject({ status: 'committed', operation: action, actor: person })
})

for (const mode of ['pending', 'relocated', 'pinned'] as const) {
  it.each(['restore', 'undo'] as const)(`retains bytes and history without CAS for %s at the ${mode} original Notes boundary`, async action => {
    const f = await fixture(mode), snapshot = await f.storage.inspect(), before = await f.journal()
    if (mode === 'pending') expect(snapshot.operation).toMatchObject({ operationId: 'original-move', phase: 'committed' })
    else if (mode === 'relocated') { expect(snapshot.operation).toBeNull(); expect(snapshot.resourceChanges).toContainEqual(expect.objectContaining({ from: expect.objectContaining({ workspacePath: f.original }), to: expect.objectContaining({ workspacePath: f.target }) })) }
    else { expect(snapshot.operation).toBeNull(); expect(snapshot.resourceChanges).toEqual([]); expect(snapshot.directory).toBe(f.target) }
    const writes = vi.spyOn(f.files, 'write'), actionCalls = vi.spyOn(f.noteFileWriter, action)
    const result = await f.run(action)
    expect(result).toMatchObject({ result: { status: 'unknown', code: action === 'restore' ? 'FILE_RESTORE_UNCONFIRMED' : 'FILE_UNDO_UNCONFIRMED',
      message: mode === 'pending' ? expect.stringContaining('move needs recovery') : mode === 'relocated' ? expect.stringContaining('confirmed Notes directory') : expect.stringContaining('pinned Notes directory changed') } })
    expect(actionCalls).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled()
    expect(await readFile(join(f.original, f.path), 'utf8')).toBe(f.current.content)
    if (mode !== 'pinned') expect(await readFile(join(f.target, f.path), 'utf8')).toBe(f.current.content)
    expect(await f.journal()).toEqual(before)
    expect(await f.metadata.readHistoryOperation('original-action')).toBeUndefined()
  })
}
