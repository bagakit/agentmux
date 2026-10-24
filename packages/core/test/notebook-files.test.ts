import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile, cp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxNotebookStore, AgentMuxNotesStorage } from '../src/notebook-store.js'
import { noteHistoryRevision, type NoteHistoryRecord } from '../src/note-history.js'
import { applyNotebookChange, emptyNotebookState } from '../src/notebook-catalog.js'
import { notebookFilesFingerprint, readNotebookFiles } from '../src/notebook-files.js'
import { DatabaseSync } from 'node:sqlite'
import { digest, legacySqliteFixture, changeOriginalMetadata, historicalBodyPath } from './helpers/notebook-files-fixture.js'

const fault = vi.hoisted(() => ({ link: '', rename: '', competingRoot: '', reads: [] as string[], observing: false, changingSql: '', sqlReads: 0, syncTarget: '', syncAttempt: 0, syncFailureAt: 0, syncs: [] as string[], syncObserving: false, clearLocation: '' }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args), sync = handle.sync.bind(handle), path = String(args[0])
      handle.sync = async () => {
        if (fault.syncObserving) fault.syncs.push(path)
        if (path === fault.syncTarget && ++fault.syncAttempt === fault.syncFailureAt) throw Object.assign(new Error('original directory flush interrupted'), { code: 'EIO' })
        return sync()
      }; return handle
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => { if (fault.observing) fault.reads.push(String(args[0])); const bytes = await actual.readFile(...args); if (String(args[0]) === fault.changingSql && ++fault.sqlReads === 2) await actual.writeFile(fault.changingSql + '.sqlite-identity', 'external-identity-change'); return bytes },
    link: async (...args: Parameters<typeof actual.link>) => {
      if (String(args[1]) === fault.link) { fault.link = ''; if (fault.competingRoot) await actual.writeFile(args[1], fault.competingRoot); else throw Object.assign(new Error('original publication interrupted'), { code: 'EIO' }) }
      return actual.link(...args)
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (String(args[1]) === fault.clearLocation) { const location = JSON.parse(await actual.readFile(args[0], 'utf8')); if (location.pending === null && Object.keys(location.operations).length) { fault.clearLocation = ''; throw Object.assign(new Error('location completion interrupted'), { code: 'EIO' }) } }
      if (String(args[1]) === fault.rename) { fault.rename = ''; throw Object.assign(new Error('original replacement interrupted'), { code: 'EIO' }) }; return actual.rename(...args) }
  }
})
const roots: string[] = []
afterEach(async () => { fault.link = ''; fault.rename = ''; fault.competingRoot = ''; fault.observing = false; fault.reads = []; fault.changingSql = ''; fault.sqlReads = 0; fault.syncTarget = ''; fault.syncAttempt = 0; fault.syncFailureAt = 0; fault.syncs = []; fault.syncObserving = false; fault.clearLocation = ''; for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }) })
it('reopens saved original catalog, author and complete historical body using readable library files only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'note-files-authority-')); roots.push(root)
  const path = join(root, 'notebooks.root.json'), store = new AgentMuxNotebookStore(path)
  const resource = { hostId: 'local', workspaceId: 'original', workspacePath: root, path: 'original.note.md' }
  const actor = { kind: 'user' as const, id: 'original-person' }, content = 'Original saved knowledge\n', revision = noteHistoryRevision(content)
  let state = await store.apply({ expectedRevision: 0, operationId: 'register-original', change: { kind: 'register', noteId: 'original-note', resource, title: 'Original' } }, actor)
  state = await store.apply({ expectedRevision: state.revision, operationId: 'follow-original', change: { kind: 'follow', noteId: 'original-note' } }, actor)
  const provenance = { noteId: 'original-note', resource, revision, blocks: { original: { created: { actor, at: 1 }, lastEdited: { actor, at: 1 } } } }
  await store.recordProvenance(provenance)
  const event = await store.recordHistory({ eventId: 'original-event', sequence: 0, batchId: 'original-batch', noteId: 'original-note', resource, originalResource: resource,
    status: 'committed', actor, at: 1, operation: 'edit', parentEventId: null, requestFingerprint: 'original-request', beforeContent: null, baseRevision: null, content, revision, provenance })
  expect(store.path).toBe(path)
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  expect(manifest.schema).toBe('agentmux.notebook.files.v1')
  expect((await readdir(root, { recursive: true })).some(name => String(name).endsWith('.sqlite'))).toBe(false)
  const fresh = new AgentMuxNotebookStore(path)
  expect(await fresh.read()).toEqual(state)
  expect(await fresh.readProvenance({ ...provenance, blockIds: ['original'] })).toMatchObject({ status: 'recorded', blocks: provenance.blocks })
  expect(await fresh.readHistoryOperation(event.eventId)).toEqual(event)
  expect((await fresh.readHistory({ noteId: event.noteId, resource, eventId: event.eventId, includeContent: true })).entries[0]?.content).toBe(content)
})

