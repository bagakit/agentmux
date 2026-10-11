import { expect, it } from 'vitest'
import { parseConnectionSetupResult as decodePublicResult, type ConnectionSetupOperation, type ConnectionSetupView } from '@agentmux/core/connections'
import { parseConnectionSetupResult } from '../src/connection-setup-codec.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const decoders = [parseConnectionSetupResult, decodePublicResult]
const input = { operationId: 'original-management-intent' }
function reply(authentication?: ConnectionSetupOperation['authentication']): ConnectionSetupView {
  return {
    operation: {
      ...input, connectionId: 'saved-bot', expectedConnectionRevision: 3,
      goal: { kind: 'agent-conversation', interaction: 'messages' }, revision: 11,
      adapterId: 'test-adapter', application: { domain: 'platform.example', appId: 'app_saved_bot' },
      request: { state: 'confirmed', attemptId: 'original-init-attempt' }, secureStorage: 'stored',
      ...(authentication ? { authentication } : {})
    },
    challenge: { qrPayload: 'fixture-active-opaque-challenge', expiresAt: null, nextPollAt: _historyFixtureEpoch(0, 0, 0) }
  }
}
const authentication = { attemptId: 'current-auth-attempt', stepId: 'current-auth-step', stage: 'waiting' as const, request: 'confirmed' as const, secureStorage: 'stored' as const }

it('source and public compiled decoder accept the exact stored challenge owner while retaining an older unknown init receipt', () => {
  const initial = reply(), renewed = reply(authentication)
  renewed.operation!.request.state = 'unknown'; renewed.operation!.secureStorage = 'unknown'
  for (const decode of decoders) {
    expect(decode('connection.setup.inspect', initial, input)).toEqual(initial)
    const decoded = decode('connection.setup.inspect', renewed, input)
    expect(decoded).toEqual(renewed)
    expect(decoded.operation?.request).toEqual({ state: 'unknown', attemptId: 'original-init-attempt' })
    expect(decoded.operation?.authentication).toEqual(authentication)
  }
})

it('a stored old init cannot qualify any current unknown, unstored or dispatching authentication challenge', () => {
  const states = [
    { request: 'unknown', secureStorage: 'unknown' },
    { request: 'confirmed', secureStorage: 'unknown' },
    { request: 'dispatching', secureStorage: 'storing' }
  ] as const
  for (const state of states) {
    const value = reply({ ...authentication, ...state })
    for (const decode of decoders) {
      expect(() => decode('connection.setup.inspect', value, input), `Current ${state.request}/${state.secureStorage} cannot borrow the old init ACK`).toThrow(expect.objectContaining({ code: 'INVALID_CONNECTION_SETUP_DATA' }))
      // The same original safe observation remains readable when private challenge material is withheld.
      expect(decode('connection.setup.inspect', { ...value, challenge: null }, input)).toEqual({ ...value, challenge: null })
    }
  }
})
