import { expect, it } from 'vitest'
import { parseContinuousProgressInputReading, parseContinuousProgressInputReference, projectContinuousProgressInput, type ContinuousProgressInputReference } from '../src/continuous-progress-input.js'
import { parseScheduleRecord, validateScheduleRpcResult } from '../src/public-rpc-schedules.js'
import { parseMotePreferencesReadResult } from '../src/mote/preferences.js'
import type { AgentPromptSubmissionRecord } from '../src/types.js'

const source = { sourceId: 'public-mote-configuration', revision: 'main-A-generation' }
const key = { kind: 'prompt' as const, agentSessionId: 'original-agent', expectedRun: { runId: 'original-run' }, submissionId: 'logical-tick', attemptId: 'physical-attempt' }
const reference = (): ContinuousProgressInputReference => ({ inputKey: structuredClone(key), futureIntent: { intentId: 'original-definition', occurrenceAt: 1200 }, definitionOperationId: 'create-definition', managedSource: { ...source }, preparedAt: 1230 })
function record(): AgentPromptSubmissionRecord {
  const privatePlan = { kind: 'native-rpc' as const, protocolId: 'private-protocol', actorId: 'private-actor', sourceId: 'private-native-source', threadId: 'private-native-session', operation: 'start-or-steer' as const, clientCorrelation: 'private-nonce' }
  return { agentSessionId: key.agentSessionId, run: { ...key.expectedRun },
    admission: { submissionId: key.attemptId, operationId: key.attemptId, inputKey: structuredClone(key), futureIntent: { ...reference().futureIntent }, acknowledged: true,
      intent: { run: { ...key.expectedRun }, ownerInstanceId: 'private-owner', prompt: 'PRIVATE SYSTEM AND USER BODY', plan: privatePlan },
      transport: 'native', native: { plan: privatePlan, outcome: 'admitted', turnId: 'private-native-turn' } },
    nativeSource: { actorId: 'private-actor', nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'private-native-session', transcriptPath: '/private/native.jsonl' } },
    nativeResult: { state: 'completed', run: { ...key.expectedRun }, promptSubmissionId: key.attemptId, sourceId: 'private-native-source', nativeSessionId: 'private-native-session', nativeTurnId: 'private-native-turn', recordId: 'private-native-record', observedAt: 1600, nativeObservedAt: 1500,
      correlation: { kind: 'native-ack', clientCorrelation: 'private-nonce' } } }
}
function loop() {
  return { loopId: 'original-loop', hostId: 'original-host', agentSessionId: key.agentSessionId, providerId: 'codex', workspacePath: '/original/workspace', everyMs: 60000, intervalMs: 60000,
    prompt: 'Original loop private guidance', futureIntentId: 'original-definition', creationOperationId: 'create-definition', revision: 2, status: 'active', nextCheckAt: 60000, managedSource: { ...source }, lastInputRef: reference() }
}
function preferences(maintenance: unknown) {
  return { kind: 'quick', target: { spaceId: 'mote-space', zoneId: 'mote-zone', expectedResource: { hostId: 'original-host', workspaceId: 'workspace', workspacePath: '/original/workspace' } },
    status: 'unconfirmed', source: null, defaults: null, choices: { executors: [], conversations: [], destinations: [] }, main: null, issue: 'Original File observation unavailable', maintenance }
}
function idle(original: AgentPromptSubmissionRecord) {
  original.semanticIdle = { state: 'idle', run: { ...key.expectedRun }, source: 'native-status', sourceId: 'private-native-source', sequence: 7, nativeSessionId: 'private-native-session', nativeTurnId: 'private-native-turn', promptSubmissionId: key.attemptId, recordId: 'private-idle', observedAt: 1700 }
  return original
}
it.each(['completed', 'failed', 'interrupted'] as const)('projects the exact original native %s with only safe timestamps', state => {
  const original = record(); original.nativeResult!.state = state
  expect(projectContinuousProgressInput(reference(), original)).toEqual({ reference: reference(), status: 'confirmed', delivery: 'native-admitted', nativeResult: { state, observedAt: 1600, nativeObservedAt: 1500 } })
})
it('never exposes the private original claim, native locator, correlation or protocol fields', () => {
  const original = idle(record()), before = structuredClone(original), ref = reference()
  expect(() => projectContinuousProgressInput(ref, original)).not.toThrow()
  const result = projectContinuousProgressInput(ref, original), encoded = JSON.stringify(result)
  for (const sentinel of ['PRIVATE', 'private-', '/private/', 'clientCorrelation', 'actorId', 'nativeSessionId', 'nativeTurnId', 'nativeSource', 'recordId', 'protocolId', 'intentSummary', 'promptDigest']) expect(encoded).not.toContain(sentinel)
  expect(result.reference.managedSource).toEqual(source)
  expect(original).toEqual(before)
  ref.inputKey.submissionId = 'changed-after-read'; expect(result.reference.inputKey.submissionId).toBe('logical-tick')
})
it.each(['SID', 'record-Run', 'claim-key', 'physical-attempt', 'future-intent', 'occurrence'] as const)('does not expose or confirm a mismatched %s original record', kind => {
  const original = record()
  if (kind === 'SID') original.agentSessionId = 'another-agent'
  if (kind === 'record-Run') original.run.runId = 'another-run'
  if (kind === 'claim-key') original.admission!.inputKey = { ...key, submissionId: 'another-logical-tick' }
  if (kind === 'physical-attempt') original.admission!.submissionId = 'another-physical-attempt'
  if (kind === 'future-intent') original.admission!.futureIntent!.intentId = 'another-definition'
  if (kind === 'occurrence') original.admission!.futureIntent!.occurrenceAt++
  expect(projectContinuousProgressInput(reference(), original)).toEqual({ reference: reference(), status: 'unconfirmed', delivery: 'unconfirmed', nativeResult: { state: 'unknown' } })
})
it.each(['run', 'submission'] as const)('does not borrow a native result from another %s', kind => {
  const original = record(); if (!original.nativeResult || !('run' in original.nativeResult)) throw Error('Native fixture missing')
  if (kind === 'run') original.nativeResult.run.runId = 'another-run'
  else original.nativeResult.promptSubmissionId = 'another-input'
  expect(projectContinuousProgressInput(reference(), original).nativeResult).toEqual({ state: 'unknown' })
})
it('returned idle is distinct from an exact native result and cannot become completed', () => {
  const original = idle(record()); delete original.nativeResult
  expect(projectContinuousProgressInput(reference(), original)).toMatchObject({ nativeResult: { state: 'unknown' }, returnedIdle: { state: 'returned-idle', observedAt: 1700 } })
  original.semanticIdle!.run.runId = 'another-run'; expect(projectContinuousProgressInput(reference(), original).returnedIdle).toBeUndefined()
  original.semanticIdle!.run.runId = key.expectedRun.runId; original.semanticIdle!.promptSubmissionId = 'another-input'
  expect(projectContinuousProgressInput(reference(), original).returnedIdle).toBeUndefined()
})
it('a PTY byte ACK is terminal confirmation and its uncorrelated result remains unsupported', () => {
  const original = record(), admission = original.admission!
  original.admission = { ...admission, transport: 'pty', startByte: 0, endByte: 40, native: undefined, intent: { ...admission.intent!, plan: { kind: 'single-phase', data: 'Private body\r' } } } as AgentPromptSubmissionRecord['admission']
  original.nativeResult = { state: 'unsupported', reason: 'uncorrelated-carrier' }
  expect(projectContinuousProgressInput(reference(), original)).toMatchObject({ status: 'confirmed', delivery: 'terminal-confirmed', nativeResult: { state: 'unsupported' } })
  original.admission!.acknowledged = false; expect(projectContinuousProgressInput(reference(), original).delivery).toBe('unconfirmed')
})
it('legacy missing data stays unknown and a claimed native input is not an acceptance ACK', () => {
  expect(projectContinuousProgressInput(reference(), null).status).toBe('unconfirmed')
  const original = record(); delete original.nativeResult
  expect(projectContinuousProgressInput(reference(), original).nativeResult).toEqual({ state: 'unknown' })
  delete original.admission!.inputKey; expect(projectContinuousProgressInput(reference(), original).status).toBe('unconfirmed')
  const claimed = record(); claimed.admission!.acknowledged = false
  if (claimed.admission!.transport !== 'native') throw Error('Native fixture missing')
  claimed.admission!.native.outcome = 'claimed'
  expect(projectContinuousProgressInput(reference(), claimed)).toMatchObject({ delivery: 'unconfirmed', nativeResult: { state: 'unknown' } })
})
it('typed whole-input refusal is distinct from an ACK or partially accepted bytes', () => {
  const original = record(); original.admission!.acknowledged = false; original.admission!.notApplied = true
  if (original.admission!.transport !== 'native') throw Error('Native fixture missing')
  original.admission!.native.outcome = 'not-applied'
  expect(projectContinuousProgressInput(reference(), original)).toMatchObject({ delivery: 'not-applied', nativeResult: { state: 'unknown' } })
  const pty = record(), admission = pty.admission!
  pty.admission = { ...admission, acknowledged: false, notApplied: true, transport: 'pty', startByte: 0, endByte: 40, native: undefined,
    chunks: [{ operationId: 'partial-chunk', startByte: 0, endByte: 5, acknowledged: true }], intent: { ...admission.intent!, plan: { kind: 'single-phase', data: 'Private body\r' } } } as unknown as AgentPromptSubmissionRecord['admission']
  delete pty.nativeResult
  expect(projectContinuousProgressInput(reference(), pty).delivery).toBe('unconfirmed')
})
it('the reference accepts only the exact prompt address and original finite times', () => {
  for (const patch of [{ inputKey: { ...key, kind: 'message', messageId: 'message' } }, { inputKey: { ...key, expectedRun: { ...key.expectedRun, processId: 99 } } }, { futureIntent: { intentId: 'id', occurrenceAt: NaN } }, { preparedAt: -1 }, { preparedAt: 1.5 }, { definitionOperationId: '' }, { nonce: 'private' }, { prompt: 'private' }]) expect(() => parseContinuousProgressInputReference({ ...reference(), ...patch })).toThrow()
})
it('the safe reading decoder rejects private fields, synthetic success, and cross-reference data', () => {
  const read = projectContinuousProgressInput(reference(), record())
  for (const value of [{ ...read, fullClaim: record() }, { ...read, nativeResult: { ...read.nativeResult, sourceId: 'private-native' } }, { ...read, reference: { ...read.reference, inputKey: { ...key, control: {} } } },
    { ...read, status: 'unconfirmed' }, { ...read, delivery: 'terminal-confirmed' }, { ...read, nativeResult: { state: 'unknown', observedAt: 1600 } }, { ...read, returnedIdle: { state: 'completed', observedAt: 1700 } }]) expect(() => parseContinuousProgressInputReading(value)).toThrow()
  expect(() => parseContinuousProgressInputReading(read, { ...reference(), preparedAt: 1231 })).toThrow()
  expect(parseContinuousProgressInputReading(read, reference())).toEqual(read)
})
it('the actual schedule and Mote preference codecs consume the same exact safe reading', () => {
  const input = projectContinuousProgressInput(reference(), record()), schedule = loop()
  expect(validateScheduleRpcResult('schedule.inspect', { schedule, input, executionScope: 'connected-host' }, { scheduleId: schedule.loopId }).input).toEqual(input)
  const parsed = parseMotePreferencesReadResult(preferences({ status: 'active', schedule, input, issue: null }))
  expect(parsed.kind === 'quick' && parsed.maintenance?.input).toEqual(input)
})
it('public consumers reject array-coerced status, delivery and native state', () => {
  const original = projectContinuousProgressInput(reference(), record()), schedule = loop()
  for (const input of [{ ...original, status: ['confirmed'] }, { ...original, status: ['unconfirmed'] }, { ...original, delivery: ['native-admitted'] }, { ...original, delivery: ['terminal-confirmed'], nativeResult: { state: 'unknown' } }, { ...original, nativeResult: { ...original.nativeResult, state: ['completed'] } }]) {
    expect(() => parseContinuousProgressInputReading(input)).toThrow()
    expect(() => validateScheduleRpcResult('schedule.inspect', { schedule, input, executionScope: 'connected-host' })).toThrow()
    expect(() => parseMotePreferencesReadResult(preferences({ status: 'active', schedule, input, issue: null }))).toThrow()
  }
})
it('codecs reject an input reading with no saved reference or another target/source/definition', () => {
  const input = projectContinuousProgressInput(reference(), record())
  for (const change of ['missing', 'SID', 'source', 'generation', 'definition'] as const) {
    const schedule = loop()
    if (change === 'missing') delete (schedule as Partial<typeof schedule>).lastInputRef
    if (change === 'SID') schedule.lastInputRef.inputKey.agentSessionId = 'another-agent'
    if (change === 'source') schedule.lastInputRef.managedSource!.sourceId = 'another-mote'
    if (change === 'generation') schedule.lastInputRef.managedSource!.revision = 'another-role'
    if (change === 'definition') schedule.lastInputRef.definitionOperationId = 'another-definition-operation'
    if (change !== 'missing') expect(() => parseScheduleRecord(schedule)).toThrow()
    expect(() => validateScheduleRpcResult('schedule.inspect', { schedule, input, executionScope: 'connected-host' })).toThrow()
    expect(() => parseMotePreferencesReadResult(preferences({ status: 'active', schedule, input, issue: null }))).toThrow()
  }
  expect(() => validateScheduleRpcResult('schedule.inspect', { schedule: null, input, executionScope: 'connected-host' })).toThrow()
})
it('the same loop cannot return a reading from another prepared input', () => {
  const schedule = loop(), input = projectContinuousProgressInput(reference(), record())
  schedule.lastInputRef.inputKey.attemptId = 'new-physical-attempt'
  expect(() => validateScheduleRpcResult('schedule.inspect', { schedule, input, executionScope: 'connected-host' })).toThrow()
  expect(() => parseMotePreferencesReadResult(preferences({ status: 'active', schedule, input, issue: null }))).toThrow()
})
it('a current definition change retains the last prepared original definition reference', () => {
  const schedule = { ...loop(), futureIntentId: 'new-definition', currentDefinition: { intentId: 'new-definition', operationId: 'adopt-new', baseIntentId: 'original-definition', guidanceRevision: 'new-guide' },
    lastTickId: 'later-skipped-check', lastOutcome: 'skipped' }
  expect(() => parseScheduleRecord(schedule)).not.toThrow()
  expect(parseScheduleRecord(schedule).lastInputRef).toEqual(reference())
  expect(validateScheduleRpcResult('schedule.inspect', { schedule, executionScope: 'connected-host' }, { operationId: key.attemptId }).schedule?.lastInputRef).toEqual(reference())
  const wrongPair = structuredClone(schedule); wrongPair.lastInputRef.futureIntent.intentId = 'new-definition'
  expect(() => parseScheduleRecord(wrongPair)).toThrow()
  const legacy = { ...loop() }; delete (legacy as Partial<typeof legacy>).lastInputRef
  expect(parseScheduleRecord(legacy).lastInputRef).toBeUndefined()
  const read = parseMotePreferencesReadResult(preferences({ status: 'active', schedule: legacy, issue: null }))
  expect(read.kind === 'quick' && read.maintenance?.input).toBeUndefined()
})