async function originalSql() {
  const directory = await mkdtemp(join(tmpdir(), 'note-original-sql-')); roots.push(directory)
  const sql = join(directory, 'notebooks.sqlite'), path = join(directory, 'notebooks.root.json')
  const resource = { hostId: 'local', workspaceId: '__notes__', workspacePath: directory, path: 'original.note.md' }, actor = { kind: 'user' as const, id: 'original-person' }
  const content = '---\nschema: agentmux.note.md.v1\nnote-id: original-note\n---\n\nOriginal saved text\n\n^original\n'
  const revision = noteHistoryRevision(content), provenance = { noteId: 'original-note', resource, revision, blocks: { original: { created: { actor, at: 1 }, lastEdited: { actor, at: 2 } } } }
  const state = applyNotebookChange(emptyNotebookState(), { expectedRevision: 0, operationId: 'original-register', change: { kind: 'register', noteId: 'original-note', resource, title: 'Original' } }, actor, 1)
  const event: NoteHistoryRecord = { eventId: 'original-operation', sequence: 1, batchId: 'original-batch', noteId: 'original-note', resource, originalResource: resource,
    actor, status: 'unconfirmed', at: 2, operation: 'edit', parentEventId: null, requestFingerprint: 'original-immutable-request', beforeContent: null, baseRevision: null, content, revision, provenance,
    fileWitness: { device: '12', inode: '13', size: '14', ctimeNs: '15', mtimeNs: '16' } }
  const snapshot = { incarnation: 'original-library', state, provenance: [provenance], history: [event] }
  await legacySqliteFixture(sql, snapshot); await writeFile(join(directory, resource.path), content)
  return { directory, sql, path, resource, actor, content, revision, provenance, event, snapshot }
}
it.each(['catalog', 'provenance', 'history', 'operation'] as const)('imports SQL-only originals on the first real %s read without requiring a write', async first => {
  const f = await originalSql(), sqlBytes = await readFile(f.sql), identity = await readFile(f.sql + '.sqlite-identity'), store = new AgentMuxNotebookStore(f.sql)
  await expect(readFile(join(f.directory, 'notebooks.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  if (first === 'catalog') expect(await store.read()).toEqual(f.snapshot.state)
  else if (first === 'provenance') expect(await store.readProvenance({ ...f.provenance, blockIds: ['original'] })).toMatchObject({ status: 'unconfirmed', blocks: { original: { created: f.provenance.blocks.original.created, lastEdited: null } } })
  else if (first === 'history') expect((await store.readHistory({ noteId: f.event.noteId, resource: f.resource, eventId: f.event.eventId, includeContent: true })).entries[0]).toMatchObject({ content: f.content, status: 'unconfirmed', fileWitness: f.event.fileWitness })
  else expect(await store.readHistoryOperation(f.event.eventId)).toEqual(f.event)
  expect(await readFile(f.sql)).toEqual(sqlBytes); expect(await readFile(f.sql + '.sqlite-identity')).toEqual(identity)
  expect(await readFile(f.sql + '.original-' + digest(sqlBytes))).toEqual(sqlBytes)
  expect(await readFile(f.sql + '.sqlite-identity.original-' + digest(identity))).toEqual(identity)
  const actual = (await readNotebookFiles(f.path))!
  expect(notebookFilesFingerprint(actual)).toBe(notebookFilesFingerprint(f.snapshot))
})
it('does not borrow stale SQL or JSON when an established copied library loses its root and profile', async () => {
  const f = await originalSql(); await new AgentMuxNotebookStore(f.sql).read()
  await writeFile(join(f.directory, 'notebooks.json'), JSON.stringify(emptyNotebookState())); await rm(f.path)
  const fresh = new AgentMuxNotebookStore(undefined, new AgentMuxNotesStorage(join(f.directory, 'new-profile', 'location.json'), f.directory))
  await expect(fresh.read()).rejects.toMatchObject({ code: 'NOTEBOOK_READ_UNCONFIRMED' })
  await expect(fresh.recordHistory({ ...f.event, eventId: 'new-operation', sequence: 0 })).rejects.toMatchObject({ code: 'NOTEBOOK_READ_UNCONFIRMED' })
  expect(await readFile(f.sql)).not.toHaveLength(0); await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' })
})
it.each([false, true])('resumes the exact interrupted export on fresh read, unless original SQL changed: %s', async changed => {
  const f = await originalSql(); fault.link = f.path
  await expect(new AgentMuxNotebookStore(f.sql).read()).rejects.toMatchObject({ code: 'NOTEBOOK_READ_UNCONFIRMED' })
  const pending = await readFile(f.path + '.importing.json')
  expect((await readdir(f.path + '.files')).length).toBeGreaterThan(0)
  if (changed) {
    const db = new DatabaseSync(f.sql)
    try { const state = { ...f.snapshot.state, revision: f.snapshot.state.revision + 1 }; db.prepare('UPDATE notebook_state SET json=?').run(JSON.stringify(state)) } finally { db.close() }
    const bytes = await readFile(f.sql)
    await expect(new AgentMuxNotebookStore(f.sql).read()).rejects.toMatchObject({ code: 'NOTEBOOK_READ_UNCONFIRMED' })
    expect(await readFile(f.path + '.importing.json')).toEqual(pending); expect(await readFile(f.sql)).toEqual(bytes)
    await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' })
  } else {
    const fresh = new AgentMuxNotebookStore(f.sql)
    expect(await fresh.read()).toEqual(f.snapshot.state)
    expect(await fresh.readHistoryOperation(f.event.eventId)).toEqual(f.event)
    await expect(readFile(f.path + '.importing.json')).rejects.toMatchObject({ code: 'ENOENT' })
  }
})
it('never replaces a different root that appears at the first publication boundary', async () => {
  const f = await originalSql(), foreign = JSON.stringify({ original: 'different library bytes must remain' })
  fault.link = f.path; fault.competingRoot = foreign
  await expect(new AgentMuxNotebookStore(f.sql).read()).rejects.toMatchObject({ code: 'NOTEBOOK_READ_UNCONFIRMED' })
  expect(await readFile(f.path, 'utf8')).toBe(foreign)
  expect(await readFile(f.path + '.importing.json', 'utf8')).toContain('original-library')
})
it('isolates exact history and author reads from a damaged catalog and unrelated metadata, with no SQL or historical body scans', async () => {
  const f = await originalSql(), store = new AgentMuxNotebookStore(f.path); await store.read()
  const otherResource = { ...f.resource, path: 'other.note.md' }
  await store.recordProvenance({ ...f.provenance, noteId: 'other-note', resource: otherResource })
  await changeOriginalMetadata(f.path, 'other-note', otherResource, value => { value.provenance = '{corrupt unrelated attribution}' })
  const root = JSON.parse(await readFile(f.path, 'utf8'))
  await writeFile(join(f.path + '.files', 'catalog', root.catalog + '.json'), '{broken catalog')
  fault.observing = true
  const fresh = new AgentMuxNotebookStore(f.path)
  expect((await fresh.readHistory({ noteId: f.event.noteId, resource: f.resource })).entries[0]).toMatchObject({ eventId: f.event.eventId, status: 'unconfirmed' })
  expect((await fresh.readProvenance({ ...f.provenance, blockIds: ['original'] })).blocks.original?.created).toEqual(f.provenance.blocks.original.created)
  expect(fault.reads.filter(path => /\.sqlite|\/bodies\/|\/catalog\//u.test(path))).toEqual([])
  expect((await fresh.readHistoryOperation(f.event.eventId))?.requestFingerprint).toBe(f.event.requestFingerprint)
  await expect(fresh.read()).rejects.toMatchObject({ code: 'NOTEBOOK_READ_UNCONFIRMED' })
  expect(await readFile(join(f.directory, f.resource.path), 'utf8')).toBe(f.content)
})
it('preserves independently confirmed creators when historical author metadata belongs to another original', async () => {
  const f = await originalSql(), store = new AgentMuxNotebookStore(f.path); await store.read()
  await changeOriginalMetadata(f.path, f.event.noteId, f.resource, value => { value.history[0].provenance.resource.path = 'foreign.note.md' })
  expect(await store.readProvenance({ ...f.provenance, blockIds: ['original'] })).toMatchObject({ status: 'unconfirmed', blocks: { original: { created: f.provenance.blocks.original.created, lastEdited: null } } })
  await expect(store.readHistoryOperation(f.event.eventId)).rejects.toMatchObject({ code: 'NOTEBOOK_READ_UNCONFIRMED' })
})
it('keeps catalog and author resources together when root replacement fails, and does not rewrite historical blobs', async () => {
  const f = await originalSql(), store = new AgentMuxNotebookStore(f.path); const before = await store.read(), rootBytes = await readFile(f.path), blob = await readFile(historicalBodyPath(f.path, f.revision))
  fault.rename = f.path
  await expect(store.apply({ expectedRevision: before.revision, operationId: 'interrupted-move', change: { kind: 'relocate', noteId: f.event.noteId, from: f.resource, resource: { ...f.resource, path: 'moved.note.md' } } }, f.actor)).rejects.toMatchObject({ code: 'EIO' })
  expect(await readFile(f.path)).toEqual(rootBytes); expect(await store.read()).toEqual(before)
  expect(await store.readHistoryOperation(f.event.eventId)).toEqual(f.event)
  expect(await readFile(historicalBodyPath(f.path, f.revision))).toEqual(blob)
})
it('keeps operation ambiguity authoritative even when the events belong to distinct original resources', async () => {
  const f = await originalSql(), store = new AgentMuxNotebookStore(f.path); await store.read()
  const foreign = { ...f.resource, path: 'foreign.note.md' }
  const { provenance: _provenance, ...event } = f.event
  await store.recordHistory({ ...event, sequence: 0, noteId: 'foreign-note', resource: foreign })
  await expect(new AgentMuxNotebookStore(f.path).readHistoryOperation(f.event.eventId)).rejects.toMatchObject({ code: 'NOTE_HISTORY_OPERATION_CONFLICT' })
})
it('opens a selected library copied to a new physical location without the old path or profile, retaining external addresses and original operation identities', async () => {
  const f = await originalSql(), store = new AgentMuxNotebookStore(f.path); let state = await store.read()
  const external = { hostId: 'local', workspaceId: 'external', workspacePath: '/not-this-library', path: 'external.note.md' }
  state = await store.apply({ expectedRevision: state.revision, operationId: 'external-register', change: { kind: 'register', noteId: 'external-note', resource: external, title: 'External' } }, f.actor)
  const destination = await mkdtemp(join(tmpdir(), 'note-copied-library-')); roots.push(destination)
  await cp(f.directory, destination, { recursive: true }); await rm(f.directory, { recursive: true })
  // A saved library requires no SQL input, profile or operation snapshot to be useful.
  for (const entry of await readdir(destination)) if (entry.includes('.sqlite')) await rm(join(destination, entry))
  const fresh = new AgentMuxNotebookStore(undefined, new AgentMuxNotesStorage(join(destination, 'fresh-profile', 'location.json'), destination)), actual = await fresh.read()
  expect(actual.pages['original-note']?.resource).toEqual({ ...f.resource, workspacePath: destination }); expect(actual.pages['external-note']?.resource).toEqual(external)
  expect(actual.trail).toEqual(state.trail); expect(actual.operations).toEqual(state.operations)
  const event = (await fresh.readHistoryOperation(f.event.eventId))!
  expect(event).toEqual({ ...f.event, resource: { ...f.resource, workspacePath: destination }, provenance: { ...f.provenance, resource: { ...f.resource, workspacePath: destination } } })
  expect(event.originalResource).toEqual(f.resource); expect(event.requestFingerprint).toBe(f.event.requestFingerprint)
  expect(await readFile(join(destination, f.resource.path), 'utf8')).toBe(f.content)
})
it.each(['prepared', 'committed'] as const)('resumes an original %s SQLite directory operation under its existing identity and snapshot', async phase => {
  const f = await originalSql(), target = f.directory + '-outside', locator = join(f.directory, 'location.json')
  roots.push(target); await mkdir(target)
  const to = { ...f.resource, workspacePath: target }, state = applyNotebookChange(f.snapshot.state, { expectedRevision: f.snapshot.state.revision, operationId: 'original-move:original-note', change: { kind: 'relocate', noteId: f.event.noteId, from: f.resource, resource: to } }, f.actor, 3)
  const prepared = { ...f.snapshot, state, provenance: [{ ...f.provenance, resource: to }], history: [{ ...f.event, resource: to, provenance: { ...f.provenance, resource: to } }] }
  const snapshotPath = join(f.directory, 'prepared-metadata.json'), bytes = JSON.stringify(prepared) + '\n'
  await writeFile(snapshotPath, bytes)
  if (phase === 'committed') { await legacySqliteFixture(join(target, 'notebooks.sqlite'), prepared); await writeFile(join(target, f.resource.path), f.content) }
  const operation = { operationId: 'original-move', expectedDirectory: f.directory, directory: target, phase, files: [{ source: join(f.directory, f.resource.path), destination: join(target, f.resource.path), hash: digest(f.content) }], resourceChanges: [{ noteId: f.event.noteId, from: f.resource, to }], catalog: state,
    sourceCatalog: f.sql, sourceCatalogHash: notebookFilesFingerprint(f.snapshot), database: { incarnation: f.snapshot.incarnation, snapshotPath, snapshotHash: digest(bytes) } }
  await writeFile(locator, JSON.stringify({ schemaVersion: 1, directory: phase === 'prepared' ? f.directory : target, catalogFormat: 'sqlite', catalogEstablished: true, operations: { 'original-move': operation }, pending: 'original-move' }))
  const owner = new AgentMuxNotesStorage(locator, f.directory); await owner.resume()
  expect((await owner.inspect('original-move')).operation).toMatchObject({ operationId: 'original-move', phase: 'committed', database: operation.database })
  const fresh = new AgentMuxNotebookStore(undefined, owner)
  expect(await fresh.read()).toEqual(state)
  expect(await fresh.readHistoryOperation(f.event.eventId)).toEqual(prepared.history[0])
  expect(await readFile(f.sql)).not.toHaveLength(0); expect(await readFile(join(target, f.resource.path), 'utf8')).toBe(f.content)
})
it('allows an explicit A to B to A move using the original retirement evidence, retaining history and foreign input bytes', async () => {
  const f = await originalSql(), locator = join(f.directory, 'profile', 'location.json'), owner = new AgentMuxNotesStorage(locator, f.directory), store = new AgentMuxNotebookStore(undefined, owner)
  await store.read(); const sql = await readFile(f.sql), target = f.directory + '-moved'; roots.push(target)
  await owner.change({ operationId: 'to-b', expectedDirectory: f.directory, directory: target })
  expect(JSON.parse(await readFile(f.path, 'utf8'))).toMatchObject({ schema: 'agentmux.notebook.moved.v1', operationId: 'to-b' })
  await owner.change({ operationId: 'back-a', expectedDirectory: target, directory: f.directory })
  expect((await store.read()).pages[f.event.noteId]?.resource).toEqual(f.resource)
  expect(await store.readHistoryOperation(f.event.eventId)).toEqual(f.event)
  expect(await readFile(f.sql)).toEqual(sql)
})
it('reconfirms the already published exact root after interrupted identity acknowledgement without replaying old SQL', async () => {
  const f = await originalSql(); fault.link = f.path + '.identity'
  await expect(new AgentMuxNotebookStore(f.sql).read()).rejects.toMatchObject({ code: 'NOTEBOOK_READ_UNCONFIRMED' })
  const root = await readFile(f.path)
  await expect(readFile(f.path + '.identity')).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await new AgentMuxNotebookStore(f.path).read()).toEqual(f.snapshot.state)
  expect(await readFile(f.path)).toEqual(root); expect(await readFile(f.path + '.identity', 'utf8')).toBe(f.snapshot.incarnation)
  await expect(readFile(f.path + '.importing.json')).rejects.toMatchObject({ code: 'ENOENT' })
})
it.each([true, false])('refuses an identity changed between SQL snapshot and original-byte acknowledgement, originally present: %s', async present => {
  const f = await originalSql(); if (!present) await rm(f.sql + '.sqlite-identity'); fault.changingSql = f.sql
  await expect(new AgentMuxNotebookStore(f.sql).read()).rejects.toMatchObject({ code: 'NOTEBOOK_READ_UNCONFIRMED' })
  expect(fault.sqlReads).toBeGreaterThanOrEqual(2)
  expect(await readFile(f.sql + '.sqlite-identity', 'utf8')).toBe('external-identity-change')
  await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' })
})
it.each(['receipt', 'identity'] as const)('retains both libraries when an explicit return destination has conflicting retirement %s', async damage => {
  const f = await originalSql(), owner = new AgentMuxNotesStorage(join(f.directory, 'profile', 'location.json'), f.directory), store = new AgentMuxNotebookStore(undefined, owner)
  await store.read(); const target = f.directory + '-moved'; roots.push(target)
  await owner.change({ operationId: 'to-b', expectedDirectory: f.directory, directory: target })
  if (damage === 'receipt') { const retired = JSON.parse(await readFile(f.path, 'utf8')); delete retired.destination; await writeFile(f.path, JSON.stringify(retired)) }
  else await writeFile(f.path + '.identity', 'different-incarnation')
  const original = await readFile(f.path), current = await readFile(join(target, 'notebooks.root.json'))
  await expect(owner.change({ operationId: 'back-a', expectedDirectory: target, directory: f.directory })).rejects.toMatchObject({ code: 'NOTEBOOK_READ_UNCONFIRMED' })
  expect(await readFile(f.path)).toEqual(original); expect(await readFile(join(target, 'notebooks.root.json'))).toEqual(current)
  expect((await store.read()).pages[f.event.noteId]?.resource.workspacePath).toBe(target)
})
it('honors an existing file-authority locator when the entire current file root is removed but old SQL remains', async () => {
  const f = await originalSql(), locator = join(f.directory, 'profile', 'location.json'), owner = new AgentMuxNotesStorage(locator, f.directory)
  await new AgentMuxNotebookStore(undefined, owner).read()
  await rm(f.path); await rm(f.path + '.identity'); await rm(f.path + '.files', { recursive: true })
  const fresh = new AgentMuxNotebookStore(undefined, new AgentMuxNotesStorage(locator, f.directory))
  await expect(fresh.readHistoryOperation(f.event.eventId)).rejects.toMatchObject({ code: 'NOTEBOOK_READ_UNCONFIRMED' })
  await expect(fresh.recordProvenance(f.provenance)).rejects.toMatchObject({ code: 'NOTEBOOK_READ_UNCONFIRMED' })
  await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' })
})
it('reconfirms an immutable historical body and its directory after link succeeded but directory flush failed', async () => {
  const f = await originalSql(), bodyPath = historicalBodyPath(f.path, f.revision)
  fault.syncTarget = join(f.path + '.files', 'bodies'); fault.syncFailureAt = 2
  await expect(new AgentMuxNotebookStore(f.path).read()).rejects.toMatchObject({ code: 'NOTEBOOK_READ_UNCONFIRMED' })
  expect(fault.syncAttempt).toBe(2); expect(await readFile(bodyPath, 'utf8')).toBe(f.content)
  await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' })
  fault.syncTarget = ''; fault.syncObserving = true
  expect(await new AgentMuxNotebookStore(f.path).read()).toEqual(f.snapshot.state)
  expect(fault.syncs).toContain(bodyPath); expect(fault.syncs).toContain(join(f.path + '.files', 'bodies'))
})
it('keeps a previously confirmed explicit Store unknown when its root and all markers subsequently disappear', async () => {
  const f = await originalSql(), store = new AgentMuxNotebookStore(f.path); await store.read()
  await rm(f.path); await rm(f.path + '.identity'); await rm(f.path + '.files', { recursive: true })
  await expect(store.read()).rejects.toMatchObject({ code: 'NOTEBOOK_READ_UNCONFIRMED' })
  await expect(store.readHistoryOperation(f.event.eventId)).rejects.toMatchObject({ code: 'NOTEBOOK_READ_UNCONFIRMED' })
  await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' })
})
it('does not resume another target’s copied pending import even while its original source bytes remain readable', async () => {
  const f = await originalSql(); fault.link = f.path
  await expect(new AgentMuxNotebookStore(f.path).read()).rejects.toMatchObject({ code: 'NOTEBOOK_READ_UNCONFIRMED' })
  const bytes = await readFile(f.path + '.importing.json'), target = await mkdtemp(join(tmpdir(), 'note-foreign-pending-')); roots.push(target)
  const path = join(target, 'notebooks.root.json'); await writeFile(path + '.importing.json', bytes)
  await expect(new AgentMuxNotebookStore(path).read()).rejects.toMatchObject({ code: 'NOTEBOOK_READ_UNCONFIRMED' })
  expect(await readFile(path + '.importing.json')).toEqual(bytes); expect(await readFile(f.path + '.importing.json')).toEqual(bytes)
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
})
it('retains the last prepared export and original pending operation when a committed same-directory conversion has no confirmed destination', async () => {
  const f = await originalSql(), locator = join(f.directory, 'location.json'), snapshotPath = join(f.directory, 'last-complete-export.json'), bytes = JSON.stringify(f.snapshot) + '\n'
  await writeFile(snapshotPath, bytes); await rm(f.sql); await rm(f.sql + '.sqlite-identity'); await rm(join(f.directory, f.resource.path))
  const operation = { operationId: 'original-convert', kind: 'convert', expectedDirectory: f.directory, directory: f.directory, phase: 'committed', sourceCatalog: f.sql,
    sourceCatalogHash: notebookFilesFingerprint(f.snapshot), catalog: f.snapshot.state, resourceChanges: [],
    files: [{ source: join(f.directory, 'legacy.note.json'), destination: join(f.directory, f.resource.path), hash: digest('old json'), preparedSource: join(f.directory, 'stage.md'), targetHash: digest(f.content), backup: join(f.directory, 'legacy.original') }],
    database: { incarnation: f.snapshot.incarnation, snapshotPath, snapshotHash: digest(bytes) } }
  await writeFile(locator, JSON.stringify({ schemaVersion: 1, directory: f.directory, catalogFormat: 'sqlite', catalogEstablished: true, operations: { 'original-convert': operation }, pending: 'original-convert' }))
  await expect(new AgentMuxNotesStorage(locator, f.directory).resume()).rejects.toMatchObject({ code: 'NOTES_STORAGE_CONFLICT' })
  expect(await readFile(snapshotPath, 'utf8')).toBe(bytes)
  expect(JSON.parse(await readFile(locator, 'utf8'))).toMatchObject({ pending: 'original-convert', operations: { 'original-convert': operation } })
})
it.each([{ damage: 'metadata', remainingSource: false }, { damage: 'body', remainingSource: false }, { damage: 'body', remainingSource: true }])('retains the pending file move and last export when destination $damage is unavailable, remaining source: $remainingSource', async ({ damage, remainingSource }) => {
  const f = await originalSql(), locator = join(f.directory, 'profile', 'location.json'), owner = new AgentMuxNotesStorage(locator, f.directory)
  const store = new AgentMuxNotebookStore(undefined, owner); const catalog = await store.read()
  const secondBody = f.content.replace('note-id: original-note', 'note-id: second-note')
  if (remainingSource) {
    await writeFile(join(f.directory, 'second.note.md'), secondBody)
    await store.apply({ expectedRevision: catalog.revision, operationId: 'second-original', change: { kind: 'register', noteId: 'second-note', title: 'Second', resource: { ...f.resource, path: 'second.note.md' } } }, f.actor)
  }
  const target = f.directory + '-moved'; roots.push(target)
  fault.clearLocation = locator
  await expect(owner.change({ operationId: 'original-move', expectedDirectory: f.directory, directory: target })).rejects.toMatchObject({ code: 'EIO' })
  const location = JSON.parse(await readFile(locator, 'utf8')), operation = location.operations['original-move'], snapshot = await readFile(operation.database.snapshotPath)
  expect(location.pending).toBe('original-move'); expect(JSON.parse(await readFile(f.path, 'utf8')).schema).toBe('agentmux.notebook.moved.v1')
  await expect(readFile(join(f.directory, f.resource.path))).rejects.toMatchObject({ code: 'ENOENT' })
  if (remainingSource) await writeFile(join(f.directory, 'second.note.md'), secondBody)
  if (damage === 'metadata') await rm(join(target, 'notebooks.root.json'))
  else await rm(join(target, f.resource.path))
  await expect(new AgentMuxNotesStorage(locator, target).resume()).rejects.toThrow()
  expect(await readFile(operation.database.snapshotPath)).toEqual(snapshot)
  expect(JSON.parse(await readFile(locator, 'utf8')).pending).toBe('original-move')
})
