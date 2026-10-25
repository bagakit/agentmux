import { appendFile } from 'node:fs/promises'
import { afterEach, expect, it } from 'vitest'
import { consumeConversationWindowPage } from '../../src/conversation.js'
import { jsonl, nativeHistoryFixture } from '../fixtures/native-history-session.js'

const fixtures: Awaited<ReturnType<typeof nativeHistoryFixture>>[] = []
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close() })
const ref = { hostId: 'local', agentSessionId: 'private-agent' }
const assistant = (uuid: string, content: unknown, stopReason?: string | null, extra: Record<string, unknown> = {}) => ({
  type: 'assistant', sessionId: 'native-main', uuid, user_message_uuid: 'original-input',
  message: { id: 'response-with-distinct-blocks', role: 'assistant', content, ...(stopReason === undefined ? {} : { stop_reason: stopReason }) },
  ...extra
})
async function fixture(rows: unknown[]) {
  const f = await nativeHistoryFixture('claude', jsonl(rows)); fixtures.push(f); return f
}

it('reads distinct public progress blocks and a final through Core without collapsing shared response IDs or tool steps', async () => {
  const f = await fixture([
    assistant('progress-1', [{ type: 'text', text: 'The work is complete.' }], 'tool_use'),
    assistant('progress-2', [{ type: 'text', text: 'The work is complete.' },
      { type: 'image', source: { type: 'url', url: 'https://example.test/original.png' } }], 'tool_use'),
    assistant('tool', [{ type: 'tool_use', id: 'call-original', name: 'Read', input: { path: 'original' } }], 'tool_use'),
    assistant('final', [{ type: 'text', text: 'I will inspect the next step.' }], 'end_turn', {
      message: { id: 'final-response', role: 'assistant', content: [{ type: 'text', text: 'I will inspect the next step.' }], stop_reason: 'end_turn' }
    })
  ])
  const history = await f.client.sessionHistoryPage(ref.agentSessionId)
  expect(history.items.map(item => [item.id, item.kind, item.messagePhase])).toEqual([
    ['progress-1', 'assistant-message', 'progress'], ['progress-2', 'assistant-message', 'progress'],
    ['tool', 'activity', undefined], ['final', 'assistant-message', 'final']
  ])
  expect(history.items[1]!.contentParts).toEqual([
    { kind: 'text', text: 'The work is complete.', contentEligibility: 'public' },
    { kind: 'resource', resourceType: 'image', reference: 'https://example.test/original.png', contentEligibility: 'public' }
  ])
  for (const item of history.items) {
    expect(item.turnId).toBe('original-input')
    expect(item).not.toHaveProperty('completedAt')
  }

  const page = await f.client.readAgentConversation({ ...ref, processDetails: 'deferred' })
  const reading = consumeConversationWindowPage(page)
  expect(reading.kind).toBe('complete')
  if (reading.kind !== 'complete') throw Error('Expected the complete small conversation')
  const originals = reading.snapshot.units.flatMap(unit => unit.records)
  const speech = originals.filter(record => record.original.kind === 'native')
  expect(speech.map(record => record.original.kind === 'native' && [record.original.item.id, record.original.item.messagePhase]).sort())
    .toEqual([['final', 'final'], ['progress-1', 'progress'], ['progress-2', 'progress']])
  expect(reading.snapshot.units.filter(unit => unit.event.role === 'message')).toHaveLength(3)
  expect(originals.filter(record => record.original.kind === 'deferred')).toHaveLength(1)
  const original = speech.find(record => record.original.kind === 'native' && record.original.item.id === 'progress-1')!
  const detail = consumeConversationWindowPage(await f.client.readAgentConversation({ ...ref,
    anchor: { record: original.reference!, revision: original.revision, frontier: reading.snapshot.window.checkpoint } }))
  expect(detail.kind).toBe('complete')
  if (detail.kind !== 'complete') throw Error('Expected the exact original message')
  expect(detail.snapshot.units.flatMap(unit => unit.records).map(record => record.original))
    .toEqual([{ kind: 'native', item: history.items[0] }])
  expect((await f.bytes()).native).toEqual(f.before.native)
  expect(await f.store.load()).toEqual([f.session])
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
})

it('keeps unknown and interrupted speech readable without guessing from prose, adjacent tools or progress event names', async () => {
  const f = await fixture([
    ...[undefined, null, 'max_tokens', 'stop_sequence', 'refusal', 'pause_turn', 'future_reason'].map((reason, index) =>
      assistant(`unknown-${index}`, 'Finished. I will use a tool next.', reason)),
    assistant('aborted', 'Retained partial original', 'end_turn', { isAbortedMidStream: true }),
    assistant('adjacent-tool', [{ type: 'tool_use', id: 'call', name: 'Read', input: {} }], 'tool_use'),
    assistant('thinking', [{ type: 'thinking', thinking: 'Recorded thought' }], 'end_turn'),
    assistant('generated', 'Generated context', 'end_turn', { isSynthetic: true }),
    assistant('error', 'Original API error', 'end_turn', { isApiErrorMessage: true }),
    ...['agent_progress', 'hook_progress', 'bash_progress'].map(type => ({
      type: 'progress', sessionId: 'native-main', uuid: type,
      data: { type, message: assistant('nested', 'Nested progress is not main-agent speech', 'tool_use') }
    }))
  ])
  const page = await f.client.sessionHistoryPage(ref.agentSessionId)
  expect(page.items).toHaveLength(15)
  expect(page.items.filter(item => item.kind === 'assistant-message').map(item => item.id))
    .toEqual([...Array.from({ length: 7 }, (_, i) => `unknown-${i}`), 'aborted'])
  for (const item of page.items) {
    expect(item).not.toHaveProperty('messagePhase')
    expect(item).not.toHaveProperty('completedAt')
  }
  expect(page.items[7]!.contentParts).toEqual([{ kind: 'text', text: 'Retained partial original', contentEligibility: 'public' }])
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
})

it('preserves phase and exact records across append changes and backwards history pages', async () => {
  const f = await fixture([assistant('before', 'Before the tool', 'tool_use')])
  const checkpoint = await f.client.sessionHistoryCheckpoint(ref.agentSessionId)
  await appendFile(f.path, jsonl([
    assistant('after', [{ type: 'text', text: 'Tool results are available' }], 'tool_use'),
    assistant('answer', 'Answer', 'end_turn')
  ]))
  const changes = await f.client.readSessionHistoryChanges(ref.agentSessionId, { checkpoint, limit: 100 })
  expect(changes.items.map(item => [item.id, item.messagePhase])).toEqual([['after', 'progress'], ['answer', 'final']])
  const latest = await f.client.sessionHistoryPage(ref.agentSessionId, { limit: 1 })
  expect(latest.items).toEqual([changes.items[1]])
  expect(latest.nextCursor).toBeTruthy()
  const earlier = await f.client.sessionHistoryPage(ref.agentSessionId, { limit: 1, cursor: latest.nextCursor! })
  expect(earlier.items).toEqual([changes.items[0]])
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
})
