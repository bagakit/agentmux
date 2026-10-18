import { afterEach, expect, it, vi } from 'vitest'
import { projectConversationStream, projectConversationTimeline, conversationRecordId, type ConversationStreamInput } from '../src/conversation.js'
import * as sourceAdapter from '../src/conversation-timeline.js'
import { nativeHistoryFixture, jsonl } from './fixtures/native-history-session.js'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'

const sid = 'stream-session', hostId = 'original-host'
const source = { providerId: 'claude', nativeSessionId: 'original-native' }
const target = { hostId, agentSessionId: sid, source: { kind: 'native' as const, ...source, recordId: 'native-input' } }
function originals(related = false) {
  return projectConversationTimeline({ agentSessionId: sid, executionHostId: hostId,
    historyPage: { agentSessionId: sid, source, nextCursor: null, items: [
      { id: 'native-input', kind: 'user-message', contentParts: [{ kind: 'text', text: 'Repeatable input' }] }
    ] }, timeline: { agentSessionId: sid, revision: 1, items: [
      { id: 'submitted-input', agentSessionId: sid, kind: 'user_message', source: 'user', status: 'complete', title: 'Input',
        content: 'Repeatable input', authorHuman: true, createdAt: fixtureEpoch(0, 0, 1), updatedAt: fixtureEpoch(0, 0, 1),
        ...(related ? { conversation: { sameEvent: target } } : {}) }
    ] } })
}
function accepted(value = originals()): ConversationStreamInput {
  return { agentSessionId: sid, reference: value.reference, records: value.records, scope: value.scope,
    coverage: value.coverage, nativeSource: source }
}
const closes: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })

it('retains accepted source objects and writer versions without serializing the original body again', () => {
  const input = accepted()
  const originals = input.records.map(record => record.original.item)
  for (const item of originals) Object.defineProperty(item, 'toJSON', { value() { throw Error('Original writer version must be reused') } })
  const result = projectConversationStream(input)
  expect(result.events).toHaveLength(2)
  expect(result.records).toEqual(input.records)
  result.records.forEach((record, index) => {
    expect(record).toBe(input.records[index]); expect(record.original.item).toBe(originals[index])
    expect(record.revision).toBe(input.records[index]!.revision)
    expect(record.order).toBe(input.records[index]!.order)
  })
  expect(result.events.map(event => [event.reference?.source.kind, event.author.kind])).toEqual([['captured', 'human'], ['native', 'unknown']])
})

it('coalesces only an exact late relation while retaining both original contributions', () => {
  const first = projectConversationStream(accepted()), next = projectConversationStream(accepted(originals(true)))
  expect(first.events).toHaveLength(2); expect(next.events).toHaveLength(1)
  expect(next.records).toHaveLength(2)
  expect(next.events[0]!.id).toBe(conversationRecordId(target))
  expect(next.events[0]!.author).toEqual({ kind: 'human' })
  expect(next.events[0]!.content.map(part => part.placement)).toEqual(['body', 'detail'])
  const submitted = first.records.find(record => record.original.kind === 'captured')!
  expect(next.events[0]!.coalesces).toEqual([{ fromEventIds: [submitted.id],
    relation: { kind: 'same-event', from: submitted.reference, to: target } }])
  expect(next.events[0]!.revision).not.toBe(first.events[0]!.revision)
  expect(next.order.crossSource).toBe('partial')
})

it('keeps a foreign Host contribution independent and exposes the original namespace conflict', () => {
  const input = accepted(originals(true)), captured = input.records.find(record => record.original.kind === 'captured')!
  const foreign = { ...captured, reference: { ...captured.reference!, hostId: 'another-host' } }
  const native = input.records.find(record => record.original.kind === 'native')!
  const result = projectConversationStream({ ...input, records: [native, foreign] })
  expect(result.reference).toBeNull()
  expect(result.events).toHaveLength(2)
  expect(result.records.find(record => record.reference?.hostId === 'another-host')).toBe(foreign)
  expect(result.coverage.flatMap(value => value.gaps).map(gap => gap.code)).toContain('CONVERSATION_SOURCE_HOST_CONFLICT')
  expect(result.events.map(event => event.coalesces)).toEqual([undefined, undefined])
})

it('reads and advances a real Core conversation without converting accepted records back into source pages', async () => {
  const f = await nativeHistoryFixture('claude', jsonl([{ type: 'user', uuid: 'original-input', sessionId: 'native-main',
    message: { role: 'user', content: 'Original native input' } }]))
  closes.push(f.close)
  const adapter = vi.spyOn(sourceAdapter, 'projectConversationTimeline')
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  const first = await f.client.readAgentConversation(ref)
  expect(first.items.length).toBeGreaterThan(0)
  const next = await f.client.readConversationChanges({ ...ref, checkpoint: first.window.checkpoint, view: first.window.view! })
  expect(next.window.id).toBe(first.window.id)
  expect(next.items).toEqual(first.items)
  expect(adapter).not.toHaveBeenCalled()
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})
