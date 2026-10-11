import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { CONNECTION_SETUP_READ_ACTIONS, connectionSetupConfigurationSubject, connectionSetupPermissionActionPurpose, type ConnectionSetupReadSubject, type ConnectionSetupReadSummary, type ConnectionSetupPermissionReview, type ConnectionSetupMessageReceptionReview } from './connection-setup-contract.js'
import type { ConnectionSetupBegin, ConnectionSetupChallenge, ConnectionSetupInspectionReceipt, ConnectionSetupConfigurationReceipt, ConnectionSetupMethod, ConnectionSetupOperation, ConnectionSetupParamsMap, ConnectionSetupResultMap, ConnectionSetupView } from './connection-setup-contract.js'

export const CONNECTION_SETUP_RPC_METHODS = { 'connection.setup.begin': 'long', 'connection.setup.advance': 'long', 'connection.setup.inspect': 'long', 'connection.setup.ls': 'long' } as const
export const isConnectionSetupMethod = (value: unknown): value is ConnectionSetupMethod => typeof value === 'string' && Object.hasOwn(CONNECTION_SETUP_RPC_METHODS, value)
const fail = (): never => { throw new AgentMuxError('Setup data does not describe the exact original management intent.', 'INVALID_CONNECTION_SETUP_DATA') }
function object(value: unknown, fields: readonly string[]) { const p = rpcRecord(value); if (Object.keys(p).some(k => !fields.includes(k))) fail(); return p }
function text(value: unknown): string { if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) fail(); return value as string }
function id(value: unknown): string { const v = text(value); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(v)) fail(); return v }
function integer(value: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): number { if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail(); return value as number }
function choice<T extends string>(value: unknown, values: readonly T[]): T { if (!values.includes(value as T)) fail(); return value as T }
const configurationEffect = (value: unknown) => choice(value, ['enable-messaging', 'use-persistent-connection', 'add-application-permissions', 'add-message-reception'] as const)
const permissionPurpose = (value: unknown) => choice(value, ['agent-conversation', 'mote-profile-sync'] as const)
const names = (value: unknown): string[] => { if (!Array.isArray(value)) fail(); const result = (value as unknown[]).map(text); if (new Set(result).size !== result.length) fail(); return result }
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
  const p = object(value, ['operationId', 'connectionId', 'expectedConnectionRevision', 'goal', 'source']), g = object(p.goal, ['kind', 'interaction'])
  const source = p.source === undefined ? undefined : object(p.source, ['kind', 'operationId', 'expectedRevision'])
  return { operationId: id(p.operationId), connectionId: id(p.connectionId), expectedConnectionRevision: integer(p.expectedConnectionRevision), goal: { kind: choice(g.kind, ['agent-conversation']), interaction: choice(g.interaction, ['messages', 'cards']) }, ...(source ? { source: { kind: choice(source.kind, ['enrollment']), operationId: id(source.operationId), expectedRevision: integer(source.expectedRevision) } } : {}) }
}
export function parseConnectionSetupChallenge(value: unknown): ConnectionSetupChallenge {
  const p = object(value, ['qrPayload', 'expiresAt', 'nextPollAt'])
  return { qrPayload: text(p.qrPayload), expiresAt: p.expiresAt === null ? null : integer(p.expiresAt, 0), nextPollAt: integer(p.nextPollAt, 0) }
}
export function parseConnectionSetupOperation(value: unknown): ConnectionSetupOperation {
  const p = object(value, ['operationId', 'connectionId', 'expectedConnectionRevision', 'goal', 'source', 'revision', 'adapterId', 'application', 'request', 'secureStorage', 'reason', 'authentication'])
  const input = begin(Object.fromEntries(['operationId', 'connectionId', 'expectedConnectionRevision', 'goal', 'source'].map(k => [k, p[k]])))
  const a = object(p.application, ['domain', 'appId']), r = object(p.request, ['kind', 'state', 'attemptId']), domain = text(a.domain)
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(domain)) fail()
  const result: ConnectionSetupOperation = { ...input, revision: integer(p.revision), adapterId: id(p.adapterId), application: { domain, appId: id(a.appId) }, request: { state: choice(r.state, ['not-dispatched', 'dispatching', 'confirmed', 'unknown', 'refused']), attemptId: r.attemptId === null ? null : id(r.attemptId) }, secureStorage: choice(p.secureStorage, ['not-started', 'storing', 'stored', 'unknown']), ...(p.reason === undefined ? {} : { reason: choice(p.reason, ['adapter-unavailable', 'secure-storage-unavailable', 'request-unconfirmed', 'challenge-unconfirmed']) }) }
  if (result.request.state === 'not-dispatched' && result.request.attemptId !== null || result.request.state !== 'not-dispatched' && result.request.attemptId === null || result.secureStorage === 'stored' && result.request.state !== 'confirmed') fail()
  if (input.source) result.request.kind = choice(r.kind, ['enrollment-handoff'])
  else if (r.kind !== undefined) fail()
  if (p.authentication !== undefined) {
    result.authentication = parseConnectionSetupAuthentication(p.authentication)
  }
  return result
}
export function parseConnectionSetupParams<M extends ConnectionSetupMethod>(method: M, value: unknown): ConnectionSetupParamsMap[M] {
  if (method === 'connection.setup.begin') return begin(value) as ConnectionSetupParamsMap[M]
  if (method === 'connection.setup.advance') {
    const p = object(value, ['operationId', 'expectedRevision', 'decision', 'versionId']), d = object(p.decision, ['actionId', 'value'])
    const actionId = id(d.actionId)
    if (p.versionId !== undefined && !actionId.startsWith('setup-version-read:') && !actionId.startsWith('setup-inspection-recover:')) fail()
    return { operationId: id(p.operationId), expectedRevision: integer(p.expectedRevision), decision: { actionId, value: choice(d.value, ['continue', 'confirm', 'renew']) }, ...(p.versionId === undefined ? {} : { versionId: id(p.versionId) }) } as ConnectionSetupParamsMap[M]
  }
  if (method === 'connection.setup.ls') { const p = object(value, ['connectionId', 'cursor', 'limit']); return { connectionId: id(p.connectionId), ...(p.cursor === undefined ? {} : { cursor: text(p.cursor) }), ...(p.limit === undefined ? {} : { limit: integer(p.limit, 1, 100) }) } as ConnectionSetupParamsMap[M] }
  const p = object(value, ['operationId', 'applicationInspection', 'applicationConfiguration'])
  const result: ConnectionSetupParamsMap['connection.setup.inspect'] = { operationId: id(p.operationId) }
  if (p.applicationInspection !== undefined) {
    const s = object(p.applicationInspection, ['selectedStepId', 'cursor', 'limit', 'versionId'])
    result.applicationInspection = { ...(s.versionId === undefined ? {} : { versionId: id(s.versionId) }), ...(s.selectedStepId === undefined ? {} : { selectedStepId: id(s.selectedStepId) }), ...(s.cursor === undefined ? {} : { cursor: text(s.cursor) }), ...(s.limit === undefined ? {} : { limit: integer(s.limit, 1, 100) }) }
  }
  if (p.applicationConfiguration !== undefined) {
    const s = object(p.applicationConfiguration, ['effect', 'purpose', 'selectedStepId', 'cursor', 'limit']), effect = configurationEffect(s.effect)
    if (effect !== 'add-application-permissions' && s.purpose !== undefined) fail()
    result.applicationConfiguration = { ...(effect === 'add-application-permissions' ? { effect, purpose: permissionPurpose(s.purpose) } : { effect }), ...(s.selectedStepId === undefined ? {} : { selectedStepId: id(s.selectedStepId) }), ...(s.cursor === undefined ? {} : { cursor: text(s.cursor) }), ...(s.limit === undefined ? {} : { limit: integer(s.limit, 1, 100) }) }
  }
  return result as ConnectionSetupParamsMap[M]
}
const readSubjects = [...Object.keys(CONNECTION_SETUP_READ_ACTIONS), 'publication-version'] as ConnectionSetupReadSubject[]
const versionStatus = (value: unknown) => choice(value, ['draft', 'reviewing', 'approved', 'rejected', 'awaiting-release', 'unknown'] as const)
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
  if (subject === 'publication-version') {
    const p = object(value, ['subject', 'versionId', 'status']); return { subject, versionId: id(p.versionId), status: versionStatus(p.status) }
  }
  object(value, ['subject'])
  return { subject }
}
export function parseConnectionSetupInspectionReceipt(value: unknown): ConnectionSetupInspectionReceipt {
  const p = object(value, ['stepId', 'input', 'request', 'secureStorage', 'subject', 'versionId'])
  const result: ConnectionSetupInspectionReceipt = { stepId: id(p.stepId), input: parseConnectionSetupParams('connection.setup.advance', p.input), request: requestState(p.request), secureStorage: choice(p.secureStorage, ['not-started', 'storing', 'stored', 'unknown']) }
  if (p.subject !== undefined) result.subject = choice(p.subject, readSubjects)
  if (result.subject === 'publication-version') {
    result.versionId = id(p.versionId)
    if (result.input.versionId !== result.versionId || !result.input.decision.actionId.startsWith('setup-version-read:')) fail()
  } else if (p.versionId !== undefined || result.input.versionId !== undefined) fail()
  if (result.input.decision.value !== 'continue' || result.secureStorage === 'stored' && result.request !== 'confirmed') fail()
  return result
}
export function parseConnectionSetupPermissionReview(value: unknown): ConnectionSetupPermissionReview {
  const p = object(value, ['permissions', 'reason'])
  if (!Array.isArray(p.permissions)) fail()
  const permissions = (p.permissions as unknown[]).map(value => { const r = object(value, ['name', 'group', 'state']); return { name: text(r.name), group: choice(r.group, ['messages', 'groups', 'identity'] as const), state: choice(r.state, ['requested', 'missing', 'unknown'] as const) } })
  if (!permissions.length || new Set(permissions.map(p => p.name)).size !== permissions.length) fail()
  const reason = p.reason === undefined ? undefined : choice(p.reason, ['catalog-unconfirmed', 'applied-unconfirmed', 'scope-unavailable', 'scope-ambiguous', 'unsupported-scope-id'] as const)
  if (permissions.some(p => p.state === 'unknown') !== Boolean(reason)) fail()
  return { permissions, ...(reason ? { reason } : {}) }
}
export function parseConnectionSetupMessageReceptionReview(value: unknown): ConnectionSetupMessageReceptionReview {
  const p = object(value, ['reception', 'transport', 'reason'])
  const reception = choice(p.reception, ['subscribed', 'missing', 'unknown'] as const), transport = choice(p.transport, ['persistent-connection', 'webhook', 'function', 'unknown'] as const)
  const reason = p.reason === undefined ? undefined : choice(p.reason, ['catalog-unconfirmed', 'settings-unconfirmed', 'event-unavailable', 'event-ambiguous'] as const)
  if ((reception === 'unknown') !== Boolean(reason)) fail()
  return { reception, transport, ...(reason ? { reason } : {}) }
}
export function parseConnectionSetupConfigurationReceipt(value: unknown): ConnectionSetupConfigurationReceipt {
  const effect = configurationEffect(rpcRecord(value).effect)
  const common = ['effect', 'stepId', 'input', 'request', 'secureStorage']
  const p = object(value, [...common, ...(effect === 'add-application-permissions' ? ['purpose', 'sourceStepIds', 'scopeNames', 'requiresDataRangeConfiguration'] : effect === 'add-message-reception' ? ['sourceStepIds', 'transport'] : ['sourceStepId'])])
  const input = parseConnectionSetupParams('connection.setup.advance', p.input), request = requestState(p.request), secureStorage = choice(p.secureStorage, ['not-started', 'storing', 'stored', 'unknown'] as const), stepId = id(p.stepId)
  if (input.decision.value !== 'confirm' || secureStorage === 'stored' && request !== 'confirmed') fail()
  if (effect === 'add-message-reception') {
    const sources = object(p.sourceStepIds, ['catalog', 'settings']), sourceStepIds = { catalog: id(sources.catalog), settings: id(sources.settings) }
    if (new Set([stepId, sourceStepIds.catalog, sourceStepIds.settings]).size !== 3 || !input.decision.actionId.startsWith('setup-reception:')) fail()
    return { effect, stepId, input, request, secureStorage, sourceStepIds, transport: choice(p.transport, ['persistent-connection']) }
  }
  if (effect !== 'add-application-permissions') {
    const sourceStepId = id(p.sourceStepId)
    if (stepId === sourceStepId) fail()
    return { effect, stepId, sourceStepId, input, request, secureStorage }
  }
  const sources = object(p.sourceStepIds, ['catalog', 'applied']), sourceStepIds = { catalog: id(sources.catalog), applied: id(sources.applied) }, scopeNames = names(p.scopeNames)
  if (!scopeNames.length || new Set([stepId, sourceStepIds.catalog, sourceStepIds.applied]).size !== 3 || p.requiresDataRangeConfiguration !== null && typeof p.requiresDataRangeConfiguration !== 'boolean' || request !== 'confirmed' && p.requiresDataRangeConfiguration !== null) fail()
  const purpose = permissionPurpose(p.purpose)
  if (connectionSetupPermissionActionPurpose(input.decision.actionId) !== purpose) fail()
  return { effect, stepId, input, request, secureStorage, purpose, sourceStepIds, scopeNames, requiresDataRangeConfiguration: p.requiresDataRangeConfiguration as boolean | null }
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
      const supportedCapabilities = ['management-authentication', 'application-inspection', 'messaging-capability', 'persistent-event-transport', 'application-permissions', 'message-reception', 'enrollment-continuation'] as const
      if (!Array.isArray(s.capabilities) || s.capabilities.length > supportedCapabilities.length) fail()
      const capabilities = (s.capabilities as unknown[]).map(value => choice(value, supportedCapabilities))
      if (new Set(capabilities).size !== capabilities.length) fail()
      support = { connectionRevision: integer(s.connectionRevision), capabilities }
    }
    return { operations, next: p.next === null ? null : text(p.next), support } as ConnectionSetupResultMap[M]
  }
  const p = object(value, ['operation', 'challenge', 'reason', 'continuation', 'receipt', 'applicationInspection', 'applicationConfiguration']), operation = p.operation === null ? null : parseConnectionSetupOperation(p.operation), challenge = p.challenge === null ? null : parseConnectionSetupChallenge(p.challenge)
  if (operation && operation.operationId !== (input as { operationId: string }).operationId || !operation && (method === 'connection.setup.begin' || challenge !== null)) fail()
  if (method === 'connection.setup.begin' && operation) {
    // Select the admitted fields explicitly: summaries also contain safe result fields.
    const admitted = begin(Object.fromEntries(['operationId', 'connectionId', 'expectedConnectionRevision', 'goal', 'source'].map(k => [k, operation[k as keyof ConnectionSetupOperation]])))
    if (JSON.stringify(admitted) !== JSON.stringify(input)) fail()
  }
  const challengeRequest = operation?.authentication?.request ?? operation?.request.state
  const challengeStorage = operation?.authentication?.secureStorage ?? operation?.secureStorage
  if (challenge && (challengeRequest !== 'confirmed' || challengeStorage !== 'stored')) fail()
  if (challenge && operation?.request.kind === 'enrollment-handoff' && !operation.authentication) fail()
  const result: ConnectionSetupView = { operation, challenge, ...(p.reason === undefined ? {} : { reason: choice(p.reason, ['connection-revised', 'challenge-unavailable']) }) }
  if (method === 'connection.setup.inspect' && operation && (input as ConnectionSetupParamsMap['connection.setup.inspect']).applicationInspection && p.applicationInspection === undefined) fail()
  if (method === 'connection.setup.inspect' && operation && (input as ConnectionSetupParamsMap['connection.setup.inspect']).applicationConfiguration && p.applicationConfiguration === undefined) fail()
  if (p.continuation !== undefined) {
    if (!operation || result.reason === 'connection-revised') fail()
    const c = object(p.continuation, ['stage', 'account', 'actions'])
    if (!Array.isArray(c.actions) || c.actions.length > 2) fail()
    const actions = (c.actions as unknown[]).map(value => { const a = object(value, ['actionId', 'expectedRevision', 'kind']); return { actionId: id(a.actionId), expectedRevision: integer(a.expectedRevision), kind: choice(a.kind, ['continue', 'confirm-account', 'renew'] as const) } })
    if (new Set(actions.map(a => a.actionId)).size !== actions.length || new Set(actions.map(a => a.kind)).size !== actions.length) fail()
    result.continuation = { stage: stage(c.stage), account: c.account === null ? null : parseConnectionSetupAccount(c.account), actions }
    if (result.continuation.account && !['account', 'confirmed'].includes(result.continuation.stage) || ['account', 'confirmed'].includes(result.continuation.stage) && !result.continuation.account) fail()
    if (operation && !operation.authentication && operation.request.kind === 'enrollment-handoff' && result.continuation.account && (result.continuation.stage !== 'account' || operation.request.state !== 'confirmed' || operation.secureStorage !== 'stored')) fail()
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
    if (!Array.isArray(s.observations) || s.observations.length > limit || !Array.isArray(s.actions) || s.actions.length > readSubjects.length + 2) fail()
    const observations = (s.observations as unknown[]).map(parseConnectionSetupInspectionReceipt), selected = s.selected === null ? null : parseConnectionSetupInspectionReceipt(s.selected)
    if (new Set(observations.map(o => o.stepId)).size !== observations.length || new Set(observations.map(o => o.input.decision.actionId)).size !== observations.length) fail()
    if ([...observations, ...(selected ? [selected] : [])].some(o => o.input.operationId !== operation!.operationId)) fail()
    const selector = method === 'connection.setup.inspect' ? (input as ConnectionSetupParamsMap['connection.setup.inspect']).applicationInspection : undefined
    if (selector?.selectedStepId && selected && selector.selectedStepId !== selected.stepId) fail()
    if (method === 'connection.setup.advance' && (!result.receipt || !selected || selected.stepId !== result.receipt.stepId)) fail()
    const copy = selected && observations.find(o => o.stepId === selected.stepId)
    if (copy && JSON.stringify(copy) !== JSON.stringify(selected)) fail()
    const actions = (s.actions as unknown[]).map(value => {
      const a = object(value, ['actionId', 'expectedRevision', 'kind', 'versionId'])
      const actionId = id(a.actionId), expectedRevision = integer(a.expectedRevision)
      if (a.kind === 'read-publication-version') {
        const versionId = id(a.versionId)
        if (!actionId.startsWith('setup-version-read:') || method === 'connection.setup.inspect' && selector?.versionId !== versionId) fail()
        return { actionId, expectedRevision, kind: 'read-publication-version' as const, versionId }
      }
      if (a.versionId !== undefined) fail()
      return { actionId, expectedRevision, kind: choice(a.kind, ['inspect-application', 'recover-application-inspection', ...Object.values(CONNECTION_SETUP_READ_ACTIONS)] as const) }
    })
    if (new Set(actions.map(a => a.actionId)).size !== actions.length || new Set(actions.map(a => a.kind)).size !== actions.length) fail()
    if (actions.some(a => a.kind === 'recover-application-inspection') && (!selected || selected.request !== 'confirmed' || selected.secureStorage === 'stored')) fail()
    const permission = choice(s.applicationInfoReadPermission, ['confirmed', 'unknown'] as const)
    if (permission === 'confirmed' && (!selected || selected.subject !== undefined || selected.request !== 'confirmed' || selected.secureStorage !== 'stored' || result.reason === 'connection-revised' || operation!.authentication?.stage !== 'confirmed' || operation!.authentication.request !== 'confirmed' || operation!.authentication.secureStorage !== 'stored')) fail()
    result.applicationInspection = { observations, selected, next: s.next === null ? null : text(s.next), applicationInfoReadPermission: permission, actions }
    if (s.readResult !== undefined) {
      const readResult = parseConnectionSetupReadSummary(s.readResult)
      if (!selected || selected.subject !== readResult.subject || readResult.subject === 'publication-version' && selected.versionId !== readResult.versionId || selected.request !== 'confirmed' || selected.secureStorage !== 'stored' || result.reason === 'connection-revised' || operation!.authentication?.stage !== 'confirmed' || operation!.authentication.request !== 'confirmed' || operation!.authentication.secureStorage !== 'stored') fail()
      result.applicationInspection.readResult = readResult
    }
  }
  if (p.applicationConfiguration !== undefined) {
    if (!operation || method === 'connection.setup.begin' || method === 'connection.setup.inspect' && !(input as ConnectionSetupParamsMap['connection.setup.inspect']).applicationConfiguration) fail()
    const raw = rpcRecord(p.applicationConfiguration), effect = configurationEffect(raw.effect)
    const c = object(raw, ['effect', 'subject', 'effects', 'next', 'selected', 'capability', 'actions', 'reason', 'unresolved', ...(effect === 'add-application-permissions' ? ['purpose', 'sources', 'review'] : effect === 'add-message-reception' ? ['sources', 'review'] : ['source'])])
    const selector = method === 'connection.setup.inspect' ? (input as ConnectionSetupParamsMap['connection.setup.inspect']).applicationConfiguration : undefined
    if (!Array.isArray(c.effects) || c.effects.length > (selector?.limit ?? 25) || !Array.isArray(c.actions) || c.actions.length > 2 || selector && selector.effect !== effect) fail()
    const effects = (c.effects as unknown[]).map(parseConnectionSetupConfigurationReceipt), selected = c.selected === null ? null : parseConnectionSetupConfigurationReceipt(c.selected)
    if (new Set(effects.map(e => e.stepId)).size !== effects.length || new Set(effects.map(e => e.input.decision.actionId)).size !== effects.length || [...effects, ...(selected ? [selected] : [])].some(e => e.input.operationId !== operation!.operationId || e.effect !== effect)) fail()
    if (selector?.selectedStepId && selected && selector.selectedStepId !== selected.stepId) fail()
    const copy = selected && effects.find(e => e.stepId === selected.stepId)
    if (copy && JSON.stringify(copy) !== JSON.stringify(selected)) fail()
    const capability = choice(c.capability, ['enabled', 'disabled', 'unknown'] as const)
    const qualified = result.reason !== 'connection-revised' && operation!.authentication?.stage === 'confirmed' && operation!.authentication.request === 'confirmed' && operation!.authentication.secureStorage === 'stored'
    const sourceReceipt = (value: unknown, subject: ConnectionSetupReadSubject) => {
      if (value === null) return null
      const source = parseConnectionSetupInspectionReceipt(value)
      if (source.input.operationId !== operation!.operationId || source.subject !== subject || source.request !== 'confirmed' || source.secureStorage !== 'stored') fail()
      return source
    }
    const actions = (c.actions as unknown[]).map(value => { const a = object(value, ['actionId', 'expectedRevision', 'kind']); return { actionId: id(a.actionId), expectedRevision: integer(a.expectedRevision), kind: choice(a.kind, ['enable-messaging', 'use-persistent-connection', 'add-application-permissions', 'add-message-reception', 'recover-configuration-effect'] as const) } })
    if (new Set(actions.map(a => a.actionId)).size !== actions.length || new Set(actions.map(a => a.kind)).size !== actions.length) fail()
    if (actions.some(a => a.kind !== 'recover-configuration-effect' && (a.kind !== effect || capability !== 'disabled' || a.expectedRevision !== operation!.revision || c.reason !== undefined))) fail()
    if (actions.some(a => a.kind === 'recover-configuration-effect') && (!selected || selected.request !== 'confirmed' || selected.secureStorage === 'stored')) fail()
    if (method === 'connection.setup.advance' && (!result.receipt || !selected || selected.stepId !== result.receipt.stepId)) fail()
    const common = { effects, next: c.next === null ? null : text(c.next), selected, capability, actions, ...(c.reason === undefined ? {} : { reason: choice(c.reason, ['source-unconfirmed', 'adapter-unavailable', 'original-effect-unconfirmed'] as const) }) }
    if (effect === 'add-application-permissions') {
      const purpose = permissionPurpose(c.purpose), pair = object(c.sources, ['catalog', 'applied'])
      const sources = { catalog: sourceReceipt(pair.catalog, 'permission-catalog'), applied: sourceReceipt(pair.applied, 'application-permissions') }, review = c.review === null ? null : parseConnectionSetupPermissionReview(c.review)
      if (actions.some(action => action.kind === 'add-application-permissions' && connectionSetupPermissionActionPurpose(action.actionId) !== purpose)) fail()
      if (c.subject !== 'application-permissions' || selector?.effect === effect && selector.purpose !== purpose || sources.catalog && sources.applied && sources.catalog.stepId === sources.applied.stepId) fail()
      if (review && (!sources.catalog || !sources.applied || !qualified) || capability !== 'unknown' && (!review || review.reason || !qualified)) fail()
      if (review && capability !== 'unknown' && (review.permissions.some(p => p.state === 'missing') ? 'disabled' : 'enabled') !== capability) fail()
      result.applicationConfiguration = { ...common, effect, subject: 'application-permissions', purpose, sources, review }
    } else if (effect === 'add-message-reception') {
      const pair = object(c.sources, ['catalog', 'settings']), sources = { catalog: sourceReceipt(pair.catalog, 'event-catalog'), settings: sourceReceipt(pair.settings, 'event-settings') }
      const review = c.review === null ? null : parseConnectionSetupMessageReceptionReview(c.review)
      if (c.subject !== 'event-settings' || sources.catalog && sources.settings && sources.catalog.stepId === sources.settings.stepId) fail()
      if (review && (!sources.catalog || !sources.settings || !qualified) || capability !== 'unknown' && (!review || review.reason || !qualified)) fail()
      if (review && capability !== 'unknown' && (review.reception === 'subscribed' ? 'enabled' : review.reception === 'missing' ? 'disabled' : 'unknown') !== capability) fail()
      if (actions.some(a => a.kind === effect && (!a.actionId.startsWith('setup-reception:') || review?.reception !== 'missing' || review.transport !== 'persistent-connection'))) fail()
      result.applicationConfiguration = { ...common, effect, subject: 'event-settings', sources, review }
    } else {
      const subject = connectionSetupConfigurationSubject(effect), source = sourceReceipt(c.source, subject)
      if (c.subject !== subject || capability !== 'unknown' && (!source || !qualified)) fail()
      result.applicationConfiguration = { ...common, effect, subject, source }
    }
    if (result.applicationConfiguration.reason === 'original-effect-unconfirmed' && actions.some(a => a.kind !== 'recover-configuration-effect')) fail()
    if (c.unresolved !== undefined) {
      const u = object(c.unresolved, ['operationId', 'connectionId', 'stepId'])
      if (result.applicationConfiguration.reason !== 'original-effect-unconfirmed') fail()
      result.applicationConfiguration.unresolved = { operationId: id(u.operationId), connectionId: id(u.connectionId), stepId: id(u.stepId) }
    }
  }
  return result as ConnectionSetupResultMap[M]
}
