const { fixtureEpoch: _newTailFixtureEpoch, fixturePath: _newTailFixturePath } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { AgentMuxNotebookStore, AgentMuxNotesStorage } from '../src/notebook-store.js'
import { applyNotebookChange, emptyNotebookState } from '../src/notebook-catalog.js'
import { readNotebookDatabase } from '../src/notebook-database.js'
import type { NoteProvenanceWrite } from '../src/note-provenance.js'
const roots: string[] = []
const io = vi.hoisted(() => ({ database: '', fullReads: 0, headerBytes: 0 }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => { if (String(args[0]) === io.database) io.fullReads++; return actual.readFile(...args) },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      if (String(args[0]) === io.database && args[1] === 'r') {
        const read = handle.read.bind(handle)
        handle.read = ((...params: unknown[]) => { if (typeof params[2] === 'number') io.headerBytes += params[2]; return (read as (...args: unknown[]) => unknown)(...params) }) as typeof handle.read
      }
      return handle
    } }
})
const sha = (content: string) => 'sha256:' + createHash('sha256').update(content).digest('hex')
const creator = { actor: { kind: 'agent' as const, id: 'original-agent' }, at: _newTailFixtureEpoch(0, 0, 10) }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'note-sqlite-')); roots.push(root)
  const directory = join(root, 'notes'); await mkdir(directory)
  const storage = new AgentMuxNotesStorage(join(root, 'notes-location.json'), directory), store = new AgentMuxNotebookStore(undefined, storage)
  const resource = { hostId: 'local', workspaceId: '__notes__', workspacePath: directory, path: 'one.note.md' }
  const body = '---\nschema: agentmux.note.md.v1\nnote-id: original\n---\n\nOriginal text\n\n^block\n'
  await writeFile(join(directory, resource.path), body)
  const attribution: NoteProvenanceWrite = { noteId: 'original', resource, revision: sha(body), blocks: { block: { created: creator, lastEdited: creator } } }
  return { root, directory, storage, store, resource, body, attribution }
}
afterEach(async () => { io.database = ''; io.fullReads = 0; io.headerBytes = 0; vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
describe('original SQLite Notebook metadata owner', () => {
  it('retains exact body authors through fresh owners, preserves old creation on unknown revisions and refuses a different resource', async () => {
    const f = await fixture(); await f.store.recordProvenance(f.attribution)
    const fresh = new AgentMuxNotebookStore(undefined, new AgentMuxNotesStorage(f.storage.locatorPath, _newTailFixturePath("unused")))
    expect(await fresh.readProvenance({ ...f.attribution, blockIds: ['block'] })).toMatchObject({ status: 'recorded', blocks: f.attribution.blocks })
    const query = { ...f.attribution, revision: sha('new unsaved external body'), blockIds: ['block', 'new-block'] }
    expect(await fresh.readProvenance(query)).toMatchObject({ status: 'unconfirmed', blocks: { block: { created: creator, lastEdited: null }, 'new-block': { created: null, lastEdited: null } } })
    expect(await fresh.readProvenance({ ...query, resource: { ...f.resource, path: 'other.note.md' } })).toMatchObject({ status: 'unconfirmed', blocks: { block: { created: null, lastEdited: null } } })
    const next = { ...f.attribution, revision: query.revision, blocks: { block: { created: null, lastEdited: { actor: { kind: 'user' as const, id: 'human-editor' }, at: _newTailFixtureEpoch(0, 0, 20) } } } }
    const result = await fresh.recordProvenance(next)
    expect(result.blocks.block).toEqual({ created: creator, lastEdited: next.blocks.block.lastEdited })
    expect(await fresh.recordProvenance(next)).toEqual(result)
    await expect(fresh.recordProvenance({ ...next, blocks: { block: { created: null, lastEdited: creator } } })).rejects.toMatchObject({ code: 'NOTE_PROVENANCE_CONFLICT' })
    expect((await fresh.readProvenance({ ...query, blockIds: ['block'] })).blocks.block?.lastEdited).toEqual(next.blocks.block.lastEdited)
  })
  it('imports old catalog JSON once with an exact recoverable backup; missing or replaced acknowledged SQLite never becomes empty', async () => {
    const f = await fixture(), original = { ...emptyNotebookState(), revision: 5 }
    const oldPath = join(f.directory, 'notebooks.json'), raw = JSON.stringify(original)
    await writeFile(oldPath, raw)
    expect(await f.store.read()).toEqual(original)
    expect((await readFile(f.store.path)).subarray(0, 16).toString()).toBe('SQLite format 3\0')
    expect(await readFile(oldPath + '.original-' + sha(raw).slice(7), 'utf8')).toBe(raw)
    await writeFile(oldPath, JSON.stringify(emptyNotebookState()))
    expect(await f.store.read()).toEqual(original)
    await rm(f.store.path)
    await rm(f.store.path + '.sqlite-identity')
    await expect(f.store.read()).rejects.toMatchObject({ code: 'NOTEBOOK_READ_UNCONFIRMED' })
    await expect(f.store.apply({ operationId: 'overwrite', expectedRevision: 0, change: { kind: 'create', notebookId: 'new', name: 'New' } }, { kind: 'user', id: 'human' })).rejects.toMatchObject({ code: 'NOTEBOOK_READ_UNCONFIRMED' })
    expect(await readFile(oldPath, 'utf8')).toBe(JSON.stringify(emptyNotebookState()))
  })
  it('keeps opaque original block identities separate from object prototype properties', async () => {
    const f = await fixture(), ids = ['__proto__', 'constructor']
    const blocks = Object.fromEntries(ids.map(id => [id, { created: creator, lastEdited: creator }]))
    await f.store.recordProvenance({ ...f.attribution, blocks })
    const result = await f.store.readProvenance({ ...f.attribution, blockIds: ids })
    expect(Object.keys(result.blocks)).toEqual(ids); expect(result.status).toBe('recorded')
    for (const id of ids) expect(Object.hasOwn(result.blocks, id) && result.blocks[id]?.created).toEqual(creator)
  })
  it('records inside the real Notes resource fence and serializes independent async requests', async () => {
    const f = await fixture(), events: string[] = []
    let release!: () => void, entered!: () => void
    const held = new Promise<void>(resolve => { release = resolve }), active = new Promise<void>(resolve => { entered = resolve })
    const first = f.storage.withLock(async () => {
      events.push('first-enter'); await f.store.recordProvenance(f.attribution); events.push('first-recorded'); entered(); await held; events.push('first-exit')
    })
    await active
    const second = new AgentMuxNotesStorage(f.storage.locatorPath, f.directory).withLock(async () => { events.push('second-enter'); expect((await f.store.readProvenance({ ...f.attribution, blockIds: ['block'] })).status).toBe('recorded') })
    await new Promise(resolve => setTimeout(resolve, 30)); expect(events).toEqual(['first-enter', 'first-recorded'])
    release(); await Promise.all([first, second]); expect(events).toEqual(['first-enter', 'first-recorded', 'first-exit', 'second-enter'])
  })
  it('expires a reentrant lease when its original callback returns, even in a delayed child async chain', async () => {
    const f = await fixture(), events: string[] = []
    let letChildContinue!: () => void, releaseOther!: () => void, otherEntered!: () => void, child!: Promise<void>
    const childWait = new Promise<void>(resolve => { letChildContinue = resolve }), otherWait = new Promise<void>(resolve => { releaseOther = resolve }), otherActive = new Promise<void>(resolve => { otherEntered = resolve })
    await f.storage.withLock(async () => { child = childWait.then(() => f.storage.withLock(async () => { events.push('child-enter') })) })
    const other = f.storage.withLock(async () => { events.push('other-enter'); otherEntered(); await otherWait; events.push('other-exit') })
    await otherActive; letChildContinue(); await new Promise(resolve => setTimeout(resolve, 30))
    expect(events).toEqual(['other-enter']); releaseOther(); await Promise.all([other, child]); expect(events).toEqual(['other-enter', 'other-exit', 'child-enter'])
  })
  it('keeps healthy directory and exact attribution reads independent of unrelated damaged author history without reading the whole database', async () => {
    const f = await fixture(); await f.store.recordProvenance(f.attribution)
    const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(f.store.path)
    const insert = db.prepare('INSERT INTO provenance VALUES (?,?,?,?)')
    for (let i = 0; i < 200; i++) insert.run('unrelated-' + i, 'unrelated-resource', sha(String(i)), '{malformed unrelated attribution')
    db.close()
    io.database = f.store.path
    expect((await f.store.read()).revision).toBe(0)
    expect(await f.store.readProvenance({ ...f.attribution, blockIds: ['block'] })).toMatchObject({ status: 'recorded', blocks: f.attribution.blocks })
    expect(await f.store.readProvenance({ ...f.attribution, revision: sha('external-body'), blockIds: ['block'] })).toMatchObject({ status: 'unconfirmed', blocks: { block: { created: creator, lastEdited: null } } })
    expect(io.fullReads).toBe(0); expect(io.headerBytes).toBe(3 * 16)
  })
  it('never grants a valid foreign attribution payload stored under the requested SQL row key', async () => {
    const f = await fixture(); await f.store.recordProvenance(f.attribution)
    const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(f.store.path)
    db.prepare('UPDATE provenance SET json=?').run(JSON.stringify({ ...f.attribution, noteId: 'different-original' })); db.close()
    await expect(f.store.readProvenance({ ...f.attribution, blockIds: ['block'] })).rejects.toMatchObject({ code: 'NOTEBOOK_READ_UNCONFIRMED' })
    expect((await f.store.read()).revision).toBe(0)
    expect(await readFile(join(f.directory, f.resource.path), 'utf8')).toBe(f.body)
  })
  it('cuts over an explicit same-directory JSON body with exact revision receipts, backup and trusted historical authors', async () => {
    const f = await fixture(), legacy = { ...f.resource, path: 'old.note.json' }, source = join(f.directory, legacy.path), raw = '{original legacy bytes retained}', target = join(f.directory, 'old.note.md'), staged = join(f.root, 'staged.md')
    await writeFile(source, raw); await writeFile(staged, f.body)
    await f.store.apply({ expectedRevision: 0, operationId: 'old-page', change: { kind: 'register', noteId: 'original', title: 'Original', resource: legacy } }, { kind: 'user', id: 'owner' })
    const to = { ...legacy, path: 'old.note.md' }, backup = source + '.original-' + sha(raw).slice(7), change = { noteId: 'original', from: legacy, to, conversion: { sourceRevision: sha(raw), targetRevision: sha(f.body) } }
    const prepare = vi.fn(async () => ({ files: [{ source, destination: target, hash: sha(raw).slice(7), targetHash: sha(f.body).slice(7), preparedSource: staged, backup }], resourceChanges: [change], provenance: [{ ...f.attribution, resource: to }] }))
    await f.storage.convert({ operationId: 'old-body-format', expectedDirectory: f.directory }, prepare)
    expect(prepare).toHaveBeenCalledTimes(1); expect((await f.store.read()).pages.original?.resource).toEqual(to)
    expect(await f.store.readProvenance({ ...f.attribution, resource: to, blockIds: ['block'] })).toMatchObject({ status: 'recorded', blocks: f.attribution.blocks })
    expect(await readFile(target, 'utf8')).toBe(f.body); expect(await readFile(backup, 'utf8')).toBe(raw)
    await expect(readFile(source)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(staged)).rejects.toMatchObject({ code: 'ENOENT' })
    await f.storage.convert({ operationId: 'old-body-format', expectedDirectory: f.directory }, prepare); expect(prepare).toHaveBeenCalledTimes(1)
    expect((await f.storage.inspect()).resourceChanges).toContainEqual(change)
  })
  it('keeps partial conversion issues visible across owners while healthy Notes and writes remain available', async () => {
    const f = await fixture(), legacy = { ...f.resource, path: 'old.note.json' }, source = join(f.directory, legacy.path), target = { ...legacy, path: 'old.note.md' }, raw = 'original legacy bytes', staged = join(f.root, 'partial-staged.md')
    await writeFile(source, raw); await writeFile(staged, f.body)
    const remote = { hostId: 'remote-host', workspaceId: 'remote-workspace', workspacePath: _newTailFixturePath("remote"), path: 'remote.note.json' }
    let state = await f.store.apply({ expectedRevision: 0, operationId: 'healthy-page', change: { kind: 'register', noteId: 'original', title: 'Original', resource: legacy } }, { kind: 'user', id: 'owner' })
    await f.store.apply({ expectedRevision: state.revision, operationId: 'remote-page', change: { kind: 'register', noteId: 'remote-original', title: 'Remote', resource: remote } }, { kind: 'user', id: 'owner' })
    const issue = { noteId: 'remote-original', resource: remote, code: 'NOTE_REMOTE_UNAVAILABLE', message: 'The original remote host is unavailable; its original source is retained.' }
    await f.storage.convert({ operationId: 'healthy-partial-batch', expectedDirectory: f.directory }, async () => ({ files: [{ source, destination: join(f.directory, target.path), hash: sha(raw).slice(7), preparedSource: staged, targetHash: sha(f.body).slice(7), backup: source + '.original' }], resourceChanges: [{ noteId: 'original', from: legacy, to: target, conversion: { sourceRevision: sha(raw), targetRevision: sha(f.body) } }], provenance: [{ ...f.attribution, resource: target }], issues: [issue] }))
    const freshStorage = new AgentMuxNotesStorage(f.storage.locatorPath, _newTailFixturePath("unused")), fresh = new AgentMuxNotebookStore(undefined, freshStorage)
    expect((await freshStorage.inspect()).conversionIssues).toEqual([issue])
    state = await fresh.read(); expect(state.pages.original?.resource).toEqual(target); expect(state.pages['remote-original']?.resource).toEqual(remote)
    expect(await readFile(join(f.directory, target.path), 'utf8')).toBe(f.body)
    const locator = JSON.parse(await readFile(f.storage.locatorPath, 'utf8')); locator.conversionIssues = '{damaged observation}'; await writeFile(f.storage.locatorPath, JSON.stringify(locator))
    const nextBody = f.body + '\nLegitimate later input\n'
    await freshStorage.withLock(async () => { await writeFile(join(f.directory, target.path), nextBody); await fresh.recordProvenance({ ...f.attribution, resource: target, revision: sha(nextBody) }) })
    expect(await readFile(join(f.directory, target.path), 'utf8')).toBe(nextBody)
    expect((await freshStorage.inspect()).conversionIssues).toEqual([{ noteId: null, resource: null, code: 'CONVERSION_OBSERVATION_UNCONFIRMED', message: expect.any(String) }])
    expect((await fresh.read()).pages['remote-original']?.resource).toEqual(remote)
    await freshStorage.convert({ operationId: 'explicit-reobserve', expectedDirectory: f.directory }, async () => ({ files: [], resourceChanges: [], provenance: [], issues: [issue] }))
    expect((await new AgentMuxNotesStorage(f.storage.locatorPath, _newTailFixturePath("unused")).inspect()).conversionIssues).toEqual([issue])
  })
  it.each(['prepared', 'committed'] as const)('recovers an original %s JSON journal under the same operation identity without overwriting its recorded move', async phase => {
    const f = await fixture(), targetRoot = join(f.root, 'legacy target'); await mkdir(targetRoot)
    const from = { ...f.resource, path: 'one.note.json' }, oldTo = { ...from, workspacePath: targetRoot }, to = { ...oldTo, path: 'one.note.md' }
    const actor = { kind: 'user' as const, id: 'original-owner' }, raw = '{original old body bytes}', source = join(f.directory, from.path), oldTarget = join(targetRoot, oldTo.path), staged = join(f.root, 'prepared-markdown')
    await writeFile(source, raw); await writeFile(oldTarget, raw); await writeFile(staged, f.body)
    let before = applyNotebookChange(emptyNotebookState(), { expectedRevision: 0, operationId: 'original-page', change: { kind: 'register', noteId: 'original', title: 'Original', resource: from } }, actor, 1)
    before = applyNotebookChange(before, { expectedRevision: before.revision, operationId: 'original-follow', change: { kind: 'follow', noteId: 'original' } }, actor, 2)
    const after = applyNotebookChange(before, { expectedRevision: before.revision, operationId: 'legacy-move:original', change: { kind: 'relocate', noteId: 'original', from, resource: oldTo } }, actor, 3)
    const sourceCatalog = join(f.directory, 'notebooks.json'), sourceBytes = JSON.stringify(before)
    await writeFile(sourceCatalog, sourceBytes)
    if (phase === 'committed') await writeFile(join(targetRoot, 'notebooks.json'), JSON.stringify(after) + '\n')
    const old = { operationId: 'legacy-move', expectedDirectory: f.directory, directory: targetRoot, phase, resourceChanges: [{ noteId: 'original', from, to: oldTo }], files: [{ source, destination: oldTarget, hash: sha(raw).slice(7) }], catalog: after, sourceCatalog, sourceCatalogHash: sha(sourceBytes).slice(7) }
    await writeFile(f.storage.locatorPath, JSON.stringify({ schemaVersion: 1, directory: phase === 'prepared' ? f.directory : targetRoot, operations: { 'legacy-move': old }, pending: 'legacy-move', catalogEstablished: true }))
    const result = await f.storage.recoverLegacyOperation('legacy-move', async (original, snapshot) => {
      expect(original).toEqual(old); expect(snapshot.state).toEqual(phase === 'prepared' ? before : after)
      return { files: [source, oldTarget].map(path => ({ source: path, destination: join(targetRoot, to.path), hash: sha(raw).slice(7), targetHash: sha(f.body).slice(7), preparedSource: staged, backup: path + '.original-' + sha(raw).slice(7) })), resourceChanges: [from, oldTo].map(resource => ({ noteId: 'original', from: resource, to, conversion: { sourceRevision: sha(raw), targetRevision: sha(f.body) } })), provenance: [{ ...f.attribution, resource: to }] }
    })
    expect(result.operation).toMatchObject({ operationId: 'legacy-move', phase: 'committed', kind: 'convert' })
    const fresh = new AgentMuxNotebookStore(undefined, new AgentMuxNotesStorage(f.storage.locatorPath, _newTailFixturePath("unused"))), state = await fresh.read()
    expect(state.pages.original?.resource).toEqual(to); expect(state.pages.original?.followers).toEqual(before.pages.original?.followers)
    expect(state.operations['legacy-move:original']).toEqual(after.operations['legacy-move:original'])
    expect(state.operations['legacy-move:markdown:original']).toBeTruthy(); expect(state.trail.slice(0, after.trail.length)).toEqual(after.trail)
    expect(await fresh.readProvenance({ ...f.attribution, resource: to, blockIds: ['block'] })).toMatchObject({ status: 'recorded', blocks: f.attribution.blocks })
    for (const path of [source, oldTarget]) { await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' }); expect(await readFile(path + '.original-' + sha(raw).slice(7), 'utf8')).toBe(raw) }
  })
  it('moves Markdown and exact provenance together with original ids, followers and repeated operation receipts', async () => {
    const f = await fixture(); let state = await f.store.apply({ expectedRevision: 0, operationId: 'register', change: { kind: 'register', noteId: 'original', title: 'Original title', resource: f.resource } }, { kind: 'user', id: 'owner' })
    state = await f.store.apply({ expectedRevision: state.revision, operationId: 'follow', change: { kind: 'follow', noteId: 'original' } }, { kind: 'agent', id: 'follower' })
    await f.store.recordProvenance(f.attribution)
    const target = join(f.root, 'new notes'), input = { operationId: 'original-move', expectedDirectory: f.directory, directory: target }
    await f.storage.change(input)
    const fresh = new AgentMuxNotebookStore(undefined, new AgentMuxNotesStorage(f.storage.locatorPath, _newTailFixturePath("unused"))), actual = await fresh.read()
    expect(actual.pages.original?.followers).toEqual(state.pages.original?.followers)
    expect(actual.trail.slice(0, 2)).toEqual(state.trail)
    expect(await fresh.readProvenance({ ...f.attribution, resource: { ...f.resource, workspacePath: target }, blockIds: ['block'] })).toMatchObject({ status: 'recorded', blocks: f.attribution.blocks })
    expect(await readFile(join(target, f.resource.path), 'utf8')).toBe(f.body)
    await expect(readFile(join(f.directory, f.resource.path))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await f.storage.change(input)).toEqual(await f.storage.inspect(input.operationId))
    const operation = (await f.storage.inspect(input.operationId)).operation!
    await expect(readFile(operation.database!.snapshotPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readNotebookDatabase(join(target, 'notebooks.sqlite')))?.provenance).toHaveLength(1)
  })
})
