import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { historyReaderFixture, core } from './fixtures/session-history-reader.js'

const fixtures: Awaited<ReturnType<typeof historyReaderFixture>>[] = []
afterEach(async () => { await Promise.all(fixtures.splice(0).map(f => f.close())); vi.restoreAllMocks() })
async function fixture(...args: Parameters<typeof historyReaderFixture>) {
  const f = await historyReaderFixture(...args); fixtures.push(f); return f
}
it('reads retained captured work without a native locator or original Run and preserves exact scope', async () => {
  const f = await fixture(false, true)
  const read = (extra = {}) => core.readAgentSessionHistory(f.client, { ...f.reference, source: 'captured', limit: 1, ...extra })
  const first = await read()
  expect(first).toMatchObject({ ...f.reference, source: 'captured', availability: 'available', order: 'newest-first',
    items: [{ kind: 'item', item: { id: 'captured-1', content: 'Original task 中', source: 'user' } }] })
  expect(first.nextCursor).toBeTypeOf('string')
  const second = await read({ cursor: first.nextCursor })
  expect(second.items).toMatchObject([{ kind: 'item', item: { id: 'captured-0', content: 'Older captured work' } }])
  expect(second.nextCursor).toBeNull()
  await expect(read({ hostId: 'different-host' })).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
  await expect(read({ agentSessionId: 'original' })).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
  await expect(read({ source: 'native', cursor: first.nextCursor })).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  await expect(read({ cursor: first.nextCursor!.slice(0, -3) + 'bad' })).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  await f.unchanged()
})
it('makes native unavailable distinct from a genuinely empty captured history', async () => {
  const f = await fixture()
  await expect(core.readAgentSessionHistory(f.client, { ...f.reference, source: 'native' }))
    .rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE' })
  const empty = { ...f.session, agentSessionId: 'empty-agent', run: { runId: 'empty-run' } }
  await f.store.compareAndSwap(null, empty)
  const page = await core.readAgentSessionHistory(f.client, { hostId: 'local', agentSessionId: empty.agentSessionId, source: 'captured' })
  expect(page).toMatchObject({ source: 'captured', availability: 'empty', items: [], nextCursor: null })
})
it.each(['captured', 'native'] as const)('keeps oversized %s content completely readable with contiguous bounded fragments', async source => {
  const body = 'Original 中🙂\n'.repeat(800)
  const f = await fixture(source === 'native', true, body)
  const fragments: Buffer[] = []
  let cursor: string | undefined, total = 0, sha = '', itemId = '', finished = false
  for (let index = 0; index < 100; index++) {
    const input = { ...f.reference, source, limit: 1, maxBytes: 4096, ...(cursor ? { cursor } : {}) }
    const page = await core.readAgentSessionHistory(f.client, input)
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(4096 - 1024)
    expect(core.parseAgentSessionHistoryReadPage(page, input)).toEqual(page)
    const entry = page.items[0]!
    expect(entry.kind).toBe('fragment')
    if (entry.kind !== 'fragment') throw new Error('Missing real fragment')
    expect(entry.offsetBytes).toBe(total)
    if (!sha) { sha = entry.sha256; itemId = entry.itemId }
    expect(entry.sha256).toBe(sha); expect(entry.itemId).toBe(itemId)
    const bytes = Buffer.from(entry.dataBase64, 'base64'); fragments.push(bytes); total += bytes.length
    expect(bytes.length).toBeGreaterThan(0)
    cursor = page.nextCursor ?? undefined
    if (total === entry.totalBytes) { finished = true; break }
    expect(cursor).toBeTypeOf('string')
  }
  expect(finished).toBe(true)
  const bytes = Buffer.concat(fragments)
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha)
  const item = JSON.parse(bytes.toString('utf8'))
  expect(source === 'captured' ? item.content : item.contentParts[0].text).toBe(body)
  const older = await core.readAgentSessionHistory(f.client, { ...f.reference, source, limit: 1, maxBytes: 4096, cursor })
  expect(older.items).toMatchObject([{ kind: 'item', item: { id: source === 'captured' ? 'captured-0' : 'older-native' } }])
  expect(older.nextCursor).toBeNull()
  await f.unchanged()
})
it('rejects source revision drift instead of losing or repeating captured entries', async () => {
  const f = await fixture()
  const first = await core.readAgentSessionHistory(f.client, { ...f.reference, source: 'captured', limit: 1 })
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item: {
    id: 'later', agentSessionId: f.session.agentSessionId, kind: 'user_message', status: 'complete', source: 'user', title: 'Later', createdAt: 200, updatedAt: 200, content: 'Later' } })
  await expect(core.readAgentSessionHistory(f.client, { ...f.reference, source: 'captured', limit: 1, cursor: first.nextCursor! }))
    .rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
})
it('rejects mismatched or oversized public results at the consumer seam', async () => {
  const f = await fixture()
  const input = { ...f.reference, source: 'captured' as const, maxBytes: 4096 }
  const page = await core.readAgentSessionHistory(f.client, input)
  for (const bad of [{ ...page, hostId: 'other' }, { ...page, agentSessionId: 'other' }, { ...page, source: 'native' },
    { ...page, revision: 'guess' }, { ...page, items: [{ kind: 'item', item: { id: 'one', agentSessionId: 'other' } }] },
    { ...page, items: [{ kind: 'item', item: { id: 'one', agentSessionId: 'original-agent', content: 'x'.repeat(6000) } }] }]) {
    expect(() => core.parseAgentSessionHistoryReadPage(bad, input)).toThrow()
  }
})
