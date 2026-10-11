import { appendFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { paginatedFixture, user, context, body, source, turn, jsonl } from './helpers/codex-paginated.js'
import { readCodexSavedSessionHistoryRecord } from '../src/providers/codex-saved-history.js'
import { conversationRevision, consumeJsonReadEntry, type ConversationUnit } from '../src/conversation.js'
import { readSessionHistoryTextResource } from '../src/session-history-content.js'
import { savedQuestionReply, savedQuestionAnswer } from './helpers/codex-saved-question.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'

const close: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of close.splice(0).reverse()) await dispose(); vi.restoreAllMocks() })

it('uses canonical paginated user content and retains every context, assistant and tool record', async () => {
  const assistant = { type: 'response_item', payload: { type: 'message', id: 'assistant-original', role: 'assistant', content: [{ type: 'output_text', text: 'Original reply' }] } }
  const tool = { type: 'response_item', payload: { type: 'function_call', id: 'tool-original', name: 'read', call_id: 'original-call', arguments: '{}' } }
  const f = await paginatedFixture([context(), user(), assistant, tool]); close.push(f.close)
  const page = await f.client.sessionHistoryPage(f.session.agentSessionId)
  expect(page.items).toHaveLength(4)
  expect(page.items[0]).toMatchObject({ id: 'model-context-record', kind: 'activity', title: 'Model context', contentParts: [{ kind: 'text', text: body }] })
  expect(page.items[1]).toMatchObject({ id: f.recordId(1), kind: 'user-message', turnId: turn, contentParts: [{ kind: 'text', text: body }] })
  expect(page.items[1]!.id).not.toBe('native-user-item')
  expect(page.items[2]).toMatchObject({ id: 'assistant-original', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Original reply' }] })
  expect(page.items[3]).toMatchObject({ id: 'tool-original', kind: 'activity', contentParts: [{ kind: 'tool-call', callId: 'original-call' }] })
  const messages = await f.client.readAgentSessionHistory({ hostId: 'local', agentSessionId: f.session.agentSessionId, source: 'native', kind: 'user-message', limit: 100 })
  expect(messages.userMessages).toHaveLength(1); expect(messages.userMessages![0]).toMatchObject({ rawId: f.recordId(1), content: body, publicContent: 'unknown', author: { kind: 'unknown' } })
  expect(page.items[1]).not.toHaveProperty('conversation.sameEvent')
  await f.unchangedSource()
})

it.each(['legacy', Symbol('missing'), null, 'future'])('does not borrow the paginated contract from format %s', async mode => {
  const f = await paginatedFixture([context(), user()], mode); close.push(f.close)
  const page = await f.client.sessionHistoryPage(f.session.agentSessionId)
  expect(page.items[0]).toMatchObject({ kind: 'user-message', contentParts: [{ kind: 'text', text: body }] })
  expect(page.items[1]).toMatchObject({ kind: 'activity', contentParts: [{ kind: 'text', text: JSON.stringify(user().payload) }] })
})

it.each([['paginated', 'legacy'], ['legacy', 'paginated']])('only the first format %s applies when a tail page contains copied %s metadata', async (first, copied) => {
  const f = await paginatedFixture([context(), ...Array.from({ length: 30 }, () => ({ type: 'event_msg', payload: { type: 'unrelated', text: 'padding'.repeat(3000) } })), user()], first); close.push(f.close)
  await appendFile(f.transcriptPath, jsonl([{ type: 'session_meta', payload: { ...f.meta.payload, history_mode: copied } }]))
  const page = await f.client.sessionHistoryPage(f.session.agentSessionId, { limit: 1 })
  expect(page.items).toHaveLength(1); expect(page.items[0]!.kind).toBe(first === 'paginated' ? 'user-message' : 'activity')
  expect(page.items[0]!.id).toBe(f.recordId(31)); expect(page.nextCursor).toBeTruthy()
})

it('preserves isolated context, duplicate genuine users and malformed or foreign completed originals', async () => {
  const foreign = user(); foreign.payload.thread_id = 'foreign-native'
  const malformed = user(); delete (malformed.payload as Partial<typeof malformed.payload>).turn_id
  const unknown = { type: 'future-input', opaque: ['complete', 7] }
  const f = await paginatedFixture([context(), user('first', [{ type: 'text', text: body }, unknown]), user('second'), foreign, malformed]); close.push(f.close)
  const page = await f.client.sessionHistoryPage(f.session.agentSessionId)
  expect(page.items.filter(item => item.kind === 'user-message')).toHaveLength(2)
  expect(page.items[1]!.contentParts).toEqual([{ kind: 'text', text: body }, { kind: 'text', text: JSON.stringify(unknown) }])
  for (const [index, raw] of [[3, foreign], [4, malformed]] as const) expect(page.items[index]).toMatchObject({ kind: 'activity', contentParts: [{ kind: 'text', text: JSON.stringify(raw.payload) }] })
  const only = await paginatedFixture([context()]); close.push(only.close)
  expect((await only.client.sessionHistoryPage(only.session.agentSessionId)).items).toMatchObject([{ id: 'model-context-record', kind: 'activity', contentParts: [{ text: body }] }])
})

it('keeps canonical question reply metadata in the original parser and known UserInput resources in order', async () => {
  const wrapper = savedQuestionReply().payload.content[0]!.text
  const f = await paginatedFixture([user('reply', [{ type: 'text', text: wrapper }, { type: 'mention', path: 'app://original', name: 'Original mention' }]),
    user('mixed', [{ type: 'text', text: wrapper }, { type: 'image', image_url: 'opaque:image' }, { type: 'audio', audio_url: 'opaque:audio' }])]); close.push(f.close)
  const [item, mixed] = (await f.client.sessionHistoryPage(f.session.agentSessionId)).items
  expect(item).toMatchObject({ kind: 'user-message', questionAnswers: [{ answer: savedQuestionAnswer }] })
  expect(item!.contentParts).toEqual([{ kind: 'text', text: wrapper }, { kind: 'resource', resourceType: 'file', reference: 'app://original', label: 'Original mention' }])
  expect(mixed!.contentParts).toEqual([{ kind: 'text', text: wrapper }, { kind: 'resource', resourceType: 'image', reference: 'opaque:image' }, { kind: 'resource', resourceType: 'audio', reference: 'opaque:audio' }])
  expect(mixed!.questionAnswers).toBeUndefined()
})

it.each([false, true])('page, exact resource and durable changes preserve the same deferred canonical parts and raw position (compiled=%s)', async compiled => {
  const f = await paginatedFixture([], 'paginated', compiled); close.push(f.close)
  const cut = await f.client.sessionHistoryCheckpoint(f.session.agentSessionId)
  const text = 'Original complete user 中🙂\n'.repeat(90_000), original = user('large', [{ type: 'text', text }, { type: 'future', value: 'retained' }])
  await appendFile(f.transcriptPath, jsonl([original]))
  const page = await f.client.sessionHistoryPage(f.session.agentSessionId), item = page.items[0]!
  expect(item).toMatchObject({ id: f.recordId(0), kind: 'user-message', turnId: turn })
  const part = item.contentParts[0]!
  expect(part).toMatchObject({ kind: 'resource', resourceType: 'text', content: { kind: 'text' } })
  if (part.kind !== 'resource' || part.resourceType !== 'text') throw Error('Missing original deferred text resource')
  expect(await readSessionHistoryTextResource(part, 0, { source, recordId: item.id, turnId: turn }, input => f.client.sessionHistoryResource(f.session.agentSessionId, input))).toEqual({ kind: 'text', text })
  expect(await readCodexSavedSessionHistoryRecord({ ...f.providerContext, recordId: item.id, turnId: turn })).toEqual(item)
  expect((await f.client.readSessionHistoryChanges(f.session.agentSessionId, { checkpoint: cut })).items).toEqual([item])
}, 30_000)

it.each([false, true])('exact Core anchors use the corrected version and never substitute the old activity representation (compiled=%s)', async compiled => {
  const f = await paginatedFixture([user()], 'paginated', compiled); close.push(f.close)
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }, page = await f.client.readAgentConversation({ ...ref, limit: 10 })
  const entry = page.items[0]!; expect(entry.kind).toBe('item')
  if (entry.kind !== 'item') throw Error('Missing actual Core unit')
  const unit = entry.item as ConversationUnit, record = unit.records[0]!
  expect(unit.event.role).toBe('message')
  const cut = (await f.client.conversationCheckpoint(ref)).checkpoint
  const anchor = { record: record.reference!, revision: record.revision, frontier: cut }
  const exact = await f.client.readAgentConversation({ ...ref, anchor })
  const read = consumeJsonReadEntry({ entry: exact.items[0]!, scopeKey: 'exact', maxTotalBytes: 32 * 1024 * 1024 })
  expect(read.kind).toBe('complete')
  if (read.kind === 'complete') expect((read.value as ConversationUnit).records[0]).toEqual(record)
  const old = { id: f.recordId(0), kind: 'activity', title: 'item_completed', startedAt: _historyFixtureEpoch(0, 0, 100), turnId: turn, contentParts: [{ kind: 'text', text: JSON.stringify(user().payload) }] }
  expect(record.revision).not.toBe(conversationRevision(old))
  const unavailable = await f.client.readAgentConversation({ ...ref, anchor: { ...anchor, revision: conversationRevision(old) } })
  expect(unavailable.items).toEqual([])
  expect(unavailable.coverage.flatMap(c => c.gaps).map(g => g.code)).toContain('AGENT_CONVERSATION_VERSION_UNAVAILABLE')
})
