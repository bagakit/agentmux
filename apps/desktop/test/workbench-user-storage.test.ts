import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state'
import { createBatchedPersistentStorage, USER_SAVE_REPLY_MS } from '../src/renderer/src/lib/persisted-ui-writer'
import { createWorkbenchUserDocument, createWorkbenchUserStorage, WORKBENCH_USER_STATE_KEY as key } from '../src/renderer/src/lib/workbench-user-storage'
import type { WorkbenchUserStateReceipt } from '../src/shared/workbench-user-state'

const encoded = (text: string) => JSON.stringify({ state: { agentComposerDrafts: { original: text } }, version: 1 })
function source(value: string | null) {
  const data = new Map(value === null ? [] : [[key, value]])
  return { getItem: (name: string) => data.get(name) ?? null, removeItem: vi.fn((name: string) => { data.delete(name) }) }
}
afterEach(() => vi.useRealTimers())

it('imports original bytes only on native absence and removes them after the durable acknowledgement', async () => {
  const original = source(encoded('Retained original'))
  let native: string | null = null
  let acknowledge!: () => void
  const write = vi.fn((_value: string) => new Promise<void>(resolve => { acknowledge = resolve }))
  const storage = createWorkbenchUserStorage({ readWorkbenchState: async () => native,
    importWorkbenchState: async value => { await write(value); native = value; return value }, writeWorkbenchState: write }, () => original)
  const reading = storage.getItem(key)
  await vi.waitFor(() => expect(write).toHaveBeenCalledWith(encoded('Retained original')))
  expect(original.getItem(key)).toBe(encoded('Retained original'))
  acknowledge()
  expect(await reading).toBe(encoded('Retained original'))
  expect(original.getItem(key)).toBeNull()
})

it('hydrates the native hot projection after exact legacy bytes acquire durable custody', async () => {
  const retained = JSON.stringify({ state: { draft: 'Original', agentSteerQueues: { session: [{ operationId: 'old', archived: true }] } }, version: 1 })
  const hot = encoded('Original normalized by the owner')
  const original = source(retained)
  const read = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(hot)
  const write = vi.fn()
  const storage = createWorkbenchUserStorage({ readWorkbenchState: read, importWorkbenchState: async value => value, writeWorkbenchState: write }, () => original)
  expect(await storage.getItem(key)).toBe(hot)
  expect(original.getItem(key)).toBeNull()
  expect(read).toHaveBeenCalledTimes(2)
  expect(write).not.toHaveBeenCalled()
})

const receiptFor = (raw: string): WorkbenchUserStateReceipt => ({
  path: 'original-user-document', diskDurability: 'confirmed', confirmedAt: Date.now(),
  contentDigest: createHash('sha256').update(raw).digest('hex'), sizeBytes: Buffer.byteLength(raw)
})
const browser = (): Storage => ({ ...source(null), length: 0, key: () => null, clear() {}, setItem() {} })

it('sends only changed queue operations and the same batch draft without encoding unrelated archived bytes', async () => {
  const hugeArchive = { operationId: 'old-archive', archived: true, text: 'Stored archive '.repeat(700_000) }
  const active = { operationId: 'hot-item', text: 'Current request' }
  const unrelated = { operationId: 'other-item', text: 'Unrelated active request' }
  const seed = JSON.stringify({ state: {
    agentSteerQueues: { original: [hugeArchive, active], other: [unrelated] }, agentComposerDrafts: { original: 'Saved draft' }
  }, version: 1 })
  const write = vi.fn(async (raw: string) => receiptFor(raw))
  const doc = createWorkbenchUserDocument({ readWorkbenchState: async () => seed, importWorkbenchState: async raw => raw,
    writeWorkbenchState: write }, browser)
  const hydrated = (await doc.persistent.storage.getItem(key))!.state as {
    agentSteerQueues: Record<string, Record<string, unknown>[]>
    agentComposerDrafts: Record<string, string>
  }
  const next = { ...hydrated, agentComposerDrafts: { original: 'Current request' }, agentSteerQueues: { ...hydrated.agentSteerQueues,
    original: [hydrated.agentSteerQueues.original![0]!, { ...active, archived: true, movedToDraft: true }] } }
  await doc.persistent.checkpoint(key, { state: next, version: 1 })
  expect(write).toHaveBeenCalledOnce()
  const raw = write.mock.calls[0]![0]
  expect(Buffer.byteLength(seed)).toBeGreaterThan(9_600_000)
  expect(Buffer.byteLength(raw)).toBeLessThan(1024)
  expect(JSON.parse(raw)).toEqual({
    state: { agentComposerDrafts: { original: 'Current request' } }, version: 1,
    inputQueueDelta: { changes: [{ ownerKey: 'original', order: ['old-archive', 'hot-item'], remove: [],
      upsert: [{ operationId: 'hot-item', entry: { ...active, archived: true, movedToDraft: true } }] }] }
  })
  expect(doc.confirmedProjectionDigest()).toBe(receiptFor(raw).contentDigest)

  write.mockClear()
  doc.persistent.storage.setItem(key, { version: 1, state: { ...next, agentComposerDrafts: { original: 'Temporary input' } } })
  doc.persistent.storage.setItem(key, { version: 1, state: next })
  await doc.persistent.flush()
  expect(write).not.toHaveBeenCalled()
  await doc.persistent.checkpoint(key, { state: next, version: 1 })
  expect(write).toHaveBeenCalledOnce()
  expect(JSON.parse(write.mock.calls[0]![0]).inputQueueDelta).toEqual({ changes: [] })
})

