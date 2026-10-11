// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { AGENT_BOOKMARK_STORAGE_KEY, agentBookmarkKey, createAgentBookmarks, type AgentBookmark } from '../src/renderer/src/lib/agent-bookmarks'
const bounds = { x: 24, y: 32, width: 420, height: 500 }
const original = { hostId: 'original-host', agentSessionId: 'canonical-agent', presentationId: 'display-agent', label: 'Original Agent', workspaceName: 'Project', excerpt: 'Original task', bounds }
const neighbor = { ...original, agentSessionId: 'other-agent', label: 'Neighbor Agent' }
const disposers: (() => void)[] = []
function fixture(seed?: string) {
  let bytes = seed ?? null
  const writes: string[] = []
  const storage = { getItem: vi.fn(() => bytes), setItem: vi.fn((_key: string, value: string) => { bytes = value; writes.push(value) }) }
  const flush = vi.fn(async () => {})
  const owner = createAgentBookmarks({ storage, flush })
  disposers.push(() => owner.stopLifecycle())
  return { owner, storage, flush, writes, read: () => bytes, seed: (value: string | null) => { bytes = value } }
}
const saved = (entries: unknown[]) => JSON.stringify({ version: 1, bookmarks: entries })
const entry = (input = original): AgentBookmark => ({ ...input, key: agentBookmarkKey(input.hostId, input.agentSessionId) })
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); vi.useRealTimers(); vi.restoreAllMocks() })
it('deduplicates canonical Host/SID across display aliases and preserves protected snapshots', async () => {
  const f = fixture(), first = f.owner.pin(original)!, other = f.owner.pin(neighbor)!
  expect(first).toBe(agentBookmarkKey(original.hostId, original.agentSessionId))
  expect(f.owner.pin({ ...original, presentationId: 'alias', label: 'Newer name', excerpt: 'New task', bounds: { ...bounds, x: 99 } })).toBe(first)
  expect(f.owner.get().bookmarks.map(item => item.key)).toEqual([other, first])
  expect(f.owner.get().bookmarks[1]).toEqual(entry())
  const remote = f.owner.pin({ ...original, hostId: 'neighbor-host' })!
  expect(remote).not.toBe(first); expect(f.owner.get().bookmarks).toHaveLength(3)
  await f.owner.flush()
})
it('restores bounded snapshots and order without any Session catalog or Runtime operation', () => {
  const f = fixture(saved([entry(), entry(neighbor)])), state = f.owner.get()
  expect(state.bookmarks).toEqual([entry(), entry(neighbor)]); expect(state.persistenceIssue).toBeNull()
  expect(f.storage.getItem).toHaveBeenCalledExactlyOnceWith(AGENT_BOOKMARK_STORAGE_KEY)
  expect(f.storage.setItem).not.toHaveBeenCalled(); expect(f.flush).not.toHaveBeenCalled()
  const listener = vi.fn(), unsubscribe = f.owner.subscribe(listener)
  expect(f.owner.get()).toBe(state); unsubscribe(); expect(f.owner.get()).toBe(state); expect(listener).not.toHaveBeenCalled()
})
it('coalesces settled geometry and ordering, and a removed pending bookmark never resurrects', async () => {
  vi.useFakeTimers(); const f = fixture(), a = f.owner.pin(original)!, b = f.owner.pin(neighbor)!
  f.owner.setBounds(a, { ...bounds, x: -18, width: 700 }); f.owner.bringToFront(a); f.owner.remove(b)
  expect(f.writes).toHaveLength(0); await vi.advanceTimersByTimeAsync(200)
  expect(f.writes).toHaveLength(1); expect(f.flush).toHaveBeenCalledOnce()
  const restored = fixture(f.read()!).owner.get().bookmarks
  expect(restored).toEqual([{ ...entry(), bounds: { ...bounds, x: -18, width: 700 } }])
  await vi.advanceTimersByTimeAsync(500); expect(f.writes).toHaveLength(1)
})
it('identical updates keep the existing durable deadline and do not add writes', async () => {
  vi.useFakeTimers(); const f = fixture(), key = f.owner.pin(original)!
  await vi.advanceTimersByTimeAsync(150); f.owner.setBounds(key, { ...bounds }); f.owner.pin({ ...original })
  await vi.advanceTimersByTimeAsync(50); expect(f.writes).toHaveLength(1)
  f.owner.setBounds(key, { ...bounds }); await vi.advanceTimersByTimeAsync(500); expect(f.writes).toHaveLength(1)
})
it('keeps current in-memory bookmarks through a failed write and retries the same projection', async () => {
  const f = fixture(), key = f.owner.pin(original)!
  f.storage.setItem.mockImplementationOnce(() => { throw new Error('Storage unavailable') })
  await expect(f.owner.flush()).resolves.toBeUndefined()
  expect(f.owner.get().bookmarks).toEqual([entry()]); expect(f.owner.get().persistenceIssue?.phase).toBe('write'); expect(f.flush).not.toHaveBeenCalled()
  await f.owner.retry(); expect(f.owner.get().persistenceIssue).toBeNull(); expect(JSON.parse(f.read()!).bookmarks[0].key).toBe(key)
})
it('a flush refusal retains local bytes and an honest retry without rejecting healthy work', async () => {
  const f = fixture(); f.owner.pin(original); f.flush.mockRejectedValueOnce(new Error('Flush authority unconfirmed'))
  await expect(f.owner.flush()).resolves.toBeUndefined(); const bytes = f.read()
  expect(bytes).not.toBeNull(); expect(f.owner.get().persistenceIssue?.phase).toBe('flush')
  await f.owner.retry(); expect(f.read()).toBe(bytes); expect(f.writes).toHaveLength(1); expect(f.flush).toHaveBeenCalledTimes(2); expect(f.owner.get().persistenceIssue).toBeNull()
})
it('unreadable saved bytes are fenced while current additions and removals merge after retry', async () => {
  const f = fixture('original unreadable bytes')
  expect(f.owner.get().persistenceIssue?.phase).toBe('read')
  const transient = f.owner.pin(neighbor)!, removed = agentBookmarkKey(original.hostId, original.agentSessionId)
  f.owner.remove(removed); await f.owner.flush(); expect(f.read()).toBe('original unreadable bytes'); expect(f.storage.setItem).not.toHaveBeenCalled()
  const untouched = { ...entry(), agentSessionId: 'untouched', key: agentBookmarkKey(original.hostId, 'untouched') }
  f.seed(saved([entry(), untouched])); await f.owner.retry()
  expect(f.owner.get().bookmarks.map(item => item.key)).toEqual([untouched.key, transient]); expect(f.owner.get().persistenceIssue).toBeNull()
  expect(JSON.parse(f.read()!).bookmarks.map((item: AgentBookmark) => item.key)).toEqual([untouched.key, transient])
})
it.each(['{"version":2,"bookmarks":[]}', saved([entry(), { ...entry(neighbor), key: 'forged-key' }]), saved([{ ...entry(), bounds: { ...bounds, width: -1 } }])])('preserves unconfirmed saved records without writing an empty default', async bytes => {
  const f = fixture(bytes); expect(f.owner.get().persistenceIssue?.phase).toBe('read')
  f.owner.pin({ ...neighbor, agentSessionId: 'new-current' }); await f.owner.flush(); expect(f.read()).toBe(bytes); expect(f.storage.setItem).not.toHaveBeenCalled()
})
it('a thrown initial storage read cannot replace the original bytes with a default', async () => {
  const f = fixture(saved([entry()])); f.storage.getItem.mockImplementationOnce(() => { throw new Error('Read blocked') })
  f.owner.pin(neighbor); await f.owner.flush(); expect(f.storage.setItem).not.toHaveBeenCalled(); await f.owner.retry()
  expect(f.owner.get().bookmarks).toEqual([entry(), entry(neighbor)])
})
it('late older save receipts cannot clear or replace the newest persistence issue', async () => {
  const f = fixture(); let finish!: () => void
  f.flush.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
  const a = f.owner.pin(original)!, pending = f.owner.flush(); f.owner.setBounds(a, { ...bounds, x: 180 })
  f.flush.mockRejectedValueOnce(new Error('Newest flush refused')); await f.owner.flush()
  expect(f.owner.get().persistenceIssue?.message).toContain('Newest flush refused'); finish(); await pending
  expect(f.owner.get().persistenceIssue?.message).toContain('Newest flush refused')
  await f.owner.retry(); expect(f.owner.get().persistenceIssue).toBeNull()
})
it('late old failure cannot resurrect a removed bookmark or replace a newer success', async () => {
  const f = fixture(); let reject!: (error: Error) => void
  f.flush.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail }))
  const key = f.owner.pin(original)!, pending = f.owner.flush(); f.owner.remove(key); await f.owner.flush()
  reject(new Error('Old failure')); await pending
  expect(f.owner.get().bookmarks).toEqual([]); expect(f.owner.get().persistenceIssue).toBeNull(); expect(JSON.parse(f.read()!).bookmarks).toEqual([])
})
it('saves only bounded presentation fields and never prunes a valid bookmark population', async () => {
  const f = fixture()
  for (let index = 0; index < 70; index++) f.owner.pin({ ...original, agentSessionId: 'canonical-' + index,
    label: 'n'.repeat(600), workspaceName: 'w'.repeat(600), excerpt: 'e'.repeat(5000),
    ...{ control: { run: { runId: 'forbidden-control' } }, callback: () => {}, image: 'forbidden-image-bytes' } })
  await f.owner.flush(); const bytes = f.read()!, entries = JSON.parse(bytes).bookmarks as AgentBookmark[]
  expect(entries).toHaveLength(70); expect(entries[0]!.label).toHaveLength(512); expect(entries[0]!.workspaceName).toHaveLength(512); expect(entries[0]!.excerpt).toHaveLength(4096); expect(entries[0]!.excerptTruncated).toBe(true)
  expect(bytes).not.toMatch(/forbidden-control|callback|forbidden-image-bytes/); expect(fixture(bytes).owner.get().bookmarks).toHaveLength(70)
})
it('explicit snapshot adoption clears an absent excerpt without changing key or saved bounds', async () => {
  const f = fixture(), key = f.owner.pin(original)!
  f.owner.updateSnapshot(key, { label: 'New name', workspaceName: 'New project', excerpt: undefined })
  expect(f.owner.get().bookmarks).toEqual([{ ...entry(), label: 'New name', workspaceName: 'New project', excerpt: undefined }])
  await f.owner.flush(); expect(JSON.parse(f.read()!).bookmarks[0]).not.toHaveProperty('excerpt')
})
it('pagehide and beforeunload synchronously write the newest pending value before transport', async () => {
  const f = fixture(), dispose = f.owner.startLifecycle(window)
  expect(f.owner.startLifecycle(window)).toBe(dispose)
  f.owner.pin(original); window.dispatchEvent(new Event('pagehide'))
  expect(JSON.parse(f.read()!).bookmarks).toEqual([entry()])
  f.owner.setBounds(entry().key, { ...bounds, height: 680 }); window.dispatchEvent(new Event('beforeunload'))
  expect(JSON.parse(f.read()!).bookmarks[0].bounds.height).toBe(680)
  dispose(); const flushes = f.flush.mock.calls.length; window.dispatchEvent(new Event('pagehide')); expect(f.flush.mock.calls.length).toBe(flushes)
  expect(f.owner.get().bookmarks).toHaveLength(1); await f.owner.flush()
})

it('stopping an unattached lifecycle flushes its timer without discarding preferences', async () => {
  vi.useFakeTimers(); const f = fixture(); f.owner.pin(original); f.owner.stopLifecycle()
  expect(f.writes).toHaveLength(1); await vi.advanceTimersByTimeAsync(250); expect(f.writes).toHaveLength(1)
  expect(f.owner.get().bookmarks).toEqual([entry()]); await f.owner.flush()
})
