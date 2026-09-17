import { appendFile } from 'node:fs/promises'
import { afterEach, expect, it } from 'vitest'
import { nativeHistoryFixture, jsonl } from './fixtures/native-history-session.js'

const fixtures: Awaited<ReturnType<typeof nativeHistoryFixture>>[] = []
afterEach(async () => { await Promise.all(fixtures.splice(0).map((fixture) => fixture.close())) })
const header = (cwd: string, extra: Record<string, unknown> = {}) => ({ type: 'session', version: 3, id: 'native-main', cwd,
  timestamp: '2026-10-01T01:00:00Z', ...extra })
const message = (id: string, parentId: string | null, role: string, content: unknown) => ({ type: 'message', id, parentId,
  timestamp: '2026-10-01T01:02:03Z', message: { role, content } })
async function fixture(entries: unknown[], extraHeader: Record<string, unknown> = {}, partial = '') {
  const f = await nativeHistoryFixture('pi', (root) => jsonl([header(root, extraHeader), ...entries]) + partial)
  fixtures.push(f); return f
}

it('reads last durable Pi branch across pages, retaining pre-compaction history and excluding an abandoned sibling', async () => {
  const f = await fixture([
    message('root-user', null, 'user', 'old user survives compaction'),
    message('main-answer', 'root-user', 'assistant', [{ type: 'text', text: 'old main answer' }]),
    message('abandoned', 'root-user', 'assistant', [{ type: 'text', text: 'wrong branch' }]),
    { type: 'compaction', id: 'compact', parentId: 'main-answer', timestamp: '2026-10-01T01:03:00Z',
      summary: 'actual summary', firstKeptEntryId: 'main-answer', tokensBefore: 90 },
    message('new-user', 'compact', 'user', [{ type: 'text', text: 'before' }, { type: 'image', mimeType: 'image/png', data: 'cGlj' }, { type: 'text', text: 'after' }]),
    { type: 'label', id: 'last-durable', parentId: 'new-user', timestamp: 'unknown', targetId: 'main-answer', label: 'marker' }
  ])
  const first = await f.client.sessionHistoryPage('private-agent', { limit: 2 })
  expect(first.items.map((item) => item.id)).toEqual(['new-user', 'last-durable'])
  expect(first.items[0]!.contentParts).toEqual([{ kind: 'text', text: 'before' },
    { kind: 'resource', resourceType: 'image', reference: 'data:image/png;base64,cGlj' }, { kind: 'text', text: 'after' }])
  expect(first.items[1]).not.toHaveProperty('startedAt')
  const second = await f.client.sessionHistoryPage('private-agent', { limit: 2, cursor: first.nextCursor! })
  expect(second.items.map((item) => item.id)).toEqual(['main-answer', 'compact'])
  expect(second.items[1]!.kind).toBe('activity')
  expect(second.items[1]!.contentParts).toEqual([{ kind: 'text', text: 'actual summary' }])
  const third = await f.client.sessionHistoryPage('private-agent', { limit: 2, cursor: second.nextCursor! })
  expect(third.items.map((item) => item.id)).toEqual(['root-user'])
  expect(third.items[0]!.contentParts).toEqual([{ kind: 'text', text: 'old user survives compaction' }])
  expect(third.nextCursor).toBeNull()
  expect(await f.bytes()).toEqual(f.before)
  expect(f.controls).toHaveLength(6)
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
})

it('preserves tool/custom/unknown native activities and exact text, without invented completion times', async () => {
  const f = await fixture([
    message('human', null, 'user', '\n exact 中 \n'),
    message('tool', 'human', 'toolResult', [{ type: 'text', text: 'tool stdout' }]),
    { type: 'custom_message', id: 'custom', parentId: 'tool', timestamp: 'unknown', customType: 'notice', display: true, content: 'extension notice' },
    { type: 'new-native-kind', id: 'unknown', parentId: 'custom', timestamp: 'unknown', data: { visible: true } }
  ])
  const page = await f.client.sessionHistoryPage('private-agent')
  expect(page.items.map((item) => [item.id, item.kind])).toEqual([['human', 'user-message'], ['tool', 'activity'], ['custom', 'activity'], ['unknown', 'activity']])
  expect(page.items[0]!.contentParts).toEqual([{ kind: 'text', text: '\n exact 中 \n' }])
  expect(page.items[1]!.contentParts).toEqual([{ kind: 'text', text: 'tool stdout' }])
  expect(page.items[2]!.contentParts).toEqual([{ kind: 'text', text: 'extension notice' }])
  expect(page.items[3]!.contentParts[0]!.kind).toBe('text')
  expect(page.items[3]).not.toHaveProperty('startedAt')
  for (const item of page.items) expect(item).not.toHaveProperty('completedAt')
})

it('holds the original branch/cut on older pages after a new branch is appended', async () => {
  const f = await fixture([message('one', null, 'user', 'one'), message('two', 'one', 'assistant', 'two')])
  const first = await f.client.sessionHistoryPage('private-agent', { limit: 1 })
  expect(first.items.map((item) => item.id)).toEqual(['two'])
  await appendFile(f.path, jsonl([message('new-branch', 'one', 'assistant', 'new')]))
  const older = await f.client.sessionHistoryPage('private-agent', { limit: 1, cursor: first.nextCursor! })
  expect(older.items.map((item) => item.id)).toEqual(['one'])
  expect(older.nextCursor).toBeNull()
  const fresh = await f.client.sessionHistoryPage('private-agent', { limit: 1 })
  expect(fresh.items.map((item) => item.id)).toEqual(['new-branch'])
})

it.each([{ version: 1 }, { version: 2 }, { id: 'another-native' }, { cwd: '/wrong-workspace' }])('refuses unsupported/foreign headers without migrating %s', async (extra) => {
  const f = await fixture([message('one', null, 'user', 'one')], extra)
  await expect(f.client.sessionHistoryPage('private-agent')).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  expect(await f.bytes()).toEqual(f.before)
})

it('rejects missing/cyclic parents instead of mixing another branch or falsely completing', async () => {
  for (const entries of [[message('one', 'missing', 'user', 'body')], [message('one', 'one', 'user', 'body')]]) {
    const f = await fixture(entries)
    await expect(f.client.sessionHistoryPage('private-agent')).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_INVALID_TRANSCRIPT' })
    expect(await f.bytes()).toEqual(f.before)
  }
})

it('excludes a partial tail and keeps an empty v3 transcript honestly empty', async () => {
  const f = await fixture([message('one', null, 'user', 'one')], {}, '{"type":"message"')
  expect((await f.client.sessionHistoryPage('private-agent')).items.map((item) => item.id)).toEqual(['one'])
  expect(await f.bytes()).toEqual(f.before)
  const empty = await fixture([])
  expect(await empty.client.sessionHistoryPage('private-agent')).toMatchObject({ items: [], nextCursor: null })
})
