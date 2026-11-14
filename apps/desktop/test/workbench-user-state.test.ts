import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { durableWriteFile, recoveryDigest } from '@agentmux/core'
import { DatabaseSync } from 'node:sqlite'
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state'
import type { WorkbenchInputQueueChange } from '../src/shared/workbench-user-state'

const roots: string[] = []
const value = (text: string) => JSON.stringify({ version: 1, state: {
  agentComposerDrafts: { 'original-region': text },
  agentSteerQueues: { 'original-session': [{ operationId: 'original-input', text, expectedRunId: 'original-run' }] },
  documents: { 'original-workspace\0notes.md': { text, baseRevision: 'original-file-revision' } },
  arbitraryRetainedField: { original: true }
} })
const decoded = (raw: string | null) => JSON.parse(raw!)
const readDocument = async (owner: WorkbenchUserStateStore) => decoded(await owner.read())
const archived = (operationId: string, enqueuedAt: number, text = operationId) => {
  const run = { runId: 'original-run' }, key = { kind: 'prompt', agentSessionId: 'original-session', submissionId: operationId, expectedRun: run }
  const ref = { key, waitGeneration: 1 }
  return { operationId, enqueuedAt, text, archived: true,
    directInputControl: { kind: 'agent', hostId: 'local', agentSessionId: 'original-session', run },
    directInputBinding: { expectedRun: run },
    inputReceipt: { status: 'terminal-confirmed', persistence: 'confirmed', observation: 'closed', key, ref,
      control: { ref, state: 'dispatch-authorized', at: enqueuedAt, gateId: 'original-gate' } } }
}
const save = (draft: string, changes: WorkbenchInputQueueChange[] = []) =>
  JSON.stringify({ version: 1, state: { agentComposerDrafts: { 'original-region': draft } }, inputQueueDelta: { changes } })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-user-state-')); roots.push(root)
  return { root, path: join(root, 'workbench-user-state.json') }
}

afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 }))) })