it('retries the previous queue value when an unacknowledged attempt may already have changed it', async () => {
  vi.useFakeTimers()
  const digest = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (_algorithm, bytes) =>
    new Uint8Array(createHash('sha256').update(new Uint8Array(bytes as ArrayBuffer)).digest()).buffer)
  const original = { operationId: 'reverted', text: 'Confirmed original' }
  const other = { operationId: 'other-owner', text: 'New original input' }
  const seed = JSON.stringify({ state: { agentSteerQueues: { first: [original] } }, version: 1 })
  let started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  let release!: () => void
  const first = new Promise<void>(resolve => { release = resolve })
  const write = vi.fn(async (raw: string) => receiptFor(raw)).mockImplementationOnce(async raw => {
    started()
    await first
    return receiptFor(raw)
  })
  const doc = createWorkbenchUserDocument({ readWorkbenchState: async () => seed, importWorkbenchState: async raw => raw,
    writeWorkbenchState: write }, browser, vi.fn())
  await doc.hydrate()
  doc.persistent.storage.setItem(key, { state: { agentSteerQueues: { first: [{ ...original, text: 'Unconfirmed replacement' }] } }, version: 1 })
  const outcome = Promise.resolve(doc.persistent.flush()).catch(error => error)
  try {
    await entered
    doc.persistent.storage.setItem(key, { state: { agentSteerQueues: { first: [original], second: [other] } }, version: 1 })
    await vi.advanceTimersByTimeAsync(USER_SAVE_REPLY_MS)
    expect((await outcome).code).toBe('WORKBENCH_USER_STATE_REPLY_OVERDUE')
    await vi.advanceTimersByTimeAsync(1000)
    expect(write).toHaveBeenCalledTimes(2)
    const raw = write.mock.calls[1]![0]
    expect(JSON.parse(raw).inputQueueDelta.changes).toEqual([
      { ownerKey: 'first', order: ['reverted'], remove: [], upsert: [{ operationId: 'reverted', entry: original }] },
      { ownerKey: 'second', order: ['other-owner'], remove: [], upsert: [{ operationId: 'other-owner', entry: other }] }
    ])
    expect(doc.confirmedProjectionDigest()).toBe(receiptFor(raw).contentDigest)
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(doc.confirmedProjectionDigest()).toBe(receiptFor(raw).contentDigest)
    expect(doc.persistent.pending()).toBe(false)
  } finally { release(); vi.clearAllTimers(); digest.mockRestore() }
})

it.each([false, true])('uses exact archive ACK references without another save or erasing a later edit (%s)', async laterEdit => {
  const archived = { operationId: 'archived-op', archived: true, text: 'Exact captured cold row' }
  const later = { operationId: archived.operationId, text: 'A later revision on the same owner' }
  let latest: Record<string, unknown>[] = [archived]
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const waiting = new Promise<void>(resolve => { release = resolve })
  const write = vi.fn(async (raw: string): Promise<WorkbenchUserStateReceipt> => receiptFor(raw))
    .mockImplementationOnce(async raw => {
      entered()
      await waiting
      return { ...receiptFor(raw), inputQueueArchived: [{ ownerKey: 'same-owner', operationId: archived.operationId }],
        inputQueueArchiveOwners: ['same-owner'] }
    })
  const doc = createWorkbenchUserDocument({ readWorkbenchState: async () => null, importWorkbenchState: async raw => raw,
    writeWorkbenchState: write }, browser)
  await doc.hydrate()
  const captured = () => ({ state: { agentSteerQueues: { 'same-owner': latest } }, version: 1 })
  const observed = vi.fn((rows: { ownerKey: string; entry: Record<string, unknown> }[]) => {
    expect(rows[0]?.entry).toBe(archived)
    const next = latest.filter(item => !rows.some(row => row.ownerKey === 'same-owner' && row.entry === item))
    if (next.length === latest.length) return
    latest = next
    doc.persistent.storage.setItem(key, captured())
  })
  const commit = vi.fn()
  const stopEviction = doc.subscribeInputQueueEvictions(observed)
  const stopCommit = doc.subscribeInputQueueCommits(commit)
  const saving = doc.persistent.checkpoint(key, captured())
  try {
    await started
    if (laterEdit) {
      latest = [later]
      doc.persistent.storage.setItem(key, captured())
    }
    release()
    await saving
    expect(observed).toHaveBeenCalledOnce()
    expect(commit).toHaveBeenCalledExactlyOnceWith(new Set(['same-owner']))
    expect(latest).toEqual(laterEdit ? [later] : [])
    expect(write).toHaveBeenCalledTimes(laterEdit ? 2 : 1)
    if (laterEdit) expect(JSON.parse(write.mock.calls[1]![0]).inputQueueDelta.changes).toEqual([
      { ownerKey: 'same-owner', order: [later.operationId], upsert: [{ operationId: later.operationId, entry: later }], remove: [] }
    ])
    expect(doc.persistent.pending()).toBe(false)
  } finally { release(); stopEviction(); stopCommit() }
})

