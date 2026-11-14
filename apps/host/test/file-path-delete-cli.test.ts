import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, symlink, unlink, writeFile, rm, open, chmod } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import * as core from '@agentmux/core'
import type { FileDeleteParams } from '@agentmux/core/files'
import { noteHistoryRevision } from '@agentmux/core/note-history'
import { OrdinaryWorkspaceFiles } from '../src/ordinary-files.js'
import { FileDeleteHistory } from '../src/file-delete-history.js'
import { agent, cleanup, fixture, helper, hostFixture, operationRecord } from './helpers/file-path-fixture.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { FilePathMutations } from '../src/file-path-mutations.js'
import { cleanupExecutableNativeFixtures, executableNativeFixture, until } from '../../../packages/core/test/helpers/executable-native-fixture.js'

const facts: unknown[] = []
afterAll(async () => { if (process.env.AGENTMUX_FILE_PATH_DELETE_EVIDENCE) await writeFile(process.env.AGENTMUX_FILE_PATH_DELETE_EVIDENCE, JSON.stringify({ schema: 'agentmux.file-delete-proof.v1', platform: process.platform, facts }, null, 2) + '\n') })
beforeAll(async () => { await promisify(execFile)(process.execPath, [resolve('apps/host/scripts/build-workspace-move-helper.mjs')]) })
afterEach(async () => { await cleanupExecutableNativeFixtures(); for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

async function target(f: Awaited<ReturnType<typeof hostFixture>>, path: string, operationId: string, options: { recursive?: boolean; expectedRevision?: string } = {}): Promise<FileDeleteParams> {
  const observed = await f.cli(['stat'], { zoneId: 'original-files-zone', path,
    expectedResource: { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.root } })
  expect(observed.code, observed.stdout + observed.stderr).toBe(0)
  const current = observed.body.result
  return { operationId, zoneId: 'original-files-zone', path, expectedResource: current.resource,
    expected: { root: current.result.observation.root, parent: current.result.observation.parent, entry: current.result.observation.entry }, ...options }
}

function nativeDeleteOptions(options: ConstructorParameters<typeof OrdinaryWorkspaceFiles>[0]) {
  const actual = OrdinaryWorkspaceFiles.prototype.deletePath
  return vi.spyOn(OrdinaryWorkspaceFiles.prototype, 'deletePath').mockImplementation(function (workspace, input) { return actual.call(new OrdinaryWorkspaceFiles({ helperPath: helper, ...options }), workspace, input) })
}

async function deleteFixture(options: ConstructorParameters<typeof OrdinaryWorkspaceFiles>[0] = {}) {
  const f = await fixture(options), notes = new core.AgentMuxNotebookStore(join(f.original.root, 'notebooks.json'))
  const fd = await open(join(f.original.root, 'private-finite-producer-fd'), 'a+'); cleanup.push(() => fd.close())
  const inner = f.original.client as unknown as { spawnFiniteFileProducer: (spawn: (fd: number) => import('node:child_process').ChildProcess) => import('node:child_process').ChildProcess }
  inner.spawnFiniteFileProducer = spawn => spawn(fd.fd)
  f.original.inner.kernel.listPage = async () => ({ runs: [], nextCursor: null })
  const owner = new FilePathMutations({ directory: join(f.original.root, 'file-path-mutations'), files: f.ordinary,
    directoryScope: predicate => f.original.client.retainExecutionDirectoryMutation(predicate), noteLease: work => notes.runWithWriteLease(work),
    deleteHistory: (workspace, input, digest, actor) => new FileDeleteHistory(notes, f.ordinary, workspace, input, digest, actor) })
  const request = async (path: string, operationId: string, recursive?: boolean): Promise<FileDeleteParams> => {
    const observation = await owner.stat(f.workspace, path)
    if (observation.entry.kind === 'absent') throw new Error('Original fixture entry absent')
    return { zoneId: 'original-files-zone', path, operationId, expectedResource: f.descriptor(path), expected: { root: observation.root, parent: observation.parent, entry: observation.entry },
      ...(observation.entry.kind === 'file' ? { expectedRevision: 'sha256:' + createHash('sha256').update(await readFile(join(f.root, path))).digest('hex') } : recursive === undefined ? {} : { recursive }) }
  }
  return { ...f, notes, owner, request }
}

it('compiled CLI deletes the exact original file through Host and Native, retains its operation and never replays after member loss', async () => {
  const f = await hostFixture('physical\nroot\\part'), content = 'Original deletion bytes\n'
  await writeFile(join(f.root, 'original.txt'), content)
  const input = await target(f, 'original.txt', 'original-file-delete', { expectedRevision: noteHistoryRevision(content) })
  const native = vi.spyOn(OrdinaryWorkspaceFiles.prototype, 'deletePath'), beforeStore = await readFile(f.original.store.path)
  const deleted = await f.cli(['delete'], input)
  expect(deleted.code, deleted.stdout + deleted.stderr).toBe(0)
  expect(deleted.body.result.result, JSON.stringify(deleted.body)).toMatchObject({ action: 'delete', filesystem: 'deleted', durability: 'confirmed', noteHistory: { status: 'recorded' } })
  expect(native).toHaveBeenCalledTimes(1)
  await expect(readFile(join(f.root, input.path))).rejects.toMatchObject({ code: 'ENOENT' })
  const query = { operationId: input.operationId, zoneId: input.zoneId, path: input.path, expectedResource: input.expectedResource }
  const observed = await f.cli(['mutation', 'inspect'], query)
  expect(observed.code, observed.stdout + observed.stderr).toBe(0)
  expect(observed.body.result.result).toMatchObject({ filesystem: 'deleted', durability: 'unconfirmed', original: input })
  expect((await f.cli(['delete'], input)).body.result.result).toMatchObject({ filesystem: 'deleted', durability: 'unconfirmed' })
  await unlink(operationRecord(f.original.root, input.operationId))
  await writeFile(join(f.root, input.path), 'Later unrelated input')
  expect((await f.cli(['delete'], input)).body.result.result).toMatchObject({ filesystem: 'unknown', code: 'FILE_MUTATION_RECORD_UNAVAILABLE' })
  expect(await readFile(join(f.root, input.path), 'utf8')).toBe('Later unrelated input')
  expect(native).toHaveBeenCalledTimes(1)
  expect(await readFile(f.original.store.path)).toEqual(beforeStore)
  expect(f.original.inner.kernel.stop).not.toHaveBeenCalled()
})

it('compiled CLI preserves current registered and header Notes, prior creators and history through the original history owner', async () => {
  const f = await hostFixture(), notes = new core.AgentMuxNotebookStore(), creator = { kind: 'user' as const, id: 'original-body-creator' }
  const resource = { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.root, path: 'registered.txt' }
  const prior = 'Original prior body\n\n^original\n', content = 'Current externally saved body, absent from history\n\n^original\n', priorRevision = noteHistoryRevision(prior)
  await notes.apply({ operationId: 'register-original', expectedRevision: 0, change: { kind: 'register', noteId: 'registered-original', title: 'Original', resource } }, creator)
  const provenance = { noteId: 'registered-original', resource, revision: priorRevision, blocks: { original: { created: { actor: creator, at: 1 }, lastEdited: { actor: creator, at: 1 } } } }
  await notes.recordProvenance(provenance)
  await notes.recordHistory({ eventId: 'prior-original-event', batchId: 'prior-original-batch', sequence: 0, noteId: 'registered-original', resource, originalResource: resource,
    actor: creator, at: 1, operation: 'edit', status: 'committed', requestFingerprint: 'prior-original-request', parentEventId: null, beforeContent: null, baseRevision: null, content: prior, revision: priorRevision, provenance })
  await writeFile(join(f.root, resource.path), content)
  const headerContent = '---\nschema: agentmux.note.md.v1\nnote-id: unregistered-original\n---\n\nOriginal header Note body\n'
  await writeFile(join(f.root, 'unregistered.data'), headerContent)
  for (const [path, noteId, body] of [[resource.path, 'registered-original', content], ['unregistered.data', 'unregistered-original', headerContent]]) {
    const input = await target(f, path!, 'delete-' + noteId, { expectedRevision: noteHistoryRevision(body!) })
    const reply = await f.cli(['delete'], input)
    expect(reply.code, reply.stdout + reply.stderr).toBe(0)
    expect(reply.body.result.result).toMatchObject({ filesystem: 'deleted', noteHistory: { status: 'recorded' } })
    const original = { ...resource, path: path! }, fresh = new core.AgentMuxNotebookStore()
    const deletion = (await fresh.readHistory({ noteId: noteId!, resource: original, limit: 10 })).entries.find(event => event.operation === 'delete')!
    expect(deletion).toMatchObject({ status: 'committed', actor: { kind: 'agent', id: agent.actor.id }, baseRevision: noteHistoryRevision(body!), revision: null })
    expect(deletion.source).toBeUndefined()
    const query = await runCompiledObjectCli(['--endpoint', 'unix:' + join(f.original.root, 'host.sock'), 'file', 'history', '--zone', input.zoneId, '--path', path!, '--resource', JSON.stringify(input.expectedResource), '--note', noteId!, '--event-id', deletion.eventId, '--content'],
      objectCliEnvironment(f.original.root, { AGENTMUX_AGENT_SESSION_ID: agent.actor.id, AGENTMUX_AGENT_CAPABILITY: f.original.capability }))
    expect(query.code, query.stdout + query.stderr).toBe(0)
    expect(JSON.parse(query.stdout).result.result.entries[0]).toMatchObject({ beforeContent: body, content: null, originalResource: original, status: 'committed' })
  }
  const fresh = new core.AgentMuxNotebookStore()
  expect(Object.keys((await fresh.read()).pages)).toEqual(['registered-original'])
  expect(await fresh.readHistoryOperation('prior-original-event')).toMatchObject({ actor: creator, content: prior, resource, provenance })
  expect(await fresh.readProvenance({ noteId: 'registered-original', resource, revision: priorRevision, blockIds: ['original'] })).toMatchObject({ status: 'unconfirmed', blocks: { original: { created: { actor: creator, at: 1 }, lastEdited: null } } })
})

it('compiled CLI defaults to empty-directory deletion, explicitly consumes the original subtree and never follows outside symlinks', async () => {
  const f = await hostFixture(), outside = join(f.original.root, 'outside-preserved.txt')
  await writeFile(outside, 'outside original bytes'); await mkdir(join(f.root, 'tree'))
  await writeFile(join(f.root, 'tree/plain.txt'), 'ordinary bytes')
  await writeFile(join(f.root, 'tree/generic.md'), '---\ntitle: Ordinary frontmatter\n---\n\nPlain Markdown\n')
  await writeFile(join(f.root, 'tree/literal\\..'), 'Literal Unix child, not a Note path')
  await symlink(outside, join(f.root, 'tree/outside-link'))
  const emptyOnly = await target(f, 'tree', 'empty-only-original')
  const refused = await f.cli(['delete'], emptyOnly)
  expect(refused.code, refused.stdout + refused.stderr).toBe(0)
  expect(refused.body.result.result).toMatchObject({ filesystem: 'not-applied', code: 'FILE_DELETE_DIRECTORY_NOT_EMPTY' })
  expect(await readFile(join(f.root, 'tree/plain.txt'), 'utf8')).toBe('ordinary bytes')
  const recursive = await target(f, 'tree', 'explicit-subtree-original', { recursive: true })
  // Scope identity is not a frozen child listing. This later child is in the
  // explicitly authorized original subtree and must not fake a directory CAS.
  await writeFile(join(f.root, 'tree/later-child'), 'later subtree bytes')
  const removed = await f.cli(['delete'], recursive)
  expect(removed.code, removed.stdout + removed.stderr).toBe(0)
  expect(removed.body.result.result).toMatchObject({ filesystem: 'deleted' })
  await expect(readdir(join(f.root, 'tree'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(outside, 'utf8')).toBe('outside original bytes')
  await mkdir(join(f.root, 'empty'))
  expect((await f.cli(['delete'], await target(f, 'empty', 'actually-empty'))).body.result.result.filesystem).toBe('deleted')
})

it('one explicit recursive delete retains multiple original Note snapshots with owner-assigned history sequences', async () => {
  const f = await hostFixture(), notes = new core.AgentMuxNotebookStore()
  await mkdir(join(f.root, 'notes'))
  for (const id of ['alpha', 'beta', 'gamma']) await writeFile(join(f.root, 'notes/' + id + '.md'), '---\nschema: agentmux.note.md.v1\nnote-id: ' + id + '\n---\n\nBody ' + id + '\n')
  const input = await target(f, 'notes', 'multiple-note-subtree', { recursive: true })
  const reply = await f.cli(['delete'], input)
  expect(reply.code, reply.stdout + reply.stderr).toBe(0)
  expect(reply.body.result.result).toMatchObject({ filesystem: 'deleted', noteHistory: { status: 'recorded' } })
  const sequences = new Set<number>()
  for (const id of ['alpha', 'beta', 'gamma']) {
    const resource = { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.root, path: 'notes/' + id + '.md' }
    const entry = (await notes.readHistory({ noteId: id, resource })).entries[0]!
    expect(entry, 'Every original Note requires a retained body before unlink').toBeDefined()
    sequences.add(entry.sequence)
    expect(await notes.readHistoryOperation(entry.eventId)).toMatchObject({ operation: 'delete', status: 'committed', batchId: input.operationId, beforeContent: '---\nschema: agentmux.note.md.v1\nnote-id: ' + id + '\n---\n\nBody ' + id + '\n' })
  }
  expect(sequences.size).toBe(3)
  expect(Object.keys((await notes.read()).pages)).toHaveLength(0)
})

it('a partial recursive producer retains prepared Note bodies and the exact remaining claim without committing lost receipts', async () => {
  const f = await hostFixture(), notes = new core.AgentMuxNotebookStore()
  await mkdir(join(f.root, 'tree'))
  const content = (id: string) => '---\nschema: agentmux.note.md.v1\nnote-id: ' + id + '\n---\n\nOriginal ' + id + '\n'
  for (const id of ['first', 'second']) await writeFile(join(f.root, 'tree/' + id + '.note.md'), content(id))
  const actual = FileDeleteHistory.prototype.snapshot, seen: string[] = []
  vi.spyOn(FileDeleteHistory.prototype, 'snapshot').mockImplementation(async function (value) {
    seen.push(value.suffix)
    if (seen.length === 2) throw new Error('Controlled original history writer unavailable before the second unlink')
    return actual.call(this, value)
  })
  const input = await target(f, 'tree', 'partial-original-subtree', { recursive: true }), native = vi.spyOn(OrdinaryWorkspaceFiles.prototype, 'deletePath')
  const reply = await f.cli(['delete'], input)
  expect(reply.code, reply.stdout + reply.stderr).toBe(0)
  expect(reply.body.result.result).toMatchObject({ filesystem: 'unknown', phase: 'claimed', noteHistory: { status: 'unconfirmed' } })
  expect(seen).toHaveLength(2)
  const record = JSON.parse(await readFile(operationRecord(f.original.root, input.operationId), 'utf8'))
  const claim = join(record.producer.location.root, reply.body.result.result.retainedPath)
  expect(await readdir(claim)).toHaveLength(1)
  await expect(readFile(join(claim, seen[0]!))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(claim, seen[1]!), 'utf8')).toContain('Original')
  const firstId = seen[0]!.split('.')[0]!, resource = { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.root, path: 'tree/' + seen[0] }
  const entry = (await notes.readHistory({ noteId: firstId, resource, limit: 10 })).entries[0]!
  expect(await notes.readHistoryOperation(entry.eventId)).toMatchObject({ status: 'prepared', operation: 'delete', beforeContent: content(firstId), revision: null, content: null })
  expect((await f.cli(['delete'], input)).body.result.result.filesystem).toBe('unknown')
  expect(native).toHaveBeenCalledTimes(1)
})

it('compiled CLI explicitly discovers a large binary revision, keeps default stat entry-only and consumes the same exact revision for delete', async () => {
  const f = await hostFixture(), bytes = Buffer.alloc(17 * 1024 * 1024, 0xff), revision = 'sha256:' + createHash('sha256').update(bytes).digest('hex')
  await writeFile(join(f.root, 'large.bin'), bytes)
  const query = { zoneId: 'original-files-zone', path: 'large.bin', expectedResource: { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.root } }
  const plain = await f.cli(['stat'], query)
  expect(plain.code, plain.stdout + plain.stderr).toBe(0)
  expect(plain.body.result.result.observation.revision).toBeUndefined()
  const observed = await f.cli(['stat', '--revision'], query)
  expect(observed.code, observed.stdout + observed.stderr).toBe(0)
  const read = observed.body.result
  expect(read.result.observation.revision).toEqual({ status: 'observed', revision })
  const input: FileDeleteParams = { operationId: 'large-binary-original', zoneId: query.zoneId, path: query.path, expectedResource: read.resource,
    expected: { root: read.result.observation.root, parent: read.result.observation.parent, entry: read.result.observation.entry }, expectedRevision: read.result.observation.revision.revision }
  const native = vi.spyOn(OrdinaryWorkspaceFiles.prototype, 'deletePath'), reply = await f.cli(['delete'], input)
  expect(reply.code, reply.stdout + reply.stderr).toBe(0)
  expect(reply.body.result.result).toMatchObject({ filesystem: 'deleted' })
  expect(native).toHaveBeenCalledTimes(1)
  await writeFile(join(f.root, query.path), bytes)
  const original = await target(f, query.path, 'same-bytes-new-generation', { expectedRevision: revision })
  await rename(join(f.root, query.path), join(f.root, 'original-inode.bin')); await writeFile(join(f.root, query.path), bytes)
  expect((await f.cli(['delete'], original)).body.result.result).toMatchObject({ filesystem: 'not-applied', code: 'FILE_DELETE_SOURCE_CONFLICT' })
  expect(native).toHaveBeenCalledTimes(1)
  expect((await readFile(join(f.root, query.path))).equals(bytes)).toBe(true)
})

it('revision discovery uses the original Native FD, reports N/A explicitly and never hashes an entry-only request', async () => {
  const f = await hostFixture(), bytes = Buffer.alloc(256 * 1024, 0x61)
  await writeFile(join(f.root, 'source'), bytes)
  const actual = OrdinaryWorkspaceFiles.prototype.statPath; let barriers = 0, changed = false
  vi.spyOn(OrdinaryWorkspaceFiles.prototype, 'statPath').mockImplementation(function (workspace, path, includeRevision) {
    return actual.call(new OrdinaryWorkspaceFiles({ helperPath: helper, beforeStatRevision: async () => {
      barriers++
      // The real readonly Host/CLI call crosses the old 2s timeout budget.
      await new Promise(resolve => setTimeout(resolve, 2300))
      if (!changed) { changed = true; await writeFile(join(f.root, 'source'), Buffer.alloc(bytes.length, 0x62)) }
    } }), workspace, path, includeRevision)
  })
  const query = { zoneId: 'original-files-zone', path: 'source', expectedResource: { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.root } }
  expect((await f.cli(['stat'], query)).body.result.result.status).toBe('observed')
  expect(barriers).toBe(0)
  const conflict = await f.cli(['stat'], { ...query, includeRevision: true })
  expect(conflict.code, conflict.stdout + conflict.stderr).toBe(0)
  expect(conflict.body.result.result).toMatchObject({ status: 'unknown', code: 'FILE_STAT_UNCONFIRMED' })
  expect(barriers).toBe(1)
  expect((await readFile(join(f.root, 'source'))).equals(Buffer.alloc(bytes.length, 0x62))).toBe(true)
  await mkdir(join(f.root, 'directory')); await symlink('directory', join(f.root, 'link'))
  for (const path of ['directory', 'link', 'absent']) {
    const reply = await f.cli(['stat'], { ...query, path, includeRevision: true })
    expect(reply.code, reply.stdout + reply.stderr).toBe(0)
    expect(reply.body.result.result.observation.revision).toEqual({ status: 'not-applicable' })
  }
  expect(barriers).toBe(1)
})

it('actual CLI retains the selected Notes library, ancestors and exact catalog/data paths through physical aliases while ordinary files stay healthy', async () => {
  const f = await hostFixture(), notes = new core.AgentMuxNotebookStore(), actor = { kind: 'user' as const, id: 'retained-library-creator' }
  const resource = { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.root, path: 'outside-note.md' }, body = 'Original external saved Note body\n'
  await writeFile(join(f.root, resource.path), body)
  await notes.apply({ operationId: 'register-library-original', expectedRevision: 0, change: { kind: 'register', noteId: 'library-original', title: 'Original', resource } }, actor)
  await notes.recordHistory({ eventId: 'library-original-history', sequence: 0, batchId: 'library-original-history', noteId: 'library-original', resource, originalResource: resource,
    actor, at: 1, operation: 'edit', status: 'committed', requestFingerprint: 'library-original-fingerprint', parentEventId: null, beforeContent: null, baseRevision: null, content: body, revision: noteHistoryRevision(body) })
  const storage = notes.storage!
  await storage.change({ operationId: 'select-library-inside-workspace', expectedDirectory: (await storage.inspect()).directory, directory: join(f.root, 'container/library') })
  const current = await storage.inspect(), retainedFacts = await storage.retainedFilePaths()
  const data = retainedFacts.authorityPaths.find(path => path === current.catalogPath + '.files')!
  const targets = ['container', 'container/library', current.catalogPath.slice(f.root.length + 1), join(data, (await readdir(data))[0]!).slice(f.root.length + 1)]
  await symlink('container', join(f.root, 'alias'))
  targets.push('alias/library')
  const producer = vi.spyOn(OrdinaryWorkspaceFiles.prototype, 'deletePath')
  for (const [index, path] of targets.entries()) {
    const observation = await f.ordinary.statPath(f.workspace, path)
    const input = await target(f, path, 'retained-library-target-' + index, observation.entry.kind === 'file' ? { expectedRevision: 'sha256:' + createHash('sha256').update(await readFile(join(f.root, path))).digest('hex') } : { recursive: true })
    const reply = await f.cli(['delete'], input)
    expect(reply.code, reply.stdout + reply.stderr).toBe(0)
    expect(reply.body.result.result, JSON.stringify(reply.body)).toMatchObject({ filesystem: 'not-applied', code: 'NOTES_STORAGE_PATH_RETAINED' })
  }
  expect(producer).not.toHaveBeenCalled()
  const link = await f.cli(['delete'], await target(f, 'alias', 'independent-leaf-link'))
  expect(link.body.result.result.filesystem).toBe('deleted')
  expect(producer).toHaveBeenCalledTimes(1)
  const innerBody = '---\nschema: agentmux.note.md.v1\nnote-id: ordinary-inside-library\n---\n\nOrdinary managed body\n'
  await writeFile(join(current.directory, 'ordinary.note.md'), innerBody)
  const ordinary = await f.cli(['delete'], await target(f, 'container/library/ordinary.note.md', 'ordinary-library-file', { expectedRevision: noteHistoryRevision(innerBody) }))
  expect(ordinary.body.result.result).toMatchObject({ filesystem: 'deleted', noteHistory: { status: 'recorded' } })
  expect(await new core.AgentMuxNotebookStore().readHistoryOperation('library-original-history')).toMatchObject({ content: body, actor, resource })
  expect(await readFile(join(f.root, resource.path), 'utf8')).toBe(body)
  const source = (await f.cli(['stat'], { zoneId: 'original-files-zone', path: resource.path, expectedResource: { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.root } })).body.result
  const destination = (await f.cli(['stat'], { zoneId: 'original-files-zone', path: 'ordinary-renamed.md', expectedResource: { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.root } })).body.result
  const moved = await f.cli(['move'], { operationId: 'unrelated-note-move', zoneId: 'original-files-zone', path: resource.path, expectedResource: source.resource,
    expected: { root: source.result.observation.root, parent: source.result.observation.parent, entry: source.result.observation.entry }, destination: { zoneId: 'original-files-zone', path: 'ordinary-renamed.md', expectedResource: destination.resource, expectedAbsent: true, expected: { root: destination.result.observation.root, parent: destination.result.observation.parent } } })
  expect(moved.body.result.result.filesystem).toBe('moved')
  const PendingStorage = storage.constructor as new (locator: string, initial: string, ports: { beforeSourceCleanup(): Promise<void> }) => typeof storage
  const pendingStorage = new PendingStorage(storage.locatorPath, storage.initialDirectory, { beforeSourceCleanup: async () => { throw Error('Controlled original Host acknowledgement unavailable') } })
  await expect(pendingStorage.change({ operationId: 'pending-original-library-move', expectedDirectory: current.directory, directory: join(f.root, 'pending-target') })).rejects.toThrow('Controlled original Host acknowledgement unavailable')
  expect((await pendingStorage.inspect()).operation).toMatchObject({ operationId: 'pending-original-library-move', phase: 'committed' })
  const dispatched = producer.mock.calls.length
  for (const [index, path] of ['container/library', 'pending-target'].entries()) {
    const reply = await f.cli(['delete'], await target(f, path, 'retain-pending-library-' + index, { recursive: true }))
    expect(reply.code, reply.stdout + reply.stderr).toBe(0)
    expect(reply.body.result.result).toMatchObject({ filesystem: 'not-applied', code: 'NOTES_STORAGE_PATH_RETAINED' })
  }
  expect(producer).toHaveBeenCalledTimes(dispatched)
  facts.push({ case: 'selected-and-pending-notes-storage', retainedBeforeProducer: targets, pendingSourceAndDestinationRetained: true })
}, 30000)

it('compiled CLI rejects missing requested revisions, unrequested hashes and deletion receipts bound to another source generation', async () => {
  const f = await fixture(); await writeFile(join(f.root, 'source'), 'Original codec body')
  const original = await f.ordinary.statPath(f.workspace, 'source'), resource = f.descriptor('source'), query = { zoneId: resource.zoneId, path: 'source', expectedResource: { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.root } }
  if (original.entry.kind === 'absent') throw new Error('Original source absent')
  const input: FileDeleteParams = { ...query, operationId: 'codec-delete-original', expectedResource: resource, expected: { root: original.root, parent: original.parent, entry: original.entry }, expectedRevision: noteHistoryRevision('Original codec body') }
  let revision: unknown = undefined, witness = input.expected.entry.witness
  const server = new core.AgentMuxControlServer({ coreClients: f.original.coreClients, files: {
    stat: async () => ({ resource, result: { status: 'observed', observation: { ...original, ...(revision === undefined ? {} : { revision }) } } }),
    delete: async () => ({ operationId: input.operationId, resource, result: { action: 'delete', phase: 'deleted', filesystem: 'deleted', durability: 'confirmed', deletedWitness: witness } }),
    inspectMutation: async () => ({ operationId: input.operationId, resource, result: { action: 'delete', phase: 'deleted', filesystem: 'deleted', durability: 'confirmed', deletedWitness: witness, original: input } })
  } as never }, join(f.original.root, 'codec.sock'))
  await server.start(); cleanup.push(() => server.stop())
  const env = objectCliEnvironment(f.original.root, { AGENTMUX_AGENT_SESSION_ID: agent.actor.id, AGENTMUX_AGENT_CAPABILITY: f.original.capability })
  const cli = (action: string[], value: unknown) => runCompiledObjectCli(['--endpoint', 'unix:' + join(f.original.root, 'codec.sock'), 'file', ...action, '--input', '-'], env, JSON.stringify(value))
  const missing = await cli(['stat'], { ...query, includeRevision: true })
  expect(missing.code, missing.stdout + missing.stderr).toBe(1)
  expect(missing.stdout + missing.stderr).toContain('CONTROL_PROTOCOL_ERROR')
  revision = { status: 'observed', revision: input.expectedRevision }
  expect((await cli(['stat'], query)).code).toBe(1)
  expect((await cli(['stat'], { ...query, includeRevision: true })).code).toBe(0)
  for (const field of ['device', 'inode', 'birthtimeNs'] as const) {
    witness = { ...input.expected.entry.witness, [field]: '987654321' }
    for (const [action, value] of [[['delete'], input], [['mutation', 'inspect'], { operationId: input.operationId, zoneId: input.zoneId, path: input.path, expectedResource: resource }]] as const) {
      const bad = await cli([...action], value)
      expect(bad.code, bad.stdout + bad.stderr).toBe(1)
      expect(bad.stdout + bad.stderr).toContain('CONTROL_PROTOCOL_ERROR')
    }
  }
  expect(await readFile(join(f.root, 'source'), 'utf8')).toBe('Original codec body')
})





it('late Native claim and parent replacements preserve both original and replacement objects without deleting another generation', async () => {
  const f = await hostFixture(), body = 'Original exact bytes\n'
  await writeFile(join(f.root, 'source'), body)
  const input = await target(f, 'source', 'late-source-replacement', { expectedRevision: noteHistoryRevision(body) })
  const first = nativeDeleteOptions({ beforeDeleteClaim: async () => {
    await rename(join(f.root, 'source'), join(f.root, 'original-source'))
    await writeFile(join(f.root, 'source'), body)
  } })
  const replacement = await f.cli(['delete'], input)
  expect(replacement.code, replacement.stdout + replacement.stderr).toBe(0)
  expect(replacement.body.result.result).toMatchObject({ filesystem: 'not-applied', code: 'FILE_DELETE_SOURCE_CONFLICT' })
  expect(await readFile(join(f.root, 'source'), 'utf8')).toBe(body)
  expect(await readFile(join(f.root, 'original-source'), 'utf8')).toBe(body)
  first.mockRestore()
  await mkdir(join(f.root, 'parent')); await writeFile(join(f.root, 'parent/source'), body)
  const secondInput = await target(f, 'parent/source', 'late-parent-replacement', { expectedRevision: noteHistoryRevision(body) })
  nativeDeleteOptions({ beforeDeleteUnlink: async () => {
    await rename(join(f.root, 'parent'), join(f.root, 'original-parent'))
    await mkdir(join(f.root, 'parent')); await writeFile(join(f.root, 'parent/source'), 'New parent bytes')
  } })
  const parent = await f.cli(['delete'], secondInput)
  expect(parent.code, parent.stdout + parent.stderr).toBe(0)
  expect(parent.body.result.result).toMatchObject({ filesystem: 'unknown', phase: 'claimed' })
  const record = JSON.parse(await readFile(operationRecord(f.original.root, secondInput.operationId), 'utf8'))
  expect(await readFile(join(f.root, 'original-parent', record.stage, 'entry'), 'utf8')).toBe(body)
  expect(await readFile(join(f.root, 'parent/source'), 'utf8')).toBe('New parent bytes')
  facts.push({ case: 'late-source-and-parent-replacement', first: replacement.body.result.result, second: parent.body.result.result })
})

it('a Note changed after its prepared snapshot remains claimed with the original body retained and no committed deletion', async () => {
  const f = await hostFixture(), notes = new core.AgentMuxNotebookStore()
  const body = '---\nschema: agentmux.note.md.v1\nnote-id: snapshot-original\n---\n\nOriginal body\n'
  await writeFile(join(f.root, 'note.data'), body)
  const input = await target(f, 'note.data', 'changed-after-snapshot', { expectedRevision: noteHistoryRevision(body) })
  let changed = ''
  nativeDeleteOptions({ afterDeleteSnapshot: async () => {
    const record = JSON.parse(await readFile(operationRecord(f.original.root, input.operationId), 'utf8'))
    changed = join(record.producer.location.root, record.stage, 'entry')
    await writeFile(changed, body + 'Later external edit\n')
  } })
  const reply = await f.cli(['delete'], input)
  expect(reply.code, reply.stdout + reply.stderr).toBe(0)
  expect(reply.body.result.result).toMatchObject({ filesystem: 'unknown', phase: 'claimed' })
  expect(await readFile(changed, 'utf8')).toBe(body + 'Later external edit\n')
  const resource = { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.root, path: input.path }
  const entry = (await notes.readHistory({ noteId: 'snapshot-original', resource })).entries[0]!
  expect(await notes.readHistoryOperation(entry.eventId)).toMatchObject({ status: 'prepared', beforeContent: body, baseRevision: noteHistoryRevision(body), content: null })
  facts.push({ case: 'body-change-after-snapshot', receipt: reply.body.result.result, historyEventId: entry.eventId })
})

it('the original byte-reader rejects a substituted private claim before retaining any decoy Note body', async () => {
  const f = await hostFixture(), notes = new core.AgentMuxNotebookStore()
  const body = '---\nschema: agentmux.note.md.v1\nnote-id: fd-original\n---\n\nOriginal body\n'
  await writeFile(join(f.root, 'note.data'), body)
  const input = await target(f, 'note.data', 'replaced-private-note-claim', { expectedRevision: noteHistoryRevision(body) })
  const actual = OrdinaryWorkspaceFiles.prototype.readByteRange; let claimed = ''
  vi.spyOn(OrdinaryWorkspaceFiles.prototype, 'readByteRange').mockImplementation(async function (workspace, path, options) {
    if (options.expectedWitness) {
      claimed = join(workspace.path, path)
      await rename(claimed, claimed + '.original')
      // Keep the byte length identical: size validation cannot stand in for the
      // original FD generation check when another inode occupies its claim.
      await writeFile(claimed, body.replace('Original body', 'Imposter body'))
    }
    return actual.call(this, workspace, path, options)
  })
  const reply = await f.cli(['delete'], input)
  expect(reply.code, reply.stdout + reply.stderr).toBe(0)
  expect(reply.body.result.result).toMatchObject({ filesystem: 'unknown', phase: 'claimed' })
  expect(await readFile(claimed + '.original', 'utf8')).toBe(body)
  expect(await readFile(claimed, 'utf8')).toContain('Imposter body')
  const resource = { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.root, path: input.path }
  expect((await notes.readHistory({ noteId: 'fd-original', resource })).entries).toHaveLength(0)
  facts.push({ case: 'private-claim-replacement', receipt: reply.body.result.result, originalAndDecoyRetained: true })
})

it('actual Core startup cannot cross a finite delete producer after parent exit and can reopen the same identity only after its Native effect closes', async () => {
  const f = await fixture(); await mkdir(join(f.root, 'original-directory'))
  const from = await f.ordinary.statPath(f.workspace, 'original-directory')
  const runtime = join(f.original.root, 'private-runtime'), state = join(f.original.root, 'private-state')
  await mkdir(runtime); await mkdir(state)
  const bundle = resolve('apps/host/.local/delete-finite-producer-' + process.pid + '.mjs')
  await mkdir(resolve('apps/host/.local'), { recursive: true })
  const { build } = createRequire(new URL('../package.json', import.meta.url))('esbuild')
  await build({ entryPoints: [resolve('apps/host/src/workspace-file-worker.ts')], outfile: bundle, bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24' })
  cleanup.push(() => rm(bundle, { force: true }))
  const wrapper = join(f.original.root, 'finite-helper')
  await writeFile(wrapper, (await readFile(resolve('apps/host/test/helpers/finite-file-producer-wrapper.mjs'), 'utf8')).replace('#!/usr/bin/env node', '#!' + process.execPath)); await chmod(wrapper, 0o700)
  const evidence = join(f.original.root, 'finite-producer'), configuration = join(f.original.root, 'lease-proof.json')
  await writeFile(configuration, JSON.stringify({ state, runtime, workspace: f.root, evidence, wrapper, nativeHelper: helper,
    coreEntry: resolve('packages/core/dist/index.js'), workerEntry: bundle, originalSocket: join(runtime, 'original.sock'), contenderSocket: join(runtime, 'new.sock'),
    request: { action: 'path-delete', path: 'original-directory', stage: '.agentmux-delete-' + 'd'.repeat(64),
      expected: { root: from.root, parent: from.parent, entry: from.entry }, recursive: false } }))
  const childEntry = resolve('apps/host/test/helpers/file-producer-owner-child.mjs')
  const closing = await promisify(execFile)(process.execPath, [childEntry, 'closing', configuration], { timeout: 10000 })
  expect(JSON.parse(closing.stdout.trim())).toEqual({ closingBorrowCode: 'RUNTIME_OWNER_CLOSING' })
  const parent = spawn(process.execPath, [childEntry, 'producer', configuration], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let errors = ''; parent.stderr.on('data', value => errors += value); parent.stdout.on('data', value => errors += value)
  cleanup.push(async () => { if (parent.exitCode === null && parent.signalCode === null) { const ended = once(parent, 'exit'); parent.kill('SIGKILL'); await ended } })
  const [message] = await once(parent, 'message') as [{ identity: { runtimeId: string }; pid: number }]
  let producer: { pid: number; nativePid: number; inheritedFd7: boolean } | undefined
  await vi.waitFor(async () => { if (parent.exitCode !== null) throw new Error('Finite producer exited before its checkpoint: ' + errors); producer = JSON.parse(await readFile(evidence + '.ready', 'utf8')); expect(producer!.pid).toBeGreaterThan(0) }, { timeout: 10000 })
  cleanup.push(async () => {
    await writeFile(evidence + '.release', 'G')
    for (const pid of [producer?.nativePid, producer?.pid]) if (pid) { try { process.kill(pid, 'SIGTERM') } catch {} }
  })
  const exit = once(parent, 'exit'); parent.kill('SIGKILL'); await exit
  expect(() => process.kill(message.pid, 0)).toThrow()
  const runProbe = async () => JSON.parse((await promisify(execFile)(process.execPath, [childEntry, 'probe', configuration], { timeout: 10000 })).stdout.trim())
  expect(await runProbe(), errors).toMatchObject({ acquired: false, code: 'RUNTIME_OWNER_BUSY' })
  await expect(readFile(join(runtime, 'new.sock.owner.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  await writeFile(evidence + '.release', 'G')
  await vi.waitFor(async () => { expect(JSON.parse(await readFile(evidence + '.closed', 'utf8'))).toEqual({ code: 0 }) }, { timeout: 10000 })
  await expect(readdir(join(f.root, '.agentmux-delete-' + 'd'.repeat(64)))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readdir(join(f.root, 'original-directory'))).rejects.toMatchObject({ code: 'ENOENT' })
  const replacement = await runProbe()
  expect(replacement).toMatchObject({ acquired: true, identity: { runtimeId: message.identity.runtimeId } })
  facts.push({ case: 'actual-core-finite-delete-lease', originalParent: message.pid, originalIdentity: message.identity, producer,
    contenderSocket: join(runtime, 'new.sock'), semanticBusyWhileEffectPossible: true, endpointLockAbsentDuringBusy: true, closingBorrowRevokedSynchronously: true, replacementIdentity: replacement.identity })
}, 30000)

it('the original active, retired and prepared recovery metadata retain deletion ancestors through an external physical alias', async () => {
  const f = await deleteFixture(); await mkdir(join(f.root, 'source')); await mkdir(join(f.root, 'source/child')); await mkdir(join(f.root, 'pending'))
  const alias = join(f.original.root, 'external-cwd-alias'); await symlink(join(f.root, 'source'), alias)
  const current = (await f.original.store.loadMetadata()).find(value => value.agentSessionId === agent.actor.id)!
  const bound = { ...current, workspacePath: join(alias, 'child') }; await f.original.store.compareAndSwap(current, bound)
  const native = vi.spyOn(f.ordinary, 'deletePath')
  expect((await f.owner.delete(f.workspace, await f.request('source', 'delete-active-cwd', true), agent)).result).toMatchObject({ filesystem: 'not-applied', code: 'EXECUTION_DIRECTORY_REFERENCED' })
  const reservation = { reservationId: 'retire-delete-cwd', ownerId: 'private-delete-cwd-owner', ownerPid: process.pid, kind: 'stop' as const,
    agentSessionId: bound.agentSessionId, operationId: 'retire-delete-cwd', expiresAt: Date.now() + 60000, expectedRun: bound.run,
    stopOperation: { daemonInstance: 'fixture-runtime', operationKey: 'retire-delete-cwd', runId: bound.run.runId } }
  await f.original.store.reserveLifecycle(reservation); await f.original.store.commitLifecycle(reservation, null)
  const reopened = new core.AgentMuxFileAgentSessionStore(f.original.store.path)
  expect(await reopened.retainedExecutionDirectories('local')).toContain(bound.workspacePath)
  expect((await f.owner.delete(f.workspace, await f.request('source', 'delete-retired-cwd', true), agent)).result).toMatchObject({ filesystem: 'not-applied', code: 'EXECUTION_DIRECTORY_REFERENCED' })
  const { run, retiredRuns, ...seed } = bound
  const creation = { reservationId: 'prepare-delete-cwd', ownerId: 'private-delete-cwd-owner', ownerPid: process.pid, kind: 'create' as const,
    agentSessionId: 'new-delete-cwd-agent', operationId: 'prepare-delete-cwd', expiresAt: Date.now() + 60000,
    preparedCreation: { ...seed, agentSessionId: 'new-delete-cwd-agent', workspacePath: join(f.root, 'pending'), creation: { createOperationId: 'prepare-delete-cwd', intentDigest: 'a'.repeat(64), initialPrompt: 'not-requested' as const } } }
  await f.original.store.reserveLifecycle(creation)
  expect((await f.owner.delete(f.workspace, await f.request('pending', 'delete-prepared-cwd', true), agent)).result).toMatchObject({ filesystem: 'not-applied', code: 'EXECUTION_DIRECTORY_REFERENCED' })
  expect(native).not.toHaveBeenCalled(); expect(await readdir(join(f.root, 'source'))).toEqual(['child'])
  expect(await reopened.retainedExecutionDirectories('other-host')).toEqual([])
  facts.push({ case: 'active-retired-prepared-cwd-physical-alias', nativeDeleteDispatches: 0, originalSessionId: current.agentSessionId })
})

it('a new Terminal admission cannot pass the exact delete scope after its last reference check, while unrelated work remains available', async () => {
  const f = await deleteFixture({ beforeDeleteUnlink: async () => {
    await expect(f.original.client.createTerminal({ command: process.execPath, workspacePath: join(f.root, 'source') })).rejects.toMatchObject({ code: 'EXECUTION_DIRECTORY_MUTATION_IN_PROGRESS' })
    expect(await f.original.client.withExecutionDirectoryAdmission(join(f.root, 'unrelated'), async () => 'healthy')).toBe('healthy')
  } })
  await mkdir(join(f.root, 'source'))
  const result = await f.owner.delete(f.workspace, await f.request('source', 'last-delete-reference-window'), agent)
  expect(result.result).toMatchObject({ filesystem: 'deleted' })
  facts.push({ case: 'late-terminal-admission-delete-scope', unrelatedAdmission: 'healthy', receipt: result.result })
})

it('a real private Native Agent keeps its original Run, PID, cwd and input after a related delete is refused', async () => {
  const native = await executableNativeFixture('configured-path'), source = join(native.root, 'source'); await mkdir(source)
  const created = await native.client.createAgent({ providerId: 'claude', executorId: 'fixture', workspacePath: source, commandOverride: native.executable,
    env: native.env, injectAgentMuxGuide: false, prompt: 'Original deletion protection task' })
  const first = await native.receipt(created); expect(first.cwd).toBe(source)
  await until(() => native.client.agentSession(created.agentSessionId), value => Boolean(value.nativeHandle))
  const files = new OrdinaryWorkspaceFiles({ helperPath: helper }), workspace = { id: 'native-original', hostId: 'local', path: native.root }
  const notes = new core.AgentMuxNotebookStore(join(native.root, 'private-notebooks.json'))
  const owner = new FilePathMutations({ directory: join(native.root, 'file-path-mutations'), files,
    directoryScope: predicate => native.client.retainExecutionDirectoryMutation(predicate), noteLease: work => notes.runWithWriteLease(work),
    deleteHistory: (workspace, input, digest, actor) => new FileDeleteHistory(notes, files, workspace, input, digest, actor) })
  const observed = await files.statPath(workspace, 'source')
  if (observed.entry.kind === 'absent') throw Error('Original cwd absent')
  const input: FileDeleteParams = { operationId: 'native-retained-delete-cwd', zoneId: 'native-zone', path: 'source', recursive: true,
    expectedResource: { hostId: 'local', workspaceId: workspace.id, workspacePath: native.root, zoneId: 'native-zone', zonePath: native.root, path: 'source' },
    expected: { root: observed.root, parent: observed.parent, entry: observed.entry } }
  const dispatch = vi.spyOn(files, 'deletePath')
  expect((await owner.delete(workspace, input, agent)).result).toMatchObject({ filesystem: 'not-applied', code: 'EXECUTION_DIRECTORY_REFERENCED' })
  expect(dispatch).not.toHaveBeenCalled(); expect(() => process.kill(first.pid, 0)).not.toThrow()
  expect((await native.client.statusAgent(created.agentSessionId)).run).toMatchObject({ runId: created.run.runId, state: 'running', workspacePath: source })
  await native.client.writeAgent({ agentSessionId: created.agentSessionId, expectedRun: created.run, data: 'healthy input after refused delete\n', source: 'user' })
  expect(() => process.kill(first.pid, 0)).not.toThrow()
  facts.push({ case: 'real-native-agent-delete-veto', agentSessionId: created.agentSessionId, run: created.run, originalReceipt: first, inputAcceptedAfterVeto: true })
}, 45000)

it('registered binary bodies and conflicting header identities remain claimed without invented Note text or creators', async () => {
  const f = await hostFixture(), notes = new core.AgentMuxNotebookStore(), creator = { kind: 'user' as const, id: 'original-registration-owner' }
  for (const [index, bytes] of [Buffer.from([0xff, 0x00, 0xfe]), Buffer.from('---\nschema: agentmux.note.md.v1\nnote-id: conflicting-header\n---\n\nCurrent text\n')].entries()) {
    const path = 'registered-' + index + '.data', resource = { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.root, path }, noteId = 'registered-original-' + index
    const state = await notes.read()
    await notes.apply({ operationId: 'register-identity-' + index, expectedRevision: state.revision, change: { kind: 'register', noteId, title: noteId, resource } }, creator)
    await writeFile(join(f.root, path), bytes)
    const input = await target(f, path, 'unreadable-original-' + index, { expectedRevision: 'sha256:' + createHash('sha256').update(bytes).digest('hex') })
    const reply = await f.cli(['delete'], input)
    expect(reply.code, reply.stdout + reply.stderr).toBe(0)
    expect(reply.body.result.result).toMatchObject({ filesystem: 'unknown', phase: 'claimed' })
    const record = JSON.parse(await readFile(operationRecord(f.original.root, input.operationId), 'utf8'))
    expect(await readFile(join(f.root, record.stage, 'entry'))).toEqual(bytes)
    expect((await notes.readHistory({ noteId, resource })).entries).toHaveLength(0)
  }
  await writeFile(join(f.root, 'independent'), 'Ordinary healthy bytes')
  expect((await f.cli(['delete'], await target(f, 'independent', 'healthy-after-unreadable', { expectedRevision: noteHistoryRevision('Ordinary healthy bytes') }))).body.result.result.filesystem).toBe('deleted')
})

it('a fresh real owner process retains the prepared original Note body after Native deletion loses its final reply and never replays', async () => {
  const f = await hostFixture(), notes = new core.AgentMuxNotebookStore()
  const body = '---\nschema: agentmux.note.md.v1\nnote-id: durable-original\n---\n\nOriginal durable body\n'
  await writeFile(join(f.root, 'note.data'), body)
  const input = await target(f, 'note.data', 'lost-final-delete-reply', { expectedRevision: noteHistoryRevision(body) })
  nativeDeleteOptions({ deleteFault: 'delete-after-unlink-crash' })
  const reply = await f.cli(['delete'], input)
  expect(reply.code, reply.stdout + reply.stderr).toBe(0)
  expect(reply.body.result.result).toMatchObject({ filesystem: 'unknown', phase: 'claimed', noteHistory: { status: 'unconfirmed' } })
  await expect(readFile(join(f.root, 'note.data'))).rejects.toMatchObject({ code: 'ENOENT' })
  const resource = { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.root, path: input.path }
  const event = (await notes.readHistory({ noteId: 'durable-original', resource })).entries[0]!
  expect(event).toBeDefined()
  const bundle = resolve('apps/host/.local/delete-owner-observer-' + process.pid + '.mjs')
  const { build } = createRequire(new URL('../package.json', import.meta.url))('esbuild')
  await mkdir(resolve('apps/host/.local'), { recursive: true })
  await build({ stdin: { resolveDir: process.cwd(), contents: "export {FilePathMutations} from './apps/host/src/file-path-mutations.ts';export {OrdinaryWorkspaceFiles} from './apps/host/src/ordinary-files.ts'" }, outfile: bundle, bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24' })
  cleanup.push(() => rm(bundle, { force: true }))
  const configuration = join(f.original.root, 'delete-owner-observer.json')
  await writeFile(configuration, JSON.stringify({ entry: bundle, helper, directory: join(f.original.root, 'file-path-mutations'), workspace: f.workspace, input, context: agent,
    action: 'delete', historyEventId: event.eventId }))
  const invoke = async () => JSON.parse((await promisify(execFile)(process.execPath, [resolve('apps/host/test/helpers/file-path-operation-observer.mjs'), configuration])).stdout)
  const observed = await invoke()
  expect(observed.pid).not.toBe(process.pid)
  expect(observed).toMatchObject({ publishCalls: 0, result: { result: { filesystem: 'unknown', durability: 'unconfirmed' } }, history: { status: 'prepared', beforeContent: body, baseRevision: noteHistoryRevision(body), content: null } })
  await unlink(operationRecord(f.original.root, input.operationId)); await writeFile(join(f.root, 'note.data'), 'Later independent bytes')
  expect(await invoke()).toMatchObject({ publishCalls: 0, result: { result: { filesystem: 'unknown', code: 'FILE_MUTATION_RECORD_UNAVAILABLE' } }, history: { status: 'prepared', beforeContent: body } })
  expect(await readFile(join(f.root, 'note.data'), 'utf8')).toBe('Later independent bytes')
  facts.push({ case: 'fresh-node-note-delete-lost-reply', originalOperation: input.operationId, freshPid: observed.pid, publishCalls: observed.publishCalls, retainedEventId: event.eventId, originalBodyRetained: true })
}, 30000)


