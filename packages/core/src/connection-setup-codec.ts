import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { CONNECTION_SETUP_READ_ACTIONS, type ConnectionSetupReadSubject, type ConnectionSetupReadSummary } from './connection-setup-contract.js'
import type { ConnectionSetupBegin, ConnectionSetupChallenge, ConnectionSetupInspectionReceipt, ConnectionSetupMethod, ConnectionSetupOperation, ConnectionSetupParamsMap, ConnectionSetupResultMap, ConnectionSetupView } from './connection-setup-contract.js'

export const CONNECTION_SETUP_RPC_METHODS = { 'connection.setup.begin': 'long', 'connection.setup.advance': 'long', 'connection.setup.inspect': 'long', 'connection.setup.ls': 'long' } as const
export const isConnectionSetupMethod = (value: unknown): value is ConnectionSetupMethod => typeof value === 'string' && Object.hasOwn(CONNECTION_SETUP_RPC_METHODS, value)
const fail = (): never => { throw new AgentMuxError('Setup data does not describe the exact original management intent.', 'INVALID_CONNECTION_SETUP_DATA') }
function object(value: unknown, fields: readonly string[]) { const p = rpcRecord(value); if (Object.keys(p).some(k => !fields.includes(k))) fail(); return p }
function text(value: unknown): string { if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) fail(); return value as string }
function id(value: unknown): string { const v = text(value); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(v)) fail(); return v }
function integer(value: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): number { if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail(); return value as number }
function choice<T extends string>(value: unknown, values: readonly T[]): T { if (!values.includes(value as T)) fail(); return value as T }
const stage = (value: unknown) => choice(value, ['waiting', 'scanned', 'handoff', 'account', 'confirmed', 'expired', 'unknown'] as const)
const requestState = (value: unknown) => choice(value, ['dispatching', 'confirmed', 'unknown'] as const)
export function parseConnectionSetupAccount(value: unknown) {
  const p = object(value, ['userId', 'tenantId', 'userName', 'tenantName'])
  return { userId: text(p.userId), tenantId: text(p.tenantId), ...(p.userName === undefined ? {} : { userName: text(p.userName) }), ...(p.tenantName === undefined ? {} : { tenantName: text(p.tenantName) }) }
}
export function parseConnectionSetupAuthentication(value: unknown): NonNullable<ConnectionSetupOperation['authentication']> {
  const a = object(value, ['attemptId', 'stepId', 'stage', 'request', 'secureStorage'])
  const result = { attemptId: id(a.attemptId), stepId: id(a.stepId), stage: stage(a.stage), request: requestState(a.request), secureStorage: choice(a.secureStorage, ['not-started', 'storing', 'stored', 'unknown'] as const) }
  if (result.secureStorage === 'stored' && result.request !== 'confirmed') fail()
  return result
}
function begin(value: unknown): ConnectionSetupBegin {
  const p = object(value, ['operationId', 'connectionId', 'expectedConnectionRevision', 'goal']), g = object(p.goal, ['kind', 'interaction'])
  return { operationId: id(p.operationId), connectionId: id(p.connectionId), expectedConnectionRevision: integer(p.expectedConnectionRevision), goal: { kind: choice(g.kind, ['agent-conversation']), interaction: choice(g.interaction, ['messages', 'cards']) } }
}
export function parseConnectionSetupChallenge(value: unknown): ConnectionSetupChallenge {
  const p = object(value, ['qrPayload', 'expiresAt', 'nextPollAt'])
  return { qrPayload: text(p.qrPayload), expiresAt: p.expiresAt === null ? null : integer(p.expiresAt, 0), nextPollAt: integer(p.nextPollAt, 0) }
}
export function parseConnectionSetupOperation(value: unknown): ConnectionSetupOperation {
  const p = object(value, ['operationId', 'connectionId', 'expectedConnectionRevision', 'goal', 'revision', 'adapterId', 'application', 'request', 'secureStorage', 'reason', 'authentication'])
  const input = begin(Object.fromEntries(['operationId', 'connectionId', 'expectedConnectionRevision', 'goal'].map(k => [k, p[k]])))
  const a = object(p.application, ['domain', 'appId']), r = object(p.request, ['state', 'attemptId']), domain = text(a.domain)
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(domain)) fail()
  const result: ConnectionSetupOperation = { ...input, revision: integer(p.revision), adapterId: id(p.adapterId), application: { domain, appId: id(a.appId) }, request: { state: choice(r.state, ['not-dispatched', 'dispatching', 'confirmed', 'unknown', 'refused']), attemptId: r.attemptId === null ? null : id(r.attemptId) }, secureStorage: choice(p.secureStorage, ['not-started', 'storing', 'stored', 'unknown']), ...(p.reason === undefined ? {} : { reason: choice(p.reason, ['adapter-unavailable', 'secure-storage-unavailable', 'request-unconfirmed', 'challenge-unconfirmed']) }) }
  if (result.request.state === 'not-dispatched' && result.request.attemptId !== null || result.request.state !== 'not-dispatched' && result.request.attemptId === null || result.secureStorage === 'stored' && result.request.state !== 'confirmed') fail()
  if (p.authentication !== undefined) {
    result.authentication = parseConnectionSetupAuthentication(p.authentication)
  }
  return result
}
export function parseConnectionSetupParams<M extends ConnectionSetupMethod>(method: M, value: unknown): ConnectionSetupParamsMap[M] {
  if (method === 'connection.setup.begin') return begin(value) as ConnectionSetupParamsMap[M]
  if (method === 'connection.setup.advance') {
    const p = object(value, ['operationId', 'expectedRevision', 'decision']), d = object(p.decision, ['actionId', 'value'])
    return { operationId: id(p.operationId), expectedRevision: integer(p.expectedRevision), decision: { actionId: id(d.actionId), value: choice(d.value, ['continue', 'confirm', 'renew']) } } as ConnectionSetupParamsMap[M]
  }
  if (method === 'connection.setup.ls') { const p = object(value, ['connectionId', 'cursor', 'limit']); return { connectionId: id(p.connectionId), ...(p.cursor === undefined ? {} : { cursor: text(p.cursor) }), ...(p.limit === undefined ? {} : { limit: integer(p.limit, 1, 100) }) } as ConnectionSetupParamsMap[M] }
  const p = object(value, ['operationId', 'applicationInspection'])
  const result: ConnectionSetupParamsMap['connection.setup.inspect'] = { operationId: id(p.operationId) }
  if (p.applicationInspection !== undefined) {
    const s = object(p.applicationInspection, ['selectedStepId', 'cursor', 'limit'])
    result.applicationInspection = { ...(s.selectedStepId === undefined ? {} : { selectedStepId: id(s.selectedStepId) }), ...(s.cursor === undefined ? {} : { cursor: text(s.cursor) }), ...(s.limit === undefined ? {} : { limit: integer(s.limit, 1, 100) }) }
  }
  return result as ConnectionSetupParamsMap[M]
}
const readSubjects = Object.keys(CONNECTION_SETUP_READ_ACTIONS) as ConnectionSetupReadSubject[]
export function parseConnectionSetupReadSummary(value: unknown): ConnectionSetupReadSummary {
  const raw = rpcRecord(value), subject = choice(raw.subject, readSubjects)
  if (subject === 'application-details') {
    const p = object(value, ['subject', 'name', 'description'])
    const display = (v: unknown, max: number): string | null => {
      if (v === null) return null
      if (typeof v !== 'string' || v.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v)) fail()
      return v as string
    }
    return { subject, name: display(p.name, 512), description: display(p.description, 4096) }
  }
  if (subject === 'event-settings') {
    const p = object(value, ['subject', 'transport'])
    return { subject, transport: choice(p.transport, ['persistent-connection', 'webhook', 'function', 'unknown']) }
  }
  object(value, ['subject'])
  return { subject }
}
export function parseConnectionSetupInspectionReceipt(value: unknown): ConnectionSetupInspectionReceipt {
  const p = object(value, ['stepId', 'input', 'request', 'secureStorage', 'subject'])
  const result: ConnectionSetupInspectionReceipt = { stepId: id(p.stepId), input: parseConnectionSetupParams('connection.setup.advance', p.input), request: requestState(p.request), secureStorage: choice(p.secureStorage, ['not-started', 'storing', 'stored', 'unknown']) }
  if (p.subject !== undefined) result.subject = choice(p.subject, readSubjects)
  if (result.input.decision.value !== 'continue' || result.secureStorage === 'stored' && result.request !== 'confirmed') fail()
  return result
}
export function parseConnectionSetupResult<M extends ConnectionSetupMethod>(method: M, value: unknown, input: ConnectionSetupParamsMap[M]): ConnectionSetupResultMap[M] {
  if (method === 'connection.setup.ls') {
    const p = object(value, ['operations', 'next', 'support']), i = input as ConnectionSetupParamsMap['connection.setup.ls']
    if (!Array.isArray(p.operations) || p.operations.length > (i.limit ?? 25)) fail()
    const operations = (p.operations as unknown[]).map(parseConnectionSetupOperation)
    if (operations.some(o => o.connectionId !== i.connectionId) || new Set(operations.map(o => o.operationId)).size !== operations.length) fail()
    let support: ConnectionSetupResultMap['connection.setup.ls']['support'] = null
    if (p.support !== null) {
      const s = object(p.support, ['connectionRevision', 'capabilities'])
      if (!Array.isArray(s.capabilities) || s.capabilities.length > 2) fail()
      const capabilities = (s.capabilities as unknown[]).map(value => choice(value, ['management-authentication', 'application-inspection'] as const))
      if (new Set(capabilities).size !== capabilities.length) fail()
      support = { connectionRevision: integer(s.connectionRevision), capabilities }
    }
    return { operations, next: p.next === null ? null : text(p.next), support } as ConnectionSetupResultMap[M]
  }
  const p = object(value, ['operation', 'challenge', 'reason', 'continuation', 'receipt', 'applicationInspection']), operation = p.operation === null ? null : parseConnectionSetupOperation(p.operation), challenge = p.challenge === null ? null : parseConnectionSetupChallenge(p.challenge)
  if (operation && operation.operationId !== (input as { operationId: string }).operationId || !operation && (method === 'connection.setup.begin' || challenge !== null)) fail()
  if (method === 'connection.setup.begin' && operation) {
    // Select the admitted fields explicitly: summaries also contain safe result fields.
    const admitted = begin(Object.fromEntries(['operationId', 'connectionId', 'expectedConnectionRevision', 'goal'].map(k => [k, operation[k as keyof ConnectionSetupOperation]])))
    if (JSON.stringify(admitted) !== JSON.stringify(input)) fail()
  }
  const challengeRequest = operation?.authentication?.request ?? operation?.request.state
  const challengeStorage = operation?.authentication?.secureStorage ?? operation?.secureStorage
  if (challenge && (challengeRequest !== 'confirmed' || challengeStorage !== 'stored')) fail()
  const result: ConnectionSetupView = { operation, challenge, ...(p.reason === undefined ? {} : { reason: choice(p.reason, ['connection-revised', 'challenge-unavailable']) }) }
  if (method === 'connection.setup.inspect' && operation && (input as ConnectionSetupParamsMap['connection.setup.inspect']).applicationInspection && p.applicationInspection === undefined) fail()
  if (p.continuation !== undefined) {
    if (!operation || result.reason === 'connection-revised') fail()
    const c = object(p.continuation, ['stage', 'account', 'actions'])
    if (!Array.isArray(c.actions) || c.actions.length > 2) fail()
    const actions = (c.actions as unknown[]).map(value => { const a = object(value, ['actionId', 'expectedRevision', 'kind']); return { actionId: id(a.actionId), expectedRevision: integer(a.expectedRevision), kind: choice(a.kind, ['continue', 'confirm-account', 'renew'] as const) } })
    if (new Set(actions.map(a => a.actionId)).size !== actions.length || new Set(actions.map(a => a.kind)).size !== actions.length) fail()
    result.continuation = { stage: stage(c.stage), account: c.account === null ? null : parseConnectionSetupAccount(c.account), actions }
    if (result.continuation.account && !['account', 'confirmed'].includes(result.continuation.stage) || ['account', 'confirmed'].includes(result.continuation.stage) && !result.continuation.account) fail()
  }
  if (p.receipt !== undefined) {
    if (method !== 'connection.setup.advance' || !operation) fail()
    const r = object(p.receipt, ['actionId', 'stepId', 'state'])
    result.receipt = { actionId: id(r.actionId), stepId: id(r.stepId), state: requestState(r.state) }
    if (result.receipt.actionId !== (input as ConnectionSetupParamsMap['connection.setup.advance']).decision.actionId) fail()
  }
  if (p.applicationInspection !== undefined) {
    if (!operation || method === 'connection.setup.begin' || method === 'connection.setup.inspect' && !(input as ConnectionSetupParamsMap['connection.setup.inspect']).applicationInspection) fail()
    const s = object(p.applicationInspection, ['observations', 'next', 'selected', 'applicationInfoReadPermission', 'readResult', 'actions'])
    const limit = method === 'connection.setup.inspect' ? (input as ConnectionSetupParamsMap['connection.setup.inspect']).applicationInspection?.limit ?? 25 : 25
    if (!Array.isArray(s.observations) || s.observations.length > limit || !Array.isArray(s.actions) || s.actions.length > 6) fail()
    const observations = (s.observations as unknown[]).map(parseConnectionSetupInspectionReceipt), selected = s.selected === null ? null : parseConnectionSetupInspectionReceipt(s.selected)
    if (new Set(observations.map(o => o.stepId)).size !== observations.length || new Set(observations.map(o => o.input.decision.actionId)).size !== observations.length) fail()
    if ([...observations, ...(selected ? [selected] : [])].some(o => o.input.operationId !== operation!.operationId)) fail()
    const selector = method === 'connection.setup.inspect' ? (input as ConnectionSetupParamsMap['connection.setup.inspect']).applicationInspection : undefined
    if (selector?.selectedStepId && selected && selector.selectedStepId !== selected.stepId) fail()
    if (method === 'connection.setup.advance' && (!result.receipt || !selected || selected.stepId !== result.receipt.stepId)) fail()
    const copy = selected && observations.find(o => o.stepId === selected.stepId)
    if (copy && JSON.stringify(copy) !== JSON.stringify(selected)) fail()
    const actions = (s.actions as unknown[]).map(value => { const a = object(value, ['actionId', 'expectedRevision', 'kind']); return { actionId: id(a.actionId), expectedRevision: integer(a.expectedRevision), kind: choice(a.kind, ['inspect-application', 'recover-application-inspection', ...Object.values(CONNECTION_SETUP_READ_ACTIONS)] as const) } })
    if (new Set(actions.map(a => a.actionId)).size !== actions.length || new Set(actions.map(a => a.kind)).size !== actions.length) fail()
    if (actions.some(a => a.kind === 'recover-application-inspection') && (!selected || selected.request !== 'confirmed' || selected.secureStorage === 'stored')) fail()
    const permission = choice(s.applicationInfoReadPermission, ['confirmed', 'unknown'] as const)
    if (permission === 'confirmed' && (!selected || selected.subject !== undefined || selected.request !== 'confirmed' || selected.secureStorage !== 'stored' || result.reason === 'connection-revised' || operation!.authentication?.stage !== 'confirmed' || operation!.authentication.request !== 'confirmed' || operation!.authentication.secureStorage !== 'stored')) fail()
    result.applicationInspection = { observations, selected, next: s.next === null ? null : text(s.next), applicationInfoReadPermission: permission, actions }
    if (s.readResult !== undefined) {
      const readResult = parseConnectionSetupReadSummary(s.readResult)
      if (!selected || selected.subject !== readResult.subject || selected.request !== 'confirmed' || selected.secureStorage !== 'stored' || result.reason === 'connection-revised' || operation!.authentication?.stage !== 'confirmed' || operation!.authentication.request !== 'confirmed' || operation!.authentication.secureStorage !== 'stored') fail()
      result.applicationInspection.readResult = readResult
    }
  }
  return result as ConnectionSetupResultMap[M]
}
