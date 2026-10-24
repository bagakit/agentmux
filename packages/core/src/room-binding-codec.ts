import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseNativeConversationCheckpoint } from './session-history-changes.js'
import { parseConversationCheckpoint } from './conversation-changes.js'
import { validateAgentDirectedPromptTarget } from './agent-prompt-condition.js'
import { dequal } from 'dequal'
import type { ConnectionActor, ConnectionApplication, ConnectionGrant } from './connections-contract.js'
import type { RoomBinding, RoomBindingAuthority, RoomBindingMethod, RoomBindingOperation, RoomBindingParamsMap, RoomBindingResultMap, RoomBindingScope } from './room-binding-contract.js'

export const ROOM_BINDING_RPC_METHODS = { 'connection.binding.member.inherit': 'long', 'connection.bind': 'long', 'connection.binding.inspect': 'long', 'connection.binding.ls': 'long', 'connection.binding.pause': 'long', 'connection.binding.resume': 'long', 'connection.binding.detach': 'long', 'connection.binding.relink': 'long', 'connection.grant': 'long' } as const
export const isRoomBindingMethod = (value: unknown): value is RoomBindingMethod => typeof value === 'string' && Object.hasOwn(ROOM_BINDING_RPC_METHODS, value)
const fail = (): never => { throw new AgentMuxError('Binding data does not describe the original authorized objects.', 'INVALID_ROOM_BINDING_DATA') }
const object = (value: unknown, fields: string[]) => rpcRecord(value, fields, 'INVALID_ROOM_BINDING_DATA')
function text(value: unknown): string { if (typeof value !== 'string' || !value || value.length > 16_384 || /[\u0000-\u001f\u007f]/u.test(value)) fail(); return value as string }
function id(value: unknown): string { const result = text(value); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(result)) fail(); return result }
function revision(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 1) fail(); return value as number }
export function parseConnectionApplication(value: unknown): ConnectionApplication { const p = object(value, ['domain', 'appId']), domain = text(p.domain); if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(domain)) fail(); return { domain, appId: id(p.appId) } }
function source(value: unknown) { const p = object(value, ['providerId', 'nativeSessionId']); return { providerId: text(p.providerId), nativeSessionId: text(p.nativeSessionId) } }
function inputTarget(value: unknown): import('./room-binding-contract.js').RoomBindingInputTarget {
  const target = validateAgentDirectedPromptTarget(value)
  if (target.kind === 'native-conversation' && !Object.hasOwn(value as object, 'expectedTurnId')) return { kind: target.kind, source: target.source }
  return fail()
}
function scope(value: unknown): RoomBindingScope {
  const p = object(value, ['input', 'publication'])
  if ((p.input !== 'mentions-and-replies' && p.input !== 'all-messages') ||
    (p.publication !== 'future-native-user-facing' && p.publication !== 'future-shared-conversation')) fail()
  return { input: p.input as RoomBindingScope['input'], publication: p.publication as RoomBindingScope['publication'] }
}
function target(p: Record<string, unknown>) { return { executionHostId: id(p.executionHostId), agentSessionId: id(p.agentSessionId), ...(p.regionAnchor === undefined ? {} : { regionAnchor: { regionId: id(object(p.regionAnchor, ['regionId']).regionId) } }) } }
export function parseRoomBindingTarget(value: unknown) { return target(object(value, ['executionHostId', 'agentSessionId', 'regionAnchor'])) }
export function parseConnectionMember(value: unknown): Pick<ConnectionActor, 'idType' | 'userId'> { const p = object(value, ['idType', 'userId']); return { idType: id(p.idType), userId: text(p.userId) } }
export function parseRoomBindingAuthority(value: unknown): RoomBindingAuthority { const p = object(value, ['kind', 'id']); if (p.kind !== 'user' && p.kind !== 'device' && p.kind !== 'agent') fail(); return { kind: p.kind as RoomBindingAuthority['kind'], id: text(p.id) } }
export function parseConnectionActor(value: unknown): ConnectionActor { const p = object(value, ['application', 'idType', 'userId']); return { application: parseConnectionApplication(p.application), ...parseConnectionMember({ idType: p.idType, userId: p.userId }) } }
export function parseConnectionGrantCapabilities(value: unknown): ConnectionGrant['capabilities'] { if (!Array.isArray(value) || value.length > 3 || new Set(value).size !== value.length || value.some(v => !['input', 'answer', 'permission'].includes(v))) fail(); return [...value as ConnectionGrant['capabilities']] }
export function parseConnectionGrant(value: unknown): ConnectionGrant {
  const p = object(value, ['grantId', 'revision', 'bindingId', 'bindingRevision', 'connectionId', 'actor', 'externalConversationId', 'state', 'capabilities'])
  if (p.state !== 'active' && p.state !== 'revoked') fail()
  return { grantId: id(p.grantId), revision: revision(p.revision), bindingId: id(p.bindingId), bindingRevision: revision(p.bindingRevision), connectionId: id(p.connectionId), actor: parseConnectionActor(p.actor), externalConversationId: text(p.externalConversationId), state: p.state as ConnectionGrant['state'], capabilities: parseConnectionGrantCapabilities(p.capabilities) }
}
export function parseRoomBinding(value: unknown): RoomBinding {
  const p = object(value, ['bindingId', 'revision', 'state', 'connectionId', 'application', 'externalConversationId', 'scope', 'inputTarget', 'executionHostId', 'executionRuntimeId', 'agentSessionId', 'regionAnchor', 'sourceCheckpoints', 'sourceFrontier', 'publicationOrigin', 'authorizedBy'])
  const origin = p.publicationOrigin === undefined ? undefined : { createOperationId: id(object(p.publicationOrigin, ['createOperationId']).createOperationId) }
  if (p.state !== 'active' && p.state !== 'paused' && p.state !== 'detached' || !Array.isArray(p.sourceCheckpoints) || p.sourceCheckpoints.length > 32 ||
    (origin ? p.sourceCheckpoints.length !== 0 || p.sourceFrontier !== undefined || scope(p.scope).publication !== 'future-native-user-facing' : p.sourceCheckpoints.length < 1)) fail()
  const t = { executionHostId: id(p.executionHostId), agentSessionId: id(p.agentSessionId), ...(p.regionAnchor === undefined ? {} : { regionAnchor: target(p).regionAnchor }) }, checkpoints = (p.sourceCheckpoints as unknown[]).map(parseNativeConversationCheckpoint)
  if (checkpoints.some(c => c.agentSessionId !== t.agentSessionId) || new Set(checkpoints.map(c => JSON.stringify(c.source))).size !== checkpoints.length) fail()
  const frontier = p.sourceFrontier === undefined ? undefined : parseConversationCheckpoint(p.sourceFrontier, { hostId: t.executionHostId, agentSessionId: t.agentSessionId })
  if (frontier && (frontier.frontier.cuts.filter(c => c.kind === 'native').length !== checkpoints.length || checkpoints.some(c => !frontier.frontier.cuts.some(cut => cut.kind === 'native' && JSON.stringify(cut.checkpoint) === JSON.stringify(c))))) fail()
  return { ...t, ...(p.executionRuntimeId === undefined ? {} : { executionRuntimeId: id(p.executionRuntimeId) }), bindingId: id(p.bindingId), revision: revision(p.revision), state: p.state as RoomBinding['state'], connectionId: id(p.connectionId), application: parseConnectionApplication(p.application), externalConversationId: text(p.externalConversationId), scope: scope(p.scope), ...(p.inputTarget === undefined ? {} : { inputTarget: inputTarget(p.inputTarget) }), sourceCheckpoints: checkpoints, ...(frontier ? { sourceFrontier: frontier } : {}), ...(origin ? { publicationOrigin: origin } : {}), authorizedBy: parseRoomBindingAuthority(p.authorizedBy) }
}
export function parseRoomBindingOperation(value: unknown): RoomBindingOperation {
  const p = object(value, ['operationId', 'action', 'state', 'binding', 'grant', 'inherited', 'reused', 'code', 'notices'])
  if (!['bind', 'pause', 'resume', 'detach', 'relink', 'grant', 'inherit'].includes(String(p.action))) fail()
  const base = { operationId: id(p.operationId), action: p.action as RoomBindingOperation['action'] }
  if (p.state === 'preparing') { if (['binding', 'grant', 'inherited', 'reused', 'code', 'notices'].some(k => p[k] !== undefined)) fail(); return { ...base, state: 'preparing' } }
  if (p.state === 'refused') { if (['binding', 'grant', 'inherited', 'reused', 'notices'].some(k => p[k] !== undefined)) fail(); return { ...base, state: 'refused', code: id(p.code) } }
  if (p.state !== 'applied' || p.code !== undefined || p.reused !== undefined && typeof p.reused !== 'boolean') fail()
  const binding = parseRoomBinding(p.binding), grant = p.grant === undefined ? undefined : parseConnectionGrant(p.grant)
  if (grant && (base.action !== 'grant' || grant.bindingId !== binding.bindingId || grant.bindingRevision !== binding.revision || grant.connectionId !== binding.connectionId || grant.externalConversationId !== binding.externalConversationId || JSON.stringify(grant.actor.application) !== JSON.stringify(binding.application))) fail()
  const inherited = p.inherited === undefined ? undefined : parseInherited(p.inherited)
  if ((base.action === 'inherit') !== !!inherited || inherited && (grant || JSON.stringify(inherited.actor.application) !== JSON.stringify(binding.application))) fail()
  const notices = p.notices === undefined ? undefined : parseRoomBindingNotices(p.notices)
  if (notices && (['grant', 'inherit'].includes(base.action) || p.reused === true)) fail()
  if (notices) {
    const events = notices.map(item => item.event).join(',')
    const allowed: Partial<Record<RoomBindingOperation['action'], string[]>> = { bind: ['connected'], pause: ['paused'], resume: ['resumed'], detach: ['disconnected'], relink: ['updated', 'resumed', 'disconnected,connected'] }
    if (!allowed[base.action]?.includes(events)) fail()
  }
  return { ...base, state: 'applied', binding, ...(inherited ? { inherited } : {}), ...(notices ? { notices } : {}), ...(grant ? { grant } : {}), ...(p.reused === undefined ? {} : { reused: p.reused as boolean }) }
}
function parseInherited(value: unknown): NonNullable<Extract<RoomBindingOperation, { state: 'applied' }>['inherited']> {
  const p = object(value, ['actor', 'grants'])
  if (!Array.isArray(p.grants) || !p.grants.length) fail()
  const grants = (p.grants as unknown[]).map(item => { const g = object(item, ['grantId', 'revision']); return { grantId: id(g.grantId), revision: revision(g.revision) } })
  if (new Set(grants.map(g => g.grantId)).size !== grants.length) fail()
  return { actor: parseConnectionActor(p.actor), grants }
}
function parseMemberAccess(value: unknown): import('./connection-application-access-contract.js').ConnectionMemberAccess {
  const p = object(value, ['actor', 'local', 'effective']), actor = parseConnectionActor(p.actor), l = object(p.local, ['kind', 'grant', 'previousDecision'])
  const local = l.kind === 'none' && typeof l.previousDecision === 'boolean' && l.grant === undefined ? { kind: 'none' as const, previousDecision: l.previousDecision }
    : ['override', 'review-required'].includes(String(l.kind)) && l.previousDecision === undefined ? { kind: l.kind as 'override' | 'review-required', grant: parseConnectionGrant(l.grant) } : fail()
  if (local.kind !== 'none' && !dequal(local.grant.actor, actor)) fail()
  let effective: import('./connection-application-access-contract.js').ConnectionEffectiveGrant | null = null
  if (p.effective !== null) {
    const g = object(p.effective, ['actor', 'state', 'capabilities', 'source']), r = object(g.source, ['kind', 'grantId', 'revision'])
    if (!['room', 'application'].includes(String(r.kind)) || !['active', 'revoked'].includes(String(g.state)) || !dequal(parseConnectionActor(g.actor), actor)) fail()
    effective = { actor, state: g.state as 'active' | 'revoked', capabilities: parseConnectionGrantCapabilities(g.capabilities), source: { kind: r.kind as 'room' | 'application', grantId: id(r.grantId), revision: revision(r.revision) } }
  }
  if (local.kind === 'review-required' && local.grant.state !== 'revoked' && effective !== null || (local.kind === 'override' || local.kind === 'review-required' && local.grant.state === 'revoked') && (!effective || !dequal(effective.source, { kind: 'room', grantId: local.grant.grantId, revision: local.grant.revision }) || effective.state !== local.grant.state || !dequal(effective.capabilities, local.grant.capabilities)) || local.kind === 'none' && effective?.source.kind === 'room') fail()
  return { actor, local, effective }
}
export function parseRoomBindingNotices(value: unknown): import('./room-binding-contract.js').RoomBindingNotice[] {
  if (!Array.isArray(value) || value.length > 2) fail()
  const notices = (value as unknown[]).map(item => {
    const p = object(item, ['event', 'deliveryOperationId'])
    if (!['connected', 'disconnected', 'paused', 'resumed', 'updated'].includes(String(p.event))) fail()
    return { event: p.event as import('./room-binding-contract.js').RoomBindingNoticeEvent, deliveryOperationId: id(p.deliveryOperationId) }
  })
  if (new Set(notices.map(item => item.deliveryOperationId)).size !== notices.length) fail()
  return notices
}
export function parseRoomBindingParams<M extends RoomBindingMethod>(method: M, value: unknown): RoomBindingParamsMap[M] {
  if (method === 'connection.binding.inspect') {
    const p = object(value, ['bindingId', 'revision', 'operationId'])
    if ((p.bindingId === undefined) === (p.operationId === undefined) || p.operationId !== undefined && p.revision !== undefined) fail()
    return (p.operationId !== undefined ? { operationId: id(p.operationId) } : { bindingId: id(p.bindingId), ...(p.revision === undefined ? {} : { revision: revision(p.revision) }) }) as RoomBindingParamsMap[M]
  }
  if (method === 'connection.binding.ls') {
    const p = object(value, ['connectionId', 'executionHostId', 'agentSessionId'])
    return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, id(v)])) as RoomBindingParamsMap[M]
  }
  if (method === 'connection.binding.pause' || method === 'connection.binding.resume' || method === 'connection.binding.detach') { const p = object(value, ['operationId', 'bindingId', 'expectedRevision']); return { operationId: id(p.operationId), bindingId: id(p.bindingId), expectedRevision: revision(p.expectedRevision) } as RoomBindingParamsMap[M] }
  if (method === 'connection.binding.member.inherit') { const p = object(value, ['operationId', 'bindingId', 'expectedBindingRevision', 'actor', 'expectedGrant']), g = object(p.expectedGrant, ['grantId', 'revision']); return { operationId: id(p.operationId), bindingId: id(p.bindingId), expectedBindingRevision: revision(p.expectedBindingRevision), actor: parseConnectionActor(p.actor), expectedGrant: { grantId: id(g.grantId), revision: revision(g.revision) } } as RoomBindingParamsMap[M] }
  if (method === 'connection.grant') {
    const p = object(value, ['operationId', 'bindingId', 'expectedBindingRevision', 'grantId', 'expectedRevision', 'actor', 'capabilities', 'state'])
    if (p.state !== 'active' && p.state !== 'revoked') fail()
    return { operationId: id(p.operationId), bindingId: id(p.bindingId), expectedBindingRevision: revision(p.expectedBindingRevision), grantId: id(p.grantId), expectedRevision: p.expectedRevision === null ? null : revision(p.expectedRevision), actor: parseConnectionActor(p.actor), capabilities: parseConnectionGrantCapabilities(p.capabilities), state: p.state as ConnectionGrant['state'] } as RoomBindingParamsMap[M]
  }
  const p = object(value, ['operationId', 'bindingId', 'connectionId', 'expectedConnectionRevision', 'externalConversationId', 'scope', 'inputTarget', 'expectedSource', 'executionHostId', 'agentSessionId', 'regionAnchor', ...(method === 'connection.binding.relink' ? ['expectedRevision'] : [])])
  return { ...target(p), operationId: id(p.operationId), bindingId: id(p.bindingId), connectionId: id(p.connectionId), expectedConnectionRevision: revision(p.expectedConnectionRevision), externalConversationId: text(p.externalConversationId), scope: scope(p.scope), ...(p.inputTarget === undefined ? {} : { inputTarget: inputTarget(p.inputTarget) }), expectedSource: source(p.expectedSource), ...(method === 'connection.binding.relink' ? { expectedRevision: revision(p.expectedRevision) } : {}) } as RoomBindingParamsMap[M]
}
export function parseRoomBindingResult<M extends RoomBindingMethod>(method: M, value: unknown, input: RoomBindingParamsMap[M]): RoomBindingResultMap[M] {
  if (method === 'connection.binding.ls') {
    const p = object(value, ['bindings']); if (!Array.isArray(p.bindings)) fail()
    const bindings = (p.bindings as unknown[]).map(parseRoomBinding)
    if (new Set(bindings.map(b => b.bindingId)).size !== bindings.length || bindings.some(b => Object.entries(input).some(([k,v]) => b[k as keyof RoomBinding] !== v))) fail()
    return { bindings } as RoomBindingResultMap[M]
  }
  if (method === 'connection.binding.inspect') {
    const p = object(value, ['binding', 'current', 'operation', 'grants', 'access']), expected = input as RoomBindingParamsMap['connection.binding.inspect']
    const binding = p.binding === null ? null : parseRoomBinding(p.binding), current = p.current === null ? null : parseRoomBinding(p.current), operation = p.operation === null ? null : parseRoomBindingOperation(p.operation)
    if (!Array.isArray(p.grants)) fail(); const grants = (p.grants as unknown[]).map(parseConnectionGrant)
    if (expected.operationId ? operation && operation.operationId !== expected.operationId || binding && (operation?.state !== 'applied' || JSON.stringify(binding) !== JSON.stringify(operation.binding)) : operation !== null || binding && (binding.bindingId !== expected.bindingId || expected.revision !== undefined && binding.revision !== expected.revision)) fail()
    if (current && current.bindingId !== (binding?.bindingId ?? expected.bindingId) || grants.some(g => !binding || g.bindingId !== binding.bindingId || g.bindingRevision !== binding.revision)) fail()
    const access = p.access === undefined ? undefined : Array.isArray(p.access) ? p.access.map(parseMemberAccess) : fail()
    if (access && (expected.operationId !== undefined || expected.revision !== undefined || !binding || access.some(a => !dequal(a.actor.application, binding.application) || a.local.kind !== 'none' && a.local.grant.bindingId !== binding.bindingId) || new Set(access.map(a => JSON.stringify(a.actor))).size !== access.length)) fail()
    return { binding, current, operation, grants, ...(access ? { access } : {}) } as RoomBindingResultMap[M]
  }
  const op = parseRoomBindingOperation(value), expected = input as RoomBindingParamsMap['connection.bind'] & RoomBindingParamsMap['connection.grant'] & RoomBindingParamsMap['connection.binding.relink']
  const action = method === 'connection.bind' ? 'bind' : method === 'connection.binding.member.inherit' ? 'inherit' : method === 'connection.grant' ? 'grant' : method === 'connection.binding.pause' ? 'pause' : method === 'connection.binding.resume' ? 'resume' : method === 'connection.binding.detach' ? 'detach' : 'relink'
  if (op.operationId !== expected.operationId || op.action !== action) fail()
  if (op.state === 'applied') {
    const b = op.binding
    if (b.bindingId !== expected.bindingId && !op.reused || action !== 'bind' && op.reused) fail()
    if (action === 'bind' || action === 'relink') {
      if (b.publicationOrigin !== undefined || b.connectionId !== expected.connectionId || b.executionHostId !== expected.executionHostId || b.agentSessionId !== expected.agentSessionId || b.externalConversationId !== expected.externalConversationId || JSON.stringify(b.scope) !== JSON.stringify(expected.scope) || !dequal(b.inputTarget, expected.inputTarget) || b.sourceCheckpoints.some(c => JSON.stringify(c.source) !== JSON.stringify(expected.expectedSource)) || action === 'relink' && b.revision !== expected.expectedRevision + 1) fail()
    } else if (['pause', 'resume', 'detach'].includes(action) && (b.state !== ({ pause: 'paused', resume: 'active', detach: 'detached' } as Record<string, string>)[action] || b.revision !== expected.expectedRevision + 1)) fail()
    else if (action === 'inherit') { const i = input as RoomBindingParamsMap['connection.binding.member.inherit']; if (b.revision !== i.expectedBindingRevision || !op.inherited || !dequal(op.inherited.actor, i.actor) || !op.inherited.grants.some(g => dequal(g, i.expectedGrant))) fail() }
    else if (action === 'grant' && (!op.grant || b.revision !== expected.expectedBindingRevision || op.grant.grantId !== expected.grantId || op.grant.revision !== (expected.expectedRevision ?? 0) + 1 || JSON.stringify(op.grant.actor) !== JSON.stringify(expected.actor) || JSON.stringify(op.grant.capabilities) !== JSON.stringify(expected.capabilities) || op.grant.state !== expected.state)) fail()
  }
  return op as RoomBindingResultMap[M]
}
