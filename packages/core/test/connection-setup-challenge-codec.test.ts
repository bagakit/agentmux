import { expect, it } from 'vitest'
import { parseConnectionEnrollmentDiagnostic, parseConnectionSetupResult as decodePublicResult, type ConnectionSetupOperation, type ConnectionSetupView } from '@agentmux/core/connections'
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

it('private child evidence may be saved or locally recovered while business confirmation stays unknown', () => {
  const readInput = { operationId: input.operationId, expectedRevision: 11, decision: { actionId: 'setup-inspect:original', value: 'continue' as const } }
  const read = { stepId: 'original-read-child', input: readInput, request: 'unknown' as const, secureStorage: 'stored' as const }
  const writeInput = { ...readInput, decision: { actionId: 'setup-enable:original', value: 'confirm' as const } }
  const write = { effect: 'enable-messaging' as const, stepId: 'original-effect-child', sourceStepId: read.stepId, input: writeInput, request: 'unknown' as const, secureStorage: 'stored' as const }
  const confirmed = { ...reply({ ...authentication, stage: 'confirmed' }), challenge: null }
  const inspection: ConnectionSetupView = { ...confirmed, applicationInspection: { observations: [read], selected: read, next: null, applicationInfoReadPermission: 'unknown', actions: [] } }
  const configuration: ConnectionSetupView = { ...confirmed, applicationConfiguration: { effect: 'enable-messaging', subject: 'bot-settings', effects: [write], selected: write, next: null, capability: 'unknown', source: null, actions: [] } }
  const readSelector = { ...input, applicationInspection: {} }, writeSelector = { ...input, applicationConfiguration: { effect: 'enable-messaging' as const } }
  for (const decode of decoders) {
    expect(decode('connection.setup.inspect', inspection, readSelector)).toEqual(inspection)
    expect(decode('connection.setup.inspect', configuration, writeSelector)).toEqual(configuration)
    const readRecovery: ConnectionSetupView = { ...inspection, applicationInspection: { ...inspection.applicationInspection!, observations: [], selected: { ...read, secureStorage: 'unknown' }, actions: [{ kind: 'recover-application-inspection', actionId: 'original-read-recover', expectedRevision: 11 }] } }
    const writeRecovery: ConnectionSetupView = { ...configuration, applicationConfiguration: { ...configuration.applicationConfiguration!, effects: [], selected: { ...write, secureStorage: 'unknown' }, actions: [{ kind: 'recover-configuration-effect', actionId: 'original-effect-recover', expectedRevision: 11 }] } }
    expect(decode('connection.setup.inspect', readRecovery, readSelector)).toEqual(readRecovery)
    expect(decode('connection.setup.inspect', writeRecovery, writeSelector)).toEqual(writeRecovery)
    expect(() => decode('connection.setup.inspect', { ...inspection, applicationInspection: { ...inspection.applicationInspection!, applicationInfoReadPermission: 'confirmed' } }, readSelector)).toThrow()
    const readSubject = { ...read, subject: 'bot-settings' as const }
    const readable: ConnectionSetupView = { ...inspection, applicationInspection: { ...inspection.applicationInspection!, observations: [], selected: readSubject } }
    expect(decode('connection.setup.inspect', readable, readSelector)).toEqual(readable)
    expect(() => decode('connection.setup.inspect', { ...readable, applicationInspection: { ...readable.applicationInspection!, readResult: { subject: 'bot-settings' } } }, readSelector)).toThrow()
    expect(decode('connection.setup.inspect', { ...readable, applicationInspection: { ...readable.applicationInspection!, selected: { ...readSubject, request: 'confirmed' }, readResult: { subject: 'bot-settings' } } }, readSelector).applicationInspection?.readResult).toEqual({ subject: 'bot-settings' })
    expect(() => decode('connection.setup.inspect', { ...configuration, applicationConfiguration: { ...configuration.applicationConfiguration!, capability: 'enabled' } }, writeSelector)).toThrow()
    for (const request of ['dispatching', 'refused', 'not-dispatched']) {
      expect(() => decode('connection.setup.inspect', { ...inspection, applicationInspection: { ...inspection.applicationInspection!, observations: [], selected: { ...read, request } } }, readSelector)).toThrow()
      expect(() => decode('connection.setup.inspect', { ...configuration, applicationConfiguration: { ...configuration.applicationConfiguration!, effects: [], selected: { ...write, request } } }, writeSelector)).toThrow()
    }
  }
})


it('authentication diagnostics retain bounded failure locations and keep historical observations readable', () => {
  const original = { stage: 'authentication', code: 'native-unconfirmed', step: 'poll', failure: 'invalid-response', httpStatus: 200 }
  expect(parseConnectionEnrollmentDiagnostic(original)).toEqual(original)
  for (const boundary of ['json', 'transition', 'handoff']) {
    expect(parseConnectionEnrollmentDiagnostic({ ...original, boundary })).toEqual({ ...original, boundary })
  }
  expect(() => parseConnectionEnrollmentDiagnostic({ ...original, boundary: 'https://private.example/token' })).toThrow()
  expect(() => parseConnectionEnrollmentDiagnostic({ stage: 'response', code: 'invalid-response', boundary: 'json' })).toThrow()
})
