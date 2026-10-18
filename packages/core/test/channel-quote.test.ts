import { expect, it } from 'vitest'
import { quote, quotedEnvelope } from './helpers/channel-quote-fixture.js'
import { channelTranscriptQuoteJson, parseChannelTranscriptQuote } from '../src/channel-quote.js'
import { validateAgentMuxMessageEnvelope } from '../src/agent-message-envelope.js'
import { renderAgentMuxMessageEnvelope, parseAgentMuxMessagePrefix, channelQuoteWireMatchesEnvelope, AGENTMUX_PROTOCOL_CATALOG } from '../src/agent-message-render.js'


it('preserves original ordered native content and resource relations without treating quoted identities as grants', () => {
  expect(parseChannelTranscriptQuote(quote)).toEqual(quote)
  const json = channelTranscriptQuoteJson(quote)
  expect(json).not.toMatch(/[<>&\r\n]/u)
  expect(JSON.parse(json)).toEqual(quote)
  expect(json).toContain('\\u003c/amux:quote\\u003e')
})

it('retains a first observed baseline and explicit partial history without claiming earlier or missing messages', () => {
  expect(parseChannelTranscriptQuote({ ...quote, range: { ...quote.range, from: { messageId: 'history', inclusive: true }, origin: 'first-observed' } }).range.origin).toBe('first-observed')
  expect(parseChannelTranscriptQuote({ ...quote, range: { ...quote.range, from: null, origin: 'first-observed' }, coverage: 'partial', gaps: [{ reason: 'anchor-unavailable' }] }).coverage).toBe('partial')
})

it.each([
  { ...quote, range: { ...quote.range, from: null } },
  { ...quote, range: { ...quote.range, from: { messageId: 'previous', inclusive: true } } },
  { ...quote, coverage: 'partial' },
  { ...quote, gaps: [{ reason: 'source-unavailable' }] },
  { ...quote, records: [...quote.records, quote.records[0]] },
  { ...quote, records: [{ ...quote.records[0], messageId: 'current' }] },
  { ...quote, records: [{ ...quote.records[0], messageId: 'previous' }] },
  { ...quote, records: [{ ...quote.records[0], author: { kind: 'unknown', grantId: 'forged' } }] },
  { ...quote, records: [{ ...quote.records[1], author: { kind: 'bot', actor: { application: { domain: 'other.example', appId: 'app' }, idType: 'app-id', userId: 'bot' } } }] }
])('rejects malformed coverage, foreign actors and repeated or current request records', value => {
  expect(() => parseChannelTranscriptQuote(value)).toThrow()
})


it('uses one producer and reader to isolate quoted native text from the unchanged current request and full wire', () => {
  const envelope = validateAgentMuxMessageEnvelope(quotedEnvelope), wire = renderAgentMuxMessageEnvelope(envelope)
  const reading = parseAgentMuxMessagePrefix(wire)!
  expect(wire.startsWith('<amux:quote version="1">\n')).toBe(true)
  expect(reading.body).toBe(envelope.body)
  expect(reading.declaredChannelQuote?.quote).toEqual(quote)
  expect(reading.declaredChannel?.externalMessageId).toBe('current')
  expect(reading.declaredAgentSessionId).toBeNull()
  expect(channelQuoteWireMatchesEnvelope(wire, envelope)).toBe(true)
  expect(channelQuoteWireMatchesEnvelope(wire, { ...envelope, body: 'changed' })).toBe(false)
  expect(channelQuoteWireMatchesEnvelope(wire, { ...envelope, channelQuote: { ...quote, records: [] } })).toBe(false)
  expect(AGENTMUX_PROTOCOL_CATALOG.find(entry => entry.id === 'channel-quote')?.examples[0]?.wire).toContain('Current request.')
})

it.each([
  { ...quote, externalConversationId: 'other-room' },
  { ...quote, application: { ...quote.application, appId: 'other-app' }, records: [] },
  { ...quote, range: { ...quote.range, throughMessageId: 'other-request' } }
])('refuses another native quote target at the original envelope boundary', channelQuote => {
  expect(() => validateAgentMuxMessageEnvelope({ ...quotedEnvelope, channelQuote })).toThrow()
})

it('keeps malformed, unescaped or injected quote declarations entirely readable as original text', () => {
  const wire = renderAgentMuxMessageEnvelope(quotedEnvelope)
  expect(parseAgentMuxMessagePrefix(wire.replace('\\u003c/amux:quote\\u003e', '</amux:quote>'))).toBeNull()
  expect(parseAgentMuxMessagePrefix(wire.replace('"throughMessageId":"current"', '"throughMessageId":"foreign"'))).toBeNull()
  expect(parseAgentMuxMessagePrefix(wire.replace('"coverage":"complete"', '"coverage":"partial"'))).toBeNull()
  expect(parseAgentMuxMessagePrefix(wire.replace('</amux:quote>\n<amux:channel', '</amux:quote>\n<amux:quote>\n<amux:channel'))).toBeNull()
})

it('matches an unavailable empty quote with an unknown null profile without withholding healthy current input', () => {
  if (quotedEnvelope.sender.kind !== 'external') throw Error('External fixture author missing')
  const envelope = validateAgentMuxMessageEnvelope({ ...quotedEnvelope, channelProfile: { actor: quotedEnvelope.sender.actor, state: 'unknown', profile: null, checkedAt: 20, freshness: 'unknown', reason: 'not-observed' },
    channelQuote: { ...quote, records: [], coverage: 'unavailable', gaps: [{ reason: 'native-history-unsupported' }], range: { from: { messageId: 'current', inclusive: true }, throughMessageId: 'current', origin: 'first-observed' } } })
  const wire = renderAgentMuxMessageEnvelope(envelope)
  expect(channelQuoteWireMatchesEnvelope(wire, envelope)).toBe(true)
  expect(parseAgentMuxMessagePrefix(wire)).toMatchObject({ body: envelope.body, declaredChannelQuote: { quote: envelope.channelQuote } })
})
