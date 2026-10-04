import { fixturePath } from './helpers/fixture-values.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentMuxNotebookStore, AgentMuxNotesStorage } from '../src/notebook-store.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
const directorySyncFault = vi.hoisted(() => ({ path: '', attempts: 0, failNext: false }))
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, open: async (...args: Parameters<typeof original.open>) => {
    const file = await original.open(...args)
    if (String(args[0]) === directorySyncFault.path && args[1] === 'r') {
      const sync = file.sync.bind(file)
      file.sync = async () => {
        directorySyncFault.attempts++
        if (directorySyncFault.failNext) { directorySyncFault.failNext = false; throw new Error('Directory sync unconfirmed') }
        return sync()
      }
    }
    return file
  } }
})
const directories: string[] = []
afterEach(async () => { directorySyncFault.path = ''; directorySyncFault.attempts = 0; directorySyncFault.failNext = false; for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'notes-owner-')); directories.push(root)
  const original = join(root, 'original'), target = join(root, 'new library'), location = join(root, 'state', 'notes-location.json')
  await mkdir(original); const bytes = JSON.stringify({ schema: 'agentmux.note.v1', noteId: 'original-note', content: { blockId: 'original-block', text: 'Saved content' } })
  await writeFile(join(original, 'one.note.json'), bytes)
  const store = new AgentMuxNotebookStore(join(original, 'notebooks.json'))
  await store.apply({ expectedRevision: 0, operationId: 'register', change: { kind: 'register', noteId: 'original-note', title: 'Original title', resource: { hostId: 'local', workspaceId: '__notes__', workspacePath: original, path: 'one.note.json' }, source: { sourceId: 'source-original', url: 'https://example.test', title: 'Source', recordedAt: 1 } } }, { kind: 'user', id: 'original-user' })
  return { root, original, target, location, bytes, storage: new AgentMuxNotesStorage(location, original), before: await store.read() }
}
describe('one durable Notes directory operation', () => {
  it('moves real bytes and catalog, preserving identities and source history through a fresh owner', async () => {
    const f = await fixture(), operation = { operationId: 'change-original', expectedDirectory: f.original, directory: f.target }
    const result = await f.storage.change(operation)
    expect(result.directory).toBe(f.target); expect(result.operation?.phase).toBe('committed')
    expect(await readFile(join(f.target, 'one.note.json'), 'utf8')).toBe(f.bytes)
    await expect(readFile(join(f.original, 'one.note.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    const restarted = new AgentMuxNotesStorage(f.location, fixturePath("unused")), reopened = new AgentMuxNotebookStore(undefined, restarted)
    const state = await reopened.read()
    expect(state.pages['original-note']).toMatchObject({ noteId: 'original-note', resource: { workspaceId: '__notes__', workspacePath: f.target }, sources: f.before.pages['original-note']!.sources })
    expect(state.trail[0]).toEqual(f.before.trail[0]); expect(state.trail.at(-1)?.action).toBe('relocated')
    expect(await f.storage.change(operation)).toEqual(await restarted.inspect('change-original'))
    expect((await reopened.read()).trail).toHaveLength(2)
    const rpc = new AgentMuxRpcService({ notebookStore: reopened })
    const inspected = await rpc.call('notebook.inspect', { operationId: 'change-original' })
    expect(inspected.storageOperation?.phase).toBe('committed')
  })
  it('retains original catalog and bytes when a target file conflicts, then resumes exactly once', async () => {
    const f = await fixture(); await mkdir(f.target); await writeFile(join(f.target, 'one.note.json'), 'other data')
    const op = { operationId: 'original-conflict', expectedDirectory: f.original, directory: f.target }
    await expect(f.storage.change(op)).rejects.toMatchObject({ code: 'NOTES_STORAGE_CONFLICT' })
    expect((await f.storage.inspect()).catalogPath).toBe(join(f.original, 'notebooks.json'))
    expect(await readFile(join(f.original, 'one.note.json'), 'utf8')).toBe(f.bytes)
    await rm(join(f.target, 'one.note.json')); const next = new AgentMuxNotesStorage(f.location, fixturePath("unused")); await next.resume()
    expect((await next.inspect('original-conflict')).operation?.phase).toBe('committed')
    expect(await readFile(join(f.target, 'one.note.json'), 'utf8')).toBe(f.bytes)
  })
  it('rejects changed original bytes, reused operation identity and nested target without erasing work', async () => {
    const f = await fixture(); await expect(f.storage.change({ operationId: 'nested', expectedDirectory: f.original, directory: join(f.original, 'child') })).rejects.toMatchObject({ code: 'NOTES_STORAGE_INPUT_INVALID' })
    const op = { operationId: 'original', expectedDirectory: f.original, directory: f.target }; await f.storage.change(op)
    await expect(f.storage.change({ ...op, directory: join(f.root, 'third') })).rejects.toMatchObject({ code: 'NOTES_STORAGE_INPUT_INVALID' })
    expect(await readFile(join(f.target, 'one.note.json'), 'utf8')).toBe(f.bytes)
  })
  it('rejects a different Note identity and never substitutes an empty directory after a confirmed catalog is lost', async () => {
    const f = await fixture(); await writeFile(join(f.original, 'one.note.json'), JSON.stringify({ noteId: 'different-note' }))
    await expect(f.storage.change({ operationId: 'invalid-identity', expectedDirectory: f.original, directory: f.target })).rejects.toThrow('identity')
    const guarded = new AgentMuxNotebookStore(undefined, f.storage)
    await f.storage.withLock(() => f.storage.confirmCatalog()); await rm(join(f.original, 'notebooks.json'))
    await expect(guarded.read()).rejects.toMatchObject({ code: 'NOTEBOOK_READ_UNCONFIRMED' })
    await expect(f.storage.change({ operationId: 'missing-catalog', expectedDirectory: f.original, directory: f.target })).rejects.toMatchObject({ code: 'NOTEBOOK_READ_UNCONFIRMED' })
    expect((await f.storage.inspect()).directory).toBe(f.original)
  })
  it('moves an already written managed Note without inventing a catalog page, retaining capture recovery identity', async () => {
    const f = await fixture(); await mkdir(join(f.original, 'nested'))
    const bytes = JSON.stringify({ schema: 'agentmux.note.v1', noteId: 'written-unregistered', content: { blockId: 'same-capture-block', text: 'Original capture' } })
    await writeFile(join(f.original, 'nested', 'pending.note.json'), bytes)
    await writeFile(join(f.original, 'project.txt'), 'unrelated project')
    const result = await f.storage.change({ operationId: 'with-pending-capture', expectedDirectory: f.original, directory: f.target })
    expect(await readFile(join(f.target, 'nested', 'pending.note.json'), 'utf8')).toBe(bytes)
    await expect(readFile(join(f.original, 'nested', 'pending.note.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(result.resourceChanges).toContainEqual({ noteId: 'written-unregistered', from: { hostId: 'local', workspaceId: '__notes__', workspacePath: f.original, path: 'nested/pending.note.json' }, to: { hostId: 'local', workspaceId: '__notes__', workspacePath: f.target, path: 'nested/pending.note.json' } })
    expect((await new AgentMuxNotebookStore(undefined, f.storage).read()).pages['written-unregistered']).toBeUndefined()
    expect(await readFile(join(f.original, 'project.txt'), 'utf8')).toBe('unrelated project')
  })
  it('retains ambiguous managed bytes whose identity already belongs to a foreign registered Note', async () => {
    const f = await fixture(), foreignRoot = join(f.root, 'project'); await mkdir(foreignRoot)
    const store = new AgentMuxNotebookStore(join(f.original, 'notebooks.json'))
    await store.apply({ expectedRevision: f.before.revision, operationId: 'foreign-page', change: { kind: 'register', noteId: 'foreign-note', title: 'Project note', resource: { hostId: 'local', workspaceId: 'project', workspacePath: foreignRoot, path: 'foreign.note.json' } } }, { kind: 'user', id: 'original-user' })
    const bytes = JSON.stringify({ schema: 'agentmux.note.v1', noteId: 'foreign-note', content: 'Keep ambiguous bytes' })
    await writeFile(join(f.original, 'unregistered.note.json'), bytes)
    await expect(f.storage.change({ operationId: 'ambiguous-identity', expectedDirectory: f.original, directory: f.target })).rejects.toMatchObject({ code: 'NOTES_STORAGE_UNCONFIRMED' })
    expect((await f.storage.inspect()).directory).toBe(f.original); expect(await readFile(join(f.original, 'unregistered.note.json'), 'utf8')).toBe(bytes)
    expect((await store.read()).pages['foreign-note']?.resource.workspaceId).toBe('project')
  })
  it('keeps original prepared operation recoverable if bytes change after the first copy fails', async () => {
    const f = await fixture(); await mkdir(f.target); await writeFile(join(f.target, 'one.note.json'), 'occupied')
    await expect(f.storage.change({ operationId: 'prepared-original', expectedDirectory: f.original, directory: f.target })).rejects.toMatchObject({ code: 'NOTES_STORAGE_CONFLICT' })
    await rm(join(f.target, 'one.note.json')); await writeFile(join(f.original, 'one.note.json'), f.bytes + ' ')
    await expect(f.storage.resume()).rejects.toMatchObject({ code: 'NOTES_STORAGE_CONFLICT' })
    expect((await f.storage.inspect('prepared-original')).operation?.phase).toBe('prepared')
    expect((await f.storage.inspect()).directory).toBe(f.original)
    await writeFile(join(f.original, 'one.note.json'), f.bytes); await f.storage.resume()
    expect((await f.storage.inspect()).directory).toBe(f.target)
  })
  it.each(['missing body', 'changed body', 'missing catalog', 'changed catalog'])('never deletes the last good sources on a committed retry with %s', async damage => {
    const f = await fixture(); let acknowledged = false
    const storage = new AgentMuxNotesStorage(f.location, f.original, { beforeSourceCleanup: async () => { if (!acknowledged) throw new Error('Host references not acknowledged') } })
    const operation = { operationId: 'committed-original', expectedDirectory: f.original, directory: f.target }
    await expect(storage.change(operation)).rejects.toThrow('not acknowledged')
    expect((await storage.inspect(operation.operationId)).operation?.phase).toBe('committed')
    if (damage === 'missing body') await rm(join(f.target, 'one.note.json'))
    if (damage === 'changed body') await writeFile(join(f.target, 'one.note.json'), 'damaged target')
    if (damage === 'missing catalog') await rm(join(f.target, 'notebooks.json'))
    if (damage === 'changed catalog') { const catalog = JSON.parse(await readFile(join(f.target, 'notebooks.json'), 'utf8')); catalog.pages['original-note'].resource.workspacePath = f.original; await writeFile(join(f.target, 'notebooks.json'), JSON.stringify(catalog)) }
    acknowledged = true; await expect(storage.change(operation)).rejects.toThrow()
    expect(await readFile(join(f.original, 'one.note.json'), 'utf8')).toBe(f.bytes)
    expect(await readFile(join(f.original, 'notebooks.json'), 'utf8')).toContain('original-note')
  })
  it.each(['source', 'destination'])('does not overwrite a %s Notebook catalog changed while the original operation was prepared', async changed => {
    const f = await fixture(); await mkdir(f.target); await writeFile(join(f.target, 'one.note.json'), 'occupied body')
    await expect(f.storage.change({ operationId: 'prepared-catalog', expectedDirectory: f.original, directory: f.target })).rejects.toMatchObject({ code: 'NOTES_STORAGE_CONFLICT' })
    await rm(join(f.target, 'one.note.json'))
    const path = join(changed === 'source' ? f.original : f.target, 'notebooks.json'), bytes = JSON.stringify({ ...f.before, revision: f.before.revision + 1 })
    await writeFile(path, bytes); await expect(f.storage.resume()).rejects.toMatchObject({ code: 'NOTES_STORAGE_CONFLICT' })
    expect(await readFile(path, 'utf8')).toBe(bytes); expect((await f.storage.inspect()).directory).toBe(f.original)
    expect(await readFile(join(f.original, 'one.note.json'), 'utf8')).toBe(f.bytes)
  })
  it('retains every original when one Note changes during host acknowledgement', async () => {
    const f = await fixture(), secondPath = join(f.original, 'two.note.json')
    await writeFile(secondPath, JSON.stringify({ schema: 'agentmux.note.v1', noteId: 'second-note', content: 'Second original' }))
    const changed = JSON.stringify({ schema: 'agentmux.note.v1', noteId: 'second-note', content: 'New original input during acknowledgement' })
    const storage = new AgentMuxNotesStorage(f.location, f.original, { beforeSourceCleanup: async () => { await writeFile(secondPath, changed) } })
    await expect(storage.change({ operationId: 'changed-during-ack', expectedDirectory: f.original, directory: f.target })).rejects.toThrow('during the host acknowledgement')
    expect(await readFile(join(f.original, 'one.note.json'), 'utf8')).toBe(f.bytes)
    expect(await readFile(secondPath, 'utf8')).toBe(changed)
    expect(await readFile(join(f.original, 'notebooks.json'), 'utf8')).toContain('original-note')
    expect((await storage.inspect()).operation?.operationId).toBe('changed-during-ack')
  })
  it('reconfirms directory durability when retrying an already published Note after sync failed', async () => {
    const f = await fixture(), operation = { operationId: 'directory-sync-retry', expectedDirectory: f.original, directory: f.target }
    directorySyncFault.path = f.target; directorySyncFault.failNext = true
    await expect(f.storage.change(operation)).rejects.toThrow('Directory sync unconfirmed')
    expect(directorySyncFault.attempts).toBe(1)
    expect(await readFile(join(f.target, 'one.note.json'), 'utf8')).toBe(f.bytes)
    expect(await readFile(join(f.original, 'one.note.json'), 'utf8')).toBe(f.bytes)
    expect((await f.storage.inspect()).operation?.phase).toBe('prepared')
    await f.storage.change(operation)
    expect(directorySyncFault.attempts).toBeGreaterThanOrEqual(3)
    expect(await readFile(join(f.target, 'one.note.json'), 'utf8')).toBe(f.bytes)
    expect((await f.storage.inspect()).operation).toBeNull()
    await expect(readFile(join(f.original, 'one.note.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('bootstrap uses the same operation, moving only registered flat local scratch notes', async () => {
    const f = await fixture(); const legacy = join(f.root, 'legacy', 'notebooks.json'); await mkdir(join(f.root, 'legacy')); await writeFile(legacy, JSON.stringify({ ...f.before, pages: { ...f.before.pages, 'original-note': { ...f.before.pages['original-note'], resource: { ...f.before.pages['original-note']!.resource, workspaceId: '__scratch__' } } } }))
    await writeFile(join(f.original, 'unrelated.txt'), 'keep this'); const storage = new AgentMuxNotesStorage(join(f.root, 'otherstate', 'notes-location.json'), f.target)
    await storage.bootstrap({ catalogPath: legacy, workspace: { id: '__scratch__', hostId: 'local', path: f.original }, destinationWorkspaceId: '__notes__' })
    expect((await storage.inspect('adopt-original-notes-directory')).operation?.resourceChanges[0]?.to.workspaceId).toBe('__notes__')
    expect(await readFile(join(f.original, 'unrelated.txt'), 'utf8')).toBe('keep this')
    expect(await readFile(join(f.target, 'one.note.json'), 'utf8')).toBe(f.bytes)
  })
})