it('preserves old bytes after unknown native import or read failure and never overwrites an existing native document', async () => {
  for (const phase of ['read', 'import']) {
    const original = source(encoded('Original bytes'))
    const port = { importWorkbenchState: async () => { throw Error('Directory sync unconfirmed') }, readWorkbenchState: vi.fn(async () => { if (phase === 'read') throw Error('Owner unavailable'); return null }),
      writeWorkbenchState: vi.fn(async () => { throw Error('Directory sync unconfirmed') }) }
    await expect(createWorkbenchUserStorage(port, () => original).getItem(key)).rejects.toThrow()
    expect(original.getItem(key)).toBe(encoded('Original bytes'))
    expect(original.removeItem).not.toHaveBeenCalled()
    if (phase === 'read') expect(port.writeWorkbenchState).not.toHaveBeenCalled()
  }
  const original = source(encoded('Older browser bytes')), write = vi.fn()
  const storage = createWorkbenchUserStorage({ readWorkbenchState: async () => encoded('Native original'), importWorkbenchState: async value => value, writeWorkbenchState: write }, () => original)
  expect(await storage.getItem(key)).toBe(encoded('Native original'))
  expect(write).not.toHaveBeenCalled()
})

it('hydrates the native queue winner and retains different original bytes after a concurrent first write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amux-import-winner-'))
  const path = join(root, 'workbench-user-state.json'), owner = new WorkbenchUserStateStore(path)
  const held = encoded('Older browser bytes'), latest = encoded('Concurrent native input'), original = source(held)
  let release!: () => void, observed!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), ready = new Promise<void>(resolve => { observed = resolve })
  const storage = createWorkbenchUserStorage({
    readWorkbenchState: async () => { const value = await owner.read(); observed(); await gate; return value },
    importWorkbenchState: value => owner.importIfAbsent(value), writeWorkbenchState: value => owner.write(value)
  }, () => original)
  try {
    const reading = storage.getItem(key)
    await ready
    await owner.write(latest)
    release()
    expect(JSON.parse((await reading)!)).toEqual(JSON.parse(latest))
    expect(JSON.parse((await owner.read())!)).toEqual(JSON.parse(latest))
    expect(original.getItem(key)).toBe(held)
    expect(original.removeItem).not.toHaveBeenCalled()
  } finally { release(); await rm(root, { recursive: true, force: true }) }
})

it('does not turn corrupted original bytes into an empty new document', async () => {
  const original = source('{invalid'), write = vi.fn()
  await expect(createWorkbenchUserStorage({ readWorkbenchState: async () => null, importWorkbenchState: async value => value, writeWorkbenchState: write }, () => original).getItem(key)).rejects.toThrow()
  expect(write).not.toHaveBeenCalled()
  expect(original.getItem(key)).toBe('{invalid')
})

it('a late native write acknowledgement retains and saves a newer input', async () => {
  const writes: string[] = []
  let release!: () => void
  const base = { getItem: async () => null, setItem: vi.fn(async (_name: string, value: string) => {
    writes.push(value)
    if (writes.length === 1) await new Promise<void>(resolve => { release = resolve })
  }), removeItem: async () => {} }
  const writer = createBatchedPersistentStorage<{ draft: string }>(base)
  writer.storage.setItem(key, { state: { draft: 'First' }, version: 1 })
  const saving = writer.flush()
  await vi.waitFor(() => expect(writes).toHaveLength(1))
  writer.storage.setItem(key, { state: { draft: 'Latest' }, version: 1 })
  release()
  await saving
  expect(writes.map(value => JSON.parse(value).state.draft)).toEqual(['First', 'Latest'])
  await writer.flush()
  expect(writes).toHaveLength(2)
})