function child(args: string[]): Promise<any> {
  const source = pathToFileURL(resolve('apps/desktop/src/main/workbench-user-state.ts')).href
  const worker = `
    import { WorkbenchUserStateStore } from ${JSON.stringify(source)};
    const [path, operation, value] = process.argv.slice(1);
    const owner = new WorkbenchUserStateStore(path);
    const result = operation === 'write' ? await owner.write(value) : await owner.read();
    await owner.flushDiagnostics();
    process.stdout.write(JSON.stringify({ result, observation: owner.observe() }));`
  const loader = resolve('packages/core/scripts/helpers/core-source-loader.mjs')
  return new Promise((yes, no) => {
    const process = spawn(globalThis.process.execPath, ['--import', loader, '--input-type=module', '--eval', worker, '--', ...args],
      { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', errors = ''
    process.stdout.on('data', data => { output += data }); process.stderr.on('data', data => { errors += data })
    process.on('error', no); process.on('close', code => {
      if (code !== 0) no(new Error('User-state process failed: ' + errors))
      else { try { yes(JSON.parse(output)) } catch (error) { no(error) } }
    })
  })
}

describe('Main-owned Desktop user state', () => {
  it('distinguishes absence, holds original user members and returns a producer receipt for the exact bytes', async () => {
    const { path } = await fixture(), owner = new WorkbenchUserStateStore(path)
    expect(await owner.read()).toBeNull()
    expect(owner.observe()).toMatchObject({ availability: 'missing', diskDurability: 'unconfirmed' })
    const original = '\n' + value('Unsent original input') + '\n'
    const receipt = await owner.write(original)
    expect(receipt).toMatchObject({ path, diskDurability: 'confirmed', sizeBytes: Buffer.byteLength(original) })
    expect(receipt.contentDigest).toMatch(/^[a-f0-9]{64}$/)
    expect((await readFile(owner.databasePath)).subarray(0, 16).toString()).toBe('SQLite format 3\0')
    expect(await readDocument(owner)).toEqual(decoded(original))
    expect(owner.observe()).toMatchObject({ availability: 'present', contentDigest: receipt.contentDigest,
      diskDurability: 'unconfirmed', confirmedAt: null, lastConfirmedWrite: receipt, lastFailure: null })
    expect((await stat(owner.databasePath)).mode & 0o777).toBe(0o600)
  })

  it('queues reads and later writes behind the originally admitted write', async () => {
    const { path } = await fixture()
    let release!: () => void, started!: () => void
    const gate = new Promise<void>(resolve => { release = resolve }), ready = new Promise<void>(resolve => { started = resolve })
    const owner = new WorkbenchUserStateStore(path, { syncDirectory: async () => { started(); await gate } })
    const first = owner.write(value('First'))
    await ready
    const reading = owner.read(), second = owner.write(value('Second'))
    expect(owner.observe().lastConfirmedWrite).toBeNull()
    release()
    await first
    expect(decoded(await reading)).toEqual(decoded(value('First')))
    await second
    expect(await readDocument(owner)).toEqual(decoded(value('Second')))
  })

  it('retains the original file after failed migration and records safe cross-restart failure metadata', async () => {
    const { path } = await fixture(), original = value('Private original draft')
    await writeFile(path, original)
    const obstruction = path + '.original-' + recoveryDigest(original) + '.json'
    await mkdir(obstruction)
    const owner = new WorkbenchUserStateStore(path)
    await expect(owner.write(value('Newest unsaved input'))).rejects.toMatchObject({ phase: 'before-replace', code: 'EISDIR' })
    expect(await readFile(path, 'utf8')).toBe(original)
    await expect(readFile(owner.databasePath)).rejects.toMatchObject({ code: 'ENOENT' })
    await owner.flushDiagnostics()
    const diagnostic = await readFile(path + '.failure.json', 'utf8')
    expect(diagnostic).not.toContain('Private')
    expect(diagnostic).not.toContain('Newest')
    await rm(obstruction, { recursive: true })
    const restarted = await child([path, 'read'])
    expect(decoded(restarted.result)).toEqual(decoded(original))
    expect(restarted.observation).toMatchObject({ diskDurability: 'unconfirmed', lastFailure: { operation: 'read', phase: 'before-replace', code: 'EISDIR' } })
    await expect(owner.write(value('Newest unsaved input'))).resolves.toMatchObject({ diskDurability: 'confirmed' })
    expect(await readDocument(owner)).toEqual(decoded(value('Newest unsaved input')))
  })

  it('reconfirms identical bytes after an after-replace directory-sync failure', async () => {
    const { path } = await fixture(), input = value('Original input remains pending')
    let writes = 0
    const owner = new WorkbenchUserStateStore(path, { syncDirectory: async () => {
      if (++writes === 1) throw Object.assign(new Error('Directory sync failed'), { code: 'EIO' })
    } })
    await expect(owner.write(input)).rejects.toMatchObject({ phase: 'after-replace' })
    expect(await readDocument(owner)).toEqual(decoded(input))
    expect(owner.observe()).toMatchObject({ diskDurability: 'unconfirmed', confirmedAt: null })
    await expect(owner.write(input)).resolves.toMatchObject({ diskDurability: 'confirmed' })
    expect(writes).toBe(2)
    expect(owner.observe().lastFailure).toMatchObject({ phase: 'after-replace', code: 'EIO' })
  })

  it('does not replace corrupt original data with a valid new or empty document', async () => {
    const { path } = await fixture(), corrupt = '{ "private original draft": '
    await writeFile(path, corrupt)
    const owner = new WorkbenchUserStateStore(path)
    await expect(owner.read()).rejects.toMatchObject({ code: 'WORKBENCH_USER_STATE_INVALID' })
    await expect(owner.write(value('New default'))).rejects.toMatchObject({ code: 'WORKBENCH_USER_STATE_INVALID' })
    expect(await readFile(path, 'utf8')).toBe(corrupt)
    await owner.flushDiagnostics()
    expect(await readFile(path + '.failure.json', 'utf8')).not.toContain('private original draft')
    expect(owner.observe()).toMatchObject({ availability: 'unconfirmed', diskDurability: 'unconfirmed' })
  })

  it('rejects only malformed incoming writes and keeps the healthy saved state available', async () => {
    const { path } = await fixture(), owner = new WorkbenchUserStateStore(path)
    const receipt = await owner.write(value('Saved'))
    for (const invalid of ['', '{}', '{"state":[],"version":1}', '{"state":{},"version":"1"}', 'null']) {
      await expect(owner.write(invalid)).rejects.toMatchObject({ code: 'WORKBENCH_USER_STATE_INVALID' })
      expect(await readDocument(owner)).toEqual(decoded(value('Saved')))
      expect(owner.observe()).toMatchObject({ diskDurability: 'unconfirmed', contentDigest: receipt.contentDigest,
        lastConfirmedWrite: receipt, lastFailure: { phase: 'request' } })
    }
  })

  it('does not turn a read failure into absence or poison the later explicit retry', async () => {
    const { path } = await fixture(), original = value('Preserved')
    await writeFile(path, original)
    let unavailable = true
    const owner = new WorkbenchUserStateStore(path, { read: async (target, encoding) => {
      if (target === path && unavailable) throw Object.assign(new Error('Private denied source'), { code: 'EACCES' })
      return readFile(target, encoding)
    } })
    await expect(owner.read()).rejects.toMatchObject({ code: 'EACCES' })
    await expect(owner.write(value('New'))).rejects.toMatchObject({ code: 'EACCES' })
    expect(await readFile(path, 'utf8')).toBe(original)
    unavailable = false
    expect(await readDocument(owner)).toEqual(decoded(original))
    await expect(owner.write(value('New'))).resolves.toMatchObject({ diskDurability: 'confirmed' })
  })

  it('obtains a writer ACK for identical explicit saves; a process read cannot manufacture that receipt', async () => {
    const { path } = await fixture()
    const owner = new WorkbenchUserStateStore(path)
    const receipt = await owner.write(value('Same'))
    expect(await owner.write(value('Same'))).toMatchObject({ ...receipt, confirmedAt: expect.any(Number) })
    const restarted = new WorkbenchUserStateStore(path)
    expect(await readDocument(restarted)).toEqual(decoded(value('Same')))
    expect(restarted.observe().diskDurability).toBe('unconfirmed')
    await expect(restarted.write(value('Same'))).resolves.toMatchObject({ ...receipt, confirmedAt: expect.any(Number) })
  })

  it('reads exact original drafts, queue identities and unsaved content from a second real process', async () => {
    const { path } = await fixture(), original = value('Original bytes survive process exit')
    const written = await child([path, 'write', original])
    expect(written.result.diskDurability).toBe('confirmed')
    const recovered = await child([path, 'read'])
    expect(decoded(recovered.result)).toEqual(decoded(original))
    expect(JSON.parse(recovered.result)).toMatchObject({ version: 1, state: {
      agentComposerDrafts: { 'original-region': 'Original bytes survive process exit' },
      agentSteerQueues: { 'original-session': [{ operationId: 'original-input', expectedRunId: 'original-run' }] },
      arbitraryRetainedField: { original: true }
    } })
    expect(recovered.observation.diskDurability).toBe('unconfirmed')
    expect(recovered.observation.lastConfirmedWrite).toBeNull()
  })

  it('does not extend an original writer ACK to an externally replaced equal-byte file', async () => {
    const { path } = await fixture(), original = value('Same bytes, another file')
    const owner = new WorkbenchUserStateStore(path), receipt = await owner.write(original)
    expect(owner.observe()).toMatchObject({ diskDurability: 'confirmed', lastConfirmedWrite: receipt })
    await durableWriteFile(owner.databasePath, await readFile(owner.databasePath), { requireDirectorySync: true })
    expect(await readDocument(owner)).toEqual(decoded(original))
    expect(owner.observe()).toMatchObject({ availability: 'unconfirmed', contentDigest: null,
      diskDurability: 'unconfirmed', confirmedAt: null, lastConfirmedWrite: receipt })
  })

  it('does not confirm unchanged receipt metadata after an external SQLite update', async () => {
    const { path } = await fixture(), owner = new WorkbenchUserStateStore(path), original = value('Original author')
    const receipt = await owner.write(original)
    const database = new DatabaseSync(owner.databasePath)
    try {
      database.prepare("UPDATE document_rows SET body = ? WHERE scope = 'agentComposerDrafts' AND name = 'original-region'")
        .run(JSON.stringify('Foreign author'))
    } finally { database.close() }
    expect((await readDocument(owner)).state.agentComposerDrafts['original-region']).toBe('Foreign author')
    expect(owner.observe()).toMatchObject({ availability: 'unconfirmed', contentDigest: null, lastConfirmedWrite: receipt })
    await expect(owner.write(original)).rejects.toMatchObject({ code: 'WORKBENCH_USER_DATABASE_CHANGED' })
  })

  it('keeps original user data available when its diagnostic sidecar is malformed', async () => {
    const { path } = await fixture(), original = value('Healthy original')
    await new WorkbenchUserStateStore(path).write(original)
    await writeFile(path + '.failure.json', 'invalid diagnostic')
    expect(await readDocument(new WorkbenchUserStateStore(path))).toEqual(decoded(original))
  })

  it('imports only within the original native queue and returns a concurrent normal write as the winner', async () => {
    const { path } = await fixture(), owner = new WorkbenchUserStateStore(path)
    expect(await owner.read()).toBeNull()
    const latest = value('Newest legitimate user write'), old = value('Stale imported browser data')
    const written = owner.write(latest), imported = owner.importIfAbsent(old)
    await written
    expect(decoded(await imported)).toEqual(decoded(latest))
    expect(await readDocument(owner)).toEqual(decoded(latest))
  })

  it('imports exact existing user bytes once and never overwrites the native winner', async () => {
    const { path } = await fixture(), owner = new WorkbenchUserStateStore(path), original = value('Original imported bytes')
    expect(await owner.importIfAbsent(original)).toBe(original)
    expect(owner.observe()).toMatchObject({ diskDurability: 'confirmed', lastConfirmedWrite: { diskDurability: 'confirmed' } })
    expect(decoded(await owner.importIfAbsent('malformed stale source'))).toEqual(decoded(original))
    expect(await readDocument(owner)).toEqual(decoded(original))
  })

  it('does not let a stalled auxiliary diagnostic block the original failure or the next user save', async () => {
    const { path } = await fixture()
    let release!: () => void, started!: () => void, fail = true
    const held = new Promise<void>(yes => { release = yes }), ready = new Promise<void>(yes => { started = yes })
    const owner = new WorkbenchUserStateStore(path, { syncDirectory: async () => {
      if (fail) { fail = false; throw Object.assign(new Error('Original failure'), { code: 'ENOSPC' }) }
    }, write: async (target, body, options) => {
      if (target.endsWith('.failure.json')) { started(); await held }
      return durableWriteFile(target, body, options)
    } })
    try {
      await expect(owner.write(value('Original failed input'))).rejects.toMatchObject({ code: 'ENOSPC' })
      await ready
      await expect(owner.write(value('New explicit retry'))).resolves.toMatchObject({ diskDurability: 'confirmed' })
      expect(await readDocument(owner)).toEqual(decoded(value('New explicit retry')))
    } finally { release(); await owner.flushDiagnostics() }
  })
  it('acknowledges an equal concurrent native winner before legacy import may release its bytes', async () => {
    const { path } = await fixture(), original = value('Equal retained original')
    await writeFile(path, original)
    const syncDirectory = vi.fn(async () => { throw Error('Winner directory sync unconfirmed') })
    const owner = new WorkbenchUserStateStore(path, { syncDirectory })
    await expect(owner.importIfAbsent(original)).rejects.toThrow('Winner directory sync unconfirmed')
    expect(syncDirectory).toHaveBeenCalledTimes(1)
    expect(await readFile(path, 'utf8')).toBe(original)
    expect(owner.observe().lastConfirmedWrite).toBeNull()
  })

  it('a stalled historical diagnostic read does not delay user data or overwrite a newer failure', async () => {
    const { path } = await fixture(), original = value('Healthy original')
    await writeFile(path, original)
    let release!: (value: string) => void
    const historical = new Promise<string>(resolve => { release = resolve })
    const owner = new WorkbenchUserStateStore(path, { read: (file, encoding) => file.endsWith('.failure.json') ? historical : readFile(file, encoding) })
    try {
      let settled = false
      const reading = owner.read().then(value => { settled = true; return value })
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 1000 })
      expect(decoded(await reading)).toEqual(decoded(original))
      await expect(owner.write(value('Still usable'))).resolves.toMatchObject({ diskDurability: 'confirmed' })
      await expect(owner.write('malformed')).rejects.toThrow()
      const current = owner.observe().lastFailure
      release(JSON.stringify({ schema: 'agentmux.workbench-user-state-failure.v1', failure: {
        operation: 'read', phase: null, code: 'OLDER_DIAGNOSTIC', observedAt: 1 } }))
      await Promise.resolve()
      expect(owner.observe().lastFailure).toEqual(current)
      expect(owner.observe().lastFailure?.code).toBe('WORKBENCH_USER_STATE_INVALID')
    } finally { release('{}'); await owner.flushDiagnostics() }
  })

  it('rolls back the draft when the same move to draft cannot archive its original queue row', async () => {
    const { path } = await fixture(), owner = new WorkbenchUserStateStore(path), frame = {}
    const pending = { operationId: 'original-input', text: 'queued body', runId: 'original-run', status: 'queued' }
    const before = JSON.stringify({ version: 1, state: { agentComposerDrafts: { 'original-region': 'original draft' },
      agentSteerQueues: { 'original-session': [pending] } } })
    await owner.write(before)
    const database = new DatabaseSync(owner.databasePath)
    try {
      database.exec(`CREATE TRIGGER reject_archive BEFORE UPDATE OF body ON input_queue
        WHEN OLD.owner = 'original-session' BEGIN SELECT RAISE(ABORT, 'test simulated archive write failure'); END;`)
      const moved = { ...pending, archived: true, movedToDraft: true }
      const payload = save('original draft\n\nqueued body', [{ ownerKey: 'original-session',
        order: [pending.operationId], upsert: [{ operationId: pending.operationId, entry: moved }], remove: [] }])
      const request = { value: payload, writeRevision: 1 }
      const rendererOwner = new WorkbenchUserStateStore(path)
      await expect(rendererOwner.writeFromRenderer(frame, request, () => true)).rejects.toThrow('test simulated archive write failure')
      expect(await readDocument(new WorkbenchUserStateStore(path))).toEqual(decoded(before))
      database.exec('DROP TRIGGER reject_archive')
      await expect(rendererOwner.writeFromRenderer(frame, request, () => true)).resolves.toMatchObject({
        writeRevision: 1, contentDigest: recoveryDigest(payload), diskDurability: 'confirmed'
      })
      const recovered = await child([path, 'read'])
      expect(decoded(recovered.result).state).toEqual({
        agentComposerDrafts: { 'original-region': 'original draft\n\nqueued body' }, agentSteerQueues: { 'original-session': [moved] }
      })
    } finally { database.close() }
  })

  it('cuts eligible old archived bodies out of the hot snapshot and pages exact saved rows', async () => {
    const { path } = await fixture(), owner = new WorkbenchUserStateStore(path), frame = {}
    const a = archived('archive-a', 20), b = archived('archive-b', 20), c = archived('archive-c', 10)
    const pending = { operationId: 'pending', text: 'still held', awaitingExplicitSend: true }
    const original = JSON.stringify({ version: 1, state: { agentComposerDrafts: { 'original-region': 'older draft' },
      agentSteerQueues: { 'original-session': [a, b, c, pending], elsewhere: Array.from({ length: 128 }, (_, index) =>
        archived('unrelated-' + index, 100 + index, 'unrelated body '.repeat(2048))) } } })
    await writeFile(path, original)
    const active = await readDocument(owner)
    expect(Object.keys(active.state.agentSteerQueues)).toEqual(['original-session'])
    expect(active.state.agentSteerQueues).toEqual({ 'original-session': [pending] })
    expect(await readFile(path, 'utf8')).toBe(original)
    expect(await readFile(path + '.original-' + recoveryDigest(original) + '.json', 'utf8')).toBe(original)
    const first = await owner.readInputArchive({ ownerKey: 'original-session', limit: 2 })
    expect(first.entries).toEqual([{ ownerKey: 'original-session', entry: b }, { ownerKey: 'original-session', entry: a }])
    expect(first.nextCursor).not.toBeNull()
    expect(await owner.readInputArchive({ ownerKey: 'original-session', after: first.nextCursor!, limit: 2 }))
      .toEqual({ entries: [{ ownerKey: 'original-session', entry: c }], nextCursor: null })
    expect(await owner.readInputArchive({ ownerKey: 'original-session', operationId: 'archive-a' }))
      .toEqual({ entries: [{ ownerKey: 'original-session', entry: a }], nextCursor: null })
    await expect(owner.readInputArchive({ ownerKey: 'elsewhere', after: first.nextCursor!, limit: 2 })).rejects.toThrow()
    const database = new DatabaseSync(owner.databasePath)
    try {
      const lookup = database.prepare(`EXPLAIN QUERY PLAN SELECT owner, body, enqueued_at, ordinal FROM input_queue
        WHERE cold = 1 AND owner = ? AND operation_id = ? ORDER BY enqueued_at DESC, ordinal DESC LIMIT ?`)
      expect(lookup.get('original-session', 'archive-a', 2)?.detail).toContain('input_archive_operation')
      database.exec(`CREATE TRIGGER guard_untouched_archive BEFORE UPDATE OF body ON input_queue
        WHEN OLD.cold = 1 BEGIN SELECT RAISE(ABORT, 'ordinary draft save rewrote an unrelated archive'); END;`)
      const receipt = await owner.writeFromRenderer(frame, { value: save('only this draft changed'), writeRevision: 1 }, () => true)
      expect(receipt.inputQueueArchiveOwners).toBeUndefined()
      expect((await readDocument(owner)).state.agentSteerQueues).toEqual({ 'original-session': [pending] })
      expect((await owner.readInputArchive({ ownerKey: 'original-session', operationId: 'archive-a' })).entries[0]?.entry).toEqual(a)
    } finally { database.close() }
  })

  it('retains duplicated old operation identities without granting a replacement write', async () => {
    const { path } = await fixture(), owner = new WorkbenchUserStateStore(path)
    const rows = [archived('same', 1, 'first original'), archived('same', 2, 'second original')]
    const original = JSON.stringify({ version: 1, state: { agentComposerDrafts: { 'original-region': 'original draft' },
      agentSteerQueues: { 'original-session': rows } } })
    await writeFile(path, original)
    expect((await readDocument(owner)).state.agentSteerQueues).toEqual({ 'original-session': rows })
    expect(await owner.readInputArchive({ ownerKey: 'original-session', operationId: 'same' })).toEqual({ entries: [], nextCursor: null })
    await expect(owner.write(save('newer unrelated draft'))).resolves.toMatchObject({ diskDurability: 'confirmed' })
    await expect(owner.write(save('untouched on failure', [{ ownerKey: 'original-session', order: [], upsert: [], remove: ['same'] }])))
      .rejects.toMatchObject({ code: 'WORKBENCH_INPUT_OPERATION_AMBIGUOUS' })
    expect((await readDocument(owner)).state).toEqual({
      agentComposerDrafts: { 'original-region': 'newer unrelated draft' }, agentSteerQueues: { 'original-session': rows }
    })
    expect(await readFile(path, 'utf8')).toBe(original)
  })

  it('keeps migrated original bytes inert when the acknowledged database disappears', async () => {
    const { path } = await fixture(), owner = new WorkbenchUserStateStore(path)
    const original = value('original migration input')
    await writeFile(path, original)
    await owner.read()
    await owner.write(save('a later durable draft'))
    await unlink(owner.databasePath)
    const restarted = new WorkbenchUserStateStore(path)
    await expect(restarted.read()).rejects.toMatchObject({ code: 'WORKBENCH_USER_DATABASE_UNAVAILABLE' })
    await expect(restarted.write(save('must stay in memory'))).rejects.toMatchObject({ code: 'WORKBENCH_USER_DATABASE_UNAVAILABLE' })
    expect(await readFile(path, 'utf8')).toBe(original)
    await expect(readFile(owner.databasePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

})
