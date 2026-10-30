import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { parseConnectionDelivery, type ConnectionDelivery } from '@agentmux/core/connections'
import { deliveryFact } from '../../core/test/fixtures/connection-delivery.js'
import { publicationRateLimitObservation, type PublicationRateLimitAdvice } from '../src/publication-rate-limit.js'

const observedAt = fixtureEpoch(2)
const scopes = { request: 'a'.repeat(64), conversation: 'b'.repeat(64) }
const source = { kind: 'message' as const, attempt: 3 }
const localDeadline = observedAt + 5_000
const wait = { reason: 'rate-limit' as const, notBefore: localDeadline, basis: 'local' as const }
const rateLimitedDelivery = (): ConnectionDelivery => ({ ...deliveryFact(), state: 'not-applied', reason: 'rate-limited',
  receipt: { state: 'not-applied', reason: 'rate-limited' }, retrySource: source })

afterEach(() => vi.restoreAllMocks())

describe('publication rate-limit contract', () => {
  describe('public original-delivery wait', () => {
    it.each(['native', 'local'] as const)('preserves a %s pending wait without inventing a retry source', basis => {
      const original = { ...deliveryFact(), wait: { ...wait, basis } }
      const parsed = parseConnectionDelivery(original)
      expect(parsed).toEqual(original)
      expect(parsed.retrySource).toBeUndefined()
      expect(parsed.lastContinuation).toBeUndefined()
    })

    it('preserves the exact message failure source beside its wait', () => {
      const original = { ...rateLimitedDelivery(), wait }
      expect(parseConnectionDelivery(original)).toEqual(original)
      expect(parseConnectionDelivery(original).retrySource).toEqual(source)
    })

    it.each(['platform-rejected', 'unsupported-format'] as const)('rejects a wait attached to a %s refusal', reason => {
      const original = { ...rateLimitedDelivery(), reason, receipt: { state: 'not-applied' as const, reason } }
      expect(parseConnectionDelivery(original)).toEqual(original)
      expect(() => parseConnectionDelivery({ ...original, wait })).toThrowError(expect.objectContaining({ code: 'INVALID_CONNECTION_DELIVERY_DATA' }))
    })

    it('rejects a wait on an unknown message effect', () => {
      const original: ConnectionDelivery = { ...deliveryFact(), state: 'unknown', reason: 'effect-unconfirmed',
        receipt: { state: 'unknown', reason: 'effect-unconfirmed' } }
      expect(parseConnectionDelivery(original)).toEqual(original)
      expect(() => parseConnectionDelivery({ ...original, wait })).toThrowError(expect.objectContaining({ code: 'INVALID_CONNECTION_DELIVERY_DATA' }))
    })

    it('does not turn a rate-limit reason without the original source into a qualified failure wait', () => {
      const { retrySource: _source, ...original } = rateLimitedDelivery()
      expect(parseConnectionDelivery(original)).toEqual(original)
      expect(() => parseConnectionDelivery({ ...original, wait })).toThrowError(expect.objectContaining({ code: 'INVALID_CONNECTION_DELIVERY_DATA' }))
    })
  })

  describe('private original-response advice', () => {
    it.each([scopes.request, scopes.conversation])('retains the actual source and only the responding native scope %s', scopeKey => {
      expect(publicationRateLimitObservation(source.attempt, { scopeKey, observedAt, resetSeconds: 0 }, scopes)).toEqual({
        source, scopeKey, reason: 'rate-limit', notBefore: observedAt, basis: 'native'
      })
    })

    it('retains a legal long native deadline and does not extend it when observed again later', () => {
      const advice = { scopeKey: scopes.request, observedAt, resetSeconds: 7_200 }
      const original = { source, scopeKey: scopes.request, reason: 'rate-limit', notBefore: observedAt + 7_200 * 1_000, basis: 'native' }
      expect(publicationRateLimitObservation(source.attempt, advice, scopes)).toEqual(original)
      vi.spyOn(Date, 'now').mockReturnValue(observedAt + 24 * 60 * 60 * 1_000)
      expect(publicationRateLimitObservation(source.attempt, advice, scopes)).toEqual(original)
    })

    it.each([
      { label: 'missing reset', resetSeconds: undefined },
      { label: 'negative reset', resetSeconds: -1 },
      { label: 'non-finite reset', resetSeconds: Number.POSITIVE_INFINITY },
      { label: 'NaN reset', resetSeconds: Number.NaN },
      { label: 'unsafe millisecond multiplication', resetSeconds: Number.MAX_SAFE_INTEGER },
      { label: 'unsafe final deadline addition', resetSeconds: 9_007_199_254_000 }
    ])('uses the local5s policy for $label while retaining accurate native membership', ({ resetSeconds }) => {
      const advice: PublicationRateLimitAdvice = { scopeKey: scopes.conversation, observedAt,
        ...(resetSeconds === undefined ? {} : { resetSeconds }) }
      expect(publicationRateLimitObservation(source.attempt, advice, scopes)).toEqual({
        source, scopeKey: scopes.conversation, reason: 'rate-limit', notBefore: localDeadline, basis: 'local'
      })
    })

    it('cannot derive an observation from a foreign scope or absent original membership', () => {
      const advice = { scopeKey: 'c'.repeat(64), observedAt, resetSeconds: 30 }
      expect(publicationRateLimitObservation(source.attempt, advice, scopes)).toBeUndefined()
      expect(publicationRateLimitObservation(source.attempt, { ...advice, scopeKey: scopes.request }, undefined)).toBeUndefined()
      expect(publicationRateLimitObservation(source.attempt, undefined, scopes)).toBeUndefined()
    })
  })
})
