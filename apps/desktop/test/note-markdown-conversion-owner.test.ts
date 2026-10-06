// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentMuxNotesStorage, AgentMuxNotebookStore, applyNotebookChange, emptyNotebookState, type NotesStorageOperation } from '@agentmux/core/notebook-store'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { newNoteDocument, readNoteDocument } from '@agentmux/client-ui/note/note-document'
import { attributeNoteBlocks } from '@agentmux/client-ui/note/note-provenance'
import { NotesStorageOwner } from '../src/main/notes-storage-owner'
import { ConfigOwner } from '../src/main/config-owner'
import type { AppConfig } from '../src/shared/contracts'
import { fixtureTime } from '../scripts/lib/fixture-values.mjs'
import { api } from '../src/renderer/src/lib/api'
import { NotesSettingsPane } from '../src/renderer/src/components/settings/NotesSettingsPane'
vi.hoisted(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true))
const directories: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
const revision = (value: string) => 'sha256:' + createHash('sha256').update(value).digest('hex')
async function fixture(failAcknowledgement = false) {
  const root = await mkdtemp(join(tmpdir(), 'note-format-owner-')); directories.push(root)
  const directory = join(root, 'notes'); await mkdir(directory)
  const resource = { hostId: 'local', workspaceId: '__notes__', workspacePath: directory, path: 'original.note.json' }
  const actor = { kind: 'agent' as const, id: 'original-author-session' }
  const note = attributeNoteBlocks(null, newNoteDocument('原始正文 [[Target]]', 'original-note', 'original-block'), actor, fixtureTime(10))
  const bytes = JSON.stringify(note, null, 2)
  await writeFile(join(directory, resource.path), bytes)
  let catalog = applyNotebookChange(emptyNotebookState(), { operationId: 'original-register', expectedRevision: 0, change: { kind: 'register', noteId: note.noteId, title: 'Original', resource } }, actor, fixtureTime(10))
  catalog = applyNotebookChange(catalog, { operationId: 'original-follow', expectedRevision: catalog.revision, change: { kind: 'follow', noteId: note.noteId } }, actor, fixtureTime(20))
  await writeFile(join(directory, 'notebooks.json'), JSON.stringify(catalog) + '\n')
  let config = { hosts: [], executors: {}, appearance: {}, workspaces: [{ id: '__notes__', name: 'Notes', hostId: 'local', path: directory, kind: 'folder' }] } as unknown as AppConfig
  const configOwner = new ConfigOwner({ read: () => config, save: async value => value, publish: value => { config = value } })
  const spatial = new AgentMuxSpatialStateStore(join(root, 'spatial.json'))
  let fail = failAcknowledgement, owner!: NotesStorageOwner
  const storage = new AgentMuxNotesStorage(join(root, 'state', 'notes-location.json'), directory, { beforeSourceCleanup: async () => {
    if (fail) throw new Error('Host resource acknowledgement unavailable')
    await owner.confirmResources(await storage.inspect())
  } })
  owner = new NotesStorageOwner(configOwner, spatial, () => {}, storage)
  return { root, directory, resource, bytes, note, catalog, owner, storage, configOwner, spatial, release: () => { fail = false } }
}
it('initializes the original owner into Markdown, exact revision attribution and followers, then rejects the old same-Workspace write path', async () => {
  const f = await fixture(), snapshot = await f.owner.initialize()
  const file = await readFile(join(f.directory, 'original.note.md'), 'utf8'), parsed = readNoteDocument(file)
  expect(parsed.status).toBe('valid')
  if (parsed.status !== 'valid') throw new Error(parsed.message)
  expect(parsed.note.noteId).toBe(f.note.noteId)
  expect(parsed.note.content.content?.[0]?.attrs?.blockId).toBe('original-block')
  const store = new AgentMuxNotebookStore(undefined, f.storage), catalog = await store.read()
  expect(catalog.pages['original-note']?.followers).toEqual(f.catalog.pages['original-note']?.followers)
  expect(catalog.operations['original-follow']).toEqual(f.catalog.operations['original-follow'])
  const change = snapshot.resourceChanges.find(change => change.noteId === f.note.noteId)!
  expect(change.conversion).toEqual({ sourceRevision: revision(f.bytes), targetRevision: revision(file) })
  const provenance = await store.readProvenance({ noteId: f.note.noteId, resource: change.to, revision: revision(file), blockIds: ['original-block'] })
  expect(provenance.status).toBe('recorded')
  expect(provenance.blocks['original-block']?.created).toEqual(f.note.content.content?.[0]?.attrs?.provenance.created)
  await expect(readFile(join(f.directory, f.resource.path))).rejects.toMatchObject({ code: 'ENOENT' })
  const backup = join(f.directory, '.agentmux-note-backups', f.resource.path + '.' + revision(f.bytes).slice(7) + '.bak')
  expect(await readFile(backup, 'utf8')).toBe(f.bytes)
  const save = vi.fn(async () => 'written')
  await expect(f.owner.write(f.configOwner.current.workspaces[0]!, { path: f.resource.path, content: f.bytes, expectedRevision: revision(f.bytes) }, save)).rejects.toMatchObject({ code: 'NOTE_RESOURCE_CHANGED' })
  expect(save).not.toHaveBeenCalled()
  await f.owner.write(f.configOwner.current.workspaces[0]!, { path: 'original.note.md', content: file, expectedRevision: revision(file) }, save)
  expect(save).toHaveBeenCalledOnce()
  const reopened = new NotesStorageOwner(f.configOwner, f.spatial, () => {}, new AgentMuxNotesStorage(f.storage.locatorPath, f.directory))
  await reopened.initialize()
  expect(await readFile(join(f.directory, 'original.note.md'), 'utf8')).toBe(file)
})
it('retains last original bytes after publication when Host acknowledgement fails and resumes the same operation with a fresh owner', async () => {
  const f = await fixture(true)
  await expect(f.owner.initialize()).rejects.toThrow('acknowledgement unavailable')
  const pending = (await f.storage.inspect()).operation!
  expect(pending.phase).toBe('committed')
  expect(await readFile(join(f.directory, f.resource.path), 'utf8')).toBe(f.bytes)
  expect(await readFile(pending.files[0]!.backup!, 'utf8')).toBe(f.bytes)
  f.release()
  await f.owner.initialize()
  expect((await f.storage.inspect(pending.operationId)).operation?.operationId).toBe(pending.operationId)
  await expect(readFile(join(f.directory, f.resource.path))).rejects.toMatchObject({ code: 'ENOENT' })
})
it('does not replace an occupied Markdown target or delete the original legacy Note', async () => {
  const f = await fixture()
  await writeFile(join(f.directory, 'original.note.md'), 'unrelated original bytes')
  const snapshot = await f.owner.initialize()
  expect(snapshot.conversionIssues).toContainEqual(expect.objectContaining({ noteId: f.note.noteId, resource: f.resource, message: expect.stringContaining('different bytes') }))
  expect(await readFile(join(f.directory, 'original.note.md'), 'utf8')).toBe('unrelated original bytes')
  expect(await readFile(join(f.directory, f.resource.path), 'utf8')).toBe(f.bytes)
})
it('retains both legacy originals when another file claims the same Note identity', async () => {
  const f = await fixture()
  await writeFile(join(f.directory, 'duplicate.note.json'), f.bytes)
  const result = await f.owner.initialize()
  expect(result.conversionIssues?.filter(issue => issue.noteId === f.note.noteId)).toHaveLength(2)
  expect(await readFile(join(f.directory, f.resource.path), 'utf8')).toBe(f.bytes)
  expect(await readFile(join(f.directory, 'duplicate.note.json'), 'utf8')).toBe(f.bytes)
  await expect(readFile(join(f.directory, 'original.note.md'))).rejects.toMatchObject({ code: 'ENOENT' })
})
it('keeps remote and unavailable originals observable while healthy local conversion and saving remain available', async () => {
  const f = await fixture(), remote = { ...f.resource, hostId: 'original-remote', workspaceId: 'remote-workspace', path: 'remote.note.json' }
  let catalog = applyNotebookChange(f.catalog, { operationId: 'register-remote', expectedRevision: f.catalog.revision, change: { kind: 'register', noteId: 'remote-note', title: 'Original remote', resource: remote } }, { kind: 'user', id: 'original-person' }, fixtureTime(30))
  catalog = applyNotebookChange(catalog, { operationId: 'register-unavailable', expectedRevision: catalog.revision, change: { kind: 'register', noteId: 'unavailable-note', title: 'Temporarily unavailable', resource: { ...f.resource, path: 'missing.note.json' } } }, { kind: 'user', id: 'original-person' }, fixtureTime(40))
  await writeFile(join(f.directory, 'notebooks.json'), JSON.stringify(catalog) + '\n')
  const observed = await f.owner.initialize(), store = new AgentMuxNotebookStore(undefined, f.storage)
  expect(readNoteDocument(await readFile(join(f.directory, 'original.note.md'), 'utf8')).status).toBe('valid')
  expect((await store.read()).pages['remote-note']?.resource).toEqual(remote)
  expect(observed.conversionIssues).toEqual(expect.arrayContaining([
    expect.objectContaining({ noteId: 'remote-note', resource: remote, code: 'NOTE_CONVERSION_REMOTE' }),
    expect.objectContaining({ noteId: 'unavailable-note', code: 'ENOENT' })
  ]))
  const save = vi.fn(async () => 'saved')
  await f.owner.write(f.configOwner.current.workspaces[0]!, { path: 'original.note.md', content: 'healthy draft', expectedRevision: 'saved' }, save)
  expect(save).toHaveBeenCalledOnce()
  const reopened = new AgentMuxNotesStorage(f.storage.locatorPath, f.directory)
  expect((await reopened.inspect()).conversionIssues).toEqual(observed.conversionIssues)
})
it('adopts healthy scratch Markdown while retaining a bad local original, then adopts that same identity after explicit recovery', async () => {
  const f = await fixture(), scratchPath = join(f.root, 'scratch'), statePath = join(f.root, 'state')
  await mkdir(scratchPath); await mkdir(statePath, { recursive: true })
  const good = { ...f.resource, workspaceId: '__scratch__', workspacePath: scratchPath }
  const bad = { ...good, path: 'bad.note.json' }
  await writeFile(join(scratchPath, good.path), f.bytes)
  const unsupported = newNoteDocument('Keep original unsupported body', 'bad-original-note', 'bad-original-block')
  unsupported.content.content![0]!.attrs!.futureUnsupported = 'Retain these original bytes'
  const badBytes = JSON.stringify(unsupported)
  await writeFile(join(scratchPath, bad.path), badBytes)
  let catalog = applyNotebookChange(f.catalog, { operationId: 'old-scratch-resource', expectedRevision: f.catalog.revision, change: { kind: 'relocate', noteId: f.note.noteId, from: f.resource, resource: good } }, { kind: 'user', id: 'original-person' }, fixtureTime(60))
  catalog = applyNotebookChange(catalog, { operationId: 'old-bad-page', expectedRevision: catalog.revision, change: { kind: 'register', noteId: 'bad-original-note', title: 'Bad original', resource: bad } }, { kind: 'user', id: 'original-person' }, fixtureTime(70))
  await writeFile(join(statePath, 'notebooks.json'), JSON.stringify(catalog) + '\n')
  await rm(join(f.directory, 'notebooks.json')); await rm(join(f.directory, f.resource.path))
  await f.configOwner.update(config => ({ ...config, workspaces: [...config.workspaces, { id: '__scratch__', name: 'Original scratch', hostId: 'local', path: scratchPath, kind: 'folder' as const }] }))
  const snapshot = await f.owner.initialize(), store = new AgentMuxNotebookStore(undefined, f.storage)
  const first = await store.read()
  expect(first.pages[f.note.noteId]?.resource).toEqual({ ...f.resource, path: 'original.note.md' })
  expect(first.pages['bad-original-note']?.resource).toEqual(bad)
  expect(snapshot.conversionIssues?.find(issue => issue.noteId === 'bad-original-note')?.resource).toEqual(bad)
  expect(await readFile(join(scratchPath, bad.path), 'utf8')).toBe(badBytes)
  const saved = await readFile(join(f.directory, 'original.note.md'), 'utf8'), save = vi.fn(async () => 'written')
  await f.owner.write(f.configOwner.current.workspaces.find(workspace => workspace.id === '__notes__')!, { path: 'original.note.md', content: saved, expectedRevision: revision(saved) }, save)
  expect(save).toHaveBeenCalledOnce()
  await writeFile(join(scratchPath, bad.path), JSON.stringify(newNoteDocument('Recovered original body', 'bad-original-note', 'bad-original-block')))
  const recovered = await f.owner.initialize(), second = await store.read()
  expect(second.pages['bad-original-note']?.resource).toEqual({ ...f.resource, path: 'bad.note.md' })
  expect(recovered.conversionIssues ?? []).toEqual([])
  expect(readNoteDocument(await readFile(join(f.directory, 'bad.note.md'), 'utf8')).status).toBe('valid')
})
it.each([
  { phase: 'prepared' as const, copy: false, source: true },
  { phase: 'prepared' as const, copy: true, source: true },
  { phase: 'committed' as const, copy: true, source: true },
  { phase: 'committed' as const, copy: true, source: false }
])('recovers the original JSON move operation ($phase, copied=$copy, source=$source) without replacing its catalog operation identity', async scenario => {
  const f = await fixture(), target = join(f.root, 'old-move-destination'); await mkdir(target)
  const destination = { ...f.resource, workspacePath: target }
  const operationId = 'original-pending-move', sourceCatalogBytes = JSON.stringify(f.catalog) + '\n'
  const movedCatalog = applyNotebookChange(f.catalog, { operationId: operationId + ':' + f.note.noteId, expectedRevision: f.catalog.revision,
    change: { kind: 'relocate', noteId: f.note.noteId, from: f.resource, resource: destination } }, { kind: 'user', id: 'notes-directory-owner' }, fixtureTime(50))
  if (scenario.copy) await writeFile(join(target, destination.path), f.bytes)
  if (!scenario.source) await rm(join(f.directory, f.resource.path))
  if (scenario.phase === 'committed') await writeFile(join(target, 'notebooks.json'), JSON.stringify(movedCatalog) + '\n')
  const operation: NotesStorageOperation = { operationId, expectedDirectory: f.directory, directory: target, phase: scenario.phase, sourceCatalog: join(f.directory, 'notebooks.json'),
    sourceCatalogHash: revision(sourceCatalogBytes).slice(7), catalog: movedCatalog, resourceChanges: [{ noteId: f.note.noteId, from: f.resource, to: destination }],
    files: [{ source: join(f.directory, f.resource.path), destination: join(target, destination.path), hash: revision(f.bytes).slice(7) }] }
  await mkdir(join(f.root, 'state'), { recursive: true })
  await writeFile(f.storage.locatorPath, JSON.stringify({ schemaVersion: 1, directory: scenario.phase === 'prepared' ? f.directory : target, operations: { [operationId]: operation }, pending: operationId, catalogEstablished: true }) + '\n')
  await f.owner.initialize()
  const recovered = (await f.storage.inspect(operationId)).operation!
  expect(recovered.operationId).toBe(operationId)
  expect(recovered.phase).toBe('committed')
  expect(recovered.kind).toBe('convert')
  const state = await new AgentMuxNotebookStore(undefined, f.storage).read()
  expect(state.operations[operationId + ':' + f.note.noteId]).toEqual(movedCatalog.operations[operationId + ':' + f.note.noteId])
  expect(state.pages[f.note.noteId]?.resource).toEqual({ ...destination, path: 'original.note.md' })
  expect(readNoteDocument(await readFile(join(target, 'original.note.md'), 'utf8')).status).toBe('valid')
  for (const file of recovered.files) {
    expect(await readFile(file.backup!, 'utf8')).toBe(f.bytes)
    await expect(readFile(file.source)).rejects.toMatchObject({ code: 'ENOENT' })
  }
  expect(recovered.files).toHaveLength(Number(scenario.source) + Number(scenario.copy))
})
it('mounted Notes settings shows the exact unavailable Note and retries conversion through the original Host owner', async () => {
  const f = await fixture(), unavailable = { ...f.resource, path: 'missing.note.json' }
  const catalog = applyNotebookChange(f.catalog, { operationId: 'register-missing', expectedRevision: f.catalog.revision, change: { kind: 'register', noteId: 'missing-note', title: 'Missing original', resource: unavailable } }, { kind: 'user', id: 'original-person' }, fixtureTime(60))
  await writeFile(join(f.directory, 'notebooks.json'), JSON.stringify(catalog) + '\n')
  await f.owner.initialize()
  let reading: ReturnType<NotesStorageOwner['inspect']> | undefined, changing: ReturnType<NotesStorageOwner['change']> | undefined
  vi.spyOn(api.notesStorage, 'inspect').mockImplementation(id => reading = f.owner.inspect(id))
  const change = vi.spyOn(api.notesStorage, 'change').mockImplementation(input => changing = f.owner.change(input))
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  try {
    await act(async () => root.render(createElement(NotesSettingsPane, { preferences: undefined, onSave: vi.fn(), onOpenNotes: vi.fn() })))
    expect(reading).toBeDefined()
    await act(async () => { await reading })
    expect(host.textContent).toContain('missing-note')
    expect(host.textContent).toContain('missing.note.json')
    await writeFile(join(f.directory, unavailable.path), JSON.stringify(newNoteDocument('Now available', 'missing-note', 'missing-block')))
    await act(async () => {
      const button = [...host.querySelectorAll('button')].find(button => button.textContent === 'Retry original Note conversion')!
      button.click()
      expect(changing).toBeDefined()
      await changing
      await reading
    })
    expect(readNoteDocument(await readFile(join(f.directory, 'missing.note.md'), 'utf8')).status).toBe('valid')
    expect(change.mock.calls[0]?.[0]).toMatchObject({ directory: f.directory, expectedDirectory: f.directory })
    expect((await f.owner.inspect()).conversionIssues ?? []).toEqual([])
  } finally { await act(async () => root.unmount()); host.remove() }
})
