import { afterEach, expect, it } from 'vitest'
import { nativeHistoryFixture, jsonl } from './fixtures/native-history-session.js'
import { loadAgentSessions } from '../src/agent-session-store.js'
import { SESSION_HISTORY_MAX_PAGE_BYTES } from '../src/session-history.js'

const fixtures: Awaited<ReturnType<typeof nativeHistoryFixture>>[] = []
afterEach(async () => { await Promise.all(fixtures.splice(0).map((fixture) => fixture.close())) })
async function fixture(data: string | Buffer) {
  const value = await nativeHistoryFixture('claude', data); fixtures.push(value); return value
}
const record = (uuid: string, type: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  sessionId: 'native-main', uuid, type, message: { role: type, content }, ...extra
})

it('omits sidechain entries even when they carry the main native Session ID', async () => {
  const f = await fixture(jsonl([
    record('main-user', 'user', 'main user'),
    record('same-id-child', 'assistant', 'child body', { isSidechain: true }),
    record('main-answer', 'assistant', 'main answer')
  ]))
  expect((await f.client.sessionHistoryPage('private-agent')).items.map((item) => item.id)).toEqual(['main-user', 'main-answer'])
})

it('reads main Claude pages with exact UUIDs and ordered resources, excluding sidechains without Run or file changes', async () => {
  const f = await fixture(jsonl([
    record('user-1', 'user', '  exact first\n', { timestamp: '2026-10-01T01:02:03Z' }),
    record('assistant-1', 'assistant', [{ type: 'text', text: 'answer' }]),
    record('child-1', 'assistant', 'never parent history', { sessionId: 'child-native', isSidechain: true }),
    record('tool-result', 'user', [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'actual tool output' }]),
    record('latest', 'user', [{ type: 'text', text: 'before ' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'cGlj' } },
      { type: 'text', text: ' after 中' }])
  ]))
  const first = await f.client.sessionHistoryPage('private-agent', { limit: 2 })
  expect(first.source).toEqual({ providerId: 'claude', nativeSessionId: 'native-main' })
  expect(first.items.map((item) => [item.id, item.kind])).toEqual([['tool-result', 'activity'], ['latest', 'user-message']])
  expect(first.items[1]!.contentParts).toEqual([{ kind: 'text', text: 'before ' },
    { kind: 'resource', resourceType: 'image', reference: 'data:image/png;base64,cGlj' },
    { kind: 'text', text: ' after 中' }])
  expect(first.items[0]!.contentParts).toEqual([{ kind: 'text', text: 'actual tool output' }])
  const older = await f.client.sessionHistoryPage('private-agent', { limit: 2, cursor: first.nextCursor! })
  expect(older.items.map((item) => item.id)).toEqual(['user-1', 'assistant-1'])
  expect(older.items[0]!.startedAt).toBe(Date.parse('2026-10-01T01:02:03Z'))
  expect(older.nextCursor).toBeNull()
  expect(await f.bytes()).toEqual(f.before)
  expect(f.controls).toHaveLength(6)
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
})

it('preserves neutral unknown activity and missing time, while keeping mixed tool records out of human speech', async () => {
  const f = await fixture(jsonl([
    { type: 'future-native-event', uuid: 'unknown', sessionId: 'native-main', detail: 'kept', timestamp: 'not-a-date' },
    record('tool', 'assistant', [{ type: 'text', text: 'planning ' }, { type: 'tool_use', id: 'call', name: 'read', input: { path: 'a' } }])
  ]))
  const page = await f.client.sessionHistoryPage('private-agent')
  expect(page.items.map((item) => item.kind)).toEqual(['activity', 'activity'])
  expect(page.items[0]!.contentParts[0]).toEqual({ kind: 'text', text: JSON.stringify({ type: 'future-native-event', uuid: 'unknown', sessionId: 'native-main', detail: 'kept', timestamp: 'not-a-date' }) })
  expect(page.items[0]).not.toHaveProperty('startedAt')
  expect(page.items[1]!.contentParts).toEqual([{ kind: 'text', text: 'planning ' }, { kind: 'text', text: '{"type":"tool_use","id":"call","name":"read","input":{"path":"a"}}' }])
})

it('keeps synthetic and compaction summary user records neutral instead of assigning a human speaker', async () => {
  const f = await fixture(jsonl([
    record('meta', 'user', 'generated context', { isMeta: true }),
    record('summary', 'user', 'persisted compaction summary', { isCompactSummary: true }),
    record('synthetic', 'user', 'generated instruction', { isSynthetic: true })
  ]))
  const page = await f.client.sessionHistoryPage('private-agent')
  expect(page.items.map((item) => [item.id, item.kind])).toEqual([['meta', 'activity'], ['summary', 'activity'], ['synthetic', 'activity']])
  expect(page.items.map((item) => item.contentParts)).toEqual([
    [{ kind: 'text', text: 'generated context' }], [{ kind: 'text', text: 'persisted compaction summary' }],
    [{ kind: 'text', text: 'generated instruction' }]
  ])
})

it('keeps long UTF8 records complete across range chunks and excludes a partial final append without repair', async () => {
  const exact = 'x'.repeat(65_500) + '中'.repeat(50)
  const complete = jsonl([record('long', 'assistant', exact)])
  const f = await fixture(Buffer.concat([Buffer.from(complete + '{"type":"user","text":"'), Buffer.from([0xe4, 0xb8])]))
  const page = await f.client.sessionHistoryPage('private-agent')
  expect(page.items).toHaveLength(1)
  expect(page.items[0]!.contentParts).toEqual([{ kind: 'text', text: exact }])
  expect(await f.bytes()).toEqual(f.before)
})

it('refuses a different main native Session or a missing exact locator', async () => {
  const wrong = await fixture(jsonl([record('other', 'user', 'wrong', { sessionId: 'another-main' })]))
  await expect(wrong.client.sessionHistoryPage('private-agent')).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  const missing = await fixture(jsonl([record('one', 'user', 'body')]))
  const session = (await loadAgentSessions(missing.store))[0]!
  await missing.store.compareAndSwap(session, { ...session, updatedAt: 2,
    nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'native-main' } })
  await expect(missing.client.sessionHistoryPage('private-agent')).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_LOCATOR_UNAVAILABLE' })
})

it('counts skipped sidechain bytes against the page budget and cancels on disposal', async () => {
  const large = await fixture(jsonl(Array.from({ length: 70 }, (_, index) => record(`side-${index}`, 'assistant', 'x'.repeat(64 * 1024), { isSidechain: true }))))
  await expect(large.client.sessionHistoryPage('private-agent')).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_TOO_LARGE' })
  const after = await large.bytes()
  expect(after.native.length).toBeGreaterThan(SESSION_HISTORY_MAX_PAGE_BYTES)
  expect(after.native.equals(large.before.native)).toBe(true)
  expect(after.store.length).toBeGreaterThan(0)
  expect(after.store.equals(large.before.store)).toBe(true)
  const f = await fixture(jsonl([record('one', 'user', 'existing')]))
  const pending = f.client.sessionHistoryPage('private-agent')
  const rejected = expect(pending).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_CANCELLED' })
  await f.client.dispose(); await rejected
})
