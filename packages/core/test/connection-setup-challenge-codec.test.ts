import { expect, it } from 'vitest'
import { parseConnectionEnrollmentDiagnostic, parseConnectionSetupResult as decodePublicResult, type ConnectionSetupOperation, type ConnectionSetupView } from '@agentmux/core/connections'
import { parseConnectionSetupConfigurationReceipt, parseConnectionSetupResult } from '../src/connection-setup-codec.js'
import { parseConnectionEnrollmentDiagnostic as parseSourceDiagnostic } from '../src/connection-enrollment-codec.js'
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

it.each(['waiting', 'scanned'] as const)('source and public decoder keep an exact live %s display source separate from its pending request and ACK', stage => {
  const native: ConnectionSetupView = { ...reply({ ...authentication, stage: 'handoff', request: 'dispatching', secureStorage: 'not-started' }), challengeSource: { attemptId: authentication.attemptId, stepId: 'original-display-source' }, continuation: { stage, account: null, actions: [] } }
  const storing: ConnectionSetupView = { ...reply({ ...authentication, stage, secureStorage: 'storing' }), challengeSource: { attemptId: authentication.attemptId, stepId: authentication.stepId }, continuation: { stage, account: null, actions: [] } }
  for (const decode of decoders) {
    expect(decode('connection.setup.inspect', native, input)).toEqual(native)
    expect(decode('connection.setup.inspect', storing, input)).toEqual(storing)
    for (const value of [
      { ...native, challengeSource: { ...native.challengeSource!, attemptId: 'another-attempt' } },
      { ...native, challengeSource: { ...native.challengeSource!, stepId: authentication.stepId } },
      { ...storing, challengeSource: native.challengeSource },
      { ...native, continuation: { ...native.continuation!, stage: 'expired' } },
      { ...native, continuation: { ...native.continuation!, stage: 'handoff' } },
      { ...native, continuation: { ...native.continuation!, actions: [{ kind: 'continue', expectedRevision: 11, actionId: 'unearned-next-action' }] } },
      { ...native, operation: { ...native.operation!, authentication: { ...native.operation!.authentication!, request: 'unknown' } } },
      { ...storing, operation: { ...storing.operation!, authentication: { ...storing.operation!.authentication!, secureStorage: 'unknown' } } },
      { ...native, challenge: null },
      { ...native, challengeSource: undefined }
    ]) expect(() => decode('connection.setup.inspect', value, input)).toThrow(expect.objectContaining({ code: 'INVALID_CONNECTION_SETUP_DATA' }))
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

it('source and public diagnostic codecs admit only finite redirect reasons on the original authentication failure', () => {
  const original = { stage: 'authentication', code: 'native-unconfirmed', step: 'console', failure: 'redirect-unconfirmed', boundary: 'handoff', httpStatus: 302 }
  const reasons = ['missing-location', 'redirect-limit', 'invalid-url', 'unsupported-scheme', 'url-credentials', 'unexpected-port', 'unexpected-fragment', 'unexpected-host', 'unexpected-redirect', 'unexpected-final-host']
  for (const decode of [parseSourceDiagnostic, parseConnectionEnrollmentDiagnostic]) {
    expect(decode(original)).toEqual(original)
    for (const redirectReason of reasons) expect(decode({ ...original, redirectReason })).toEqual({ ...original, redirectReason })
    for (const redirectReason of ['unknown-reason', 'https://private.example/token', '', null, 1])
      expect(() => decode({ ...original, redirectReason })).toThrow()
    expect(() => decode({ ...original, failure: 'http-status', redirectReason: 'unexpected-host' })).toThrow()
    expect(() => decode({ ...original, failure: undefined, redirectReason: 'unexpected-host' })).toThrow()
    expect(() => decode({ stage: 'response', code: 'http-status', httpStatus: 302, redirectReason: 'unexpected-host' })).toThrow()
    for (const field of ['location', 'url', 'host', 'path', 'query', 'hash', 'token', 'cookie'])
      expect(() => decode({ ...original, redirectReason: 'unexpected-host', [field]: 'private-native-value' })).toThrow()
  }
})

it('publication consumers share owner-declared subjects without vendor entry values or weakened source provenance', () => {
  const draft = { kind: 'create-version', version: '1.0.0', notes: 'Original release', visibility: 'creator-only', desktopEntry: 'chat-entry', mobileEntry: 'chat-entry' } as const
  const selected = { subject: 'publication-versions', stepId: 'original-version-list', input: { ...input, expectedRevision: 11, decision: { actionId: 'setup-read:versions', value: 'continue' } }, request: 'confirmed', secureStorage: 'stored' } as const
  const review = { versions: [], selectedVersion: null, changes: [], audience: null, proposedAudience: { include: { all: false, departments: [], people: ['original-creator'], groups: [] }, exclude: { all: false, departments: [], people: [], groups: [] } }, entries: { desktop: { current: null, choices: ['chat-entry'] }, mobile: { current: null, choices: ['chat-entry'] } }, sharing: null, reasonRequired: null, creatorAudienceAvailable: true, issues: [] }
  const value: ConnectionSetupView = { ...reply({ ...authentication, stage: 'confirmed' }), challenge: null }
  value.operation!.source = { kind: 'enrollment', operationId: 'original-enrollment', expectedRevision: 2 }
  value.operation!.request.kind = 'enrollment-handoff'
  value.applicationConfiguration = { effect: 'create-application-version', subject: 'publication-pending', effects: [], selected: null, next: null, sources: { versions: selected }, requiredSubjects: ['publication-versions'], draft, review, capability: 'disabled', actions: [{ kind: 'create-application-version', expectedRevision: 11, actionId: 'setup-publish-create:original' }] }
  const selector = { ...input, applicationConfiguration: { effect: 'create-application-version' as const, draft } }
  for (const decode of decoders) {
    expect(decode('connection.setup.inspect', value, selector)).toEqual(value)
    for (const requiredSubjects of [[], ['publication-pending'], ['publication-versions', 'bot-settings'], ['publication-versions', 'publication-versions']]) {
      expect(() => decode('connection.setup.inspect', { ...value, applicationConfiguration: { ...value.applicationConfiguration!, requiredSubjects } }, selector)).toThrow()
    }
    const { source, ...unrelated } = value.operation!
    unrelated.request = { state: 'confirmed', attemptId: 'original-init-attempt' }
    expect(() => decode('connection.setup.inspect', { ...value, operation: unrelated }, selector)).toThrow()
    expect(() => decode('connection.setup.inspect', { ...value, applicationConfiguration: { ...value.applicationConfiguration!, sources: { versions: { ...selected, request: 'unknown' } } } }, selector)).toThrow()
    expect(() => decode('connection.setup.inspect', { ...value, applicationConfiguration: { ...value.applicationConfiguration!, sources: {} } }, selector)).toThrow()
    expect(() => decode('connection.setup.inspect', { ...value, applicationConfiguration: { ...value.applicationConfiguration!, review: { ...review, versions: [{ versionId: 'existing-version', version: '1.0.0', status: 'draft' }] } } }, selector)).toThrow()
    expect(() => decode('connection.setup.inspect', { ...value, applicationConfiguration: { ...value.applicationConfiguration!, draft: { ...draft, visibility: 'current' } } }, { ...selector, applicationConfiguration: { effect: 'create-application-version', draft: { ...draft, visibility: 'current' } } })).toThrow()
  }
})

it('complete publication receipts retain their canonical source binding order', () => {
  const receipt = { effect: 'create-application-version', stepId: 'original-create', input: { ...input, expectedRevision: 11, decision: { actionId: 'setup-publish-create:original', value: 'confirm' }, publicationDraft: { kind: 'create-version', version: '1.0.0', notes: 'Original release', visibility: 'current' } }, request: 'confirmed', secureStorage: 'stored', sourceStepIds: { features: 'features-read', sharing: 'sharing-read', visibility: 'visibility-read', versions: 'versions-read', pending: 'pending-read' }, versionId: 'created-version', submission: null }
  const parsed = parseConnectionSetupConfigurationReceipt(receipt)
  expect('sourceStepIds' in parsed && Object.keys(parsed.sourceStepIds)).toEqual(['pending', 'versions', 'visibility', 'sharing', 'features'])
})
