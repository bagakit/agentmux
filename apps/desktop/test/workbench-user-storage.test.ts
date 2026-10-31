import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state'
import { createBatchedPersistentStorage } from '../src/renderer/src/lib/persisted-ui-writer'
import { createWorkbenchUserStorage, WORKBENCH_USER_STATE_KEY as key } from '../src/renderer/src/lib/workbench-user-storage'

const encoded = (text: string) => JSON.stringify({ state: { agentComposerDrafts: { original: text } }, version: 1 })
function source(value: string | null) {
  const data = new Map(value === null ? [] : [[key, value]])
  return { getItem: (name: string) => data.get(name) ?? null, removeItem: vi.fn((name: string) => { data.delete(name) }) }
}
afterEach(() => vi.useRealTimers())

it('imports original bytes only on native absence and removes them after the durable acknowledgement', async () => {
  const original = source(encoded('Retained original'))
  let acknowledge!: () => void
  const write = vi.fn((_value: string) => new Promise<void>(resolve => { acknowledge = resolve }))
  const storage = createWorkbenchUserStorage({ readWorkbenchState: async () => null, importWorkbenchState: async value => { await write(value); return value }, writeWorkbenchState: write }, () => original)
  const reading = storage.getItem(key)
  await vi.waitFor(() => expect(write).toHaveBeenCalledWith(encoded('Retained original')))
  expect(original.getItem(key)).toBe(encoded('Retained original'))
  acknowledge()
  expect(await reading).toBe(encoded('Retained original'))
  expect(original.getItem(key)).toBeNull()
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
    expect(await reading).toBe(latest)
    expect(await readFile(path, 'utf8')).toBe(latest)
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
  const write = vi.fn(async (_value: string) => {})
  await createWorkbenchUserStorage({ readWorkbenchState: async () => encoded('Old'), importWorkbenchState: async value => value, writeWorkbenchState: write }, () => source(null)).removeItem(key)
  expect(JSON.parse(write.mock.calls[0]![0] as string)).toEqual({ state: {}, version: 1 })
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