it('failure retains the exact latest input and equal readable bytes still require the native writer acknowledgement', async () => {
  const state = { state: { draft: 'Original' }, version: 1 }
  const base = { getItem: async () => JSON.stringify(state), setItem: vi.fn().mockRejectedValueOnce(Error('Unconfirmed directory sync')).mockResolvedValue(undefined), removeItem: async () => {} }
  const writer = createBatchedPersistentStorage<{ draft: string }>(base)
  writer.storage.setItem(key, state)
  await expect(writer.flush()).rejects.toThrow('Unconfirmed directory sync')
  await writer.flush()
  expect(base.setItem).toHaveBeenCalledTimes(2)
})

it('clearing waits for accepted writes and retains an explicit empty native document', async () => {
  const events: string[] = []
  let release!: () => void
  const base = { getItem: async () => null, setItem: async () => { events.push('write'); await new Promise<void>(resolve => { release = resolve }) },
    removeItem: async () => { events.push('remove') } }
  const writer = createBatchedPersistentStorage<{ draft: string }>(base)
  writer.storage.setItem(key, { state: { draft: 'Original' }, version: 1 })
  const saving = writer.flush()
  await vi.waitFor(() => expect(events).toEqual(['write']))
  const clearing = writer.storage.removeItem(key)
  writer.storage.setItem(key, { state: { draft: 'New edit after clearing' }, version: 1 })
  release()
  // The later edit must follow removal; it must not be consumed by the older drain.
  base.setItem = async (_name?: string, _value?: string) => { events.push('new-write') }
  await Promise.all([saving, clearing])
  expect(events).toEqual(['write', 'remove', 'new-write'])
  const root = await mkdtemp(join(tmpdir(), 'amux-clear-ack-'))
  const owner = new WorkbenchUserStateStore(join(root, 'workbench-user-state.json'))
  const write = vi.fn((value: string) => owner.write(value))
  try {
    await createWorkbenchUserStorage({ readWorkbenchState: () => owner.read(), importWorkbenchState: value => owner.importIfAbsent(value), writeWorkbenchState: write }, () => source(null)).removeItem(key)
    expect(JSON.parse(write.mock.calls[0]![0])).toEqual({ state: {}, version: 1 })
    expect(JSON.parse((await owner.read())!)).toEqual({ state: {}, version: 1 })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('a failed clear releases its barrier and keeps a newer edit available to the original writer', async () => {
  const events: string[] = []
  let release!: () => void, saved: string | null = null
  const base = { getItem: async () => saved, setItem: async (_name: string, value: string) => {
    const draft = JSON.parse(value).state.draft
    events.push('write:' + draft)
    if (draft === 'Before clear') await new Promise<void>(resolve => { release = resolve })
    saved = value
  }, removeItem: async () => { events.push('remove'); throw Error('Native clear failed') } }
  const writer = createBatchedPersistentStorage<{ draft: string }>(base)
  writer.storage.setItem(key, { state: { draft: 'Before clear' }, version: 1 })
  const saving = writer.flush()
  await vi.waitFor(() => expect(events).toEqual(['write:Before clear']))
  const clearing = writer.storage.removeItem(key)
  const rejected = expect(clearing).rejects.toThrow('Native clear failed')
  writer.storage.setItem(key, { state: { draft: 'After clear' }, version: 1 })
  release()
  await saving
  await rejected
  expect(writer.pending()).toBe(true)
  await writer.flush()
  expect(events).toEqual(['write:Before clear', 'remove', 'write:After clear'])
  expect(JSON.parse(saved!).state.draft).toBe('After clear')
})

it('overlapping clears retain their individual barriers before saving the latest later input', async () => {
  const events: string[] = []
  let release!: () => void
  const base = { getItem: async () => null, setItem: async (_name: string, value: string) => {
    const draft = JSON.parse(value).state.draft
    events.push('write:' + draft)
    if (draft === 'Original') await new Promise<void>(resolve => { release = resolve })
  }, removeItem: async () => { events.push('remove') } }
  const writer = createBatchedPersistentStorage<{ draft: string }>(base)
  writer.storage.setItem(key, { state: { draft: 'Original' }, version: 1 })
  const saving = writer.flush()
  await vi.waitFor(() => expect(events).toEqual(['write:Original']))
  const first = writer.storage.removeItem(key)
  writer.storage.setItem(key, { state: { draft: 'Before second clear' }, version: 1 })
  const second = writer.storage.removeItem(key)
  writer.storage.setItem(key, { state: { draft: 'After both clears' }, version: 1 })
  release()
  await Promise.all([saving, first, second])
  await writer.flush()
  expect(events).toEqual(['write:Original', 'remove', 'remove', 'write:After both clears'])
})
