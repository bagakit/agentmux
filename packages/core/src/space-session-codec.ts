import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseSpaceAuthorityRef, type SpaceAuthorityRef, type SpaceAuthoritySource } from './space-authority.js'
import { parseHostedAgentSessionRead, parseHostedNativeConnection } from './hosted-value.js'
import { isHostedAgentSessionSummary } from './hosted-session-summary.js'
import { parseLifecycleDiagnosticEvent } from './lifecycle-diagnostic.js'
import type { SpaceSessionMember, SpaceSessionsOpening, SpaceSessionsObservation } from './space-sessions.js'
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
export function parseSpaceSessionsObservation(value: unknown, opening: SpaceSessionsOpening): SpaceSessionsObservation {
  const p = rpcRecord(value, ['reference', 'source', 'revision', 'type', 'member', 'state', 'hostId', 'runtimeId', 'authority', 'event'], 'CONTROL_PROTOCOL_ERROR')
  const actual = envelope(p, opening.reference)
  if (actual.source.ownerInstanceId !== opening.source.ownerInstanceId || actual.revision < opening.revision) return invalid()
  if (p.type === 'membership-complete') { rpcRecord(p, ['reference', 'source', 'revision', 'type'], 'CONTROL_PROTOCOL_ERROR'); return { ...actual, type: p.type } }
  if (p.type === 'removed') { rpcRecord(p, ['reference', 'source', 'revision', 'type', 'member'], 'CONTROL_PROTOCOL_ERROR'); return { ...actual, type: p.type, member: member(p.member) } }
  if (p.type === 'member') {
    rpcRecord(p, ['reference', 'source', 'revision', 'type', 'member', 'state'], 'CONTROL_PROTOCOL_ERROR')
    const original = member(p.member), state = rpcRecord(p.state, ['status', 'authority', 'session', 'issue'], 'CONTROL_PROTOCOL_ERROR')
    if (state.status === 'pending') { rpcRecord(state, ['status'], 'CONTROL_PROTOCOL_ERROR'); return { ...actual, type: p.type, member: original, state: { status: state.status } } }
    if (state.status === 'unknown' || state.status === 'unavailable') {
      rpcRecord(state, ['status', 'issue'], 'CONTROL_PROTOCOL_ERROR'); const issue = rpcRecord(state.issue, ['code', 'message'], 'CONTROL_PROTOCOL_ERROR')
      return { ...actual, type: p.type, member: original, state: { status: state.status, issue: { code: id(issue.code), message: id(issue.message) } } }
    }
    const authority = source(state.authority)
    if (original.hostId === null || original.runtimeId !== authority.runtimeId) return invalid()
    if (state.status === 'missing') { rpcRecord(state, ['status', 'authority'], 'CONTROL_PROTOCOL_ERROR'); return { ...actual, type: p.type, member: original, state: { status: state.status, authority } } }
    if (state.status !== 'observed') return invalid()
    rpcRecord(state, ['status', 'authority', 'session'], 'CONTROL_PROTOCOL_ERROR')
    const session = parseHostedAgentSessionRead(state.session, original.agentSessionId, 'summary')
    if (!session || !isHostedAgentSessionSummary(session)) return invalid()
    return { ...actual, type: p.type, member: original, state: { status: state.status, authority, session } }
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
