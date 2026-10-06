import { describe, expect, it } from 'vitest'
import { parseConnectionDelivery, parseConnectionDeliveryParams, parseConnectionDeliveryReceipt, parseConnectionDeliveryResult, type ConnectionDelivery } from '../src/connections.js'
import { deliveryFact } from './fixtures/connection-delivery.js'

const scope = { connectionId: 'original-connection', bindingId: 'original-binding', bindingRevision: 3 }
describe('finite original delivery DTO', () => {
  it('preserves each queue fate separately from the original receipt and accepts exact opaque platform and source references', () => {
    const original = deliveryFact(), receipt = { state: 'not-applied' as const, reason: 'platform-rejected' as const }
    const facts: ConnectionDelivery[] = [original, { ...original, state: 'dispatching' }, { ...original, state: 'unknown', reason: 'effect-unconfirmed', receipt: { state: 'unknown', reason: 'effect-unconfirmed' } },
      { ...original, state: 'confirmed', mapping: { messageId: 'message/成员', threadId: 'thread@example.test' }, receipt: { state: 'confirmed', mapping: { messageId: 'message/成员', threadId: 'thread@example.test' } } },
      { ...original, state: 'not-applied', reason: 'platform-rejected', receipt }, { ...original, state: 'superseded', receipt },
      { ...original, state: 'cancelled', reason: 'original-speech-withdrawn', receipt }, { ...original, state: 'pending', receipt }]
    for (const fact of facts) expect(parseConnectionDelivery(fact)).toEqual(fact)
    const captured: ConnectionDelivery = { ...original, reference: { ...original.reference, source: { kind: 'captured', recordId: 'original-capture' } } }
    expect(parseConnectionDelivery(captured)).toEqual(captured)
  })
  it('validates surplus withdrawal ordinals without turning an absent mapping into a dispatched withdrawal', () => {
    const original = deliveryFact(), mapping = { messageId: 'old-fragment' }
    expect(parseConnectionDelivery({ ...original, effect: 'withdraw', fragment: { ordinal: 4, count: 0 }, state: 'pending' }).fragment).toEqual({ ordinal: 4, count: 0 })
    expect(parseConnectionDelivery({ ...original, effect: 'withdraw', fragment: { ordinal: 4, count: 1 }, state: 'confirmed', mapping }).mapping).toEqual(mapping)
    for (const fragment of [{ ordinal: -1, count: 1 }, { ordinal: 1, count: 1 }, { ordinal: 0, count: 0 }, { ordinal: 0.5, count: 2 }]) expect(() => parseConnectionDelivery({ ...original, fragment })).toThrow()
    expect(() => parseConnectionDelivery({ ...original, effect: 'withdraw', state: 'unknown', reason: 'effect-unconfirmed' })).toThrow()
    expect(() => parseConnectionDelivery({ ...original, state: 'confirmed' })).toThrow()
    expect(() => parseConnectionDelivery({ ...original, predecessorOperationId: original.operationId })).toThrow()
  })
  it('rejects private bodies, prepared wire, raw diagnostics and untrusted runtime object fields without echoing their values', () => {
    const original = deliveryFact(), secret = 'private-adapter-data'
    const invalid = [{ ...original, payload: secret }, { ...original, prepared: secret }, { ...original, ordinal: 2 }, { ...original, diagnostic: secret },
      { ...original, target: { ...original.target, authorization: secret } }, { ...original, mapping: { messageId: 'message', headers: secret } },
      { ...original, reference: { ...original.reference, source: { ...original.reference.source, diagnostic: secret } } },
      { ...original, receipt: { state: 'confirmed', mapping: { messageId: 'message' }, diagnostic: secret } }, { ...original, state: 'unknown', reason: secret }]
    for (const value of invalid) {
      try { parseConnectionDelivery(value); throw new Error('Expected invalid delivery') } catch (error) { expect((error as Error).message).not.toContain(secret); expect(error).toHaveProperty('code', 'INVALID_CONNECTION_DELIVERY_DATA') }
    }
    let reads = 0
    expect(() => parseConnectionDelivery(Object.defineProperty({ ...original }, 'mapping', { enumerable: true, get: () => { reads++; return secret } }))).toThrow()
    expect(reads).toBe(0)
    expect(() => parseConnectionDelivery(Object.assign(Object.create({ privileged: true }), original))).toThrow()
    expect(() => parseConnectionDelivery({ ...original, operationId: 'operation\nother' })).toThrow()
  })
  it('accepts only safe receipt reasons and consistent confirmed original mappings', () => {
    for (const reason of ['effect-unconfirmed', 'platform-rejected', 'adapter-unavailable', 'platform-unavailable', 'rate-limited', 'thread-unavailable', 'unsupported-format']) expect(parseConnectionDeliveryReceipt({ state: 'not-applied', reason })).toEqual({ state: 'not-applied', reason })
    for (const value of [{ state: 'unknown', reason: 'original-speech-withdrawn' }, { state: 'confirmed', mapping: { messageId: 'message' }, reason: 'platform-rejected' }, { state: 'not-applied', reason: 'platform-rejected', mapping: { messageId: 'message' } }]) expect(() => parseConnectionDeliveryReceipt(value)).toThrow()
    expect(() => parseConnectionDelivery({ ...deliveryFact(), state: 'confirmed', mapping: { messageId: 'original' }, receipt: { state: 'confirmed', mapping: { messageId: 'other' } } })).toThrow()
  })
  it('correlates bounded pages and continuations with the exact requested Connection and Binding revision', () => {
    const first = deliveryFact('z-first'), second = deliveryFact('a-second')
    expect(parseConnectionDeliveryResult('connection.delivery.ls', { deliveries: [first, second], next: second.operationId }, { ...scope, limit: 2 })).toEqual({ deliveries: [first, second], next: second.operationId })
    for (const value of [{ deliveries: [first, first], next: null }, { deliveries: [first], next: 'foreign' }, { deliveries: [], next: first.operationId },
      { deliveries: [{ ...first, bindingRevision: 2 }], next: null }, { deliveries: [{ ...first, bindingId: 'other' }], next: null }, { deliveries: [{ ...first, target: { ...first.target, connectionId: 'other' } }], next: null }]) expect(() => parseConnectionDeliveryResult('connection.delivery.ls', value, scope)).toThrow()
    expect(() => parseConnectionDeliveryResult('connection.delivery.ls', { deliveries: [first, second], next: null }, { ...scope, limit: 1 })).toThrow()
    expect(() => parseConnectionDeliveryResult('connection.delivery.ls', { deliveries: [first], next: null }, { ...scope, after: first.operationId })).toThrow()
    for (const limit of [0, 101, 1.5, Infinity]) expect(() => parseConnectionDeliveryParams('connection.delivery.ls', { ...scope, limit })).toThrow()
    expect(() => parseConnectionDeliveryParams('connection.delivery.ls', { ...scope, bindingRevision: 0 })).toThrow()
    expect(() => parseConnectionDeliveryParams('connection.delivery.retry', { operationId: first.operationId, actor: { kind: 'user', id: 'forged' } })).toThrow()
  })
  it('reports a finite current worker observation even when no delivery exists, without claiming an effect receipt', () => {
    const value = { deliveries: [], next: null, observation: { state: 'unknown', reason: 'source-gap' } }
    expect(parseConnectionDeliveryResult('connection.delivery.ls', value, scope)).toEqual(value)
    for (const state of ['unknown', 'ready', 'unavailable', 'disabled']) expect(parseConnectionDeliveryResult('connection.delivery.ls', { ...value, observation: { state } }, scope)).toEqual({ ...value, observation: { state } })
    for (const observation of [{ state: 'confirmed' }, { state: 'unknown', reason: 'raw-adapter-error' }, { state: 'ready', receipt: { state: 'confirmed' } }, null]) expect(() => parseConnectionDeliveryResult('connection.delivery.ls', { ...value, observation }, scope)).toThrow()
    expect(() => parseConnectionDelivery({ ...deliveryFact(), state: new String('pending') })).toThrow()
  })
  it('correlates inspections and retries with the original operation without manufacturing missing facts', () => {
    const original = deliveryFact()
    expect(parseConnectionDeliveryResult('connection.delivery.inspect', { delivery: null }, { operationId: original.operationId })).toEqual({ delivery: null })
    expect(parseConnectionDeliveryResult('connection.delivery.retry', { delivery: original }, { operationId: original.operationId })).toEqual({ delivery: original })
    for (const method of ['connection.delivery.inspect', 'connection.delivery.retry'] as const) expect(() => parseConnectionDeliveryResult(method, { delivery: original }, { operationId: 'foreign' })).toThrow()
    expect(() => parseConnectionDeliveryResult('connection.delivery.retry', { delivery: null }, { operationId: original.operationId })).toThrow()
  })
})
