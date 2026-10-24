import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseConnectionActor } from './room-binding-codec.js'
import type { AgentExternalMessageAuthor } from './external-author.js'
import { parseAgentExternalAuthoritySource, type AgentExternalAuthoritySource } from './external-author.js'
import type { ConversationItemRef } from './conversation.js'
import { connectionDiagnosisIntakeCodes } from './connection-diagnosis-contract.js'

/** Original platform attribution. Recording a message grants no execution permission. */
export type AgentExternalConversationAuthor = Omit<AgentExternalMessageAuthor, 'grantId' | 'grantRevision' | 'grantSource'>
/** Read-only projection of the original ingress, not a Core input receipt or authorization. */
export type AgentExternalConversationInputObservation = { ingressId: string; state: 'received' | 'claimed' | 'refused'; code?: typeof connectionDiagnosisIntakeCodes[number] }
export type AgentExternalConversationReference = { agentSessionId: string; ingressId: string; authoritySource?: AgentExternalAuthoritySource }
export type AgentExternalConversationMessage = AgentExternalConversationReference & {
  hostId: string; author: AgentExternalConversationAuthor; body: string; inputMetadata?: AgentExternalConversationInputObservation
}
export type AgentExternalConversationAuthority = {
  message: AgentExternalConversationMessage | null
  authority: 'current' | 'refused' | 'unavailable'
  code?: string
}
export type AgentExternalConversationReceipt = AgentExternalConversationReference & {
  record: ConversationItemRef; revision: string
}
export interface AgentExternalConversationAuthorityPort {
  resolveConversationMessage(ref: AgentExternalConversationReference): Promise<AgentExternalConversationAuthority>
}
const fail = (): never => { throw new AgentMuxError('The external conversation reference does not identify an original authenticated record.', 'INVALID_EXTERNAL_CONVERSATION') }
const text = (v: unknown): string => { if (typeof v !== 'string' || !v.trim() || v.length > 16_384 || /[\u0000-\u001f\u007f]/u.test(v)) fail(); return v as string }
export function parseExternalConversationReference(value: unknown): AgentExternalConversationReference {
  const p = rpcRecord(value, ['agentSessionId', 'ingressId', 'authoritySource'], 'INVALID_EXTERNAL_CONVERSATION')
  return { agentSessionId: text(p.agentSessionId), ingressId: text(p.ingressId), ...(p.authoritySource === undefined ? {} : { authoritySource: parseAgentExternalAuthoritySource(p.authoritySource) }) }
}
export function parseExternalConversationAuthor(value: unknown): AgentExternalConversationAuthor {
  const p = rpcRecord(value, ['kind', 'connectionId', 'actor', 'externalConversationId', 'externalMessageId', 'bindingId', 'bindingRevision', 'authoritySource'], 'INVALID_EXTERNAL_CONVERSATION')
  if (p.kind !== 'external' || !Number.isSafeInteger(p.bindingRevision) || Number(p.bindingRevision) < 1) fail()
  return { kind: 'external', connectionId: text(p.connectionId), actor: parseConnectionActor(p.actor), externalConversationId: text(p.externalConversationId), externalMessageId: text(p.externalMessageId), bindingId: text(p.bindingId), bindingRevision: p.bindingRevision as number, ...(p.authoritySource === undefined ? {} : { authoritySource: parseAgentExternalAuthoritySource(p.authoritySource) }) }
}
export function externalConversationAuthor(author: AgentExternalMessageAuthor | AgentExternalConversationAuthor): AgentExternalConversationAuthor {
  const { kind, connectionId, actor, externalConversationId, externalMessageId, bindingId, bindingRevision, authoritySource } = author
  return parseExternalConversationAuthor({ kind, connectionId, actor, externalConversationId, externalMessageId, bindingId, bindingRevision, ...(authoritySource ? { authoritySource } : {}) })
}
/** Pure identity over original platform facts; no body, display label or input grant participates. */
export function externalConversationRecordId(author: AgentExternalConversationAuthor): string {
  return JSON.stringify(['external-message', author.actor.application.domain, author.actor.application.appId, author.externalConversationId, author.externalMessageId])
}
export function parseExternalConversationInputObservation(value: unknown): AgentExternalConversationInputObservation {
  const p = rpcRecord(value, ['ingressId', 'state', 'code'], 'INVALID_EXTERNAL_CONVERSATION')
  if (!['received', 'claimed', 'refused'].includes(p.state as string) || p.code !== undefined && !connectionDiagnosisIntakeCodes.includes(p.code as never)) fail()
  return { ingressId: text(p.ingressId), state: p.state as AgentExternalConversationInputObservation['state'], ...(p.code === undefined ? {} : { code: p.code as NonNullable<AgentExternalConversationInputObservation['code']> }) }
}
export function parseExternalConversationAuthority(value: unknown): AgentExternalConversationAuthority {
  const p = rpcRecord(value, ['message', 'authority', 'code'], 'INVALID_EXTERNAL_CONVERSATION')
  if (!['current', 'refused', 'unavailable'].includes(String(p.authority))) fail()
  let message: AgentExternalConversationMessage | null = null
  if (p.message !== null) {
    const m = rpcRecord(p.message, ['agentSessionId', 'ingressId', 'hostId', 'author', 'body', 'inputMetadata', 'authoritySource'], 'INVALID_EXTERNAL_CONVERSATION')
    if (typeof m.body !== 'string' || !m.body || m.body.includes('\0')) fail()
    message = { ...parseExternalConversationReference({ agentSessionId: m.agentSessionId, ingressId: m.ingressId, ...(m.authoritySource === undefined ? {} : { authoritySource: m.authoritySource }) }), hostId: text(m.hostId), author: parseExternalConversationAuthor(m.author), body: m.body as string, ...(m.inputMetadata === undefined ? {} : { inputMetadata: parseExternalConversationInputObservation(m.inputMetadata) }) }
    if (message.authoritySource?.hostingRuntimeId !== message.author.authoritySource?.hostingRuntimeId || message.authoritySource?.executionRuntimeId !== message.author.authoritySource?.executionRuntimeId) fail()
    if (message.inputMetadata && message.inputMetadata.ingressId !== message.ingressId) fail()
  }
  if (p.authority === 'current' && (!message || p.code !== undefined)) fail()
  return { message, authority: p.authority as AgentExternalConversationAuthority['authority'], ...(p.code === undefined ? {} : { code: text(p.code) }) }
}
export function parseExternalConversationReceipt(value: unknown, input: AgentExternalConversationReference): AgentExternalConversationReceipt {
  const p = rpcRecord(value, ['agentSessionId', 'ingressId', 'record', 'revision', 'authoritySource'], 'INVALID_EXTERNAL_CONVERSATION'), r = rpcRecord(p.record, ['hostId', 'agentSessionId', 'source'], 'INVALID_EXTERNAL_CONVERSATION'), s = rpcRecord(r.source, ['kind', 'recordId'], 'INVALID_EXTERNAL_CONVERSATION')
  const source = p.authoritySource === undefined ? undefined : parseAgentExternalAuthoritySource(p.authoritySource)
  if (source?.hostingRuntimeId !== input.authoritySource?.hostingRuntimeId || source?.executionRuntimeId !== input.authoritySource?.executionRuntimeId || p.agentSessionId !== input.agentSessionId || p.ingressId !== input.ingressId || r.agentSessionId !== input.agentSessionId || s.kind !== 'captured') fail()
  return { ...input, record: { hostId: text(r.hostId), agentSessionId: input.agentSessionId, source: { kind: 'captured', recordId: text(s.recordId) } }, revision: text(p.revision) }
}
