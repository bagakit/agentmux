import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AGENTMUX_CLI_COMMANDS } from '../src/agentmux-cli-commands.js'
import { parseConnectionIngressRecord } from '../src/ingress-codec.js'
import { isMoteChatMethod, moteChatDiagnosisCode, moteChatDiagnosisKey, parseMoteChatParams, parseMoteChatResult,
  moteChatPreparationReason, moteChatInputFailureCode, moteChatInputFailureCodes, moteChatDiagnosisGenerationKey,
  type MoteChatDiagnosis, type MoteChatDiagnosisInput, type MoteChatDiagnosisIntake } from '../src/mote-chat.js'
import { parseConnectionDiagnosisWaiting } from '../src/connection-diagnosis-codec.js'
import type { AgentInputSubmissionReceipt, AgentInputWaitReason } from '../src/agent-input-wait.js'
import { fixturePath } from './helpers/fixture-values.js'

const method = 'space.mote.chat.diagnose' as const
const input: MoteChatDiagnosisInput = { target: { spaceId: 'private-mote', zoneId: 'private-home',
  expectedResource: { hostId: 'original-host', workspaceId: 'private-workspace', workspacePath: fixturePath('private-mote-home') } } }
const stage = { state: 'ready' as const }
const inputObservation = (overrides: Partial<MoteChatDiagnosisIntake['input']> = {}): MoteChatDiagnosisIntake['input'] => ({
  status: null, observation: 'not-started', controlState: null, receiptObservation: null, waiting: null, preparationReason: null, failureCode: null, runtime: null, ...overrides
})
const diagnosis = (): MoteChatDiagnosis => ({
  targetKey: moteChatDiagnosisKey(input.target), limit: 5,
  configuration: { revision: 2, enabled: true, connection: { connectionId: 'public-connection', application: { domain: 'platform.example', appId: 'public-app' } } },
  readiness: { state: 'unavailable', code: 'MOTE_CHAT_SOURCE_UNCONFIRMED' },
  service: { enabled: true, revision: 0 }, adapterService: { enabled: true, revision: 1 },
  connection: { enabled: true, revision: 3, authentication: stage, transport: stage, intake: stage, delivery: stage },
  incoming: { rows: [{ key: moteChatDiagnosisKey(input.target, 'private-ingress'), state: 'received',
    code: 'MOTE_CHAT_SOURCE_UNCONFIRMED', codeRecorded: true, preparation: 'creation-dispatched',
    input: inputObservation() }], more: true }, publications: [], issues: []
})

