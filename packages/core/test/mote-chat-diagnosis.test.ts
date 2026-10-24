import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AGENTMUX_CLI_COMMANDS } from '../src/agentmux-cli-commands.js'
import { parseConnectionIngressRecord } from '../src/ingress-codec.js'
import { isMoteChatMethod, moteChatDiagnosisCode, moteChatDiagnosisKey, parseMoteChatParams, parseMoteChatResult,
  type MoteChatDiagnosis, type MoteChatDiagnosisInput } from '../src/mote-chat.js'
import { fixturePath } from './helpers/fixture-values.js'

const method = 'space.mote.chat.diagnose' as const
const input: MoteChatDiagnosisInput = { target: { spaceId: 'private-mote', zoneId: 'private-home',
  expectedResource: { hostId: 'original-host', workspaceId: 'private-workspace', workspacePath: fixturePath('private-mote-home') } } }
const stage = { state: 'ready' as const }
const diagnosis = (): MoteChatDiagnosis => ({
  targetKey: moteChatDiagnosisKey(input.target), limit: 5,
  configuration: { revision: 2, enabled: true, connection: { connectionId: 'public-connection', application: { domain: 'platform.example', appId: 'public-app' } } },
  readiness: { state: 'unavailable', code: 'MOTE_CHAT_SOURCE_UNCONFIRMED' },
  service: { enabled: true, revision: 0 }, adapterService: { enabled: true, revision: 1 },
  connection: { enabled: true, revision: 3, authentication: stage, transport: stage, intake: stage, delivery: stage },
  incoming: { rows: [{ key: moteChatDiagnosisKey(input.target, 'private-ingress'), state: 'received',
    code: 'MOTE_CHAT_SOURCE_UNCONFIRMED', codeRecorded: true, preparation: 'creation-dispatched',
    input: { status: null, observation: 'not-started' } }], more: true }, issues: []
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
  value.incoming!.rows[0]!.input = { status: 'terminal-confirmed', observation: 'observed' }
  expect(parseMoteChatResult(method, value, input).incoming!.rows[0]!.input.status).toBe('terminal-confirmed')
  value.incoming!.rows[0]!.preparation = 'other-route'
  value.incoming!.rows[0]!.input = { status: null, observation: 'unavailable' }
  expect(parseMoteChatResult(method, value, input).incoming!.rows[0]!.input).toEqual({ status: null, observation: 'unavailable' })
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
      [{ ...row, input: { status: 'admitted', observation: 'not-started' } }],
      [{ ...row, preparation: 'other-route', input: { status: 'admitted', observation: 'observed' } }],
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
