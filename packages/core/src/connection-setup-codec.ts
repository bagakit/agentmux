import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import type { ConnectionSetupBegin, ConnectionSetupChallenge, ConnectionSetupMethod, ConnectionSetupOperation, ConnectionSetupParamsMap, ConnectionSetupResultMap, ConnectionSetupView } from './connection-setup-contract.js'

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
  const p = object(value, ['operationId']); return { operationId: id(p.operationId) } as ConnectionSetupParamsMap[M]
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
      if (!Array.isArray(s.capabilities) || s.capabilities.length > 1) fail()
      support = { connectionRevision: integer(s.connectionRevision), capabilities: (s.capabilities as unknown[]).map(value => choice(value, ['management-authentication'] as const)) }
    }
    return { operations, next: p.next === null ? null : text(p.next), support } as ConnectionSetupResultMap[M]
  }
  const p = object(value, ['operation', 'challenge', 'reason', 'continuation', 'receipt']), operation = p.operation === null ? null : parseConnectionSetupOperation(p.operation), challenge = p.challenge === null ? null : parseConnectionSetupChallenge(p.challenge)
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
  return result as ConnectionSetupResultMap[M]
}
