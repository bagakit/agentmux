import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseSpaceAuthorityRef, type SpaceAuthorityRef, type SpaceAuthoritySource } from './space-authority.js'
import { parseHostedAgentSessionRead, parseHostedNativeConnection } from './hosted-value.js'
import { isHostedAgentSessionSummary } from './hosted-session-summary.js'
import { parseLifecycleDiagnosticEvent } from './lifecycle-diagnostic.js'
import { parseAdoptedHostRoute } from './host-route.js'
import type { SpaceSessionOccurrence, SpaceSessionMember, SpaceSessionsOpening, SpaceSessionsObservation } from './space-sessions.js'
import type { AgentMuxClientEvent } from './types.js'

const invalid = (): never => { throw new AgentMuxError('The original Space Session observation is malformed or belongs to another source.', 'CONTROL_PROTOCOL_ERROR') }
function id(value: unknown): string { if (typeof value !== 'string' || !value || value.includes('\0')) return invalid(); return value }
function source(value: unknown): SpaceAuthoritySource { const p = rpcRecord(value, ['runtimeId', 'ownerInstanceId'], 'CONTROL_PROTOCOL_ERROR'); return { runtimeId: id(p.runtimeId), ownerInstanceId: id(p.ownerInstanceId) } }
function envelope(value: unknown, reference: SpaceAuthorityRef): SpaceSessionsOpening {
  const p = rpcRecord(value), actual = parseSpaceAuthorityRef(p.reference, 'CONTROL_PROTOCOL_ERROR'), original = source(p.source)
  if (actual.runtimeId !== reference.runtimeId || actual.spaceId !== reference.spaceId || original.runtimeId !== reference.runtimeId || !Number.isSafeInteger(p.revision) || (p.revision as number) < 0) return invalid()
  return { reference: actual, source: original, revision: p.revision as number }
}
export type SpaceSessionsStreamOpening = SpaceSessionsOpening & { transferId: string }
export function parseSpaceSessionsStreamOpening(value: unknown, reference: SpaceAuthorityRef): SpaceSessionsStreamOpening {
  const p = rpcRecord(value, ['reference', 'source', 'revision', 'transferId'], 'CONTROL_PROTOCOL_ERROR')
  return { ...envelope(p, reference), transferId: id(p.transferId) }
}
function member(value: unknown): SpaceSessionMember {
  const p = rpcRecord(value, ['hostId', 'runtimeId', 'agentSessionId'], 'CONTROL_PROTOCOL_ERROR')
  return { hostId: p.hostId === null ? null : id(p.hostId), runtimeId: p.runtimeId === null ? null : id(p.runtimeId), agentSessionId: id(p.agentSessionId) }
}
function occurrences(value: unknown, runtimeId: string | null): SpaceSessionOccurrence[] {
  if (!Array.isArray(value)) return invalid()
  const result = value.map(item => {
    const p = rpcRecord(item, ['regionId','creationOperationId','associationOperationId','projectRuntimeId','agentRuntimeId','executionRoute'], 'CONTROL_PROTOCOL_ERROR')
    const projectRuntimeId = p.projectRuntimeId === null ? null : id(p.projectRuntimeId), agentRuntimeId = p.agentRuntimeId === null ? null : id(p.agentRuntimeId)
    if (agentRuntimeId !== runtimeId) return invalid()
    const r = rpcRecord(p.executionRoute, ['kind','route'], 'CONTROL_PROTOCOL_ERROR')
    let executionRoute: SpaceSessionOccurrence['executionRoute']
    if (r.kind === 'adopted') {
      const route = parseAdoptedHostRoute(r.route)
      if (route.source.runtimeId !== projectRuntimeId || route.hops.at(-1)!.target.runtimeId !== agentRuntimeId) return invalid()
      executionRoute = { kind: r.kind, route }
    } else {
      rpcRecord(r, ['kind'], 'CONTROL_PROTOCOL_ERROR')
      if (r.kind !== 'same' && r.kind !== 'unconfirmed' || r.kind === 'same' && (!projectRuntimeId || projectRuntimeId !== agentRuntimeId)) return invalid()
      executionRoute = { kind: r.kind }
    }
    if (p.associationOperationId !== undefined && (p.creationOperationId !== undefined || executionRoute.kind !== 'unconfirmed')) return invalid()
    return { ...(p.associationOperationId === undefined ? {} : { associationOperationId: id(p.associationOperationId) }), regionId: id(p.regionId), ...(p.creationOperationId === undefined ? {} : { creationOperationId: id(p.creationOperationId) }), projectRuntimeId, agentRuntimeId, executionRoute }
  })
  if (new Set(result.map(item => item.regionId)).size !== result.length) return invalid()
  return result
}
export function parseSpaceSessionsObservation(value: unknown, opening: SpaceSessionsOpening): SpaceSessionsObservation {
  const p = rpcRecord(value, ['reference', 'source', 'revision', 'type', 'member', 'occurrences', 'state', 'association', 'hostId', 'runtimeId', 'authority', 'event'], 'CONTROL_PROTOCOL_ERROR')
  const actual = envelope(p, opening.reference)
  if (actual.source.ownerInstanceId !== opening.source.ownerInstanceId || actual.revision < opening.revision) return invalid()
  if (p.type === 'membership-complete') { rpcRecord(p, ['reference', 'source', 'revision', 'type'], 'CONTROL_PROTOCOL_ERROR'); return { ...actual, type: p.type } }
  if (p.type === 'removed') { rpcRecord(p, ['reference', 'source', 'revision', 'type', 'member'], 'CONTROL_PROTOCOL_ERROR'); return { ...actual, type: p.type, member: member(p.member) } }
  if (p.type === 'association') {
    rpcRecord(p, ['reference','source','revision','type','association','state'], 'CONTROL_PROTOCOL_ERROR')
    const association = rpcRecord(p.association, ['regionId','operationId'], 'CONTROL_PROTOCOL_ERROR'), state = rpcRecord(p.state, ['status','issue'], 'CONTROL_PROTOCOL_ERROR')
    const issue = rpcRecord(state.issue, ['code','message'], 'CONTROL_PROTOCOL_ERROR')
    if (state.status !== 'unavailable') return invalid()
    return { ...actual, type: p.type, association: { regionId: id(association.regionId), operationId: id(association.operationId) }, state: { status: state.status, issue: { code: id(issue.code), message: id(issue.message) } } }
  }
  if (p.type === 'member') {
    rpcRecord(p, ['reference', 'source', 'revision', 'type', 'member', 'occurrences', 'state'], 'CONTROL_PROTOCOL_ERROR')
    const original = member(p.member), locations = p.occurrences === undefined ? {} : { occurrences: occurrences(p.occurrences, original.runtimeId) }, state = rpcRecord(p.state, ['status', 'authority', 'session', 'issue'], 'CONTROL_PROTOCOL_ERROR')
    if (state.status === 'pending') { rpcRecord(state, ['status'], 'CONTROL_PROTOCOL_ERROR'); return { ...actual, type: p.type, member: original, ...locations, state: { status: state.status } } }
    if (state.status === 'unknown' || state.status === 'unavailable') {
      rpcRecord(state, ['status', 'issue'], 'CONTROL_PROTOCOL_ERROR'); const issue = rpcRecord(state.issue, ['code', 'message'], 'CONTROL_PROTOCOL_ERROR')
      return { ...actual, type: p.type, member: original, ...locations, state: { status: state.status, issue: { code: id(issue.code), message: id(issue.message) } } }
    }
    const authority = source(state.authority)
    if (original.hostId === null || original.runtimeId !== authority.runtimeId) return invalid()
    if (state.status === 'missing') { rpcRecord(state, ['status', 'authority'], 'CONTROL_PROTOCOL_ERROR'); return { ...actual, type: p.type, member: original, ...locations, state: { status: state.status, authority } } }
    if (state.status !== 'observed') return invalid()
    rpcRecord(state, ['status', 'authority', 'session'], 'CONTROL_PROTOCOL_ERROR')
    const session = parseHostedAgentSessionRead(state.session, original.agentSessionId, 'summary')
    if (!session || !isHostedAgentSessionSummary(session)) return invalid()
    return { ...actual, type: p.type, member: original, ...locations, state: { status: state.status, authority, session } }
  }
  if (p.type === 'runtime') {
    rpcRecord(p, ['reference', 'source', 'revision', 'type', 'hostId', 'runtimeId', 'authority', 'event'], 'CONTROL_PROTOCOL_ERROR')
    const authority = source(p.authority), event = rpcRecord(p.event), type = id(event.type)
    if (authority.runtimeId !== p.runtimeId || ['terminal-output', 'terminal-snapshot', 'terminal-resized', 'attachment-state'].includes(type)) return invalid()
    const originalEvent = event as AgentMuxClientEvent
    parseLifecycleDiagnosticEvent(originalEvent)
    if (type === 'connection-state') parseHostedNativeConnection(event)
    if (type === 'agent-session') {
      const session = rpcRecord(event.session); parseHostedAgentSessionRead(session, id(session.agentSessionId), 'summary')
    }
    return { ...actual, type: p.type, hostId: id(p.hostId), runtimeId: id(p.runtimeId), authority, event: originalEvent }
  }
  return invalid()
}
