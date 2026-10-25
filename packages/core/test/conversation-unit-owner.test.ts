import { afterEach, expect, it, vi } from 'vitest'
import { nativeHistoryFixture, jsonl } from './fixtures/native-history-session.js'
import { consumeConversationWindowPage, parseConversationReadPageForWindow, parseConversationUnitsForPage } from '../src/conversation.js'
import * as stream from '../src/conversation-stream.js'

const closes: Array<() => Promise<unknown>> = []
afterEach(async () => { try { for (const close of closes.splice(0).reverse()) await close() } finally { vi.restoreAllMocks() } })

it('reuses only exact immutable page items and independently validates copied, raw and foreign units', async () => {
  const f = await nativeHistoryFixture('claude', jsonl([{ type: 'user', uuid: 'original', sessionId: 'native-main', message: { role: 'user', content: 'Original contribution' } }]))
  closes.push(f.close)
  const input = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  const page = parseConversationReadPageForWindow(await f.client.readAgentConversation(input), input)
  const consumed = consumeConversationWindowPage(page)
  if (consumed.kind !== 'complete') throw Error('Expected a complete original window')
  const units = consumed.snapshot.units
  expect(units.length).toBeGreaterThan(0)
  const digest = vi.spyOn(stream, 'conversationRevision')
  expect(parseConversationUnitsForPage(units, page)[0]).toBe(units[0])
  expect(digest).not.toHaveBeenCalled()
  for (const [values, context] of [
    [structuredClone(units), page], [units, structuredClone(page)],
    [units, parseConversationReadPageForWindow(structuredClone(page), input)]
  ] as const) {
    digest.mockClear()
    const parsed = parseConversationUnitsForPage(values, context)
    expect(parsed).toEqual(units); expect(parsed[0]).not.toBe(values[0])
    expect(digest, 'Only exact items of this original owned page reuse content validation').toHaveBeenCalled()
  }
  const malformed = structuredClone(units)
  malformed[0]!.event.revision = 'a'.repeat(64)
  expect(() => parseConversationUnitsForPage(malformed, page)).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  const foreign = structuredClone(page); foreign.agentSessionId = 'another-session'
  expect(() => parseConversationUnitsForPage(units, foreign)).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  expect(f.controls.every(control => control.mock.calls.length === 0)).toBe(true)
})