it('accepts only the complete exact target and hashes its canonical identity without exposing it', () => {
  expect(isMoteChatMethod(method)).toBe(true)
  expect(parseMoteChatParams(method, input)).toEqual(input)
  const reordered = { expectedResource: { workspacePath: input.target.expectedResource.workspacePath,
    workspaceId: 'private-workspace', hostId: 'original-host' }, zoneId: 'private-home', spaceId: 'private-mote' }
  expect(moteChatDiagnosisKey(reordered)).toBe(moteChatDiagnosisKey(input.target))
  expect(moteChatDiagnosisKey(input.target, 'private-ingress')).not.toBe(moteChatDiagnosisKey(input.target))
  expect(moteChatDiagnosisKey(input.target, 'other-ingress')).not.toBe(moteChatDiagnosisKey(input.target, 'private-ingress'))
  expect(moteChatDiagnosisKey({ ...input.target, zoneId: 'another-home' })).not.toBe(moteChatDiagnosisKey(input.target))
  for (const extra of [{ limit: 100 }, { actor: {} }, { cursor: 'private-ingress' }, { operationId: 'retry' }])
    expect(() => parseMoteChatParams(method, { ...input, ...extra })).toThrow(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
  expect(() => parseMoteChatParams(method, { target: { spaceId: 'private-mote' } })).toThrow()
})

it('keeps readiness, original preparation and Core receipt observations separate in a redacted result', () => {
  const value = diagnosis()
  expect(parseMoteChatResult(method, value, input)).toEqual(value)
  const encoded = JSON.stringify(parseMoteChatResult(method, value, input))
  for (const privateValue of ['private-mote', 'private-home', 'private-workspace', 'private-ingress', input.target.expectedResource.workspacePath])
    expect(encoded).not.toContain(privateValue)
  value.incoming!.rows[0]!.input = inputObservation({ status: 'terminal-confirmed', observation: 'observed', controlState: 'dispatch-authorized', receiptObservation: 'closed' })
  expect(parseMoteChatResult(method, value, input).incoming!.rows[0]!.input.status).toBe('terminal-confirmed')
  value.incoming!.rows[0]!.preparation = 'other-route'
  value.incoming!.rows[0]!.input = inputObservation({ observation: 'unavailable' })
  expect(parseMoteChatResult(method, value, input).incoming!.rows[0]!.input).toEqual(inputObservation({ observation: 'unavailable' }))
  value.incoming = { rows: [], more: false }
  expect(parseMoteChatResult(method, value, input).incoming).toEqual({ rows: [], more: false })
  value.incoming = null; value.issues = ['intake-unavailable']
  expect(parseMoteChatResult(method, value, input).incoming).toBeNull()
})

it('rejects private fields, foreign targets, arbitrary causes and inconsistent or unbounded observations', () => {
  const v = diagnosis(), row = v.incoming!.rows[0]!
  const malformed: unknown[] = [
    { ...v, target: input.target },
    { ...v, targetKey: moteChatDiagnosisKey({ ...input.target, zoneId: 'foreign-home' }) },
    { ...v, configuration: { ...v.configuration, creator: 'private-person' } },
    { ...v, configuration: { ...v.configuration, strangerMessageLimit: 12 } },
    { ...v, connection: { ...v.connection, authentication: { state: 'unavailable', reason: 'raw native error' } } },
    { ...v, readiness: { state: 'ready', code: 'MOTE_CHAT_SOURCE_UNCONFIRMED' } },
    { ...v, issues: ['configuration-unavailable', 'configuration-unavailable'] }, { ...v, limit: 6 },
    ...[
      [{ ...row, agentSessionId: 'private-session' }], [{ ...row, input: { ...row.input, body: 'private-message' } }],
      [{ ...row, code: 'PRIVATE_EXCEPTION_CODE' }], [{ ...row, codeRecorded: false }],
      [{ ...row, input: inputObservation({ status: 'admitted' }) }],
      [{ ...row, preparation: 'other-route', input: inputObservation({ status: 'admitted', observation: 'observed' }) }],
      Array(6).fill(row), [row, structuredClone(row)], Array(1)
    ].map(rows => ({ ...v, incoming: { rows, more: false } })), { ...v, incoming: { rows: [] } }
  ]
  for (const value of malformed)
    expect(() => parseMoteChatResult(method, value, input)).toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  expect(moteChatDiagnosisCode('MOTE_CHAT_EXECUTOR_UNAVAILABLE')).toBe('MOTE_CHAT_EXECUTOR_UNAVAILABLE')
  expect(moteChatDiagnosisCode('INGRESS_ACTOR_NOT_AUTHORIZED')).toBe('INGRESS_ACTOR_NOT_AUTHORIZED')
  expect(moteChatDiagnosisCode('INGRESS_PREPARATION_UNAVAILABLE')).toBe('INGRESS_PREPARATION_UNAVAILABLE')
  expect(moteChatDiagnosisCode('PRIVATE_EXCEPTION_CODE')).toBeNull()
  expect(moteChatDiagnosisCode({ code: 'MOTE_CHAT_EXECUTOR_UNAVAILABLE', message: 'private error' })).toBeNull()
})

it('keeps generation publication windows bounded, redacted and separate from terminal receipt and runtime', () => {
  const report = diagnosis(), row = report.incoming!.rows[0]!
  row.preparation = 'ready'
  for (const status of ['terminal-confirmed', 'admitted'] as const) {
    row.input = inputObservation({ status, observation: 'observed', controlState: 'dispatch-authorized', receiptObservation: 'closed', runtime: { target: 'original', state: 'running', exitCode: null } })
    expect(parseMoteChatResult(method, report, input).incoming!.rows[0]!.input).toEqual(row.input)
  }
  const generationKey = moteChatDiagnosisGenerationKey(input.target, 'private-generation')
  expect(generationKey).not.toBe(moteChatDiagnosisKey(input.target, 'private-generation'))
  const publication = { generationKey, preparedProviderId: 'claude', intakeKeys: [row.key], reading: 'observed' as const,
    observation: { state: 'ready' as const }, sourceObservation: { state: 'ready' as const, code: null, codeRecorded: false, checkpointKey: 'a'.repeat(64) },
    effectObservation: { state: 'unknown' as const, reason: 'effect-unconfirmed' as const }, coverage: { state: 'complete' as const, gaps: [], more: false, originCount: 0 },
    effects: [{ kind: 'conversation' as const, effect: 'upsert' as const, state: 'unknown' as const, receipt: { state: 'unknown' as const, reason: 'platform-unavailable' as const }, resourceUpload: null }], more: false }
  report.publications = [publication]
  expect(parseMoteChatResult(method, report, input)).toEqual(report)
  for (const preparedProviderId of [null, 'custom-provider', 'x'.repeat(300), '😀'.repeat(1024)]) {
    expect(parseMoteChatResult(method, { ...report, publications: [{ ...publication, preparedProviderId }] }, input)
      .publications[0]!.preparedProviderId).toBe(preparedProviderId)
  }
  for (const fields of [
    ...[undefined, '', 'x'.repeat(4097), '😀'.repeat(1025), 'private\nvalue', 1, {}].map(preparedProviderId => ({ preparedProviderId })),
    { generationKey: 'private-generation' }, { intakeKeys: ['f'.repeat(64)] }, { intakeKeys: [row.key, row.key] },
    { reading: 'unavailable' }, { bindingId: 'private-binding' }, { sourceObservation: { ...publication.sourceObservation, nativeSessionId: 'private-native' } },
    { sourceObservation: { ...publication.sourceObservation, code: 'RAW_EXCEPTION' } },
    { effects: [{ ...publication.effects[0], operationId: 'private-operation' }] },
    { effects: [{ ...publication.effects[0], receipt: { state: 'confirmed', reason: null, mapping: { messageId: 'private-platform-message' } } }] },
    { effects: [{ ...publication.effects[0], receipt: { state: 'unknown', reason: null } }] }, { effects: Array(6).fill(publication.effects[0]) },
    { coverage: { ...publication.coverage, gaps: [{ reason: 'source-gap', code: null, codeRecorded: true, record: 'private-record' }] } }
  ]) expect(() => parseMoteChatResult(method, { ...report, publications: [{ ...publication, ...fields }] }, input)).toThrow()
  expect(() => parseMoteChatResult(method, { ...report, publications: [publication, publication] }, input)).toThrow()
  expect(() => parseMoteChatResult(method, { ...report, incoming: null }, input)).toThrow()
  row.preparation = 'other-route'; row.input = inputObservation({ observation: 'unavailable' })
  expect(() => parseMoteChatResult(method, report, input)).toThrow()
})

it('reuses exact safe waiting combinations while separating receipt ownership from inspection availability', () => {
  const report = diagnosis(), row = report.incoming!.rows[0]!
  row.input = inputObservation({ status: 'waiting', observation: 'observed', controlState: 'enabled', receiptObservation: 'rejoin-needed' })
  expect(parseMoteChatResult(method, report, input).incoming!.rows[0]!.input.waiting).toBeNull()
  const tuples: Array<NonNullable<MoteChatDiagnosisIntake['input']['waiting']>> = [
    { phase: 'runtime', reason: 'runtime-unavailable', wake: 'runtime-restored' },
    { phase: 'authorization', reason: 'author-authorization-needed', wake: 'explicit-rejoin' },
    { phase: 'observer', reason: 'observer-stopped', wake: 'explicit-rejoin' },
    { phase: 'native-environment', reason: 'original-environment-unconfirmed', wake: 'explicit-rejoin' },
    { phase: 'input-environment', reason: 'original-input-unconfirmed', wake: 'explicit-rejoin' },
    { phase: 'input-environment', reason: 'original-target-changed', wake: 'explicit-rejoin' },
    { phase: 'service', reason: 'observation-failed', wake: 'explicit-rejoin' }
  ]
  for (const waiting of tuples) {
    row.input.waiting = waiting
    expect(parseConnectionDiagnosisWaiting(waiting)).toEqual(waiting)
    expect(parseMoteChatResult(method, report, input).incoming!.rows[0]!.input.waiting).toEqual(waiting)
  }
  const original = structuredClone(row.input), malformed: unknown[] = [
    { ...original, waiting: { phase: 'runtime', reason: 'original-input-unconfirmed', wake: 'runtime-restored' } },
    { ...original, waiting: { phase: 'runtime', reason: 'runtime-unavailable', wake: 'explicit-rejoin' } },
    { ...original, waiting: { ...original.waiting, failure: { message: 'private body' } } },
    { ...original, waiting: { ...original.waiting, ref: { key: 'private input' } } },
    { ...original, controlState: 'working' }, { ...original, receiptObservation: 'observed' },
    { ...original, controlState: 'dispatch-authorized', receiptObservation: 'owned' },
    { ...original, receiptObservation: 'closed' },
    { ...original, status: 'stopped', controlState: 'enabled', receiptObservation: 'closed' },
    { ...original, status: 'admitted', controlState: 'stopped-before-dispatch', receiptObservation: 'closed' },
    { ...original, status: 'unknown', receiptObservation: 'owned' },
    { ...original, controlState: null }, { ...original, status: null },
    { ...original, waiting: null, preparationReason: 'native-busy' },
    { ...original, waiting: null, failureCode: 'AGENT_INTERACTION_PENDING' },
    { ...original, failureCode: 'PRIVATE_EXCEPTION_CODE' },
    { ...original, failureCode: { code: 'AGENT_INTERACTION_PENDING' } },
    { ...original, preparationReason: 'native-busy', failureCode: 'AGENT_INTERACTION_PENDING' },
    { ...original, preparationReason: 'private-code' }, { ...original, gateId: 'private gate' },
    { ...original, runtime: { target: 'original', state: 'running', exitCode: 1 } },
    { ...original, runtime: { target: 'original', state: 'exited', exitCode: 0, runId: 'private-run' } },
    { ...original, runtime: { target: 'guessed', state: 'exited', exitCode: null } },
    { ...original, runtime: { target: 'original', state: 'dead', exitCode: null } }
  ]
  for (const value of malformed) {
    const bad = { ...report, incoming: { rows: [{ ...row, input: value }], more: false } }
    expect(() => parseMoteChatResult(method, bad, input)).toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  }
})

it('publishes only explicitly enumerated original wait failure codes, never messages or nested errors', () => {
  const key = { kind: 'message' as const, agentSessionId: 'private-session', expectedRun: { runId: 'private-run' }, messageId: 'private-input' }
  const receipt: AgentInputSubmissionReceipt = { key, ref: { key, waitGeneration: 1 }, persistence: 'confirmed',
    control: { ref: { key, waitGeneration: 1 }, state: 'enabled', at: 1 }, admission: null, status: 'waiting', observation: 'rejoin-needed' }
  const failure = (code: string) => ({ name: 'AgentMuxError', code, message: 'Private message AGENT_INTERACTION_PENDING',
    detail: '{"code":"AGENT_INTERACTION_PENDING"}', stack: 'Private stack' })
  const report = diagnosis(), row = report.incoming!.rows[0]!
  row.input = inputObservation({ status: 'waiting', observation: 'observed', controlState: 'enabled', receiptObservation: 'rejoin-needed',
    waiting: { phase: 'input-environment', reason: 'original-input-unconfirmed', wake: 'explicit-rejoin' } })
  for (const code of moteChatInputFailureCodes) {
    receipt.control.waiting = { phase: 'input-environment', reason: 'original-input-unconfirmed', wake: 'explicit-rejoin', failure: failure(code) }
    expect(moteChatInputFailureCode(receipt)).toBe(code)
    row.input.failureCode = code
    expect(parseMoteChatResult(method, report, input).incoming!.rows[0]!.input.failureCode).toBe(code)
  }
  receipt.control.waiting = { phase: 'native-environment', reason: 'original-environment-unconfirmed', wake: 'explicit-rejoin',
    observation: { phase: 'original-observation', failure: failure('AGENT_INTERACTION_PENDING') } }
  expect(moteChatInputFailureCode(receipt)).toBe('AGENT_INTERACTION_PENDING')
  for (const code of ['PRIVATE_EXCEPTION_CODE', 'AGENT_PROMPT_PREPARATION_FAILED', 'AGENT_INTERACTION_PENDING private-id', '']) {
    receipt.control.waiting = { phase: 'input-environment', reason: 'original-input-unconfirmed', wake: 'explicit-rejoin', failure: failure(code) }
    expect(moteChatInputFailureCode(receipt)).toBeNull()
  }
  receipt.control.waiting = { phase: 'runtime', reason: 'runtime-unavailable', wake: 'runtime-restored' }
  expect(moteChatInputFailureCode(receipt)).toBeNull()
  delete receipt.control.waiting
  expect(moteChatInputFailureCode(receipt)).toBeNull()
  const missing = { ...row.input } as Record<string, unknown>; delete missing.failureCode
  expect(() => parseMoteChatResult(method, { ...report, incoming: { rows: [{ ...row, input: missing }], more: false } }, input)).toThrow()
})

it('exports only an existing preparation reason after matching the original input key, never its private fence or retry permission', () => {
  for (const kind of ['prompt', 'message'] as const) {
    const key = { kind, agentSessionId: 'private-session', expectedRun: { runId: 'private-run' },
      ...(kind === 'prompt' ? { submissionId: 'private-operation' } : { messageId: 'private-operation' }) } as AgentInputSubmissionReceipt['key']
    const wait = { reason: 'context-compaction', retrySafe: true, agentSessionId: key.agentSessionId, runId: key.expectedRun.runId,
      operationId: 'private-operation', nativeSourceId: 'private-native-source', inputByte: 12 }
    const receipt: AgentInputSubmissionReceipt = { key, ref: { key, waitGeneration: 1 }, persistence: 'confirmed',
      control: { ref: { key, waitGeneration: 1 }, state: 'enabled', at: 1 }, admission: null, status: 'waiting', observation: 'rejoin-needed' }
    const waiting = (value: unknown): AgentInputWaitReason => ({ phase: 'input-environment', reason: 'original-input-unconfirmed', wake: 'explicit-rejoin',
      failure: { name: 'AgentMuxError', message: 'private body', code: 'AGENT_PROMPT_PREPARATION_FAILED', detail: JSON.stringify({ detail: JSON.stringify({ preparationWait: value }) }) } })
    for (const reason of ['context-compaction', 'native-busy'] as const) {
      receipt.control.waiting = waiting({ ...wait, reason })
      expect(moteChatPreparationReason(receipt)).toBe(reason)
    }
    for (const field of ['agentSessionId', 'runId', 'operationId']) {
      receipt.control.waiting = waiting({ ...wait, [field]: 'foreign-original' })
      expect(moteChatPreparationReason(receipt)).toBeNull()
    }
    receipt.control.waiting = waiting({ ...wait, reason: 'guessed-from-text' })
    expect(moteChatPreparationReason(receipt)).toBeNull()
    delete receipt.control.waiting
    expect(moteChatPreparationReason(receipt)).toBeNull()
  }
})

it('exposes the same exact-target parser through original CLI discovery without a write or retry option', async () => {
  const command = AGENTMUX_CLI_COMMANDS.find(entry => entry.method === method)
  expect(command).toBeDefined()
  expect(command!.flags).toEqual({ '--input': 'data' })
  expect(command!.details).toContain('never private content, people, quotas or Session references')
  const directory = await mkdtemp(fixturePath('tmp/amx-mote-diagnosis-'))
  try {
    const path = join(directory, 'input.json')
    await writeFile(path, JSON.stringify(input))
    expect(await command!.parse(['--input', path])).toEqual(input)
    await expect(command!.parse(['--input', path, '--retry'])).rejects.toMatchObject({ code: 'INVALID_CLI_ARGUMENT' })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('retains a received message preparation code without admitting input or changing action and claimed records', () => {
  const application = { domain: 'platform.example', appId: 'original-app' }
  const actor = { application, idType: 'open_id', userId: 'original-person' }
  const received = { ingressId: 'original-ingress', connectionId: 'original-connection', application,
    eventId: 'original-event', externalMessageId: 'original-message', externalConversationId: 'original-direct',
    conversationKind: 'direct', actor, body: 'Original private input', state: 'received' }
  const code = 'MOTE_CHAT_EXECUTOR_UNAVAILABLE'
  expect(parseConnectionIngressRecord({ ...received, code })).toEqual({ ...received, code })
  expect(parseConnectionIngressRecord(received)).toEqual(received)
  expect(() => parseConnectionIngressRecord({ ...received, code, input: {} })).toThrow()
  const claimed = { ...received, state: 'claimed', input: { hostId: 'original-host', agentSessionId: 'original-session',
    expectedRun: { runId: 'original-run' }, operationId: 'original-input-operation', messageId: 'original-mailbox-message',
    author: { kind: 'external', connectionId: received.connectionId, actor, externalMessageId: received.externalMessageId,
      externalConversationId: received.externalConversationId, bindingId: 'original-binding', bindingRevision: 1,
      grantId: 'original-grant', grantRevision: 1 } } }
  expect(parseConnectionIngressRecord(claimed)).toEqual(claimed)
  expect(() => parseConnectionIngressRecord({ ...claimed, code })).toThrow()
  const action = { kind: 'action', ingressId: 'original-action-ingress', connectionId: received.connectionId, application,
    eventId: 'original-action-event', actor, externalConversationId: received.externalConversationId,
    sourceMessageId: 'original-card', actionRef: 'original-action', state: 'received' }
  expect(parseConnectionIngressRecord(action)).toEqual(action)
  expect(() => parseConnectionIngressRecord({ ...action, code })).toThrow()
})
